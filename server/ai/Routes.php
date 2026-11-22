<?php
declare(strict_types=1);

namespace Savepoint\AI;

require_once __DIR__ . '/PhotoImport.php';
require_once __DIR__ . '/CoverFinder.php';
require_once __DIR__ . '/ConfirmedGames.php';

// The main endpoint validates HTTPS, Origin, JSON and its 64 KiB cap before
// entering this dispatcher. AI requests use the current session cookie;
// their responses never set a replacement cookie.
final class Routes
{
    public static function dispatch(string $action, array $request, array $application): never
    {
        try {
            $cookie = $_COOKIE[\SESSION_COOKIE_NAME] ?? null;
            if (!is_string($cookie) || preg_match('/\A[a-zA-Z0-9,-]{1,256}\z/', $cookie) !== 1) {
                throw new ImportException('ai_session_expired', 401);
            }
            // Confirmed collection writes hold the session lock through their
            // database work. Other routes release it before upload or provider I/O.
            $writes = in_array($action, ['ai-add', 'ai-duplicates-apply'], true);
            $epoch = self::openSession($cookie, $writes);
            $config = GameRecognizer::configload(__DIR__ . '/config.local.php');
            $available = GameRecognizer::configured($config) && function_exists('curl_init');
            if ($action === 'ai-status') {
                \respond(200, ['ok' => true, 'available' => $available]);
            }
            if (!$available && $action !== 'ai-duplicates-apply') {
                throw new ImportException($action === 'ai-duplicates-scan'
                    ? 'ai_duplicates_not_configured' : 'ai_not_configured', 503);
            }
            if ($action === 'ai-cover-search') {
                $result = self::searchCover($request, new GameRecognizer($config, __DIR__), $application['app_origin']);
                self::ensureSameSession($cookie, $epoch);
                \respond(200, ['ok' => true] + $result);
            }
            if ($action === 'ai-duplicates-scan' || $action === 'ai-duplicates-apply') {
                $result = self::duplicates($action, $request, $config, $application, $cookie, $epoch);
                \respond(200, ['ok' => true] + $result);
            }
            $owner = hash_hmac('sha256', $cookie . ':' . $epoch, (string)$application['app_password_hash']);
            $store = new UploadStore(__DIR__ . '/uploads');
            switch ($action) {
                case 'ai-upload-start':
                    if (($request['mime'] ?? null) !== 'image/jpeg' || !is_int($request['size'] ?? null)) {
                        throw new ImportException('ai_invalid_upload');
                    }
                    $result = $store->begin($owner, $request['size']);
                    break;
                case 'ai-upload-chunk':
                    if (!is_string($request['uploadId'] ?? null) || !is_int($request['offset'] ?? null)
                        || !is_string($request['data'] ?? null)) {
                        throw new ImportException('ai_invalid_upload');
                    }
                    $result = $store->append($owner, $request['uploadId'], $request['offset'], $request['data']);
                    break;
                case 'ai-upload-cancel':
                    if (!is_string($request['uploadId'] ?? null)) throw new ImportException('ai_invalid_upload');
                    $store->cancel($owner, $request['uploadId']);
                    $result = [];
                    break;
                case 'ai-recognize':
                    if (!is_string($request['uploadId'] ?? null)) throw new ImportException('ai_invalid_upload');
                    $deadline = microtime(true) + 32;
                    // Claim and delete the local photo before calling Gemini.
                    // Retrying the upload ID cannot repeat either lookup.
                    $jpeg = $store->take($owner, $request['uploadId']);
                    $language = strtolower((string)($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? '')) === 'en' ? 'en' : 'pl';
                    $recognizer = new GameRecognizer($config, __DIR__);
                    $result = $recognizer->recognize($jpeg, $language);
                    unset($jpeg);
                    // A completed model response must not cross sign-out,
                    // session expiry, or another sign-in using the old cookie.
                    self::ensureSameSession($cookie, $epoch);
                    $result = self::suggestCovers($result, $recognizer, $deadline, $application['app_origin']);
                    self::ensureSameSession($cookie, $epoch);
                    break;
                case 'ai-add':
                    if (!is_array($request['games'] ?? null)) {
                        throw new BatchException('ai_invalid_batch', 422);
                    }
                    $db = \getDatabase($application);
                    $result = ConfirmedGames::add($db, $request['games'], ($request['confirmed'] ?? null) === true, 'normalizedGame');
                    if (($request['delta'] ?? null) === true) {
                        $result['addedGames'] = \listGames($db, array_map('strtolower', array_column($request['games'], 'id')));
                    } else {
                        $result['games'] = \listGames($db);
                    }
                    break;
                default:
                    throw new ImportException('ai_invalid_upload');
            }
            \respond(200, ['ok' => true] + $result);
        } catch (ImportException $error) {
            if ($error->retryAfter > 0) header('Retry-After: ' . $error->retryAfter);
            $errorId = self::operationErrorId($action, $error->errorId);
            \respond($error->status, ['ok' => false, 'error' => $errorId,
                'errorId' => $errorId, 'authRequired' => $error->status === 401]);
        } catch (BatchException $error) {
            \respond($error->httpStatus, ['ok' => false, 'error' => $error->errorId, 'errorId' => $error->errorId]);
        } catch (\Throwable $error) {
            // Provider bodies and configuration values must not reach logs
            // or browser errors, including through an unexpected exception.
            error_log('Savepoint AI request failed.');
            \respond(503, ['ok' => false, 'error' => $action === 'ai-cover-search'
                ? 'ai_cover_search_unavailable' : 'ai_service_unavailable']);
        }
    }

    // Select a message catalog ID suited to the failed operation. The API
    // translates it for the browser and also keeps it as a machine-readable ID.
    private static function operationErrorId(string $action, string $errorId): string
    {
        return match ($action) {
            'ai-cover-search' => match ($errorId) {
                'ai_rate_limited' => 'ai_cover_search_rate_limited',
                'ai_not_configured', 'ai_service_unavailable', 'ai_upload_busy', 'ai_upload_unavailable'
                    => 'ai_cover_search_unavailable',
                default => $errorId,
            },
            'ai-duplicates-scan' => match ($errorId) {
                'ai_response_invalid' => 'ai_duplicates_response_invalid',
                'ai_refused' => 'ai_duplicates_refused',
                default => $errorId,
            },
            default => $errorId,
        };
    }

    private static function duplicates(
        string $action,
        array $request,
        array $config,
        array $application,
        string $cookie,
        int $epoch,
    ): array {
        require_once __DIR__ . '/DuplicateGames.php';
        $secret = hash_hmac('sha256', 'duplicates:' . $cookie . ':' . $epoch, (string)$application['app_password_hash']);
        $db = \getDatabase($application);

        if ($action === 'ai-duplicates-apply') {
            [$keep, $removed] = DuplicateGames::apply($db, $request, $secret);
            if (($request['delta'] ?? null) === true) {
                return ['game' => \listGames($db, [$keep])[0] ?? null, 'deletedId' => $removed];
            }
            return ['games' => \listGames($db)];
        }

        require_once __DIR__ . '/DuplicateDetector.php';
        $recognizer = new GameRecognizer($config, __DIR__);
        $games = DuplicateGames::snapshot($db);
        $snapshot = DuplicateGames::snapshotFingerprint($games);
        $position = DuplicateGames::scanPosition($request['cursor'] ?? null, $snapshot, $secret);
        $result = DuplicateDetector::find($games, $recognizer->recognizeDuplicates(...), $position);
        $result['cursor'] = $result['position'] === null ? null
            : DuplicateGames::issueCursor($result['position'], $snapshot, $secret);
        unset($result['position']);

        // Only the same signed-in session can receive the review and use its
        // short-lived tickets.
        self::ensureSameSession($cookie, $epoch);
        $result['pairs'] = array_map(
            static fn(array $pair): array => self::duplicateReviewPair($pair, $secret),
            $result['pairs']
        );
        return $result;
    }

    private static function duplicateReviewPair(array $pair, string $secret): array
    {
        // Sign the stored values before sanitizing either record for the browser.
        $pair['ticket'] = DuplicateGames::issue($pair['left'], $pair['right'], $secret);
        foreach (['left', 'right'] as $side) {
            $pair[$side]['coverUrl'] = \publicCoverUrl($pair[$side]['coverUrl']);
            unset($pair[$side]['updatedAt']);
        }
        return $pair;
    }

    private static function searchCover(array $request, GameRecognizer $recognizer, string $applicationOrigin): array
    {
        $title = $request['title'] ?? null;
        $platforms = $request['platforms'] ?? null;
        if (!is_string($title) || strlen($title) > 1020 || trim($title) === ''
            || preg_match('/\A[^\x00-\x1f\x7f]{1,255}\z/u', $title) !== 1
            || !is_array($platforms) || !array_is_list($platforms) || count($platforms) < 1 || count($platforms) > 35) {
            throw new ImportException('ai_invalid_cover_search', 422);
        }
        $selected = [];
        foreach ($platforms as $platform) {
            if (!is_string($platform) || !GameRecognizer::supportsPlatform($platform) || isset($selected[$platform])) {
                throw new ImportException('ai_invalid_cover_search', 422);
            }
            $selected[$platform] = true;
        }

        $recognizer->admitManualCoverSearch();
        $candidates = array_map(static fn(string $platform): array => [
            'title' => trim($title), 'platform' => $platform, 'confidence' => 'high',
        ], $platforms);
        $result = self::suggestCovers(['candidates' => $candidates], $recognizer, microtime(true) + 24, $applicationOrigin, singleCover: true);
        // Prefer verified catalogue artwork for any of the selected platforms.
        foreach (['igdb', 'steamgriddb', 'wikipedia'] as $source) {
            foreach ($result['candidates'] as $candidate) {
                if (($candidate['coverSource'] ?? null) === $source) {
                    return array_intersect_key($candidate, array_flip(['coverUrl', 'coverSourceUrl', 'coverSource']));
                }
            }
        }
        $none = ['coverUrl' => ''];
        if (($result['coverSearch'] ?? null) === 'unavailable') $none['coverSearch'] = 'unavailable';
        return $none;
    }

    private static function suggestCovers(
        array $result,
        GameRecognizer $recognizer,
        float $deadline,
        string $applicationOrigin,
        bool $singleCover = false,
    ): array {
        $covers = GameRecognizer::configload(__DIR__ . '/cover-config.local.php');
        $select = static function (array $choices) use ($recognizer, $deadline): array {
            $remaining = (int)floor($deadline - microtime(true));
            if ($remaining < 1) throw new ImportException('ai_provider_timeout', 504);
            return $recognizer->selectCovers($choices, min(10, $remaining));
        };
        return CoverFinder::addSuggestions($result, $select,
            $covers, tokenCache: __DIR__ . '/igdb-token.json', singleCover: $singleCover, deadline: $deadline,
            applicationOrigin: $applicationOrigin);
    }

    private static function ensureSameSession(string $cookie, int $epoch): void
    {
        if (self::openSession($cookie, false) !== $epoch) {
            throw new ImportException('ai_session_expired', 401);
        }
    }

    private static function openSession(string $cookie, bool $writable): int
    {
        if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_only_cookies', '1');
        session_name(\SESSION_COOKIE_NAME);
        session_id($cookie);
        // Explicitly supply the existing cookie ID without permitting PHP to
        // send a replacement cookie. Strict mode still rejects unknown IDs.
        $started = session_start(['use_cookies' => false, 'read_and_close' => !$writable]);
        header_remove('Set-Cookie');
        $now = time();
        $epoch = (int)($_SESSION['authenticated_at'] ?? 0);
        $activity = (int)($_SESSION['last_activity_at'] ?? 0);
        if (!$started || session_id() !== $cookie || (int)($_SESSION['user_id'] ?? 0) !== 1
            || $epoch <= 0 || $activity < $epoch || $activity > $now || $epoch > $now
            || $now - $activity > 1800 || $now - $epoch > 28800) {
            if (session_status() === PHP_SESSION_ACTIVE) session_abort();
            $_SESSION = [];
            throw new ImportException('ai_session_expired', 401);
        }
        if ($writable) $_SESSION['last_activity_at'] = $now;
        return $epoch;
    }
}
