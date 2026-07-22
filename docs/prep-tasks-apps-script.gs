/**
 * Prep Tasks sync — Google Apps Script web app
 * -------------------------------------------------
 * Backs the Wellness OS "Prep" page. It is ONLY a read/write bridge to the
 * existing `Prep_Tasks` tab of the "Destination Scorecard" spreadsheet.
 * It does not add columns or change the schema — it reads and writes the
 * columns that are already there, addressed by their header names.
 *
 * SETUP
 * 1. Open the "Destination Scorecard" spreadsheet.
 * 2. Extensions -> Apps Script. Delete the starter code and paste this file.
 * 3. (Recommended) Project Settings -> Script Properties -> add a property
 *    named PREP_TOKEN with a long random value. Leave it unset to run with
 *    no token (fine for a private, unlisted deployment).
 * 4. Deploy -> New deployment -> type "Web app".
 *      - Execute as: Me
 *      - Who has access: Anyone with the link
 *    Copy the /exec URL it gives you.
 * 5. In the Wellness OS Prep page, open the gear (Settings), paste the /exec
 *    URL and the same token, and Save.
 *
 * Re-deploy (Manage deployments -> edit -> new version) whenever you change
 * this script.
 */

var SHEET_NAME = 'Prep_Tasks';

// Only these columns may be written back from the app. Everything else in the
// row is read-only from the app's point of view.
var WRITABLE = ['status', 'owner', 'due_date', 'priority', 'notes', 'task_name'];

function requiredToken_() {
  return PropertiesService.getScriptProperties().getProperty('PREP_TOKEN') || '';
}

function tokenOk_(provided) {
  var need = requiredToken_();
  if (!need) return true; // no token configured -> open (relies on unlisted URL)
  return String(provided || '') === need;
}

function sheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('Sheet "' + SHEET_NAME + '" was not found.');
  return sh;
}

function headerMap_(sh) {
  var lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    var key = String(headers[i] || '').trim();
    if (key) map[key] = i; // 0-based column index
  }
  return { headers: headers, map: map };
}

function cellToString_(value, tz) {
  if (value === null || value === undefined) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    // Store dates back as plain YYYY-MM-DD so the app can bucket them by day.
    return Utilities.formatDate(value, tz, 'yyyy-MM-dd');
  }
  return String(value);
}

function readTasks_() {
  var sh = sheet_();
  var tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone() || 'Etc/UTC';
  var hm = headerMap_(sh);
  var map = hm.map;
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 2) return [];

  var values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var out = [];
  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    var get = function (name) {
      return map[name] === undefined ? '' : cellToString_(row[map[name]], tz);
    };
    var deleted = String(get('deleted')).trim().toUpperCase();
    if (deleted === 'TRUE' || deleted === 'YES' || deleted === '1') continue;
    var id = get('task_id');
    var name = get('task_name');
    if (!id && !name) continue; // skip fully blank rows

    out.push({
      task_id: id,
      task_name: name,
      category: get('category'),
      milestone: get('milestone'),
      status: get('status'),
      priority: get('priority'),
      due_date: get('due_date'),
      owner: get('owner'),
      notes: get('notes'),
      updated_at: get('updated_at'),
      subtasks: get('subtasks')
    });
  }
  return out;
}

function updateTask_(taskId, fields) {
  var sh = sheet_();
  var tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone() || 'Etc/UTC';
  var hm = headerMap_(sh);
  var map = hm.map;
  if (map['task_id'] === undefined) throw new Error('No task_id column found.');

  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  var idCol = map['task_id'];
  var ids = sh.getRange(2, idCol + 1, Math.max(0, lastRow - 1), 1).getValues();

  var targetRow = -1;
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === String(taskId).trim()) {
      targetRow = i + 2; // account for header + 1-based
      break;
    }
  }
  if (targetRow === -1) throw new Error('Task not found: ' + taskId);

  var applied = {};
  for (var f = 0; f < WRITABLE.length; f++) {
    var key = WRITABLE[f];
    if (!(key in fields)) continue;
    if (map[key] === undefined) continue;
    sh.getRange(targetRow, map[key] + 1).setValue(fields[key]);
    applied[key] = fields[key];
  }

  // Always stamp updated_at when something changed.
  if (map['updated_at'] !== undefined && Object.keys(applied).length) {
    var stamp = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ss'Z'");
    sh.getRange(targetRow, map['updated_at'] + 1).setValue(stamp);
    applied.updated_at = stamp;
  }

  // Return the full, fresh row.
  var rowVals = sh.getRange(targetRow, 1, 1, lastCol).getValues()[0];
  var get = function (name) {
    return map[name] === undefined ? '' : cellToString_(rowVals[map[name]], tz);
  };
  return {
    task_id: get('task_id'),
    task_name: get('task_name'),
    category: get('category'),
    milestone: get('milestone'),
    status: get('status'),
    priority: get('priority'),
    due_date: get('due_date'),
    owner: get('owner'),
    notes: get('notes'),
    updated_at: get('updated_at'),
    subtasks: get('subtasks')
  };
}

function addTask_(fields) {
  var sh = sheet_();
  var tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone() || 'Etc/UTC';
  var hm = headerMap_(sh);
  var map = hm.map;
  var lastCol = sh.getLastColumn();
  var row = [];
  for (var c = 0; c < lastCol; c++) row.push('');

  var id = String(fields.task_id || ('app-' + Utilities.getUuid().slice(0, 8)));
  var stamp = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ss'Z'");
  var set = function (name, val) { if (map[name] !== undefined) row[map[name]] = val; };

  set('task_id', id);
  set('task_name', fields.task_name || '');
  set('status', fields.status || 'Not Started');
  set('owner', fields.owner || '');
  set('due_date', fields.due_date || '');
  set('priority', fields.priority || '');
  set('notes', fields.notes || '');
  set('category', fields.category || '');
  set('deleted', 'FALSE');
  set('created_at', stamp);
  set('updated_at', stamp);

  sh.appendRow(row);

  return {
    task_id: id,
    task_name: fields.task_name || '',
    category: fields.category || '',
    milestone: '',
    status: fields.status || 'Not Started',
    priority: fields.priority || '',
    due_date: fields.due_date || '',
    owner: fields.owner || '',
    notes: fields.notes || '',
    updated_at: stamp,
    subtasks: ''
  };
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function serverToday_() {
  var tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone() || 'Etc/UTC';
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    if (!tokenOk_(params.token)) return json_({ ok: false, error: 'Unauthorized' });
    var action = params.action || 'list';
    if (action === 'list') {
      return json_({ ok: true, today: serverToday_(), tasks: readTasks_() });
    }
    return json_({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    var token = body.token || (e && e.parameter && e.parameter.token);
    if (!tokenOk_(token)) return json_({ ok: false, error: 'Unauthorized' });

    var action = body.action || 'update';
    if (action === 'update') {
      if (!body.task_id) return json_({ ok: false, error: 'Missing task_id' });
      var task = updateTask_(body.task_id, body.fields || {});
      return json_({ ok: true, task: task });
    }
    if (action === 'add') {
      var added = addTask_(body.fields || {});
      return json_({ ok: true, task: added });
    }
    if (action === 'list') {
      return json_({ ok: true, today: serverToday_(), tasks: readTasks_() });
    }
    return json_({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}
