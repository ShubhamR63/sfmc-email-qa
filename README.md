# sfmc-email-qa

Platform-independent HTML email QA audit for **Salesforce Marketing Cloud (SFMC)**.
Zero dependencies - requires only Node.js 18+ and runs the same on Windows, macOS, Linux and CI.

## What it checks

| # | Check | Notes |
|---|-------|-------|
| 1 | **HREF inventory** | Every `<a>`/`<area>` href: text links, image links, AMPscript, `RedirectTo()`, mailto, tel, header/footer, hidden. Reports `HREF / Alias / ALT / SRC / Status`. |
| 2 | **SRC inventory** | Every `<img>`, VML image, favicon, `background=` and CSS `url()`. Reports `SRC / HREF / Alias / ALT / Status`. Independent of the HREF inventory. |
| 3 | **Totals and lists** | HREF/SRC/alias counts; HREFs without alias/ALT/SRC; SRCs without HREF/alias/ALT. |
| 4 | **Alias validation** | All aliases, duplicates, missing, aliases containing spaces. |
| 5 | **ALT validation** | Missing, empty, placeholder ALT text. |
| 6 | **Tracking codes** | `opencounter` and `usermatch` must exist **before** `<body>`. Reports "Tracking Code Placement Issue Found". |
| 7 | **Content blocks** | All `ContentBlockByKey()` / `ContentBlockByID()` (and `ByName`). |
| 8 | **Unsubscribe** | Content block **and** `href="%%=RedirectTo(@urlOrganic)=%%"` with `alias="unsubscribe"`. Prints the exact "Add Unsub block" text if missing. |
| 9 | **HTTPS** | `http://`, empty and invalid hrefs. Valid AMPscript expressions are excluded. |
| 10 | **Final PASS/FAIL summary** | Counts for every category. |

## Usage

```bash
# one file (prints Markdown report)
node src/cli.js path/to/email.html

# folder (recursive) -> one report per email in ./reports
node src/cli.js emails/ --out reports/

# JSON output, strict mode
node src/cli.js email.html --format json --strict
```

Or install it globally / run with npx once it is on GitHub:

```bash
npm install -g .
sfmc-email-qa email.html
```

| Option | Description |
|--------|-------------|
| `-f, --format <md\|json>` | Report format (default `md`) |
| `-o, --out <path>` | Write report to a file, or to a folder for multiple inputs |
| `--strict` | Treat WARN findings (e.g. unlinked images) as failures |

**Exit codes:** `0` all PASS, `1` at least one FAIL, `2` usage / IO error - so it can gate a CI pipeline.

## Web page

`npm run web` builds and opens `docs/index.html`: paste your email HTML, click **Run QA** for the report or **Preview** to render it (Desktop / Mobile, AMPscript shown as placeholders). Runs entirely in the browser.

## Severity model

- **FAIL** - breaks the audit: missing/duplicate/spaced alias, missing/empty/placeholder ALT on content images, missing/empty/invalid/non-HTTPS href, tracking, content block or unsubscribe problems, image without SRC.
- **WARN** - fails only with `--strict`: image with no link, empty ALT on an unlinked (decorative) image, non-HTTPS image SRC, hidden elements.
- **INFO** - text links have no SRC/ALT by definition; reported, never failing.

Missing items are always shown in **bold** (`**Missing**`, `**Missing / Text Link**`) in the report.

## Design notes

- SFMC templates contain AMPscript such as `href="%%=RedirectTo(concat("https://", @x))=%%"` whose nested quotes break normal HTML parsers. [`src/parser.js`](src/parser.js) is a small scanner that treats `%%=...=%%` as atomic inside attributes, and masks `%%[ ... ]%%` blocks and HTML comments (Outlook `<!--[if mso]>` content is still audited).
- Line numbers refer to the original file.
- Alias comparison for duplicates is case-insensitive.
- Content blocks referenced in the email are reported but **not resolved** - links inside the content block itself (e.g. the footer) are not visible to this tool.
- AMPscript hrefs are not flagged as non-HTTPS because their final scheme is only known at send time.

## Development

```bash
npm test
```

## Publishing to GitHub

```bash
cd sfmc-email-qa
git init -b main
git add .
git commit -m "Initial commit: SFMC email QA"
git remote add origin https://github.com/<your-user>/sfmc-email-qa.git
git push -u origin main
```

GitHub Actions (`.github/workflows/ci.yml`) runs the tests on Ubuntu, Windows and macOS with Node 18/20/22.

### Gate a repository of emails in CI

```yaml
- run: node src/cli.js emails/ --out reports/
- uses: actions/upload-artifact@v4
  if: always()
  with: { name: qa-reports, path: reports/ }
```
