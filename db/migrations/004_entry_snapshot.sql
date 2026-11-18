-- Each entry keeps its own service line (which decides the department manager) and billable flag.
-- They follow the task while the entry can still be edited, and freeze when it's submitted, so later
-- task edits can't move submitted time to another approver or change approved billable totals.
ALTER TABLE time_entries ADD COLUMN service_line_id uuid REFERENCES service_lines(id);
ALTER TABLE time_entries ADD COLUMN billable boolean;
UPDATE time_entries e SET service_line_id = t.service_line_id, billable = t.billable FROM tasks t WHERE t.id = e.task_id;
ALTER TABLE time_entries ALTER COLUMN service_line_id SET NOT NULL, ALTER COLUMN billable SET NOT NULL;
CREATE INDEX time_entries_service_line_idx ON time_entries (service_line_id);

CREATE FUNCTION time_entry_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.status IN ('draft', 'rejected')
     OR (NEW.status = 'submitted' AND OLD.status IN ('draft', 'rejected')) THEN
    SELECT t.service_line_id, t.billable INTO NEW.service_line_id, NEW.billable FROM tasks t WHERE t.id = NEW.task_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER time_entry_snapshot BEFORE INSERT OR UPDATE ON time_entries
  FOR EACH ROW EXECUTE FUNCTION time_entry_snapshot();

CREATE FUNCTION task_snapshot_drafts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.service_line_id IS DISTINCT FROM OLD.service_line_id OR NEW.billable IS DISTINCT FROM OLD.billable THEN
    UPDATE time_entries SET service_line_id = NEW.service_line_id, billable = NEW.billable
     WHERE task_id = NEW.id AND status IN ('draft', 'rejected');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_snapshot_drafts AFTER UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION task_snapshot_drafts();

-- One pending request for more hours per person and task, even when two arrive at once.
CREATE UNIQUE INDEX hours_requests_one_pending ON hours_requests (task_id, requested_by) WHERE status = 'pending';
