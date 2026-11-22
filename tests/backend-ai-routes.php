<?php
declare(strict_types=1);

// Real loopback HTTP and file-backed sessions, with synthetic configuration
// and a namespaced cURL transport. No private files or external calls are used.
if (PHP_SAPI !== 'cli' || PHP_VERSION_ID < 80100) {
    fwrite(STDERR, "These isolated tests require PHP CLI 8.1 or newer.\n");
    exit(1);
}

function routeExpect(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

function removeRouteTree(string $path): void
{
    if (!is_dir($path)) return;
    foreach (new FilesystemIterator($path) as $entry) {
        if ($entry->isDir() && !$entry->isLink()) removeRouteTree($entry->getPathname());
        else unlink($entry->getPathname());
    }
    rmdir($path);
}

$source = dirname(__DIR__);
$root = sys_get_temp_dir() . '/savepoint-ai-routes-' . bin2hex(random_bytes(8));
$public = $root . '/public';
$private = $root . '/private/savepoint/ai';
$sessions = $root . '/sessions';
$server = null;
$pipes = [];

try {
    foreach ([$public . '/api', $private, $sessions] as $directory) mkdir($directory, 0700, true);
    copy($source . '/api/games.php', $public . '/api/games.php');
    $origin = 'https://library.savepoint.test';
    $application = ['host' => '127.0.0.1', 'port' => 1, 'database' => 'isolated', 'username' => 'isolated',
        'password' => 'synthetic-credential', 'app_origin' => $origin, 'app_username' => 'SyntheticCollector',
        'app_password_salt' => str_repeat('ab', 16), 'app_password_hash' => str_repeat('cd', 32),
        'app_password_iterations' => 1, 'turnstile_site_key' => 'synthetic-public-site-key',
        'turnstile_secret_key' => 'synthetic-credential'];
    file_put_contents(dirname($private) . '/config.local.php', '<?php return ' . var_export($application, true) . ';');

    putenv('SAVEPOINT_TRUSTED_HTTPS_PROXY');
    foreach (['Routes.php', 'PhotoImport.php', 'CoverFinder.php', 'ConfirmedGames.php'] as $file) {
        copy($source . '/server/ai/' . $file, $private . '/' . $file);
    }

    // Shadow only the outbound provider transport; all route/session/upload
    // implementation and the API entry point remain the actual source files.
    $router = <<<'PHP'
<?php
namespace Savepoint\AI {
    function curl_init(?string $url = null): object { return (object)['url' => $url, 'options' => [], 'status' => 200]; }
    function curl_setopt_array(object $handle, array $options): bool { $handle->options = $options; return true; }
    function providerReply(object $handle, array $response, int $status = 200): bool
    {
        $handle->status = $status;
        $body = json_encode($response, JSON_THROW_ON_ERROR);
        return ($handle->options[CURLOPT_WRITEFUNCTION])($handle, $body) === strlen($body);
    }
    function curl_exec(object $handle): bool
    {
        $root = getenv('SAVEPOINT_AI_ROUTE_ROOT');
        $options = $handle->options;
        if (($options[CURLOPT_POST] ?? null) !== true || ($options[CURLOPT_FOLLOWLOCATION] ?? null) !== false
            || ($options[CURLOPT_SSL_VERIFYPEER] ?? null) !== true || ($options[CURLOPT_SSL_VERIFYHOST] ?? null) !== 2) {
            throw new \RuntimeException('Provider requests must use POST, verify TLS and disallow redirects.');
        }
        $headers = array_map('strtolower', $options[CURLOPT_HTTPHEADER]);
        $post = $options[CURLOPT_POSTFIELDS];
        if ($handle->url === 'https://id.twitch.tv/oauth2/token') {
            file_put_contents($root . '/provider-calls', "oauth\n", FILE_APPEND);
            parse_str($post, $form);
            if (($form['client_id'] ?? null) !== 'synthetic-credential-igdb-client-id'
                || ($form['client_secret'] ?? null) !== 'synthetic-credential-igdb-client-secret'
                || ($form['grant_type'] ?? null) !== 'client_credentials'
                || !in_array('content-type: application/x-www-form-urlencoded', $headers, true)
                || preg_grep('/^(authorization|x-goog-api-key):/', $headers) !== []) {
                throw new \RuntimeException('Invalid OAuth request.');
            }
            return providerReply($handle, ['access_token' => 'synthetic-credential-twitch-token',
                'token_type' => 'bearer', 'expires_in' => 3600]);
        }
        if ($handle->url === 'https://api.igdb.com/v4/games') {
            file_put_contents($root . '/provider-calls', "igdb\n", FILE_APPEND);
            if (!in_array('client-id: synthetic-credential-igdb-client-id', $headers, true)
                || !in_array('authorization: bearer synthetic-credential-twitch-token', $headers, true)
                || preg_grep('/^x-goog-api-key:/', $headers) !== [] || str_contains($post, 'synthetic-credential')
                || !str_contains($post, 'name ~ "Synthetic game"')) {
                throw new \RuntimeException('Invalid IGDB request.');
            }
            if (is_file($root . '/catalogue-unavailable')) {
                return providerReply($handle, ['error' => 'synthetic-credential-private-upstream-detail'], 503);
            }
            if (is_file($root . '/catalogue-empty')) return providerReply($handle, []);
            if (is_file($root . '/catalogue-wait')) {
                file_put_contents($root . '/catalogue-started', 'started');
                $deadline = microtime(true) + 5;
                while (!is_file($root . '/catalogue-release') && microtime(true) < $deadline) usleep(10000);
            }
            return providerReply($handle, [[
                'id' => 7, 'name' => 'Synthetic game', 'slug' => 'synthetic-game',
                'cover' => ['id' => 8, 'image_id' => 'cofixture'],
                'platforms' => [['id' => 6, 'name' => 'PC (Microsoft Windows)']],
                'first_release_date' => 978307200, 'game_type' => 0,
            ]]);
        }
        if ($handle->url === 'https://en.wikipedia.org/w/api.php') {
            file_put_contents($root . '/provider-calls', "wikipedia\n", FILE_APPEND);
            parse_str($post, $form);
            $titles = explode('|', $form['titles'] ?? '');
            if (($form['action'] ?? null) !== 'query' || ($form['prop'] ?? null) !== 'pageimages|pageprops'
                || !in_array('content-type: application/x-www-form-urlencoded', $headers, true)
                || !in_array('Synthetic game', $titles, true)
                || array_diff($titles, ['Synthetic game', 'Synthetic game (video game)']) !== []
                || preg_grep('/^(client-id|authorization|x-goog-api-key):/', $headers) !== []
                || str_contains($post, 'synthetic-credential')) {
                throw new \RuntimeException('Invalid anonymous Wikipedia request.');
            }
            if (is_file($root . '/catalogue-unavailable')) {
                return providerReply($handle, ['error' => 'synthetic-credential-private-upstream-detail'], 503);
            }
            return providerReply($handle, ['query' => ['pages' => [[
                'ns' => 0, 'pageid' => 101, 'title' => 'Synthetic game', 'pageimage' => 'Fixture_cover.jpg',
                'pageprops' => ['wikibase-shortdesc' => '2001 video game'],
                'thumbnail' => ['source' => 'https://upload.wikimedia.org/wikipedia/en/thumb/a/ab/Fixture_cover.jpg/220px-Fixture_cover.jpg',
                    'width' => 220, 'height' => 300],
            ]]]]);
        }
        if ($handle->url !== 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent'
            || !in_array('x-goog-api-key: synthetic-credential-for-route-tests-only', $headers, true)
            || preg_grep('/^(client-id|authorization):/', $headers) !== []) {
            file_put_contents($root . '/provider-calls', "unexpected\n", FILE_APPEND);
            throw new \RuntimeException('Unexpected provider request.');
        }
        $payload = json_decode($post, true);
        if (isset($payload['generationConfig']['responseJsonSchema']['properties']['matches'])) {
            file_put_contents($root . '/provider-calls', "cover-check\n", FILE_APPEND);
            $offered = json_decode($payload['contents'][0]['parts'][0]['text'], true);
            $option = $offered[0] ?? [];
            if (count($offered) !== 1 || !in_array($option['provider'] ?? null, ['igdb', 'wikipedia'], true)
                || !is_int($option['index'] ?? null)
                || ($option['title'] ?? null) !== 'Synthetic game' || ($option['platform'] ?? null) !== 'PC'
                || str_contains($post, 'synthetic-credential') || str_contains($post, 'images.igdb.com')
                || str_contains($post, 'upload.wikimedia.org') || count($payload['contents'][0]['parts']) !== 1) {
                throw new \RuntimeException('Invalid Gemini cover metadata.');
            }
            return providerReply($handle, ['candidates' => [[
                'content' => ['parts' => [['text' => json_encode(['matches' => [$option['index']]])]]], 'finishReason' => 'STOP',
            ]]]);
        }
        file_put_contents($root . '/provider-calls', "recognize\n", FILE_APPEND);
        file_put_contents($root . '/transport-started', 'started');
        if (is_file($root . '/transport-wait')) {
            $deadline = microtime(true) + 5;
            while (!is_file($root . '/transport-release') && microtime(true) < $deadline) usleep(10000);
        }
        $result = json_encode(['candidates' => [['title' => 'Synthetic game', 'platform' => 'PC',
            'confidence' => 'high', 'note' => '']], 'notes' => '']);
        // Return the current Gemini envelope without changing any route code.
        return providerReply($handle, ['candidates' => [[
            'content' => ['parts' => [['text' => $result]]], 'finishReason' => 'STOP'
        ]]]);
    }
    function curl_getinfo(object $handle, int $option = 0): int { return $handle->status; }
    function curl_close(object $handle): void {}
}
namespace {
    // Model the web server's TLS signal independently of incoming headers.
    if (($_SERVER['HTTP_X_TEST_CONNECTION'] ?? '') !== 'cleartext') $_SERVER['HTTPS'] = 'on';
    require __DIR__ . '/public/api/games.php';
}
PHP;
    file_put_contents($root . '/router.php', $router);
    $listener = stream_socket_server('tcp://127.0.0.1:0', $error, $message);
    routeExpect(is_resource($listener), 'Could not reserve a loopback test port.');
    $address = stream_socket_get_name($listener, false);
    fclose($listener);
    $command = [PHP_BINARY, '-d', 'display_errors=0', '-d', 'log_errors=1',
        '-d', 'session.save_path=' . $sessions, '-d', 'session.gc_probability=0',
        '-d', 'session.use_cookies=1', '-d', 'session.use_strict_mode=0',
        '-S', $address, '-t', $public, $root . '/router.php'];
    $environment = getenv();
    $environment['SAVEPOINT_AI_ROUTE_ROOT'] = $root;
    $server = proc_open($command, [0 => ['pipe', 'r'], 1 => ['file', $root . '/server.log', 'a'],
        2 => ['file', $root . '/server.log', 'a']], $pipes, $root, $environment);
    routeExpect(is_resource($server), 'Could not start the isolated PHP HTTP server.');
    fclose($pipes[0]);
    $deadline = microtime(true) + 3;
    do {
        $ready = @stream_socket_client('tcp://' . $address, $error, $message, 0.1);
        if ($ready !== false) { fclose($ready); break; }
        usleep(10000);
    } while (microtime(true) < $deadline);
    routeExpect($ready !== false, 'The isolated PHP HTTP server did not start.');

    $send = static function (string $body, ?string $cookie = null, array $overrides = [], bool $chunked = false) use ($address) {
        $socket = stream_socket_client('tcp://' . $address, $error, $message, 2);
        routeExpect(is_resource($socket), 'Could not connect to isolated API.');
        stream_set_timeout($socket, 8);
        $headers = ['Host' => 'library.savepoint.test', 'X-Forwarded-Proto' => 'https',
            'Origin' => 'https://library.savepoint.test', 'Content-Type' => 'application/json',
            'Accept-Language' => 'en', 'Connection' => 'close'];
        if ($cookie !== null) $headers['Cookie'] = 'savepoint_session_v3=' . $cookie;
        foreach ($overrides as $name => $value) {
            if ($value === null) unset($headers[$name]); else $headers[$name] = $value;
        }
        $headers[$chunked ? 'Transfer-Encoding' : 'Content-Length'] = $chunked ? 'chunked' : (string)strlen($body);
        $wire = "POST /api/games.php HTTP/1.1\r\n";
        foreach ($headers as $name => $value) $wire .= $name . ': ' . $value . "\r\n";
        $wire .= "\r\n" . ($chunked ? dechex(strlen($body)) . "\r\n" . $body . "\r\n0\r\n\r\n" : $body);
        routeExpect(fwrite($socket, $wire) === strlen($wire), 'Could not send the complete test request.');
        return $socket;
    };
    $receive = static function ($socket): array {
        $wire = stream_get_contents($socket);
        $metadata = stream_get_meta_data($socket);
        fclose($socket);
        routeExpect(!$metadata['timed_out'] && is_string($wire), 'The isolated API request timed out.');
        $parts = explode("\r\n\r\n", $wire, 2);
        routeExpect(count($parts) === 2 && preg_match('/\AHTTP\/1\.[01] ([0-9]{3})/', $parts[0], $match) === 1,
            'Expected a complete HTTP response.');
        routeExpect(preg_match('/^Set-Cookie:/mi', $parts[0]) !== 1, 'An AI response must never send Set-Cookie.');
        $data = json_decode($parts[1], true);
        routeExpect(is_array($data), 'The API response must contain JSON only.');
        routeExpect(!str_contains($parts[1], 'synthetic-credential') && !str_contains($parts[1], 'config.local.php')
            && !str_contains($parts[1], '/private/'), 'The API response must not expose credentials or private paths.');
        return ['status' => (int)$match[1], 'data' => $data, 'headers' => $parts[0]];
    };
    $request = static fn(array $body, ?string $cookie = null, array $headers = []): array =>
        $receive($send(json_encode($body, JSON_UNESCAPED_SLASHES), $cookie, $headers));
    $writeSession = static function (string $id, array $values) use ($sessions): string {
        $body = '';
        foreach ($values as $key => $value) $body .= $key . '|' . serialize($value);
        file_put_contents($sessions . '/sess_' . $id, $body);
        return $body;
    };
    $now = time();
    $valid = ['user_id' => 1, 'authenticated_at' => $now - 120, 'last_activity_at' => $now - 60];
    $manualCover = ['action' => 'ai-cover-search', 'title' => 'Synthetic game', 'platforms' => ['PC']];
    $actions = ['ai-status', 'ai-upload-start', 'ai-upload-chunk', 'ai-upload-cancel', 'ai-recognize', 'ai-cover-search', 'ai-add'];
    foreach ($actions as $action) {
        foreach ([null, 'invalid.id', 'uninitialized-ai-session'] as $cookie) {
            $result = $request(['action' => $action], $cookie);
            routeExpect($result['status'] === 401 && ($result['data']['authRequired'] ?? null) === true,
                'Every AI action must require an initialized authenticated cookie.');
        }
        $result = $request(['action' => $action], null, ['Cookie' => 'savepoint_session_v3[]=array']);
        routeExpect($result['status'] === 401, 'Array cookies must fail closed.');
    }
    echo "PASS: all seven AI actions reject absent, malformed, array and uninitialized cookies without Set-Cookie\n";

    $invalidSessions = [[], ['user_id' => 2], ['user_id' => 1],
        ['user_id' => 1, 'authenticated_at' => $now - 2000, 'last_activity_at' => $now - 1801],
        ['user_id' => 1, 'authenticated_at' => $now - 28801, 'last_activity_at' => $now - 1],
        ['user_id' => 1, 'authenticated_at' => $now + 100, 'last_activity_at' => $now + 100],
        ['user_id' => 1, 'authenticated_at' => $now - 50, 'last_activity_at' => $now - 51]];
    foreach ($invalidSessions as $index => $values) {
        $id = 'invalid-state-' . $index;
        $original = $writeSession($id, $values);
        foreach ($actions as $action) {
            routeExpect($request(['action' => $action], $id)['status'] === 401,
                'Incomplete, foreign, expired or inconsistent session state must fail closed.');
            routeExpect(file_get_contents($sessions . '/sess_' . $id) === $original,
                'Rejected AI sessions must not rotate, clear or refresh the file-backed session.');
        }
    }
    echo "PASS: idle/absolute expiry and malformed authentication state fail closed without changing sessions\n";

    $cookie = 'valid-ai-session';
    $original = $writeSession($cookie, $valid);
    $result = $request(['action' => 'ai-status'], $cookie);
    routeExpect($result['status'] === 200 && $result['data']['ok'] === true && $result['data']['available'] === false,
        'An authenticated deployment without an AI key must report available=false.');
    routeExpect(array_diff(array_keys($result['data']), ['ok', 'available', 'session']) === [], 'Status must expose no provider configuration.');
    routeExpect(($result['data']['session']['authenticatedAt'] ?? null) === $valid['authenticated_at'], 'Status must carry existing session deadlines.');
    foreach (array_slice($actions, 1) as $action) {
        $result = $request($action === 'ai-cover-search' ? $manualCover : ['action' => $action], $cookie);
        routeExpect($result['status'] === 503, 'Disabled AI actions must stop before database access.');
        if ($action !== 'ai-add') routeExpect(file_get_contents($sessions . '/sess_' . $cookie) === $original,
            'Read-only AI routes must not refresh or rewrite the authenticated session.');
    }
    echo "PASS: no-key status is safe and AI lookups stay read-only without opening a database connection\n";

    foreach (['https://evil.example', 'null', 'http://library.savepoint.test',
        'https://library.savepoint.test:444', 'https://user@library.savepoint.test'] as $origin) {
        routeExpect($request(['action' => 'ai-status'], $cookie, ['Origin' => $origin])['status'] === 403,
            'AI requests must reject unauthorized origins.');
    }
    routeExpect($request(['action' => 'ai-status'], $cookie, ['Origin' => null])['status'] === 403, 'Missing Origin and Referer must be rejected.');
    routeExpect($request(['action' => 'ai-status'], $cookie, ['Origin' => null, 'Referer' => 'https://library.savepoint.test/'])['status'] === 200,
        'The existing same-origin Referer fallback must work.');
    routeExpect($request(['action' => 'ai-status'], $cookie, ['X-Test-Connection' => 'cleartext'])['status'] === 426,
        'A header claiming HTTPS cannot bypass the web server TLS check.');
    routeExpect($request(['action' => 'ai-status'], $cookie, ['Content-Type' => 'text/plain'])['status'] === 415, 'AI requests require JSON.');
    routeExpect($receive($send('{', $cookie))['status'] === 400, 'Malformed JSON must be rejected before sessions open.');
    $base = '{"action":"ai-status","padding":"';
    $atCap = $base . str_repeat('x', 65536 - strlen($base) - 2) . '"}';
    routeExpect(strlen($atCap) === 65536 && $receive($send($atCap, $cookie))['status'] === 200, 'Exactly 64 KiB of JSON must remain accepted.');
    routeExpect($receive($send($atCap . ' ', $cookie))['status'] === 413, 'Content-Length above 64 KiB must be rejected.');
    routeExpect($receive($send($atCap . ' ', $cookie, [], true))['status'] === 413, 'Chunked input must not bypass the 64 KiB body cap.');
    echo "PASS: transport, origin, JSON and 64 KiB limits precede sessions, including chunked-body overflow\n";

    // The fixture key is synthetic and never reaches a real HTTP transport.
    $configuration = ['enabled' => true, 'api_key' => 'synthetic-credential-for-route-tests-only',
        'model' => 'gemini-3.5-flash-lite', 'hourly_limit' => 100];
    file_put_contents($private . '/config.local.php', '<?php return ' . var_export($configuration, true) . ';');

    // Exercise manual lookup before any application/database configuration exists.
    $original = $writeSession($cookie, $valid);
    foreach ([
        ['title' => null], ['title' => 42], ['title' => ['Synthetic game']], ['title' => '   '],
        ['title' => str_repeat('a', 256)], ['title' => str_repeat('𠀀', 256)],
        ['platforms' => null], ['platforms' => 'PC'], ['platforms' => []],
        ['platforms' => (object)['0' => 'PC']], ['platforms' => ['console' => 'PC']],
        ['platforms' => [false]], ['platforms' => [['PC']]],
        ['platforms' => ['PC', 'PC']], ['platforms' => ['PC', 'Unknown console']],
        ['platforms' => ['pc']], ['platforms' => [' PC ']], ['platforms' => array_fill(0, 36, 'PC')],
    ] as $invalid) {
        $result = $request($invalid + $manualCover, $cookie);
        routeExpect($result['status'] === 422
            && ($result['data']['error'] ?? null) === 'Enter a valid game title and select at least one platform.'
            && ($result['data']['errorDefault'] ?? null) === 'Podaj poprawny tytuł gry i wybierz przynajmniej jedną platformę.',
            'Expected a localized manual lookup validation error for ' . json_encode($invalid, JSON_UNESCAPED_UNICODE));
    }
    routeExpect(!is_file($root . '/provider-calls') && !is_file($private . '/manual-cover-budget.json')
        && !is_dir($private . '/uploads'), 'Invalid input must not use the providers, the quota or photo storage.');
    routeExpect(file_get_contents($sessions . '/sess_' . $cookie) === $original,
        'Invalid manual lookups must leave the session unchanged.');
    echo "PASS: manual cover lookup validates titles and JSON console arrays before provider or quota work\n";

    $wikiImage = 'https://upload.wikimedia.org/wikipedia/en/thumb/a/ab/Fixture_cover.jpg/220px-Fixture_cover.jpg';
    $wikiArticle = 'https://en.wikipedia.org/?curid=101';
    $expectWikiCover = static function (array $candidate) use ($wikiImage, $wikiArticle): bool {
        return ($candidate['coverUrl'] ?? null) === $wikiImage && ($candidate['coverSource'] ?? null) === 'wikipedia'
            && ($candidate['coverSourceUrl'] ?? null) === $wikiArticle;
    };
    $result = $request($manualCover, $cookie);
    routeExpect($result['status'] === 200 && $expectWikiCover($result['data'])
        && file($root . '/provider-calls', FILE_IGNORE_NEW_LINES) === ['wikipedia', 'cover-check'],
        'An authenticated manual lookup can find a verified Wikipedia cover without private catalogue credentials.');
    unlink($root . '/provider-calls');
    $coverConfiguration = ['igdb_client_id' => 'synthetic-credential-igdb-client-id',
        'igdb_client_secret' => 'synthetic-credential-igdb-client-secret'];
    file_put_contents($private . '/cover-config.local.php', '<?php return ' . var_export($coverConfiguration, true) . ';');
    $result = $request(['title' => '  Synthetic game  ', 'platforms' => ['Xbox 360', 'PC']] + $manualCover, $cookie);
    routeExpect($result['status'] === 200 && ($result['data']['ok'] ?? null) === true
        && ($result['data']['coverUrl'] ?? null) === 'https://images.igdb.com/igdb/image/upload/t_cover_big/cofixture.jpg'
        && ($result['data']['coverSource'] ?? null) === 'igdb'
        && ($result['data']['coverSourceUrl'] ?? null) === 'https://www.igdb.com/games/synthetic-game',
        'Manual lookup must return the verified cover for a matching selected console.');
    routeExpect(file($root . '/provider-calls', FILE_IGNORE_NEW_LINES) === ['oauth', 'igdb', 'cover-check'],
        'Manual lookup must reuse the catalogue and metadata selection without photo inference.');
    $result = $request(['platforms' => ['Xbox 360']] + $manualCover, $cookie);
    routeExpect($result['status'] === 200 && ($result['data']['coverUrl'] ?? null) === ''
        && !isset($result['data']['coverSearch']) && !isset($result['data']['coverSource']),
        'A cover for an unselected console must not populate the manual draft.');
    $calls = file($root . '/provider-calls', FILE_IGNORE_NEW_LINES);
    routeExpect($calls === ['oauth', 'igdb', 'cover-check', 'igdb'], 'A known console mismatch must skip the fallback and Gemini check.');
    file_put_contents($root . '/catalogue-empty', 'empty');
    $result = $request($manualCover, $cookie);
    unlink($root . '/catalogue-empty');
    $calls = [...$calls, 'igdb', 'wikipedia', 'cover-check'];
    routeExpect($result['status'] === 200 && $expectWikiCover($result['data'])
        && file($root . '/provider-calls', FILE_IGNORE_NEW_LINES) === $calls,
        'Without a matching primary cover, manual lookup returns the verified Wikipedia fallback.');
    $result = $request(['title' => str_repeat('𠀀', 80), 'platforms' => ['Inna']] + $manualCover, $cookie);
    routeExpect($result['status'] === 200 && ($result['data']['coverUrl'] ?? null) === ''
        && file($root . '/provider-calls', FILE_IGNORE_NEW_LINES) === $calls,
        'An 80-character, 320-byte title and the Other console must be accepted without suggesting an unverified cover.');
    file_put_contents($root . '/catalogue-unavailable', 'unavailable');
    $unavailable = $request($manualCover, $cookie);
    unlink($root . '/catalogue-unavailable');
    routeExpect($unavailable['status'] === 200 && ($unavailable['data']['coverSearch'] ?? null) === 'unavailable'
        && ($unavailable['data']['coverUrl'] ?? null) === '', 'When primary and fallback lookups both fail, the route returns an unavailable result safely.');
    routeExpect(file_get_contents($sessions . '/sess_' . $cookie) === $original && !is_dir($private . '/uploads'),
        'Completed manual lookups must neither rewrite session activity nor create photo uploads.');
    echo "PASS: manual cover lookup prioritizes primary artwork, then uses Wikipedia when needed, without photo or database access\n";

    file_put_contents($root . '/catalogue-wait', 'wait');
    $inFlight = $send(json_encode($manualCover), $cookie);
    $deadline = microtime(true) + 3;
    while (!is_file($root . '/catalogue-started') && microtime(true) < $deadline) usleep(10000);
    routeExpect(is_file($root . '/catalogue-started'), 'Manual lookup must enter the catalogue fixture.');
    $sessionFile = fopen($sessions . '/sess_' . $cookie, 'r+b');
    routeExpect($sessionFile !== false && flock($sessionFile, LOCK_EX | LOCK_NB),
        'Manual lookup must release the session lock before waiting for the catalogue.');
    $writeSession($cookie, []);
    flock($sessionFile, LOCK_UN); fclose($sessionFile);
    file_put_contents($root . '/catalogue-release', 'release');
    $result = $receive($inFlight);
    $writeSession($cookie, $valid);
    routeExpect($result['status'] === 401 && ($result['data']['authRequired'] ?? null) === true && !isset($result['data']['coverUrl']),
        'A completed manual lookup must not disclose a result after logout.');

    $calls = file($root . '/provider-calls', FILE_IGNORE_NEW_LINES);
    $limitedConfiguration = ['hourly_limit' => 1] + $configuration;
    file_put_contents($private . '/config.local.php', '<?php return ' . var_export($limitedConfiguration, true) . ';');
    $result = $request($manualCover, $cookie);
    routeExpect($result['status'] === 429 && ($result['data']['error'] ?? null) === 'The cover search limit has been reached. Try again later.'
        && preg_match('/^Retry-After: [1-9][0-9]*\r?$/mi', $result['headers']) === 1
        && file($root . '/provider-calls', FILE_IGNORE_NEW_LINES) === $calls,
        'Exhausting the manual quota must return Retry-After before proceeding to any provider.');
    file_put_contents($private . '/config.local.php', '<?php return ' . var_export($configuration, true) . ';');
    foreach (['catalogue-wait', 'catalogue-started', 'catalogue-release'] as $file) unlink($root . '/' . $file);
    unlink($private . '/cover-config.local.php');
    unlink($private . '/igdb-token.json');
    echo "PASS: manual quota is enforced before provider calls and session logout suppresses late results\n";

    routeExpect($request(['action' => 'ai-status'], $cookie)['data']['available'] === true,
        'Synthetic Gemini configuration must enable recognition without cover credentials.');
    $original = $writeSession($cookie, $valid);
    foreach ([
        [['action' => 'ai-upload-start', 'mime' => 'image/png', 'size' => 10], 400],
        [['action' => 'ai-upload-start', 'mime' => 'image/jpeg', 'size' => 2097153], 413],
        [['action' => 'ai-upload-chunk', 'uploadId' => '../outside', 'offset' => 0, 'data' => 'eA=='], 400],
        [['action' => 'ai-recognize', 'uploadId' => '../outside'], 400],
        [['action' => 'ai-upload-cancel', 'uploadId' => '../outside'], 400],
    ] as [$body, $status]) {
        routeExpect($request($body, $cookie)['status'] === $status, 'Configured photo routes must reject invalid input safely.');
        routeExpect(file_get_contents($sessions . '/sess_' . $cookie) === $original,
            'Configured photo route errors must leave session activity unchanged.');
    }
    routeExpect($request(['action' => 'ai-add'], $cookie)['status'] === 422,
        'The final add route must reject a missing batch before connecting to a database.');
    $saved = file_get_contents($sessions . '/sess_' . $cookie);
    routeExpect(is_string($saved) && $saved !== $original && str_contains($saved, 'authenticated_at|i:' . $valid['authenticated_at'] . ';'),
        'Only the final add route may persist activity while preserving the authentication epoch.');
    echo "PASS: configured route errors remain cookie-free and only the final add route persists session activity\n";
    $jpeg = base64_decode('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==', true);
    routeExpect(is_string($jpeg), 'Could not decode the synthetic JPEG fixture.');
    foreach (['no-cover-config', 'unchanged', 'catalogue-unavailable', 'logout', 'new-login'] as $mode) {
        if ($mode === 'unchanged') {
            file_put_contents($private . '/cover-config.local.php', '<?php return ' . var_export($coverConfiguration, true) . ';');
            $result = $request(['action' => 'ai-status'], $cookie);
            routeExpect($result['status'] === 200 && $result['data']['available'] === true
                && array_diff(array_keys($result['data']), ['ok', 'available', 'session']) === [],
                'Status must remain independent of private cover configuration.');
        }
        $original = $writeSession($cookie, $valid);
        foreach (['transport-started', 'transport-release', 'provider-calls', 'catalogue-unavailable'] as $file) {
            if (is_file($root . '/' . $file)) unlink($root . '/' . $file);
        }
        if ($mode === 'catalogue-unavailable') file_put_contents($root . '/catalogue-unavailable', 'unavailable');
        file_put_contents($root . '/transport-wait', 'wait');
        $start = $request(['action' => 'ai-upload-start', 'mime' => 'image/jpeg', 'size' => strlen($jpeg)], $cookie);
        routeExpect($start['status'] === 200 && is_string($start['data']['uploadId'] ?? null), 'The authenticated fixture upload must begin.');
        $id = $start['data']['uploadId'];
        routeExpect($request(['action' => 'ai-upload-chunk', 'uploadId' => $id, 'offset' => 0, 'data' => base64_encode($jpeg)], $cookie)['status'] === 200,
            'The authenticated JPEG fixture must upload.');
        $inFlight = $send(json_encode(['action' => 'ai-recognize', 'uploadId' => $id]), $cookie);
        $deadline = microtime(true) + 3;
        while (!is_file($root . '/transport-started') && microtime(true) < $deadline) usleep(10000);
        routeExpect(is_file($root . '/transport-started'), 'Recognition must enter the isolated provider transport.');
        routeExpect(!is_file($private . '/uploads/' . $id . '.part') && !is_file($private . '/uploads/' . $id . '.json'),
            'Recognition must claim and remove the uploaded photo before calling the provider.');
        $sessionFile = fopen($sessions . '/sess_' . $cookie, 'r+b');
        routeExpect($sessionFile !== false && flock($sessionFile, LOCK_EX | LOCK_NB),
            'Recognition must release the session lock before waiting for the provider.');
        routeExpect(stream_get_contents($sessionFile) === $original, 'Recognition must leave session activity unchanged while waiting.');
        if (in_array($mode, ['logout', 'new-login'], true)) {
            $replacement = $mode === 'logout' ? [] : array_replace($valid, ['authenticated_at' => $now - 10, 'last_activity_at' => $now - 5]);
            $writeSession($cookie, $replacement);
        }
        flock($sessionFile, LOCK_UN); fclose($sessionFile);
        file_put_contents($root . '/transport-release', 'release');
        $result = $receive($inFlight);
        $calls = file($root . '/provider-calls', FILE_IGNORE_NEW_LINES);
        if ($mode === 'unchanged') {
            $candidate = $result['data']['candidates'][0] ?? [];
            routeExpect($result['status'] === 200 && ($candidate['title'] ?? null) === 'Synthetic game'
                && ($candidate['coverUrl'] ?? null) === 'https://images.igdb.com/igdb/image/upload/t_cover_big/cofixture.jpg'
                && ($candidate['coverSource'] ?? null) === 'igdb'
                && ($candidate['coverSourceUrl'] ?? null) === 'https://www.igdb.com/games/synthetic-game',
                'A current authenticated session must receive the game and its selected cover.');
            routeExpect($calls === ['recognize', 'oauth', 'igdb', 'cover-check'],
                'The authenticated route must run private OAuth and the catalogue before the Gemini cover check.');
        } elseif ($mode === 'no-cover-config') {
            $candidate = $result['data']['candidates'][0] ?? [];
            routeExpect($result['status'] === 200 && ($candidate['title'] ?? null) === 'Synthetic game'
                && $expectWikiCover($candidate) && $calls === ['recognize', 'wikipedia', 'cover-check'],
                'Photo recognition can return a verified Wikipedia cover when the primary sources are not configured.');
        } elseif ($mode === 'catalogue-unavailable') {
            $candidate = $result['data']['candidates'][0] ?? [];
            routeExpect($result['status'] === 200 && ($candidate['title'] ?? null) === 'Synthetic game'
                && ($result['data']['coverSearch'] ?? null) === 'unavailable' && !isset($candidate['coverUrl']),
                'Unavailable cover sources must preserve existing photo recognition.');
            routeExpect($calls === ['recognize', 'igdb', 'wikipedia'],
                'Recognition must skip the Gemini cover check when no cover source responds.');
        } else {
            routeExpect($result['status'] === 401 && !isset($result['data']['candidates']),
                'Completed recognition must not cross logout or a different authentication epoch.');
            routeExpect($calls === ['recognize'], 'An ended session must not start any cover catalogue lookup.');
        }
        $writeSession($cookie, $valid);
        unlink($root . '/transport-started');
        routeExpect($request(['action' => 'ai-recognize', 'uploadId' => $id], $cookie)['status'] === 404
            && !is_file($root . '/transport-started'),
            'The consumed upload must not produce a second inference call.');
    }
    echo "PASS: recognition claims photos, uses private cover credentials and rejects late results after logout or another login\n";
    echo "All 9 isolated AI HTTP/session route groups passed without private configuration, a database or external network.\n";
} finally {
    if (is_resource($server)) { proc_terminate($server); proc_close($server); }
    removeRouteTree($root);
}
