<?php
declare(strict_types=1);

namespace Savepoint\Covers;

// Store validated copies outside the document root. The authenticated API reads
// the saved bytes and serves them as images.
final class CoverBackup
{
    // Byte limits cap each image at 5 MiB and the store at 512 MiB.
    // RETRY_AFTER is the six-hour retry cooldown, expressed in seconds.
    public const MAX_BYTES = 5242880;
    public const MAX_TOTAL_BYTES = 536870912;
    private const RETRY_AFTER = 21600;
    private \Closure $download;

    // The default downloader enforces the network policy. Isolated tests can
    // supply a synthetic downloader to exercise storage without network access.
    public function __construct(
        private string $directory,
        ?callable $download = null,
        private string $applicationHost = '',
        private array $blockedIpv4 = [],
    ) {
        $this->download = $download === null ? $this->download(...) : \Closure::fromCallable($download);
    }

    // Parse a fetch target without making a network request. Preserve the path
    // and query while omitting the fragment and any explicit default port.
    public static function target(string $url, string $applicationHost = ''): ?array
    {
        if ($url === '' || strlen($url) > 4096 || preg_match('/[\x00-\x20\x7f-\xff\\\\]/', $url)) {
            return null;
        }
        $parts = parse_url($url);
        if (!is_array($parts) || isset($parts['user']) || isset($parts['pass'])) {
            return null;
        }
        $scheme = strtolower((string)($parts['scheme'] ?? ''));
        if (!in_array($scheme, ['https', 'http'], true)) {
            return null;
        }

        $host = strtolower((string)($parts['host'] ?? ''));
        // Domain names only: no IP literals, alternate numeric forms or local hosts.
        if (
            strlen($host) > 253
            || !preg_match('/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/D', $host)
            || $host === strtolower($applicationHost)
            || str_ends_with($host, '.localhost')
            || str_ends_with($host, '.local')
            || str_ends_with($host, '.internal')
        ) {
            return null;
        }
        $port = $scheme === 'https' ? 443 : 80;
        if (isset($parts['port']) && $parts['port'] !== $port) {
            return null;
        }

        $path = (string)($parts['path'] ?? '/');
        if ($path === '') {
            $path = '/';
        }
        $canonical = $scheme . '://' . $host . $path;
        if (isset($parts['query'])) {
            $canonical .= '?' . $parts['query'];
        }
        return ['url' => $canonical, 'host' => $host, 'port' => $port];
    }

    // Apply both the deployment's deny list and checks for nonpublic addresses.
    public static function publicIpv4(string $ip, array $blockedIpv4 = []): bool
    {
        // IPv4-only outbound requests also exclude mapped IPv6 and transition ranges.
        $publicIpv4Flags = FILTER_FLAG_IPV4 | FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE;
        $blockedRangePattern = '/^(?:0\.|100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.'
            . '|192\.0\.0\.|192\.0\.2\.|192\.88\.99\.|198\.(?:1[89]\.|51\.100\.)|203\.0\.113\.'
            . '|22[4-9]\.|23[0-9]\.|24[0-9]\.|25[0-5]\.)/';

        return filter_var($ip, FILTER_VALIDATE_IP, $publicIpv4Flags) !== false
            && !in_array($ip, $blockedIpv4, true)
            && !preg_match($blockedRangePattern, $ip);
    }

    // Resolve relative Location headers against the current URL and validate
    // the resulting target with the same rules as the original URL.
    public static function redirect(string $base, string $location, string $applicationHost = ''): ?string
    {
        $location = trim($location);
        if ($location === '' || strlen($location) > 4096 || preg_match('/[\x00-\x20\x7f-\xff\\\\]/', $location)) {
            return null;
        }
        $from = parse_url($base);
        if (!is_array($from)) {
            return null;
        }
        if (str_starts_with($location, '//')) {
            $location = $from['scheme'] . ':' . $location;
        } elseif (!preg_match('/^[a-z][a-z0-9+.-]*:/i', $location)) {
            $origin = $from['scheme'] . '://' . $from['host'];
            if (str_starts_with($location, '?')) {
                $location = $origin . ($from['path'] ?? '/') . $location;
            } elseif (str_starts_with($location, '#')) {
                return null;
            } elseif (str_starts_with($location, '/')) {
                $location = $origin . $location;
            } else {
                $path = (string)($from['path'] ?? '/');
                $directory = substr($path, 0, strrpos($path, '/') + 1);
                $location = $origin . $directory . $location;
            }
        }
        $target = self::target($location, $applicationHost);
        // Do not downgrade a protected source to cleartext on a redirect.
        if ($target === null || ($from['scheme'] === 'https' && str_starts_with($target['url'], 'http:'))) {
            return null;
        }
        return $target['url'];
    }

    // Bound the image dimensions and require the image parser and fileinfo to
    // agree on a supported raster format before storing or serving the bytes.
    public static function imageType(string $bytes): ?string
    {
        if ($bytes === '' || strlen($bytes) > self::MAX_BYTES) {
            return null;
        }
        $info = @getimagesizefromstring($bytes);
        if (
            $info === false
            || $info[0] < 1 || $info[1] < 1
            || $info[0] > 8192 || $info[1] > 8192
            || $info[0] * $info[1] > 40000000
        ) {
            return null;
        }
        $types = [
            IMAGETYPE_JPEG => 'image/jpeg',
            IMAGETYPE_PNG => 'image/png',
            IMAGETYPE_GIF => 'image/gif',
            IMAGETYPE_WEBP => 'image/webp',
            IMAGETYPE_AVIF => 'image/avif',
        ];
        $mime = $types[$info[2]] ?? null;
        if ($mime === null || !class_exists(\finfo::class)) {
            return null;
        }
        return (new \finfo(FILEINFO_MIME_TYPE))->buffer($bytes) === $mime ? $mime : null;
    }

    // Allow an initial request and at most three redirects within one transfer
    // budget. Resolve and validate the destination again at each hop.
    private function download(string $url): ?string
    {
        if (!function_exists('curl_init')) {
            return null;
        }
        $deadline = microtime(true) + 8;
        for ($hop = 0; $hop <= 3; $hop++) {
            $target = self::target($url, $this->applicationHost);
            if ($target === null || microtime(true) >= $deadline) {
                return null;
            }
            $addresses = @gethostbynamel($target['host']);
            if (!is_array($addresses) || $addresses === []) {
                return null;
            }
            // Reject mixed public/private DNS answers, then pin the accepted IP.
            foreach ($addresses as $address) {
                if (!self::publicIpv4($address, $this->blockedIpv4)) {
                    return null;
                }
            }

            $remainingMs = (int)(($deadline - microtime(true)) * 1000);
            if ($remainingMs < 1) {
                return null;
            }
            $body = '';
            $location = null;
            $headerBytes = 0;
            $curl = curl_init($target['url']);
            if ($curl === false) {
                return null;
            }
            try {
                // Pin the connection to the checked IPv4 address and keep the
                // URL hostname for HTTP routing and TLS certificate checks.
                curl_setopt_array($curl, [
                    CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
                    CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
                    CURLOPT_FOLLOWLOCATION => false,
                    CURLOPT_PROXY => '',
                    CURLOPT_IPRESOLVE => CURL_IPRESOLVE_V4,
                    CURLOPT_RESOLVE => [$target['host'] . ':' . $target['port'] . ':' . $addresses[0]],
                    CURLOPT_CONNECTTIMEOUT_MS => min(2500, $remainingMs),
                    CURLOPT_TIMEOUT_MS => $remainingMs,
                    CURLOPT_SSL_VERIFYPEER => true,
                    CURLOPT_SSL_VERIFYHOST => 2,
                    CURLOPT_MAXFILESIZE => self::MAX_BYTES,
                    CURLOPT_USERAGENT => 'Savepoint-CoverBackup/1.0',
                    // Request uncompressed image bytes without application cookies, credentials or Referer.
                    CURLOPT_HTTPHEADER => [
                        'Accept: image/jpeg, image/png, image/webp, image/gif, image/avif',
                        'Accept-Encoding: identity',
                    ],
                    // Enforce limits on streamed bytes even when the server
                    // does not report a response size.
                    CURLOPT_HEADERFUNCTION => static function ($handle, string $line) use (&$location, &$headerBytes): int {
                        $headerBytes += strlen($line);
                        if ($headerBytes > 32768) {
                            return 0;
                        }
                        if (preg_match('/^HTTP\//i', $line)) {
                            $location = null;
                        }
                        if (stripos($line, 'Location:') === 0) {
                            $location = trim(substr($line, 9));
                        }
                        return strlen($line);
                    },
                    CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use (&$body): int {
                        if (strlen($body) + strlen($chunk) > self::MAX_BYTES) {
                            return 0;
                        }
                        $body .= $chunk;
                        return strlen($chunk);
                    },
                ]);
                $success = curl_exec($curl);
                $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
            } finally {
                curl_close($curl);
            }
            if ($success === false) {
                return null;
            }
            if ($status === 200) {
                return self::imageType($body) === null ? null : $body;
            }
            if (!in_array($status, [301, 302, 303, 307, 308], true) || $hop === 3 || !is_string($location)) {
                return null;
            }
            $url = self::redirect($target['url'], $location, $this->applicationHost);
            if ($url === null) {
                return null;
            }
        }
        return null;
    }

    // Use the exact saved URL as a cache key without putting it in a filename.
    // Reads perform local I/O only and revalidate bytes before returning them.
    public function read(string $url): ?array
    {
        if ($url === '') {
            return null;
        }
        $path = $this->directory . '/' . hash('sha256', $url) . '.img';
        if (!is_file($path) || is_link($path) || filesize($path) > self::MAX_BYTES) {
            return null;
        }
        $bytes = @file_get_contents($path, false, null, 0, self::MAX_BYTES + 1);
        if (!is_string($bytes)) {
            return null;
        }
        $mime = self::imageType($bytes);
        return $mime === null ? null : ['bytes' => $bytes, 'mime' => $mime];
    }

    // Reuse a valid copy or attempt one download. A failure marker limits
    // repeated fetches of the same unavailable image.
    public function backup(string $url): array
    {
        if (self::target($url, $this->applicationHost) === null) {
            return ['status' => 'unavailable'];
        }
        if ($this->read($url) !== null) {
            return ['status' => 'cached'];
        }
        if (!is_dir($this->directory) && !@mkdir($this->directory, 0700, true) && !is_dir($this->directory)) {
            return ['status' => 'unavailable'];
        }
        @chmod($this->directory, 0700);
        $key = hash('sha256', $url);
        $failureMarker = $this->directory . '/' . $key . '.failed';
        if (is_file($failureMarker) && time() - (int)filemtime($failureMarker) < self::RETRY_AFTER) {
            return ['status' => 'unavailable'];
        }

        // Serialize downloads and quota checks across requests. Return busy
        // instead of holding the calling request open behind another fetch.
        $lock = @fopen($this->directory . '/.fetch.lock', 'c');
        if ($lock === false) {
            return ['status' => 'unavailable'];
        }
        @chmod($this->directory . '/.fetch.lock', 0600);
        if (!flock($lock, LOCK_EX | LOCK_NB)) {
            fclose($lock);
            return ['status' => 'busy'];
        }

        $temporaryPath = null;
        try {
            // Another request may have saved the image before we got the lock.
            if ($this->read($url) !== null) {
                return ['status' => 'cached'];
            }
            $usedBytes = 0;
            foreach (glob($this->directory . '/*.img') ?: [] as $file) {
                $usedBytes += (int)filesize($file);
            }
            if ($usedBytes >= self::MAX_TOTAL_BYTES) {
                return ['status' => 'quota'];
            }

            $bytes = ($this->download)($url);
            if (!is_string($bytes) || self::imageType($bytes) === null) {
                @touch($failureMarker);
                @chmod($failureMarker, 0600);
                return ['status' => 'unavailable'];
            }
            if ($usedBytes + strlen($bytes) > self::MAX_TOTAL_BYTES) {
                return ['status' => 'quota'];
            }

            // Publish the finished file with a same-directory rename so reads
            // never observe a partially written image.
            $temporaryPath = tempnam($this->directory, '.pending-');
            if ($temporaryPath === false) {
                return ['status' => 'unavailable'];
            }
            @chmod($temporaryPath, 0600);
            $backupPath = $this->directory . '/' . $key . '.img';
            if (file_put_contents($temporaryPath, $bytes) !== strlen($bytes) || !rename($temporaryPath, $backupPath)) {
                return ['status' => 'unavailable'];
            }
            $temporaryPath = null;
            @unlink($failureMarker);
            return ['status' => 'saved'];
        } catch (\Throwable $error) {
            // Never disclose image URLs, IPs or filesystem paths to the browser/log.
            @touch($failureMarker);
            @chmod($failureMarker, 0600);
            return ['status' => 'unavailable'];
        } finally {
            if (is_string($temporaryPath) && is_file($temporaryPath)) {
                @unlink($temporaryPath);
            }
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }
}
