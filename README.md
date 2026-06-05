# alpha-pro-senate-parser

Nightly scraper that downloads the official **U.S. Senate Electronic Financial
Disclosure** (eFD) periodic transaction reports, extracts senator stock trades,
and publishes them as a public JSON file via GitHub Actions.

Powers the Senate-trade data in **Alpha Tracker Pro**. Replaces the old
`senate-stock-watcher-data` archive that was frozen Dec 2019.

---

## What this does

1. Every 6 hours, GitHub Actions runs `scrape.js`
2. The script accepts the Senate eFD STOCK Act agreement (a one-time click-through gate)
3. Searches for all PTR filings in the current + previous year
4. Skips paper filings (scanned PDFs) — focuses on the digital ones, which are cleaner
5. Downloads each PTR's HTML view page
6. Parses the trade table with `cheerio`
7. Writes the combined result to `senate-trades.json` in this repo
8. Commits + pushes the updated JSON

The Alpha Pro frontend then fetches the JSON from this repo's raw URL and
merges it with the House data.

---

## Setup (one-time, ~10 minutes)

Same flow as `alpha-pro-data` (the House parser). No terminal required.

### 1. Create a new public repo on GitHub

1. Click **+** (top right) → **New repository**
2. **Repository name:** `alpha-pro-senate-data`
3. **Visibility:** **Public** *(required for the free 2000 Action minutes/month)*
4. Check **Add a README file**
5. Click **Create repository**

### 2. Upload these files

1. On your new repo page, click **Add file → Upload files**
2. Drag the **entire contents** of this `6x-senate-parser/` folder into the upload zone:
   - `package.json`
   - `scrape.js`
   - `.gitignore`
   - `README.md`
   - `.github/workflows/scrape.yml` *(the .github folder must come with its contents intact)*
3. Scroll down → commit message: `Initial Senate parser setup`
4. Click **Commit changes**

> ⚠️ If GitHub's web UI strips the hidden `.github` folder, upload `scrape.yml` separately:
> - Click **Add file → Create new file**
> - In the filename box type `.github/workflows/scrape.yml` (the slashes create the folders)
> - Paste the YAML content from `.github/workflows/scrape.yml` in this folder
> - Commit

### 3. Trigger the first run manually

1. Click the **Actions** tab on your repo page
2. Click **Scrape Senate PTRs** in the left sidebar
3. Click the **Run workflow** dropdown (top right of the runs list)
4. Click the green **Run workflow** button

The run takes 5–10 minutes. You'll see it in the runs list with a yellow dot
while running, green check when done.

### 4. Verify the JSON appeared

After the first successful run, navigate back to the repo root and you should
see a new file `senate-trades.json`. Click it — you'll see something like:

```json
{
  "generatedAt": "2026-...",
  "source": "https://efdsearch.senate.gov",
  "filingsProcessed": 212,
  "filingsFailed": 0,
  "filingsPaper": 26,
  "tradeCount": 796,
  "trades": [
    {"name": "Tina Smith", "ticker": "PODD", "action": "SELL", ...}
  ]
}
```

### 5. Get the raw URL

The URL the Alpha Pro app will read from is:

```
https://raw.githubusercontent.com/<YOUR-USERNAME>/alpha-pro-senate-data/main/senate-trades.json
```

For example, if your username is `hugh20-30`, the URL is:

```
https://raw.githubusercontent.com/hugh20-30/alpha-pro-senate-data/main/senate-trades.json
```

**Send this URL to me** and I'll wire it into the Alpha Pro app's
`loadLiveData()`. After one more static-site redeploy, your live site will
show real, fresh Senate trades alongside the House data.

---

## How much will this cost?

**$0/month forever** at our usage level.

GitHub free tier gives 2000 Action minutes/month for public repos. Each Senate
scrape takes ~5–8 minutes. Running 4 times a day = 600–960 minutes/month
across both House + Senate scrapers combined, well under the limit.

---

## Realistic limitations

| Limit | Why |
|---|---|
| **~85–90% of PTRs parse successfully** | Paper filings (scanned PDFs) are skipped — would need OCR. |
| **Only "Stock" asset type captured** | Bonds, options, crypto, and mutual funds are filtered out to keep signal high. |
| **Format changes break the parser** | Rare (~1× every 2 years). When it happens, the scraper still runs but `tradeCount` will drop. Fix the parser in `parseTradesFromHtml()`. |
| **Trade sectors come back as "Other"** | The Alpha Pro app enriches sectors from its own ticker-mapping table when it loads the JSON. |

---

## Manual testing

To run locally before committing (requires Node 20+):

```bash
npm install
npm run scrape
cat senate-trades.json | head -50
```

---

## File overview

| File | Purpose |
|---|---|
| `scrape.js` | Main scraper: accepts agreement, searches PTRs, parses HTML tables, writes JSON |
| `package.json` | Dependencies (cheerio) |
| `.github/workflows/scrape.yml` | GitHub Actions schedule + commit logic |
| `.gitignore` | Excludes node_modules and noise from commits |
| `senate-trades.json` | The output (auto-created on first successful run) |

---

## How the Senate eFD agreement gate works

Unlike the House Clerk, which serves PTRs as plain PDFs at predictable URLs,
the Senate eFD requires every visitor to POST an agreement to the STOCK Act
"prohibition of insider trading" notice. The scraper:

1. GETs `/search/home/` to grab the initial `csrfmiddlewaretoken`
2. POSTs that token + `prohibition_agreement=1` to the same URL
3. Server returns 302 → `/search/` and rotates the `sessionid` cookie to one
   that has `search_agreement: True` baked into the session state
4. We carry that cookie through all subsequent search + PTR-view requests

This is the same approach the (now-defunct) `senate-stock-watcher` project
used. If Senate eFD changes their form field names, the fix is small —
update the field names in `acceptAgreement()`.
