# Backlog: wireframe features after the first milestone

Each line names the wireframe function(s) to trace when the work starts. The schema already has `paymo_client_id`, `paymo_project_id`, `paymo_task_id` and `paymo_entry_id` columns, so imports can be re-run without creating duplicates.

## Needs an implementation decision first (simulated in the wireframe)

| Feature | What the wireframe shows | Decision needed |
|---|---|---|
| **Paymo sync** | Settings → Integrations: connect with an API key, webhook plus nightly reconcile at 02:00, map tasks to service lines by task-list keywords, a queue of new Paymo projects to accept, an unmatched-time review, a lock after 5 days. The connection test only fakes a `GET /api/me` (`paymo-test` action, `paymoProjectOptions` 2167, `settings.paymo` in `seed`). | One-time migration or ongoing two-way sync? If ongoing, which system is the source of truth for tasks and time? Webhooks need a public HTTPS URL. |
| **BambooHR sync** | Pulls approved time off into scheduling and timesheets (`bambooSync` 4427, Settings → Integrations). Marked “Connected (simulated)”. | Whether to adopt it, who owns the API key (`BAMBOOHR_API_KEY`), and how people are matched (by email). |
| **Email delivery** (scheduled report emails, “Send test”) | `viewEmails` (5367), `emailDialog` (5387); the test send is simulated. | Provider (Postmark, SES, Google Workspace SMTP), sender domain, unsubscribe and bounce handling. |
| **Contract reader (Claude)** | Reads contract PDFs to prefill retainers (`readPdf`, `buildPrompt`, `normalize`); has a simulated sample result. | Whether to send contracts to the Claude API, data retention, and the model (the wireframe offers Sonnet 5.5, Opus 5.5 and Haiku 5.5). |

## Product features

**Retainer accounting**
- Monthly hours per service line, borrowing from future months, converting hours between service lines at rate ratios, overage alerts, quote opportunities (`compute`, `overs`, `quotes`, `retainerPanelBase` 1965, `retainerHours`, `retainerLog`).
- Borrow and convert requests with client approval evidence, and admin approval (`viewRequests`, `requestEffect`, `approveRequest` 4269). Today’s Hours requests tab covers only the task-time case.
- Contract terms: start, term, invoicing frequency, timing, net days, late fee, renewal (`stepContract`, `contractFields`, `defaultTerms`).

**Hourly projects and billing**
- Budgets per service line, budget alerts, milestones and percent billing (`hourly`, `hourlyPanelBase`, `hstats`).
- Invoices built from contracts and usage, marking months billed, yearly billing and forecasts (`buildInvoices`, `viewBilling` 4942, `viewBillingYear`, `forecastInvoices`, `confirmBilledDialog`).
- Charge-backs and expenses with markup and receipts (`chargebackSection`, `cbDialog`, `viewExpenses` 4998, `expCsv`).

**Estimates and proposals**
- Estimate cost calculator with line groups, freelance and pass-through costs, target margin, and rate suggestions; convert an estimate to a project (`viewEstimates` 4552, `viewEstimate`, `estRollup`, `estCost`, `doConvert`).
- Proposals from templates, with a client-facing view, acceptance and PDF (`viewProposals` 3401, `viewProposal`, `viewProposalClient`, `propPdf`, `seedTemplates`).

**Team scheduling and utilization**
- Bookings, capacity, time off, a two-week task view, forecasting and risk (`viewSchedule` 4872/4908, `viewScheduleTasks`, `viewForecast` 4922, `riskModel`, `bookDialog`, `offDialog`, `capDialog`).
- Utilization against each person’s target, plus a Home utilization tile (`viewUtil` 5326, `personUtil`, `targetUtil`). Capacity per weekday is already stored and editable.
- Hourly cost per person and margin, shown to admins only (`deptCost`, `projMargin`, `marginCard`).

**Imports**
- **Historical CSV import** of monthly hours with a preview, plus backfill from a set month (`viewImport` 2368, `parseCSV`, `buildImport`, `importPreview`, `paymo.backfill`).
- A one-time Paymo data import into the current schema; see “Paymo data” in the README.

**Tasks and collaboration**
- Informed followers, checklists, subtasks, files, comments with @mentions, recurring tasks, priority flags (`taskDialog` 5199, `postComment`, `mentionsIn`, `RECUR`, `PRIO`).
- Custom board columns per project and drag between columns (`colsDialog`, `readCols`, board drag handlers).
- Notifications bell, preferences and due/budget alerts (`notify`, `runChecks`, `bell`, `bellPanel`, `prefsDialog`). Approval routing works today without notifications; reviewers see counts on the Timesheets nav item.
- Favorite Home filters, sidebar shortcuts, client timeline (`favMenu`, `shortcutDialog`, `viewClientTimeline`), project notes and meetings (`projectNotes`, `meetingDialog`).

**Reports**
- Saved reports, PDF export, value/cost/margin columns, an archived-people toggle, grouped CSV (`rbPdf`, `rbCsv` grouped mode, `state.reports`).

**Platform**
- Theme switch (light, dark, high contrast); the tokens are already in `fc.css`, and the app follows the system setting.
- SSO (Google Workspace), password reset by email, a production deployment (managed Postgres, HTTPS with `COOKIE_SECURE=1`).
