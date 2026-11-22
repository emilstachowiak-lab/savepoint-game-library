<?php
declare(strict_types=1);

namespace {
    if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
    if (PHP_VERSION_ID < 80200) { fwrite(STDERR, "These isolated tests require PHP 8.2 or newer.\n"); exit(1); }
    // The default transport executes against namespace shims, never sockets.
    foreach (['CURLOPT_PROTOCOLS', 'CURLPROTO_HTTPS', 'CURLOPT_REDIR_PROTOCOLS', 'CURLOPT_FOLLOWLOCATION',
        'CURLOPT_PROXY', 'CURLOPT_POST', 'CURLOPT_POSTFIELDS', 'CURLOPT_HTTPHEADER', 'CURLOPT_CONNECTTIMEOUT',
        'CURLOPT_TIMEOUT', 'CURLOPT_SSL_VERIFYPEER', 'CURLOPT_SSL_VERIFYHOST', 'CURLOPT_WRITEFUNCTION',
        'CURLOPT_HEADERFUNCTION', 'CURLINFO_RESPONSE_CODE', 'CURLE_OPERATION_TIMEDOUT'] as $index => $name) {
        if (!defined($name)) define($name, 12000 + $index);
    }
    if (!function_exists('curl_init')) {
        function curl_init(?string $url = null): false { throw new \RuntimeException('Real transport must never run.'); }
    }
    $aiTransfers = [];
    $aiHandles = [];
}

namespace Savepoint\AI {
    function curl_init(?string $url = null): object
    {
        $handle = (object)['url' => $url, 'options' => [], 'status' => 0, 'closed' => false];
        $GLOBALS['aiHandles'][] = $handle;
        return $handle;
    }
    function curl_setopt_array(object $handle, array $options): bool { $handle->options = $options; return true; }
    function curl_exec(object $handle): bool
    {
        $fixture = array_shift($GLOBALS['aiTransfers']);
        if (!is_array($fixture)) throw new \RuntimeException('Unexpected synthetic transfer.');
        $handle->status = $fixture['status'] ?? 200;
        $handle->error = $fixture['error'] ?? 0;
        foreach ($fixture['headers'] ?? [] as $header) ($handle->options[CURLOPT_HEADERFUNCTION])($handle, $header);
        foreach ($fixture['chunks'] ?? [] as $chunk) {
            if (($handle->options[CURLOPT_WRITEFUNCTION])($handle, $chunk) !== strlen($chunk)) return false;
        }
        return $fixture['success'] ?? true;
    }
    function curl_getinfo(object $handle, int $option): int { return $handle->status; }
    function curl_errno(object $handle): int { return $handle->error; }
    function curl_close(object $handle): void { $handle->closed = true; }
}

namespace {
    require dirname(__DIR__) . '/server/ai/PhotoImport.php';

    use Savepoint\AI\GameRecognizer;
    use Savepoint\AI\ImportException;
    use Savepoint\AI\UploadStore;

    function expect(bool $condition, string $message): void
    {
        if (!$condition) throw new \RuntimeException($message);
    }
    function failure(callable $operation, string $id, ?int $status = null): ImportException
    {
        try { $operation(); }
        catch (ImportException $error) {
            expect($error->errorId === $id && $error->getMessage() === $id, 'Expected safe error ID: ' . $id);
            if ($status !== null) expect($error->status === $status, 'Expected HTTP status: ' . $status);
            return $error;
        }
        throw new \RuntimeException('Expected rejection: ' . $id);
    }
    function response(array $result): array
    {
        return ['candidates' => [['finishReason' => 'STOP', 'content' => ['role' => 'model', 'parts' => [
            ['text' => json_encode($result, JSON_THROW_ON_ERROR)],
        ]]]]];
    }
    function removeFixture(string $path): void
    {
        if (is_dir($path) && !is_link($path)) {
            foreach (new \FilesystemIterator($path, \FilesystemIterator::SKIP_DOTS) as $entry) removeFixture($entry->getPathname());
            rmdir($path);
        } elseif (file_exists($path) || is_link($path)) unlink($path);
    }

    $directory = sys_get_temp_dir() . '/savepoint-ai-isolated-' . bin2hex(random_bytes(8));
    mkdir($directory, 0700);
    register_shutdown_function(static fn() => removeFixture($directory));
    $owner = hash('sha256', 'synthetic-session-one');
    $other = hash('sha256', 'synthetic-session-two');
    // A generated white pixel contains no real photo or camera metadata.
    $jpeg = base64_decode('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==', true);
    expect(is_string($jpeg), 'Synthetic JPEG must decode.');
    UploadStore::validateJpeg($jpeg);

    $store = new UploadStore($directory . '/upload-one');
    $upload = $store->begin($owner, strlen($jpeg));
    expect(preg_match('/\A[a-f0-9]{32}\z/', $upload['uploadId']) === 1 && $upload['offset'] === 0
        && $upload['chunkBytes'] === 45000 && $upload['expiresIn'] === 900, 'The server allocates bounded opaque upload IDs and reports their remaining lifetime.');
    $id = $upload['uploadId'];
    expect((fileperms($directory . '/upload-one') & 0777) === 0700, 'Upload directory must be private.');
    expect((fileperms($directory . '/upload-one/' . $id . '.part') & 0777) === 0600, 'Photo files must be private.');
    $first = base64_encode(substr($jpeg, 0, 100));
    expect($store->append($owner, $id, 0, $first)['offset'] === 100, 'First chunk must advance exactly.');
    expect($store->append($owner, $id, 0, $first)['offset'] === 100, 'An exact lost-response replay is idempotent.');
    file_put_contents($directory . '/upload-one/' . $id . '.part', 'uncommitted bytes', FILE_APPEND);
    expect($store->append($owner, $id, 0, $first)['offset'] === 100, 'An incomplete write can be retried from its last committed offset.');
    failure(fn() => $store->append($owner, $id, 0, base64_encode(str_repeat('x', 100))), 'ai_invalid_upload');
    failure(fn() => $store->append($owner, $id, 101, $first), 'ai_invalid_upload');
    failure(fn() => $store->append($other, $id, 100, base64_encode(substr($jpeg, 100))), 'ai_upload_unavailable', 404);
    failure(fn() => $store->take($other, $id), 'ai_upload_unavailable', 404);
    failure(fn() => $store->cancel($other, $id), 'ai_upload_unavailable', 404);
    failure(fn() => $store->take($owner, $id), 'ai_upload_incomplete', 409);
    $store->append($owner, $id, 100, base64_encode(substr($jpeg, 100)));
    expect($store->take($owner, $id) === $jpeg, 'Only the owning session can consume the assembled JPEG.');
    failure(fn() => $store->take($owner, $id), 'ai_upload_unavailable', 404);
    $store->cancel($owner, $id);
    expect(!file_exists($directory . '/upload-one/' . $id . '.json')
        && !file_exists($directory . '/upload-one/' . $id . '.part'), 'Taking an image deletes metadata and bytes before analysis.');
    echo "PASS: private session-owned ordered uploads, exact retries and single-use consumption.\n";

    failure(fn() => $store->begin($owner, UploadStore::MAX_BYTES + 1), 'ai_image_too_large', 413);
    failure(fn() => $store->begin($owner, 0), 'ai_image_too_large', 413);
    failure(fn() => $store->begin('account-1', 20), 'ai_invalid_upload');
    failure(fn() => $store->append($owner, '../private', 0, 'QQ=='), 'ai_invalid_upload');
    $id = $store->begin($owner, 100)['uploadId'];
    foreach (['', 'QQ', 'QQ==\n', '%%%%', base64_encode(str_repeat('x', 45001))] as $data) {
        failure(fn() => $store->append($owner, $id, 0, $data), 'ai_invalid_upload');
    }
    failure(fn() => $store->append($owner, $id, -1, 'QQ=='), 'ai_invalid_upload');
    failure(fn() => $store->append($owner, $id, 0, base64_encode(str_repeat('x', 101))), 'ai_invalid_upload');
    $store->cancel($owner, $id);
    echo "PASS: strict byte, Base64, owner, offset and path bounds retain the existing request cap.\n";

    $now = 100000;
    $clock = static function () use (&$now): int { return $now; };
    $quota = new UploadStore($directory . '/quota', $clock);
    $one = $quota->begin($owner, UploadStore::MAX_BYTES)['uploadId'];
    $two = $quota->begin($owner, UploadStore::MAX_BYTES)['uploadId'];
    failure(fn() => $quota->begin($owner, 1), 'ai_upload_limit', 429);
    $quota->begin($other, UploadStore::MAX_BYTES);
    $quota->begin(hash('sha256', 'synthetic-three'), UploadStore::MAX_BYTES);
    failure(fn() => $quota->begin(hash('sha256', 'synthetic-four'), 1), 'ai_upload_limit', 429);
    $quota->cancel($owner, $one);
    $quota->begin(hash('sha256', 'synthetic-four'), 1);
    $now += 901;
    failure(fn() => $quota->take($owner, $two), 'ai_upload_expired', 410);
    expect(!file_exists($directory . '/quota/' . $two . '.part'), 'An expired upload is removed when its owner returns.');
    $quota->prune();
    expect(count(iterator_to_array(new \FilesystemIterator($directory . '/quota', \FilesystemIterator::SKIP_DOTS))) === 1,
        'Expiry reaps all old metadata and partial images, retaining only the lock.');
    $quota->begin($owner, strlen($jpeg));
    echo "PASS: global and per-owner quotas, bounded expiry and cancellation free storage.\n";

    $invalid = $store->begin($owner, 12)['uploadId'];
    $store->append($owner, $invalid, 0, base64_encode('not-an-image'));
    failure(fn() => $store->take($owner, $invalid), 'ai_image_invalid', 422);
    expect(!file_exists($directory . '/upload-one/' . $invalid . '.part'), 'Invalid complete uploads are consumed too.');
    $sof = strpos($jpeg, "\xff\xc0");
    expect(is_int($sof), 'Synthetic fixture must contain its frame header.');
    $wide = substr_replace($jpeg, pack('n', 1601), $sof + 7, 2);
    foreach ([$wide, substr($jpeg, 0, -2), '<svg></svg>', str_repeat('x', UploadStore::MAX_BYTES + 1)] as $image) {
        failure(fn() => UploadStore::validateJpeg($image), 'ai_image_invalid', 422);
    }
    echo "PASS: JPEG MIME, signatures, complete length and dimensions are checked before provider access.\n";

    $outside = $directory . '/untouched';
    file_put_contents($outside, 'synthetic unchanged target');
    symlink($directory . '/upload-one', $directory . '/linked-store');
    failure(fn() => (new UploadStore($directory . '/linked-store'))->begin($owner, 1), 'ai_upload_unavailable', 503);
    mkdir($directory . '/linked-lock');
    symlink($outside, $directory . '/linked-lock/.lock');
    failure(fn() => (new UploadStore($directory . '/linked-lock'))->begin($owner, 1), 'ai_upload_unavailable', 503);
    $linked = $store->begin($owner, 1)['uploadId'];
    unlink($directory . '/upload-one/' . $linked . '.part');
    symlink($outside, $directory . '/upload-one/' . $linked . '.part');
    failure(fn() => $store->append($owner, $linked, 0, 'eA=='), 'ai_upload_unavailable', 503);
    expect(file_get_contents($outside) === 'synthetic unchanged target', 'Symlinks cannot redirect writes or deletion.');
    echo "PASS: symlinked stores, locks and image files fail closed without touching their targets.\n";

    $defaults = GameRecognizer::configload($directory . '/missing-config.php');
    expect($defaults['enabled'] === false && $defaults['api_key'] === ''
        && $defaults['model'] === 'gemini-3.5-flash-lite' && !GameRecognizer::configured($defaults), 'An unconfigured feature is disabled.');
    $template = require dirname(__DIR__) . '/server/ai/config.example.php';
    expect(!GameRecognizer::configured($template) && $template['api_key'] === '', 'Public template must contain no credential.');
    file_put_contents($directory . '/synthetic-config.php', '<?php echo "synthetic-secret-output"; return ["enabled"=>false];');
    ob_start();
    GameRecognizer::configload($directory . '/synthetic-config.php');
    expect(ob_get_clean() === '', 'Configuration output must not leak into an API response.');
    $config = ['enabled' => true, 'api_key' => 'synthetic-gemini-key-not-real', 'model' => 'gemini-3.5-flash-lite', 'hourly_limit' => 20];
    expect(GameRecognizer::configured($config), 'Synthetic configured fixture must be enabled.');
    foreach ([['api_key' => "synthetic-key\r\nHeader:value"], ['enabled' => 'true'],
        ['model' => 'https://invalid.example/model'], ['model' => '../gemini-3.5-flash-lite'],
        ['model' => 'gemini-3.5-flash-lite?key=synthetic'], ['model' => 'gemini-3.5-flash-lite-preview'],
        ['model' => 'gpt-5.4-mini']] as $bad) {
        expect(!GameRecognizer::configured(array_replace($config, $bad)), 'Malformed configuration must remain disabled.');
    }
    failure(fn() => (new GameRecognizer($defaults, $directory . '/disabled'))->recognize($jpeg, 'pl'), 'ai_not_configured', 503);
    expect(!is_dir($directory . '/disabled'), 'Disabled recognition must not create budget state or make a call.');
    echo "PASS: private optional configuration stays disabled until explicitly configured and emits no secrets.\n";

    $recognized = ['candidates' => [['title' => 'Synthetic Game', 'platform' => 'PC', 'confidence' => 'high', 'note' => '']], 'notes' => ''];
    $requests = [];
    $recognizer = new GameRecognizer($config, $directory . '/recognize', static function (array $payload, string $key) use (&$requests, $recognized): array {
        $requests[] = $payload;
        expect($key === 'synthetic-gemini-key-not-real', 'Only the synthetic transport receives the credential.');
        expect(strpos(json_encode($payload), $key) === false, 'Credentials must not enter model input.');
        return response($recognized);
    });
    expect($recognizer->recognize($jpeg, 'en') === $recognized, 'Validated candidates must be returned without collection writes.');
    $payload = $requests[0];
    expect(!isset($payload['generationConfig']['candidateCount']) && $payload['generationConfig']['maxOutputTokens'] === 6000
        && $payload['generationConfig']['responseMimeType'] === 'application/json' && !isset($payload['tools'])
        && !isset($payload['model']) && !isset($payload['store']), 'Only bounded stateless Gemini recognition is requested.');
    $schema = $payload['generationConfig']['responseJsonSchema'];
    expect($schema['additionalProperties'] === false
        && $schema['properties']['candidates']['items']['additionalProperties'] === false
        && $schema['required'] === ['candidates', 'notes'], 'Structured results retain required typed fields and reject extra properties.');
    expect(!str_contains(json_encode($schema, JSON_THROW_ON_ERROR), 'maxLength')
        && !str_contains(json_encode($schema, JSON_THROW_ON_ERROR), 'maxItems'), 'Provider-incompatible bounds are omitted; application validation enforces them.');
    $instructions = $payload['systemInstruction']['parts'][0]['text'];
    expect(str_contains($instructions, 'untrusted') && str_contains($instructions, 'English')
        && str_contains($instructions, 'at most 32'), 'Image instructions are untrusted, candidates are bounded and notes use the interface language.');
    expect($payload['contents'][0]['role'] === 'user'
        && $payload['contents'][0]['parts'][1]['inlineData'] === ['mimeType' => 'image/jpeg', 'data' => base64_encode($jpeg)], 'Only the prepared inline JPEG is sent.');
    expect((fileperms($directory . '/recognize/analysis-budget.json') & 0777) === 0600, 'The global admission counter must be private.');
    echo "PASS: strict multi-game Gemini GenerateContent payload omits tools, collection data and credentials from the prompt.\n";

    $uncertain = $recognized;
    $uncertain['candidates'][0]['title'] = '';
    $uncertain['candidates'][0]['platform'] = '';
    $uncertainRecognizer = new GameRecognizer($config, $directory . '/uncertain', static fn() => response($uncertain));
    expect($uncertainRecognizer->recognize($jpeg, 'pl')['candidates'][0]['confidence'] === 'low', 'Empty evidence cannot be presented as confident.');
    $invalidResults = [];
    $extra = $recognized; $extra['candidates'][0]['coverUrl'] = 'https://invalid.example/image'; $invalidResults[] = response($extra);
    $unknown = $recognized; $unknown['candidates'][0]['platform'] = 'Invented Platform'; $invalidResults[] = response($unknown);
    $tooMany = $recognized; $tooMany['candidates'] = array_fill(0, 33, $recognized['candidates'][0]); $invalidResults[] = response($tooMany);
    $control = $recognized; $control['candidates'][0]['title'] = "Synthetic\nGame"; $invalidResults[] = response($control);
    $long = $recognized; $long['notes'] = str_repeat('x', 4001); $invalidResults[] = response($long);
    foreach ([null, '', 'FINISH_REASON_UNSPECIFIED', 'MAX_TOKENS', 'OTHER', 'LANGUAGE', 'MALFORMED_FUNCTION_CALL'] as $finish) {
        $incomplete = response($recognized); $incomplete['candidates'][0]['finishReason'] = $finish; $invalidResults[] = $incomplete;
    }
    $invalidResults[] = ['candidates' => []];
    $invalidResults[] = ['error' => ['message' => 'synthetic private provider failure']];
    $invalidResults[] = ['candidates' => array_fill(0, 2, response($recognized)['candidates'][0])];
    $invalidResults[] = ['candidates' => [['finishReason' => 'STOP', 'content' => ['parts' => [['text' => '<html>not JSON</html>']]]]]];
    $invalidResults[] = ['candidates' => [['finishReason' => 'STOP', 'content' => ['parts' => [['text' => str_repeat('x', 131073)]]]]]];
    $nonText = response($recognized); $nonText['candidates'][0]['content']['parts'][] = ['functionCall' => ['name' => 'untrusted']]; $invalidResults[] = $nonText;
    $thought = response($recognized); $thought['candidates'][0]['content']['parts'][0]['thought'] = true; $invalidResults[] = $thought;
    $malformedSafety = response($recognized); $malformedSafety['candidates'][0]['safetyRatings'] = 'invalid'; $invalidResults[] = $malformedSafety;
    $invalidResults[] = ['promptFeedback' => ['blockReason' => []]];
    foreach ($invalidResults as $index => $invalidResult) {
        failure(fn() => (new GameRecognizer($config, $directory . '/invalid-' . $index, static fn() => $invalidResult))->recognize($jpeg, 'en'), 'ai_response_invalid', 502);
    }
    $refusals = [['promptFeedback' => ['blockReason' => 'SAFETY', 'blockReasonMessage' => 'synthetic private provider text']],
        ['promptFeedback' => ['blockReason' => 'OTHER']],
        ['promptFeedback' => ['safetyRatings' => [['blocked' => true]]]]];
    foreach (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION'] as $finish) {
        $refusal = response($recognized); $refusal['candidates'][0]['finishReason'] = $finish;
        $refusal['candidates'][0]['finishMessage'] = 'synthetic private provider text'; $refusals[] = $refusal;
    }
    $refusal = response($recognized); $refusal['candidates'][0]['safetyRatings'] = [['blocked' => true]]; $refusals[] = $refusal;
    foreach ($refusals as $index => $refusal) {
        failure(fn() => (new GameRecognizer($config, $directory . '/refusal-' . $index, static fn() => $refusal))->recognize($jpeg, 'en'), 'ai_refused', 422);
    }
    $split = response($recognized);
    $text = $split['candidates'][0]['content']['parts'][0]['text'];
    $split['candidates'][0]['content']['parts'] = [['text' => substr($text, 0, 20)], ['text' => substr($text, 20)]];
    expect((new GameRecognizer($config, $directory . '/split', static fn() => $split))->recognize($jpeg, 'en') === $recognized,
        'A complete structured response can contain multiple text parts.');
    echo "PASS: uncertain, malformed, excessive, refused and incomplete model outputs never bypass review validation.\n";

    $now = 100000;
    $calls = 0;
    $budgetConfig = array_replace($config, ['hourly_limit' => 1]);
    $failTransport = static function () use (&$calls): never { $calls++; throw new \RuntimeException('synthetic private upstream failure'); };
    $firstRecognizer = new GameRecognizer($budgetConfig, $directory . '/budget', $failTransport, $clock);
    failure(fn() => $firstRecognizer->recognize($jpeg, 'en'), 'ai_service_unavailable', 502);
    $secondRecognizer = new GameRecognizer($budgetConfig, $directory . '/budget', $failTransport, $clock);
    failure(fn() => $secondRecognizer->recognize($jpeg, 'en'), 'ai_rate_limited', 429);
    expect($calls === 1, 'An ambiguous paid call consumes its global slot and is never retried.');
    $now += 3600;
    failure(fn() => $secondRecognizer->recognize($jpeg, 'en'), 'ai_service_unavailable', 502);
    expect($calls === 2, 'A later hour admits a new explicit request.');
    file_put_contents($directory . '/budget/analysis-budget.json', 'corrupt');
    failure(fn() => $secondRecognizer->recognize($jpeg, 'en'), 'ai_service_unavailable', 503);
    expect($calls === 2, 'A corrupt admission counter cannot reset spending.');
    echo "PASS: global hourly admission is locked, bounded and counts ambiguous failures without automatic retries.\n";

    $GLOBALS['aiTransfers'][] = ['chunks' => [json_encode(response($recognized), JSON_THROW_ON_ERROR)]];
    expect((new GameRecognizer($config, $directory . '/transport'))->recognize($jpeg, 'en') === $recognized, 'The real request builder parses the synthetic response.');
    $handle = $GLOBALS['aiHandles'][0];
    expect($handle->url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent' && $handle->closed, 'The fixed model endpoint is closed after use.');
    expect($handle->options[CURLOPT_HTTPHEADER] === ['x-goog-api-key: synthetic-gemini-key-not-real', 'Content-Type: application/json', 'Accept: application/json']
        && !str_contains($handle->url, $config['api_key']) && !str_contains($handle->options[CURLOPT_POSTFIELDS], $config['api_key']),
        'The API key appears only in the Google authentication header, never in the URL or prompt.');
    expect(json_decode($handle->options[CURLOPT_POSTFIELDS], true, 32, JSON_THROW_ON_ERROR) === $payload, 'The actual request builder sends the validated Gemini payload.');
    expect($handle->options[CURLOPT_PROTOCOLS] === CURLPROTO_HTTPS && $handle->options[CURLOPT_FOLLOWLOCATION] === false
        && $handle->options[CURLOPT_PROXY] === '' && $handle->options[CURLOPT_SSL_VERIFYPEER] === true
        && $handle->options[CURLOPT_SSL_VERIFYHOST] === 2 && $handle->options[CURLOPT_CONNECTTIMEOUT] === 5
        && $handle->options[CURLOPT_TIMEOUT] === 24, 'Transport never redirects the key or weakens HTTPS validation.');
    foreach ([['status' => 302], ['status' => 401, 'chunks' => ['synthetic private provider error']],
        ['success' => false], ['chunks' => [str_repeat('x', 524289)]]] as $index => $fixture) {
        $before = count($GLOBALS['aiHandles']);
        $GLOBALS['aiTransfers'][] = $fixture;
        failure(fn() => (new GameRecognizer($config, $directory . '/transport-error-' . $index))->recognize($jpeg, 'en'), 'ai_service_unavailable', 502);
        expect(count($GLOBALS['aiHandles']) === $before + 1 && end($GLOBALS['aiHandles'])->closed, 'Transport failure is closed and not retried.');
    }
    $GLOBALS['aiTransfers'][] = ['status' => 429, 'headers' => ["Retry-After: 37\r\n"]];
    $rateError = failure(fn() => (new GameRecognizer($config, $directory . '/transport-rate'))->recognize($jpeg, 'en'),
        'ai_provider_rate_limited', 429);
    expect($rateError->retryAfter === 37, 'Respect the sanitized upstream retry delay.');
    $GLOBALS['aiTransfers'][] = ['success' => false, 'error' => CURLE_OPERATION_TIMEDOUT];
    failure(fn() => (new GameRecognizer($config, $directory . '/transport-timeout'))->recognize($jpeg, 'en'),
        'ai_provider_timeout', 504);
    echo "PASS: fixed HTTPS transport enforces certificate, redirect, timeout and response-size limits without leaking provider text.\n";
    echo "All 10 isolated AI import backend test groups passed.\n";
}
