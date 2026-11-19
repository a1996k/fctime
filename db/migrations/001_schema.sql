-- FifthColor Time schema for MySQL 8.0 or newer (InnoDB, utf8mb4).
-- Durations are whole minutes. entry_date and due_date are calendar dates in the workspace time zone
-- (settings.time_zone). Instants are DATETIME(6) in UTC; the app works in UTC on every connection.
-- Ids are UUIDs in CHAR(36). Text comparisons use the default case-insensitive collation, so unique
-- names and emails ignore case. No triggers or stored routines: the app user needs only ordinary
-- privileges on its own database (SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES).

CREATE TABLE settings (
  id                TINYINT     NOT NULL DEFAULT 1 PRIMARY KEY,
  time_zone         VARCHAR(64) NOT NULL DEFAULT 'America/Chicago',
  rounding_minutes  INT         NOT NULL DEFAULT 0,
  budget_alert_pct  INT         NOT NULL DEFAULT 80,
  updated_at        DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_by        CHAR(36)    NULL,
  CONSTRAINT settings_one_row CHECK (id = 1),
  CONSTRAINT settings_rounding CHECK (rounding_minutes IN (0, 6, 15)),
  CONSTRAINT settings_alert CHECK (budget_alert_pct BETWEEN 10 AND 100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO settings (id) VALUES (1);

CREATE TABLE service_lines (
  id              CHAR(36)      NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  name            VARCHAR(80)   NOT NULL,
  color           VARCHAR(16)   NOT NULL DEFAULT '#868E96',
  rate            DECIMAL(10,2) NOT NULL DEFAULT 0,
  manager_id      CHAR(36)      NULL,         -- department manager: second approval. NULL = admins approve.
  sort            INT           NOT NULL DEFAULT 0,
  match_keywords  VARCHAR(300)  NOT NULL DEFAULT '',   -- maps Paymo task lists to this service line on import
  archived_at     DATETIME(6)   NULL,
  created_at      DATETIME(6)   NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  UNIQUE KEY service_lines_name_key (name),
  CONSTRAINT service_lines_rate CHECK (rate >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE users (
  id             CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  name           VARCHAR(200) NOT NULL,
  email          VARCHAR(255) NOT NULL,
  password_hash  VARCHAR(255) NULL,
  role           VARCHAR(16)  NOT NULL DEFAULT 'member',
  dept_id        CHAR(36)     NULL,
  capacity       JSON         NOT NULL DEFAULT (JSON_ARRAY(480, 480, 480, 480, 480, 0, 0)),  -- minutes per weekday, Monday first
  paymo_user_id  BIGINT       NULL,
  archived_at    DATETIME(6)  NULL,
  created_at     DATETIME(6)  NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  UNIQUE KEY users_email_key (email),
  UNIQUE KEY users_paymo_key (paymo_user_id),
  CONSTRAINT users_role CHECK (role IN ('admin', 'ae', 'acct', 'member')),
  CONSTRAINT users_dept_fk FOREIGN KEY (dept_id) REFERENCES service_lines (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
ALTER TABLE service_lines ADD CONSTRAINT service_lines_manager_fk FOREIGN KEY (manager_id) REFERENCES users (id);
ALTER TABLE settings ADD CONSTRAINT settings_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users (id);

CREATE TABLE sessions (
  token_hash  CHAR(64)    NOT NULL PRIMARY KEY,
  user_id     CHAR(36)    NOT NULL,
  created_at  DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  expires_at  DATETIME(6) NOT NULL,
  KEY sessions_user_idx (user_id),
  CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE clients (
  id               CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  name             VARCHAR(200) NOT NULL,
  owner_id         CHAR(36)     NULL,    -- account owner: first approval. NULL = admins approve.
  color            VARCHAR(16)  NOT NULL DEFAULT '#868E96',
  paymo_client_id  BIGINT       NULL,
  archived_at      DATETIME(6)  NULL,
  created_at       DATETIME(6)  NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  UNIQUE KEY clients_name_key (name),
  UNIQUE KEY clients_paymo_key (paymo_client_id),
  CONSTRAINT clients_owner_fk FOREIGN KEY (owner_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE projects (
  id                CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  client_id         CHAR(36)     NOT NULL,
  name              VARCHAR(200) NOT NULL,
  kind              VARCHAR(16)  NOT NULL DEFAULT 'project',
  status            VARCHAR(16)  NOT NULL DEFAULT 'active',
  paymo_project_id  BIGINT       NULL,
  created_at        DATETIME(6)  NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  UNIQUE KEY projects_client_name_key (client_id, name),
  UNIQUE KEY projects_paymo_key (paymo_project_id),
  CONSTRAINT projects_kind CHECK (kind IN ('retainer', 'project')),
  CONSTRAINT projects_status CHECK (status IN ('active', 'waiting', 'hold', 'done')),
  CONSTRAINT projects_client_fk FOREIGN KEY (client_id) REFERENCES clients (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE tasks (
  id               CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  project_id       CHAR(36)     NOT NULL,
  service_line_id  CHAR(36)     NOT NULL,
  title            VARCHAR(255) NOT NULL,
  assignee_id      CHAR(36)     NULL,
  status           VARCHAR(16)  NOT NULL DEFAULT 'todo',
  start_date       DATE         NULL,
  due_date         DATE         NOT NULL,
  budget_minutes   INT          NOT NULL,
  billable         TINYINT(1)   NOT NULL DEFAULT 1,
  notes            TEXT         NOT NULL DEFAULT (''),
  paymo_task_id    BIGINT       NULL,
  created_by       CHAR(36)     NULL,
  created_at       DATETIME(6)  NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at       DATETIME(6)  NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  KEY tasks_project_idx (project_id),
  KEY tasks_assignee_idx (assignee_id),
  UNIQUE KEY tasks_paymo_key (paymo_task_id),
  CONSTRAINT tasks_status CHECK (status IN ('todo', 'doing', 'review', 'done')),
  CONSTRAINT tasks_budget CHECK (budget_minutes > 0),
  CONSTRAINT tasks_dates CHECK (start_date IS NULL OR start_date <= due_date),
  CONSTRAINT tasks_project_fk FOREIGN KEY (project_id) REFERENCES projects (id),
  CONSTRAINT tasks_service_line_fk FOREIGN KEY (service_line_id) REFERENCES service_lines (id),
  CONSTRAINT tasks_assignee_fk FOREIGN KEY (assignee_id) REFERENCES users (id),
  CONSTRAINT tasks_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE hours_requests (
  id             CHAR(36)    NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  task_id        CHAR(36)    NOT NULL,
  requested_by   CHAR(36)    NOT NULL,
  minutes        INT         NOT NULL,
  reason         TEXT        NOT NULL,
  status         VARCHAR(16) NOT NULL DEFAULT 'pending',
  decided_by     CHAR(36)    NULL,
  decided_at     DATETIME(6) NULL,
  decision_note  TEXT        NULL,
  created_at     DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  -- one pending request per person and task, even when two arrive at once
  pending_key    VARCHAR(80) GENERATED ALWAYS AS (IF(status = 'pending', CONCAT(task_id, ':', requested_by), NULL)) STORED,
  UNIQUE KEY hours_requests_one_pending (pending_key),
  KEY hours_requests_status_idx (status),
  CONSTRAINT hours_requests_minutes CHECK (minutes > 0),
  CONSTRAINT hours_requests_status CHECK (status IN ('pending', 'approved', 'declined')),
  CONSTRAINT hours_requests_task_fk FOREIGN KEY (task_id) REFERENCES tasks (id),
  CONSTRAINT hours_requests_requested_by_fk FOREIGN KEY (requested_by) REFERENCES users (id),
  CONSTRAINT hours_requests_decided_by_fk FOREIGN KEY (decided_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- every change to a task's time budget after creation
CREATE TABLE task_budget_log (
  id          BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  task_id     CHAR(36)    NOT NULL,
  minutes     INT         NOT NULL,
  reason      TEXT        NOT NULL,
  actor_id    CHAR(36)    NOT NULL,
  request_id  CHAR(36)    NULL,
  at          DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  KEY task_budget_log_task_idx (task_id),
  CONSTRAINT task_budget_log_task_fk FOREIGN KEY (task_id) REFERENCES tasks (id),
  CONSTRAINT task_budget_log_actor_fk FOREIGN KEY (actor_id) REFERENCES users (id),
  CONSTRAINT task_budget_log_request_fk FOREIGN KEY (request_id) REFERENCES hours_requests (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- one running timer per person
CREATE TABLE timers (
  id          CHAR(36)    NOT NULL PRIMARY KEY,
  user_id     CHAR(36)    NOT NULL,
  task_id     CHAR(36)    NOT NULL,
  started_at  DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  note        TEXT        NOT NULL DEFAULT (''),
  UNIQUE KEY timers_user_key (user_id),
  CONSTRAINT timers_user_fk FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT timers_task_fk FOREIGN KEY (task_id) REFERENCES tasks (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE time_entries (
  id               CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  user_id          CHAR(36)     NOT NULL,
  task_id          CHAR(36)     NOT NULL,
  entry_date       DATE         NOT NULL,
  start_time       TIME         NULL,
  end_time         TIME         NULL,
  minutes          INT          NOT NULL,
  note             TEXT         NOT NULL DEFAULT (''),
  status           VARCHAR(16)  NOT NULL DEFAULT 'draft',
  source           VARCHAR(16)  NOT NULL DEFAULT 'manual',
  -- Copied from the task while the entry is a draft or sent back, and when it's submitted; then frozen.
  -- The service line decides the department manager, so task edits can't move submitted time or change
  -- approved billable totals. The app maintains these (no triggers, so no special privileges are needed).
  service_line_id  CHAR(36)     NOT NULL,
  billable         TINYINT(1)   NOT NULL,
  source_timer_id  CHAR(36)     NULL,    -- a stopped timer creates exactly one entry
  paymo_entry_id   BIGINT       NULL,
  import_key       VARCHAR(100) NULL,    -- de-duplicates CSV imports, which have no Paymo id
  submitted_at     DATETIME(6)  NULL,
  ae_by            CHAR(36)     NULL,
  ae_at            DATETIME(6)  NULL,
  dept_by          CHAR(36)     NULL,
  dept_at          DATETIME(6)  NULL,
  rejected_by      CHAR(36)     NULL,
  rejected_at      DATETIME(6)  NULL,
  rejected_reason  TEXT         NULL,
  rejected_step    VARCHAR(8)   NULL,
  created_at       DATETIME(6)  NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at       DATETIME(6)  NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  UNIQUE KEY time_entries_timer_key (source_timer_id),
  UNIQUE KEY time_entries_paymo_key (paymo_entry_id),
  UNIQUE KEY time_entries_import_key (import_key),
  KEY time_entries_user_date_idx (user_id, entry_date),
  KEY time_entries_task_idx (task_id),
  KEY time_entries_status_idx (status),
  KEY time_entries_date_idx (entry_date),
  KEY time_entries_service_line_idx (service_line_id),
  CONSTRAINT time_entries_minutes CHECK (minutes BETWEEN 1 AND 1440),
  CONSTRAINT time_entries_status CHECK (status IN ('draft', 'submitted', 'ae-approved', 'approved', 'rejected')),
  CONSTRAINT time_entries_source CHECK (source IN ('timer', 'manual', 'import')),
  CONSTRAINT time_entries_step CHECK (rejected_step IS NULL OR rejected_step IN ('ae', 'dept')),
  CONSTRAINT time_entries_times CHECK ((start_time IS NULL) = (end_time IS NULL)),
  CONSTRAINT time_entries_user_fk FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT time_entries_task_fk FOREIGN KEY (task_id) REFERENCES tasks (id),
  CONSTRAINT time_entries_service_line_fk FOREIGN KEY (service_line_id) REFERENCES service_lines (id),
  CONSTRAINT time_entries_ae_fk FOREIGN KEY (ae_by) REFERENCES users (id),
  CONSTRAINT time_entries_dept_fk FOREIGN KEY (dept_by) REFERENCES users (id),
  CONSTRAINT time_entries_rejected_fk FOREIGN KEY (rejected_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- audit trail for entries; no foreign key on entry_id so history survives deletes
CREATE TABLE time_entry_events (
  id        BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  entry_id  CHAR(36)    NOT NULL,
  action    VARCHAR(20) NOT NULL,   -- created, updated, deleted, submitted, approved, returned, imported
  step      VARCHAR(8)  NULL,       -- ae | dept for approvals and returns
  actor_id  CHAR(36)    NOT NULL,
  at        DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  reason    TEXT        NULL,
  detail    JSON        NULL,
  KEY time_entry_events_entry_idx (entry_id),
  CONSTRAINT time_entry_events_actor_fk FOREIGN KEY (actor_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- in-app notifications (wireframe notify(), bell())
CREATE TABLE notifications (
  id          BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id     CHAR(36)     NOT NULL,
  type        VARCHAR(16)  NOT NULL,
  title       VARCHAR(500) NOT NULL,
  body        TEXT         NOT NULL DEFAULT (''),
  link        VARCHAR(500) NULL,     -- an app route such as #/time/approvals
  dedupe_key  VARCHAR(200) NULL,     -- reminders and alerts fire once per key
  read_at     DATETIME(6)  NULL,
  created_at  DATETIME(6)  NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  UNIQUE KEY notifications_dedupe_key (user_id, dedupe_key),
  KEY notifications_user_idx (user_id, created_at),
  CONSTRAINT notifications_type CHECK (type IN ('time', 'hours', 'assigned', 'due', 'budget')),
  CONSTRAINT notifications_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Paymo imports, staged with a preview before anything is written
CREATE TABLE import_runs (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  source       VARCHAR(16)  NOT NULL,
  status       VARCHAR(16)  NOT NULL DEFAULT 'preview',
  label        VARCHAR(300) NOT NULL DEFAULT '',
  options      JSON         NOT NULL DEFAULT (JSON_OBJECT()),
  raw          LONGTEXT     NOT NULL,    -- what Paymo returned, or the CSV rows, as JSON text (large files outgrow the JSON type)
  summary      JSON         NULL,        -- counts once imported
  created_by   CHAR(36)     NOT NULL,
  created_at   DATETIME(6)  NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  imported_at  DATETIME(6)  NULL,
  CONSTRAINT import_runs_source CHECK (source IN ('paymo-api', 'paymo-csv')),
  CONSTRAINT import_runs_status CHECK (status IN ('preview', 'imported', 'discarded')),
  CONSTRAINT import_runs_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
