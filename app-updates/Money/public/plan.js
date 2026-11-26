'use strict';
/* Money Quest: the paycheque plan.
   Works out how much of your money is already spoken for until your next paycheque, and
   where the rest should go. Used by the app (browser) and by the server (for Meadow), so the
   numbers are the same everywhere.

   The order follows mainstream Canadian guidance:
   - Cover what's due before the next paycheque first: bills, everyday needs (groceries, gas,
     transit) and the minimum payment on every debt.
     FCAC: "continue making the minimum payments on all your debts".
   - Keep a small buffer in your account so a surprise doesn't overdraw you.
   - Build an emergency fund, starting small: FCAC says it "should provide you with enough money
     to cover your living expenses for 3 to 6 months", and to start "by saving a small amount on a
     regular basis". CIRO suggests a high-interest savings account or a TFSA for it.
   - Put extra money on the highest-interest debt first (the avalanche method). FCAC: "you'll pay
     less interest. This will help you be debt-free sooner."
   - Aim to send about 20% of take-home pay to savings and extra debt payments, the "20" in the
     common 50/30/20 rule of thumb. What's left is yours to spend, guilt-free.
   Sources:
     https://www.canada.ca/en/financial-consumer-agency/services/make-budget.html
     https://www.canada.ca/en/financial-consumer-agency/services/debt/paying-debt.html
     https://www.ciro.ca/node/28996 (What is an emergency fund?) */
(function (root) {
  const HIGH_APR = 7; // debts at or above this rate get extra payments before long-term saving
  const r2 = n => Math.round(n * 100) / 100;
  const pd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const ds = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const add = (s, n) => { const d = pd(s); d.setDate(d.getDate() + n); return ds(d); };
  const days = (a, b) => Math.max(1, Math.round((pd(b) - pd(a)) / 864e5));
  // the dates a debt payment is due between from (inclusive) and until (exclusive)
  function debtDues(d, from, until) {
    const out = []; if (!d.dueDay) return out;
    const f = pd(from);
    for (let i = 0; i < 3; i++) {
      const y = f.getFullYear(), m = f.getMonth() + i, last = new Date(y, m + 1, 0).getDate();
      const s = ds(new Date(y, m, Math.min(+d.dueDay, last)));
      if (s >= from && s < until) out.push(s);
    }
    return out;
  }

  /* in: {
       pay,                 // the paycheque being planned (0 = plan the money already in your wallet)
       wallet,              // current wallet balance (used when pay is 0)
       today, nextPayday,   // 'YYYY-MM-DD'; nextPayday may be null (then 14 days is assumed)
       bills,               // [{ name, due, amount }] still to pay before nextPayday
       dailyNeeds,          // everyday necessary spending per day (groceries, gas, transit)
       monthlyBills,        // recurring bills per month
       emergency,           // what's saved for emergencies so far
       debts,               // [{ name, balance, apr, min, dueDay }]
       goals,               // [{ id, name, target, saved, deadline }]
       savePct,             // share of take-home for savings + extra debt (default 20)
       usualPay,            // a normal paycheque (sets the default buffer)
       buffer,              // money to always leave in the account (default: 5% of pay, at least 50)
     } */
  function plan(i) {
    const today = i.today, until = i.nextPayday || add(today, 14), n = days(today, until);
    // base = what's in your account right now. A paycheque you just logged is already in the wallet,
    // so the plan counts the money you had before payday too, not only the new cheque.
    const pay = Math.max(0, +i.pay || 0), hasWallet = i.wallet != null && i.wallet !== '';
    const base = hasWallet ? Math.max(0, +i.wallet || 0) : pay;
    const bills = (i.bills || []).filter(b => b.due < until).map(b => ({ name: b.name, due: b.due, amount: r2(+b.amount || 0) }));
    const billTotal = r2(bills.reduce((a, b) => a + b.amount, 0));
    const everyday = r2(Math.max(0, +i.dailyNeeds || 0) * n);
    const debts = (i.debts || []).filter(d => +d.balance > 0);
    const mins = [];
    for (const d of debts) for (const due of debtDues(d, today, until)) mins.push({ name: d.name, due, amount: r2(Math.min(+d.min || 0, +d.balance)) });
    const minTotal = r2(mins.reduce((a, b) => a + b.amount, 0));
    const buffer = r2(i.buffer != null && i.buffer !== '' ? Math.max(0, +i.buffer) : Math.max(50, Math.min(250, (pay || +i.usualPay || base) * 0.05)));
    const needed = r2(billTotal + everyday + minTotal);
    const left = r2(base - needed - buffer);

    // monthly essentials = bills + everyday needs; the emergency fund is measured in months of these
    const monthEss = Math.max(1, (+i.monthlyBills || 0) + Math.max(0, +i.dailyNeeds || 0) * 30.4);
    const ef = Math.max(0, +i.emergency || 0), starter = monthEss, full = monthEss * 3;
    const high = debts.filter(d => +d.apr >= HIGH_APR).sort((a, b) => b.apr - a.apr || a.balance - b.balance);
    const goals = (i.goals || []).filter(g => (g.saved || 0) < g.target).sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'));
    const pct = Math.max(0, Math.min(60, i.savePct == null ? 20 : +i.savePct));

    // the savings slice: ~20% of the paycheque, never more than what's actually left
    const slice = pay ? r2(Math.max(0, Math.min(left, pay * pct / 100))) : 0;
    const moves = [];
    let stage;
    const push = (kind, label, why, amount, extra = {}) => { amount = r2(amount); if (amount >= 1) moves.push({ kind, label, why, amount, ...extra }); };
    if (ef < starter) {
      stage = 'starter';
      const gap = starter - ef;
      if (high.length) { const e = Math.min(gap, slice / 2); push('emergency', 'Emergency fund', `Starter goal: one month of essentials (${Math.round(ef / starter * 100)}% there)`, e); push('debt', `Extra on ${high[0].name}`, `${+high[0].apr}% interest, the most expensive debt`, slice - e, { debt: high[0].name }); }
      else {
        const e = Math.min(slice, gap), rest = slice - e;
        push('emergency', 'Emergency fund', `Starter goal: one month of essentials (${Math.round(ef / starter * 100)}% there)`, e + (goals[0] ? rest * 0.5 : rest));
        if (goals[0]) push('goal', goals[0].name, 'Your next savings goal', rest * 0.5, { goal: goals[0].id });
      }
    } else if (high.length) {
      stage = 'debt';
      const d = Math.min(slice * 0.8, high.reduce((a, x) => a + +x.balance, 0));
      push('debt', `Extra on ${high[0].name}`, `${+high[0].apr}% interest: paying it first saves the most`, d, { debt: high[0].name });
      push('emergency', 'Emergency fund', 'Keep it growing toward 3 months', slice - d);
    } else if (ef < full) {
      stage = 'emergency';
      const e = Math.min(full - ef, goals.length ? slice * 0.7 : slice);
      push('emergency', 'Emergency fund', `Toward 3 months of essentials (${Math.round(ef / full * 100)}% there)`, e);
      if (goals[0]) push('goal', goals[0].name, 'Your next savings goal', slice - e, { goal: goals[0].id });
      else push('long', 'Long-term savings', 'A TFSA or RRSP', slice - e);
    } else {
      stage = 'grow';
      if (goals[0]) { push('goal', goals[0].name, 'Your next savings goal', slice * 0.5, { goal: goals[0].id }); push('long', 'Long-term savings', 'Your emergency fund is set. Grow it in a TFSA or RRSP', slice * 0.5); }
      else push('long', 'Long-term savings', 'Your emergency fund is set. Grow it in a TFSA or RRSP', slice);
    }
    const saving = r2(moves.reduce((a, m) => a + m.amount, 0));
    const free = r2(Math.max(0, left - saving));
    return {
      pay, base, until, days: n, nextPayday: i.nextPayday || null,
      bills, billTotal, everyday, dailyNeeds: +i.dailyNeeds || 0, mins, minTotal, buffer, needed,
      left, short: r2(Math.max(0, -left)), moves, saving, free, perDay: r2(free / n),
      stage, emergency: { saved: ef, starter: r2(starter), full: r2(full), monthEss: r2(monthEss) }, pct,
    };
  }
  const api = { plan, debtDues, HIGH_APR };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PLAN = api;
})(this);
