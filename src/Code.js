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
var CACHE_KEY = 'parsed-data-v1';
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
  return respond_(function () {
    var loaded = loadData_(!!forceRefresh);
    var today = Utilities.formatDate(new Date(), 'America/Lima', 'yyyy-MM-dd');
    var dashboard = buildDashboard(loaded.data, {
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
  return respond_(function () {
    var clean = sanitizeSettings(settings);
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
  var raw = PropertiesService.getUserProperties().getProperty(SETTINGS_PROPERTY);
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
  var cache = CacheService.getScriptCache();
  if (!forceRefresh) {
    var cached = cacheGet_(cache, CACHE_KEY);
    if (cached) {
      cached.fromCache = true;
      return cached;
    }
  }
  var fresh = { data: readSheet_(), loadedAt: new Date().toISOString(), fromCache: false };
  cachePut_(cache, CACHE_KEY, fresh, CACHE_TTL_SECONDS);
  return fresh;
}

function openSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty(SHEET_ID_PROPERTY);
  if (!id || !String(id).trim()) {
    throw new AppError_('SHEET_ID_MISSING',
      'The SHEET_ID script property is not set. In the Apps Script editor open ' +
      'Project Settings → Script Properties and add SHEET_ID with your spreadsheet ID.');
  }
  try {
    return SpreadsheetApp.openById(String(id).trim());
  } catch (e) {
    var msg = String(e && e.message ? e.message : e);
    if (/permission|access denied|not have access/i.test(msg)) {
      throw new AppError_('NO_PERMISSION',
        'No permission to open the spreadsheet set in SHEET_ID. Make sure the account ' +
        'that deployed the web app can view it.');
    }
    throw new AppError_('SHEET_NOT_FOUND',
      'Could not open the spreadsheet set in SHEET_ID. Check that the ID is correct. (' + msg + ')');
  }
}

function getTabValues_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    throw new AppError_('TAB_NOT_FOUND', 'Tab "' + name + '" was not found in the spreadsheet.');
  }
  var values = sheet.getDataRange().getValues();
  var tz = ss.getSpreadsheetTimeZone();
  return values.map(function (row) {
    return row.map(function (cell) {
      return cell instanceof Date ? Utilities.formatDate(cell, tz, 'yyyy-MM-dd') : cell;
    });
  });
}

function readSheet_() {
  var ss = openSpreadsheet_();
  var parsed = parseExpenses(getTabValues_(ss, TABS.expenses).map(function (r) {
    return r.slice(0, 8);
  }));
  var budgets = parseBudgets(getTabValues_(ss, TABS.budgets));
  var income = findIncome(getTabValues_(ss, TABS.framework));
  if (income === null) {
    throw new AppError_('INCOME_NOT_FOUND',
      'Could not find a numeric "Mothly Income" value (label in column G, value in column H) ' +
      'in the "' + TABS.framework + '" tab.');
  }
  return { expenses: parsed.expenses, invalid: parsed.invalid, budgets: budgets, income: income };
}

/** Stores JSON split across several keys to stay under the 100 KB value limit. */
function cachePut_(cache, key, obj, ttl) {
  try {
    var json = JSON.stringify(obj);
    var entries = {};
    var n = Math.ceil(json.length / CACHE_CHUNK_SIZE);
    for (var i = 0; i < n; i++) {
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
    var n = Number(cache.get(key + ':n'));
    if (!n) return null;
    var keys = [];
    for (var i = 0; i < n; i++) keys.push(key + ':' + i);
    var parts = cache.getAll(keys);
    var json = '';
    for (var j = 0; j < n; j++) {
      if (parts[keys[j]] === undefined) return null;
      json += parts[keys[j]];
    }
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}
