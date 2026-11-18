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

## Assumptions and open decisions

1. **Stack.** The repo was empty, so this is a new project: Node + Express + PostgreSQL, with a no-build single-page app that reuses the wireframe’s CSS, icons and component markup unchanged.
2. **Workspace time zone** defaults to `America/Chicago` (the wireframe’s `paymo.tz`) and is admin-editable. “Today”, timer dates and Monday-start weeks use it. Changing it doesn’t move saved entries.
3. **Timer entry date** is the day the timer *started* (the wireframe used the stop day). A timer that runs past 24 hours is saved as 24:00, with a warning to fix it.
4. **Rounding** rounds the duration up; the start and end clock times stay as recorded (same as the wireframe).
5. **Assignee is required** on tasks, because this brief lists it. The wireframe allowed “Unassigned.”
6. **Only admins change a time budget after a task is created.** The wireframe let anyone raise an unlocked task’s budget, which would bypass the request-and-approve flow. Whoever creates a task sets its first budget, and anyone can create tasks (as in the wireframe).
7. **No self-approval for non-admins** (not covered by the wireframe). A reviewer’s own time goes to an admin. Admins may approve their own time, and it is logged.
8. **Report visibility** (the wireframe showed everyone all time): admins see everything; Managers and Account Executives see everyone except admins, plus time on their clients; team members see their own time, plus time on clients they own and in departments they manage. The CSV uses the same rule. Bill-rate value shows to managers and admins only; cost and margin are in the backlog.
9. **Board columns are fixed** to the wireframe defaults. Custom columns per project are in the backlog.
10. **Who can see what in setup:** everyone signed in can see all clients, projects and tasks (as in the wireframe). Only admins can change setup.
11. **Sign-in** is email and password, with server sessions in Postgres. SSO (Google Workspace) would be a separate decision.
