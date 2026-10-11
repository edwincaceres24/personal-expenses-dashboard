/**
 * Server side: web app entry point, sheet access, caching and endpoints.
 * Business logic lives in Logic.js (pure functions, unit-tested with Jest).
 * Read-only: this script never writes to the spreadsheet.
 */

var SHEET_ID_PROPERTY = 'SHEET_ID';
var SETTINGS_PROPERTY = 'settings';
var TABS = {
  expenses: 'Expenses',
  budgets: 'Budgets',
  framework: 'Financial Framework'
};
var CACHE_KEY = 'parsed-data-v2';
var CACHE_TTL_SECONDS = 300;
var CACHE_CHUNK_SIZE = 90000; // CacheService values are limited to 100 KB

/** Serves the dashboard page. */
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Expenses')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Inlines another HTML file (used by Index.html for Styles/Client). */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

// ---------------------------------------------------------------------------
// Endpoints (called with google.script.run). They never throw: they return
// { ok: true, data } or { ok: false, error: { code, message } }.
// ---------------------------------------------------------------------------

function getDashboard(month, forceRefresh) {
  return respond_(() => {
    const loaded = loadData_(!!forceRefresh);
    const today = Utilities.formatDate(new Date(), 'America/Lima', 'yyyy-MM-dd');
    const dashboard = buildDashboard(loaded.data, {
      month: month,
      today: today,
      settings: readSettings_()
    });
    dashboard.loadedAt = loaded.loadedAt;
    dashboard.fromCache = loaded.fromCache;
    return dashboard;
  });
}

function saveSettings(settings) {
  return respond_(() => {
    const clean = sanitizeSettings(settings);
    PropertiesService.getUserProperties().setProperty(SETTINGS_PROPERTY, JSON.stringify(clean));
    return clean;
  });
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function AppError_(code, message) {
  this.code = code;
  this.message = message;
}

function respond_(fn) {
  try {
    return { ok: true, data: fn() };
  } catch (e) {
    if (e instanceof AppError_) return { ok: false, error: { code: e.code, message: e.message } };
    console.error(e && e.stack ? e.stack : e);
    return {
      ok: false,
      error: { code: 'UNEXPECTED', message: 'Unexpected error: ' + (e && e.message ? e.message : String(e)) }
    };
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function readSettings_() {
  const raw = PropertiesService.getUserProperties().getProperty(SETTINGS_PROPERTY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sheet access + cache
// ---------------------------------------------------------------------------

function loadData_(forceRefresh) {
  const cache = CacheService.getScriptCache();
  if (!forceRefresh) {
    const cached = cacheGet_(cache, CACHE_KEY);
    if (cached) {
      cached.fromCache = true;
      return cached;
    }
  }
  const fresh = { data: readSheet_(), loadedAt: new Date().toISOString(), fromCache: false };
  cachePut_(cache, CACHE_KEY, fresh, CACHE_TTL_SECONDS);
  return fresh;
}

function getSheetId_() {
  let id = PropertiesService.getScriptProperties().getProperty(SHEET_ID_PROPERTY);
  id = id ? String(id).trim() : '';
  if (!id) {
    throw new AppError_('SHEET_ID_MISSING',
      'The SHEET_ID script property is not set. In the Apps Script editor open ' +
      'Project Settings → Script Properties and add SHEET_ID with your spreadsheet ID.');
  }
  // Accept a full spreadsheet URL by mistake and extract the ID from it.
  const m = id.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : id;
}

/** Maps a Sheets API failure to a specific, readable error (keeping the raw text). */
function sheetsError_(e, id) {
  const msg = String(e && e.message ? e.message : e);
  if (typeof Sheets === 'undefined' || /Sheets is not defined/.test(msg)) {
    return new AppError_('SHEETS_API_DISABLED',
      'The Google Sheets API advanced service is not enabled for this script. In the Apps Script ' +
      'editor click Services (+), add "Google Sheets API" (v4), then reload. (' + msg + ')');
  }
  if (/not found|404/i.test(msg)) {
    return new AppError_('SHEET_NOT_FOUND',
      'Spreadsheet "' + id + '" (SHEET_ID) was not found. Check that the ID is correct. (' + msg + ')');
  }
  if (/permission|403|access/i.test(msg)) {
    return new AppError_('NO_PERMISSION',
      'No permission to read spreadsheet "' + id + '" (SHEET_ID). Make sure the account that deployed ' +
      'the web app can view it, then open the web app again to re-authorize. (' + msg + ')');
  }
  return new AppError_('SHEET_READ_FAILED', 'Could not read the spreadsheet. (' + msg + ')');
}

/**
 * Reads the three tabs with one Sheets API batchGet call (read-only scope).
 * Values come unformatted: numbers stay numbers and date cells are serial
 * numbers, which Logic.parseDate converts without locale ambiguity.
 */
function readSheet_() {
  const id = getSheetId_();
  let titles;
  try {
    const meta = Sheets.Spreadsheets.get(id, { fields: 'sheets.properties.title' });
    titles = (meta.sheets || []).map(sh => { return sh.properties.title; });
  } catch (e) {
    throw sheetsError_(e, id);
  }
  [TABS.expenses, TABS.budgets, TABS.framework].forEach(name => {
    if (titles.indexOf(name) < 0) {
      throw new AppError_('TAB_NOT_FOUND',
        'Tab "' + name + '" was not found in the spreadsheet. Tabs found: ' + titles.join(', ') + '.');
    }
  });

  const ranges = [
    quoteTab_(TABS.expenses) + '!A:H',
    quoteTab_(TABS.budgets) + '!A:B',
    quoteTab_(TABS.framework) + '!A:H'
  ];
  let res;
  try {
    res = Sheets.Spreadsheets.Values.batchGet(id, {
      ranges: ranges,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER'
    });
  } catch (e) {
    throw sheetsError_(e, id);
  }
  const vr = res.valueRanges || [];
  const values = i => { return (vr[i] && vr[i].values) || []; };

  const parsed = parseExpenses(values(0));
  const budgets = parseBudgets(values(1));
  const income = findIncome(values(2));
  if (income === null) {
    throw new AppError_('INCOME_NOT_FOUND',
      'Could not find a numeric "Mothly Income" value (label in column G, value in column H) ' +
      'in the "' + TABS.framework + '" tab.');
  }
  return { expenses: parsed.expenses, invalid: parsed.invalid, budgets: budgets, income: income };
}

function quoteTab_(name) {
  return "'" + name.replace(/'/g, "''") + "'";
}

/** Stores JSON split across several keys to stay under the 100 KB value limit. */
function cachePut_(cache, key, obj, ttl) {
  try {
    const json = JSON.stringify(obj);
    const entries = {};
    const n = Math.ceil(json.length / CACHE_CHUNK_SIZE);
    for (let i = 0; i < n; i++) {
      entries[key + ':' + i] = json.slice(i * CACHE_CHUNK_SIZE, (i + 1) * CACHE_CHUNK_SIZE);
    }
    entries[key + ':n'] = String(n);
    cache.putAll(entries, ttl);
  } catch (e) {
    console.warn('Cache write skipped: ' + e); // caching is best-effort
  }
}

function cacheGet_(cache, key) {
  try {
    const n = Number(cache.get(key + ':n'));
    if (!n) return null;
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(key + ':' + i);
    const parts = cache.getAll(keys);
    let json = '';
    for (let j = 0; j < n; j++) {
      if (parts[keys[j]] === undefined) return null;
      json += parts[keys[j]];
    }
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}
