<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
if (PHP_VERSION_ID < 80100) {
    echo "These isolated tests require PHP 8.1 or newer.\n";
    exit(1);
}

// No application config, real database, session or external CAPTCHA requests.
// Fibers model overlapping connections and exclusive row locks deterministically;
// this does not replace a parallel integration test against the actual DB engine.
final class TestResponse extends RuntimeException
{
    public function __construct(public int $status, public array $payload)
    {
        parent::__construct('Captured API response.');
    }
}

final class MemoryStore
{
    public array $buckets = [];
    public array $locks = [];
    public bool $cooperative = false;
    public mixed $afterLock = null;
}

final class MemoryDatabase extends PDO
{
    public array $buckets;
    public int $reservations = 0;
    public array $failures = [];
    public array $lockOrder = [];
    public bool $listFailure = false;
    public MemoryStore $store;
    private bool $transaction = false;
    private array $pending = [];

    public function __construct(?MemoryStore $store = null)
    {
        $this->store = $store ?? new MemoryStore();
        $this->buckets =& $this->store->buckets;
    }
    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        return new MemoryStatement($this, $query);
    }
    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): PDOStatement|false
    {
        if ($this->listFailure) throw new PDOException('Synthetic collection failure.');
        return new MemoryStatement($this, $query);
    }
    public function beginTransaction(): bool
    {
        expect(!$this->transaction, 'Transactions must not be nested.');
        $this->transaction = true;
        $this->pending = [];
        $this->reservations++;
        return true;
    }
    public function commit(): bool
    {
        foreach ($this->pending as $key => $row) {
            if ($row === null) unset($this->buckets[$key]);
            else $this->buckets[$key] = $row;
        }
        $this->finishTransaction();
        return true;
    }
    public function rollBack(): bool { $this->finishTransaction(); return true; }
    private function finishTransaction(): void
    {
        foreach ($this->store->locks as $key => $owner) {
            if ($owner === spl_object_id($this)) unset($this->store->locks[$key]);
        }
        $this->pending = [];
        $this->transaction = false;
    }
    public function inTransaction(): bool { return $this->transaction; }
    public function exec(string $statement): int|false { return 0; }
    public function pause(): void
    {
        if ($this->store->cooperative && Fiber::getCurrent() !== null) Fiber::suspend('query');
    }
    public function lock(string $key): void
    {
        while (isset($this->store->locks[$key]) && $this->store->locks[$key] !== spl_object_id($this)) {
            expect(Fiber::getCurrent() !== null, 'An overlapping transaction must use a separate Fiber.');
            Fiber::suspend('lock-wait');
        }
        $this->store->locks[$key] = spl_object_id($this);
        $this->lockOrder[] = $key;
        if (is_callable($this->store->afterLock)) {
            $callback = $this->store->afterLock;
            $this->store->afterLock = null;
            $callback();
        }
    }
    public function read(string $key): array|false
    {
        return array_key_exists($key, $this->pending) ? ($this->pending[$key] ?? false) : ($this->buckets[$key] ?? false);
    }
    public function write(string $key, array $row): void
    {
        expect($this->transaction && ($this->store->locks[$key] ?? null) === spl_object_id($this), 'Counter updates require the exclusive lock.');
        $this->pending[$key] = $row;
    }
    public function delete(string $key): void
    {
        $this->lock($key);
        expect(!$this->transaction, 'This test deletion is an autocommit statement.');
        unset($this->buckets[$key], $this->store->locks[$key]);
    }
}

final class MemoryStatement extends PDOStatement
{
    private mixed $result = false;
    public function __construct(private MemoryDatabase $db, private string $sql) {}
    public function execute(?array $params = null): bool
    {
        $this->db->pause();
        $params ??= [];
        $query = preg_replace('/\s+/', ' ', trim($this->sql));
        $key = ($params[':scope'] ?? '') . ':' . ($params[':bucket'] ?? '');
        if (str_starts_with($query, 'SELECT blocked_until')) {
            $this->result = $this->db->read($key)['blocked_until'] ?? false;
        } elseif (str_starts_with($query, 'INSERT INTO login_throttle')) {
            expect(str_contains($query, 'ON DUPLICATE KEY UPDATE'), 'Reservation creation must acquire an exclusive duplicate-key lock.');
            if ($this->db->failures !== []) {
                $driverCode = array_shift($this->db->failures);
                $error = new PDOException('Synthetic database contention.');
                $error->errorInfo = ['40001', $driverCode, 'Synthetic database contention.'];
                throw $error;
            }
            $this->db->lock($key);
            if ($this->db->read($key) === false) $this->db->write($key, [
                'failed_attempts' => 0, 'window_started_at' => $params[':window_now'],
                'blocked_until' => 0, 'last_attempt_at' => $params[':last_now'],
            ]);
        } elseif (str_starts_with($query, 'SELECT failed_attempts')) {
            expect(str_contains($query, 'FOR UPDATE') && str_contains($query, 'blocked_until'), 'The locked read must include the active cooldown.');
            expect(($this->db->store->locks[$key] ?? null) === spl_object_id($this->db), 'The upsert must already own the exclusive row lock.');
            $this->result = $this->db->read($key);
        } elseif (str_starts_with($query, 'UPDATE login_throttle')) {
            $this->db->write($key, [
                'failed_attempts' => $params[':count'], 'window_started_at' => $params[':window'],
                'blocked_until' => $params[':blocked'], 'last_attempt_at' => $params[':now'],
            ]);
        } elseif (str_starts_with($query, 'DELETE FROM login_throttle WHERE (scope')) {
            foreach (['ip', 'account', 'captcha'] as $scope) {
                $this->db->delete($params[':' . $scope . '_scope'] . ':' . $params[':' . $scope . '_bucket']);
            }
        } elseif (str_starts_with($query, 'DELETE FROM login_throttle WHERE scope')) {
            $this->db->delete($key);
        } else {
            throw new RuntimeException('Unexpected query in isolated test.');
        }
        return true;
    }
    public function fetchColumn(int $column = 0): mixed { return $this->result; }
    public function fetch(int $mode = PDO::FETCH_DEFAULT, int $cursorOrientation = PDO::FETCH_ORI_NEXT, int $cursorOffset = 0): mixed { return $this->result; }
    public function fetchAll(int $mode = PDO::FETCH_DEFAULT, mixed ...$args): array { return []; }
}

function expect(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}
function captureResponse(callable $callback): TestResponse
{
    $notificationsBefore = count($GLOBALS['loginNotifications'] ?? []);
    try { $callback(); } catch (TestResponse $response) {
        if ($response->status >= 400) expect(count($GLOBALS['loginNotifications'] ?? []) === $notificationsBefore, 'Rejected requests must not schedule login email.');
        return $response;
    }
    throw new RuntimeException('Expected the API to finish with a response.');
}
function testNow(): int { return $GLOBALS['testNow']; }
function counters(int $attempts, int $started, int $blocked = 0): array
{
    return ['failed_attempts' => $attempts, 'window_started_at' => $started, 'blocked_until' => $blocked, 'last_attempt_at' => $started];
}
function resetTestState(): void
{
    $GLOBALS['testNow'] = 2000000000;
    $GLOBALS['siteverifyCalls'] = 0;
    $GLOBALS['passwordCalls'] = 0;
    $GLOBALS['captchaResult'] = false;
    $GLOBALS['passwordHook'] = null;
    $GLOBALS['loginNotifications'] = [];
    $_SERVER['REMOTE_ADDR'] = '203.0.113.20';
    $_SESSION = [];
}
function runOverlapping(array $callbacks): array
{
    $fibers = array_map(static fn(callable $callback): Fiber => new Fiber($callback), $callbacks);
    foreach ($fibers as $fiber) $fiber->start();
    for ($round = 0; $round < 20000; $round++) {
        $pending = false;
        foreach ($fibers as $fiber) {
            if (!$fiber->isTerminated()) { $pending = true; $fiber->resume(); }
        }
        if (!$pending) return array_map(static fn(Fiber $fiber): mixed => $fiber->getReturn(), $fibers);
    }
    throw new RuntimeException('Cooperative transactions did not finish; possible lock-order regression.');
}

$source = file_get_contents(dirname(__DIR__) . '/api/games.php');
token_get_all($source, TOKEN_PARSE);
$mainStart = strpos($source, "\ntry {\n    if (!isHttpsRequest())");
expect($mainStart !== false, 'API entry point was not found.');
$functions = substr($source, strpos($source, 'function respond('), $mainStart - strpos($source, 'function respond('));
$respondEnd = strpos($functions, 'function isHttpsRequest(');
$functions = 'function respond(int $status, array $data): void { throw new TestResponse($status, $data); }' . "\n" . substr($functions, $respondEnd);
$verifyStart = strpos($functions, 'function verifyTurnstileToken(');
$verifyEnd = strpos($functions, 'function verifyAutomaticCaptcha(', $verifyStart);
$functions = substr($functions, 0, $verifyStart) . 'function verifyTurnstileToken(array $config, string $token): ?bool { $GLOBALS["siteverifyCalls"]++; return $GLOBALS["captchaResult"]; }' . "\n" . substr($functions, $verifyEnd);
$sessionStart = strpos($functions, 'function establishAuthenticatedSession(');
$sessionEnd = strpos($functions, 'function handleLogin(', $sessionStart);
$functions = substr($functions, 0, $sessionStart) . 'function establishAuthenticatedSession(): void { $_SESSION["user_id"] = 1; }' . "\n" . substr($functions, $sessionEnd);
$notificationStart = strpos($functions, 'function scheduleSuccessfulLoginNotification(');
$notificationEnd = strpos($functions, 'function establishAuthenticatedSession(', $notificationStart);
expect($notificationStart !== false && $notificationEnd > $notificationStart, 'The optional mail boundary must remain separately testable.');
$functions = substr($functions, 0, $notificationStart) . 'function scheduleSuccessfulLoginNotification(string $username, string $ip, int $timestamp): void { $GLOBALS["loginNotifications"][] = compact("username", "ip", "timestamp"); }' . "\n" . substr($functions, $notificationEnd);
$functions = str_replace('function passwordMatches(', 'function actualPasswordMatches(', $functions);
$functions .= "\n" . 'function passwordMatches(array $config, string $password): bool { $GLOBALS["passwordCalls"]++; if (is_callable($GLOBALS["passwordHook"])) ($GLOBALS["passwordHook"])(); return actualPasswordMatches($config, $password); }';
$functions = preg_replace('/(?<![a-zA-Z0-9_])time\(\)/', 'testNow()', $functions);
eval($functions);

$salt = 'isolated-test-salt';
$config = [
    'app_username' => 'test-user', 'app_password_salt' => bin2hex($salt),
    'app_password_iterations' => 1, 'app_password_hash' => hash_pbkdf2('sha256', 'test-password', $salt, 1, 64),
    'app_origin' => 'https://savepoint.example.test',
    'turnstile_site_key' => 'test-site', 'turnstile_secret_key' => 'test-secret',
];
$login = ['username' => 'test-user', 'password' => 'test-password', 'captcha' => ['token' => 'synthetic-token']];
$wrongLogin = array_replace($login, ['password' => 'wrong-test-password']);
$captchaKey = 'captcha_fail:' . rateBucket('captcha_fail', '203.0.113.20', $config);
$requestKey = 'login_request:' . rateBucket('login_request', '203.0.113.20', $config);
$ipKey = 'login_ip:' . rateBucket('login_ip', '203.0.113.20', $config);
$accountKey = 'account:' . rateBucket('account', 'test-user', $config);

resetTestState();
$db = new MemoryDatabase();
$db->buckets[$captchaKey] = counters(5, testNow(), testNow() + 60);
$response = captureResponse(fn() => handleLogin($db, $config, $login));
expect($response->status === 429 && $GLOBALS['siteverifyCalls'] === 0 && $db->reservations === 0, 'A blocked CAPTCHA bucket must stop before reservations and Siteverify.');

resetTestState();
$db = new MemoryDatabase();
for ($attempt = 1; $attempt <= 5; $attempt++) {
    $response = captureResponse(fn() => handleLogin($db, $config, $login));
    expect($response->status === ($attempt < 5 ? 422 : 429), 'CAPTCHA reservation limit regression.');
}
$response = captureResponse(fn() => handleLogin($db, $config, $login));
expect($response->status === 429 && $GLOBALS['siteverifyCalls'] === 5, 'Only five invalid CAPTCHA verifications may start before cooldown.');
expect(!isset($db->buckets[$accountKey]) && !isset($db->buckets[$ipKey]), 'Invalid tokens must not consume global-account or password reservations.');

resetTestState();
$db = new MemoryDatabase();
$GLOBALS['captchaResult'] = null;
for ($attempt = 0; $attempt < 5; $attempt++) {
    $response = captureResponse(fn() => handleLogin($db, $config, $login));
    expect($response->status === 503, 'Unavailable CAPTCHA must fail closed during its reservation budget.');
}
$response = captureResponse(fn() => handleLogin($db, $config, $login));
expect($response->status === 429 && $GLOBALS['siteverifyCalls'] === 5 && $GLOBALS['passwordCalls'] === 0, 'CAPTCHA outages must not create unlimited outbound requests or check passwords.');

resetTestState();
$db = new MemoryDatabase();
$requestBucket = rateBucket('login_request', clientIp(), $config);
for ($attempt = 0; $attempt < 10; $attempt++) reserveLoginRequest($db, $requestBucket, $config);
$response = captureResponse(fn() => reserveLoginRequest($db, $requestBucket, $config));
expect($response->status === 429 && $db->buckets[$requestKey]['failed_attempts'] === 11, 'The eleventh request must be rejected by the independent request budget.');
$blockedRequest = $db->buckets[$requestKey];
$response = captureResponse(fn() => reserveLoginRequest($db, $requestBucket, $config));
expect($response->status === 429 && $db->buckets[$requestKey] === $blockedRequest, 'Requests during cooldown must not extend or change the bucket.');

resetTestState();
$db = new MemoryDatabase();
$db->buckets[$captchaKey] = counters(3, testNow());
$GLOBALS['captchaResult'] = true;
$GLOBALS['passwordHook'] = function () use ($db, $accountKey, $ipKey): void {
    expect($db->buckets[$accountKey]['failed_attempts'] === 1 && $db->buckets[$ipKey]['failed_attempts'] === 1, 'Both reservations must commit before the password hash starts.');
};
$response = captureResponse(fn() => handleLogin($db, $config, $login));
expect($response->status === 200 && ($_SESSION['user_id'] ?? 0) === 1 && $GLOBALS['passwordCalls'] === 1, 'Valid login must still establish the session.');
expect(!isset($db->buckets[$captchaKey]) && !isset($db->buckets[$accountKey]) && !isset($db->buckets[$ipKey]), 'Successful login must clear all three authentication buckets.');
expect(isset($db->buckets[$requestKey]), 'Success must preserve the independent request budget.');
expect($GLOBALS['loginNotifications'] === [['username' => 'test-user', 'ip' => '203.0.113.20', 'timestamp' => testNow()]], 'Exactly one successful login notice must use the trusted account, peer address and authentication time.');
expect(!str_contains(json_encode($response->payload), 'test-password') && !str_contains(json_encode($response->payload), 'synthetic-token'), 'Login responses must not contain password or CAPTCHA credentials.');

resetTestState();
$db = new MemoryDatabase();
$GLOBALS['captchaResult'] = true;
$_SERVER['HTTP_X_FORWARDED_FOR'] = '198.51.100.250';
$injectedLogin = array_replace($login, ['email' => 'untrusted@example.invalid', 'smtp_host' => 'attacker.invalid']);
$response = captureResponse(fn() => handleLogin($db, $config, $injectedLogin));
expect($response->status === 200 && $GLOBALS['loginNotifications'] === [['username' => 'test-user', 'ip' => '203.0.113.20', 'timestamp' => testNow()]], 'Request email fields and forwarded IP headers must not control login notifications.');
unset($_SERVER['HTTP_X_FORWARDED_FOR']);

resetTestState();
$db = new MemoryDatabase();
$db->listFailure = true;
$GLOBALS['captchaResult'] = true;
try { handleLogin($db, $config, $login); throw new RuntimeException('Expected the synthetic collection failure.'); }
catch (PDOException $error) { expect($GLOBALS['loginNotifications'] === [], 'A failed collection response must not schedule successful-login mail.'); }

resetTestState();
listGames(new MemoryDatabase());
expect($GLOBALS['loginNotifications'] === [], 'Reading the collection must not generate a fresh login notice.');

resetTestState();
$db = new MemoryDatabase();
$GLOBALS['captchaResult'] = true;
for ($attempt = 1; $attempt <= 5; $attempt++) {
    $response = captureResponse(fn() => handleLogin($db, $config, $wrongLogin));
    expect($response->status === ($attempt < 5 ? 401 : 429), 'Valid CAPTCHA with wrong password must consume the IP/account reservations.');
}
$response = captureResponse(fn() => handleLogin($db, $config, $wrongLogin));
expect($response->status === 429 && $GLOBALS['passwordCalls'] === 5 && $GLOBALS['siteverifyCalls'] === 5, 'Blocked IP requests must not check CAPTCHA or passwords.');
$GLOBALS['testNow'] += 60;
$response = captureResponse(fn() => handleLogin($db, $config, $login));
expect($response->status === 200, 'A correct password must be usable after the short cooldown, without waiting for the full window.');

// A stale unlocked precheck cannot erase a newer cooldown, even after turnover.
resetTestState();
$db = new MemoryDatabase();
$db->buckets[$requestKey] = counters(10, testNow() - 61);
checkRateLimit($db, 'login_request', $requestBucket, $config);
$db->buckets[$requestKey]['blocked_until'] = testNow() + 59;
$before = $db->buckets[$requestKey];
$response = captureResponse(fn() => reserveLoginRequest($db, $requestBucket, $config));
expect($response->status === 429 && $db->buckets[$requestKey] === $before, 'Active cooldown must win over both an expired window and a stale precheck.');

// The clock advances while an exclusive lock is being acquired.
resetTestState();
$db = new MemoryDatabase();
$db->buckets[$requestKey] = counters(11, testNow() - 59, testNow() + 1);
$db->store->afterLock = static function (): void { $GLOBALS['testNow'] += 2; };
reserveLoginRequest($db, $requestBucket, $config);
expect($db->buckets[$requestKey]['failed_attempts'] === 1 && $db->buckets[$requestKey]['window_started_at'] === testNow(), 'Window/cooldown decisions must use time after the lock wait.');

resetTestState();
$db = new MemoryDatabase();
$db->failures = [1213, 1205];
reserveLoginRequest($db, $requestBucket, $config);
expect($db->reservations === 3 && $db->buckets[$requestKey]['failed_attempts'] === 1, 'Deadlock/lock-timeout retries must repeat the entire transaction without double-counting.');
$db = new MemoryDatabase();
$db->failures = [1213, 1213, 1213, 1213];
try { reserveLoginRequest($db, $requestBucket, $config); throw new RuntimeException('Persistent contention must fail closed.'); }
catch (PDOException $error) { expect($db->reservations === 3 && $db->buckets === [], 'Contention retries must be bounded and rolled back.'); }

// All callbacks start before any reservation is committed, like distinct PHP
// sessions/connections hitting a cold or existing bucket concurrently.
foreach ([false, true] as $existing) {
    resetTestState();
    $store = new MemoryStore();
    $store->cooperative = true;
    if ($existing) $store->buckets[$captchaKey] = counters(0, testNow());
    $callbacks = [];
    for ($index = 0; $index < 20; $index++) {
        $connection = new MemoryDatabase($store);
        $callbacks[] = static function () use ($connection, $config, $login): TestResponse {
            $_SERVER['REMOTE_ADDR'] = '203.0.113.20';
            return captureResponse(fn() => handleLogin($connection, $config, $login));
        };
    }
    runOverlapping($callbacks);
    expect($GLOBALS['siteverifyCalls'] === 5 && $GLOBALS['passwordCalls'] === 0 && $store->buckets[$captchaKey]['failed_attempts'] === 5, 'Overlapping invalid CAPTCHA requests must reserve at most five outbound calls, with cold or existing rows.');
}

resetTestState();
$store = new MemoryStore();
$store->cooperative = true;
$GLOBALS['captchaResult'] = true;
$callbacks = [];
for ($index = 1; $index <= 32; $index++) {
    $connection = new MemoryDatabase($store);
    $ip = '203.0.113.' . $index;
    // handleLogin captures clientIp before its first cooperative DB yield.
    $callbacks[] = static function () use ($connection, $config, $wrongLogin, $ip): TestResponse {
        $_SERVER['REMOTE_ADDR'] = $ip;
        return captureResponse(fn() => handleLogin($connection, $config, $wrongLogin));
    };
}
runOverlapping($callbacks);
expect($GLOBALS['passwordCalls'] === 10 && $store->buckets[$accountKey]['failed_attempts'] === 10, 'Distinct concurrent IPs must not exceed the ten global password reservations.');
expect($store->buckets[$accountKey]['blocked_until'] === testNow() + 2, 'The last initial global reservation must already protect the next request.');
$GLOBALS['testNow'] += 2;
$store->cooperative = false;
$_SERVER['REMOTE_ADDR'] = '203.0.113.100';
$response = captureResponse(fn() => handleLogin(new MemoryDatabase($store), $config, $wrongLogin));
expect($GLOBALS['passwordCalls'] === 11 && $response->status === 429 && $store->buckets[$accountKey]['blocked_until'] === testNow() + 4, 'Exactly one further global slot must be available after cooldown, with escalating backoff.');
$GLOBALS['testNow'] += 4;
$_SERVER['REMOTE_ADDR'] = '203.0.113.101';
$response = captureResponse(fn() => handleLogin(new MemoryDatabase($store), $config, $login));
expect($response->status === 200 && !isset($store->buckets[$accountKey]), 'Correct credentials must still work after a global cooldown and clear the account bucket.');
expect(count($GLOBALS['loginNotifications']) === 1, 'Only the successful recovery, not preceding rejected attempts, may generate mail.');

$main = substr($source, $mainStart);
$databaseAt = strpos($main, '$db = getDatabase($config);');
expect($databaseAt !== false, 'API database boundary must be identifiable.');
foreach (["respond(405,", 'enforcePostOrigin($config[\'app_origin\']);', '$request = json_decode('] as $guard) {
    $guardAt = strpos($main, $guard);
    expect($guardAt !== false && $guardAt < $databaseAt, 'Invalid request guards must precede DB access.');
}
expect(!preg_match('/CREATE\s+TABLE|ALTER\s+TABLE|INFORMATION_SCHEMA|ensureSchema/i', $source), 'Runtime API must not perform schema administration.');
expect(!str_contains($source, "'provider' => 'pow'"), 'The API must not fall back to a bot-solvable local challenge.');
expect(str_contains($source, "\$config['turnstile_site_key'] === '' || \$config['turnstile_secret_key'] === ''"), 'Both Turnstile keys must be mandatory.');

$appOrigin = 'https://savepoint.example.test:8443';
expect(httpsOrigin('https://SAVEPOINT.example.test:443/') === $config['app_origin'], 'The configured default HTTPS port and hostname must be normalized.');
expect(httpsOrigin('https://savepoint.example.test/invalid') === null, 'A configured origin cannot include a deployment path.');
$_SERVER = ['HTTP_X_FORWARDED_PROTO' => 'https', 'HTTP_HOST' => 'savepoint.example.test:8443'];
expect(!isHttpsRequest(), 'A client header must not enable HTTPS handling.');
$_SERVER['HTTPS'] = 'on';
expect(isHttpsRequest(), 'Server-side HTTPS must enable HTTPS handling.');
foreach ([
    ['HTTP_ORIGIN' => 'https://savepoint.example.test'],
    ['HTTP_ORIGIN' => 'http://savepoint.example.test:8443'],
    ['HTTP_ORIGIN' => 'https://other.example.test:8443', 'HTTP_REFERER' => $appOrigin . '/'],
    ['HTTP_ORIGIN' => 'https://user@savepoint.example.test:8443'],
    ['HTTP_ORIGIN' => $appOrigin . '?extra=value'],
    [],
] as $headers) {
    unset($_SERVER['HTTP_ORIGIN'], $_SERVER['HTTP_REFERER']);
    $_SERVER += $headers;
    $response = captureResponse(fn() => enforcePostOrigin($appOrigin));
    expect($response->status === 403, 'Requests without the configured HTTPS origin must be rejected.');
}
$_SERVER['HTTP_ORIGIN'] = $appOrigin;
enforcePostOrigin($appOrigin);
unset($_SERVER['HTTP_ORIGIN']);
$_SERVER['HTTP_REFERER'] = $appOrigin . '/index.html?v=1';
enforcePostOrigin($appOrigin);

$migration = file_get_contents(dirname(__DIR__) . '/scripts/migrate.php');
token_get_all($migration, TOKEN_PARSE);
$cliGuardAt = strpos($migration, "if (PHP_SAPI !== 'cli')");
$configReadAt = strpos($migration, 'require $configPath');
expect($cliGuardAt !== false && $configReadAt !== false && $cliGuardAt < $configReadAt, 'Migration must reject HTTP before reading config.');

// Run the real optional integration helper with absent SMTP configuration. Namespaced
// filesystem/log shims ensure this can never read a real private configuration.
$helperStart = strpos($source, 'function scheduleSuccessfulLoginNotification(');
$helperEnd = strpos($source, 'function establishAuthenticatedSession(', $helperStart);
$helper = substr($source, $helperStart, $helperEnd - $helperStart);
$GLOBALS['missingMailPaths'] = [];
$GLOBALS['missingMailLogs'] = [];
eval('namespace SavepointMissingMailSandbox; use \\Throwable; function is_file(string $path): bool { $GLOBALS["missingMailPaths"][] = $path; return false; } function error_log(string $message): bool { $GLOBALS["missingMailLogs"][] = $message; return true; } ' . $helper);
SavepointMissingMailSandbox\scheduleSuccessfulLoginNotification('test-user', '203.0.113.20', testNow(), $appOrigin);
expect(count($GLOBALS['missingMailPaths']) === 1 && str_ends_with($GLOBALS['missingMailPaths'][0], '/private/savepoint/mail/smtp.local.php'), 'The integration must check only its fixed private SMTP configuration when disabled.');
expect($GLOBALS['missingMailLogs'] === [], 'An intentionally unconfigured SMTP integration must not log errors.');
expect(substr_count($main, 'scheduleSuccessfulLoginNotification(') === 0, 'GET and data-operation entry points must not schedule login mail.');

echo "PASS: locked cooldown/window checks, bounded transaction retries, overlapping CAPTCHA/account reservations, password recovery, request/migration guards and successful-login-only email scheduling.\n";
