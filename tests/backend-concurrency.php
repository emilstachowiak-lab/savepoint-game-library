<?php
declare(strict_types=1);

/**
 * Real InnoDB concurrency checks. Run ONLY in a disposable, separate test DB.
 * Requires PHP CLI 8.1+, PDO_MYSQL, pcntl, and an existing login_throttle table
 * prepared from api/schema.sql by the test runner. No DDL is performed here.
 *
 * Required environment (there are intentionally no connection defaults):
 *   TEST_DB_ISOLATED=1
 *   TEST_DB_DSN=mysql:host=mariadb;dbname=savepoint_concurrency_test;charset=utf8mb4
 *   TEST_DB_USER=<isolated test user>
 *   TEST_DB_PASSWORD=<isolated test password, explicitly empty is also accepted>
 *
 * Does not load config.local.php, dispatch API requests, access games, establish
 * sessions, hash passwords, or call Siteverify. Each fork opens its own PDO.
 * Production rate-limit functions are extracted without running API bootstrap.
 * Test-only scopes isolate all rows; cleanup deletes exact scope/bucket pairs.
 * A namespaced random_int disables unrelated probabilistic throttle cleanup.
 * Burst tests freeze the clock to avoid a slow runner crossing the 2s cooldown;
 * the lock-wait boundary tests use the real wall clock and real InnoDB locks.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

final class SandboxApiResponse extends RuntimeException
{
    public function __construct(public int $status)
    {
        parent::__construct('Captured sandbox API response.');
    }
}

function expect(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

function scopeFor(string $scope): string
{
    return $GLOBALS['testScopePrefix'] . substr(hash('sha256', $scope), 0, 6);
}

function database(): PDO
{
    $db = new PDO($GLOBALS['testDsn'], $GLOBALS['testUser'], $GLOBALS['testPassword'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_TIMEOUT => 5,
    ]);
    // Bound a failed test's lock wait; no server-global settings are changed.
    $db->exec('SET SESSION innodb_lock_wait_timeout = 5');
    return $db;
}

function registerRow(string $scope, string $bucket): void
{
    expect(strlen($scope) <= 24 && str_starts_with($scope, 'test_'), 'Invalid sandbox scope.');
    expect((bool)preg_match('/^[a-f0-9]{64}$/D', $bucket), 'Invalid sandbox bucket.');
    $GLOBALS['testRows'][$scope . ':' . $bucket] = [$scope, $bucket];
}

function seedRow(string $scope, string $bucket, int $count = 0, ?int $window = null, int $blocked = 0): void
{
    registerRow($scope, $bucket);
    $db = database();
    $statement = $db->prepare('INSERT INTO login_throttle (scope, bucket_hash, failed_attempts, window_started_at, blocked_until, last_attempt_at)
        VALUES (:scope, :bucket, :count, :window, :blocked, :last)');
    $now = $GLOBALS['testClock'] ?? time();
    $statement->execute([':scope' => $scope, ':bucket' => $bucket, ':count' => $count,
        ':window' => $window ?? $now, ':blocked' => $blocked, ':last' => $now]);
    // Never keep a parent PDO alive across pcntl_fork().
}

function row(string $scope, string $bucket): array
{
    $db = database();
    $statement = $db->prepare('SELECT failed_attempts, window_started_at, blocked_until, last_attempt_at
        FROM login_throttle WHERE scope = :scope AND bucket_hash = :bucket');
    $statement->execute([':scope' => $scope, ':bucket' => $bucket]);
    $result = $statement->fetch();
    expect(is_array($result), 'Expected sandbox throttle row is missing.');
    return $result;
}

function cleanupRows(): void
{
    if (!$GLOBALS['testRows']) return;
    $db = database();
    $delete = $db->prepare('DELETE FROM login_throttle WHERE scope = :scope AND bucket_hash = :bucket');
    foreach ($GLOBALS['testRows'] as [$scope, $bucket]) {
        $delete->execute([':scope' => $scope, ':bucket' => $bucket]);
    }
    $check = $db->prepare('SELECT COUNT(*) FROM login_throttle WHERE scope = :scope AND bucket_hash = :bucket');
    foreach ($GLOBALS['testRows'] as [$scope, $bucket]) {
        $check->execute([':scope' => $scope, ':bucket' => $bucket]);
        expect((int)$check->fetchColumn() === 0, 'Sandbox cleanup left a throttle row behind.');
    }
}

function extractFunctions(string $source, array $names): array
{
    $tokens = token_get_all($source);
    $found = [];
    $total = count($tokens);
    for ($index = 0; $index < $total; $index++) {
        if (!is_array($tokens[$index]) || $tokens[$index][0] !== T_FUNCTION) continue;
        $cursor = $index + 1;
        while ($cursor < $total && is_array($tokens[$cursor]) && $tokens[$cursor][0] === T_WHITESPACE) $cursor++;
        if (!isset($tokens[$cursor]) || !is_array($tokens[$cursor]) || $tokens[$cursor][0] !== T_STRING) continue;
        $name = $tokens[$cursor][1];
        if (!in_array($name, $names, true)) continue;
        $code = '';
        $depth = 0;
        $opened = false;
        for ($cursor = $index; $cursor < $total; $cursor++) {
            $token = $tokens[$cursor];
            $code .= is_array($token) ? $token[1] : $token;
            if ($token === '{') { $depth++; $opened = true; }
            if ($token === '}' && --$depth === 0 && $opened) break;
        }
        expect($opened && $depth === 0, 'Cannot extract production rate-limit function.');
        $found[$name] = $code;
        $index = $cursor;
    }
    expect(count($found) === count($names), 'Required production rate-limit functions are missing.');
    return $found;
}

function loadProductionHelpers(): void
{
    $source = file_get_contents(dirname(__DIR__) . '/api/games.php');
    expect(is_string($source), 'Cannot read production helper source.');
    $functions = extractFunctions($source, ['updateRateLimitBuckets', 'rateLimitDefinition',
        'recordRateLimitAttempt', 'reserveLoginRequest', 'reserveCaptchaAttempt', 'reservePasswordAttempt', 'issueCaptchaChallenge']);
    // Only the scope builder is wrapped, so real reserve* functions cannot touch
    // production scope names even if the isolated DB already contains other rows.
    $functions['rateLimitDefinition'] = preg_replace('/^function\s+rateLimitDefinition\b/',
        'function unscopedRateLimitDefinition', $functions['rateLimitDefinition'], 1);
    $sandbox = <<<'PHP'
namespace SavepointConcurrencySandbox;
use \PDO;
use \PDOException;
use \Throwable;
function time(): int { return $GLOBALS['testClock'] ?? \time(); }
function random_int(int $min, int $max): int { return $max; }
function header(string $value, bool $replace = true, int $status = 0): void {}
function respond(int $status, array $data): void { throw new \SandboxApiResponse($status); }
function rateLimitDefinition(string $scope, string $bucket, int $threshold, int $window, int $baseDelay, int $maxDelay): array {
    return unscopedRateLimitDefinition(\scopeFor($scope), $bucket, $threshold, $window, $baseDelay, $maxDelay);
}
PHP;
    eval($sandbox . "\n" . implode("\n", $functions));
}

function writeMessage($pipe, array $message): void
{
    $wire = json_encode($message, JSON_THROW_ON_ERROR) . "\n";
    while ($wire !== '') {
        $written = fwrite($pipe, $wire);
        expect(is_int($written) && $written > 0, 'Cannot write worker protocol message.');
        $wire = substr($wire, $written);
    }
    fflush($pipe);
}

function readMessage($pipe, string $type): array
{
    $line = fgets($pipe, 16384);
    expect(is_string($line), 'Worker protocol ended or timed out.');
    $message = json_decode($line, true, 32, JSON_THROW_ON_ERROR);
    expect(is_array($message) && ($message['type'] ?? '') === $type, 'Unexpected worker protocol message.');
    return $message;
}

function workers(int $count, callable $operation): array
{
    $workers = [];
    try {
        for ($index = 0; $index < $count; $index++) {
            $pair = stream_socket_pair(STREAM_PF_UNIX, STREAM_SOCK_STREAM, STREAM_IPPROTO_IP);
            expect(is_array($pair), 'Cannot create worker barrier.');
            $pid = pcntl_fork();
            if ($pid === -1) { fclose($pair[0]); fclose($pair[1]); throw new RuntimeException('Cannot fork worker.'); }
            if ($pid === 0) {
                fclose($pair[0]);
                foreach ($workers as $worker) fclose($worker['pipe']);
                $pipe = $pair[1];
                stream_set_timeout($pipe, 15);
                try {
                    $db = database();
                    writeMessage($pipe, ['type' => 'ready']);
                    readMessage($pipe, 'go');
                    writeMessage($pipe, ['type' => 'started']);
                    try {
                        $result = $operation($db, $index);
                    } catch (SandboxApiResponse $response) {
                        $result = ['allowed' => false, 'status' => $response->status];
                    }
                    writeMessage($pipe, ['type' => 'result', 'result' => $result]);
                    $db = null;
                    fclose($pipe);
                    exit(0);
                } catch (Throwable $error) {
                    // No connection strings, credentials, SQL text or DB error
                    // messages are sent to stdout or the parent protocol.
                    $driver = $error instanceof PDOException ? (int)($error->errorInfo[1] ?? 0) : 0;
                    try { writeMessage($pipe, ['type' => 'error', 'class' => get_class($error), 'driver' => $driver]); } catch (Throwable) {}
                    fclose($pipe);
                    exit(1);
                }
            }
            fclose($pair[1]);
            stream_set_timeout($pair[0], 15);
            $workers[] = ['pid' => $pid, 'pipe' => $pair[0]];
        }
        foreach ($workers as $worker) readMessage($worker['pipe'], 'ready');
        return $workers;
    } catch (Throwable $error) {
        stopWorkers($workers);
        throw $error;
    }
}

function stopWorkers(array $workers): void
{
    foreach ($workers as $worker) {
        if (is_resource($worker['pipe'])) fclose($worker['pipe']);
        if (function_exists('posix_kill')) @posix_kill($worker['pid'], SIGTERM);
    }
    foreach ($workers as $worker) pcntl_waitpid($worker['pid'], $status);
}

function finishWorkers(array $workers): array
{
    $results = [];
    foreach ($workers as $worker) {
        $message = readMessage($worker['pipe'], 'result');
        expect(is_array($message['result'] ?? null), 'Worker returned an invalid result.');
        $results[] = $message['result'];
    }
    foreach ($workers as $worker) {
        pcntl_waitpid($worker['pid'], $status);
        expect(pcntl_wifexited($status) && pcntl_wexitstatus($status) === 0, 'Concurrency worker failed.');
        fclose($worker['pipe']);
    }
    return $results;
}

function burst(int $count, callable $operation): array
{
    $workers = workers($count, $operation);
    try {
        foreach ($workers as $worker) writeMessage($worker['pipe'], ['type' => 'go']);
        foreach ($workers as $worker) readMessage($worker['pipe'], 'started');
        $results = finishWorkers($workers);
        $workers = [];
        return $results;
    } finally {
        if ($workers) stopWorkers($workers);
    }
}

function testSingleBucket(bool $existing): void
{
    $name = $existing ? 'existing' : 'fresh';
    $scope = scopeFor($name);
    $bucket = hash('sha256', $GLOBALS['testScopePrefix'] . $name);
    registerRow($scope, $bucket);
    if ($existing) seedRow($scope, $bucket);
    $results = burst(12, static function (PDO $db) use ($name, $bucket): array {
        $definition = SavepointConcurrencySandbox\rateLimitDefinition($name, $bucket, 6, 900, 60, 60);
        $result = SavepointConcurrencySandbox\updateRateLimitBuckets($db, [$definition], true);
        return ['allowed' => $result['recorded'], 'retryAfter' => $result['retryAfter']];
    });
    expect(count(array_filter($results, static fn(array $result): bool => $result['allowed'])) === 6,
        'Concurrent reservations exceeded or lost the six-slot limit.');
    $row = row($scope, $bucket);
    expect((int)$row['failed_attempts'] === 6, 'Concurrent counter lost or added reservations.');
    expect((int)$row['blocked_until'] === $GLOBALS['testClock'] + 60, 'Last admitted slot did not establish cooldown.');
    echo "PASS: 12 processes, {$name} bucket, exactly six admitted slots.\n";
}

function testGlobalAccount(): void
{
    $account = hash('sha256', $GLOBALS['testScopePrefix'] . 'shared-account');
    registerRow(scopeFor('account'), $account);
    $ips = [];
    for ($index = 0; $index < 12; $index++) {
        $ips[] = hash('sha256', $GLOBALS['testScopePrefix'] . 'synthetic-ip-' . $index);
        registerRow(scopeFor('login_ip'), $ips[$index]);
    }
    $results = burst(12, static function (PDO $db, int $index) use ($ips, $account): array {
        $retryAfter = SavepointConcurrencySandbox\reservePasswordAttempt($db, $ips[$index], $account,
            ['turnstile_site_key' => 'synthetic-public-key']);
        return ['allowed' => true, 'retryAfter' => $retryAfter];
    });
    expect(count(array_filter($results, static fn(array $result): bool => $result['allowed'])) === 10,
        'Different IPs bypassed or lost the global ten-slot account limit.');
    expect((int)row(scopeFor('account'), $account)['failed_attempts'] === 10, 'Global account counter is not ten.');
    $ipReservations = 0;
    foreach ($ips as $index => $ip) {
        $count = (int)row(scopeFor('login_ip'), $ip)['failed_attempts'];
        expect($count === ($results[$index]['allowed'] ? 1 : 0), 'Rejected account reservation consumed an IP slot.');
        if (!$results[$index]['allowed']) expect($results[$index]['status'] === 429, 'Blocked account did not return 429.');
        $ipReservations += $count;
    }
    expect($ipReservations === 10, 'Atomic account/IP reservations disagree.');
    echo "PASS: 12 distinct synthetic IPs share exactly ten account slots.\n";
}

function testLockWait(bool $freshBlock): void
{
    $GLOBALS['testClock'] = null;
    $name = $freshBlock ? 'fresh-block' : 'expired-block';
    $scope = scopeFor($name);
    $bucket = hash('sha256', $GLOBALS['testScopePrefix'] . $name);
    $before = time();
    seedRow($scope, $bucket, 4, $before - 120);
    $workers = workers(1, static function (PDO $db) use ($name, $bucket): array {
        $definition = SavepointConcurrencySandbox\rateLimitDefinition($name, $bucket, 5, 1, 60, 60);
        $result = SavepointConcurrencySandbox\updateRateLimitBuckets($db, [$definition], true);
        return ['allowed' => $result['recorded'], 'retryAfter' => $result['retryAfter']];
    });
    // This connection is opened AFTER fork, and therefore is never inherited.
    $holder = null;
    try {
        $holder = database();
        $holder->beginTransaction();
        $lock = $holder->prepare('SELECT failed_attempts FROM login_throttle WHERE scope = :scope AND bucket_hash = :bucket FOR UPDATE');
        $lock->execute([':scope' => $scope, ':bucket' => $bucket]);
        $lock->fetch();
        $initialBlocked = $freshBlock ? 0 : time() + 1;
        $setInitialBlock = $holder->prepare('UPDATE login_throttle SET blocked_until = :blocked WHERE scope = :scope AND bucket_hash = :bucket');
        $setInitialBlock->execute([':blocked' => $initialBlocked, ':scope' => $scope, ':bucket' => $bucket]);
        writeMessage($workers[0]['pipe'], ['type' => 'go']);
        readMessage($workers[0]['pipe'], 'started');
        $started = time();
        while (time() < $started + 2) usleep(20000);
        $releasedAt = time();
        $blockedUntil = $freshBlock ? $releasedAt + 4 : $initialBlocked;
        $update = $holder->prepare('UPDATE login_throttle SET blocked_until = :blocked WHERE scope = :scope AND bucket_hash = :bucket');
        $update->execute([':blocked' => $blockedUntil, ':scope' => $scope, ':bucket' => $bucket]);
        $holder->commit();
        $holder = null;
        $result = finishWorkers($workers)[0];
        $workers = [];
        $row = row($scope, $bucket);
        if ($freshBlock) {
            expect(!$result['allowed'] && $result['retryAfter'] > 0 && $result['retryAfter'] <= 4,
                'Waiting request missed the fresh cooldown or used time from before the lock.');
            expect((int)$row['failed_attempts'] === 4 && (int)$row['window_started_at'] === $before - 120,
                'Expired window was reset before respecting a fresh cooldown.');
            expect((int)$row['blocked_until'] === $blockedUntil, 'Rejected reservation changed the fresh cooldown.');
        } else {
            expect($result['allowed'], 'Expired cooldown was checked using time from before the lock.');
            expect((int)$row['failed_attempts'] === 1 && (int)$row['last_attempt_at'] >= $releasedAt
                && (int)$row['window_started_at'] >= $releasedAt, 'Reservation timestamps were sampled before obtaining the lock.');
        }
        echo 'PASS: lock wait respects ' . ($freshBlock ? 'fresh cooldown before window reset' : 'expired cooldown and post-lock timestamps') . ".\n";
    } finally {
        if ($holder instanceof PDO && $holder->inTransaction()) $holder->rollBack();
        $holder = null;
        if ($workers) stopWorkers($workers);
    }
}

$GLOBALS['testRows'] = [];
$exitCode = 0;
try {
    expect(PHP_VERSION_ID >= 80100 && extension_loaded('pdo_mysql') && function_exists('pcntl_fork'),
        'Requires PHP CLI 8.1+, PDO_MYSQL and pcntl.');
    expect(getenv('TEST_DB_ISOLATED') === '1', 'Set TEST_DB_ISOLATED=1 only for a disposable separate test database.');
    $GLOBALS['testDsn'] = trim((string)getenv('TEST_DB_DSN'));
    $GLOBALS['testUser'] = trim((string)getenv('TEST_DB_USER'));
    $GLOBALS['testPassword'] = getenv('TEST_DB_PASSWORD');
    expect(str_starts_with($GLOBALS['testDsn'], 'mysql:') && $GLOBALS['testUser'] !== '' && $GLOBALS['testPassword'] !== false,
        'Explicit TEST_DB_DSN, TEST_DB_USER and TEST_DB_PASSWORD are required.');
    expect((bool)preg_match('/(?:^|;)dbname=([^;]+)/', substr($GLOBALS['testDsn'], 6), $match), 'DSN requires an explicit separate database name.');
    $databaseName = trim($match[1]);
    expect((bool)preg_match('/(?:^|[_-])test(?:s)?(?:[_-]|$)/i', $databaseName), 'Database name must contain a separate test component.');
    $GLOBALS['testScopePrefix'] = 'test_' . bin2hex(random_bytes(4)) . '_';
    $GLOBALS['testClock'] = time();
    $db = database();
    expect($db->query('SELECT DATABASE()')->fetchColumn() === $databaseName, 'Connection did not select the explicit test database.');
    $table = $db->query("SELECT ENGINE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'login_throttle'")->fetchColumn();
    expect(is_string($table) && strcasecmp($table, 'InnoDB') === 0, 'Prepare the InnoDB login_throttle table in the isolated test DB first.');
    $db = null;
    loadProductionHelpers();
    testSingleBucket(false);
    testSingleBucket(true);
    testGlobalAccount();
    testLockWait(false);
    testLockWait(true);
} catch (Throwable $error) {
    $exitCode = 1;
    // Assertion text is ours; PDO details can contain sensitive connection data.
    $message = $error instanceof PDOException ? 'Database operation failed; connection details suppressed.' : $error->getMessage();
    fwrite(STDERR, 'FAIL: ' . $message . "\n");
} finally {
    try { cleanupRows(); } catch (Throwable) {
        $exitCode = 1;
        fwrite(STDERR, "FAIL: exact sandbox-row cleanup failed.\n");
    }
}
if ($exitCode === 0) echo "All real InnoDB concurrency checks passed; exact sandbox rows removed.\n";
exit($exitCode);
