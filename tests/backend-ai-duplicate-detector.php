<?php
declare(strict_types=1);

use Savepoint\AI\DuplicateDetector;
use Savepoint\AI\GameRecognizer;
use Savepoint\AI\ImportException;

require_once __DIR__ . '/../server/ai/PhotoImport.php';
require_once __DIR__ . '/../server/ai/DuplicateDetector.php';

function expectDuplicate(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

function duplicateGame(string $id, string $title, string $platform = 'PC'): array
{
    return [
        'id' => $id, 'title' => $title, 'platform' => $platform,
        'edition' => 'Fizyczne', 'coverUrl' => 'https://example.test/cover.jpg',
        'status' => 'Do ogrania', 'createdAt' => 1700000000000,
    ];
}

$collection = [
    duplicateGame('game-1', 'Halo', 'Xbox'),
    duplicateGame('game-2', 'Halo: Combat Evolved', 'Xbox'),
    duplicateGame('game-3', 'Halo 2', 'Xbox'),
    duplicateGame('game-4', 'Halo 3', 'Xbox 360'),
    duplicateGame('game-5', 'Grand Theft Auto V', 'PlayStation 3'),
    duplicateGame('game-6', 'GTA 5', 'Xbox 360'),
    duplicateGame('game-7', 'Wonderboy', 'PC, Switch'),
    duplicateGame('game-8', 'Wonderboy', 'Switch, PC'),
    duplicateGame('game-9', 'Wiedźmin'),
    duplicateGame('game-10', 'Wiedzmin'),
    duplicateGame('game-11', 'Maraton'),
    duplicateGame('game-12', 'Marathon'),
];
$seen = [];
$result = DuplicateDetector::find($collection, static function (array $options) use (&$seen): array {
    $matches = [];
    foreach ($options as $option) {
        expectDuplicate(array_keys($option) === ['index', 'left', 'right'], 'Offer only the documented metadata.');
        foreach (['left', 'right'] as $side) {
            expectDuplicate(array_keys($option[$side]) === ['title', 'platform'], 'Do not send row IDs, covers, progress or ownership.');
        }
        $one = $option['left']['title'];
        $two = $option['right']['title'];
        $titles = [$one, $two];
        sort($titles, SORT_STRING);
        $pair = implode(' + ', $titles);
        $seen[] = $pair;
        if (in_array($pair, ['GTA 5 + Grand Theft Auto V', 'Halo + Halo: Combat Evolved',
            'Wiedzmin + Wiedźmin', 'Wonderboy + Wonderboy'], true)) {
            $matches[] = $option['index'];
        }
    }
    return $matches;
});
expectDuplicate(!in_array('Halo 2 + Halo 3', $seen, true), 'Do not send known different numbered games.');
expectDuplicate(in_array('Marathon + Maraton', $seen, true), 'Review probable spelling variants.');
expectDuplicate(count($result['pairs']) === 4 && !$result['limited'], 'Keep only the model-confirmed probable matches.');
$recommendations = array_column($result['pairs'], 'recommendation');
expectDuplicate(count(array_keys($recommendations, 'delete', true)) === 1 && count(array_keys($recommendations, 'merge', true)) === 3,
    'Delete recommendations require identical stored details, with platform order ignored.');
expectDuplicate(count($collection) === 12, 'A scan must not edit its input collection.');

$abbreviatedTitles = [
    ['GoW', 'God of War'],
    ['NFS', 'Need for Speed'],
    ['CKE', 'Celestial Knights of Ember'],
    ['LoZ', 'The Legend of Zelda'],
    ['RE', 'Resident Evil'],
    ['FFVII', 'Final Fantasy 7'],
    ['GTA VI', 'Grand Theft Auto VI'],
    ['G.T.A. VI', 'Grand Theft Auto VI'],
    ['GTAVI', 'Grand Theft Auto VI'],
    ['RDR2', 'Red Dead Redemption II'],
    ['AC Valhalla', 'Assassin’s Creed Valhalla'],
    ['CoD MWII', 'Call of Duty: Modern Warfare II'],
    ['GoW Ragnarök', 'God of War Ragnarök'],
    ['FFXIV', 'Final Fantasy 14'],
    ['FFXVI', 'Final Fantasy XVI'],
    ['TLOU 2', 'The Last of Us Part II'],
    ['BOTW', 'The Legend of Zelda: Breath of the Wild'],
    ['MGS 3', 'Metal Gear Solid 3: Snake Eater'],
    ['MGS 3', 'Metal Gear Solid 3 Snake Eater'],
];
foreach ($abbreviatedTitles as [$abbreviation, $fullTitle]) {
    $reviewed = [];
    $records = [duplicateGame('abbreviation', $abbreviation, 'PC'), duplicateGame('full-title', $fullTitle, 'Xbox')];
    $result = DuplicateDetector::find($records, static function (array $options) use (&$reviewed): array {
        $reviewed = $options;
        return array_column($options, 'index');
    });
    $expectedTitles = [$abbreviation, $fullTitle];
    sort($expectedTitles, SORT_STRING);
    $offeredTitles = [$reviewed[0]['left']['title'] ?? '', $reviewed[0]['right']['title'] ?? ''];
    sort($offeredTitles, SORT_STRING);
    expectDuplicate(count($reviewed) === 1 && $expectedTitles === $offeredTitles,
        "Offer unchanged title strings for model review: $abbreviation / $fullTitle.");
    expectDuplicate(count($result['pairs']) === 1 && $result['pairs'][0]['recommendation'] === 'merge',
        'An approved abbreviation yields a merge suggestion.');
}

$providerRejected = null;
$result = DuplicateDetector::find([
    duplicateGame('initials', 'GoW'),
    duplicateGame('canonical', 'God of War'),
], static function (array $options) use (&$providerRejected): array {
    $providerRejected = count($options);
    return [];
});
expectDuplicate($providerRejected === 1 && $result['pairs'] === [], 'An abbreviation never bypasses model confirmation.');

$differentInstallments = [
    ['GTA V', 'Grand Theft Auto VI'],
    ['GTAV', 'Grand Theft Auto VI'],
    ['FFVIII', 'Final Fantasy VII'],
    ['FFVII', 'FFVIII'],
    ['CoD MWII', 'CoD MWIII'],
    ['TLOU 3', 'The Last of Us Part II'],
    ['MGS 2', 'Metal Gear Solid 3: Snake Eater'],
];
foreach ($differentInstallments as [$abbreviation, $fullTitle]) {
    $result = DuplicateDetector::find([
        duplicateGame('abbreviation', $abbreviation),
        duplicateGame('full-title', $fullTitle),
    ], static fn(array $options): array => array_column($options, 'index'));
    expectDuplicate($result['pairs'] === [], "Different installment numbers do not match: $abbreviation / $fullTitle.");
}

$lateEntries = [];
for ($index = 0; $index < 4998; $index++) {
    $lateEntries[] = duplicateGame('record-' . $index, 'Fixture ' . $index);
}
$lateEntries[] = duplicateGame('late-one', 'Yooka-Laylee');
$lateEntries[] = duplicateGame('late-two', 'Yooka Laylee');
$result = DuplicateDetector::find($lateEntries, static fn(array $options): array => array_column($options, 'index'));
expectDuplicate(count($result['pairs']) === 1 && $result['pairs'][0]['left']['id'] === 'late-one', 'Check beyond the first rows of a 5,000-game collection.');

$manyCopies = [];
for ($index = 0; $index < 105; $index++) {
    $manyCopies[] = duplicateGame('duplicate-' . $index, 'Identical Fixture');
}
$result = DuplicateDetector::find($manyCopies, static function (array $options): array {
    expectDuplicate(count($options) === 96, 'Bound each Gemini duplicate request.');
    return array_column($options, 'index');
});
expectDuplicate($result['limited'] && count($result['pairs']) === 96, 'Report omitted comparisons rather than an exhaustive result.');

$mixedCollection = [...$manyCopies, duplicateGame('short-name', 'NFS'), duplicateGame('long-name', 'Need for Speed')];
$result = DuplicateDetector::find($mixedCollection, static function (array $options): array {
    expectDuplicate(count($options) === 96, 'Including abbreviations must keep the existing batch limit.');
    foreach ($options as $option) {
        $titles = [$option['left']['title'], $option['right']['title']];
        if (in_array('NFS', $titles, true) && in_array('Need for Speed', $titles, true)) return [$option['index']];
    }
    throw new RuntimeException('Exact matches must not crowd strong abbreviations out of the batch.');
});
expectDuplicate($result['limited'] && count($result['pairs']) === 1 && $result['pairs'][0]['recommendation'] === 'merge',
    'Publish only the accepted abbreviation suggestion in the capped scan.');

$copiesForPagination = array_slice($manyCopies, 0, 17);
$allPairs = [];
$next = null;
do {
    $page = DuplicateDetector::find($copiesForPagination, static function (array $options): array {
        expectDuplicate(count($options) <= 96, 'Every continuation uses one bounded Gemini call.');
        return array_column($options, 'index');
    }, $next);
    foreach ($page['pairs'] as $pair) {
        $key = $pair['left']['id'] . '/' . $pair['right']['id'];
        expectDuplicate(!isset($allPairs[$key]), 'A continuation does not repeat offered pairs.');
        $allPairs[$key] = true;
    }
    $next = $page['position'];
} while ($next !== null);
expectDuplicate(count($allPairs) === 136 && $page['limited'] === false, 'Continuation reaches each possible identical pair in the snapshot.');

$budgetPath = sys_get_temp_dir() . '/savepoint-duplicate-test-' . bin2hex(random_bytes(8));
$fixtureOption = static fn(int $index): array => ['index' => $index, 'left' => ['title' => 'Test', 'platform' => 'PC'],
    'right' => ['title' => 'Test', 'platform' => 'PC']];
$options = array_map($fixtureOption, [22, 57, 3]);
$verdicts = [
    ['index' => 3, 'duplicate' => true],
    ['index' => 57, 'duplicate' => false],
    ['index' => 22, 'duplicate' => true],
];
$invalidReplies = [
    'legacy sparse response' => ['matches' => [22, 3]],
    'empty list' => ['decisions' => []],
    'missing verdict' => ['decisions' => array_slice($verdicts, 0, 2)],
    'repeated index' => ['decisions' => [$verdicts[0], $verdicts[1], $verdicts[0]]],
    'foreign index' => ['decisions' => [$verdicts[0], $verdicts[1], ['index' => 300, 'duplicate' => true]]],
    'string index' => ['decisions' => [$verdicts[0], $verdicts[1], ['index' => '22', 'duplicate' => true]]],
    'decimal index' => ['decisions' => [$verdicts[0], $verdicts[1], ['index' => 22.0, 'duplicate' => true]]],
    'string verdict' => ['decisions' => [$verdicts[0], $verdicts[1], ['index' => 22, 'duplicate' => 'false']]],
    'integer verdict' => ['decisions' => [$verdicts[0], $verdicts[1], ['index' => 22, 'duplicate' => 1]]],
    'missing verdict field' => ['decisions' => [$verdicts[0], $verdicts[1], ['index' => 22]]],
    'extra verdict field' => ['decisions' => [$verdicts[0], $verdicts[1], $verdicts[2] + ['note' => 'extra']]],
    'extra top-level field' => ['decisions' => $verdicts, 'note' => 'extra'],
    'object instead of list' => ['decisions' => (object)$verdicts],
];
$limit = count($invalidReplies) + 3;
$config = ['enabled' => true, 'api_key' => 'synthetic-duplicate-test-key', 'model' => 'gemini-3.5-flash-lite', 'hourly_limit' => $limit];
$reply = ['decisions' => $verdicts];
$calls = 0;
$transport = static function (array $payload, string $key, int $timeout) use (&$calls, &$reply, &$options): array {
    $calls++;
    expectDuplicate($timeout === 25 && $key === 'synthetic-duplicate-test-key', 'Use the configured model transport with bounded duration.');
    expectDuplicate(!isset($payload['tools']) && !str_contains(json_encode($payload), $key), 'Do not send tools or embed credentials in the prompt.');
    expectDuplicate(json_decode($payload['contents'][0]['parts'][0]['text'], true) === $options, 'Send the original shortlisted metadata in one request.');
    $generation = $payload['generationConfig'];
    expectDuplicate($generation['maxOutputTokens'] === 3072 && $generation['thinkingConfig']['thinkingLevel'] === 'low',
        'Allow time and output for a complete batch of verdicts.');
    $decision = $generation['responseJsonSchema']['properties']['decisions']['items']['properties'];
    expectDuplicate($decision['index']['type'] === 'integer' && $decision['duplicate']['type'] === 'boolean',
        'Require a typed verdict with an explicit pair index.');
    $text = json_encode($reply, JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION);
    return ['candidates' => [['finishReason' => 'STOP', 'content' => ['parts' => [['text' => $text]]]]]];
};
$model = new GameRecognizer($config, $budgetPath, $transport, static fn(): int => 1700000000);
try {
    expectDuplicate($model->recognizeDuplicates($options) === [22, 3], 'Return positive verdicts in the original order regardless of the reply order.');
    $reply = ['decisions' => array_map(static fn(int $index): array => ['index' => $index, 'duplicate' => false], [22, 57, 3])];
    expectDuplicate($model->recognizeDuplicates($options) === [], 'A complete negative review produces no duplicate suggestions.');
    foreach ($invalidReplies as $reason => $reply) {
        try {
            $model->recognizeDuplicates($options);
            throw new RuntimeException("Reject $reason.");
        } catch (ImportException $error) {
            expectDuplicate($error->errorId === 'ai_response_invalid', "Reject $reason as an invalid model response.");
        }
    }
    $fullBatchIndexes = range(100, 195);
    $options = array_map($fixtureOption, $fullBatchIndexes);
    $reply = ['decisions' => array_map(static fn(int $index): array => ['index' => $index, 'duplicate' => true], array_reverse($fullBatchIndexes))];
    expectDuplicate($model->recognizeDuplicates($options) === $fullBatchIndexes, 'Accept one verdict for each of the 96 offered pairs.');
    try {
        $model->recognizeDuplicates($options);
        throw new RuntimeException('Expected the duplicate scan budget to be exhausted.');
    } catch (ImportException $error) {
        expectDuplicate($error->errorId === 'ai_rate_limited' && $calls === $limit, 'Enforce a separate hourly Gemini scan budget.');
    }
    expectDuplicate(file_exists($budgetPath . '/duplicate-budget.json') && !file_exists($budgetPath . '/cover-budget.json'),
        'Keep the duplicate and cover budgets independent.');
} finally {
    foreach (new FilesystemIterator($budgetPath) as $entry) unlink($entry->getPathname());
    rmdir($budgetPath);
}

echo "PASS: title variants across the collection, bounded Gemini metadata and complete duplicate decisions.\n";
