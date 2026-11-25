// Meadow - your life app. Runs on your PC (no extra installs, just Node.js).
// Run: node server.js   then open http://localhost:3200 (or the Tailscale address from your phone)

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const PORT = Number(process.env.PORT) || 3200; // 3000 = Dice and Luck, 3100 = Money Quest
const TS_PORT = 10000;                         // Tailscale Serve port (443 = Dice and Luck, 8443 = Money Quest)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'life.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PUBLIC_DIR = path.join(__dirname, 'public');
const COLLECTIONS = ['tasks', 'events', 'lists', 'done', 'settings', 'feeds', 'apps', 'projects'];
const KEEP_BACKUPS = 30;
const TOMBSTONE_DAYS = 60;

// ---------- storage ----------
// Everything lives in data/life.json. Each item has an id, updatedAt (when it was last changed)
// and _rev (a counter the server bumps on every change, so devices can ask "what changed since X?").
// Deleted items stay for a while as { deleted: true } so other devices learn about the delete.
let db = { version: 1, rev: 0, items: {} };

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function load() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    try { db = readJson(DATA_FILE); }
    catch (e) {
      const bad = DATA_FILE.replace(/\.json$/, `.broken-${Date.now()}.json`);
      fs.copyFileSync(DATA_FILE, bad);
      const last = latestBackup();
      console.error(`  life.json could not be read (${e.message}). Kept it as ${path.basename(bad)}.`);
      if (last) { db = readJson(last); console.error(`  Restored ${path.basename(last)}.`); }
    }
  }
  db.items = db.items || {};
  for (const c of COLLECTIONS) db.items[c] = db.items[c] || {};
  db.rev = db.rev || 0;
  prune();
}

function latestBackup() {
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort();
  return files.length ? path.join(BACKUP_DIR, files[files.length - 1]) : null;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    writeJson(DATA_FILE, db);
    backup();
  }, 300);
}

// one backup per day, the last 30 days are kept
function backup() {
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(BACKUP_DIR, `life-${day}.json`);
  if (fs.existsSync(file)) return;
  fs.copyFileSync(DATA_FILE, file);
  const files = fs.readdirSync(BACKUP_DIR).filter(f => /^life-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(BACKUP_DIR, f));
}

// forget deleted items after 60 days
function prune() {
  const cutoff = Date.now() - TOMBSTONE_DAYS * 864e5;
  for (const c of COLLECTIONS) {
    for (const [id, it] of Object.entries(db.items[c])) if (it.deleted && (it.updatedAt || 0) < cutoff) delete db.items[c][id];
  }
}

// ---------- sync ----------
// A device sends the changes it made (possibly while offline) and the last rev it has seen.
// For each item the newest change wins. The reply holds everything that changed since that rev.
function cleanItem(it) {
  if (!it || typeof it !== 'object' || Array.isArray(it)) return null;
  if (typeof it.id !== 'string' || !/^[\w-]{1,64}$/.test(it.id)) return null;
  const out = JSON.parse(JSON.stringify(it));
  out.updatedAt = Number(out.updatedAt) || Date.now();
  if (out.updatedAt > Date.now() + 864e5) out.updatedAt = Date.now(); // a phone with a wrong clock
  delete out._rev;
  return out;
}

function sync(body) {
  const changes = Array.isArray(body.changes) ? body.changes.slice(0, 5000) : [];
  let applied = 0;
  for (const ch of changes) {
    if (!ch || !COLLECTIONS.includes(ch.coll)) continue;
    const it = cleanItem(ch.item);
    if (!it) continue;
    const cur = db.items[ch.coll][it.id];
    if (cur && (cur.updatedAt || 0) > it.updatedAt) continue; // we already have a newer version
    it._rev = ++db.rev;
    db.items[ch.coll][it.id] = it;
    applied++;
  }
  if (applied) save();
  const since = Number(body.since) || 0;
  const out = [];
  for (const c of COLLECTIONS) {
    for (const it of Object.values(db.items[c])) if (it._rev > since) out.push({ coll: c, item: it });
  }
  return { rev: db.rev, changes: out, full: since === 0 };
}

// ---------- links to your other apps (read-only) ----------
// Meadow asks Money Quest and Dice and Luck, on this same PC, for a short summary.
// The last good answer is kept, so your phone still sees something when an app is closed.
const LINKS = {
  money: { url: 'http://127.0.0.1:3100/api/link/summary', name: 'Money Quest' },
  dice: { url: 'http://127.0.0.1:3000/api/link/summary', name: 'Dice and Luck' },
};
const LINKS_FILE = path.join(DATA_DIR, 'links.json');
let linkCache = {};
try { linkCache = readJson(LINKS_FILE); } catch {}
function fetchJson(url) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: 2500 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ error: res.statusCode === 404 ? 'needs-update' : 'HTTP ' + res.statusCode });
        try { resolve({ data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch { resolve({ error: 'bad-reply' }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ error: 'offline' }));
  });
}

// Other apps you add yourself in Settings (name + port). Meadow checks that each one is running and,
// if the app answers /api/link/summary in the simple format described in the README, shows its numbers
// and dates too.
function customApps() {
  return Object.values(db.items.apps || {}).filter(a => !a.deleted && Number.isInteger(+a.port) && +a.port > 0 && +a.port < 65536 && +a.port !== PORT);
}
async function checkCustom(a) {
  const base = `http://127.0.0.1:${+a.port}`;
  const r = await fetchJson(base + '/api/link/summary');
  if (r.data && typeof r.data === 'object') return { data: r.data };
  if (r.error === 'offline') return { error: 'offline' };
  return { running: true }; // it answers, it just has nothing to share
}
let linksBusy = null, linksAt = 0;
async function links(force) {
  if (!force && Date.now() - linksAt < 15000 && !linksBusy) return linkCache;
  if (!linksBusy) linksBusy = (async () => {
    const out = { apps: {} };
    const prevApps = linkCache.apps || {};
    const jobs = Object.entries(LINKS).map(async ([k, l]) => {
      let r = await fetchJson(l.url);
      if (r.error === 'offline' || r.error === 'timeout') { await new Promise(ok => setTimeout(ok, 400)); r = await fetchJson(l.url); } // one quick retry
      const prev = linkCache[k] || {};
      out[k] = r.data ? { ok: true, at: Date.now(), data: r.data } : { ok: false, error: r.error, at: prev.at || null, data: prev.data || null };
    });
    for (const a of customApps()) jobs.push((async () => {
      const r = await checkCustom(a), prev = prevApps[a.id] || {};
      out.apps[a.id] = r.error ? { ok: false, error: r.error, at: prev.at || null, data: prev.data || null }
        : { ok: true, at: Date.now(), data: r.data || null };
    })());
    await Promise.all(jobs);
    out.checked = Date.now();
    linkCache = out; linksAt = Date.now();
    try { writeJson(LINKS_FILE, out); } catch {}
    linksBusy = null;
    return out;
  })();
  return linksBusy;
}

// ---------- calendar feeds (iCal / .ics links: iPhone, iCloud, school, Google, Outlook) ----------
// You paste a calendar's share link in Settings. Your PC downloads it every 30 minutes (read-only)
// and Meadow shows the events next to your own. The last good copy is kept for when you're offline.
const https = require('https');
const CAL_FILE = path.join(DATA_DIR, 'calendars.json');
let calCache = {};
try { calCache = readJson(CAL_FILE); } catch {}

function fetchText(url, hops = 0) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(url.trim().replace(/^webcals?:\/\//i, 'https://')); } catch { return resolve({ error: 'bad-link' }); }
    if (!/^https?:$/.test(u.protocol)) return resolve({ error: 'bad-link' });
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { timeout: 15000, headers: { 'User-Agent': 'Meadow/3 (calendar reader)', Accept: 'text/calendar, */*' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, u).href, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve({ error: res.statusCode === 404 || res.statusCode === 403 ? 'not-found' : 'HTTP ' + res.statusCode }); }
      const chunks = []; let size = 0;
      const stream = /gzip/.test(res.headers['content-encoding'] || '') ? res.pipe(zlib.createGunzip()) : res;
      stream.on('data', c => { size += c.length; if (size > 20e6) { req.destroy(); resolve({ error: 'too-big' }); } else chunks.push(c); });
      stream.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', () => resolve({ error: 'offline' }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ error: 'offline' }));
  });
}

// Outlook and Exchange feeds often use Windows time zone names
const WIN_TZ = {
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix', 'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax', 'SA Pacific Standard Time': 'America/Bogota',
  'Central America Standard Time': 'America/Guatemala', 'Mexico Standard Time': 'America/Mexico_City', 'Central Standard Time (Mexico)': 'America/Mexico_City',
  'GMT Standard Time': 'Europe/London', 'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw', 'UTC': 'UTC', 'Coordinated Universal Time': 'UTC',
};
const tzOk = {};
function validTz(tz) {
  if (!tz) return null;
  tz = tz.replace(/^"|"$/g, '').replace(/^\//, '');
  tz = WIN_TZ[tz] || tz;
  if (!(tz in tzOk)) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); tzOk[tz] = true; } catch { tzOk[tz] = false; } }
  return tzOk[tz] ? tz : null;
}
function tzOffset(tz, ms) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms))) parts[p.type] = +p.value;
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second) - ms;
}
// wall-clock time in a zone -> a real moment
function wallToDate(w, mode, tz) {
  if (mode === 'utc') return new Date(Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s));
  if (mode === 'tz') {
    const guess = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
    let t = guess - tzOffset(tz, guess);
    t = guess - tzOffset(tz, t);
    return new Date(t);
  }
  return new Date(w.y, w.m - 1, w.d, w.h, w.mi, w.s); // "floating" time: the same clock time wherever you are
}
const p2 = n => String(n).padStart(2, '0');
const localDay = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const localTime = d => `${p2(d.getHours())}:${p2(d.getMinutes())}`;

function parseDT(value, params) {
  const v = String(value || '').trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m || params.VALUE === 'DATE') {
    m = m || v.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    return { allDay: true, w: { y: +m[1], m: +m[2], d: +m[3], h: 0, mi: 0, s: 0 } };
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const tz = !m[7] && validTz(params.TZID);
  return { allDay: false, w: { y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0) }, mode: m[7] ? 'utc' : tz ? 'tz' : 'float', tz };
}
function parseDuration(v) {
  const m = String(v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * ((+(m[2] || 0) * 7 + +(m[3] || 0)) * 864e5 + +(m[4] || 0) * 36e5 + +(m[5] || 0) * 6e4 + +(m[6] || 0) * 1e3);
}
const unescapeText = s => String(s || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

function parseIcs(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = []; let cur = null, calName = '', depth = 0;
  for (const line of lines) {
    if (/^BEGIN:VEVENT$/i.test(line)) { cur = { exdates: [] }; continue; }
    if (/^END:VEVENT$/i.test(line)) { if (cur) events.push(cur); cur = null; continue; }
    if (/^BEGIN:/i.test(line) && cur) { depth++; continue; } // skip VALARM etc.
    if (/^END:/i.test(line) && cur && depth) { depth--; continue; }
    const i = line.search(/[:]/); if (i < 0) continue;
    const head = line.slice(0, i), value = line.slice(i + 1);
    const [name, ...ps] = head.split(';');
    const params = {};
    for (const p of ps) { const j = p.indexOf('='); if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1); }
    const N = name.toUpperCase();
    if (!cur) { if (N === 'X-WR-CALNAME') calName = unescapeText(value); continue; }
    if (depth) continue;
    if (N === 'UID') cur.uid = value.trim();
    else if (N === 'SUMMARY') cur.title = unescapeText(value);
    else if (N === 'LOCATION') cur.location = unescapeText(value);
    else if (N === 'DTSTART') cur.start = parseDT(value, params);
    else if (N === 'DTEND') cur.end = parseDT(value, params);
    else if (N === 'DURATION') cur.duration = parseDuration(value);
    else if (N === 'RRULE') cur.rrule = Object.fromEntries(value.split(';').map(x => x.split('=')).map(([k, v]) => [String(k).toUpperCase(), v]));
    else if (N === 'EXDATE') for (const x of value.split(',')) { const d = parseDT(x, params); if (d) cur.exdates.push(d); }
    else if (N === 'RECURRENCE-ID') cur.recurId = parseDT(value, params);
    else if (N === 'STATUS') cur.status = value.trim().toUpperCase();
  }
  return { calName, events };
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
// day arithmetic on plain calendar dates (no time zones involved)
const cd = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const cdParts = t => ({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
const cdKey = t => `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function nthWeekday(y, m, n, wd) {
  if (n > 0) { const first = cd(y, m, 1).getUTCDay(); const day = 1 + ((wd - first + 7) % 7) + (n - 1) * 7; return day <= daysIn(y, m) ? cd(y, m, day) : null; }
  const last = daysIn(y, m), lw = cd(y, m, last).getUTCDay(); const day = last - ((lw - wd + 7) % 7) + (n + 1) * 7; return day >= 1 ? cd(y, m, day) : null;
}

// list the calendar dates an event happens on, between dtstart and `toKey`
function expandDates(ev, toKey) {
  const s = ev.start.w, start = cd(s.y, s.m, s.d), r = ev.rrule;
  if (!r) return [start];
  const freq = (r.FREQ || '').toUpperCase(), interval = Math.max(1, +r.INTERVAL || 1), count = +r.COUNT || 0;
  let untilKey = null;
  if (r.UNTIL) { const u = parseDT(r.UNTIL, {}); if (u) untilKey = u.allDay || u.mode !== 'utc' ? `${u.w.y}-${p2(u.w.m)}-${p2(u.w.d)}` : localDay(wallToDate(u.w, 'utc')); }
  const byday = (r.BYDAY || '').split(',').filter(Boolean).map(x => { const m = x.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i); return m ? { n: +(m[1] || 0), wd: DAYS.indexOf(m[2].toUpperCase()) } : null; }).filter(Boolean);
  const bymd = (r.BYMONTHDAY || '').split(',').filter(Boolean).map(Number);
  const out = []; let made = 0;
  const push = t => {
    if (t < start) return true;
    const k = cdKey(t);
    if (untilKey && k > untilKey) return false;
    if (count && made >= count) return false;
    if (k > toKey) return false;
    made++; out.push(t); return true;
  };
  for (let k = 0; k < 5000; k++) {
    let cands = [];
    if (freq === 'DAILY') cands = [new Date(start.getTime() + k * interval * 864e5)];
    else if (freq === 'WEEKLY') {
      const ws = new Date(start.getTime() - start.getUTCDay() * 864e5 + k * interval * 7 * 864e5);
      const wds = byday.length ? byday.map(b => b.wd) : [start.getUTCDay()];
      cands = [...new Set(wds)].sort().map(wd => new Date(ws.getTime() + wd * 864e5));
    } else if (freq === 'MONTHLY') {
      const mm = s.m - 1 + k * interval, y = s.y + Math.floor(mm / 12), m = (mm % 12) + 1;
      if (byday.length) cands = byday.map(b => b.n ? nthWeekday(y, m, b.n, b.wd) : null).filter(Boolean);
      if (!byday.length || byday.some(b => !b.n)) {
        if (byday.some(b => !b.n)) for (let d = 1; d <= daysIn(y, m); d++) { const t = cd(y, m, d); if (byday.some(b => !b.n && b.wd === t.getUTCDay())) cands.push(t); }
        else for (const d of bymd.length ? bymd : [s.d]) { const dd = d < 0 ? daysIn(y, m) + d + 1 : d; if (dd >= 1 && dd <= daysIn(y, m)) cands.push(cd(y, m, dd)); }
      }
      cands.sort((a, b) => a - b);
    } else if (freq === 'YEARLY') {
      const y = s.y + k * interval;
      if (s.d <= daysIn(y, s.m)) cands = [cd(y, s.m, s.d)];
    } else return [start];
    for (const t of cands) if (!push(t)) return out;
    if (cands.length && cdKey(cands[cands.length - 1]) > toKey) return out;
  }
  return out;
}

function feedEvents(text, fromKey, toKey) {
  const { calName, events } = parseIcs(text);
  const overrides = new Set(events.filter(e => e.recurId && e.uid).map(e => e.uid + '|' + occKey(e.recurId)));
  const out = [];
  for (const ev of events) {
    if (!ev.start || ev.status === 'CANCELLED') continue;
    const len = ev.end ? null : ev.duration;
    const ex = new Set(ev.exdates.map(occKey));
    for (const t of expandDates(ev, toKey)) {
      const day = cdParts(t), w = { ...ev.start.w, y: day.y, m: day.m, d: day.d };
      const occ = { allDay: ev.start.allDay, w, mode: ev.start.mode, tz: ev.start.tz };
      const key = occKey(occ);
      if (ex.has(key) || ex.has(key.slice(0, 10))) continue;
      if (!ev.recurId && ev.rrule && overrides.has(ev.uid + '|' + key)) continue;
      let item;
      if (ev.start.allDay) {
        let days = 1;
        if (ev.end && ev.end.allDay) days = Math.max(1, Math.round((cd(ev.end.w.y, ev.end.w.m, ev.end.w.d) - cd(ev.start.w.y, ev.start.w.m, ev.start.w.d)) / 864e5));
        else if (len) days = Math.max(1, Math.round(len / 864e5));
        const date = cdKey(t), endDate = cdKey(new Date(t.getTime() + (days - 1) * 864e5));
        if (endDate < fromKey) continue;
        item = { date, allDay: true }; if (endDate !== date) item.endDate = endDate;
      } else {
        const st = wallToDate(w, ev.start.mode, ev.start.tz);
        let en = null;
        if (ev.end && !ev.end.allDay) en = new Date(st.getTime() + (wallToDate(ev.end.w, ev.end.mode, ev.end.tz) - wallToDate(ev.start.w, ev.start.mode, ev.start.tz)));
        else if (len) en = new Date(st.getTime() + len);
        const date = localDay(st);
        if (date < fromKey || date > toKey) continue;
        item = { date, start: localTime(st), allDay: false };
        if (en && en > st) item.end = localTime(en);
      }
      item.id = (ev.uid || ev.title || 'ev').slice(0, 80) + '|' + key;
      item.title = ev.title || '(No title)';
      if (ev.location) item.location = ev.location;
      out.push(item);
      if (out.length > 4000) break;
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || (a.start || '').localeCompare(b.start || ''));
  return { calName, events: out };
}
function occKey(o) {
  if (o.allDay) return `${o.w.y}-${p2(o.w.m)}-${p2(o.w.d)}`;
  const d = wallToDate(o.w, o.mode, o.tz);
  return `${localDay(d)} ${localTime(d)}`;
}

const FEED_TTL = 30 * 6e4;
const feedBusy = {};
async function refreshFeed(f) {
  if (feedBusy[f.id]) return feedBusy[f.id];
  return (feedBusy[f.id] = (async () => {
    const prev = calCache[f.id] || {};
    let r = await fetchText(f.url);
    if (r.error && /^webcal:\/\//i.test(f.url.trim())) { const r2 = await fetchText(f.url.trim().replace(/^webcal:/i, 'http:')); if (r2.text) r = r2; } // a few servers only speak plain http
    const now = new Date(), from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 31), to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 200);
    let entry;
    if (r.text && /BEGIN:VCALENDAR/i.test(r.text)) {
      const { calName, events } = feedEvents(r.text, localDay(from), localDay(to));
      entry = { ok: true, at: Date.now(), tried: Date.now(), url: f.url, calName, events };
    } else {
      entry = { ok: false, error: r.text != null ? 'not-a-calendar' : r.error, tried: Date.now(), at: prev.url === f.url ? prev.at || null : null, url: f.url, calName: prev.calName || '', events: prev.url === f.url ? prev.events || [] : [] };
    }
    calCache[f.id] = entry;
    try { writeJson(CAL_FILE, calCache); } catch {}
    delete feedBusy[f.id];
    return entry;
  })());
}
const feedList = () => Object.values(db.items.feeds || {}).filter(f => !f.deleted && typeof f.url === 'string' && f.url.trim());
async function calendars(force) {
  const feeds = feedList(), ids = new Set(feeds.map(f => f.id));
  for (const id of Object.keys(calCache)) if (!ids.has(id)) delete calCache[id];
  await Promise.all(feeds.map(f => {
    const c = calCache[f.id];
    if (force || !c || c.url !== f.url || Date.now() - (c.tried || 0) > FEED_TTL) return refreshFeed(f);
  }));
  return calCache;
}

// ---------- http ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 10e6) { reject(Object.assign(new Error('Too much at once'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function sendJson(req, res, status, obj) {
  let buf = Buffer.from(JSON.stringify(obj));
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (buf.length > 1400 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    buf = zlib.gzipSync(buf); headers['Content-Encoding'] = 'gzip';
  }
  res.writeHead(status, headers);
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  // This app is private. If Tailscale Funnel (public internet) is ever switched on for it, refuse.
  if (req.headers['tailscale-funnel-request'] && process.env.ALLOW_PUBLIC !== '1') {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Meadow is private. Open it from a device signed in to your Tailscale account.');
  }
  const url = new URL(req.url, 'http://x');
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { p = '/'; }
  try {
    if (p === '/api/ping') return sendJson(req, res, 200, { ok: true, app: 'meadow', rev: db.rev });
    if (p === '/api/links' && req.method === 'GET') return sendJson(req, res, 200, await links(url.searchParams.has('force')));
    if (p === '/api/calendars' && req.method === 'GET') return sendJson(req, res, 200, await calendars(url.searchParams.has('force')));
    if (p === '/api/sync' && req.method === 'POST') return sendJson(req, res, 200, sync(await readBody(req)));
    if (p === '/api/export' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="meadow-backup.json"' });
      return res.end(JSON.stringify(db, null, 2));
    }
    if (p.startsWith('/api/')) return sendJson(req, res, 404, { error: 'Not found' });

    const file = path.normalize(path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(file);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    if (p === '/sw.js') headers['Service-Worker-Allowed'] = '/';
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (!e.status) console.error(e);
    sendJson(req, res, e.status || 500, { error: e.message || 'Server error' });
  }
});

load();
setInterval(prune, 864e5);
// keep the other apps and calendars fresh in the background, so your phone always gets recent info
setInterval(() => links(true).catch(() => {}), 60000);
setInterval(() => calendars(false).catch(() => {}), 5 * 6e4);
setTimeout(() => { links(true).catch(() => {}); calendars(false).catch(() => {}); }, 1500);
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log(`\n  Meadow is already running. Open http://localhost:${PORT}\n`);
    process.exit(2);
  }
  throw e;
});
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  🌱 Meadow is running!\n');
  console.log(`  On this computer:  http://localhost:${PORT}`);
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) console.log(`  Same Wi-Fi:        http://${a.address}:${PORT}   (${name})`);
  }
  require('child_process').execFile('tailscale', ['status', '--json'], { timeout: 4000, windowsHide: true }, (err, out) => {
    let host = null;
    try { host = JSON.parse(out).Self.DNSName.replace(/\.$/, ''); } catch {}
    if (host) console.log(`\n  On your iPhone:    https://${host}:${TS_PORT}   (needs the Tailscale app, same account)`);
    else console.log('\n  (Tailscale not found, so the app is only reachable on this PC and your Wi-Fi.)');
    console.log('\n  Data is saved in data\\life.json\n');
  });
});
