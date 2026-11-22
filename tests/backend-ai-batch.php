<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

use Savepoint\AI\BatchException;
use Savepoint\AI\ConfirmedGames;

require dirname(__DIR__) . '/server/ai/ConfirmedGames.php';

// Execute the real normalizer in isolation. Loading the endpoint or a private
// configuration would make these tests depend on production services.
$source = file_get_contents(dirname(__DIR__) . '/api/games.php');
$start = strpos($source, 'function validCollectionText(');
$end = strpos($source, 'function findCollectionRow(', $start);
if ($start === false || $end === false) throw new RuntimeException('Normalizer boundaries unavailable.');
eval(substr($source, $start, $end - $start));

function expectBatch(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

/** A transaction model with no constructor connection or real SQL transport. */
final class BatchMemoryDatabase extends PDO
{
    public array $queries = [];
    public array $parameters = [];
    public int $begins = 0;
    public int $commits = 0;
    public int $rollbacks = 0;
    public int $insertAttempts = 0;
    public ?int $failInsertAt = null;
    public bool $failCommit = false;
    public bool $duplicateDuringInsert = false;
    private bool $transaction = false;
    private array $pending = [];

    public function __construct(public array $rows = []) {}
    public function inTransaction(): bool { return $this->transaction; }
    public function beginTransaction(): bool
    {
        expectBatch(!$this->transaction, 'Nested transactions are forbidden.');
        $this->transaction = true;
        $this->pending = $this->rows;
        $this->begins++;
        return true;
    }
    public function commit(): bool
    {
        if ($this->failCommit) throw new RuntimeException('Synthetic commit failure.');
        $this->rows = $this->pending;
        $this->pending = [];
        $this->transaction = false;
        $this->commits++;
        return true;
    }
    public function rollBack(): bool
    {
        $this->pending = [];
        $this->transaction = false;
        $this->rollbacks++;
        return true;
    }
    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        $this->queries[] = $query;
        expectBatch(!preg_match('/\b(?:UPDATE games|DELETE FROM games|INSERT IGNORE|ON DUPLICATE)\b/i', $query), 'Appending must never overwrite, delete or silently skip rows.');
        return new BatchMemoryStatement($this, $query);
    }
    public function selectRows(array $ids): array
    {
        expectBatch($this->transaction, 'The lookup must hold transaction locks.');
        return array_values(array_filter($this->pending, static fn(array $row): bool => in_array(strtolower($row['id']), $ids, true)));
    }
    public function insertRow(array $params): void
    {
        expectBatch($this->transaction, 'The insert must belong to the transaction.');
        $this->insertAttempts++;
        if ($this->failInsertAt === $this->insertAttempts) throw new RuntimeException('Synthetic insert failure.');
        $id = $params[':id'];
        if (isset($this->pending[$id]) || $this->duplicateDuringInsert) {
            $error = new PDOException('Synthetic duplicate-key failure.');
            $error->errorInfo = ['23000', 1062, 'Synthetic duplicate-key failure.'];
            throw $error;
        }
        $row = [];
        foreach (['id', 'title', 'platform', 'edition', 'cover_url', 'status', 'created_at'] as $field) {
            expectBatch(array_key_exists(':' . $field, $params), 'Every value must use a bound parameter.');
            $row[$field] = $params[':' . $field];
        }
        $this->pending[$id] = $row;
    }
}

final class BatchMemoryStatement extends PDOStatement
{
    private array $result = [];
    public function __construct(private BatchMemoryDatabase $db, private string $query) {}
    public function execute(?array $params = null): bool
    {
        $params ??= [];
        $this->db->parameters[] = $params;
        if (str_starts_with($this->query, 'SELECT ')) {
            expectBatch(str_contains($this->query, 'ORDER BY id FOR UPDATE'), 'The read must lock IDs in one deterministic order.');
            $this->result = $this->db->selectRows($params);
        } else {
            expectBatch(str_starts_with($this->query, 'INSERT INTO games '), 'Only a plain insert may follow the lookup.');
            $this->db->insertRow($params);
        }
        return true;
    }
    public function fetchAll(int $mode = PDO::FETCH_DEFAULT, mixed ...$args): array { return $this->result; }
}

function batchGame(int $number = 1): array
{
    return [
        'id' => sprintf('%08x-1234-4123-8123-%012x', $number, $number),
        'title' => 'Synthetic game ' . $number,
        'platform' => 'PC',
        'edition' => 'Fizyczne',
        'coverUrl' => '',
        'status' => 'Do ogrania',
        'createdAt' => 1700000000000 + $number,
    ];
}

function addBatch(BatchMemoryDatabase $db, array $items, bool $confirmed = true): array
{
    return ConfirmedGames::add($db, $items, $confirmed, 'normalizedGame');
}

function expectBatchError(callable $action, string $id, int $status): void
{
    try { $action(); } catch (BatchException $error) {
        expectBatch($error->errorId === $id && $error->httpStatus === $status && $error->getMessage() === $id, 'The API must receive only the expected safe error identifier.');
        return;
    }
    throw new RuntimeException('Expected a safe batch error: ' . $id);
}

{
    $unrelated = normalizedGame(batchGame(99));
    $db = new BatchMemoryDatabase([$unrelated['id'] => $unrelated]);
    $one = batchGame(1);
    $two = batchGame(2);
    $two['title'] = 'Synthetic édition 日本語';
    $two['platform'] = 'PC, PC, PlayStation 2';
    expectBatch(addBatch($db, [$two, $one]) === ['inserted' => 2], 'Both reviewed games must be appended.');
    expectBatch(count($db->rows) === 3 && $db->rows[$unrelated['id']] === $unrelated, 'The existing collection must remain intact.');
    expectBatch($db->rows[$two['id']]['platform'] === 'PC, PlayStation 2', 'Batch normalization must match ordinary saves.');
    expectBatch($db->begins === 1 && $db->commits === 1 && $db->rollbacks === 0, 'The entire append must commit once.');
    expectBatch($db->parameters[0] === [$one['id'], $two['id']], 'Lock ordering must not depend on user row order.');
    echo "PASS: confirmed multi-game append uses real normalization, bound inserts and one transaction while preserving existing rows.\n";
}

{
    $db = new BatchMemoryDatabase();
    expectBatchError(fn() => addBatch($db, [batchGame()], false), 'ai_confirmation_required', 400);
    expectBatch($db->begins === 0 && $db->queries === [], 'Unconfirmed input must never reach the database.');
    echo "PASS: explicit confirmation is required before any database work.\n";
}

{
    $invalid = [[], array_fill(0, 33, batchGame()), ['unexpected' => batchGame()], [null], [['title' => 'Incomplete']]];
    foreach ([
        ['id', 'not-a-uuid'], ['id', '00000001-1234-1123-8123-000000000001'],
        ['title', []], ['title', ''], ['title', str_repeat('x', 256)], ['title', str_repeat('é', 256)],
        ['title', "broken\xc3\x28"], ['title', "control\nvalue"], ['platform', true],
        ['platform', ''], ['platform', ', ,'], ['platform', str_repeat('x', 401)],
        ['edition', 'Physical'], ['status', 'Done'], ['coverUrl', false],
        ['coverUrl', 'https://user:password@covers.example/image.jpg'], ['coverUrl', 'javascript:alert(1)'],
        ['coverUrl', "https://covers.example/image\r\n"], ['coverUrl', 'https://covers.example/' . str_repeat('x', 2048)],
        ['createdAt', '1700000000001'], ['createdAt', 0], ['createdAt', -1], ['createdAt', 1.5],
        ['createdAt', true], ['createdAt', 9007199254740992],
    ] as [$field, $value]) {
        $item = batchGame();
        $item[$field] = $value;
        $invalid[] = [$item];
    }
    $extra = batchGame();
    $extra['unexpected'] = 'value';
    $invalid[] = [$extra];
    $same = batchGame();
    $same['id'] = strtoupper($same['id']);
    $invalid[] = [batchGame(), $same];
    foreach ($invalid as $items) {
        $db = new BatchMemoryDatabase();
        expectBatchError(fn() => addBatch($db, $items), 'ai_invalid_batch', 422);
        expectBatch($db->begins === 0 && $db->rows === [], 'Every invalid batch must fail before the transaction.');
    }
    $lastInvalid = batchGame(2);
    $lastInvalid['title'] = '';
    $db = new BatchMemoryDatabase();
    expectBatchError(fn() => addBatch($db, [batchGame(1), $lastInvalid]), 'ai_invalid_batch', 422);
    expectBatch($db->begins === 0, 'A valid first row must not cause partial database work.');
    echo "PASS: malformed lists, duplicate IDs, scalar types, UTF-8, byte/character limits, URLs and canonical enums fail before opening a transaction.\n";
}

{
    $items = array_map('batchGame', range(1, 32));
    $items[0]['title'] = str_repeat('é', 255);
    $db = new BatchMemoryDatabase();
    expectBatch(addBatch($db, $items) === ['inserted' => 32] && count($db->rows) === 32, 'Exactly 32 reviewed games and a valid 255-character Unicode title must be accepted.');
    echo "PASS: the exact batch and UTF-8 boundary remain usable.\n";
}

{
    $item = batchGame();
    $stored = normalizedGame($item);
    $stored['created_at'] = (string)$stored['created_at'];
    $stored['cover_url'] = null;
    $db = new BatchMemoryDatabase([$stored['id'] => $stored]);
    $item['id'] = strtoupper($item['id']);
    expectBatch(addBatch($db, [$item]) === ['inserted' => 0], 'A retry with the exact same normalized data must succeed without duplication.');
    expectBatch($db->insertAttempts === 0 && $db->rows[$stored['id']] === $stored, 'A replay must not rewrite even an equivalent existing row.');
    $new = batchGame(2);
    expectBatch(addBatch($db, [$new, $item]) === ['inserted' => 1] && count($db->rows) === 2, 'A mixed batch may add only its missing row.');
    echo "PASS: stable-ID retries are idempotent with native PDO strings, nullable covers and matching existing rows.\n";
}

{
    $item = batchGame();
    $stored = normalizedGame($item);
    $db = new BatchMemoryDatabase([$stored['id'] => $stored]);
    $item['title'] = 'Different reviewed title';
    expectBatchError(fn() => addBatch($db, [batchGame(2), $item]), 'ai_batch_conflict', 409);
    expectBatch($db->rows === [$stored['id'] => $stored] && $db->insertAttempts === 0 && $db->rollbacks === 1, 'Every overlap must be checked before any insertion or overwrite.');
    echo "PASS: conflicting existing IDs roll back and cannot overwrite collection records.\n";
}

{
    foreach (['insert', 'commit'] as $failure) {
        $stored = normalizedGame(batchGame(99));
        $db = new BatchMemoryDatabase([$stored['id'] => $stored]);
        if ($failure === 'insert') $db->failInsertAt = 2;
        else $db->failCommit = true;
        try { addBatch($db, [batchGame(1), batchGame(2)]); throw new LogicException('A synthetic failure was not raised.'); }
        catch (RuntimeException $error) {
            expectBatch(str_starts_with($error->getMessage(), 'Synthetic '), 'The expected injected failure must propagate.');
        }
        expectBatch($db->rows === [$stored['id'] => $stored] && $db->rollbacks === 1 && !$db->inTransaction(), 'Database failures must roll back every new row and preserve all existing rows.');
    }
    $db = new BatchMemoryDatabase();
    $db->duplicateDuringInsert = true;
    expectBatchError(fn() => addBatch($db, [batchGame()]), 'ai_batch_conflict', 409);
    expectBatch($db->rows === [] && $db->rollbacks === 1, 'A concurrent duplicate must remain an append-only conflict.');
    echo "PASS: later-insert, commit and concurrent-duplicate failures roll back the complete batch.\n";
}

{
    $db = new BatchMemoryDatabase();
    $db->beginTransaction();
    try { addBatch($db, [batchGame()]); throw new LogicException('A nested operation was accepted.'); }
    catch (RuntimeException $error) {
        expectBatch($error->getMessage() === 'AI batch requires a dedicated transaction.', 'The batch must reject an unrelated active transaction.');
    }
    expectBatch($db->inTransaction() && $db->rollbacks === 0, 'Rejecting nested work must not roll back the caller transaction.');
    $db->rollBack();
    $db = new BatchMemoryDatabase();
    expectBatchError(fn() => ConfirmedGames::add($db, [batchGame()], true, static function (array $item): array {
        $row = normalizedGame($item);
        $row['id'] = batchGame(2)['id'];
        return $row;
    }), 'ai_invalid_batch', 422);
    expectBatch($db->begins === 0, 'Normalization may not change the stable reviewed identifier.');
    echo "PASS: transaction ownership and stable normalized identifiers are enforced.\n";
}

echo "All 8 isolated AI batch groups passed without a database, network or private configuration.\n";
