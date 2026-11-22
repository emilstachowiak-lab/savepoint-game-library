<?php
declare(strict_types=1);

namespace Savepoint\AI;

use InvalidArgumentException;
use PDO;
use PDOException;
use RuntimeException;
use Throwable;

/** Safe error identifiers let the API translate failures without exposing SQL. */
final class BatchException extends RuntimeException
{
    public function __construct(public readonly string $errorId, public readonly int $httpStatus)
    {
        parent::__construct($errorId);
    }
}

/** Append reviewed games atomically, without changing any existing record. */
final class ConfirmedGames
{
    public const MAX_GAMES = 32;
    private const FIELDS = ['id', 'title', 'platform', 'edition', 'coverUrl', 'status', 'createdAt'];
    private const ROW_FIELDS = ['id', 'title', 'platform', 'edition', 'cover_url', 'status', 'created_at'];
    private const EDITIONS = ['Fizyczne', 'Cyfrowe', 'Fizyczne i cyfrowe'];
    private const STATUSES = ['Do ogrania', 'W trakcie', 'Ograna'];

    /** @return array{inserted: int} */
    public static function add(PDO $db, array $items, bool $confirmed, callable $normalize): array
    {
        if (!$confirmed) {
            throw new BatchException('ai_confirmation_required', 400);
        }
        if (!array_is_list($items) || $items === [] || count($items) > self::MAX_GAMES) {
            self::invalid();
        }

        // Validate the complete request before opening a transaction. The caller
        // supplies the same normalizer used by ordinary collection operations.
        $rows = [];
        foreach ($items as $item) {
            if (!is_array($item)) self::invalid();
            $item = self::validatedItem($item);
            if (isset($rows[$item['id']])) self::invalid();
            try {
                $row = $normalize($item);
            } catch (InvalidArgumentException) {
                self::invalid();
            }
            if (!is_array($row) || !self::validNormalizedRow($row, $item)) self::invalid();
            $rows[$item['id']] = $row;
        }
        ksort($rows, SORT_STRING);

        // This operation must own its transaction; never roll back work started
        // by an unrelated caller. Sorting IDs gives overlapping batches one order.
        if ($db->inTransaction()) {
            throw new RuntimeException('AI batch requires a dedicated transaction.');
        }
        if (!$db->beginTransaction()) {
            throw new RuntimeException('Could not begin AI batch transaction.');
        }
        try {
            $placeholders = implode(',', array_fill(0, count($rows), '?'));
            $lookup = $db->prepare(
                'SELECT id, title, platform, edition, cover_url, status, created_at
                 FROM games WHERE id IN (' . $placeholders . ') ORDER BY id FOR UPDATE'
            );
            if ($lookup === false || !$lookup->execute(array_keys($rows))) {
                throw new RuntimeException('Could not inspect AI batch identifiers.');
            }
            $existing = [];
            foreach ($lookup->fetchAll(PDO::FETCH_ASSOC) as $stored) {
                $id = strtolower((string)($stored['id'] ?? ''));
                if (!isset($rows[$id]) || !self::sameRow($stored, $rows[$id])) {
                    throw new BatchException('ai_batch_conflict', 409);
                }
                $existing[$id] = true;
            }

            $inserted = 0;
            $insert = null;
            foreach ($rows as $id => $row) {
                // Replaying the exact IDs and normalized values after a lost
                // response succeeds without inserting duplicate games.
                if (isset($existing[$id])) continue;
                $insert ??= $db->prepare(
                    'INSERT INTO games (id, title, platform, edition, cover_url, status, created_at)
                     VALUES (:id, :title, :platform, :edition, :cover_url, :status, :created_at)'
                );
                if ($insert === false || !$insert->execute([
                    ':id' => $row['id'],
                    ':title' => $row['title'],
                    ':platform' => $row['platform'],
                    ':edition' => $row['edition'],
                    ':cover_url' => $row['cover_url'],
                    ':status' => $row['status'],
                    ':created_at' => $row['created_at'],
                ])) {
                    throw new RuntimeException('Could not insert reviewed AI game.');
                }
                $inserted++;
            }
            if (!$db->commit()) throw new RuntimeException('Could not commit AI batch.');
            return ['inserted' => $inserted];
        } catch (Throwable $error) {
            if ($db->inTransaction()) $db->rollBack();
            // A concurrent insert may win after the lookup. It must never turn
            // an append into an overwrite or expose a database error message.
            if ($error instanceof PDOException && (int)($error->errorInfo[1] ?? 0) === 1062) {
                throw new BatchException('ai_batch_conflict', 409);
            }
            throw $error;
        }
    }

    private static function validatedItem(array $item): array
    {
        if (array_diff(array_keys($item), self::FIELDS) !== []
            || array_diff(self::FIELDS, array_keys($item)) !== []) self::invalid();
        foreach (['id', 'title', 'platform', 'edition', 'coverUrl', 'status'] as $field) {
            if (!is_string($item[$field]) || !self::validText($item[$field])) self::invalid();
        }
        if (!preg_match('/\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/iD', $item['id'])
            || !is_int($item['createdAt']) || $item['createdAt'] <= 0 || $item['createdAt'] > 9007199254740991) {
            self::invalid();
        }
        $item['id'] = strtolower($item['id']);
        foreach (['title', 'platform', 'edition', 'coverUrl', 'status'] as $field) {
            $item[$field] = trim($item[$field]);
        }
        if (!self::validTitle($item['title']) || $item['platform'] === '' || strlen($item['platform']) > 1649
            || !in_array($item['edition'], self::EDITIONS, true) || !in_array($item['status'], self::STATUSES, true)
            || !self::validCover($item['coverUrl'])) self::invalid();
        return $item;
    }

    private static function validNormalizedRow(array $row, array $item): bool
    {
        if (array_diff(array_keys($row), self::ROW_FIELDS) !== []
            || array_diff(self::ROW_FIELDS, array_keys($row)) !== []) return false;
        foreach (['id', 'title', 'platform', 'edition', 'cover_url', 'status'] as $field) {
            if (!is_string($row[$field]) || !self::validText($row[$field])) return false;
        }
        return $row['id'] === $item['id'] && $row['created_at'] === $item['createdAt']
            && self::validTitle($row['title']) && $row['platform'] !== '' && preg_match_all('/./us', $row['platform']) <= 400
            && in_array($row['edition'], self::EDITIONS, true) && in_array($row['status'], self::STATUSES, true)
            && self::validCover($row['cover_url']);
    }

    private static function validText(string $value): bool
    {
        return preg_match('//u', $value) === 1 && preg_match('/[\x00-\x1f\x7f]/', $value) === 0;
    }

    private static function validTitle(string $value): bool
    {
        return $value !== '' && strlen($value) <= 1020 && preg_match_all('/./us', $value) <= 255;
    }

    private static function validCover(string $value): bool
    {
        if ($value === '') return true;
        if (strlen($value) > 2048 || filter_var($value, FILTER_VALIDATE_URL) === false) return false;
        $parts = parse_url($value);
        return is_array($parts) && strtolower((string)($parts['scheme'] ?? '')) === 'https'
            && !isset($parts['user']) && !isset($parts['pass']);
    }

    private static function sameRow(array $stored, array $expected): bool
    {
        foreach (['title', 'platform', 'edition', 'status'] as $field) {
            if (!is_string($stored[$field] ?? null) || $stored[$field] !== $expected[$field]) return false;
        }
        return (string)($stored['cover_url'] ?? '') === $expected['cover_url']
            && (string)($stored['created_at'] ?? '') === (string)$expected['created_at'];
    }

    private static function invalid(): never
    {
        throw new BatchException('ai_invalid_batch', 422);
    }
}
