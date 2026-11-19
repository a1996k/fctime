# Requirements map: first milestone

Source: `FifthColor Studio Manager (wireframe) (8).html`, read as source text. The wireframe was revised several times, and a later function declaration replaces an earlier one of the same name, so this map cites the **active** (last) definition. Line numbers refer to that file.

## Users and roles

| Role (wireframe `ROLE`, line 2863) | Key | What they do in this milestone |
|---|---|---|
| Admin | `admin` | Sets up people, roles, service lines, clients and projects; can approve either step; adds hours to task budgets; approves hours requests; sees all time. |
| Manager | `ae` | Usually a client’s **account owner**, giving the first approval on that client’s time. Sees everyone’s timesheets except admins’. |
| Account Executive | `acct` | Same access as Manager. |
| Team Member | `member` | Logs time and works on tasks. Can also be a **department manager** (for example, Jamie manages Creative), giving the second approval for that service line. |

“Account owner” is `client.ownerId` and “department manager” is `service.managerId`. Both are properties, not roles (wireframe `aeOf`, `deptMgrOf`, lines 3085–3101).

## Workflows

### 1. Set up work

| Item | Wireframe | Built as |
|---|---|---|
| People, roles, departments, capacity | `viewSettings` → People tab (4466) | Settings → People. Add, edit, archive, reset password. |
| Service lines with rate, color, department manager | `viewSettings` → Service lines (4466) | Settings → Service lines |
| Clients with account owner and color | `addProjectDialog` (4045), `viewClients` (3978) | Clients, Add/Edit client (admin) |
| Several projects per client; kind and status | `viewClient` (4001), `viewProjects` (4828), `settings.projectStatuses` (`seedV6`, 3909) | Client page → Add project; Projects list |
| Tasks | `taskDialog` (5199), `saveTask` (4215), `tasksTab` (4813), `taskRow` (4112) | Project page (List/Board), task dialog, Home “Add task” |
| Home: assigned tasks, this week’s hours | `viewMyWork` (4080), `homeTaskSection` (5126), `BUCKETS` (4075) | Home: timer card, tiles, tasks grouped Past due / Today / This week / Later |

**Required task fields:** name, project, service line, responsible person, status (To do / In progress / Review / Done, from `DEF_COLS`), due date, time budget (stored in minutes), billable (default on). Optional: start date, notes. `saveTask` enforces name, budget > 0 and due date, and rejects a due date before the start date.

**Validation:** names are unique per scope (clients, service lines, projects within a client). Archived clients take no new tasks or time. Tasks with logged time can’t be deleted (`taskDialog` delete button). Only admins or the task’s creator can delete one.

### 2. Track time

| Item | Wireframe | Built as |
|---|---|---|
| Start from Home, sidebar, task | `timerCard` in `viewMyWork`, `sidebar` timer (3951), `taskRow` play button, task dialog “Start timer” | All four, plus the project board |
| Pick a task | `timerPickDialog` (2931) | Same: search, “Assigned to you” first |
| One timer per person; starting another saves the last as a draft | `startTimer` (4238) calling `stopTimer(true)` | `POST /api/timer/start` stops and saves any running timer in the same transaction; `timers.user_id` is UNIQUE |
| Restore after refresh | wireframe used `localStorage` | Timer lives in the database; Home and sidebar read it on load |
| Rounding when a timer stops | `roundMin` (2908); Settings “Round timer entries up to” none/6/15 | `settings.rounding_minutes`, applied in `stopTimerRow` |
| Budget used vs budget; lock at 100% | `isLocked` (4111), `taskRow` pill, `runChecks` alerts | Logged/budget pill (amber at the alert %, red lock at 100%); timer start and manual entries are blocked when over |
| Ask for more hours | `moreTimeDialog` (4156), `submitMoreTime` (4254), `approveRequest` (4269) | Staff send a request; admins approve or decline under Timesheets → Hours requests. Admins can also add hours directly. Every change goes to `task_budget_log`. |

**Timer state transitions:** none → running (start) → draft entry (stop, or start on another task). Stop is idempotent: the client sends the timer’s id, and `time_entries.source_timer_id` is UNIQUE, so retries return the same entry (`alreadyStopped: true`).

### 3. Log time manually

| Item | Wireframe | Built as |
|---|---|---|
| Start and end, or a total (`1:30`, `1.5`, `90m`) | round 11 `entryDialog` (6217), `saveEntry2` (6234), `parseDuration` (2874) | Same form and parser, shared by browser and server (`public/js/shared/time.js`) |
| Weekly list and calendar views | `listWeek` (4341), `calendarWeek` (4348) | Timesheets → My timesheet, Calendar/List toggle |
| Drag on the calendar to prefill the form | pointer handlers after `saveEntry2` (6250–6270) | Same: 15-minute snap, 7 AM – 8 PM grid |
| Warn on overlaps, save anyway | `saveEntry2` clash toast | Server returns `overlaps`; UI warns “It was saved anyway.” Overlapping blocks sit side by side on the calendar. |

**Validation:** task required; date required; end after start; total between 1 minute and 24 hours; entry must fit the task budget; new time only on open tasks of active clients.

### 4. Submit and approve the week

Statuses (`ESTATUS`, 2864): `draft` (Not submitted) → `submitted` (Waiting for account owner) → `ae-approved` (Waiting for department manager) → `approved`. Either review step can move entries to `rejected` (Sent back).

| Item | Wireframe | Built as |
|---|---|---|
| Edit own draft or sent-back entries only | `editableEntry` (3027) | Enforced in `PATCH/DELETE /api/entries/:id` |
| Submit the week | `submitWeek` (3065): drafts and sent-back entries → submitted; blocked while a timer runs this week | `POST /api/timesheets/submit` |
| Step 1: account owner | `timeGroups` (3079), `canAE` | Grouped by person × week × client |
| Step 2: department manager of the task’s service line | `canDept` | Grouped by person × week × service line |
| Approve / send back with a reason | `approveGroup` (3096), `rejectGroup` (3100) | `POST /api/approvals/approve` and `/return`; a reason is required |
| Correct and resubmit | editing a rejected entry returns it to draft (`saveEntry2`) | Same; the reason stays visible until resubmitted |
| Who acted and when | `e.ae`, `e.dept`, `e.rejected` `{by, at}` | `ae_by/ae_at`, `dept_by/dept_at`, `rejected_*` columns, plus a `time_entry_events` audit row for every action (shown as History on each entry) |
| Team timesheets | `teamWeek` (4361), `canSeeTimesheet` (4314) | Timesheets → Team timesheets |

**Reviewer exceptions, taken from the wireframe:**
- Admins can act at either step (`canAE`, `canDept`).
- No account owner, or no department manager, means admins approve (`aeOf(e)||'__admins'`; Settings shows “Admins approve”).
- If whoever approves step 1 is also the step-2 approver, or there is no manager and an admin approves step 1, both steps complete at once (`approveGroup`).

All rules run on the server. `lockForDecision` re-checks every entry inside a transaction, and a stale or repeated decision returns 409.

### 5. Report on hours

| Item | Wireframe | Built as |
|---|---|---|
| Filters: date range, client, project, person, billable, approval | `repCfg` / `repEntries` (5022–5028), `RPRE` presets | Same presets plus Custom. Approval filter: all / approved / not yet approved / a single status. |
| Total, billable, non-billable | KPI tiles in `viewReports` (5041) | Tiles plus a grouped tree (up to three levels) |
| CSV | `rbCsv` (5074) | `GET /api/reports/time.csv`, one row per entry, with minutes and hours. It uses the same query as the on-screen report, so totals match to the minute. |

## Milestone 2

### Notifications (wireframe `notify` 3700, `bell` 3728, `bellPanel` 3732, `openNotifLink` 3739, `runChecks` 4283)

| Event | Who is told | Link |
|---|---|---|
| A week is submitted | Each client’s account owner, or admins if the client has no owner or it’s the owner’s own time | Timesheet approvals |
| Step 1 approved | The service line’s department manager, or admins if none or it’s their own time | Timesheet approvals |
| Time sent back | The person, with the reviewer’s reason | That week’s timesheet |
| Time fully approved | The person | That week’s timesheet |
| More hours requested | Admins | Hours requests |
| Request approved or declined, or hours added | The requester and the person responsible | The task |
| Task assigned by someone else | The new assignee | The task |
| Budget passes the alert percent, or locks at 100% | The assignee; admins too when it locks (once per budget) | The task |
| Task due within two days, or overdue | The assignee, once per due date (created when they open the app) | The task |

Nobody is notified of their own action. Unread counts refresh every minute. Email delivery stays a separate decision (see the backlog).

### Paymo import (wireframe `viewImport` 2368, `buildImport` 2381, `settings.paymo` in `seed`, `paymoProjectOptions` 2167)

- **Sources:**
  - The Paymo API v3, using Basic auth with the API key as the username, month-sized `time_interval` windows, and Retry-After handling.
  - A Paymo CSV export, with columns matched by name and adjustable on the preview.
- **Staging:** a run is staged in `import_runs` and previewed. Nothing is written until the admin imports.
- **Matching:** each record is matched by Paymo id, then by name (or email for people). Matched records are never changed. Entries are de-duplicated by `paymo_entry_id`, or for CSV rows by a hash of date, person, task, times and duration.
- **Service lines:** task lists map by each service line’s keywords, and the admin can override any of them. Tasks without a task list match by task name; anything left over goes to a default.
- **What comes over:**
  - Open tasks, plus any task with time in the range.
  - New tasks get Paymo’s due date (otherwise the last logged day) and Paymo’s budget (otherwise the imported time, plus optional extra hours for open tasks).
  - New people arrive as Team Members with no password; people inactive in Paymo arrive archived.
  - Imported time arrives approved (the default) or not submitted. Each entry gets an `imported` audit event.

## Assumptions and open decisions

1. **Stack.** The repo was empty, so this is a new project: Node + Express + MySQL 8, with a no-build single-page app that reuses the wireframe’s CSS, icons and component markup unchanged. MySQL matches FifthColor’s other applications. The first version used PostgreSQL and was switched over with the same behavior and tests.
2. **Workspace time zone** defaults to `America/Chicago` (the wireframe’s `paymo.tz`) and is admin-editable. “Today”, timer dates, Monday-start weeks and displayed timestamps use it. Changing it doesn’t move saved entries.
3. **Timer entry date** is the day the timer *started* (the wireframe used the stop day). A timer that runs past 24 hours is saved as 24:00, with a warning to fix it. A running timer blocks submitting only the week it will land in.
4. **Rounding** rounds the duration up; the start and end clock times stay as recorded (same as the wireframe), so a rounded timer entry counts more minutes than its clock span. Overlap checks and the calendar use the recorded span. Editing an entry without changing its times keeps the rounded minutes. Entries can't cross midnight in the form; split them into one entry per day.
5. **Assignee is required** on tasks, because this brief lists it. The wireframe allowed “Unassigned.”
6. **Setting up tasks is for admins and managers** (changed after review). In the wireframe anyone could add or edit tasks, which let staff sidestep the hours-request approval with a new high-budget task, and let anyone reroute or re-bill submitted time.
   - Admins and Managers/Account Executives create tasks and edit their details.
   - Only admins change a budget after creation; budgets are capped at 10,000 hours.
   - The person responsible can change status and notes.
   - Everyone can still see tasks and log time on open ones.
7. **Nobody approves their own time** (not covered by the wireframe):
   - A reviewer’s own time goes to admins, and the approvals list says so.
   - An admin’s own time goes to another active admin. Only a sole admin may approve their own time, since nobody else could.
8. **Submitted time is frozen** (added after review). Each entry keeps its service line (which decides the department manager) and billable flag from submission, while the client stays fixed through its project. Task edits change only time that hasn’t been submitted yet, and sent-back time picks up the task’s current values again. The app keeps these in step in the same transaction as each change, without database triggers. Reviewers act on the exact version of each entry they saw, and anything changed since is refused.
9. **Overlap warning** appears in the form as soon as the times overlap, and again after saving. Saving is always allowed. The wireframe only warned after saving.
10. **Budget checks** block only added minutes. An entry already over budget (a timer can run past the limit) can still be corrected or reduced.
11. **Report visibility** (the wireframe showed everyone all time):
    - Admins see everything.
    - Managers and Account Executives see everyone except admins, plus time on their clients.
    - Team members see their own time, plus time on clients they own and in departments they manage.
    - The CSV, the person filter and the task time log follow the same rule. Bill rates and bill-rate value show only to managers and admins; cost and margin are in the backlog.
12. **Board columns are fixed** to the wireframe defaults. Custom columns per project are in the backlog.
13. **Setup is visible to everyone signed in:** all clients, projects and tasks, as in the wireframe. Only admins change people, service lines, clients, projects and settings.
14. **Sign-in** is email and password, with server sessions in the database:
    - Failed attempts are blocked per email after 10. Many failures from one network address slow that address down but never block a correct password.
    - Unknown emails take as long to reject as wrong passwords.
    - People change their own password, which signs out their other sessions.
    - SSO (Google Workspace) and password reset by email would be separate decisions.
15. **Dates** can’t be logged more than a week ahead.
