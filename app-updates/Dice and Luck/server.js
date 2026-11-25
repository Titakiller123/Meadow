'use strict';
// Dice and Luck v2: self-hosted tabletop campaign site. No dependencies. Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os'), zlib = require('zlib');
const SYSTEMS = require('./systems.js');
const PORT = process.env.PORT || 3000, DIR = __dirname, DD = process.env.DATA_DIR || path.join(DIR, 'data');
const DATA = path.join(DD, 'data.json'), UP = path.join(DD, 'uploads');
fs.mkdirSync(UP, { recursive: true });

// Version 1 kept data next to the code. Move it into the data folder once.
if (!process.env.DATA_DIR) {
  try {
    const old = path.join(DIR, 'data.json');
    if (fs.existsSync(old) && !fs.existsSync(DATA)) { fs.renameSync(old, DATA); console.log('Moved your existing data into the data folder.'); }
    const ou = path.join(DIR, 'uploads');
    if (fs.existsSync(ou)) for (const f of fs.readdirSync(ou)) fs.renameSync(path.join(ou, f), path.join(UP, f));
  } catch (e) { console.log('Could not move old data:', e.message); }
}

class E extends Error { constructor(c, m) { super(m); this.c = c; } }
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const str = (s, n) => String(s ?? '').slice(0, n);
const obj = x => (x && typeof x === 'object' && !Array.isArray(x)) ? x : {};
const uid = () => crypto.randomBytes(5).toString('hex'), code = () => crypto.randomBytes(3).toString('hex');
const THEMES = ['grimoire', 'wartable', 'arcane', 'dungeon', 'plain'];
const newCamp = (name, owner, system) => ({ id: uid(), name: str(name, 80) || 'New campaign', owner, system: has(SYSTEMS, system) && SYSTEMS[system].id ? system : 'dnd5e', joinCode: code(), members: [owner], chat: [],
  arc: { title: '', summary: '' }, maps: [], dmData: { sections: [{ id: uid(), title: 'Session prep', body: '' }], theme: 'grimoire' },
  book: { title: system === 'coc' ? 'Case Journal' : system === 'alien' ? 'Mission Log' : system === 'mothership' ? 'Ship’s Log' : system === 'lancer' ? 'Campaign Log' : 'Tome of Tales', chapters: [] }, init: { on: false, round: 1, turn: 0, dir: system === 'alien' ? 'low' : 'high', list: [] }, rolls: [], bounties: [], npcs: [], feed: [], scene: {}, arcsV: 1, created: Date.now() });

function migrate(old) {
  const D = { v: 2, users: {}, sessions: {}, camps: {}, chars: {}, notebooks: {} };
  for (const [n, u] of Object.entries(old.users || {})) D.users[n] = { salt: u.salt, h: u.h, canDM: u.role === 'dm' };
  const dm = Object.keys(D.users).find(n => D.users[n].canDM);
  if (dm) {
    const c = newCamp('My campaign', dm);
    c.joinCode = old.joinCode || c.joinCode; c.members = Object.keys(D.users);
    c.arc = old.arc || c.arc; c.maps = old.maps || [];
    if (old.dm && old.dm.sections) c.dmData.sections = old.dm.sections;
    D.camps[c.id] = c;
    for (const [owner, data] of Object.entries(old.chars || {})) { const id = uid(); D.chars[id] = { id, camp: c.id, owner, status: 'active', data, ts: Date.now() }; }
    console.log('Upgraded your campaign data to the new format.');
  }
  return D;
}
let D = { v: 2, users: {}, sessions: {}, camps: {}, chars: {}, notebooks: {} };
try {
  const tmp = DATA + '.tmp';
  if (fs.existsSync(tmp)) {
    const newer = !fs.existsSync(DATA) || fs.statSync(tmp).mtimeMs > fs.statSync(DATA).mtimeMs;
    let ok = false; try { JSON.parse(fs.readFileSync(tmp, 'utf8')); ok = true; } catch {}
    if (newer && ok) { if (fs.existsSync(DATA)) fs.copyFileSync(DATA, path.join(DD, 'data.before-recovery.json')); fs.copyFileSync(tmp, DATA); console.log('Recovered your latest changes from data.json.tmp.'); }
    try { fs.unlinkSync(tmp); } catch {}
  }
} catch (e) { console.log('Could not check data.json.tmp:', e.message); }
if (fs.existsSync(DATA)) {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    fs.copyFileSync(DATA, path.join(DD, 'data.backup.json'));
    D = raw.v === 2 ? { ...D, ...raw } : migrate(raw);
  } catch (e) {
    const b = path.join(DD, 'data.broken-' + Date.now() + '.json'); fs.copyFileSync(DATA, b);
    console.log('data.json could not be read. A copy was saved as ' + b + ' and a fresh start was made.');
  }
}
// bring older campaigns up to date: story arcs live in the Tome, plus bounties, NPCs and the news feed
for (const c of Object.values(D.camps)) {
  c.bounties = c.bounties || []; c.npcs = c.npcs || []; c.npcFolders = c.npcFolders || []; c.chat = c.chat || []; c.feed = c.feed || []; c.scene = c.scene || {};
  if (!c.arcsV) {
    c.arcsV = 1;
    for (const ch of c.book.chapters) { ch.status = 'past'; ch.summary = ch.summary || ''; }
    if (c.arc && c.arc.title) c.book.chapters.push({ id: uid(), title: c.arc.title, summary: c.arc.summary || '', status: 'current', by: c.owner, ts: Date.now(), pages: [] });
  }
}
let timer;
// Saving. On Windows (and in OneDrive folders) the swap can be blocked for a moment while
// another program reads the file. Never crash on that: try a few ways, then try again shortly.
let saveFails = 0, retryT = null;
const flush = () => {
  const json = JSON.stringify(D), tmp = DATA + '.tmp';
  try { fs.writeFileSync(tmp, json); } catch (e) { return saveLater(e); }
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(tmp, DATA); return saved(); } catch (e) { if (i === 4) break; const t = Date.now() + 40; while (Date.now() < t); }
  }
  try { fs.copyFileSync(tmp, DATA); try { fs.unlinkSync(tmp); } catch {} return saved(); } catch (e) { return saveLater(e); }
};
function saved() { if (saveFails) console.log('Saving works again.'); saveFails = 0; return true; }
function saveLater(e) {
  if (++saveFails === 1) console.log('Could not save just now (' + (e.code || e.message) + '). Trying again... Your changes are kept in data.json.tmp meanwhile.');
  clearTimeout(retryT); retryT = setTimeout(flush, Math.min(5000, 300 * saveFails)); return false;
}
let HUB = null;
const save = () => { clearTimeout(timer); timer = setTimeout(flush, 200); if (HUB) HUB.poke(); };
process.on('uncaughtException', e => {
  if (e && (e.code === 'EADDRINUSE' || e.syscall === 'listen')) { console.log('Port ' + PORT + ' is already in use. Dice and Luck is probably already running in another window.'); process.exit(1); }
  console.log('Something went wrong, but Dice and Luck keeps running:', e && e.stack || e);
});
process.on('SIGINT', () => { flush(); process.exit(); });
process.on('SIGTERM', () => { flush(); process.exit(); });

const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, h: crypto.scryptSync(pw, salt, 32).toString('hex') });
// Compact replies: JSON is gzipped when the browser accepts it, and a GET answer that hasn't changed since
// the browser's last copy gets a tiny "304 Not modified" instead (players poll /state every 5 seconds).
const gzOk = req => !!req && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
const J = (res, code, o) => {
  const req = res.req, txt = JSON.stringify(o), h = { 'Content-Type': 'application/json' };
  if (req && req.method === 'GET' && code === 200) {
    const tag = 'W/"' + crypto.createHash('sha1').update(txt).digest('base64').slice(0, 22) + '"';
    h.ETag = tag; h['Cache-Control'] = 'private, no-cache';
    if (req.headers['if-none-match'] === tag) { res.writeHead(304, h); return res.end(); }
  }
  if (txt.length > 1400 && gzOk(req)) { h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding'; res.writeHead(code, h); return res.end(zlib.gzipSync(txt, { level: 6 })); }
  res.writeHead(code, h); res.end(txt);
};
async function body(req, lim = 2e6) {
  let n = 0; const c = [];
  for await (const x of req) { n += x.length; if (n > lim) throw new E(413, 'That is too large to save.'); c.push(x); }
  if (!c.length) return {};
  try { return obj(JSON.parse(Buffer.concat(c))); } catch { throw new E(400, 'Bad data.'); }
}
const fails = {};
const tooMany = ip => (fails[ip] = (fails[ip] || []).filter(t => t > Date.now() - 600000)).length >= 10;
const bad = ip => (fails[ip] = fails[ip] || []).push(Date.now());
let VERC = null, VERT = 0;
const ver = () => { if (VERC && Date.now() - VERT < 3000) return VERC; VERT = Date.now(); return (VERC = verNow()); };
const verNow = () => ['index.html', 'app.js', 'style.css', 'server.js', 'systems.js', 'hubserver.js', 'forgeserver.js', 'forge.html', 'forge.js', 'hub.html', 'hub.js', 'hub.css', 'tv.html', 'tv.js', 'schedule.html', 'schedule.js', 'dgdraw.js', 'dungeon.js', 'dungeonserver.js', 'gameui.js', 'quickbar.js', 'mapmarks.js', 'supplies.js', 'items.json', 'bulk.js', 'terminal.html', 'terminal.js', 'terminalserver.js', 'termhub.js'].map(f => { try { return fs.statSync(path.join(DIR, f)).mtimeMs | 0; } catch { return 0; } }).join('-');
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/systems.js': ['systems.js', 'text/javascript; charset=utf-8'],
  '/hub': ['hub.html', 'text/html; charset=utf-8'], '/hub.js': ['hub.js', 'text/javascript; charset=utf-8'], '/hub.css': ['hub.css', 'text/css; charset=utf-8'], '/tv.js': ['tv.js', 'text/javascript; charset=utf-8'], '/weather.js': ['weather.js', 'text/javascript; charset=utf-8'], '/board.js': ['board.js', 'text/javascript; charset=utf-8'], '/dgdraw.js': ['dgdraw.js', 'text/javascript; charset=utf-8'], '/dungeon.js': ['dungeon.js', 'text/javascript; charset=utf-8'], '/gameui.js': ['gameui.js', 'text/javascript; charset=utf-8'], '/quickbar.js': ['quickbar.js', 'text/javascript; charset=utf-8'], '/mapmarks.js': ['mapmarks.js', 'text/javascript; charset=utf-8'], '/supplies.js': ['supplies.js', 'text/javascript; charset=utf-8'], '/bulk.js': ['bulk.js', 'text/javascript; charset=utf-8'], '/items.json': ['items.json', 'application/json; charset=utf-8'],
  '/modules': ['module.html', 'text/html; charset=utf-8'], '/module.js': ['module.js', 'text/javascript; charset=utf-8'],
  '/forge': ['forge.html', 'text/html; charset=utf-8'], '/forge.js': ['forge.js', 'text/javascript; charset=utf-8'],
  '/schedule': ['schedule.html', 'text/html; charset=utf-8'], '/schedule.js': ['schedule.js', 'text/javascript; charset=utf-8'],
  '/terminal': ['terminal.html', 'text/html; charset=utf-8'], '/terminal.js': ['terminal.js', 'text/javascript; charset=utf-8'], '/termhub.js': ['termhub.js', 'text/javascript; charset=utf-8'],
  '/spells.json': ['spells.json', 'application/json; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'], '/monsters.json': ['monsters.json', 'application/json; charset=utf-8'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'], '/icon-maskable.png': ['icon-maskable.png', 'image/png'] };
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.weba': 'audio/webm' };
// Program files (pages, scripts, styles, spell and monster lists): kept in memory, gzipped once, and
// answered with "304 Not modified" when the browser already has this version. Re-read when the file changes.
const SCACHE = {};
function sendStatic(req, res, f, type) {
  const fp = path.join(DIR, f), st = fs.statSync(fp), key = st.mtimeMs + ':' + st.size;
  let c = SCACHE[f];
  if (!c || c.key !== key) {
    const raw = fs.readFileSync(fp), zip = /^(text|application\/(json|javascript|manifest))/.test(type);
    c = SCACHE[f] = { key, raw, gz: zip ? zlib.gzipSync(raw, { level: 9 }) : null, tag: 'W/"' + crypto.createHash('sha1').update(raw).digest('base64').slice(0, 22) + '"' };
  }
  const h = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: c.tag, Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === c.tag) { res.writeHead(304, h); return res.end(); }
  if (c.gz && gzOk(req)) { res.writeHead(200, { ...h, 'Content-Encoding': 'gzip', 'Content-Length': c.gz.length }); return res.end(c.gz); }
  res.writeHead(200, { ...h, 'Content-Length': c.raw.length }); return res.end(c.raw);
}
function sendFile(req, res, f) { // pictures, video and sound, with byte ranges so video and audio can seek
  if (!fs.existsSync(f)) throw new E(404, 'Not found');
  const size = fs.statSync(f).size, h = { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': res.getHeader('Cache-Control') || 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' };
  const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (rg && (rg[1] || rg[2])) {
    let a = rg[1] === '' ? Math.max(0, size - +rg[2]) : +rg[1], z = rg[1] === '' || rg[2] === '' ? size - 1 : Math.min(+rg[2], size - 1);
    if (a > z || a >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...h, 'Content-Range': `bytes ${a}-${z}/${size}`, 'Content-Length': z - a + 1 }); return fs.createReadStream(f, { start: a, end: z }).pipe(res);
  }
  res.writeHead(200, { ...h, 'Content-Length': size }); return fs.createReadStream(f).pipe(res);
}

function saveImage(dataUrl, max) {
  const k = /^data:image\/(png|jpeg|webp|gif);base64,/.exec(dataUrl || '');
  if (!k) throw new E(400, 'Upload a PNG, JPEG, WebP or GIF image.');
  const buf = Buffer.from(dataUrl.slice(k[0].length), 'base64');
  if (buf.length > max) throw new E(413, 'That image is too large.');
  const file = uid() + (k[1] === 'jpeg' ? '.jpg' : '.' + k[1]);
  fs.writeFileSync(path.join(UP, file), buf); return file;
}
function gc() { // remove uploaded images nothing refers to any more (keeps files from the last 2 hours)
  try {
    const ref = JSON.stringify(D), cut = Date.now() - 2 * 3600e3;
    for (const f of fs.readdirSync(UP)) { const fp = path.join(UP, f); if (!ref.includes(f) && fs.statSync(fp).mtimeMs < cut) fs.unlinkSync(fp); }
  } catch {}
}

function startSession(res, name, secure) {
  const t = crypto.randomBytes(24).toString('hex');
  D.sessions[t] = { u: name }; save();
  res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`);
  J(res, 200, { ok: true });
}
const mineCamps = n => Object.values(D.camps).filter(c => c.owner === n || c.members.includes(n)).map(c => ({ id: c.id, name: c.name, role: c.owner === n ? 'dm' : 'player' }));

// What a player may reveal to the table. Identity (name, class, species, level, portrait) is always visible.
const SHARE = { abil: ['ab'], vit: ['hp', 'hpmax', 'thp', 'ac', 'speed', 'hdLeft', 'dsS', 'dsF', 'insp', 'exh'], sk: ['saves', 'skills'], wep: ['weapons'],
  spell: ['sAb', 'spells', 'slots'], feat: ['abil'], items: ['items'], eq: ['coins', 'gear', 'supplies'], lang: ['langs', 'profs'], bio: ['bio'] };
const IDF = ['name', 'species', 'cls', 'sub', 'mc', 'lvl', 'align', 'bg', 'feat', 'portrait', 'frame', 'atlas']; // atlas: who holds the Cartographer's maps
function pub(d, sys) { // the part of a sheet other players may see
  const sm = sys && sys !== 'dnd5e' ? SYSTEMS.shareMap(sys) : null, SH = sm || SHARE, ID = sm ? SYSTEMS.identityKeys(sys) : IDF;
  const sh = obj(d.share), o = {}; for (const k of ID) if (d[k] !== undefined) o[k] = d[k];
  for (const s of Object.keys(SH)) if (sh[s] === true) for (const k of SH[s]) if (d[k] !== undefined) o[k] = d[k];
  o.share = Object.fromEntries(Object.keys(SH).filter(s => sh[s] === true).map(s => [s, true])); return o;
}
const curArc = camp => camp.book.chapters.find(c => c.status === 'current') || null;
const syncArc = camp => { const a = curArc(camp); camp.arc = a ? { title: a.title, summary: a.summary || '' } : { title: '', summary: '' }; };
function notify(camp, by, type, text, ref) {
  camp.feed.push({ id: uid(), ts: Date.now(), by, type, text: str(text, 160), ref: ref || {} });
  if (camp.feed.length > 60) camp.feed = camp.feed.slice(-60);
}
const NPC_ATT = ['unknown', 'ally', 'friendly', 'neutral', 'wary', 'hostile'], NPC_ST = ['alive', 'dead', 'past', 'missing', 'unknown'], B_ST = ['open', 'active', 'done', 'failed'];
const goodFile = f => /^[\w-]+\.(png|jpg|webp|gif)$/.test(f || '') && fs.existsSync(path.join(UP, f)) ? f : '';
const cleanObjs = a => (Array.isArray(a) ? a : []).slice(0, 30).map(o => ({ id: str(obj(o).id, 20) || uid(), t: str(o.t, 200), done: o.done === true })).filter(o => o.t.trim());
// ---- world map (hex grid) ----
const TERR = { plains: 1, road: .5, forest: 2, hills: 2, mountain: 3, swamp: 3, desert: 2, water: null, blocked: null };
const NB = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const hexPx = (g, q, r) => g.orient === 'flat' ? { x: g.ox + 1.5 * g.size * q, y: g.oy + Math.sqrt(3) * g.size * (r + q / 2) } : { x: g.ox + Math.sqrt(3) * g.size * (q + r / 2), y: g.oy + 1.5 * g.size * r };
function pxHex(g, x, y) {
  x -= g.ox; y -= g.oy; let q, r;
  if (g.orient === 'flat') { q = 2 / 3 * x / g.size; r = (-1 / 3 * x + Math.sqrt(3) / 3 * y) / g.size; }
  else { q = (Math.sqrt(3) / 3 * x - 1 / 3 * y) / g.size; r = 2 / 3 * y / g.size; }
  let cx = q, cz = r, cy = -cx - cz, rx = Math.round(cx), ry = Math.round(cy), rz = Math.round(cz);
  const dx = Math.abs(rx - cx), dy = Math.abs(ry - cy), dz = Math.abs(rz - cz);
  if (dx > dy && dx > dz) rx = -ry - rz; else if (dy > dz) ry = -rx - rz; else rz = -rx - ry;
  return { q: rx, r: rz };
}
const newWorld = (file, w, h) => { const size = Math.max(12, Math.round(w / 32)); const g = { size, orient: 'pointy', ox: 0, oy: 0 };
  return { file, w, h, grid: g, party: pxHex(g, w / 2, h / 2), hexes: {}, requests: [], move: null, days: 0, hexDays: 1, log: [] }; };
const terrOf = (W, q, r) => (obj(W.hexes[q + ',' + r]).t) || 'plains';
function checkPath(W, path, free) { // each step must touch the one before; returns the days it takes
  if (!Array.isArray(path) || !path.length || path.length > 400) throw new E(400, 'That route isn’t valid.');
  let cur = W.party, cost = 0; const out = [];
  for (const s of path) {
    const q = Math.round(+obj(s).q), r = Math.round(+obj(s).r);
    if (!Number.isFinite(q) || !Number.isFinite(r) || Math.abs(q) > 3000 || Math.abs(r) > 3000) throw new E(400, 'That route isn’t valid.');
    if (!NB.some(d => cur.q + d[0] === q && cur.r + d[1] === r)) throw new E(400, 'Each step has to touch the one before it.');
    const c = TERR[terrOf(W, q, r)];
    if (c === null && !free) throw new E(400, 'That route crosses ground nobody can travel over.');
    cost += c === null ? 1 : c; cur = { q, r }; out.push(cur);
  }
  return { path: out, days: Math.round(cost * (W.hexDays || 1) * 100) / 100 };
}
const hexName = (W, h) => obj(W.hexes[h.q + ',' + h.r]).name || 'a new hex';
// ---- Worlds: campaigns of the same DM grouped under one world (camp.world = { id, name }) ----
// A person met by several of the world's parties is one LINKED person: each campaign keeps its own Who's Who copy
// (secret = not met yet, attitude, status and folders stay per party) and copies with the same `wid` keep these fields in sync:
const WSYNC = ['name', 'role', 'race', 'where', 'faction', 'portrait', 'notes', 'dmNotes'];
const worldCamps = camp => camp && camp.world && camp.world.id ? Object.values(D.camps).filter(c => c.world && c.world.id === camp.world.id && c.owner === camp.owner) : (camp ? [camp] : []);
function npcSync(camp, o) {
  if (!o || !o.wid || !camp.world) return 0; let n = 0;
  for (const c of worldCamps(camp)) { if (c === camp) continue; for (const x of c.npcs || []) if (x.wid === o.wid && x !== o) { WSYNC.forEach(k => { x[k] = o[k]; }); x.ts = Date.now(); n++; } }
  return n;
}
function view(camp, me) {
  const dm = camp.owner === me.name, members = camp.members.filter(u => has(D.users, u));
  const all = Object.values(D.chars).filter(c => c.camp === camp.id && members.includes(c.owner));
  const sum = c => { const open = dm || c.owner === me.name || obj(c.data.share).vit === true;
    return { id: c.id, owner: c.owner, status: c.status, name: c.data.name, cls: c.data.cls, sub: c.data.sub, mc: Array.isArray(c.data.mc) ? c.data.mc : [], species: c.data.species,
    lvl: c.data.lvl, hp: open ? c.data.hp : null, hpmax: open ? c.data.hpmax : null, ac: open ? c.data.ac : null, portrait: c.data.portrait || '', frame: str(c.data.frame, 20) }; };

  const out = { ver: ver(), me: { name: me.name, canDM: me.canDM, role: dm ? 'dm' : 'player' }, camp: { id: camp.id, name: camp.name, owner: camp.owner, system: camp.system || 'dnd5e' },
    arc: camp.arc, party: all.filter(c => c.status === 'active').map(sum), fallen: all.filter(c => c.status !== 'active').map(sum),
    maps: camp.maps.map(m => ({ ...m, marks: (m.marks || []).filter(k => k.vis === 'all' || k.by === me.name), pins: m.pins.filter(p => dm || !p.secret),
      areas: (m.areas || []).filter(a => dm || a.vis === 'all' || (a.vis === 'some' && (a.who || []).includes(me.name))).map(a => dm ? a : { id: a.id, name: a.name, note: a.note, x: a.x, y: a.y, w: a.w, h: a.h, vis: a.vis, going: a.going || [] }) })),
    chars: Object.fromEntries(all.map(c => (dm || c.owner === me.name) ? [c.id, { id: c.id, owner: c.owner, status: c.status, data: c.data, ts: c.ts || 0 }]
      : [c.id, { id: c.id, owner: c.owner, status: c.status, data: pub(c.data, camp.system), view: true }])),
    clock: (obj(camp.clock).ev || []).slice(-60), scene: camp.scene || {}, world: camp.world || null, init: initView(camp.init || { on: false, round: 1, turn: 0, dir: 'high', list: [] }, dm), book: camp.book, feed: camp.feed.slice(-30), seen: obj(obj(D.users[me.name]).seen)[camp.id] || 0,
    bounties: camp.bounties.filter(b => (dm || !b.secret) && (!b.draft || b.by === me.name)), // drafts: only the writer sees them
    npcFolders: camp.npcFolders || [],
    lore: (camp.lore || []).filter(l => dm || !l.to.length || l.to.includes(me.name)).map(l => dm ? l : { id: l.id, title: l.title, text: l.text, ts: l.ts }),
    npcs: camp.npcs.filter(n => dm || !n.secret).map(n => dm ? n : { ...n, dmNotes: undefined, wid: undefined }), notebook: D.notebooks[camp.id + '|' + me.name] || { chapters: [], ts: 0 },
    rolls: camp.rolls.filter(r => dm || !r.hidden).slice(-40),
    chat: (camp.chat || []).filter(x => !x.to.length || x.by === me.name || x.to.includes(me.name)).slice(-200),
    chatSeen: obj(obj(D.users[me.name]).chatSeen)[camp.id] || 0, members, giphy: camp.giphy || '', propArt: camp.propArt || {},
    // what the TV is showing, for the blurred background behind everyone's screen
    tvArt: (L => L.tvbg !== false && L.art && L.art.file ? { file: L.art.file, kind: L.art.kind === 'video' ? 'video' : 'image' } : null)(obj(obj(camp.hub).live)) };
  out.dungeons = DUNG.view(camp, me, dm);
  if (dm) { // the world this campaign belongs to, and for linked people the other parties that have them
    out.world = camp.world || null;
    if (camp.world) { const w = {}; for (const c of worldCamps(camp)) if (c !== camp) for (const x of c.npcs || []) if (x.wid) (w[x.wid] = w[x.wid] || []).push({ camp: c.name, met: !x.secret });
      out.npcWorld = Object.fromEntries(camp.npcs.filter(n => n.wid && w[n.wid]).map(n => [n.id, w[n.wid]])); }
  }
  if (dm) out.modules = (camp.modules || []).map(mo => ({ id: mo.id, title: mo.title, summary: mo.summary || '', ts: mo.ts, chapters: mo.chapters.length, done: mo.chapters.filter(c => c.done).length }));
  if (dm) { out.tvChat = { pin: (obj(obj(obj(camp.hub).live).chatPin).id) || '', mode: obj(obj(camp.hub).live).chatTV || 'off', board: obj(obj(obj(camp.hub).live).reveal).kind === 'board', job: obj(obj(obj(obj(camp.hub).live).reveal).job).id || '' }; out.dm = camp.dmData; out.joinCode = camp.joinCode; out.players = members.filter(u => u !== camp.owner); }
  return out;
}
function initView(I, dm) {
  if (dm) return I;
  return { ...I, list: (I.list || []).map(e => ({ id: e.id, name: e.hid ? '???' : e.name, init: e.init, owner: e.owner, npc: e.npc, kind: e.kind || (e.npc ? 'npc' : 'pc'), hid: !!e.hid,
    hs: e.hpmax ? (e.hp <= 0 ? 'down' : e.hp * 2 <= e.hpmax ? 'bloodied' : '') : '' })) };
}
const cleanNB = b => ({ chapters: (Array.isArray(b.chapters) ? b.chapters : []).slice(0, 60).map(c => ({ id: str(obj(c).id, 20) || uid(), title: str(c.title, 100),
  pages: (Array.isArray(c.pages) ? c.pages : []).slice(0, 100).map(p => ({ id: str(obj(p).id, 20) || uid(), title: str(p.title, 100), body: str(p.body, 100000), imgs: (Array.isArray(p.imgs) ? p.imgs : []).slice(0, 60).map(f => goodFile(str(f, 60))).filter(Boolean),
  sent: (Array.isArray(p.sent) ? p.sent : []).slice(0, 10).map(x => ({ a: str(obj(x).a, 20), p: str(obj(x).p, 20) })) })) })),
  // the player's own lore notes, and their private notes on each quest (by bounty id)
  lore: (Array.isArray(b.lore) ? b.lore : []).slice(0, 200).map(x => ({ id: str(obj(x).id, 20) || uid(), title: str(obj(x).title, 120), text: str(obj(x).text, 20000) })),
  qnotes: Object.fromEntries(Object.entries(obj(b.qnotes)).filter(([k, v]) => /^\w{1,20}$/.test(k) && typeof v === 'string' && v.trim()).slice(0, 400).map(([k, v]) => [k, str(v, 10000)])),
  // the player's own map collection: sketches, uploaded pictures and copies of the DM's maps
  maps: (Array.isArray(b.maps) ? b.maps : []).slice(0, 200).map(x => ({ id: str(obj(x).id, 20) || uid(), title: str(obj(x).title, 120), where: str(obj(x).where, 120), note: str(obj(x).note, 5000),
    file: goodFile(str(obj(x).file, 60)), kind: ['sketch', 'picture', 'copy'].includes(obj(x).kind) ? x.kind : 'picture', ts: Math.round(+obj(x).ts) || Date.now() })).filter(x => x.file) });

// the party's clock: "time passes" events (DM button, world travel). Each player's app burns their lit lights and eats rations once per event.
function tick(camp, mins, days, why) {
  const c = camp.clock = obj(camp.clock); c.ev = Array.isArray(c.ev) ? c.ev : [];
  const e = { id: uid(), ts: Math.max(Date.now(), ((c.ev[c.ev.length - 1] || {}).ts || 0) + 1), mins: Math.max(0, Math.round(+mins || 0)), days: Math.max(0, +days || 0), why: str(why, 40) };
  c.ev = [...c.ev, e].slice(-60); return e;
}
async function campRoute(req, res, m, rest, me, camp, dm) {
  const need = () => { if (!dm) throw new E(403, 'DM only.'); };
  const ok = () => J(res, 200, { ok: true });
  let r;
  if (rest.startsWith('/hub')) return HUB.campRoute(req, res, m, rest, me, camp, dm);
  if (rest.startsWith('/sched')) return HUB.schedRoute(req, res, m, rest, me, camp, dm);
  if (rest.startsWith('/dungeons') || rest === '/mapcopy') return DUNG.route(req, res, m, rest, me, camp, dm);
  if (rest === '/term' || rest.startsWith('/term/')) return TERM.route(req, res, m, rest, me, camp, dm);
  if (rest === '/state' && m === 'GET') return J(res, 200, view(camp, me));
  if (rest === '/' && m === 'PUT') {
    need(); const b = await body(req);
    if (b.name !== undefined) camp.name = str(b.name, 80).trim() || camp.name;
    if (b.bookTitle !== undefined) camp.book.title = str(b.bookTitle, 80).trim() || 'Tome of Tales';
    save(); return ok();
  }
  if (rest === '/' && m === 'DELETE') {
    need(); delete D.camps[camp.id];
    for (const id of Object.keys(D.chars)) if (D.chars[id].camp === camp.id) delete D.chars[id];
    for (const k of Object.keys(D.notebooks)) if (k.startsWith(camp.id + '|')) delete D.notebooks[k];
    for (const mp of camp.maps) try { fs.unlinkSync(path.join(UP, mp.file)); } catch {}
    save(); return ok();
  }
  if (rest === '/arc' && m === 'PUT') {
    need(); const b = await body(req); let a = curArc(camp);
    if (!a) { a = { id: uid(), title: '', summary: '', status: 'current', by: me.name, ts: Date.now(), pages: [] }; camp.book.chapters.push(a); }
    a.title = str(b.title, 200); a.summary = str(b.summary, 5000); syncArc(camp); save(); return ok();
  }
  // chat: messages and pictures for everyone, or only for chosen people
  if (rest === '/chat' && m === 'POST') {
    camp.chat = camp.chat || [];
    const b = await body(req), text = str(b.text, 2000).trim(), img = goodFile(str(b.img, 60)), url = /^https:\/\/[^\s"'<>]{8,480}$/.test(str(b.url, 500)) ? str(b.url, 500) : '';
    if (!text && !img && !url) throw new E(400, 'Write something or add a picture.');
    const to = [...new Set((Array.isArray(b.to) ? b.to : []).map(x => str(x, 20)))].filter(u => u !== me.name && camp.members.includes(u)).slice(0, 20);
    const msg = { id: uid(), ts: Date.now(), by: me.name, to, text, img, url };
    camp.chat.push(msg); if (camp.chat.length > 500) camp.chat.splice(0, camp.chat.length - 500);
    save(); return J(res, 200, { id: msg.id });
  }
  if (rest === '/chat/giphy' && m === 'PUT') { need(); const b = await body(req); camp.giphy = str(b.key, 80).trim().replace(/[^\w-]/g, ''); save(); return ok(); }
  if (rest === '/chat/seen' && m === 'POST') { const u = D.users[me.name]; u.chatSeen = { ...obj(u.chatSeen), [camp.id]: Date.now() }; save(); return ok(); }
  // reactions: tap an emoji to add or take back your reaction
  if ((r = rest.match(/^\/chat\/(\w+)\/react$/)) && m === 'POST') {
    const x = (camp.chat || []).find(y => y.id === r[1]); if (!x || (x.to.length && x.by !== me.name && !x.to.includes(me.name))) throw new E(404, 'No such message.');
    const b = await body(req), e = str(b.e, 16).trim();
    if (!e || /[\w\s<>&"'`]/.test(e)) throw new E(400, 'Pick an emoji.');
    const re = x.re = obj(x.re), who = Array.isArray(re[e]) ? re[e] : [];
    if (who.includes(me.name)) re[e] = who.filter(n => n !== me.name); else { if (!re[e] && Object.keys(re).length >= 20) throw new E(400, 'That message has enough reactions.'); re[e] = [...who, me.name]; }
    if (!re[e].length) delete re[e];
    save(); return J(res, 200, { re });
  }
  if ((r = rest.match(/^\/chat\/(\w+)$/)) && m === 'DELETE') {
    const x = (camp.chat || []).find(y => y.id === r[1]); if (!x || (x.to.length && x.by !== me.name && !x.to.includes(me.name))) throw new E(404, 'No such message.');
    if (x.by !== me.name && !dm) throw new E(403, 'Only who wrote it or the DM can remove a message.');
    camp.chat = camp.chat.filter(y => y !== x); save(); return ok();
  }
  if (rest === '/seen' && m === 'POST') { const u = D.users[me.name]; u.seen = { ...obj(u.seen), [camp.id]: Date.now() }; save(); return ok(); }
  if (rest === '/dm' && m === 'PUT') {
    need(); const b = await body(req, 3e6);
    camp.dmData.sections = (Array.isArray(b.sections) ? b.sections : []).slice(0, 50).map(x => ({ id: str(obj(x).id, 20) || uid(), title: str(x.title, 100), body: str(x.body, 20000) }));
    if (THEMES.includes(b.theme)) camp.dmData.theme = b.theme;
    save(); return ok();
  }
  if (rest === '/joincode' && m === 'POST') { need(); camp.joinCode = code(); save(); return ok(); }
  if ((r = rest.match(/^\/players\/([a-z0-9_]+)(\/password)?$/))) {
    need();
    if (!camp.members.includes(r[1]) || r[1] === camp.owner) throw new E(404, 'No such player.');
    if (m === 'PUT' && r[2]) {
      const b = await body(req);
      if (str(b.password, 200).length < 8) throw new E(400, 'Password needs at least 8 characters.');
      Object.assign(D.users[r[1]], hash(b.password));
      for (const t of Object.keys(D.sessions)) if (D.sessions[t].u === r[1]) delete D.sessions[t];
      save(); return ok();
    }
    if (m === 'DELETE' && !r[2]) { camp.members = camp.members.filter(u => u !== r[1]); save(); return ok(); }
  }
  // characters
  const chr = id => (has(D.chars, id) && D.chars[id].camp === camp.id) ? D.chars[id] : null;
  const mayEdit = c => { if (!c) throw new E(404, 'No such character.'); if (c.owner !== me.name && !dm) throw new E(403, 'That isn’t your character.'); };
  if (rest === '/chars' && m === 'POST') {
    const b = await body(req, 3e6), owner = b.owner ? str(b.owner, 20) : me.name;
    if (owner !== me.name) { need(); if (!camp.members.includes(owner) || owner === camp.owner) throw new E(404, 'No such player.'); }
    if (owner === camp.owner) throw new E(400, 'The DM doesn’t use a character sheet.');
    const id = uid(); D.chars[id] = { id, camp: camp.id, owner, status: 'active', data: obj(b.data), ts: Date.now() };
    save(); return J(res, 200, { id });
  }
  if ((r = rest.match(/^\/chars\/(\w+)(\/status)?$/))) {
    const c = chr(r[1]); mayEdit(c);
    if (m === 'PUT' && !r[2]) { const b = await body(req, 3e6), d = obj(b.data); if (JSON.stringify(d).length > 400000) throw new E(413, 'That character is too large.');
      if (b.base !== undefined && +b.base !== (c.ts || 0)) return J(res, 409, { error: 'This sheet changed somewhere else.', data: c.data, ts: c.ts || 0 });
      c.data = d; c.ts = Math.max(Date.now(), (c.ts || 0) + 1); save(); return J(res, 200, { ok: true, ts: c.ts }); }
    if (m === 'POST' && r[2]) { const b = await body(req); if (!['active', 'fallen', 'retired'].includes(b.status)) throw new E(400, 'Bad status.'); c.status = b.status; save(); return ok(); }
    if (m === 'DELETE' && !r[2]) { delete D.chars[c.id]; save(); return ok(); }
  }
  // bounty board
  if ((r = rest.match(/^\/bounties(?:\/(\w+))?$/))) {
    const clean = (b, o) => { o.title = str(b.title, 120).trim() || o.title || 'Untitled job'; o.desc = str(b.desc, 4000); o.reward = str(b.reward, 200); o.giver = str(b.giver, 100); o.location = str(b.location, 100); o.objectives = cleanObjs(b.objectives); if (dm && b.arc !== undefined) o.arc = camp.book.chapters.some(c => c.id === b.arc) ? b.arc : ''; if (b.img !== undefined) o.img = goodFile(str(b.img, 60)); };
    if (!r[1] && m === 'POST') {
      const b = await body(req), o = { id: uid(), status: 'open', claimed: [], by: me.name, ts: Date.now(), secret: dm && b.secret === true, draft: b.draft === true }; clean(b, o); if (dm && B_ST.includes(b.status)) o.status = b.status; if (o.arc === undefined) o.arc = (curArc(camp) || {}).id || ''; camp.bounties.push(o);
      if (!o.secret && !o.draft) notify(camp, me.name, 'bounty', `${me.name} posted a job: ${o.title}`, { tab: 'bounty', id: o.id }); save(); return J(res, 200, { id: o.id });
    }
    const o = camp.bounties.find(x => x.id === r[1]); if (!o || (o.secret && !dm) || (o.draft && o.by !== me.name)) throw new E(404, 'No such job.');
    if (m === 'DELETE') { if (o.by !== me.name && !dm) throw new E(403, 'Only the poster or the DM can remove a job.'); camp.bounties = camp.bounties.filter(x => x !== o); save(); return ok(); }
    if (m === 'PUT') {
      const b = await body(req);
      if (b.op === 'claim') { o.claimed = o.claimed.includes(me.name) ? o.claimed.filter(x => x !== me.name) : [...o.claimed, me.name]; if (o.claimed.length && o.status === 'open') o.status = 'active'; else if (!o.claimed.length && o.status === 'active') o.status = 'open'; if (o.claimed.includes(me.name)) notify(camp, me.name, 'bounty', `${me.name} took the job: ${o.title}`, { tab: 'bounty', id: o.id }); }
      else if (b.op === 'obj') { const ob = o.objectives.find(x => x.id === b.id); if (ob) ob.done = b.done === true; }
      else if (b.op === 'status') { if (!B_ST.includes(b.status)) throw new E(400, 'Bad status.'); o.status = b.status; if (b.status === 'done' || b.status === 'failed') notify(camp, me.name, 'bounty', `${o.title} is ${b.status === 'done' ? 'complete' : 'failed'}`, { tab: 'bounty', id: o.id }); }
      else { if (o.by !== me.name && !dm) throw new E(403, 'Only the poster or the DM can edit the details.'); const was = o.secret || o.draft; clean(b, o); if (dm && b.secret !== undefined) o.secret = b.secret === true; if (b.draft !== undefined) o.draft = b.draft === true && o.by === me.name; if (was && !o.secret && !o.draft) notify(camp, me.name, 'bounty', `A new job appeared: ${o.title}`, { tab: 'bounty', id: o.id }); }
      save(); return ok();
    }
  }
  // lore the DM hands out: to everyone, or to chosen players (their notebook shows it)
  if ((r = rest.match(/^\/lore(?:\/(\w+))?$/))) {
    need(); camp.lore = camp.lore || [];
    const clean = (b, o) => { o.title = str(b.title, 120).trim() || o.title || 'Untitled lore'; o.text = str(b.text, 20000); o.to = (Array.isArray(b.to) ? b.to : []).map(u => str(u, 40)).filter(u => camp.members.includes(u) && u !== camp.owner).slice(0, 50); };
    if (!r[1] && m === 'POST') { const b = await body(req), o = { id: uid(), ts: Date.now() }; clean(b, o); camp.lore.push(o); if (camp.lore.length > 300) camp.lore = camp.lore.slice(-300);
      if (!o.to.length) notify(camp, me.name, 'lore', `New lore in everyone's notebook: ${o.title}`, { tab: 'notes' }); save(); return J(res, 200, { id: o.id }); }
    const o = camp.lore.find(x => x.id === r[1]); if (!o) throw new E(404, 'No such lore.');
    if (m === 'PUT') { const b = await body(req); clean(b, o); o.ts = Date.now(); save(); return ok(); }
    if (m === 'DELETE') { camp.lore = camp.lore.filter(x => x !== o); save(); return ok(); }
  }
  // NPC register
  const okFolder = f => (camp.npcFolders || []).some(x => x.id === f) || (/^c:\w+$/.test(f) && has(D.chars, f.slice(2)) && D.chars[f.slice(2)].camp === camp.id);
  const cleanFolders = a => [...new Set((Array.isArray(a) ? a : []).map(f => str(f, 30)).filter(okFolder))].slice(0, 30);
  // Who's Who folders (custom ones; every character also has an automatic folder 'c:<charId>')
  if ((r = rest.match(/^\/npcfolders(?:\/(\w+))?$/))) {
    camp.npcFolders = camp.npcFolders || [];
    if (!r[1] && m === 'POST') {
      const b = await body(req), name = str(b.name, 60).trim(); if (!name) throw new E(400, 'Give the folder a name.');
      if (camp.npcFolders.length >= 60) throw new E(400, 'That is a lot of folders. Remove one first.');
      const f = { id: uid(), name, by: me.name, ts: Date.now() }; camp.npcFolders.push(f); save(); return J(res, 200, { id: f.id });
    }
    const f = camp.npcFolders.find(x => x.id === r[1]); if (!f) throw new E(404, 'No such folder.');
    if (f.by !== me.name && !dm) throw new E(403, 'Only who made the folder or the DM can change it.');
    if (m === 'PUT') { const b = await body(req), name = str(b.name, 60).trim(); if (name) f.name = name; save(); return ok(); }
    if (m === 'DELETE') { camp.npcFolders = camp.npcFolders.filter(x => x !== f); camp.npcs.forEach(n => { if (n.folders) n.folders = n.folders.filter(x => x !== f.id); }); save(); return ok(); }
  }
  // merge two Who's Who entries that turned out to be the same person: keeps everything from both in the first one
  if ((r = rest.match(/^\/npcs\/(\w+)\/merge$/)) && m === 'POST') {
    const b = await body(req), o = camp.npcs.find(x => x.id === r[1]), src = camp.npcs.find(x => x.id === str(b.from, 20));
    if (!o || !src || (o.secret && !dm) || (src.secret && !dm)) throw new E(404, 'No such person.');
    if (o === src) throw new E(400, 'Pick two different people.');
    const oldA = o.name, oldB = src.name, nm = str(b.name, 100).trim(), keepName = nm === oldB ? oldB : (nm || oldA);
    const other = keepName === oldA ? oldB : oldA;
    const join = (x, y, n) => { x = (x || '').trim(); y = (y || '').trim(); if (/^unknown$/i.test(x)) x = ''; if (/^unknown$/i.test(y)) y = ''; if (!x) return y.slice(0, n); if (!y || x.toLowerCase() === y.toLowerCase() || x.toLowerCase().includes(y.toLowerCase())) return x.slice(0, n); const j = x + ' / ' + y; return j.length <= n ? j : x.slice(0, n); };
    const text = (x, y, n) => { x = (x || '').trim(); y = (y || '').trim(); if (!y) return x.slice(0, n); if (!x) return (`Known before as ${oldB}:\n` + y).slice(0, n); return (x + `\n\n— Known before as ${oldB} —\n` + y).slice(0, n); };
    o.role = join(o.role, src.role, 100); o.race = join(o.race, src.race, 60); o.where = join(o.where, src.where, 100); o.faction = join(o.faction, src.faction, 100);
    if ((o.attitude || 'unknown') === 'unknown') o.attitude = src.attitude || 'unknown';
    if ((o.status || 'alive') === 'unknown' || ((o.status || 'alive') === 'alive' && src.status && src.status !== 'alive' && src.status !== 'unknown')) o.status = src.status || o.status;
    const aka = `Also known as: ${other}`;
    o.notes = text(o.notes, src.notes, 6000); if (!(o.notes || '').includes(aka)) o.notes = (aka + (o.notes ? '\n\n' + o.notes : '')).slice(0, 6000);
    o.dmNotes = text(o.dmNotes, src.dmNotes, 6000);
    if (!o.portrait && src.portrait) o.portrait = src.portrait;
    o.folders = [...new Set([...(o.folders || []), ...(src.folders || [])])].filter(okFolder);
    o.name = keepName; o.secret = !!(o.secret && src.secret); o.ts = Date.now(); if (!o.wid && src.wid) o.wid = src.wid;
    o.merged = [...(o.merged || []), { name: oldB, id: src.id, by: me.name, ts: Date.now() }].slice(-20);
    camp.npcs = camp.npcs.filter(x => x !== src);
    if (!o.secret) notify(camp, me.name, 'npc', `${oldA} and ${oldB} turned out to be the same person: ${o.name}`, { tab: 'npcs', id: o.id });
    npcSync(camp, o); save(); return J(res, 200, { id: o.id });
  }
  if ((r = rest.match(/^\/npcs(?:\/(\w+))?$/))) {
    const clean = (b, o) => {
      o.name = str(b.name, 100).trim() || o.name || 'Unnamed'; o.role = str(b.role, 100); o.race = str(b.race, 60); o.where = str(b.where, 100); o.faction = str(b.faction, 100);
      o.attitude = NPC_ATT.includes(b.attitude) ? b.attitude : (o.attitude || 'unknown'); o.status = NPC_ST.includes(b.status) ? b.status : (o.status || 'alive');
      o.notes = str(b.notes, 6000); if (b.folders !== undefined) o.folders = cleanFolders(b.folders); if (b.portrait !== undefined) o.portrait = goodFile(str(b.portrait, 60));
    };
    if (!r[1] && m === 'POST') {
      const b = await body(req), o = { id: uid(), by: me.name, ts: Date.now(), secret: dm && b.secret === true, dmNotes: dm ? str(b.dmNotes, 6000) : '', portrait: '' }; clean(b, o); camp.npcs.push(o);
      if (!o.secret) notify(camp, me.name, 'npc', `${me.name} added ${o.name} to the Who’s Who`, { tab: 'npcs', id: o.id }); save(); return J(res, 200, { id: o.id });
    }
    const o = camp.npcs.find(x => x.id === r[1]); if (!o || (o.secret && !dm)) throw new E(404, 'No such person.');
    if (m === 'DELETE') { if (o.by !== me.name && !dm) throw new E(403, 'Only who added them or the DM can remove an entry.'); camp.npcs = camp.npcs.filter(x => x !== o); save(); return ok(); }
    if (m === 'PUT') {
      const b = await body(req), was = o.secret; clean(b, o);
      if (dm) { if (b.dmNotes !== undefined) o.dmNotes = str(b.dmNotes, 6000); if (b.secret !== undefined) o.secret = b.secret === true; if (was && !o.secret) notify(camp, me.name, 'npc', `${o.name} was added to the Who’s Who`, { tab: 'npcs', id: o.id }); }
      o.ts = Date.now(); npcSync(camp, o); save(); return ok();
    }
  }
  // world map: one big picture with a hex grid, a party token and travel requests
  if (rest === '/world/upload' && m === 'POST') {
    need(); const ct = String(req.headers['content-type'] || '').split(';')[0].trim(), X = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
    if (!has(X, ct)) throw new E(400, 'Use a PNG, JPEG or WebP picture.');
    const w = Math.round(+req.headers['x-w']), h = Math.round(+req.headers['x-h']);
    if (!(w >= 200 && w <= 20000 && h >= 200 && h <= 20000)) throw new E(400, 'Missing picture size.');
    let n = 0; const c = [];
    for await (const x of req) { n += x.length; if (n > 40e6) throw new E(413, 'That picture is too large (limit 40 MB).'); c.push(x); }
    if (!n) throw new E(400, 'Empty file.');
    const file = uid() + X[ct]; fs.writeFileSync(path.join(UP, file), Buffer.concat(c));
    if (camp.world && camp.world.file) { try { fs.unlinkSync(path.join(UP, camp.world.file)); } catch {} Object.assign(camp.world, { file, w, h }); }
    else camp.world = newWorld(file, w, h);
    save(); return ok();
  }
  if (rest === '/world' && m === 'DELETE') { need(); if (camp.world && camp.world.file) { try { fs.unlinkSync(path.join(UP, camp.world.file)); } catch {} } camp.world = null; save(); return ok(); }
  if (rest === '/world' && m === 'PUT') {
    need(); const W = camp.world; if (!W) throw new E(404, 'No world map yet.'); const b = await body(req, 2e6), n = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(+v) ? +v : d));
    if (b.grid) { // keep the party standing on the same spot of the picture when the grid changes
      const at = hexPx(W.grid, W.party.q, W.party.r), g = { size: n(b.grid.size, 8, W.w / 2, W.grid.size), orient: b.grid.orient === 'flat' ? 'flat' : 'pointy', ox: n(b.grid.ox, -2000, 2000, 0), oy: n(b.grid.oy, -2000, 2000, 0) };
      W.grid = g; W.party = pxHex(g, at.x, at.y);
    }
    if (b.hexDays !== undefined) W.hexDays = n(b.hexDays, .25, 30, 1);
    if (b.days !== undefined) W.days = n(b.days, 0, 99999, 0);
    if (Array.isArray(b.paint)) for (const p of b.paint.slice(0, 6000)) {
      const q = Math.round(+obj(p).q), r = Math.round(+obj(p).r), t = str(p.t, 12); if (!Number.isFinite(q) || !Number.isFinite(r) || !has(TERR, t)) continue;
      const k = q + ',' + r, e = obj(W.hexes[k]); e.t = t === 'plains' ? undefined : t; if (e.t || e.name || e.note) W.hexes[k] = e; else delete W.hexes[k];
    }
    if (b.hex) { const q = Math.round(+b.hex.q), r = Math.round(+b.hex.r), k = q + ',' + r; if (Number.isFinite(q) && Number.isFinite(r)) { const e = obj(W.hexes[k]); e.name = str(b.hex.name, 60); e.note = str(b.hex.note, 2000); if (e.t || e.name || e.note) W.hexes[k] = e; else delete W.hexes[k]; } }
    if (b.party) { const q = Math.round(+b.party.q), r = Math.round(+b.party.r); if (Number.isFinite(q) && Number.isFinite(r)) W.party = { q, r }; }
    save(); return ok();
  }
  if (rest === '/world/move' && m === 'POST') { // the DM moves the party straight away
    need(); const W = camp.world; if (!W) throw new E(404, 'No world map yet.'); const b = await body(req), c = checkPath(W, b.path, true);
    W.move = { id: uid(), path: c.path, ts: Date.now(), days: c.days, by: me.name }; W.party = c.path[c.path.length - 1]; W.days += c.days;
    W.log = [...W.log, { ts: Date.now(), to: W.party, name: hexName(W, W.party), days: c.days, by: me.name }].slice(-30);
    notify(camp, me.name, 'travel', `The party travels to ${hexName(W, W.party)} (${c.days} day${c.days === 1 ? '' : 's'})`, { tab: 'maps', world: true }); tick(camp, c.days * 1440, c.days, 'travel'); save(); return ok();
  }
  if ((r = rest.match(/^\/world\/requests(?:\/(\w+))?$/))) {
    const W = camp.world; if (!W) throw new E(404, 'No world map yet.');
    if (!r[1] && m === 'POST') {
      const b = await body(req), c = checkPath(W, b.path, false);
      W.requests = W.requests.filter(x => x.by !== me.name).slice(-19);
      const cps = (Array.isArray(b.cps) ? b.cps : []).slice(0, 80).map(x => ({ q: Math.round(+obj(x).q), r: Math.round(+obj(x).r) })).filter(x => Number.isFinite(x.q) && Number.isFinite(x.r));
      const q = { id: uid(), by: me.name, path: c.path, cps, days: c.days, ts: Date.now() }; W.requests.push(q);
      notify(camp, me.name, 'travel', `${me.name} asks to travel to ${hexName(W, c.path[c.path.length - 1])} (${c.days} day${c.days === 1 ? '' : 's'})`, { tab: 'maps', world: true }); save(); return J(res, 200, { id: q.id });
    }
    const q = W.requests.find(x => x.id === r[1]); if (!q) throw new E(404, 'That request is gone.');
    if (m === 'DELETE') { if (q.by !== me.name && !dm) throw new E(403, 'Not yours to cancel.'); W.requests = W.requests.filter(x => x !== q); save(); return ok(); }
    if (m === 'PUT') {
      need(); const b = await body(req);
      if (b.op === 'accept') {
        let c; try { c = checkPath(W, q.path, true); } catch (e) { W.requests = W.requests.filter(x => x !== q); save(); throw new E(409, 'The party has moved since this was asked, so the route no longer starts next to it. The request was cleared.'); }
        W.requests = W.requests.filter(x => x !== q);
        W.move = { id: uid(), path: c.path, ts: Date.now(), days: c.days, by: q.by }; W.party = c.path[c.path.length - 1]; W.days += c.days;
        W.log = [...W.log, { ts: Date.now(), to: W.party, name: hexName(W, W.party), days: c.days, by: q.by }].slice(-30);
        notify(camp, me.name, 'travel', `The party travels to ${hexName(W, W.party)} (${c.days} day${c.days === 1 ? '' : 's'})`, { tab: 'maps', world: true }); tick(camp, c.days * 1440, c.days, 'travel');
      } else { W.requests = W.requests.filter(x => x !== q); notify(camp, me.name, 'travel', `The DM said not yet to ${q.by}’s travel request`, { tab: 'maps', world: true }); }
      save(); return ok();
    }
  }
  // table scene (picture, video or built-in look behind the fire)
  if (rest === '/scene' && m === 'PUT') {
    need(); const b = await body(req), sc = camp.scene = obj(camp.scene);
    if (b.preset !== undefined) { if (!['campfire', 'tavern', 'tabletop', 'dungeon', 'study', 'bridge', 'cargo', 'hangar'].includes(b.preset)) throw new E(400, 'Unknown look.'); sc.preset = b.preset; delete sc.file; delete sc.kind; }
    if (b.dim !== undefined) sc.dim = Math.max(0, Math.min(80, Math.round(+b.dim) || 0));
    if (b.fire !== undefined) sc.fire = b.fire === true;
    if (b.light !== undefined) { if (!['', 'none', 'candle', 'bulb', 'fluor', 'neon', 'lantern'].includes(b.light)) throw new E(400, 'Unknown light.'); sc.light = b.light; }
    if (b.lightColor !== undefined) sc.lightColor = /^#[0-9a-f]{6}$/i.test(b.lightColor) ? b.lightColor : '';
    if (b.lightLevel !== undefined) sc.lightLevel = Math.max(0, Math.min(100, Math.round(+b.lightLevel) || 0));
    save(); return ok();
  }
  if (rest === '/scene/upload' && m === 'POST') {
    need(); const ct = String(req.headers['content-type'] || '').split(';')[0].trim(), X = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'video/webm': '.webm' };
    if (!has(X, ct)) throw new E(400, 'Use a PNG, JPEG, WebP, GIF, MP4 or WebM file.');
    const lim = ct.startsWith('video') ? 80e6 : 15e6; let n = 0; const c = [];
    for await (const x of req) { n += x.length; if (n > lim) throw new E(413, `That file is too large (limit ${lim / 1e6} MB).`); c.push(x); }
    if (!n) throw new E(400, 'Empty file.');
    const file = uid() + X[ct]; fs.writeFileSync(path.join(UP, file), Buffer.concat(c));
    camp.scene = { ...obj(camp.scene), file, kind: ct.startsWith('video') ? 'video' : 'image' }; save(); return ok();
  }
  if (rest === '/scene' && m === 'DELETE') { need(); camp.scene = {}; save(); return ok(); }
  // maps
  if (rest === '/maps' && m === 'POST') {
    need(); const b = await body(req, 22e6), file = saveImage(b.data, 15e6), id = uid();
    camp.maps.push({ id, name: str(b.name, 100) || 'Untitled map', file, pins: [] }); save(); return J(res, 200, { id });
  }
  if ((r = rest.match(/^\/maps\/(\w+)$/)) && m === 'DELETE') {
    need(); const mp = camp.maps.find(x => x.id === r[1]);
    if (mp) { try { fs.unlinkSync(path.join(UP, mp.file)); } catch {} camp.maps = camp.maps.filter(x => x !== mp); save(); }
    return ok();
  }
  // table art: the DM's own picture for each prop on the table ('none' = the drawn one, missing = the built-in art)
  if (rest === '/propart' && m === 'PUT') {
    need(); const b = await body(req), k = str(b.key, 20);
    if (!['tome', 'bounty', 'npc', 'grave', 'map', 'screen', 'journal', 'bag', 'tomb', 'fire', 'sky'].includes(k)) throw new E(400, 'Unknown prop.');
    camp.propArt = obj(camp.propArt);
    if (!b.file) delete camp.propArt[k]; else if (b.file === 'none') camp.propArt[k] = 'none';
    else { const f = goodFile(str(b.file, 60)); if (!f) throw new E(400, 'Upload the picture first.'); camp.propArt[k] = f; }
    save(); return ok();
  }
  // scribbles: anyone at the table can write a line on a pin's note
  if ((r = rest.match(/^\/maps\/(\w+)\/pins\/(\w+)\/notes(?:\/(\w+))?$/))) {
    const mp = camp.maps.find(x => x.id === r[1]), pin = mp && mp.pins.find(x => x.id === r[2]);
    if (!pin || (pin.secret && !dm)) throw new E(404, 'No such pin.');
    pin.notes = Array.isArray(pin.notes) ? pin.notes : [];
    if (m === 'POST' && !r[3]) { const b = await body(req), t = str(b.t, 500).trim(); if (!t) throw new E(400, 'Write something first.');
      if (pin.notes.length >= 60) pin.notes.shift(); const n = { id: uid(), by: me.name, t, ts: Date.now() }; pin.notes.push(n); save(); return J(res, 200, n); }
    if (m === 'DELETE' && r[3]) { const n = pin.notes.find(x => x.id === r[3]); if (!n) throw new E(404, 'No such note.'); if (n.by !== me.name && !dm) throw new E(403, 'You can only rub out your own notes.');
      pin.notes = pin.notes.filter(x => x !== n); save(); return ok(); }
    throw new E(404, 'Not found');
  }
  if ((r = rest.match(/^\/maps\/(\w+)\/pins(?:\/(\w+))?$/))) {
    const mp = camp.maps.find(x => x.id === r[1]); if (!mp) throw new E(404, 'No such map.');
    if (m === 'POST' && !r[2]) {
      const b = await body(req), pin = { id: uid(), x: Math.min(1, Math.max(0, +b.x || 0)), y: Math.min(1, Math.max(0, +b.y || 0)),
        name: str(b.name, 100) || 'New place', note: str(b.note, 3000), by: me.name, secret: dm && !!b.secret };
      mp.pins.push(pin); save(); return J(res, 200, { id: pin.id });
    }
    const pin = mp.pins.find(x => x.id === r[2]);
    if (!pin || (pin.by !== me.name && !dm)) throw new E(403, 'You can only change your own pins.');
    if (m === 'PUT') { const b = await body(req); pin.name = str(b.name, 100); pin.note = str(b.note, 3000); if (dm) pin.secret = !!b.secret; save(); return ok(); }
    if (m === 'DELETE') { mp.pins = mp.pins.filter(x => x !== pin); save(); return ok(); }
  }
  // delete several Who's Who entries or bounty board jobs at once (same rule as one at a time: whoever added it, or the DM)
  if (rest === '/bulkdel' && m === 'POST') {
    const b = await body(req), ids = new Set((Array.isArray(b.ids) ? b.ids : []).slice(0, 1000).map(x => str(x, 40)));
    const key = b.kind === 'npcs' ? 'npcs' : b.kind === 'bounties' ? 'bounties' : null; if (!key) throw new E(400, 'Unknown list.');
    const can = o => o.by === me.name || dm, see = o => dm || !o.secret;
    const del = camp[key].filter(o => ids.has(o.id) && see(o) && can(o)), gone = new Set(del);
    camp[key] = camp[key].filter(o => !gone.has(o)); save();
    return J(res, 200, { deleted: del.length, skipped: ids.size - del.length });
  }
  if (rest === '/clock' && m === 'POST') { // the DM says time passes for the whole party
    need(); const b = await body(req), mins = Math.min(60 * 24 * 30, Math.max(1, Math.round(+b.mins || 0))), days = Math.floor(mins / 1440);
    const e = tick(camp, mins, days, 'dm');
    const txt = mins >= 1440 ? `${days} day${days === 1 ? '' : 's'}` : mins >= 60 ? `${Math.round(mins / 60 * 10) / 10} hour${mins === 60 ? '' : 's'}` : `${mins} minutes`;
    notify(camp, me.name, 'time', `${txt} pass${days === 1 || mins === 60 ? 'es' : ''}`, { tab: 'party' }); save(); return J(res, 200, e);
  }
  // drawings and written notes on a map: party ('all') or only the person who made them ('me'); author or DM rubs them out
  if ((r = rest.match(/^\/maps\/(\w+)\/marks(?:\/(\w+))?$/))) {
    const mp = camp.maps.find(x => x.id === r[1]); if (!mp) throw new E(404, 'No such map.');
    mp.marks = Array.isArray(mp.marks) ? mp.marks : [];
    const c01 = n => Math.min(1, Math.max(0, +n || 0)), col = c => /^#[0-9a-f]{6}$/i.test(c || '') ? c : '#b3170d';
    const mine = k => k.by === me.name, see = k => k.vis === 'all' || mine(k);
    if (m === 'POST' && !r[2]) {
      const b = await body(req, 400000), k = { id: uid(), by: me.name, ts: Date.now(), vis: b.vis === 'me' ? 'me' : 'all', c: col(b.c) };
      if (b.kind === 'text') { k.kind = 'text'; k.x = c01(b.x); k.y = c01(b.y); k.t = str(b.t, 300).trim(); k.s = [1, 2, 3].includes(+b.s) ? +b.s : 2; if (!k.t) throw new E(400, 'Write something first.'); }
      else { k.kind = 'ink'; k.w = [2, 4, 8].includes(+b.w) ? +b.w : 4; k.p = (Array.isArray(b.p) ? b.p : []).slice(0, 800).filter(q => Array.isArray(q)).map(q => [Math.round(c01(q[0]) * 1e4) / 1e4, Math.round(c01(q[1]) * 1e4) / 1e4]); if (k.p.length < 2) throw new E(400, 'Draw a longer line.'); }
      if (mp.marks.length >= 600) throw new E(400, 'This map is full of drawings. Rub some out first.');
      mp.marks.push(k); save(); return J(res, 200, { id: k.id });
    }
    if (m === 'DELETE' && !r[2]) { // clear: your own marks, or the DM clears everyone's party marks with ?all=1
      const all = dm && new URL(req.url, 'http://x').searchParams.get('all') === '1';
      mp.marks = mp.marks.filter(k => !(mine(k) || (all && k.vis === 'all'))); save(); return ok();
    }
    const k = mp.marks.find(x => x.id === r[2]); if (!k || !see(k)) throw new E(404, 'No such note.');
    if (!mine(k) && !dm) throw new E(403, 'You can only rub out your own drawings and notes.');
    if (m === 'PUT') { const b = await body(req); if (k.kind === 'text') { if (b.t !== undefined) k.t = str(b.t, 300).trim() || k.t; if (b.x !== undefined) k.x = c01(b.x); if (b.y !== undefined) k.y = c01(b.y); } if (mine(k) && (b.vis === 'all' || b.vis === 'me')) k.vis = b.vis; save(); return ok(); }
    if (m === 'DELETE') { mp.marks = mp.marks.filter(x => x !== k); save(); return ok(); }
  }
  // areas: hidden regions of a map that players pick as where they are heading
  if ((r = rest.match(/^\/maps\/(\w+)\/areas(?:\/(\w+)(\/go)?)?$/))) {
    const mp = camp.maps.find(x => x.id === r[1]); if (!mp) throw new E(404, 'No such map.'); mp.areas = mp.areas || [];
    const c01 = n => Math.min(1, Math.max(0, +n || 0));
    if (m === 'POST' && !r[2]) {
      need(); const b = await body(req), x = c01(b.x), y = c01(b.y), a = { id: uid(), name: str(b.name, 100) || 'New area', note: str(b.note, 3000), x, y, w: Math.min(1 - x, Math.max(.01, c01(b.w))), h: Math.min(1 - y, Math.max(.01, c01(b.h))), vis: 'dm', who: [], going: [] };
      mp.areas.push(a); save(); return J(res, 200, { id: a.id });
    }
    const a = mp.areas.find(q => q.id === r[2]); if (!a) throw new E(404, 'No such area.');
    if (r[3] && m === 'POST') {
      const seen = dm || a.vis === 'all' || (a.vis === 'some' && (a.who || []).includes(me.name)); if (!seen) throw new E(404, 'No such area.');
      const was = (a.going || []).includes(me.name); for (const q of mp.areas) q.going = (q.going || []).filter(n => n !== me.name);
      if (!was) { a.going.push(me.name); if (a.vis === 'all') notify(camp, me.name, 'travel', `${me.name} is heading to ${a.name}`, { tab: 'maps' }); }
      save(); return ok();
    }
    need();
    if (m === 'PUT') {
      const b = await body(req);
      if (b.name !== undefined) a.name = str(b.name, 100) || a.name; if (b.note !== undefined) a.note = str(b.note, 3000);
      if (b.vis !== undefined && ['all', 'dm', 'some'].includes(b.vis)) a.vis = b.vis;
      if (Array.isArray(b.who)) a.who = b.who.map(n => str(n, 40)).filter(n => camp.members.includes(n)).slice(0, 50);
      for (const k of ['x', 'y', 'w', 'h']) if (b[k] !== undefined) a[k] = c01(b[k]);
      a.going = (a.going || []).filter(n => a.vis === 'all' || (a.vis === 'some' && a.who.includes(n))); save(); return ok();
    }
    if (m === 'DELETE') { mp.areas = mp.areas.filter(q => q !== a); save(); return ok(); }
  }
  // shared book
  if ((r = rest.match(/^\/book\/chapters(?:\/(\w+))?(\/pages(?:\/(\w+))?)?$/))) {
    const [, chId, pgSeg, pgId] = r, chs = camp.book.chapters;
    if (!chId && m === 'POST') {
      need(); const b = await body(req), c = { id: uid(), title: str(b.title, 200) || 'New arc', summary: str(b.summary, 5000), status: 'current', by: me.name, ts: Date.now(), pages: [] };
      for (const x of chs) if (x.status === 'current') x.status = 'past';
      chs.push(c); syncArc(camp); notify(camp, me.name, 'arc', `A new arc began: ${c.title}`, { tab: 'tome', arc: c.id }); save(); return J(res, 200, { id: c.id });
    }
    const ch = chs.find(x => x.id === chId); if (!ch) throw new E(404, 'No such chapter.');
    if (!pgSeg) {
      if (m === 'PUT') {
        need(); const b = await body(req);
        if (b.title !== undefined) ch.title = str(b.title, 200) || ch.title;
        if (b.summary !== undefined) ch.summary = str(b.summary, 5000);
        if (b.status === 'current') { for (const x of chs) if (x.status === 'current') x.status = 'past'; ch.status = 'current'; }
        else if (b.status === 'past') ch.status = 'past';
        syncArc(camp); save(); return ok();
      }
      if (m === 'DELETE') { need(); camp.book.chapters = chs.filter(x => x !== ch); syncArc(camp); save(); return ok(); }
    } else if (!pgId && m === 'POST') {
      const b = await body(req), p = { id: uid(), title: str(b.title, 100) || 'New page', body: str(b.body, 50000), by: me.name, ts: Date.now() };
      ch.pages.push(p); notify(camp, me.name, 'page', `${me.name} added “${p.title}” to ${ch.title}`, { tab: 'tome', arc: ch.id, page: p.id }); save(); return J(res, 200, { id: p.id });
    } else if (pgId) {
      const pg = ch.pages.find(x => x.id === pgId); if (!pg) throw new E(404, 'No such page.');
      if (pg.by !== me.name && !dm) throw new E(403, 'You can only change your own pages.');
      if (m === 'PUT') { const b = await body(req); pg.title = str(b.title, 100); pg.body = str(b.body, 50000); pg.ts = Date.now(); save(); return ok(); }
      if (m === 'DELETE') { ch.pages = ch.pages.filter(x => x !== pg); save(); return ok(); }
    }
  }
  // private notebook: only the owner writes it; the DM may READ any player's notebook (players are told so), players never read each other's
  { const nr = rest.match(/^\/notebook\/([a-z0-9_]{1,20})$/);
    if (nr && m === 'GET') { need(); const u = nr[1];
      if (!camp.members.includes(u) || u === camp.owner) throw new E(404, 'No such player.');
      const nb = D.notebooks[camp.id + '|' + u] || {};
      return J(res, 200, { user: u, notebook: { chapters: nb.chapters || [], lore: nb.lore || [], qnotes: nb.qnotes || {}, maps: nb.maps || [], ts: nb.ts || 0 } }); } }
  if (rest === '/notebook' && m === 'PUT') {
    const b = await body(req, 4e6), k = camp.id + '|' + me.name, cur = D.notebooks[k] || { chapters: [], ts: 0 };
    if (b.base !== undefined && +b.base !== (cur.ts || 0)) return J(res, 409, { error: 'Your journal changed somewhere else.', chapters: cur.chapters, lore: cur.lore || [], qnotes: cur.qnotes || {}, maps: cur.maps || [], ts: cur.ts || 0 });
    D.notebooks[k] = { ...cleanNB(b), ts: Math.max(Date.now(), (cur.ts || 0) + 1) }; save(); return J(res, 200, { ok: true, ts: D.notebooks[k].ts });
  }
  // turn order (shared). The DM edits everything; a player may change only the number on their own entries.
  if (rest === '/init' && m === 'PUT') {
    need(); const b = await body(req), o = obj(b.init), was = camp.init && camp.init.on;
    camp.init = { on: o.on === true, round: Math.max(1, Math.min(999, Math.round(+o.round) || 1)), dir: o.dir === 'low' ? 'low' : 'high',
      list: (Array.isArray(o.list) ? o.list : []).slice(0, 40).map(e => { const hpmax = Math.max(0, Math.min(99999, Math.round(+e.hpmax) || 0));
        return { id: str(e.id, 20) || uid(), name: str(e.name, 40), init: Math.max(-99, Math.min(999, Math.round(+e.init) || 0)), owner: str(e.owner, 20), npc: e.npc === true,
          kind: ['pc', 'npc', 'mon'].includes(e.kind) ? e.kind : (e.npc === true ? 'npc' : 'pc'), mon: str(e.mon, 80), ac: str(e.ac, 40), hpmax, hp: hpmax ? Math.max(-999, Math.min(hpmax * 2, Math.round(+e.hp) || 0)) : 0, hid: e.hid === true }; }) };
    camp.init.turn = Math.max(0, Math.min(Math.max(0, camp.init.list.length - 1), Math.round(+o.turn) || 0));
    if (!!was !== camp.init.on && HUB) HUB.combat(camp, camp.init.on);
    save(); return ok();
  }
  if (rest === '/init/mine' && m === 'PUT') {
    const b = await body(req), I = camp.init = camp.init || { on: false, round: 1, turn: 0, dir: 'high', list: [] }, e = I.list.find(x => x.id === b.id);
    if (!e || (e.owner !== me.name && !dm)) throw new E(404, 'No such entry.'); e.init = Math.max(-99, Math.min(999, Math.round(+b.init) || 0)); save(); return ok();
  }
  // dice log
  if (rest === '/rolls' && m === 'POST') {
    const b = await body(req);
    camp.rolls.push({ id: uid(), by: me.name, who: str(b.who, 60), label: str(b.label, 80), expr: str(b.expr, 80), detail: str(b.detail, 300),
      total: Math.round(+b.total) || 0, crit: ['crit', 'fumble'].includes(b.crit) ? b.crit : '', hidden: dm && !!b.hidden, ts: Date.now() });
    if (camp.rolls.length > 60) camp.rolls = camp.rolls.slice(-60);
    save(); return ok();
  }
  throw new E(404, 'Not found');
}

// ---------- Meadow link (read-only) ----------
// Meadow, the owner's life app on this same PC, asks for a short summary of each campaign
// (name, next session, active jobs). It only answers programs on this PC (not players, not
// Tailscale, not the internet), shows no private notes, and never changes anything.
function lifeLinkSummary() {
  const camps = Object.values(D.camps).map(c => {
    const last = Math.max(c.created || 0, ...(c.feed || []).slice(-20).map(f => f.ts || 0), ...(c.chat || []).slice(-20).map(x => x.ts || 0));
    const next = c.sched && c.sched.next ? { date: c.sched.next.date, time: c.sched.next.time || '', note: c.sched.next.note || '' } : null;
    return { id: c.id, name: c.name, system: c.system || 'dnd5e', dm: c.owner, players: (c.members || []).filter(u => u !== c.owner).length,
      next, activeJobs: (c.bounties || []).filter(b => !b.draft && (b.status === 'active' || b.status === 'open')).length, lastActivity: last || null };
  }).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  return { app: 'dice-and-luck', at: new Date().toISOString(), camps };
}

async function handle(req, res) {
  const p = new URL(req.url, 'http://x').pathname, m = req.method;
  // Requests from the internet arrive through Tailscale Funnel (or a tunnel) on this PC, with forwarding headers.
  const fwd = String(req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || ''), loop = /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress || '');
  const remote = loop && !!(fwd || req.headers['tailscale-funnel-request']), ip = remote ? (fwd.split(',')[0].trim() || 'internet') : req.socket.remoteAddress;
  req.remote = remote;
  if (p === '/api/link/summary' && m === 'GET') {
    if (!loop || fwd || Object.keys(req.headers).some(h => h.startsWith('x-forwarded') || h.startsWith('tailscale-') || h === 'forwarded')) throw new E(403, 'Only apps on this PC can read this.');
    return J(res, 200, lifeLinkSummary());
  }
  if (remote && (p === '/hub' || p === '/hub.js' || p === '/modules' || p === '/module.js' || p === '/tv' || p.startsWith('/tv/') || p === '/tv.js' || p.startsWith('/api/tv/') || p.startsWith('/api/remote/') || p === '/api/shutdown' || /^\/api\/c\/\w+\/hub/.test(p)))
    throw new E(403, 'The Creative Hub, the TV and End session only work on your home network.');
  if (m === 'GET' && has(STATIC, p)) {
    const [f, type] = STATIC[p]; return sendStatic(req, res, f, type);
  }
  if (m === 'GET' && (p === '/tv' || p.startsWith('/tv/'))) return sendStatic(req, res, 'tv.html', 'text/html; charset=utf-8');
  // the Crew Terminal's rendered monitor (pictures made in Blender), shipped with the program
  if (m === 'GET' && /^\/terminal\/rig\/[\w-]+\.(webp|jpg|png)$/.test(p)) { res.setHeader('Cache-Control', 'public, max-age=86400'); return sendFile(req, res, path.join(DIR, 'terminal-rig', path.basename(p))); }
  if (p.startsWith('/api/tv/') || p.startsWith('/api/remote/')) { if (await HUB.publicRoute(req, res, p, m)) return; throw new E(404, 'Not found'); }
  if (p === '/api/status' && m === 'GET') return J(res, 200, { setup: !Object.keys(D.users).length });
  if (p === '/api/register' && m === 'POST') {
    if (tooMany(ip)) throw new E(429, 'Too many attempts. Wait a few minutes.');
    const b = await body(req), n = str(b.username, 40).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_]{2,19}$/.test(n)) throw new E(400, 'Username: 3 to 20 letters, numbers or underscores.');
    if (str(b.password, 200).length < 8) throw new E(400, 'Password needs at least 8 characters.');
    const first = !Object.keys(D.users).length; let camp = null;
    if (first && remote) throw new E(403, 'Create the DM account on the PC first.');
    if (!first) {
      camp = Object.values(D.camps).find(c => c.joinCode === str(b.code, 20).trim().toLowerCase());
      if (!camp) { bad(ip); throw new E(403, 'That join code isn’t right. Ask your DM.'); }
    }
    if (has(D.users, n)) throw new E(409, 'That username is taken.');
    D.users[n] = { ...hash(b.password), canDM: first };
    if (camp) camp.members.push(n);
    return startSession(res, n, remote);
  }
  if (p === '/api/login' && m === 'POST') {
    if (tooMany(ip)) throw new E(429, 'Too many attempts. Wait a few minutes.');
    const b = await body(req), n = str(b.username, 40).trim().toLowerCase(), u = has(D.users, n) ? D.users[n] : null;
    const ok = u && crypto.timingSafeEqual(Buffer.from(hash(str(b.password, 200), u.salt).h), Buffer.from(u.h));
    if (!ok) { bad(ip); throw new E(401, 'Wrong username or password.'); }
    return startSession(res, n, remote);
  }
  const ck = Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(a => a[0]));
  const s = has(D.sessions, ck.sid) ? D.sessions[ck.sid] : null, u = s && has(D.users, s.u) ? D.users[s.u] : null;
  const me = u ? { name: s.u, canDM: !!u.canDM, tour: !!u.tourDone } : null;
  if (p === '/api/tour' && m === 'POST' && me) { D.users[me.name].tourDone = Date.now(); save(); return J(res, 200, { ok: true }); }
  if (p === '/api/logout' && m === 'POST') { delete D.sessions[ck.sid]; save(); return J(res, 200, { ok: true }); }
  if (!me) throw new E(401, 'Please sign in.');
  if (p === '/api/shutdown' && m === 'POST') {
    if (!me.canDM) throw new E(403, 'Only the DM account can end the session.');
    clearTimeout(timer); flush();
    const bd = path.join(DD, 'backups'); fs.mkdirSync(bd, { recursive: true });
    const d = new Date(), z = n => String(n).padStart(2, '0'), name = `party-hub-${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}.json`;
    fs.writeFileSync(path.join(bd, name), JSON.stringify(D));
    const old = fs.readdirSync(bd).filter(f => /^party-hub-.*\.json$/.test(f)).sort(); while (old.length > 30) fs.unlinkSync(path.join(bd, old.shift()));
    J(res, 200, { ok: true, backup: name }); console.log('Session ended by ' + me.name + '. Saved to backups/' + name);
    setTimeout(() => process.exit(0), 400); return;
  }

  if (p.startsWith('/uploads/')) { res.setHeader('Cache-Control', 'private, max-age=31536000, immutable'); return sendFile(req, res, path.join(UP, path.basename(p))); }
  if (/^\/art\/[\w-]+\.(webp|png)$/.test(p) && m === 'GET') return sendFile(req, res, path.join(DIR, 'art', path.basename(p)));
  if (p === '/api/me' && m === 'GET') return J(res, 200, { me, camps: mineCamps(me.name), ver: ver() });
  if (p === '/api/camps' && m === 'POST') {
    if (!me.canDM) throw new E(403, 'Only the DM account can create campaigns.');
    const b = await body(req), c = newCamp(b.name, me.name, b.system); D.camps[c.id] = c; save(); return J(res, 200, { id: c.id });
  }
  if (p === '/api/join' && m === 'POST') {
    if (tooMany(ip)) throw new E(429, 'Too many attempts. Wait a few minutes.');
    const b = await body(req), c = Object.values(D.camps).find(x => x.joinCode === str(b.code, 20).trim().toLowerCase());
    if (!c) { bad(ip); throw new E(403, 'That join code isn’t right. Ask your DM.'); }
    if (!c.members.includes(me.name)) { c.members.push(me.name); save(); }
    return J(res, 200, { id: c.id });
  }
  if (p === '/api/upload' && m === 'POST') { const b = await body(req, 12e6), gif = /^data:image\/gif;/.test(b.data || ''); return J(res, 200, { file: saveImage(b.data, gif ? 8e6 : 4e6) }); }
  if (p.startsWith('/api/forge') && await FORGE.route(req, res, p, m, me)) return;
  const mc = p.match(/^\/api\/c\/(\w+)(\/.*)?$/);
  if (mc) {
    const camp = has(D.camps, mc[1]) ? D.camps[mc[1]] : null;
    if (!camp) throw new E(404, 'No such campaign.');
    const dm = camp.owner === me.name;
    if (!dm && !camp.members.includes(me.name)) throw new E(403, 'You’re not in this campaign.');
    return campRoute(req, res, m, mc[2] || '/', me, camp, dm);
  }
  throw new E(404, 'Not found');
}

let FORGE = null, DUNG = null, TERM = null;
TERM = require('./terminalserver.js')({ E, J, body, uid, str, obj, has, save, notify, goodFile, chars: () => D.chars, users: () => D.users });
DUNG = require('./dungeonserver.js')({ E, J, body, uid, str, obj, has, UP, save, notify, goodFile, chars: () => D.chars });
HUB = require('./hubserver.js')({ E, J, body, uid, str, obj, has, UP, DD, sendFile, view, save, camps: () => Object.values(D.camps), users: () => D.users, chars: () => D.chars, notify, dg: () => DUNG, worldCamps, npcSync, WSYNC, forge: () => obj(D.forge) });
FORGE = require('./forgeserver.js')({ E, J, body, uid, str, obj, UP, save, notify, camps: () => Object.values(D.camps), chars: () => D.chars, store: () => (D.forge = obj(D.forge)), hub: () => HUB });

const server = http.createServer(async (req, res) => {
  try { await handle(req, res); }
  catch (e) {
    if (e instanceof E) return J(res, e.c, { error: e.message });
    console.error(e); try { J(res, 500, { error: 'Something went wrong on the server.' }); } catch {}
  }
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nDice and Luck is running.\n  On this PC:   http://localhost:${PORT}\n  Creative Hub: http://localhost:${PORT}/hub`);
  for (const l of Object.values(os.networkInterfaces()).flat()) if (l && l.family === 'IPv4' && !l.internal) console.log(`  Same network: http://${l.address}:${PORT}`);
  console.log(Object.keys(D.users).length ? '\nPlayers join with the code shown on the DM screen.\n' : '\nNo accounts yet. The FIRST account you create becomes the DM.\n');
});
gc(); setInterval(gc, 3600e3).unref();
// start.bat / start.sh set this so dropping in a new server.js restarts the server by itself
if (process.env.PH_AUTORESTART) fs.watchFile(__filename, { interval: 3000 }, (a, b) => { if (a.mtimeMs !== b.mtimeMs) { console.log('server.js was updated. Restarting...'); flush(); process.exit(42); } });
