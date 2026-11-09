<?php
declare(strict_types=1);

// This endpoint serves the single-account game collection. GET requests return
// the collection, a passive session check, or cached cover bytes. Same-origin
// JSON POST requests handle authentication and collection operations.

// Keep diagnostics in server logs while FastCGI reloads the per-directory settings.
ini_set('display_errors', '0');
ini_set('display_startup_errors', '0');
ini_set('log_errors', '1');
header_remove('X-Powered-By');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('X-Content-Type-Options: nosniff');

const SESSION_COOKIE_NAME = 'savepoint_session_v3';

function respond(int $status, array $data): void
{
    $preferred = strtolower(trim(explode(',', (string)($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? ''), 2)[0]));
    $language = preg_match('/\Aen(?:-[a-z0-9]{1,8})*\z/', $preferred) === 1 ? 'en' : 'pl';
    if (is_string($data['error'] ?? null)) {
        // Route errors use catalog IDs internally. Include the alternate text
        // for clients that switch languages after receiving an error.
        $messages = apiErrorMessages($data['error']);
        $data['error'] = $messages[$language];
        if ($language === 'en') {
            $data['errorDefault'] = $messages['pl'];
        } elseif ($preferred === 'pl') {
            $data['errorEnglish'] = $messages['en'];
        }
    }
    if (!headers_sent()) {
        header('Content-Language: ' . $language);
    }

    // Attach deadlines only to successful responses for an authenticated session.
    if (($data['ok'] ?? false) === true && ($session = sessionMetadata()) !== null) {
        $data['session'] = $session;
    }
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/** @return array{pl: string, en: string} */
function apiErrorMessages(string $id): array
{
    $catalog = [
        'authentication_required' => [
            'pl' => 'Zaloguj się.',
            'en' => 'Log in.',
        ],
        'captcha_configuration_incomplete' => [
            'pl' => 'Niepełna konfiguracja weryfikacji CAPTCHA.',
            'en' => 'CAPTCHA configuration is incomplete.',
        ],
        'captcha_unavailable' => [
            'pl' => 'Weryfikacja CAPTCHA jest chwilowo niedostępna.',
            'en' => 'CAPTCHA verification is temporarily unavailable.',
        ],
        'captcha_verification_failed' => [
            'pl' => 'Automatyczna weryfikacja nie powiodła się. Spróbuj ponownie.',
            'en' => 'Automatic verification failed. Try again.',
        ],
        'configuration_incomplete' => [
            'pl' => 'Niepełna konfiguracja serwera.',
            'en' => 'Server configuration is incomplete.',
        ],
        'configuration_missing' => [
            'pl' => 'Brak konfiguracji serwera.',
            'en' => 'Server configuration is missing.',
        ],
        'cover_backup_unavailable' => [
            'pl' => 'Kopia okładki nie jest jeszcze dostępna.',
            'en' => 'The cover backup is not available yet.',
        ],
        'cover_not_found' => [
            'pl' => 'Nie znaleziono okładki.',
            'en' => 'Cover not found.',
        ],
        'failed_logins_rate_limited' => [
            'pl' => 'Za dużo nieudanych logowań. Odczekaj przed kolejną próbą.',
            'en' => 'Too many failed login attempts. Wait before trying again.',
        ],
        'failed_verifications_rate_limited' => [
            'pl' => 'Za dużo nieudanych weryfikacji. Odczekaj przed kolejną próbą.',
            'en' => 'Too many failed verification attempts. Wait before trying again.',
        ],
        'game_data_missing' => [
            'pl' => 'Brak danych gry.',
            'en' => 'Game data is missing.',
        ],
        'game_title_and_platform_required' => [
            'pl' => 'Tytuł i konsola są wymagane.',
            'en' => 'A title and platform are required.',
        ],
        'https_required' => [
            'pl' => 'Logowanie wymaga bezpiecznego połączenia HTTPS.',
            'en' => 'Logging in requires a secure HTTPS connection.',
        ],
        'invalid_app_account_configuration' => [
            'pl' => 'Nieprawidłowa konfiguracja konta aplikacji.',
            'en' => 'Invalid application account configuration.',
        ],
        'invalid_app_origin' => [
            'pl' => 'Nieprawidłowy adres aplikacji w konfiguracji serwera.',
            'en' => 'Invalid application URL in the server configuration.',
        ],
        'invalid_cover_ip_blocklist' => [
            'pl' => 'Nieprawidłowa lista adresów IPv4 w konfiguracji serwera.',
            'en' => 'Invalid IPv4 address list in the server configuration.',
        ],
        'invalid_cover_list' => [
            'pl' => 'Nieprawidłowa lista okładek.',
            'en' => 'Invalid list of covers.',
        ],
        'invalid_credentials' => [
            'pl' => 'Nieprawidłowa nazwa użytkownika lub hasło.',
            'en' => 'Incorrect username or password.',
        ],
        'invalid_game_collection' => [
            'pl' => 'Nieprawidłowa kolekcja gier.',
            'en' => 'Invalid game collection.',
        ],
        'invalid_game_data' => [
            'pl' => 'Nieprawidłowe dane gry.',
            'en' => 'Invalid game data.',
        ],
        'invalid_request_data' => [
            'pl' => 'Nieprawidłowe dane żądania.',
            'en' => 'Invalid request data.',
        ],
        'invalid_session_request' => [
            'pl' => 'Nieprawidłowe żądanie sesji.',
            'en' => 'Invalid session request.',
        ],
        'json_required' => [
            'pl' => 'Żądanie musi zawierać dane JSON.',
            'en' => 'The request must contain JSON data.',
        ],
        'login_requests_rate_limited' => [
            'pl' => 'Za dużo żądań logowania. Odczekaj przed kolejną próbą.',
            'en' => 'Too many login requests. Wait before trying again.',
        ],
        'method_not_allowed' => [
            'pl' => 'Niedozwolona metoda żądania.',
            'en' => 'Request method not allowed.',
        ],
        'origin_not_allowed' => [
            'pl' => 'Żądanie pochodzi z niedozwolonej strony.',
            'en' => 'The request came from an unauthorized origin.',
        ],
        'rate_limited' => [
            'pl' => 'Za dużo prób. Odczekaj przed kolejną próbą.',
            'en' => 'Too many attempts. Wait before trying again.',
        ],
        'request_too_large' => [
            'pl' => 'Żądanie jest zbyt duże.',
            'en' => 'The request is too large.',
        ],
        'server_error' => [
            'pl' => 'Błąd połączenia z bazą danych. Sprawdź konfigurację serwera.',
            'en' => 'Could not connect to the database. Check the server configuration.',
        ],
        'session_checks_rate_limited' => [
            'pl' => 'Za dużo kontroli sesji. Odczekaj chwilę i ponów próbę.',
            'en' => 'Too many session checks. Wait a moment and try again.',
        ],
        'unknown_action' => [
            'pl' => 'Nieznana operacja.',
            'en' => 'Unknown operation.',
        ],
    ];

    // Use a generic error for unrecognized IDs or exception messages.
    return $catalog[$id] ?? $catalog['server_error'];
}

function isHttpsRequest(): bool
{
    // Use the web server's TLS indicator. A reverse proxy must have its TLS
    // state mapped to this variable by the deployment's trusted server config.
    return in_array(strtolower((string)($_SERVER['HTTPS'] ?? '')), ['on', '1'], true);
}

function startSecureSession(): void
{
    // Accept session IDs only in cookies and let PHP reject uninitialized IDs.
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    session_name(SESSION_COOKIE_NAME);
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'secure' => true,
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    session_start();
}

function enforceSessionTimeout(bool $touch = true): void
{
    // User ID 1 represents the single configured account. Expiration clears
    // its state and retires the old session ID before any route checks access.
    if ((int)($_SESSION['user_id'] ?? 0) !== 1) {
        return;
    }
    $now = time();
    $authenticatedAt = (int)($_SESSION['authenticated_at'] ?? 0);
    $lastActivityAt = (int)($_SESSION['last_activity_at'] ?? 0);
    // Activity extends the 30-minute idle window within the fixed eight-hour limit.
    if ($authenticatedAt === 0 || $lastActivityAt === 0 || $now - $lastActivityAt > 1800 || $now - $authenticatedAt > 28800) {
        $_SESSION = [];
        session_regenerate_id(true);
        return;
    }
    if ($touch) $_SESSION['last_activity_at'] = $now;
}

function sessionMetadata(): ?array
{
    // Send server time alongside the expiry timestamps so the UI can account
    // for clock differences when it schedules its local session lock.
    if ((int)($_SESSION['user_id'] ?? 0) !== 1) {
        return null;
    }
    $authenticatedAt = (int)($_SESSION['authenticated_at'] ?? 0);
    $lastActivityAt = (int)($_SESSION['last_activity_at'] ?? 0);
    if ($authenticatedAt <= 0 || $lastActivityAt <= 0) {
        return null;
    }
    return [
        'authenticatedAt' => $authenticatedAt,
        'lastActivityAt' => $lastActivityAt,
        'idleExpiresAt' => $lastActivityAt + 1800,
        'absoluteExpiresAt' => $authenticatedAt + 28800,
        'serverNow' => time(),
    ];
}

function loadLocalConfig(): array
{
    // The deployment keeps credentials in a sibling private directory outside
    // the web root. Invalid configuration stops the request before database use.
    $path = dirname(__DIR__, 2) . '/private/savepoint/config.local.php';
    if (!is_file($path) || !is_readable($path)) {
        respond(503, ['ok' => false, 'error' => 'configuration_missing']);
    }
    $config = require $path;
    if (!is_array($config)) {
        respond(503, ['ok' => false, 'error' => 'configuration_incomplete']);
    }
    $requiredKeys = [
        'host',
        'database',
        'username',
        'password',
        'app_origin',
        'app_username',
        'app_password_salt',
        'app_password_hash',
    ];
    foreach ($requiredKeys as $key) {
        if (!is_string($config[$key] ?? null) || $config[$key] === '') {
            respond(503, ['ok' => false, 'error' => 'configuration_incomplete']);
        }
    }
    foreach (['turnstile_site_key', 'turnstile_secret_key'] as $key) {
        $config[$key] = is_string($config[$key] ?? null) ? trim($config[$key]) : '';
    }
    if ($config['turnstile_site_key'] === '' || $config['turnstile_secret_key'] === '') {
        respond(503, ['ok' => false, 'error' => 'captcha_configuration_incomplete']);
    }
    if (
        strlen($config['app_username']) > 128
        || $config['app_username'] !== trim($config['app_username'])
        || !preg_match('/\A[^\x00-\x1f\x7f]+\z/u', $config['app_username'])
        || !preg_match('/\A(?:[0-9a-f]{2}){16,64}\z/i', $config['app_password_salt'])
        || !preg_match('/\A[0-9a-f]{64}\z/i', $config['app_password_hash'])
        || !is_int($config['app_password_iterations'] ?? null)
        || $config['app_password_iterations'] < 1
    ) {
        respond(503, ['ok' => false, 'error' => 'invalid_app_account_configuration']);
    }
    $config['app_password_hash'] = strtolower($config['app_password_hash']);
    // POST validation uses the full origin. Turnstile and the cover downloader
    // use the hostname derived from that same configured value.
    $origin = httpsOrigin($config['app_origin']);
    if ($origin === null) {
        respond(503, ['ok' => false, 'error' => 'invalid_app_origin']);
    }
    $config['app_origin'] = $origin;
    $config['app_host'] = parse_url($origin, PHP_URL_HOST);
    $config['cover_blocked_ipv4'] ??= [];
    if (!is_array($config['cover_blocked_ipv4']) || !array_is_list($config['cover_blocked_ipv4'])) {
        respond(503, ['ok' => false, 'error' => 'invalid_cover_ip_blocklist']);
    }
    foreach ($config['cover_blocked_ipv4'] as $ip) {
        if (!is_string($ip) || !filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            respond(503, ['ok' => false, 'error' => 'invalid_cover_ip_blocklist']);
        }
    }
    return $config;
}

function getDatabase(array $config): PDO
{
    // Use native prepared statements and exceptions so write failures reach
    // the relevant rollback or request handler.
    $dsn = sprintf(
        'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
        $config['host'],
        (int)($config['port'] ?? 3306),
        $config['database']
    );
    return new PDO($dsn, $config['username'], $config['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
}

function rateBucket(string $scope, string $identity, array $config): string
{
    // Store keyed digests in the throttle table in place of raw IPs and account names.
    return hash_hmac('sha256', $scope . ':' . $identity, (string)$config['app_password_hash']);
}

function checkRateLimit(PDO $db, string $scope, string $bucketHash, array $config): void
{
    // This fast rejection is advisory. The locked update below makes the
    // admission decision for concurrent requests.
    $statement = $db->prepare('SELECT blocked_until FROM login_throttle WHERE scope = :scope AND bucket_hash = :bucket');
    $statement->execute([':scope' => $scope, ':bucket' => $bucketHash]);
    $retryAfter = (int)$statement->fetchColumn() - time();
    if ($retryAfter > 0) {
        header('Retry-After: ' . $retryAfter);
        respond(429, [
            'ok' => false,
            'error' => 'rate_limited',
            'captcha' => issueCaptchaChallenge($config),
        ]);
    }
}

function updateRateLimitBuckets(PDO $db, array $buckets, bool $reserve = false): array
{
    // A password attempt must reserve both its account and IP slots together.
    // A cooldown in either bucket leaves the attempt unrecorded in both.
    // Every transaction acquires the same keys in the same order.
    usort(
        $buckets,
        static fn(array $a, array $b): int => strcmp(
            $a['scope'] . ':' . $a['bucket'],
            $b['scope'] . ':' . $b['bucket'],
        ),
    );
    for ($attempt = 0; $attempt < 3; $attempt++) {
        $db->beginTransaction();
        try {
            $rows = [];
            foreach ($buckets as $bucket) {
                $insertedAt = time();
                // The no-op duplicate update takes an exclusive lock immediately.
                // INSERT IGNORE could require a shared-to-exclusive lock upgrade.
                $insert = $db->prepare(
                    'INSERT INTO login_throttle
                        (scope, bucket_hash, failed_attempts, window_started_at, blocked_until, last_attempt_at)
                     VALUES (:scope, :bucket, 0, :window_now, 0, :last_now)
                     ON DUPLICATE KEY UPDATE bucket_hash = VALUES(bucket_hash)'
                );
                $insert->execute([
                    ':scope' => $bucket['scope'],
                    ':bucket' => $bucket['bucket'],
                    ':window_now' => $insertedAt,
                    ':last_now' => $insertedAt,
                ]);
                $select = $db->prepare(
                    'SELECT failed_attempts, window_started_at, blocked_until
                     FROM login_throttle
                     WHERE scope = :scope AND bucket_hash = :bucket
                     FOR UPDATE'
                );
                $select->execute([':scope' => $bucket['scope'], ':bucket' => $bucket['bucket']]);
                $rows[] = $select->fetch();
            }
            // A lock wait may cross a window/cooldown boundary. Use the current time
            // only after all locks are held, and respect cooldown before any reset.
            $now = time();
            $retryAfter = 0;
            foreach ($rows as $row) {
                $retryAfter = max($retryAfter, (int)$row['blocked_until'] - $now);
            }
            if ($retryAfter > 0) {
                $db->commit();
                return ['recorded' => false, 'retryAfter' => $retryAfter];
            }
            foreach ($buckets as $index => $bucket) {
                $count = (int)$rows[$index]['failed_attempts'];
                $windowStarted = (int)$rows[$index]['window_started_at'];
                if ($now - $windowStarted >= $bucket['window']) {
                    $count = 0;
                    $windowStarted = $now;
                }
                $count++;
                // Reservations admit the last initial slot while already placing
                // the next request into cooldown. Later, one slot is available
                // after each cooldown; a correct password can still log in.
                $blockingCount = $bucket['threshold'] + ($reserve ? 0 : 1);
                $delay = $count >= $blockingCount
                    ? min($bucket['maxDelay'], $bucket['baseDelay'] * (2 ** min(10, $count - $blockingCount)))
                    : 0;
                $retryAfter = max($retryAfter, $delay);
                $update = $db->prepare(
                    'UPDATE login_throttle
                     SET failed_attempts = :count, window_started_at = :window,
                         blocked_until = :blocked, last_attempt_at = :now
                     WHERE scope = :scope AND bucket_hash = :bucket'
                );
                $update->execute([
                    ':count' => $count,
                    ':window' => $windowStarted,
                    ':blocked' => $delay > 0 ? $now + $delay : 0,
                    ':now' => $now,
                    ':scope' => $bucket['scope'],
                    ':bucket' => $bucket['bucket'],
                ]);
            }
            $db->commit();
            break;
        } catch (Throwable $error) {
            if ($db->inTransaction()) {
                $db->rollBack();
            }
            // Retry lock wait timeouts and deadlocks after rolling back the attempt.
            $driverCode = $error instanceof PDOException ? (int)($error->errorInfo[1] ?? 0) : 0;
            if ($attempt < 2 && in_array($driverCode, [1205, 1213], true)) {
                usleep(1000 * ($attempt + 1));
                continue;
            }
            throw $error;
        }
    }
    // Occasionally prune a bounded batch of stale rows after releasing the locks.
    if (random_int(1, 100) === 1) {
        $db->exec('DELETE FROM login_throttle WHERE last_attempt_at < ' . ($now - 86400) . ' ORDER BY last_attempt_at LIMIT 100');
    }
    return ['recorded' => true, 'retryAfter' => $retryAfter];
}

function rateLimitDefinition(string $scope, string $bucket, int $threshold, int $window, int $baseDelay, int $maxDelay): array
{
    return compact('scope', 'bucket', 'threshold', 'window', 'baseDelay', 'maxDelay');
}

function recordRateLimitAttempt(
    PDO $db,
    string $scope,
    string $bucketHash,
    int $threshold,
    int $windowSeconds,
    int $baseDelay,
    int $maxDelay,
): int {
    $bucket = rateLimitDefinition($scope, $bucketHash, $threshold, $windowSeconds, $baseDelay, $maxDelay);
    $result = updateRateLimitBuckets($db, [$bucket]);
    return $result['retryAfter'];
}

function reserveLoginRequest(PDO $db, string $bucketHash, array $config): void
{
    // Cap total login requests per IP before spending a slot on CAPTCHA or a password.
    $retryAfter = recordRateLimitAttempt($db, 'login_request', $bucketHash, 10, 60, 60, 300);
    if ($retryAfter > 0) {
        header('Retry-After: ' . $retryAfter);
        respond(429, [
            'ok' => false,
            'error' => 'login_requests_rate_limited',
            'captcha' => issueCaptchaChallenge($config),
        ]);
    }
}

function reserveCaptchaAttempt(PDO $db, string $bucketHash, array $config): int
{
    $result = updateRateLimitBuckets($db, [rateLimitDefinition('captcha_fail', $bucketHash, 5, 900, 60, 3600)], true);
    if (!$result['recorded']) {
        header('Retry-After: ' . $result['retryAfter']);
        respond(429, [
            'ok' => false,
            'error' => 'failed_verifications_rate_limited',
            'captcha' => issueCaptchaChallenge($config),
        ]);
    }
    return $result['retryAfter'];
}

function reservePasswordAttempt(PDO $db, string $ipBucket, string $accountBucket, array $config): int
{
    $result = updateRateLimitBuckets($db, [
        rateLimitDefinition('account', $accountBucket, 10, 900, 2, 30),
        rateLimitDefinition('login_ip', $ipBucket, 5, 900, 60, 3600),
    ], true);
    if (!$result['recorded']) {
        header('Retry-After: ' . $result['retryAfter']);
        respond(429, [
            'ok' => false,
            'error' => 'failed_logins_rate_limited',
            'captcha' => issueCaptchaChallenge($config),
        ]);
    }
    return $result['retryAfter'];
}

function clientIp(): string
{
    // Rate limits use the address supplied by the web server. Trust decisions
    // about forwarding headers belong to the deployment's server configuration.
    $address = (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown');
    return filter_var($address, FILTER_VALIDATE_IP) ? $address : 'unknown';
}

function sessionCheckRetryAfter(string $directory, string $address): int
{
    // Passive session checks use a file counter and can run without a database
    // connection. Two hex digits limit the table to 256 files even when callers
    // rotate IPs. Addresses in the same slot share its quota.
    $slot = substr(hash('sha256', $address), 0, 2);
    $file = @fopen($directory . '/' . $slot, 'c+b');
    if ($file === false) {
        throw new RuntimeException('Session check rate limiter is unavailable.');
    }
    try {
        if (!flock($file, LOCK_EX | LOCK_NB)) {
            // Ask the caller to retry instead of queueing checks behind the lock.
            return 1;
        }
        $now = time();
        $window = intdiv($now, 60);
        $stored = stream_get_contents($file, 64);
        if ($stored === false) {
            throw new RuntimeException('Could not read session check counter.');
        }
        [$previousWindow, $count] = array_pad(explode(' ', $stored, 2), 2, '0');
        $count = (int)$previousWindow === $window ? (int)$count : 0;
        if ($count >= 30) {
            return 60 - ($now % 60);
        }
        $record = $window . ' ' . ($count + 1);
        if (!rewind($file) || fwrite($file, $record) !== strlen($record)
            || !ftruncate($file, strlen($record)) || !fflush($file)) {
            throw new RuntimeException('Could not save session check counter.');
        }
        return 0;
    } finally {
        fclose($file);
    }
}

function enforceSessionCheckRateLimit(): void
{
    $directory = dirname(__DIR__, 2) . '/private/savepoint/session-check-limits';
    $retryAfter = sessionCheckRetryAfter($directory, clientIp());
    if ($retryAfter > 0) {
        header('Retry-After: ' . $retryAfter);
        respond(429, ['ok' => false, 'error' => 'session_checks_rate_limited']);
    }
}

function httpsOrigin(string $url, bool $allowReferer = false): ?string
{
    // Reduce accepted values to HTTPS scheme, lowercase hostname and effective
    // port. A Referer may include a path and query because it identifies a page.
    if ($url === '' || preg_match('/[\x00-\x20\x7f\\\\]/', $url)) {
        return null;
    }
    $parts = parse_url($url);
    if (!is_array($parts) || strtolower($parts['scheme'] ?? '') !== 'https'
        || !filter_var($parts['host'] ?? '', FILTER_VALIDATE_DOMAIN, FILTER_FLAG_HOSTNAME)
        || isset($parts['user']) || isset($parts['pass'])) {
        return null;
    }
    if (!$allowReferer && (!in_array($parts['path'] ?? '', ['', '/'], true)
        || isset($parts['query']) || isset($parts['fragment']))) {
        return null;
    }
    $port = $parts['port'] ?? 443;
    return $port > 0 ? 'https://' . strtolower($parts['host']) . ($port === 443 ? '' : ':' . $port) : null;
}

function enforcePostOrigin(string $appOrigin): void
{
    // Fall back to Referer only when Origin is absent or empty. The target
    // origin comes from private configuration instead of the request's Host header.
    $origin = (string)($_SERVER['HTTP_ORIGIN'] ?? '');
    $candidate = $origin !== '' ? httpsOrigin($origin) : httpsOrigin((string)($_SERVER['HTTP_REFERER'] ?? ''), true);
    if ($candidate !== $appOrigin) {
        respond(403, ['ok' => false, 'error' => 'origin_not_allowed']);
    }
}

function issueCaptchaChallenge(array $config): array
{
    // The widget needs the public site key. Server-side verification uses the secret key.
    return ['provider' => 'turnstile', 'siteKey' => $config['turnstile_site_key']];
}

function verifyTurnstileToken(array $config, string $token): ?bool
{
    // False means verification was rejected. Null signals unavailable
    // transport or an unsuccessful HTTP status from the verification service.
    if ($token === '' || strlen($token) > 2048) {
        return false;
    }
    $payload = http_build_query([
        'secret' => $config['turnstile_secret_key'],
        'response' => $token,
    ], '', '&', PHP_QUERY_RFC3986);
    $url = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
    $response = false;
    $status = 0;

    // Prefer cURL and use verified HTTPS streams when cURL is unavailable.
    if (function_exists('curl_init')) {
        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_HTTPHEADER => ['Content-Type: application/x-www-form-urlencoded'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => 10,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);
        $response = curl_exec($curl);
        $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $curlError = curl_error($curl);
        curl_close($curl);
        if ($response === false) {
            error_log('Savepoint Turnstile request failed: ' . $curlError);
            return null;
        }
    } elseif (filter_var(ini_get('allow_url_fopen'), FILTER_VALIDATE_BOOLEAN)) {
        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => "Content-Type: application/x-www-form-urlencoded\r\n",
                'content' => $payload,
                'timeout' => 10,
                'ignore_errors' => true,
            ],
            'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
        ]);
        $response = @file_get_contents($url, false, $context);
        foreach ($http_response_header ?? [] as $headerLine) {
            if (preg_match('/^HTTP\/\S+\s+(\d{3})/', $headerLine, $matches)) {
                $status = (int)$matches[1];
            }
        }
        if ($response === false) {
            error_log('Savepoint Turnstile request failed: stream request unavailable.');
            return null;
        }
    } else {
        error_log('Savepoint Turnstile unavailable: neither cURL nor URL streams are enabled.');
        return null;
    }

    if ($status < 200 || $status >= 300) {
        error_log('Savepoint Turnstile returned HTTP ' . $status . '.');
        return null;
    }
    $result = json_decode((string)$response, true);
    if (!is_array($result) || empty($result['success'])) {
        return false;
    }
    // A valid token must also belong to this deployment's login widget.
    return ($result['hostname'] ?? '') === $config['app_host']
        && ($result['action'] ?? '') === 'login';
}

function verifyAutomaticCaptcha(array $request, array $config): ?bool
{
    // The hidden website field catches form-filling bots before the outbound request.
    $submitted = is_array($request['captcha'] ?? null) ? $request['captcha'] : [];
    $honeypot = is_string($request['website'] ?? null) ? trim($request['website']) : '';
    if ($honeypot !== '') {
        return false;
    }
    $token = is_string($submitted['token'] ?? null) ? $submitted['token'] : '';
    return verifyTurnstileToken($config, $token);
}

function listGames(PDO $db): array
{
    // Convert database columns to the browser's field names and value types.
    $rows = $db->query('SELECT id, title, platform, edition, cover_url, status, created_at FROM games')->fetchAll();
    return array_map(static function (array $row): array {
        return [
            'id' => $row['id'],
            'title' => $row['title'],
            'platform' => $row['platform'],
            'edition' => $row['edition'],
            'coverUrl' => $row['cover_url'] ?? '',
            'status' => $row['status'],
            'createdAt' => (int)$row['created_at'],
        ];
    }, $rows);
}

function normalizedGame(array $game): array
{
    // Save and both import modes share a write format. Multiple platforms are
    // stored as one comma-separated field with empty entries and repeats removed.
    $title = trim((string)($game['title'] ?? ''));
    $platformInput = is_string($game['platform'] ?? null) ? trim($game['platform']) : '';
    $platforms = array_map('trim', explode(',', $platformInput));
    $platforms = array_filter($platforms, static fn(string $value): bool => $value !== '');
    $platforms = array_values(array_unique($platforms));
    $platform = implode(', ', $platforms);
    if ($title === '' || strlen($title) > 320 || $platform === '' || strlen($platform) > 400 || count($platforms) > 50) {
        throw new InvalidArgumentException('game_title_and_platform_required');
    }
    // Preserve valid IDs and creation times from the client or older exports.
    $id = (string)($game['id'] ?? '');
    if (!preg_match('/^[a-zA-Z0-9-]{1,36}$/', $id)) {
        $id = sprintf(
            '%04x%04x-%04x-4%03x-%04x-%012x',
            random_int(0, 0xffff),
            random_int(0, 0xffff),
            random_int(0, 0xffff),
            random_int(0, 0x0fff),
            random_int(0, 0x3fff) | 0x8000,
            random_int(0, 0xffffffffffff),
        );
    }
    // Saving an optional cover URL only validates its format. The separate
    // backup module applies stricter checks before contacting the remote host.
    $cover = trim((string)($game['coverUrl'] ?? ''));
    if ($cover !== '' && (!filter_var($cover, FILTER_VALIDATE_URL) || !preg_match('/^https?:\/\//i', $cover))) {
        $cover = '';
    }
    $createdAt = filter_var($game['createdAt'] ?? null, FILTER_VALIDATE_INT);
    if ($createdAt === false || $createdAt === null || $createdAt < 0) {
        $createdAt = (int)round(microtime(true) * 1000);
    }
    return [
        'id' => $id,
        'title' => $title,
        'platform' => $platform,
        'edition' => substr(trim((string)($game['edition'] ?? 'Fizyczne')) ?: 'Fizyczne', 0, 50),
        'cover_url' => $cover,
        'status' => substr(trim((string)($game['status'] ?? 'Do ogrania')) ?: 'Do ogrania', 0, 50),
        'created_at' => $createdAt,
    ];
}

function writeGame(PDOStatement $statement, array $game): void
{
    // Bind the shared row shape to the caller's insert or upsert statement.
    $normalized = normalizedGame($game);
    $statement->execute([
        ':id' => $normalized['id'],
        ':title' => $normalized['title'],
        ':platform' => $normalized['platform'],
        ':edition' => $normalized['edition'],
        ':cover_url' => $normalized['cover_url'],
        ':status' => $normalized['status'],
        ':created_at' => $normalized['created_at'],
    ]);
}

function coverBackupStore(array $config): \Savepoint\Covers\CoverBackup
{
    // Keep cached image bytes outside the web root. The authenticated route
    // below is the only HTTP entry point for reading a private copy.
    $private = dirname(__DIR__, 2) . '/private/savepoint/covers';
    require_once $private . '/CoverBackup.php';
    return new \Savepoint\Covers\CoverBackup(
        $private . '/images',
        applicationHost: $config['app_host'],
        blockedIpv4: $config['cover_blocked_ipv4'],
    );
}

function savedCoverUrl(PDO $db, mixed $id): string
{
    if (!is_string($id) || !preg_match('/^[a-zA-Z0-9-]{1,36}$/D', $id)) {
        respond(404, ['ok' => false, 'error' => 'cover_not_found']);
    }
    $statement = $db->prepare('SELECT cover_url FROM games WHERE id = :id');
    $statement->execute([':id' => $id]);
    $url = $statement->fetchColumn();
    if (!is_string($url) || $url === '') {
        respond(404, ['ok' => false, 'error' => 'cover_not_found']);
    }
    return $url;
}

function serveCoverBackup(PDO $db, mixed $id, array $config): void
{
    $url = savedCoverUrl($db, $id);
    // Release the session lock before file I/O so other browser requests can proceed.
    session_write_close();
    $image = coverBackupStore($config)->read($url);
    if ($image === null) {
        respond(404, ['ok' => false, 'error' => 'cover_backup_unavailable']);
    }
    header('Content-Type: ' . $image['mime']);
    header('Content-Length: ' . strlen($image['bytes']));
    header('Content-Disposition: inline; filename="cover"');
    header('Cross-Origin-Resource-Policy: same-origin');
    echo $image['bytes'];
    exit;
}

function createCoverBackup(PDO $db, mixed $id, array $config): void
{
    // Resolve the game ID to its current saved URL and release the session lock
    // before the backup module can make a network request.
    $url = savedCoverUrl($db, $id);
    session_write_close();
    $result = coverBackupStore($config)->backup($url);
    respond(200, ['ok' => true, 'backup' => $result]);
}

function coverBackupStatuses(PDO $db, mixed $ids, array $config): void
{
    // Limit the incoming batch before deduplication so repeated IDs still
    // count toward the request bound.
    if (!is_array($ids) || !array_is_list($ids) || count($ids) > 32) {
        respond(400, ['ok' => false, 'error' => 'invalid_cover_list']);
    }
    foreach ($ids as $id) {
        if (!is_string($id) || !preg_match('/^[a-zA-Z0-9-]{1,36}$/D', $id)) {
            respond(400, ['ok' => false, 'error' => 'invalid_cover_list']);
        }
    }
    $ids = array_values(array_unique($ids));
    if ($ids === []) {
        session_write_close();
        respond(200, ['ok' => true, 'backups' => []]);
    }
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $statement = $db->prepare('SELECT id, cover_url FROM games WHERE id IN (' . $placeholders . ')');
    $statement->execute($ids);
    $rows = $statement->fetchAll();
    session_write_close();
    $store = coverBackupStore($config);
    $readyByUrl = [];
    $backups = [];
    foreach ($rows as $row) {
        $url = (string)($row['cover_url'] ?? '');
        if (!array_key_exists($url, $readyByUrl)) {
            // Validate cached bytes and MIME once per saved URL across the batch.
            $readyByUrl[$url] = $url !== '' && $store->read($url) !== null;
        }
        $backups[] = ['id' => (string)$row['id'], 'coverUrl' => $url, 'ready' => $readyByUrl[$url]];
    }
    respond(200, ['ok' => true, 'backups' => $backups]);
}

function passwordMatches(array $config, string $password): bool
{
    // The salt is stored as hex and decoded for PBKDF2. Compare the resulting
    // digest with the stored digest in constant time.
    $salt = hex2bin((string)$config['app_password_salt']);
    if ($salt === false) {
        return false;
    }
    $candidate = hash_pbkdf2('sha256', $password, $salt, (int)$config['app_password_iterations'], 64);
    return hash_equals((string)$config['app_password_hash'], $candidate);
}

function scheduleSuccessfulLoginNotification(string $username, string $ip, int $timestamp, string $appOrigin): void
{
    // A private SMTP file enables the optional module. The module defers
    // delivery until shutdown so mail I/O can happen after the response.
    try {
        $directory = dirname(__DIR__, 2) . '/private/savepoint/mail';
        if (!is_file($directory . '/smtp.local.php')) {
            return;
        }
        $module = $directory . '/LoginNotifier.php';
        if (!is_file($module) || !is_readable($module)) {
            error_log('Savepoint login notification unavailable.');
            return;
        }
        set_error_handler(static fn(): bool => true);
        try {
            require_once $module;
            \Savepoint\Mail\scheduleLoginNotification($username, $ip, $timestamp, $appOrigin);
        } finally {
            restore_error_handler();
        }
    } catch (Throwable $error) {
        // Never log SMTP configuration, transport errors or request credentials.
        error_log('Savepoint login notification unavailable.');
    }
}

function establishAuthenticatedSession(): void
{
    // Regenerate the ID before assigning the account to prevent session fixation.
    session_regenerate_id(true);
    $_SESSION['user_id'] = 1;
    $_SESSION['authenticated_at'] = time();
    $_SESSION['last_activity_at'] = time();
}

function handleLogin(PDO $db, array $config, array $request): void
{
    $ip = clientIp();
    $ipBucket = rateBucket('login_ip', $ip, $config);
    // Every submitted username shares the configured account bucket. Varying
    // the username cannot bypass the account quota or create arbitrary buckets.
    $accountBucket = rateBucket('account', strtolower((string)$config['app_username']), $config);
    $captchaBucket = rateBucket('captcha_fail', $ip, $config);
    $requestBucket = rateBucket('login_request', $ip, $config);
    checkRateLimit($db, 'login_ip', $ipBucket, $config);
    checkRateLimit($db, 'account', $accountBucket, $config);
    checkRateLimit($db, 'captcha_fail', $captchaBucket, $config);
    reserveLoginRequest($db, $requestBucket, $config);
    $captchaRetry = reserveCaptchaAttempt($db, $captchaBucket, $config);
    $captchaValid = verifyAutomaticCaptcha($request, $config);
    if ($captchaValid === null) {
        respond(503, [
            'ok' => false,
            'error' => 'captcha_unavailable',
            'captcha' => issueCaptchaChallenge($config),
        ]);
    }
    if (!$captchaValid) {
        if ($captchaRetry > 0) {
            header('Retry-After: ' . $captchaRetry);
            respond(429, [
                'ok' => false,
                'error' => 'failed_verifications_rate_limited',
                'captcha' => issueCaptchaChallenge($config),
            ]);
        }
        respond(422, [
            'ok' => false,
            'error' => 'captcha_verification_failed',
            'captcha' => issueCaptchaChallenge($config),
        ]);
    }

    $clearCaptcha = $db->prepare('DELETE FROM login_throttle WHERE scope = :scope AND bucket_hash = :bucket');
    $clearCaptcha->execute([':scope' => 'captcha_fail', ':bucket' => $captchaBucket]);
    // Only a verified CAPTCHA reaches the password budget. Reserve the slot
    // before running PBKDF2 so parallel checks share the same limit.
    $passwordRetry = reservePasswordAttempt($db, $ipBucket, $accountBucket, $config);

    $username = is_string($request['username'] ?? null) ? $request['username'] : '';
    $password = is_string($request['password'] ?? null) ? $request['password'] : '';
    $usernameMatches = strlen($username) <= 128 && hash_equals((string)$config['app_username'], $username);
    $passwordMatches = strlen($password) <= 1024 && passwordMatches($config, $password);
    if (!$usernameMatches || !$passwordMatches) {
        // Use the same failure response for an incorrect username or password.
        if ($passwordRetry > 0) {
            header('Retry-After: ' . $passwordRetry);
            respond(429, [
                'ok' => false,
                'error' => 'failed_logins_rate_limited',
                'captcha' => issueCaptchaChallenge($config),
            ]);
        }
        respond(401, [
            'ok' => false,
            'error' => 'invalid_credentials',
            'captcha' => issueCaptchaChallenge($config),
        ]);
    }
    // Reset failure counters after success. Keep the separate login request quota.
    $clear = $db->prepare(
        'DELETE FROM login_throttle
         WHERE (scope = :ip_scope AND bucket_hash = :ip_bucket)
            OR (scope = :account_scope AND bucket_hash = :account_bucket)
            OR (scope = :captcha_scope AND bucket_hash = :captcha_bucket)'
    );
    $clear->execute([
        ':ip_scope' => 'login_ip',
        ':ip_bucket' => $ipBucket,
        ':account_scope' => 'account',
        ':account_bucket' => $accountBucket,
        ':captcha_scope' => 'captcha_fail',
        ':captcha_bucket' => $captchaBucket,
    ]);
    establishAuthenticatedSession();
    $games = listGames($db);
    scheduleSuccessfulLoginNotification((string)$config['app_username'], $ip, time(), $config['app_origin']);
    respond(200, ['ok' => true, 'games' => $games]);
}

function handleLogout(): void
{
    // Remove server-side state and expire the cookie using its original scope.
    $_SESSION = [];
    $params = session_get_cookie_params();
    setcookie(session_name(), '', [
        'expires' => time() - 42000,
        'path' => $params['path'],
        'domain' => $params['domain'],
        'secure' => $params['secure'],
        'httponly' => $params['httponly'],
        'samesite' => $params['samesite'] ?? 'Strict',
    ]);
    session_destroy();
    respond(200, ['ok' => true]);
}

// Request dispatch validates transport and input first, then checks the session
// and opens the database only for routes that need it.
try {
    if (!isHttpsRequest()) {
        respond(426, ['ok' => false, 'error' => 'https_required']);
    }
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method !== 'GET' && $method !== 'POST') {
        header('Allow: GET, POST');
        respond(405, ['ok' => false, 'error' => 'method_not_allowed']);
    }

    $request = [];
    $action = '';
    $config = null;
    if ($method === 'POST') {
        // Validate the request origin before consuming the JSON body.
        $config = loadLocalConfig();
        enforcePostOrigin($config['app_origin']);
        $contentType = strtolower(trim(explode(';', (string)($_SERVER['CONTENT_TYPE'] ?? ''))[0]));
        if ($contentType !== 'application/json') {
            respond(415, ['ok' => false, 'error' => 'json_required']);
        }
        if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 65536) {
            respond(413, ['ok' => false, 'error' => 'request_too_large']);
        }
        // Read one byte beyond the cap to detect overflow without relying on Content-Length.
        $rawRequest = file_get_contents('php://input', false, null, 0, 65537);
        if ($rawRequest === false || strlen($rawRequest) > 65536) {
            respond(413, ['ok' => false, 'error' => 'request_too_large']);
        }
        $request = json_decode($rawRequest, true);
        if (!is_array($request)) {
            respond(400, ['ok' => false, 'error' => 'invalid_request_data']);
        }
        $action = is_string($request['action'] ?? null) ? $request['action'] : '';
    }

    $coverRequest = $method === 'GET' && array_key_exists('cover', $_GET);
    $sessionCheck = $method === 'GET' && array_key_exists('session', $_GET);
    if ($sessionCheck && (($_GET['session'] ?? null) !== '1' || $coverRequest)) {
        respond(400, ['ok' => false, 'error' => 'invalid_session_request']);
    }
    if ($sessionCheck) {
        // Reject absent or malformed session cookies before opening a PHP session.
        $cookie = $_COOKIE[SESSION_COOKIE_NAME] ?? null;
        if (!is_string($cookie) || !preg_match('/\A[a-zA-Z0-9,-]{1,256}\z/', $cookie)) {
            respond(401, ['ok' => false, 'error' => 'authentication_required', 'authRequired' => true]);
        }
        enforceSessionCheckRateLimit();
    }
    startSecureSession();
    // Passive checks and image work enforce both deadlines without refreshing the idle timer.
    enforceSessionTimeout(!in_array($action, ['backup-cover', 'backup-cover-status'], true) && !$coverRequest && !$sessionCheck);
    if ($sessionCheck) {
        if ((int)($_SESSION['user_id'] ?? 0) !== 1) {
            respond(401, ['ok' => false, 'error' => 'authentication_required', 'authRequired' => true]);
        }
        session_write_close();
        respond(200, ['ok' => true]);
    }
    if ($method === 'POST' && $action === 'logout') {
        handleLogout();
    }
    // Session checks and logout have already returned. Apply the data route
    // guards before connecting to the database.
    $config ??= loadLocalConfig();
    if ($coverRequest && (int)($_SESSION['user_id'] ?? 0) !== 1) {
        respond(401, ['ok' => false, 'error' => 'authentication_required', 'authRequired' => true]);
    }
    if ($method === 'POST' && $action !== 'login' && (int)($_SESSION['user_id'] ?? 0) !== 1) {
        respond(401, [
            'ok' => false,
            'error' => 'authentication_required',
            'authRequired' => true,
            'captcha' => issueCaptchaChallenge($config),
        ]);
    }
    $postActions = [
        'login',
        'save',
        'delete',
        'migrate',
        'replace',
        'backup-cover',
        'backup-cover-status',
    ];
    if ($method === 'POST' && !in_array($action, $postActions, true)) {
        respond(400, ['ok' => false, 'error' => 'unknown_action']);
    }
    $db = getDatabase($config);

    if ($method === 'GET') {
        if ($coverRequest) {
            serveCoverBackup($db, $_GET['cover'], $config);
        }
        if ((int)($_SESSION['user_id'] ?? 0) !== 1) {
            // An unauthenticated collection request gets widget settings and
            // consumes a challenge slot. Game records require a valid session.
            $challengeBucket = rateBucket('challenge', clientIp(), $config);
            checkRateLimit($db, 'challenge', $challengeBucket, $config);
            $retryAfter = recordRateLimitAttempt($db, 'challenge', $challengeBucket, 60, 900, 60, 3600);
            if ($retryAfter > 0) {
                header('Retry-After: ' . $retryAfter);
                respond(429, [
                    'ok' => false,
                    'error' => 'login_requests_rate_limited',
                    'captcha' => issueCaptchaChallenge($config),
                ]);
            }
            respond(401, [
                'ok' => false,
                'error' => 'authentication_required',
                'authRequired' => true,
                'captcha' => issueCaptchaChallenge($config),
            ]);
        }
        respond(200, ['ok' => true, 'games' => listGames($db)]);
    }
    if ($action === 'login') {
        handleLogin($db, $config, $request);
    }

    if ($action === 'backup-cover') {
        createCoverBackup($db, $request['id'] ?? null, $config);
    }

    if ($action === 'backup-cover-status') {
        coverBackupStatuses($db, $request['ids'] ?? null, $config);
    }

    if ($action === 'save') {
        if (!is_array($request['game'] ?? null)) {
            respond(400, ['ok' => false, 'error' => 'game_data_missing']);
        }
        // One upsert handles new games and edits to existing game IDs.
        $statement = $db->prepare(
            'INSERT INTO games (id, title, platform, edition, cover_url, status, created_at)
             VALUES (:id, :title, :platform, :edition, :cover_url, :status, :created_at)
             ON DUPLICATE KEY UPDATE
                 title = VALUES(title),
                 platform = VALUES(platform),
                 edition = VALUES(edition),
                 cover_url = VALUES(cover_url),
                 status = VALUES(status),
                 created_at = VALUES(created_at)'
        );
        writeGame($statement, $request['game']);
        respond(200, ['ok' => true, 'games' => listGames($db)]);
    }

    if ($action === 'delete') {
        $id = (string)($request['id'] ?? '');
        $statement = $db->prepare('DELETE FROM games WHERE id = :id');
        $statement->execute([':id' => $id]);
        respond(200, ['ok' => true, 'games' => listGames($db)]);
    }

    if ($action === 'migrate' || $action === 'replace') {
        $items = $request['games'] ?? null;
        if (!is_array($items) || count($items) > 5000) {
            respond(400, ['ok' => false, 'error' => 'invalid_game_collection']);
        }
        // Migration keeps existing rows with matching IDs. Replacement clears
        // the collection and inserts the new rows in a single transaction so
        // an invalid entry cannot leave the collection partially replaced.
        $inserted = 0;
        $db->beginTransaction();
        try {
            if ($action === 'replace') {
                $db->exec('DELETE FROM games');
            }
            $insert = $action === 'migrate' ? 'INSERT IGNORE INTO games' : 'INSERT INTO games';
            $statement = $db->prepare(
                $insert . ' (id, title, platform, edition, cover_url, status, created_at)
                            VALUES (:id, :title, :platform, :edition, :cover_url, :status, :created_at)'
            );
            foreach ($items as $item) {
                if (!is_array($item)) {
                    throw new InvalidArgumentException('invalid_game_data');
                }
                writeGame($statement, $item);
                $inserted += $statement->rowCount();
            }
            $db->commit();
        } catch (Throwable $error) {
            if ($db->inTransaction()) {
                $db->rollBack();
            }
            throw $error;
        }
        respond(200, ['ok' => true, 'inserted' => $inserted, 'games' => listGames($db)]);
    }

    respond(400, ['ok' => false, 'error' => 'unknown_action']);
} catch (InvalidArgumentException $error) {
    // Game validation errors carry catalog IDs. Import rolls back before
    // this handler translates and returns the validation error.
    respond(422, ['ok' => false, 'error' => $error->getMessage()]);
} catch (Throwable $error) {
    // Keep unexpected exception details in the server log and send a generic error.
    error_log('Savepoint API error: ' . $error->getMessage());
    respond(500, ['ok' => false, 'error' => 'server_error']);
}
