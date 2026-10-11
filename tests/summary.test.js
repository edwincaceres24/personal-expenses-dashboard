// Apps Script shares one global scope across files; mimic that for Summary.js.
const L = require('../src/Logic.js');
Object.assign(global, L);
const S = require('../src/Summary.js');

const HEADER = ['Timestamp', '1. Amount', '2. Category ', '3. Account', '4. Note', '5. Date', '6. Month', '7. Year'];
const row = (amount, category, account, note, date) => ['', amount, category, account, note, date, '', ''];
const parse = rows => L.parseExpenses([HEADER].concat(rows));
const data = (rows, budgets, income) => {
  const p = parse(rows);
  return { expenses: p.expenses, invalid: p.invalid, budgets: budgets || {}, income: income === undefined ? 5000 : income };
};
const settings = { watched: ['Restaurant', 'Beauty'], capPct: 55 };

describe('isoWeekKey', () => {
  test('regular week', () => expect(S.isoWeekKey('2026-10-05')).toBe('2026-W41'));
  test('any day of the week gives the same key', () => expect(S.isoWeekKey('2026-10-11')).toBe('2026-W41'));
  test('year boundaries follow ISO 8601', () => {
    expect(S.isoWeekKey('2026-01-01')).toBe('2026-W01');
    expect(S.isoWeekKey('2025-12-29')).toBe('2026-W01');
    expect(S.isoWeekKey('2021-01-03')).toBe('2020-W53');
  });
});

describe('previousWeek / week range', () => {
  test('regular Monday reports the Monday–Sunday that just ended', () => {
    expect(S.previousWeek('2026-10-12')).toEqual({ start: '2026-10-05', end: '2026-10-11' });
    expect(S.formatWeekLabel(S.previousWeek('2026-10-12'))).toBe('Oct 5–11');
  });
  test('a week crossing two months', () => {
    const w = S.previousWeek('2026-11-02');
    expect(w).toEqual({ start: '2026-10-26', end: '2026-11-01' });
    expect(S.formatWeekLabel(w)).toBe('Oct 26 – Nov 1');
  });
  test('Monday the 1st', () => {
    expect(S.previousWeek('2026-06-01')).toEqual({ start: '2026-05-25', end: '2026-05-31' });
  });
});

describe('weekOverWeek', () => {
  test('percentage change', () => {
    expect(S.weekOverWeek(150, 100)).toEqual({ current: 150, previous: 100, delta: 50, pct: 50 });
    expect(S.weekOverWeek(50, 100).pct).toBe(-50);
  });
  test('previous week was 0: no percentage', () => {
    expect(S.weekOverWeek(80, 0)).toEqual({ current: 80, previous: 0, delta: 80, pct: null });
  });
});

describe('weekStatus', () => {
  test('ok / warning at 80% / over / no budget', () => {
    expect(S.weekStatus(50, 100)).toBe('ok');
    expect(S.weekStatus(80, 100)).toBe('warning');
    expect(S.weekStatus(100, 100)).toBe('warning');
    expect(S.weekStatus(100.01, 100)).toBe('over');
    expect(S.weekStatus(10, null)).toBe('no-budget');
  });
});

describe('buildWeeklyReport', () => {
  const budgets = { Restaurant: 520, Food: 400, Rent: 1800 }; // weekly: 120, 92.31
  const rows = [
    row(150, 'Restaurant', 'VISA', 'Cena', '10-06-2026'),
    row(40, 'Food', 'Cash', 'Plaza Vea', '10-07-2026'),
    row(60, 'Transport', 'AMEX', 'Uber', '10-08-2026'),
    row(1800, 'Rent', 'VISA', 'Alquiler', '10-09-2026'),
    row(100, 'Food', 'Cash', 'Tottus', '09-30-2026'), // previous week (Sep 28–Oct 4)
    row(25, 'Transport', 'Cash', 'Taxi', '10-12-2026') // after the reported week
  ];
  const report = S.buildWeeklyReport(data(rows, budgets), { today: '2026-10-12', settings });

  test('week info and totals (rent included in the total)', () => {
    expect(report.week).toEqual({ start: '2026-10-05', end: '2026-10-11', key: '2026-W41', label: 'Oct 5–11' });
    expect(report.total).toBe(2050);
    expect(report.comparison.previous).toBe(100);
  });
  test('covers ALL categories, not only watched; rent excluded; worst first', () => {
    expect(report.control.map(c => c.key)).toEqual(['Restaurant', 'Food', 'Transport', 'Beauty']);
    const by = Object.fromEntries(report.control.map(c => [c.key, c]));
    expect(by.Restaurant).toMatchObject({ spent: 150, limit: 120, status: 'over', remaining: -30, watched: true });
    expect(by.Food).toMatchObject({ spent: 40, limit: 92.31, status: 'ok', watched: false });
    expect(report.overCount).toBe(1);
  });
  test('a category without budget has no limit and status no-budget', () => {
    expect(report.control.find(c => c.key === 'Transport')).toMatchObject({ limit: null, remaining: null, status: 'no-budget' });
  });
  test('a watched category with no spending still appears at zero', () => {
    expect(report.control.find(c => c.key === 'Beauty')).toMatchObject({ spent: 0, limit: null, status: 'no-budget', watched: true });
  });
  test('top expenses are the biggest of the week', () => {
    expect(report.top.map(e => e.amount)).toEqual([1800, 150, 60, 40]);
  });
  test('regular week: one projection section as of the end of the week', () => {
    expect(report.months).toHaveLength(1);
    expect(report.months[0]).toMatchObject({ kind: 'projection', month: '2026-10' });
    expect(report.months[0].summary.daysElapsed).toBe(11);
  });
});

describe('month sections', () => {
  const rows = [
    row(1000, 'Food', 'Cash', 'a', '10-20-2026'),
    row(200, 'Food', 'Cash', 'b', '10-28-2026'),
    row(50, 'Food', 'Cash', 'c', '11-01-2026')
  ];
  test('week crossing two months: closing of the first + projection of the second', () => {
    const r = S.buildWeeklyReport(data(rows), { today: '2026-11-02', settings });
    expect(r.months.map(m => m.kind)).toEqual(['closing', 'projection']);
    expect(r.months[0]).toMatchObject({ month: '2026-10', label: 'Oct 2026' });
    expect(r.months[0].summary).toMatchObject({ closed: true, spent: 1200, cap: 2750 });
    expect(r.months[0].gap).toBe(1550);
    expect(r.months[1].summary).toMatchObject({ month: '2026-11', spent: 50, daysElapsed: 1 });
    expect(r.months[1].summary.projected).toBe(1500);
  });
  test('Monday the 1st: only the previous month closing result', () => {
    const r = S.buildWeeklyReport(data([row(300, 'Food', 'Cash', 'x', '05-27-2026')]), { today: '2026-06-01', settings });
    expect(r.months).toHaveLength(1);
    expect(r.months[0]).toMatchObject({ kind: 'closing', month: '2026-05' });
    expect(r.months[0].summary.closed).toBe(true);
  });
});

describe('a week with no expenses', () => {
  const r = S.buildWeeklyReport(data([row(90, 'Food', 'Cash', 'old', '09-01-2026')]), { today: '2026-10-12', settings });
  test('empty report, no crash', () => {
    expect(r.hasExpenses).toBe(false);
    expect(r.total).toBe(0);
    expect(r.top).toEqual([]);
    expect(r.comparison.pct).toBeNull();
    expect(r.overCount).toBe(0);
  });
  test('the email says so and still renders', () => {
    const mail = S.renderSummaryEmail(r, null, '');
    expect(mail.html).toContain('No expenses were recorded last week.');
    expect(mail.subject).toBe('Weekly summary: Oct 5–11 · S/ 0 spent · no category over limit');
  });
});

describe('data quality line', () => {
  test('counts invalid amounts (in the week or undated) and vague notes of the week', () => {
    const d = data([
      row('abc', 'Food', 'Cash', 'x', '10-06-2026'), // invalid, in week
      row('xyz', 'Food', 'Cash', 'x', '09-01-2026'), // invalid, other week
      row(10, 'Food', 'Cash', 'Gaaa', '10-07-2026'),
      row(10, 'Food', 'Cash', 'Menú del día', '10-07-2026')
    ]);
    expect(S.buildWeeklyReport(d, { today: '2026-10-12', settings }).quality).toEqual({ invalidAmounts: 1, vagueNotes: 1 });
  });
});

describe('Claude payload (privacy)', () => {
  const long = 'x'.repeat(60);
  const r = S.buildWeeklyReport(data([
    row(100, 'Food', 'VISA', long, '10-06-2026'),
    row(80, 'Restaurant', 'AMEX', 'Cena pagada con AMEX', '10-07-2026'),
    row(60, 'Food', 'Cash', 'Cash', '10-08-2026')
  ], { Food: 400 }), { today: '2026-10-12', settings });
  const payload = S.buildClaudePayload(r);
  const json = JSON.stringify(payload);

  test('no account names, no row numbers', () => {
    expect(json).not.toMatch(/VISA|AMEX|Cash/i);
    expect(json).not.toMatch(/"row"/);
    expect(json).not.toMatch(/account/i);
  });
  test('notes truncated to 40 characters', () => {
    const notes = payload.topExpenses.map(e => e.note);
    expect(notes[0]).toBe('x'.repeat(40));
    notes.forEach(n => expect(n.length).toBeLessThanOrEqual(40));
  });
  test('only the aggregates and at most 5 expenses', () => {
    expect(Object.keys(payload).sort()).toEqual(['categories', 'changePct', 'currency', 'months', 'previousWeekTotal', 'topExpenses', 'week', 'weekTotal']);
    expect(payload.topExpenses.length).toBeLessThanOrEqual(5);
  });
  test('prompt asks for JSON only', () => {
    expect(S.buildClaudePrompt(r)).toContain('{"recommendations"');
  });
});

describe('validateRecommendations', () => {
  const ok = JSON.stringify({ recommendations: ['Cut Restaurant to S/ 100.', 'Pause Beauty this week.'] });
  test('accepts 2 or 3 non-empty strings', () => {
    expect(S.validateRecommendations(ok)).toEqual(['Cut Restaurant to S/ 100.', 'Pause Beauty this week.']);
    expect(S.validateRecommendations(JSON.stringify({ recommendations: ['a', 'b', 'c'] }))).toHaveLength(3);
  });
  test('accepts JSON wrapped in a code fence', () => {
    expect(S.validateRecommendations('```json\n' + ok + '\n```')).toHaveLength(2);
  });
  test('rejects invalid JSON, wrong counts, empty or non-string items', () => {
    expect(S.validateRecommendations('not json')).toBeNull();
    expect(S.validateRecommendations('')).toBeNull();
    expect(S.validateRecommendations(undefined)).toBeNull();
    expect(S.validateRecommendations('{"recommendations": []}')).toBeNull();
    expect(S.validateRecommendations('{"recommendations": ["only one"]}')).toBeNull();
    expect(S.validateRecommendations('{"recommendations": ["a","b","c","d"]}')).toBeNull();
    expect(S.validateRecommendations('{"recommendations": ["a", "  "]}')).toBeNull();
    expect(S.validateRecommendations('{"recommendations": ["a", 5]}')).toBeNull();
    expect(S.validateRecommendations('{"other": ["a","b"]}')).toBeNull();
  });
});

describe('once-per-week guard', () => {
  test('marker format and skip logic', () => {
    expect(S.summaryMarker('2026-W41')).toBe('summary:2026-W41');
    expect(S.shouldSendSummary(null, 'summary:2026-W41', false)).toBe(true);
    expect(S.shouldSendSummary('summary:2026-W40', 'summary:2026-W41', false)).toBe(true);
    expect(S.shouldSendSummary('summary:2026-W41', 'summary:2026-W41', false)).toBe(false);
    expect(S.shouldSendSummary('summary:2026-W41', 'summary:2026-W41', true)).toBe(true);
  });
});

describe('email', () => {
  const r = S.buildWeeklyReport(data([row(150, 'Restaurant', 'VISA', '<b>Cena</b>', '10-06-2026')], { Restaurant: 520 }),
    { today: '2026-10-12', settings });
  const recs = ['Cut Restaurant to S/ 100.', 'Pause Beauty.'];
  test('subject follows the spec format', () => {
    expect(S.summarySubject(r)).toBe('Weekly summary: Oct 5–11 · S/ 150 spent · 1 category over limit');
  });
  test('sections in order, notes escaped, dashboard link included', () => {
    const { html, text } = S.renderSummaryEmail(r, recs, 'https://script.google.com/x/exec');
    const order = ['Recommendations', 'Weekly control', 'Month', 'Top expenses', 'Data quality', 'Open the dashboard'].map(t => html.indexOf(t));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('&lt;b&gt;Cena&lt;/b&gt;');
    expect(html).not.toContain('<b>Cena</b>');
    expect(html).toContain('https://script.google.com/x/exec');
    expect(text).toContain('Cut Restaurant to S/ 100.');
  });
  test('without recommendations: fallback note; without URL: no link', () => {
    const { html } = S.renderSummaryEmail(r, null, '');
    expect(html).toContain('Recommendations unavailable this week.');
    expect(html).not.toContain('Open the dashboard');
  });
  test('error email', () => {
    const m = S.renderErrorEmail('Tab "Expenses" was not found', 'https://x');
    expect(m.subject).toBe('Weekly summary failed');
    expect(m.html).toContain('Tab &quot;Expenses&quot; was not found');
  });
});
