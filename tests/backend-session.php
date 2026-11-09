<?php
declare(strict_types=1);

namespace SavepointSessionTest {
    const SESSION_COOKIE_NAME = 'savepoint_session_v3';
    function time(): int { return $GLOBALS['sessionNow']; }
    function session_regenerate_id(bool $deleteOldSession = false): bool
    {
        $GLOBALS['sessionRotations'][] = $deleteOldSession;
        return true;
    }
    function http_response_code(?int $status = null): int
    {
        if ($status !== null) $GLOBALS['sessionStatus'] = $status;
        return $GLOBALS['sessionStatus'];
    }
    function isHttpsRequest(): bool { return true; }
    function startSecureSession(): void { $GLOBALS['sessionStarts']++; }
    function enforceSessionCheckRateLimit(): void
    {
        $GLOBALS['sessionLimitChecks']++;
        if ($GLOBALS['sessionRateLimited']) respond(429, ['ok' => false]);
    }
    function session_write_close(): bool { $GLOBALS['sessionClosed'] = true; return true; }
    function loadLocalConfig(): never
    {
        $GLOBALS['sessionConfigReads']++;
        throw new \RuntimeException('Passive checks must not read real configuration.');
    }
    function getDatabase(array $config): never
    {
        $GLOBALS['sessionDatabaseReads']++;
        throw new \RuntimeException('Passive checks must not open a database.');
    }
    final class Response extends \RuntimeException
    {
        public function __construct(public int $status, public array $payload) { parent::__construct('Captured response.'); }
    }
}

namespace {
    if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
    if (PHP_VERSION_ID < 80100) { echo "These tests require PHP 8.1 or newer.\n"; exit(1); }
    // Execute real helpers and dispatch with a synthetic clock/session. No
    // production configuration, database, cookies, CAPTCHA or network access.
    $source = file_get_contents(dirname(__DIR__) . '/api/games.php');
    token_get_all($source, TOKEN_PARSE);
    function sessionExpect(bool $condition, string $message): void
    {
        if (!$condition) throw new \RuntimeException($message);
    }
    function sessionSection(string $start, string $end): string
    {
        $source = $GLOBALS['source'];
        $first = strpos($source, $start); $last = strpos($source, $end, $first === false ? 0 : $first);
        sessionExpect($first !== false && $last !== false && $last > $first, 'Expected actual source section: ' . $start);
        return substr($source, $first, $last - $first);
    }
    $respond = sessionSection('function respond(', 'function isHttpsRequest(');
    sessionExpect(substr_count($respond, 'exit;') === 1, 'Only the response termination boundary should be replaced.');
    $respond = str_replace('exit;', 'throw new Response($status, $data);', $respond);
    eval('namespace SavepointSessionTest; ' . $respond . sessionSection('function enforceSessionTimeout(', 'function loadLocalConfig('));

    $sessionNow = 100000;
    $sessionRotations = [];
    $sessionStatus = 200;
    $valid = ['user_id' => 1, 'authenticated_at' => 99000, 'last_activity_at' => 99500];
    $expected = ['authenticatedAt' => 99000, 'lastActivityAt' => 99500, 'idleExpiresAt' => 101300, 'absoluteExpiresAt' => 127800, 'serverNow' => 100000];
    foreach ([[], ['user_id' => 2], ['user_id' => 1], ['user_id' => 1, 'authenticated_at' => 0, 'last_activity_at' => 1]] as $invalid) {
        $_SESSION = $invalid;
        sessionExpect(SavepointSessionTest\sessionMetadata() === null, 'Anonymous or incomplete sessions must not expose metadata.');
    }
    $_SESSION = $valid;
    sessionExpect(SavepointSessionTest\sessionMetadata() === $expected && $_SESSION === $valid, 'Metadata must report real server deadlines without touching activity.');
    echo "PASS: session metadata is server-timed, bounded and read-only; anonymous/incomplete sessions receive none\n";

    $capture = static function (callable $callback): SavepointSessionTest\Response {
        ob_start();
        try { $callback(); }
        catch (SavepointSessionTest\Response $response) {
            $json = ob_get_clean();
            sessionExpect(json_decode($json, true) === $response->payload, 'The actual response must serialize the captured payload.');
            return $response;
        } catch (\Throwable $error) { ob_end_clean(); throw $error; }
        ob_end_clean();
        throw new \RuntimeException('Response must terminate.');
    };
    $games = [['id' => 'synthetic', 'title' => 'Synthetic game', 'coverUrl' => 'https://example.invalid/cover.png']];
    $_SESSION = $valid;
    $response = $capture(static fn() => SavepointSessionTest\respond(200, ['ok' => true, 'games' => $games]));
    sessionExpect($response->payload === ['ok' => true, 'games' => $games, 'session' => $expected], 'Normal successful responses must add metadata outside unchanged games.');
    $response = $capture(static fn() => SavepointSessionTest\respond(200, ['ok' => true, 'backup' => ['status' => 'cached']]));
    sessionExpect($response->payload['session'] === $expected, 'Successful passive cover results must retain the same inactivity deadline.');
    $response = $capture(static fn() => SavepointSessionTest\respond(400, ['ok' => false, 'error' => 'Synthetic failure']));
    sessionExpect(!isset($response->payload['session']), 'Error responses must not disclose session metadata.');
    $_SESSION = [];
    $response = $capture(static fn() => SavepointSessionTest\respond(200, ['ok' => true]));
    sessionExpect($response->payload === ['ok' => true], 'Logout/anonymous successes must not retain old metadata.');
    echo "PASS: actual JSON response adds deadlines only for authenticated successes without changing games or logout\n";

    $first = strpos($source, "\ntry {\n    if (!isHttpsRequest())");
    $last = strrpos($source, '} catch (InvalidArgumentException $error)');
    sessionExpect($first !== false && $last !== false, 'Actual API dispatch must be identifiable.');
    $body = substr($source, $first + strlen("\ntry {\n"), $last - $first - strlen("\ntry {\n"));
    $run = static function (array $session, array $query, array $cookies = ['savepoint_session_v3' => 'synthetic'], bool $limited = false) use ($body, $capture): SavepointSessionTest\Response {
        $_SERVER = ['REQUEST_METHOD' => 'GET', 'HTTPS' => 'on']; $_GET = $query; $_SESSION = $session;
        $_COOKIE = $cookies;
        $GLOBALS['sessionStarts'] = 0; $GLOBALS['sessionClosed'] = false;
        $GLOBALS['sessionConfigReads'] = 0; $GLOBALS['sessionDatabaseReads'] = 0;
        $GLOBALS['sessionLimitChecks'] = 0; $GLOBALS['sessionRateLimited'] = $limited;
        return $capture(static fn() => eval('namespace SavepointSessionTest; ' . $body));
    };
    $response = $run($valid, ['session' => '1']);
    sessionExpect($response->status === 200 && $response->payload === ['ok' => true, 'session' => $expected], 'Passive session check must return metadata without games.');
    sessionExpect($_SESSION === $valid && $sessionStarts === 1 && $sessionClosed && $sessionConfigReads === 0 && $sessionDatabaseReads === 0, 'Successful passive check must release session, preserve activity and avoid all DB/config reads.');
    echo "PASS: actual passive session route returns deadlines only, releases the lock and never opens configuration/DB\n";

    foreach ([[], ['user_id' => 1], ['user_id' => 1, 'authenticated_at' => 99000, 'last_activity_at' => 98199], ['user_id' => 1, 'authenticated_at' => 71199, 'last_activity_at' => 99999]] as $session) {
        $response = $run($session, ['session' => '1']);
        sessionExpect($response->status === 401 && $response->payload === ['ok' => false, 'error' => 'Zaloguj się.', 'authRequired' => true], 'Anonymous, invalid, idle-expired and absolute-expired sessions must stay unauthorized.');
        sessionExpect(!isset($response->payload['session']) && $sessionConfigReads === 0 && $sessionDatabaseReads === 0, 'Unauthorized passive checks must reveal no metadata and never read configuration/DB.');
    }
    sessionExpect(count($sessionRotations) === 3 && !in_array(false, $sessionRotations, true), 'Invalid/expired authenticated sessions must rotate their old ID.');
    echo "PASS: anonymous, invalid and expired passive checks fail closed before configuration or database access\n";

    foreach ([['session' => '0'], ['session' => ['1']], ['session' => '1', 'cover' => 'synthetic']] as $query) {
        $response = $run($valid, $query);
        sessionExpect($response->status === 400 && $sessionStarts === 0 && $sessionConfigReads === 0 && $sessionDatabaseReads === 0, 'Malformed/conflicting passive query must stop before session or other I/O.');
    }
    echo "PASS: malformed or conflicting session queries are rejected before starting a session\n";

    foreach ([[], ['savepoint_session_v3' => ''], ['savepoint_session_v3' => ['fake']], ['savepoint_session_v3' => '../fake']] as $cookies) {
        $response = $run([], ['session' => '1'], $cookies);
        sessionExpect($response->status === 401 && $response->payload['authRequired'] === true, 'Missing or malformed cookies must return an authentication error.');
        sessionExpect($sessionStarts === 0 && $sessionLimitChecks === 0, 'Invalid cookies must not open a session or touch the limiter.');
    }
    $response = $run($valid, ['session' => '1'], ['savepoint_session_v3' => 'synthetic'], true);
    sessionExpect($response->status === 429 && $sessionStarts === 0 && $sessionLimitChecks === 1, 'Over-limit checks must stop before opening a session.');
    echo "PASS: cookie guard and rate rejection both precede session creation\n";

    eval('namespace SavepointSessionTest; ' . sessionSection('function sessionCheckRetryAfter(', 'function enforceSessionCheckRateLimit('));
    $directory = sys_get_temp_dir() . '/savepoint-session-test-' . bin2hex(random_bytes(8));
    mkdir($directory, 0700);
    try {
        $ip = '192.0.2.1';
        for ($i = 0; $i < 30; $i++) {
            sessionExpect(SavepointSessionTest\sessionCheckRetryAfter($directory, $ip) === 0, 'First 30 checks must be admitted.');
        }
        sessionExpect(SavepointSessionTest\sessionCheckRetryAfter($directory, $ip) === 60 - ($sessionNow % 60), 'The next check must return seconds until the new window.');
        sessionExpect(SavepointSessionTest\sessionCheckRetryAfter($directory, '192.0.2.2') === 0, 'An address in another slot must retain its own allowance.');
        $sessionNow += 60;
        sessionExpect(SavepointSessionTest\sessionCheckRetryAfter($directory, $ip) === 0, 'A new window must reset the allowance.');
    } finally {
        foreach (glob($directory . '/*') as $file) unlink($file);
        rmdir($directory);
    }
    echo "PASS: file limiter admits its quota, rejects excess, separates slots and resets the window\n";
    echo "All 7 isolated session-lifetime test groups passed.\n";
}
