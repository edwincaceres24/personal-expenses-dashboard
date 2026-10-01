# Personal Tracker — Expenses

A personal expense dashboard built as a Google Apps Script web app. It reads (never
writes) a Google Sheet that is filled through a Google Form, and shows:

- **Month pace**: spending vs. a monthly cap (a percentage of income, 55% by default),
  with a marker for today and a projected month-end total. Closed months show the
  final result.
- **Weekly control** (Monday–Sunday) for watched categories, where the weekly limit is
  monthly budget × 12 ÷ 52. You can switch between this week and last week.
- **Categories of the month** vs. budget, with a status: on track, ahead of pace,
  over budget or no budget.
- **6-month trend** chart with the cap as a reference line.
- **Data quality** checks: missing rent, invalid amounts, vague notes, and spending
  with no budget.
- **Latest 12 transactions** of the selected month.
- **Settings** (watched categories and cap %), saved per user.

All amounts are in Peruvian soles (PEN). The UI is in English, and the time zone is
`America/Lima`.

## Project structure

```
src/
  appsscript.json   Manifest (V8, America/Lima, read-only Sheets scope, web app config)
  Code.js           doGet, server endpoints, sheet access, cache
  Logic.js          Pure business logic (no Apps Script globals), unit tested with Jest
  Index.html        Layout
  Styles.html       CSS (light/dark via prefers-color-scheme)
  Client.html       Client-side JS (vanilla, inline SVG chart)
tests/logic.test.js Jest tests for Logic.js
scripts/deploy.js   Helper used by `npm run deploy`
```

## Spreadsheet expectations

| Tab | Range | Notes |
|---|---|---|
| `Expenses` | A:H, header in row 1 | Timestamp, Amount, Category, Account, Note, Date (`MM-DD-YYYY`), Month, Year. Columns are read **by position**. |
| `Budgets` | A:B | Category, monthly threshold |
| `Financial Framework` | any | The row whose column G says `Mothly Income`; its value is read from column H. |

How the data quirks are handled:
- **Non-numeric amounts** are excluded from all totals and listed in the data-quality panel with their row number.
- **Invalid dates** in the Date column fall back to the Timestamp.
- **Out-of-order rows** are always sorted by date.
- **Rent is a lump sum**: it's counted as-is in the month-end projection, and only the rest of the spending is extrapolated. It is never marked "ahead of pace".
- **Missing rent**: a month with no Rent entry of S/ 1,000 or more is flagged. The current month shows "not recorded yet" instead.
- **Vague notes** are counted: empty notes, "Gaaa", a bare number, an account name, or fewer than 3 letters.

## Setup

### 1. Prerequisites

- Node.js 18 or newer, and npm
- The Google account that owns, or can view, the expense spreadsheet
- The Apps Script API turned on for that account at
  <https://script.google.com/home/usersettings>

### 2. Install dependencies (clasp and jest)

```bash
git clone https://github.com/<your-user>/personal-tracker-expenses.git
cd personal-tracker-expenses
npm install
```

`clasp` is installed locally, so use `npx clasp ...`. You can also install it globally
with `npm install -g @google/clasp`.

### 3. Log in to clasp

```bash
npx clasp login
```

This stores your credentials in `~/.clasprc.json`. **Never commit that file**; it is
already in `.gitignore`.

### 4. Create or link the Apps Script project

`.clasp.json` points at an existing script ID with `rootDir: "src"`.

- **To use your own project instead**, create one:

  ```bash
  rm .clasp.json
  npx clasp create --type webapp --title "Expenses" --rootDir src
  ```

  clasp might overwrite `src/appsscript.json`. If it does, restore it with
  `git checkout src/appsscript.json`.
- **To link an existing project**, put its script ID (from Project Settings in the
  Apps Script editor) in `.clasp.json`:

  ```json
  { "scriptId": "<your-script-id>", "rootDir": "src" }
  ```

### 5. Set the `SHEET_ID` script property

The spreadsheet ID is **not** stored in the repo. Set it as a script property:

1. Run `npx clasp open-script` (or open the project at script.google.com).
2. Go to **Project Settings** (the gear icon), then **Script Properties**, then **Add script property**.
3. Enter **Property** `SHEET_ID` and **Value** the spreadsheet ID. That's the part
   of the sheet URL between `/d/` and `/edit`.
4. Click **Save script properties**.

### 6. Push the code

```bash
npm test     # run the unit tests
npm run push # clasp push --force (uploads src/)
```

### 7. Deploy as a web app

The first time, deploy from the editor so you can review the authorization prompt:

1. In the Apps Script editor, click **Deploy**, then **New deployment**, then the gear icon, then **Web app**.
2. Set **Execute as** to *Me* and **Who has access** to *Only myself*. These match
   `appsscript.json`.
3. Click **Deploy** and authorize the requested scope. The only scope is read-only
   access to your spreadsheets.
4. Copy the **Web app URL** and the **Deployment ID**.

You can also run `npm run deploy` without `DEPLOYMENT_ID` to create a new deployment
from the CLI. If you do, open the web app URL once to authorize it.

### 8. Update the deployment after changes

Redeploying to the **same deployment ID** keeps the same URL:

```bash
export DEPLOYMENT_ID=<your-deployment-id>   # e.g. put it in your shell profile, not in the repo
npm run deploy                              # tests → push → new version on the same deployment
```

You can also do it from the editor: **Deploy**, then **Manage deployments**, then
pencil (edit), then **Version: New version**, then **Deploy**.

To try changes without redeploying, use the `/dev` URL. You'll find it under
**Deploy**, then **Test deployments**, and it always runs the latest pushed code.

## Usage notes

- **Caching**: data is cached for 5 minutes. **Refresh data** bypasses the cache and
  re-reads the sheet.
- **Settings**: the watched categories and cap % are stored with
  `PropertiesService.getUserProperties()`. Budgets and income always come from the sheet.
- **Errors**: problems show a specific message instead of a blank page. Examples are
  SHEET_ID not set, tab not found, no permission, and income label not found.

## Development

```bash
npm test             # Jest unit tests for src/Logic.js
npx clasp push --watch
```

`Logic.js` uses no Apps Script globals and exports its functions with
`module.exports` when running in Node, so the same file runs in both environments.

### Security

- Never commit `.clasprc.json`, tokens, or the spreadsheet ID.
- The script ID in `.clasp.json` is not a secret, because access is controlled by
  your Google account.
- The web app runs as you and is reachable **only by you**.
