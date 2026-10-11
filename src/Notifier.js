/**
 * Shared email helper. Recipient: Script Property ALERT_EMAIL, falling back to
 * the email of the account that owns / runs the script.
 */

var ALERT_EMAIL_PROPERTY = 'ALERT_EMAIL';
var DASHBOARD_URL_PROPERTY = 'DASHBOARD_URL';

function resolveRecipient_() {
  const configured = String(PropertiesService.getScriptProperties().getProperty(ALERT_EMAIL_PROPERTY) || '').trim();
  return configured || Session.getEffectiveUser().getEmail();
}

/** Link to the web app, from the DASHBOARD_URL property ('' if not set). */
function dashboardUrl_() {
  return String(PropertiesService.getScriptProperties().getProperty(DASHBOARD_URL_PROPERTY) || '').trim();
}

/** Sends { subject, html, text } to the alert recipient. */
function sendNotification_(message) {
  MailApp.sendEmail({
    to: resolveRecipient_(),
    subject: message.subject,
    htmlBody: message.html,
    body: message.text,
    name: 'Expenses dashboard'
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveRecipient_: resolveRecipient_, dashboardUrl_: dashboardUrl_, sendNotification_: sendNotification_ };
}
