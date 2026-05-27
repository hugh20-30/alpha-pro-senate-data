// ── Alpha Tracker Pro · House Clerk PTR scraper ────────────────────────────
//
// Runs on GitHub Actions every 6 hours. Downloads the official House Clerk
// XML index for the current + previous year, pulls each recent PTR PDF,
// extracts trades with a defensive regex, and writes `house-trades.json`.
//
// Expected output shape (matches what the Alpha Pro app already consumes):
//   { generatedAt, source, filingsProcessed, filingsFailed, tradeCount,
//     trades: [{name, ticker, action, value, valueMid, dateISO, date,
//               sector, receipt, source}, ...] }
//
// Realistic accuracy: ~70–85% of native digital PTRs (skips scanned ones).
// When the House Clerk changes PDF format, this may need regex updates.
// ────────────────────────────────────────────────────────────────────────────

import AdmZip from 'adm-zip';
import fs from 'fs';

const HOUSE_BASE  = 'https://disclosures-clerk.house.gov';
const CURRENT_YEAR = new Date().getFullYear();
const MAX_PDFS     = 200;   // cap per run · keeps action under time budget
const FETCH_DELAY  = 50;    // ms between PDF fetches · be a polite citizen

async function main() {
  console.log(`──────── Alpha Pro House scraper · ${new Date().toISOString()} ────────`);

  // ── 1. Build the filing index from XML (current + previous year) ───────
  const filings = [];
  for (const year of [CURRENT_YEAR, CURRENT_YEAR - 1]) {
    try {
      const yearFilings = await fetchYearIndex(year);
      console.log(`  ${year}: ${yearFilings.length} PTR filings found`);
      filings.push(...yearFilings);
    } catch (e) {
      console.log(`  ${year}: failed (${e.message})`);
    }
  }
  if (!filings.length) {
    console.error('No filings found — abort'); process.exit(1);
  }

  // Sort by filing date descending, cap to MAX_PDFS
  filings.sort((a, b) => filingDateMs(b.filingDate) - filingDateMs(a.filingDate));
  const recent = filings.slice(0, MAX_PDFS);
  console.log(`  Processing ${recent.length} most-recent PTRs`);

  // ── 2. Process each PDF ─────────────────────────────────────────────────
  const allTrades = [];
  let success = 0, failed = 0;
  const pdfParse = (await import('pdf-parse')).default;

  for (let i = 0; i < recent.length; i++) {
    const f = recent[i];
    try {
      const pdfBuf = await fetchPdf(f.year, f.docID);
      const data = await pdfParse(pdfBuf);
      const trades = parseTradesFromText(data.text, f);
      allTrades.push(...trades);
      success++;
    } catch (e) {
      failed++;
      // Logged only every 25 failures to keep CI log readable
      if (failed % 25 === 1) console.log(`  Skip ${f.docID} (${e.message.slice(0, 60)})`);
    }
    if ((i + 1) % 25 === 0) console.log(`  Progress · ${i + 1}/${recent.length} · ${allTrades.length} trades extracted so far`);
    if (FETCH_DELAY) await new Promise(r => setTimeout(r, FETCH_DELAY));
  }

  // ── 3. Dedupe + sort + write ────────────────────────────────────────────
  const seen = new Set();
  const deduped = allTrades.filter(t => {
    const k = `${t.name}|${t.ticker}|${t.dateISO}|${t.action}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  deduped.sort((a, b) => b.dateISO.localeCompare(a.dateISO));

  const output = {
    generatedAt: new Date().toISOString(),
    source: HOUSE_BASE,
    filingsProcessed: success,
    filingsFailed: failed,
    tradeCount: deduped.length,
    trades: deduped
  };

  fs.writeFileSync('house-trades.json', JSON.stringify(output, null, 2));
  console.log(`──────── Done · ${deduped.length} trades from ${success}/${recent.length} PDFs · ${failed} skipped ────────`);
}

// ── Helpers ───────────────────────────────────────────────────────────────

// Fetch + unzip + parse one year's XML index. Returns array of PTR filings.
async function fetchYearIndex(year) {
  const url = `${HOUSE_BASE}/public_disc/financial-pdfs/${year}FD.ZIP`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`XML HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  const xmlEntry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.xml'));
  if (!xmlEntry) throw new Error('No XML in ZIP');
  const xml = xmlEntry.getData().toString('utf-8');
  return parseXmlIndex(xml, year);
}

// XML is flat <FinancialDisclosure><Member>...</Member></FinancialDisclosure>.
// Skipping a real XML library to keep the package tiny — regex handles this fine.
function parseXmlIndex(xml, year) {
  const out = [];
  const memberRegex = /<Member>([\s\S]*?)<\/Member>/g;
  let m;
  while ((m = memberRegex.exec(xml)) !== null) {
    const block = m[1];
    const tag = (name) => {
      const r = new RegExp(`<${name}>([^<]*)</${name}>`);
      const mm = block.match(r);
      return mm ? mm[1].trim() : '';
    };
    const filingType = tag('FilingType');
    if (filingType !== 'P') continue;      // P = Periodic Transaction Report
    const docID = tag('DocID');
    const last = tag('Last');
    if (!docID || !last) continue;
    out.push({
      last, first: tag('First'), suffix: tag('Suffix'),
      stateDst: tag('StateDst'),
      filingDate: tag('FilingDate'),
      docID, year
    });
  }
  return out;
}

async function fetchPdf(year, docID) {
  const url = `${HOUSE_BASE}/public_disc/ptr-pdfs/${year}/${docID}.pdf`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PDF HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Extract trade rows from a PTR's text content.
//
// The House PTR has a few text shapes after pdf-parse extracts it:
//   (a) Tabular:  "[ST]  NVDA  P  04/15/2026  $1,001 - $15,000"
//   (b) Inline:   "NVIDIA Corp - Common Stock  (NVDA)  ...  P  04/15/2026 $1,001-$15,000"
//   (c) Multi-line table cells (very messy)
//
// Strategy: scan for ticker-in-parens OR all-caps ticker tokens, then look
// for the conventional context within ~300 chars (transaction code P/S, a
// date MM/DD/YYYY, an amount range like "$1,001 - $15,000"). Only emit a
// trade when ALL FOUR pieces are present near each other. Anything else gets
// silently skipped — false positives are worse than misses for this product.
function parseTradesFromText(text, filing) {
  const memberName = `${filing.first} ${filing.last}`.trim();
  if (!memberName || !text) return [];
  const trades = [];

  // Strict pattern: ticker in parens + nearby P/S + date + amount
  // Allows up to 300 chars of slop between ticker and context (handles
  // table cells that get jumbled after pdf-parse).
  const re = /\(([A-Z]{1,5}(?:\.[A-Z])?)\)[\s\S]{0,300}?\b([PSE])\s*(?:\(partial\))?[\s\S]{0,80}?(\d{1,2}\/\d{1,2}\/\d{4})[\s\S]{0,80}?(\$[\d,]+(?:\s*-\s*\$[\d,]+)?(?:\s*\+)?)/g;

  let m;
  while ((m = re.exec(text)) !== null) {
    const [, ticker, type, dateStr, amount] = m;
    const dateISO = parseMDY(dateStr);
    if (!dateISO) continue;
    // E = exchange · skip ambiguous types
    const action = type === 'P' ? 'BUY' : type === 'S' ? 'SELL' : null;
    if (!action) continue;
    // Normalize the value string — pdf-parse sometimes injects \n between
    // the two halves of an amount range. Collapse to single spaces.
    const cleanValue = amount.replace(/\s+/g, ' ').trim();
    trades.push({
      name: memberName,
      ticker: ticker.toUpperCase(),
      action,
      value: cleanValue,
      valueMid: midpointOf(cleanValue),
      dateISO,
      date: formatDate(dateISO),
      sector: 'Other',  // worker-side enrichment fills this
      receipt: `${HOUSE_BASE}/public_disc/ptr-pdfs/${filing.year}/${filing.docID}.pdf`,
      source: 'house-clerk'
    });
  }
  return trades;
}

function parseMDY(s) {
  const m = (s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const year = parseInt(m[3], 10);
  if (year < 2010 || year > new Date().getFullYear() + 1) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function midpointOf(amount) {
  const nums = (amount.match(/\$([\d,]+)/g) || [])
    .map(s => parseInt(s.replace(/[\$,]/g, ''), 10))
    .filter(n => !isNaN(n));
  if (nums.length === 0) return 0;
  if (nums.length === 1) return nums[0];
  return Math.round((nums[0] + nums[1]) / 2);
}

function filingDateMs(s) {
  // FilingDate format from House XML: "M/D/YYYY"
  if (!s) return 0;
  const iso = parseMDY(s);
  return iso ? new Date(iso).getTime() : 0;
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
