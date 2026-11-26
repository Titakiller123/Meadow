// Meadow app. Everything is saved on this device first and synced with your PC when it can reach it.
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const ic = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const COLLS = ['tasks', 'events', 'lists', 'done', 'settings', 'feeds', 'apps', 'projects', 'debts'];
  const LS = 'meadow-v1';

  // ---------- dates (all as local 'YYYY-MM-DD') ----------
  const pad = n => String(n).padStart(2, '0');
  const ds = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const pd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const today = () => ds(new Date());
  const addDays = (s, n) => { const d = pd(s); d.setDate(d.getDate() + n); return ds(d); };
  const diffDays = (a, b) => Math.round((pd(b) - pd(a)) / 864e5);
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WDL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function dayLabel(s) {
    const n = diffDays(today(), s);
    if (n === 0) return 'Today';
    if (n === 1) return 'Tomorrow';
    if (n === -1) return 'Yesterday';
    const d = pd(s);
    if (n > 1 && n < 7) return WDL[d.getDay()];
    return `${WD[d.getDay()]}, ${MON[d.getMonth()].slice(0, 3)} ${d.getDate()}${d.getFullYear() !== new Date().getFullYear() ? ', ' + d.getFullYear() : ''}`;
  }
  const shortDay = s => { const n = diffDays(today(), s); if (n === 0) return 'Today'; if (n === 1) return 'Tomorrow'; const d = pd(s); return n > 1 && n < 7 ? WD[d.getDay()] : `${MON[d.getMonth()].slice(0, 3)} ${d.getDate()}`; };
  function timeLabel(t) {
    if (!t || !/^\d{1,2}:\d{2}/.test(t)) return t || '';
    const [h, m] = t.split(':').map(Number);
    return `${((h + 11) % 12) + 1}${m ? ':' + pad(m) : ''} ${h < 12 ? 'AM' : 'PM'}`;
  }
  const weekStart = s => addDays(s, -pd(s).getDay()); // weeks start on Sunday

  // repeats: daily | weekdays | weekly | biweekly | monthly | yearly
  const REPEATS = [['', 'Does not repeat'], ['daily', 'Every day'], ['weekdays', 'Every weekday (Mon to Fri)'], ['weekly', 'Every week'], ['biweekly', 'Every 2 weeks'], ['monthly', 'Every month'], ['yearly', 'Every year']];
  function nextDate(s, rep) {
    const d = pd(s);
    if (rep === 'daily') d.setDate(d.getDate() + 1);
    else if (rep === 'weekdays') { do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6); }
    else if (rep === 'weekly') d.setDate(d.getDate() + 7);
    else if (rep === 'biweekly') d.setDate(d.getDate() + 14);
    else if (rep === 'monthly') { const day = pd(s).getDate(); d.setDate(1); d.setMonth(d.getMonth() + 1); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); }
    else if (rep === 'yearly') d.setFullYear(d.getFullYear() + 1);
    else return null;
    return ds(d);
  }
  function occursOn(ev, s) {
    if (ev.skip && ev.skip.includes(s)) return false;
    if (!ev.repeat) return ev.date === s;
    if (s < ev.date || (ev.until && s > ev.until)) return false;
    const a = pd(ev.date), b = pd(s), n = diffDays(ev.date, s);
    switch (ev.repeat) {
      case 'daily': return true;
      case 'weekdays': return b.getDay() > 0 && b.getDay() < 6;
      case 'weekly': return n % 7 === 0;
      case 'biweekly': return n % 14 === 0;
      case 'monthly': { const last = new Date(b.getFullYear(), b.getMonth() + 1, 0).getDate(); return b.getDate() === Math.min(a.getDate(), last); }
      case 'yearly': return a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    }
    return false;
  }

  // ---------- local store + sync ----------
  let S = { db: {}, rev: 0, outbox: [], links: {}, cals: {} };
  try { S = Object.assign(S, JSON.parse(localStorage.getItem(LS) || '{}')); } catch {}
  for (const c of COLLS) S.db[c] = S.db[c] || {};
  S.links = S.links || {}; S.cals = S.cals || {};
  const persist = () => { try { localStorage.setItem(LS, JSON.stringify(S)); } catch {} };

  function put(coll, item) {
    item.updatedAt = Date.now();
    S.db[coll][item.id] = item;
    S.outbox.push({ coll, item });
    persist(); render(); soon();
    return item;
  }
  const del = (coll, id) => put(coll, { id, deleted: true });
  const all = coll => Object.values(S.db[coll]).filter(x => !x.deleted);
  const get = (coll, id) => { const x = S.db[coll][id]; return x && !x.deleted ? x : null; };

  let syncState = 'idle', syncing = false, again = false, timer = null, calsDirty = false;
  const soon = () => { clearTimeout(timer); timer = setTimeout(sync, 400); };
  async function sync() {
    if (syncing) { again = true; return; }
    syncing = true; syncState = 'busy'; drawSync();
    const sending = S.outbox.slice(0, 2000);
    try {
      const r = await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ since: S.rev, changes: sending }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      S.outbox.splice(0, sending.length);
      const pending = new Set(S.outbox.map(o => o.coll + '/' + o.item.id));
      let changed = false;
      for (const { coll, item } of j.changes) {
        if (!S.db[coll] || pending.has(coll + '/' + item.id)) continue;
        const cur = S.db[coll][item.id];
        if (cur && cur._rev === item._rev && cur.updatedAt === item.updatedAt) continue;
        if (cur && !cur._rev && (cur.updatedAt || 0) > (item.updatedAt || 0)) continue;
        S.db[coll][item.id] = item; changed = true;
      }
      S.rev = j.rev; syncState = 'ok'; persist();
      if (changed) render();
      if (calsDirty) { calsDirty = false; refreshCals(true); refreshLinks(true); }
    } catch { syncState = 'offline'; }
    syncing = false; drawSync();
    if (again) { again = false; soon(); }
  }
  function drawSync() {
    const b = $('#sync'), pending = S.outbox.length;
    b.className = 'sync ' + (syncState === 'offline' ? 'offline' : syncState === 'busy' ? 'busy' : '');
    const label = syncState === 'offline' ? (pending ? `Offline · ${pending} to sync` : 'Offline') : syncState === 'busy' ? 'Syncing' : 'Saved';
    b.innerHTML = `<span class="dot"></span><span class="slbl">${label}</span>`; b.setAttribute('aria-label', label); b.title = label;
  }

  // ---------- your other apps and calendars (read-only, through your PC) ----------
  let linksBusy = false, calsBusy = false;
  const rerender = () => { if ($('#sheet').hidden && !document.activeElement?.matches?.('input,textarea,select')) render(); };
  async function refreshLinks(force) {
    if (linksBusy) return; linksBusy = true;
    try {
      const r = await fetch('/api/links' + (force ? '?force=1' : ''));
      if (r.ok) { const j = await r.json(); const before = JSON.stringify(S.links); S.links = j; persist(); if (JSON.stringify(j) !== before) rerender(); }
    } catch {}
    linksBusy = false;
  }
  async function refreshCals(force) {
    if (calsBusy) return; calsBusy = true;
    try {
      const r = await fetch('/api/calendars' + (force ? '?force=1' : ''));
      if (r.ok) { const j = await r.json(); const before = JSON.stringify(S.cals); S.cals = j; persist(); if (JSON.stringify(j) !== before) rerender(); }
    } catch {}
    calsBusy = false;
  }
  const money = () => (S.links.money && S.links.money.data) || null;
  const dice = () => (S.links.dice && S.links.dice.data) || null;
  const feeds = () => all('feeds').sort((a, b) => (a.created || 0) - (b.created || 0));
  const customApps = () => all('apps').sort((a, b) => (a.created || 0) - (b.created || 0));
  // the address of each app, from wherever you opened Meadow (this PC, Wi-Fi or Tailscale)
  function appUrl(which) {
    const h = location.hostname, local = h === 'localhost' || h === '127.0.0.1', ts = h.endsWith('.ts.net');
    if (typeof which === 'object') return local ? `http://localhost:${which.port}` : ts && which.tsPort ? `https://${h}:${which.tsPort}` : `http://${h}:${which.port}`;
    if (which === 'money') return local ? 'http://localhost:3100' : ts ? `https://${h}:8443` : `http://${h}:3100`;
    return local ? 'http://localhost:3000' : ts ? `https://${h}` : `http://${h}:3000`;
  }
  function fmtMoney(n, cur) {
    if (settings().hideAmounts) return '•••';
    if (n == null || isNaN(n)) return '–';
    const neg = n < 0, v = Math.abs(n);
    return (neg ? '−' : '') + (cur || '$') + v.toLocaleString(undefined, { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function ago(t) {
    if (!t) return '';
    const m = Math.round((Date.now() - t) / 6e4);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    if (m < 60 * 20) return `${Math.round(m / 60)} h ago`;
    return new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  // bills, paydays, game sessions, your other apps' dates and calendar feeds on a given day
  function linkItemsOn(day) {
    const out = [], s = settings(), m = money(), d = dice();
    if (m && s.showMoney !== false) for (const u of m.upcoming || []) if (u.due === day) out.push({ kind: u.type === 'income' ? 'pay' : 'bill', title: u.name, sub: u.type === 'income' ? (u.variable ? 'Payday · Money Quest' : `Payday · ${fmtMoney(u.amount, m.currency)}`) : `Bill · ${fmtMoney(u.amount, m.currency)}${u.autopay ? ' · pays itself' : ''}`, app: 'money' });
    if (d && s.showGames !== false) for (const c of visibleCamps()) if (c.next && c.next.date === day) out.push({ kind: 'game', title: c.name, sub: ['Game session', c.next.note].filter(Boolean).join(' · '), time: c.next.time, app: 'dice' });
    for (const d of openDebts()) if (dueOn(d, day)) out.push({ kind: 'debt', title: d.name, sub: `Payment due${d.min ? ' · min ' + fmtMoney(+d.min, cur()) : ''} · Debts`, debt: d.id });
    for (const a of customApps()) {
      const L = (S.links.apps || {})[a.id];
      if (a.on === false || !L || !L.data || !Array.isArray(L.data.events)) continue;
      for (const e of L.data.events) if (e && e.date === day) out.push({ kind: 'app', title: String(e.title || ''), sub: [e.sub, a.name].filter(Boolean).join(' · '), time: e.time, app: a, color: a.color });
    }
    for (const f of feeds()) {
      const C = S.cals[f.id];
      if (f.on === false || !C || !C.events) continue;
      for (const e of C.events) if (e.date === day || (e.endDate && e.date <= day && day <= e.endDate)) {
        out.push({ kind: 'feed', title: e.title, sub: [e.end ? `Until ${timeLabel(e.end)}` : '', e.location, f.name || C.calName].filter(Boolean).join(' · '), time: e.allDay ? '' : e.start, allDay: e.allDay, color: f.color, feed: f.id });
      }
    }
    return out;
  }
  function visibleCamps() {
    const d = dice(); if (!d) return [];
    const hidden = settings().hiddenCamps;
    return d.camps.filter(c => hidden ? !hidden.includes(c.id) : (c.next || c.players >= 2));
  }

  // ---------- settings + lists ----------
  const LIST_ICONS = ['inbox', 'home', 'book', 'heart', 'briefcase', 'cart', 'dumbbell', 'dice', 'palette', 'wrench', 'leaf', 'paw', 'plane', 'bulb', 'wallet', 'target'];
  const EMOJI_TO_ICON = { '📥': 'inbox', '🏡': 'home', '📚': 'book', '🌸': 'heart', '💼': 'briefcase', '🛒': 'cart', '💪': 'dumbbell', '🎲': 'dice', '🎨': 'palette', '🧹': 'home', '🔧': 'wrench', '🌿': 'leaf', '🐾': 'paw', '✈️': 'plane', '💡': 'bulb', '❤️': 'heart' };
  const DEFAULT_LISTS = [
    { id: 'inbox', name: 'Inbox', icon: 'inbox', color: '#7d776a', order: 0 },
    { id: 'home', name: 'House', icon: 'home', color: '#b0704a', order: 1 },
    { id: 'school', name: 'School', icon: 'book', color: '#4a6fb8', order: 2 },
    { id: 'personal', name: 'Personal', icon: 'heart', color: '#b5506a', order: 3 },
  ];
  const COLORS = ['#3f6f36', '#2f7a8c', '#4a6fb8', '#7a5cc0', '#b5506a', '#b8553a', '#b0704a', '#b08a2e', '#7d776a'];
  const THEMES = [
    { id: 'sunrise', name: 'Sunrise', note: 'Warm paper, amber and green', c: ['#fbf8f1', '#a9cf86', '#d97706'] },
    { id: 'meadow', name: 'Meadow', note: 'Soft greens and cream', c: ['#f5f2ea', '#9fcb7e', '#3f6f36'] },
    { id: 'seaside', name: 'Seaside', note: 'Sea breeze and sand', c: ['#eff3f4', '#8cc3d6', '#235f7a'] },
    { id: 'blossom', name: 'Blossom', note: 'Spring petals', c: ['#f8f1f0', '#f2c4cc', '#9c3f58'] },
    { id: 'firefly', name: 'Firefly night', note: 'Dark and calm', c: ['#16192a', '#3f6457', '#e9c96b'] },
  ];
  function settings() {
    return Object.assign({ name: '', buddy: 'Pip', theme: 'light', sound: true, cozy: false, showMoney: true, showGames: true, hideAmounts: false, hiddenCamps: null }, get('settings', 'main') || {});
  }
  function setSetting(k, v) { const s = Object.assign({ id: 'main' }, get('settings', 'main') || {}); s[k] = v; put('settings', s); }
  function lists() {
    const have = all('lists');
    const ids = new Set(Object.keys(S.db.lists));
    for (const l of DEFAULT_LISTS) if (!ids.has(l.id)) have.push(l); // defaults have fixed ids, so devices never duplicate them
    return have.map(l => ({ ...l, icon: l.icon || EMOJI_TO_ICON[l.emoji] || 'leaf' })).sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  }
  const listOf = id => lists().find(l => l.id === id) || lists()[0];

  // ---------- tasks ----------
  const openTasks = () => all('tasks').filter(t => !t.done);
  function sortTasks(a, b) {
    const pr = { high: 0, normal: 1, low: 2 };
    return (a.due || '9999').localeCompare(b.due || '9999') || (a.time || '99').localeCompare(b.time || '99') || (pr[a.priority || 'normal'] - pr[b.priority || 'normal']) || (a.created || 0) - (b.created || 0);
  }
  function completeTask(id, el) {
    const t = get('tasks', id);
    if (!t) return;
    const before = JSON.parse(JSON.stringify(t));
    const rec = { id: uid(), taskId: t.id, title: t.title, day: today(), at: Date.now(), plant: ART.PLANTS[Math.floor(Math.random() * ART.PLANTS.length)] };
    fresh = rec.id;
    put('done', rec);
    let msg = settings().cozy ? 'Done. A new flower is growing.' : 'Done.';
    if (t.repeat && t.due) {
      let n = nextDate(t.due, t.repeat);
      while (n <= today()) n = nextDate(n, t.repeat);
      t.due = n;
      (t.checklist || []).forEach(c => (c.done = false));
      msg = `Done. Next one: ${dayLabel(n)}`;
    } else { t.done = true; t.doneAt = Date.now(); }
    put('tasks', t);
    petals(el);
    chime();
    buddyLine = cheer();
    toast(msg, () => { put('tasks', before); del('done', rec.id); });
  }
  function uncompleteTask(id) {
    const t = get('tasks', id); if (!t) return;
    t.done = false; delete t.doneAt; put('tasks', t);
    const recs = all('done').filter(d => d.taskId === id).sort((a, b) => b.at - a.at);
    if (recs[0]) del('done', recs[0].id);
  }

  // quick add: "call mom tomorrow", "essay due fri !", "laundry today"
  function parseQuick(text) {
    let title = text.trim(), due = '', priority = 'normal';
    if (/(^|\s)!+$/.test(title) || /(^|\s)!high$/i.test(title)) { priority = 'high'; title = title.replace(/\s*!+(high)?$/i, ''); }
    const rules = [
      [/\s+(today|tonight|tdy)$/i, () => today()],
      [/\s+(tomorrow|tmr|tmrw)$/i, () => addDays(today(), 1)],
      [/\s+next week$/i, () => addDays(today(), 7)],
    ];
    for (const [re, f] of rules) if (re.test(title)) { due = f(); title = title.replace(re, ''); break; }
    if (!due) {
      const m = title.match(/\s+(?:on\s+)?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|urday|sday)?$/i);
      if (m) {
        const target = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(m[1].slice(0, 3).toLowerCase());
        let d = addDays(today(), 1); while (pd(d).getDay() !== target) d = addDays(d, 1);
        due = d; title = title.slice(0, m.index);
      }
    }
    return { title: title.trim() || text.trim(), due, priority };
  }
  function addTask(fields) {
    return put('tasks', Object.assign({ id: uid(), title: '', notes: '', list: 'inbox', due: '', time: '', priority: 'normal', repeat: '', checklist: [], done: false, created: Date.now() }, fields));
  }

  // ---------- garden ----------
  let fresh = null, buddyLine = null;
  const doneOn = day => all('done').filter(d => d.day === day);
  function streak() {
    const days = new Set(all('done').map(d => d.day));
    let s = today(), n = 0;
    if (!days.has(s)) s = addDays(s, -1); // today still counts as "not yet"
    while (days.has(s)) { n++; s = addDays(s, -1); }
    return n;
  }
  function weekPlants() {
    const ws = weekStart(today());
    return all('done').filter(d => d.day >= ws).sort((a, b) => a.at - b.at).map(d => ({ id: d.id, plant: d.plant, fresh: d.id === fresh }));
  }
  function mood() {
    const h = new Date().getHours();
    const n = doneOn(today()).length, left = dueToday().length + overdue().length;
    if (h >= 22 || h < 6) return 'sleepy';
    if (n > 0 && left === 0) return 'proud';
    if (n > 0) return 'happy';
    return 'calm';
  }
  function cheer() {
    const n = doneOn(today()).length + 1;
    const lines = [`That's ${n} done today. Nice work.`, 'One less thing on your mind.', 'Steady progress. Keep going.', 'Small wins add up.', 'Another flower for the garden.'];
    if (dueToday().length + overdue().length <= 1) lines.push('Almost caught up for today.');
    return lines[Math.floor(Math.random() * lines.length)];
  }
  function buddySays() {
    if (buddyLine) return buddyLine;
    const s = settings(), h = new Date().getHours(), name = s.name ? `, ${s.name}` : '';
    const od = overdue().length, dt = dueToday().length, ev = eventsOn(today()).length + linkItemsOn(today()).length;
    if (h >= 22 || h < 6) return doneOn(today()).length ? 'Good work today. Time to rest.' : 'It\'s late. Tomorrow is a fresh start.';
    if (!all('tasks').length && !all('events').length) return `Hi${name}. Tap + to add your first task.`;
    if (od) return `${od} task${od > 1 ? 's' : ''} carried over. Start with the easiest one?`;
    if (dt) return `${dt} task${dt > 1 ? 's' : ''} for today${ev ? ` and ${ev} thing${ev > 1 ? 's' : ''} on the calendar` : ''}.`;
    if (ev) return `No tasks due. ${ev} thing${ev > 1 ? 's' : ''} on the calendar today.`;
    return `Nothing due today${name}. A calm day.`;
  }

  // ---------- events ----------
  function eventsOn(day) {
    return all('events').filter(e => occursOn(e, day)).sort((a, b) => (a.allDay ? '00' : a.start || '99').localeCompare(b.allDay ? '00' : b.start || '99'));
  }
  const overdue = () => openTasks().filter(t => t.due && t.due < today()).sort(sortTasks);
  const dueToday = () => openTasks().filter(t => t.due === today()).sort(sortTasks);

  // ---------- projects (house projects, school projects, anything with several steps) ----------
  const STATUSES = [['active', 'In progress'], ['planned', 'Planned'], ['paused', 'On hold'], ['done', 'Finished']];
  const projects = () => all('projects').sort((a, b) => (a.target || '9999').localeCompare(b.target || '9999') || (a.created || 0) - (b.created || 0));
  const projTasks = id => all('tasks').filter(t => t.project === id);
  function projStats(p) {
    const ts = projTasks(p.id), done = ts.filter(t => t.done).length;
    const next = ts.filter(t => !t.done).sort(sortTasks)[0] || null;
    return { total: ts.length, done, pct: ts.length ? Math.round(done / ts.length * 100) : 0, next };
  }
  const statusTag = st => `<span class="tag ${{ active: 'blue', planned: '', paused: 'warn', done: 'good' }[st] || ''}">${esc((STATUSES.find(x => x[0] === st) || STATUSES[1])[1])}</span>`;

  // ---------- rendering ----------
  const PAGES = ['home', 'tasks', 'calendar', 'projects', 'money', 'debts', 'games', 'connections', 'settings', 'more'];
  let tab = { today: 'home', me: 'settings' }[location.hash.slice(1)] || location.hash.slice(1) || 'home';
  if (!PAGES.includes(tab)) tab = 'home';
  let listFilter = 'all', showDone = false, calMonth = today().slice(0, 7), calSel = today(), projOpen = null;

  function greet() {
    const h = new Date().getHours(), n = settings().name;
    const g = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    return g + (n ? `, ${esc(n)}` : '');
  }
  function themeMode() {
    const t = settings().theme;
    if (t === 'auto') return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    return t === 'dark' || t === 'firefly' ? 'dark' : 'light';
  }
  const NAV = [
    ['home', 'grid', 'Home'], ['tasks', 'check', 'Tasks'], ['calendar', 'cal', 'Calendar'], ['projects', 'folder', 'Projects'],
    ['money', 'wallet', 'Money'], ['debts', 'receipt', 'Debts'], ['games', 'dice', 'Game nights'], ['connections', 'link', 'Connections'], ['settings', 'gear', 'Settings'],
  ];
  function drawSide() {
    const counts = { tasks: dueToday().length + overdue().length || '', projects: projects().filter(p => p.status === 'active').length || '', debts: openDebts().length || '' };
    $('#side').innerHTML = `<div class="brand"><img src="/icon.svg" alt="">Meadow</div>
      <button class="add" data-act="add">${ic('plus', 's')}New</button>
      ${NAV.map(([id, icon, name], i) => `${i === 4 || i === 7 ? '<div class="gap"></div>' : ''}<button class="nav ${tab === id ? 'on' : ''}" data-tab="${id}" aria-current="${tab === id ? 'page' : 'false'}">${ic(icon, 'm')}${name}${counts[id] ? `<span class="c">${counts[id]}</span>` : ''}</button>`).join('')}
      <div class="foot">${syncState === 'offline' ? 'Offline. Changes are saved on this device.' : 'Synced with your PC'}</div>`;
  }
  function render() {
    document.body.dataset.theme = themeMode();
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.content = getComputedStyle(document.body).getPropertyValue('--bg').trim() || '#f3f2ec';
    const navTab = ['projects', 'money', 'debts', 'games', 'connections', 'settings'].includes(tab) ? 'more' : tab;
    document.querySelectorAll('#tabs [data-tab]').forEach(b => { b.classList.toggle('on', b.dataset.tab === navTab); b.setAttribute('aria-current', b.dataset.tab === navTab ? 'page' : 'false'); });
    const d = new Date(), date = `${WDL[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}`;
    const titles = {
      home: `<small>${date}</small>Overview`, tasks: `<small>${openTasks().length} open</small>Tasks`, calendar: `<small>${date}</small>Calendar`,
      projects: `<small>${projects().filter(p => p.status === 'active').length} in progress</small>Projects`, money: '<small>From Money Quest</small>Money', debts: `<small>${openDebts().length} open</small>Debts`,
      games: '<small>From Dice and Luck</small>Game nights', connections: '<small>Apps and calendars</small>Connections', settings: '<small>Meadow</small>Settings', more: '<small>Everything else</small>More',
    };
    $('#title').innerHTML = titles[tab];
    const keepScroll = window.scrollY;
    $('#app').innerHTML = { home: viewHome, tasks: viewTasks, calendar: viewCalendar, projects: viewProjects, money: viewMoney, debts: viewDebts, games: viewGames, connections: viewConnections, settings: viewSettings, more: viewMore }[tab]();
    window.scrollTo(0, keepScroll);
    drawSide(); drawSync();
    fresh = null;
  }
  const panelHead = (icon, title, extra = '', cls = '') => `<div class="panel-h"><h2>${icon ? ic(icon, cls) : ''}${title}</h2>${extra}</div>`;
  const sec = title => `<div class="sec"><h2>${title}</h2></div>`;
  const openLink = (href, label = 'Open') => `<a class="linkbtn" href="${esc(href)}" target="_blank" rel="noopener">${label} ${ic('ext', 's')}</a>`;
  const goLink = (to, label) => `<button class="linkbtn" data-tab="${to}">${label} ${ic('right', 's')}</button>`;

  function taskRow(t, opts = {}) {
    const l = listOf(t.list), late = t.due && t.due < today() && !t.done;
    const cl = t.checklist || [], pr = t.project && get('projects', t.project);
    const meta = [];
    if (opts.showList !== false) meta.push(`<span><i class="dotc" style="background:${esc(l.color)}"></i>${esc(l.name)}</span>`);
    if (pr && opts.showProject !== false) meta.push(`<span>${ic('folder')}${esc(pr.name)}</span>`);
    if (t.due && opts.showDue !== false) meta.push(`<span class="${late ? 'late' : ''}">${dayLabel(t.due)}</span>`);
    if (t.time) meta.push(`<span>${ic('clock')}${timeLabel(t.time)}</span>`);
    if (t.repeat) meta.push(`<span>${ic('repeat')}${esc((REPEATS.find(r => r[0] === t.repeat) || ['', ''])[1].replace('Every ', ''))}</span>`);
    if (cl.length) meta.push(`<span>${ic('check')}${cl.filter(c => c.done).length}/${cl.length}</span>`);
    if (t.notes) meta.push(`<span>${ic('note')}Notes</span>`);
    if (t.priority === 'high') meta.push('<span class="late">Important</span>');
    return `<div class="row ${t.done ? 'done' : ''}">
      <button class="check p-${t.priority || 'normal'}" data-act="${t.done ? 'undone' : 'done'}" data-id="${t.id}" aria-label="${t.done ? 'Mark not done' : 'Mark done'}: ${esc(t.title)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="body" data-act="edit-task" data-id="${t.id}" role="button" tabindex="0"><div class="t">${esc(t.title)}</div>${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}</div>
    </div>`;
  }

  // one day's schedule: your events, calendar feeds, bills, paydays, game sessions, other apps
  function kindColor(x) {
    if (x.color) return x.color;
    return { bill: 'var(--bill)', pay: 'var(--money)', game: 'var(--game)', app: 'var(--accent)', feed: 'var(--accent)', debt: 'var(--warn)' }[x.kind] || COLORS[1];
  }
  function schedule(day) {
    const rows = eventsOn(day).map(e => ({ sort: e.allDay ? '00:00' : e.start || '99', when: e.allDay ? 'All day' : timeLabel(e.start), color: e.color || COLORS[1], title: e.title, sub: [e.end && !e.allDay ? `Until ${timeLabel(e.end)}` : '', e.location].filter(Boolean).join(' · '), act: 'edit-event', id: e.id }));
    for (const x of linkItemsOn(day)) {
      const label = { bill: 'Bill', pay: 'Payday', game: 'Session', app: 'Today', feed: 'All day', debt: 'Due' }[x.kind];
      rows.push({ sort: x.time || (x.kind === 'feed' && x.allDay ? '00:00' : '00:01'), when: x.time ? timeLabel(x.time) : label, color: kindColor(x), title: x.title, sub: x.sub, href: x.app ? appUrl(x.app) : '', act: x.kind === 'feed' ? 'feed-ev' : x.kind === 'debt' ? 'pay-debt' : '', id: x.feed || x.debt || '' });
    }
    return rows.sort((a, b) => a.sort.localeCompare(b.sort));
  }
  function tlRow(r, day) {
    const inner = `<span class="when">${esc(r.when)}</span><span class="pin" style="color:${esc(r.color)}"></span><div><div class="t">${esc(r.title)}</div>${r.sub ? `<div class="sub">${esc(r.sub)}</div>` : ''}</div>`;
    if (r.href) return `<a class="tl-row" href="${esc(r.href)}" target="_blank" rel="noopener">${inner}<span class="go">${ic('ext', 's')}</span></a>`;
    return `<div class="tl-row" ${r.act ? `data-act="${r.act}" data-id="${esc(r.id)}" data-day="${day}" role="button" tabindex="0"` : ''}>${inner}<span class="go">${r.act === 'edit-event' ? ic('right', 's') : ''}</span></div>`;
  }
  const nowHM = () => `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`;
  function nextUp() {
    const t = today(), now = nowHM();
    const up = schedule(t).find(r => /^\d\d:\d\d$/.test(r.sort) && r.sort >= now && r.sort !== '00:00' && r.sort !== '00:01');
    if (up) return { day: t, r: up };
    for (let i = 1; i <= 14; i++) { const r = schedule(addDays(t, i))[0]; if (r) return { day: addDays(t, i), r }; }
    return null;
  }
  function staleNote(L, name) {
    if (!L || L.ok) return '';
    if (L.error === 'needs-update') return `<div class="note warn">${name} needs the small Meadow update (run “Connect my apps” once).</div>`;
    return `<div class="note warn">${name} isn't running right now${L.at ? `, so this is from ${ago(L.at)}` : ''}. It refreshes by itself when it's back.</div>`;
  }

  // ---------- Home: the dashboard ----------
  // contour lines for the header card (original artwork: a little hill seen from above)
  const TOPO = `<svg class="topo" viewBox="0 0 600 260" preserveAspectRatio="xMaxYMid slice" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.2">${
    [0, 1, 2, 3, 4, 5, 6, 7].map(i => { const k = 1 + i * .42, cx = 470, cy = 120; return `<path d="M${cx - 30 * k} ${cy}c${-4 * k} ${-26 * k} ${22 * k} ${-46 * k} ${52 * k} ${-44 * k}s${44 * k} ${14 * k} ${50 * k} ${38 * k}s${-12 * k} ${44 * k} ${-46 * k} ${46 * k}s${-52 * k} ${-12 * k} ${-56 * k} ${-40 * k}z"/>`; }).join('')
  }${[0, 1, 2, 3].map(i => { const k = 1 + i * .55, cx = 120, cy = 210; return `<path d="M${cx - 26 * k} ${cy}c${2 * k} ${-20 * k} ${20 * k} ${-30 * k} ${40 * k} ${-26 * k}s${30 * k} ${16 * k} ${26 * k} ${32 * k}s${-24 * k} ${24 * k} ${-44 * k} ${18 * k}s${-24 * k} ${-12 * k} ${-22 * k} ${-24 * k}z"/>`; }).join('')}</g></svg>`;
  const isoWeek = d => { const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const n = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() + 4 - n); const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1)); return Math.ceil(((x - y0) / 864e5 + 1) / 7); };
  function homeHero() {
    const d = new Date(), t = today(), y = d.getFullYear();
    const yLen = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365, doy = diffDays(`${y}-01-01`, t) + 1;
    const mins = d.getHours() * 60 + d.getMinutes(), dayPct = Math.round(mins / 1440 * 100);
    const dim = new Date(y, d.getMonth() + 1, 0).getDate(), wd = d.getDay() || 7;
    return `<section class="panel hero span-3">${TOPO}
      <div><div class="eyebrow">Daily brief</div>
        <h2>${greet()}</h2><p>${summaryLine().replace(/^./, c => c.toUpperCase())}</p>
        <div class="actions"><button class="btn small solid" data-act="add">${ic('plus', 's')}New</button><button class="btn small" data-tab="tasks">${ic('check', 's')}Tasks</button><button class="btn small" data-tab="calendar">${ic('cal', 's')}Calendar</button></div></div>
      <div class="almanac" aria-label="Where you are in time">
        <div class="cell w"><div class="l"><span>Day</span><span>${nowHM()} · ${dayPct}%</span></div><div class="ticks" role="img" aria-label="${dayPct}% of the day gone"><i style="width:${dayPct}%"></i></div></div>
        <div class="cell"><div class="l">Week</div><div class="v">${pad(isoWeek(d))}<span class="muted" style="font-size:12px"> / day ${wd}</span></div></div>
        <div class="cell"><div class="l">Month</div><div class="v">${d.getDate()}<span class="muted" style="font-size:12px"> / ${dim}</span></div></div>
        <div class="cell w"><div class="l"><span>Year ${y}</span><span>day ${doy} · ${yLen - doy} left</span></div><div class="bar blue" role="img" aria-label="${Math.round(doy / yLen * 100)}% of the year gone"><i style="width:${(doy / yLen * 100).toFixed(1)}%"></i></div></div>
      </div></section>`;
  }
  function kpiStrip() {
    const s = settings(), m = money(), t = today(), cells = [];
    const done = doneOn(t).length, od = overdue().length, left = dueToday().length + od;
    const pct = done + left ? Math.round(done / (done + left) * 100) : 0;
    cells.push(`<button class="kpi" data-tab="tasks"><span class="k">${ic('check', 'accent')}Today</span><span class="v num">${done}/${done + left}</span><span class="d">${left ? `${left} left` : done ? 'All done' : 'Nothing due'}</span><span class="meter good"><i style="width:${pct}%"></i></span></button>`);
    cells.push(`<button class="kpi" data-tab="tasks"><span class="k">${ic('alert', od ? 'warn' : 'accent')}Overdue</span><span class="v num ${od ? 'warn' : ''}">${od}</span><span class="d">${od ? 'carried over' : 'all caught up'}</span></button>`);
    const wk = openTasks().filter(x => x.due && x.due > t && x.due <= addDays(t, 7)).length;
    cells.push(`<button class="kpi" data-tab="tasks"><span class="k">${ic('list', 'accent')}Next 7 days</span><span class="v num">${wk}</span><span class="d">tasks due · ${openTasks().length} open</span></button>`);
    if (m && s.showMoney !== false) {
      cells.push(`<button class="kpi" data-tab="money"><span class="k">${ic('wallet', 'money')}Safe to spend</span><span class="v num ${m.safeToSpend < 0 ? 'bad' : 'good'}">${fmtMoney(m.safeToSpend, m.currency)}</span><span class="d">${m.nextPayday ? `until ${shortDay(m.nextPayday)}` : 'next 2 weeks'}</span></button>`);
      const b = m.month || {}, mp = b.budget ? Math.round(b.spent / b.budget * 100) : 0;
      cells.push(`<button class="kpi" data-tab="money"><span class="k">${ic('receipt', 'money')}Month spent</span><span class="v num ${mp > 100 ? 'bad' : ''}">${b.budget ? mp + '%' : fmtMoney(b.spent, m.currency)}</span><span class="d">${b.budget ? `of ${fmtMoney(b.budget, m.currency)}` : 'this month'}</span><span class="meter ${mp > 100 ? 'over' : mp > 85 ? 'warn' : ''}"><i style="width:${Math.min(100, mp)}%"></i></span></button>`);
    } else {
      const nu = nextUp();
      cells.push(`<button class="kpi" data-tab="calendar"><span class="k">${ic('cal', 'accent')}Next up</span><span class="v">${nu ? (nu.day === t ? esc(nu.r.when) : shortDay(nu.day)) : 'Free'}</span><span class="d">${nu ? esc(nu.r.title) : 'Nothing for 2 weeks'}</span></button>`);
      cells.push(`<button class="kpi" data-tab="tasks"><span class="k">${ic('flame', 'accent')}Streak</span><span class="v num">${streak()}d</span><span class="d">days in a row</span></button>`);
    }
    const act = projects().filter(p => p.status === 'active'), avg = act.length ? Math.round(act.reduce((n, p) => n + projStats(p).pct, 0) / act.length) : 0;
    cells.push(`<button class="kpi" data-tab="projects"><span class="k">${ic('folder', 'accent')}Projects</span><span class="v num">${act.length}</span><span class="d">${act.length ? `active · ${avg}% avg` : 'none active'}</span><span class="meter"><i style="width:${avg}%"></i></span></button>`);
    return `<section class="panel kpis span-3" aria-label="At a glance">${cells.join('')}</section>`;
  }
  function homeTasks() {
    const od = overdue(), dt = dueToday(), n = od.length + dt.length, max = 6;
    const rows = [...od.map(x => taskRow(x, { showProject: true })), ...dt.map(x => taskRow(x, { showDue: false }))];
    const hi = [...od, ...dt].filter(x => x.priority === 'high').length, timed = dt.filter(x => x.time).length;
    return `<section class="panel span-2">
      ${panelHead('check', 'Today', `<span class="count">${n ? `${n} to do` : ''}</span>${goLink('tasks', 'All tasks')}`, 'accent')}
      <form class="quick" data-form="quick-today"><label class="sr" for="qtoday">Add a task for today</label><input id="qtoday" name="q" placeholder="Add a task for today" autocomplete="off" enterkeyhint="done"><button>Add</button></form>
      ${rows.slice(0, max).join('')}
      ${rows.length > max ? `<button class="linkbtn" data-tab="tasks">${rows.length - max} more ${ic('right', 's')}</button>` : ''}
      ${!n ? `<div class="empty">${doneOn(today()).length ? 'All done for today.' : 'Nothing due today.'}</div>` : ''}
      <div class="pfoot"><span>done today <b>${doneOn(today()).length}</b></span><span>important <b>${hi}</b></span><span>with a time <b>${timed}</b></span><span>no date <b>${openTasks().filter(x => !x.due).length}</b></span></div>
    </section>`;
  }
  function homeSchedule() {
    const t = today(), sch = schedule(t), tmr = schedule(addDays(t, 1)), now = nowHM();
    let placed = false, html = '';
    for (const r of sch) {
      const timed = /^\d\d:\d\d$/.test(r.sort) && r.sort !== '00:00' && r.sort !== '00:01';
      if (timed && !placed && r.sort > now) { html += `<div class="nowline" aria-label="Now">NOW ${now}</div>`; placed = true; }
      html += tlRow(r, t).replace('class="tl-row"', `class="tl-row${timed && r.sort < now ? ' past' : ''}"`);
    }
    if (sch.length && !placed && sch.some(r => /^\d\d:\d\d$/.test(r.sort) && r.sort > '00:01')) html += `<div class="nowline">NOW ${now}</div>`;
    return `<section class="panel">
      ${panelHead('clock', 'Schedule', `<span class="count">${sch.length || ''}</span>${goLink('calendar', 'Calendar')}`, 'accent')}
      ${sch.length ? html : '<div class="empty">Nothing on the calendar today.</div>'}
      ${tmr.length ? `<div class="group">Tomorrow · ${tmr.length}</div>${tmr.slice(0, 3).map(r => tlRow(r, addDays(t, 1))).join('')}` : ''}
    </section>`;
  }
  // everything with a date coming up, as a countdown
  function homeMilestones() {
    const t = today(), s = settings(), m = money(), out = [];
    if (m && s.showMoney !== false) {
      if (m.nextPayday && m.nextPayday >= t) out.push({ day: m.nextPayday, title: 'Payday', sub: 'Money Quest', icon: 'wallet', href: appUrl('money') });
      for (const u of (m.upcoming || []).filter(u => u.type !== 'income' && u.due >= t).slice(0, 2)) out.push({ day: u.due, title: u.name, sub: u.autopay ? 'Bill · pays itself' : 'Bill', icon: 'receipt', amt: u.variable ? 'Varies' : fmtMoney(u.amount, m.currency), href: appUrl('money') });
    }
    if (dice() && s.showGames !== false) for (const c of visibleCamps().filter(c => c.next && c.next.date >= t).slice(0, 2)) out.push({ day: c.next.date, title: c.name, sub: `Game session${c.next.time ? ' · ' + timeLabel(c.next.time) : ''}`, icon: 'dice', href: appUrl('dice') });
    for (const d of openDebts()) { const due = nextDue(d); if (due) out.push({ day: due, title: d.name, sub: 'Debt payment', icon: 'receipt', amt: d.min ? fmtMoney(+d.min, cur()) : '', act: 'pay-debt', id: d.id }); }
    for (const p of projects().filter(p => p.target && p.status !== 'done' && p.target >= t)) out.push({ day: p.target, title: p.name, sub: `Project target · ${projStats(p).pct}% done`, icon: 'folder', act: 'open-project', id: p.id });
    for (const x of openTasks().filter(x => x.priority === 'high' && x.due && x.due > t)) out.push({ day: x.due, title: x.title, sub: `Important · ${listOf(x.list).name}`, icon: 'target', act: 'edit-task', id: x.id });
    for (const f of feeds().filter(f => f.on !== false)) {
      const C = S.cals[f.id]; if (!C || !C.events) continue;
      const e = C.events.filter(e => e.date > t).sort((a, b) => a.date.localeCompare(b.date))[0];
      if (e) out.push({ day: e.date, title: e.title, sub: f.name || C.calName || 'Calendar', icon: 'cal', act: 'goto-day', id: e.date });
    }
    for (const e of all('events').filter(e => e.date > t && !e.repeat)) out.push({ day: e.date, title: e.title, sub: e.allDay ? 'All day' : timeLabel(e.start), icon: 'cal', act: 'edit-event', id: e.id });
    out.sort((a, b) => a.day.localeCompare(b.day));
    const rows = out.slice(0, 6).map((x, i) => {
      const n = diffDays(t, x.day), cls = n === 0 ? 'now' : n <= 3 ? 'soon' : '';
      const inner = `<span class="n ${cls}"><b>${n === 0 ? 'Now' : n}</b><small>${n === 0 ? 'today' : n === 1 ? 'day' : 'days'}</small></span><span class="lt"><b>${esc(x.title)}</b><span>${ic(x.icon, 's')}${esc(x.sub)} · ${shortDay(x.day)}</span></span>${x.amt ? `<span class="amt">${esc(x.amt)}</span>` : ''}`;
      return x.href ? `<a class="cd ${i ? '' : 'first'}" href="${esc(x.href)}" target="_blank" rel="noopener">${inner}</a>` : `<button class="cd ${i ? '' : 'first'}" data-act="${x.act}" data-id="${esc(x.id)}" ${x.act === 'edit-event' ? `data-day="${x.day}"` : ''}>${inner}</button>`;
    });
    return `<section class="panel">${panelHead('target', 'Coming up', `<span class="count">${out.length}</span>`, 'accent')}${rows.length ? rows.join('') : '<div class="empty">No dates coming up. Paydays, sessions, project targets and calendar events show here.</div>'}</section>`;
  }
  // finished tasks over the last 26 weeks
  function homeActivity() {
    const t = today(), counts = {};
    for (const d of all('done')) counts[d.day] = (counts[d.day] || 0) + 1;
    const end = addDays(weekStart(t), 6), start = addDays(weekStart(t), -175), cells = [];
    let total = 0;
    for (let day = start; day <= end; day = addDays(day, 1)) {
      const n = counts[day] || 0, lv = day > t ? 'fut' : n === 0 ? '' : n === 1 ? 'l1' : n <= 3 ? 'l2' : n <= 5 ? 'l3' : 'l4';
      if (day <= t) total += n;
      cells.push(`<i class="${lv}${day === t ? ' now' : ''}" title="${dayLabel(day)}: ${n} done"></i>`);
    }
    const days = Object.keys(counts).sort(); let best = 0, run = 0, prev = null;
    for (const d of days) { run = prev && diffDays(prev, d) === 1 ? run + 1 : 1; best = Math.max(best, run); prev = d; }
    const ws = weekStart(t), thisWk = days.filter(d => d >= ws && d <= t).reduce((n, d) => n + counts[d], 0), lastWk = days.filter(d => d >= addDays(ws, -7) && d < ws).reduce((n, d) => n + counts[d], 0);
    const delta = thisWk - lastWk;
    return `<section class="panel">${panelHead('chart', 'Activity', '<span class="count">26 weeks</span>', 'accent')}
      <div class="heatwrap"><div class="days" aria-hidden="true"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div><div class="heat" role="img" aria-label="${total} tasks finished in the last 26 weeks">${cells.join('')}</div></div>
      <div class="heatkey">less<i style="background:var(--heat0)"></i><i style="background:var(--heat1)"></i><i style="background:var(--heat2)"></i><i style="background:var(--heat3)"></i><i style="background:var(--heat4)"></i>more</div>
      <div class="minis"><div><div class="l">Streak</div><div class="v">${streak()}d</div></div><div><div class="l">Best</div><div class="v">${best}d</div></div><div><div class="l">This wk</div><div class="v ${delta > 0 ? 'good' : ''}">${thisWk}<span class="muted" style="font-size:11px"> ${delta > 0 ? '+' : delta < 0 ? '−' : '±'}${Math.abs(delta)}</span></div></div></div>
    </section>`;
  }
  // open work per area
  function homeAreas() {
    const t = today(), open = openTasks(), ls = lists().map(l => {
      const ts = open.filter(x => (x.list || 'inbox') === l.id), late = ts.filter(x => x.due && x.due < t).length;
      const done = all('done').filter(d => d.day >= addDays(t, -30) && (get('tasks', d.taskId) || {}).list === l.id).length;
      return { l, n: ts.length, late, done };
    }).filter(a => a.n || a.done);
    const max = Math.max(1, ...ls.map(a => a.n + a.done));
    return `<section class="panel">${panelHead('list', 'Areas', `<span class="count">${open.length} open</span>${goLink('tasks', 'Tasks')}`, 'accent')}
      ${ls.length ? ls.map((a, i) => `<button class="area ${i ? '' : 'first'}" data-act="filter" data-id="${a.l.id}" data-go="tasks"><i class="dotc" style="background:${esc(a.l.color)}"></i><b>${esc(a.l.name)}</b><span class="stack" role="img" aria-label="${a.n} open, ${a.done} finished in 30 days"><i style="width:${a.done / max * 100}%;background:${esc(a.l.color)};opacity:.45"></i><i style="width:${a.n / max * 100}%;background:${esc(a.l.color)}"></i></span><span class="nums">${a.late ? `<span class="late">${a.late}!</span> ` : ''}${a.n} open</span></button>`).join('')
        : '<div class="empty">No open tasks in any area.</div>'}
      <div class="pfoot"><span>faded = finished in 30 days</span></div>
    </section>`;
  }
  function homeMoney() {
    const s = settings(), m = money(), L = S.links.money;
    if (s.showMoney === false) return '';
    if (!m) return `<section class="panel">${panelHead('wallet', 'Money', '', 'money')}<div class="empty">${L && L.error === 'needs-update' ? 'Money Quest needs the small Meadow update. Run “Connect my apps” on your PC.' : 'Waiting for Money Quest. Start it on your PC and this fills in by itself.'}</div></section>`;
    const t = today(), bills = (m.upcoming || []).filter(u => u.type !== 'income' && u.due >= t).slice(0, 3);
    const spent = m.month.spent, budget = m.month.budget, pct = budget ? Math.min(100, Math.round(spent / budget * 100)) : 0;
    return `<section class="panel">
      ${panelHead('wallet', 'Money', goLink('money', 'Details'), 'money')}
      <div class="kicker">Safe to spend${m.nextPayday ? ` until ${shortDay(m.nextPayday)}` : ''}</div>
      <div class="big num ${m.safeToSpend < 0 ? 'bad' : 'good'}">${fmtMoney(m.safeToSpend, m.currency)}</div>
      ${budget ? `<div style="margin-top:12px"><div class="kv"><span>This month</span><span class="num">${fmtMoney(spent, m.currency)} of ${fmtMoney(budget, m.currency)}</span></div><div class="bar ${spent > budget ? 'over' : pct > 85 ? 'warn' : ''}" role="img" aria-label="${pct}% of monthly budget used"><i style="width:${pct}%"></i></div></div>` : ''}
      ${bills.length ? `<div class="group">Next bills</div>${bills.map((u, i) => `<div class="line ${i ? '' : 'first'}" style="min-height:40px;padding:6px 0"><div class="lt"><b style="font-size:14.5px">${esc(u.name)}</b></div><span class="muted" style="font-size:13px">${shortDay(u.due)}</span><span class="amt num" style="font-size:14px">${u.variable ? 'Varies' : fmtMoney(u.amount, m.currency)}</span></div>`).join('')}` : ''}
      ${staleNote(L, 'Money Quest')}
    </section>`;
  }
  function homeProjects() {
    const ps = projects().filter(p => p.status === 'active' || p.status === 'planned').sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1)).slice(0, 4);
    return `<section class="panel">
      ${panelHead('folder', 'Projects', goLink('projects', 'All'), 'accent')}
      ${ps.length ? ps.map((p, i) => { const st = projStats(p); return `<button class="pline ${i ? '' : 'first'}" data-act="open-project" data-id="${p.id}"><i class="dotc" style="background:${esc(listOf(p.area).color)}"></i><b>${esc(p.name)}</b><span class="bar blue"><i style="width:${st.pct}%"></i></span><span class="pc num">${st.total ? st.pct + '%' : '–'}</span></button>`; }).join('')
        : '<div class="empty">Track bigger things here, like fixing up a room or a school assignment, with their own steps.</div>'}
      <div class="btnrow"><button class="btn small" data-act="new-project">${ic('plus', 's')}New project</button></div>
    </section>`;
  }
  function homeGames() {
    const s = settings(), d = dice(), L = S.links.dice;
    if (s.showGames === false) return '';
    if (!d) return `<section class="panel">${panelHead('dice', 'Game nights', '', 'game')}<div class="empty">Waiting for Dice and Luck. Start it on your PC and this fills in by itself.</div></section>`;
    const camps = visibleCamps().sort((a, b) => (a.next ? a.next.date : '9999').localeCompare(b.next ? b.next.date : '9999')).slice(0, 3);
    return `<section class="panel">
      ${panelHead('dice', 'Game nights', goLink('games', 'Details'), 'game')}
      ${camps.length ? camps.map((c, i) => `<div class="line ${i ? '' : 'first'}"><div class="lt"><b>${esc(c.name)}</b><span>${c.next ? `${dayLabel(c.next.date)}${c.next.time ? ' · ' + esc(timeLabel(c.next.time)) : ''}` : 'No date set'}</span></div>${c.activeJobs ? `<span class="tag">${c.activeJobs} jobs</span>` : ''}</div>`).join('') : '<div class="empty">No campaigns picked. Choose them in Settings.</div>'}
      ${staleNote(L, 'Dice and Luck')}
    </section>`;
  }
  function homeWeek() {
    const t = today(), open = openTasks(), cs = getComputedStyle(document.body);
    const resolve = c => /^var\(/.test(c) ? cs.getPropertyValue(c.slice(4, -1)).trim() : c;
    const days = [0, 1, 2, 3, 4, 5, 6].map(i => {
      const day = addDays(t, i), items = [...schedule(day).map(r => resolve(r.color)), ...open.filter(x => x.due === day).map(x => listOf(x.list).color)];
      return `<button class="${i === 0 ? 'today' : ''}" data-act="goto-day" data-id="${day}" aria-label="${dayLabel(day)}: ${items.length} item${items.length === 1 ? '' : 's'}"><span class="wd">${WD[pd(day).getDay()]}</span><span class="dn">${pd(day).getDate()}</span><span class="dots">${items.slice(0, 6).map(c => `<i style="background:${esc(c)}"></i>`).join('')}</span></button>`;
    }).join('');
    const rows = [];
    for (let i = 1; i <= 7 && rows.length < 5; i++) {
      const day = addDays(t, i);
      for (const r of schedule(day)) if (rows.length < 5) rows.push(`<div class="line" style="min-height:44px;padding:7px 0"><i class="dotc" style="background:${esc(r.color)}"></i><div class="lt"><b style="font-size:14.5px">${esc(r.title)}</b></div><span class="muted" style="font-size:13px;white-space:nowrap">${shortDay(day)}${/^\d/.test(r.when) ? ' · ' + esc(r.when) : ''}</span></div>`);
    }
    return `<section class="panel span-2">${panelHead('cal', 'Next 7 days', goLink('calendar', 'Calendar'), 'accent')}<div class="week">${days}</div>${rows.length ? `<div style="margin-top:8px">${rows.join('').replace('class="line"', 'class="line first"')}</div>` : ''}</section>`;
  }
  function homeConnections() {
    const rows = [['Money Quest', S.links.money], ['Dice and Luck', S.links.dice], ...customApps().map(a => [a.name, (S.links.apps || {})[a.id]])];
    const fs = feeds().filter(f => f.on !== false), okCals = fs.filter(f => S.cals[f.id] && S.cals[f.id].ok).length;
    return `<section class="panel">
      ${panelHead('link', 'Connections', goLink('connections', 'Manage'), 'accent')}
      ${rows.map(([n, L], i) => `<div class="line ${i ? '' : 'first'}" style="min-height:40px;padding:6px 0"><div class="lt"><b style="font-size:14.5px">${esc(n)}</b></div>${appStatus(L, n, true)}</div>`).join('')}
      <div class="line" style="min-height:40px;padding:6px 0"><div class="lt"><b style="font-size:14.5px">Calendars</b></div>${fs.length ? `<span class="status ${okCals === fs.length ? 'ok' : ''}">${okCals} of ${fs.length} up to date</span>` : '<button class="linkbtn" data-act="new-feed">Add one</button>'}</div>
    </section>`;
  }
  function homeGarden() {
    const s = settings(); if (!s.cozy) return '';
    const wk = weekPlants();
    return `<section class="panel garden span-2"><div class="scene">${ART.meadow(wk, new Date().getHours())}<div data-act="buddy" role="button" aria-label="${esc(s.buddy)}, your companion">${ART.buddy(mood())}</div><div class="say"><span id="sayline">${esc(buddySays())}</span></div></div>
      <div class="foot"><span>${ic('flower', 's')}${wk.length} this week</span><span>${ic('flame', 's')}${streak()}-day streak</span></div></section>`;
  }
  function summaryLine() {
    const od = overdue().length, dt = dueToday().length, nu = nextUp(), t = today(), parts = [];
    parts.push(dt + od ? `<b>${dt + od} task${dt + od === 1 ? '' : 's'}</b> for today${od ? ` (${od} carried over)` : ''}` : '<b>No tasks</b> due today');
    if (nu && nu.day === t) parts.push(`next on the calendar: <b>${esc(nu.r.title)}</b> at ${esc(nu.r.when)}`);
    const m = money(); if (m && settings().showMoney !== false && !settings().hideAmounts) { const b = (m.upcoming || []).find(u => u.type !== 'income' && u.due >= t && u.due <= addDays(t, 3)); if (b) parts.push(`<b>${esc(b.name)}</b> is due ${dayLabel(b.due).toLowerCase()}`); }
    return parts.join(', ') + '.';
  }
  function viewHome() {
    return `<div class="bento">
        ${homeHero()}
        ${kpiStrip()}
        ${homeTasks()}
        ${homeSchedule()}
        ${homeGarden()}
        ${homeMilestones()}
        ${homeActivity()}
        ${homeAreas()}
        ${homeWeek()}
        ${homeMoney()}
        ${homeDebts()}
        ${homeProjects()}
        ${homeGames()}
        ${homeConnections()}
      </div>`;
  }

  // ---------- Tasks ----------
  function viewTasks() {
    const ls = lists(), open = openTasks();
    const chips = [`<button class="chip ${listFilter === 'all' ? 'on' : ''}" data-act="filter" data-id="all" aria-pressed="${listFilter === 'all'}">All <span class="c">${open.length}</span></button>`,
      ...ls.map(l => { const n = open.filter(t => (t.list || 'inbox') === l.id).length; return `<button class="chip ${listFilter === l.id ? 'on' : ''}" data-act="filter" data-id="${l.id}" aria-pressed="${listFilter === l.id}">${ic(l.icon)}${esc(l.name)}${n ? ` <span class="c">${n}</span>` : ''}</button>`; })].join('');
    const mine = open.filter(t => listFilter === 'all' || (t.list || 'inbox') === listFilter).sort(sortTasks);
    const t = today(), wkEnd = addDays(t, 7);
    const groups = [
      ['Carried over', x => x.due && x.due < t, 'overdue'], ['Today', x => x.due === t], ['Tomorrow', x => x.due === addDays(t, 1)],
      ['Next 7 days', x => x.due > addDays(t, 1) && x.due <= wkEnd], ['Later', x => x.due > wkEnd], ['No date', x => !x.due],
    ];
    let out = '';
    for (const [name, f, cls] of groups) {
      const g = mine.filter(f);
      if (g.length) out += `<div class="group ${cls || ''}">${name} <span style="opacity:.75">· ${g.length}</span></div><div class="panel flush">${g.map(x => taskRow(x, { showList: listFilter === 'all', showDue: name !== 'Today' && name !== 'Tomorrow' })).join('')}</div>`;
    }
    const cut = Date.now() - 14 * 864e5;
    const doneList = all('tasks').filter(x => x.done && (x.doneAt || 0) > cut && (listFilter === 'all' || (x.list || 'inbox') === listFilter)).sort((a, b) => b.doneAt - a.doneAt);
    const placeholder = listFilter === 'all' || listFilter === 'inbox' ? 'Add a task, e.g. “call mom tomorrow”' : `Add to ${esc(listOf(listFilter).name)}`;
    return `
      <div class="chips" role="group" aria-label="Areas">${chips}</div>
      <form class="quick" data-form="quick-task"><label class="sr" for="qtask">Add a task</label><input id="qtask" name="q" placeholder="${placeholder}" autocomplete="off" enterkeyhint="done"><button>Add</button></form>
      ${out || `<div class="panel" style="margin-top:12px"><div class="empty">${listFilter === 'all' ? 'No tasks yet. Type one above. End it with “today”, “tomorrow” or a day like “fri”, and add “!” to mark it important.' : 'Nothing in this area right now.'}</div></div>`}
      ${doneList.length ? `<button class="group" data-act="toggle-done" aria-expanded="${showDone}" style="width:100%">Done lately · ${doneList.length} ${ic(showDone ? 'left' : 'right', 's')}</button>${showDone ? `<div class="panel flush">${doneList.map(x => taskRow(x)).join('')}</div>` : ''}` : ''}
    `;
  }

  // ---------- Calendar ----------
  function viewCalendar() {
    const [y, m] = calMonth.split('-').map(Number);
    const first = new Date(y, m - 1, 1), start = addDays(ds(first), -first.getDay());
    const t = today(), cs = getComputedStyle(document.body);
    const resolve = c => /^var\(/.test(c) ? cs.getPropertyValue(c.slice(4, -1)).trim() : c;
    let cells = WD.map(w => `<div class="wd" aria-hidden="true">${w.slice(0, 2)}</div>`).join('');
    const open = openTasks();
    for (let i = 0; i < 42; i++) {
      const day = addDays(start, i), dd = pd(day);
      if (i === 35 && dd.getMonth() !== m - 1) break;
      const items = [...schedule(day).map(r => resolve(r.color)), ...open.filter(x => x.due === day).map(x => listOf(x.list).color)];
      cells += `<button class="day ${dd.getMonth() !== m - 1 ? 'other' : ''} ${day === t ? 'today' : ''} ${day === calSel ? 'sel' : ''}" data-act="pick-day" data-id="${day}" aria-label="${dayLabel(day)}${items.length ? `, ${items.length} item${items.length > 1 ? 's' : ''}` : ''}" aria-pressed="${day === calSel}"><span class="num">${dd.getDate()}</span><span class="dots">${items.slice(0, 4).map(c => `<i style="background:${esc(c)}"></i>`).join('')}</span></button>`;
    }
    const sch = schedule(calSel), tks = all('tasks').filter(x => x.due === calSel || (x.done && x.doneAt && ds(new Date(x.doneAt)) === calSel && !x.repeat)).sort(sortTasks);
    const uniq = [...new Map(tks.map(x => [x.id, x])).values()];
    const lbl = dayLabel(calSel), s = settings();
    const leg = [];
    if (money() && s.showMoney !== false) leg.push(['var(--bill)', 'Bills'], ['var(--money)', 'Paydays']);
    if (dice() && s.showGames !== false) leg.push(['var(--game)', 'Game sessions']);
    for (const f of feeds()) if (f.on !== false) leg.push([f.color, f.name || 'Calendar']);
    for (const a of customApps()) if (a.on !== false && (S.links.apps || {})[a.id]?.data?.events?.length) leg.push([a.color, a.name]);
    const legend = leg.length ? `<div class="legend">${leg.map(([c, n]) => `<span><i class="dotc" style="background:${esc(c)}"></i>${esc(n)}</span>`).join('')}</div>` : '';
    return `<div class="cols">
      <div class="panel">
        <div class="calhead">
          <h2>${MON[m - 1]} ${y}</h2>
          <button class="textbtn" data-act="cal-today">Today</button>
          <button class="iconbtn" data-act="cal-prev" aria-label="Previous month">${ic('left')}</button>
          <button class="iconbtn" data-act="cal-next" aria-label="Next month">${ic('right')}</button>
        </div>
        <div class="grid">${cells}</div>
        ${legend}
      </div>
      <div class="panel">
        ${panelHead('', `${lbl}${['Today', 'Tomorrow', 'Yesterday'].includes(lbl) ? ` <span class="muted" style="font-weight:600">· ${MON[pd(calSel).getMonth()].slice(0, 3)} ${pd(calSel).getDate()}</span>` : ''}`, `<span class="count">${sch.length + uniq.length || ''}</span>`)}
        ${sch.map(r => tlRow(r, calSel)).join('')}
        ${uniq.length ? `${sch.length ? '<div class="group">Tasks</div>' : ''}${uniq.map(x => taskRow(x, { showDue: false })).join('')}` : ''}
        ${!sch.length && !uniq.length ? '<div class="empty">Nothing planned.</div>' : ''}
        <div class="btnrow"><button class="btn solid" data-act="new-event" data-day="${calSel}">${ic('plus', 's')}Event</button><button class="btn" data-act="new-task" data-day="${calSel}">${ic('plus', 's')}Task</button></div>
        ${feeds().length ? '' : `<div class="note">Add your school or iPhone calendar in <button class="linkbtn" data-tab="connections" style="min-height:0">Connections</button> to see it here too.</div>`}
      </div>
    </div>`;
  }

  // ---------- Projects ----------
  function viewProjects() {
    if (projOpen && get('projects', projOpen)) return viewProject(get('projects', projOpen));
    const ps = projects();
    const card = p => {
      const st = projStats(p), a = listOf(p.area);
      return `<button class="proj" data-act="open-project" data-id="${p.id}">
        <div class="top"><b>${esc(p.name)}</b>${statusTag(p.status)}</div>
        <div class="sub"><span><i class="dotc" style="background:${esc(a.color)}"></i>${esc(a.name)}</span>${p.target ? `<span>${ic('cal', 's')}${p.status === 'done' ? '' : 'Due '}${dayLabel(p.target)}</span>` : ''}<span>${st.total ? `${st.done} of ${st.total} steps` : 'No steps yet'}</span></div>
        <div class="bar blue"><i style="width:${st.pct}%"></i></div>
        ${st.next ? `<div class="next"><span class="muted">Next:</span> ${esc(st.next.title)}</div>` : ''}
      </button>`;
    };
    let out = '';
    for (const [k, name] of STATUSES) { const g = ps.filter(p => (p.status || 'planned') === k); if (g.length) out += `<div class="group">${name} <span style="opacity:.75">· ${g.length}</span></div><div class="projects">${g.map(card).join('')}</div>`; }
    return `<div class="btnrow" style="margin-top:0"><button class="btn solid" style="flex:0 0 auto" data-act="new-project">${ic('plus', 's')}New project</button></div>
      ${out || `<div class="panel" style="margin-top:14px"><div class="empty">Projects hold bigger things with several steps: painting a room, fixing the sink, a school assignment, planning a trip. Each one gets its own task list and a progress bar.</div></div>`}`;
  }
  function viewProject(p) {
    const st = projStats(p), a = listOf(p.area), ts = projTasks(p.id);
    const open = ts.filter(t => !t.done).sort(sortTasks), done = ts.filter(t => t.done).sort((x, y) => (y.doneAt || 0) - (x.doneAt || 0));
    return `<button class="back" data-act="close-project">${ic('left', 's')}All projects</button>
      <div class="cols">
      <div class="panel">
        <div class="panel-h"><h2 style="font-size:19px">${esc(p.name)}</h2>${statusTag(p.status)}</div>
        <div class="proj" style="border:0;box-shadow:none;padding:0"><div class="sub"><span><i class="dotc" style="background:${esc(a.color)}"></i>${esc(a.name)}</span>${p.target ? `<span>${ic('cal', 's')}Due ${dayLabel(p.target)}</span>` : ''}</div></div>
        <div class="kv" style="margin-top:12px"><span>Progress</span><span class="num">${st.done} of ${st.total} steps · ${st.pct}%</span></div>
        <div class="bar blue"><i style="width:${st.pct}%"></i></div>
        ${p.notes ? `<p style="white-space:pre-wrap;margin:14px 0 0;font-size:14.5px">${esc(p.notes)}</p>` : ''}
        <div class="btnrow"><button class="btn" data-act="edit-project" data-id="${p.id}">Edit project</button>${p.status !== 'done' ? `<button class="btn" data-act="finish-project" data-id="${p.id}">${ic('check', 's')}Mark finished</button>` : ''}</div>
      </div>
      <div class="panel">
        ${panelHead('list', 'Steps', `<span class="count">${open.length ? `${open.length} left` : ''}</span>`, 'accent')}
        <form class="quick" data-form="quick-project" data-id="${p.id}"><label class="sr" for="qproj">Add a step</label><input id="qproj" name="q" placeholder="Add a step, e.g. “buy paint sat”" autocomplete="off" enterkeyhint="done"><button>Add</button></form>
        ${open.map(x => taskRow(x, { showList: false, showProject: false })).join('')}
        ${!ts.length ? '<div class="empty">Break it into small steps. Each step is a task, so it can have a date and show up on Home and the calendar.</div>' : ''}
        ${done.length ? `<div class="group">Done · ${done.length}</div>${done.map(x => taskRow(x, { showList: false, showProject: false })).join('')}` : ''}
      </div></div>`;
  }

  // ---------- Money ----------
  function viewMoney() {
    const s = settings(), m = money(), L = S.links.money;
    if (!m) return `<div class="panel"><div class="empty">${L && L.error === 'needs-update' ? 'Money Quest needs the small Meadow update. Run “Connect my apps” on your PC.' : 'Waiting for Money Quest. Start it on your PC and this fills in by itself.'}</div>${openLink(appUrl('money'), 'Open Money Quest')}</div>`;
    const t = today(), up = (m.upcoming || []).filter(u => u.due >= t).sort((a, b) => a.due.localeCompare(b.due));
    const spent = m.month.spent, budget = m.month.budget, pct = budget ? Math.min(100, Math.round(spent / budget * 100)) : 0;
    const billsTotal = up.filter(u => u.type !== 'income' && u.due <= addDays(t, 30) && !u.variable).reduce((a, u) => a + u.amount, 0);
    const goals = (m.goals || []).filter(g => g.target > 0);
    return `${staleNote(L, 'Money Quest')}
      <section class="panel kpis" aria-label="Money at a glance">
        <a class="kpi" href="${appUrl('money')}" target="_blank" rel="noopener"><span class="k">${ic('wallet', 'money')}Safe to spend</span><span class="v num ${m.safeToSpend < 0 ? 'bad' : 'good'}">${fmtMoney(m.safeToSpend, m.currency)}</span><span class="d">${m.nextPayday ? `until ${shortDay(m.nextPayday)}` : 'next 2 weeks'}</span></a>
        <div class="kpi"><span class="k">${ic('wallet')}Wallet</span><span class="v num">${fmtMoney(m.wallet, m.currency)}</span><span class="d">${m.keepForBills ? `${fmtMoney(m.keepForBills, m.currency)} kept for bills` : 'Nothing set aside'}</span></div>
        <div class="kpi"><span class="k">${ic('receipt')}Spent this month</span><span class="v num">${fmtMoney(spent, m.currency)}</span><span class="d">${budget ? `${pct}% of ${fmtMoney(budget, m.currency)}` : 'No budget set'}</span></div>
        <div class="kpi"><span class="k">${ic('cal')}Bills next 30 days</span><span class="v num">${fmtMoney(billsTotal, m.currency)}</span><span class="d">${up.filter(u => u.type !== 'income' && u.due <= addDays(t, 30)).length} bills</span></div>
      </section>
      <div class="cols" style="margin-top:14px">
        <section class="panel">${panelHead('cal', 'Coming up', openLink(appUrl('money'), 'Money Quest'), 'accent')}
          ${up.length ? up.slice(0, 14).map((u, i) => `<div class="line ${i ? '' : 'first'}"><span class="lic ${u.type === 'income' ? 'pay' : 'bill'}">${ic(u.type === 'income' ? 'wallet' : 'receipt', 's')}</span><div class="lt"><b>${esc(u.name)}</b><span>${dayLabel(u.due)}${u.type === 'income' ? ' · payday' : u.autopay ? ' · pays itself' : ''}</span></div><span class="amt num ${u.type === 'income' ? 'in' : ''}">${u.variable ? 'Varies' : (u.type === 'income' ? '+' : '') + fmtMoney(u.amount, m.currency)}</span></div>`).join('') : '<div class="empty">No bills or paydays in the next two months.</div>'}
        </section>
        <section class="panel">${panelHead('target', 'Goals', '', 'money')}
          ${budget ? `<div class="kv"><span>Monthly budget</span><span class="num">${fmtMoney(spent, m.currency)} of ${fmtMoney(budget, m.currency)}</span></div><div class="bar ${spent > budget ? 'over' : pct > 85 ? 'warn' : ''}"><i style="width:${pct}%"></i></div>` : ''}
          ${goals.length ? goals.map(g => { const gp = Math.min(100, Math.round((g.saved || 0) / g.target * 100)); return `<div style="margin-top:14px"><div class="kv"><span style="color:var(--ink)">${esc(g.name)}${g.deadline ? ` <span class="muted">· by ${shortDay(g.deadline)}</span>` : ''}</span><span class="num">${fmtMoney(g.saved || 0, m.currency)} of ${fmtMoney(g.target, m.currency)}</span></div><div class="bar"><i style="width:${gp}%"></i></div></div>`; }).join('') : '<div class="empty">No savings goals in Money Quest yet.</div>'}
          <div class="note">Read from Money Quest. Make changes there.</div>
        </section>
      </div>
      <div style="margin-top:14px">${homeDebts() || `<section class="panel">${panelHead('receipt', 'Debts', goLink('debts', 'Open'), 'accent')}<div class="empty">Track cards, loans and money you owe, and see your debt-free date.</div></section>`}
      </div>`;
  }

  // ---------- Debts: track what you owe and plan the payoff ----------
  const DEBT_KINDS = [['card', 'Credit card'], ['loan', 'Loan'], ['car', 'Car loan'], ['student', 'Student loan'], ['line', 'Line of credit'], ['person', 'Owed to a person'], ['other', 'Other']];
  const debts = () => all('debts').sort((a, b) => (a.created || 0) - (b.created || 0));
  const openDebts = () => debts().filter(d => (+d.balance || 0) > 0.005);
  const cur = () => (money() && money().currency) || '$';
  const kindName = k => (DEBT_KINDS.find(x => x[0] === k) || DEBT_KINDS[6])[1];
  // the next date a payment is due, from the day of the month it's due
  function nextDue(d, from = today()) {
    if (!d.dueDay) return '';
    const f = pd(from);
    for (let i = 0; i < 2; i++) {
      const y = f.getFullYear(), m = f.getMonth() + i, last = new Date(y, m + 1, 0).getDate();
      const s = ds(new Date(y, m, Math.min(+d.dueDay, last)));
      if (s >= from) return s;
    }
    return '';
  }
  const dueOn = (d, day) => { if (!d.dueDay) return false; const x = pd(day), last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate(); return x.getDate() === Math.min(+d.dueDay, last); };
  // month-by-month payoff. budget = every minimum + extra, kept the same each month, so money
  // freed up by a paid-off debt rolls onto the next one ("rollover"). minimumsOnly pays each debt's minimum and nothing more.
  function simulate(list, extra, strategy, minimumsOnly) {
    const ds_ = list.filter(d => (+d.balance || 0) > 0.005 && (!minimumsOnly || +d.min > 0)).map(d => ({ id: d.id, name: d.name, bal: +d.balance, apr: Math.max(0, +d.apr || 0), min: Math.max(0, +d.min || 0) }));
    const budget = ds_.reduce((a, d) => a + d.min, 0) + (minimumsOnly ? 0 : Math.max(0, +extra || 0));
    const series = [ds_.reduce((a, d) => a + d.bal, 0)], paidOff = {};
    let month = 0, interest = 0;
    while (ds_.some(d => d.bal > 0.005) && month < 600) {
      month++;
      for (const d of ds_) if (d.bal > 0.005) { const i = d.bal * d.apr / 1200; d.bal += i; interest += i; }
      let pool = budget;
      for (const d of ds_) if (d.bal > 0.005) { const p = Math.min(d.min, d.bal, pool); d.bal -= p; pool -= p; }
      if (!minimumsOnly) {
        const order = ds_.filter(d => d.bal > 0.005).sort(strategy === 'snowball' ? (a, b) => a.bal - b.bal || b.apr - a.apr : (a, b) => b.apr - a.apr || a.bal - b.bal);
        for (const d of order) { if (pool <= 0) break; const p = Math.min(pool, d.bal); d.bal -= p; pool -= p; }
      }
      for (const d of ds_) if (d.bal <= 0.005 && !paidOff[d.id]) { d.bal = 0; paidOff[d.id] = month; }
      series.push(ds_.reduce((a, d) => a + d.bal, 0));
    }
    return { months: month, interest, series, paidOff, stuck: ds_.some(d => d.bal > 0.005), budget };
  }
  const monthsLabel = n => { const y = Math.floor(n / 12), m = n % 12; return [y ? `${y} yr${y === 1 ? '' : 's'}` : '', m ? `${m} mo` : ''].filter(Boolean).join(' ') || '0 mo'; };
  const monthOut = n => { const d = pd(today()); d.setDate(1); d.setMonth(d.getMonth() + n); return `${MON[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`; };
  function debtPlan() {
    const s = settings(), list = openDebts();
    const plan = simulate(list, s.debtExtra || 0, s.debtStrategy || 'avalanche', false);
    const base = simulate(list, 0, 'avalanche', true);
    return { plan, base, list, strategy: s.debtStrategy || 'avalanche', extra: +s.debtExtra || 0 };
  }
  // balance over time: your plan (solid) against paying only the minimums (dashed)
  let chartData = null;
  function debtChart(plan, base) {
    const W = 640, H = 180, L = 52, R = 12, T = 12, B = 26;
    const n = Math.max(plan.series.length, base.stuck ? 0 : base.series.length, 2) - 1;
    const max = Math.max(...plan.series, ...base.series.slice(0, n + 1)) || 1;
    const x = i => L + (W - L - R) * i / n, y = v => T + (H - T - B) * (1 - v / max);
    const path = sr => sr.slice(0, n + 1).map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
    const grid = [0, .5, 1].map(f => `<line x1="${L}" x2="${W - R}" y1="${y(max * f)}" y2="${y(max * f)}" class="gl"/><text x="${L - 8}" y="${y(max * f) + 4}" text-anchor="end">${fmtMoney(Math.round(max * f), cur()).replace(/\.\d+$/, '')}</text>`).join('');
    const step = n <= 24 ? 6 : n <= 60 ? 12 : n <= 120 ? 24 : 60;
    const ticks = []; for (let i = 0; i <= n; i += step) ticks.push(`<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${i === 0 ? 'Now' : monthOut(i)}</text>`);
    chartData = { plan: plan.series, base: base.series, n, L, R, W };
    const pEnd = Math.min(plan.series.length - 1, n);
    return `<div class="dchart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Total owed over time. Your plan reaches zero in ${monthsLabel(plan.months)}${base.stuck ? '; minimum payments never clear it' : `; minimums only take ${monthsLabel(base.months)}`}.">
      ${grid}${ticks.join('')}
      <path d="${path(plan.series)}L${x(pEnd)} ${y(0)}L${x(0)} ${y(0)}Z" class="area"/>
      <path d="${path(base.series)}" class="base"/>
      <path d="${path(plan.series)}" class="plan"/>
      <circle cx="${x(pEnd)}" cy="${y(0)}" r="4.5" class="end"/>
      <line class="xh" x1="0" x2="0" y1="${T}" y2="${H - B}" style="display:none"/>
      <rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
    </svg><div class="tip" hidden></div>
    <div class="legend" style="border:0;margin:6px 0 0;padding:0"><span><i class="sw plan"></i>Your plan</span><span><i class="sw base"></i>Minimums only</span></div></div>`;
  }
  document.addEventListener('pointermove', ev => {
    const svg = ev.target.closest && ev.target.closest('.dchart svg'); if (!svg || !chartData) return;
    const r = svg.getBoundingClientRect(), vx = (ev.clientX - r.left) / r.width * chartData.W;
    const i = Math.max(0, Math.min(chartData.n, Math.round((vx - chartData.L) / (chartData.W - chartData.L - chartData.R) * chartData.n)));
    const px = chartData.L + (chartData.W - chartData.L - chartData.R) * i / chartData.n;
    const xh = svg.querySelector('.xh'); xh.setAttribute('x1', px); xh.setAttribute('x2', px); xh.style.display = '';
    const tip = svg.parentElement.querySelector('.tip'), v = chartData.plan[Math.min(i, chartData.plan.length - 1)], b = chartData.base[Math.min(i, chartData.base.length - 1)];
    tip.hidden = false; tip.innerHTML = `<b>${i ? monthOut(i) : 'Now'}</b><span><i class="sw plan"></i>Plan ${fmtMoney(Math.round(v), cur())}</span><span><i class="sw base"></i>Minimums ${fmtMoney(Math.round(b), cur())}</span>`;
    tip.style.left = `${Math.min(r.width - 170, Math.max(0, px / chartData.W * r.width - 85))}px`;
  });
  document.addEventListener('pointerleave', ev => { if (ev.target.closest && ev.target.closest('.dchart svg')) { ev.target.querySelector('.xh').style.display = 'none'; ev.target.parentElement.querySelector('.tip').hidden = true; } }, true);

  function debtRow(d, plan, i) {
    const start = Math.max(+d.start || 0, +d.balance || 0), paid = start - (+d.balance || 0), pct = start ? Math.round(paid / start * 100) : 0;
    const due = nextDue(d), done = (+d.balance || 0) <= 0.005, po = plan && plan.paidOff[d.id];
    const monthlyInt = (+d.balance || 0) * (+d.apr || 0) / 1200;
    return `<div class="debt ${i ? '' : 'first'} ${done ? 'done' : ''}">
      <div class="dtop" data-act="edit-debt" data-id="${d.id}" role="button" tabindex="0">
        <div class="lt"><b>${esc(d.name)}</b><span>${esc(kindName(d.kind))}${d.apr ? ` · ${(+d.apr).toFixed(2).replace(/\.?0+$/, '')}% APR` : ' · no interest'}${d.min ? ` · min ${fmtMoney(+d.min, cur())}` : ''}</span></div>
        <div class="bal"><b class="num">${fmtMoney(+d.balance || 0, cur())}</b><span>${done ? 'Paid off' : po ? `clear by ${monthOut(po)}` : ''}</span></div>
      </div>
      <div class="bar ${done ? '' : 'blue'}" role="img" aria-label="${pct}% paid off"><i style="width:${pct}%"></i></div>
      <div class="dfoot"><span class="num">${pct}% paid${start ? ` of ${fmtMoney(start, cur())}` : ''}</span>${!done && monthlyInt >= 0.01 ? `<span class="num">≈${fmtMoney(Math.round(monthlyInt * 100) / 100, cur())}/mo interest</span>` : ''}${due && !done ? `<span class="${diffDays(today(), due) <= 3 ? 'soon' : ''}">due ${shortDay(due)}</span>` : ''}${!done ? `<button class="btn small" data-act="pay-debt" data-id="${d.id}">${ic('plus', 's')}Payment</button>` : ''}</div>
    </div>`;
  }
  function viewDebts() {
    const all_ = debts(), t = today();
    if (!all_.length) return `<section class="panel"><div class="empty" style="padding:8px 0 12px">Add each debt you owe, like a credit card, a loan or money borrowed from a friend. Meadow works out your debt-free date, how much interest you'll pay and the fastest way to pay it all off.</div><button class="btn solid" data-act="new-debt">${ic('plus', 's')}Add a debt</button></section>`;
    const { plan, base, list, strategy, extra } = debtPlan();
    const total = list.reduce((a, d) => a + +d.balance, 0), mins = list.reduce((a, d) => a + (+d.min || 0), 0);
    const startAll = all_.reduce((a, d) => a + Math.max(+d.start || 0, +d.balance || 0), 0), paidAll = startAll - total;
    const monthInt = list.reduce((a, d) => a + +d.balance * (+d.apr || 0) / 1200, 0);
    const paidMonth = all_.flatMap(d => (d.payments || []).filter(p => p.date.slice(0, 7) === t.slice(0, 7))).reduce((a, p) => a + +p.amount, 0);
    const saveInt = base.stuck ? null : base.interest - plan.interest, saveMo = base.stuck ? null : base.months - plan.months;
    const order = [...list].sort((a, b) => (plan.paidOff[a.id] || 999) - (plan.paidOff[b.id] || 999));
    const recent = all_.flatMap(d => (d.payments || []).map(p => ({ ...p, debt: d }))).sort((a, b) => b.date.localeCompare(a.date) || (b.at || 0) - (a.at || 0)).slice(0, 6);
    return `<section class="panel kpis six span-3" aria-label="Debts at a glance">
        <div class="kpi"><span class="k">${ic('receipt', 'warn')}Total owed</span><span class="v num">${fmtMoney(Math.round(total * 100) / 100, cur())}</span><span class="d">${list.length} debt${list.length === 1 ? '' : 's'}</span></div>
        <div class="kpi"><span class="k">${ic('target', 'accent')}Paid off</span><span class="v num good">${startAll ? Math.round(paidAll / startAll * 100) : 0}%</span><span class="d">${fmtMoney(Math.round(paidAll), cur())} so far</span><span class="meter good"><i style="width:${startAll ? paidAll / startAll * 100 : 0}%"></i></span></div>
        <div class="kpi"><span class="k">${ic('cal', 'accent')}Debt-free</span><span class="v">${plan.stuck ? 'Never' : list.length ? monthOut(plan.months) : 'Now'}</span><span class="d">${plan.stuck ? 'payments too low' : monthsLabel(plan.months)}</span></div>
        <div class="kpi"><span class="k">${ic('wallet', 'accent')}Monthly</span><span class="v num">${fmtMoney(mins + extra, cur())}</span><span class="d">${fmtMoney(mins, cur())} min${extra ? ` + ${fmtMoney(extra, cur())}` : ''}</span></div>
        <div class="kpi"><span class="k">${ic('flame', 'warn')}Interest/mo</span><span class="v num ${monthInt > 0 ? 'warn' : ''}">${fmtMoney(Math.round(monthInt * 100) / 100, cur())}</span><span class="d">${plan.stuck ? '' : `${fmtMoney(Math.round(plan.interest), cur())} total`}</span></div>
        <div class="kpi"><span class="k">${ic('check', 'money')}Paid this month</span><span class="v num">${fmtMoney(Math.round(paidMonth * 100) / 100, cur())}</span><span class="d">${MON[pd(t).getMonth()]}</span></div>
      </section>
      <div class="cols" style="margin-top:14px">
        <section class="panel">${panelHead('chart', 'Payoff plan', '', 'accent')}
          <div class="field" style="margin-bottom:12px"><span class="lbl">Strategy</span><div class="seg" role="group" aria-label="Strategy">
            <button type="button" data-act="debt-strat" data-id="avalanche" class="${strategy === 'avalanche' ? 'on' : ''}">Avalanche<small>highest interest first</small></button>
            <button type="button" data-act="debt-strat" data-id="snowball" class="${strategy === 'snowball' ? 'on' : ''}">Snowball<small>smallest balance first</small></button></div></div>
          <div class="field" style="margin-bottom:12px"><label class="lbl" for="debt-extra">Extra each month, on top of the minimums</label>
            <div class="quick" style="margin:0"><input id="debt-extra" class="num" inputmode="decimal" value="${extra || ''}" placeholder="0" aria-describedby="extra-hint"><button type="button" data-act="debt-extra-set">Update</button></div>
            <div class="minichips">${[0, 25, 50, 100, 250].map(v => `<button type="button" data-act="debt-extra" data-id="${v}" class="${extra === v ? 'on' : ''}">${v ? '+' + fmtMoney(v, cur()) : 'None'}</button>`).join('')}</div></div>
          ${list.length ? debtChart(plan, base) : ''}
          ${plan.stuck ? `<div class="note warn" id="extra-hint">At these payments some debts never get paid off: the interest is bigger than what goes in. Raise a minimum or add an extra amount.</div>`
            : `<div class="minis" id="extra-hint"><div><div class="l">Debt-free</div><div class="v">${monthOut(plan.months)}</div></div><div><div class="l">Interest</div><div class="v">${fmtMoney(Math.round(plan.interest), cur())}</div></div><div><div class="l">vs minimums</div><div class="v ${saveInt > 0.5 ? 'good' : ''}">${base.stuck ? 'never ends' : saveInt > 0.5 ? `−${fmtMoney(Math.round(saveInt), cur())}` : 'same'}</div></div></div>
              ${saveMo > 0 ? `<div class="note">Paying ${fmtMoney(extra, cur())} extra each month clears everything <b>${monthsLabel(saveMo)} sooner</b> and saves ${fmtMoney(Math.round(saveInt), cur())} in interest.</div>` : base.stuck ? '<div class="note">With only the minimums, some debts would never be paid off.</div>' : ''}`}
          ${order.length > 1 ? `<div class="group">Pay-off order</div>${order.map((d, i) => `<div class="cd ${i ? '' : 'first'}"><span class="n ${i ? '' : 'soon'}"><b>${i + 1}</b><small>${i ? 'next' : 'focus'}</small></span><span class="lt"><b>${esc(d.name)}</b><span>${fmtMoney(+d.balance, cur())}${d.apr ? ` · ${+d.apr}%` : ''}</span></span><span class="amt">${plan.paidOff[d.id] ? monthOut(plan.paidOff[d.id]) : '—'}</span></div>`).join('')}` : ''}
        </section>
        <div>
          <section class="panel">${panelHead('receipt', 'Your debts', `<button class="linkbtn" data-act="new-debt">${ic('plus', 's')}Add</button>`, 'accent')}
            ${all_.map((d, i) => debtRow(d, plan, i)).join('')}
          </section>
          <section class="panel">${panelHead('list', 'Recent payments', '', 'accent')}
            ${recent.length ? recent.map((p, i) => `<div class="line ${i ? '' : 'first'}" style="min-height:42px;padding:6px 0"><div class="lt"><b style="font-size:14.5px">${esc(p.debt.name)}</b><span>${dayLabel(p.date)}${p.note ? ' · ' + esc(p.note) : ''}</span></div><span class="amt num">${fmtMoney(+p.amount, cur())}</span></div>`).join('') : '<div class="empty">Log a payment on any debt and it shows here.</div>'}
          </section>
        </div>
      </div>
      <div class="note" style="margin:14px 2px 0">Estimates assume interest is charged monthly at the APR you enter and that you don't add new charges. Debts are kept in Meadow and sync to your phone; Money Quest isn't changed.</div>`;
  }
  function homeDebts() {
    const list = openDebts(); if (!list.length) return '';
    const { plan } = debtPlan(), total = list.reduce((a, d) => a + +d.balance, 0);
    const startAll = debts().reduce((a, d) => a + Math.max(+d.start || 0, +d.balance || 0), 0), pct = startAll ? Math.round((startAll - total) / startAll * 100) : 0;
    const next = list.map(d => ({ d, due: nextDue(d) })).filter(x => x.due).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 2);
    return `<section class="panel">${panelHead('receipt', 'Debts', goLink('debts', 'Plan'), 'accent')}
      <div class="kicker">Total owed</div><div class="big num">${fmtMoney(Math.round(total * 100) / 100, cur())}</div>
      <div class="kv" style="margin-top:10px"><span>${pct}% paid off</span><span>${plan.stuck ? 'payments too low' : `debt-free ${monthOut(plan.months)}`}</span></div><div class="bar" role="img" aria-label="${pct}% paid off"><i style="width:${pct}%"></i></div>
      ${next.length ? `<div class="group">Next payments</div>${next.map((x, i) => `<button class="line ${i ? '' : 'first'}" style="min-height:40px;padding:6px 0" data-act="pay-debt" data-id="${x.d.id}"><div class="lt"><b style="font-size:14.5px">${esc(x.d.name)}</b></div><span class="muted" style="font-size:13px">${shortDay(x.due)}</span><span class="amt num" style="font-size:14px">${x.d.min ? fmtMoney(+x.d.min, cur()) : ''}</span></button>`).join('')}` : ''}
    </section>`;
  }

  // ---------- Game nights ----------
  function viewGames() {
    const d = dice(), L = S.links.dice;
    if (!d) return `<div class="panel"><div class="empty">Waiting for Dice and Luck. Start it on your PC and this fills in by itself.</div>${openLink(appUrl('dice'), 'Open Dice and Luck')}</div>`;
    const shown = new Set(visibleCamps().map(c => c.id));
    const camps = [...d.camps].sort((a, b) => (shown.has(b.id) - shown.has(a.id)) || (a.next ? a.next.date : '9999').localeCompare(b.next ? b.next.date : '9999'));
    return `${staleNote(L, 'Dice and Luck')}
      <section class="panel">${panelHead('dice', 'Campaigns', openLink(appUrl('dice'), 'Dice and Luck'), 'game')}
        ${camps.map((c, i) => `<div class="line ${i ? '' : 'first'}"><span class="lic game">${ic(c.next ? 'cal' : 'dice', 's')}</span><div class="lt"><b>${esc(c.name)}</b><span>${c.next ? `Next: ${dayLabel(c.next.date)}${c.next.time ? ' · ' + esc(timeLabel(c.next.time)) : ''}` : 'No session date set'} · ${c.players} player${c.players === 1 ? '' : 's'}${c.system ? ' · ' + esc(c.system.toUpperCase()) : ''}</span></div>${c.activeJobs ? `<span class="tag">${c.activeJobs} jobs</span>` : ''}${shown.has(c.id) ? '' : '<span class="tag">Hidden</span>'}</div>`).join('')}
        <div class="note">Choose which campaigns show on Home in Settings. Session dates come from Dice and Luck.</div>
      </section>`;
  }

  // ---------- Connections ----------
  function appStatus(L, name, short) {
    if (!L) return '<span class="status wait">Checking…</span>';
    if (L.ok) return `<span class="status ok">${short ? 'Connected' : `Connected · ${ago(L.at)}`}</span>`;
    if (L.error === 'needs-update') return `<span class="status">Needs update</span>`;
    return `<span class="status">Not running${L.at && !short ? ` · last seen ${ago(L.at)}` : ''}</span>`;
  }
  function feedStatus(f) {
    const C = S.cals[f.id];
    if (!C || C.url !== f.url) return '<span class="status wait">Loading…</span>';
    const n = (C.events || []).filter(e => (e.endDate || e.date) >= today()).length;
    if (C.ok) return `<span class="status ok">${n} upcoming · ${ago(C.at)}</span>`;
    const why = { 'not-found': 'link not found', 'not-a-calendar': 'that link isn\'t a calendar', 'bad-link': 'that doesn\'t look like a link', offline: 'no internet on your PC', 'too-big': 'calendar too large' }[C.error] || C.error;
    return `<span class="status">Couldn't load: ${esc(why)}${C.at ? ` · last copy ${ago(C.at)}` : ''}</span>`;
  }
  function viewConnections() {
    const feedRows = feeds().map((f, i) => `<div class="line ${i ? '' : 'first'}"><span class="lic" style="color:${esc(f.color)};background:color-mix(in srgb, ${esc(f.color)} 14%, transparent)">${ic('cal', 's')}</span><div class="lt" data-act="edit-feed" data-id="${f.id}" role="button" tabindex="0" style="cursor:pointer"><b>${esc(f.name || S.cals[f.id]?.calName || 'Calendar')}</b>${feedStatus(f)}</div><button class="switch ${f.on !== false ? 'on' : ''}" data-act="toggle-feed" data-id="${f.id}" role="switch" aria-checked="${f.on !== false}" aria-label="Show ${esc(f.name)}"></button></div>`).join('');
    const appRows = customApps().map(a => `<div class="line"><span class="lic" style="color:${esc(a.color)};background:color-mix(in srgb, ${esc(a.color)} 14%, transparent)">${ic(a.icon || 'bulb', 's')}</span><div class="lt" data-act="edit-app" data-id="${a.id}" role="button" tabindex="0" style="cursor:pointer"><b>${esc(a.name)}</b>${appStatus((S.links.apps || {})[a.id], a.name)}${(() => { const st = (S.links.apps || {})[a.id]?.data?.stats; return Array.isArray(st) && st.length ? `<span>${st.slice(0, 3).map(x => `${esc(x.label)}: ${esc(x.value)}`).join(' · ')}</span>` : ''; })()}</div>${openLink(appUrl(a))}</div>`).join('');
    return `<div class="cols">
      <section class="panel">
        ${panelHead('link', 'Apps on your PC', `<button class="linkbtn" data-act="check-apps">${ic('sync', 's')}Check now</button>`, 'accent')}
        <div class="line first"><span class="lic pay">${ic('wallet', 's')}</span><div class="lt"><b>Money Quest</b>${appStatus(S.links.money, 'Money Quest')}</div>${openLink(appUrl('money'))}</div>
        <div class="line"><span class="lic game">${ic('dice', 's')}</span><div class="lt"><b>Dice and Luck</b>${appStatus(S.links.dice, 'Dice and Luck')}</div>${openLink(appUrl('dice'))}</div>
        ${appRows}
        <div class="btnrow"><button class="btn" data-act="new-app">${ic('plus', 's')}Add another app</button></div>
        <div class="note">Each app keeps running on its own server on your PC. Meadow finds them by itself, checks every minute and only reads from them. If one is closed, you see its last numbers until it's back.</div>
      </section>
      <section class="panel">
        ${panelHead('cal', 'Calendars', '', 'accent')}
        ${feedRows || '<div class="empty">Add a school, iPhone or work calendar with its share link. Its events show up next to yours.</div>'}
        <div class="btnrow"><button class="btn" data-act="new-feed">${ic('plus', 's')}Add a calendar</button></div>
      </section></div>`;
  }

  // ---------- Settings ----------
  function viewSettings() {
    const s = settings();
    const sw = (key, on, label, hint) => `<div class="toggle"><span>${label}${hint ? `<small>${hint}</small>` : ''}</span><button class="switch ${on ? 'on' : ''}" data-act="toggle-set" data-id="${key}" role="switch" aria-checked="${!!on}" aria-label="${label}"></button></div>`;
    const mode = ['light', 'dark', 'auto'].includes(s.theme) ? s.theme : themeMode();
    const ls = lists().map(l => `<div class="listrow"><span class="em" style="color:${esc(l.color)};background:color-mix(in srgb, ${esc(l.color)} 14%, transparent)">${ic(l.icon, 'm')}</span><span class="nm">${esc(l.name)}</span><button class="textbtn" data-act="edit-list" data-id="${l.id}">Edit</button></div>`).join('');
    const d = dice(), hidden = s.hiddenCamps;
    const campRows = d ? d.camps.map(c => { const on = hidden ? !hidden.includes(c.id) : !!(c.next || c.players >= 2); return sw('camp:' + c.id, on, esc(c.name), `${c.players} player${c.players === 1 ? '' : 's'}${c.next ? ' · next ' + dayLabel(c.next.date) : ''}`); }).join('') : '';
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const recs = all('done'), ws = weekStart(today());
    const weeks = [...Array(8)].map((_, i) => { const a = addDays(ws, -7 * (7 - i)), b = addDays(a, 6); return { a, n: recs.filter(r => r.day >= a && r.day <= b).length }; });
    const max = Math.max(1, ...weeks.map(w => w.n));
    return `<div class="cols"><div>
      <section class="panel">${panelHead('user', 'You')}
        <div class="field" style="margin:0"><label for="setname">Your name (for the greeting)</label><input id="setname" class="inp" data-set="name" value="${esc(s.name)}" placeholder="Your name" autocomplete="given-name"></div>
      </section>
      <section class="panel">${panelHead('palette', 'Appearance')}
        <div class="seg" role="group" aria-label="Appearance">${[['light', 'Light'], ['dark', 'Dark'], ['auto', 'Match phone']].map(([v, n]) => `<button type="button" data-act="theme" data-id="${v}" class="${mode === v ? 'on' : ''}">${n}</button>`).join('')}</div>
      </section>
      <section class="panel">${panelHead('eye', 'Show on Home')}
        ${sw('showMoney', s.showMoney !== false, 'Money', 'Safe to spend, bills and paydays')}
        ${sw('hideAmounts', s.hideAmounts, 'Hide amounts', 'Shows ••• instead of numbers, for when others can see your screen')}
        ${sw('showGames', s.showGames !== false, 'Game nights', 'Next sessions from Dice and Luck')}
      </section>
      ${d && s.showGames !== false ? `<section class="panel">${panelHead('dice', 'Campaigns to show', '', 'game')}${campRows.replace('class="toggle"', 'class="toggle first"')}</section>` : ''}
      <section class="panel">${panelHead('list', 'Areas', '<span class="count">Group your tasks and projects</span>')}${ls}<div class="btnrow"><button class="btn" data-act="new-list">${ic('plus', 's')}New area</button></div></section>
      </div><div>
      <section class="panel">${panelHead('sparkle', 'Extras')}
        ${sw('cozy', s.cozy, 'Garden and companion', 'A small meadow on Home where a flower grows for each finished task')}
        ${s.cozy ? `<div class="field" style="margin:4px 0 12px"><label for="setbuddy">Companion's name</label><input id="setbuddy" class="inp" data-set="buddy" value="${esc(s.buddy)}" placeholder="Pip"></div>` : ''}
        ${sw('sound', s.sound, 'Sounds', 'A soft chime when you finish a task')}
      </section>
      <section class="panel">${panelHead('chart', 'Finished tasks')}
        <div class="muted" style="font-size:14px">${recs.length} finished so far · ${streak()}-day streak</div>
        <div class="bars" role="img" aria-label="Tasks finished per week, last 8 weeks">${weeks.map((w, i) => `<div class="${i === 7 ? 'cur' : ''}" style="height:${Math.round(w.n / max * 100)}%"><span>${w.n || ''}</span></div>`).join('')}</div>
        <div class="barlbl" aria-hidden="true">${weeks.map((w, i) => `<span>${i === 7 ? 'Now' : `${pd(w.a).getMonth() + 1}/${pd(w.a).getDate()}`}</span>`).join('')}</div>
      </section>
      ${standalone ? '' : `<section class="panel help">${panelHead('phone', 'Put Meadow on your iPhone')}<ol>
        <li>Make sure Tailscale is on, then open this page in <b>Safari</b>.</li>
        <li>Tap the <b>Share</b> button (the square with an arrow).</li>
        <li>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
      </ol><div class="note">It opens like a normal app and keeps working without signal. Changes sync when your PC is reachable.</div></section>`}
      <section class="panel">${panelHead('cloud', 'Sync and backup')}
        <div class="muted" style="font-size:14px">${syncState === 'offline' ? 'Can\'t reach your PC right now. Everything is saved on this device and will sync later.' : 'Connected to your PC.'}${S.outbox.length ? ` ${S.outbox.length} change${S.outbox.length > 1 ? 's' : ''} waiting.` : ''}</div>
        <div class="btnrow"><button class="btn" data-act="sync-now">${ic('sync', 's')}Sync now</button><a class="btn" href="/api/export" download>${ic('download', 's')}Backup</a></div>
      </section>
      <div class="muted" style="text-align:center;font-size:12.5px;padding:14px 0 20px">Meadow · version 5.1</div>
      </div></div>`;
  }

  // ---------- More (phones) ----------
  function viewMore() {
    const m = money(), d = dice(), t = today(), act = projects().filter(p => p.status === 'active').length;
    const nextG = d ? visibleCamps().filter(c => c.next && c.next.date >= t).sort((a, b) => a.next.date.localeCompare(b.next.date))[0] : null;
    const conn = [S.links.money, S.links.dice].filter(L => L && L.ok).length + customApps().filter(a => (S.links.apps || {})[a.id]?.ok).length;
    const rows = [
      ['projects', 'folder', 'accent', 'Projects', act ? `${act} in progress` : 'House projects, school and more'],
      ['money', 'wallet', 'pay', 'Money', m ? `${fmtMoney(m.safeToSpend, m.currency)} safe to spend` : 'From Money Quest'],
      ['debts', 'receipt', 'bill', 'Debts', openDebts().length ? `${fmtMoney(Math.round(openDebts().reduce((a, d) => a + +d.balance, 0)), cur())} owed · ${openDebts().length} debt${openDebts().length === 1 ? '' : 's'}` : 'Track debts and plan the payoff'],
      ['games', 'dice', 'game', 'Game nights', nextG ? `Next: ${nextG.name}, ${dayLabel(nextG.next.date)}` : 'From Dice and Luck'],
      ['connections', 'link', 'accent', 'Connections', `${conn} app${conn === 1 ? '' : 's'} connected · ${feeds().length} calendar${feeds().length === 1 ? '' : 's'}`],
      ['settings', 'gear', '', 'Settings', 'Appearance, areas, backup'],
    ];
    return `<section class="panel menu">${rows.map(([id, icon, cls, name, sub], i) => `<button class="line ${i ? '' : 'first'}" data-tab="${id}"><span class="lic ${cls}">${ic(icon, 'm')}</span><div class="lt"><b>${name}</b><span>${esc(sub)}</span></div><span class="chev">${ic('right', 's')}</span></button>`).join('')}</section>`;
  }

  // ---------- sheets (editors) ----------
  let sheetState = null, lastFocus = null;
  function openSheet(html, state) {
    sheetState = state || {};
    lastFocus = document.activeElement;
    $('#sheet .panel-s').innerHTML = `<div class="grab" aria-hidden="true"></div>${html}`;
    $('#sheet').hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeSheet() { $('#sheet').hidden = true; sheetState = null; document.body.style.overflow = ''; if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch {} }

  function taskSheet(t, isNew) {
    const ls = lists();
    const cl = t.checklist || [];
    const quick = [['Today', today()], ['Tomorrow', addDays(today(), 1)], ['Next week', addDays(today(), 7)], ['No date', '']];
    openSheet(`
      <h3>${isNew ? 'New task' : 'Edit task'}</h3>
      <div class="field"><label for="f-title">Task</label><input id="f-title" class="inp big" name="title" value="${esc(t.title)}" placeholder="What needs doing?" autocomplete="off"></div>
      <div class="two"><div class="field"><label for="f-list">Area</label><select id="f-list" class="inp" name="list">${ls.map(l => `<option value="${l.id}" ${l.id === (t.list || 'inbox') ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="f-proj">Project</label><select id="f-proj" class="inp" name="project"><option value="">None</option>${projects().filter(p => p.status !== 'done' || p.id === t.project).map(p => `<option value="${p.id}" ${p.id === t.project ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div></div>
      <div class="field"><label for="f-due">When</label>
        <div class="two"><input id="f-due" class="inp" type="date" name="due" value="${esc(t.due)}" aria-label="Date"><input class="inp" type="time" name="time" value="${esc(t.time)}" aria-label="Time (optional)"></div>
        <div class="minichips">${quick.map(([n, v]) => `<button type="button" data-act="due" data-id="${v}" class="${t.due === v ? 'on' : ''}">${n}</button>`).join('')}</div>
      </div>
      <div class="field"><label for="f-rep">Repeat</label><select id="f-rep" class="inp" name="repeat">${REPEATS.map(([v, n]) => `<option value="${v}" ${v === (t.repeat || '') ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="field"><span class="lbl">Priority</span><div class="seg" data-seg="priority" role="group" aria-label="Priority">${[['low', 'Low'], ['normal', 'Normal'], ['high', 'Important']].map(([v, n]) => `<button type="button" data-v="${v}" class="${(t.priority || 'normal') === v ? 'on' : ''}">${n}</button>`).join('')}</div></div>
      <div class="field"><span class="lbl">Checklist</span><div id="cl">${cl.map(c => clRow(c)).join('')}</div>
        <div class="cl"><span class="check" style="opacity:.35" aria-hidden="true"></span><input type="text" id="clnew" placeholder="Add a step" enterkeyhint="done" aria-label="Add a checklist step"></div></div>
      <div class="field"><label for="f-notes">Notes</label><textarea id="f-notes" class="inp" name="notes" placeholder="Anything to remember">${esc(t.notes)}</textarea></div>
      <div class="btnrow">${isNew ? '' : '<button class="btn danger" data-act="delete-task">Delete</button>'}<button class="btn" data-act="close">Cancel</button><button class="btn solid" data-act="save-task">Save</button></div>
    `, { kind: 'task', task: JSON.parse(JSON.stringify(t)), isNew });
    if (isNew) setTimeout(() => $('#sheet [name=title]').focus(), 80);
  }
  const clRow = c => `<div class="cl ${c.done ? 'done' : ''}" data-cid="${c.id}"><button type="button" class="check" data-act="cl-toggle" aria-label="Toggle step"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg></button><input type="text" value="${esc(c.text)}" aria-label="Step"><button type="button" class="rm" data-act="cl-del" aria-label="Remove step">${ic('x', 's')}</button></div>`;
  function readChecklist() {
    return [...document.querySelectorAll('#cl .cl')].map(r => ({ id: r.dataset.cid, text: r.querySelector('input').value.trim(), done: r.classList.contains('done') })).filter(c => c.text);
  }
  function saveTaskSheet() {
    const p = $('#sheet .panel-s'), t = sheetState.task;
    t.title = p.querySelector('[name=title]').value.trim();
    if (!t.title) { p.querySelector('[name=title]').focus(); return; }
    t.list = p.querySelector('[name=list]').value;
    t.project = p.querySelector('[name=project]').value;
    t.due = p.querySelector('[name=due]').value;
    t.time = p.querySelector('[name=time]').value;
    t.repeat = p.querySelector('[name=repeat]').value;
    if (t.repeat && !t.due) t.due = today();
    t.priority = p.querySelector('[data-seg=priority] .on')?.dataset.v || 'normal';
    t.notes = p.querySelector('[name=notes]').value;
    const extra = $('#clnew').value.trim();
    t.checklist = readChecklist();
    if (extra) t.checklist.push({ id: uid(), text: extra, done: false });
    const wasNew = sheetState.isNew;
    put('tasks', t);
    closeSheet();
    toast(wasNew ? 'Task added' : 'Saved');
  }

  function eventSheet(e, isNew, day) {
    openSheet(`
      <h3>${isNew ? 'New event' : 'Edit event'}</h3>
      <div class="field"><label for="e-title">Event</label><input id="e-title" class="inp big" name="title" value="${esc(e.title)}" placeholder="What's happening?" autocomplete="off"></div>
      <div class="toggle">All day<button type="button" class="switch ${e.allDay ? 'on' : ''}" data-act="allday" role="switch" aria-checked="${!!e.allDay}" aria-label="All day"></button></div>
      <div class="field" style="margin-top:12px"><label for="e-date">Date</label><input id="e-date" class="inp" type="date" name="date" value="${esc(e.date)}"></div>
      <div class="field" id="times" ${e.allDay ? 'hidden' : ''}><div class="two"><div><label class="lbl" for="e-start">Starts</label><input id="e-start" class="inp" type="time" name="start" value="${esc(e.start)}"></div><div><label class="lbl" for="e-end">Ends</label><input id="e-end" class="inp" type="time" name="end" value="${esc(e.end)}"></div></div></div>
      <div class="field"><label for="e-rep">Repeat</label><select id="e-rep" class="inp" name="repeat">${REPEATS.map(([v, n]) => `<option value="${v}" ${v === (e.repeat || '') ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="field" id="untilf" ${e.repeat ? '' : 'hidden'}><label for="e-until">Repeat until (optional)</label><input id="e-until" class="inp" type="date" name="until" value="${esc(e.until)}"></div>
      <div class="field"><span class="lbl">Colour</span><div class="swatches" role="group" aria-label="Colour">${COLORS.map((c, i) => `<button type="button" data-act="color" data-id="${c}" class="${(e.color || COLORS[1]) === c ? 'on' : ''}" style="background:${c}" aria-label="Colour ${i + 1}"></button>`).join('')}</div></div>
      <div class="field"><label for="e-loc">Where</label><input id="e-loc" class="inp" name="location" value="${esc(e.location)}" placeholder="Optional"></div>
      <div class="field"><label for="e-notes">Notes</label><textarea id="e-notes" class="inp" name="notes" placeholder="Optional">${esc(e.notes)}</textarea></div>
      <div class="btnrow">${isNew ? '' : '<button class="btn danger" data-act="delete-event">Delete</button>'}<button class="btn" data-act="close">Cancel</button><button class="btn solid" data-act="save-event">Save</button></div>
    `, { kind: 'event', ev: JSON.parse(JSON.stringify(e)), isNew, day });
    if (isNew) setTimeout(() => $('#sheet [name=title]').focus(), 80);
  }
  function saveEventSheet() {
    const p = $('#sheet .panel-s'), e = sheetState.ev;
    e.title = p.querySelector('[name=title]').value.trim();
    if (!e.title) { p.querySelector('[name=title]').focus(); return; }
    e.date = p.querySelector('[name=date]').value || today();
    e.allDay = p.querySelector('[data-act=allday]').classList.contains('on');
    e.start = e.allDay ? '' : p.querySelector('[name=start]').value;
    e.end = e.allDay ? '' : p.querySelector('[name=end]').value;
    e.repeat = p.querySelector('[name=repeat]').value;
    e.until = e.repeat ? p.querySelector('[name=until]').value : '';
    e.location = p.querySelector('[name=location]').value.trim();
    e.notes = p.querySelector('[name=notes]').value;
    e.color = p.querySelector('.swatches .on')?.dataset.id || COLORS[1];
    if (!e.allDay && !e.start) e.allDay = true;
    put('events', e);
    closeSheet(); toast('Saved to your calendar');
  }

  function listSheet(l, isNew) {
    openSheet(`
      <h3>${isNew ? 'New list' : 'Edit list'}</h3>
      <div class="field"><label for="l-name">Name</label><input id="l-name" class="inp big" name="name" value="${esc(l.name)}" placeholder="List name"></div>
      <div class="field"><span class="lbl">Icon</span><div class="minichips icons" data-pick="icon" role="group" aria-label="Icon">${LIST_ICONS.map(n => `<button type="button" class="${l.icon === n ? 'on' : ''}" data-v="${n}" aria-label="${n}">${ic(n)}</button>`).join('')}</div></div>
      <div class="field"><span class="lbl">Colour</span><div class="swatches" role="group" aria-label="Colour">${COLORS.map((c, i) => `<button type="button" data-act="color" data-id="${c}" class="${l.color === c ? 'on' : ''}" style="background:${c}" aria-label="Colour ${i + 1}"></button>`).join('')}</div></div>
      <div class="btnrow">${isNew || l.id === 'inbox' ? '' : '<button class="btn danger" data-act="delete-list">Delete</button>'}<button class="btn" data-act="close">Cancel</button><button class="btn solid" data-act="save-list">Save</button></div>
    `, { kind: 'list', list: JSON.parse(JSON.stringify(l)), isNew });
  }

  // a calendar you follow by link (school, iCloud, Google, Outlook)
  function feedSheet(f, isNew) {
    openSheet(`
      <h3>${isNew ? 'Add a calendar' : 'Edit calendar'}</h3>
      <div class="field"><label for="c-name">Name</label><input id="c-name" class="inp big" name="name" value="${esc(f.name)}" placeholder="e.g. School, Family, Work" autocomplete="off"></div>
      <div class="field"><label for="c-url">Calendar link</label><input id="c-url" class="inp" name="url" type="url" inputmode="url" value="${esc(f.url)}" placeholder="webcal://… or https://….ics" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="field"><span class="lbl">Colour</span><div class="swatches" role="group" aria-label="Colour">${COLORS.map((c, i) => `<button type="button" data-act="color" data-id="${c}" class="${f.color === c ? 'on' : ''}" style="background:${c}" aria-label="Colour ${i + 1}"></button>`).join('')}</div></div>
      <details class="note" style="margin:0 0 16px"><summary style="font-weight:700;cursor:pointer;min-height:32px">Where do I find the link?</summary>
        <p><b>iPhone / iCloud:</b> Calendar app, tap Calendars, tap ⓘ next to the calendar, turn on Public Calendar, then Share Link and Copy.</p>
        <p><b>School portal (Canvas, Blackboard, Outlook):</b> look for “Calendar feed”, “Subscribe” or “Publish calendar” and copy the ICS link.</p>
        <p><b>Google Calendar:</b> on a computer, Settings, pick the calendar, then copy “Secret address in iCal format”.</p>
        <p>Your PC checks it every 30 minutes. Meadow only reads it and never changes it.</p>
      </details>
      <div class="btnrow">${isNew ? '' : '<button class="btn danger" data-act="delete-feed">Remove</button>'}<button class="btn" data-act="close">Cancel</button><button class="btn solid" data-act="save-feed">${isNew ? 'Add' : 'Save'}</button></div>
    `, { kind: 'feed', feed: JSON.parse(JSON.stringify(f)), isNew });
    if (isNew) setTimeout(() => $('#sheet [name=name]').focus(), 80);
  }
  // another app running on your PC, on its own port
  function appSheet(a, isNew) {
    openSheet(`
      <h3>${isNew ? 'Add an app' : 'Edit app'}</h3>
      <div class="field"><label for="a-name">Name</label><input id="a-name" class="inp big" name="name" value="${esc(a.name)}" placeholder="e.g. Recipe box" autocomplete="off"></div>
      <div class="two">
        <div class="field"><label for="a-port">Port on your PC</label><input id="a-port" class="inp" name="port" inputmode="numeric" value="${esc(a.port)}" placeholder="3300"></div>
        <div class="field"><label for="a-ts">Tailscale port</label><input id="a-ts" class="inp" name="tsPort" inputmode="numeric" value="${esc(a.tsPort || '')}" placeholder="Optional"></div>
      </div>
      <div class="field"><span class="lbl">Icon</span><div class="minichips icons" data-pick="icon" role="group" aria-label="Icon">${LIST_ICONS.map(n => `<button type="button" class="${a.icon === n ? 'on' : ''}" data-v="${n}" aria-label="${n}">${ic(n)}</button>`).join('')}</div></div>
      <div class="field"><span class="lbl">Colour</span><div class="swatches" role="group" aria-label="Colour">${COLORS.map((c, i) => `<button type="button" data-act="color" data-id="${c}" class="${a.color === c ? 'on' : ''}" style="background:${c}" aria-label="Colour ${i + 1}"></button>`).join('')}</div></div>
      <div class="note" style="margin:0 0 16px">The port is the number in the app's address, like <b>3300</b> in localhost:3300. Meadow shows whether it's running and gives you a button to open it. If the app shares a summary (see the README), its numbers and dates show up too.</div>
      <div class="btnrow">${isNew ? '' : '<button class="btn danger" data-act="delete-app">Remove</button>'}<button class="btn" data-act="close">Cancel</button><button class="btn solid" data-act="save-app">${isNew ? 'Add' : 'Save'}</button></div>
    `, { kind: 'app', app: JSON.parse(JSON.stringify(a)), isNew });
  }

  function projectSheet(pr, isNew) {
    openSheet(`
      <h3>${isNew ? 'New project' : 'Edit project'}</h3>
      <div class="field"><label for="p-name">Name</label><input id="p-name" class="inp big" name="name" value="${esc(pr.name)}" placeholder="e.g. Paint the bedroom" autocomplete="off"></div>
      <div class="two"><div class="field"><label for="p-area">Area</label><select id="p-area" class="inp" name="area">${lists().map(l => `<option value="${l.id}" ${l.id === pr.area ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="p-target">Finish by</label><input id="p-target" class="inp" type="date" name="target" value="${esc(pr.target)}"></div></div>
      <div class="field"><span class="lbl">Status</span><div class="seg" data-seg="status" role="group" aria-label="Status">${STATUSES.map(([v, n]) => `<button type="button" data-v="${v}" class="${(pr.status || 'planned') === v ? 'on' : ''}">${n}</button>`).join('')}</div></div>
      <div class="field"><label for="p-notes">Notes</label><textarea id="p-notes" class="inp" name="notes" placeholder="Measurements, links, budget, anything useful">${esc(pr.notes)}</textarea></div>
      <div class="btnrow">${isNew ? '' : '<button class="btn danger" data-act="delete-project">Delete</button>'}<button class="btn" data-act="close">Cancel</button><button class="btn solid" data-act="save-project">${isNew ? 'Create' : 'Save'}</button></div>
    `, { kind: 'project', proj: JSON.parse(JSON.stringify(pr)), isNew });
    if (isNew) setTimeout(() => $('#sheet [name=name]').focus(), 80);
  }

  function debtSheet(d, isNew) {
    openSheet(`
      <h3>${isNew ? 'New debt' : 'Edit debt'}</h3>
      <div class="field"><label for="d-name">Name</label><input id="d-name" class="inp big" name="name" value="${esc(d.name)}" placeholder="e.g. Visa, car loan, Alex" autocomplete="off"></div>
      <div class="field"><label for="d-kind">Type</label><select id="d-kind" class="inp" name="kind">${DEBT_KINDS.map(([v, n]) => `<option value="${v}" ${v === d.kind ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="two"><div class="field"><label for="d-bal">Balance owed now</label><input id="d-bal" class="inp num" name="balance" inputmode="decimal" value="${d.balance === '' || d.balance == null ? '' : +d.balance}" placeholder="0.00"></div>
      <div class="field"><label for="d-start">Original amount <small class="muted">(optional)</small></label><input id="d-start" class="inp num" name="start" inputmode="decimal" value="${d.start ? +d.start : ''}" placeholder="for progress"></div></div>
      <div class="two"><div class="field"><label for="d-apr">Interest rate (APR %)</label><input id="d-apr" class="inp num" name="apr" inputmode="decimal" value="${d.apr ? +d.apr : ''}" placeholder="0 if none"></div>
      <div class="field"><label for="d-min">Minimum payment / month</label><input id="d-min" class="inp num" name="min" inputmode="decimal" value="${d.min ? +d.min : ''}" placeholder="0.00"></div></div>
      <div class="field"><label for="d-due">Payment due on day of the month</label><input id="d-due" class="inp num" name="dueDay" inputmode="numeric" value="${d.dueDay || ''}" placeholder="e.g. 15 (leave empty if none)"></div>
      <div class="field"><label for="d-notes">Notes</label><textarea id="d-notes" class="inp" name="notes" placeholder="Account, who to pay, promo rate end date">${esc(d.notes)}</textarea></div>
      <div class="btnrow">${isNew ? '' : '<button class="btn danger" data-act="delete-debt">Delete</button>'}<button class="btn" data-act="close">Cancel</button><button class="btn solid" data-act="save-debt">${isNew ? 'Add debt' : 'Save'}</button></div>
    `, { kind: 'debt', debt: JSON.parse(JSON.stringify(d)), isNew });
    if (isNew) setTimeout(() => $('#sheet [name=name]').focus(), 80);
  }
  function paySheet(d) {
    openSheet(`
      <h3>Payment on ${esc(d.name)}</h3>
      <p class="muted" style="margin:-8px 0 14px">Owed now: <b class="num" style="color:var(--ink)">${fmtMoney(+d.balance, cur())}</b></p>
      <div class="two"><div class="field"><label for="pay-amt">Amount</label><input id="pay-amt" class="inp big num" name="amount" inputmode="decimal" value="${d.min ? Math.min(+d.min, +d.balance) : ''}" placeholder="0.00"></div>
      <div class="field"><label for="pay-date">Date</label><input id="pay-date" class="inp" type="date" name="date" value="${today()}"></div></div>
      <div class="minichips" style="margin:-6px 0 14px">${d.min ? `<button type="button" data-act="pay-fill" data-id="${+d.min}">Minimum</button>` : ''}<button type="button" data-act="pay-fill" data-id="${+d.balance}">Pay it all</button></div>
      <div class="field"><label for="pay-note">Note <small class="muted">(optional)</small></label><input id="pay-note" class="inp" name="note" autocomplete="off"></div>
      <div class="btnrow"><button class="btn" data-act="close">Cancel</button><button class="btn solid" data-act="save-pay">Log payment</button></div>
    `, { kind: 'pay', debt: d.id });
    setTimeout(() => $('#sheet [name=amount]').select(), 80);
  }
  function addSheet() {
    openSheet(`
      <h3>Add</h3>
      <button class="choice" data-act="new-task"><span class="e">${ic('check')}</span><span>New task<small>Something to do, with or without a date</small></span></button>
      <button class="choice" data-act="new-event"><span class="e">${ic('cal')}</span><span>New event<small>Something happening at a set time</small></span></button>
      <button class="choice" data-act="new-project"><span class="e">${ic('folder')}</span><span>New project<small>A bigger job with several steps, like a house project</small></span></button>
      <button class="choice" data-act="new-debt"><span class="e">${ic('receipt')}</span><span>New debt<small>A card, loan or money you owe, with a payoff plan</small></span></button>
    `);
  }

  // ---------- effects ----------
  function toast(msg, undo) {
    $('#toasts').innerHTML = ''; // one message at a time
    const el = document.createElement('div');
    el.className = 'toast'; el.setAttribute('role', 'status');
    el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button>Undo</button>' : ''}`;
    if (undo) el.querySelector('button').onclick = () => { undo(); el.remove(); buddyLine = null; };
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), undo ? 5000 : 2200);
  }
  function petals(el) {
    if (!el || !settings().cozy || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const r = el.getBoundingClientRect(), cols = ['#f7c6d0', '#fbe08a', '#bfe3a5', '#f4a7a0', '#c9b6f0'];
    for (let i = 0; i < 10; i++) {
      const p = document.createElement('i');
      p.className = 'petal';
      const a = Math.random() * Math.PI * 2, dist = 24 + Math.random() * 36;
      p.style.cssText = `left:${r.left + r.width / 2}px;top:${r.top + r.height / 2}px;background:${cols[i % cols.length]};--dx:${Math.cos(a) * dist}px;--dy:${Math.sin(a) * dist + 30}px;--r:${Math.random() * 360}deg`;
      $('#fx').appendChild(p);
      setTimeout(() => p.remove(), 1000);
    }
  }
  let actx = null;
  function chime() {
    if (!settings().sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const now = actx.currentTime;
      [[880, 0], [1318.5, 0.09]].forEach(([f, d]) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0, now + d); g.gain.linearRampToValueAtTime(0.1, now + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, now + d + 0.5);
        o.connect(g).connect(actx.destination); o.start(now + d); o.stop(now + d + 0.55);
      });
    } catch {}
  }

  // ---------- events (clicks, forms) ----------
  document.addEventListener('click', ev => {
    const el = ev.target.closest('[data-act],[data-tab],[data-seg] button,[data-pick] button');
    if (!el) return;
    if (el.dataset.tab) { if (el.dataset.tab === 'projects') projOpen = null; tab = el.dataset.tab; history.replaceState(null, '', '#' + tab); buddyLine = null; if (!$('#sheet').hidden) closeSheet(); window.scrollTo(0, 0); return render(); }
    if (el.parentElement?.dataset.seg || el.parentElement?.dataset.pick) {
      el.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el)); return;
    }
    const id = el.dataset.id, act = el.dataset.act;
    switch (act) {
      case 'add': return addSheet();
      case 'close': return closeSheet();
      case 'done': return completeTask(id, el);
      case 'undone': return uncompleteTask(id);
      case 'edit-task': { const t = get('tasks', id); if (t) taskSheet(t, false); return; }
      case 'new-task': return taskSheet({ id: uid(), title: '', notes: '', list: listFilter !== 'all' && tab === 'tasks' ? listFilter : 'inbox', due: el.dataset.day || (tab === 'home' ? today() : ''), project: tab === 'projects' && projOpen ? projOpen : '', time: '', priority: 'normal', repeat: '', checklist: [], done: false, created: Date.now() }, true);
      case 'save-task': return saveTaskSheet();
      case 'delete-task': { const t = sheetState.task; del('tasks', t.id); closeSheet(); toast('Task deleted', () => put('tasks', t)); return; }
      case 'due': {
        $('#sheet [name=due]').value = id;
        el.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el)); return;
      }
      case 'cl-toggle': el.closest('.cl').classList.toggle('done'); return;
      case 'cl-del': el.closest('.cl').remove(); return;
      case 'new-event': return eventSheet({ id: uid(), title: '', date: el.dataset.day || calSel || today(), allDay: false, start: '', end: '', repeat: '', color: COLORS[1], location: '', notes: '' }, true);
      case 'edit-event': { const e = get('events', id); if (e) eventSheet(e, false, el.dataset.day); return; }
      case 'save-event': return saveEventSheet();
      case 'delete-event': {
        const e = sheetState.ev, day = sheetState.day;
        if (e.repeat && day && day !== e.date) {
          openSheet(`<h3>Delete “${esc(e.title)}”</h3>
            <button class="choice" data-act="del-one"><span class="e">${ic('cal')}</span><span>Only ${esc(dayLabel(day))}<small>Keep the other days</small></span></button>
            <button class="choice" data-act="del-all"><span class="e">${ic('x')}</span><span>Every time<small>Remove the whole series</small></span></button>`, { kind: 'delev', ev: get('events', e.id), day });
          return;
        }
        del('events', e.id); closeSheet(); toast('Event deleted', () => put('events', e)); return;
      }
      case 'del-one': { const e = sheetState.ev; e.skip = [...(e.skip || []), sheetState.day]; put('events', e); closeSheet(); toast('Removed that day'); return; }
      case 'del-all': { const e = sheetState.ev; del('events', e.id); closeSheet(); toast('Event deleted', () => put('events', e)); return; }
      case 'allday': el.classList.toggle('on'); el.setAttribute('aria-checked', el.classList.contains('on')); $('#times').hidden = el.classList.contains('on'); return;
      case 'color': el.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el)); return;
      case 'filter': listFilter = id; if (el.dataset.go) { tab = el.dataset.go; history.replaceState(null, '', '#' + tab); window.scrollTo(0, 0); } return render();
      case 'toggle-done': showDone = !showDone; return render();
      case 'pick-day': calSel = id; return render();
      case 'cal-prev': case 'cal-next': {
        const [y, m] = calMonth.split('-').map(Number), d = new Date(y, m - 1 + (act === 'cal-next' ? 1 : -1), 1);
        calMonth = ds(d).slice(0, 7); return render();
      }
      case 'cal-today': calMonth = today().slice(0, 7); calSel = today(); return render();
      case 'theme': return setSetting('theme', id);
      case 'goto-day': calSel = id; calMonth = id.slice(0, 7); tab = 'calendar'; history.replaceState(null, '', '#calendar'); window.scrollTo(0, 0); return render();
      case 'new-project': return projectSheet({ id: uid(), name: '', area: listFilter !== 'all' && tab === 'tasks' ? listFilter : 'home', status: 'active', target: '', notes: '', created: Date.now() }, true);
      case 'open-project': projOpen = id; tab = 'projects'; history.replaceState(null, '', '#projects'); window.scrollTo(0, 0); return render();
      case 'close-project': projOpen = null; return render();
      case 'edit-project': { const pr = get('projects', id); if (pr) projectSheet(pr, false); return; }
      case 'finish-project': { const pr = get('projects', id); if (pr) { const before = { ...pr }; put('projects', { ...pr, status: 'done', finishedAt: Date.now() }); chime(); toast(`Finished ${pr.name}`, () => put('projects', before)); } return; }
      case 'save-project': {
        const p = $('#sheet .panel-s'), pr = sheetState.proj;
        pr.name = p.querySelector('[name=name]').value.trim(); if (!pr.name) return p.querySelector('[name=name]').focus();
        pr.area = p.querySelector('[name=area]').value; pr.target = p.querySelector('[name=target]').value;
        pr.status = p.querySelector('[data-seg=status] .on')?.dataset.v || 'planned'; pr.notes = p.querySelector('[name=notes]').value;
        const wasNew = sheetState.isNew; put('projects', pr); closeSheet();
        if (wasNew) { projOpen = pr.id; tab = 'projects'; history.replaceState(null, '', '#projects'); window.scrollTo(0, 0); render(); }
        toast(wasNew ? 'Project created. Add its first step.' : 'Saved'); if (wasNew) setTimeout(() => $('#qproj')?.focus(), 50); return;
      }
      case 'delete-project': {
        const pr = sheetState.proj, ts = projTasks(pr.id);
        ts.forEach(t => put('tasks', { ...t, project: '' }));
        del('projects', pr.id); projOpen = null; closeSheet(); toast(`Deleted ${pr.name}. Its steps stay in Tasks.`); return;
      }
      case 'toggle-set': {
        if (id.startsWith('camp:')) {
          const cid = id.slice(5), shown = visibleCamps().map(c => c.id);
          const hiddenNow = (dice()?.camps || []).map(c => c.id).filter(x => !shown.includes(x));
          return setSetting('hiddenCamps', shown.includes(cid) ? [...hiddenNow, cid] : hiddenNow.filter(x => x !== cid));
        }
        return setSetting(id, !settings()[id]);
      }
      case 'buddy': {
        const b = el.querySelector('.buddy'); b.classList.remove('wiggle'); void b.offsetWidth; b.classList.add('wiggle');
        const lines = ['Hello there.', 'Finish a task and I\'ll grow a flower.', 'Drink some water today.', 'You\'re doing better than you think.', 'Small steps still move you forward.', 'Take a deep breath.'];
        const say = $('#sayline'); if (say) say.textContent = lines[Math.floor(Math.random() * lines.length)];
        return;
      }
      case 'edit-list': return listSheet(listOf(id), false);
      case 'new-list': return listSheet({ id: uid(), name: '', icon: 'leaf', color: COLORS[0], order: lists().length }, true);
      case 'save-list': {
        const p = $('#sheet .panel-s'), l = sheetState.list;
        l.name = p.querySelector('[name=name]').value.trim(); if (!l.name) return p.querySelector('[name=name]').focus();
        l.icon = p.querySelector('[data-pick=icon] .on')?.dataset.v || l.icon;
        l.color = p.querySelector('.swatches .on')?.dataset.id || l.color;
        delete l.emoji;
        put('lists', l); closeSheet(); return;
      }
      case 'delete-list': {
        const l = sheetState.list;
        all('tasks').filter(t => t.list === l.id).forEach(t => { t.list = 'inbox'; put('tasks', t); });
        del('lists', l.id); if (listFilter === l.id) listFilter = 'all';
        closeSheet(); toast(`Deleted ${l.name}. Its tasks moved to Inbox.`); return;
      }
      case 'sync-now': sync(); refreshLinks(true); refreshCals(true); return;
      case 'check-apps': refreshLinks(true).then(() => toast('Checked your apps')); return;
      case 'feed-ev': { const f = get('feeds', id); toast(`From ${f ? f.name || 'a linked calendar' : 'a linked calendar'}. Change it in that calendar.`); return; }
      case 'new-feed': { const used = feeds().map(f => f.color); return feedSheet({ id: uid(), name: '', url: '', color: COLORS.find(c => !used.includes(c)) || COLORS[2], on: true, created: Date.now() }, true); }
      case 'edit-feed': { const f = get('feeds', id); if (f) feedSheet(f, false); return; }
      case 'toggle-feed': { const f = get('feeds', id); if (f) put('feeds', { ...f, on: f.on === false }); return; }
      case 'save-feed': {
        const p = $('#sheet .panel-s'), f = sheetState.feed;
        const url = p.querySelector('[name=url]').value.trim();
        if (!/^(webcals?|https?):\/\/\S+$/i.test(url)) { toast('Paste the calendar link (starts with webcal:// or https://)'); return p.querySelector('[name=url]').focus(); }
        f.url = url;
        f.name = p.querySelector('[name=name]').value.trim() || (S.cals[f.id] && S.cals[f.id].calName) || 'Calendar';
        f.color = p.querySelector('.swatches .on')?.dataset.id || f.color;
        const wasNew = sheetState.isNew;
        calsDirty = true; put('feeds', f); closeSheet();
        toast(wasNew ? `Added ${f.name}. Loading its events…` : 'Saved'); return;
      }
      case 'delete-feed': { const f = sheetState.feed; del('feeds', f.id); closeSheet(); toast(`Removed ${f.name}`, () => { calsDirty = true; put('feeds', f); }); return; }
      case 'new-app': return appSheet({ id: uid(), name: '', port: '', tsPort: '', icon: 'bulb', color: COLORS[3], on: true, created: Date.now() }, true);
      case 'edit-app': { const a = get('apps', id); if (a) appSheet(a, false); return; }
      case 'save-app': {
        const p = $('#sheet .panel-s'), a = sheetState.app;
        a.name = p.querySelector('[name=name]').value.trim(); if (!a.name) return p.querySelector('[name=name]').focus();
        const port = +p.querySelector('[name=port]').value.trim(), ts = p.querySelector('[name=tsPort]').value.trim();
        if (!Number.isInteger(port) || port < 1 || port > 65535) { toast('The port is a number, like 3300'); return p.querySelector('[name=port]').focus(); }
        if (port === 3200 || port === 3100 || port === 3000) { toast(port === 3200 ? 'That port is Meadow itself' : 'That app is already connected'); return; }
        a.port = port; a.tsPort = /^\d{1,5}$/.test(ts) ? +ts : '';
        a.icon = p.querySelector('[data-pick=icon] .on')?.dataset.v || a.icon;
        a.color = p.querySelector('.swatches .on')?.dataset.id || a.color;
        calsDirty = true; put('apps', a); closeSheet(); toast(`Connected ${a.name}`); return;
      }
      case 'new-debt': return debtSheet({ id: uid(), name: '', kind: 'card', balance: '', start: '', apr: '', min: '', dueDay: '', notes: '', payments: [], created: Date.now() }, true);
      case 'edit-debt': { const d = get('debts', id); if (d) debtSheet(d, false); return; }
      case 'save-debt': {
        const p = $('#sheet .panel-s'), d = sheetState.debt, num = n => { const v = parseFloat(String(p.querySelector(`[name=${n}]`).value).replace(/[^0-9.\-]/g, '')); return isNaN(v) ? 0 : v; };
        d.name = p.querySelector('[name=name]').value.trim(); if (!d.name) return p.querySelector('[name=name]').focus();
        d.kind = p.querySelector('[name=kind]').value; d.balance = Math.max(0, num('balance')); d.apr = Math.max(0, num('apr')); d.min = Math.max(0, num('min'));
        d.start = Math.max(num('start'), sheetState.isNew ? d.balance : 0); const dd = Math.round(num('dueDay')); d.dueDay = dd >= 1 && dd <= 31 ? dd : '';
        d.notes = p.querySelector('[name=notes]').value;
        const wasNew = sheetState.isNew; put('debts', d); closeSheet();
        if (wasNew && tab !== 'debts') { tab = 'debts'; history.replaceState(null, '', '#debts'); window.scrollTo(0, 0); render(); }
        toast(wasNew ? `Added ${d.name}` : 'Saved'); return;
      }
      case 'delete-debt': { const d = sheetState.debt; del('debts', d.id); closeSheet(); toast(`Deleted ${d.name}`, () => put('debts', d)); return; }
      case 'pay-debt': { const d = get('debts', id); if (d) paySheet(d); return; }
      case 'pay-fill': { $('#sheet [name=amount]').value = id; return; }
      case 'save-pay': {
        const p = $('#sheet .panel-s'), d = get('debts', sheetState.debt); if (!d) return closeSheet();
        const amt = parseFloat(String(p.querySelector('[name=amount]').value).replace(/[^0-9.]/g, '')); if (!(amt > 0)) return p.querySelector('[name=amount]').focus();
        const before = JSON.parse(JSON.stringify(d)), pay = { id: uid(), date: p.querySelector('[name=date]').value || today(), amount: Math.round(amt * 100) / 100, note: p.querySelector('[name=note]').value.trim(), at: Date.now() };
        const nb = Math.max(0, Math.round((+d.balance - pay.amount) * 100) / 100);
        put('debts', { ...d, balance: nb, payments: [...(d.payments || []), pay] }); closeSheet();
        if (nb === 0) { chime(); toast(`${d.name} is paid off!`, () => put('debts', before)); } else toast(`Logged ${fmtMoney(pay.amount, cur())}. ${fmtMoney(nb, cur())} left.`, () => put('debts', before));
        return;
      }
      case 'debt-strat': return setSetting('debtStrategy', id);
      case 'debt-extra': return setSetting('debtExtra', +id);
      case 'debt-extra-set': { const v = parseFloat(String($('#debt-extra').value).replace(/[^0-9.]/g, '')); return setSetting('debtExtra', isNaN(v) ? 0 : Math.round(v * 100) / 100); }
      case 'delete-app': { const a = sheetState.app; del('apps', a.id); closeSheet(); toast(`Removed ${a.name}`, () => put('apps', a)); return; }
    }
  });
  document.addEventListener('submit', ev => {
    const f = ev.target.closest('[data-form]'); if (!f) return;
    ev.preventDefault();
    const q = f.q.value.trim(); if (!q) return;
    const parsed = parseQuick(q);
    if (f.dataset.form === 'quick-today') addTask({ title: parsed.title, priority: parsed.priority, due: parsed.due || today() });
    else if (f.dataset.form === 'quick-project') { const pr = get('projects', f.dataset.id); addTask({ title: parsed.title, priority: parsed.priority, due: parsed.due, list: pr ? pr.area : 'inbox', project: f.dataset.id }); }
    else addTask({ title: parsed.title, priority: parsed.priority, due: parsed.due, list: listFilter === 'all' ? 'inbox' : listFilter });
    toast(parsed.due && parsed.due !== today() ? `Added for ${dayLabel(parsed.due)}` : 'Task added');
    setTimeout(() => { const i = document.querySelector(`[data-form=${f.dataset.form}] input`); if (i) i.focus(); }, 0);
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && ev.target.id === 'debt-extra') { ev.preventDefault(); $('[data-act=debt-extra-set]').click(); return; }
    if (ev.key === 'Escape' && !$('#sheet').hidden) closeSheet();
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('[role=button][data-act]')) { ev.preventDefault(); ev.target.click(); }
    if (ev.key === 'Enter' && ev.target.id === 'clnew') {
      ev.preventDefault();
      const v = ev.target.value.trim(); if (!v) return;
      $('#cl').insertAdjacentHTML('beforeend', clRow({ id: uid(), text: v, done: false }));
      ev.target.value = '';
    }
  });
  document.addEventListener('change', ev => { const k = ev.target.dataset?.set; if (k) setSetting(k, ev.target.value.trim()); });
  document.addEventListener('change', ev => { if (ev.target.name === 'repeat' && $('#untilf')) $('#untilf').hidden = !ev.target.value; });

  // keep things fresh: sync every 20 s, other apps every 2 min, redraw when the hour or day changes
  setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 20000);
  setInterval(() => { if (document.visibilityState === 'visible') refreshLinks(); }, 60000);
  setInterval(() => { if (document.visibilityState === 'visible') refreshCals(); }, 10 * 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { sync(); refreshLinks(); refreshCals(); render(); } });
  window.addEventListener('online', () => { sync(); refreshLinks(); refreshCals(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (settings().theme === 'auto') render(); });
  window.addEventListener('scroll', () => $('#top').classList.toggle('scrolled', window.scrollY > 4), { passive: true });
  let lastDay = today(), lastHour = new Date().getHours();
  setInterval(() => {
    const h = new Date().getHours();
    if (today() !== lastDay || h !== lastHour) { lastDay = today(); lastHour = h; buddyLine = null; if ($('#sheet').hidden) render(); }
  }, 60000);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  render();
  sync();
  refreshLinks();
  refreshCals();
  window.MEADOW = { S, sync, parseQuick, nextDate, occursOn };
})();
