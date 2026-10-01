/**
 * UI smoke tests: run the real Index/Styles/Client HTML in jsdom, with
 * google.script.run stubbed by dev/build-preview.js (real Logic.js, fake data).
 * jsdom has no layout engine, so these check behavior, not pixels.
 */
const { JSDOM, VirtualConsole } = require('jsdom');
const { buildPreviewHtml } = require('../dev/build-preview');

const TODAY = '2026-10-01';

async function open(opts = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => errors.push(e.message));
  virtualConsole.on('error', e => errors.push(String(e)));
  const qs = opts.scenario ? `?scenario=${opts.scenario}` : '';
  const dom = new JSDOM(buildPreviewHtml({ today: TODAY }), {
    url: 'http://localhost/' + qs,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      // jsdom does not implement <dialog> modality.
      window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    }
  });
  const doc = dom.window.document;
  await waitFor(() => !doc.getElementById('dashboard').hidden || !doc.getElementById('error').hidden);
  return { dom, doc, errors, $: id => doc.getElementById(id) };
}

async function waitFor(cond, timeout = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 10));
  }
}

const text = el => el.textContent.replace(/\s+/g, ' ').trim();

describe('dashboard UI (local preview)', () => {
  let page;
  beforeEach(async () => { page = await open(); });
  afterEach(() => page.dom.window.close());

  test('renders every panel without JS errors', () => {
    const { $, errors } = page;
    expect(errors).toEqual([]);
    expect($('error').hidden).toBe(true);
    expect(text($('pace'))).toMatch(/Spent so far/);
    expect(text($('pace'))).toMatch(/Projected month-end/);
    expect($('weekly').querySelectorAll('li')).toHaveLength(4);
    expect($('categories').querySelectorAll('li').length).toBeGreaterThan(0);
    expect($('trend').querySelectorAll('.hit')).toHaveLength(6);
    expect($('transactions').querySelectorAll('tbody tr').length).toBeGreaterThan(0);
    expect($('month-select').value).toBe('2026-10');
  });

  test('formats amounts in PEN and dates in English', () => {
    expect(text(page.$('pace'))).toMatch(/S\/ \d{1,3}(,\d{3})*/);
    expect(text(page.$('weekly-range'))).toBe('Mon Sep 28 – Sun Oct 4 · weekly limit = monthly budget × 12 ÷ 52');
  });

  test('shows display labels, not sheet keys', () => {
    page.doc.querySelectorAll('#main details').forEach(d => { d.open = true; });
    const visible = text(page.$('main'));
    expect(visible).toMatch(/Leisure/);
    expect(visible).not.toMatch(/Laisure|Deuda/);
  });

  test('escapes notes instead of rendering them as HTML', () => {
    const tx = page.$('transactions');
    expect(tx.querySelector('td.note b')).toBeNull();
    expect(text(tx)).toContain('<b>Cena</b> & "postre"');
  });

  test('data-quality panel reports the fixture quirks', () => {
    const q = text(page.$('quality'));
    expect(q).toMatch(/Rent not recorded.*1 month/);
    expect(q).toMatch(/Invalid amounts.*1 rows/);
    expect(q).toContain('“Food”');
  });

  test('week toggle switches to last week', () => {
    page.doc.querySelector('.seg[data-week="lastWeek"]').click();
    expect(text(page.$('weekly-range'))).toMatch(/^Mon Sep 21 – Sun Sep 27/);
    expect(page.doc.querySelector('.seg[data-week="lastWeek"]').getAttribute('aria-pressed')).toBe('true');
  });

  test('changing the month reloads a closed month with a final result', async () => {
    const sel = page.$('month-select');
    sel.value = '2026-09';
    sel.dispatchEvent(new page.dom.window.Event('change'));
    await waitFor(() => /Final total/.test(page.$('pace').textContent));
    expect(text(page.$('pace'))).not.toMatch(/Projected month-end/);
  });

  test('saving settings updates the cap and watched categories', async () => {
    const { $, doc, dom } = page;
    $('settings-btn').click();
    expect($('settings-dialog').open).toBe(true);
    doc.querySelectorAll('#watched-list input').forEach(i => { i.checked = i.value === 'Food'; });
    $('cap-input').value = '60';
    $('settings-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await waitFor(() => /60% of income/.test($('pace').textContent));
    expect($('settings-dialog').open).toBe(false);
    expect([...$('weekly').querySelectorAll('.row-name')].map(text)).toEqual(['Food']);
  });

  test('rejects an invalid cap percentage', () => {
    const { $, dom } = page;
    $('settings-btn').click();
    $('cap-input').value = '150';
    $('settings-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    expect($('settings-error').hidden).toBe(false);
    expect($('settings-dialog').open).toBe(true);
  });
});

describe('error and empty states', () => {
  test.each([
    ['SHEET_ID_MISSING', 'Spreadsheet not configured'],
    ['NO_PERMISSION', 'No permission'],
    ['TAB_NOT_FOUND', 'Tab not found']
  ])('%s shows a specific message, never a blank page', async (code, title) => {
    const { $, dom } = await open({ scenario: 'error:' + code });
    expect($('error').hidden).toBe(false);
    expect(text($('error'))).toContain(title);
    expect($('dashboard').hidden).toBe(true);
    dom.window.close();
  });

  test('a sheet with no expenses renders empty states', async () => {
    const { $, errors, dom } = await open({ scenario: 'empty' });
    expect(errors).toEqual([]);
    expect(text($('transactions'))).toBe('No transactions this month.');
    dom.window.close();
  });
});
