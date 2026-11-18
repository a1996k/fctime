# FifthColor Time

An internal web app for tracking time against FifthColor client work. Navigation, layouts, wording and visual design come from the FifthColor Studio Manager wireframe. Paymo served as the workflow reference.

**First milestone (this build):** setting up work, timers, manual time entry, weekly submission with two-step approval, and hour reports with CSV export.

- [Requirements map](docs/requirements-map.md): each workflow traced to its wireframe screen or function, with the rules and the assumptions made.
- [Backlog](docs/backlog.md): the remaining wireframe features, with simulated integrations flagged for decisions.
- [Verification](docs/verification.md): what was tested and the results.

## Stack

- **Server:** Node.js 20+ and Express 5, with PostgreSQL 14+ through `pg`. No ORM; the schema is plain SQL in `db/migrations/`.
- **Client:** a no-build single-page app (`public/`) that reuses the wireframe’s stylesheet, icons and component markup unchanged.
- **Sign-in:** email and password, hashed with scrypt, with HTTP-only session cookies stored in Postgres. Mutating requests must be JSON, which blocks cross-site form posts.
- **Time:** durations are whole minutes. Dates and Monday-start weeks follow the workspace time zone (Settings → Company defaults, default `America/Chicago`). Stopping a timer is safe to retry: each timer creates exactly one entry (`time_entries.source_timer_id` is unique).

## Local setup

You need Node.js 20 or newer and PostgreSQL. Either use your own Postgres, or start one with Docker:

```bash
docker compose up -d
```

That creates the `fctime` database and an empty `fctime_test` database, with user and password `fctime`/`fctime`. If you use your own Postgres instead, create both databases:

```bash
createdb fctime && createdb fctime_test
```

Then install, configure, load the demo data and start the server:

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm run db:reset
```

```bash
npm start
```

Open http://localhost:3000. `npm run dev` restarts the server whenever files change. Migrations also run on every `npm start`.

| Command | What it does |
|---|---|
| `npm run db:reset` | Drops every table in `DATABASE_URL`, migrates, and loads the demo data |
| `npm run db:migrate` | Applies new migrations only |
| `npm test` | API and unit tests against `TEST_DATABASE_URL` (default `fctime_test`, which is wiped) |
| `npm run verify:ui` | Walks through the whole flow in Chromium (needs Playwright; see below) and saves screenshots to `verify-output/` |

To run the browser check on your machine, install Playwright once:

```bash
npm i -D playwright && npx playwright install chromium
```

## Demo sign-in

Every demo user’s password is `fifthcolor-demo` (set `DEMO_PASSWORD` in `.env` before seeding to change it). People, clients and tasks come from the wireframe’s sample data, with dates moved to the current weeks.

| Person | Email | Role | Why sign in as them |
|---|---|---|---|
| Morgan Hale | morgan@fifthcolor.example | Admin; Strategy manager | Settings, every approval, hours requests, every report |
| Alex Rivera | alex@fifthcolor.example | Manager | Account owner of Northwind Coffee and Pine & Co.: step-1 approvals |
| Sam Patel | sam@fifthcolor.example | Manager | Account owner of Harbor Health |
| Jamie Chen | jamie@fifthcolor.example | Team Member, Creative | Creative and Video manager: step-2 approvals |
| Casey Diaz | casey@fifthcolor.example | Team Member, Creative | Logs time; 24 h week |
| Riley Brooks | riley@fifthcolor.example | Team Member, Development | Development manager |
| Taylor Kim | taylor@fifthcolor.example | Team Member, Strategy | Logs time |
| Chris Ortega | chris@fifthcolor.example | Team Member, Media | Media manager |

**A quick tour:** sign in as Casey, start a timer from Home, refresh the page, then stop it from the sidebar. Drag on the Timesheets calendar to add time, then submit the week. Sign in as Alex to approve or send it back (Timesheets → Timesheet approvals), then as Jamie for the second step. Sign in as Morgan to see Time Reports and download the CSV.

## Project layout

```
server/            Express app, auth, business rules (domain.js), routes/, demo seed
db/migrations/     SQL schema
public/            index.html, css/fc.css (from the wireframe) + app.css, js/ (views, store, shared time helpers)
test/              node:test API flow and unit tests
scripts/           migrate, seed, verify-ui (Playwright walk-through)
docs/              requirements map, backlog, verification
```

## Paymo data

Nothing from Paymo is needed for this milestone; it runs on demo data. The import is the next step, and the tables already have `paymo_*_id` columns so imports can be re-run without duplicates. When you’re ready to migrate, send either a **read-only Paymo API key** (best: it lets the import re-run for a final top-up at cutover) or these CSV exports:

1. **Users:** name, email, active or not. Also say which role each person should have here, and their department.
2. **Clients:** Paymo client ID and name. Also say who the account owner is for each.
3. **Projects:** Paymo project ID, name, client, active or archived, and retainer or project.
4. **Task lists and tasks:** task ID, name, project, task list, assignees, due date, budget hours, billable flag. Also say how task lists map to service lines (the wireframe matched them by keyword, for example “Design, Copy → Creative”).
5. **Time entries** for the history you want to keep: entry ID, date, start and end (or duration), user, task, description, billable or billed flag.

Also needed: the earliest date to bring over (the wireframe assumed January 2026), the time zone your Paymo account uses, and whether imported history should land as already **approved**.
