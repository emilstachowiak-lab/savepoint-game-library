<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

use Savepoint\AI\DuplicateGames;
use Savepoint\AI\ImportException;
use Savepoint\AI\Routes;

require dirname(__DIR__) . '/server/ai/Routes.php';
require dirname(__DIR__) . '/server/ai/DuplicateGames.php';

// Use the actual SQL and rollback behavior in memory. SQLite has no FOR UPDATE
// syntax, so check the MySQL clause before removing it for this test only.
final class DuplicateTestDatabase extends PDO
{
    public bool $lockedLookup = false;

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        if (str_starts_with($query, 'SELECT ')) {
            expectDuplicates($this->inTransaction() && str_ends_with($query, 'ORDER BY id FOR UPDATE'),
                'The reviewed rows must be locked in ID order inside the transaction.');
            $this->lockedLookup = true;
            $query = substr($query, 0, -strlen(' FOR UPDATE'));
        }
        return parent::prepare($query, $options);
    }
}

function expectDuplicates(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

function expectDuplicateError(callable $action, string $id, int $status): void
{
    try {
        $action();
    } catch (ImportException $error) {
        expectDuplicates($error->errorId === $id && $error->status === $status, 'Unexpected resolution error.');
        return;
    }
    throw new RuntimeException('The invalid duplicate operation was accepted.');
}

function duplicateFixture(): DuplicateTestDatabase
{
    $db = new DuplicateTestDatabase('sqlite::memory:');
    $db->exec('CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT, platform TEXT, edition TEXT,
        cover_url TEXT, status TEXT, created_at INTEGER, updated_at TEXT)');
    $insert = $db->prepare('INSERT INTO games VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    $insert->execute(['fixture-a', 'Fixture Game', 'PC, Xbox', 'Cyfrowe', null,
        'Do ogrania', 1700000000000, '2026-01-01 00:00:00']);
    $insert->execute(['fixture-b', 'Fixture Game!', 'Xbox, PlayStation 4', 'Fizyczne', 'https://images.example.test/game.jpg',
        'W trakcie', 1700000000001, '2026-01-02 00:00:00']);
    return $db;
}

function duplicateRequest(PDO $db, string $mode = 'merge'): array
{
    [$left, $right] = DuplicateGames::snapshot($db);
    return [
        'ticket' => DuplicateGames::issue($right, $left, 'fixture session signing material'),
        'keepId' => $right['id'], 'mode' => $mode, 'confirmed' => true,
    ];
}

function resolveDuplicate(PDO $db, array $request): void
{
    DuplicateGames::apply($db, $request, 'fixture session signing material');
}

$cursorDb = duplicateFixture();
$snapshot = DuplicateGames::snapshotFingerprint(DuplicateGames::snapshot($cursorDb));
$secret = 'synthetic scan cursor signing material';
$cursor = DuplicateGames::issueCursor([1, 0, 12], $snapshot, $secret);
expectDuplicates(DuplicateGames::scanPosition($cursor, $snapshot, $secret) === [1, 0, 12],
    'A valid continuation resumes at the original snapshot position.');
expectDuplicateError(fn() => DuplicateGames::scanPosition($cursor, $snapshot, 'other synthetic session'),
    'ai_duplicates_scan_changed', 409);
$cursorDb->exec("UPDATE games SET title = 'Edited fixture' WHERE id = 'fixture-b'");
$newSnapshot = DuplicateGames::snapshotFingerprint(DuplicateGames::snapshot($cursorDb));
expectDuplicateError(fn() => DuplicateGames::scanPosition($cursor, $newSnapshot, $secret),
    'ai_duplicates_scan_changed', 409);

// Load the production sanitizer without dispatching the API entry point.
$apiSource = file_get_contents(dirname(__DIR__) . '/api/games.php');
$sanitizerStart = strpos($apiSource, 'function publicCoverUrl(');
expectDuplicates($sanitizerStart !== false, 'The cover URL sanitizer must remain available.');
$sanitizerEnd = strpos($apiSource, 'function gameFromDatabaseRow(', $sanitizerStart);
expectDuplicates($sanitizerEnd > $sanitizerStart, 'The cover URL sanitizer must be independently testable.');
eval(substr($apiSource, $sanitizerStart, $sanitizerEnd - $sanitizerStart));

$reviewDb = duplicateFixture();
$legacyCover = 'https://test-user:test-password@images.example.test/legacy.jpg';
$setCover = $reviewDb->prepare("UPDATE games SET cover_url = ? WHERE id = 'fixture-a'");
$setCover->execute([$legacyCover]);
[$left, $right] = DuplicateGames::snapshot($reviewDb);
$formatPair = new ReflectionMethod(Routes::class, 'duplicateReviewPair');
$review = $formatPair->invoke(null, ['left' => $left, 'right' => $right, 'recommendation' => 'delete'], $secret);
$reversed = $formatPair->invoke(null, ['left' => $right, 'right' => $left, 'recommendation' => 'delete'], $secret);
expectDuplicates($review['left']['coverUrl'] === '' && $review['right']['coverUrl'] === $right['coverUrl']
    && $reversed['right']['coverUrl'] === '' && $reversed['left']['coverUrl'] === $right['coverUrl'],
    'Either side of the browser review must redact legacy URL credentials and preserve ordinary covers.');
expectDuplicates(!array_key_exists('updatedAt', $review['left']) && !array_key_exists('updatedAt', $review['right']),
    'The review must remove both internal timestamps.');
$reviewRequest = ['ticket' => $review['ticket'], 'keepId' => $left['id'], 'mode' => 'delete', 'confirmed' => true];
$setCover->execute(['https://test-user:changed-password@images.example.test/legacy.jpg']);
expectDuplicateError(fn() => DuplicateGames::apply($reviewDb, $reviewRequest, $secret), 'ai_duplicates_stale', 409);
$setCover->execute([$legacyCover]);
expectDuplicates(DuplicateGames::apply($reviewDb, $reviewRequest, $secret) === [$left['id'], $right['id']],
    'A sanitized review must still produce a usable ticket for the original stored values.');
expectDuplicates(DuplicateGames::snapshot($reviewDb)[0]['coverUrl'] === $legacyCover,
    'Sanitizing the browser review must not rewrite the cover of the retained game.');
echo "PASS: duplicate reviews redact legacy cover credentials and issue tickets for unmodified stored records.\n";

$db = duplicateFixture();
$original = DuplicateGames::snapshot($db);
$request = duplicateRequest($db);
expectDuplicateError(fn() => resolveDuplicate($db, array_replace($request, ['confirmed' => 1])), 'ai_duplicates_invalid', 422);
expectDuplicateError(fn() => resolveDuplicate($db, array_replace($request, ['keepId' => 'unrelated'])), 'ai_duplicates_invalid', 422);
expectDuplicateError(fn() => DuplicateGames::apply($db, $request, 'a different session'), 'ai_duplicates_invalid', 422);
expectDuplicates(!$db->lockedLookup && DuplicateGames::snapshot($db) === $original, 'Invalid approvals must never lock or modify records.');
resolveDuplicate($db, $request);
$expected = array_replace($original[1], ['platform' => 'Xbox, PlayStation 4, PC', 'edition' => 'Fizyczne i cyfrowe']);
expectDuplicates($db->lockedLookup && DuplicateGames::snapshot($db) === [$expected],
    'Merge must combine platforms and canonical media while retaining other selected fields.');
expectDuplicateError(fn() => resolveDuplicate($db, $request), 'ai_duplicates_stale', 409);
expectDuplicates(DuplicateGames::snapshot($db) === [$expected], 'Retrying a committed merge must preserve the remaining record.');

$db = duplicateFixture();
$request = duplicateRequest($db, 'delete');
resolveDuplicate($db, $request);
expectDuplicates(DuplicateGames::snapshot($db) === [$original[1]], 'Deletion must not edit the retained record.');

$db = duplicateFixture();
$request = duplicateRequest($db);
$db->exec("UPDATE games SET updated_at = '2026-01-03 00:00:00' WHERE id = 'fixture-a'");
$modified = DuplicateGames::snapshot($db);
expectDuplicateError(fn() => resolveDuplicate($db, $request), 'ai_duplicates_stale', 409);
expectDuplicates(DuplicateGames::snapshot($db) === $modified && !$db->inTransaction(), 'A newer record revision must prevent deletion.');

$db = duplicateFixture();
$request = duplicateRequest($db);
$db->exec("CREATE TRIGGER fail_delete BEFORE DELETE ON games BEGIN SELECT RAISE(ABORT, 'Synthetic delete failure'); END");
try {
    resolveDuplicate($db, $request);
    throw new RuntimeException('A failed delete unexpectedly committed.');
} catch (PDOException) {
    expectDuplicates(DuplicateGames::snapshot($db) === $original && !$db->inTransaction(), 'A failed delete must roll back the merged fields.');
}

$db = duplicateFixture();
$platform = $db->prepare("UPDATE games SET platform = ? WHERE id = 'fixture-a'");
$platform->execute([str_repeat('x', 400)]);
$request = duplicateRequest($db);
$oversized = DuplicateGames::snapshot($db);
expectDuplicateError(fn() => resolveDuplicate($db, $request), 'ai_duplicates_merge_too_large', 422);
expectDuplicates(DuplicateGames::snapshot($db) === $oversized, 'A large platform union must never truncate records or delete a game.');

echo "PASS: duplicate actions require a current reviewed ticket, merge or delete atomically, and roll back unsafe changes.\n";
