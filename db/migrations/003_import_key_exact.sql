-- CSV entry keys are compared exactly: under the default collation “ab12” and “AB12” were the same
-- key, so the second row was silently left out of an import.
ALTER TABLE time_entries MODIFY import_key VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL;
