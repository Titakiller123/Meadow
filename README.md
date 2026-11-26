# 🌱 Meadow

Your home base for everything in your life: tasks, calendar and school, house projects, money and game nights, all in one place on your PC and iPhone.
It runs on your PC, like Money Quest. Your iPhone opens it through Tailscale and keeps working without signal.

## Set it up (once)
1. Put this `Life App` folder next to your `Money` folder (anywhere is fine).
2. Double-click **First-time setup.bat**. It:
   - makes Meadow start by itself when you log in to Windows,
   - shares it privately with your phone through Tailscale on port **10000**,
   - opens it in your browser and shows the address for your iPhone.
3. If Windows Firewall asks about Node.js, tick **Private networks** and click **Allow**.

## Connect Money Quest and Dice and Luck (once)
Double-click **Connect my apps.bat**. It finds your Money and Dice and Luck folders (or asks you to pick them) and adds a small read-only summary to each app.
- That summary only answers programs on this PC. Phones, Tailscale and the internet can't see it, and it can't change anything.
- It checks each `server.js` is exactly the version the update was made for. If you changed it since, it leaves it alone and tells you.
- The old file is kept as `server.before-meadow.js`. To undo, run `app-updates\Undo the app updates.bat`.
- Both apps restart by themselves a few seconds later.

After that, Meadow shows:
- **Home**: safe to spend, your next session and today's tasks at a glance, plus Money (wallet, this month's budget, bills and paydays for the next two weeks) and Game nights (next session for each campaign and active jobs).
- **Calendar**: bills, paydays and game sessions on their days, with a colour legend.
- **More > Connections** shows whether each app is connected. **Settings** has switches to show or hide money and game nights, **Hide amounts** (shows ••• instead of numbers), and which campaigns to show.
Each app keeps running on its own server. Meadow finds them by itself on this PC, checks them every minute in the background (even when your phone is closed) and only reads from them. If an app isn't running, Meadow shows the last summary it got, says when it was from, and picks it back up as soon as the app is running again. **More > Connections > Check now** checks straight away.

## Add your other calendars (school, iPhone, Google, Outlook)
In **More > Connections > Add a calendar**, give it a name and paste the calendar's share link (it starts with `webcal://` or `https://` and often ends in `.ics`). Its events show on Home and the Calendar in their own colour. Add as many as you like, and switch each one on or off.
- **iPhone / iCloud**: Calendar app, tap **Calendars**, tap ⓘ next to the calendar, turn on **Public Calendar**, then **Share Link** and **Copy**.
- **School portals** (Canvas, Blackboard, Outlook): look for **Calendar feed**, **Subscribe** or **Publish calendar** and copy the ICS link.
- **Google Calendar**: on a computer, **Settings**, pick the calendar, copy **Secret address in iCal format**.

Your PC downloads each calendar every 30 minutes and keeps the last good copy, so they still show when you're offline. Meadow never changes them. Repeating events, cancelled days, moved classes and time zones are handled. Anyone with a calendar's link can see it, so keep the links private.

## Connect more of your own apps
**More > Connections > Add another app**: type its name and the port it runs on (the number in `localhost:3300`). Add its Tailscale port too if you want the Open button to work from your iPhone. Meadow then shows whether it's running.

If you want an app's numbers and dates inside Meadow, give it a read-only `GET /api/link/summary` that answers with JSON like this (both parts optional):
```json
{ "stats":  [ { "label": "Meals planned", "value": "5 of 7" } ],
  "events": [ { "date": "2026-11-26", "time": "15:00", "title": "Bake pies", "sub": "Thanksgiving prep" } ] }
```
Its numbers show next to it in Connections, and its events show on Home and the Calendar.

## Put it on your iPhone
1. Make sure the Tailscale app is on (same account as the PC).
2. Open `https://<your-pc>.<tailnet>.ts.net:10000` in **Safari**. It's the same address as Money Quest, with `:10000` instead of `:8443`.
3. Tap **Share** (the square with the arrow), then **Add to Home Screen**, then **Add**.

It opens full screen like a normal app. Without signal it still works: changes are saved on the phone and sync when the PC is reachable again (the little dot at the top says "Offline · 2 to sync" until then).

## Everyday buttons
- **start.bat**: opens Meadow (and starts it if it isn't running).
- **stop.bat**: stops it until the next login.
- Ports: Dice and Luck 3000, Money Quest 3100, Meadow **3200**. Tailscale: Dice and Luck 443, Money Quest 8443, Meadow **10000**.
- Don't use `tailscale funnel` for Meadow. It would put it on the public internet, so Meadow refuses those requests.

## How it works
Meadow is your home base. On the iPhone the bottom bar has **Home, Tasks, +, Calendar, More**. On a computer everything is in the sidebar.
- **Home**: a dashboard of your day. A daily brief at the top (what's on today, plus how far through the day, week, month and year you are), six key numbers (tasks today, overdue, next 7 days, safe to spend, month spent, projects), then today's tasks, your schedule with a line showing now, **Coming up** (a countdown to paydays, bills, sessions, project targets and calendar events), **Activity** (every task you finished over the last 26 weeks, with your streak), **Areas** (open work per area), the next 7 days, money, projects, game nights and your connections. Tap any tile to open that section.
- **Tasks**: grouped into areas (Inbox, House, School, Personal, plus your own). Type a task and end it with `today`, `tomorrow`, `next week` or a day like `fri`. Add `!` at the end to mark it important. Tap a task to add a time, repeat, checklist, notes, or put it in a project. Ticking a repeating task moves it to its next date.
- **Calendar**: a month view with your events, linked calendars, bills, paydays and game sessions. Events can repeat. Deleting one day of a repeating event keeps the rest.
- **Projects** (in More): bigger jobs with several steps, like painting a room, fixing the sink or a school assignment. Each has an area, a status (in progress, planned, on hold, finished), a finish-by date, notes and its own steps with a progress bar. Steps are normal tasks, so they show on Home and the calendar too.
- **Debts** (in More, or the sidebar): add each card, loan or money you owe with its balance, interest rate (APR), minimum payment and due day. Log payments as you make them. The payoff planner shows your debt-free date, total interest and the order to pay things off, using **Avalanche** (highest interest first, saves the most) or **Snowball** (smallest balance first, quick wins), plus what an extra amount each month saves you. Payment due dates show on Home, Coming up and the Calendar.
- **Kitchen** (in More, or the sidebar): everything in your fridge, freezer and pantry, sorted by what goes off first. Type “milk 2L” or “chicken fri” to add something fast; if you don't give a date, Meadow guesses a sensible one. Tap **Use** when you use some (it tracks how much is left), **Done** when it's finished and **Toss** if it went off; either can add “Buy …” to your tasks. **Cook with what you have** suggests recipes from what's in stock, putting the ones that use up expiring food first, and you can add your own recipes. **Food waste** shows eaten vs thrown out over 8 weeks. Things about to expire show on Home, in Coming up and on the Calendar.
- **Money** and **Game nights** (in More): the full picture from Money Quest (bills, paydays, budget, savings goals) and Dice and Luck (campaigns and next sessions). Read-only; make changes in those apps.
- **Connections** (in More): your apps and calendars, with their status.
- **Settings**: name, Light / Dark / Match phone, what shows on Home, campaigns, areas, sounds, backup. Under **Extras** you can switch the little garden and companion back on.

## Your data
- Saved in `data\life.json`. A copy goes into `data\backups\` once a day, and the last 30 days are kept.
- To update Meadow, copy new program files over the old ones. Never delete the `data` folder.
- Problems? `data\server.log` shows what Meadow printed when it last started.
