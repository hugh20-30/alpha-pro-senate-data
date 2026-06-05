// ── Alpha Tracker Pro · Senate eFD PTR scraper ─────────────────────────────
//
// Runs on GitHub Actions every 6 hours. The Senate Electronic Financial
// Disclosure site (efdsearch.senate.gov) requires accepting a click-through
// "STOCK Act prohibition" agreement before any search works. We POST the
// agreement form, carry the session cookie + CSRF token through a search
// request, then fetch each PTR (Periodic Transaction Report) HTML view and
// parse the trade table.
//
// Output shape matches the House parser (alpha-pro-data/house-trades.json):
//   { generatedAt, source, filingsProcessed, filingsFailed, tradeCount,
//     trades: [{name, ticker, action, value, valueMid, dateISO, date,
//               sector, receipt, source}, ...] }
//
// The front-end merges senate-trades.json + house-trades.json into one feed.
// ──────────────────────────────────────────────────────────────────────────

import * as cheerio from 'cheerio';
import fs from 'fs';

const BASE         = 'https://efdsearch.senate.gov';
const UA           = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const PAGE_SIZE    = 500;   // DataTables page size for search results
const MAX_PTRS     = 800;   // cap per run · keeps action well under time budget
const FETCH_DELAY  = 250;   // ms between PTR fetches · be a polite citizen
const REPORT_TYPE_PTR = 11; // eFD's internal id for Periodic Transaction Report

const CURRENT_YEAR = new Date().getFullYear();

// Cookie jar (we manage cookies manually since Node 20 fetch has no jar)
let cookies = {};
function cookieHeader() {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}
function absorbSetCookie(setCookie) {
  if (!setCookie) return;
  // Node fetch may return string or array — normalize
  const lines = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const line of lines) {
    for (const part of line.split(/,(?=[^;]+=[^;]+)/)) {
      const m = part.match(/^\s*([^=;]+)=([^;]*)/);
      if (m) cookies[m[1].trim()] = m[2].trim();
    }
  }
}

async function ghFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    redirect: 'manual',     // we want to inspect 302s ourselves
    headers: {
      'User-Agent': UA,
      'Cookie': cookieHeader(),
      ...(opts.headers || {})
    }
  });
  absorbSetCookie(res.headers.get('set-cookie'));
  return res;
}

async function main() {
  console.log(`──────── Alpha Pro Senate scraper · ${new Date().toISOString()} ────────`);

  // ── 1. Accept the prohibition agreement ────────────────────────────────
  console.log('  Accepting STOCK Act agreement…');
  await acceptAgreement();

  // ── 2. Search for recent PTRs across last 2 years ──────────────────────
  // Newer PTRs first (descending submitted_date). We pull current + previous
  // year and merge — covers everything filed since Jan 1 last year.
  const allFilings = [];
  for (const year of [CURRENT_YEAR, CURRENT_YEAR - 1]) {
    try {
      const yf = await searchPTRs(year);
      console.log(`  ${year}: ${yf.length} PTR filings found`);
      allFilings.push(...yf);
    } catch (e) {
      console.log(`  ${year}: search failed (${e.message})`);
    }
  }
  if (!allFilings.length) {
    console.error('No filings found — abort'); process.exit(1);
  }

  // Sort by filing date descending, cap to MAX_PTRS
  allFilings.sort((a, b) => filingDateMs(b.filingDate) - filingDateMs(a.filingDate));
  const recent = allFilings.slice(0, MAX_PTRS);
  console.log(`  Processing ${recent.length} most-recent PTRs`);

  // ── 3. Fetch each PTR HTML view + parse trade table ────────────────────
  const allTrades = [];
  let success = 0, failed = 0, paper = 0;
  for (let i = 0; i < recent.length; i++) {
    const f = recent[i];
    if (f.paper) { paper++; continue; }  // skip paper filings (scanned PDFs)
    try {
      const html = await fetchPTR(f.viewUrl);
      const trades = parseTradesFromHtml(html, f);
      allTrades.push(...trades);
      success++;
    } catch (e) {
      failed++;
      if (failed % 25 === 1) console.log(`  Skip ${f.viewUrl} (${e.message.slice(0, 60)})`);
    }
    if ((i + 1) % 25 === 0) console.log(`  Progress · ${i + 1}/${recent.length} · ${allTrades.length} trades extracted so far`);
    if (FETCH_DELAY) await new Promise(r => setTimeout(r, FETCH_DELAY));
  }

  // ── 4. Dedupe + sort + write ───────────────────────────────────────────
  const seen = new Set();
  const deduped = allTrades.filter(t => {
    const k = `${t.name}|${t.ticker}|${t.dateISO}|${t.action}|${t.value}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  deduped.sort((a, b) => b.dateISO.localeCompare(a.dateISO));

  const output = {
    generatedAt: new Date().toISOString(),
    source: BASE,
    filingsProcessed: success,
    filingsFailed: failed,
    filingsPaper: paper,
    tradeCount: deduped.length,
    trades: deduped
  };

  fs.writeFileSync('senate-trades.json', JSON.stringify(output, null, 2));
  console.log(`──────── Done · ${deduped.length} trades from ${success}/${recent.length} PTRs · ${failed} failed · ${paper} skipped (paper) ────────`);
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function acceptAgreement() {
  // GET /search/home/ to grab the initial CSRF token + csrftoken cookie.
  const home = await ghFetch(`${BASE}/search/home/`);
  if (!home.ok) throw new Error(`agreement GET failed: HTTP ${home.status}`);
  const homeHtml = await home.text();
  const csrf = (homeHtml.match(/name="csrfmiddlewaretoken" value="([^"]+)"/) || [])[1];
  if (!csrf) throw new Error('no csrf on home page');

  // POST the agreement. Server responds 302 → /search/ and rotates sessionid.
  const accept = await ghFetch(`${BASE}/search/home/`, {
    method: 'POST',
    headers: {
      'Referer':      `${BASE}/search/home/`,
      'Origin':       BASE,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: `csrfmiddlewaretoken=${encodeURIComponent(csrf)}&prohibition_agreement=1`
  });
  if (accept.status !== 302 && accept.status !== 200) {
    throw new Error(`agreement POST returned HTTP ${accept.status}`);
  }
  // GET /search/ to refresh CSRF cookie post-session-rotation.
  const search = await ghFetch(`${BASE}/search/`);
  if (!search.ok) throw new Error(`search page GET failed: HTTP ${search.status}`);
}

async function searchPTRs(year) {
  // The DataTables endpoint accepts start/length pagination. We pull pages of
  // PAGE_SIZE until we've fetched recordsTotal or hit MAX_PTRS guard.
  const all = [];
  let start = 0;
  // Refresh CSRF from cookie before each batch (cookie value is what server
  // verifies; the form value just has to match the cookie).
  while (true) {
    const csrf = cookies.csrftoken;
    if (!csrf) throw new Error('lost csrftoken cookie');
    const body = new URLSearchParams({
      start: String(start),
      length: String(PAGE_SIZE),
      report_types: JSON.stringify([REPORT_TYPE_PTR]),
      filer_types: '[]',
      submitted_start_date: `01/01/${year} 00:00:00`,
      submitted_end_date:   `12/31/${year} 23:59:59`,
      candidate_state: '',
      senator_state:   '',
      office_id:       '',
      first_name:      '',
      last_name:       '',
      csrfmiddlewaretoken: csrf
    });
    const res = await ghFetch(`${BASE}/search/report/data/`, {
      method: 'POST',
      headers: {
        'Referer':         `${BASE}/search/`,
        'Origin':          BASE,
        'X-CSRFToken':     csrf,
        'X-Requested-With':'XMLHttpRequest',
        'Content-Type':    'application/x-www-form-urlencoded; charset=UTF-8'
      },
      body: body.toString()
    });
    if (!res.ok) throw new Error(`search HTTP ${res.status}`);
    const data = await res.json();
    const rows = data.data || [];
    if (!rows.length) break;
    for (const row of rows) {
      // Row format: [firstName, lastName, fullName, '<a href="..." ...>label</a>', filingDate]
      const [first, last, fullName, linkHtml, filingDate] = row;
      const hrefMatch = (linkHtml || '').match(/href="([^"]+)"/);
      if (!hrefMatch) continue;
      const viewUrl = hrefMatch[1].startsWith('http') ? hrefMatch[1] : `${BASE}${hrefMatch[1]}`;
      const isPaper = /\/paper\//i.test(viewUrl);
      all.push({ first, last, fullName, viewUrl, filingDate, paper: isPaper, year });
    }
    start += rows.length;
    if (start >= (data.recordsTotal || 0)) break;
    if (all.length >= MAX_PTRS) break;
    // Be polite between paginated requests
    await new Promise(r => setTimeout(r, 200));
  }
  return all;
}

async function fetchPTR(url) {
  const res = await ghFetch(url, {
    headers: { 'Referer': `${BASE}/search/` }
  });
  if (!res.ok) throw new Error(`PTR HTTP ${res.status}`);
  return await res.text();
}

// Parse the single <table> on a digital PTR view page. Columns:
//   # | Transaction Date | Owner | Ticker | Asset Name | Asset Type | Type | Amount | Comment
function parseTradesFromHtml(html, filing) {
  const $ = cheerio.load(html);
  const trades = [];
  // The senator's full name comes from the search row (cleaner than the
  // page heading which may include "(Senator)" suffix).
  const memberName = `${filing.first} ${filing.last}`.trim();

  $('table tbody tr').each((_, tr) => {
    const cells = $(tr).find('td').map((__, td) => $(td).text().trim()).get();
    if (cells.length < 8) return;
    // [#, date, owner, ticker, asset, assetType, type, amount, comment?]
    const dateStr  = cells[1];
    const ticker   = (cells[3] || '').replace(/\s+/g, '').toUpperCase();
    const assetType = (cells[5] || '').toLowerCase();
    const typeStr  = (cells[6] || '').toLowerCase();
    const amount   = cells[7] || '';

    // Only stocks (skip bonds, options, crypto, etc. — keeps signal high)
    if (!/stock/.test(assetType)) return;
    // Ticker must look like a real ticker (1–5 caps, optional .CLASS)
    if (!ticker || !/^[A-Z]{1,5}(\.[A-Z])?$/.test(ticker)) return;
    // Action: "Purchase" → BUY, "Sale" (Full/Partial) → SELL, "Exchange" skip
    let action = null;
    if (/purchase/.test(typeStr)) action = 'BUY';
    else if (/sale/.test(typeStr)) action = 'SELL';
    if (!action) return;

    const dateISO = parseMDY(dateStr);
    if (!dateISO) return;

    const cleanValue = amount.replace(/\s+/g, ' ').trim();
    trades.push({
      name: memberName,
      ticker,
      action,
      value: cleanValue,
      valueMid: midpointOf(cleanValue),
      dateISO,
      date: formatDate(dateISO),
      sector: 'Other',                     // front-end enriches from TICKER_SECTOR
      receipt: filing.viewUrl,
      source: 'senate-efd'
    });
  });
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
  if (!s) return 0;
  const iso = parseMDY(s);
  return iso ? new Date(iso).getTime() : 0;
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
