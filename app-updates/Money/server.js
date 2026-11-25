// Money Quest - local money tracker server (no dependencies, just Node.js)
// Run: node server.js   then open http://localhost:3100 (or your PC's IP from your phone)

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3100; // 3000 belongs to Dice and Luck
const TS_PORT = 8443; // Tailscale Serve port (443 is used by Dice and Luck's Funnel)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PUBLIC_DIR = path.join(__dirname, 'public');

// kind: need = necessary (rent, bills, groceries, gas…), want = nice to have, junk = fast food & co.
const DEFAULT_CATEGORIES = [
  { id: 'groceries', name: 'Groceries', emoji: '🛒', type: 'expense', food: true, kind: 'need' },
  { id: 'bills', name: 'Rent & Bills', emoji: '🏠', type: 'expense', food: false, kind: 'need' },
  { id: 'utilities', name: 'Wi-Fi & Utilities', emoji: '📶', type: 'expense', food: false, kind: 'need' },
  { id: 'gas', name: 'Gas', emoji: '⛽', type: 'expense', food: false, kind: 'need' },
  { id: 'transport', name: 'Transport', emoji: '🚌', type: 'expense', food: false, kind: 'need' },
  { id: 'health', name: 'Health', emoji: '💊', type: 'expense', food: false, kind: 'need' },
  { id: 'eating-out', name: 'Restaurants', emoji: '🍝', type: 'expense', food: true, kind: 'want' },
  { id: 'coffee', name: 'Coffee & Snacks', emoji: '☕', type: 'expense', food: true, kind: 'want' },
  { id: 'shopping', name: 'Shopping', emoji: '🛍️', type: 'expense', food: false, kind: 'want' },
  { id: 'fun', name: 'Entertainment', emoji: '🎮', type: 'expense', food: false, kind: 'want' },
  { id: 'subscriptions', name: 'Subscriptions', emoji: '📺', type: 'expense', food: false, kind: 'want' },
  { id: 'gifts', name: 'Gifts', emoji: '🎁', type: 'expense', food: false, kind: 'want' },
  { id: 'other', name: 'Other', emoji: '📦', type: 'expense', food: false, kind: 'want' },
  { id: 'fast-food', name: 'Fast Food', emoji: '🍟', type: 'expense', food: true, kind: 'junk' },
  { id: 'salary', name: 'Salary', emoji: '💼', type: 'income', food: false, kind: 'want' },
  { id: 'side', name: 'Side Hustle', emoji: '💡', type: 'income', food: false, kind: 'want' },
  { id: 'income-other', name: 'Other Income', emoji: '💰', type: 'income', food: false, kind: 'want' },
];
const KINDS = ['need', 'want', 'junk'];

function defaultDb() {
  return {
    version: 3,
    settings: {
      name: 'Player',
      currency: '$',
      monthlyBudget: 1500,
      foodBudget: 400,
      categories: DEFAULT_CATEGORIES,
      onboarded: false,
      startBalance: 0,
      balanceAnchor: null, // when the wallet balance was set; entries logged after this change it
      rewardRate: 10,      // % of every amount you put aside that becomes reward coins (1 coin = 1 of your currency)
      underBudgetRate: 20, // % of what's left under budget at the end of a month that becomes coins
    },
    transactions: [],
    goals: [],
    checkins: [],
    vault: [],       // deposits into the Wizard Tower's general vault
    recurring: [],   // bills and paydays that repeat
    rewards: [],     // treats you can buy with coins
    redemptions: [], // treats you bought
  };
}

// ---------- storage: one file per person, plus a shared ledger ----------
// data/profiles.json lists the people. The first person's data stays in data/money.json,
// anyone added later gets data/profile-<id>.json. data/shared.json holds shared expenses.
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const SHARED_FILE = path.join(DATA_DIR, 'shared.json');
const MAX_PROFILES = 6;
const profiles = new Map(); // id -> { id, file, db }
let current = null;         // the person this request is for
let db;                     // = current.db; all the routes below read and write this
let shared = { expenses: [], settlements: [] };
let rev = 1;                // bumps on every save so other devices know to refresh

// strip the invisible BOM Notepad sometimes adds when you edit a file by hand
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
function useProfile(p) { current = p; db = p.db; }
// run fn as another person, then switch back
function withProfile(p, fn) { const prev = current; useProfile(p); try { return fn(); } finally { if (prev) useProfile(prev); } }
const mainProfile = () => profiles.get('main') || profiles.values().next().value;

// Fill in missing fields and upgrade older files. Returns true if anything changed.
function upgradeDb(d) {
  const def = defaultDb();
  d.settings = { ...def.settings, ...(d.settings || {}) };
  for (const k of ['transactions', 'goals', 'checkins', 'vault', 'recurring', 'rewards', 'redemptions']) d[k] = d[k] || [];
  if ((d.version || 1) >= 3) return false;
  // give every category a need/want/junk kind and add missing defaults (Gas, Wi-Fi & Utilities, Fast Food)
  const cats = d.settings.categories;
  for (const c of cats) {
    const dc = DEFAULT_CATEGORIES.find(x => x.id === c.id);
    if (!KINDS.includes(c.kind)) c.kind = dc ? dc.kind : c.essential ? 'need' : 'want';
    if (dc && c.id === 'eating-out' && c.name === 'Eating Out') { c.name = dc.name; c.emoji = dc.emoji; }
    delete c.essential;
  }
  for (const dc of DEFAULT_CATEGORIES) {
    if (['gas', 'utilities', 'fast-food'].includes(dc.id) && !cats.find(c => c.id === dc.id)) {
      const firstIncome = cats.findIndex(c => c.type === 'income');
      cats.splice(firstIncome < 0 ? cats.length : firstIncome, 0, { ...dc });
    }
  }
  d.version = 3;
  return true;
}

function load() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const index = fs.existsSync(PROFILES_FILE) ? readJson(PROFILES_FILE) : [{ id: 'main', file: 'money.json' }];
  for (const e of index) {
    const file = path.join(DATA_DIR, e.file), exists = fs.existsSync(file);
    const p = { id: e.id, file: e.file, db: exists ? readJson(file) : defaultDb() };
    profiles.set(p.id, p);
    withProfile(p, () => { if (upgradeDb(db) || !exists) save(); });
  }
  if (fs.existsSync(SHARED_FILE)) shared = { expenses: [], settlements: [], ...readJson(SHARED_FILE) };
  useProfile(mainProfile());
}
const saveIndex = () => writeJson(PROFILES_FILE, [...profiles.values()].map(p => ({ id: p.id, file: p.file })));

// keep one backup per day of each file, the last 30
function backup(file, base) {
  const stamp = new Date().toISOString().slice(0, 10);
  fs.copyFileSync(file, path.join(BACKUP_DIR, `${base}-${stamp}.json`));
  const re = new RegExp(`^${base}-\\d{4}-\\d{2}-\\d{2}\\.json$`);
  const files = fs.readdirSync(BACKUP_DIR).filter(f => re.test(f)).sort();
  while (files.length > 30) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
}
function save() {
  rev++;
  const file = path.join(DATA_DIR, current.file);
  writeJson(file, db);
  backup(file, current.file.replace(/\.json$/, ''));
}
function saveShared() {
  rev++;
  writeJson(SHARED_FILE, shared);
  backup(SHARED_FILE, 'shared');
}
const profileList = () => [...profiles.values()].map(p => ({
  id: p.id, name: p.db.settings.name, hasPin: !!p.db.auth?.pinHash, onboarded: !!p.db.settings.onboarded,
}));

// ---------- validation helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const newId = () => crypto.randomBytes(6).toString('hex');
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
function str(v, max = 120) { return String(v ?? '').trim().slice(0, max); }
function money(v, { allowNegative = false, allowZero = false } = {}) {
  const n = Math.round(Number(v) * 100) / 100;
  if (!Number.isFinite(n)) throw new HttpError(400, 'Amount must be a number');
  if (!allowNegative && n < 0) throw new HttpError(400, 'Amount must be positive');
  if (!allowZero && n === 0) throw new HttpError(400, 'Amount cannot be zero');
  if (Math.abs(n) > 1e9) throw new HttpError(400, 'Amount too large');
  return n;
}
function date(v) {
  if (!isDate(v)) throw new HttpError(400, 'Date must be YYYY-MM-DD');
  return v;
}
function findOr404(list, id, what) {
  const item = list.find(x => x.id === id);
  if (!item) throw new HttpError(404, `${what} not found`);
  return item;
}

function cleanTransaction(b, existing = {}) {
  const t = { ...existing };
  if (!existing.id || b.amount !== undefined) t.amount = money(b.amount);
  if (!existing.id || b.type !== undefined) t.type = b.type === 'income' ? 'income' : 'expense';
  if (!existing.id || b.category !== undefined) t.category = str(b.category, 40) || 'other';
  if (!existing.id || b.note !== undefined) t.note = str(b.note, 140);
  if (!existing.id || b.date !== undefined) t.date = date(b.date);
  return t;
}

// reward rates are percentages from 0 to 100
function applyRates(s, b) {
  const pct = v => Math.min(100, Math.max(0, Math.round(Number(v) * 10) / 10 || 0));
  if (b.rewardRate !== undefined) s.rewardRate = pct(b.rewardRate);
  if (b.underBudgetRate !== undefined) s.underBudgetRate = pct(b.underBudgetRate);
}

// ---------- recurring payments (bills & paydays) ----------
const pad2 = n => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const addDaysStr = (s, n) => { const [y, m, d] = s.split('-').map(Number); return localDate(new Date(y, m - 1, d + n)); };

// Every due date of a recurring item between `from` and `to` (inclusive, YYYY-MM-DD).
// Never earlier than the day the item was added (r.from), so nothing gets back-filled.
function occurrences(r, from, to) {
  if (r.from > from) from = r.from;
  const out = [];
  if (from > to) return out;
  if (r.freq === 'monthly') {
    let [y, m] = from.split('-').map(Number);
    for (let guard = 0; guard < 600; guard++) {
      const dim = new Date(y, m, 0).getDate();
      const d = `${y}-${pad2(m)}-${pad2(Math.min(r.day, dim))}`;
      if (d > to) break;
      if (d >= from) out.push(d);
      if (++m > 12) { m = 1; y++; }
    }
  } else {
    const step = r.freq === 'weekly' ? 7 : 14;
    let d = r.anchor;
    while (d < from) d = addDaysStr(d, step);
    while (addDaysStr(d, -step) >= from) d = addDaysStr(d, -step);
    for (let guard = 0; d <= to && guard < 600; guard++) { out.push(d); d = addDaysStr(d, step); }
  }
  return out;
}

function cleanRecurring(b, existing = {}) {
  const r = { ...existing };
  const has = k => !existing.id || b[k] !== undefined;
  if (has('type')) r.type = b.type === 'income' ? 'income' : 'expense';
  if (has('name')) { r.name = str(b.name, 40); if (!r.name) throw new HttpError(400, 'Recurring payment needs a name'); }
  if (has('emoji')) r.emoji = str(b.emoji, 8) || (r.type === 'income' ? '💼' : '🧾');
  // variable = the amount changes every time (hourly pay). It never auto-logs: the app asks you on payday.
  if (has('variable')) r.variable = r.type === 'income' && !!b.variable;
  if (has('amount')) r.amount = money(b.amount || 0, { allowZero: !!r.variable });
  if (has('category')) r.category = str(b.category, 40) || (r.type === 'income' ? 'salary' : 'bills');
  if (has('freq')) r.freq = ['monthly', 'weekly', 'biweekly'].includes(b.freq) ? b.freq : 'monthly';
  if (has('day')) r.day = Math.min(31, Math.max(1, Math.round(Number(b.day)) || 1));
  if (has('anchor')) r.anchor = b.anchor ? date(b.anchor) : localDate();
  if (has('autopay')) r.autopay = !!b.autopay;
  if (r.variable) r.autopay = false;
  r.skipped = r.skipped || [];
  r.from = r.from || localDate();
  r.createdAt = r.createdAt || new Date().toISOString();
  r.id = r.id || newId();
  return r;
}

const isLogged = (r, due) => db.transactions.some(t => t.recurringId === r.id && t.dueDate === due);

function payRecurring(r, due, paidOn, amount, auto) {
  if (isLogged(r, due)) throw new HttpError(409, 'Already logged');
  db.transactions.push({
    id: newId(), type: r.type, amount: amount ?? r.amount, category: r.category, note: r.name,
    date: paidOn, recurringId: r.id, dueDate: due, auto: !!auto, createdAt: new Date().toISOString(),
  });
}

// Auto-pay: log every due bill / payday marked "automatic" up to today, for everyone.
function runAutopay() {
  const today = localDate();
  for (const p of profiles.values()) withProfile(p, () => {
    let added = 0;
    for (const r of db.recurring) {
      if (!r.autopay) continue;
      for (const due of occurrences(r, r.from, today)) {
        if (r.skipped.includes(due) || isLogged(r, due)) continue;
        payRecurring(r, due, due, r.amount, true);
        added++;
      }
    }
    if (added) { save(); console.log(`  ⏱️  Auto-logged ${added} recurring payment(s) for ${db.settings.name}`); }
  });
}

// ---------- PIN lock ----------
// The PIN is never stored, only a salted scrypt hash. Unlocked devices get a random
// session token in an HttpOnly cookie; only a hash of each token is saved.
const SESSION_DAYS = 90;
const COOKIE = 'mq_session';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const pinSet = () => !!db.auth?.pinHash;

function hashPin(pin, salt) { return crypto.scryptSync(pin, salt, 32).toString('hex'); }
function checkPin(pin) {
  if (!pinSet() || typeof pin !== 'string') return false;
  const a = Buffer.from(hashPin(pin, db.auth.salt), 'hex'), b = Buffer.from(db.auth.pinHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function validPin(pin) {
  if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'PIN must be 4–8 digits');
  return pin;
}
function cookieToken(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`));
  return m ? m[1] : null;
}
function pruneSessions() {
  const cutoff = Date.now() - SESSION_DAYS * 864e5;
  db.auth = db.auth || {};
  db.auth.sessions = (db.auth.sessions || []).filter(s => s.created > cutoff);
}
// Which person is this device signed in as? Each person's file holds their own device sessions.
// With only one person and no PIN, everyone is that person (how the app worked before profiles).
function resolveProfile(req) {
  const t = cookieToken(req);
  if (t) {
    const h = sha(t), cutoff = Date.now() - SESSION_DAYS * 864e5;
    for (const p of profiles.values()) {
      if ((p.db.auth?.sessions || []).some(s => s.hash === h && s.created > cutoff)) return p;
    }
  }
  if (profiles.size === 1) {
    const only = mainProfile();
    if (!only.db.auth?.pinHash) return only;
  }
  return null;
}
function newSession(res) {
  const token = crypto.randomBytes(32).toString('hex');
  pruneSessions();
  db.auth.sessions.push({ hash: sha(token), created: Date.now() });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}
function endSession(req, res) {
  const t = cookieToken(req);
  if (t && db.auth) db.auth.sessions = (db.auth.sessions || []).filter(s => s.hash !== sha(t));
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

// Tailscale Serve proxies from 127.0.0.1, so use the forwarded address to tell devices apart.
function clientIp(req) {
  const direct = req.socket.remoteAddress || '';
  const fwd = req.headers['x-forwarded-for'];
  const isLoopback = direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1';
  return isLoopback && fwd ? String(fwd).split(',')[0].trim() : direct;
}

// Slow down PIN guessing: after 5 wrong tries from a device, it gets locked out for a while.
const attempts = new Map();
function guardAttempts(ip) {
  const a = attempts.get(ip);
  if (a && a.until > Date.now()) {
    throw new HttpError(429, `Too many wrong PINs. Try again in ${Math.ceil((a.until - Date.now()) / 1000)}s`);
  }
}
function failAttempt(ip) {
  const a = attempts.get(ip) || { fails: 0, until: 0 };
  a.fails++;
  if (a.fails >= 5) a.until = Date.now() + Math.min(15 * 60, 30 * (a.fails - 4)) * 1000;
  attempts.set(ip, a);
}

// ---------- routes ----------
const routes = [];
// open = reachable without unlocking (only the auth endpoints)
const route = (method, pattern, fn, open = false) => routes.push({ method, re: new RegExp('^' + pattern + '$'), fn, open });

route('GET', '/api/auth/status', (b, p, req) => {
  const who = resolveProfile(req);
  return { authed: !!who, me: who?.id || null, pinSet: who ? !!who.db.auth?.pinHash : false, profiles: profileList() };
}, true);
// Sign in as a person: needs their PIN if they have one.
route('POST', '/api/auth/login', (b, p, req, res) => {
  const target = profiles.get(b.profile) || (profiles.size === 1 ? mainProfile() : null);
  if (!target) throw new HttpError(400, 'Pick who you are');
  useProfile(target);
  if (pinSet()) {
    const ip = clientIp(req);
    guardAttempts(ip);
    if (!checkPin(b.pin)) { failAttempt(ip); throw new HttpError(401, 'Wrong PIN'); }
    attempts.delete(ip);
  }
  newSession(res);
  return { ok: true };
}, true);
route('POST', '/api/auth/logout', (b, p, req, res) => { endSession(req, res); return { ok: true }; }, true);
// Set, change or remove the PIN. Changing or removing needs the current PIN and signs out every other device.
route('POST', '/api/auth/pin', (b, p, req, res) => {
  const ip = clientIp(req);
  if (pinSet()) {
    guardAttempts(ip);
    if (!checkPin(b.currentPin)) { failAttempt(ip); throw new HttpError(401, 'Current PIN is wrong'); }
  }
  if (b.newPin === null || b.newPin === '') {
    db.auth = { sessions: [] };
    newSession(res); // stay signed in on this device
  } else {
    const salt = crypto.randomBytes(16).toString('hex');
    db.auth = { salt, pinHash: hashPin(validPin(b.newPin), salt), sessions: [] };
    newSession(res);
  }
  return { pinSet: pinSet() };
});

route('GET', '/api/data', () => { runAutopay(); return db; });
// cheap check other devices poll to know when to refresh
route('GET', '/api/rev', () => ({ rev }));

// Quickstart: save everything from the setup wizard in one go.
route('POST', '/api/setup', (b) => {
  const s = db.settings;
  if (b.name !== undefined) s.name = str(b.name, 30) || 'Player';
  if (b.currency !== undefined) s.currency = str(b.currency, 4) || '$';
  if (b.monthlyBudget !== undefined) s.monthlyBudget = money(b.monthlyBudget, { allowZero: true });
  if (b.foodBudget !== undefined) s.foodBudget = money(b.foodBudget, { allowZero: true });
  applyRates(s, b);
  s.startBalance = money(b.startBalance || 0, { allowZero: true, allowNegative: true });
  s.balanceAnchor = new Date().toISOString();
  const saved = money(b.saved || 0, { allowZero: true });
  if (saved > 0) db.vault.push({ id: newId(), amount: saved, date: localDate(), createdAt: s.balanceAnchor, initial: true });
  // The wallet balance you just entered already includes today, so auto-logging starts tomorrow.
  // (Bills you pay by hand can still show up as due today.)
  for (const r of (b.recurring || []).slice(0, 60)) {
    const item = cleanRecurring(r);
    if (item.autopay) item.from = addDaysStr(localDate(), 1);
    db.recurring.push(item);
  }
  for (const g of (b.goals || []).slice(0, 30)) {
    const name = str(g.name, 60);
    if (!name) continue;
    db.goals.push({ id: newId(), name, emoji: str(g.emoji, 8) || '🎯', target: money(g.target), deadline: g.deadline ? date(g.deadline) : null, deposits: [], createdAt: new Date().toISOString() });
  }
  for (const w of (b.rewards || []).slice(0, 40)) db.rewards.push(cleanReward(w));
  s.onboarded = true;
  runAutopay();
  return db;
});

route('POST', '/api/transactions', (b) => {
  const t = cleanTransaction(b);
  t.id = newId();
  t.createdAt = new Date().toISOString();
  db.transactions.push(t);
  return db;
});
const notShared = t => { if (t.sharedId) throw new HttpError(400, 'This is a shared expense. Change it in the Shared tab.'); };
route('PUT', '/api/transactions/([\\w-]+)', (b, [id]) => {
  const i = db.transactions.findIndex(t => t.id === id);
  if (i < 0) throw new HttpError(404, 'Transaction not found');
  notShared(db.transactions[i]);
  db.transactions[i] = cleanTransaction(b, db.transactions[i]);
  return db;
});
// Pay yourself first: record what you put aside from a paycheck (0 = skipped this time).
// The money goes into a goal if you pick one, otherwise into the tower vault.
route('POST', '/api/transactions/([\\w-]+)/saved', (b, [id]) => {
  const t = findOr404(db.transactions, id, 'Transaction');
  if (t.type !== 'income') throw new HttpError(400, 'Only paychecks and other income can be saved from');
  if (t.saveDone !== undefined) throw new HttpError(409, 'Already handled');
  const amount = money(b.amount || 0, { allowZero: true });
  if (amount > 0) {
    const dep = { id: newId(), amount, date: localDate(), createdAt: new Date().toISOString(), fromTx: t.id };
    if (b.goalId) findOr404(db.goals, b.goalId, 'Goal').deposits.push(dep);
    else db.vault.push(dep);
  }
  t.saveDone = amount;
  return db;
});
route('DELETE', '/api/transactions/([\\w-]+)', (b, [id]) => {
  notShared(findOr404(db.transactions, id, 'Transaction'));
  db.transactions = db.transactions.filter(t => t.id !== id);
  return db;
});

route('POST', '/api/goals', (b) => {
  const name = str(b.name, 60);
  if (!name) throw new HttpError(400, 'Goal needs a name');
  db.goals.push({
    id: newId(),
    name,
    emoji: str(b.emoji, 8) || '🎯',
    target: money(b.target),
    deadline: b.deadline ? date(b.deadline) : null,
    deposits: [],
    createdAt: new Date().toISOString(),
  });
  return db;
});
route('PUT', '/api/goals/([\\w-]+)', (b, [id]) => {
  const g = findOr404(db.goals, id, 'Goal');
  if (b.name !== undefined) g.name = str(b.name, 60) || g.name;
  if (b.emoji !== undefined) g.emoji = str(b.emoji, 8) || g.emoji;
  if (b.target !== undefined) g.target = money(b.target);
  if (b.deadline !== undefined) g.deadline = b.deadline ? date(b.deadline) : null;
  return db;
});
route('DELETE', '/api/goals/([\\w-]+)', (b, [id]) => {
  findOr404(db.goals, id, 'Goal');
  db.goals = db.goals.filter(g => g.id !== id);
  return db;
});
route('POST', '/api/goals/([\\w-]+)/deposit', (b, [id]) => {
  const g = findOr404(db.goals, id, 'Goal');
  g.deposits.push({ id: newId(), amount: money(b.amount, { allowNegative: true }), date: date(b.date), createdAt: new Date().toISOString() });
  return db;
});

// ---- Wizard Tower vault (savings not tied to a goal) ----
route('POST', '/api/vault', (b) => {
  db.vault.push({ id: newId(), amount: money(b.amount, { allowNegative: true }), date: date(b.date), createdAt: new Date().toISOString() });
  return db;
});

// ---- recurring bills & paydays ----
route('POST', '/api/recurring', (b) => { const r = cleanRecurring(b); db.recurring.push(r); runAutopay(); return db; });
route('PUT', '/api/recurring/([\\w-]+)', (b, [id]) => {
  const i = db.recurring.findIndex(r => r.id === id);
  if (i < 0) throw new HttpError(404, 'Recurring payment not found');
  db.recurring[i] = cleanRecurring(b, db.recurring[i]);
  runAutopay();
  return db;
});
route('DELETE', '/api/recurring/([\\w-]+)', (b, [id]) => {
  findOr404(db.recurring, id, 'Recurring payment');
  db.recurring = db.recurring.filter(r => r.id !== id); // past entries stay in your log
  return db;
});
route('POST', '/api/recurring/([\\w-]+)/pay', (b, [id]) => {
  const r = findOr404(db.recurring, id, 'Recurring payment');
  payRecurring(r, date(b.dueDate), date(b.date), b.amount !== undefined ? money(b.amount) : r.amount, false);
  return db;
});
route('POST', '/api/recurring/([\\w-]+)/skip', (b, [id]) => {
  const r = findOr404(db.recurring, id, 'Recurring payment');
  const d = date(b.dueDate);
  if (!r.skipped.includes(d)) r.skipped.push(d);
  return db;
});

// ---- Reward shop ----
function cleanReward(b, existing = {}) {
  const w = { ...existing };
  if (!existing.id || b.name !== undefined) { w.name = str(b.name, 40); if (!w.name) throw new HttpError(400, 'Reward needs a name'); }
  if (!existing.id || b.emoji !== undefined) w.emoji = str(b.emoji, 8) || '🎁';
  if (!existing.id || b.cost !== undefined) {
    w.cost = Math.round(Number(b.cost));
    if (!(w.cost > 0 && w.cost < 1e6)) throw new HttpError(400, 'Cost must be a positive number of coins');
  }
  // optional: the real money this treat uses (e.g. takeout), logged as a purchase when you activate it
  if (b.spend === null) delete w.spend; // not set: activating logs the whole coin cost
  else if (b.spend !== undefined) w.spend = money(b.spend, { allowZero: true });
  if (b.category !== undefined) w.category = str(b.category, 40) || 'fun';
  w.id = w.id || newId();
  return w;
}
route('POST', '/api/rewards', (b) => { db.rewards.push(cleanReward(b)); return db; });
route('PUT', '/api/rewards/([\\w-]+)', (b, [id]) => {
  const i = db.rewards.findIndex(w => w.id === id);
  if (i < 0) throw new HttpError(404, 'Reward not found');
  db.rewards[i] = cleanReward(b, db.rewards[i]);
  return db;
});
route('DELETE', '/api/rewards/([\\w-]+)', (b, [id]) => { db.rewards = db.rewards.filter(w => w.id !== id); return db; });
route('POST', '/api/rewards/([\\w-]+)/redeem', (b, [id]) => {
  const w = findOr404(db.rewards, id, 'Reward');
  const red = { id: newId(), rewardId: w.id, name: w.name, emoji: w.emoji, cost: w.cost, date: date(b.date), createdAt: new Date().toISOString() };
  // optionally log the real purchase at the same time
  if (b.log) {
    const t = cleanTransaction({ type: 'expense', amount: b.amount ?? w.cost, category: b.category || 'fun', note: `${w.emoji} ${w.name} (reward)`, date: b.date });
    t.id = newId(); t.createdAt = red.createdAt; t.rewardId = red.id;
    db.transactions.push(t);
  }
  db.redemptions.push(red);
  return db;
});
// undo: gives the coins back and removes the purchase it logged, if any
route('DELETE', '/api/redemptions/([\\w-]+)', (b, [id]) => {
  db.redemptions = db.redemptions.filter(x => x.id !== id);
  db.transactions = db.transactions.filter(t => t.rewardId !== id);
  return db;
});

route('POST', '/api/checkins', (b) => {
  const d = date(b.date);
  if (!db.checkins.includes(d)) db.checkins.push(d);
  return db;
});
route('DELETE', '/api/checkins/(\\d{4}-\\d{2}-\\d{2})', (b, [d]) => {
  db.checkins = db.checkins.filter(x => x !== d);
  return db;
});

// Wipe everything you've added (entries, goals, no-spend days, tower, bills, rewards) and show the
// quickstart again. Name, budgets, categories and PIN are kept.
// A copy of everything is saved to data\backups\reset-<time>.json first, just in case.
route('POST', '/api/reset', (b, p, req) => {
  if (b.confirm !== 'RESET') throw new HttpError(400, 'Type RESET to confirm');
  if (pinSet()) {
    const ip = clientIp(req);
    guardAttempts(ip);
    if (!checkPin(b.pin)) { failAttempt(ip); throw new HttpError(401, 'Wrong PIN'); }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(BACKUP_DIR, `reset-${stamp}.json`), JSON.stringify(db, null, 2));
  for (const k of ['transactions', 'goals', 'checkins', 'vault', 'recurring', 'rewards', 'redemptions']) db[k] = [];
  Object.assign(db.settings, { onboarded: false, startBalance: 0, balanceAnchor: null });
  return db;
});

route('PUT', '/api/settings', (b) => {
  const s = db.settings;
  if (b.name !== undefined) s.name = str(b.name, 30) || 'Player';
  if (b.currency !== undefined) s.currency = str(b.currency, 4) || '$';
  if (b.monthlyBudget !== undefined) s.monthlyBudget = money(b.monthlyBudget, { allowZero: true });
  if (b.foodBudget !== undefined) s.foodBudget = money(b.foodBudget, { allowZero: true });
  if (Array.isArray(b.categories)) {
    s.categories = b.categories.slice(0, 60).map(c => ({
      id: str(c.id, 40) || newId(),
      name: str(c.name, 30) || 'Category',
      emoji: str(c.emoji, 8) || '📦',
      type: c.type === 'income' ? 'income' : 'expense',
      food: !!c.food,
      kind: KINDS.includes(c.kind) ? c.kind : 'want',
    }));
  }
  if (b.onboarded !== undefined) s.onboarded = !!b.onboarded;
  if (b.autoSave !== undefined) s.autoSave = !!b.autoSave; // put the suggested amount aside on every paycheck without asking
  applyRates(s, b);
  // setting your wallet balance: entries logged from now on move it up and down
  if (b.startBalance !== undefined) {
    s.startBalance = money(b.startBalance, { allowZero: true, allowNegative: true });
    s.balanceAnchor = new Date().toISOString();
  }
  return db;
});

// ---- people ----
// Add someone (e.g. your partner). They pick their name on their own device, run the
// quickstart and can set their own PIN. Their personal data stays separate from yours.
route('POST', '/api/profiles', (b) => {
  const name = str(b.name, 30);
  if (!name) throw new HttpError(400, 'Give them a name');
  if (profiles.size >= MAX_PROFILES) throw new HttpError(400, 'That is the maximum number of people');
  if (profileList().some(x => x.name.toLowerCase() === name.toLowerCase())) throw new HttpError(400, 'Someone already has that name');
  const id = newId(), p = { id, file: `profile-${id}.json`, db: defaultDb() };
  p.db.settings.name = name;
  profiles.set(id, p);
  withProfile(p, save);
  saveIndex();
  return db;
});

// ---- shared expenses (Splitwise style) ----
// Each shared expense records who paid and how much of it is each person's share.
// Everyone's share is also logged in their own books (so it counts in their budget),
// tagged with sharedId so it stays in sync and can only be changed here.
const involved = e => e.paidBy === current.id || Object.keys(e.shares).includes(current.id);
route('POST', '/api/shared', (b) => {
  const amount = money(b.amount);
  if (!profiles.has(b.paidBy)) throw new HttpError(400, 'Who paid?');
  const shares = {};
  for (const [id, v] of Object.entries(b.shares || {})) {
    if (!profiles.has(id)) throw new HttpError(400, 'Unknown person in the split');
    const m = money(v, { allowZero: true });
    if (m > 0) shares[id] = m;
  }
  const total = Math.round(Object.values(shares).reduce((a, x) => a + x, 0) * 100) / 100;
  if (Math.abs(total - amount) > 0.011) throw new HttpError(400, 'The split has to add up to the total');
  if (!Object.keys(shares).concat(b.paidBy).includes(current.id)) throw new HttpError(400, 'You must be part of the expense');
  const e = {
    id: newId(), amount, paidBy: b.paidBy, shares, note: str(b.note, 140) || 'Shared expense',
    category: str(b.category, 40) || 'other', date: date(b.date), createdBy: current.id, createdAt: new Date().toISOString(),
  };
  shared.expenses.push(e);
  for (const [id, share] of Object.entries(shares)) withProfile(profiles.get(id), () => {
    db.transactions.push({ id: newId(), type: 'expense', amount: share, category: e.category, note: `👥 ${e.note}`, date: e.date, sharedId: e.id, createdAt: e.createdAt });
    save();
  });
  saveShared();
  return db;
});
route('DELETE', '/api/shared/([\\w-]+)', (b, [id]) => {
  const e = findOr404(shared.expenses, id, 'Shared expense');
  if (!involved(e)) throw new HttpError(403, "That expense isn't yours");
  shared.expenses = shared.expenses.filter(x => x.id !== id);
  for (const p of profiles.values()) withProfile(p, () => {
    const n = db.transactions.length;
    db.transactions = db.transactions.filter(t => t.sharedId !== id);
    if (db.transactions.length !== n) save();
  });
  saveShared();
  return db;
});
// Settle up: record money one person paid the other back.
route('POST', '/api/settlements', (b) => {
  if (!profiles.has(b.from) || !profiles.has(b.to) || b.from === b.to) throw new HttpError(400, 'Who paid whom?');
  if (![b.from, b.to].includes(current.id)) throw new HttpError(400, 'You must be one of the two people');
  shared.settlements.push({ id: newId(), from: b.from, to: b.to, amount: money(b.amount), note: str(b.note, 140), date: date(b.date), createdBy: current.id, createdAt: new Date().toISOString() });
  saveShared();
  return db;
});
route('DELETE', '/api/settlements/([\\w-]+)', (b, [id]) => {
  const s = findOr404(shared.settlements, id, 'Payment');
  if (![s.from, s.to].includes(current.id)) throw new HttpError(403, "That payment isn't yours");
  shared.settlements = shared.settlements.filter(x => x.id !== id);
  saveShared();
  return db;
});

function csvExport() {
  const cats = Object.fromEntries(db.settings.categories.map(c => [c.id, c.name]));
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['date', 'type', 'category', 'amount', 'note']];
  [...db.transactions].sort((a, b) => a.date.localeCompare(b.date))
    .forEach(t => rows.push([t.date, t.type, cats[t.category] || t.category, t.amount, t.note]));
  return rows.map(r => r.map(esc).join(',')).join('\r\n');
}

// ---------- Meadow link (read-only) ----------
// Meadow, your life app on this same PC, asks for a short summary here: wallet, safe to spend,
// upcoming bills and paydays, this month's spending and your goals. It only answers programs on
// this PC (not phones, not Tailscale, not the internet) and it never changes anything.
function linkFromThisPcOnly(req) {
  const loop = /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress || '');
  const proxied = Object.keys(req.headers).some(h => h.startsWith('x-forwarded') || h.startsWith('tailscale-') || h.startsWith('cf-') || h === 'forwarded');
  return loop && !proxied;
}
function lifeLinkSummary() {
  return withProfile(mainProfile(), () => {
    const s = db.settings, t = localDate(), sumOf = a => a.reduce((x, y) => x + (Number(y) || 0), 0);
    // wallet: the balance you entered, moved by everything logged after it (same rule as the app)
    let wallet = null;
    if (s.balanceAnchor) {
      const after = x => (x.createdAt || '') >= s.balanceAnchor;
      wallet = s.startBalance;
      for (const x of db.transactions) if (after(x)) wallet += x.type === 'income' ? x.amount : -x.amount;
      for (const v of db.vault) if (!v.initial && after(v)) wallet -= v.amount;
      for (const g of db.goals) for (const d of g.deposits || []) if (after(d)) wallet -= d.amount;
      const me = current.id;
      for (const e of shared.expenses || []) { if ((e.createdAt || '') < s.balanceAnchor) continue; const mine = (e.shares || {})[me] || 0; wallet += e.paidBy === me ? -(e.amount - mine) : mine; }
      for (const x of shared.settlements || []) { if ((x.createdAt || '') < s.balanceAnchor) continue; if (x.from === me) wallet -= x.amount; if (x.to === me) wallet += x.amount; }
    }
    const open = (r, due) => !isLogged(r, due) && !(r.skipped || []).includes(due);
    const upcoming = [];
    for (const r of db.recurring) {
      for (const due of occurrences(r, r.autopay ? addDaysStr(t, 1) : addDaysStr(t, -14), addDaysStr(t, 62))) {
        if (open(r, due)) upcoming.push({ id: r.id, name: r.name, type: r.type, amount: r.amount, variable: !!r.variable, autopay: !!r.autopay, due });
      }
    }
    upcoming.sort((a, b) => a.due.localeCompare(b.due));
    const nextPayday = upcoming.find(u => u.type === 'income' && u.due > t)?.due || null;
    const until = nextPayday || addDaysStr(t, 14);
    const keep = sumOf(upcoming.filter(u => u.type === 'expense' && u.due < until).map(u => u.amount));
    const ym = t.slice(0, 7);
    const monthSpent = sumOf(db.transactions.filter(x => x.type === 'expense' && (x.date || '').startsWith(ym)).map(x => x.amount));
    const goals = db.goals.map(g => ({ name: g.name, emoji: g.emoji, saved: sumOf((g.deposits || []).map(d => d.amount)), target: g.target, deadline: g.deadline || null }))
      .filter(g => g.saved < g.target).slice(0, 5);
    return {
      app: 'money-quest', at: new Date().toISOString(), name: s.name, currency: s.currency || '$',
      wallet, safeToSpend: wallet == null ? null : wallet - keep, keepForBills: keep, nextPayday,
      month: { spent: monthSpent, budget: s.monthlyBudget || 0 },
      upcoming, goals,
    };
  });
}

// ---------- http ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) { reject(new HttpError(413, 'Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  if (type !== 'application/json') return res.end(body);
  // never send PIN hashes or session hashes to the browser. Along with your own data you get
  // the shared ledger and everyone's names (never anyone else's personal data).
  res.end(JSON.stringify(body === db ? { ...db, auth: undefined, me: current.id, profiles: profileList(), shared } : body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  // Safety net: this app is meant to be private. If Tailscale Funnel (public internet) is ever
  // switched on for it, refuse those requests. Set ALLOW_PUBLIC=1 to override.
  if (req.headers['tailscale-funnel-request'] && process.env.ALLOW_PUBLIC !== '1') {
    return send(res, 403, 'Money Quest is private. Open it from a device signed in to your Tailscale account.', 'text/plain');
  }
  if (p === '/api/link/summary' && req.method === 'GET') {
    if (!linkFromThisPcOnly(req)) return send(res, 403, { error: 'Only apps on this PC can read this.' });
    try { return send(res, 200, lifeLinkSummary()); } catch (e) { console.error(e); return send(res, 500, { error: 'Summary failed' }); }
  }
  try {
    const who = p.startsWith('/api/') ? resolveProfile(req) : null;
    useProfile(who || mainProfile());
    if (p === '/api/export.csv') {
      if (!who) throw new HttpError(401, 'Locked');
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="money-quest.csv"' });
      return res.end('﻿' + csvExport());
    }
    if (p.startsWith('/api/')) {
      const r = routes.find(r => r.method === req.method && r.re.test(p));
      if (!r) throw new HttpError(404, 'Not found');
      if (!r.open && !who) throw new HttpError(401, 'Locked');
      const body = req.method === 'GET' ? {} : await readBody(req);
      const result = r.fn(body, p.match(r.re).slice(1), req, res);
      if (req.method !== 'GET') save();
      return send(res, 200, result);
    }
    // static files
    const file = path.normalize(path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(res, 404, 'Not found', 'text/plain');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.status || 500, { error: e.message || 'Server error' });
  }
});

load();
runAutopay();
setInterval(runAutopay, 10 * 60 * 1000); // check for due auto-payments every 10 minutes
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log(`\n  Money Quest is already running. Open http://localhost:${PORT}\n`);
    process.exit(2); // background.bat sees 2 and doesn't start a second copy
  }
  throw e;
});
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  💰 Money Quest is running!\n');
  console.log(`  On this computer:  http://localhost:${PORT}`);
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  On your phone:     http://${a.address}:${PORT}   (${name})`);
    }
  }
  require('child_process').execFile('tailscale', ['status', '--json'], { timeout: 4000, windowsHide: true }, (err, out) => {
    let host = null;
    try { host = JSON.parse(out).Self.DNSName.replace(/\.$/, ''); } catch {}
    if (host) console.log(`\n  From anywhere:     https://${host}:${TS_PORT}   (phone needs the Tailscale app, same account)`);
    else console.log('\n  (Tailscale not found, so the app is only reachable on your Wi-Fi.)');
    console.log('\n  Data is saved in data\\money.json');
    console.log('  Press Ctrl+C to stop.\n');
  });
});
