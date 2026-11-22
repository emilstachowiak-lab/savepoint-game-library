<?php
declare(strict_types=1);

namespace Savepoint\AI;

use PDO;
use RuntimeException;
use Throwable;

final class DuplicateGames
{
    private const TICKET_SECONDS = 900;
    private const CURSOR_SECONDS = 86400;
    private const SELECT_COLUMNS = 'id, title, platform, edition, cover_url, status, created_at, updated_at';
    private const EDITIONS = ['Fizyczne', 'Cyfrowe', 'Fizyczne i cyfrowe'];

    public static function snapshot(PDO $db): array
    {
        $statement = $db->query('SELECT ' . self::SELECT_COLUMNS . ' FROM games ORDER BY id');
        if ($statement === false) throw new RuntimeException('Could not read the duplicate review snapshot.');
        $games = [];
        while ($row = $statement->fetch(PDO::FETCH_ASSOC)) $games[] = self::game($row);
        return $games;
    }

    public static function snapshotFingerprint(array $games): string
    {
        $hash = hash_init('sha256');
        foreach ($games as $game) hash_update($hash, self::fingerprint($game));
        return hash_final($hash);
    }

    /** @param array{int, int, int} $position The phase and two indexes of the next pair. */
    public static function issueCursor(array $position, string $snapshot, string $secret): string
    {
        return self::encode([time() + self::CURSOR_SECONDS, $snapshot, $position], 'scan:' . $secret);
    }

    /** @return array{int, int, int}|null The resume position for the same collection snapshot. */
    public static function scanPosition(mixed $cursor, string $snapshot, string $secret): ?array
    {
        if ($cursor === null) return null;
        try {
            $data = self::decode($cursor, 'scan:' . $secret);
            if (count($data) === 3 && is_int($data[0]) && $data[0] >= time()
                && is_string($data[1]) && hash_equals($snapshot, $data[1])
                && is_array($data[2]) && array_is_list($data[2]) && count($data[2]) === 3
                && count(array_filter($data[2], 'is_int')) === 3 && min($data[2]) >= 0) return $data[2];
        } catch (ImportException) {
            // An expired or invalid cursor has the same restart path.
        }
        throw new ImportException('ai_duplicates_scan_changed', 409);
    }

    public static function issue(array $left, array $right, string $secret): string
    {
        if (!self::validId($left['id'] ?? null) || !self::validId($right['id'] ?? null)
            || strcasecmp($left['id'], $right['id']) === 0) self::invalid();

        // The ticket binds both reviewed records to a session without exposing
        // an API secret or keeping a copy of their details on the server.
        return self::encode([
            time() + self::TICKET_SECONDS,
            [$left['id'], self::fingerprint($left)],
            [$right['id'], self::fingerprint($right)],
        ], $secret);
    }

    /** @return array{string, string} The retained and removed record IDs. */
    public static function apply(PDO $db, array $request, string $secret): array
    {
        $keep = $request['keepId'] ?? null;
        $mode = $request['mode'] ?? null;
        if (($request['confirmed'] ?? null) !== true || !self::validId($keep)
            || !in_array($mode, ['merge', 'delete'], true)) self::invalid();
        $reviewed = self::reviewedGames($request['ticket'] ?? null, $secret);
        $ids = array_column($reviewed, 0);
        if (!in_array($keep, $ids, true)) self::invalid();
        $remove = $ids[0] === $keep ? $ids[1] : $ids[0];
        sort($ids, SORT_STRING);

        if ($db->inTransaction() || !$db->beginTransaction()) {
            throw new RuntimeException('Duplicate resolution requires a dedicated transaction.');
        }
        try {
            // Recheck both records under the same locks used for the writes;
            // a stale suggestion must never change a newer collection entry.
            $lookup = $db->prepare('SELECT ' . self::SELECT_COLUMNS . ' FROM games WHERE id IN (?, ?) ORDER BY id FOR UPDATE');
            if ($lookup === false || !$lookup->execute($ids)) {
                throw new RuntimeException('Could not lock the duplicate records.');
            }
            $games = array_column(array_map(self::game(...), $lookup->fetchAll(PDO::FETCH_ASSOC)), null, 'id');
            foreach ($reviewed as [$id, $fingerprint]) {
                if (!isset($games[$id]) || !hash_equals($fingerprint, self::fingerprint($games[$id]))) self::stale();
            }

            if ($mode === 'merge') self::mergeFields($db, $games[$keep], $games[$remove]);
            $delete = $db->prepare('DELETE FROM games WHERE id = ?');
            if ($delete === false || !$delete->execute([$remove]) || $delete->rowCount() !== 1) {
                throw new RuntimeException('Could not remove the reviewed duplicate.');
            }
            if (!$db->commit()) throw new RuntimeException('Could not commit duplicate resolution.');
        } catch (Throwable $error) {
            if ($db->inTransaction()) $db->rollBack();
            throw $error;
        }
        return [$keep, $remove];
    }

    private static function game(array $row): array
    {
        return [
            'id' => $row['id'],
            'title' => $row['title'],
            'platform' => $row['platform'],
            'edition' => $row['edition'],
            'coverUrl' => $row['cover_url'] ?? '',
            'status' => $row['status'],
            'createdAt' => (int)$row['created_at'],
            'updatedAt' => $row['updated_at'],
        ];
    }

    private static function fingerprint(array $game): string
    {
        return hash('sha256', json_encode([
            $game['id'], $game['title'], $game['platform'], $game['edition'], $game['coverUrl'],
            $game['status'], $game['createdAt'], $game['updatedAt'],
        ], JSON_THROW_ON_ERROR));
    }

    private static function signature(string $payload, string $secret): string
    {
        return hash_hmac('sha256', "savepoint-duplicate-review\n" . $payload, $secret);
    }

    private static function encode(array $data, string $secret): string
    {
        $encoded = json_encode($data, JSON_THROW_ON_ERROR);
        $payload = rtrim(strtr(base64_encode($encoded), '+/', '-_'), '=');
        return $payload . '.' . self::signature($payload, $secret);
    }

    private static function decode(mixed $ticket, string $secret): array
    {
        if (!is_string($ticket) || !preg_match('/\A([a-zA-Z0-9_-]{1,512})\.([a-f0-9]{64})\z/', $ticket, $parts)
            || !hash_equals(self::signature($parts[1], $secret), $parts[2])) self::invalid();

        $decoded = base64_decode(strtr($parts[1], '-_', '+/'), true);
        $payload = $decoded === false ? null : json_decode($decoded, true, 4);
        if (!is_array($payload) || !array_is_list($payload)) self::invalid();
        return $payload;
    }

    private static function reviewedGames(mixed $ticket, string $secret): array
    {
        $payload = self::decode($ticket, $secret);
        if (count($payload) !== 3 || !is_int($payload[0])) self::invalid();
        [$expires, $left, $right] = $payload;
        if ($expires <= time()) self::stale();
        foreach ([$left, $right] as $pair) {
            if (!is_array($pair) || !array_is_list($pair) || count($pair) !== 2 || !self::validId($pair[0])
                || !is_string($pair[1]) || !preg_match('/\A[a-f0-9]{64}\z/', $pair[1])) self::invalid();
        }
        if (strcasecmp($left[0], $right[0]) === 0) self::invalid();
        return [$left, $right];
    }

    private static function mergeFields(PDO $db, array $keep, array $remove): void
    {
        // Use the ordinary save format and keep the chosen record's platform
        // ordering, status, cover identity and collection timestamp.
        $parts = array_map('trim', explode(',', $keep['platform'] . ',' . $remove['platform']));
        $platforms = array_unique(array_filter($parts, static fn(string $part): bool => $part !== ''));
        $combined = implode(', ', $platforms);
        if (preg_match_all('/./us', $combined) > 400) $combined = implode(',', $platforms);
        if ($combined === '' || preg_match_all('/./us', $combined) > 400 || count($platforms) > 50) {
            throw new ImportException('ai_duplicates_merge_too_large', 422);
        }
        // Canonical media types can be combined losslessly. An imported edition
        // may carry a custom label, so use the edition of the chosen record.
        $edition = $keep['edition'];
        if ($edition !== $remove['edition'] && in_array($edition, self::EDITIONS, true)
            && in_array($remove['edition'], self::EDITIONS, true)) {
            $edition = 'Fizyczne i cyfrowe';
        }
        if ($combined === $keep['platform'] && $edition === $keep['edition']) return;
        $update = $db->prepare('UPDATE games SET platform = ?, edition = ? WHERE id = ?');
        if ($update === false || !$update->execute([$combined, $edition, $keep['id']])) {
            throw new RuntimeException('Could not merge the reviewed records.');
        }
    }

    private static function validId(mixed $id): bool
    {
        return is_string($id) && preg_match('/\A[a-zA-Z0-9-]{1,36}\z/', $id) === 1;
    }

    private static function invalid(): never
    {
        throw new ImportException('ai_duplicates_invalid', 422);
    }

    private static function stale(): never
    {
        throw new ImportException('ai_duplicates_stale', 409);
    }
}
