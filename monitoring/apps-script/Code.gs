/**
 * Hubi pilot monitoring page. Bound to the "Hubi pilot monitoring" Sheet: it only reads that Sheet.
 *
 * Who can open it: the web app is deployed for the whole Wellhub domain, because Apps Script cannot list individual people,
 * so the list is enforced here. Only the emails in the Access tab (column A) see anything; everyone else gets a short
 * "no access" page and no data. The page shows real questions and answers from the pilot, so keep that list short.
 */

var TABS = ['Summary', 'Daily', 'Feedback', 'Not covered', 'Sources', 'Notes', 'Issues'];

function doGet() {
  if (!isAllowed_()) {
    return HtmlService.createHtmlOutput(
      '<body style="font-family:system-ui,sans-serif;background:#FBF8EC;color:#590931;padding:48px 24px;max-width:520px;margin:auto">' +
      '<h2 style="margin:0 0 8px">No access</h2><p>This page is limited to a short list of people. Ask Giulia Esposito to add your email.</p></body>'
    ).setTitle('Hubi pilot monitoring');
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Hubi pilot monitoring')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Called by the page. Checks the list again: the page's data must never depend on the page having been allowed once. */
function getData() {
  if (!isAllowed_()) throw new Error('No access');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = {};
  TABS.forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    out[name] = sheet ? sheet.getDataRange().getDisplayValues() : [];
  });
  return out;
}

function isAllowed_() {
  var email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (!email) return false;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Access');
  if (!sheet) return false;
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim().toLowerCase() === email) return true;
  }
  return false;
}
