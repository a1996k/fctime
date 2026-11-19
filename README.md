# FifthColor Time

An internal web app for tracking time against FifthColor client work. Navigation, layouts, wording and visual design come from the FifthColor Studio Manager wireframe. Paymo served as the workflow reference.

**Milestone 1:** setting up work, timers, manual time entry, weekly submission with two-step approval, and hour reports with CSV export.
**Milestone 2:** in-app notifications, importing from Paymo (API key or CSV export), and fixes from an independent review.

- [Requirements map](docs/requirements-map.md): each workflow traced to its wireframe screen or function, with the rules and the assumptions made.
- [Backlog](docs/backlog.md): the remaining wireframe features, with simulated integrations flagged for decisions.
- [Verification](docs/verification.md): what was tested, the review findings, and the results.
- [Going live](docs/deployment.md): hosting, configuration, the first admin, bringing Paymo history over, backups and upgrades.

## Stack

- **Server:** Node.js 20+ and Express 5, with MySQL 8.0 through `mysql2`, the same database as FifthColor’s other applications. No ORM; the schema is plain SQL in `db/migrations/`.
- **Client:** a no-build single-page app (`public/`) that reuses the wireframe’s stylesheet, icons and component markup unchanged.
- **Sign-in:** email and password, hashed with scrypt, with HTTP-only session cookies stored in the database. Mutating requests must be JSON, which blocks cross-site form posts. People change their own password by clicking their name at the top of any page.
- **Time:** durations are whole minutes. Dates and Monday-start weeks follow the workspace time zone (Settings → Company defaults, default `America/Chicago`). Stopping a timer is safe to retry: each timer creates exactly one entry (`time_entries.source_timer_id` is unique).
- **Integrity:** each entry keeps its own service line and billable flag once submitted, so later task edits can’t move it to a different approver or change approved totals. Reviewers approve exactly the version of each entry they saw.

## Local setup

You need Node.js 20 or newer and MySQL 8.0.16 or newer (MariaDB isn’t supported). Either use your own MySQL server, or start one with Docker:

```bash
docker compose up -d
```

That creates the `fctime` database and an empty `fctime_test` database, with user and password `fctime`/`fctime`. If you use your own MySQL server instead, create the user and both databases as an admin (pick your own password and put it in `DATABASE_URL`):

```sql
CREATE USER 'fctime'@'%' IDENTIFIED BY 'fctime';
CREATE DATABASE fctime CHARACTER SET utf8mb4;
CREATE DATABASE fctime_test CHARACTER SET utf8mb4;
GRANT ALL PRIVILEGES ON fctime.* TO 'fctime'@'%';
GRANT ALL PRIVILEGES ON fctime_test.* TO 'fctime'@'%';
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

Open http://localhost:3000. `npm run dev` restarts the server whenever files change. New migrations apply on every `npm start`, so an existing database upgrades in place.

| Command | What it does |
|---|---|
| `npm run db:reset` | Drops every table in `DATABASE_URL`, migrates, and loads the demo data. Refuses with `NODE_ENV=production`, or when the database holds anyone other than the demo users |
| `npm run db:migrate` | Applies new migrations only |
| `npm run admin:create -- --email … --name "…"` | Creates the first admin on an empty database, or makes an existing person an admin with a new password ([Going live](docs/deployment.md)) |
| `npm test` | API, import and unit tests against `TEST_DATABASE_URL` (default `fctime_test`, which is wiped) |
| `npm run verify:ui` | Walks through the whole flow in Chromium, including a Paymo import against a stand-in Paymo server, and saves screenshots to `verify-output/` (needs Playwright; see below) |

To run the browser check on your machine, install Playwright once:

```bash
npm i -D playwright && npx playwright install chromium
```

### MySQL notes

- `DATABASE_URL` looks like `mysql://user:password@host:3306/fctime`.
- Times are stored in UTC. The app sets each connection to UTC and does the workspace time zone math itself, so MySQL’s time zone tables aren’t needed.
- There are no triggers, stored procedures or events, so the app’s database user needs only ordinary table privileges. That works with binary logging on and on managed MySQL services.
- A web Paymo import keeps a copy of the fetched data or uploaded file until you import or discard it. One web import takes up to 50,000 entries (about 6 MB stored), well within MySQL 8’s default `max_allowed_packet` of 64 MB. The command-line import has no limit and stores no copy.

### Admin login from `.env`

To sign in as an admin without the demo people, add a password of at least 12 characters to `.env`:

```
ADMIN_PASSWORD=choose-a-long-password
```

Each time the server starts, it makes sure there's an admin with the username `admin` and that password. Type `admin` in the Email or username box to sign in. To change the password, edit `.env` and restart; that also signs out the old sessions. While `ADMIN_PASSWORD` is set, the app won't archive this account, change its role or give it another password. Remove the line to manage it in Settings like anyone else.

## Demo sign-in

Every demo user’s password is `fifthcolor-demo` (set `DEMO_PASSWORD` in `.env` before seeding to change it). Demo data is for development only: with `NODE_ENV=production` the seed refuses to run. People, clients and tasks come from the wireframe’s sample data, with dates moved to the current weeks.

| Person | Email | Role | Why sign in as them |
|---|---|---|---|
| Morgan Hale | morgan@fifthcolor.example | Admin; Strategy manager | Settings, the Paymo import, every approval, hours requests, every report |
| Alex Rivera | alex@fifthcolor.example | Manager | Account owner of Northwind Coffee and Pine & Co.: step-1 approvals; adds tasks |
| Sam Patel | sam@fifthcolor.example | Manager | Account owner of Harbor Health |
| Jamie Chen | jamie@fifthcolor.example | Team Member, Creative | Creative and Video manager: step-2 approvals |
| Casey Diaz | casey@fifthcolor.example | Team Member, Creative | Logs time; 24 h week |
| Riley Brooks | riley@fifthcolor.example | Team Member, Development | Development manager |
| Taylor Kim | taylor@fifthcolor.example | Team Member, Strategy | Logs time |
| Chris Ortega | chris@fifthcolor.example | Team Member, Media | Media manager |

**A quick tour:** sign in as Casey, start a timer from Home, refresh the page, then stop it from the sidebar. Drag on the Timesheets calendar to add time (the form warns if it overlaps), then submit the week. Sign in as Alex: the bell shows the submission; approve it or send it back from Timesheets → Timesheet approvals. Then sign in as Jamie for the second step. Sign in as Morgan to see Time Reports, download the CSV, and try Settings → Import from Paymo.

## Importing from Paymo

Settings → **Import from Paymo** (admins only). Nothing is saved until you’ve reviewed a preview.

1. **Bring the data in**, one of two ways:
   - **API key** (recommended): in Paymo, open My Account and create an API key, paste it, and choose the dates to bring over. The key is used for that fetch only and is never stored. The server must be able to reach `app.paymoapp.com`.
   - **CSV export**: export time entries from a Paymo report, one row per entry, and upload the file. Columns are matched by name (date, person or user, email, client, project, task list, task, description, start and end time, duration, billable). You can fix the mapping and the date format on the preview.
   - One web import takes up to 50,000 entries, about a year and a half for 30 people. Bring longer histories over a year at a time, or use the command line below.
2. **Review the preview:**
   - **People** are matched by Paymo id, then email, then name. For each person you can match them to someone else, add them as a new Team Member, or skip their time.
   - **Task lists** map to service lines using the keywords on each service line (Settings → Service lines).
   - Choose whether old time arrives **approved** (the default, which keeps history out of approval queues) or **not submitted**.
   - The preview also shows warnings: running Paymo timers, entries with no duration, and unreadable rows.
3. **Import.** It runs in one transaction. Records already in the app are matched and left alone, and only new ones are added, so you can import again later (for example a final top-up at cutover) without duplicates. That holds across the two ways in, too: time that came from a CSV is recognized when the API brings it again (by person, task, date and length), and the other way round.

The same import runs from a terminal, which suits a large first migration. It previews by default and writes only with `--commit`. The key comes from an environment variable, so it never lands in your shell history or the app:

```bash
PAYMO_API_KEY=your-key npm run import:paymo -- --from 2026-01-01 --to 2026-11-30 --as you@fifthcolor.com
```

Add `--commit` to import. Use `--csv file.csv` instead of a key for a CSV export. The other options are `--status draft`, `--extra-hours 4`, `--default-service Creative` and `--date-format dmy`.

After an import:
- Set account owners for new clients.
- Set roles, departments and passwords for new people. Imported people can’t sign in until an admin sets a password.
- New tasks with no budget in Paymo get the imported time as their budget, so they start locked. You can add extra hours for open tasks on the preview.

## Project layout

```
server/            Express app, auth, business rules (domain.js), notifications (notify.js),
                   routes/, import/ (Paymo API client, CSV parser, importer), demo seed
db/migrations/     SQL schema, applied in order
public/            index.html, css/fc.css (from the wireframe) + app.css, js/ (views, store, shared time helpers)
test/              node:test API flow, import and unit tests
scripts/           migrate, seed, verify-ui (Playwright walk-through)
docs/              requirements map, backlog, verification
```

## Notes

- In the CSV export, the `minutes` column is exact. The `hours` column is rounded per row, so its total can differ from the report by a hundredth; use minutes when reconciling.
- `PAYMO_BASE_URL` overrides the Paymo API address. The tests use it to point at a stand-in server.
