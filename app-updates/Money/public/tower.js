'use strict';
/* Money Quest — Wizard Tower, coins & reward shop, recurring bills, quickstart, live sync.
   Loaded after app.js and shares its helpers (S, api, mutate, fmt, today, cat, ...). */

/* ---------------- coins ----------------
   Coins are real money you've earned the right to spend on fun. 1 coin = 1 of your currency.
   They come from only two places:
     1. a % of every amount you put aside (tower vault or goals)
     2. a % of what's left under budget when a month ends
   Taking money back out of savings takes those coins away again. */
const rates = () => ({ save: S.db.settings.rewardRate ?? 10, under: S.db.settings.underBudgetRate ?? 20 });

/* ---------------- need / want / junk ---------------- */
const KIND = {
  need: { label: 'Need', plural: 'Needs', icon: '✅', color: 'var(--good)', desc: 'Necessary: rent, bills, groceries, gas' },
  want: { label: 'Want', plural: 'Wants', icon: '🟡', color: 'var(--warn)', desc: 'Nice to have' },
  junk: { label: 'Junk', plural: 'Junk', icon: '🚫', color: 'var(--bad)', desc: 'Fast food & things you regret' },
};
const kindOf = c => (KIND[c.kind] ? c.kind : 'want');
const txKind = t => kindOf(cat(t.category));
function kindTotals(list) {
  const o = { need: 0, want: 0, junk: 0 };
  list.forEach(t => { if (t.type === 'expense') o[txKind(t)] += t.amount; });
  return o;
}
// Average necessary spending from your finished months (the last 3 with real activity).
function avgNeeds() {
  const curYm = ymOf(today()), byMonth = {};
  for (const t of S.db.transactions) {
    if (t.type !== 'expense') continue;
    const m = ymOf(t.date);
    if (m >= curYm) continue;
    const o = byMonth[m] || (byMonth[m] = { n: 0, need: 0 });
    o.n++; if (txKind(t) === 'need') o.need += t.amount;
  }
  const months = Object.keys(byMonth).filter(m => byMonth[m].n >= 5).sort().slice(-3);
  if (!months.length) return null;
  return { avg: sum(months.map(m => byMonth[m].need)) / months.length, months };
}

/* ---------------- the tower ---------------- */
const FLOORS = [
  [0, 'Dusty Cellar', '🕯️'], [100, 'Apprentice Room', '📜'], [250, 'Library', '📚'], [500, 'Alchemy Lab', '⚗️'],
  [1000, 'Observatory', '🔭'], [2500, 'Crystal Chamber', '💎'], [5000, "Dragon's Lair", '🐉'], [10000, 'Enchanted Spire', '✨'],
  [25000, 'Sky Throne', '👑'], [50000, 'Celestial Peak', '🌌'], [100000, 'Realm of Legends', '🌟'],
];
const floorIndex = total => { let i = 0; FLOORS.forEach((f, k) => { if (total >= f[0]) i = k; }); return i; };
const vaultTotal = () => sum(S.db.vault.map(v => v.amount));
const towerTotal = () => vaultTotal() + sum(S.db.goals.map(goalSaved));
const initialHoard = () => sum(S.db.vault.filter(v => v.initial).map(v => v.amount));
const savedByYou = () => sum(S.db.vault.filter(v => !v.initial).map(v => v.amount)) + sum(S.db.goals.map(goalSaved));

// Wallet = the balance you entered, moved by everything you log after entering it.
function walletBalance() {
  const s = S.db.settings;
  if (!s.balanceAnchor) return null;
  const after = x => (x.createdAt || '') >= s.balanceAnchor;
  let bal = s.startBalance;
  for (const t of S.db.transactions) if (after(t)) bal += t.type === 'income' ? t.amount : -t.amount;
  for (const v of S.db.vault) if (!v.initial && after(v)) bal -= v.amount;
  for (const g of S.db.goals) for (const d of g.deposits) if (after(d)) bal -= d.amount;
  return bal + sharedWalletAdjust(s.balanceAnchor); // who really paid shared costs
}

function computeCoins() {
  const db = S.db, s = db.settings, r = rates(), curYm = ymOf(today());
  const onTime = db.transactions.filter(t => t.type === 'expense' && t.recurringId && t.date <= t.dueDate).length; // for XP

  const saved = Math.max(0, savedByYou());
  const fromSaving = Math.floor(saved * r.save / 100);

  // finished months where you spent less than your budget
  const months = {};
  db.transactions.forEach(t => {
    if (t.type !== 'expense') return;
    const m = ymOf(t.date), o = months[m] || (months[m] = { n: 0, spent: 0 });
    o.n++; o.spent += t.amount;
  });
  const underMonths = Object.entries(months)
    .filter(([m, o]) => m < curYm && o.n >= 5 && o.spent < s.monthlyBudget)
    .map(([m, o]) => ({ m, left: s.monthlyBudget - o.spent, coins: Math.floor((s.monthlyBudget - o.spent) * r.under / 100) }));
  const fromUnder = sum(underMonths.map(x => x.coins));

  // this month so far: what you'd get if the month ended today
  const nowSpent = months[curYm]?.spent || 0;
  const pending = Math.max(0, Math.floor((s.monthlyBudget - nowSpent) * r.under / 100));

  const earned = fromSaving + fromUnder;
  const spent = sum(db.redemptions.map(x => x.cost));
  return { earned, spent, balance: earned - spent, saved, fromSaving, fromUnder, underMonths, pending, onTime };
}

/* ---------------- recurring bills & paydays ---------------- */
// Same rules as the server: due dates between from..to, never before the day the item was added.
function occurrences(r, from, to) {
  if (r.from > from) from = r.from;
  const out = [];
  if (from > to) return out;
  if (r.freq === 'monthly') {
    let [y, m] = from.split('-').map(Number);
    for (let guard = 0; guard < 600; guard++) {
      const d = `${y}-${pad(m)}-${pad(Math.min(r.day, new Date(y, m, 0).getDate()))}`;
      if (d > to) break;
      if (d >= from) out.push(d);
      if (++m > 12) { m = 1; y++; }
    }
  } else {
    const step = r.freq === 'weekly' ? 7 : 14;
    let d = r.anchor;
    while (d < from) d = addDays(d, step);
    while (addDays(d, -step) >= from) d = addDays(d, -step);
    for (let guard = 0; d <= to && guard < 600; guard++) { out.push(d); d = addDays(d, step); }
  }
  return out;
}
const isLogged = (r, due) => S.db.transactions.some(t => t.recurringId === r.id && t.dueDate === due);
const isOpen = (r, due) => !isLogged(r, due) && !r.skipped.includes(due);
function dueItems(days = 7) {
  const t = today(), until = addDays(t, days), out = [];
  for (const r of S.db.recurring) {
    const from = r.autopay ? addDays(t, 1) : r.from; // auto ones handle themselves; show only upcoming
    for (const d of occurrences(r, from, until)) if (isOpen(r, d)) out.push({ r, due: d });
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}
const nextDue = r => occurrences(r, today(), addDays(today(), 400)).find(d => isOpen(r, d));
const ordinal = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const weekday = ds => parseDate(ds).toLocaleDateString(undefined, { weekday: 'long' });
function schedText(r) {
  if (r.freq === 'monthly') return `Monthly on the ${ordinal(r.day)}`;
  return `${r.freq === 'weekly' ? 'Every' : 'Every other'} ${weekday(r.anchor)}`;
}
const perMonth = r => r.freq === 'weekly' ? r.amount * 52 / 12 : r.freq === 'biweekly' ? r.amount * 26 / 12 : r.amount;
function dueLabel(due) {
  const days = Math.round((parseDate(due) - parseDate(today())) / 864e5);
  if (days < 0) return `<span class="bad">Overdue ${-days} day${days === -1 ? '' : 's'}</span>`;
  if (days === 0) return '<span class="warn">Due today</span>';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days · ${parseDate(due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

/* ---------------- needs vs wants vs junk card ---------------- */
function kindCard(m, isNow) {
  const k = kindTotals(m.exp), total = k.need + k.want + k.junk;
  const a = avgNeeds();
  const junkN = m.exp.filter(t => txKind(t) === 'junk').length;
  const pct = v => total ? v / total * 100 : 0;
  let avgLine;
  if (a) {
    const lbl = a.months.map(x => monthLabel(x, true)).join(', ');
    avgLine = `📊 <b>Your average necessary spending: ${fmt0(a.avg)}/month</b> <span class="muted">(${lbl}${a.months.length < 2 ? '. Gets more accurate after 2 months' : ''})</span>`;
    if (isNow) avgLine += `<br><span class="muted">This month so far: ${fmt0(k.need)} of needs.</span>`;
  } else {
    avgLine = `📊 <span class="muted">Your average necessary spending appears after your first full month of logging. So far: ${fmt0(k.need)} of needs.</span>`;
  }
  return `<div class="card">
    <div class="card-row"><b>Needs vs wants vs junk</b><span class="muted small num">${fmt0(total)}</span></div>
    ${total ? `<div class="meter split" style="margin-top:10px">${['need', 'want', 'junk'].map(x => `<i style="width:${pct(k[x])}%;background:${KIND[x].color}"></i>`).join('')}</div>` : ''}
    <div class="kind-rows">${['need', 'want', 'junk'].map(x => `<div class="kind-row kind-${x}"><span>${KIND[x].icon} ${KIND[x].plural}</span><b class="num">${fmt0(k[x])}</b><span class="muted small">${pct(k[x]).toFixed(0)}%</span></div>`).join('')}</div>
    ${junkN ? `<p class="small bad" style="margin:8px 0 0">🍟 ${junkN} fast-food buy${junkN === 1 ? '' : 's'} ${isNow ? 'this month' : 'that month'}: ${fmt(k.junk)} that could have gone into your tower.</p>` : total ? `<p class="small good" style="margin:8px 0 0">🥦 Zero junk ${isNow ? 'this month so far' : 'that month'}. Nice!</p>` : ''}
    <p class="small" style="margin:10px 0 0">${avgLine}</p>
  </div>`;
}

/* ---------------- home widgets ---------------- */
function payFirstLine() {
  const ym = ymOf(today());
  const pays = S.db.transactions.filter(t => isPaycheck(t) && ymOf(t.date) === ym);
  if (!pays.length) return '';
  const saved = sum(pays.map(t => t.saveDone || 0)), done = pays.filter(t => t.saveDone > 0).length;
  const waiting = pendingSaves().length;
  return `<div class="card tap" data-action="${waiting ? 'open-save' : 'tab'}" data-tab="tower" style="padding:10px 14px">
    <div class="card-row small"><span>🏦 <b>Paid yourself first:</b> ${fmt0(saved)} from ${done}/${pays.length} paycheck${pays.length === 1 ? '' : 's'} this month</span>
    ${waiting ? '<span class="link">Save now ›</span>' : ''}</div></div>`;
}
function homeTreasure() {
  const w = walletBalance(), t = towerTotal(), c = computeCoins();
  const f = FLOORS[floorIndex(t)];
  const afford = [...S.db.rewards].sort((a, b) => a.cost - b.cost).find(r => r.cost <= c.balance);
  const cheapest = [...S.db.rewards].sort((a, b) => a.cost - b.cost).find(r => r.cost > c.balance);
  return `<div class="grid2" style="margin-bottom:12px">
      <div class="card stat-tile tap" data-action="wallet">
        <div class="label">${ic('wallet')} Wallet</div>
        <div class="value num ${w != null && w < 0 ? 'bad' : ''}">${w == null ? '—' : fmt0(w)}</div>
        <div class="delta muted">${w == null ? 'tap to set your balance' : 'spending money'}</div>
      </div>
      <div class="card stat-tile tap tower-tile" data-action="tab" data-tab="tower">
        <div class="label">${ic('tower')} Wizard Tower</div>
        <div class="value num" style="color:var(--gold)">${fmt0(t)}</div>
        <div class="delta muted">${f[2]} ${f[1]}</div>
      </div>
    </div>
    ${homeSafe()}
    ${payFirstLine()}
    <div class="card tap shop-tile" data-action="tab" data-tab="shop">
      <div class="card-row">
        <div><b>${COIN} ${c.balance.toLocaleString()} reward coins</b> <span class="muted small">= ${fmt0(c.balance)} of guilt-free fun</span>
          <div class="muted small">${afford ? `✨ Unlocked: ${esc(afford.emoji)} ${esc(afford.name)}. Tap to activate!` : cheapest ? `${cheapest.cost - c.balance} more to unlock ${esc(cheapest.emoji)} ${esc(cheapest.name)}` : 'Add rewards to your reward levels'}</div></div>
        <span class="link">${ic('gift')} Rewards ›</span>
      </div>
    </div>`;
}
function homeBills() {
  const items = dueItems(7);
  if (!S.db.recurring.length) return '';
  return `<h2 style="display:flex;justify-content:space-between">Bills & paydays <button class="link" data-action="tab" data-tab="bills">Manage</button></h2>
    <div class="card">${items.length ? items.slice(0, 6).map(({ r, due }) => billRow(r, due)).join('')
      : '<div class="muted small">Nothing due in the next 7 days. 😌</div>'}</div>`;
}
const amountText = r => r.variable ? (r.amount ? `~${fmt0(r.amount)}` : 'varies') : `${r.type === 'income' ? '+' : ''}${fmt(r.amount)}`;
function billRow(r, due) {
  const inc = r.type === 'income';
  const action = r.autopay
    ? '<span class="tag auto">AUTO</span>'
    : `<button class="btn small-btn ${inc ? '' : 'gold'}" data-action="pay-bill" data-id="${r.id}" data-due="${due}">${r.variable ? 'Enter pay' : inc ? 'Got it' : 'Pay'}</button>`;
  return `<div class="tx bill">
    <div class="ic">${esc(r.emoji)}</div>
    <div class="info"><b>${esc(r.name)}</b><span>${dueLabel(due)}</span></div>
    <div style="text-align:right"><div class="amt num ${inc ? 'income' : ''}">${amountText(r)}</div></div>
    ${action}
  </div>`;
}

/* ---------------- Wizard Tower view ---------------- */
function viewTower() {
  const total = towerTotal(), fi = floorIndex(total), next = FLOORS[fi + 1];
  const cur0 = FLOORS[fi][0];
  const prog = next ? (total - cur0) / (next[0] - cur0) * 100 : 100;
  const show = FLOORS.slice(0, Math.min(FLOORS.length, fi + 3)).map((f, i) => ({ f, i })).reverse();
  const piles = Math.min(12, 1 + Math.floor(Math.log2(1 + total / 50)));
  let html = `<div class="tower-hero">
      <div class="small muted" style="letter-spacing:.12em;text-transform:uppercase;font-weight:700">Gold in your tower</div>
      <div class="hoard num">${fmt0(total)}</div>
      <div style="color:var(--xp-2);font-weight:700">Floor ${fi + 1}: ${FLOORS[fi][2]} ${FLOORS[fi][1]}</div>
      ${next ? `<div class="xpbar" style="margin:12px auto 4px;max-width:280px"><i style="width:${clamp(prog, 0, 100)}%;background:linear-gradient(90deg,#e8a317,var(--gold))"></i></div>
        <div class="small muted">${fmt0(next[0] - total)} more to unlock ${next[2]} ${next[1]}</div>`
      : '<div class="small muted" style="margin-top:8px">You built the whole tower. Legendary. 👑</div>'}
    </div>
    <div class="tower">
      <div class="roof"><span>${fi >= FLOORS.length - 1 ? '🌟' : '⭐'}</span></div>
      ${show.map(({ f, i }) => {
        const unlocked = i <= fi, current = i === fi;
        return `<div class="floor ${unlocked ? 'lit' : 'locked'} ${current ? 'current' : ''}">
          <span class="window">${unlocked ? f[2] : '🔒'}</span>
          <span class="f-name">${unlocked || i === fi + 1 ? f[1] : '???'}</span>
          <span class="f-at num">${current ? '🧙' : unlocked ? '✓' : fmt0(f[0])}</span>
        </div>`;
      }).join('')}
      <div class="tower-base">${'💰'.repeat(piles)}</div>
    </div>
    <h2>The vault</h2>
    <div class="card">
      <div class="card-row"><div><b>🗝️ Free gold</b><div class="muted small">Savings not tied to a goal</div></div><b class="num big" style="color:var(--gold)">${fmt0(vaultTotal())}</b></div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn gold" data-action="vault" data-w="0">⬆️ Store gold</button>
        <button class="btn" data-action="vault" data-w="1">⬇️ Take out</button>
      </div>
      <p class="muted small" style="margin:10px 0 0">${rates().save}% of everything you store becomes reward coins. Storing gold moves it out of your wallet.</p>
      <label class="check-row" style="margin:12px 0 0"><input id="tw-autosave" type="checkbox" ${S.db.settings.autoSave ? 'checked' : ''}> 🤖 Auto-save a realistic amount from every paycheck</label>
    </div>`;
  if (S.db.goals.length) {
    html += `<div class="card small">${S.db.goals.map(g => `<div class="card-row" style="padding:4px 0"><span>${esc(g.emoji)} ${esc(g.name)}</span><b class="num">${fmt0(goalSaved(g))}</b></div>`).join('')}
      <div class="card-row" style="padding:4px 0"><span>🗝️ Vault</span><b class="num">${fmt0(vaultTotal())}</b></div></div>`;
  }
  return html + viewGoals();
}

/* ---------------- Reward Shop ---------------- */
function viewShop() {
  const c = computeCoins();
  const rewards = [...S.db.rewards].sort((a, b) => a.cost - b.cost);
  const recent = [...S.db.redemptions].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 8);
  const r = rates(), s = S.db.settings;
  const m = monthData(ymOf(today()));
  return `<div class="tower-hero">
      <div class="small muted" style="letter-spacing:.12em;text-transform:uppercase;font-weight:700">Reward coins</div>
      <div class="hoard num">${COIN} ${c.balance.toLocaleString()}</div>
      <div class="small muted">= ${fmt0(c.balance)} you've earned the right to spend on fun</div>
    </div>

    <h2>How you earned them</h2>
    <div class="card">
      <div class="card-row" style="padding:5px 0"><span>🏰 ${r.save}% of the ${fmt0(c.saved)} you've put aside</span><b class="num">+${c.fromSaving.toLocaleString()}</b></div>
      <div class="card-row" style="padding:5px 0"><span>❤️ ${r.under}% of money left under budget (${c.underMonths.length} month${c.underMonths.length === 1 ? '' : 's'})</span><b class="num">+${c.fromUnder.toLocaleString()}</b></div>
      <div class="card-row" style="padding:5px 0"><span>🎁 Rewards activated</span><b class="num">−${c.spent.toLocaleString()}</b></div>
      <div class="card-row" style="padding:8px 0 2px;border-top:1px solid var(--line);margin-top:4px"><b>Balance</b><b class="num" style="color:var(--gold)">${COIN} ${c.balance.toLocaleString()}</b></div>
      <p class="muted small" style="margin:10px 0 0">${m.spent < s.monthlyBudget
        ? `📅 This month you're ${fmt0(s.monthlyBudget - m.spent)} under budget so far. Finish the month like that and you'll get <b>+${c.pending} ${COIN}</b>.`
        : `📅 This month is over budget, so no under-budget coins this time.`}</p>
    </div>

    <h2>Reward levels</h2>
    ${rewards.length ? `<div class="ladder">${rewards.map((w, i) => {
      const ok = c.balance >= w.cost;
      return `<div class="card rung ${ok ? 'ok' : ''}">
        <div class="rung-lvl">${ok ? '✨' : '🔒'}<span>Lv ${i + 1}</span></div>
        <div class="r-ic">${esc(w.emoji)}</div>
        <div style="flex:1;min-width:0"><b>${esc(w.name)}</b>
          <div class="r-cost num">${COIN} ${w.cost.toLocaleString()}</div>
          ${ok ? '' : `<div class="xpbar" style="margin-top:6px"><i style="width:${clamp(c.balance / w.cost * 100, 0, 100)}%;background:var(--gold)"></i></div><div class="small muted" style="margin-top:3px">${(w.cost - c.balance).toLocaleString()} more coins</div>`}
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
          ${ok ? `<button class="btn gold small-btn" data-action="redeem" data-id="${w.id}">Activate</button>` : ''}
          <button class="link small" data-action="edit-reward" data-id="${w.id}">Edit</button>
        </div>
      </div>`;
    }).join('')}</div>` : `<div class="card">${empty('🎁', 'No reward levels yet. Add treats you want to allow yourself.')}</div>`}
    <button class="btn primary block" data-action="new-reward" style="margin-top:4px">＋ New reward level</button>

    <h2>Reward rates</h2>
    <div class="card">
      <div class="field-row">
        <label class="field"><span>% of savings → coins</span><input id="rate-save" inputmode="decimal" value="${r.save}"></label>
        <label class="field"><span>% left under budget → coins</span><input id="rate-under" inputmode="decimal" value="${r.under}"></label>
      </div>
      <button class="btn block" data-action="save-rates">Save rates</button>
    </div>

    ${recent.length ? `<h2>Rewards activated</h2><div class="card">${recent.map(x => `<div class="tx"><div class="ic">${esc(x.emoji)}</div>
      <div class="info"><b>${esc(x.name)}</b><span>${dayLabel(x.date)}</span></div><div class="amt num">-${COIN}${x.cost}</div>
      <button class="x" data-action="undo-redeem" data-id="${x.id}" aria-label="Undo">↩</button></div>`).join('')}</div>` : ''}`;
}
const treatCats = () => cats().filter(c => c.type === 'expense' && kindOf(c) !== 'need');
const catOptions = (list, sel) => list.map(c => `<option value="${esc(c.id)}" ${c.id === sel ? 'selected' : ''}>${c.emoji} ${esc(c.name)}</option>`).join('');
function activateForm(w) {
  // a reward can say how much real money it uses (e.g. takeout); otherwise assume the whole cost
  const spend = w.spend ?? w.cost, logIt = spend > 0;
  return `<div style="text-align:center"><div style="font-size:52px">${esc(w.emoji)}</div><h3 style="margin-bottom:4px">Activate ${esc(w.name)}?</h3>
      <p class="muted small" style="margin-top:0">Spends ${COIN} ${w.cost}${w.spend ? `, including ${fmt0(w.spend)} of real money` : ''}. You earned this. Enjoy it!</p></div>
    <label class="check-row"><input id="act-log" type="checkbox" ${logIt ? 'checked' : ''}> Also log the money it uses as a purchase</label>
    <div class="field-row" id="act-log-fields" ${logIt ? '' : 'hidden'}>
      <label class="field"><span>Real cost</span><input id="act-amount" inputmode="decimal" value="${spend || ''}"></label>
      <label class="field"><span>Category</span><select id="act-cat">${catOptions(treatCats(), w.category || 'fun')}</select></label>
    </div>
    <button class="btn gold block" data-action="confirm-redeem" data-id="${w.id}">✨ Activate</button>`;
}
function rewardForm(w) {
  return `<h3>${w ? 'Edit treat' : 'New treat'}</h3>
    <div class="field-row">
      <label class="field" style="flex:0 0 70px"><span>Icon</span><input id="w-emoji" maxlength="8" value="${esc(w?.emoji || '🎁')}"></label>
      <label class="field"><span>What do you get to do?</span><input id="w-name" maxlength="40" placeholder="Movie night" value="${esc(w?.name || '')}"></label>
    </div>
    <label class="field"><span>Cost in coins</span><input id="w-cost" inputmode="numeric" placeholder="25" value="${w?.cost || ''}"></label>
    <p class="muted small" style="margin-top:-4px">1 ${COIN} = ${fmt0(1)}. Storing ${fmt0(100)} earns ${rates().save} ${COIN}.</p>
    <div class="field-row">
      <label class="field"><span>Real money it uses (optional)</span><input id="w-spend" inputmode="decimal" placeholder="e.g. 30 for takeout" value="${w?.spend ?? ''}"></label>
      <label class="field"><span>Logged as</span><select id="w-cat">${catOptions(treatCats(), w?.category || 'fun')}</select></label>
    </div>
    <p class="muted small" style="margin-top:-4px">When you activate it, this amount is logged as a purchase for you. Leave it empty to log the whole coin cost, or put 0 if it's free.</p>
    <button class="btn primary block" data-action="save-reward" data-id="${w?.id || ''}">Save</button>
    ${w ? `<button class="btn danger block" style="margin-top:10px" data-action="delete-reward" data-id="${w.id}">Delete</button>` : ''}`;
}

/* ---------------- Bills view ---------------- */
function viewBills() {
  const bills = S.db.recurring.filter(r => r.type === 'expense'), pays = S.db.recurring.filter(r => r.type === 'income');
  const inc = sum(pays.map(perMonth)), out = sum(bills.map(perMonth));
  const row = r => {
    const nd = nextDue(r);
    return `<div class="tx" data-action="edit-recurring" data-id="${r.id}">
      <div class="ic">${esc(r.emoji)}</div>
      <div class="info"><b>${esc(r.name)} ${r.autopay ? '<span class="tag auto">AUTO</span>' : ''}</b><span>${schedText(r)}${nd ? ` · next ${parseDate(nd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}</span></div>
      <div class="amt num ${r.type}">${amountText(r)}</div></div>`;
  };
  return `<h2>Bills & paydays</h2>
    <div class="grid2" style="margin-bottom:12px">
      <div class="card stat-tile"><div class="label">Income / month</div><div class="value num good">${fmt0(inc)}</div></div>
      <div class="card stat-tile"><div class="label">Bills / month</div><div class="value num">${fmt0(out)}</div><div class="delta ${inc - out >= 0 ? 'muted' : 'bad'}">${fmt0(inc - out)} left after bills</div></div>
    </div>
    <h2>Bills</h2>
    <div class="card">${bills.length ? bills.map(row).join('') : empty('🧾', 'No bills yet.')}</div>
    <button class="btn block" data-action="new-recurring" data-type="expense">＋ Add a bill</button>
    <h2>Paydays</h2>
    <div class="card">${pays.length ? pays.map(row).join('') : empty('💼', 'No paydays yet.')}</div>
    <button class="btn block" data-action="new-recurring" data-type="income">＋ Add a payday</button>
    <p class="muted small" style="margin:14px 4px">Bills marked <span class="tag auto">AUTO</span> log themselves on their due day and count as paid on time. Others show up on Home with a Pay button. Paying on time earns +${XP.billOnTime} XP.</p>`;
}
function recurringForm(r, type) {
  type = r?.type || type;
  const freq = r?.freq || 'monthly';
  const list = cats().filter(c => c.type === type);
  const defCat = r?.category || (type === 'income' ? 'salary' : 'bills');
  return `<h3>${r ? 'Edit' : 'New'} ${type === 'income' ? 'payday' : 'bill'}</h3>
    <div class="field-row">
      <label class="field" style="flex:0 0 70px"><span>Icon</span><input id="r-emoji" maxlength="8" value="${esc(r?.emoji || (type === 'income' ? '💼' : '🧾'))}"></label>
      <label class="field"><span>Name</span><input id="r-name" maxlength="40" placeholder="${type === 'income' ? 'Paycheck' : 'Rent'}" value="${esc(r?.name || '')}"></label>
    </div>
    <div class="field-row">
      <label class="field"><span>${type === 'income' ? 'Amount (or typical, if it changes)' : 'Amount'}</span><input id="r-amount" inputmode="decimal" value="${r?.amount || ''}"></label>
      <label class="field"><span>Category</span><select id="r-cat">${list.map(c => `<option value="${esc(c.id)}" ${c.id === defCat ? 'selected' : ''}>${c.emoji} ${esc(c.name)}</option>`).join('')}</select></label>
    </div>
    <div class="field-row">
      <label class="field"><span>How often</span><select id="r-freq">
        <option value="monthly" ${freq === 'monthly' ? 'selected' : ''}>Every month</option>
        <option value="biweekly" ${freq === 'biweekly' ? 'selected' : ''}>Every 2 weeks</option>
        <option value="weekly" ${freq === 'weekly' ? 'selected' : ''}>Every week</option></select></label>
      <label class="field" id="r-day-wrap" ${freq === 'monthly' ? '' : 'hidden'}><span>Day of month</span><input id="r-day" type="number" min="1" max="31" value="${r?.day || 1}"></label>
      <label class="field" id="r-anchor-wrap" ${freq === 'monthly' ? 'hidden' : ''}><span>Next date</span><input id="r-anchor" type="date" value="${r?.anchor || today()}"></label>
    </div>
    ${type === 'income' ? `<label class="check-row"><input id="r-var" type="checkbox" ${r ? (r.variable ? 'checked' : '') : 'checked'}> Pay changes each time (hourly). Ask me on payday</label>` : ''}
    <label class="check-row" id="r-auto-wrap" ${type === 'income' && (r ? r.variable : true) ? 'hidden' : ''}><input id="r-auto" type="checkbox" ${r?.autopay ? 'checked' : ''}> ${type === 'income' ? 'Add it automatically on payday' : 'Auto-pays (log it for me on the due day)'}</label>
    <button class="btn primary block" data-action="save-recurring" data-id="${r?.id || ''}" data-type="${type}">Save</button>
    ${r ? `<button class="btn danger block" style="margin-top:10px" data-action="delete-recurring" data-id="${r.id}">Delete (past entries stay in your log)</button>` : ''}`;
}
function payForm(r, due) {
  const late = today() > due, inc = r.type === 'income';
  if (r.variable) {
    return `<div style="text-align:center"><div style="font-size:52px">💰</div><h3 style="margin-bottom:4px">${due === today() ? "It's payday!" : 'Did you get paid?'}</h3>
      <p class="muted small" style="margin-top:0">${esc(r.emoji)} ${esc(r.name)} · ${parseDate(due).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</p></div>
      <p class="small" style="text-align:center">How much did you get paid?</p>
      <div class="amount-input"><span>${esc(cur())}</span><input id="pay-amount" inputmode="decimal" placeholder="${r.amount ? r.amount.toFixed(2) : '0.00'}"></div>
      <button class="btn gold block" data-action="confirm-pay" data-id="${r.id}" data-due="${due}">💰 Add to my wallet</button>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn" data-action="snooze-pay" data-id="${r.id}" data-due="${due}">Remind me later</button>
        <button class="btn" data-action="skip-bill" data-id="${r.id}" data-due="${due}">No pay this time</button>
      </div>`;
  }
  return `<h3>${esc(r.emoji)} ${esc(r.name)}</h3>
    <p class="muted small" style="margin-top:-6px">${inc ? 'Payday' : 'Due'} ${parseDate(due).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}${late ? ' · <span class="bad">late</span>' : ''}</p>
    <div class="amount-input"><span>${esc(cur())}</span><input id="pay-amount" inputmode="decimal" value="${r.amount}"></div>
    <button class="btn gold block" data-action="confirm-pay" data-id="${r.id}" data-due="${due}">${inc ? `💰 Mark received` : `🧾 Mark paid${late ? '' : ` · +${XP.billOnTime} XP`}`}</button>
    <button class="btn block" style="margin-top:10px" data-action="skip-bill" data-id="${r.id}" data-due="${due}">Skip this one (didn't happen)</button>`;
}

/* ---------------- Quickstart ---------------- */
const SETUP_STEPS = ['Welcome', 'Your gold', 'Income', 'Bills', 'Budget', 'Goals', 'Rewards', 'Finish'];
const BILL_PRESETS = [['🏠', 'Rent', 'bills'], ['📶', 'Wi-Fi', 'utilities'], ['📱', 'Phone', 'utilities'], ['💡', 'Electricity', 'utilities'], ['🚿', 'Water', 'utilities'],
  ['🚗', 'Car insurance', 'bills'], ['🚙', 'Car payment', 'bills'], ['📺', 'Streaming', 'subscriptions'], ['🏋️', 'Gym', 'subscriptions'], ['➕', '', 'bills']];
const GOAL_PRESETS = [['🛡️', 'Emergency fund'], ['✈️', 'Vacation'], ['📱', 'New phone'], ['🚗', 'Car'], ['⛓️', 'Pay off debt'], ['🎓', 'Education'], ['➕', '']];
// costs are in coins, and 1 coin = 1 of your currency, so they're roughly what the treat really costs
const REWARD_PRESETS = [['☕', 'Fancy coffee', 6], ['🎬', 'Movie night', 25], ['🍣', 'Dinner out', 40], ['🎮', 'New game', 60],
  ['👟', 'New shoes', 100], ['🎤', 'Concert', 150], ['✈️', 'Weekend trip', 300], ['➕', '', 20]];

// new person? (shared expenses your partner added for you don't count as having started)
const needsSetup = () => !S.db.settings.onboarded && !S.db.transactions.some(t => !t.sharedId) && !S.db.goals.length && !S.db.recurring.length;
function newSetup() {
  const s = S.db.settings;
  return {
    step: 0, d: {
      name: s.name === 'Player' ? '' : s.name, currency: s.currency, startBalance: '', saved: '',
      income: [{ emoji: '💼', name: 'Paycheck', amount: '', freq: 'biweekly', day: 1, anchor: '', autopay: false, variable: true, category: 'salary' }],
      bills: [{ emoji: '🏠', name: 'Rent', amount: '', day: 1, autopay: false, category: 'bills' }, { emoji: '📶', name: 'Wi-Fi', amount: '', day: 1, autopay: false, category: 'utilities' }],
      monthlyBudget: '', foodBudget: '',
      goals: [{ emoji: '🛡️', name: 'Emergency fund', target: '', deadline: '' }],
      rewards: REWARD_PRESETS.slice(1, 4).map(([emoji, name, cost]) => ({ emoji, name, cost })),
      rewardRate: String(s.rewardRate ?? 10), underBudgetRate: String(s.underBudgetRate ?? 20),
      pin: '',
    },
  };
}
// an hourly payday only needs a name; a fixed one needs an amount
const keepIncome = r => r.variable ? !!r.name.trim() : parseAmount(r.amount) > 0;
const bind = (list, i, k) => `data-list="${list}" data-i="${i}" data-k="${k}"`;
const sbind = k => `data-bind="${k}"`;
function setupMonthly(d) {
  const inc = sum(d.income.map(r => perMonth({ freq: r.freq, amount: parseAmount(r.amount) || 0 })));
  const bills = sum(d.bills.map(b => parseAmount(b.amount) || 0));
  return { inc, bills };
}
function presetChips(list, presets, d) {
  const have = new Set(d[list].map(x => x.name));
  return `<div class="chips wrap">${presets.map((p, i) => have.has(p[1]) && p[1] ? '' : `<button class="chip" data-action="setup-add" data-list="${list}" data-p="${i}">${p[0]} ${p[1] || 'Custom'}</button>`).join('')}</div>`;
}
function viewSetup() {
  const st = S.setup || (S.setup = newSetup()), d = st.d, last = st.step === SETUP_STEPS.length - 1;
  let body = '';
  switch (st.step) {
    case 0: body = `<div class="setup-hero">${LOGO('hero-logo')}<h1>Welcome to your Wizard Tower</h1>
        <p class="muted">Let's set up your money world. It takes about 3 minutes, and you can change everything later.</p></div>
        <div class="card how">
          <div>📝 <b>Log spending</b> → earn XP and level up</div>
          <div>🏰 <b>Put money aside</b> → your tower grows floor by floor</div>
          <div>${COIN} <b>Part of what you save</b> (and what's left under budget) becomes reward coins</div>
          <div>🎁 <b>Unlock reward levels</b> and spend coins on treats, guilt-free</div>
          <div>✅ <b>Needs vs</b> 🟡 <b>wants vs</b> 🚫 <b>junk</b>: see where your money really goes</div>
        </div>
        <div class="field-row"><label class="field" style="flex:3"><span>What should we call you?</span><input ${sbind('name')} maxlength="30" placeholder="Your name" value="${esc(d.name)}"></label>
        <label class="field" style="flex:1"><span>Currency</span><input ${sbind('currency')} maxlength="4" value="${esc(d.currency)}"></label></div>`; break;
    case 1: {
      const fi = floorIndex(parseAmount(d.saved) || 0);
      body = `<h1 class="setup-h">💰 How much gold do you have?</h1>
        <label class="field"><span>Money you can spend right now (checking + cash)</span><input ${sbind('startBalance')} inputmode="decimal" placeholder="0.00" value="${esc(d.startBalance)}"></label>
        <p class="muted small" style="margin-top:-4px">This becomes your 👛 Wallet. It goes up and down as you log income and purchases.</p>
        <label class="field"><span>Money you've already saved</span><input ${sbind('saved')} inputmode="decimal" placeholder="0.00" value="${esc(d.saved)}"></label>
        <div class="card" style="text-align:center"><div style="font-size:36px">${FLOORS[fi][2]}</div><b>Your tower starts at floor ${fi + 1}: ${FLOORS[fi][1]}</b>
          <div class="muted small">Your savings go into the tower's vault. Saving more unlocks new floors.</div></div>`; break;
    }
    case 2: body = `<h1 class="setup-h">💼 When do you get paid?</h1>
        <p class="muted small">Add each regular income. Paid hourly? Keep "My pay changes each time" ticked and the app will pop up on payday to ask what you got.</p>
        ${d.income.map((r, i) => `<div class="card">
          <div class="field-row"><label class="field" style="flex:0 0 58px"><span>Icon</span><input ${bind('income', i, 'emoji')} maxlength="8" value="${esc(r.emoji)}"></label>
            <label class="field"><span>Name</span><input ${bind('income', i, 'name')} maxlength="40" value="${esc(r.name)}"></label>
            <button class="x" data-action="setup-del" data-list="income" data-i="${i}" aria-label="Remove">✕</button></div>
          <label class="check-row"><input type="checkbox" ${bind('income', i, 'variable')} ${r.variable ? 'checked' : ''}> My pay changes each time (hourly)</label>
          <div class="field-row"><label class="field"><span>${r.variable ? 'Typical paycheck (optional)' : 'Amount each time'}</span><input ${bind('income', i, 'amount')} inputmode="decimal" placeholder="${r.variable ? 'for budget tips' : '0.00'}" value="${esc(r.amount)}"></label>
            <label class="field"><span>How often</span><select ${bind('income', i, 'freq')}>
              ${[['monthly', 'Every month'], ['biweekly', 'Every 2 weeks'], ['weekly', 'Every week']].map(([v, l]) => `<option value="${v}" ${r.freq === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
          ${r.freq === 'monthly' ? `<label class="field"><span>Day of month</span><input type="number" min="1" max="31" ${bind('income', i, 'day')} value="${r.day}"></label>`
            : `<label class="field"><span>Next payday</span><input type="date" ${bind('income', i, 'anchor')} value="${r.anchor}"></label>`}
          ${r.variable ? '<p class="muted small" style="margin:0">🔔 On payday the app will ask how much you got paid.</p>'
            : `<label class="check-row"><input type="checkbox" ${bind('income', i, 'autopay')} ${r.autopay ? 'checked' : ''}> Add it automatically on payday</label>`}
        </div>`).join('')}
        <button class="btn block" data-action="setup-add" data-list="income" data-p="-1">＋ Add another income</button>`; break;
    case 3: body = `<h1 class="setup-h">🧾 What bills come every month?</h1>
        <p class="muted small">Rent, Wi-Fi, phone… these count as ✅ needs. Tap to add more:</p>
        ${presetChips('bills', BILL_PRESETS, d)}
        ${d.bills.map((b, i) => `<div class="card">
          <div class="field-row"><label class="field" style="flex:0 0 58px"><span>Icon</span><input ${bind('bills', i, 'emoji')} maxlength="8" value="${esc(b.emoji)}"></label>
            <label class="field"><span>Name</span><input ${bind('bills', i, 'name')} maxlength="40" placeholder="Bill name" value="${esc(b.name)}"></label>
            <button class="x" data-action="setup-del" data-list="bills" data-i="${i}" aria-label="Remove">✕</button></div>
          <div class="field-row"><label class="field"><span>Amount</span><input ${bind('bills', i, 'amount')} inputmode="decimal" placeholder="0.00" value="${esc(b.amount)}"></label>
            <label class="field"><span>Due day (1–31)</span><input type="number" min="1" max="31" ${bind('bills', i, 'day')} value="${b.day}"></label></div>
          <label class="check-row"><input type="checkbox" ${bind('bills', i, 'autopay')} ${b.autopay ? 'checked' : ''}> Auto-pays (log it for me on the due day)</label>
        </div>`).join('')}`; break;
    case 4: {
      const m = setupMonthly(d);
      body = `<h1 class="setup-h">❤️ Set your budgets</h1>
        <div class="card">
          <div class="card-row" style="padding:3px 0"><span>Income per month</span><b class="num good">${fmt0(m.inc)}</b></div>
          <div class="card-row" style="padding:3px 0"><span>Bills per month</span><b class="num">−${fmt0(m.bills)}</b></div>
          <div class="card-row" style="padding:3px 0;border-top:1px solid var(--line);margin-top:4px;padding-top:7px"><span>Left for everything else</span><b class="num ${m.inc - m.bills >= 0 ? '' : 'bad'}">${fmt0(m.inc - m.bills)}</b></div>
        </div>
        <label class="field"><span>Monthly budget (all spending, including bills)</span><input ${sbind('monthlyBudget')} inputmode="decimal" value="${esc(d.monthlyBudget)}"></label>
        <label class="field"><span>Monthly food budget (groceries + eating out)</span><input ${sbind('foodBudget')} inputmode="decimal" value="${esc(d.foodBudget)}"></label>
        <p class="muted small">We suggested numbers that leave about 20% of what's left for saving. Adjust them to fit your life.</p>`; break;
    }
    case 5: body = `<h1 class="setup-h">🐉 What are you saving for?</h1>
        <p class="muted small">Each goal is a boss you defeat by saving. Tap to add:</p>
        ${presetChips('goals', GOAL_PRESETS, d)}
        ${d.goals.map((g, i) => `<div class="card">
          <div class="field-row"><label class="field" style="flex:0 0 58px"><span>Icon</span><input ${bind('goals', i, 'emoji')} maxlength="8" value="${esc(g.emoji)}"></label>
            <label class="field"><span>Goal</span><input ${bind('goals', i, 'name')} maxlength="60" placeholder="Goal name" value="${esc(g.name)}"></label>
            <button class="x" data-action="setup-del" data-list="goals" data-i="${i}" aria-label="Remove">✕</button></div>
          <div class="field-row"><label class="field"><span>Target</span><input ${bind('goals', i, 'target')} inputmode="decimal" placeholder="1000" value="${esc(g.target)}"></label>
            <label class="field"><span>By when? (optional)</span><input type="date" ${bind('goals', i, 'deadline')} value="${esc(g.deadline)}"></label></div>
        </div>`).join('')}`; break;
    case 6: body = `<h1 class="setup-h">🎁 What treats do you allow yourself?</h1>
        <div class="card">
          <p class="small" style="margin:0 0 10px">Reward coins are real money you've earned the right to spend. <b>1 ${COIN} = ${fmt0(1)}.</b> You get coins two ways:</p>
          <div class="field-row">
            <label class="field"><span>% of what you put aside</span><input ${sbind('rewardRate')} inputmode="decimal" value="${esc(d.rewardRate)}"></label>
            <label class="field"><span>% left under budget at month end</span><input ${sbind('underBudgetRate')} inputmode="decimal" value="${esc(d.underBudgetRate)}"></label>
          </div>
          <p class="muted small" style="margin:0">Example: save ${fmt0(200)} → <b>${Math.floor(200 * (parseAmount(d.rewardRate) || 0) / 100)} ${COIN}</b>. End a month ${fmt0(300)} under budget → <b>${Math.floor(300 * (parseAmount(d.underBudgetRate) || 0) / 100)} ${COIN}</b>.</p>
        </div>
        <p class="muted small">Each treat is a reward level. Set the cost to about what it really costs. Tap to add:</p>
        ${presetChips('rewards', REWARD_PRESETS, d)}
        ${d.rewards.map((w, i) => `<div class="card"><div class="field-row" style="align-items:flex-end">
          <label class="field" style="flex:0 0 58px"><span>Icon</span><input ${bind('rewards', i, 'emoji')} maxlength="8" value="${esc(w.emoji)}"></label>
          <label class="field"><span>Treat</span><input ${bind('rewards', i, 'name')} maxlength="40" placeholder="Treat" value="${esc(w.name)}"></label>
          <label class="field" style="flex:0 0 80px"><span>${COIN} Cost</span><input ${bind('rewards', i, 'cost')} inputmode="numeric" value="${esc(w.cost)}"></label>
          <button class="x" data-action="setup-del" data-list="rewards" data-i="${i}" aria-label="Remove" style="margin-bottom:12px">✕</button></div></div>`).join('')}`; break;
    case 7: {
      const n = (l, f) => d[l].filter(f).length;
      body = `<div class="setup-hero"><div style="font-size:64px">🏰</div><h1>Ready to build your tower?</h1></div>
        <div class="card">
          <div class="card-row" style="padding:4px 0"><span>👛 Wallet</span><b class="num">${fmt0(parseAmount(d.startBalance) || 0)}</b></div>
          <div class="card-row" style="padding:4px 0"><span>🏰 Starting gold</span><b class="num" style="color:var(--gold)">${fmt0(parseAmount(d.saved) || 0)}</b></div>
          <div class="card-row" style="padding:4px 0"><span>💼 Paydays</span><b>${n('income', keepIncome)}</b></div>
          <div class="card-row" style="padding:4px 0"><span>🧾 Bills</span><b>${n('bills', b => parseAmount(b.amount) > 0 && b.name.trim())}</b></div>
          <div class="card-row" style="padding:4px 0"><span>🐉 Goals</span><b>${n('goals', g => parseAmount(g.target) > 0 && g.name.trim())}</b></div>
          <div class="card-row" style="padding:4px 0"><span>🎁 Treats</span><b>${n('rewards', w => parseAmount(w.cost) > 0 && w.name.trim())}</b></div>
        </div>
        ${S.pinSet ? '' : `<label class="field"><span>🔒 Lock the app with a PIN (optional, 4–8 digits)</span><input ${sbind('pin')} type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" value="${esc(d.pin)}"></label>
        <p class="muted small" style="margin-top:-4px">Recommended, since you can open the app from anywhere.</p>`}`; break;
    }
  }
  return `<div class="setup-top">
      <div class="setup-progress"><i style="width:${(st.step + 1) / SETUP_STEPS.length * 100}%"></i></div>
      <div class="card-row small muted"><span>Step ${st.step + 1} of ${SETUP_STEPS.length} · ${SETUP_STEPS[st.step]}</span><button class="link" data-action="setup-skip">Skip setup</button></div>
    </div>
    ${body}
    <div class="btn-row setup-nav">
      ${st.step ? '<button class="btn" data-action="setup-back">Back</button>' : ''}
      <button class="btn primary" data-action="${last ? 'setup-finish' : 'setup-next'}">${last ? '🏰 Build my tower!' : 'Next'}</button>
    </div>`;
}
function suggestBudgets(d) {
  const m = setupMonthly(d);
  if (!m.inc) return;
  const left = Math.max(0, m.inc - m.bills);
  if (d.monthlyBudget === '') d.monthlyBudget = String(Math.round((m.bills + left * 0.8) / 10) * 10);
  if (d.foodBudget === '') d.foodBudget = String(Math.round(left * 0.25 / 10) * 10);
}
function setupGoalTarget(d) {
  const bills = setupMonthly(d).bills;
  return bills ? String(Math.round(bills * 3 / 100) * 100) : '';
}

/* ---------------- actions ---------------- */
function goSetupStep(n) { S.setup.step = n; window.scrollTo(0, 0); render(); }
Object.assign(A, {
  wallet: () => {
    const w = walletBalance();
    openModal(`<h3>👛 Wallet balance</h3>
      <p class="muted small" style="margin-top:-6px">How much spending money do you have right now (checking + cash)? From now on, everything you log moves this number.</p>
      <div class="amount-input"><span>${esc(cur())}</span><input id="wal-amount" inputmode="decimal" value="${w == null ? '' : w.toFixed(2)}"></div>
      <button class="btn primary block" data-action="save-wallet">Save</button>`);
  },
  'save-wallet': async () => {
    const v = parseAmount(document.getElementById('wal-amount').value);
    if (!Number.isFinite(v)) return toast('Enter an amount', 'bad');
    if (await mutate('PUT', '/api/settings', { startBalance: v })) { closeModal(); toast('👛 Wallet updated'); }
  },
  vault: el => {
    const w = el.dataset.w === '1';
    openModal(`<h3>${w ? '⬇️ Take gold out' : '⬆️ Store gold in the tower'}</h3>
      <p class="muted small" style="margin-top:-6px">${w ? `Vault has ${fmt(vaultTotal())}. Taking money out also takes back its reward coins (${rates().save}%).` : `Moves money from your wallet into the tower. ${rates().save}% of it becomes reward coins.`}</p>
      <div class="amount-input"><span>${esc(cur())}</span><input id="v-amount" inputmode="decimal" placeholder="0.00"></div>
      <button class="btn ${w ? '' : 'gold'} block" data-action="confirm-vault" data-w="${w ? 1 : 0}">${w ? 'Take out' : 'Store gold'}</button>`);
  },
  'confirm-vault': async el => {
    const amt = parseAmount(document.getElementById('v-amount').value);
    if (!(amt > 0)) return toast('Enter an amount', 'bad');
    const w = el.dataset.w === '1';
    if (w && amt > vaultTotal()) return toast("The vault doesn't have that much", 'bad');
    const wal = walletBalance();
    if (!w && wal != null && amt > wal && !confirm(`That's more than your wallet (${fmt(wal)}). Store it anyway?`)) return;
    const before = floorIndex(towerTotal());
    if (await mutate('POST', '/api/vault', { amount: w ? -amt : amt, date: today() })) {
      closeModal();
      const after = floorIndex(towerTotal());
      if (after > before) { toast(`🏰 New floor unlocked: ${FLOORS[after][2]} ${FLOORS[after][1]}!`, 'gold'); confetti(120); }
      else if (!w) toast(`🏰 ${fmt(amt)} stored in the tower`, 'gold');
    }
  },
  'pay-bill': el => openModal(payForm(S.db.recurring.find(r => r.id === el.dataset.id), el.dataset.due)),
  'confirm-pay': async el => {
    const amount = parseAmount(document.getElementById('pay-amount').value);
    if (!(amount > 0)) return toast('Enter an amount', 'bad');
    const r = S.db.recurring.find(x => x.id === el.dataset.id);
    if (await mutate('POST', `/api/recurring/${el.dataset.id}/pay`, { dueDate: el.dataset.due, date: today(), amount })) {
      closeModal();
      if (r.type === 'expense') { toast(`🧾 ${r.name} paid!`, 'gold'); if (today() <= el.dataset.due) confetti(40); }
      else { toast(`💰 ${r.name} received`, 'gold'); setTimeout(savePrompt, 700); }
    }
  },
  'snooze-pay': el => { snooze(el.dataset.id, el.dataset.due); closeModal(); toast("🔔 I'll ask again in a few hours"); },
  'skip-bill': async el => { if (await mutate('POST', `/api/recurring/${el.dataset.id}/skip`, { dueDate: el.dataset.due })) closeModal(); },
  'new-recurring': el => openModal(recurringForm(null, el.dataset.type)),
  'edit-recurring': el => openModal(recurringForm(S.db.recurring.find(r => r.id === el.dataset.id))),
  'save-recurring': async el => {
    const v = id => document.getElementById(id).value;
    const body = {
      type: el.dataset.type, emoji: v('r-emoji'), name: v('r-name'), amount: parseAmount(v('r-amount')), category: v('r-cat'),
      freq: v('r-freq'), day: +v('r-day'), anchor: v('r-anchor') || today(), autopay: document.getElementById('r-auto').checked,
      variable: !!document.getElementById('r-var')?.checked,
    };
    if (body.variable) { body.autopay = false; body.amount = body.amount || 0; }
    if (!body.name.trim()) return toast('Give it a name', 'bad');
    if (!body.variable && !(body.amount > 0)) return toast('Enter an amount', 'bad');
    const id = el.dataset.id;
    if (await mutate(id ? 'PUT' : 'POST', id ? `/api/recurring/${id}` : '/api/recurring', body)) { closeModal(); toast('Saved ✓'); }
  },
  'delete-recurring': async el => { if (confirm('Delete this? Past entries stay in your log.') && await mutate('DELETE', `/api/recurring/${el.dataset.id}`)) closeModal(); },
  'new-reward': () => openModal(rewardForm(null)),
  'edit-reward': el => openModal(rewardForm(S.db.rewards.find(w => w.id === el.dataset.id))),
  'save-reward': async el => {
    const spendRaw = document.getElementById('w-spend').value.trim();
    const body = {
      emoji: document.getElementById('w-emoji').value, name: document.getElementById('w-name').value,
      cost: parseAmount(document.getElementById('w-cost').value), category: document.getElementById('w-cat').value,
      spend: spendRaw === '' ? null : parseAmount(spendRaw),
    };
    if (body.spend !== null && !(body.spend >= 0)) return toast('Real money must be a number (or empty)', 'bad');
    if (!body.name.trim()) return toast('What is the treat?', 'bad');
    if (!(body.cost > 0)) return toast('Set a coin cost', 'bad');
    const id = el.dataset.id;
    if (await mutate(id ? 'PUT' : 'POST', id ? `/api/rewards/${id}` : '/api/rewards', body)) closeModal();
  },
  'delete-reward': async el => { if (confirm('Delete this treat?') && await mutate('DELETE', `/api/rewards/${el.dataset.id}`)) closeModal(); },
  redeem: el => {
    const w = S.db.rewards.find(x => x.id === el.dataset.id);
    if (computeCoins().balance < w.cost) return toast('Not enough coins yet', 'bad');
    openModal(activateForm(w));
  },
  'confirm-redeem': async el => {
    const w = S.db.rewards.find(x => x.id === el.dataset.id);
    const log = document.getElementById('act-log').checked;
    const amount = parseAmount(document.getElementById('act-amount').value);
    if (log && !(amount > 0)) return toast('Enter the real cost, or untick "log it"', 'bad');
    if (await mutate('POST', `/api/rewards/${w.id}/redeem`, { date: today(), log, amount, category: document.getElementById('act-cat').value })) {
      closeModal();
      confetti(100);
      toast(`${w.emoji} Enjoy your ${w.name}! You earned it.`, 'gold');
    }
  },
  'save-rates': async () => {
    const body = { rewardRate: parseAmount(document.getElementById('rate-save').value), underBudgetRate: parseAmount(document.getElementById('rate-under').value) };
    if (![body.rewardRate, body.underBudgetRate].every(v => v >= 0 && v <= 100)) return toast('Rates are percentages from 0 to 100', 'bad');
    if (await mutate('PUT', '/api/settings', body)) toast('Rates saved ✓');
  },
  'undo-redeem': async el => { if (confirm('Undo this? You get the coins back, and the purchase it logged is removed.')) mutate('DELETE', `/api/redemptions/${el.dataset.id}`); },

  // quickstart
  'setup-next': () => {
    const st = S.setup;
    if (st.step === 2 && st.d.income.some(r => keepIncome(r) && r.freq !== 'monthly' && !r.anchor)) {
      return toast('Pick the date of your next payday', 'bad');
    }
    if (st.step === 3) suggestBudgets(st.d);
    if (st.step === 4) { const g = st.d.goals.find(x => x.name === 'Emergency fund' && !x.target); if (g) g.target = setupGoalTarget(st.d); }
    goSetupStep(Math.min(SETUP_STEPS.length - 1, st.step + 1));
  },
  'setup-back': () => goSetupStep(Math.max(0, S.setup.step - 1)),
  'setup-skip': async () => {
    if (!confirm('Skip setup? You can run it again from the Me tab.')) return;
    if (await mutate('PUT', '/api/settings', { onboarded: true })) { S.setup = null; go('home'); }
  },
  'setup-add': el => {
    const d = S.setup.d, list = el.dataset.list, p = +el.dataset.p;
    if (list === 'income') d.income.push({ emoji: '💡', name: 'Side income', amount: '', freq: 'monthly', day: 1, anchor: '', autopay: false, variable: true, category: 'side' });
    if (list === 'bills') { const [emoji, name, category] = BILL_PRESETS[p]; d.bills.push({ emoji: emoji === '➕' ? '🧾' : emoji, name, amount: '', day: 1, autopay: false, category }); }
    if (list === 'goals') { const [emoji, name] = GOAL_PRESETS[p]; d.goals.push({ emoji: emoji === '➕' ? '🎯' : emoji, name, target: name === 'Emergency fund' ? setupGoalTarget(d) : '', deadline: '' }); }
    if (list === 'rewards') { const [emoji, name, cost] = REWARD_PRESETS[p]; d.rewards.push({ emoji: emoji === '➕' ? '🎁' : emoji, name, cost }); }
    render();
  },
  'setup-del': el => { S.setup.d[el.dataset.list].splice(+el.dataset.i, 1); render(); },
  'setup-finish': async () => {
    const d = S.setup.d;
    if (d.pin && !/^\d{4,8}$/.test(d.pin)) return toast('PIN must be 4–8 digits (or leave it empty)', 'bad');
    const amt = v => parseAmount(v) || 0;
    const body = {
      name: d.name.trim() || 'Player', currency: d.currency.trim() || '$',
      startBalance: amt(d.startBalance), saved: Math.max(0, amt(d.saved)),
      monthlyBudget: amt(d.monthlyBudget) || S.db.settings.monthlyBudget, foodBudget: amt(d.foodBudget) || S.db.settings.foodBudget,
      rewardRate: clamp(amt(d.rewardRate), 0, 100), underBudgetRate: clamp(amt(d.underBudgetRate), 0, 100),
      recurring: [
        ...d.income.filter(keepIncome).map(r => ({ ...r, type: 'income', amount: amt(r.amount), autopay: r.variable ? false : r.autopay, name: r.name.trim() || 'Income' })),
        ...d.bills.filter(b => amt(b.amount) > 0 && b.name.trim()).map(b => ({ ...b, type: 'expense', freq: 'monthly', amount: amt(b.amount) })),
      ],
      goals: d.goals.filter(g => amt(g.target) > 0 && g.name.trim()).map(g => ({ ...g, target: amt(g.target) })),
      rewards: d.rewards.filter(w => amt(w.cost) > 0 && w.name.trim()).map(w => ({ ...w, cost: Math.round(amt(w.cost)) })),
    };
    if (!(await mutate('POST', '/api/setup', body))) return;
    if (d.pin) {
      try { S.pinSet = (await api('POST', '/api/auth/pin', { newPin: d.pin })).pinSet; } catch (e) { toast('⚠️ PIN not set: ' + e.message, 'bad'); }
    }
    S.setup = null;
    go('tower');
    confetti(150);
    toast('🏰 Your tower rises!', 'gold');
  },
});

// keep quickstart answers as you type
function setupInput(e) {
  if (!S.setup || S.tab !== 'setup') return;
  const el = e.target, v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.dataset.bind) S.setup.d[el.dataset.bind] = v;
  else if (el.dataset.list) {
    const row = S.setup.d[el.dataset.list][+el.dataset.i];
    row[el.dataset.k] = el.dataset.k === 'day' ? clamp(Math.round(+v) || 1, 1, 31) : v;
    if ((el.dataset.k === 'freq' || el.dataset.k === 'variable') && e.type === 'change') render();
  } else return;
  if (['saved', 'rewardRate', 'underBudgetRate'].includes(el.dataset.bind) && e.type === 'change') render();
}
document.addEventListener('input', setupInput);
document.addEventListener('change', setupInput);
document.addEventListener('change', e => {
  if (e.target.id === 'r-var') document.getElementById('r-auto-wrap').hidden = e.target.checked;
  if (e.target.id === 'act-log') document.getElementById('act-log-fields').hidden = !e.target.checked;
  if (e.target.id === 'r-freq') {
    const m = e.target.value === 'monthly';
    document.getElementById('r-day-wrap').hidden = !m;
    document.getElementById('r-anchor-wrap').hidden = m;
  }
});

/* ---------------- payday reminder ---------------- */
// For paydays where the amount changes (hourly pay): on payday, or if you missed one, pop up and ask.
// "Remind me later" hides it on this device for 3 hours.
const SNOOZE_MS = 3 * 3600 * 1000;
function snoozeKey(id, due) { return `mq-snooze-${id}-${due}`; }
function snooze(id, due) { try { localStorage.setItem(snoozeKey(id, due), String(Date.now())); } catch {} }
function snoozed(id, due) {
  try { return Date.now() - Number(localStorage.getItem(snoozeKey(id, due)) || 0) < SNOOZE_MS; } catch { return false; }
}
function paydayPrompt() {
  if (!S.db || busy() || document.body.classList.contains('is-locked') || document.querySelector('.levelup')) return;
  const t = today();
  for (const r of S.db.recurring) {
    if (!r.variable) continue;
    // the oldest open payday from the last 2 weeks
    const due = occurrences(r, addDays(t, -14), t).find(d => isOpen(r, d) && !snoozed(r.id, d));
    if (due) { openModal(payForm(r, due)); return; }
  }
}

/* ---------------- pay yourself first ----------------
   After each paycheck, suggest a small amount to put aside: about a quarter of the
   "breathing room" you have after necessary costs, kept between 3% and 15% of the paycheck.
   Over budget this month? It drops to 3% so it never feels impossible. */
const isPaycheck = t => t.type === 'income' && (t.recurringId || ['salary', 'side'].includes(t.category));
function monthlyIncome() {
  const curYm = ymOf(today()), by = {};
  S.db.transactions.forEach(t => { if (t.type === 'income' && ymOf(t.date) < curYm) by[ymOf(t.date)] = (by[ymOf(t.date)] || 0) + t.amount; });
  const ms = Object.keys(by).sort().slice(-2);
  if (ms.length) return sum(ms.map(m => by[m])) / ms.length;
  return sum(S.db.recurring.filter(r => r.type === 'income').map(perMonth));
}
function paysPerMonth() {
  const r = S.db.recurring.find(x => x.type === 'income');
  return !r ? 26 / 12 : r.freq === 'weekly' ? 52 / 12 : r.freq === 'biweekly' ? 26 / 12 : 1;
}
const monthlyNeeds = () => avgNeeds()?.avg ?? sum(S.db.recurring.filter(r => r.type === 'expense').map(perMonth));
function saveSuggestion(pay) {
  const inc = monthlyIncome() || pay * paysPerMonth();
  const needs = monthlyNeeds(), room = inc - needs;
  const over = monthData(ymOf(today())).spent > S.db.settings.monthlyBudget;
  let pct = !needs ? 0.05 : clamp(room / inc * 0.25, 0.03, 0.15);
  if (over) pct = 0.03;
  const step = pay >= 100 ? 5 : 1;
  const amt = Math.min(Math.max(step, Math.round(pay * pct / step) * step), Math.max(1, Math.floor(pay * 0.2)));
  return { amt, pct: amt / pay, inc, needs, room, over };
}
function pendingSaves() {
  const since = addDays(today(), -14), anchor = S.db.settings.balanceAnchor || '';
  return S.db.transactions
    .filter(t => isPaycheck(t) && t.saveDone === undefined && t.date >= since && (t.createdAt || '') >= anchor)
    .sort((a, b) => a.date.localeCompare(b.date));
}
/* ---- which goal boss your savings attack ----
   The one with the closest deadline, then the oldest. No bosses left? It goes to the vault. */
function saveTarget() {
  return S.db.goals.filter(g => goalSaved(g) < g.target)
    .sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999') || (a.createdAt || '').localeCompare(b.createdAt || ''))[0] || null;
}

/* ---- paycheck plan: save / keep for bills / free to spend ---- */
// the next day any of your paydays comes around, after `after`
function nextPayday(after) {
  let best = null;
  for (const r of S.db.recurring) {
    if (r.type !== 'income') continue;
    const d = occurrences(r, addDays(after, 1), addDays(after, 62))[0];
    if (d && (!best || d < best)) best = d;
  }
  return best;
}
// bills still to pay from `from` up to (not including) `until`
function billsDue(from, until) {
  const out = [];
  for (const r of S.db.recurring) {
    if (r.type !== 'expense') continue;
    for (const d of occurrences(r, from, addDays(until, -1))) if (isOpen(r, d)) out.push({ r, due: d, amount: r.amount });
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}
const daysUntil = d => Math.max(1, Math.round((parseDate(d) - parseDate(today())) / 864e5));
/* ---- paycheque plan (see plan.js for the rules and their sources) ---- */
// everyday necessary spending per day: what you set, or what your "need" spending that isn't a bill averages
function dailyNeeds() {
  const s = S.db.settings;
  if (s.everydayWeekly > 0) return { perDay: s.everydayWeekly / 7, from: 'set' };
  const t = today(), since = addDays(t, -60);
  const list = S.db.transactions.filter(x => x.type === 'expense' && !x.recurringId && x.date >= since && x.date <= t && txKind(x) === 'need');
  if (!list.length) return { perDay: 0, from: 'none' };
  const first = list.reduce((a, x) => x.date < a ? x.date : a, t), span = Math.max(14, Math.round((parseDate(t) - parseDate(first)) / 864e5) + 1);
  return { perDay: sum(list.map(x => x.amount)) / span, from: 'history', days: span };
}
let meadowDebts = null, meadowAt = 0;
function loadMeadowDebts() {
  if (Date.now() - meadowAt < 5 * 60e3) return;
  meadowAt = Date.now();
  api('GET', '/api/meadow-debts').then(d => { const had = JSON.stringify(meadowDebts); meadowDebts = Array.isArray(d.debts) ? d.debts : []; if (!d.ok) meadowAt = Date.now() - 4.5 * 60e3; if (had !== JSON.stringify(meadowDebts) && S.tab === 'home' && !busy()) render(); }).catch(() => { meadowDebts = meadowDebts || []; });
}
function planFor(pay) {
  loadMeadowDebts();
  const s = S.db.settings, next = nextPayday(today()), until = next || addDays(today(), 14), dn = dailyNeeds();
  const p = PLAN.plan({
    pay, wallet: walletBalance(), today: today(), nextPayday: next,
    bills: billsDue(today(), until).map(b => ({ name: `${b.r.emoji || ''} ${b.r.name}`.trim(), due: b.due, amount: b.amount })),
    dailyNeeds: dn.perDay, monthlyBills: sum(S.db.recurring.filter(r => r.type === 'expense').map(perMonth)),
    emergency: vaultTotal(), debts: meadowDebts || [],
    goals: S.db.goals.map(g => ({ id: g.id, name: `${g.emoji || ''} ${g.name}`.trim(), target: g.target, saved: goalSaved(g), deadline: g.deadline })),
    savePct: s.planSavePct, buffer: s.planBuffer,
    usualPay: Math.max(0, ...S.db.recurring.filter(r => r.type === 'income' && !r.variable).map(r => +r.amount || 0)),
  });
  p.needsFrom = dn.from;
  p.save = Math.floor(sum(p.moves.filter(m => m.kind !== 'debt').map(m => m.amount))); // what goes into the tower (vault or a goal)
  p.debtExtra = sum(p.moves.filter(m => m.kind === 'debt').map(m => m.amount));
  p.keep = p.needed + p.buffer;
  p.next = p.nextPayday;
  return p;
}
const payPlan = pay => planFor(pay);
const shortDate = d => parseDate(d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const listOf = (a, n = 3) => a.slice(0, n).map(b => `${esc(b.name)} ${shortDate(b.due)}`).join(' · ') + (a.length > n ? ` +${a.length - n} more` : '');
function planRows(p, { saveOverride, target } = {}) {
  const save = saveOverride ?? p.save, free = Math.max(0, p.left - p.debtExtra - save), base = p.base || 1;
  const pct = v => clamp(v / base * 100, 0, 100);
  const towerMoves = p.moves.filter(m => m.kind !== 'debt'), debtMoves = p.moves.filter(m => m.kind === 'debt');
  const towerLabel = target ? `${esc(target.emoji || '')} ${esc(target.name)}` : towerMoves.map(m => esc(m.label)).join(' + ') || 'Tower vault';
  const rows = [
    ['var(--blue)', 'Bills before payday', p.bills.length ? listOf(p.bills) : 'None due before your next paycheque 🎉', p.billTotal],
    ['#6aa9a0', 'Everyday needs', p.needsFrom === 'none' ? '<a class="link" data-action="open-plan">Set what groceries, gas and transit cost you a week ›</a>' : `≈ ${fmt0(p.dailyNeeds)}/day × ${p.days} days · groceries, gas, transit${p.needsFrom === 'history' ? ' (from your spending)' : ''}`, p.everyday],
  ];
  if (p.mins.length) rows.push(['#c46a5a', 'Debt minimums', listOf(p.mins), p.minTotal]);
  rows.push(['#8a8f98', 'Buffer', 'Stays in your account for surprises', p.buffer]);
  if (save > 0 || towerMoves.length) rows.push(['var(--gold)', 'Put aside', towerMoves.length && saveOverride == null ? towerMoves.map(m => `${esc(m.label)} ${fmt0(m.amount)}: ${esc(m.why)}`).join('<br>') : `Into ${towerLabel}`, save]);
  for (const m of debtMoves) rows.push(['#d9534f', m.label, `${esc(m.why)}. Pay it from your bank, then log it in Meadow › Debts`, m.amount]);
  rows.push(['var(--good)', 'Free to spend', `≈ ${fmt0(free / p.days)}/day until ${p.next ? `payday ${shortDate(p.next)}` : 'two weeks from now'}`, free]);
  return `<div class="meter split" style="height:12px;margin-bottom:12px">${rows.map(r => `<i style="width:${pct(r[3])}%;background:${r[0]}"></i>`).join('')}</div>
    ${rows.map(([c, b, s, v]) => `<div class="plan-row"><i style="background:${c}"></i><div><b>${b}</b><span>${s}</span></div><b class="num">${fmt0(v)}</b></div>`).join('')}
    ${p.short ? `<p class="small bad" style="margin:8px 0 0">⚠️ You're ${fmt0(p.short)} short of what's needed before your next paycheque. Hold off on wants, and skip saving this time.</p>` : ''}`;
}
function planBlock(p, target, saveOverride) { return `<div class="plan">${planRows(p, { saveOverride, target })}</div>`; }
const STAGE = {
  starter: 'Step 1: a starter emergency fund (one month of essentials) while paying extra on high-interest debt.',
  debt: 'Step 2: your starter fund is done, so most savings go to your most expensive debt.',
  emergency: 'Step 3: no high-interest debt. Build your emergency fund to 3 months of essentials.',
  grow: 'Step 4: emergency fund done. Put savings toward goals and long-term savings (TFSA or RRSP).',
};
function planInfo(p) {
  return `<details class="small muted" style="margin-top:8px"><summary>How this is worked out</summary>
    <p>Before anything else, it keeps what you need until your next paycheque: bills, everyday needs, the minimum on every debt, and a ${fmt0(p.buffer)} buffer. Then about ${p.pct}% of each paycheque goes to savings and extra debt payments (the "20" in the 50/30/20 rule of thumb), and the rest is yours to spend.</p>
    <p>${STAGE[p.stage]} Your emergency fund (the tower vault) has ${fmt0(p.emergency.saved)}; one month of essentials is about ${fmt0(p.emergency.monthEss)}.</p>
    <p>Based on guidance from the <a class="link" href="https://www.canada.ca/en/financial-consumer-agency/services/make-budget.html" target="_blank" rel="noopener">Financial Consumer Agency of Canada</a> (an emergency fund of 3 to 6 months, started small), FCAC's <a class="link" href="https://www.canada.ca/en/financial-consumer-agency/services/debt/paying-debt.html" target="_blank" rel="noopener">paying back debt</a> (always pay every minimum, then the highest interest first) and <a class="link" href="https://www.ciro.ca/node/28996" target="_blank" rel="noopener">CIRO</a> (keep it in a high-interest savings account or TFSA). This is general guidance, not personal financial advice.</p></details>`;
}
// the full breakdown of the money in your wallet right now, with the settings that drive it
function planSheet() {
  const p = planFor(0), s = S.db.settings, dn = dailyNeeds();
  return `<div style="text-align:center">${LOGO('plan-logo')}<h3 style="margin-bottom:2px">Until your next paycheque</h3>
      <p class="muted small" style="margin-top:0">${fmt(p.base)} in your wallet · ${p.days} day${p.days === 1 ? '' : 's'}${p.next ? ` until ${shortDate(p.next)}` : ''}</p></div>
    <div class="card" style="border-color:var(--gold)"><div class="plan">${planRows({ ...p, debtExtra: 0, save: 0, moves: [] })}</div></div>
    <div class="field-row">
      <label class="field"><span>Everyday needs / week</span><input id="pl-week" inputmode="decimal" placeholder="${dn.from === 'history' ? Math.round(dn.perDay * 7) + ' (from spending)' : 'e.g. 150'}" value="${s.everydayWeekly || ''}"></label>
      <label class="field"><span>Buffer</span><input id="pl-buffer" inputmode="decimal" placeholder="auto" value="${s.planBuffer ?? ''}"></label>
      <label class="field"><span>Save %</span><input id="pl-pct" inputmode="decimal" placeholder="20" value="${s.planSavePct ?? ''}"></label>
    </div>
    <p class="muted small" style="margin-top:-4px">Everyday needs = groceries, gas, transit, things you can't skip. Leave it empty to use your logged "need" spending.</p>
    <button class="btn primary block" data-action="save-plan-settings">Save</button>
    ${planInfo(p)}`;
}
// Wallet minus everything spoken for until payday = what you can spend without worry.
function homeSafe() {
  const w = walletBalance();
  if (w == null || !S.db.recurring.length) return '';
  const p = planFor(0), safe = p.left;
  const parts = [p.billTotal ? `${fmt0(p.billTotal)} bills` : '', p.everyday ? `${fmt0(p.everyday)} everyday needs` : '', p.minTotal ? `${fmt0(p.minTotal)} debt minimums` : '', `${fmt0(p.buffer)} buffer`].filter(Boolean);
  return `<div class="card safe tap ${safe < 0 ? 'neg' : ''}" data-action="open-plan">
    <div class="card-row"><div><div class="small muted">🎯 Safe to spend until ${p.next ? `payday ${shortDate(p.next)}` : 'two weeks from now'}</div>
      <div class="big num ${safe < 0 ? 'bad' : 'good'}">${safe < 0 ? '−' : ''}${fmt0(Math.abs(safe))}</div></div>
      <div style="text-align:right"><div class="num"><b>${fmt0(Math.max(0, safe) / p.days)}</b><span class="muted small">/day</span></div><div class="muted small">${p.days} day${p.days === 1 ? '' : 's'}</div></div></div>
    <div class="muted small" style="margin-top:6px">${safe < 0
      ? `⚠️ You're ${fmt0(-safe)} short of what you need before your next paycheque. Hold off on wants.`
      : `🧾 Already set aside: ${parts.join(' + ')}.`}${p.needsFrom === 'none' ? ' <span class="link">Add your everyday costs ›</span>' : ' <span class="link">See breakdown ›</span>'}</div>
  </div>`;
}

function saveForm(t) {
  const plan = payPlan(t.amount), em = plan.moves.find(m => m.kind === 'emergency'), gm = plan.moves.find(m => m.kind === 'goal');
  const target = gm && (!em || gm.amount > em.amount) ? S.db.goals.find(g => g.id === gm.goal) || null : em ? null : saveTarget();
  const sg = { amt: plan.save };
  const easy = Math.max(1, Math.round(sg.amt / 2)), push = Math.max(0, Math.min(Math.round(sg.amt * 1.5), Math.floor(plan.left - plan.debtExtra)));
  const goals = S.db.goals.filter(g => goalSaved(g) < g.target);
  return `<div style="text-align:center">${LOGO('plan-logo')}<h3 style="margin-bottom:2px">Your paycheque plan</h3>
      <p class="muted small" style="margin-top:0">You got ${fmt(t.amount)} · ${esc(t.note || cat(t.category).name)} · ${dayLabel(t.date)}<br>${fmt(plan.base)} in your account now · next paycheque ${plan.next ? shortDate(plan.next) : 'in about 2 weeks'}</p></div>
    <div class="card" id="sv-plan" data-pay="${t.amount}" style="border-color:var(--gold)">${planBlock(plan, target)}</div>
    <p class="muted small" style="margin-top:-2px">${plan.short ? 'What you need before next payday comes first this time, so nothing to save. Next paycheque!' : STAGE[plan.stage]} Saving earns +${rates().save}% in ${COIN}.</p>
    <div class="chips wrap" style="justify-content:center;${sg.amt > 0 ? '' : 'display:none'}">
      <button class="chip" data-action="save-chip" data-v="${easy}">🌱 Easy ${fmt0(easy)}</button>
      <button class="chip on" data-action="save-chip" data-v="${sg.amt}">⭐ Suggested ${fmt0(sg.amt)}</button>
      <button class="chip" data-action="save-chip" data-v="${push}">🔥 Push ${fmt0(push)}</button>
    </div>
    <div class="field-row">
      <label class="field"><span>Amount</span><input id="sv-amount" inputmode="decimal" value="${sg.amt}"></label>
      <label class="field"><span>Into</span><select id="sv-goal"><option value="">🗝️ Tower vault (emergency fund)</option>${goals.map(g => `<option value="${g.id}" ${g.id === target?.id ? 'selected' : ''}>⚔️ ${esc(g.emoji)} ${esc(g.name)}</option>`).join('')}</select></label>
    </div>
    <label class="check-row"><input id="sv-auto" type="checkbox" ${S.db.settings.autoSave ? 'checked' : ''}> Do this automatically on every paycheck</label>
    <button class="btn gold block" data-action="confirm-save" data-id="${t.id}">${target ? '⚔️ Save it & attack the boss' : '🏰 Move it to my tower'}</button>
    <div class="btn-row" style="margin-top:10px">
      <button class="btn" data-action="snooze-save" data-id="${t.id}">Later</button>
      <button class="btn" data-action="skip-save" data-id="${t.id}">Not this time</button>
    </div>
    <p class="muted small" style="margin:10px 0 0;text-align:center">💡 Move the same amount into your savings account (a high-interest savings account or TFSA) so it's really set aside.</p>
    ${planInfo(plan)}`;
}
let saving = false;
async function savePrompt() {
  if (!S.db || saving || busy() || document.body.classList.contains('is-locked') || document.querySelector('.levelup')) return;
  const list = pendingSaves().filter(t => !snoozed(t.id, 'save'));
  if (!list.length) return;
  if (S.db.settings.autoSave) {
    saving = true;
    try {
      let last = null;
      for (const t of list) {
        const plan = payPlan(t.amount), target = saveTarget();
        const res = await doSave(t, plan.save, target?.id);
        if (res) last = { t, plan, target, res };
      }
      if (last && !busy()) openModal(autoPlanSheet(last));
    } finally { saving = false; }
    return;
  }
  openModal(saveForm(list[0]));
}

// Save from a paycheck. If the boss needs less than the amount, the rest goes to the vault.
async function doSave(t, amount, goalId) {
  const goal = goalId && S.db.goals.find(g => g.id === goalId);
  const before = { floor: floorIndex(towerTotal()), alive: goal ? goalSaved(goal) < goal.target : false };
  const hp = goal ? Math.max(0, goal.target - goalSaved(goal)) : 0;
  const toGoal = goal ? Math.min(amount, hp) : 0, extra = goal ? Math.max(0, amount - toGoal) : 0;
  const ok = await mutate('POST', `/api/transactions/${t.id}/saved`, { amount: goal ? toGoal : amount, goalId: goal ? goal.id : undefined });
  if (!ok) return null;
  if (extra > 0) await mutate('POST', '/api/vault', { amount: extra, date: today() });
  const g2 = goal && S.db.goals.find(g => g.id === goal.id);
  const defeated = !!(g2 && before.alive && goalSaved(g2) >= g2.target);
  const after = floorIndex(towerTotal());
  if (defeated) { toast(`🏆 ${g2.name} DEFEATED!`, 'gold'); confetti(150); }
  else if (after > before.floor) { toast(`🏰 New floor unlocked: ${FLOORS[after][2]} ${FLOORS[after][1]}!`, 'gold'); confetti(120); }
  else if (amount > 0) { toast(goal ? `⚔️ ${fmt0(toGoal)} damage to ${g2.name}!` : `🏦 ${fmt0(amount)} paid to future you!`, 'gold'); confetti(40); }
  return { amount, toGoal, extra, goal: g2, defeated };
}
function autoPlanSheet({ t, plan, target, res }) {
  const g = res.goal;
  return `<div style="text-align:center">${LOGO('plan-logo')}<h3 style="margin-bottom:2px">🤖 Paycheck plan</h3>
      <p class="muted small" style="margin-top:0">${fmt(t.amount)} · ${esc(t.note || 'Paycheck')} · auto-saved for you</p></div>
    <div class="card" style="border-color:var(--gold)">${planBlock(plan, target, res.amount)}</div>
    ${g ? `<div class="card small" style="display:flex;gap:12px;align-items:center"><div style="font-size:30px">${esc(g.emoji)}</div>
      <div style="flex:1"><b>${res.defeated ? '🏆 DEFEATED!' : `${esc(g.name)} took ${fmt0(res.toGoal)} damage`}</b>
      <div class="boss-hp" style="margin-top:6px"><i style="width:${100 - clamp(goalSaved(g) / g.target * 100, 0, 100)}%"></i></div>
      <div class="muted" style="margin-top:4px">HP ${fmt0(Math.max(0, g.target - goalSaved(g)))} / ${fmt0(g.target)}${res.extra ? ` · ${fmt0(res.extra)} extra went to the vault` : ''}</div></div></div>` : ''}
    <p class="muted small" style="text-align:center">💡 Move ${fmt0(res.amount)} into your savings account so it's really set aside.</p>
    <button class="btn primary block" data-action="close-modal">Got it</button>`;
}
Object.assign(A, {
  'save-chip': el => {
    document.getElementById('sv-amount').value = el.dataset.v;
    el.parentElement.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === el));
    refreshPlan();
  },
  'confirm-save': async el => {
    const amount = parseAmount(document.getElementById('sv-amount').value);
    if (!(amount > 0)) return toast('Enter an amount, or tap "Not this time"', 'bad');
    const goalId = document.getElementById('sv-goal').value || undefined;
    const auto = document.getElementById('sv-auto').checked;
    const t = S.db.transactions.find(x => x.id === el.dataset.id);
    if (auto !== !!S.db.settings.autoSave) await api('PUT', '/api/settings', { autoSave: auto }).then(d => { S.db = d; }).catch(() => {});
    closeModal();
    if (await doSave(t, amount, goalId)) {
      if (auto) setTimeout(() => toast('🤖 Auto-save is on for future paychecks'), 1200);
      setTimeout(savePrompt, 1500); // another paycheck waiting?
    }
  },
  'close-modal': () => closeModal(),
  'open-plan': () => openModal(planSheet()),
  'save-plan-settings': async () => {
    const num = id => { const v = document.getElementById(id).value.trim(); return v === '' ? null : parseAmount(v); };
    const body = { everydayWeekly: num('pl-week') ?? 0, planBuffer: num('pl-buffer'), planSavePct: num('pl-pct') };
    if (await mutate('PUT', '/api/settings', body)) { openModal(planSheet()); toast('Saved. Your plan is updated.'); }
  },
  'open-save': () => { const t = pendingSaves()[0]; if (t) openModal(saveForm(t)); },
  'skip-save': async el => { if (await mutate('POST', `/api/transactions/${el.dataset.id}/saved`, { amount: 0 })) closeModal(); },
  'snooze-save': el => { snooze(el.dataset.id, 'save'); closeModal(); toast("🔔 I'll remind you in a few hours"); },
  'toggle-autosave': async el => {
    if (await mutate('PUT', '/api/settings', { autoSave: el.checked })) toast(el.checked ? '🤖 Auto-save on: every paycheck saves the suggested amount' : 'Auto-save off: you\'ll get a suggestion each payday');
  },
});
document.addEventListener('change', e => { if (e.target.id === 'tw-autosave') A['toggle-autosave'](e.target); });
// redraw the plan as you change the amount or the boss in the pop-up
function refreshPlan() {
  const box = document.getElementById('sv-plan'); if (!box) return;
  const pay = +box.dataset.pay, amt = Math.max(0, parseAmount(document.getElementById('sv-amount').value) || 0);
  const gid = document.getElementById('sv-goal').value;
  box.innerHTML = planBlock(payPlan(pay), S.db.goals.find(g => g.id === gid) || null, amt);
}
document.addEventListener('input', e => { if (e.target.id === 'sv-amount') refreshPlan(); });
document.addEventListener('change', e => { if (e.target.id === 'sv-goal') refreshPlan(); });

/* ---------------- live sync ---------------- */
// Every few seconds, ask the server if anything changed (another device, or an auto-payment).
let lastRev = null, lastDay = today();
const busy = () => S.tab === 'add' || S.tab === 'setup' || !$modal.hidden ||
  ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
async function pollRev() {
  if (document.hidden || !S.db || document.body.classList.contains('is-locked')) return;
  try {
    const r = await fetch('/api/rev');
    if (r.status === 401) return showLock();
    const { rev } = await r.json();
    const newDay = today() !== lastDay;
    paydayPrompt();
    savePrompt();
    if ((rev === lastRev && !newDay) || busy()) return;
    lastRev = rev; lastDay = today();
    const d = await api('GET', '/api/data');
    if (JSON.stringify(d) !== JSON.stringify(S.db) || newDay) { S.db = d; render(); }
  } catch { /* offline for a moment; try again next tick */ }
}
setInterval(pollRev, 8000);

reload().then(() => setTimeout(() => { paydayPrompt(); savePrompt(); }, 600));
