-- Paymo import: staged runs with a preview, and the keys that make re-imports skip what's already here.
ALTER TABLE users ADD COLUMN paymo_user_id bigint UNIQUE;
-- Comma-separated words that map Paymo task lists to this service line (wireframe settings.paymo.keywords).
ALTER TABLE service_lines ADD COLUMN match_keywords text NOT NULL DEFAULT '';
-- CSV rows have no Paymo id; a stable hash of the row keeps re-imports from duplicating them.
ALTER TABLE time_entries ADD COLUMN import_key text UNIQUE;

CREATE TABLE import_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL CHECK (source IN ('paymo-api', 'paymo-csv')),
  status       text NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'imported', 'discarded')),
  label        text NOT NULL DEFAULT '',
  options      jsonb NOT NULL DEFAULT '{}',
  raw          jsonb NOT NULL,          -- what Paymo returned, or the CSV rows
  summary      jsonb,                   -- counts once imported
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  imported_at  timestamptz
);
