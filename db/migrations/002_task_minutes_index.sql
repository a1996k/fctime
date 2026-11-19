-- Logged time per task is summed on every page load. Including minutes in the task index lets
-- MySQL add it up from the index alone, without reading every entry row (five years of history:
-- about 300 ms down to 60 ms). The new index also serves the task foreign key, so the old one goes.
ALTER TABLE time_entries ADD INDEX time_entries_task_minutes_idx (task_id, minutes);
ALTER TABLE time_entries DROP INDEX time_entries_task_idx;
