# Verification: first milestone

Run on 2026-11-18 against PostgreSQL 16 and Node 22, workspace time zone America/Chicago, with the seeded demo users. Both suites wipe and reseed their own database (`fctime_test`).

## Browser walk-through: `npm run verify:ui`

The script drives the real UI in Chromium. To make the timer show a realistic duration, it backdates the running timer in the database by 52 minutes; every other step is a click or a keystroke.

| # | Step | Result |
|---|---|---|
| 1 | Morgan (admin) creates “Holiday window posters” on Northwind Coffee › Retainer: Creative, Casey, 3 h budget, due today | Saved; budget stored as **180 minutes** |
| 2 | Casey starts a timer from the task row on Home | Timer card and sidebar show it running |
| 3 | Casey refreshes the page | Timer restored from the server, showing **0:52:00** |
| 4 | Casey stops it from the sidebar | “Logged 0:52”; exactly **one** draft entry of 52 min, with start and end times |
| 5 | Casey drags 2:00–3:00 PM on today’s calendar column | Entry form opens with **14:00 – 15:00** filled in |
| 6 | Saves it | “This overlaps another entry … It was saved anyway.”; both entries kept, shown side by side |
| 7 | Adds 0:30 as a total duration | Saved |
| 8 | Submits the week | “Week submitted, 2:22” |
| 9 | Alex (Northwind’s account owner) sends it back with a reason | Entries marked Sent back; reason shown on Casey’s timesheet |
| 10 | Casey edits the 0:30 entry and resubmits | Entry stays a 0:30 total; all entries go back to Waiting for account owner |
| 11 | Alex approves (step 1 of 2) | “It moves on to the department manager.” |
| 12 | Jamie (Creative department manager) approves (step 2 of 2) | “It now counts as approved.” |
| 13 | Database check | All 3 entries `approved`, with `ae_by` Alex Rivera and `dept_by` Jamie Chen and both timestamps |
| 14 | Morgan opens Time Reports for this week, filtered to Casey, and downloads the CSV | Report: **2.37 h** total, 2.37 h billable, 0 h non-billable. CSV: 3 rows, **142 min** (52 + 60 + 30) = 2.37 h, billable 142 min. **They match.** |
| 15 | Console | No browser errors |

The CSV it downloaded:

```
date,client,project,service_line,task,person,start,end,minutes,hours,billable,approval_status,source,note
2026-11-18,Northwind Coffee,Retainer,Creative,Holiday window posters,Casey Diaz,14:00,15:00,60,1.00,yes,Approved,manual,Poster layouts
2026-11-18,Northwind Coffee,Retainer,Creative,Holiday window posters,Casey Diaz,14:35,15:27,52,0.87,yes,Approved,timer,
2026-11-18,Northwind Coffee,Retainer,Creative,Holiday window posters,Casey Diaz,,,30,0.50,yes,Approved,manual,Print specs for the window posters
```

Screenshots: [Home with timer](screenshots/home-timer.png), [calendar drag](screenshots/calendar-drag.png), [manager approval](screenshots/approvals.png), [report](screenshots/report.png). The script saves a full set to `verify-output/`.

## API and rules: `npm test` (13 tests, all passing)

`test/flow.test.js` runs the same flow through the API, plus the rules a browser can’t prove:

- **Guards:** signed-out requests get 401; form-encoded posts get 415 (CSRF); non-admins don’t receive colleagues’ email addresses.
- **Setup:** non-admins get 403 when creating clients, projects, service lines or role changes. A client can have several projects, with names unique per client. Tasks require a time budget and a due date. Only admins change a budget after a task is created.
- **Timer:** retrying a start doesn’t restart the timer. A second session sees the running timer. **Two simultaneous stops plus a late retry produce one entry**, and all three return its id. 47 minutes rounds up to 60 with 15-minute rounding. Starting another timer saves the running one as a draft. Submitting is blocked while a timer runs in the week.
- **Manual entries:** rejects junk durations and an end before the start; reports overlaps but saves the entry; blocks time over the budget (409 `budget_locked`).
- **More hours:** the timer is locked at the budget. Staff can’t add hours themselves; their request goes to an admin, and approval raises the budget and logs it. The task’s time log shows team members only their own entries, while the total counts everyone.
- **Approvals:** step 1 is offered only to the client’s account owner; the department manager and other owners don’t see it. A reviewer can’t approve their own time. A reason is required to send time back. Returned entries record who, when, which step and why. Edited entries go back to draft; resubmitting clears the reason. Repeating a decision returns 409. Step 2 goes to the service line’s manager. The audit trail reads: created → submitted → returned (Alex) → updated → submitted → approved step 1 (Alex) → approved step 2 (Jamie).
- **Wireframe exceptions:** with no account owner, admins approve step 1, and an admin who also manages the service line completes both steps at once. A department manager’s own time is not offered to them at step 2, and an admin can approve it.
- **Reports:** for six combinations of user and filter, the CSV row count, minutes and billable minutes equal the JSON totals. Casey sees only her own time, and filtering for someone else returns nothing. Jamie sees Creative time but not Strategy. Timesheet access follows the wireframe’s `canSeeTimesheet`.

`test/time.test.js` covers the duration parser (`1:30`, `1.5`, `1.5h`, `90m`), rounding, Monday weeks, and the time and date helpers.

## Also checked by hand

- Phone width (390 px): no sideways scroll on Home, Timesheets, Reports, Clients, Projects or Hours requests. Task rows and entries wrap under their titles.
- Admin screens (Settings › People, Service lines, Company defaults), the project board, the task dialog with its time budget, and Team timesheets render with the wireframe’s components.

## Known limits

- The calendar shows 7 AM to 8 PM, as in the wireframe. Time outside those hours appears in List view.
- If the suites run within an hour of midnight in the workspace time zone, the backdated timer starts on the previous day and the date assertions fail. Rerun them after midnight.
