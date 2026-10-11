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
  appsscript.json   Manifest (V8, America/Lima, read-only Sheets scope, Sheets API service, web app config)
  Code.js           doGet, server endpoints, sheet access, cache
  Logic.js          Pure business logic (no Apps Script globals), unit tested with Jest
  Summary.js        Pure logic + email HTML for the Monday weekly summary
  WeeklySummary.js  Weekly summary agent: trigger, run-now, Claude call orchestration
  Claude.js         Claude API helper (askClaude, via UrlFetchApp)
  Notifier.js       Shared email helper (recipient, dashboard link)
  Index.html        Layout
  Styles.html       CSS (light/dark via prefers-color-scheme)
  Client.html       Client-side JS (vanilla, inline SVG chart)
tests/
  logic.test.js     Unit tests for Logic.js
  summary.test.js   Unit tests for Summary.js (weeks, report, payload, validation, email)
  weekly-summary.test.js  Apps Script layer with mocked services (the real API is never called)
  ui.test.js        UI smoke tests (real HTML/JS in jsdom, fake data)
dev/
  fixtures.js       Fake spreadsheet data with the known quirks (never real data)
  build-preview.js  Builds a standalone page from src/ with google.script.run stubbed
  preview.js        Local preview server (npm run preview)
scripts/deploy.js   Helper used by `npm run deploy`
.github/workflows/  CI: runs the tests on every push and pull request
```

## How the sheet is read

The sheet is read with the **Google Sheets API advanced service** (`Sheets`), using
one `values.batchGet` call that covers all three tabs. The only OAuth scope is
`spreadsheets.readonly`.

`SpreadsheetApp.openById()` isn't used because it requires the full read/write
`spreadsheets` scope. With only the read-only scope, it fails with "You do not have
permission to call SpreadsheetApp.openById".

The advanced service is declared in `appsscript.json`. If you see "Google Sheets API
service not enabled", open the editor, click **Services (+)** and add
**Google Sheets API v4**.

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

### 2. Install dependencies (clasp, jest, jsdom)

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
npm test     # run the tests
npm run push # runs the tests, then clasp push --force (uploads src/)
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

## Weekly summary (Monday email)

Every Monday around 8:00 (America/Lima) the script emails the previous Monday–Sunday
week: spending vs. the weekly limit for **all** categories (watched ones are marked ★,
rent is excluded), the total against the week before, the top 5 expenses, the month
closing/projection, a data-quality line, and 2–3 recommendations written by Claude.
If the week crosses two months you get the closing result of the first and the
projection of the second. It never writes to the spreadsheet.

**Setup** (Apps Script editor, **Project Settings**, **Script Properties**):

| Property | Required | Value |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Your Claude API key. Never commit it. |
| `ALERT_EMAIL` | no | Recipient. Defaults to the script owner's email. |
| `DASHBOARD_URL` | no | Your web app `/exec` URL, used for the link in the email. |
| `CLAUDE_MODEL` | no | Defaults to `claude-haiku-5-5`. |
| `ANTHROPIC_WORKSPACE_ID` | only for keys not scoped to a workspace | Sent as the `anthropic-workspace-id` header. Not needed if the key was created inside a workspace. |

1. Push the code (`npm run push`).
2. In the editor, select `setupWeeklySummary` and click **Run**. Google asks you to
   authorize the new scopes: send email (`script.send_mail`), call the Claude API
   (`script.external_request`) and manage triggers (`script.scriptapp`). The sheet scope
   stays read-only. The scopes are also listed in `appsscript.json`.
3. Test it with `runWeeklySummaryNow` (sends immediately, ignores the once-per-week
   check, and does not use up that week's slot).

`removeWeeklySummary` deletes the trigger. Only one summary is sent per ISO week
(`WEEKLY_SUMMARY_LAST` property, e.g. `summary:2026-W41`). If Claude fails, times out
or returns invalid JSON, the email is still sent with "Recommendations unavailable this
week". Token usage is logged to the execution log. Only aggregates and the top 5
expenses (notes cut to 40 characters, account names removed) are sent to Claude. The
system prompt is the `SUMMARY_SYSTEM_PROMPT` constant in `src/Summary.js`.

Triggers run the **HEAD** code, so a `clasp push` changes the summary immediately.

## Usage notes

- **Caching**: data is cached for 5 minutes. **Refresh data** bypasses the cache and
  re-reads the sheet.
- **Settings**: the watched categories and cap % are stored with
  `PropertiesService.getUserProperties()`. Budgets and income always come from the sheet.
- **Errors**: problems show a specific message instead of a blank page. Examples are
  SHEET_ID not set, tab not found, no permission, and income label not found.

## Development workflow

Each step below gets closer to production. Do them in order, and only deploy when
everything before it is green.

| Step | Command | Data | Who sees it |
|---|---|---|---|
| 1. Unit and UI tests | `npm test` | fake | only you (local) |
| 2. Local preview | `npm run preview` | fake | only you (local) |
| 3. Test deployment | `npm run push`, then open the `/dev` URL | **real** | only you (latest pushed code) |
| 4. Release | `npm run deploy` | real | your web app URL (`/exec`) |

### 1. Tests

```bash
npm test             # unit tests (Logic.js) + UI smoke tests (jsdom)
npm run test:watch   # re-run on save
```

- **Logic changes**: write or adjust a test in `tests/logic.test.js` first, watch it
  fail, then make it pass.
- **UI changes**: `tests/ui.test.js` loads the real `Index`, `Styles` and `Client` HTML
  in jsdom, with the server stubbed. jsdom has no layout engine, so check visual
  changes in the preview.

### 2. Local preview (no Apps Script, fake data)

```bash
npm run preview      # http://localhost:8080 — edit src/ and refresh
```

The page is built from `src/` on every request. `google.script.run` is replaced by a
stub that runs the real `Logic.js` on the fake data in `dev/fixtures.js`. Settings
are saved in the browser's localStorage. URL parameters:

| Parameter | Example | Use |
|---|---|---|
| `today` | `?today=2026-10-01` | Test month starts and ends, week boundaries, day-1 labels |
| `scenario` | `?scenario=empty`, `?scenario=error:NO_PERMISSION` | Empty and error states |
| `delay` | `?delay=1500` | Loading states |

To check the mobile layout, open DevTools and turn on device emulation (about 375px
wide). To check dark mode, use DevTools' rendering options or switch your OS theme.

### 3. Test with real data before releasing

`npm run push` runs the tests, then uploads `src/` to Apps Script. Pushing **does
not** change your web app URL. It only updates the **test deployment**, which always
runs the latest pushed code:

1. In the editor, go to **Deploy**, then **Test deployments**, and copy the URL that
   ends in `/dev`. Bookmark it; it never changes.
2. Open it and check your change against the real sheet. Use **Refresh data** to
   skip the 5-minute cache.

`npm run push:watch` re-pushes on every save. It's handy together with the `/dev` URL.

### 4. Release

```bash
export DEPLOYMENT_ID=<your-deployment-id>   # `npx clasp list-deployments` shows it
DEPLOY_DESC="Short description of the change" npm run deploy
```

This runs the tests, pushes, and points your web app at a new version, so the URL
stays the same. To roll back, go to **Deploy**, then **Manage deployments**, then
the pencil (edit), and pick an earlier version.

### Git workflow

1. Create a branch per change: `git checkout -b fix/short-name`.
2. Make small commits in [Conventional Commits](https://www.conventionalcommits.org/)
   format (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
3. Push the branch and open a pull request. CI runs `npm test`.
4. Merge to `main` when it's green and you've checked it on the `/dev` URL.
5. Run `npm run deploy` from `main`.

### Notes

`Logic.js` uses no Apps Script globals and exports its functions with
`module.exports` when running in Node, so the same file runs in Apps Script, in Jest
and in the local preview.

### Security

- Never commit `.clasprc.json`, tokens, or the spreadsheet ID.
- The script ID in `.clasp.json` is not a secret, because access is controlled by
  your Google account.
- The web app runs as you and is reachable **only by you**.
