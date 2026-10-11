// Apps Script layer (Claude.js, Notifier.js, WeeklySummary.js) with every Apps
// Script service mocked. The real Claude API is never called.
const L = require('../src/Logic.js');
Object.assign(global, L, require('../src/Summary.js'), require('../src/Claude.js'), require('../src/Notifier.js'));
const W = require('../src/WeeklySummary.js');

const HEADER = ['Timestamp', '1. Amount', '2. Category ', '3. Account', '4. Note', '5. Date', '6. Month', '7. Year'];
const row = (amount, category, account, note, date) => ['', amount, category, account, note, date, '', ''];

let props, sent, triggers, fetchMock;

function sheetData() {
  const p = L.parseExpenses([HEADER,
    row(150, 'Restaurant', 'VISA', 'Cena', '10-06-2026'),
    row(60, 'Transport', 'AMEX', 'Uber', '10-08-2026')]);
  return { expenses: p.expenses, invalid: p.invalid, budgets: { Restaurant: 520 }, income: 5000 };
}
const apiOk = text => ({
  getResponseCode: () => 200,
  getContentText: () => JSON.stringify({ content: [{ type: 'text', text }], usage: { input_tokens: 321, output_tokens: 45 } })
});
const apiStatus = code => ({ getResponseCode: () => code, getContentText: () => '{"error":"x"}' });
const goodJson = JSON.stringify({ recommendations: ['Cut Restaurant to S/ 100.', 'Pause Transport spending.'] });

beforeEach(() => {
  props = { ANTHROPIC_API_KEY: 'sk-test', DASHBOARD_URL: 'https://script.google.com/macros/s/ID/exec' };
  sent = [];
  triggers = [];
  fetchMock = jest.fn(() => apiOk(goodJson));
  global.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = v; }
    })
  };
  global.Utilities = { formatDate: () => '2026-10-12', sleep: jest.fn() };
  global.UrlFetchApp = { fetch: fetchMock };
  global.MailApp = { sendEmail: m => sent.push(m) };
  global.Session = { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) };
  global.ScriptApp = {
    WeekDay: { MONDAY: 'MONDAY' },
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: t => { triggers = triggers.filter(x => x !== t); },
    newTrigger: handler => {
      const t = { getHandlerFunction: () => handler };
      const b = {};
      ['timeBased', 'onWeekDay', 'atHour', 'inTimezone'].forEach(m => { b[m] = jest.fn(() => b); });
      b.create = () => { triggers.push(t); return t; };
      global.__builder = b;
      return b;
    }
  };
  global.loadData_ = jest.fn(() => ({ data: sheetData(), loadedAt: 'x', fromCache: false }));
  global.readSettings_ = jest.fn(() => ({ watched: ['Restaurant'], capPct: 55 }));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('runWeeklySummary', () => {
  test('sends one email with Claude recommendations and a dashboard link', () => {
    const res = W.runWeeklySummary();
    expect(res).toEqual({ sent: true, week: '2026-W41', recommendations: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('owner@example.com');
    expect(sent[0].subject).toContain('Weekly summary: Oct 5–11');
    expect(sent[0].htmlBody).toContain('Cut Restaurant to S/ 100.');
    expect(sent[0].htmlBody).toContain('https://script.google.com/macros/s/ID/exec');
    expect(props.WEEKLY_SUMMARY_LAST).toBe('summary:2026-W41');
  });

  test('reads fresh data (bypassing the cache)', () => {
    W.runWeeklySummary();
    expect(loadData_).toHaveBeenCalledWith(true);
  });

  test('once-per-week deduplication: the second run is skipped', () => {
    W.runWeeklySummary();
    const second = W.runWeeklySummary();
    expect(second).toEqual({ sent: false, reason: 'already-sent' });
    expect(sent).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('runWeeklySummaryNow bypasses the check and does not consume the weekly slot', () => {
    W.runWeeklySummaryNow();
    W.runWeeklySummaryNow();
    expect(sent).toHaveLength(2);
    expect(props.WEEKLY_SUMMARY_LAST).toBeUndefined();
  });

  test('recipient comes from ALERT_EMAIL when set', () => {
    props.ALERT_EMAIL = ' me@example.com ';
    W.runWeeklySummary();
    expect(sent[0].to).toBe('me@example.com');
  });

  test('never writes to the spreadsheet: only mail and script properties are touched', () => {
    W.runWeeklySummary();
    expect(Object.keys(props).sort()).toEqual(['ANTHROPIC_API_KEY', 'DASHBOARD_URL', 'WEEKLY_SUMMARY_LAST']);
  });
});

describe('Claude failures never block the summary', () => {
  const expectFallback = () => {
    expect(sent).toHaveLength(1);
    expect(sent[0].htmlBody).toContain('Recommendations unavailable this week.');
    expect(console.error).toHaveBeenCalled();
  };

  test('HTTP error (after one retry)', () => {
    fetchMock.mockImplementation(() => apiStatus(500));
    expect(W.runWeeklySummary().sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectFallback();
  });
  test('request throws (timeout)', () => {
    fetchMock.mockImplementation(() => { throw new Error('Timeout'); });
    expect(W.runWeeklySummary().sent).toBe(true);
    expectFallback();
  });
  test('invalid JSON from Claude', () => {
    fetchMock.mockImplementation(() => apiOk('Sure! Here are some tips'));
    expect(W.runWeeklySummary().sent).toBe(true);
    expectFallback();
  });
  test('wrong number of recommendations', () => {
    fetchMock.mockImplementation(() => apiOk('{"recommendations":["only one"]}'));
    W.runWeeklySummary();
    expectFallback();
  });
  test('missing API key', () => {
    delete props.ANTHROPIC_API_KEY;
    W.runWeeklySummary();
    expect(fetchMock).not.toHaveBeenCalled();
    expectFallback();
  });
  test('a week with no expenses does not call Claude', () => {
    loadData_.mockImplementation(() => ({ data: Object.assign(sheetData(), { expenses: [] }), loadedAt: 'x', fromCache: false }));
    W.runWeeklySummary();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sent[0].htmlBody).toContain('No expenses were recorded last week.');
  });
});

describe('sheet failure', () => {
  test('sends a short error email instead of failing silently, and does not mark the week as sent', () => {
    loadData_.mockImplementation(() => { throw new Error('Tab "Expenses" was not found'); });
    const res = W.runWeeklySummary();
    expect(res).toMatchObject({ sent: false, reason: 'error' });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Weekly summary failed');
    expect(sent[0].htmlBody).toContain('was not found');
    expect(props.WEEKLY_SUMMARY_LAST).toBeUndefined();
  });
});

describe('askClaude', () => {
  test('default model is Haiku 5.5 and the request is well formed', () => {
    askClaude({ system: 'SYS', user: 'hi', maxTokens: 100 });
    const [url, req] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers).toEqual({ 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' });
    expect(req.muteHttpExceptions).toBe(true);
    expect(JSON.parse(req.payload)).toEqual({ model: 'claude-haiku-5-5', max_tokens: 100, system: 'SYS', messages: [{ role: 'user', content: 'hi' }] });
  });
  test('effort and schema go into output_config', () => {
    const schema = { type: 'object' };
    askClaude({ system: 's', user: 'u', effort: 'low', schema: schema });
    expect(JSON.parse(fetchMock.mock.calls[0][1].payload).output_config)
      .toEqual({ effort: 'low', format: { type: 'json_schema', schema: schema } });
  });
  test('reads text blocks after a thinking block', () => {
    fetchMock.mockImplementationOnce(() => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        stop_reason: 'end_turn', usage: {},
        content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: goodJson }]
      })
    }));
    const res = askClaude({ system: 's', user: 'u' });
    expect(res.text).toBe(goodJson);
    expect(res.stopReason).toBe('end_turn');
  });
  test('ANTHROPIC_WORKSPACE_ID adds the anthropic-workspace-id header', () => {
    props.ANTHROPIC_WORKSPACE_ID = 'wrkspc_test';
    askClaude({ system: 's', user: 'u' });
    expect(fetchMock.mock.calls[0][1].headers['anthropic-workspace-id']).toBe('wrkspc_test');
  });
  test('CLAUDE_MODEL overrides the default', () => {
    props.CLAUDE_MODEL = 'claude-sonnet-5-5';
    askClaude({ system: 's', user: 'u' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].payload).model).toBe('claude-sonnet-5-5');
  });
  test('logs token usage but never the key', () => {
    askClaude({ system: 's', user: 'u' });
    const logged = console.log.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logged).toContain('input_tokens=321');
    expect(logged).toContain('output_tokens=45');
    expect(logged).not.toContain('sk-test');
  });
  test('retries once on 429 then succeeds', () => {
    fetchMock.mockImplementationOnce(() => apiStatus(429));
    expect(askClaude({ system: 's', user: 'u' }).text).toBe(goodJson);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  test('4xx errors are not retried', () => {
    fetchMock.mockImplementation(() => apiStatus(401));
    expect(() => askClaude({ system: 's', user: 'u' })).toThrow('HTTP 401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('trigger management', () => {
  test('setupWeeklySummary installs one Monday 8:00 Lima trigger, idempotently', () => {
    W.setupWeeklySummary();
    W.setupWeeklySummary();
    expect(triggers).toHaveLength(1);
    const b = global.__builder;
    expect(b.onWeekDay).toHaveBeenCalledWith('MONDAY');
    expect(b.atHour).toHaveBeenCalledWith(8);
    expect(b.inTimezone).toHaveBeenCalledWith('America/Lima');
  });
  test('removeWeeklySummary removes only its own triggers', () => {
    triggers.push({ getHandlerFunction: () => 'somethingElse' });
    W.setupWeeklySummary();
    expect(W.removeWeeklySummary()).toBe(1);
    expect(triggers.map(t => t.getHandlerFunction())).toEqual(['somethingElse']);
    expect(W.removeWeeklySummary()).toBe(0);
  });
});
