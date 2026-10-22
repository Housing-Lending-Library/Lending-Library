/**
 * Lending Library — reminder and notification script (Google Apps Script).
 *
 * Runs under the shared lending-library Google account:
 *   tick()           every 5 minutes:
 *                      - reminders about 30 and 15 minutes before each pickup and return,
 *                        by email to the Housing mailbox and/or as a Teams channel post;
 *                      - sends queued messages for the Housing Team (escalations, suspensions).
 *   morningSummary() every day around 7:00: what's late, today and tomorrow.
 *   cleanup()        every night: deletes closed loans older than the retention period.
 *
 * Setup (see SETUP.md, steps 5–6): paste this file and appsscript.json into a new Apps Script project,
 * link it to the Firebase project, set the script properties, then run installTriggers once.
 *
 * Script properties (Project Settings → Script properties):
 *   FIREBASE_PROJECT_ID  required, e.g. lending-library-2a993
 *   TEAMS_WEBHOOK_URL    optional, the link from the Teams "Workflows" webhook
 */

const TZ = 'Europe/Berlin';
const OFFSETS = [30, 15]; // minutes before each pickup/return

// ---------- entry points ----------

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('morningSummary').timeBased().everyDays(1).atHour(7).inTimezone(TZ).create();
  ScriptApp.newTrigger('cleanup').timeBased().everyDays(1).atHour(2).inTimezone(TZ).create();
  Logger.log('Triggers installed: tick every 5 min, morningSummary ~07:00, cleanup ~02:00.');
}

function tick() {
  const settings = getSettings_();
  sendReminders_(settings);
  sendOutbox_(settings);
}

// ---------- reminders ----------

function sendReminders_(settings) {
  const now = Date.now();
  const loans = runQuery_('loans', {
    fieldFilter: { field: { fieldPath: 'status' }, op: 'IN', value: { arrayValue: { values: [{ stringValue: 'booked' }, { stringValue: 'out' }] } } },
  });
  loans.forEach(function (doc) {
    const l = doc.data;
    if (l.deleted === true) return;
    const remind = l.remind || {};
    const due = [];
    [['out', l.pickupAt], ['back', l.returnAt]].forEach(function (p) {
      if (p[0] === 'out' && l.status !== 'booked') return;
      const t = new Date(p[1]).getTime();
      // Each reminder has a window: 30 → [t-30, t-15), 15 → [t-15, t). Missed windows are skipped, not sent late.
      OFFSETS.forEach(function (off, i) {
        const key = p[0] + off;
        const next = OFFSETS[i + 1] || 0;
        if (!remind[key] && now >= t - off * 60000 && now < t - next * 60000) due.push({ key: key, kind: p[0], off: off, at: p[1] });
      });
    });
    if (!due.length) return;
    // Only the most urgent one if two fall due in the same run.
    const r = due.sort(function (a, b) { return a.off - b.off; })[0];
    const place = pudoText_(settings, l.pudo);
    const what = r.kind === 'out' ? 'Pickup' : 'Return';
    const title = 'In ' + Math.max(1, Math.round((new Date(r.at).getTime() - now) / 60000)) + ' min: ' + what + ' at ' + place;
    const lines = [
      what + ' at ' + Utilities.formatDate(new Date(r.at), TZ, 'HH:mm') + ' — ' + place,
      'Items: ' + (l.itemNames || []).join(', '),
      'Student: ' + l.borrowerName + ' (' + l.matric + ')',
      r.kind === 'out' ? 'Check the campus card and the ban list, then brief the borrower.' : 'Compare the condition with pickup: clean, complete, not damaged.',
    ];
    if (l.notes) lines.push('Notes: ' + l.notes);
    try {
      const patch = {}; patch['remind.' + r.key] = new Date().toISOString();
      // Mark first (with a precondition), so a reminder is never sent twice even if two runs overlap.
      patchPaths_('loans/' + doc.id, patch, doc.updateTime);
      if (settings.emailReminders !== false && settings.notifyEmail) sendEmail_(settings.notifyEmail, '[Lending Library] ' + title, lines.join('\n'));
      if (settings.teamsReminders !== false) postTeams_(title, lines);
    } catch (e) {
      Logger.log('Reminder for ' + doc.id + ' skipped: ' + e);
    }
  });
}

// ---------- outbox: escalations, suspensions ----------

function sendOutbox_(settings) {
  const to = settings.escalationEmail || settings.notifyEmail;
  const msgs = runQuery_('outbox', { unaryFilter: { field: { fieldPath: 'sentAt' }, op: 'IS_NULL' } });
  msgs.forEach(function (doc) {
    const m = doc.data;
    try {
      patchPaths_('outbox/' + doc.id, { sentAt: new Date().toISOString() }, doc.updateTime);
      if (to) sendEmail_(to, m.subject, m.text + '\n\n— Sent by Lending Library' + (m.by ? ' for ' + m.by.name : ''));
      postTeams_(m.subject, String(m.text).split('\n'));
    } catch (e) { Logger.log('Outbox ' + doc.id + ': ' + e); }
  });
}

// ---------- morning summary ----------

function morningSummary() {
  const settings = getSettings_();
  const now = new Date();
  const dayStart = startOfDay_(now), dayEnd = new Date(dayStart.getTime() + 864e5), tomorrowEnd = new Date(dayStart.getTime() + 2 * 864e5);
  const wait = Number(settings.noShowWaitMinutes || 15) * 60000;
  const open = runQuery_('loans', {
    fieldFilter: { field: { fieldPath: 'status' }, op: 'IN', value: { arrayValue: { values: [{ stringValue: 'booked' }, { stringValue: 'out' }] } } },
  }).map(function (d) { return d.data; }).filter(function (l) { return l.deleted !== true; });

  const late = [], today = [], tomorrow = [];
  open.forEach(function (l) {
    const out = new Date(l.pickupAt), back = new Date(l.returnAt);
    const line = function (kind) { return (l.itemNames || []).join(', ') + ' · ' + l.borrowerName + ' (' + l.matric + ') · ' + pudoText_(settings, l.pudo); };
    if (l.status === 'booked' && out.getTime() + wait < now.getTime()) late.push({ at: out, text: 'No-show? ' + line('out') });
    if (l.status === 'out' && back < now) late.push({ at: back, text: 'Overdue: ' + line('back') + ((l.contacts || []).length ? ' · ' + l.contacts.length + ' contact attempt(s)' : '') });
    [['PICKUP ', out, l.status === 'booked'], ['RETURN ', back, true]].forEach(function (p) {
      if (!p[2]) return;
      if (p[1] >= now && p[1] < dayEnd) today.push({ at: p[1], text: p[0] + line() });
      else if (p[1] >= dayEnd && p[1] < tomorrowEnd) tomorrow.push({ at: p[1], text: p[0] + line() });
    });
  });
  const byTime = function (a, b) { return a.at - b.at; };
  late.sort(byTime); today.sort(byTime); tomorrow.sort(byTime);
  if (!late.length && !today.length && !tomorrow.length) return;

  const fmt = function (x, long) { return Utilities.formatDate(x.at, TZ, long ? 'EEE dd MMM HH:mm' : 'HH:mm'); };
  const section = function (title, list, long) {
    if (!list.length) return [];
    return ['', title + ' (' + list.length + ')'].concat(list.map(function (x) { return '  ' + fmt(x, long) + '  ' + x.text; }));
  };
  const lines = ['Lending library for ' + Utilities.formatDate(now, TZ, 'EEEE d MMMM') + ':']
    .concat(section('Needs action', late, true), section('Today', today), section('Tomorrow', tomorrow));
  const subject = '[Lending Library] ' + (late.length ? late.length + ' need action, ' : '') + today.length + ' today';
  if (settings.notifyEmail) sendEmail_(settings.notifyEmail, subject, lines.join('\n'));
  if (settings.teamsReminders !== false) postTeams_(subject.replace('[Lending Library] ', 'Morning summary: '), lines.slice(1));
}

// ---------- cleanup (data retention) ----------

function cleanup() {
  const settings = getSettings_();
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - Number(settings.retentionMonths || 12));
  let removed = 0;
  listAll_('loans').forEach(function (d) {
    const l = d.data;
    const closed = l.deleted === true || ['returned', 'noshow', 'cancelled', 'notreturned'].indexOf(l.status) !== -1;
    const when = new Date(l.closedAt || l.deletedAt || l.returnAt || 0);
    if (closed && when < cutoff) { deleteDoc_('loans/' + d.id); removed++; }
  });
  listAll_('outbox').forEach(function (d) {
    if (d.data.sentAt && new Date(d.data.sentAt) < new Date(Date.now() - 30 * 864e5)) deleteDoc_('outbox/' + d.id);
  });
  Logger.log('Cleanup removed ' + removed + ' old loans.');
}

// ---------- sending ----------

function sendEmail_(to, subject, text) {
  MailApp.sendEmail({ to: to, subject: subject, body: text, name: 'Lending Library' });
}

/** Posts to a Teams channel through a "Workflows" webhook (Adaptive Card format). Does nothing if no URL is set. */
function postTeams_(title, lines) {
  const url = PropertiesService.getScriptProperties().getProperty('TEAMS_WEBHOOK_URL');
  if (!url) return;
  const card = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
        body: [{ type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true }].concat(
          (lines || []).filter(function (x) { return x !== ''; }).map(function (x) { return { type: 'TextBlock', text: String(x), wrap: true, spacing: 'Small' }; })),
      },
    }],
  };
  const res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(card), muteHttpExceptions: true });
  if (res.getResponseCode() >= 300) Logger.log('Teams post failed (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200));
}

function pudoText_(settings, id) {
  const p = (settings.pudos || []).filter(function (x) { return x.id === id; })[0];
  return p ? p.room + ' (' + p.building + ')' : (id || '');
}

// ---------- Firestore REST helpers ----------

function base_() {
  const id = PropertiesService.getScriptProperties().getProperty('FIREBASE_PROJECT_ID');
  if (!id) throw new Error('Set the script property FIREBASE_PROJECT_ID (Project Settings → Script properties).');
  return 'https://firestore.googleapis.com/v1/projects/' + id + '/databases/(default)/documents';
}
function call_(method, url, body) {
  const res = UrlFetchApp.fetch(url, {
    method: method, contentType: 'application/json', payload: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 404) return null;
  if (code >= 300) throw new Error(res.getContentText().slice(0, 300));
  return res.getContentText() ? JSON.parse(res.getContentText()) : {};
}
function getSettings_() {
  const d = call_('get', base_() + '/settings/main');
  return d ? fromFields_(d.fields || {}) : {};
}
function runQuery_(collection, where) {
  const res = call_('post', base_() + ':runQuery', { structuredQuery: { from: [{ collectionId: collection }], where: where } }) || [];
  return res.filter(function (r) { return r.document; }).map(function (r) {
    return { id: r.document.name.split('/').pop(), updateTime: r.document.updateTime, data: fromFields_(r.document.fields || {}) };
  });
}
function listAll_(collection) {
  const out = [];
  let token = '';
  do {
    const res = call_('get', base_() + '/' + collection + '?pageSize=300' + (token ? '&pageToken=' + encodeURIComponent(token) : '')) || {};
    (res.documents || []).forEach(function (d) { out.push({ id: d.name.split('/').pop(), updateTime: d.updateTime, data: fromFields_(d.fields || {}) }); });
    token = res.nextPageToken || '';
  } while (token);
  return out;
}
/** Updates only the given field paths (dots allowed, e.g. "remind.out30"). Fails if the document changed since updateTime. */
function patchPaths_(path, data, updateTime) {
  const fields = {};
  Object.keys(data).forEach(function (k) {
    const parts = k.split('.');
    let node = fields;
    parts.forEach(function (p, i) {
      if (i === parts.length - 1) node[p] = toValue_(data[k]);
      else { node[p] = node[p] || { mapValue: { fields: {} } }; node = node[p].mapValue.fields; }
    });
  });
  const mask = Object.keys(data).map(function (k) { return 'updateMask.fieldPaths=' + encodeURIComponent(k); }).join('&');
  const pre = updateTime ? '&currentDocument.updateTime=' + encodeURIComponent(updateTime) : '';
  return call_('patch', base_() + '/' + path + '?' + mask + pre, { fields: fields });
}
function deleteDoc_(path) { return call_('delete', base_() + '/' + path); }
function fromValue_(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue_);
  if ('mapValue' in v) return fromFields_(v.mapValue.fields || {});
  return null;
}
function fromFields_(f) { const o = {}; Object.keys(f).forEach(function (k) { o[k] = fromValue_(f[k]); }); return o; }
function toValue_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue_) } };
  if (typeof v === 'object') { const f = {}; Object.keys(v).forEach(function (k) { f[k] = toValue_(v[k]); }); return { mapValue: { fields: f } }; }
  return { stringValue: String(v) };
}
function startOfDay_(d) { return new Date(Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'00:00:00XXX")); }

// ---------- setup test ----------

/** Run by hand after setup: reads the database, then sends one test email and one Teams post. */
function sendTest() {
  const settings = getSettings_();
  Logger.log('Database OK. Housing mailbox: ' + (settings.notifyEmail || '(not set in Settings yet)'));
  if (settings.notifyEmail) sendEmail_(settings.notifyEmail, '[Lending Library] Test reminder', 'If you can read this, reminder emails work. You can delete this email.');
  postTeams_('Lending Library test', ['If you can read this, Teams reminders work.']);
  Logger.log('Test sent. Check the Housing mailbox' + (PropertiesService.getScriptProperties().getProperty('TEAMS_WEBHOOK_URL') ? ' and the Teams channel.' : '. (No Teams link set, so nothing was posted to Teams.)'));
}
