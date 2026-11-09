<?php
declare(strict_types=1);

namespace {
    if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
    if (PHP_VERSION_ID < 80100) { echo "These isolated tests require PHP 8.1 or newer.\n"; exit(1); }
    // Transport shims below never open sockets. Supply constants when the local
    // PHP CLI lacks cURL; the production class still executes its real options.
    foreach (['CURLOPT_PROTOCOLS', 'CURLPROTO_HTTP', 'CURLPROTO_HTTPS', 'CURLOPT_REDIR_PROTOCOLS',
        'CURLOPT_FOLLOWLOCATION', 'CURLOPT_PROXY', 'CURLOPT_IPRESOLVE', 'CURL_IPRESOLVE_V4',
        'CURLOPT_RESOLVE', 'CURLOPT_CONNECTTIMEOUT_MS', 'CURLOPT_TIMEOUT_MS', 'CURLOPT_SSL_VERIFYPEER',
        'CURLOPT_SSL_VERIFYHOST', 'CURLOPT_MAXFILESIZE', 'CURLOPT_USERAGENT', 'CURLOPT_HTTPHEADER',
        'CURLOPT_HEADERFUNCTION', 'CURLOPT_WRITEFUNCTION', 'CURLINFO_RESPONSE_CODE'] as $index => $name) {
        if (!defined($name)) define($name, 10000 + $index);
    }
    if (!function_exists('curl_init')) {
        function curl_init(?string $url = null): false { throw new \RuntimeException('Real transport must never run.'); }
    }
    $coverDns = [];
    $coverDnsCalls = [];
    $coverTransfers = [];
    $coverHandles = [];
}

namespace Savepoint\Covers {
    function file_get_contents(string $filename, bool $useIncludePath = false, mixed $context = null, int $offset = 0, ?int $length = null): string|false
    {
        if ($GLOBALS['coverStatusReading'] ?? false) {
            if (!($GLOBALS['coverStatusSessionClosed'] ?? false)) throw new \RuntimeException('Status reads must release the session first.');
            $GLOBALS['coverStatusImageReads'][] = $filename;
        }
        return \file_get_contents($filename, $useIncludePath, $context, $offset, $length);
    }
    function gethostbynamel(string $host): array|false
    {
        $GLOBALS['coverDnsCalls'][] = $host;
        return $GLOBALS['coverDns'][$host] ?? false;
    }
    function curl_init(?string $url = null): object
    {
        $handle = (object)['url' => $url, 'options' => [], 'status' => 0, 'closed' => false, 'written' => 0];
        $GLOBALS['coverHandles'][] = $handle;
        return $handle;
    }
    function curl_setopt_array(object $handle, array $options): bool { $handle->options = $options; return true; }
    function curl_exec(object $handle): bool
    {
        $fixture = array_shift($GLOBALS['coverTransfers']);
        if (!is_array($fixture)) throw new \RuntimeException('Unexpected synthetic transfer.');
        $handle->status = $fixture['status'] ?? 200;
        foreach ($fixture['headers'] ?? ["HTTP/1.1 {$handle->status} Synthetic\r\n"] as $line) {
            if (($handle->options[CURLOPT_HEADERFUNCTION])($handle, $line) !== strlen($line)) return false;
        }
        foreach ($fixture['chunks'] ?? [] as $chunk) {
            $count = ($handle->options[CURLOPT_WRITEFUNCTION])($handle, $chunk);
            $handle->written += $count;
            if ($count !== strlen($chunk)) return false;
        }
        return $fixture['success'] ?? true;
    }
    function curl_getinfo(object $handle, int $option): int { return $handle->status; }
    function curl_close(object $handle): void { $handle->closed = true; }
}

namespace SavepointCoverApiTest {
    final class Response extends \RuntimeException
    {
        public function __construct(public int $status, public array $payload) { parent::__construct('Synthetic API response.'); }
    }
    function respond(int $status, array $data): never { throw new Response($status, $data); }
    function isHttpsRequest(): bool { return true; }
    function enforcePostOrigin(string $origin): void
    {
        if ($origin !== 'https://savepoint.example') throw new \RuntimeException('Origin guard must use the configured origin.');
        $GLOBALS['coverOriginGuards']++;
    }
    function startSecureSession(): void {}
    function enforceSessionTimeout(bool $touch = true): void { $GLOBALS['coverSessionTouch'] = $touch; }
    function loadLocalConfig(): array { return ['app_origin' => 'https://savepoint.example']; }
    function getDatabase(array $config): object { $GLOBALS['coverDatabaseReads']++; return new \stdClass(); }
    function issueCaptchaChallenge(array $config): array { return ['provider' => 'synthetic']; }
    function listGames(object $db): array { return []; }
    function file_get_contents(string $path, mixed ...$args): string|false
    {
        if ($path !== 'php://input') throw new \RuntimeException('No configuration or real file reads in API routing tests.');
        return $GLOBALS['coverRequestBody'];
    }
    function serveCoverBackup(object $db, mixed $id, array $config): never { respond(200, ['route' => 'read', 'id' => $id]); }
    function createCoverBackup(object $db, mixed $id, array $config): never { respond(200, ['route' => 'backup', 'id' => $id]); }
    function coverBackupStatuses(object $db, mixed $ids, array $config): never { respond(200, ['route' => 'status', 'ids' => $ids]); }
}

namespace SavepointCoverStatusTest {
    function respond(int $status, array $data): never { throw new \SavepointCoverApiTest\Response($status, $data); }
    function session_write_close(): bool { $GLOBALS['coverStatusSessionClosed'] = true; return true; }
    function coverBackupStore(array $config): \Savepoint\Covers\CoverBackup
    {
        $GLOBALS['coverStatusStoreCalls']++;
        return new \Savepoint\Covers\CoverBackup($GLOBALS['coverStatusDirectory'], static function (): never { throw new \RuntimeException('Status must never download images.'); });
    }
    final class Database extends \PDO
    {
        public array $queries = [];
        public array $parameters = [];
        public function __construct(public array $rows) {}
        public function prepare(string $query, array $options = []): \PDOStatement|false
        {
            $this->queries[] = $query;
            return new Statement($this);
        }
    }
    final class Statement extends \PDOStatement
    {
        private array $ids = [];
        public function __construct(private Database $db) {}
        public function execute(?array $params = null): bool
        {
            $this->ids = $params ?? [];
            $this->db->parameters[] = $this->ids;
            return true;
        }
        public function fetchAll(int $mode = \PDO::FETCH_DEFAULT, mixed ...$args): array
        {
            return array_values(array_filter($this->db->rows, fn(array $row): bool => in_array($row['id'], $this->ids, true)));
        }
    }
}

namespace SavepointCoverSessionTest {
    function time(): int { return $GLOBALS['coverSessionNow']; }
    function session_regenerate_id(bool $deleteOldSession = false): bool
    {
        $GLOBALS['coverSessionRotations'][] = $deleteOldSession;
        return true;
    }
}

namespace {
    require dirname(__DIR__) . '/server/covers/CoverBackup.php';
    use Savepoint\Covers\CoverBackup;

    $groups = 0;
    function coverExpect(bool $condition, string $message): void { if (!$condition) throw new \RuntimeException($message); }
    function coverPass(string $message): void { $GLOBALS['groups']++; echo "PASS: $message\n"; }
    function coverRemove(string $directory): void
    {
        if (!is_dir($directory) || is_link($directory)) return;
        foreach (scandir($directory) ?: [] as $name) {
            if ($name === '.' || $name === '..') continue;
            $path = $directory . '/' . $name;
            if (is_dir($path) && !is_link($path)) coverRemove($path); else unlink($path);
        }
        rmdir($directory);
    }
    function coverTransport(string $url, array $dns, array $transfers, string $applicationHost = '', array $blockedIpv4 = []): ?string
    {
        $GLOBALS['coverDns'] = $dns;
        $GLOBALS['coverDnsCalls'] = [];
        $GLOBALS['coverTransfers'] = $transfers;
        $GLOBALS['coverHandles'] = [];
        $store = new CoverBackup(sys_get_temp_dir(), applicationHost: $applicationHost, blockedIpv4: $blockedIpv4);
        return (new \ReflectionMethod(CoverBackup::class, 'download'))->invoke($store, $url);
    }
    $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6l1sAAAAASUVORK5CYII=', true);
    $gif = base64_decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', true);
    coverExpect(is_string($png) && is_string($gif), 'Synthetic image fixtures must decode.');
    $url = 'https://cdn.example/covers/first.png?size=large&v=1';
    $other = 'https://cdn.example/covers/second.png';
    $applicationHost = 'savepoint.example';
    $blockedIpv4 = ['100.128.0.1'];

    foreach (['https://CDN.Example:443/a.png?x=1#part', 'http://cdn.example:80/a.png', $url] as $allowed) {
        coverExpect(CoverBackup::target($allowed) !== null, 'Normal HTTP(S) domain URLs must work.');
    }
    coverExpect(CoverBackup::target('https://CDN.Example:443/a.png?x=1#part')['url'] === 'https://cdn.example/a.png?x=1', 'Canonical request must retain query but drop fragment and normalize host.');
    foreach (['', 'file:///etc/passwd', 'ftp://cdn.example/a.png', 'gopher://cdn.example/', 'data:image/png;base64,xx',
        'http://localhost/a', 'http://host.local/a', 'http://host.internal/a', 'http://a.localhost/a',
        'http://127.0.0.1/a', 'http://2130706433/a', 'http://0x7f000001/a', 'http://0177.0.0.1/a',
        'http://[::1]/a', 'http://[::ffff:127.0.0.1]/a', 'https://user:pass@cdn.example/a',
        'https://cdn.example:444/a', 'http://cdn.example:443/a', 'https://Savepoint.Example/a',
        "https://cdn.example/a\r\nX: yes", 'https://cdn.example\\@internal.example/a', 'https://żółw.example/a'] as $denied) {
        coverExpect(CoverBackup::target($denied, $applicationHost) === null, 'Unsafe target must be rejected: ' . $denied);
    }
    coverPass('URL validation excludes local/numeric targets, credentials, alternate ports, controls and non-HTTP schemes');

    foreach (['8.8.8.8', '1.1.1.1', '93.184.216.34', '100.63.255.255', '100.128.0.1'] as $ip) {
        coverExpect(CoverBackup::publicIpv4($ip), 'Public IPv4 should be allowed: ' . $ip);
    }
    foreach (['0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
        '100.64.0.1', '100.127.255.255', '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.19.255.255',
        '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.1.2.3', '240.0.0.1', '255.255.255.255',
        '100.128.0.1', '::1', '::ffff:8.8.8.8', '2002:0808:0808::1', '64:ff9b::808:808'] as $ip) {
        coverExpect(!CoverBackup::publicIpv4($ip, $blockedIpv4), 'Private, reserved, transition or configured application address must be denied: ' . $ip);
    }
    coverPass('outbound IPv4 excludes private, reserved, metadata, shared-address, multicast and application-server ranges');

    coverExpect(CoverBackup::redirect($url, '//other.example/a.png') === 'https://other.example/a.png', 'Protocol-relative redirect should use original scheme.');
    coverExpect(CoverBackup::redirect($url, '/next.png') === 'https://cdn.example/next.png', 'Root-relative redirect should retain origin.');
    coverExpect(CoverBackup::redirect($url, 'next.png') === 'https://cdn.example/covers/next.png', 'Relative redirect should retain directory.');
    coverExpect(CoverBackup::redirect($url, '?v=2') === 'https://cdn.example/covers/first.png?v=2', 'Query-only redirect should retain path.');
    foreach (['http://other.example/a', 'http://127.0.0.1/a', 'https://user@other.example/a', '#loop', 'file:///a'] as $location) {
        coverExpect(CoverBackup::redirect($url, $location) === null, 'Unsafe/downgrade redirects must be rejected.');
    }
    coverPass('redirect resolution supports ordinary locations and prevents scheme, credential and HTTPS-downgrade bypasses');

    coverExpect(CoverBackup::imageType($png) === 'image/png', 'PNG bytes should be recognized.');
    coverExpect(CoverBackup::imageType($gif) === 'image/gif', 'GIF bytes should be recognized.');
    foreach (['', '<html><img src=x></html>', '<svg xmlns="http://www.w3.org/2000/svg"/>', '<?php echo "x";', substr($png, 0, 10), str_repeat('a', CoverBackup::MAX_BYTES + 1)] as $bytes) {
        coverExpect(CoverBackup::imageType($bytes) === null, 'Non-raster, truncated header or oversized body must be rejected.');
    }
    $wide = substr_replace($png, pack('N', 8193), 16, 4);
    $huge = substr_replace($png, pack('NN', 8192, 8192), 16, 8);
    coverExpect(CoverBackup::imageType($wide) === null && CoverBackup::imageType($huge) === null, 'Dimension and pixel limits must both be enforced.');
    coverPass('raster signatures and MIME agree; SVG/HTML, truncated headers, excess bytes and oversized dimensions are refused');

    $dns = ['cdn.example' => ['93.184.216.34']];
    coverExpect(coverTransport($url, $dns, [['chunks' => [$png]]]) === $png, 'Pinned download should return a valid synthetic image.');
    $handle = $coverHandles[0]; $options = $handle->options;
    coverExpect($options[CURLOPT_RESOLVE] === ['cdn.example:443:93.184.216.34'], 'Accepted DNS address must be pinned.');
    coverExpect($options[CURLOPT_FOLLOWLOCATION] === false && $options[CURLOPT_PROXY] === '', 'Automatic redirects and environment proxy must be disabled.');
    coverExpect($options[CURLOPT_PROTOCOLS] === (CURLPROTO_HTTP | CURLPROTO_HTTPS) && $options[CURLOPT_IPRESOLVE] === CURL_IPRESOLVE_V4, 'Only allowed protocols and IPv4 may be used.');
    coverExpect($options[CURLOPT_SSL_VERIFYPEER] === true && $options[CURLOPT_SSL_VERIFYHOST] === 2, 'TLS certificates and hostnames must be verified.');
    coverExpect($options[CURLOPT_TIMEOUT_MS] <= 8000 && $options[CURLOPT_CONNECTTIMEOUT_MS] <= 2500, 'Transport must have bounded timeouts.');
    coverExpect(in_array('Accept-Encoding: identity', $options[CURLOPT_HTTPHEADER], true), 'Download must not negotiate response decompression.');
    coverExpect(!preg_match('/cookie|authorization|referer/i', implode("\n", $options[CURLOPT_HTTPHEADER])) && $handle->closed, 'No credentials or application referrer may be sent; handles must close.');
    coverPass('real transport options pin DNS, disable proxies/automatic redirects, verify TLS, bound time and omit application secrets');

    coverExpect(coverTransport($url, ['cdn.example' => ['93.184.216.34', '127.0.0.1']], []) === null && $coverHandles === [], 'Mixed public/private DNS must be blocked before cURL.');
    coverExpect(coverTransport($url, ['cdn.example' => ['169.254.169.254']], []) === null && $coverHandles === [], 'Metadata DNS must be blocked before cURL.');
    coverExpect(coverTransport($url, [], []) === null && $coverHandles === [], 'Unresolved host must fail closed.');
    coverExpect(coverTransport($url, ['cdn.example' => ['100.128.0.1']], [], blockedIpv4: $blockedIpv4) === null && $coverHandles === [], 'A host resolving to a blocked application address must fail before opening a connection.');
    coverPass('private, mixed and unresolved DNS answers fail before opening a synthetic transfer');

    $redirect = ['status' => 302, 'headers' => ["HTTP/1.1 302 Found\r\n", "Location: https://other.example/next.png\r\n"]];
    coverExpect(coverTransport($url, $dns + ['other.example' => ['8.8.8.8']], [$redirect, ['chunks' => [$gif]]]) === $gif, 'Each allowed redirect should download its own pinned destination.');
    coverExpect($coverHandles[1]->options[CURLOPT_RESOLVE] === ['other.example:443:8.8.8.8'], 'Redirect must pin its separately resolved address.');
    coverExpect(coverTransport($url, $dns + ['other.example' => ['10.0.0.1']], [$redirect]) === null && count($coverHandles) === 1, 'Redirect to private DNS must fail before second transfer.');
    coverExpect(coverTransport($url, $dns + ['other.example' => ['100.128.0.1']], [$redirect], blockedIpv4: $blockedIpv4) === null && count($coverHandles) === 1, 'Redirect to a blocked application address must fail before second transfer.');
    $applicationRedirect = ['status' => 302, 'headers' => ["HTTP/1.1 302 Found\r\n", "Location: https://savepoint.example/next.png\r\n"]];
    coverExpect(coverTransport($url, $dns, [$applicationRedirect], applicationHost: $applicationHost) === null && $coverDnsCalls === ['cdn.example'], 'Redirect to the configured application hostname must fail before DNS.');
    $loop = ['status' => 302, 'headers' => ["HTTP/1.1 302 Found\r\n", "Location: /loop.png\r\n"]];
    coverExpect(coverTransport($url, $dns, array_fill(0, 4, $loop)) === null && count($coverHandles) === 4, 'Redirect loops must stop after at most three follows.');
    coverPass('redirects are re-resolved and pinned, private destinations are blocked and loops have a fixed hop limit');

    $chunks = array_fill(0, 6, str_repeat('a', 1048576));
    coverExpect(coverTransport($url, $dns, [['chunks' => $chunks]]) === null, 'Oversized response without Content-Length must fail.');
    coverExpect($coverHandles[0]->written === CoverBackup::MAX_BYTES, 'Streaming writer must stop before accepting the byte above its limit.');
    coverExpect(coverTransport($url, $dns, [['headers' => [str_repeat('X', 32769)], 'chunks' => [$png]]]) === null, 'Excessive response headers must fail.');
    coverExpect(coverTransport($url, $dns, [['status' => 404, 'chunks' => [$png]]]) === null, 'Image-like error responses must not be cached.');
    coverExpect(coverTransport($url, $dns, [['chunks' => ['<svg/>']]]) === null, 'Raster claim must not make SVG acceptable.');
    coverPass('streaming byte/header limits work without Content-Length; HTTP errors and non-raster payloads never become copies');

    $temporary = sys_get_temp_dir() . '/savepoint-cover-tests-' . bin2hex(random_bytes(6));
    mkdir($temporary, 0700);
    try {
        $downloads = 0;
        $store = new CoverBackup($temporary . '/images', static function (string $source) use (&$downloads, $png): string { $downloads++; return $png; }, applicationHost: $applicationHost);
        coverExpect($store->backup('https://savepoint.example/cover.png')['status'] === 'unavailable' && $downloads === 0, 'Backup must reject the configured application hostname before calling the downloader.');
        coverExpect($store->read($url) === null && $downloads === 0 && !is_dir($temporary . '/images'), 'Reading absent backup must not perform network or create storage.');
        coverExpect($store->backup($url)['status'] === 'saved' && $downloads === 1, 'First backup should save the downloaded image.');
        $image = $store->read($url);
        coverExpect($image === ['bytes' => $png, 'mime' => 'image/png'], 'Read must return original image bytes and derived MIME.');
        coverExpect($store->backup($url)['status'] === 'cached' && $downloads === 1, 'Existing successful copy must prevent another download.');
        coverExpect($store->read($other) === null, 'Changed URL must not expose a previous image.');
        $saved = $temporary . '/images/' . hash('sha256', $url) . '.img';
        clearstatcache();
        coverExpect((fileperms($temporary . '/images') & 0777) === 0700 && (fileperms($saved) & 0777) === 0600, 'Private directory and image permissions must be strict.');
        coverExpect(glob($temporary . '/images/.pending-*') === [], 'Successful atomic save must leave no staging file.');
        $beforeDns = count($coverDnsCalls);
        $store->read($url);
        coverExpect($downloads === 1 && count($coverDnsCalls) === $beforeDns, 'GET/read of a copy must never use downloader or DNS.');
        coverPass('private atomic copies retain bytes, deduplicate URLs and never perform network on reads');

        $failedCalls = 0;
        $failedStore = new CoverBackup($temporary . '/images', static function () use (&$failedCalls): ?string { $failedCalls++; return null; });
        coverExpect($failedStore->backup($other)['status'] === 'unavailable' && $failedCalls === 1, 'Failed transfer must remain unavailable.');
        coverExpect($failedStore->backup($other)['status'] === 'unavailable' && $failedCalls === 1, 'Repeated failed URL must be cooled down.');
        coverExpect($failedStore->read($url)['bytes'] === $png && $failedStore->backup($url)['status'] === 'cached', 'Failure must never destroy an existing good copy.');
        $failedPath = $temporary . '/images/' . hash('sha256', $other) . '.failed';
        touch($failedPath, time() - 21601); clearstatcache();
        coverExpect($failedStore->backup($other)['status'] === 'unavailable' && $failedCalls === 2, 'Failure must become retryable after cooldown.');
        $badStore = new CoverBackup($temporary . '/bad', static fn(): string => '<html>not an image</html>');
        coverExpect($badStore->backup($url)['status'] === 'unavailable' && (glob($temporary . '/bad/*.img') ?: []) === [], 'Invalid downloaded bytes must not create a cache image.');
        $throwingCalls = 0;
        $throwingStore = new CoverBackup($temporary . '/throws', static function () use (&$throwingCalls): never { $throwingCalls++; throw new \RuntimeException('synthetic-private-details'); });
        coverExpect($throwingStore->backup($url) === ['status' => 'unavailable'], 'Exception details must not escape in the public result.');
        coverExpect($throwingStore->backup($url) === ['status' => 'unavailable'] && $throwingCalls === 1, 'Thrown download failures must also respect cooldown.');
        coverPass('failure cooldown, byte validation and exception handling preserve good copies and reveal no transport details');

        $lock = fopen($temporary . '/images/.fetch.lock', 'c'); flock($lock, LOCK_EX);
        coverExpect($store->backup('https://cdn.example/third.png')['status'] === 'busy' && $downloads === 1, 'Overlapping backup must not begin a second transfer.');
        flock($lock, LOCK_UN); fclose($lock);
        $quotaDirectory = $temporary . '/quota'; mkdir($quotaDirectory, 0700);
        $sparse = fopen($quotaDirectory . '/' . str_repeat('0', 64) . '.img', 'w');
        coverExpect(ftruncate($sparse, CoverBackup::MAX_TOTAL_BYTES), 'Synthetic sparse quota fixture must be created.'); fclose($sparse);
        $quotaCalls = 0;
        $quotaStore = new CoverBackup($quotaDirectory, static function () use (&$quotaCalls, $png): string { $quotaCalls++; return $png; });
        coverExpect($quotaStore->backup($url)['status'] === 'quota' && $quotaCalls === 0, 'Full logical quota must reject before downloading.');
        coverPass('global nonblocking lock prevents concurrent transfers and aggregate disk quota prevents another download');

        $linkUrl = 'https://cdn.example/link.png';
        symlink($saved, $temporary . '/images/' . hash('sha256', $linkUrl) . '.img');
        coverExpect($store->read($linkUrl) === null, 'Symlink cache entries must never be served.');
        coverPass('cache reads reject symbolic links');
    } finally { coverRemove($temporary); }

    // Execute the real dispatch body with only I/O boundaries replaced. This is
    // not a real DB/session/CAPTCHA test and never reads application config.
    $source = file_get_contents(dirname(__DIR__) . '/api/games.php');
    token_get_all($source, TOKEN_PARSE);
    $statusStart = strpos($source, 'function coverBackupStatuses(');
    $statusEnd = strpos($source, 'function passwordMatches(', $statusStart);
    coverExpect($statusStart !== false && $statusEnd !== false, 'Actual status helper must be identifiable.');
    eval('namespace SavepointCoverStatusTest; use \\PDO; ' . substr($source, $statusStart, $statusEnd - $statusStart));
    $coverStatusDirectory = sys_get_temp_dir() . '/savepoint-cover-status-' . bin2hex(random_bytes(6));
    mkdir($coverStatusDirectory, 0700);
    $statusRun = static function (array $rows, mixed $ids): array {
        $db = new \SavepointCoverStatusTest\Database($rows);
        $GLOBALS['coverStatusSessionClosed'] = false;
        $GLOBALS['coverStatusImageReads'] = [];
        $GLOBALS['coverStatusStoreCalls'] = 0;
        $GLOBALS['coverStatusReading'] = true;
        try { \SavepointCoverStatusTest\coverBackupStatuses($db, $ids, []); }
        catch (\SavepointCoverApiTest\Response $response) { return [$response, $db]; }
        finally { $GLOBALS['coverStatusReading'] = false; }
        throw new \RuntimeException('Status helper produced no response.');
    };
    try {
        file_put_contents($coverStatusDirectory . '/' . hash('sha256', $url) . '.img', $png);
        $brokenUrl = 'https://cdn.example/corrupt.png';
        file_put_contents($coverStatusDirectory . '/' . hash('sha256', $brokenUrl) . '.img', '<svg/>');
        $statusRows = [
            ['id' => 'good-a', 'cover_url' => $url], ['id' => 'good-b', 'cover_url' => $url],
            ['id' => 'corrupt', 'cover_url' => $brokenUrl], ['id' => 'missing', 'cover_url' => $other],
            ['id' => 'empty-cover', 'cover_url' => ''],
            ['id' => 'not-requested', 'cover_url' => 'http://127.0.0.1/secret'],
        ];
        $beforeDns = count($coverDnsCalls);
        [$response, $db] = $statusRun($statusRows, ['good-a', 'good-b', 'corrupt', 'missing', 'empty-cover', 'absent-id', 'good-a']);
        coverExpect($response->status === 200 && $response->payload['ok'] === true && !isset($response->payload['games']), 'Status metadata must stay outside exported game records.');
        $expected = [
            ['id' => 'good-a', 'coverUrl' => $url, 'ready' => true], ['id' => 'good-b', 'coverUrl' => $url, 'ready' => true],
            ['id' => 'corrupt', 'coverUrl' => $brokenUrl, 'ready' => false], ['id' => 'missing', 'coverUrl' => $other, 'ready' => false],
            ['id' => 'empty-cover', 'coverUrl' => '', 'ready' => false],
        ];
        coverExpect($response->payload['backups'] === $expected, 'Existing, corrupt, missing and empty covers must have exact statuses; absent/unrequested IDs must not leak.');
        coverExpect($db->queries === ['SELECT id, cover_url FROM games WHERE id IN (?,?,?,?,?,?)']
            && $db->parameters === [['good-a', 'good-b', 'corrupt', 'missing', 'empty-cover', 'absent-id']], 'IDs must use one prepared query with deduplicated placeholders.');
        coverExpect(count($coverStatusImageReads) === 2 && count(array_unique($coverStatusImageReads)) === 2 && $coverStatusSessionClosed,
            'Full file reads must be deduplicated by raw URL and run after session release.');
        coverExpect(count($coverDnsCalls) === $beforeDns, 'Status checks must not resolve DNS or fetch an external image.');
        coverPass('bounded status batch uses one prepared SQL query, releases session, validates existing copies once per raw URL and returns metadata only');

        foreach ([null, 'good-a', ['key' => 'good-a'], [7], [null], [['good-a']], ['../private'], ["good-a\n"], ['https://cdn.example/a'], array_fill(0, 33, 'good-a')] as $invalidIds) {
            [$response, $db] = $statusRun($statusRows, $invalidIds);
            coverExpect($response->status === 400 && $db->queries === [] && $coverStatusStoreCalls === 0, 'Invalid/oversized batch must fail before database or file operations.');
        }
        [$response, $db] = $statusRun($statusRows, []);
        coverExpect($response->payload === ['ok' => true, 'backups' => []] && $db->queries === [] && $coverStatusStoreCalls === 0 && $coverStatusSessionClosed,
            'Empty batch must return empty statuses without SQL or image reads.');
        $thirtyTwo = array_map(static fn(int $index): string => 'status-' . $index, range(1, 32));
        [$response, $db] = $statusRun([], $thirtyTwo);
        coverExpect($response->status === 200 && $db->parameters === [$thirtyTwo] && substr_count($db->queries[0], '?') === 32,
            'Exact 32-ID boundary must be accepted and fully parameterized.');
        coverPass('status batches accept exactly 32 IDs and reject malformed, associative, non-string, path-like and oversized input without I/O');
    } finally { coverRemove($coverStatusDirectory); }

    $sessionStart = strpos($source, 'function enforceSessionTimeout(');
    $sessionEnd = strpos($source, 'function loadLocalConfig(', $sessionStart);
    coverExpect($sessionStart !== false && $sessionEnd !== false, 'Actual session timeout helper must be identifiable.');
    eval('namespace SavepointCoverSessionTest; ' . substr($source, $sessionStart, $sessionEnd - $sessionStart));
    $coverSessionNow = 100000;
    $coverSessionRotations = [];
    $_SESSION = ['user_id' => 1, 'authenticated_at' => 99000, 'last_activity_at' => 99500];
    SavepointCoverSessionTest\enforceSessionTimeout(false);
    coverExpect($_SESSION['last_activity_at'] === 99500 && $coverSessionRotations === [], 'Passive cover work must preserve last activity without rotating a valid session.');
    SavepointCoverSessionTest\enforceSessionTimeout();
    coverExpect($_SESSION['last_activity_at'] === $coverSessionNow, 'Normal activity must still refresh the inactivity clock.');
    $_SESSION = ['user_id' => 1, 'authenticated_at' => 99000, 'last_activity_at' => $coverSessionNow - 1800];
    SavepointCoverSessionTest\enforceSessionTimeout(false);
    coverExpect($_SESSION['user_id'] === 1 && $_SESSION['last_activity_at'] === $coverSessionNow - 1800, 'Exact inactivity boundary must remain valid without a passive touch.');
    $_SESSION['last_activity_at']--;
    SavepointCoverSessionTest\enforceSessionTimeout(false);
    coverExpect($_SESSION === [] && $coverSessionRotations === [true], 'Passive cover work must still expire and rotate an idle session after 1800 seconds.');
    $_SESSION = ['user_id' => 1, 'authenticated_at' => $coverSessionNow - 28801, 'last_activity_at' => $coverSessionNow];
    SavepointCoverSessionTest\enforceSessionTimeout(false);
    coverExpect($_SESSION === [] && $coverSessionRotations === [true, true], 'Absolute eight-hour expiration must remain effective during passive work.');
    $_SESSION = [];
    SavepointCoverSessionTest\enforceSessionTimeout(false);
    coverExpect($_SESSION === [] && count($coverSessionRotations) === 2, 'Anonymous session must not be refreshed or unnecessarily rotated.');
    coverPass('passive image work preserves inactivity time while normal activity refreshes it; idle and absolute expiration still clear and rotate sessions');

    $start = strpos($source, "\ntry {\n    if (!isHttpsRequest())");
    $end = strrpos($source, '} catch (InvalidArgumentException $error)');
    coverExpect($start !== false && $end !== false, 'Actual API dispatch body must be identifiable.');
    $body = substr($source, $start + strlen("\ntry {\n"), $end - $start - strlen("\ntry {\n"));
    $run = static function (string $method, array $session, array $query, array $request = []) use ($body): \SavepointCoverApiTest\Response {
        $_SERVER = ['REQUEST_METHOD' => $method, 'HTTPS' => 'on', 'CONTENT_TYPE' => 'application/json'];
        $_SESSION = $session; $_GET = $query;
        $GLOBALS['coverRequestBody'] = json_encode($request);
        $GLOBALS['coverDatabaseReads'] = 0; $GLOBALS['coverOriginGuards'] = 0; $GLOBALS['coverSessionTouch'] = null;
        try { eval('namespace SavepointCoverApiTest; ' . $body); }
        catch (\SavepointCoverApiTest\Response $response) { return $response; }
        throw new \RuntimeException('API routing test produced no captured response.');
    };
    $response = $run('GET', [], ['cover' => 'test-game']);
    coverExpect($response->status === 401 && $coverDatabaseReads === 0 && !isset($response->payload['bytes']), 'Unauthenticated copy read must stop before DB and image data.');
    $response = $run('POST', [], [], ['action' => 'backup-cover', 'id' => 'test-game']);
    coverExpect($response->status === 401 && $coverDatabaseReads === 0 && $coverOriginGuards === 1, 'Unauthenticated backup must enforce Origin and stop before DB/download.');
    $response = $run('POST', [], [], ['action' => 'backup-cover-status', 'ids' => ['test-game']]);
    coverExpect($response->status === 401 && $coverDatabaseReads === 0 && $coverOriginGuards === 1 && $coverSessionTouch === false, 'Unauthenticated status check must enforce Origin, avoid activity touch and stop before DB/files.');
    $response = $run('GET', ['user_id' => 1], ['cover' => 'test-game']);
    coverExpect($response->payload === ['route' => 'read', 'id' => 'test-game'] && $coverDatabaseReads === 1 && $coverSessionTouch === false, 'Authenticated GET must route to existing-copy reader without extending inactivity.');
    $response = $run('POST', ['user_id' => 1], [], ['action' => 'backup-cover', 'id' => 'test-game', 'url' => 'http://127.0.0.1/']);
    coverExpect($response->payload === ['route' => 'backup', 'id' => 'test-game'] && $coverOriginGuards === 1 && $coverSessionTouch === false, 'Authenticated backup route must forward ID only and never extend inactivity.');
    $response = $run('POST', ['user_id' => 1], [], ['action' => 'backup-cover-status', 'ids' => ['test-game'], 'url' => 'http://127.0.0.1/']);
    coverExpect($response->payload === ['route' => 'status', 'ids' => ['test-game']] && $coverOriginGuards === 1 && $coverSessionTouch === false,
        'Authenticated status route must forward IDs only and never extend inactivity.');
    $response = $run('GET', ['user_id' => 1], []);
    coverExpect($response->payload === ['ok' => true, 'games' => []] && $coverSessionTouch === true, 'Normal collection reads must keep their existing activity refresh.');
    coverPass('actual API routing requires authentication, keeps Origin checks and dispatches copies by game ID only');
    echo "All $groups isolated cover-backup test groups passed.\n";
}
