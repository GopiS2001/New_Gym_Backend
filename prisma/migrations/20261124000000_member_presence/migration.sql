-- Member presence (online/offline) and admin force logout.
ALTER TABLE `users`
    ADD COLUMN `last_seen_at` DATETIME(3) NULL,
    ADD COLUMN `app_in_background` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `sessions_revoked_at` DATETIME(3) NULL;

CREATE INDEX `users_last_seen_at_idx` ON `users`(`last_seen_at`);
