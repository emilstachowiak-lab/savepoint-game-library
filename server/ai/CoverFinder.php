<?php
declare(strict_types=1);

namespace Savepoint\AI;

// Query only the fixed cover providers. Gemini selects numbered options;
// neither a catalogue response nor the model can choose a server request URL.
final class CoverFinder
{
    private const STEAMGRIDDB = 'https://www.steamgriddb.com/api/v2';
    private const IGDB = 'https://api.igdb.com/v4';
    private const TWITCH = 'https://id.twitch.tv/oauth2/token';
    private const WIKIPEDIA = 'https://en.wikipedia.org/w/api.php';
    private const MAX_RESPONSE_BYTES = 524288;
    private const LOOKUP_SECONDS = 8;
    private const IGDB_SECONDS = 4;
    private const WIKIPEDIA_SECONDS = 4;
    private const CONCURRENT_REQUESTS = 4;

    private const PLATFORM_NAMES = [
        'Xbox Series' => ['Xbox Series X|S', 'Xbox Series X/S', 'Xbox Series X'],
        'PC' => ['PC (Microsoft Windows)', 'Windows', 'Linux', 'Mac', 'DOS'],
        'NES' => ['Nintendo Entertainment System', 'Family Computer'],
        'SNES' => ['Super Nintendo Entertainment System', 'Super Famicom'],
        'PSP' => ['PlayStation Portable'],
        'PlayStation Vita' => ['PS Vita'],
        'Mega Drive / Genesis' => ['Sega Mega Drive/Genesis', 'Sega Mega Drive', 'Sega Genesis'],
        'Sega CD / Mega-CD' => ['Sega CD', 'Mega-CD', 'Sega Mega CD'],
        'SG-1000' => ['Sega SG-1000'],
        '32X' => ['Sega 32X'],
        'GameCube' => ['Nintendo GameCube'],
    ];

    public static function addSuggestions(
        array $result,
        callable $select,
        array $config,
        ?callable $request = null,
        ?string $tokenCache = null,
        bool $singleCover = false,
        ?float $deadline = null,
        ?string $applicationOrigin = null,
    ): array {
        $games = [];
        foreach ($result['candidates'] as $index => $game) {
            $title = trim($game['title']);
            if ($game['confidence'] === 'low' || in_array($game['platform'], ['', 'Inna'], true)
                || self::titleKey($title) === '') {
                continue;
            }
            $games[$index] = ['title' => $title, 'platform' => $game['platform']];
        }
        if ($games === []) return $result;

        // Deduplicate catalogue searches while preserving all detected rows.
        $titles = array_values(array_unique(array_column($games, 'title')));
        $started = microtime(true);
        $deadline ??= INF;
        if ($deadline <= $started) {
            if ($singleCover) throw new ImportException('ai_provider_timeout', 504);
            return $result + ['coverSearch' => 'unavailable'];
        }
        // Reserve time for SteamGridDB even when Twitch or IGDB stalls.
        $igdbRequest = $request ?? static fn(array $jobs): array => self::fetch($jobs, min($deadline, $started + self::IGDB_SECONDS));
        $steamGridDbRequest = $request ?? static fn(array $jobs): array => self::fetch($jobs, min($deadline, $started + self::LOOKUP_SECONDS));
        $igdb = $steamGridDb = [];
        $igdbAvailable = $steamGridDbAvailable = false;
        try {
            [$igdb, $igdbAvailable] = self::igdb($titles, $config, $igdbRequest, $tokenCache);
        } catch (\Throwable) {
            // A provider outage must not erase the recognized games.
        }
        try {
            [$steamGridDb, $steamGridDbAvailable] = self::steamGridDb($titles, $config, $steamGridDbRequest);
        } catch (\Throwable) {
            // SteamGridDB and IGDB can still work independently.
        }
        $choices = [];
        $wikiGames = $games;
        foreach ($games as $row => $game) {
            $title = $game['title'];
            $platform = $game['platform'];
            $platformKnown = $platformMatches = false;
            $matchingCovers = [];
            foreach ($igdb[$title] ?? [] as $entry) {
                $platformKnown = $platformKnown || $entry['cataloguePlatforms'] !== [];
                if (!self::matchesPlatform($platform, $entry['cataloguePlatforms'])) continue;
                $platformMatches = true;
                if ($entry['url'] !== '') {
                    $matchingCovers[$entry['url']] = $entry;
                }
            }
            // Identical titles on the same console can be distinct releases.
            // Without evidence to distinguish them, leave the artwork editable.
            if (count($matchingCovers) > 1 || ($platformKnown && !$platformMatches)) {
                unset($wikiGames[$row]);
                continue;
            }
            if ($matchingCovers !== []) {
                $choices[] = self::choice(count($choices), $row, $game, reset($matchingCovers), 'igdb', 'Game cover');
            }
            // SteamGridDB grids can be custom artwork and have no console metadata.
            // Do not use one when IGDB positively identifies other consoles only.
            if (isset($steamGridDb[$title])) {
                $choices[] = self::choice(
                    count($choices), $row, $game, $steamGridDb[$title], 'steamgriddb', 'Static portrait grid'
                );
            }
        }
        try {
            if (microtime(true) >= $deadline) throw new ImportException('ai_provider_timeout', 504);
            self::applyChoices($result, $choices, $select);
            // The manual form needs one cover across all of its selected platforms.
            if ($singleCover && array_column($result['candidates'], 'coverUrl') !== []) return $result;
            $missing = array_filter($wikiGames, static fn(int $row): bool =>
                !isset($result['candidates'][$row]['coverUrl']), ARRAY_FILTER_USE_KEY);
            if ($missing !== []) {
                $wikiDeadline = min($deadline, microtime(true) + self::WIKIPEDIA_SECONDS);
                $wikiRequest = $request ?? static fn(array $jobs): array => self::fetch($jobs, $wikiDeadline);
                self::addWikipediaSuggestions($result, $missing, $select, $wikiRequest, $applicationOrigin);
                if (microtime(true) >= $deadline) $result['coverSearch'] = 'unavailable';
            } elseif (!$igdbAvailable && !$steamGridDbAvailable) {
                $result['coverSearch'] = 'unavailable';
            }
        } catch (\Throwable $error) {
            if ($singleCover && $error instanceof ImportException
                && in_array($error->errorId, ['ai_provider_rate_limited', 'ai_provider_timeout'], true)) throw $error;
            $result['coverSearch'] = 'unavailable';
        }
        return $result;
    }

    private static function applyChoices(array &$result, array $choices, callable $select): void
    {
        if ($choices === []) return;
        $selected = $select(array_column($choices, 'option'));
        foreach ($choices as ['option' => $option, 'cover' => $cover]) {
            // IGDB appears first for each row, ahead of custom grid art.
            $row = $option['gameIndex'];
            if (in_array($option['index'], $selected, true) && !isset($result['candidates'][$row]['coverUrl'])) {
                $result['candidates'][$row] += $cover;
            }
        }
    }

    private static function addWikipediaSuggestions(
        array &$result,
        array $games,
        callable $select,
        callable $request,
        ?string $applicationOrigin,
    ): void {
        // The titles parameter uses pipes as separators and accepts both page
        // names and section markers. Send only ordinary article titles.
        $games = array_filter($games, static fn(array $game): bool => strpbrk($game['title'], '|#[]{}<>') === false);
        if ($games === []) return;
        $titles = array_values(array_unique(array_column($games, 'title')));
        $pages = self::wikipediaPages($titles, $request, $applicationOrigin);

        $choices = [];
        foreach ($games as $row => $game) {
            $key = self::wikiTitleKey($game['title']);
            $entries = [];
            foreach ([$key, $key . ' (video game)'] as $name) {
                if (isset($pages[$name])) $entries[$pages[$name]['source']] = $pages[$name];
            }
            foreach ($entries as $entry) {
                $choice = self::choice(count($choices), $row, $game, $entry, 'wikipedia', 'Article image');
                $choice['option']['articleDescription'] = $entry['description'];
                $choice['option']['imageFilename'] = $entry['file'];
                $choices[] = $choice;
            }
        }
        self::applyChoices($result, $choices, $select);
    }

    private static function wikipediaPages(array $titles, callable $request, ?string $applicationOrigin): array
    {
        $jobs = [];
        // Include every title and its common disambiguation variant. Bundling
        // these in POST bodies keeps UTF-8 title lists out of the request URL.
        foreach (array_chunk($titles, 16) as $index => $group) {
            $alternates = array_map(static fn(string $title): string => $title . ' (video game)', $group);
            $names = array_unique([...$group, ...$alternates]);
            $jobs[$index === 0 ? 'wikipedia' : 'wikipedia-' . $index] = [
                'url' => self::WIKIPEDIA,
                'headers' => ['Content-Type: application/x-www-form-urlencoded'],
                // Use the deployment's public origin as the operator contact.
                'userAgent' => 'Savepoint/1.0 (cover lookup'
                    . ($applicationOrigin === null ? '' : '; ' . $applicationOrigin) . ')',
                'body' => http_build_query([
                    'action' => 'query', 'format' => 'json', 'formatversion' => 2, 'redirects' => 1,
                    'prop' => 'pageimages|pageprops', 'ppprop' => 'disambiguation|wikibase-shortdesc',
                    'piprop' => 'thumbnail|name', 'pilicense' => 'any', 'pithumbsize' => 480,
                    'pilimit' => count($names), 'titles' => implode('|', $names),
                ], '', '&', PHP_QUERY_RFC3986),
            ];
        }

        $pages = [];
        $queries = 0;
        foreach ($request($jobs) as $key => $reply) {
            $query = $reply['query'] ?? null;
            if (!isset($jobs[$key]) || !is_array($query['pages'] ?? null) || !array_is_list($query['pages'])) continue;
            $pages += self::indexWikiPages($query);
            $queries++;
        }
        if ($queries === 0) throw new \RuntimeException('Wikipedia cover lookup unavailable');
        return $pages;
    }

    private static function indexWikiPages(array $query): array
    {
        $pages = [];
        foreach ($query['pages'] as $page) {
            $title = $page['title'] ?? null;
            $id = $page['pageid'] ?? null;
            $file = $page['pageimage'] ?? null;
            $description = $page['pageprops']['wikibase-shortdesc'] ?? null;
            if (($page['ns'] ?? null) !== 0 || !is_int($id) || $id < 1 || !is_string($title)
                || strlen($title) > 340 || !is_string($file) || $file === '' || strlen($file) > 300
                || !is_string($description) || strlen($description) > 320
                || !preg_match('/\bvideo[- ]game\b/i', $description)
                || preg_match('/\b(?:series|franchise|disambiguation)\b/i', $description)
                || isset($page['pageprops']['disambiguation'])) {
                continue;
            }
            $url = self::wikiImageUrl($page['thumbnail']['source'] ?? null);
            if ($url === '') continue;
            $pages[self::wikiTitleKey($title)] = [
                'catalogueTitle' => $title, 'cataloguePlatforms' => [], 'releaseYear' => null,
                'description' => $description, 'file' => $file, 'url' => $url,
                'source' => 'https://en.wikipedia.org/?curid=' . $id,
            ];
        }

        // Resolve title aliases, but reject section redirects that can point
        // an edition or remaster to the original game's article image.
        $aliases = [];
        foreach (['normalized', 'redirects'] as $field) {
            $entries = $query[$field] ?? [];
            if (!is_array($entries)) continue;
            foreach ($entries as $entry) {
                if (is_string($entry['from'] ?? null) && is_string($entry['to'] ?? null)
                    && !isset($entry['tofragment'])) {
                    $aliases[self::wikiTitleKey($entry['from'])] = self::wikiTitleKey($entry['to']);
                }
            }
        }
        foreach ($aliases as $from => $to) {
            $visited = [$from => true];
            while (!isset($pages[$to]) && isset($aliases[$to]) && !isset($visited[$to])) {
                $visited[$to] = true;
                $to = $aliases[$to];
            }
            if (isset($pages[$to])) $pages[$from] ??= $pages[$to];
        }
        return $pages;
    }

    private static function wikiTitleKey(string $title): string
    {
        $title = preg_replace('/\s+/u', ' ', trim(str_replace('_', ' ', $title))) ?? '';
        return function_exists('mb_strtolower') ? mb_strtolower($title, 'UTF-8') : strtolower($title);
    }

    private static function wikiImageUrl(mixed $value): string
    {
        if (!is_string($value) || strlen($value) > 2048) return '';
        $parts = parse_url($value);
        $path = $parts['path'] ?? '';
        if (($parts['scheme'] ?? '') !== 'https' || ($parts['host'] ?? '') !== 'upload.wikimedia.org'
            || isset($parts['user']) || isset($parts['pass']) || isset($parts['port'])
            || !preg_match('~\A/wikipedia/(?:en|commons)/[a-z0-9/_.%()+,;!\x27@&=-]+\.(?:jpe?g|png|webp)\z~i', $path)
            || preg_match('~%(?:2f|5c)|%(?![a-f0-9]{2})~i', $path)
            || preg_match('~(?:^|/)\.{1,2}(?:/|$)|[\x00-\x1f\x7f]~', rawurldecode($path))) {
            return '';
        }
        // PageImages may append attribution tracking parameters.
        return 'https://upload.wikimedia.org' . $path;
    }

    private static function choice(
        int $index,
        int $row,
        array $game,
        array $entry,
        string $provider,
        string $artwork,
    ): array {
        return [
            'option' => ['index' => $index, 'gameIndex' => $row] + $game + [
                'provider' => $provider,
                'catalogueTitle' => $entry['catalogueTitle'],
                'cataloguePlatforms' => $entry['cataloguePlatforms'],
                'releaseYear' => $entry['releaseYear'],
                'artwork' => $artwork,
            ],
            'cover' => [
                'coverUrl' => $entry['url'],
                'coverSourceUrl' => $entry['source'],
                'coverSource' => $provider,
            ],
        ];
    }

    private static function titleKey(string $value): string
    {
        $value = function_exists('mb_strtolower') ? mb_strtolower($value, 'UTF-8') : strtolower($value);
        return trim(preg_replace('/[^\p{L}\p{N}]+/u', ' ', $value) ?? '');
    }

    private static function matchesPlatform(string $platform, array $published): bool
    {
        $names = array_map(self::titleKey(...), [$platform, ...(self::PLATFORM_NAMES[$platform] ?? [])]);
        foreach ($published as $one) {
            if (in_array(self::titleKey($one), $names, true)) return true;
        }
        return false;
    }

    private static function credential(mixed $value): bool
    {
        return is_string($value) && preg_match('/\A[a-zA-Z0-9_-]{12,256}\z/', $value) === 1;
    }

    private static function year(mixed $time): ?int
    {
        return is_int($time) && $time >= 0 && $time < 4102444800 ? (int)gmdate('Y', $time) : null;
    }

    private static function igdb(array $titles, array $config, callable $request, ?string $cache): array
    {
        $client = $config['igdb_client_id'] ?? null;
        $secret = $config['igdb_client_secret'] ?? null;
        if (!self::credential($client) || !self::credential($secret)) return [[], false];
        $token = self::igdbToken($client, $secret, $request, $cache);
        if ($token === '') return [[], false];

        $headers = ['Client-ID: ' . $client, 'Authorization: Bearer ' . $token, 'Content-Type: text/plain'];
        $titleKeys = [];
        foreach ($titles as $title) {
            // Keep APICalypse quotes and escapes out of the filter value.
            if (strpbrk($title, "\"\\") === false) $titleKeys[self::titleKey($title)][] = $title;
        }
        $jobs = [];
        foreach (array_chunk(array_column($titleKeys, 0), 10) as $chunk => $group) {
            $filters = array_map(static fn(string $title): string => 'name ~ "' . $title . '"', $group);
            $jobs[$chunk] = ['url' => self::IGDB . '/games', 'headers' => $headers,
                'body' => 'fields name,slug,cover.image_id,platforms.name,first_release_date; where ('
                    . implode(' | ', $filters) . '); limit 96;'];
        }
        if ($jobs === []) return [[], true];
        $covers = [];
        $available = false;
        foreach ($request($jobs) as $batch) {
            if (!is_array($batch) || !array_is_list($batch)) continue;
            $available = true;
            foreach (array_slice($batch, 0, 96) as $entry) {
                if (!is_string($entry['name'] ?? null) || strlen($entry['name']) > 320) continue;
                $matchedTitles = $titleKeys[self::titleKey($entry['name'])] ?? [];
                if ($matchedTitles === []) continue;
                $platforms = [];
                foreach (is_array($entry['platforms'] ?? null) ? $entry['platforms'] : [] as $platform) {
                    $name = $platform['name'] ?? null;
                    if (is_string($name) && strlen($name) <= 100) $platforms[] = $name;
                }
                $slug = $entry['slug'] ?? '';
                $image = $entry['cover']['image_id'] ?? '';
                $valid = is_string($slug) && preg_match('/\A[a-z0-9-]{1,250}\z/', $slug)
                    && is_string($image) && preg_match('/\A[a-zA-Z0-9_-]{1,80}\z/', $image);
                foreach ($matchedTitles as $title) {
                    $covers[$title][] = [
                        'catalogueTitle' => $entry['name'],
                        'cataloguePlatforms' => array_slice($platforms, 0, 24),
                        'releaseYear' => self::year($entry['first_release_date'] ?? null),
                        'url' => $valid ? 'https://images.igdb.com/igdb/image/upload/t_cover_big/' . $image . '.jpg' : '',
                        'source' => $valid ? 'https://www.igdb.com/games/' . $slug : '',
                    ];
                }
            }
        }
        return [$covers, $available];
    }

    private static function igdbToken(string $client, string $secret, callable $request, ?string $cache): string
    {
        $job = ['url' => self::TWITCH, 'headers' => ['Content-Type: application/x-www-form-urlencoded'],
            'body' => http_build_query([
                'client_id' => $client, 'client_secret' => $secret, 'grant_type' => 'client_credentials',
            ], '', '&', PHP_QUERY_RFC3986)];
        $file = $cache === null ? null : UploadStore::file($cache, 'c+b');
        $key = hash('sha256', $client . "\0" . $secret);
        try {
            if ($file !== null) {
                // A concurrent import can still use SteamGridDB while another
                // request refreshes the token.
                if (!flock($file, LOCK_EX | LOCK_NB)) return '';
                $record = json_decode((string)stream_get_contents($file, 2048), true);
                if (($record['key'] ?? null) === $key && is_int($record['expires'] ?? null)
                    && $record['expires'] > time() + 30 && self::credential($record['token'] ?? null)) {
                    return $record['token'];
                }
            }
            $reply = $request(['token' => $job])['token'] ?? null;
            $token = $reply['access_token'] ?? null;
            if (!self::credential($token)) return '';
            if ($file !== null && is_int($reply['expires_in'] ?? null) && $reply['expires_in'] > 30) {
                // Cache the access token, expiry and credential hash. The raw
                // client ID and secret stay in the private configuration.
                $record = json_encode(['key' => $key, 'token' => $token, 'expires' => time() + min(3600, $reply['expires_in'])],
                    JSON_THROW_ON_ERROR);
                if (rewind($file) && fwrite($file, $record) === strlen($record)) {
                    ftruncate($file, strlen($record));
                    fflush($file);
                }
            }
            return $token;
        } finally {
            if ($file !== null) fclose($file);
        }
    }

    private static function steamGridDb(array $titles, array $config, callable $request): array
    {
        $key = $config['steamgriddb_key'] ?? null;
        if (!self::credential($key)) return [[], false];
        $headers = ['Authorization: Bearer ' . $key];

        [$games, $searchAvailable] = self::steamGridDbGames($titles, $headers, $request);
        if ($games === []) return [[], $searchAvailable];

        $jobs = [];
        foreach ($games as $titleIndex => $game) {
            $jobs[$titleIndex] = ['url' => self::STEAMGRIDDB . '/grids/game/' . $game['id']
                . '?dimensions=600x900,660x930,342x482&types=static&nsfw=false&humor=false&epilepsy=false&limit=5',
                'headers' => $headers];
        }
        $covers = [];
        $loadedGrids = false;
        foreach ($request($jobs) as $titleIndex => $reply) {
            $images = self::steamGridDbData($reply);
            $game = $games[$titleIndex] ?? null;
            if ($images === null || $game === null) continue;
            $loadedGrids = true;
            foreach (array_slice($images, 0, 5) as $image) {
                if (!self::validPortraitGrid($image)) continue;
                $covers[$titles[$titleIndex]] = [
                    'catalogueTitle' => $game['name'],
                    'cataloguePlatforms' => [],
                    'releaseYear' => self::year($game['release_date'] ?? null),
                    'url' => $image['url'],
                    'source' => 'https://www.steamgriddb.com/grid/' . $image['id'],
                ];
                break;
            }
        }
        return [$covers, $loadedGrids];
    }

    private static function steamGridDbGames(array $titles, array $headers, callable $request): array
    {
        $jobs = [];
        foreach ($titles as $titleIndex => $title) {
            $jobs[$titleIndex] = ['url' => self::STEAMGRIDDB . '/search/autocomplete/' . rawurlencode($title),
                'headers' => $headers];
        }
        $entries = [];
        $available = false;
        foreach ($request($jobs) as $titleIndex => $reply) {
            $games = self::steamGridDbData($reply);
            if ($games === null || !isset($titles[$titleIndex])) continue;
            $available = true;
            $titleKey = self::titleKey($titles[$titleIndex]);
            $matches = [];
            foreach (array_slice($games, 0, 12) as $game) {
                if (is_int($game['id'] ?? null) && $game['id'] > 0 && is_string($game['name'] ?? null)
                    && strlen($game['name']) <= 320 && self::titleKey($game['name']) === $titleKey) {
                    $matches[$game['id']] = $game;
                }
            }
            // A portrait grid cannot resolve two distinct releases with the same name.
            if (count($matches) !== 1) continue;
            $entries[$titleIndex] = reset($matches);
        }
        return [$entries, $available];
    }

    private static function validPortraitGrid(mixed $image): bool
    {
        $url = $image['url'] ?? null;
        $width = $image['width'] ?? null;
        $height = $image['height'] ?? null;
        $validUrl = is_string($url) && preg_match(
            '~\Ahttps://cdn(?:2)?\.steamgriddb\.com/grid/[a-zA-Z0-9_-]{1,120}\.(?:jpe?g|png|webp)\z~i',
            $url,
        ) === 1;
        $portrait = is_int($width) && is_int($height) && $width >= 1 && $width < $height;
        $allowedContent = ($image['nsfw'] ?? null) === false && ($image['humor'] ?? null) === false
            && ($image['epilepsy'] ?? null) === false;

        return $validUrl && $portrait && $allowedContent && is_int($image['id'] ?? null) && $image['id'] > 0
            && in_array($image['mime'] ?? null, ['image/png', 'image/jpeg', 'image/webp'], true);
    }

    private static function steamGridDbData(mixed $response): ?array
    {
        $data = $response['data'] ?? null;
        return ($response['success'] ?? null) === true && is_array($data) && array_is_list($data) ? $data : null;
    }

    private static function fetch(array $jobs, float $deadline): array
    {
        $results = [];
        foreach (array_chunk($jobs, self::CONCURRENT_REQUESTS, true) as $batch) {
            $timeout = min(3500, (int)(($deadline - microtime(true)) * 1000));
            if ($timeout < 100) break;
            $handles = $bodies = $completed = [];
            $multi = count($batch) > 1 ? curl_multi_init() : null;
            try {
                foreach ($batch as $id => $job) {
                    $handle = curl_init($job['url']);
                    if ($handle === false) continue;
                    $handles[$id] = $handle;
                    $bodies[$id] = '';
                    $options = [
                        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
                        CURLOPT_FOLLOWLOCATION => false,
                        CURLOPT_PROXY => '',
                        CURLOPT_HTTPHEADER => ['Accept: application/json', ...$job['headers']],
                        CURLOPT_USERAGENT => $job['userAgent'] ?? 'Savepoint/1.0 cover lookup',
                        CURLOPT_CONNECTTIMEOUT_MS => min(2000, $timeout),
                        CURLOPT_TIMEOUT_MS => $timeout,
                        CURLOPT_SSL_VERIFYPEER => true,
                        CURLOPT_SSL_VERIFYHOST => 2,
                        CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use (&$bodies, $id): int {
                            if (strlen($bodies[$id]) + strlen($chunk) > self::MAX_RESPONSE_BYTES) return 0;
                            $bodies[$id] .= $chunk;
                            return strlen($chunk);
                        },
                    ];
                    if (isset($job['body'])) {
                        $options[CURLOPT_POST] = true;
                        $options[CURLOPT_POSTFIELDS] = $job['body'];
                    }
                    curl_setopt_array($handle, $options);
                    if ($multi !== null) {
                        curl_multi_add_handle($multi, $handle);
                    } elseif (curl_exec($handle) !== false) {
                        $completed[] = $handle;
                    }
                }
                if ($multi !== null) {
                    do {
                        $status = curl_multi_exec($multi, $running);
                        $remaining = min(0.2, $deadline - microtime(true));
                        if ($running && $status === CURLM_OK && $remaining > 0
                            && curl_multi_select($multi, $remaining) < 0) {
                            usleep((int)min(10000, $remaining * 1000000));
                        }
                    } while ($running && $status === CURLM_OK && microtime(true) < $deadline);
                    while ($info = curl_multi_info_read($multi)) {
                        if ($info['result'] === CURLE_OK) $completed[] = $info['handle'];
                    }
                }
                foreach ($handles as $id => $handle) {
                    if (in_array($handle, $completed, true) && curl_getinfo($handle, CURLINFO_RESPONSE_CODE) === 200) {
                        $value = json_decode($bodies[$id], true, 24);
                        if (is_array($value)) $results[$id] = $value;
                    }
                }
            } finally {
                if ($multi !== null) {
                    foreach ($handles as $handle) curl_multi_remove_handle($multi, $handle);
                    curl_multi_close($multi);
                }
            }
        }
        return $results;
    }
}
