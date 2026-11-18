-- FifthColor Time: first milestone schema.
-- Durations are whole minutes. Dates (entry_date, due_date) are calendar dates in the
-- workspace time zone (settings.time_zone). Instants (timers, audit) are timestamptz.

CREATE TABLE settings (
  id                int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  time_zone         text NOT NULL DEFAULT 'America/Chicago',
  rounding_minutes  int  NOT NULL DEFAULT 0 CHECK (rounding_minutes IN (0, 6, 15)),
  budget_alert_pct  int  NOT NULL DEFAULT 80 CHECK (budget_alert_pct BETWEEN 10 AND 100),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid
);
INSERT INTO settings (id) VALUES (1);

CREATE TABLE service_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  color       text NOT NULL DEFAULT '#868E96',
  rate        numeric(10,2) NOT NULL DEFAULT 0 CHECK (rate >= 0),
  manager_id  uuid,                      -- department manager: second approval. NULL = admins approve.
  sort        int NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX service_lines_name_key ON service_lines (lower(name));

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  email         text NOT NULL,
  password_hash text,
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'ae', 'acct', 'member')),
  dept_id       uuid REFERENCES service_lines(id),
  -- minutes of capacity per weekday, Monday first
  capacity      int[] NOT NULL DEFAULT '{480,480,480,480,480,0,0}',
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
ALTER TABLE service_lines ADD CONSTRAINT service_lines_manager_fk FOREIGN KEY (manager_id) REFERENCES users(id);
ALTER TABLE settings ADD CONSTRAINT settings_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users(id);

CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE clients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  owner_id        uuid REFERENCES users(id),   -- account owner: first approval. NULL = admins approve.
  color           text NOT NULL DEFAULT '#868E96',
  paymo_client_id bigint UNIQUE,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX clients_name_key ON clients (lower(name));

CREATE TABLE projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES clients(id),
  name             text NOT NULL,
  kind             text NOT NULL DEFAULT 'project' CHECK (kind IN ('retainer', 'project')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'waiting', 'hold', 'done')),
  paymo_project_id bigint UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX projects_client_name_key ON projects (client_id, lower(name));

CREATE TABLE tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id),
  service_line_id uuid NOT NULL REFERENCES service_lines(id),
  title           text NOT NULL,
  assignee_id     uuid REFERENCES users(id),
  status          text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'review', 'done')),
  start_date      date,
  due_date        date NOT NULL,
  budget_minutes  int NOT NULL CHECK (budget_minutes > 0),
  billable        boolean NOT NULL DEFAULT true,
  notes           text NOT NULL DEFAULT '',
  paymo_task_id   bigint UNIQUE,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (start_date IS NULL OR start_date <= due_date)
);
CREATE INDEX tasks_project_idx ON tasks (project_id);
CREATE INDEX tasks_assignee_idx ON tasks (assignee_id);

CREATE TABLE hours_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES tasks(id),
  requested_by  uuid NOT NULL REFERENCES users(id),
  minutes       int NOT NULL CHECK (minutes > 0),
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hours_requests_status_idx ON hours_requests (status);

-- every change to a task's time budget after creation
CREATE TABLE task_budget_log (
  id          bigserial PRIMARY KEY,
  task_id     uuid NOT NULL REFERENCES tasks(id),
  minutes     int NOT NULL,
  reason      text NOT NULL,
  actor_id    uuid NOT NULL REFERENCES users(id),
  request_id  uuid REFERENCES hours_requests(id),
  at          timestamptz NOT NULL DEFAULT now()
);

-- one running timer per person
CREATE TABLE timers (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL UNIQUE REFERENCES users(id),
  task_id     uuid NOT NULL REFERENCES tasks(id),
  started_at  timestamptz NOT NULL DEFAULT now(),
  note        text NOT NULL DEFAULT ''
);

CREATE TABLE time_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  task_id          uuid NOT NULL REFERENCES tasks(id),
  entry_date       date NOT NULL,
  start_time       time,
  end_time         time,
  minutes          int NOT NULL CHECK (minutes BETWEEN 1 AND 1440),
  note             text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'submitted', 'ae-approved', 'approved', 'rejected')),
  source           text NOT NULL DEFAULT 'manual' CHECK (source IN ('timer', 'manual', 'import')),
  source_timer_id  uuid UNIQUE,          -- a stopped timer creates exactly one entry
  paymo_entry_id   bigint UNIQUE,
  submitted_at     timestamptz,
  ae_by            uuid REFERENCES users(id),
  ae_at            timestamptz,
  dept_by          uuid REFERENCES users(id),
  dept_at          timestamptz,
  rejected_by      uuid REFERENCES users(id),
  rejected_at      timestamptz,
  rejected_reason  text,
  rejected_step    text CHECK (rejected_step IN ('ae', 'dept')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((start_time IS NULL) = (end_time IS NULL))
);
CREATE INDEX time_entries_user_date_idx ON time_entries (user_id, entry_date);
CREATE INDEX time_entries_task_idx ON time_entries (task_id);
CREATE INDEX time_entries_status_idx ON time_entries (status);
CREATE INDEX time_entries_date_idx ON time_entries (entry_date);

-- audit trail for entries; no FK so history survives deletes
CREATE TABLE time_entry_events (
  id        bigserial PRIMARY KEY,
  entry_id  uuid NOT NULL,
  action    text NOT NULL,   -- created, updated, deleted, submitted, approved, returned
  step      text,            -- ae | dept for approvals and returns
  actor_id  uuid NOT NULL REFERENCES users(id),
  at        timestamptz NOT NULL DEFAULT now(),
  reason    text,
  detail    jsonb
);
CREATE INDEX time_entry_events_entry_idx ON time_entry_events (entry_id);
