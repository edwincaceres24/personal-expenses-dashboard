/**
 * Fake spreadsheet data for local preview and UI tests. Deterministic (seeded),
 * shaped like the Sheets API response (Expenses A:H, Budgets A:B, Financial
 * Framework A:H), and deliberately includes the known data quirks.
 * Never put real data here: this file is committed.
 */

const HEADER = ['Timestamp', '1. Amount', '2. Category ', '3. Account', '4. Note', '5. Date', '6. Month', '7. Year'];
const CATEGORIES = ['Food', 'Restaurant', 'Relationship', 'Household', 'Health', 'Transport',
  'Beauty', 'Laisure', 'Subscription', 'Pets', 'Deuda'];
const NOTES = ['Plaza Vea', 'Almuerzo', 'Uber', 'Gaaa', '', 'Cine con Ana', 'Farmacia', 'Netflix',
  '25', 'Cash', 'Tottus', 'Peluquería', 'Menú del día', 'Gaa'];
const ACCOUNTS = ['AMEX', 'VISA', 'Cash'];

const pad = n => String(n).padStart(2, '0');
const mmddyyyy = (y, m, d) => `${pad(m)}-${pad(d)}-${y}`;
const monthName = m => ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'][m - 1];

/**
 * @param {string} today 'YYYY-MM-DD' — fixtures cover the 7 months up to it.
 */
function makeFixtures(today) {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const [ty, tm, td] = today.split('-').map(Number);
  const expenses = [HEADER];

  for (let back = 6; back >= 0; back--) {
    const date = new Date(Date.UTC(ty, tm - 1 - back, 1));
    const y = date.getUTCFullYear(), m = date.getUTCMonth() + 1;
    const lastDay = back === 0 ? td : new Date(Date.UTC(y, m, 0)).getUTCDate();
    const row = (amount, category, account, note, day) =>
      ['', amount, category, account, note, mmddyyyy(y, m, day), monthName(m), y];

    // Rent is missing two months ago (quirk: rent not always registered).
    if (back !== 2) expenses.push(row(1800, 'Rent', 'VISA', 'Alquiler', 1));
    expenses.push(row(95, 'Rent', 'VISA', 'Internet', Math.min(5, lastDay)));
    const count = Math.max(2, Math.round(lastDay * 1.3));
    for (let i = 0; i < count; i++) {
      expenses.push(row(
        Math.round((5 + rnd() * 110) * 100) / 100,
        CATEGORIES[Math.floor(rnd() * CATEGORIES.length)],
        ACCOUNTS[i % 3],
        NOTES[Math.floor(rnd() * NOTES.length)],
        1 + Math.floor(rnd() * lastDay)
      ));
    }
  }

  const cur = (amount, category, note, day) =>
    ['', amount, category, 'Cash', note, mmddyyyy(ty, tm, day), monthName(tm), ty];
  expenses.push(cur('Food', 'Food', 'Amount typed as text', td));        // non-numeric amount
  expenses.push(cur(42.5, 'Restaurant', '<b>Cena</b> & "postre"', td));  // HTML must be escaped
  expenses.push(cur(12, 'Pets', 'Back-filled, bad date', 1));
  expenses[expenses.length - 1][5] = 'not-a-date';                         // falls back to Timestamp
  expenses[expenses.length - 1][0] = `${tm}/${td}/${ty} 09:15:00`;

  // Shuffle so rows are not chronological (quirk: back-filled rows).
  const body = expenses.slice(1).sort(() => rnd() - 0.5);

  return {
    expenses: [HEADER].concat(body),
    budgets: [
      ['Category', 'Monthly treshold'],
      ['Food', 900], ['Restaurant', 400], ['Relationship', 300], ['Household', 250],
      ['Rent', 1950], ['Health', 200], ['Transport', 250], ['Beauty', 120],
      ['Laisure', 200], ['Subscription', 80]
    ],
    framework: [
      ['', '', '', '', '', '', 'Concept', 'Value'],
      ['', '', '', '', '', '', 'Mothly Income', 5200]
    ]
  };
}

module.exports = { makeFixtures };
