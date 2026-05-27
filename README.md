# alpha-pro-house-parser

Nightly scraper that downloads the official U.S. House Clerk financial-disclosure
PDFs, extracts congressional stock trades, and publishes them as a public JSON
file via GitHub Actions.

Powers the House-trade data in **Alpha Tracker Pro**.

---

## What this does

1. Every 6 hours, GitHub Actions runs `scrape.js`
2. The script downloads the official House Clerk annual disclosure XML index
3. Filters to "PTR" filings (Periodic Transaction Reports — the stock trades)
4. Downloads the most recent 200 PTR PDFs
5. Uses `pdf-parse` to extract text from each PDF
6. Runs a defensive regex parser to find trade rows
7. Writes the combined result to `house-trades.json` in this repo
8. Commits + pushes the updated JSON

The Alpha Pro frontend then fetches the JSON from this repo's raw URL.

---

## Setup (one-time, ~10 minutes)

You'll do most of this in the GitHub web UI. No terminal required.

### 1. Create a GitHub account (if you don't have one)

[github.com/signup](https://github.com/signup) — free, takes 60 seconds.

### 2. Create a new public repo

1. Click **+** (top right) → **New repository**
2. **Repository name:** `alpha-pro-data` (or anything you like)
3. **Visibility:** **Public** *(required for the free 2000 Action minutes/month)*
4. Check **Add a README file**
5. Click **Create repository**

### 3. Upload these files

1. On your new repo page, click **Add file → Upload files**
2. Drag the **entire contents** of this `6x-parser/` folder into the upload zone:
   - `package.json`
   - `scrape.js`
   - `.gitignore`
   - `README.md`
   - `.github/workflows/scrape.yml` *(the .github folder must come with its contents intact)*
3. Scroll down → commit message: `Initial parser setup`
4. Click **Commit changes**

> ⚠️ If GitHub's web UI strips the hidden `.github` folder, you may need to upload `scrape.yml` separately:
> - Click **Add file → Create new file**
> - In the filename box type `.github/workflows/scrape.yml` (the slashes create the folders)
> - Paste the YAML content from `scrape.yml` in this folder
> - Commit

### 4. Trigger the first run manually

GitHub Actions normally only runs on its schedule (every 6 hours). To kick it
off immediately the first time:

1. Click the **Actions** tab on your repo page
2. Click **Scrape House PTRs** in the left sidebar
3. Click the **Run workflow** dropdown (top right of the runs list)
4. Click the green **Run workflow** button

The run takes 10–20 minutes. You'll see it in the runs list with a yellow dot
while running, green check when done.

### 5. Verify the JSON appeared

After the first successful run, navigate back to the repo root and you should
see a new file `house-trades.json`. Click it — you'll see something like:

```json
{
  "generatedAt": "2026-...",
  "source": "https://disclosures-clerk.house.gov",
  "filingsProcessed": 187,
  "filingsFailed": 13,
  "tradeCount": 1432,
  "trades": [
    {"name": "Nancy Pelosi", "ticker": "NVDA", "action": "BUY", ... }
  ]
}
```

### 6. Get the raw URL

The URL the Alpha Pro app will read from is:

```
https://raw.githubusercontent.com/<YOUR-USERNAME>/<YOUR-REPO-NAME>/main/house-trades.json
```

For example, if your username is `hughvanatta` and you named the repo
`alpha-pro-data`, the URL is:

```
https://raw.githubusercontent.com/hughvanatta/alpha-pro-data/main/house-trades.json
```

**Send this URL to me** and I'll wire it into the Alpha Pro app's
`loadLiveData()`. After one more static-site redeploy, your live site will
start showing real House trades alongside the Senate data.

---

## How much will this cost?

**$0/month forever** at our usage level.

GitHub free tier gives 2000 Action minutes/month for public repos. Each scrape
takes ~5–10 minutes. Running 4 times a day = 600–1200 minutes/month, well under
the limit.

---

## Realistic limitations

| Limit | Why |
|---|---|
| **~70–85% of PTRs parse successfully** | House PDFs come in many formats (digital, scanned, handwritten). The parser handles the most common one; others are skipped. |
| **Old PDFs (pre-2022) may not parse** | Format changes over the years. |
| **Scanned PDFs are skipped** | Would need OCR (out of scope). |
| **Format changes break the parser** | Rare (~1× every 2 years). When it happens, the scraper still runs but `tradeCount` will drop. Fix the regex in `parseTradesFromText()`. |
| **Trade sectors come back as "Other"** | The Alpha Pro app enriches sectors from its own ticker-mapping table when it loads the JSON. |

This is the same trade-off the (now defunct) **house-stock-watcher** project had —
70% accuracy, ~$0 to run, occasional manual fix-ups.

---

## Manual testing

To run locally before committing (requires Node 20+):

```bash
npm install
npm run scrape
cat house-trades.json | head -50
```

---

## File overview

| File | Purpose |
|---|---|
| `scrape.js` | Main scraper: fetches XML, downloads PDFs, extracts trades, writes JSON |
| `package.json` | Dependencies (adm-zip, pdf-parse) |
| `.github/workflows/scrape.yml` | GitHub Actions schedule + commit logic |
| `.gitignore` | Excludes node_modules and noise from commits |
| `house-trades.json` | The output (auto-created on first successful run) |
