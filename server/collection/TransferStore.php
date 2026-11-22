<?php
declare(strict_types=1);

namespace Savepoint\Collection;

use InvalidArgumentException;
use JsonException;
use RuntimeException;
use Throwable;

final class TransferError extends RuntimeException
{
    public function __construct(public readonly int $status, string $code)
    {
        parent::__construct($code);
    }
}

/**
 * Stores bounded collection uploads outside the document root. The caller
 * supplies an owner derived from the authenticated session, never from JSON.
 */
final class TransferStore
{
    public const MAX_BYTES = 16 * 1024 * 1024;
    public const CHUNK_BYTES = 32 * 1024;
    private const TTL = 7200;
    private const MAX_ACTIVE = 4;

    public function __construct(private readonly string $directory)
    {
    }

    public function start(string $owner, mixed $mode, mixed $size): array
    {
        if (!in_array($mode, ['migrate', 'replace'], true) || !is_int($size) || $size < 2) {
            throw new TransferError(400, 'collection_upload_invalid');
        }
        if ($size > self::MAX_BYTES) {
            throw new TransferError(413, 'request_too_large');
        }
        return $this->withLock(function () use ($owner, $mode, $size): array {
            if ($this->purgeExpired() >= self::MAX_ACTIVE) {
                throw new TransferError(429, 'collection_upload_busy');
            }
            $id = bin2hex(random_bytes(16));
            $path = $this->payloadPath($id);
            $file = @fopen($path, 'x+b');
            if ($file === false) {
                throw new RuntimeException('Collection staging could not create a payload.');
            }
            fclose($file);
            @chmod($path, 0600);
            try {
                $this->writeState($id, [
                    'owner' => $owner,
                    'mode' => $mode,
                    'size' => $size,
                    'status' => 'uploading',
                    'expiresAt' => time() + self::TTL,
                ]);
            } catch (Throwable $error) {
                @unlink($path);
                throw $error;
            }
            return ['uploadId' => $id, 'offset' => 0, 'chunkBytes' => self::CHUNK_BYTES];
        });
    }

    // Offsets count decoded bytes. Replaying identical bytes acknowledges the
    // same end offset without appending, and gaps or conflicting overlaps fail.
    public function append(string $owner, mixed $id, mixed $offset, mixed $encoded): int
    {
        $id = $this->validateId($id);
        if (!is_int($offset) || $offset < 0 || !is_string($encoded)
            || strlen($encoded) > 4 * (int)ceil(self::CHUNK_BYTES / 3)) {
            throw new TransferError(400, 'collection_upload_invalid');
        }
        $chunk = base64_decode($encoded, true);
        if ($chunk === false || $chunk === '' || strlen($chunk) > self::CHUNK_BYTES
            || base64_encode($chunk) !== $encoded) {
            throw new TransferError(400, 'collection_upload_invalid');
        }
        return $this->withLock(function () use ($owner, $id, $offset, $chunk): int {
            $state = $this->ownedState($owner, $id);
            if ($state['status'] !== 'uploading') {
                throw new TransferError(409, 'collection_upload_uncertain');
            }
            $file = @fopen($this->payloadPath($id), 'r+b');
            if ($file === false) {
                throw new RuntimeException('Collection staging payload is unavailable.');
            }
            try {
                $current = fstat($file)['size'] ?? null;
                $end = $offset + strlen($chunk);
                if ($current === null || $offset > $current || $end > $state['size']) {
                    throw new TransferError(409, 'collection_upload_offset');
                }
                if (fseek($file, $offset) !== 0) {
                    throw new RuntimeException('Collection staging could not select the chunk offset.');
                }
                if ($offset < $current) {
                    if ($end <= $current && fread($file, strlen($chunk)) === $chunk) {
                        return $end;
                    }
                    throw new TransferError(409, 'collection_upload_offset');
                }
                if (fwrite($file, $chunk) !== strlen($chunk) || !fflush($file)) {
                    // Restore the previous length so a retry starts at the same offset.
                    @ftruncate($file, $current);
                    throw new RuntimeException('Collection staging could not write a chunk.');
                }
                return $end;
            } finally {
                fclose($file);
            }
        });
    }

    public function finish(string $owner, mixed $id, callable $apply): int
    {
        $id = $this->validateId($id);
        return $this->withLock(function () use ($owner, $id, $apply): int {
            $state = $this->ownedState($owner, $id);
            if ($state['status'] === 'done') {
                return $state['inserted'];
            }
            if ($state['status'] === 'applying') {
                throw new TransferError(409, 'collection_upload_uncertain');
            }
            $path = $this->payloadPath($id);
            $payload = @file_get_contents($path, false, null, 0, $state['size'] + 1);
            if ($payload === false || strlen($payload) !== $state['size']) {
                throw new TransferError(409, 'collection_upload_offset');
            }
            try {
                $items = json_decode($payload, true, 32, JSON_THROW_ON_ERROR);
            } catch (JsonException $error) {
                throw new InvalidArgumentException('invalid_game_collection');
            }
            if (!str_starts_with(ltrim($payload, " \t\r\n"), '[') || !is_array($items)) {
                throw new InvalidArgumentException('invalid_game_collection');
            }
            unset($payload);

            // Persist the intent before applying. A lost response can reuse a
            // completed result, while an interrupted commit is never repeated.
            $state['status'] = 'applying';
            $this->writeState($id, $state);
            try {
                $inserted = $apply($state['mode'], $items);
            } catch (InvalidArgumentException | \CollectionConflict $error) {
                $this->remove($id);
                throw $error;
            } catch (Throwable $error) {
                // This upload can no longer be applied. Keep its status, not
                // the collection data, for a caller retrying the response.
                @unlink($path);
                throw $error;
            }
            $state['status'] = 'done';
            $state['inserted'] = $inserted;
            $this->writeState($id, $state);
            @unlink($path);
            return $inserted;
        });
    }

    public function cancel(string $owner, mixed $id): void
    {
        $id = $this->validateId($id);
        $this->withLock(function () use ($owner, $id): void {
            $state = $this->ownedState($owner, $id);
            if ($state['status'] === 'uploading') {
                $this->remove($id);
            }
        });
    }

    public function prune(): void
    {
        if (is_dir($this->directory)) $this->withLock($this->purgeExpired(...));
    }

    private function withLock(callable $operation): mixed
    {
        if (!is_dir($this->directory) && !@mkdir($this->directory, 0700, true)
            && !is_dir($this->directory)) {
            throw new RuntimeException('Collection staging directory is unavailable.');
        }
        $file = @fopen($this->directory . '/lock', 'c+b');
        if ($file === false) {
            throw new RuntimeException('Collection staging lock is unavailable.');
        }
        try {
            if (!flock($file, LOCK_EX | LOCK_NB)) {
                throw new TransferError(429, 'collection_upload_busy');
            }
            return $operation();
        } finally {
            fclose($file);
        }
    }

    private function validateId(mixed $id): string
    {
        if (!is_string($id) || preg_match('/\A[a-f0-9]{32}\z/D', $id) !== 1) {
            throw new TransferError(400, 'collection_upload_invalid');
        }
        return $id;
    }

    private function metadataPath(string $id): string
    {
        return $this->directory . '/' . $id . '.json';
    }

    private function payloadPath(string $id): string
    {
        return $this->directory . '/' . $id . '.upload';
    }

    private function ownedState(string $owner, string $id): array
    {
        $state = $this->readState($this->metadataPath($id));
        if ($state === null || $state['expiresAt'] <= time() || !hash_equals($state['owner'], $owner)) {
            throw new TransferError(404, 'collection_upload_missing');
        }
        return $state;
    }

    private function readState(string $path): ?array
    {
        $raw = @file_get_contents($path, false, null, 0, 4096);
        $state = $raw !== false ? json_decode($raw, true) : null;
        if (!is_array($state)
            || !is_int($state['expiresAt'] ?? null) || !is_string($state['owner'] ?? null)
            || !is_int($state['size'] ?? null) || $state['size'] < 2 || $state['size'] > self::MAX_BYTES
            || !in_array($state['mode'] ?? null, ['replace', 'migrate'], true)
            || !in_array($state['status'] ?? null, ['uploading', 'applying', 'done'], true)
            || ($state['status'] === 'done' && !is_int($state['inserted'] ?? null))) {
            return null;
        }
        return $state;
    }

    private function writeState(string $id, array $state): void
    {
        $json = json_encode($state, JSON_THROW_ON_ERROR);
        $temporary = $this->directory . '/.state-' . $id;
        if (@file_put_contents($temporary, $json) !== strlen($json)
            || !@rename($temporary, $this->metadataPath($id))) {
            @unlink($temporary);
            throw new RuntimeException('Collection staging could not write its metadata.');
        }
    }

    private function remove(string $id): void
    {
        @unlink($this->payloadPath($id));
        @unlink($this->metadataPath($id));
    }

    private function purgeExpired(): int
    {
        $active = 0;
        $now = time();
        foreach (glob($this->directory . '/*.json') ?: [] as $file) {
            $state = $this->readState($file);
            if ($state === null || $state['expiresAt'] <= $now) {
                $this->remove(basename($file, '.json'));
            } elseif ($state['status'] !== 'done' && is_file($this->payloadPath(basename($file, '.json')))) {
                $active++;
            }
        }
        // Remove abandoned payloads that were never given an expiry record.
        foreach (glob($this->directory . '/*.upload') ?: [] as $file) {
            if (!is_file($this->metadataPath(basename($file, '.upload'))) && filemtime($file) < $now - self::TTL) {
                @unlink($file);
            }
        }
        return $active;
    }
}
