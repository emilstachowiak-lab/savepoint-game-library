<?php
declare(strict_types=1);

namespace Savepoint\AI;

final class DuplicateDetector
{
    private const MAX_PAIRS = 96;
    private const MAX_COMPARISONS = 15000;
    private const MAX_ABBREVIATION_BYTES = 56;
    private const MAX_ABBREVIATION_WORDS = 8;
    private const STOP_WORDS = ['a', 'an', 'and', 'de', 'for', 'in', 'of', 'the', 'to'];
    private const ROMAN_NUMERALS = [
        'i' => '1', 'ii' => '2', 'iii' => '3', 'iv' => '4', 'v' => '5', 'vi' => '6',
        'vii' => '7', 'viii' => '8', 'ix' => '9', 'x' => '10', 'xi' => '11', 'xii' => '12',
        'xiii' => '13', 'xiv' => '14', 'xv' => '15', 'xvi' => '16',
        'xvii' => '17', 'xviii' => '18', 'xix' => '19', 'xx' => '20',
    ];

    public static function find(array $games, callable $check, ?array $position = null): array
    {
        $profiles = [];
        foreach ($games as $game) {
            $profile = self::profile($game);
            if ($profile['compact'] !== '') $profiles[] = $profile;
        }
        usort($profiles, static fn(array $a, array $b): int =>
            strcmp($a['compact'], $b['compact']) ?: strcmp($a['game']['id'], $b['game']['id']));

        [$pairs, $next] = self::candidatePairs($profiles, $position);
        $page = ['pairs' => [], 'limited' => $next !== null, 'position' => $next];
        if ($pairs === []) return $page;

        // Only titles, platforms and temporary pair indexes reach Gemini.
        $options = [];
        $offered = [];
        foreach ($pairs as $index => [$left, $right]) {
            $gamesToCompare = [$profiles[$left]['game'], $profiles[$right]['game']];
            $offered[$index] = $gamesToCompare;
            [$first, $second] = array_map(static fn(array $game): array => [
                'title' => $game['title'], 'platform' => $game['platform'],
            ], $gamesToCompare);
            $options[] = ['index' => $index, 'left' => $first, 'right' => $second];
        }

        $matches = array_fill_keys($check($options), true);
        foreach ($offered as $index => [$left, $right]) {
            if (!isset($matches[$index])) continue;
            $page['pairs'][] = [
                'left' => $left, 'right' => $right,
                'recommendation' => self::sameDetails($left, $right) ? 'delete' : 'merge',
            ];
        }
        return $page;
    }

    private static function titleTokens(string $title): array
    {
        if (class_exists(\Normalizer::class)) {
            $title = \Normalizer::normalize($title, \Normalizer::FORM_D) ?: $title;
        }
        $title = function_exists('mb_strtolower') ? mb_strtolower($title, 'UTF-8') : strtolower($title);
        $title = preg_replace('/(?<=\p{Latin})\p{M}+/u', '', $title) ?? '';
        // Keep Polish titles comparable even on hosts without Intl.
        $title = strtr($title, [
            'ą' => 'a', 'Ą' => 'a', 'ć' => 'c', 'Ć' => 'c', 'ę' => 'e', 'Ę' => 'e',
            'ł' => 'l', 'Ł' => 'l', 'ń' => 'n', 'Ń' => 'n', 'ó' => 'o', 'Ó' => 'o',
            'ś' => 's', 'Ś' => 's', 'ź' => 'z', 'Ź' => 'z', 'ż' => 'z', 'Ż' => 'z',
        ]);
        $tokens = preg_split('/[^\p{L}\p{N}\p{M}]+|(?<=[\p{L}\p{M}])(?=\p{N})|(?<=\p{N})(?=\p{L})/u',
            $title, -1, PREG_SPLIT_NO_EMPTY) ?: [];
        foreach ($tokens as $index => &$token) {
            // Also recognize a release number before its subtitle. Leave the
            // letters I, V and X alone when used inside ordinary phrases.
            if ($index > 0 && ($index === count($tokens) - 1 || strlen($token) > 1)) {
                $token = self::ROMAN_NUMERALS[$token] ?? $token;
            }
        }
        unset($token);
        return array_values(array_filter($tokens, static fn(string $word, int $index): bool =>
            !in_array($word, ['part', 'chapter', 'episode', 'volume'], true) || !ctype_digit($tokens[$index + 1] ?? ''),
            ARRAY_FILTER_USE_BOTH));
    }

    private static function profile(array $game): array
    {
        $tokens = self::titleTokens($game['title']);
        $compact = implode('', $tokens);
        $titleParts = preg_split('/[:：]|\s[-–—]\s/u', $game['title'], 2) ?: [];
        $base = count($titleParts) === 2 ? implode('', self::titleTokens($titleParts[0])) : '';
        if (preg_match('/\p{L}.*\p{L}.*\p{L}.*\p{L}/u', $base) !== 1) $base = '';
        $words = array_values(array_diff($tokens, self::STOP_WORDS));
        $numbers = array_values(array_unique(preg_grep('/\A[0-9]+\z/', $words)));
        sort($numbers, SORT_STRING);
        // A possessive ending is part of the word, not an extra initial.
        $withoutPossessives = preg_replace('/(?<=\p{L})[\x{2019}\x{27}]s\b/iu', '', $game['title']) ?? $game['title'];
        $abbreviationWords = $withoutPossessives === $game['title'] ? $tokens : self::titleTokens($withoutPossessives);
        $shortForms = self::shortForms($abbreviationWords);
        $expansions = self::abbreviations($abbreviationWords);
        // A shorthand can name only the series and number, or only the
        // subtitle. The model still decides whether the pair is the same game.
        $parts = preg_split('/[:：]|\s[-–—]\s/u', $withoutPossessives, 2) ?: [];
        if (count($parts) === 2) {
            $expansions += self::abbreviations(self::titleTokens($parts[0]));
            $expansions += self::abbreviations(self::titleTokens($parts[1]));
        }
        foreach ($abbreviationWords as $index => $word) {
            if ($index < count($abbreviationWords) - 1 && ctype_digit($word)) {
                $expansions += self::abbreviations(array_slice($abbreviationWords, 0, $index + 1));
                break;
            }
        }

        return [
            'game' => $game, 'compact' => $compact, 'base' => $base, 'numbers' => $numbers,
            'words' => array_fill_keys($words, true), 'shortForms' => $shortForms, 'expansions' => $expansions,
        ];
    }

    private static function similarityKeys(array $profile, bool $index): array
    {
        $compact = $profile['compact'];
        $keys = ['title:' . $compact];
        if ($profile['base'] !== '' && $profile['base'] !== $compact) $keys[] = 'title:' . $profile['base'];
        // Edges catch single-word spelling variants. Word buckets catch
        // omitted articles, subtitles and other changes within a title.
        if (strlen($compact) >= 5) {
            $keys[] = 'start:' . substr($compact, 0, 3);
            $keys[] = 'end:' . substr($compact, -3);
        }
        foreach (array_keys($profile['words']) as $word) {
            $word = (string)$word;
            if (strlen($word) >= 3 && !ctype_digit($word)) $keys[] = 'word:' . $word;
        }
        // Separate installments in shared word buckets. An unnumbered title
        // can still be considered against numbered ones with other evidence.
        $numbers = implode(',', $profile['numbers']);
        $numbered = array_map(static fn(string $key): string => 'number:' . $numbers . ':' . $key, $keys);
        if ($index || $numbers === '') {
            $all = array_map(static fn(string $key): string => 'any:' . $key, $keys);
            return $index ? [...$all, ...$numbered] : $all;
        }
        return [...$numbered, ...array_map(static fn(string $key): string => 'number::' . $key, $keys)];
    }

    private static function shortForms(array $words): array
    {
        $literal = implode('', $words);
        if (strlen($literal) > self::MAX_ABBREVIATION_BYTES || preg_match('/\p{L}.*\p{L}/u', $literal) !== 1) return [];

        static $romanSuffixPattern = null;
        $romanSuffixPattern ??= '/\A([a-z]{2,12}?)(' . implode('|', array_keys(self::ROMAN_NUMERALS)) . ')\z/';
        $forms = [$literal => true];
        foreach ($words as $index => $word) {
            // A glued Roman suffix can be part of a short title. Keep the
            // literal form as well because those letters may be initials.
            if (preg_match($romanSuffixPattern, $word, $parts) !== 1 || preg_match('/[^ivx]/', $parts[1]) !== 1) continue;
            $numbered = $words;
            $numbered[$index] = $parts[1] . self::ROMAN_NUMERALS[$parts[2]];
            $forms[implode('', $numbered)] = true;
        }
        return $forms;
    }

    private static function abbreviations(array $words): array
    {
        if (count($words) > self::MAX_ABBREVIATION_WORDS) return [];
        $variants = [$words, array_values(array_diff($words, self::STOP_WORDS))];
        if (in_array($words[0] ?? '', ['a', 'an', 'the'], true)) $variants[] = array_slice($words, 1);

        $forms = [];
        foreach ($variants as $variant) {
            // Initials may include articles and prepositions or omit them.
            // Also recognize a short series name followed by a full subtitle,
            // and the reverse. Keep each release number in its original place.
            $initials = [];
            $wordCount = 0;
            foreach ($variant as $word) {
                if (ctype_digit($word)) {
                    $initials[] = $word;
                } elseif (preg_match('/\A(\p{L}\p{M}*)[\p{L}\p{M}]*\z/u', $word, $letter) === 1) {
                    $initials[] = $letter[1];
                    $wordCount++;
                } else {
                    continue 2;
                }
            }
            if ($wordCount < 2) continue;
            $forms[] = implode('', $initials);
            for ($split = 1; $split < count($variant); $split++) {
                $forms[] = implode('', array_slice($initials, 0, $split)) . implode('', array_slice($variant, $split));
                $forms[] = implode('', array_slice($variant, 0, $split)) . implode('', array_slice($initials, $split));
            }
        }
        $literal = implode('', $words);
        return array_fill_keys(array_filter($forms, static fn(string $form): bool =>
            strlen($form) <= self::MAX_ABBREVIATION_BYTES && $form !== $literal), true);
    }

    private static function numberedShapes(array $forms): array
    {
        $shapes = [];
        foreach ($forms as $form => $_) {
            $shape = preg_replace('/[0-9]+/', '#', (string)$form);
            if ($shape !== (string)$form) $shapes[$shape] = true;
        }
        return $shapes;
    }

    /**
     * Positions resume at the first unprocessed pair in profiles sorted by
     * normalized title and then ID. Phase 0 matches abbreviations before phase 1
     * matches similar titles.
     *
     * @param array{int, int, int}|null $position The phase, left index, and right index.
     * @return array{list<array{int, int}>, array{int, int, int}|null} Pairs and the next position.
     */
    private static function candidatePairs(array $profiles, ?array $position): array
    {
        [$startPhase, $startLeft, $startRight] = $position ?? [0, 0, 0];
        $pairs = [];
        $compared = 0;
        // Short title matches go first so large runs of repeated identical
        // titles cannot push abbreviations out of the first scan.
        for ($phase = $startPhase; $phase < 2; $phase++) {
            $buckets = [];
            foreach ($profiles as $index => $profile) {
                $keys = $phase === 0 ? self::abbreviationKeys($profile, true) : self::similarityKeys($profile, true);
                foreach ($keys as $key) self::addPosting($buckets, $key, $index);
            }
            for ($left = $startLeft; $left < count($profiles); $left++) {
                $profile = $profiles[$left];
                $keys = $phase === 0 ? self::abbreviationKeys($profile, false) : self::similarityKeys($profile, false);
                $neighbors = self::neighbors($buckets, $keys, $phase === 0 ? $startRight : max($left + 1, $startRight));
                foreach ($neighbors as $right => $_) {
                    if ($right === $left) continue;
                    if ($compared++ >= self::MAX_COMPARISONS) return [$pairs, [$phase, $left, $right]];
                    $other = $profiles[$right];
                    if ($phase === 0) {
                        if (!self::abbreviation($profile, $other)
                            || ($right < $left && self::abbreviation($other, $profile))) continue;
                    } elseif (self::abbreviation($profile, $other) || self::abbreviation($other, $profile)
                        || !self::similar($profile, $other)) {
                        continue;
                    }
                    if (count($pairs) === self::MAX_PAIRS) return [$pairs, [$phase, $left, $right]];
                    $pairs[] = [min($left, $right), max($left, $right)];
                }
                $startRight = 0;
            }
            $startLeft = $startRight = 0;
        }
        return [$pairs, null];
    }

    private static function abbreviationKeys(array $profile, bool $index): array
    {
        $keys = $index ? array_map(static fn($form): string => 'expansion:' . $form, array_keys($profile['expansions'])) : [];
        foreach (array_keys($profile['shortForms']) as $form) {
            $alternate = $form !== $profile['compact'];
            if ($index) {
                $keys[] = 'literal:' . $form;
                if ($alternate) $keys[] = 'alternate:' . $form;
            } else {
                $keys[] = 'expansion:' . $form;
                $keys[] = 'alternate:' . $form;
                if ($alternate) $keys[] = 'literal:' . $form;
            }
        }
        return $keys;
    }

    private static function addPosting(array &$buckets, string|int $key, int $index): void
    {
        // A singleton costs only one integer. Larger lists store four bytes
        // per index instead of creating a PHP array for each search key.
        if (!isset($buckets[$key])) {
            $buckets[$key] = $index;
        } elseif (is_int($buckets[$key])) {
            $buckets[$key] = pack('V2', $buckets[$key], $index);
        } else {
            $buckets[$key] .= pack('V', $index);
        }
    }

    private static function neighbors(array $buckets, array $keys, int $minimum): array
    {
        $neighbors = [];
        foreach ($keys as $key) {
            $list = $buckets[$key] ?? null;
            if (is_int($list)) {
                if ($list >= $minimum) $neighbors[$list] = true;
            } elseif (is_string($list)) {
                foreach (unpack('V*', $list) as $right) {
                    if ($right >= $minimum) $neighbors[$right] = true;
                }
            }
        }
        ksort($neighbors, SORT_NUMERIC);
        return $neighbors;
    }

    private static function differentNumbers(array $left, array $right): bool
    {
        return $left['numbers'] !== [] && $right['numbers'] !== [] && $left['numbers'] !== $right['numbers'];
    }

    private static function abbreviation(array $left, array $right): bool
    {
        return $left['compact'] !== $right['compact'] && !self::differentNumbers($left, $right)
            && array_intersect_key($left['shortForms'], $right['shortForms'] + $right['expansions']) !== [];
    }

    private static function similar(array $left, array $right): bool
    {
        $a = $left['compact'];
        $b = $right['compact'];
        if (self::differentNumbers($left, $right)) return false;
        if ($a === $b) return true;
        // Do not let spelling similarity reintroduce different sequels when
        // their abbreviation uses the same letters but different numbers.
        $leftNumbered = self::numberedShapes($left['shortForms']);
        $rightNumbered = self::numberedShapes($right['shortForms']);
        if (array_intersect_key($leftNumbered, $rightNumbered + self::numberedShapes($right['expansions'])) !== []
            || array_intersect_key($rightNumbered, self::numberedShapes($left['expansions'])) !== []) return false;
        if ($a === $right['base'] || $b === $left['base']) return true;

        $shared = count(array_intersect_key($left['words'], $right['words']));
        $combined = count($left['words']) + count($right['words']) - $shared;
        if ($shared >= 2 && (2 * $shared >= $combined
            || $shared === min(count($left['words']), count($right['words'])))) return true;

        // PHP's edit distance is byte-based. Keep it for short ASCII strings;
        // multilingual titles can still match by complete text, edges and words.
        $length = max(strlen($a), strlen($b));
        $tolerance = $length >= 12 ? 2 : 1;
        if ($length >= 5 && $length <= 80 && abs(strlen($a) - strlen($b)) <= $tolerance
            && ctype_alnum($a) && ctype_alnum($b)) {
            $distance = levenshtein($a, $b);
            if ($distance <= $tolerance) return true;
        }
        return false;
    }

    private static function sameDetails(array $left, array $right): bool
    {
        foreach (['title', 'edition', 'status', 'coverUrl'] as $field) {
            if ($left[$field] !== $right[$field]) return false;
        }
        $platforms = static function (string $value): array {
            $parts = array_unique(array_map('trim', explode(',', $value)));
            sort($parts, SORT_STRING);
            return $parts;
        };
        return $platforms($left['platform']) === $platforms($right['platform']);
    }
}
