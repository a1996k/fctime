-- In-app notifications (wireframe notify(), bell(), bellPanel()).
CREATE TABLE notifications (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('time', 'hours', 'assigned', 'due', 'budget')),
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  link        text,              -- an app route such as #/time/approvals
  dedupe_key  text,              -- reminders and alerts fire once per key
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
