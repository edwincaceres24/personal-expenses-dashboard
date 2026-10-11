/**
 * Claude API helper (Messages API over UrlFetchApp).
 * Script Properties: ANTHROPIC_API_KEY (required), CLAUDE_MODEL (optional),
 * ANTHROPIC_WORKSPACE_ID (only for keys not scoped to a workspace).
 * Never logs the API key or the prompt; logs token usage only.
 */

var CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
var CLAUDE_API_VERSION = '2023-06-01';
var CLAUDE_DEFAULT_MODEL = 'claude-haiku-5-5';
var CLAUDE_KEY_PROPERTY = 'ANTHROPIC_API_KEY';
var CLAUDE_MODEL_PROPERTY = 'CLAUDE_MODEL';
var CLAUDE_WORKSPACE_PROPERTY = 'ANTHROPIC_WORKSPACE_ID';
var CLAUDE_RETRY_DELAY_MS = 2000;

/**
 * Sends one prompt and returns { text, model, usage }.
 * opts: { system, user, maxTokens }. Throws on a missing key, an HTTP error
 * (after one retry on 429 / 5xx) or an unreadable response.
 */
function askClaude(opts) {
  const props = PropertiesService.getScriptProperties();
  const key = String(props.getProperty(CLAUDE_KEY_PROPERTY) || '').trim();
  if (!key) throw new Error('Script property ' + CLAUDE_KEY_PROPERTY + ' is not set.');
  const model = String(props.getProperty(CLAUDE_MODEL_PROPERTY) || '').trim() || CLAUDE_DEFAULT_MODEL;
  const workspaceId = String(props.getProperty(CLAUDE_WORKSPACE_PROPERTY) || '').trim();
  const headers = { 'x-api-key': key, 'anthropic-version': CLAUDE_API_VERSION };
  if (workspaceId) headers['anthropic-workspace-id'] = workspaceId;
  const request = {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    muteHttpExceptions: true,
    payload: JSON.stringify({
      model: model,
      max_tokens: opts.maxTokens || 400,
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }]
    })
  };

  let res = UrlFetchApp.fetch(CLAUDE_API_URL, request);
  let code = res.getResponseCode();
  if (code === 429 || code >= 500) {
    Utilities.sleep(CLAUDE_RETRY_DELAY_MS);
    res = UrlFetchApp.fetch(CLAUDE_API_URL, request);
    code = res.getResponseCode();
  }
  const body = res.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('Claude API HTTP ' + code + ': ' + String(body).slice(0, 500));
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    throw new Error('Claude API returned a non-JSON response.');
  }
  const usage = data.usage || {};
  console.log('Claude usage: model=' + model + ' input_tokens=' + usage.input_tokens + ' output_tokens=' + usage.output_tokens);
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return { text: text, model: model, usage: usage };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { askClaude: askClaude, CLAUDE_DEFAULT_MODEL: CLAUDE_DEFAULT_MODEL };
}
