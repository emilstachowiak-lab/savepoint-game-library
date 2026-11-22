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
const COLLECTION_FIELDS = 'id, title, platform, edition, cover_url, status, created_at, updated_at';
const COLLECTION_INSERT = 'INSERT INTO games (id, title, platform, edition, cover_url, status, created_at)
    VALUES (:id, :title, :platform, :edition, :cover_url, :status, :created_at)';

function respond(int $status, array $data): never
{
    // AI responses never set a session cookie, so a delayed reply cannot
    // restore an old cookie after sign-out.
    if (defined('SAVEPOINT_AI_REQUEST')) header_remove('Set-Cookie');
    $preferred = strtolower(trim(explode(',', (string)($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? ''), 2)[0]));
    $language = preg_match('/\Aen(?:-[a-z0-9]{1,8})*\z/', $preferred) === 1 ? 'en' : 'pl';
    if (is_string($data['error'] ?? null)) {
        // Route errors use catalog IDs internally. Include the alternate text
        // for clients that switch languages after receiving an error.
        if (str_starts_with($data['error'], 'collection_')) {
            $data['code'] = $data['error'];
        }
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
        'ai_not_configured' => [
            'pl' => 'Funkcja Dodaj Gry AI jest niedostępna bez klucza Gemini API.',
            'en' => 'Add Games AI is unavailable without a Gemini API key.',
        ],
        'ai_duplicates_not_configured' => [
            'pl' => 'Wyszukiwanie powtórzeń jest niedostępne bez klucza Gemini API.',
            'en' => 'Duplicate detection is unavailable without a Gemini API key.',
        ],
        'ai_duplicates_invalid' => [
            'pl' => 'Wybierz wpis do zachowania i potwierdź operację.',
            'en' => 'Choose the entry to keep and confirm the action.',
        ],
        'ai_duplicates_stale' => [
            'pl' => 'Wpisy się zmieniły lub podgląd wygasł. Uruchom ponownie wyszukiwanie powtórzeń.',
            'en' => 'The entries changed or the review expired. Run duplicate detection again.',
        ],
        'ai_duplicates_merge_too_large' => [
            'pl' => 'Połączona lista platform przekracza limit. Uporządkuj platformy w edycji gier i sprawdź powtórzenia ponownie.',
            'en' => 'The combined platform list exceeds the limit. Edit the platform lists and scan for duplicates again.',
        ],
        'ai_invalid_cover_search' => [
            'pl' => 'Podaj poprawny tytuł gry i wybierz przynajmniej jedną platformę.',
            'en' => 'Enter a valid game title and select at least one platform.',
        ],
        'ai_cover_search_unavailable' => [
            'pl' => 'Wyszukiwanie okładek jest chwilowo niedostępne.',
            'en' => 'Cover search is temporarily unavailable.',
        ],
        'ai_cover_search_rate_limited' => [
            'pl' => 'Osiągnięto limit wyszukiwania okładek. Spróbuj ponownie później.',
            'en' => 'The cover search limit has been reached. Try again later.',
        ],
        'ai_session_expired' => [
            'pl' => 'Sesja wygasła. Zaloguj się ponownie przed użyciem AI.',
            'en' => 'Your session expired. Sign in again before using AI.',
        ],
        'ai_invalid_upload' => [
            'pl' => 'Nieprawidłowe dane zdjęcia. Wybierz je ponownie.',
            'en' => 'Invalid photo data. Choose the photo again.',
        ],
        'ai_image_too_large' => [
            'pl' => 'Zdjęcie przekracza dozwolony rozmiar. Wybierz mniejsze zdjęcie.',
            'en' => 'The photo exceeds the size limit. Choose a smaller photo.',
        ],
        'ai_image_invalid' => [
            'pl' => 'Nie udało się odczytać zdjęcia. Wybierz poprawny obraz.',
            'en' => 'Could not read the photo. Choose a valid image.',
        ],
        'ai_upload_limit' => [
            'pl' => 'Za dużo jednoczesnych zdjęć. Spróbuj ponownie za chwilę.',
            'en' => 'Too many simultaneous photos. Try again shortly.',
        ],
        'ai_upload_unavailable' => [
            'pl' => 'Zdjęcie wygasło lub jest niedostępne. Wybierz je ponownie.',
            'en' => 'The photo expired or is unavailable. Choose it again.',
        ],
        'ai_upload_expired' => [
            'pl' => 'Przesyłanie zdjęcia wygasło. Wybierz „Rozpoznaj gry”, aby przesłać zdjęcie ponownie.',
            'en' => 'The photo upload expired. Select “Identify games” to upload it again.',
        ],
        'ai_upload_busy' => [
            'pl' => 'Trwa przetwarzanie innego zdjęcia. Spróbuj ponownie za chwilę.',
            'en' => 'Another photo is being processed. Try again shortly.',
        ],
        'ai_upload_incomplete' => [
            'pl' => 'Nie przesłano całego zdjęcia. Wybierz je i spróbuj ponownie.',
            'en' => 'The photo upload is incomplete. Choose it and try again.',
        ],
        'ai_rate_limited' => [
            'pl' => 'Osiągnięto limit rozpoznań AI. Spróbuj ponownie później.',
            'en' => 'The AI recognition limit has been reached. Try again later.',
        ],
        'ai_service_unavailable' => [
            'pl' => 'Rozpoznawanie AI jest chwilowo niedostępne. Spróbuj ponownie później.',
            'en' => 'AI recognition is temporarily unavailable. Try again later.',
        ],
        'ai_response_invalid' => [
            'pl' => 'AI nie zwróciło poprawnej listy gier. Spróbuj użyć wyraźniejszego zdjęcia.',
            'en' => 'AI did not return a valid game list. Try a clearer photo.',
        ],
        'ai_refused' => [
            'pl' => 'Nie udało się rozpoznać gier na tym zdjęciu. Wybierz inne zdjęcie.',
            'en' => 'Could not identify games in this photo. Choose another photo.',
        ],
        'ai_confirmation_required' => [
            'pl' => 'Potwierdź poprawność wybranych gier przed ich dodaniem.',
            'en' => 'Confirm that the selected games are correct before adding them.',
        ],
        'ai_invalid_batch' => [
            'pl' => 'Sprawdź dane wybranych gier. Jednocześnie można dodać od 1 do 32 gier.',
            'en' => 'Check the selected game details. You can add between 1 and 32 games at a time.',
        ],
        'ai_batch_conflict' => [
            'pl' => 'Dane zapisu są w konflikcie z kolekcją. Odśwież stronę i sprawdź zapisane gry.',
            'en' => 'The save conflicts with your collection. Reload and check your saved games.',
        ],
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
            'pl' => 'Wystąpił błąd serwera. Spróbuj ponownie później.',
            'en' => 'A server error occurred. Try again later.',
        ],
        'database_unavailable' => [
            'pl' => 'Baza danych jest chwilowo niedostępna. Spróbuj ponownie później.',
            'en' => 'The database is temporarily unavailable. Try again later.',
        ],
        'session_unavailable' => [
            'pl' => 'Nie można zapisać sesji. Odśwież stronę i spróbuj ponownie.',
            'en' => 'The session could not be saved. Refresh the page and try again.',
        ],
        'collection_conflict' => [
            'pl' => 'Wpis zmienił się od otwarcia. Odśwież kolekcję i spróbuj ponownie.',
            'en' => 'This entry has changed. Refresh the collection and try again.',
        ],
        'collection_import_conflict' => [
            'pl' => 'Import zawiera powtórzony identyfikator lub wpis o identyfikatorze używanym już przez inną grę.',
            'en' => 'The import contains a repeated ID or an ID already used by a different game.',
        ],
        'collection_upload_invalid' => [
            'pl' => 'Przesłany fragment kopii kolekcji jest nieprawidłowy.',
            'en' => 'The uploaded collection chunk is invalid.',
        ],
        'collection_upload_missing' => [
            'pl' => 'Przesyłanie kopii kolekcji wygasło. Wybierz plik ponownie.',
            'en' => 'The collection upload expired. Select the file again.',
        ],
        'collection_upload_busy' => [
            'pl' => 'Inna kopia kolekcji jest właśnie przesyłana. Spróbuj ponownie za chwilę.',
            'en' => 'Another collection backup is being uploaded. Try again shortly.',
        ],
        'collection_upload_offset' => [
            'pl' => 'Brakuje fragmentu kopii kolekcji. Prześlij plik ponownie.',
            'en' => 'A collection backup chunk is missing. Upload the file again.',
        ],
        'collection_upload_uncertain' => [
            'pl' => 'Nie można potwierdzić wyniku przywracania. Odśwież kolekcję przed ponownym przesłaniem pliku.',
            'en' => 'The restore result could not be confirmed. Refresh the collection before uploading the file again.',
        ],
        'ai_duplicates_response_invalid' => [
            'pl' => 'Gemini zwrócił nieprawidłowy wynik wyszukiwania powtórzeń. Spróbuj ponownie.',
            'en' => 'Gemini returned an invalid duplicate scan result. Try again.',
        ],
        'ai_duplicates_refused' => [
            'pl' => 'Gemini odrzucił żądanie wyszukania powtórzeń.',
            'en' => 'Gemini declined the duplicate scan request.',
        ],
        'ai_duplicates_scan_changed' => [
            'pl' => 'Kolekcja zmieniła się podczas sprawdzania. Uruchom wyszukiwanie ponownie.',
            'en' => 'The collection changed during the scan. Run the scan again.',
        ],
        'ai_provider_rate_limited' => [
            'pl' => 'Osiągnięto limit Gemini. Spróbuj ponownie później.',
            'en' => 'The Gemini request limit was reached. Try again later.',
        ],
        'ai_provider_timeout' => [
            'pl' => 'Gemini nie odpowiedział na czas. Spróbuj ponownie.',
            'en' => 'Gemini took too long to respond. Try again.',
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
    if (in_array(strtolower((string)($_SERVER['HTTPS'] ?? '')), ['on', '1'], true)) {
        return true;
    }
    // Only a configured HTTPS-terminating proxy can attest to the external scheme.
    $proxy = getenv('SAVEPOINT_TRUSTED_HTTPS_PROXY');
    return is_string($proxy) && filter_var($proxy, FILTER_VALIDATE_IP) !== false
        && $proxy === ($_SERVER['REMOTE_ADDR'] ?? null)
        && strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
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
    if (!@session_start()) {
        respond(503, ['ok' => false, 'error' => 'session_unavailable']);
    }
}

function closeSecureSession(): void
{
    if (session_status() === PHP_SESSION_ACTIVE && !@session_write_close()) {
        respond(503, ['ok' => false, 'error' => 'session_unavailable']);
    }
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
        if (!@session_regenerate_id(true)) {
            @session_destroy();
            respond(503, ['ok' => false, 'error' => 'session_unavailable']);
        }
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
    try {
        $db = new PDO($dsn, $config['username'], $config['password'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_TIMEOUT => 5,
        ]);
        // Enforce SQL column constraints independently of the hosting defaults.
        $db->exec("SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_ALL_TABLES')");
        return $db;
    } catch (PDOException $error) {
        error_log('Savepoint database connection is unavailable.');
        respond(503, ['ok' => false, 'error' => 'database_unavailable']);
    }
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
    // Keep counters in bounded shards while giving each address its own quota.
    $key = hash('sha256', @inet_pton($address) ?: $address);
    $slot = substr($key, 0, 2);
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
        $stored = stream_get_contents($file, 12288);
        if ($stored === false) {
            throw new RuntimeException('Could not read session check counter.');
        }
        $state = json_decode($stored, true);
        $counts = ($state['window'] ?? null) === $window && is_array($state['counts'] ?? null)
            ? $state['counts']
            : [];
        $count = (int)($counts[$key] ?? 0);
        if ($count >= 30 || ($count === 0 && count($counts) >= 128)) {
            return 60 - ($now % 60);
        }
        $counts[$key] = $count + 1;
        $record = json_encode(['window' => $window, 'counts' => $counts], JSON_THROW_ON_ERROR);
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
    // False means the submitted token was rejected. Null means verification
    // could not complete because of transport, provider, or configuration errors.
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
        $curlError = curl_errno($curl);
        curl_close($curl);
        if ($response === false) {
            error_log('Savepoint Turnstile transport error ' . $curlError . '.');
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
                'follow_location' => 0,
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
    if (!is_array($result) || !is_bool($result['success'] ?? null)) {
        return null;
    }
    if (!$result['success']) {
        $errors = $result['error-codes'] ?? null;
        // Only response-specific rejections count against the user. Provider
        // errors, bad configuration, and unfamiliar replies are unavailable.
        $rejections = ['invalid-input-response', 'missing-input-response', 'timeout-or-duplicate'];
        if (is_array($errors) && $errors !== []) {
            foreach ($errors as $code) {
                if (!in_array($code, $rejections, true)) {
                    return null;
                }
            }
            return false;
        }
        return null;
    }
    // A valid token must also belong to this deployment's login widget.
    return ($result['hostname'] ?? '') === $config['app_host']
        && ($result['action'] ?? '') === 'login';
}

function verifyLoginChallenge(array $request, array $config): ?bool
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

function publicCoverUrl(string $url): string
{
    // Older versions admitted URLs containing user information. Redact them
    // when projecting stored game rows for browser replies.
    $parts = parse_url($url);
    if (is_array($parts) && (array_key_exists('user', $parts) || array_key_exists('pass', $parts))) {
        return '';
    }
    return $url;
}

function gameFromDatabaseRow(array $row): array
{
    $game = [
        'id' => (string)$row['id'],
        'title' => (string)$row['title'],
        'platform' => (string)$row['platform'],
        'edition' => (string)$row['edition'],
        'coverUrl' => (string)($row['cover_url'] ?? ''),
        'status' => (string)$row['status'],
        'createdAt' => (int)$row['created_at'],
    ];
    $game['revision'] = hash('sha256', serialize([$game, (string)($row['updated_at'] ?? '')]));
    $game['coverUrl'] = publicCoverUrl($game['coverUrl']);
    return $game;
}

function listGames(PDO $db, ?array $ids = null): array
{
    if ($ids === null) {
        $statement = $db->query('SELECT ' . COLLECTION_FIELDS . ' FROM games');
    } else {
        if ($ids === []) {
            return [];
        }
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $statement = $db->prepare('SELECT ' . COLLECTION_FIELDS . ' FROM games WHERE id IN (' . $placeholders . ')');
        $statement->execute($ids);
    }
    return array_map('gameFromDatabaseRow', $statement->fetchAll());
}

function validCollectionText(string $text, int $limit): bool
{
    // SQL VARCHAR limits count Unicode code points. Reject invalid UTF-8 and
    // control characters before passing strings to the database.
    return strlen($text) <= $limit * 4
        && preg_match('/\A[^\x00-\x1f\x7f]{1,' . $limit . '}\z/uD', $text) === 1;
}

function normalizeCollectionPlatform(string $platform): string
{
    if (strlen($platform) > 1649) {
        throw new InvalidArgumentException('game_title_and_platform_required');
    }
    $platforms = array_values(array_unique(array_filter(
        array_map(static fn(string $value): string => trim($value, ' '), explode(',', $platform)),
        static fn(string $value): bool => $value !== ''
    )));
    if (count($platforms) > 50) {
        throw new InvalidArgumentException('game_title_and_platform_required');
    }
    // Compact separators preserve all preset combinations in existing databases.
    $platform = implode(', ', $platforms);
    if (!validCollectionText($platform, 400)) {
        $platform = implode(',', $platforms);
    }
    if (!validCollectionText($platform, 400)) {
        throw new InvalidArgumentException('game_title_and_platform_required');
    }
    return $platform;
}

function validCollectionId(mixed $id): bool
{
    return is_string($id) && preg_match('/\A[a-zA-Z0-9-]{1,36}\z/D', $id) === 1;
}

function normalizedGame(array $game): array
{
    $title = is_string($game['title'] ?? null) ? trim($game['title'], ' ') : '';
    if (!validCollectionText($title, 255)) {
        throw new InvalidArgumentException('game_title_and_platform_required');
    }
    $platform = normalizeCollectionPlatform(is_string($game['platform'] ?? null) ? $game['platform'] : '');
    $id = $game['id'] ?? null;
    if (!validCollectionId($id)) {
        throw new InvalidArgumentException('invalid_game_data');
    }
    $edition = $game['edition'] ?? 'Fizyczne';
    $status = $game['status'] ?? 'Do ogrania';
    if (!is_string($edition) || !is_string($status)) {
        throw new InvalidArgumentException('invalid_game_data');
    }
    $edition = trim($edition, ' ');
    $status = trim($status, ' ');
    $edition = $edition === '' ? 'Fizyczne' : $edition;
    $status = $status === '' ? 'Do ogrania' : $status;
    if (!validCollectionText($edition, 50) || !validCollectionText($status, 50)) {
        throw new InvalidArgumentException('invalid_game_data');
    }
    $cover = $game['coverUrl'] ?? '';
    if (!is_string($cover) || strlen($cover) > 65535) {
        throw new InvalidArgumentException('invalid_game_data');
    }
    $cover = trim($cover, ' ');
    if ($cover !== '') {
        $parts = parse_url($cover);
        if (!filter_var($cover, FILTER_VALIDATE_URL) || !is_array($parts)
            || !in_array(strtolower($parts['scheme'] ?? ''), ['http', 'https'], true)
            || array_key_exists('user', $parts) || array_key_exists('pass', $parts)) {
            throw new InvalidArgumentException('invalid_game_data');
        }
    }
    $createdAtInput = $game['createdAt'] ?? null;
    if ($createdAtInput === null) {
        $createdAt = (int)round(microtime(true) * 1000);
    } elseif (!is_int($createdAtInput) && !is_string($createdAtInput)) {
        throw new InvalidArgumentException('invalid_game_data');
    } else {
        $createdAt = filter_var($createdAtInput, FILTER_VALIDATE_INT, [
            'options' => ['min_range' => 0, 'max_range' => 9007199254740991],
        ]);
        if ($createdAt === false) {
            throw new InvalidArgumentException('invalid_game_data');
        }
    }
    return [
        'id' => $id,
        'title' => $title,
        'platform' => $platform,
        'edition' => $edition,
        'cover_url' => $cover,
        'status' => $status,
        'created_at' => $createdAt,
    ];
}

function findCollectionRow(PDO $db, string $id, bool $lock = false): ?array
{
    $query = 'SELECT ' . COLLECTION_FIELDS . ' FROM games WHERE id = :id';
    $statement = $db->prepare($query . ($lock ? ' FOR UPDATE' : ''));
    $statement->execute([':id' => $id]);
    $row = $statement->fetch();
    return is_array($row) ? $row : null;
}

function collectionRowMatches(array $row, array $game): bool
{
    foreach ($game as $field => $value) {
        if ((string)($row[$field] ?? '') !== (string)$value) {
            return false;
        }
    }
    return true;
}

final class CollectionConflict extends RuntimeException
{
}

function validCollectionRevision(mixed $revision): bool
{
    return is_string($revision) && preg_match('/\A[a-f0-9]{64}\z/D', $revision) === 1;
}

function inCollectionTransaction(PDO $db, callable $operation): mixed
{
    if (!$db->beginTransaction()) {
        throw new RuntimeException('Could not begin collection transaction.');
    }
    try {
        $value = $operation();
        if (!$db->commit()) {
            throw new RuntimeException('Could not commit collection transaction.');
        }
        return $value;
    } catch (Throwable $error) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $error;
    }
}

function saveCollectionGame(PDO $db, array $request): array
{
    if (!is_array($request['game'] ?? null)) {
        throw new InvalidArgumentException('game_data_missing');
    }
    // Cached clients can retry an identical create, but they cannot edit an
    // existing record without its revision.
    $mode = $request['mode'] ?? 'create';
    if ($mode !== 'create' && $mode !== 'edit') {
        throw new InvalidArgumentException('invalid_game_data');
    }
    $revision = $request['revision'] ?? null;
    if ($mode === 'edit' && !validCollectionRevision($revision)) {
        throw new CollectionConflict('collection_conflict');
    }
    $game = normalizedGame($request['game']);
    return inCollectionTransaction($db, static function () use ($db, $mode, $revision, $game): array {
        $existing = findCollectionRow($db, $game['id'], true);
        if ($mode === 'create') {
            if ($existing === null) {
                $db->prepare(COLLECTION_INSERT)->execute($game);
                return gameFromDatabaseRow(findCollectionRow($db, $game['id']));
            }
            if (collectionRowMatches($existing, $game)) {
                return gameFromDatabaseRow($existing);
            }
            throw new CollectionConflict('collection_conflict');
        }
        if ($existing === null || $existing['id'] !== $game['id']) {
            throw new CollectionConflict('collection_conflict');
        }
        $game['created_at'] = (int)$existing['created_at'];
        $current = gameFromDatabaseRow($existing);
        // An identical write can be retried without overriding subsequent data.
        if (collectionRowMatches($existing, $game)) {
            return $current;
        }
        if (!hash_equals($current['revision'], $revision)) {
            throw new CollectionConflict('collection_conflict');
        }
        unset($game['created_at']);
        // Keep revisions distinct when multiple edits share a database second,
        // including when a later edit restores the previous field values.
        $db->prepare('UPDATE games SET title = :title, platform = :platform, edition = :edition,
            cover_url = :cover_url, status = :status,
            updated_at = IF(updated_at >= CURRENT_TIMESTAMP, DATE_ADD(updated_at, INTERVAL 1 SECOND), CURRENT_TIMESTAMP)
            WHERE id = :id')->execute($game);
        return gameFromDatabaseRow(findCollectionRow($db, $game['id']));
    });
}

function deleteCollectionGame(PDO $db, mixed $id, mixed $revision): string
{
    if (!validCollectionId($id)) {
        throw new InvalidArgumentException('invalid_game_data');
    }
    if (!validCollectionRevision($revision)) {
        throw new CollectionConflict('collection_conflict');
    }
    return inCollectionTransaction($db, static function () use ($db, $id, $revision): string {
        $row = findCollectionRow($db, $id, true);
        if ($row === null) {
            return $id;
        }
        if ($row['id'] !== $id || !hash_equals(gameFromDatabaseRow($row)['revision'], $revision)) {
            throw new CollectionConflict('collection_conflict');
        }
        $db->prepare('DELETE FROM games WHERE id = :id')->execute(['id' => $id]);
        return $id;
    });
}

function importCollectionGames(PDO $db, string $mode, mixed $items): int
{
    if (!is_array($items) || !array_is_list($items) || count($items) > 5000) {
        throw new InvalidArgumentException('invalid_game_collection');
    }
    return inCollectionTransaction($db, static function () use ($db, $mode, $items): int {
        $inserted = 0;
        $seen = [];
        if ($mode === 'replace') {
            $db->exec('DELETE FROM games');
        }
        $insert = $db->prepare(COLLECTION_INSERT);
        foreach ($items as $index => $item) {
            if (!is_array($item)) {
                throw new InvalidArgumentException('invalid_game_data');
            }
            // Older local collections without IDs still import. The derived ID
            // and timestamp stay stable across retries of the same legacy file.
            if (!isset($item['id']) || $item['id'] === '') {
                $item['id'] = 'legacy-' . substr(hash('sha256', serialize([$index, $item])), 0, 29);
            }
            $item['createdAt'] ??= 0;
            $game = normalizedGame($item);
            $key = strtolower($game['id']);
            if (isset($seen[$key])) {
                throw new CollectionConflict('collection_import_conflict');
            }
            $seen[$key] = true;
            if ($mode === 'migrate' && ($existing = findCollectionRow($db, $game['id'], true)) !== null) {
                if (!collectionRowMatches($existing, $game)) {
                    throw new CollectionConflict('collection_import_conflict');
                }
                continue;
            }
            $insert->execute($game);
            $inserted++;
        }
        return $inserted;
    });
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
    // Resolve the game ID to its current saved URL before making a network request.
    $url = savedCoverUrl($db, $id);
    $referencedUrls = static function () use ($db): iterable {
        // Read current references only when the cache needs disk space. A
        // distinct SQL text sort could collapse URLs with different suffixes.
        $statement = $db->query("SELECT cover_url FROM games WHERE cover_url IS NOT NULL AND cover_url <> ''");
        while (($url = $statement->fetchColumn()) !== false) {
            yield (string)$url;
        }
    };
    $result = coverBackupStore($config)->backup($url, $referencedUrls);
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
        closeSecureSession();
        respond(200, ['ok' => true, 'backups' => []]);
    }
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $statement = $db->prepare('SELECT id, cover_url FROM games WHERE id IN (' . $placeholders . ')');
    $statement->execute($ids);
    $rows = $statement->fetchAll();
    closeSecureSession();
    $store = coverBackupStore($config);
    $readyByUrl = [];
    $backups = [];
    foreach ($rows as $row) {
        $url = publicCoverUrl((string)($row['cover_url'] ?? ''));
        if (!array_key_exists($url, $readyByUrl)) {
            // Check validated cache metadata once per saved URL across the batch.
            $readyByUrl[$url] = $url !== '' && $store->ready($url);
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
    if (!@session_regenerate_id(true)) {
        respond(503, ['ok' => false, 'error' => 'session_unavailable']);
    }
    $_SESSION['user_id'] = 1;
    $_SESSION['authenticated_at'] = time();
    $_SESSION['last_activity_at'] = time();
}

function handleLogin(PDO $db, array $config, array $request): void
{
    $loginSessionId = session_id();
    closeSecureSession();
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
    $captchaValid = verifyLoginChallenge($request, $config);
    if ($captchaValid === null) {
        respond(503, [
            'ok' => false,
            'error' => 'captcha_unavailable',
            'captcha' => issueCaptchaChallenge($config),
        ]);
    }
    if (!$captchaValid) {
        $captchaRetry = reserveCaptchaAttempt($db, $captchaBucket, $config);
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
    $games = listGames($db);
    if ($loginSessionId !== '') {
        startSecureSession();
        if (!hash_equals($loginSessionId, session_id())) {
            // Another request retired the session while the provider was busy.
            // Suppress any anonymous cookie created when PHP reopened it.
            header_remove('Set-Cookie');
            closeSecureSession();
            respond(409, ['ok' => false, 'error' => 'session_unavailable']);
        }
    }
    establishAuthenticatedSession();
    closeSecureSession();
    scheduleSuccessfulLoginNotification((string)$config['app_username'], $ip, time(), $config['app_origin']);
    respond(200, ['ok' => true, 'games' => $games]);
}

function handleLogout(): void
{
    // Remove server-side state and expire the cookie using its original scope.
    $_SESSION = [];
    $params = session_get_cookie_params();
    $cookieExpired = setcookie(session_name(), '', [
        'expires' => time() - 42000,
        'path' => $params['path'],
        'domain' => $params['domain'],
        'secure' => $params['secure'],
        'httponly' => $params['httponly'],
        'samesite' => $params['samesite'] ?? 'Strict',
    ]);
    if (!@session_destroy() || !$cookieExpired) {
        closeSecureSession();
        respond(503, ['ok' => false, 'error' => 'session_unavailable']);
    }
    respond(200, ['ok' => true]);
}

function collectionUploadResponse(string $action, array $config, array $request): void
{
    $directory = dirname(__DIR__, 2) . '/private/savepoint/collection';
    require_once $directory . '/TransferStore.php';
    $store = new \Savepoint\Collection\TransferStore($directory . '/uploads');
    $owner = hash_hmac('sha256', session_id(), (string)$config['app_password_hash']);
    $id = $request['uploadId'] ?? null;

    if ($action === 'collection-upload-start') {
        $data = $store->start($owner, $request['mode'] ?? null, $request['size'] ?? null);
        closeSecureSession();
        respond(200, ['ok' => true] + $data);
    }
    if ($action === 'collection-upload-chunk') {
        $offset = $store->append($owner, $id, $request['offset'] ?? null, $request['data'] ?? null);
        closeSecureSession();
        respond(200, ['ok' => true, 'offset' => $offset]);
    }
    if ($action === 'collection-upload-cancel') {
        $store->cancel($owner, $id);
        closeSecureSession();
        respond(200, ['ok' => true]);
    }
    $db = getDatabase($config);
    $inserted = $store->finish($owner, $id, static fn(string $mode, array $items): int => importCollectionGames($db, $mode, $items));
    closeSecureSession();
    respond(200, ['ok' => true, 'inserted' => $inserted, 'games' => listGames($db)]);
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
        $request = json_decode($rawRequest, true, 32);
        if (!is_array($request) || !str_starts_with(ltrim($rawRequest, " \t\r\n"), '{')) {
            respond(400, ['ok' => false, 'error' => 'invalid_request_data']);
        }
        $action = is_string($request['action'] ?? null) ? $request['action'] : '';
        if (in_array($action, ['ai-cover-search', 'ai-add', 'migrate', 'replace'], true)) {
            // Associative decoding can mistake an object with numeric keys or
            // an empty object for a list. Replacement requires a JSON array.
            $field = $action === 'ai-cover-search' ? 'platforms' : 'games';
            $original = json_decode($rawRequest, false, 32)->{$field} ?? null;
            if (!is_array($original)) {
                $request[$field] = null;
            }
        }
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
    if ($method === 'POST' && in_array($action, [
        'ai-status', 'ai-upload-start', 'ai-upload-chunk', 'ai-upload-cancel', 'ai-recognize', 'ai-cover-search', 'ai-add',
        'ai-duplicates-scan', 'ai-duplicates-apply',
    ], true)) {
        define('SAVEPOINT_AI_REQUEST', true);
        // An installation can omit the optional AI module. Existing sessions
        // stay untouched when its files are absent or unreadable.
        $module = dirname(__DIR__, 2) . '/private/savepoint/ai/Routes.php';
        if (!is_readable($module)) {
            $error = match ($action) {
                'ai-cover-search' => 'ai_cover_search_unavailable',
                'ai-duplicates-scan' => 'ai_duplicates_not_configured',
                default => 'ai_service_unavailable',
            };
            respond(503, ['ok' => false, 'error' => $error, 'errorId' => $error]);
        }
        require_once $module;
        \Savepoint\AI\Routes::dispatch($action, $request, $config);
    }
    startSecureSession();
    // Passive checks and image work enforce both deadlines without refreshing the idle timer.
    enforceSessionTimeout(!in_array($action, ['backup-cover', 'backup-cover-status'], true) && !$coverRequest && !$sessionCheck);
    if ($sessionCheck) {
        if ((int)($_SESSION['user_id'] ?? 0) !== 1) {
            respond(401, ['ok' => false, 'error' => 'authentication_required', 'authRequired' => true]);
        }
        closeSecureSession();
        respond(200, ['ok' => true]);
    }
    if ($method === 'POST' && $action === 'logout') {
        handleLogout();
    }
    $authenticated = (int)($_SESSION['user_id'] ?? 0) === 1;
    if ($coverRequest && !$authenticated) {
        respond(401, ['ok' => false, 'error' => 'authentication_required', 'authRequired' => true]);
    }

    // Release the session before connecting to the database for collection
    // reads and cover work. The login flow releases it before verification.
    if ($method === 'GET' || in_array($action, ['backup-cover', 'backup-cover-status'], true)) {
        closeSecureSession();
    }
    $config ??= loadLocalConfig();
    if (!$authenticated && $action !== 'login') {
        // The challenge contains a public site key. Opening the widget needs
        // neither a database connection nor another failure-rate write.
        respond(401, [
            'ok' => false,
            'error' => 'authentication_required',
            'authRequired' => true,
            'captcha' => issueCaptchaChallenge($config),
        ]);
    }
    if (in_array($action, [
        'collection-upload-start', 'collection-upload-chunk', 'collection-upload-finish', 'collection-upload-cancel',
    ], true)) {
        collectionUploadResponse($action, $config, $request);
    }
    $postActions = ['login', 'save', 'delete', 'migrate', 'replace', 'backup-cover', 'backup-cover-status'];
    if ($method === 'POST' && !in_array($action, $postActions, true)) {
        respond(400, ['ok' => false, 'error' => 'unknown_action']);
    }
    $db = getDatabase($config);

    if ($method === 'GET') {
        if ($coverRequest) {
            serveCoverBackup($db, $_GET['cover'], $config);
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
        $game = saveCollectionGame($db, $request);
        closeSecureSession();
        $data = ($request['delta'] ?? false) === true ? ['game' => $game] : ['games' => listGames($db)];
        respond(200, ['ok' => true] + $data);
    }
    if ($action === 'delete') {
        $id = deleteCollectionGame($db, $request['id'] ?? null, $request['revision'] ?? null);
        closeSecureSession();
        $data = ($request['delta'] ?? false) === true ? ['deletedId' => $id] : ['games' => listGames($db)];
        respond(200, ['ok' => true] + $data);
    }
    if ($action === 'migrate' || $action === 'replace') {
        $inserted = importCollectionGames($db, $action, $request['games'] ?? null);
        closeSecureSession();
        respond(200, ['ok' => true, 'inserted' => $inserted, 'games' => listGames($db)]);
    }

    respond(400, ['ok' => false, 'error' => 'unknown_action']);
} catch (InvalidArgumentException $error) {
    respond(422, ['ok' => false, 'error' => $error->getMessage()]);
} catch (CollectionConflict $error) {
    respond(409, ['ok' => false, 'error' => $error->getMessage()]);
} catch (\Savepoint\Collection\TransferError $error) {
    respond($error->status, ['ok' => false, 'error' => $error->getMessage()]);
} catch (PDOException $error) {
    error_log('Savepoint database operation failed.');
    respond(503, ['ok' => false, 'error' => 'database_unavailable']);
} catch (Throwable $error) {
    // Unexpected details may contain configuration or collection data.
    error_log('Savepoint API operation failed.');
    respond(500, ['ok' => false, 'error' => 'server_error']);
}
