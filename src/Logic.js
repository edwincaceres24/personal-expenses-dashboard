/**
 * Pure business logic for the expense dashboard.
 *
 * No Apps Script globals (SpreadsheetApp, Utilities, ...) are used here, so the
 * same file runs in Apps Script and in Node (Jest). Dates are handled as
 * 'YYYY-MM-DD' strings; Code.js converts any sheet Date objects to that format
 * in the America/Lima time zone before calling into this file.
 */

var CATEGORY_LABELS = {
  Laisure: 'Leisure',
  Deuda: 'Debt'
};

var KNOWN_CATEGORIES = [
  'Food', 'Restaurant', 'Relationship', 'Household', 'Rent', 'Health', 'Family',
  'Laisure', 'Apparel', 'Transport', 'Car', 'Beauty', 'Other', 'Education',
  'Pets', 'Gift', 'Subscription', 'Deuda'
];

var KNOWN_ACCOUNTS = ['AMEX', 'VISA', 'Cash'];

var DEFAULT_SETTINGS = {
  watched: ['Restaurant', 'Relationship', 'Household', 'Beauty'],
  capPct: 55
};

var RENT_CATEGORY = 'Rent';
var RENT_MIN_AMOUNT = 1000;
// Paid once per month: counted as-is in projections (not extrapolated) and
// never flagged "ahead of pace".
var LUMP_SUM_CATEGORIES = ['Rent'];
var PACE_TOLERANCE = 0.10;
var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------------------
// Dates (all as 'YYYY-MM-DD' strings, calendar arithmetic in UTC)
// ---------------------------------------------------------------------------

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function isValidYMD(y, m, d) {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1)) return false;
  return d <= daysInMonth(y, m);
}

function toISO(y, m, d) {
  return y + '-' + pad2(m) + '-' + pad2(d);
}

/** Days in month m (1-12) of year y. */
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Parses the date formats found in the sheet into 'YYYY-MM-DD', or null.
 * Accepts 'YYYY-MM-DD', 'MM-DD-YYYY', 'M/D/YYYY' and 'M/D/YYYY H:MM:SS'.
 */
function parseDate(value) {
  if (value === null || value === undefined) return null;
  var s = String(value).trim();
  if (!s) return null;
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    var y1 = +m[1], mo1 = +m[2], d1 = +m[3];
    return isValidYMD(y1, mo1, d1) ? toISO(y1, mo1, d1) : null;
  }
  m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})(?:[ T]+\d{1,2}:\d{2}(?::\d{2})?)?$/);
  if (m) {
    var mo = +m[1], d = +m[2], y = +m[3];
    return isValidYMD(y, mo, d) ? toISO(y, mo, d) : null;
  }
  return null;
}

function isoToUTC(iso) {
  var p = iso.split('-');
  return Date.UTC(+p[0], +p[1] - 1, +p[2]);
}

function utcToISO(ms) {
  var dt = new Date(ms);
  return toISO(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function addDays(iso, n) {
  return utcToISO(isoToUTC(iso) + n * 86400000);
}

function monthOf(iso) {
  return iso.slice(0, 7);
}

function addMonths(month, n) {
  var y = +month.slice(0, 4), m = +month.slice(5, 7) - 1 + n;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  return y + '-' + pad2(m + 1);
}

function daysInMonthKey(month) {
  return daysInMonth(+month.slice(0, 4), +month.slice(5, 7));
}

function lastDayOfMonth(month) {
  return month + '-' + pad2(daysInMonthKey(month));
}

/** Monday–Sunday week containing iso. */
function weekRange(iso) {
  var dow = new Date(isoToUTC(iso)).getUTCDay(); // 0 = Sunday
  var offset = (dow + 6) % 7; // days since Monday
  var start = addDays(iso, -offset);
  return { start: start, end: addDays(start, 6) };
}

/** 'past' | 'current' | 'future' relative to today's month. */
function monthState(month, today) {
  var current = monthOf(today);
  if (month < current) return 'past';
  if (month > current) return 'future';
  return 'current';
}

/** Fraction of the month elapsed (1 for past months, 0 for future). */
function elapsedFraction(month, today) {
  var state = monthState(month, today);
  if (state === 'past') return 1;
  if (state === 'future') return 0;
  return +today.slice(8, 10) / daysInMonthKey(month);
}

// ---------------------------------------------------------------------------
// Formatting / labels
// ---------------------------------------------------------------------------

function displayCategory(key) {
  return CATEGORY_LABELS[key] || key;
}

/** 'S/ 1,234' (decimals = 0) or 'S/ 1,234.50' (decimals = 2). */
function formatPEN(amount, decimals) {
  decimals = decimals || 0;
  var n = Number(amount) || 0;
  var neg = n < 0;
  var fixed = Math.abs(n).toFixed(decimals);
  var parts = fixed.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  var out = 'S/ ' + parts.join('.');
  return (neg && Number(fixed) !== 0 ? '-' : '') + out;
}

/** 'Sep 27' */
function formatShortDate(iso) {
  return MONTH_NAMES[+iso.slice(5, 7) - 1] + ' ' + (+iso.slice(8, 10));
}

/** 'Sep 2026' */
function formatMonth(month) {
  return MONTH_NAMES[+month.slice(5, 7) - 1] + ' ' + month.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Number from a cell, or null if it is not a valid amount. */
function parseAmount(value) {
  if (typeof value === 'number') return isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  var s = String(value).trim().replace(/^S\/\.?\s*/i, '').replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

function normalizeCategory(value) {
  var s = String(value === null || value === undefined ? '' : value).trim();
  for (var i = 0; i < KNOWN_CATEGORIES.length; i++) {
    if (KNOWN_CATEGORIES[i].toLowerCase() === s.toLowerCase()) return KNOWN_CATEGORIES[i];
  }
  return s;
}

function normalizeAccount(value) {
  var s = String(value === null || value === undefined ? '' : value).trim();
  for (var i = 0; i < KNOWN_ACCOUNTS.length; i++) {
    if (KNOWN_ACCOUNTS[i].toLowerCase() === s.toLowerCase()) return KNOWN_ACCOUNTS[i];
  }
  return s;
}

function isBlankRow(row) {
  for (var i = 0; i < row.length; i++) {
    if (row[i] !== '' && row[i] !== null && row[i] !== undefined) return false;
  }
  return true;
}

function compareExpenses(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.row - b.row;
}

/**
 * Parses the "Expenses" tab (values include the header row).
 * Columns by position: 0 Timestamp, 1 Amount, 2 Category, 3 Account, 4 Note, 5 Date.
 * Returns { expenses: [...sorted by date], invalid: [...] }.
 */
function parseExpenses(values) {
  var expenses = [];
  var invalid = [];
  for (var i = 1; i < (values ? values.length : 0); i++) {
    var r = values[i] || [];
    if (isBlankRow(r)) continue;
    var rowNum = i + 1;
    var date = parseDate(r[5]);
    var dateSource = 'date';
    if (!date) {
      date = parseDate(r[0]);
      dateSource = 'timestamp';
    }
    var category = normalizeCategory(r[2]);
    var note = String(r[4] === null || r[4] === undefined ? '' : r[4]).trim();
    var amount = parseAmount(r[1]);
    var base = {
      row: rowNum,
      date: date,
      category: category,
      account: normalizeAccount(r[3]),
      note: note
    };
    if (amount === null) {
      base.rawAmount = String(r[1] === null || r[1] === undefined ? '' : r[1]);
      base.reason = 'Amount is not a number';
      invalid.push(base);
    } else if (!date) {
      base.rawAmount = String(r[1]);
      base.reason = 'Date is not valid';
      invalid.push(base);
    } else {
      base.amount = amount;
      base.month = monthOf(date);
      base.dateSource = dateSource;
      expenses.push(base);
    }
  }
  expenses.sort(compareExpenses);
  invalid.sort(function (a, b) { return a.row - b.row; });
  return { expenses: expenses, invalid: invalid };
}

/** Parses "Budgets" (Category | Monthly threshold) into { key: amount }. */
function parseBudgets(values) {
  var budgets = {};
  for (var i = 1; i < (values ? values.length : 0); i++) {
    var r = values[i] || [];
    var key = normalizeCategory(r[0]);
    var amount = parseAmount(r[1]);
    if (key && amount !== null) budgets[key] = amount;
  }
  return budgets;
}

/**
 * Finds the monthly income in "Financial Framework": label in column G,
 * value in column H. Returns a number, or null if not found / not numeric.
 */
function findIncome(values) {
  for (var i = 0; i < (values ? values.length : 0); i++) {
    var r = values[i] || [];
    var label = String(r[6] === null || r[6] === undefined ? '' : r[6])
      .trim().toLowerCase().replace(/\s+/g, ' ');
    if (label === 'mothly income' || label === 'monthly income') {
      return parseAmount(r[7]);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function sum(list) {
  var t = 0;
  for (var i = 0; i < list.length; i++) t += list[i].amount;
  return Math.round(t * 100) / 100;
}

function inMonth(expenses, month) {
  return expenses.filter(function (e) { return e.month === month; });
}

function inRange(expenses, start, end) {
  return expenses.filter(function (e) { return e.date >= start && e.date <= end; });
}

/** Months with data plus the current month, newest first. */
function availableMonths(expenses, today) {
  var seen = {};
  seen[monthOf(today)] = true;
  expenses.forEach(function (e) { seen[e.month] = true; });
  return Object.keys(seen).sort().reverse();
}

function isLumpSum(category) {
  return LUMP_SUM_CATEGORIES.indexOf(category) >= 0;
}

/**
 * Spent vs. cap for a month. For the current month the projection is
 * lump sums (rent) + variable spend ÷ days elapsed × days in month.
 */
function monthSummary(expenses, month, today, income, capPct) {
  var state = monthState(month, today);
  var dim = daysInMonthKey(month);
  var items = inMonth(expenses, month);
  var spent = sum(items);
  var lumpSum = sum(items.filter(function (e) { return isLumpSum(e.category); }));
  var cap = income !== null && income !== undefined ? Math.round(income * capPct) / 100 : null;
  var daysElapsed = state === 'past' ? dim : state === 'future' ? 0 : +today.slice(8, 10);
  var projected = null;
  if (state === 'current' && daysElapsed > 0) {
    projected = Math.round((lumpSum + (spent - lumpSum) / daysElapsed * dim) * 100) / 100;
  }
  var reference = state === 'past' ? spent : projected;
  return {
    month: month,
    state: state,
    closed: state === 'past',
    spent: spent,
    lumpSum: lumpSum,
    cap: cap,
    capPct: capPct,
    income: income,
    daysElapsed: daysElapsed,
    daysInMonth: dim,
    dayFraction: daysElapsed / dim,
    projected: projected,
    remaining: cap === null ? null : Math.round((cap - spent) * 100) / 100,
    overCap: cap !== null && reference !== null ? reference > cap : false
  };
}

/** Status of a category's spend vs. its budget. */
function categoryStatus(spent, budget, fraction, closed, lumpSum) {
  if (!budget) return 'no-budget';
  if (spent > budget) return 'over';
  if (!closed && !lumpSum && spent > budget * fraction * (1 + PACE_TOLERANCE)) return 'ahead';
  return 'on-track';
}

/** Per-category spend for the month, sorted by amount (desc). */
function categoryBreakdown(expenses, month, budgets, today) {
  var totals = {};
  var counts = {};
  inMonth(expenses, month).forEach(function (e) {
    totals[e.category] = (totals[e.category] || 0) + e.amount;
    counts[e.category] = (counts[e.category] || 0) + 1;
  });
  Object.keys(budgets).forEach(function (k) {
    if (budgets[k] > 0 && !(k in totals)) totals[k] = 0;
  });
  var fraction = elapsedFraction(month, today);
  var closed = monthState(month, today) === 'past';
  return Object.keys(totals).map(function (k) {
    var spent = Math.round(totals[k] * 100) / 100;
    var budget = budgets[k] > 0 ? budgets[k] : null;
    return {
      key: k,
      label: displayCategory(k),
      spent: spent,
      count: counts[k] || 0,
      budget: budget,
      pct: budget ? spent / budget : null,
      status: categoryStatus(spent, budget, fraction, closed, isLumpSum(k))
    };
  }).sort(function (a, b) {
    return b.spent - a.spent || a.label.localeCompare(b.label);
  });
}

function weeklyLimit(monthlyBudget) {
  if (!(monthlyBudget > 0)) return null;
  return Math.round(monthlyBudget * 12 / 52 * 100) / 100;
}

/** Day the weekly control is anchored to for the selected month. */
function weekAnchor(month, today) {
  var state = monthState(month, today);
  if (state === 'current') return today;
  if (state === 'past') return lastDayOfMonth(month);
  return month + '-01';
}

/** Weekly control for watched categories in the Monday–Sunday week of anchor. */
function weeklyControl(expenses, budgets, watched, anchor) {
  var range = weekRange(anchor);
  var week = inRange(expenses, range.start, range.end);
  var rows = (watched || []).map(function (k) {
    var spent = sum(week.filter(function (e) { return e.category === k; }));
    var limit = weeklyLimit(budgets[k]);
    return {
      key: k,
      label: displayCategory(k),
      spent: spent,
      limit: limit,
      remaining: limit === null ? null : Math.round((limit - spent) * 100) / 100,
      over: limit !== null && spent > limit
    };
  });
  return { start: range.start, end: range.end, rows: rows };
}

/** Monthly totals for the n months ending at endMonth (oldest first). */
function monthlyTrend(expenses, endMonth, n) {
  n = n || 6;
  var totals = {};
  expenses.forEach(function (e) { totals[e.month] = (totals[e.month] || 0) + e.amount; });
  var out = [];
  for (var i = n - 1; i >= 0; i--) {
    var m = addMonths(endMonth, -i);
    out.push({ month: m, label: MONTH_NAMES[+m.slice(5, 7) - 1], total: Math.round((totals[m] || 0) * 100) / 100 });
  }
  return out;
}

/** Last n transactions of the month, newest first. */
function recentTransactions(expenses, month, n) {
  n = n || 12;
  return inMonth(expenses, month).slice().sort(function (a, b) {
    return -compareExpenses(a, b);
  }).slice(0, n).map(function (e) {
    return {
      row: e.row,
      date: e.date,
      note: e.note,
      category: e.category,
      label: displayCategory(e.category),
      account: e.account,
      amount: e.amount
    };
  });
}

// ---------------------------------------------------------------------------
// Data quality
// ---------------------------------------------------------------------------

/** True for empty / meaningless notes ("Gaaa", "123", "Cash", "ok"). */
function isVagueNote(note) {
  var s = String(note === null || note === undefined ? '' : note).trim();
  if (!s) return true;
  if (/^g+a+$/i.test(s)) return true;
  if (/^[\d.,\s]+$/.test(s)) return true;
  for (var i = 0; i < KNOWN_ACCOUNTS.length; i++) {
    if (KNOWN_ACCOUNTS[i].toLowerCase() === s.toLowerCase()) return true;
  }
  var letters = s.replace(/[^A-Za-zÀ-ÿ]/g, '');
  return letters.length < 3;
}

/**
 * Data-quality checks.
 * - missingRent: months in the n-month window ending at endMonth without a Rent
 *   expense >= S/ 1,000 ('missing' for past months, 'pending' for current).
 *   Months before the first recorded expense are skipped.
 * - invalidAmounts: every row that could not be parsed (all months).
 * - vagueNotes: count / total / items for the selected month.
 * - unbudgeted: categories with spending in the selected month but no budget.
 */
function dataQuality(parsed, budgets, month, today, n) {
  n = n || 6;
  var expenses = parsed.expenses;
  var firstMonth = expenses.length ? expenses[0].month : null;
  var missingRent = [];
  for (var i = n - 1; i >= 0; i--) {
    var m = addMonths(month, -i);
    var state = monthState(m, today);
    if (state === 'future' || !firstMonth || m < firstMonth) continue;
    var hasRent = inMonth(expenses, m).some(function (e) {
      return e.category === RENT_CATEGORY && e.amount >= RENT_MIN_AMOUNT;
    });
    if (!hasRent) missingRent.push({ month: m, status: state === 'past' ? 'missing' : 'pending' });
  }

  var monthItems = inMonth(expenses, month);
  var vague = monthItems.filter(function (e) { return isVagueNote(e.note); });

  var unbudgetedTotals = {};
  monthItems.forEach(function (e) {
    if (!(budgets[e.category] > 0)) {
      unbudgetedTotals[e.category] = (unbudgetedTotals[e.category] || 0) + e.amount;
    }
  });
  var unbudgeted = Object.keys(unbudgetedTotals).map(function (k) {
    return { key: k, label: displayCategory(k || '(blank)'), spent: Math.round(unbudgetedTotals[k] * 100) / 100 };
  }).sort(function (a, b) { return b.spent - a.spent; });

  return {
    missingRent: missingRent,
    invalidAmounts: parsed.invalid.slice(),
    vagueNotes: {
      count: vague.length,
      total: sum(vague),
      items: vague.map(function (e) {
        return { row: e.row, date: e.date, note: e.note, label: displayCategory(e.category), amount: e.amount };
      })
    },
    unbudgeted: unbudgeted
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Validates user settings, falling back to defaults for invalid values. */
function sanitizeSettings(input) {
  input = input || {};
  var watched = Array.isArray(input.watched)
    ? input.watched.map(function (k) { return String(k).trim(); })
        .filter(function (k, i, arr) { return k && arr.indexOf(k) === i; })
    : DEFAULT_SETTINGS.watched.slice();
  var capPct = Number(input.capPct);
  if (!(capPct > 0 && capPct <= 100)) capPct = DEFAULT_SETTINGS.capPct;
  return { watched: watched.slice(0, 20), capPct: Math.round(capPct * 10) / 10 };
}

// ---------------------------------------------------------------------------
// Dashboard assembly
// ---------------------------------------------------------------------------

/**
 * Builds the full dashboard payload.
 * data: { expenses, invalid, budgets, income }
 * opts: { month, today, settings }
 */
function buildDashboard(data, opts) {
  var today = opts.today;
  var settings = sanitizeSettings(opts.settings);
  var month = /^\d{4}-\d{2}$/.test(opts.month || '') ? opts.month : monthOf(today);
  var parsed = { expenses: data.expenses, invalid: data.invalid };
  var anchor = weekAnchor(month, today);
  var categories = {};
  KNOWN_CATEGORIES.concat(Object.keys(data.budgets)).forEach(function (k) { categories[k] = true; });
  data.expenses.forEach(function (e) { if (e.category) categories[e.category] = true; });

  return {
    month: month,
    monthLabel: formatMonth(month),
    today: today,
    months: availableMonths(data.expenses.concat([{ month: month }]), today).map(function (m) {
      return { value: m, label: formatMonth(m) };
    }),
    settings: settings,
    categories: Object.keys(categories).sort().map(function (k) {
      return { key: k, label: displayCategory(k), budget: data.budgets[k] > 0 ? data.budgets[k] : null };
    }),
    summary: monthSummary(data.expenses, month, today, data.income, settings.capPct),
    weekly: {
      thisWeek: weeklyControl(data.expenses, data.budgets, settings.watched, anchor),
      lastWeek: weeklyControl(data.expenses, data.budgets, settings.watched, addDays(anchor, -7))
    },
    breakdown: categoryBreakdown(data.expenses, month, data.budgets, today),
    trend: monthlyTrend(data.expenses, month, 6),
    quality: dataQuality(parsed, data.budgets, month, today, 6),
    transactions: recentTransactions(data.expenses, month, 12)
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CATEGORY_LABELS: CATEGORY_LABELS,
    KNOWN_CATEGORIES: KNOWN_CATEGORIES,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    daysInMonth: daysInMonth,
    parseDate: parseDate,
    addDays: addDays,
    addMonths: addMonths,
    weekRange: weekRange,
    monthState: monthState,
    elapsedFraction: elapsedFraction,
    displayCategory: displayCategory,
    formatPEN: formatPEN,
    formatShortDate: formatShortDate,
    formatMonth: formatMonth,
    parseAmount: parseAmount,
    parseExpenses: parseExpenses,
    parseBudgets: parseBudgets,
    findIncome: findIncome,
    availableMonths: availableMonths,
    monthSummary: monthSummary,
    categoryStatus: categoryStatus,
    categoryBreakdown: categoryBreakdown,
    weeklyLimit: weeklyLimit,
    weekAnchor: weekAnchor,
    weeklyControl: weeklyControl,
    monthlyTrend: monthlyTrend,
    recentTransactions: recentTransactions,
    isVagueNote: isVagueNote,
    dataQuality: dataQuality,
    sanitizeSettings: sanitizeSettings,
    buildDashboard: buildDashboard
  };
}
