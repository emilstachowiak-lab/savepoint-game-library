-- The private collection uses a stable game ID for edits and imports.
-- created_at stores the game's collection timestamp in milliseconds.
-- updated_at is maintained by the database when the row changes.
-- A prefix index keeps the platform index compact for multi-platform entries.
CREATE TABLE IF NOT EXISTS games (
    id CHAR(36) NOT NULL,
    title VARCHAR(255) NOT NULL,
    platform VARCHAR(400) NOT NULL,
    edition VARCHAR(50) NOT NULL DEFAULT 'Fizyczne',
    cover_url TEXT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'Do ogrania',
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_games_platform (platform(100)),
    KEY idx_games_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Each scope and hashed identifier has one row for the active rate-limit window.
-- blocked_until and last_attempt_at support cooldown checks and cleanup.
CREATE TABLE IF NOT EXISTS login_throttle (
    scope VARCHAR(24) NOT NULL,
    bucket_hash CHAR(64) NOT NULL,
    failed_attempts INT UNSIGNED NOT NULL DEFAULT 0,
    window_started_at BIGINT UNSIGNED NOT NULL,
    blocked_until BIGINT UNSIGNED NOT NULL DEFAULT 0,
    last_attempt_at BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (scope, bucket_hash),
    KEY idx_login_throttle_last_attempt (last_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
