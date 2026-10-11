/**
 * Weekly Summary agent: every Monday ~8:00 (America/Lima) emails last week's
 * spending control, the month projection and 2–3 Claude recommendations.
 * Read-only: never writes to the spreadsheet.
 *
 * Setup: setupWeeklySummary() once; remove with removeWeeklySummary();
 * test with runWeeklySummaryNow() (ignores the once-per-week guard).
 */

var SUMMARY_HANDLER = 'runWeeklySummary';
var SUMMARY_LAST_PROPERTY = 'WEEKLY_SUMMARY_LAST';
var SUMMARY_TIME_ZONE = 'America/Lima';
var SUMMARY_TRIGGER_HOUR = 8;

/** Trigger entry point: sends the summary unless this week's was already sent. */
function runWeeklySummary() {
  return sendWeeklySummary_(false);
}

/** Sends the summary now, bypassing the once-per-week check (for testing). */
function runWeeklySummaryNow() {
  return sendWeeklySummary_(true);
}

function sendWeeklySummary_(force) {
  try {
    const today = Utilities.formatDate(new Date(), SUMMARY_TIME_ZONE, 'yyyy-MM-dd');
    const marker = summaryMarker(isoWeekKey(previousWeek(today).start));
    const props = PropertiesService.getScriptProperties();
    if (!shouldSendSummary(props.getProperty(SUMMARY_LAST_PROPERTY), marker, force)) {
      console.log('Weekly summary already sent for ' + marker + '; skipping.');
      return { sent: false, reason: 'already-sent' };
    }
    const loaded = loadData_(true); // fresh read: the 5-minute cache must not serve stale data
    const report = buildWeeklyReport(loaded.data, { today: today, settings: readSettings_() });
    const recommendations = report.hasExpenses ? fetchRecommendations_(report) : null;
    sendNotification_(renderSummaryEmail(report, recommendations, dashboardUrl_()));
    if (!force) props.setProperty(SUMMARY_LAST_PROPERTY, marker);
    return { sent: true, week: report.week.key, recommendations: !!recommendations };
  } catch (e) {
    console.error('Weekly summary failed: ' + (e && e.stack ? e.stack : e));
    sendNotification_(renderErrorEmail(e && e.message ? e.message : String(e), dashboardUrl_()));
    return { sent: false, reason: 'error', error: String(e && e.message ? e.message : e) };
  }
}

/** Recommendations from Claude, or null on any failure (the summary is never blocked). */
function fetchRecommendations_(report) {
  try {
    // Thinking counts toward max_tokens, so leave room beyond the short answer.
    const res = askClaude({
      system: SUMMARY_SYSTEM_PROMPT,
      user: buildClaudePrompt(report),
      maxTokens: 2000,
      effort: 'low',
      schema: RECOMMENDATIONS_SCHEMA
    });
    const recommendations = validateRecommendations(res.text);
    if (!recommendations) {
      console.error('Claude returned invalid recommendations (stop_reason=' + res.stopReason + '): ' +
        String(res.text).slice(0, 200));
    }
    return recommendations;
  } catch (e) {
    console.error('Claude call failed: ' + (e && e.message ? e.message : e));
    return null;
  }
}

/** Installs the Monday 8:00 trigger. Safe to run repeatedly (replaces any existing one). */
function setupWeeklySummary() {
  removeWeeklySummary();
  ScriptApp.newTrigger(SUMMARY_HANDLER)
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(SUMMARY_TRIGGER_HOUR)
    .inTimezone(SUMMARY_TIME_ZONE)
    .create();
  console.log('Weekly summary trigger installed (Mondays at ~' + SUMMARY_TRIGGER_HOUR + ':00 ' + SUMMARY_TIME_ZONE + ').');
}

/** Removes the trigger(s) for the weekly summary. Returns how many were removed. */
function removeWeeklySummary() {
  const triggers = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === SUMMARY_HANDLER);
  triggers.forEach(t => ScriptApp.deleteTrigger(t));
  return triggers.length;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    runWeeklySummary: runWeeklySummary,
    runWeeklySummaryNow: runWeeklySummaryNow,
    setupWeeklySummary: setupWeeklySummary,
    removeWeeklySummary: removeWeeklySummary
  };
}
