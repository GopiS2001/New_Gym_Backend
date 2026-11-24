-- Count wrong entries of 6-digit email codes.
ALTER TABLE `one_time_tokens` ADD COLUMN `attempts` INTEGER NOT NULL DEFAULT 0;
