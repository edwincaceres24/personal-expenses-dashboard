const L = require('../src/Logic.js');

const HEADER = ['Timestamp', '1. Amount', '2. Category ', '3. Account', '4. Note', '5. Date', '6. Month', '7. Year'];

function row(amount, category, account, note, date, timestamp) {
  return [timestamp || '', amount, category, account, note, date, '', ''];
}

describe('parseDate', () => {
  test('parses MM-DD-YYYY', () => {
    expect(L.parseDate('09-27-2026')).toBe('2026-09-27');
  });
  test('parses timestamp M/D/YYYY H:MM:SS', () => {
    expect(L.parseDate('9/7/2026 8:05:33')).toBe('2026-09-07');
  });
  test('parses ISO (normalized Date objects from Code.js)', () => {
    expect(L.parseDate('2026-02-28')).toBe('2026-02-28');
  });
  test('rejects invalid dates', () => {
    expect(L.parseDate('02-30-2026')).toBeNull();
    expect(L.parseDate('13-01-2026')).toBeNull();
    expect(L.parseDate('hello')).toBeNull();
    expect(L.parseDate('')).toBeNull();
    expect(L.parseDate(null)).toBeNull();
  });
  test('parses Sheets serial numbers (date cells read via the Sheets API)', () => {
    expect(L.parseDate(46292)).toBe('2026-09-27');
    expect(L.parseDate(46292.9999)).toBe('2026-09-27'); // timestamp late in the day
    expect(L.parseDate(46022)).toBe('2025-12-31');
    expect(L.parseDate(0)).toBeNull();
    expect(L.parseDate(NaN)).toBeNull();
  });
  test('handles leap years', () => {
    expect(L.parseDate('02-29-2028')).toBe('2028-02-29');
    expect(L.parseDate('02-29-2026')).toBeNull();
  });
});

describe('parseAmount', () => {
  test('numbers and numeric strings', () => {
    expect(L.parseAmount(12.5)).toBe(12.5);
    expect(L.parseAmount('1,234.50')).toBe(1234.5);
    expect(L.parseAmount('S/ 20')).toBe(20);
  });
  test('non-numeric values are null', () => {
    expect(L.parseAmount('Food')).toBeNull();
    expect(L.parseAmount('')).toBeNull();
    expect(L.parseAmount(null)).toBeNull();
    expect(L.parseAmount(NaN)).toBeNull();
  });
});

describe('parseExpenses', () => {
  const values = [
    HEADER,
    row(50, 'Food ', 'VISA', 'Plaza Vea', '09-20-2026'),
    row('Food', 'Food', 'Cash', 'Gaaa', '09-21-2026'), // invalid amount
    row(30, 'Restaurant', 'amex', 'Almuerzo', '09-02-2026'), // back-filled, earlier date
    row(15, 'Transport', 'Cash', 'Taxi', 'not a date', '9/5/2026 10:00:00'), // fallback
    ['', '', '', '', '', '', '', ''], // blank row
    row(10, 'Other', 'Cash', 'x', 'bad', 'bad') // no valid date at all
  ];
  const parsed = L.parseExpenses(values);

  test('reads columns by position and trims category', () => {
    const food = parsed.expenses.find(e => e.category === 'Food');
    expect(food).toMatchObject({ amount: 50, account: 'VISA', note: 'Plaza Vea', date: '2026-09-20', month: '2026-09', row: 2 });
  });
  test('sorts by date regardless of row order', () => {
    expect(parsed.expenses.map(e => e.date)).toEqual(['2026-09-02', '2026-09-05', '2026-09-20']);
  });
  test('falls back to timestamp when Date is invalid', () => {
    const t = parsed.expenses.find(e => e.category === 'Transport');
    expect(t.date).toBe('2026-09-05');
    expect(t.dateSource).toBe('timestamp');
  });
  test('normalizes account case', () => {
    expect(parsed.expenses[0].account).toBe('AMEX');
  });
  test('non-numeric amounts go to invalid list with row number', () => {
    expect(parsed.invalid).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 3, rawAmount: 'Food', reason: 'Amount is not a number' })
    ]));
  });
  test('rows without any valid date are invalid, blank rows ignored', () => {
    expect(parsed.invalid.map(i => i.row)).toEqual([3, 7]);
    expect(parsed.expenses).toHaveLength(3);
  });
  test('accepts serial dates and short rows from the Sheets API', () => {
    const p = L.parseExpenses([HEADER, [46292.5, 20, 'Food', 'Cash'], [46292.5, 15, 'Food', 'Cash', 'Pan', 46290], []]);
    expect(p.expenses.map(e => [e.date, e.note, e.dateSource])).toEqual([
      ['2026-09-25', 'Pan', 'date'],
      ['2026-09-27', '', 'timestamp']
    ]);
    expect(p.invalid).toEqual([]);
  });
  test('handles empty input', () => {
    expect(L.parseExpenses([])).toEqual({ expenses: [], invalid: [] });
    expect(L.parseExpenses([HEADER])).toEqual({ expenses: [], invalid: [] });
  });
});

describe('parseBudgets / findIncome', () => {
  test('parses budgets and skips header / bad rows', () => {
    const b = L.parseBudgets([['Category', 'Monthly treshold'], ['Food ', 800], ['Laisure', '200'], ['Bad', 'x'], ['', 5]]);
    expect(b).toEqual({ Food: 800, Laisure: 200 });
  });
  test('finds income by label in column G', () => {
    const v = [
      ['', '', '', '', '', '', 'Something', 1],
      ['', '', '', '', '', '', 'Mothly Income ', 6000]
    ];
    expect(L.findIncome(v)).toBe(6000);
  });
  test('returns null when label is missing', () => {
    expect(L.findIncome([['a', 'b']])).toBeNull();
  });
});

describe('formatting', () => {
  test('formatPEN', () => {
    expect(L.formatPEN(1234)).toBe('S/ 1,234');
    expect(L.formatPEN(1234.5, 2)).toBe('S/ 1,234.50');
    expect(L.formatPEN(1234567.4)).toBe('S/ 1,234,567');
    expect(L.formatPEN(-50)).toBe('-S/ 50');
    expect(L.formatPEN(0)).toBe('S/ 0');
  });
  test('dates and labels', () => {
    expect(L.formatShortDate('2026-09-27')).toBe('Sep 27');
    expect(L.formatMonth('2026-09')).toBe('Sep 2026');
    expect(L.displayCategory('Laisure')).toBe('Leisure');
    expect(L.displayCategory('Deuda')).toBe('Debt');
    expect(L.displayCategory('Food')).toBe('Food');
  });
});

describe('date helpers', () => {
  test('weekRange is Monday–Sunday', () => {
    expect(L.weekRange('2026-10-01')).toEqual({ start: '2026-09-28', end: '2026-10-04' }); // Thu
    expect(L.weekRange('2026-09-28')).toEqual({ start: '2026-09-28', end: '2026-10-04' }); // Mon
    expect(L.weekRange('2026-10-04')).toEqual({ start: '2026-09-28', end: '2026-10-04' }); // Sun
  });
  test('addMonths crosses years', () => {
    expect(L.addMonths('2026-01', -1)).toBe('2025-12');
    expect(L.addMonths('2025-11', 3)).toBe('2026-02');
  });
  test('weekAnchor', () => {
    expect(L.weekAnchor('2026-10', '2026-10-01')).toBe('2026-10-01');
    expect(L.weekAnchor('2026-09', '2026-10-01')).toBe('2026-09-30');
    expect(L.weekAnchor('2026-11', '2026-10-01')).toBe('2026-11-01');
  });
});

describe('monthSummary', () => {
  const expenses = L.parseExpenses([
    HEADER,
    row(300, 'Food', 'VISA', 'a', '09-05-2026'),
    row(700, 'Food', 'VISA', 'b', '09-10-2026'),
    row(100, 'Food', 'VISA', 'c', '08-10-2026')
  ]).expenses;

  test('current month projects month-end total', () => {
    const s = L.monthSummary(expenses, '2026-09', '2026-09-10', 4000, 55);
    expect(s.state).toBe('current');
    expect(s.cap).toBe(2200);
    expect(s.spent).toBe(1000);
    expect(s.daysElapsed).toBe(10);
    expect(s.projected).toBe(3000); // 1000 / 10 * 30
    expect(s.overCap).toBe(true);
    expect(s.remaining).toBe(1200);
  });
  test('rent is not extrapolated in the projection', () => {
    const withRent = expenses.concat(L.parseExpenses([HEADER, row(1800, 'Rent', 'VISA', 'Alquiler', '09-01-2026')]).expenses);
    const s = L.monthSummary(withRent, '2026-09', '2026-09-10', 4000, 55);
    expect(s.lumpSum).toBe(1800);
    expect(s.projected).toBe(4800); // 1800 + 1000 / 10 * 30
  });
  test('closed month shows final result, no projection', () => {
    const s = L.monthSummary(expenses, '2026-08', '2026-09-10', 4000, 55);
    expect(s.closed).toBe(true);
    expect(s.projected).toBeNull();
    expect(s.spent).toBe(100);
    expect(s.overCap).toBe(false);
  });
  test('cap percentage is configurable', () => {
    expect(L.monthSummary(expenses, '2026-09', '2026-09-10', 4000, 50).cap).toBe(2000);
  });
  test('missing income yields null cap without crashing', () => {
    expect(L.monthSummary(expenses, '2026-09', '2026-09-10', null, 55).cap).toBeNull();
  });
});

describe('categoryBreakdown', () => {
  const expenses = L.parseExpenses([
    HEADER,
    row(500, 'Food', 'VISA', 'a', '09-05-2026'),
    row(250, 'Restaurant', 'VISA', 'b', '09-06-2026'),
    row(50, 'Pets', 'Cash', 'c', '09-07-2026'),
    row(20, 'Health', 'Cash', 'd', '09-07-2026')
  ]).expenses;
  const budgets = { Food: 400, Restaurant: 600, Health: 200, Gift: 100 };

  test('statuses and ordering (current month, half elapsed)', () => {
    const b = L.categoryBreakdown(expenses, '2026-09', budgets, '2026-09-15');
    expect(b.map(c => c.key)).toEqual(['Food', 'Restaurant', 'Pets', 'Health', 'Gift']);
    const by = Object.fromEntries(b.map(c => [c.key, c.status]));
    expect(by).toEqual({ Food: 'over', Restaurant: 'on-track', Pets: 'no-budget', Health: 'on-track', Gift: 'on-track' });
  });
  test('ahead of pace when above prorated budget + tolerance', () => {
    const b = L.categoryBreakdown(expenses, '2026-09', budgets, '2026-09-03');
    expect(b.find(c => c.key === 'Restaurant').status).toBe('ahead');
  });
  test('closed months never report ahead of pace', () => {
    expect(L.categoryStatus(90, 100, 1, true)).toBe('on-track');
  });
  test('rent (lump sum) is never ahead of pace, but can be over', () => {
    const rent = L.parseExpenses([HEADER, row(1800, 'Rent', 'VISA', 'Alquiler', '09-01-2026')]).expenses;
    expect(L.categoryBreakdown(rent, '2026-09', { Rent: 1900 }, '2026-09-02')[0].status).toBe('on-track');
    expect(L.categoryBreakdown(rent, '2026-09', { Rent: 1500 }, '2026-09-02')[0].status).toBe('over');
  });
  test('uses display labels', () => {
    expect(L.categoryBreakdown([{ category: 'Laisure', amount: 1, month: '2026-09', date: '2026-09-01' }], '2026-09', {}, '2026-09-02')[0].label).toBe('Leisure');
  });
});

describe('weekly control', () => {
  test('weekly limit = monthly budget × 12 ÷ 52', () => {
    expect(L.weeklyLimit(520)).toBe(120);
    expect(L.weeklyLimit(0)).toBeNull();
    expect(L.weeklyLimit(undefined)).toBeNull();
  });

  const expenses = L.parseExpenses([
    HEADER,
    row(60, 'Restaurant', 'VISA', 'a', '09-28-2026'), // Mon of this week
    row(80, 'Restaurant', 'VISA', 'b', '10-01-2026'), // crosses into October
    row(40, 'Restaurant', 'VISA', 'c', '09-27-2026'), // Sunday of last week
    row(30, 'Beauty', 'Cash', 'd', '09-29-2026'),
    row(99, 'Food', 'Cash', 'e', '09-29-2026') // not watched
  ]).expenses;
  const budgets = { Restaurant: 520, Beauty: 130 };

  test('this week sums across a month boundary', () => {
    const w = L.weeklyControl(expenses, budgets, ['Restaurant', 'Beauty', 'Household'], '2026-10-01');
    expect(w.start).toBe('2026-09-28');
    expect(w.end).toBe('2026-10-04');
    const r = Object.fromEntries(w.rows.map(x => [x.key, x]));
    expect(r.Restaurant).toMatchObject({ spent: 140, limit: 120, remaining: -20, over: true });
    expect(r.Beauty).toMatchObject({ spent: 30, limit: 30, remaining: 0, over: false });
    expect(r.Household).toMatchObject({ spent: 0, limit: null, remaining: null, over: false });
  });
  test('last week', () => {
    const w = L.weeklyControl(expenses, budgets, ['Restaurant'], L.addDays('2026-10-01', -7));
    expect(w.start).toBe('2026-09-21');
    expect(w.rows[0].spent).toBe(40);
  });
});

describe('monthlyTrend / recentTransactions', () => {
  const expenses = L.parseExpenses([
    HEADER,
    row(100, 'Food', 'VISA', 'a', '04-01-2026'),
    row(200, 'Food', 'VISA', 'b', '09-01-2026'),
    row(50, 'Food', 'VISA', 'c', '09-03-2026'),
    row(10, 'Food', 'VISA', 'd', '03-31-2026') // outside 6-month window
  ]).expenses;

  test('six months ending at selected month, zero-filled', () => {
    const t = L.monthlyTrend(expenses, '2026-09', 6);
    expect(t.map(x => x.month)).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
    expect(t.map(x => x.total)).toEqual([100, 0, 0, 0, 0, 250]);
  });
  test('recent transactions newest first, limited', () => {
    const many = [];
    for (let d = 1; d <= 15; d++) many.push({ row: d + 1, date: `2026-09-${String(d).padStart(2, '0')}`, month: '2026-09', amount: d, category: 'Deuda', account: 'Cash', note: '' });
    const r = L.recentTransactions(many, '2026-09', 12);
    expect(r).toHaveLength(12);
    expect(r[0].date).toBe('2026-09-15');
    expect(r[0].label).toBe('Debt');
  });
});

describe('data quality', () => {
  test('isVagueNote', () => {
    ['', '  ', 'Gaaa', 'Gaa', 'gaaaaa', '25', '12.50', 'Cash', 'visa', 'ok', '?'].forEach(n =>
      expect([n, L.isVagueNote(n)]).toEqual([n, true]));
    ['Almuerzo con Ana', 'Uber', 'Plaza Vea', 'Pan'].forEach(n =>
      expect([n, L.isVagueNote(n)]).toEqual([n, false]));
  });

  const parsed = L.parseExpenses([
    HEADER,
    row(1500, 'Rent', 'VISA', 'Alquiler', '07-01-2026'),
    row(80, 'Rent', 'VISA', 'Internet', '08-03-2026'), // utilities only, rent missing
    row(1500, 'Rent', 'VISA', 'Alquiler', '09-01-2026'),
    row(40, 'Food', 'Cash', 'Gaaa', '09-04-2026'),
    row(25, 'Pets', 'Cash', '', '09-05-2026'),
    row(12, 'Food', 'Cash', 'Cash', '09-06-2026'),
    row('Food', 'Food', 'Cash', 'x', '09-07-2026'),
    row(5, 'Food', 'Cash', 'Galletas', '10-01-2026')
  ]);
  const budgets = { Food: 800, Rent: 1600 };

  const q = L.dataQuality(parsed, budgets, '2026-10', '2026-10-01', 6);

  test('missing rent: skips months before data, flags past and pending current', () => {
    expect(q.missingRent).toEqual([
      { month: '2026-08', status: 'missing' },
      { month: '2026-10', status: 'pending' }
    ]);
  });
  test('invalid amounts listed with row number', () => {
    expect(q.invalidAmounts).toHaveLength(1);
    expect(q.invalidAmounts[0]).toMatchObject({ row: 8, rawAmount: 'Food' });
  });
  test('vague notes count and total for selected month', () => {
    const sep = L.dataQuality(parsed, budgets, '2026-09', '2026-10-01', 6);
    expect(sep.vagueNotes.count).toBe(3);
    expect(sep.vagueNotes.total).toBe(77);
  });
  test('categories with spending but no budget', () => {
    const sep = L.dataQuality(parsed, budgets, '2026-09', '2026-10-01', 6);
    expect(sep.unbudgeted).toEqual([{ key: 'Pets', label: 'Pets', spent: 25 }]);
  });
  test('no data at all does not crash', () => {
    const empty = L.dataQuality({ expenses: [], invalid: [] }, {}, '2026-10', '2026-10-01');
    expect(empty).toEqual({ missingRent: [], invalidAmounts: [], vagueNotes: { count: 0, total: 0, items: [] }, unbudgeted: [] });
  });
});

describe('settings', () => {
  test('defaults', () => {
    expect(L.sanitizeSettings()).toEqual({ watched: ['Restaurant', 'Relationship', 'Household', 'Beauty'], capPct: 55 });
  });
  test('validates values', () => {
    expect(L.sanitizeSettings({ watched: ['Food', 'Food', ' Car ', ''], capPct: '60' })).toEqual({ watched: ['Food', 'Car'], capPct: 60 });
    expect(L.sanitizeSettings({ watched: [], capPct: 0 }).capPct).toBe(55);
    expect(L.sanitizeSettings({ capPct: 150 }).capPct).toBe(55);
  });
});

describe('buildDashboard', () => {
  test('assembles a full payload and defaults to current month', () => {
    const parsed = L.parseExpenses([HEADER, row(100, 'Restaurant', 'VISA', 'Cena', '09-30-2026')]);
    const d = L.buildDashboard(
      { expenses: parsed.expenses, invalid: parsed.invalid, budgets: { Restaurant: 520 }, income: 5000 },
      { month: '', today: '2026-10-01', settings: null }
    );
    expect(d.month).toBe('2026-10');
    expect(d.months.map(m => m.value)).toEqual(['2026-10', '2026-09']);
    expect(d.summary.cap).toBe(2750);
    expect(d.weekly.thisWeek.rows.find(r => r.key === 'Restaurant')).toMatchObject({ spent: 100, limit: 120 });
    expect(d.trend).toHaveLength(6);
    expect(d.categories.find(c => c.key === 'Laisure').label).toBe('Leisure');
  });
  test('selected month without data still appears in the month list', () => {
    const d = L.buildDashboard(
      { expenses: [], invalid: [], budgets: {}, income: 5000 },
      { month: '2026-05', today: '2026-10-01', settings: null }
    );
    expect(d.months.map(m => m.value)).toEqual(['2026-10', '2026-05']);
    expect(d.summary.closed).toBe(true);
  });
});
