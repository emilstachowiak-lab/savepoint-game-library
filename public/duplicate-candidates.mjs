const encoder = new TextEncoder();
const roman = new Map('i ii iii iv v vi vii viii ix x xi xii xiii xiv xv xvi xvii xviii xix xx'
  .split(' ').map((value, index) => [value, String(index + 1)]));
const stop = new Set('a an and de for in of the to'.split(' '));
const numbered = word => /^\d+$/.test(word ?? '');
const countBytes = word => encoder.encode(word).length;
const unique = items => [...new Set(items)];
const titleParts = /[:：]|\s[-–—]\s/u;
const suffix = new RegExp('^([a-z]{2,12}?)(' + [...roman.keys()].join('|') + ')$');
const regionalNames = [
  ['resident evil', 'biohazard'],
  ['mega man', 'rockman'],
  ['yakuza', 'ryu ga gotoku'],
  ['fatal frame', 'project zero'],
];

function tokens(title) {
  const words = title.normalize('NFD').toLowerCase()
    .replace(/(?<=\p{Script=Latin})\p{M}+/gu, '').replace(/ł/g, 'l')
    .split(/[^\p{L}\p{N}\p{M}]+|(?<=[\p{L}\p{M}])(?=\p{N})|(?<=\p{N})(?=\p{L})/u).filter(Boolean);
  const normalized = words.map((word, index) => index > 0 && (index === words.length - 1 || word.length > 1)
    ? roman.get(word) ?? word : word);
  return normalized.filter((word, index) =>
    !['part','chapter','episode','volume'].includes(word) || !numbered(normalized[index + 1]));
}

function shortForms(words) {
  const literal = words.join('');
  if (countBytes(literal) > 56 || !/\p{L}.*\p{L}/u.test(literal)) return [];
  const forms = [literal];
  for (const [index, word] of words.entries()) {
    const match = suffix.exec(word);
    if (match && /[^ivx]/.test(match[1])) {
      const form = [...words];
      form[index] = match[1] + roman.get(match[2]);
      forms.push(form.join(''));
    }
  }
  return unique(forms);
}

function abbreviations(words) {
  if (words.length > 8) return [];
  const variants = [words, words.filter(word => !stop.has(word))];
  if (['a','an','the'].includes(words[0])) variants.push(words.slice(1));
  const forms = [];
  for (const variant of variants) {
    const initials = variant.map(word => numbered(word) ? word : /^(\p{L}\p{M}*)[\p{L}\p{M}]*$/u.exec(word)?.[1]);
    if (initials.some(value => !value) || variant.filter(word => !numbered(word)).length < 2) continue;
    forms.push(initials.join(''));
    for (let split = 1; split < variant.length; split++) {
      forms.push(initials.slice(0, split).join('') + variant.slice(split).join(''));
      forms.push(variant.slice(0, split).join('') + initials.slice(split).join(''));
    }
  }
  const literal = words.join('');
  return unique(forms.filter(form => form !== literal && countBytes(form) <= 56));
}

function splitTitle(title) {
  const separator = titleParts.exec(title);
  return separator ? [title.slice(0, separator.index), title.slice(separator.index + separator[0].length)] : [title];
}

function profile(game) {
  const parts = splitTitle(game.title);
  const words = tokens(game.title);
  const compact = words.join('');
  const titleBase = parts.length === 2 ? tokens(parts[0]).join('') : '';
  const base = /\p{L}.*\p{L}.*\p{L}.*\p{L}/u.test(titleBase) ? titleBase : '';
  const relevant = new Set(words.filter(word => !stop.has(word)));
  const numbers = [...relevant].filter(numbered).sort().join(',');
  const withoutPossessives = game.title.replace(/(?<=\p{L})[’']s\b/giu, '');
  const abbrevWords = tokens(withoutPossessives);
  const expansions = abbreviations(abbrevWords);
  const segments = splitTitle(withoutPossessives);
  if (segments.length === 2) {
    for (const segment of segments) expansions.push(...abbreviations(tokens(segment)));
  }
  const number = abbrevWords.slice(0, -1).findIndex(numbered);
  if (number >= 0) expansions.push(...abbreviations(abbrevWords.slice(0, number + 1)));
  const short = shortForms(abbrevWords);
  const expansion = new Set(expansions);
  const shapes = list => new Set([...list].filter(value => /\d/.test(value)).map(value => value.replace(/\d+/g, '#')));
  return { game, compact, base, words: relevant, numbers, short, expansion, regional: regionalKey(words),
    spelling: spellingKeys(compact),
    shortShapes: shapes(short), expansionShapes: shapes(expansion) };
}

function regionalKey(words) {
  const title = words.join(' ');
  for (const [canonical, regional] of regionalNames) {
    if (title === canonical || title.startsWith(canonical + ' ')) return title;
    if (title === regional || title.startsWith(regional + ' ')) return canonical + title.slice(regional.length);
  }
  return '';
}

function spellingKeys(compact) {
  if (compact.length < 4 || compact.length > 80 || !/^[a-z\d]+$/.test(compact)) return [];
  // Deletions in a short prefix put neighboring spellings in the same index
  // even when a typo changes both of the old prefix/suffix keys.
  const prefix = compact.slice(0, 7);
  const keys = new Set([prefix]);
  for (let first = 0; first < prefix.length; first++) {
    keys.add(prefix.slice(0, first) + prefix.slice(first + 1));
    if (compact.length < 10) continue;
    for (let second = first + 1; second < prefix.length; second++) {
      keys.add(prefix.slice(0, first) + prefix.slice(first + 1, second) + prefix.slice(second + 1));
    }
  }
  return [...keys];
}

function keys(item, index, phase) {
  if (phase === 0) {
    const list = index ? [...item.expansion].map(form => 'expansion:' + form) : [];
    for (const form of item.short) {
      const alternate = form !== item.compact;
      if (index) {
        list.push('literal:' + form);
        if (alternate) list.push('alternate:' + form);
      } else {
        list.push('expansion:' + form, 'alternate:' + form);
        if (alternate) list.push('literal:' + form);
      }
    }
    return list;
  }
  const base = ['title:' + item.compact];
  if (item.base && item.base !== item.compact) base.push('title:' + item.base);
  if (countBytes(item.compact) >= 5) base.push('start:' + item.compact.slice(0, 3), 'end:' + item.compact.slice(-3));
  if (item.regional) base.push('regional:' + item.regional);
  for (const key of item.spelling) base.push('spelling:' + key);
  for (const word of item.words) {
    if (!numbered(word) && countBytes(word) >= 3) base.push('word:' + word);
  }
  const any = base.map(value => 'any:' + value);
  const exact = base.map(value => 'number:' + item.numbers + ':' + value);
  if (index) return [...any, ...exact];
  return item.numbers ? [...exact, ...base.map(value => 'number::' + value)] : any;
}

const changedNumber = (a, b) => a.numbers && b.numbers && a.numbers !== b.numbers;
const abbreviates = (a, b) => a.compact !== b.compact && !changedNumber(a, b)
  && a.short.some(form => b.short.includes(form) || b.expansion.has(form));

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + Number(a[i - 1] !== b[j - 1]));
      previous = old;
    }
  }
  return row[b.length];
}

function similar(a, b) {
  if (changedNumber(a, b)) return false;
  if (a.compact === b.compact) return true;
  if (a.regional && a.regional === b.regional) return true;
  if ([...a.shortShapes].some(shape => b.shortShapes.has(shape) || b.expansionShapes.has(shape))
    || [...b.shortShapes].some(shape => a.expansionShapes.has(shape))) return false;
  if (a.base === b.compact || a.compact === b.base) return true;
  const shared = [...a.words].filter(word => b.words.has(word)).length;
  if (shared >= 2 && (2 * shared >= a.words.size + b.words.size - shared
    || shared === Math.min(a.words.size, b.words.size))) return true;
  const length = Math.max(a.compact.length, b.compact.length);
  const tolerance = length >= 12 ? 2 : 1;
  return length >= 5 && length <= 80 && Math.abs(a.compact.length - b.compact.length) <= tolerance
    && /^[a-z\d]+$/.test(a.compact) && /^[a-z\d]+$/.test(b.compact)
    && editDistance(a.compact, b.compact) <= tolerance;
}

const compare = (a, b) => a === b ? 0 : a < b ? -1 : 1;

export function createCandidateScan(games, maxPairs = 32) {
  const profiles = games.map(profile).filter(item => item.compact)
    .sort((a, b) => compare(a.compact, b.compact) || compare(a.game.id, b.game.id));
  let indexPhase = -1;
  let currentIndex;
  function indexFor(phase) {
    if (indexPhase === phase) return currentIndex;
    const index = new Map();
    for (const [i, item] of profiles.entries()) {
      for (const key of keys(item, true, phase)) {
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(i);
      }
    }
    indexPhase = phase;
    currentIndex = index;
    return index;
  }

  return function read(position) {
    const pairs = [];
    let compared = 0;
    let [phase, startLeft, startRight] = position ?? [0, 0, 0];
    for (; phase < 2; phase++) {
      const index = indexFor(phase);
      for (let left = startLeft; left < profiles.length; left++, startRight = 0) {
        const first = profiles[left];
        const minimum = phase === 0 ? startRight : Math.max(left + 1, startRight);
        const adjacent = new Set();
        for (const key of keys(first, false, phase)) {
          for (const candidate of index.get(key) ?? []) {
            if (candidate >= minimum && candidate !== left) adjacent.add(candidate);
          }
        }
        for (const right of [...adjacent].sort((a, b) => a - b)) {
          if (compared++ >= 15000) return { pairs, next: [phase, left, right] };
          const second = profiles[right];
          if (phase === 0) {
            if (!abbreviates(first, second) || right < left && abbreviates(second, first)) continue;
          } else if (abbreviates(first, second) || abbreviates(second, first) || !similar(first, second)) continue;
          if (pairs.length === maxPairs) return { pairs, next: [phase, left, right] };
          pairs.push(right < left ? [second.game, first.game] : [first.game, second.game]);
        }
      }
      startLeft = startRight = 0;
    }
    return { pairs, next: null };
  };
}

export function nextCandidatePage(scan, position) {
  let page = scan(position);
  while (!page.pairs.length && page.next) page = scan(page.next);
  return { pairs: page.pairs.map(pair => pair.map(game => [game.id, game.revision])), next: page.next };
}

if (typeof WorkerGlobalScope === 'function' && globalThis instanceof WorkerGlobalScope) {
  let scan;
  globalThis.onmessage = ({ data }) => {
    if (data.games) {
      scan = createCandidateScan(data.games);
      return;
    }
    globalThis.postMessage(nextCandidatePage(scan, data.position));
  };
}
