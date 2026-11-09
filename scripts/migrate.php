<?php
declare(strict_types=1);

// Database administration is a deployment operation, never an HTTP endpoint.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

if ($argc !== 2) {
    fwrite(STDERR, "Użycie: php scripts/migrate.php /ścieżka/do/config.local.php\n");
    exit(1);
}

try {
    // Read only the database settings from the supplied private config so a
    // separate account can perform schema changes.
    $configPath = $argv[1];
    if (!is_file($configPath) || !is_readable($configPath)) {
        throw new RuntimeException('Configuration unavailable.');
    }
    $config = require $configPath;
    if (!is_array($config)) {
        throw new RuntimeException('Invalid configuration.');
    }
    foreach (['host', 'database', 'username', 'password'] as $key) {
        if (!isset($config[$key]) || !is_string($config[$key]) || $config[$key] === '') {
            throw new RuntimeException('Incomplete configuration.');
        }
    }
    $dsn = sprintf(
        'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
        $config['host'],
        (int)($config['port'] ?? 3306),
        $config['database']
    );
    $db = new PDO($dsn, $config['username'], $config['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);

    // Create missing tables from the bundled schema without replacing existing
    // collection data. The file contains simple semicolon-delimited statements.
    $schema = file_get_contents(dirname(__DIR__) . '/api/schema.sql');
    if ($schema === false) {
        throw new RuntimeException('Schema unavailable.');
    }
    foreach (explode(';', $schema) as $statement) {
        $statement = trim($statement);
        if ($statement !== '') {
            $db->exec($statement);
        }
    }

    // Inspect older installations that may still use a shorter platform
    // column or a full-width index. Reruns skip an already upgraded schema.
    $platformLength = $db->query("SELECT CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'games' AND COLUMN_NAME = 'platform'")->fetchColumn();
    if ($platformLength === false) {
        throw new RuntimeException('Expected column unavailable.');
    }
    $indexPrefix = $db->query("SELECT SUB_PART FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'games' AND INDEX_NAME = 'idx_games_platform' AND SEQ_IN_INDEX = 1")->fetchColumn();
    $changeColumn = (int)$platformLength < 400;
    $changeIndex = $indexPrefix === false || $indexPrefix === null || (int)$indexPrefix !== 100;
    if ($changeColumn || $changeIndex) {
        // Change the column and rebuild its prefix index in one ALTER TABLE.
        $changes = [];
        if ($indexPrefix !== false) {
            $changes[] = 'DROP INDEX idx_games_platform';
        }
        if ($changeColumn) {
            $changes[] = 'MODIFY platform VARCHAR(400) NOT NULL';
        }
        $changes[] = 'ADD INDEX idx_games_platform (platform(100))';
        $db->exec('ALTER TABLE games ' . implode(', ', $changes));
    }

    fwrite(STDOUT, "Schemat bazy danych jest aktualny.\n");
} catch (Throwable $error) {
    // Avoid exposing credentials, connection strings or database identifiers.
    fwrite(STDERR, "Migracja nie powiodła się. Sprawdź konfigurację, uprawnienia użytkownika bazy i wersję PHP.\n");
    exit(1);
}
