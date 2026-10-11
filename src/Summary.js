/**
 * Pure logic for the Monday "Weekly Summary" email: report data, Claude prompt
 * payload, recommendation validation and the email HTML/text.
 *
 * No Apps Script globals are used. Like Logic.js it runs in Apps Script and in
 * Node (Jest). It relies on the Logic.js functions (weekRange, sum, inRange,
 * monthSummary, formatPEN...) as globals, which Apps Script provides because
 * all files share one scope; the tests inject them into `global`.
 * Never writes anywhere and never sees account names or row numbers in the
 * payload built for the Claude API.
 */

var SUMMARY_SYSTEM_PROMPT =
  'You are a concise personal finance coach. The user lives in Lima, Peru; ' +
  'amounts are in PEN. Give 2–3 specific, actionable recommendations for the ' +
  'coming week based only on the data provided. Each recommendation: one ' +
  'sentence, max 25 words, referencing a concrete category or amount. ' +
  'Be direct; no generic advice, no greetings, no disclaimers.';

/** JSON Schema for Claude's answer (output_config.format). Count is checked by validateRecommendations. */
var RECOMMENDATIONS_SCHEMA = {
  type: 'object',
  properties: { recommendations: { type: 'array', items: { type: 'string' } } },
  required: ['recommendations'],
  additionalProperties: false
};

var SUMMARY_WARNING_PCT = 0.8;
var SUMMARY_TOP_N = 5;
var SUMMARY_NOTE_MAX = 40;

function round2_(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Weeks
// ---------------------------------------------------------------------------

/** ISO 8601 week key of a 'YYYY-MM-DD' date, e.g. '2026-W41'. */
function isoWeekKey(iso) {
  const d = new Date(isoToUTC(iso));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); // Thursday of that week
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return year + '-W' + pad2(week);
}

/** Monday–Sunday week that ended before `today` (the week reported on a Monday). */
function previousWeek(today) {
  return weekRange(addDays(today, -7));
}

/** 'Oct 5–11' or 'Oct 27 – Nov 2'. */
function formatWeekLabel(week) {
  const from = formatShortDate(week.start);
  if (monthOf(week.start) === monthOf(week.end)) return from + '–' + (+week.end.slice(8, 10));
  return from + ' – ' + formatShortDate(week.end);
}

/** Current vs. previous total; pct is null when the previous week had no spending. */
function weekOverWeek(current, previous) {
  const delta = round2_(current - previous);
  return {
    current: current,
    previous: previous,
    delta: delta,
    pct: previous > 0 ? Math.round(delta / previous * 1000) / 10 : null
  };
}

/** 'no-budget' | 'ok' | 'warning' (>= 80% of the weekly limit) | 'over'. */
function weekStatus(spent, limit) {
  if (limit === null || limit === undefined) return 'no-budget';
  if (spent > limit) return 'over';
  if (spent >= limit * SUMMARY_WARNING_PCT) return 'warning';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Report sections
// ---------------------------------------------------------------------------

/**
 * Weekly control for ALL categories (not only the watched ones): every category
 * with spending in the week, plus the watched ones even at zero. Lump-sum
 * categories (rent) are left out because they are paid once a month.
 * Worst first: over, warning, ok, no-budget; then by spent.
 */
function weeklyControlAll(expenses, budgets, watched, week) {
  const items = inRange(expenses, week.start, week.end).filter(e => !isLumpSum(e.category));
  const spentBy = {};
  items.forEach(e => { spentBy[e.category] = (spentBy[e.category] || 0) + e.amount; });
  const keys = Object.keys(spentBy);
  (watched || []).forEach(k => { if (!isLumpSum(k) && keys.indexOf(k) < 0) keys.push(k); });

  const order = { over: 0, warning: 1, ok: 2, 'no-budget': 3 };
  return keys.map(k => {
    const spent = round2_(spentBy[k] || 0);
    const limit = weeklyLimit(budgets[k]);
    return {
      key: k,
      label: displayCategory(k),
      spent: spent,
      limit: limit,
      remaining: limit === null ? null : round2_(limit - spent),
      pct: limit ? spent / limit : null,
      status: weekStatus(spent, limit),
      watched: (watched || []).indexOf(k) >= 0
    };
  }).sort((a, b) => order[a.status] - order[b.status] || b.spent - a.spent || a.label.localeCompare(b.label));
}

/** Largest expenses of the week (all categories), biggest first. */
function topExpenses(expenses, week, n) {
  return inRange(expenses, week.start, week.end).slice().sort((a, b) => {
    return b.amount - a.amount || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  }).slice(0, n || SUMMARY_TOP_N).map(e => ({
    date: e.date,
    category: e.category,
    label: displayCategory(e.category),
    note: e.note,
    amount: e.amount
  }));
}

/**
 * Month-level sections. The week's months are reported as: a month that already
 * ended gets its closing result; a month still running gets spent / projection
 * as of the end of the reported week. So a week crossing Oct→Nov yields both,
 * and Monday the 1st yields only the closing of the month that just ended.
 */
function monthSections(expenses, income, capPct, week, today) {
  const months = [monthOf(week.start)];
  if (monthOf(week.end) !== months[0]) months.push(monthOf(week.end));
  return months.map(m => {
    const closed = monthState(m, today) === 'past';
    const summary = monthSummary(expenses, m, closed ? today : week.end, income, capPct);
    const reference = closed ? summary.spent : summary.projected;
    return {
      kind: closed ? 'closing' : 'projection',
      month: m,
      label: formatMonth(m),
      summary: summary,
      gap: summary.cap === null || reference === null ? null : round2_(summary.cap - reference)
    };
  });
}

/** Invalid amounts (dated in the week, or undated) and vague notes of the week. */
function weekQuality(invalid, expenses, week) {
  const inWeek = r => !r.date || (r.date >= week.start && r.date <= week.end);
  return {
    invalidAmounts: invalid.filter(inWeek).length,
    vagueNotes: inRange(expenses, week.start, week.end).filter(e => isVagueNote(e.note)).length
  };
}

/**
 * Full report for the week that just ended.
 * data: { expenses, invalid, budgets, income }   opts: { today, settings }
 */
function buildWeeklyReport(data, opts) {
  const settings = sanitizeSettings(opts.settings);
  const week = previousWeek(opts.today);
  const before = weekRange(addDays(week.start, -7));
  const total = sum(inRange(data.expenses, week.start, week.end));
  const previousTotal = sum(inRange(data.expenses, before.start, before.end));
  const control = weeklyControlAll(data.expenses, data.budgets, settings.watched, week);
  return {
    week: { start: week.start, end: week.end, key: isoWeekKey(week.start), label: formatWeekLabel(week) },
    total: total,
    comparison: weekOverWeek(total, previousTotal),
    hasExpenses: inRange(data.expenses, week.start, week.end).length > 0,
    control: control,
    overCount: control.filter(c => c.status === 'over').length,
    top: topExpenses(data.expenses, week, SUMMARY_TOP_N),
    months: monthSections(data.expenses, data.income, settings.capPct, week, opts.today),
    quality: weekQuality(data.invalid || [], data.expenses, week)
  };
}

// ---------------------------------------------------------------------------
// Claude: payload + response validation
// ---------------------------------------------------------------------------

/** Note limited to 40 chars, with account names removed. */
function sanitizeNote(note) {
  let s = String(note === null || note === undefined ? '' : note).trim();
  KNOWN_ACCOUNTS.forEach(a => { s = s.replace(new RegExp('\\b' + a + '\\b', 'gi'), '…'); });
  return s.slice(0, SUMMARY_NOTE_MAX);
}

/** Aggregates only: no accounts, no row numbers, no full sheet. */
function buildClaudePayload(report) {
  return {
    currency: 'PEN',
    week: report.week.label,
    weekTotal: report.total,
    previousWeekTotal: report.comparison.previous,
    changePct: report.comparison.pct,
    categories: report.control.map(c => ({
      category: c.label, spent: c.spent, weeklyLimit: c.limit, status: c.status
    })),
    months: report.months.map(m => ({
      month: m.label,
      result: m.kind,
      spent: m.summary.spent,
      cap: m.summary.cap,
      projectedMonthEnd: m.summary.projected,
      gapVsCap: m.gap
    })),
    topExpenses: report.top.map(e => ({
      date: e.date, category: e.label, note: sanitizeNote(e.note), amount: e.amount
    }))
  };
}

function buildClaudePrompt(report) {
  return 'Weekly spending data:\n' + JSON.stringify(buildClaudePayload(report)) +
    '\n\nRespond with ONLY this JSON, no other text: {"recommendations": ["...", "..."]}';
}

/** 2–3 non-empty recommendation strings from Claude's text, or null if invalid. */
function validateRecommendations(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return null;
  }
  const list = parsed && parsed.recommendations;
  if (!Array.isArray(list) || list.length < 2 || list.length > 3) return null;
  const out = list.map(r => (typeof r === 'string' ? r.trim() : ''));
  return out.every(r => r) ? out : null;
}

// ---------------------------------------------------------------------------
// Once-per-week guard
// ---------------------------------------------------------------------------

function summaryMarker(weekKey) {
  return 'summary:' + weekKey;
}

function shouldSendSummary(lastMarker, marker, force) {
  return !!force || lastMarker !== marker;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

function escapeHtml_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function plural_(n, one, many) {
  return n + ' ' + (n === 1 ? one : many);
}

function summarySubject(report) {
  const over = report.overCount
    ? plural_(report.overCount, 'category', 'categories') + ' over limit'
    : 'no category over limit';
  return 'Weekly summary: ' + report.week.label + ' · ' + formatPEN(report.total) + ' spent · ' + over;
}

var SUMMARY_STATUS_TEXT = {
  over: '✕ Over', warning: '! ≥ 80%', ok: '✓ OK', 'no-budget': '– No budget'
};
var SUMMARY_STATUS_COLOR = {
  over: '#b42318', warning: '#b54708', ok: '#067647', 'no-budget': '#667085'
};

function changeText_(cmp) {
  if (cmp.pct === null) return cmp.current > 0 ? 'previous week had no spending' : 'no change';
  return (cmp.delta >= 0 ? '+' : '−') + formatPEN(Math.abs(cmp.delta)) + ' (' + (cmp.pct >= 0 ? '+' : '−') + Math.abs(cmp.pct) + '%)';
}

function remainingText_(c) {
  if (c.remaining === null) return '–';
  return formatPEN(Math.abs(c.remaining)) + (c.remaining < 0 ? ' over' : ' left');
}

function monthLine_(m) {
  const s = m.summary;
  if (s.cap === null) return m.label + ': spent ' + formatPEN(s.spent) + '.';
  const gap = m.gap === null ? '' : ' ' + (m.gap >= 0 ? 'Under' : 'Over') + ' cap by ' + formatPEN(Math.abs(m.gap)) + '.';
  if (m.kind === 'closing') {
    return m.label + ' closing result: spent ' + formatPEN(s.spent) + ' of ' + formatPEN(s.cap) + ' cap.' + gap;
  }
  return m.label + ': spent so far ' + formatPEN(s.spent) + ' of ' + formatPEN(s.cap) + ' cap; projected month-end ' +
    formatPEN(s.projected) + '.' + gap;
}

function qualityLine_(q) {
  return plural_(q.invalidAmounts, 'invalid amount', 'invalid amounts') + ' and ' +
    plural_(q.vagueNotes, 'vague note', 'vague notes') + ' this week.';
}

function recommendationsNote_(report) {
  return report.hasExpenses ? 'Recommendations unavailable this week.' : 'No expenses were recorded last week.';
}

var TH_ = 'text-align:left;padding:6px 4px;border-bottom:1px solid #d0d5dd;font-size:12px;color:#475467;';
var TD_ = 'padding:6px 4px;border-bottom:1px solid #eaecf0;font-size:14px;vertical-align:top;';

function section_(title, body) {
  return '<h2 style="font-size:16px;margin:24px 0 8px;color:#101828;">' + escapeHtml_(title) + '</h2>' + body;
}

/**
 * Builds { subject, html, text }. recommendations: array from
 * validateRecommendations, or null when unavailable. dashboardUrl may be ''.
 */
function renderSummaryEmail(report, recommendations, dashboardUrl) {
  const cmp = report.comparison;
  const headline =
    '<p style="margin:0;font-size:28px;font-weight:700;color:#101828;">' + escapeHtml_(formatPEN(report.total)) + '</p>' +
    '<p style="margin:4px 0 0;color:#475467;">spent ' + escapeHtml_(report.week.label) + ' · ' +
    escapeHtml_(changeText_(cmp)) + ' vs. the week before (' + escapeHtml_(formatPEN(cmp.previous)) + ')</p>';

  const recs = recommendations
    ? '<ol style="margin:0;padding-left:20px;">' + recommendations.map(r => '<li style="margin:4px 0;">' + escapeHtml_(r) + '</li>').join('') + '</ol>'
    : '<p style="margin:0;color:#475467;">' + escapeHtml_(recommendationsNote_(report)) + '</p>';

  const control = report.control.length
    ? '<table role="presentation" width="100%" cellspacing="0" style="border-collapse:collapse;"><tr>' +
      ['Category', 'Spent', 'Weekly limit', 'Remaining', 'Status'].map(h => '<th style="' + TH_ + '">' + h + '</th>').join('') + '</tr>' +
      report.control.map(c => '<tr><td style="' + TD_ + '">' + escapeHtml_(c.label) + (c.watched ? ' ★' : '') + '</td>' +
        '<td style="' + TD_ + '">' + escapeHtml_(formatPEN(c.spent)) + '</td>' +
        '<td style="' + TD_ + '">' + (c.limit === null ? '–' : escapeHtml_(formatPEN(c.limit))) + '</td>' +
        '<td style="' + TD_ + '">' + escapeHtml_(remainingText_(c)) + '</td>' +
        '<td style="' + TD_ + 'font-weight:600;color:' + SUMMARY_STATUS_COLOR[c.status] + ';">' + SUMMARY_STATUS_TEXT[c.status] + '</td></tr>').join('') +
      '</table><p style="margin:6px 0 0;font-size:12px;color:#667085;">★ watched category. Weekly limit = monthly budget × 12 ÷ 52. Rent is excluded (paid monthly).</p>'
    : '<p style="margin:0;color:#475467;">No spending to control last week.</p>';

  const months = report.months.map(m => '<p style="margin:4px 0;">' + escapeHtml_(monthLine_(m)) + '</p>').join('');

  const top = report.top.length
    ? '<table role="presentation" width="100%" cellspacing="0" style="border-collapse:collapse;"><tr>' +
      ['Date', 'Category', 'Note', 'Amount'].map(h => '<th style="' + TH_ + '">' + h + '</th>').join('') + '</tr>' +
      report.top.map(e => '<tr><td style="' + TD_ + '">' + escapeHtml_(formatShortDate(e.date)) + '</td>' +
        '<td style="' + TD_ + '">' + escapeHtml_(e.label) + '</td>' +
        '<td style="' + TD_ + '">' + (e.note ? escapeHtml_(e.note) : '<i>no note</i>') + '</td>' +
        '<td style="' + TD_ + '">' + escapeHtml_(formatPEN(e.amount, 2)) + '</td></tr>').join('') + '</table>'
    : '<p style="margin:0;color:#475467;">No expenses last week.</p>';

  const link = dashboardUrl
    ? '<p style="margin:24px 0 0;"><a href="' + escapeHtml_(dashboardUrl) + '" style="color:#175cd3;">Open the dashboard</a></p>'
    : '';

  const html = '<!doctype html><html><body style="margin:0;padding:16px;background:#f9fafb;font-family:Arial,Helvetica,sans-serif;color:#101828;">' +
    '<div style="max-width:600px;margin:0 auto;background:#ffffff;padding:20px;border-radius:8px;">' +
    '<h1 style="font-size:18px;margin:0 0 12px;">Weekly summary</h1>' + headline +
    section_('Recommendations', recs) + section_('Weekly control', control) +
    section_('Month', months) + section_('Top expenses', top) +
    section_('Data quality', '<p style="margin:0;">' + escapeHtml_(qualityLine_(report.quality)) + '</p>') + link +
    '</div></body></html>';

  const lines = ['Weekly summary ' + report.week.label, formatPEN(report.total) + ' spent · ' + changeText_(cmp) + ' vs. the week before', '',
    'Recommendations:'].concat(recommendations ? recommendations.map((r, i) => (i + 1) + '. ' + r) : [recommendationsNote_(report)])
    .concat(['', 'Weekly control:'], report.control.map(c => '- ' + c.label + ': ' + formatPEN(c.spent) + ' / ' +
      (c.limit === null ? 'no budget' : formatPEN(c.limit)) + ' ' + SUMMARY_STATUS_TEXT[c.status]),
    ['', 'Month:'], report.months.map(monthLine_),
    ['', 'Top expenses:'], report.top.map(e => '- ' + formatShortDate(e.date) + ' ' + e.label + ' ' + formatPEN(e.amount, 2) + (e.note ? ' (' + e.note + ')' : '')),
    ['', qualityLine_(report.quality)], dashboardUrl ? ['Dashboard: ' + dashboardUrl] : []);

  return { subject: summarySubject(report), html: html, text: lines.join('\n') };
}

/** Short email sent when the report cannot be produced (e.g. sheet unreadable). */
function renderErrorEmail(message, dashboardUrl) {
  const text = 'The weekly summary could not be generated: ' + message + (dashboardUrl ? '\nDashboard: ' + dashboardUrl : '');
  return {
    subject: 'Weekly summary failed',
    html: '<p>The weekly summary could not be generated:</p><p><b>' + escapeHtml_(message) + '</b></p>' +
      (dashboardUrl ? '<p><a href="' + escapeHtml_(dashboardUrl) + '">Open the dashboard</a></p>' : ''),
    text: text
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SUMMARY_SYSTEM_PROMPT: SUMMARY_SYSTEM_PROMPT,
    RECOMMENDATIONS_SCHEMA: RECOMMENDATIONS_SCHEMA,
    isoWeekKey: isoWeekKey,
    previousWeek: previousWeek,
    formatWeekLabel: formatWeekLabel,
    weekOverWeek: weekOverWeek,
    weekStatus: weekStatus,
    weeklyControlAll: weeklyControlAll,
    topExpenses: topExpenses,
    monthSections: monthSections,
    weekQuality: weekQuality,
    buildWeeklyReport: buildWeeklyReport,
    sanitizeNote: sanitizeNote,
    buildClaudePayload: buildClaudePayload,
    buildClaudePrompt: buildClaudePrompt,
    validateRecommendations: validateRecommendations,
    summaryMarker: summaryMarker,
    shouldSendSummary: shouldSendSummary,
    summarySubject: summarySubject,
    renderSummaryEmail: renderSummaryEmail,
    renderErrorEmail: renderErrorEmail
  };
}
