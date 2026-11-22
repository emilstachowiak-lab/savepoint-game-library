<?php
declare(strict_types=1);

use Savepoint\AI\ImportException;
use Savepoint\AI\UploadStore;
use Savepoint\Collection\TransferError;
use Savepoint\Collection\TransferStore;

// Run with the account that owns the private upload directory.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/PhotoImport.php';
require_once dirname(__DIR__) . '/collection/TransferStore.php';

$failed = false;
// A busy store can wait for the next run. Always try both stores and fail the
// command only if at least one reports an error other than lock contention.
try {
    (new UploadStore(__DIR__ . '/uploads'))->prune();
} catch (ImportException $error) {
    $failed = $error->errorId !== 'ai_upload_busy';
} catch (Throwable) {
    $failed = true;
}
try {
    (new TransferStore(dirname(__DIR__) . '/collection/uploads'))->prune();
} catch (TransferError $error) {
    $failed = $failed || $error->status !== 429;
} catch (Throwable) {
    $failed = true;
}
if ($failed) fwrite(STDERR, "Savepoint could not prune one or more temporary uploads.\n");
exit($failed ? 1 : 0);
