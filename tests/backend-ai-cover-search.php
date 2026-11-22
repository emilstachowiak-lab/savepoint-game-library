<?php
declare(strict_types=1);

// Synthetic provider responses cover catalogue matching and outages. A Gemini
// stub captures the offered choices and returns selections.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

require_once dirname(__DIR__) . '/server/ai/CoverFinder.php';
require_once dirname(__DIR__) . '/server/ai/PhotoImport.php';

use Savepoint\AI\CoverFinder;
use Savepoint\AI\GameRecognizer;
use Savepoint\AI\ImportException;

function expectCover(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

function detectedCoverGame(string $title, string $confidence = 'high', string $platform = 'PC'): array
{
    return ['title' => $title, 'platform' => $platform, 'confidence' => $confidence, 'note' => 'Keep this note.'];
}

$timeoutFixture = ['candidates' => [detectedCoverGame('Synthetic game')]];
$doNotCall = static function (): never { throw new RuntimeException('An expired deadline cannot start another request.'); };
expectCover(CoverFinder::addSuggestions($timeoutFixture, $doNotCall, [], $doNotCall, deadline: microtime(true) - 1)
    === $timeoutFixture + ['coverSearch' => 'unavailable'], 'An expired cover deadline preserves recognized games.');
try {
    CoverFinder::addSuggestions($timeoutFixture, $doNotCall, [], $doNotCall,
        singleCover: true, deadline: microtime(true) - 1);
    throw new RuntimeException('Manual cover search must report an exhausted deadline.');
} catch (ImportException $error) {
    expectCover($error->errorId === 'ai_provider_timeout' && $error->status === 504,
        'Manual cover search reports the exhausted deadline separately from an empty search.');
}

function igdbGame(int $id, string $title, string $slug, string $image, string $platform): array
{
    return [
        'id' => $id,
        'name' => $title,
        'slug' => $slug,
        'cover' => ['id' => $id + 100, 'image_id' => $image],
        'platforms' => [['id' => $id + 200, 'name' => $platform]],
        'first_release_date' => 1016928000,
        'game_type' => 0,
    ];
}

function steamGrid(int $id, string $image): array
{
    return [
        'id' => $id,
        'url' => $image,
        'width' => 600,
        'height' => 900,
        'style' => 'alternate',
        'mime' => 'image/png',
        'nsfw' => false,
        'humor' => false,
        'epilepsy' => false,
    ];
}

function wikipediaPage(int $pageId, string $title, string $cover, string $description = '2001 video game'): array
{
    return [
        'ns' => 0,
        'pageid' => $pageId,
        'title' => $title,
        'pageimage' => 'Fixture_cover.jpg',
        'pageprops' => ['wikibase-shortdesc' => $description],
        'thumbnail' => ['source' => $cover, 'width' => 220, 'height' => 300],
    ];
}

function coverFixture(
    array $igdb,
    array $steamGames,
    array $steamArtwork,
    array &$calls,
    array $failed = [],
    array $wikipediaQuery = ['pages' => []],
): Closure {
    return static function (array $requests) use ($igdb, $steamGames, $steamArtwork, &$calls, $failed, $wikipediaQuery): array {
        $responses = [];
        foreach ($requests as $key => $request) {
            $calls[] = $request;
            $parts = parse_url($request['url']);
            $host = $parts['host'] ?? '';
            $path = $parts['path'] ?? '';
            $responses[$key] = null;
            if (in_array($host, $failed, true)) continue;
            if ($host === 'id.twitch.tv' && $path === '/oauth2/token') {
                $responses[$key] = ['access_token' => 'synthetic-twitch-access-token', 'token_type' => 'bearer', 'expires_in' => 3600];
            } elseif ($host === 'api.igdb.com' && $path === '/v4/games') {
                preg_match_all('~\bname\s*\~\s*("(?:[^"\\\\]|\\\\.)*")~', $request['body'] ?? '', $queries);
                $responses[$key] = [];
                foreach ($queries[1] as $query) {
                    $title = json_decode($query, true, 2, JSON_THROW_ON_ERROR);
                    array_push($responses[$key], ...($igdb[$title] ?? []));
                }
            } elseif ($host === 'www.steamgriddb.com' && str_starts_with($path, '/api/v2/search/autocomplete/')) {
                $responses[$key] = ['success' => true, 'data' => $steamGames[rawurldecode(basename($path))] ?? []];
            } elseif ($host === 'www.steamgriddb.com' && str_starts_with($path, '/api/v2/grids/game/')) {
                $responses[$key] = ['success' => true, 'data' => $steamArtwork[basename($path)] ?? []];
            } elseif ($host === 'en.wikipedia.org' && $path === '/w/api.php') {
                $responses[$key] = ['query' => $wikipediaQuery];
            }
        }
        return $responses;
    };
}

function chosenCover(array $options, string $title, string $provider): int
{
    foreach ($options as $option) {
        if ($option['title'] === $title && $option['provider'] === $provider) return $option['index'];
    }
    throw new RuntimeException('Missing catalogue option: ' . $title . ' (' . $provider . ').');
}

$config = [
    'steamgriddb_key' => 'synthetic-steamgriddb-key',
    'igdb_client_id' => 'synthetic-igdb-client-id',
    'igdb_client_secret' => 'synthetic-igdb-client-secret',
];
$igdbCover = 'https://images.igdb.com/igdb/image/upload/t_cover_big/cofixture1.jpg';
$consoleCover = 'https://images.igdb.com/igdb/image/upload/t_cover_big/cofixture2.jpg';
$steamCover = 'https://cdn2.steamgriddb.com/grid/00000000000000000000000000000001.png';
$igdb = [
    'Fixture Prime' => [igdbGame(100, 'Fixture Prime', 'fixture-prime', 'cofixture1', 'PC (Microsoft Windows)')],
    'Console Fixture' => [igdbGame(101, 'Console Fixture', 'console-fixture', 'cofixture2', 'PlayStation 2')],
    'Wrong Platform' => [igdbGame(102, 'Wrong Platform', 'wrong-platform', 'cofixture3', 'PC (Microsoft Windows)')],
    'Unrelated Quest' => [igdbGame(103, 'Unrelated Quest II', 'unrelated-quest-ii', 'cofixture4', 'PC (Microsoft Windows)')],
];
$steamGames = [
    'Fixture Prime' => [
        ['id' => 60, 'name' => 'Fixture Prime II', 'types' => ['steam'], 'verified' => true],
        ['id' => 61, 'name' => 'Fixture Prime', 'types' => ['steam'], 'verified' => true],
    ],
    'Unrelated Quest' => [['id' => 62, 'name' => 'Unrelated Quest II', 'types' => ['steam'], 'verified' => true]],
    'Wrong Platform' => [['id' => 63, 'name' => 'Wrong Platform', 'types' => ['steam'], 'verified' => true]],
];
$steamArtwork = [61 => [steamGrid(77, $steamCover)], 63 => [steamGrid(78, $steamCover)]];
$detection = ['candidates' => [
    detectedCoverGame('Fixture Prime'),
    detectedCoverGame('Uncertain Quest', 'low'),
    detectedCoverGame('Console Fixture', 'medium', 'PlayStation 2'),
    detectedCoverGame('Wrong Platform', 'high', 'Nintendo Switch'),
    detectedCoverGame('Unrelated Quest'),
    detectedCoverGame('Unknown Platform', 'medium', 'Inna'),
], 'notes' => 'Detection notes survive.'];
$calls = $matcherInput = [];
$fixture = coverFixture($igdb, $steamGames, $steamArtwork, $calls);
$selection = CoverFinder::addSuggestions($detection, static function (array $options) use (&$matcherInput): array {
    $matcherInput = $options;
    return [chosenCover($options, 'Fixture Prime', 'steamgriddb'), chosenCover($options, 'Console Fixture', 'igdb'),
        chosenCover($options, 'Fixture Prime', 'igdb')];
}, $config, $fixture);
expectCover(count($matcherInput) === 3 && count(array_unique(array_column($matcherInput, 'index'))) === 3,
    'Each eligible catalogue option must have its own choice ID across providers and rows.');
expectCover(array_diff(array_column($matcherInput, 'title'), ['Fixture Prime', 'Console Fixture']) === [],
    'Gemini receives only exact catalogue titles with the applicable platform evidence.');
expectCover(array_diff(array_column($matcherInput, 'platform'), ['PC', 'PlayStation 2']) === [],
    'Gemini receives the platform identified in the photo for each option.');
$igdbOption = $matcherInput[chosenCover($matcherInput, 'Fixture Prime', 'igdb')];
$steamOption = $matcherInput[chosenCover($matcherInput, 'Fixture Prime', 'steamgriddb')];
expectCover($igdbOption['cataloguePlatforms'] === ['PC (Microsoft Windows)'] && $steamOption['cataloguePlatforms'] === [],
    'The verifier sees supported IGDB platforms and does not receive invented platform evidence for SteamGridDB.');
$withoutSuggestions = $selection;
foreach ([0 => [$igdbCover, 'fixture-prime'], 2 => [$consoleCover, 'console-fixture']] as $index => [$image, $slug]) {
    $candidate = $selection['candidates'][$index];
    expectCover(($candidate['coverUrl'] ?? null) === $image && ($candidate['coverSource'] ?? null) === 'igdb'
        && ($candidate['coverSourceUrl'] ?? null) === 'https://www.igdb.com/games/' . $slug,
        'An approved IGDB match uses the direct cover URL and game page, with priority over accepted SteamGridDB art.');
    unset($withoutSuggestions['candidates'][$index]['coverUrl'], $withoutSuggestions['candidates'][$index]['coverSourceUrl'],
        $withoutSuggestions['candidates'][$index]['coverSource']);
}
expectCover($withoutSuggestions === $detection, 'Adding suggestions preserves all recognition fields and ineligible rows.');
$catalogueCalls = json_encode($calls, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
foreach (['Uncertain Quest', 'Unknown Platform', 'Keep this note.', 'Detection notes survive.'] as $ignored) {
    expectCover(!str_contains($catalogueCalls, $ignored) && !str_contains($catalogueCalls, rawurlencode($ignored)),
        'Catalogue calls must contain only eligible detected titles.');
}
expectCover(!str_contains($catalogueCalls, '/grids/game/60') && !str_contains($catalogueCalls, '/grids/game/62'),
    'A fuzzy title match must not cause artwork requests for a different game.');
$steamCalls = array_filter($calls, static fn(array $call): bool => parse_url($call['url'], PHP_URL_HOST) === 'www.steamgriddb.com');
expectCover($steamCalls !== [], 'SteamGridDB should receive its own catalogue searches.');
foreach ($steamCalls as $call) {
    expectCover(in_array('Authorization: Bearer ' . $config['steamgriddb_key'], $call['headers'], true)
        && !str_contains($call['url'], $config['steamgriddb_key']) && !isset($call['body']),
        'SteamGridDB authentication belongs in the header of its catalogue GET requests.');
}
echo "PASS: exact title and platform filtering, unique choices and intact recognition results.\n";

$forPrime = ['candidates' => [detectedCoverGame('Fixture Prime')], 'notes' => 'Both catalogue selections remain optional.'];
$steamOnly = CoverFinder::addSuggestions($forPrime, static fn(array $options): array => [chosenCover($options, 'Fixture Prime', 'steamgriddb')],
    $config, $fixture);
$prime = $steamOnly['candidates'][0];
expectCover(($prime['coverUrl'] ?? null) === $steamCover && ($prime['coverSource'] ?? null) === 'steamgriddb'
    && ($prime['coverSourceUrl'] ?? null) === 'https://www.steamgriddb.com/grid/77',
    'Selecting only the SteamGridDB option keeps its direct image and source page.');
expectCover(CoverFinder::addSuggestions($forPrime, static fn(array $options): array => [], $config, $fixture) === $forPrime,
    'A Gemini veto leaves recognition unchanged.');

$igdbConfig = array_diff_key($config, ['steamgriddb_key' => null]);
$ambiguousIgdb = $igdb;
$ambiguousIgdb['Fixture Prime'][] = igdbGame(104, 'Fixture Prime', 'fixture-prime-remake', 'cofixture5', 'PC (Microsoft Windows)');
$ambiguousFixture = coverFixture($ambiguousIgdb, [], [], $calls);
$called = false;
$ambiguousSelection = CoverFinder::addSuggestions($forPrime, static function (array $options) use (&$called): array {
    $called = true;
    return array_column($options, 'index');
}, $igdbConfig, $ambiguousFixture);
expectCover(!$called && $ambiguousSelection === $forPrime,
    'Distinct IGDB covers for the same title and platform leave the ambiguous release for manual review.');

$steamConfig = ['steamgriddb_key' => $config['steamgriddb_key']];
foreach ([
    'HTTP' => str_replace('https:', 'http:', $steamCover),
    'deceptive host' => str_replace('cdn2.steamgriddb.com', 'cdn2.steamgriddb.com.example', $steamCover),
    'credentials' => str_replace('https://', 'https://user@', $steamCover),
    'SVG' => str_replace('.png', '.svg', $steamCover),
] as $label => $url) {
    $badFixture = coverFixture([], $steamGames, [61 => [steamGrid(77, $url)]], $calls);
    $called = false;
    $result = CoverFinder::addSuggestions($forPrime, static function (array $options) use (&$called): array {
        $called = true;
        return array_column($options, 'index');
    }, $steamConfig, $badFixture);
    expectCover(!$called && $result === $forPrime, 'Invalid ' . $label . ' image cannot become a suggested URL.');
}
echo "PASS: reviewed SteamGridDB art uses renderable links and invalid links are skipped.\n";

$acceptAll = static fn(array $options): array => array_column($options, 'index');
foreach ([
    ['failed' => ['id.twitch.tv'], 'cover' => $steamCover],
    ['failed' => ['api.igdb.com'], 'cover' => $steamCover],
    ['failed' => ['www.steamgriddb.com'], 'cover' => $igdbCover],
] as ['failed' => $failed, 'cover' => $expected]) {
    $workingProvider = coverFixture($igdb, $steamGames, $steamArtwork, $calls, $failed);
    $result = CoverFinder::addSuggestions($forPrime, $acceptAll, $config, $workingProvider);
    expectCover(($result['candidates'][0]['coverUrl'] ?? null) === $expected && !isset($result['coverSearch']),
        'One failed catalogue must leave the other catalogue and recognition usable.');
}
$unavailable = $forPrime + ['coverSearch' => 'unavailable'];
$allFailed = coverFixture([], [], [], $calls, ['id.twitch.tv', 'api.igdb.com', 'www.steamgriddb.com', 'en.wikipedia.org']);
expectCover(CoverFinder::addSuggestions($forPrime, $acceptAll, $config, $allFailed) === $unavailable,
    'When all configured catalogues fail, the browser receives only an unavailable status alongside recognition.');
$emptyIgdb = coverFixture([], [], [], $calls, ['www.steamgriddb.com']);
expectCover(CoverFinder::addSuggestions($forPrime, $acceptAll, $config, $emptyIgdb) === $forPrime,
    'A successful search with no matching games leaves recognition unchanged.');
$before = count($calls);
$noEligible = ['candidates' => [detectedCoverGame('Uncertain Quest', 'low')], 'notes' => 'Review the row manually.'];
expectCover(CoverFinder::addSuggestions($noEligible, $acceptAll, $config, $fixture) === $noEligible && count($calls) === $before,
    'Recognition with no eligible games skips all cover provider work.');
expectCover(CoverFinder::addSuggestions($forPrime, static function (array $options): never {
    throw new RuntimeException('Private upstream detail');
}, $config, $fixture) === $unavailable, 'Gemini cover check failure preserves recognized games without exposing provider errors.');
echo "PASS: partial catalogue and verifier failures preserve recognition.\n";

$wikimediaCover = 'https://upload.wikimedia.org/wikipedia/en/thumb/a/ab/Fixture_cover.jpg/220px-Fixture_cover.jpg';
$commonsCover = str_replace('/en/', '/commons/', $wikimediaCover);
$wikipedia = ['pages' => [
    wikipediaPage(101, 'Fixture Prime', $wikimediaCover),
    wikipediaPage(102, 'Console Fixture (video game)', $commonsCover),
    wikipediaPage(103, 'Wrong Platform', $wikimediaCover),
    wikipediaPage(104, 'Canonical Quest', $wikimediaCover . '?tracking=fixture'),
], 'redirects' => [['from' => 'Unrelated Quest', 'to' => 'Canonical Quest']]];
$calls = $matchBatches = [];
$fixture = coverFixture($igdb, $steamGames, $steamArtwork, $calls, [], $wikipedia);
$selection = CoverFinder::addSuggestions($detection, static function (array $options) use (&$matchBatches, &$calls): array {
    $matchBatches[] = $options;
    if (count($matchBatches) === 1) {
        expectCover(!in_array('en.wikipedia.org', array_map(static fn(array $call): ?string =>
            parse_url($call['url'], PHP_URL_HOST), $calls), true), 'Primary options must be checked before visiting Wikipedia.');
        return [chosenCover($options, 'Fixture Prime', 'igdb')];
    }
    return array_column($options, 'index');
}, $config, $fixture);
$wikiCalls = array_values(array_filter($calls, static fn(array $call): bool => parse_url($call['url'], PHP_URL_HOST) === 'en.wikipedia.org'));
expectCover(count($wikiCalls) === 1, 'Each photo batch needs only one anonymous Wikipedia lookup.');
parse_str($wikiCalls[0]['body'] ?? '', $query);
$wikiTitles = explode('|', $query['titles'] ?? '');
expectCover(($query['action'] ?? null) === 'query' && ($query['prop'] ?? null) === 'pageimages|pageprops'
    && ($query['redirects'] ?? null) === '1' && in_array('Console Fixture', $wikiTitles, true)
    && in_array('Unrelated Quest', $wikiTitles, true)
    && array_diff($wikiTitles, ['Console Fixture', 'Console Fixture (video game)', 'Unrelated Quest', 'Unrelated Quest (video game)']) === [],
    'Wikipedia should receive only the titles of rows that lack a verified compatible cover.');
expectCover($wikiCalls[0]['url'] === 'https://en.wikipedia.org/w/api.php'
    && preg_grep('/^(authorization|client-id|x-goog-api-key):/i', $wikiCalls[0]['headers']) === []
    && !str_contains($wikiCalls[0]['body'], 'synthetic-') && !str_contains($wikiCalls[0]['body'], 'Keep%20this%20note'),
    'Wikipedia lookup must use the fixed endpoint without provider credentials or recognition notes.');
expectCover(count($matchBatches) === 2 && array_column($matchBatches[1], 'gameIndex') === [2, 4]
    && array_column($matchBatches[1], 'provider') === ['wikipedia', 'wikipedia'],
    'Gemini verifies Wikipedia metadata only for the missing rows, preserving their original indexes.');
expectCover(($selection['candidates'][0]['coverUrl'] ?? null) === $igdbCover && !isset($selection['candidates'][3]['coverUrl']),
    'The fallback must preserve a verified primary cover and skip releases known to be incompatible.');
foreach ([2 => [$commonsCover, 102], 4 => [$wikimediaCover, 104]] as $row => [$imageUrl, $pageId]) {
    $candidate = $selection['candidates'][$row];
    expectCover(($candidate['coverUrl'] ?? null) === $imageUrl && ($candidate['coverSource'] ?? null) === 'wikipedia'
        && ($candidate['coverSourceUrl'] ?? null) === 'https://en.wikipedia.org/?curid=' . $pageId,
        'Verified fallback artwork must use an approved Wikimedia image and link to its article.');
}
$calls = [];
$unconfigured = CoverFinder::addSuggestions($forPrime, $acceptAll, [], $fixture);
expectCover(($unconfigured['candidates'][0]['coverUrl'] ?? null) === $wikimediaCover && count($calls) === 1
    && parse_url($calls[0]['url'], PHP_URL_HOST) === 'en.wikipedia.org',
    'Wikipedia fallback remains available when neither primary catalogue is configured.');
$primaryFailures = coverFixture([], [], [], $calls, ['api.igdb.com', 'www.steamgriddb.com'], $wikipedia);
$selection = CoverFinder::addSuggestions($forPrime, $acceptAll, $config, $primaryFailures);
expectCover(($selection['candidates'][0]['coverUrl'] ?? null) === $wikimediaCover && !isset($selection['coverSearch']),
    'An outage at both primary catalogues does not prevent a verified Wikipedia suggestion.');

$calls = [];
$manualPlatforms = ['candidates' => [detectedCoverGame('Fixture Prime'), detectedCoverGame('Fixture Prime', 'high', 'Xbox 360')]];
$manualResult = CoverFinder::addSuggestions($manualPlatforms, static fn(array $options): array => [0],
    $steamConfig, $fixture, singleCover: true);
expectCover(($manualResult['candidates'][0]['coverUrl'] ?? null) === $steamCover && !isset($manualResult['candidates'][1]['coverUrl'])
    && !in_array('en.wikipedia.org', array_map(static fn(array $call): ?string => parse_url($call['url'], PHP_URL_HOST), $calls), true),
    'Manual lookup for one game skips Wikipedia once an eligible primary cover is verified for any selected console.');

$fallbackOutage = coverFixture($igdb, $steamGames, $steamArtwork, $calls, ['en.wikipedia.org'], $wikipedia);
$selection = CoverFinder::addSuggestions($detection, $acceptAll, $config, $fallbackOutage);
expectCover(($selection['candidates'][0]['coverUrl'] ?? null) === $igdbCover
    && ($selection['candidates'][2]['coverUrl'] ?? null) === $consoleCover,
    'A Wikipedia outage for uncovered rows must preserve other verified suggestions.');

$calls = [];
$fullBatch = ['candidates' => []];
foreach (range(1, 32) as $row) $fullBatch['candidates'][] = detectedCoverGame(str_repeat('Ł', 74) . ' ' . $row);
$fixture = coverFixture([], [], [], $calls);
expectCover(CoverFinder::addSuggestions($fullBatch, $acceptAll, [], $fixture) === $fullBatch && count($calls) === 2,
    'A full photo batch can query every title without exceeding Wikipedia request limits.');
$requested = [];
foreach ($calls as $call) {
    parse_str($call['body'] ?? '', $query);
    $titles = explode('|', $query['titles'] ?? '');
    expectCover(count($titles) <= 50, 'Every anonymous PageImages request must respect its title limit.');
    array_push($requested, ...$titles);
}
foreach (array_column($fullBatch['candidates'], 'title') as $title) {
    expectCover(in_array($title, $requested, true) && in_array($title . ' (video game)', $requested, true),
        'A full batch keeps each exact title and its disambiguated variant.');
}

foreach ([
    'HTTP' => wikipediaPage(101, 'Fixture Prime', str_replace('https:', 'http:', $wikimediaCover)),
    'foreign host' => wikipediaPage(101, 'Fixture Prime', str_replace('upload.wikimedia.org', 'upload.wikimedia.org.example', $wikimediaCover)),
    'credentials' => wikipediaPage(101, 'Fixture Prime', str_replace('https://', 'https://user@', $wikimediaCover)),
    'unsafe path' => wikipediaPage(101, 'Fixture Prime', str_replace('/a/ab/', '/a/%2E%2E/', $wikimediaCover)),
    'SVG' => wikipediaPage(101, 'Fixture Prime', str_replace('.jpg', '.svg', $wikimediaCover)),
    'game series' => wikipediaPage(101, 'Fixture Prime', $wikimediaCover, 'Video game series'),
    'disambiguation page' => array_replace($wikipedia['pages'][0], ['pageprops' => ['disambiguation' => '',
        'wikibase-shortdesc' => '2001 video game']]),
] as $label => $page) {
    $fixture = coverFixture([], [], [], $calls, [], ['pages' => [$page]]);
    $offered = false;
    $result = CoverFinder::addSuggestions($forPrime, static function (array $options) use (&$offered): array {
        $offered = true;
        return array_column($options, 'index');
    }, [], $fixture);
    expectCover(!$offered && $result === $forPrime, 'Wikipedia cannot suggest an ineligible ' . $label . ' entry.');
}
echo "PASS: verified Wikipedia fallback fills only eligible missing covers without exposing credentials or unsafe links.\n";

$fixture = coverFixture($igdb, $steamGames, $steamArtwork, $calls);

$budgetDirectory = sys_get_temp_dir() . '/savepoint-cover-check-' . bin2hex(random_bytes(8));
mkdir($budgetDirectory, 0700);
try {
    $gemini = ['enabled' => true, 'api_key' => 'synthetic-gemini-key-not-real', 'model' => 'gemini-3.5-flash-lite'];
    $consoleIndex = chosenCover($matcherInput, 'Console Fixture', 'igdb');
    $modelResult = ['matches' => [$consoleIndex]];
    $modelPayload = [];
    $recognizer = new GameRecognizer($gemini, $budgetDirectory, static function (array $payload, string $key) use (&$modelResult, &$modelPayload): array {
        $modelPayload = $payload;
        return ['candidates' => [['finishReason' => 'STOP', 'content' => ['parts' => [
            ['text' => json_encode($modelResult, JSON_THROW_ON_ERROR)],
        ]]]]];
    });
    expectCover($recognizer->selectCovers($matcherInput) === [$consoleIndex], 'Gemini can select a submitted catalogue option ID.');
    $parts = $modelPayload['contents'][0]['parts'];
    expectCover(count($parts) === 1 && json_decode($parts[0]['text'], true, 16, JSON_THROW_ON_ERROR) === $matcherInput,
        'The cover check sends only the offered catalogue metadata for Gemini to review.');
    foreach (['images.igdb.com', 'steamgriddb.com', ...array_values($config), 'synthetic-twitch-access-token'] as $privateValue) {
        expectCover(!str_contains($parts[0]['text'], $privateValue), 'Gemini cover metadata must omit image URLs and credentials.');
    }
    foreach ([['matches' => [999999]], ['matches' => ['0']],
        ['matches' => [], 'coverUrl' => 'https://img.example/cover.jpg']] as $invalidResult) {
        $modelResult = $invalidResult;
        $rejected = CoverFinder::addSuggestions($forPrime, $recognizer->selectCovers(...), $config, $fixture);
        expectCover($rejected === $unavailable, 'Gemini cannot select unknown IDs or return additional cover data.');
    }
} finally {
    foreach (new FilesystemIterator($budgetDirectory) as $entry) unlink($entry->getPathname());
    rmdir($budgetDirectory);
}
echo "PASS: the Gemini transport receives metadata and accepts only offered cover IDs.\n";
