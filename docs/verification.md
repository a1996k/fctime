# Verification

Run on 2026-11-19 against MySQL 8.0.46 and Node 22, workspace time zone America/Chicago, with the seeded demo users. Each suite wipes and reseeds its own database (`fctime_test`).

## Switch to MySQL

The app first ran on PostgreSQL 16; it now runs on MySQL 8 to match FifthColor’s other applications. Both suites passed on PostgreSQL before the switch and pass on MySQL after it, with the same checks.
- **No triggers.** The entry snapshot (service line and billable flag) is now kept in step by the app, in the same transaction as each change. New checks prove that unsubmitted time follows task edits and that sent-back time picks up the task’s current service line.
- **Time zones.** Timestamps are stored in UTC, and workspace dates are worked out in Node. MySQL’s time zone tables aren’t needed.
- **Large imports.** A 200,000-row Paymo CSV is about 22 MB once stored. It saved in under a second, within MySQL 8’s default `max_allowed_packet` of 64 MB. (A single web import is now capped at 50,000 entries; see the pre-launch checks.)

## Pre-launch checks

Run before going live, against a production-mode server (`NODE_ENV=production`) on an empty database, and against a large copy of history.

**Production setup**
- `npm run admin:create` creates the first admin on an empty database, both by the hidden password prompt and with `NEW_PASSWORD`. It refuses short or mismatched passwords and a missing name, and given an existing email it restores that person as an admin and signs out their old sessions.
- The demo seed refuses to run with `NODE_ENV=production`, and on any database that already has people. `db:reset` refuses with `NODE_ENV=production`, and when the database holds anyone but the demo users (unless `--force`). With `NODE_ENV=production` the app won’t start without `DATABASE_URL`.
- Signed in over HTTPS (through a trusted proxy), the session cookie is `Secure` and responses carry `Strict-Transport-Security`. Every response has a Content-Security-Policy that allows only the app’s own scripts. The browser walk-through below runs under it with no errors.
- A new admin on an empty workspace can open every page with no browser errors.
- **Admin login from `.env`:**
  - With `ADMIN_PASSWORD` set, the server creates an admin with the username `admin` at start, and signing in as `admin` on the real sign-in page works.
  - A password under 12 characters, or the demo password, stops the server with a message and creates nothing.
  - A changed password takes over at the next start and signs out the old sessions.
  - While `.env` controls the account, the app refuses to archive it, demote it or give it another password.
- On a restart (`SIGTERM`), the server finishes the requests in flight and closes the database pool.
- `npm audit`: no known vulnerabilities in the dependencies.

**Load test:** a generated Paymo export with five years of weekday time for 30 people. That’s 137,264 entries across 60 clients, 172 projects and 1,096 tasks, about the most the app should see.

| What | Result |
|---|---|
| Import from the command line (preview, then `--commit`) | 2.6 s to preview, 25 s to import, in one transaction |
| Same file through the web import | Works (3.6 s to preview), but the server reached about 1 GB of memory, so a single web import is now capped at 50,000 entries, with a message pointing to smaller date ranges or the command line |
| Page load (the bootstrap call every page makes, and every save repeats) | 0.65 s at first; **0.13 s** after adding an index so task totals come from the index alone (migration 002) |
| Timesheet week, approvals queue, team week, notifications, a task’s time log | 2–25 ms each |
| Report for one month, admin | 0.07 s |
| Report for the year so far (about 27,000 entries), admin | 0.85 s on the server; in Chromium, totals drawn 0.8 s after choosing “This year”. The page now receives only the fields it shows, and responses are gzipped: 23.6 MB became **0.4 MB** on the wire |
| CSV for a full year | 0.73 s |

## Browser walk-through: `npm run verify:ui` (21 checks, all passing)

The script drives the real UI in Chromium. To give the timer a realistic duration, it backdates the running timer in the database by 52 minutes; every other step is a click or a keystroke. The Paymo steps run against a stand-in Paymo server that answers in the same shapes as Paymo's API.

| # | Step | Result |
|---|---|---|
| 1 | Morgan (admin) creates “Holiday window posters” on Northwind Coffee › Retainer: Creative, Casey, 3 h, due today | Saved; budget stored as **180 minutes** |
| 2 | Casey opens Home | **Add task** is locked for her (“Admins and managers add tasks”) |
| 3 | Casey starts a timer from the task row, then refreshes the page | Timer restored from the server, showing **0:52:00** |
| 4 | Casey stops it from the sidebar | “Logged 0:52”; exactly **one** draft entry, with start and end |
| 5 | Casey drags out an hour on today’s calendar column, overlapping the timer entry | The form opens with that range filled in (**10:00 – 11:00** on this run) and **warns about the overlap before saving** |
| 6 | Saves it, then adds 0:30 as a total | Both saved; the overlap warning shows again after saving |
| 7 | Submits the week | “Week submitted, 2:22” |
| 8 | Alex signs in | His **bell** shows “Time to approve: Casey Diaz submitted 2:22 on Northwind Coffee…”; clicking it opens Timesheet approvals |
| 9 | Alex sends it back with a reason | Entries marked Sent back |
| 10 | Casey reloads | Her bell shows “Your time was sent back: Alex Rivera: Please split…”; clicking it opens that week |
| 11 | Casey edits the 0:30 entry and resubmits | Entry stays a 0:30 total; back to Waiting for account owner |
| 12 | Alex approves (step 1), Jamie approves (step 2) | All 3 entries `approved`, with `ae_by` Alex Rivera and `dept_by` Jamie Chen |
| 13 | Morgan’s report for Casey this week, and its CSV | Report **2.37 h**; CSV 3 rows, **142 min**. **They match.** |
| 14 | Morgan fetches October from Paymo with an API key | The preview opens before anything is saved: 2 entries, 3.75 h |
| 15 | Changes the “Account management” task list to Strategy, then imports | 2 entries imported as approved. Pat Moreno is added; Casey is matched by email; Design → Creative by keyword; Account management → Strategy as chosen |
| 16 | Console | No browser errors |

Screenshots: [Home with timer](screenshots/home-timer.png), [calendar drag](screenshots/calendar-drag.png), [notifications](screenshots/notifications.png), [manager approval](screenshots/approvals.png), [report](screenshots/report.png), [import preview](screenshots/import-preview.png). The script saves a full set to `verify-output/`.

## API, import and unit tests: `npm test` (29 tests, all passing)

**`test/flow.test.js`** covers the whole milestone through the API, plus the rules a browser can’t prove:

- **Guards and setup:** sign-in, JSON-only writes, and admin-only setup. Task creation and editing are limited to admins and managers; the person responsible can change only status and notes; budgets are capped.
- **Timer:** retried starts and stops. Two simultaneous stops plus a retry give one entry. Rounding applies. Starting another timer saves the running one as a draft. A timer blocks submitting only the week it lands in. Someone else’s timer id reveals nothing.
- **Manual entries:**
  - Duration formats, the end-after-start rule, and overlaps (with no false overlaps from zero-length or past-midnight timer entries).
  - Budget locks block only added minutes, so over-budget time can be corrected.
  - Timer rounding survives a note-only edit, and dates can’t be more than a week ahead.
- **More hours:** the request and approval flow. Two requests sent at once yield one.
- **Approvals:**
  - Routing to the account owner, then the department manager, with send-back reasons and resubmission, and the full audit trail.
  - Stale decisions are refused, and repeating a decision is refused.
  - Wireframe exceptions: no owner means admins approve, and one person can complete both steps.
  - No self-approval: a manager’s own time goes to admins with a clear label, and an admin’s own time goes to another admin.
- **Frozen routing:** the review’s hijack scenario. Moving a task to another service line after submission doesn’t move its submitted time, and approved billable totals don’t change when the task’s billable flag does. Time not yet submitted does follow the task, and sent-back time picks up the task’s current service line.
- **Reports:** for six combinations of user and filter, CSV rows, minutes and billable minutes equal the report totals. Each role sees only what it should, including the task time log.
- **Notifications:** each event reaches the right person once, and people can’t mark others’ notifications read.
- **People and sign-in:** role and department validation, bill rates hidden from team members, changing your own password, and archiving someone saves their running timer as a draft.
- **Re-check fixes:** large uploads refused before sign-in, rounded timer entries don't overlap what follows, and failed sign-ins slow an address down without locking out a correct password.
- **Pre-launch review fixes:** only the exact email signs in; deletes work without a body, as the page sends them; lists where text belongs and uppercase ids are refused.
- **Admin login from `.env`:** weak passwords are refused, a new password in `.env` replaces the old one and ends its sessions, and the app leaves its sign-in to `.env`.

**`test/import.test.js`** runs the Paymo import against a stand-in Paymo API and a CSV export:

- **Access and keys:** admins only, and a wrong key is reported clearly.
- **Fetching:** entries come month by month, with the rate-limit retry exercised.
- **Matching:** people by email, clients and projects by name, task lists by keyword or the admin’s choice.
- **What’s left out:** running Paymo timers, entries with no duration, and guests.
- **Conversion:** UTC times land in Chicago time, and HTML is stripped from descriptions.
- **Re-runs:** importing again adds only what’s new; a third run has nothing to import.
- **CSV:** columns are detected; identical rows stay distinct; the same file imported again adds nothing, even after remapping the description column. Imported people can’t sign in until given a password.
- **Size limit:** a web import over 50,000 entries is refused with directions, and nothing is stored.
- **Mixed sources:** time imported by CSV is recognized when the API brings it again, and the other way round.
- **Entry IDs:** an “Entry type” column isn’t taken for one; repeated IDs are reported instead of merged; IDs differing only in case stay apart.

**`test/time.test.js`** covers the duration parser, rounding, Monday weeks and the time helpers.

## Independent review

A separate review of the milestone-1 code, made without seeing my conclusions, found 1 high, 7 medium and several low issues. All were fixed in milestone 2, with a regression test for each where one applies:

| Finding | Fix |
|---|---|
| **High:** anyone could edit any task, rerouting submitted time to their own approval queue or changing approved billable totals | Task permissions; each entry freezes its service line and billable flag when submitted |
| Admin couldn’t open entry History (server error) | Query parameters fixed |
| A sent-back entry over its budget couldn’t be corrected | Only added minutes count against the budget |
| A reviewer could approve time that changed after they loaded it | Decisions carry each entry’s version; stale ones are refused |
| Anyone could create a high-budget task to sidestep the hours request | Only admins and managers create tasks; budgets capped |
| Editing a timer entry lost its rounding | Unchanged times keep the stored minutes |
| Zero-length and past-midnight timer entries broke overlaps and re-saving | Overlaps use start plus duration; unchanged times can be re-saved |
| Saving settings could silently change the time zone | The saved zone is always listed, and the zone is sent only when changed |
| The “stop your timer” guard checked today’s week, not the timer’s | It checks the week the timer’s time lands in |
| Admins approved their own time end to end | Another admin approves it while one exists |
| Smaller items: misleading approver label, bill rates visible to team members, the calendar misdrawing out-of-hours entries, UTC timestamps, duplicate hours requests, someone else’s timer id revealing their timer, server errors on bad input, far-future dates, a possible approval deadlock, the sign-in throttle, no way to change your own password, an archived person’s orphaned timer, “today” going stale overnight | All fixed |

### Re-check of the fixes

The same reviewer then re-ran its reproduction scripts against the fixes.
- **Fixed:** 12 of the 16 findings, including the serious one. The hijack attempt now gets 403, and the approved billable total stays at 1350 minutes.
- **Partly fixed (left that way on purpose):**
  - A timer entry keeps its real start and stop times while counting rounded minutes, so the two can disagree. This is assumption 4, as in the wireframe. Overlaps and the calendar use the real times.
  - An entry that crossed midnight can be re-saved but not given new times. Split it into one entry per day.
- **Not fixed (low, documented below):** the CSV `hours` rounding, and the one-minute draft left when switching timers within the first minute.

The re-check also caught issues my fixes had introduced. All are now fixed, with tests:

| Issue | Fix |
|---|---|
| **Medium:** the 40 MB import upload limit applied before sign-in was checked, so anyone could make the server read huge bodies | Sign-in is resolved first; only an admin's CSV upload gets the large limit, and everyone else is refused at 200 KB |
| Many failed sign-ins from one address locked out correct passwords too (an office behind one address could be locked out) | That address is slowed down instead of blocked. `TRUST_PROXY` sets the client address behind a reverse proxy |
| Overlap checks used the rounded length, so a rounded timer entry “overlapped” the next one | Overlaps and the calendar use recorded clock times, falling back to the duration only for zero-length or past-midnight entries |
| Dragging to the bottom of a calendar that runs to midnight left End empty | The drag stops at 23:59 |
| Unticked entries in approvals stayed unticked after a decision | Selections reset when approvals reload |
| Changing your password left your other sessions signed in | Other sessions end; an admin’s password reset ends all of that person’s sessions |

Still open and in the backlog: a deleted entry’s history has no screen (its events are kept).

### Second independent review, before launch

A fresh review, made without seeing my conclusions, covered the MySQL rewrite, the Paymo import and the pages. It reproduced each finding against a running server. All are fixed, each with a test that fails on the code before the fix:

| Finding | Fix |
|---|---|
| **High:** MySQL’s default collation ignores accents and letter widths, so “cásey@” or a full-width “ｃasey@” signed in as Casey, and each spelling got its own 10 tries before the lockout. This came in with the switch to MySQL. | Only the exact address signs in (letter case still doesn’t matter), and failed tries count against the person, however the address is typed |
| **High:** importing the same time from a CSV and then from the API (or the other way round) added it twice, as approved | Time imported earlier from the other source is matched by person, task, date and minutes, one existing entry for each incoming one |
| Deleting a time entry or a task in the app always failed: the page sends deletes with no body, and the server wanted JSON. The API tests had sent a body, so they missed it. | Deletes need no body. A browser can’t send a cross-site DELETE without a preflight, so this doesn’t weaken the cross-site request guard. Checked in Chromium too |
| A CSV column like “Entry type” was taken for the entry ID, so rows sharing a value (“Manual”) were silently merged into one | “Entry type” is no longer matched. If the chosen ID column repeats a value, those rows are listed as problems with the fix, not merged. IDs that differ only in letter case are kept apart (migration 003) |
| Low: a list where text was expected (`"start": ["09:00"]`) caused a server error | It’s refused as bad input |
| Low: an uppercase copy of an id was accepted and stored, then failed comparisons later (an assignee lost access to their task) | Ids must be lowercase, as the app creates them |

The review also checked these and found them sound:
- **SQL injection:** every query is parameterized, including the list expansion and bulk inserts.
- **Database connections:** each runs at READ COMMITTED, in UTC, in strict mode.
- **Races:** 12 parallel entries against a 60-minute budget accepted exactly 2, and a simultaneous approve and send-back gave one 200 and one 409.
- **The earlier review’s fixes:** the frozen routing, stale decisions and self-approval guards all hold on MySQL.
- **Visibility:** each role sees only what it should, in reports, the CSV export, the task time log, entry history, the team view and timesheets. Bill rates are hidden from team members.
- **Escaping:** imported and typed text is escaped everywhere it’s shown.
- **Sessions:** revoked on sign-out, on a password change and on archiving.

## Known limits

- If the suites run within an hour of midnight in the workspace time zone, the backdated timer starts on the previous day and the date assertions fail. Rerun them after midnight.
- The Paymo import was tested against a stand-in server built from Paymo’s published API docs, not a live Paymo account. A first real import should start with a short date range to confirm the mapping.
- In the CSV export, the `hours` column is rounded per row; the `minutes` column is exact and is what reconciles.
- Switching timers within the first minute still saves the first one as a draft: 1 minute, or 15 with 15-minute rounding. That’s deliberate, since the brief says a superseded timer becomes a draft entry. The person can delete it.
