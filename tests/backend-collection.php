<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

use Savepoint\Collection\TransferError;
use Savepoint\Collection\TransferStore;

require dirname(__DIR__) . '/server/collection/TransferStore.php';

function collectionExpect(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

function collectionThrows(callable $operation, string $type, string $code): void
{
    try {
        $operation();
    } catch (Throwable $error) {
        collectionExpect($error instanceof $type && $error->getMessage() === $code, 'Unexpected validation or conflict.');
        return;
    }
    throw new RuntimeException('Expected collection operation to fail.');
}

// Run the actual row mapping and transactions against an isolated SQLite
// database. The adapter translates the MySQL-specific date and lock syntax.
final class CollectionTestDatabase extends PDO
{
    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        if (str_ends_with($query, ' FOR UPDATE')) {
            collectionExpect($this->inTransaction(), 'Optimistic writes must also lock within the transaction.');
            $query = substr($query, 0, -strlen(' FOR UPDATE'));
        }
        $query = str_replace(
            'IF(updated_at >= CURRENT_TIMESTAMP, DATE_ADD(updated_at, INTERVAL 1 SECOND), CURRENT_TIMESTAMP)',
            "MAX(datetime(updated_at, '+1 second'), CURRENT_TIMESTAMP)",
            $query
        );
        return parent::prepare($query, $options);
    }
}

$source = file_get_contents(dirname(__DIR__) . '/api/games.php');
$constantsStart = strpos($source, 'const COLLECTION_FIELDS');
$constantsEnd = strpos($source, 'function respond(');
$functionsStart = strpos($source, 'function publicCoverUrl(');
$functionsEnd = strpos($source, 'function coverBackupStore(');
eval(substr($source, $constantsStart, $constantsEnd - $constantsStart)
    . substr($source, $functionsStart, $functionsEnd - $functionsStart));

$db = new CollectionTestDatabase('sqlite::memory:', options: [PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
$db->exec("CREATE TABLE games (id TEXT PRIMARY KEY COLLATE NOCASE, title TEXT, platform TEXT,
    edition TEXT, cover_url TEXT, status TEXT, created_at INTEGER,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");
$baseGame = [
    'id' => 'fixture-game', 'title' => 'Początek', 'platform' => 'PC', 'edition' => 'Fizyczne',
    'coverUrl' => '', 'status' => 'Do ogrania', 'createdAt' => 1600000000000,
];
$created = saveCollectionGame($db, ['mode' => 'create', 'game' => $baseGame]);
collectionExpect(validCollectionRevision($created['revision']) && $created['title'] === 'Początek', 'Creates must return the current row and revision.');
collectionExpect(saveCollectionGame($db, ['game' => $baseGame]) === $created, 'Legacy clients may replay an exact create.');
$modified = array_replace($baseGame, ['title' => 'Edited', 'createdAt' => 2000]);
$updated = saveCollectionGame($db, ['mode' => 'edit', 'game' => $modified, 'revision' => $created['revision']]);
collectionExpect($updated['revision'] !== $created['revision'] && $updated['createdAt'] === $created['createdAt'], 'Edits must change the revision and preserve original creation time.');
collectionExpect(saveCollectionGame($db, ['mode' => 'edit', 'game' => $modified, 'revision' => $created['revision']]) === $updated, 'An identical edit retry must acknowledge existing data.');
collectionThrows(fn() => saveCollectionGame($db, ['mode' => 'edit', 'game' => $baseGame, 'revision' => $created['revision']]), CollectionConflict::class, 'collection_conflict');
collectionThrows(fn() => saveCollectionGame($db, ['game' => $baseGame]), CollectionConflict::class, 'collection_conflict');
collectionThrows(fn() => deleteCollectionGame($db, $baseGame['id'], null), CollectionConflict::class, 'collection_conflict');
collectionThrows(fn() => deleteCollectionGame($db, $baseGame['id'], $created['revision']), CollectionConflict::class, 'collection_conflict');
$reverted = saveCollectionGame($db, ['mode' => 'edit', 'game' => $baseGame, 'revision' => $updated['revision']]);
collectionExpect($reverted['revision'] !== $created['revision'], 'Returning to identical values must still create a new revision.');
collectionExpect(deleteCollectionGame($db, $baseGame['id'], $reverted['revision']) === $baseGame['id'], 'The current revision must delete the row.');
collectionExpect(deleteCollectionGame($db, $baseGame['id'], $reverted['revision']) === $baseGame['id'], 'Repeating a completed deletion must remain safe.');
collectionThrows(fn() => saveCollectionGame($db, ['mode' => 'edit', 'game' => $baseGame, 'revision' => $reverted['revision']]), CollectionConflict::class, 'collection_conflict');
collectionExpect(listGames($db) === [], 'An edit based on a deleted record must never resurrect it.');
saveCollectionGame($db, ['mode' => 'create', 'game' => $baseGame]);
echo "PASS: server-generated revisions, idempotent retries, legacy guards, stale edits/deletes and no edit resurrection\n";

$html = file_get_contents(dirname(__DIR__) . '/index.html');
preg_match_all('/name="platform" value="([^"]+)"/', $html, $platformMatches);
$platforms = $platformMatches[1];
collectionExpect(count($platforms) === 35, 'Load the standard platform fixture using the actual form.');
$allPlatforms = normalizedGame(array_replace($baseGame, ['platform' => implode(', ', $platforms)]));
collectionExpect(array_map('trim', explode(',', $allPlatforms['platform'])) === $platforms, 'All standard choices must fit without losing a platform.');
$legacy = array_replace($baseGame, [
    'id' => 'legacy-multi', 'title' => str_repeat('é', 255), 'platform' => 'Evercade, Archiwum, Ładne',
    'edition' => str_repeat('ą', 50), 'status' => str_repeat('Ż', 50),
]);
collectionExpect(normalizedGame($legacy)['status'] === $legacy['status'], 'Legacy custom platforms, editions, statuses and Unicode values within SQL widths must remain intact.');
collectionThrows(fn() => normalizedGame(array_replace($legacy, ['title' => str_repeat('é', 256)])), InvalidArgumentException::class, 'game_title_and_platform_required');
collectionThrows(fn() => normalizedGame(array_replace($legacy, ['coverUrl' => 'https://user:pass@static.example.test/cover.png'])), InvalidArgumentException::class, 'invalid_game_data');
collectionThrows(fn() => normalizedGame(array_replace($legacy, ['createdAt' => 9007199254740992])), InvalidArgumentException::class, 'invalid_game_data');
$before = listGames($db);
collectionThrows(fn() => importCollectionGames($db, 'replace', [$legacy, ['title' => 'Incomplete fixture']]), InvalidArgumentException::class, 'game_title_and_platform_required');
collectionExpect(listGames($db) === $before, 'An invalid row must roll back the entire replacement.');
collectionThrows(fn() => importCollectionGames($db, 'migrate', [$legacy, $modified]), CollectionConflict::class, 'collection_import_conflict');
collectionExpect(listGames($db) === $before, 'A legacy ID conflict must not silently drop a record or commit incomplete work.');
$missingId = $legacy;
unset($missingId['id']);
collectionExpect(importCollectionGames($db, 'migrate', [$missingId]) === 1
    && importCollectionGames($db, 'migrate', [$missingId]) === 0, 'Legacy imports without IDs must have stable identifiers across retries.');
echo "PASS: full platform sets, Unicode limits, legacy data, safe URLs and atomic import rollback\n";

$directory = sys_get_temp_dir() . '/savepoint-collection-' . bin2hex(random_bytes(8));
$store = new TransferStore($directory);
try {
    $fixtures = [];
    for ($i = 0; $i < 300; $i++) {
        $fixtures[] = array_replace($legacy, ['id' => 'fixture-' . $i, 'coverUrl' => 'https://static.example.test/cover/' . $i]);
    }
    $json = json_encode($fixtures, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    collectionExpect(strlen($json) > 65536, 'The fixture must exceed the ordinary API request cap.');
    ['uploadId' => $uploadId, 'offset' => $offset, 'chunkBytes' => $chunkBytes] = $store->start('fixture-session', 'replace', strlen($json));
    $first = base64_encode(substr($json, 0, $chunkBytes));
    collectionThrows(fn() => $store->append('another-session', $uploadId, 0, $first), TransferError::class, 'collection_upload_missing');
    collectionThrows(fn() => $store->append('fixture-session', $uploadId, 1, $first), TransferError::class, 'collection_upload_offset');
    collectionThrows(fn() => $store->finish('fixture-session', $uploadId, fn() => throw new RuntimeException('Incomplete upload reached apply.')), TransferError::class, 'collection_upload_offset');
    foreach (str_split($json, $chunkBytes) as $chunk) {
        $data = base64_encode($chunk);
        $next = $store->append('fixture-session', $uploadId, $offset, $data);
        collectionExpect($store->append('fixture-session', $uploadId, $offset, $data) === $next, 'A lost chunk response must allow an identical retry.');
        $offset = $next;
    }
    $applyCalls = 0;
    $apply = static function (string $mode, array $games) use ($db, &$applyCalls): int {
        $applyCalls++;
        return importCollectionGames($db, $mode, $games);
    };
    collectionExpect($store->finish('fixture-session', $uploadId, $apply) === count($fixtures) && count(listGames($db)) === count($fixtures), 'Large staged restore must save every row.');
    collectionExpect($store->finish('fixture-session', $uploadId, $apply) === count($fixtures) && $applyCalls === 1, 'A lost finish response must never apply replacement twice.');
    $failed = $store->start('fixture-session', 'replace', 2)['uploadId'];
    $store->append('fixture-session', $failed, 0, base64_encode('[]'));
    collectionThrows(fn() => $store->finish('fixture-session', $failed, fn() => throw new RuntimeException('simulated commit interruption')), RuntimeException::class, 'simulated commit interruption');
    collectionThrows(fn() => $store->finish('fixture-session', $failed, $apply), TransferError::class, 'collection_upload_uncertain');
    $canceled = $store->start('fixture-session', 'migrate', 2)['uploadId'];
    $store->cancel('fixture-session', $canceled);
    collectionThrows(fn() => $store->append('fixture-session', $canceled, 0, base64_encode('[]')), TransferError::class, 'collection_upload_missing');
    echo "PASS: over-64-KiB restore, ownership isolation, chunk/finish retries, ambiguous commit protection and cancellation\n";
} finally {
    foreach (glob($directory . '/*') ?: [] as $file) unlink($file);
    rmdir($directory);
}
