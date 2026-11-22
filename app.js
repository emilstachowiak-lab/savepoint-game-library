// Wire the page controls to the session, collection transfer and Aero scripts.
// The browser's legacy collection is available for migration or recovery.
const $ = id => document.getElementById(id);
const LEGACY_KEY = 'savepoint-library-v1';
let games = [];
let toastTimer;
let aiImportController = null;
let duplicatesController = null;

const xmbBackground = initializeXmbBackground();

// Validate the URL scheme before loading a cover. Escape values separately
// when inserting them into an HTML template, including attribute values.
const safeImageUrl = value => {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
};
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

const LANGUAGE_KEY = 'savepoint-language-v1';
let uiLanguage = 'pl';
try {
  if (localStorage.getItem(LANGUAGE_KEY) === 'en') uiLanguage = 'en';
} catch {}
const uiBindings = new Map();

function uiText(polish, english) {
  return uiLanguage === 'en' ? english ?? polish : polish;
}

function applyUiText(node, field, value) {
  if (field === 'textContent' || field === 'innerHTML' || field === 'alt') {
    if (node[field] !== value) node[field] = value;
  } else if (node.getAttribute(field) !== value) {
    if (value === null) node.removeAttribute(field);
    else node.setAttribute(field, value);
  }
}

// Keep both versions of text on persistent controls so changes to the language
// can update an existing view without replaying the action that produced it.
function bindUiText(node, field, polish, english) {
  if (!node) return;
  let fields = uiBindings.get(node);
  if (!fields) {
    fields = new Map();
    uiBindings.set(node, fields);
  }
  fields.set(field, [polish, english]);
  applyUiText(node, field, uiText(polish, english));
}

function setUiText(node, polish, english) {
  bindUiText(node, 'textContent', polish, english);
}

function uiError(polish, english) {
  const error = new Error(polish);
  error.englishMessage = english;
  return error;
}

// The API sends the other language alongside its primary error. Errors created
// in the browser instead carry an optional English message on the Error object.
function uiErrorText(error) {
  const polish = error?.payload?.errorDefault || error?.message || '';
  const english = error?.payload?.errorEnglish
    || (error?.payload?.errorDefault ? error.message : error?.englishMessage)
    || polish;
  return [polish, english];
}

// Translate labels within their own field. A custom platform can share a name
// with a status or edition. The saved values and form selections stay unchanged.
const englishGameLabels = {
  status: new Map([
    ['Do ogrania', 'To play'],
    ['W trakcie', 'In progress'],
    ['Ograna', 'Completed']
  ]),
  edition: new Map([
    ['Fizyczne', 'Physical'],
    ['Cyfrowe', 'Digital'],
    ['Fizyczne i cyfrowe', 'Physical and digital']
  ]),
  platform: new Map([['Inna', 'Other']])
};
function gameLabel(field, value) {
  return uiText(value, englishGameLabels[field].get(value));
}

// Read records from versions that saved the collection in browser storage.
function readLegacyArchive() {
  try { return localStorage.getItem(LEGACY_KEY); } catch { return null; }
}
function showLegacyArchiveControls(visible) {
  for (const id of ['downloadLegacyBtn', 'removeLegacyBtn']) {
    const button = $(id);
    if (button) button.hidden = !visible;
  }
}
function readLegacyGames() {
  try {
    const stored = JSON.parse(readLegacyArchive() || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch { return []; }
}
// These indicators report connection state and transient collection actions.
function setConnectionStatus(text, failed = false, english = text) {
  const status = $('connectionStatus');
  bindUiText(status, 'innerHTML', `<i class="dot"></i> ${esc(text)}`, `<i class="dot"></i> ${esc(english)}`);
  status.style.borderColor = failed ? '#bd665a' : '';
  status.style.color = failed ? '#9b342a' : '';
}
function notify(message, english) {
  setUiText($('toast'), message, english);
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2600);
}
// Give the batched readiness lookup a short head start. Missing copies fall
// back to lazy original images without waiting for the backup worker.
const COVER_LOAD_TIMEOUT = 10000;
const COVER_STATUS_GRACE = 2500;
let coverBackupCollection = null;
let coverBackupQueue = [];
let coverBackupTimer = null;
let coverBackupWorker = null;
const coverBackupAttempted = new Set();
const coverBackupBusyRetries = new Map();
const coverBackupStatusChecked = new Set();
const coverBackupReady = new Set();
let coverBackupStatusAvailable = true;
let coverStatusRetryAt = 0;
let coverSourceTimer = null;
let coverSavedById = new Map();
const coverImageStates = new Map();
let coverVisibilityObserver = null;
function localCoverUrl(id) {
  return /^[a-zA-Z0-9-]{1,36}$/.test(String(id)) ? API_URL + '?cover=' + encodeURIComponent(id) : '';
}
function clearCoverImageTracking() {
  clearTimeout(coverSourceTimer);
  coverSourceTimer = null;
  coverVisibilityObserver?.disconnect();
  coverVisibilityObserver = null;
  for (const state of coverImageStates.values()) { clearTimeout(state.timer); clearCoverProbe(state); }
  coverImageStates.clear();
}
function clearCoverBackups() {
  clearTimeout(coverBackupTimer);
  coverBackupTimer = null;
  coverBackupCollection = null;
  coverBackupQueue = [];
  coverBackupAttempted.clear();
  coverBackupBusyRetries.clear();
  coverBackupStatusChecked.clear();
  coverBackupReady.clear();
  coverBackupStatusAvailable = true;
  coverStatusRetryAt = 0;
  coverSavedById.clear();
  clearCoverImageTracking();
}
// A detached card or changed record cannot receive an old image callback.
function currentCoverImage(image) {
  const state = coverImageStates.get(image);
  if (!state || state.generation !== sessionGeneration || !authenticated || logoutPending
      || !$('grid').contains(image)) return null;
  const saved = coverSavedById.get(state.id);
  const matchesSavedCover = saved && String(saved.game.coverUrl) === state.key && saved.coverUrl === state.url;
  return matchesSavedCover ? state : null;
}
function clearCoverProbe(state) {
  if (!state.probe) return;
  state.probe.onload = null;
  state.probe.onerror = null;
  state.probe.removeAttribute('src');
  state.probe = null;
}
// Test a backup off-screen so a missing backup cannot interrupt a slow original.
function probeLocalCover(image) {
  const state = currentCoverImage(image);
  if (!state || state.local || state.probe || (image.complete && image.naturalWidth)) return;
  const probe = new Image();
  state.probe = probe;
  probe.referrerPolicy = 'no-referrer';
  probe.onload = () => {
    if (currentCoverImage(image) !== state || state.probe !== probe) return;
    const originalLoaded = image.complete && image.naturalWidth;
    clearCoverProbe(state);
    if (!originalLoaded) useLocalCover(image);
  };
  probe.onerror = () => { if (state.probe === probe) clearCoverProbe(state); };
  probe.src = localCoverUrl(state.id);
}
function useLocalCover(image) {
  const state = currentCoverImage(image);
  if (!state) return;
  clearTimeout(state.timer);
  state.timer = null;
  clearCoverProbe(state);
  if (state.local) return;
  state.local = true;
  image.src = localCoverUrl(state.id);
}
function useOriginalCover(image, state) {
  state.directTried = true;
  state.local = false;
  image.src = state.url;
}
function startCoverIfReady(image, state, allowOriginal = false) {
  if (image.hasAttribute('src')) return;
  if (coverBackupReady.has(state.key)) useLocalCover(image);
  else if (allowOriginal || coverBackupStatusChecked.has(state.key) || !coverBackupStatusAvailable) {
    useOriginalCover(image, state);
  }
}
function trackCoverImages() {
  const images = new Set($('grid').querySelectorAll('img.cover-image[data-cover-id]'));
  for (const [image, state] of coverImageStates) {
    if (images.has(image)) continue;
    coverVisibilityObserver?.unobserve(image);
    clearTimeout(state.timer);
    clearCoverProbe(state);
    coverImageStates.delete(image);
  }
  // A lazy image has no reliable loadstart event. Time a stalled direct
  // source only after it has become visible.
  if (!coverVisibilityObserver && typeof IntersectionObserver === 'function') {
    coverVisibilityObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        coverVisibilityObserver?.unobserve(entry.target);
        const state = currentCoverImage(entry.target);
        if (!state) continue;
        state.visible = true;
        scheduleCoverProbe(entry.target, state);
      }
    });
  }
  for (const image of images) {
    if (coverImageStates.has(image)) continue;
    const id = image.dataset.coverId;
    const saved = coverSavedById.get(id);
    if (!saved || !localCoverUrl(id)) continue;
    const src = image.getAttribute('src');
    const local = src === localCoverUrl(id) || src === localCoverUrl(id) + '&ready=1';
    const state = {
      id,
      key: String(saved.game.coverUrl),
      url: saved.coverUrl,
      generation: sessionGeneration,
      local,
      directTried: Boolean(src && !local),
      retried: local && src.endsWith('&ready=1'),
      timer: null
    };
    coverImageStates.set(image, state);
    coverVisibilityObserver?.observe(image);
    startCoverIfReady(image, state);
  }
  if (!coverSourceTimer && [...coverImageStates.keys()].some(image => !image.hasAttribute('src'))) {
    coverSourceTimer = setTimeout(() => {
      coverSourceTimer = null;
      for (const [image, state] of coverImageStates) {
        if (!currentCoverImage(image)) continue;
        startCoverIfReady(image, state, true);
        scheduleCoverProbe(image, state);
      }
    }, COVER_STATUS_GRACE);
  }
}
function scheduleCoverProbe(image, state) {
  if (state.visible && state.directTried && !state.local && !state.timer && !image.complete) {
    state.timer = setTimeout(() => probeLocalCover(image), COVER_LOAD_TIMEOUT);
  }
}
function releaseCoverSources() {
  for (const [image, state] of coverImageStates) {
    if (currentCoverImage(image)) {
      startCoverIfReady(image, state);
      scheduleCoverProbe(image, state);
    }
  }
}
function markCoverBackupReady(key) {
  coverBackupReady.add(key);
  for (const [image, state] of coverImageStates) {
    // The first fallback can have raced the initial backup. Retry once when
    // the server confirms the file exists; repeated image errors never loop.
    if (state.key !== key || state.retried || !currentCoverImage(image)) continue;
    if (!image.hasAttribute('src')) { useLocalCover(image); continue; }
    if (image.complete && image.naturalWidth) continue;
    if (!state.local) { useLocalCover(image); continue; }
    state.retried = true;
    image.src = localCoverUrl(state.id) + '&ready=1';
  }
}
function currentCoverBackupCandidate(candidate) {
  const entry = coverSavedById.get(candidate.id);
  return entry && String(entry.game.coverUrl) === candidate.key && entry.coverUrl === candidate.url;
}
// Run one backup request at a time. Query existing copies in batches first,
// then request individual backups only for URLs that still need one.
function scheduleCoverBackupWorker(delay = 750) {
  if (coverBackupTimer || coverBackupWorker || !coverBackupQueue.length || !authenticated || logoutPending || privacySuspended) return;
  const generation = sessionGeneration;
  coverBackupTimer = setTimeout(async () => {
    coverBackupTimer = null;
    if (generation !== sessionGeneration || !authenticated || logoutPending || coverBackupWorker || privacySuspended) return;
    let item;
    while (coverBackupQueue.length && !item) {
      const candidate = coverBackupQueue.shift();
      if (!coverBackupAttempted.has(candidate.key) && currentCoverBackupCandidate(candidate)) item = candidate;
    }
    if (!item) return;
    const worker = {generation};
    coverBackupWorker = worker;
    let nextDelay = 750;
    const checkingStatus = coverBackupStatusAvailable && Date.now() >= coverStatusRetryAt && !coverBackupStatusChecked.has(item.key);
    try {
      if (checkingStatus) {
        // One metadata request avoids a separate PHP request and database
        // lookup for every cover whose private backup already exists.
        const batch = [item];
        const ids = new Set([item.id]);
        for (const candidate of coverBackupQueue) {
          if (batch.length === 32) break;
          if (ids.has(candidate.id) || coverBackupAttempted.has(candidate.key)
              || coverBackupStatusChecked.has(candidate.key) || !currentCoverBackupCandidate(candidate)) continue;
          ids.add(candidate.id);
          batch.push(candidate);
        }
        const result = await apiRequest('POST', {action: 'backup-cover-status', ids: batch.map(candidate => candidate.id)}, generation);
        ensureCurrentSession(generation);
        if (!Array.isArray(result.backups) || result.backups.length > 32) throw new Error('Invalid cover backup status response');
        const statuses = new Map();
        for (const status of result.backups) {
          if (!status || typeof status.id !== 'string') continue;
          statuses.set(status.id, statuses.has(status.id) ? null : status);
        }
        for (const candidate of batch) {
          if (!currentCoverBackupCandidate(candidate)) continue;
          coverBackupStatusChecked.add(candidate.key);
          const status = statuses.get(candidate.id);
          if (status?.ready !== true || status.coverUrl !== candidate.key) continue;
          coverBackupAttempted.add(candidate.key);
          markCoverBackupReady(candidate.key);
        }
        releaseCoverSources();
        const requeueItem = !coverBackupAttempted.has(item.key) && currentCoverBackupCandidate(item);
        coverBackupQueue = coverBackupQueue.filter(candidate =>
          !coverBackupAttempted.has(candidate.key) && (!requeueItem || candidate.key !== item.key));
        if (requeueItem) coverBackupQueue.unshift(item);
      } else {
        coverBackupAttempted.add(item.key);
        const result = await apiRequest('POST', {action: 'backup-cover', id: item.id}, generation);
        ensureCurrentSession(generation);
        if (['saved', 'cached'].includes(result.backup?.status)) markCoverBackupReady(item.key);
        else if (result.backup?.status === 'busy') {
          const retries = coverBackupBusyRetries.get(item.key) || 0;
          if (retries < 3) {
            coverBackupBusyRetries.set(item.key, retries + 1);
            coverBackupAttempted.delete(item.key);
            coverBackupQueue.push(item);
            nextDelay = 1500 * 2 ** retries;
          }
        }
      }
    } catch (error) {
      // A backup failure must not block a game save, import or usable original.
      // The server applies a retry cooldown; the next session can try again.
      if (checkingStatus && !ignoredSessionError(error) && generation === sessionGeneration && !logoutPending) {
        if ([400, 404, 405, 501].includes(error.status)) coverBackupStatusAvailable = false;
        else coverStatusRetryAt = Date.now() + 15000;
        releaseCoverSources();
        if (currentCoverBackupCandidate(item)) {
          coverBackupQueue = coverBackupQueue.filter(candidate => candidate.key !== item.key);
          coverBackupQueue.unshift(item);
        }
      }
    } finally {
      if (coverBackupWorker === worker) coverBackupWorker = null;
      scheduleCoverBackupWorker(nextDelay);
    }
  }, delay);
}
// Rebuild the work list on collection replacement. Deduplicate by the raw
// stored URL because the server uses that string as its backup key.
function scheduleCoverBackups(collection = getCollectionMetadata()) {
  if (!authenticated || logoutPending || coverBackupCollection === games) return;
  coverBackupCollection = games;
  coverSavedById = new Map(collection.entries.map(entry => [String(entry.game.id), entry]));
  const seen = new Set();
  coverBackupQueue = [];
  for (const {game, coverUrl: url} of collection.entries) {
    const id = String(game.id);
    const key = String(game.coverUrl);
    if (!url || !localCoverUrl(id) || seen.has(key) || coverBackupAttempted.has(key)) continue;
    seen.add(key);
    coverBackupQueue.push({id, url, key});
  }
  scheduleCoverBackupWorker();
}
// Accept both arrays and legacy comma-separated platform strings.
function gamePlatforms(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(values.map(platform => String(platform).trim()).filter(Boolean))];
}
let collectionMetadataCache = null;
let renderedCollectionMetadata = null;
let renderedEmptyState = '';
let titleCollator;
function compareGameTitles(a, b) {
  if (titleCollator === undefined) {
    try { titleCollator = new Intl.Collator('pl'); }
    catch { titleCollator = false; }
  }
  return titleCollator && typeof a.game.title === 'string'
    ? titleCollator.compare(a.game.title, b.game.title)
    : a.game.title.localeCompare(b.game.title, 'pl');
}
// Cache search text, filters, sort orders and rendered cards by collection
// identity and language. A language change invalidates the translated markup.
function getCollectionMetadata() {
  if (collectionMetadataCache?.games === games && collectionMetadataCache.language === uiLanguage) {
    return collectionMetadataCache;
  }
  const previousEntries = collectionMetadataCache?.language === uiLanguage
    ? new Map(collectionMetadataCache.entries.map(entry => [entry.game, entry])) : new Map();
  const entries = games.map(game => previousEntries.get(game) ?? ({
    game,
    platforms: gamePlatforms(game.platform),
    searchText: `${game.title} ${game.platform}`.toLocaleLowerCase('pl'),
    coverUrl: game.coverUrl ? safeImageUrl(game.coverUrl) : '',
    card: null
  }));
  const titles = [...new Set(games.map(game => game.title).filter(Boolean))];
  const platforms = [...new Set(entries.flatMap(entry => entry.platforms))]
    .sort((a, b) => a.localeCompare(b, 'pl'));
  collectionMetadataCache = {
    games, entries, platforms, language: uiLanguage,
    sortedEntries: new Map(),
    titleOptions: titles.map(title => `<option value="${esc(title)}"></option>`).join(''),
    platformOptions: `<option value="">${uiText('Wszystkie konsole', 'All platforms')}</option>` + platforms
      .map(platform => `<option value="${esc(platform)}">${esc(gameLabel('platform', platform))}</option>`).join(''),
    doneCount: games.filter(game => game.status === 'Ograna').length
  };
  return collectionMetadataCache;
}
// The checkboxes hold the actual form values. Tabs and chips are views over
// the same inputs, so switching groups preserves every selected platform.
function platformCheckboxes() {
  return [...$('platform').querySelectorAll('input[name="platform"]')];
}
function getSelectedPlatforms() {
  return platformCheckboxes().filter(input => input.checked).map(input => input.value);
}
function validatePlatformSelection() {
  const inputs = platformCheckboxes();
  const valid = inputs.some(input => input.checked);
  inputs[0].setCustomValidity(valid ? '' : uiText('Zaznacz przynajmniej jedną konsolę.', 'Select at least one platform.'));
  return valid;
}
// Preserve platforms from imported records even if the form has no preset
// checkbox for them. Clear the previous game's extra options first.
function setPlatformSelection(value) {
  $('platform').querySelector('[data-extra-platforms]')?.remove();
  const selected = new Set(gamePlatforms(value));
  const known = new Set(platformCheckboxes().map(input => input.value));
  const extra = [...selected].filter(platform => !known.has(platform));
  if (extra.length) {
    const group = document.createElement('fieldset');
    group.className = 'platform-group';
    group.dataset.extraPlatforms = 'true';
    const legend = document.createElement('legend');
    group.dataset.platformGroup = 'Inne zapisane konsole';
    legend.textContent = uiText('Inne zapisane konsole', 'Other saved platforms');
    const choices = document.createElement('div');
    choices.className = 'platform-choice-grid';
    extra.forEach(platform => {
      const label = document.createElement('label');
      label.className = 'platform-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'platform';
      input.value = platform;
      const name = document.createElement('span');
      name.textContent = platform;
      label.append(input, name);
      choices.append(label);
    });
    group.append(legend, choices);
    $('platformOptions').append(group);
  }
  platformCheckboxes().forEach(input => { input.checked = selected.has(input.value); });
  validatePlatformSelection();
  const groups = getPlatformGroups();
  rebuildPlatformTabs(groups.find(group => group.inputs.some(input => input.checked))?.name || groups[0]?.name);
  updatePlatformSelectionSummary();
}
// Older HTML can use the original form without the tabs and preview.
const gameFormPresentationAvailable = Boolean($('coverPreview') && $('platformTabs'));
let activePlatformGroup = '';
function getPlatformGroups() {
  return [...$('platformOptions').querySelectorAll('.platform-group')].map(element => {
    const label = element.querySelector('legend').textContent.trim();
    return {
      element,
      name: element.dataset.platformGroup || label,
      label,
      inputs: [...element.querySelectorAll('input[name="platform"]')]
    };
  });
}
// Keep the visible group and ARIA selection in sync. Only the active tab is
// in the normal Tab order, with arrow keys available to move between groups.
function activatePlatformGroup(groupName, { focus = false } = {}) {
  if (!gameFormPresentationAvailable) return;
  const groups = getPlatformGroups();
  const active = groups.find(group => group.name === groupName) || groups[0];
  if (!active) return;
  activePlatformGroup = active.name;
  groups.forEach(group => { group.element.hidden = group !== active; });
  $('platformTabs').querySelectorAll('[role="tab"]').forEach(tab => {
    const selected = tab.dataset.platformGroup === active.name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  });
}
function rebuildPlatformTabs(preferredGroup = activePlatformGroup) {
  if (!gameFormPresentationAvailable) return;
  const groups = getPlatformGroups();
  $('platformTabs').replaceChildren();
  groups.forEach((group, index) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'platform-tab';
    tab.id = 'platform-tab-' + index;
    tab.dataset.platformGroup = group.name;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'platform-panel-' + index);
    const name = document.createElement('span');
    name.textContent = group.label;
    const count = document.createElement('span');
    count.className = 'platform-tab-count';
    tab.append(name, count);
    $('platformTabs').append(tab);
    group.element.id = 'platform-panel-' + index;
    group.element.setAttribute('role', 'tabpanel');
    group.element.setAttribute('aria-labelledby', tab.id);
  });
  $('platformTabs').hidden = groups.length === 0;
  $('platformOptions').classList.add('platform-tabs-ready');
  activatePlatformGroup(preferredGroup);
}
function updatePlatformSelectionSummary() {
  if (!gameFormPresentationAvailable) return;
  const groups = getPlatformGroups();
  const selected = getSelectedPlatforms();
  $('platformSelectionCount').textContent = uiText('Wybrano ' + selected.length, selected.length + ' selected');
  $('platformTabs').querySelectorAll('[role="tab"]').forEach(tab => {
    const group = groups.find(group => group.name === tab.dataset.platformGroup);
    const count = group?.inputs.filter(input => input.checked).length || 0;
    const badge = tab.querySelector('.platform-tab-count');
    badge.textContent = count ? String(count) : '';
    badge.hidden = count === 0;
  });
  $('selectedPlatforms').replaceChildren();
  const label = document.createElement('span');
  label.className = 'selected-platforms-label';
  label.textContent = uiText('Wybrane:', 'Selected:');
  $('selectedPlatforms').append(label);
  if (!selected.length) {
    const empty = document.createElement('span');
    empty.className = 'selected-platforms-empty';
    empty.textContent = uiText('Zaznacz przynajmniej jedną konsolę', 'Select at least one platform');
    $('selectedPlatforms').append(empty);
    return;
  }
  selected.forEach(platform => {
    const chip = document.createElement('span');
    chip.className = 'selected-platform-chip';
    chip.innerHTML = aeroIcon('check');
    const name = document.createElement('span');
    name.textContent = gameLabel('platform', platform);
    chip.append(name);
    $('selectedPlatforms').append(chip);
  });
}
// Preview state belongs to the current draft. Closing or reopening the form
// cancels timers, detaches image callbacks, and invalidates late results.
let coverPreviewGeneration = 0;
let coverPreviewTimer = null;
let coverPreviewLoader = null;
let coverPreviewWatchdog = null;
let coverPreviewBackupProbe = null;
function clearCoverPreviewProbe() {
  if (!coverPreviewBackupProbe) return;
  coverPreviewBackupProbe.onload = null;
  coverPreviewBackupProbe.onerror = null;
  coverPreviewBackupProbe.removeAttribute('src');
  coverPreviewBackupProbe = null;
}
function clearCoverPreview() {
  if (!gameFormPresentationAvailable) return;
  coverPreviewGeneration++;
  clearTimeout(coverPreviewTimer);
  coverPreviewTimer = null;
  clearTimeout(coverPreviewWatchdog);
  coverPreviewWatchdog = null;
  clearCoverPreviewProbe();
  if (coverPreviewLoader) {
    coverPreviewLoader.onload = null;
    coverPreviewLoader.onerror = null;
    coverPreviewLoader.removeAttribute('src');
    coverPreviewLoader = null;
  }
  const image = $('coverPreview');
  image.onload = null;
  image.onerror = null;
  image.removeAttribute('src');
  image.hidden = true;
  bindUiText(image, 'alt', '');
  $('coverPreviewPlaceholder').hidden = false;
  setUiText($('coverPreviewTitle'), 'Twoja okładka', 'Your cover');
  setUiText($('coverPreviewStatus'), 'Podgląd okładki', 'Cover preview');
}
function updateCoverSearchLinks() {
  const query = $('title').value.trim();
  const coverSearch = $('coverSearch');
  if (coverSearch) {
    coverSearch.href = 'https://www.thecoverproject.net/view.php?searchstring=' + encodeURIComponent(query);
    if (coverSearch.style) coverSearch.style.opacity = query ? '1' : '.65';
  }
  const googleSearch = $('googleCoverSearch');
  if (googleSearch) {
    googleSearch.href = 'https://www.google.com/search?udm=2&q=' + encodeURIComponent(query ? query + ' game cover' : 'video game cover');
  }
}

let aiCoverSearchRequest = null;
function clearAiCoverSearch() {
  const request = aiCoverSearchRequest;
  aiCoverSearchRequest = null;
  request?.controller?.abort();
  const button = $('aiCoverSearch');
  if (button) button.disabled = false;
  setUiText($('aiCoverSearchStatus'), '');
}
function setAiCoverSearchVisible(visible) {
  clearAiCoverSearch();
  const controls = $('aiCoverSearchControls');
  if (controls) controls.hidden = !visible;
}
async function searchGameCover() {
  const button = $('aiCoverSearch');
  const status = $('aiCoverSearchStatus');
  const backdrop = $('modalBackdrop');
  if (!button || button.disabled || !backdrop.classList.contains('open') || !privateViewUsable()) return;

  const draftId = $('gameId').value;
  const titleInput = $('title');
  const coverInput = $('coverUrl');
  const titleValue = titleInput.value;
  const title = titleValue.trim();
  const selectedPlatforms = getSelectedPlatforms();
  const coverValue = coverInput.value;
  if (!title) {
    setUiText(status, 'Wpisz tytuł gry, aby wyszukać okładkę.', 'Enter a game title to search for a cover.');
    titleInput.focus();
    return;
  }
  if (!selectedPlatforms.length) {
    setUiText(status, 'Wybierz przynajmniej jedną konsolę.', 'Select at least one platform.');
    getPlatformGroups().find(group => !group.element.hidden)?.inputs[0]?.focus();
    return;
  }
  // Imported platform labels remain on the game. The cover endpoint accepts
  // only preset platforms that its providers can use for matching.
  const platforms = platformCheckboxes().filter(input =>
    input.checked && input.value !== 'Inna' && !input.closest('[data-extra-platforms]')
  ).map(input => input.value);
  if (!platforms.length) {
    setUiText(status, 'Wybierz platformę obsługiwaną przez wyszukiwanie okładek.',
      'Select a platform supported by cover search.');
    return;
  }

  const generation = sessionGeneration;
  const request = { controller: typeof AbortController === 'function' ? new AbortController() : null };
  aiCoverSearchRequest = request;
  button.disabled = true;
  setUiText(status, 'Szukam okładki…', 'Searching for a cover…');
  const discardStaleReply = () => {
    if (aiCoverSearchRequest !== request) return true;
    if (generation === sessionGeneration && authenticated && !logoutPending && !privacySuspended
        && backdrop.classList.contains('open') && $('gameId').value === draftId
        && titleInput.value === titleValue && coverInput.value === coverValue
        && getSelectedPlatforms().join('\n') === selectedPlatforms.join('\n')) return false;
    clearAiCoverSearch();
    return true;
  };
  try {
    const result = await apiRequest('POST', { action: 'ai-cover-search', title, platforms }, generation,
      { abortableAiRequest: true, signal: request.controller?.signal });
    if (discardStaleReply()) return;
    const coverUrl = typeof result.coverUrl === 'string' ? result.coverUrl.trim() : '';
    if (!coverUrl) {
      if (result.coverSearch === 'unavailable') {
        setUiText(status, 'Wyszukiwanie okładek jest chwilowo niedostępne.', 'Cover search is temporarily unavailable.');
      } else {
        setUiText(status, 'Nie znaleziono pasującej okładki.', 'No matching cover was found.');
      }
      return;
    }
    const url = new URL(coverUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid cover URL');
    coverInput.value = url.href;
    updateCoverPreview(true);
    setUiText(status, 'Znaleziono okładkę.', 'Cover found.');
  } catch (error) {
    if (discardStaleReply() || ignoredSessionError(error)) return;
    const messages = error?.payload?.errorDefault || error?.payload?.errorEnglish
      ? uiErrorText(error)
      : ['Nie udało się wyszukać okładki. Spróbuj ponownie.', 'Could not search for a cover. Try again.'];
    setUiText(status, ...messages);
  } finally {
    if (aiCoverSearchRequest === request) {
      aiCoverSearchRequest = null;
      button.disabled = false;
    }
  }
}

function updateCoverPreviewTitle() {
  if (!gameFormPresentationAvailable) return;
  const title = $('title').value.trim();
  setUiText($('coverPreviewTitle'), title || 'Twoja okładka', title || 'Your cover');
  if (!$('coverPreview').hidden) {
    bindUiText($('coverPreview'), 'alt',
      title ? 'Okładka gry ' + title : 'Podgląd okładki',
      title ? 'Game cover for ' + title : 'Cover preview');
  }
}
// Debounce typing and load immediately when the input is committed. A saved
// backup is eligible only when the game ID and normalized URL match the draft.
function updateCoverPreview(immediate = false) {
  if (!gameFormPresentationAvailable) return;
  clearCoverPreview();
  if (logoutPending || !$('modalBackdrop').classList.contains('open')) return;
  updateCoverPreviewTitle();
  const value = $('coverUrl').value.trim();
  if (!value) {
    setUiText($('coverPreviewStatus'), 'Wklej adres okładki', 'Paste a cover URL');
    return;
  }
  const url = safeImageUrl(value);
  if (!url) {
    setUiText($('coverPreviewStatus'), 'Wpisz poprawny adres okładki', 'Enter a valid cover URL');
    return;
  }
  const generation = coverPreviewGeneration;
  const session = sessionGeneration;
  const isCurrent = () => generation === coverPreviewGeneration && session === sessionGeneration &&
    !logoutPending && $('modalBackdrop').classList.contains('open') && safeImageUrl($('coverUrl').value.trim()) === url;
  const showFailure = () => {
    if (!isCurrent()) return;
    $('coverPreview').onerror = null;
    $('coverPreview').removeAttribute('src');
    $('coverPreview').hidden = true;
    $('coverPreviewPlaceholder').hidden = false;
    setUiText($('coverPreviewStatus'), 'Nie udało się wczytać okładki', 'Could not load the cover');
  };
  const saved = games.find(game => String(game.id) === $('gameId').value && safeImageUrl(game.coverUrl) === url);
  const backupUrl = saved ? localCoverUrl(saved.id) : '';
  const preferBackup = Boolean(backupUrl && coverBackupReady.has(String(saved.coverUrl)));
  let usedBackup = preferBackup;
  let usedOriginal = !preferBackup;
  const retryPreview = () => {
    if (!usedBackup && backupUrl) { usedBackup = true; load(backupUrl); }
    else if (!usedOriginal) { usedOriginal = true; load(url); }
    else showFailure();
  };
  const load = (source = preferBackup ? backupUrl : url) => {
    coverPreviewTimer = null;
    clearTimeout(coverPreviewWatchdog);
    clearCoverPreviewProbe();
    if (!isCurrent()) return;
    const loader = new Image();
    coverPreviewLoader = loader;
    loader.referrerPolicy = 'no-referrer';
    loader.decoding = 'async';
    const fail = () => {
      if (!isCurrent() || coverPreviewLoader !== loader) return;
      clearTimeout(coverPreviewWatchdog);
      coverPreviewWatchdog = null;
      clearCoverPreviewProbe();
      coverPreviewLoader = null;
      loader.onload = null;
      loader.onerror = null;
      loader.removeAttribute('src');
      retryPreview();
    };
    loader.onload = () => {
      if (!isCurrent() || coverPreviewLoader !== loader) return;
      clearTimeout(coverPreviewWatchdog);
      coverPreviewWatchdog = null;
      clearCoverPreviewProbe();
      coverPreviewLoader = null;
      loader.onload = null;
      loader.onerror = null;
      const image = $('coverPreview');
      image.referrerPolicy = 'no-referrer';
      image.onerror = () => {
        if (!isCurrent()) return;
        retryPreview();
      };
      image.src = source;
      image.hidden = false;
      $('coverPreviewPlaceholder').hidden = true;
      setUiText($('coverPreviewStatus'), 'Podgląd okładki', 'Cover preview');
      updateCoverPreviewTitle();
    };
    loader.onerror = fail;
    if (backupUrl && !usedBackup) coverPreviewWatchdog = setTimeout(() => {
      if (!isCurrent() || coverPreviewLoader !== loader) return;
      const probe = new Image();
      coverPreviewBackupProbe = probe;
      probe.referrerPolicy = 'no-referrer';
      probe.onload = () => {
        if (!isCurrent() || coverPreviewLoader !== loader || coverPreviewBackupProbe !== probe) return;
        clearCoverPreviewProbe();
        usedBackup = true;
        loader.onload = null;
        loader.onerror = null;
        loader.removeAttribute('src');
        load(backupUrl);
      };
      probe.onerror = () => { if (coverPreviewBackupProbe === probe) clearCoverPreviewProbe(); };
      probe.src = backupUrl;
    }, COVER_LOAD_TIMEOUT);
    loader.src = source;
  };
  setUiText($('coverPreviewStatus'), 'Wczytuję okładkę…', 'Loading cover…');
  if (immediate) load();
  else coverPreviewTimer = setTimeout(() => load(), 200);
}
// Wire the optional controls. Reveal a hidden platform group when native form
// validation needs to focus one of its checkboxes.
function initializeGameFormPresentation() {
  if (!gameFormPresentationAvailable) return;
  $('platformTabs').addEventListener('click', event => {
    const tab = event.target.closest('[role="tab"]');
    if (!tab || !$('platformTabs').contains(tab)) return;
    activatePlatformGroup(tab.dataset.platformGroup);
  });
  $('platformTabs').addEventListener('keydown', event => {
    const tabs = [...$('platformTabs').querySelectorAll('[role="tab"]')];
    const current = event.target.closest('[role="tab"]');
    if (!current || !tabs.includes(current)) return;
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = tabs.indexOf(current);
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
      (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    activatePlatformGroup(tabs[target].dataset.platformGroup, { focus: true });
  });
  $('platform').addEventListener('change', () => {
    validatePlatformSelection();
    updatePlatformSelectionSummary();
  });
  $('gameForm').addEventListener('invalid', event => {
    if (event.target.name !== 'platform') return;
    const group = getPlatformGroups().find(group => group.inputs.includes(event.target));
    if (group) activatePlatformGroup(group.name);
  }, true);
  $('coverUrl').addEventListener('input', () => updateCoverPreview());
  $('coverUrl').addEventListener('change', () => updateCoverPreview(true));
}
// Escape record values in both text and attributes. Card actions use data
// attributes so the grid can handle them after replacing its contents.
function renderGameCard({ game, platforms, coverUrl }) {
  const title = esc(game.title);
  const id = esc(game.id);
  const editionIcon = game.edition === 'Fizyczne i cyfrowe'
    ? `<span class="edition-icons" aria-hidden="true">${aeroIcon('disc-3')}${aeroIcon('download')}</span>`
    : aeroIcon(game.edition === 'Cyfrowe' ? 'download' : 'disc-3');
  const cover = coverUrl
    ? `<img class="cover-image" data-cover-id="${id}"${localCoverUrl(game.id) ? '' : ` src="${esc(coverUrl)}"`}` +
      ` alt="${uiText('Okładka gry', 'Game cover for')} ${title}" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="cover-title">${title}</div>`;
  const completed = game.status === 'Ograna';
  const inProgress = game.status === 'W trakcie';
  const statusClass = completed ? 'ograna' : inProgress ? 'w-trakcie' : '';
  const statusIcon = aeroIcon(completed ? 'check' : inProgress ? 'play' : 'circle');
  const statusLabel = esc(gameLabel('status', game.status || 'Do ogrania'));
  const platformChips = platforms
    .map(platform => `<span class="platform platform-chip">${esc(gameLabel('platform', platform))}</span>`)
    .join('');
  const editLabel = uiText('Edytuj', 'Edit') + ' ' + title;
  const deleteLabel = uiText('Usuń', 'Delete') + ' ' + title;
  const editButton = `<button class="icon-btn" title="${editLabel}" aria-label="${editLabel}"` +
    ` data-game-action="edit" data-game-id="${id}">${aeroIcon('pencil')}</button>`;
  const deleteButton = `<button class="icon-btn" title="${deleteLabel}" aria-label="${deleteLabel}"` +
    ` data-game-action="delete" data-game-id="${id}">${aeroIcon('trash-2')}</button>`;

  return '<article class="game-card">' +
    `<h3 class="game-title" title="${title}">${title}</h3>` +
    `<div class="cover">
    ${cover}
    </div>
    <div class="card-body">
    <div class="edition-meta">${editionIcon}<span>${esc(gameLabel('edition', game.edition || 'Fizyczne'))}</span></div>
    <div class="game-meta">${platformChips}</div>
    <div class="card-bottom"><span class="status ${statusClass}">${statusIcon}${statusLabel}</span>
    <div class="card-menu">${editButton}
    ${deleteButton}</div></div></div></article>`;
}
// Refresh summaries and filter options when the collection or language
// changes. Build the visible grid from the current query and cached cards.
function render() {
  const query = $('search').value.toLocaleLowerCase('pl');
  const platformFilter = $('platformFilter').value;
  const editionFilter = $('editionFilter').value;
  const statusFilter = $('statusFilter').value;
  const sort = $('sort').value;
  const collection = getCollectionMetadata();
  scheduleCoverBackups(collection);
  if (renderedCollectionMetadata !== collection) {
    $('gameTitleSuggestions').innerHTML = collection.titleOptions;
    const select = $('platformFilter');
    const oldPlatform = select.value;
    select.innerHTML = collection.platformOptions;
    if (collection.platforms.includes(oldPlatform)) select.value = oldPlatform;
    const total = games.length;
    const gameUnit = uiText(total === 1 ? 'gra' : total > 1 && total < 5 ? 'gry' : 'gier', total === 1 ? 'game' : 'games');
    $('statTotal').innerHTML = `${total} <small>${gameUnit}</small>`;
    $('statPlatforms').textContent = collection.platforms.length;
    $('statDone').innerHTML = `${collection.doneCount} <small>${uiText('gier', collection.doneCount === 1 ? 'game' : 'games')}</small>`;
    renderedCollectionMetadata = collection;
  }
  const sortedEntries = collection.sortedEntries.get(sort);
  const list = (sortedEntries ?? collection.entries).filter(entry =>
    (!query || entry.searchText.includes(query)) &&
    (!platformFilter || entry.platforms.includes(platformFilter)) &&
    (!editionFilter || (entry.game.edition || 'Fizyczne') === editionFilter || entry.game.edition === 'Fizyczne i cyfrowe') &&
    (!statusFilter || entry.game.status === statusFilter));
  if (!sortedEntries && (sort === 'title' || sort === 'newest')) {
    if (sort === 'title') list.sort(compareGameTitles);
    else list.sort((a, b) => (b.game.createdAt || 0) - (a.game.createdAt || 0));

    // Reuse the complete order without sorting hidden games on a narrow search.
    if (list.length === collection.entries.length) collection.sortedEntries.set(sort, list);
  }
  const resultUnit = uiText(list.length === 1 ? 'GRA' : list.length > 1 && list.length < 5 ? 'GRY' : 'GIER',
    list.length === 1 ? 'GAME' : 'GAMES');
  $('count').textContent = `${list.length} ${resultUnit}`;
  const grid = $('grid');
  if (!list.length) {
    const isEmpty = !games.length;
    const emptyState = `${uiLanguage}:${isEmpty}`;
    if (renderedEmptyState === emptyState) return;
    renderedEmptyState = emptyState;
    const title = isEmpty ? uiText('Twoja kolekcja zaczyna się tutaj', 'Your collection starts here')
      : uiText('Nie znaleziono gier', 'No games found');
    const message = isEmpty
      ? uiText('Dodaj pierwszą grę i miej wszystkie swoje zakupy na konsole pod ręką.',
        'Add your first game and keep your console collection in one place.')
      : uiText('Zmień wyszukiwanie lub filtry, aby zobaczyć więcej wyników.',
        'Change your search or filters to see more results.');
    const addFirstGame = isEmpty
      ? `<button class="primary" data-action="add-first">${aeroIcon('plus')}${uiText('Dodaj pierwszą grę', 'Add your first game')}</button>`
      : '';
    grid.innerHTML = `<div class="empty"><div class="empty-icon">${aeroIcon(isEmpty ? 'library-big' : 'search-x')}</div>
      <h2>${title}</h2>
      <p>${message}</p>
      ${addFirstGame}</div>`;
    trackCoverImages();
    return;
  }
  renderedEmptyState = '';
  const nodes = list.map(entry => {
    if (!entry.card) {
      const container = document.createElement('div');
      container.innerHTML = renderGameCard(entry);
      entry.card = container.firstElementChild;
    }
    return entry.card;
  });
  // Keep the cards that remain visible mounted. Updating a filter must not
  // restart their images or blur their controls when their position is stable.
  const wanted = new Set(nodes);
  for (const child of [...grid.children]) if (!wanted.has(child)) child.remove();
  nodes.forEach((node, index) => {
    const current = grid.children[index] ?? null;
    if (current !== node) grid.insertBefore(node, current);
  });
  trackCoverImages();
}
// Reference only known SVG symbols from the page's icon sprite.
const AERO_ICON_NAMES = new Set([
  'library-big', 'gamepad-2', 'circle-check', 'plus', 'search', 'pencil', 'trash-2',
  'disc-3', 'download', 'upload', 'log-out', 'external-link', 'x', 'check', 'shield-check',
  'triangle-alert', 'search-x', 'circle', 'play', 'eye', 'eye-off', 'menu', 'chevron-down'
]);
function aeroIcon(name) {
  if (!AERO_ICON_NAMES.has(name)) return '';
  return '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="#ui-icon-' + name + '"></use></svg>';
}
// The configured API supplies the active challenge. A separate generation
// invalidates old widget callbacks each time the login screen is reset.
let captchaChallenge = null;
let captchaSolution = null;
let captchaSolvePromise = null;
let captchaGeneration = 0;
let turnstileScriptPromise = null;
let turnstileWidgetId = null;
let turnstileWaitTimer = null;

function stopTurnstileWait() {
  if (turnstileWaitTimer !== null) clearTimeout(turnstileWaitTimer);
  turnstileWaitTimer = null;
}

function clearCaptchaWidget() {
  stopTurnstileWait();
  if (turnstileWidgetId !== null && window.turnstile) {
    try { window.turnstile.remove(turnstileWidgetId); } catch {}
  }
  turnstileWidgetId = null;
  $('captchaWidget').replaceChildren();
}

// Share the script load between callers and release failed loads for retry.
function loadTurnstileApi() {
  if (window.turnstile) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.dataset.turnstileApi = 'true';
    const finish = error => {
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      if (error) {
        turnstileScriptPromise = null;
        script.remove();
        reject(error);
      } else resolve();
    };
    const timer = setTimeout(() => finish(uiError(
      'Weryfikacja nie załadowała się na czas. Spróbuj ponownie.',
      'Verification did not load in time. Try again.')), 15000);
    script.onload = () => {
      finish(window.turnstile ? null : uiError('Nie udało się uruchomić weryfikacji Turnstile.',
        'Could not start Turnstile verification.'));
    };
    script.onerror = () => finish(uiError('Nie udało się załadować weryfikacji. Sprawdź połączenie i spróbuj ponownie.',
      'Could not load verification. Check your connection and try again.'));
    document.head.append(script);
  });
  return turnstileScriptPromise;
}

function hasCaptchaChallenge(challenge) {
  return challenge?.provider === 'turnstile'
    ? typeof challenge.siteKey === 'string' && challenge.siteKey.length > 0
    : typeof challenge?.nonce === 'string' && challenge.nonce.length > 0;
}

// Older API responses can carry a proof-of-work nonce. Yield between bounded
// batches of hashes to keep the form responsive while solving the challenge.
async function solveAutomaticCaptcha(challenge) {
  if (!globalThis.crypto?.subtle || !globalThis.TextEncoder) {
    throw uiError('Automatyczna weryfikacja wymaga aktualnej przeglądarki i połączenia HTTPS.',
      'Automatic verification requires an up-to-date browser and an HTTPS connection.');
  }
  const difficulty = Math.max(1, Math.min(4, Number(challenge.difficulty) || 3));
  const encoder = new TextEncoder();
  const maxAttempts = 2000000;
  const batchSize = 128;
  const fullZeroBytes = Math.floor(difficulty / 2);
  const needsZeroNibble = difficulty % 2 === 1;
  for (let batchStart = 0; batchStart < maxAttempts; batchStart += batchSize) {
    const batchLength = Math.min(batchSize, maxAttempts - batchStart);
    const candidates = Array.from({ length: batchLength }, (_, index) => {
      const counter = batchStart + index;
      return { counter, data: encoder.encode(`${challenge.nonce}:${counter}`) };
    });
    const digests = await Promise.all(candidates.map(candidate =>
      crypto.subtle.digest('SHA-256', candidate.data)
    ));
    for (let index = 0; index < digests.length; index++) {
      const digest = new Uint8Array(digests[index]);
      let matches = true;
      for (let byte = 0; byte < fullZeroBytes; byte++) {
        if (digest[byte] !== 0) { matches = false; break; }
      }
      if (matches && needsZeroNibble && (digest[fullZeroBytes] & 0xf0) !== 0) matches = false;
      if (matches) return String(candidates[index].counter);
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw uiError('Nie udało się przygotować automatycznej weryfikacji. Odśwież stronę.',
    'Could not prepare automatic verification. Reload the page.');
}
// Keep submit disabled until the current challenge produces a usable answer.
// Turnstile expiry clears the token so it cannot be reused by a later attempt.
function prepareCaptcha(challenge) {
  const isTurnstile = challenge?.provider === 'turnstile';
  if (!hasCaptchaChallenge(challenge)) {
    $('loginButton').disabled = true;
    setUiText($('captchaStatus'), 'Brak danych weryfikacji. Odśwież stronę.',
      'Verification details are missing. Reload the page.');
    $('retryConnection').hidden = false;
    return;
  }
  const generation = ++captchaGeneration;
  clearCaptchaWidget();
  captchaChallenge = challenge;
  captchaSolution = null;
  setUiText($('authIntro'),
    isTurnstile ? 'Wpisz dane konta i potwierdź weryfikację, jeśli zostaniesz o to poproszony.'
      : 'Wpisz dane konta. Automatyczna kontrola antybotowa działa w tle.',
    isTurnstile ? 'Enter your account details and complete verification if prompted.'
      : 'Enter your account details. Bot verification runs in the background.');
  $('loginButton').disabled = true;
  setUiText($('loginButton'), 'Sprawdzam zabezpieczenie…', 'Verifying…');
  $('retryConnection').hidden = true;
  setUiText($('captchaStatus'), 'Trwa automatyczna weryfikacja zabezpieczenia…', 'Running automatic verification…');
  if (isTurnstile) {
    captchaSolvePromise = null;
    loadTurnstileApi().then(() => {
      if (generation !== captchaGeneration) return;
      // A stalled widget must offer a retry. Leave any ongoing or manual
      // verification available until the user actually chooses to retry.
      const showRetry = () => {
        if (generation !== captchaGeneration) return;
        stopTurnstileWait();
        setUiText($('captchaStatus'), 'Weryfikacja trwa dłużej niż zwykle. Możesz zaczekać lub spróbować ponownie.',
          'Verification is taking longer than usual. You can wait or try again.');
        $('retryConnection').hidden = false;
      };
      const startWaitTimer = () => {
        stopTurnstileWait();
        turnstileWaitTimer = setTimeout(showRetry, 25000);
      };
      setUiText($('captchaStatus'), 'Potwierdź weryfikację zabezpieczenia.', 'Complete the security check.');
      startWaitTimer();
      turnstileWidgetId = window.turnstile.render('#captchaWidget', {
        sitekey: challenge.siteKey,
        action: 'login',
        theme: 'auto',
        language: uiLanguage,
        callback: token => {
          if (generation !== captchaGeneration) return;
          stopTurnstileWait();
          captchaSolution = token;
          setUiText($('captchaStatus'), 'Weryfikacja gotowa.', 'Verification complete.');
          $('loginButton').disabled = false;
          setUiText($('loginButton'), 'Zaloguj się', 'Sign in');
          $('retryConnection').hidden = true;
        },
        'expired-callback': () => {
          if (generation !== captchaGeneration) return;
          captchaSolution = null;
          setUiText($('captchaStatus'), 'Weryfikacja wygasła. Rozwiąż ją ponownie.',
            'Verification expired. Complete it again.');
          $('loginButton').disabled = true;
          startWaitTimer();
          try { window.turnstile.reset(turnstileWidgetId); } catch {}
        },
        'error-callback': () => {
          if (generation !== captchaGeneration) return;
          stopTurnstileWait();
          captchaSolution = null;
          setUiText($('captchaStatus'), 'Weryfikacja jest chwilowo niedostępna.', 'Verification is temporarily unavailable.');
          $('loginButton').disabled = true;
          $('retryConnection').hidden = false;
        },
        'timeout-callback': showRetry
      });
    }).catch(error => {
      if (generation !== captchaGeneration) return;
      stopTurnstileWait();
      setUiText($('captchaStatus'), ...uiErrorText(error));
      $('retryConnection').hidden = false;
    });
    return;
  }
  captchaSolvePromise = solveAutomaticCaptcha(challenge).then(solution => {
    if (generation === captchaGeneration) {
      captchaSolution = solution;
      setUiText($('captchaStatus'), 'Automatyczna weryfikacja gotowa.', 'Automatic verification complete.');
      $('loginButton').disabled = false;
      setUiText($('loginButton'), 'Zaloguj się', 'Sign in');
      $('retryConnection').hidden = true;
    }
    return solution;
  }).catch(error => {
    if (generation === captchaGeneration) {
      setUiText($('captchaStatus'), ...uiErrorText(error));
      $('loginButton').disabled = true;
      setUiText($('loginButton'), 'Zaloguj się', 'Sign in');
      $('retryConnection').hidden = false;
    }
    return null;
  });
}
// Keep the optional visibility control and its accessible state in sync.
function setLoginPasswordVisibility(visible) {
  $('loginPassword').type = visible ? 'text' : 'password';
  const button = $('toggleLoginPassword');
  if (!button) return;
  button.setAttribute('aria-pressed', String(visible));
  bindUiText(button, 'aria-label', visible ? 'Ukryj hasło' : 'Pokaż hasło',
    visible ? 'Hide password' : 'Show password');
  const icon = button.querySelector('use');
  if (icon) icon.setAttribute('href', visible ? '#ui-icon-eye-off' : '#ui-icon-eye');
  else setUiText(button, visible ? 'Ukryj' : 'Pokaż', visible ? 'Hide' : 'Show');
}
function clearLoginPassword() {
  $('loginPassword').value = '';
  setLoginPasswordVisibility(false);
}
function initializeLoginPresentation() {
  const button = $('toggleLoginPassword');
  if (!button) return;
  setLoginPasswordVisibility(false);
  button.addEventListener('click', () => setLoginPasswordVisibility($('loginPassword').type === 'password'));
}
// The action menu is a keyboard-accessible disclosure over existing buttons.
// Restore focus only while the user can still interact with the collection.
function closeAppMenu(restoreFocus = false) {
  const menu = $('appMenu'), toggle = $('appMenuToggle');
  if (!menu || !toggle) return;
  const wasOpen = !menu.hidden;
  menu.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  if (restoreFocus && wasOpen && !$('appShell').hidden && !logoutPending) toggle.focus();
}
function setAppMenuOpen(open) {
  const menu = $('appMenu'), toggle = $('appMenuToggle');
  if (!menu || !toggle) return;
  if (!open || $('appShell').hidden || logoutPending || !authenticated) { closeAppMenu(); return; }
  menu.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
}
// Arrow navigation visits menu actions and category summaries. Native fields
// inside a category retain their own arrow, Home and End behavior.
function appMenuNavigationItems(menu) {
  return Array.from(menu.querySelectorAll('button.app-menu-item, summary'))
    .filter(item => !item.disabled && !item.closest('[hidden]'));
}
function handleAppMenuKeydown(event) {
  const container = $('appMenuContainer'), menu = $('appMenu'), toggle = $('appMenuToggle');
  if (!container || !menu || !toggle) return false;
  const target = document.activeElement;
  if (event.key === 'Escape' && !menu.hidden) {
    event.preventDefault();
    closeAppMenu(true);
    return true;
  }
  if (target === toggle && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    setAppMenuOpen(true);
    const items = appMenuNavigationItems(menu);
    if (!menu.hidden && items.length) items[event.key === 'ArrowDown' ? 0 : items.length - 1].focus();
    return true;
  }
  if (!menu.hidden && menu.contains(target) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    if (target?.closest?.('input, select, textarea')) return false;
    const items = appMenuNavigationItems(menu);
    if (!items.length) return false;
    event.preventDefault();
    const current = items.indexOf(target);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
    return true;
  }
  return false;
}
function initializeAppMenu() {
  const container = $('appMenuContainer'), menu = $('appMenu'), toggle = $('appMenuToggle');
  if (!container || !menu || !toggle || container.dataset.menuInitialized === 'true') return;
  container.dataset.menuInitialized = 'true';
  closeAppMenu();
  toggle.addEventListener('click', () => setAppMenuOpen(menu.hidden));
  // Capture closes the disclosure before the unchanged import/export/logout
  // handlers run. In particular the file picker keeps the original user gesture.
  menu.addEventListener('click', event => {
    if (event.target?.closest?.('button.app-menu-item')) closeAppMenu(true);
  }, true);
  container.addEventListener('focusout', event => {
    // Native color/select popups can transfer focus outside the DOM temporarily.
    // An actual outside click or Tab to another element still closes the menu.
    if (!event.relatedTarget && event.target?.matches?.('input, select, textarea')) return;
    if (!container.contains(event.relatedTarget)) closeAppMenu();
  });
  document.addEventListener('click', event => {
    if (!container.contains(event.target)) closeAppMenu();
  });
}
// A fresh login screen starts with its previous challenge discarded.
function showLogin() {
  closeAppMenu();
  setLoginPasswordVisibility(false);
  clearSessionCaptcha();
  $('appShell').hidden = true;
  $('authScreen').hidden = false;
  setUiText($('authTitle'), 'Zaloguj się', 'Sign in');
  setUiText($('authIntro'), 'Wpisz dane konta. Automatyczna kontrola antybotowa działa w tle.',
    'Enter your account details. Bot verification runs in the background.');
  $('loginForm').hidden = false;
  $('websiteField').value = '';
  setUiText($('authMessage'), '');
  $('retryConnection').hidden = true;
  $('loginButton').disabled = true;
  setUiText($('loginButton'), 'Sprawdzam zabezpieczenie…', 'Verifying…');
  setUiText($('captchaStatus'), 'Przygotowuję automatyczną weryfikację…', 'Preparing automatic verification…');
  $('loginUsername').focus();
}
function showAuthError(message, connectionError = false, english) {
  closeAppMenu();
  setLoginPasswordVisibility(false);
  clearSessionCaptcha();
  $('loginButton').disabled = true;
  $('appShell').hidden = true;
  $('authScreen').hidden = false;
  setUiText($('authTitle'), connectionError ? 'Brak połączenia z aplikacją' : 'Nie udało się zalogować',
    connectionError ? 'Could not connect to the application' : 'Could not sign in');
  setUiText($('authIntro'), '');
  $('loginForm').hidden = true;
  setUiText($('authMessage'), message, english);
  $('retryConnection').hidden = !connectionError;
}
// Logout and expiry clear collection records, rendered cards, form drafts,
// search options, and previews. Cancel view timers and image work as well.
function clearPrivateData() {
  aiImportController?.clearPrivateData();
  duplicatesController?.clearPrivateData();
  clearSessionPolicy();
  closeAppMenu();
  showLegacyArchiveControls(false);
  clearCoverBackups();
  pendingGameDeletes.clear();
  games = [];
  collectionMetadataCache = null;
  renderedCollectionMetadata = null;
  renderedEmptyState = '';
  $('appShell').hidden = true;
  $('grid').replaceChildren();
  $('gameTitleSuggestions').replaceChildren();
  $('platformFilter').innerHTML = `<option value="">${uiText('Wszystkie konsole', 'All platforms')}</option>`;
  ['search', 'platformFilter', 'editionFilter', 'statusFilter'].forEach(id => { $(id).value = ''; });
  $('sort').value = 'newest';
  $('count').textContent = uiText('0 GIER', '0 GAMES');
  $('statTotal').innerHTML = uiText('0 <small>gier</small>', '0 <small>games</small>');
  $('statPlatforms').textContent = '0';
  $('statDone').innerHTML = uiText('0 <small>gier</small>', '0 <small>games</small>');
  clearTimeout(toastTimer);
  setUiText($('toast'), '');
  $('toast').classList.remove('show');
  $('gameForm').reset();
  setPlatformSelection();
  $('gameId').value = '';
  clearCollectionImport();
  updateCoverSearchLinks();
  closeModal();
  $('loginUsername').value = '';
  clearLoginPassword();
  $('websiteField').value = '';
}
// Invalidate callbacks before removing the widget so stale verification cannot
// enable sign-in or hide Retry after the form has been replaced by an error.
function clearSessionCaptcha() {
  captchaGeneration++;
  clearCaptchaWidget();
  captchaChallenge = null;
  captchaSolution = null;
  captchaSolvePromise = null;
}
function handleSessionExpired(payload) {
  sessionGeneration++;
  authenticated = false;
  clearPrivateData();
  showLogin();
  if (hasCaptchaChallenge(payload?.captcha)) prepareCaptcha(payload.captcha);
  else showAuthError('Sesja wygasła. Połącz się ponownie, aby się zalogować.', true,
    'Your session expired. Reconnect to sign in.');
}
function showLogoutStatus(error = null) {
  $('appShell').hidden = true;
  $('authScreen').hidden = false;
  setUiText($('authTitle'), error ? 'Wylogowanie niepotwierdzone' : 'Wylogowywanie…',
    error ? 'Sign-out could not be confirmed' : 'Signing out…');
  setUiText($('authIntro'),
    error ? 'Dane kolekcji są ukryte. Ponów wylogowanie po odzyskaniu połączenia.'
      : 'Dane kolekcji są ukryte. Czekam na potwierdzenie wylogowania z serwera.',
    error ? 'Your collection is hidden. Try signing out again when you reconnect.'
      : 'Your collection is hidden while the server confirms sign-out.');
  $('loginForm').hidden = true;
  setUiText($('captchaStatus'), '');
  setUiText($('authMessage'), ...uiErrorText(error));
  $('retryConnection').hidden = !error;
}
// A restored cookie must not bypass the fresh-login marker. Keep the screen
// locked until the server confirms logout and the user logs in again.
function lockUnexpectedSession() {
  sessionGeneration++;
  authenticated = false;
  logoutPending = true;
  freshLoginRequired = true;
  storePendingLogout(true);
  storeFlag(FRESH_LOGIN_REQUIRED_KEY, true);
  clearPrivateData();
  clearSessionCaptcha();
  showLogoutStatus(uiError('Serwer nadal zwraca aktywną sesję. Ponów wylogowanie przed nowym logowaniem.',
    'The server still reports an active session. Sign out again before signing in.'));
}
async function settlePendingRequests(requests) {
  if (!requests.length) return;
  let timer;
  try {
    await Promise.race([
      Promise.allSettled(requests),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          reject(uiError('Wcześniejsze żądania jeszcze się nie zakończyły. Spróbuj ponownie wylogować aplikację.',
            'Earlier requests are still running. Try signing out again.'));
        }, 15000);
      })
    ]);
  } finally { clearTimeout(timer); }
}
// Hide and clear local data before contacting the server. Leave the pending
// marker set until confirmation so reloading or retrying cannot reveal it.
async function performLogout() {
  if (logoutRequest) return logoutRequest;
  logoutPending = true;
  freshLoginRequired = true;
  storePendingLogout(true);
  storeFlag(FRESH_LOGIN_REQUIRED_KEY, true);
  const generation = ++sessionGeneration;
  authenticated = false;
  clearPrivateData();
  clearSessionCaptcha();
  showLogoutStatus();
  const outstanding = [...activeApiRequests];
  const attempt = (async () => {
    try {
      // Wait for older login responses (including Set-Cookie) before the final
      // logout. Aborting a browser fetch alone does not cancel server work.
      await settlePendingRequests(outstanding);
      ensureCurrentSession(generation, true);
      await apiRequest('POST', { action: 'logout' }, generation);
      ensureCurrentSession(generation, true);
      logoutPending = false;
      storePendingLogout(false);
      logoutRequest = null;
      await initialize();
    } catch (error) {
      if (generation !== sessionGeneration || ignoredSessionError(error)) return;
      showLogoutStatus(error);
    } finally {
      if (logoutRequest === attempt) logoutRequest = null;
    }
  })();
  logoutRequest = attempt;
  return attempt;
}
// Move legacy records only inside a confirmed session. Preserve the browser
// copy if migration fails so the user can retry without losing it.
async function acceptAuthenticated(initialGames, generation = sessionGeneration) {
  ensureCurrentSession(generation);
  authenticated = true;
  clearLoginPassword();
  captchaGeneration++;
  clearCaptchaWidget();
  captchaChallenge = null;
  captchaSolution = null;
  captchaSolvePromise = null;
  const legacyGames = readLegacyGames();
  let migrationNotice;
  games = initialGames;
  if (legacyGames.length) {
    try {
      const migration = await submitCollectionTransfer('migrate', legacyGames, generation);
      ensureCurrentSession(generation);
      try { localStorage.removeItem(LEGACY_KEY); } catch {}
      if (migration.inserted > 0) {
        const unit = migration.inserted === 1 ? 'game' : 'games';
        migrationNotice = [
          `Przeniesiono ${migration.inserted} gier do bazy danych`,
          `Moved ${migration.inserted} ${unit} to the database`
        ];
      }
    } catch (error) {
      if (ignoredSessionError(error) || generation !== sessionGeneration) throw error;
      const [polish, english] = uiErrorText(error);
      migrationNotice = [
        `Nie udało się przenieść starszej kolekcji. Kopia w przeglądarce została zachowana. ${polish}`,
        `Could not move the older collection. The copy in your browser was kept. ${english}`
      ];
    }
  }
  ensureCurrentSession(generation);
  setConnectionStatus('zapis w bazie danych', false, 'saved in the database');
  if (!sessionPolicy) { void performLogout(); throw staleSessionError(); }
  $('appShell').hidden = privacySuspended;
  $('authScreen').hidden = !privacySuspended;
  showLegacyArchiveControls(readLegacyArchive() !== null);
  armSessionTimers();
  render();
  loadCollectionTools();
  if (migrationNotice) notify(...migrationNotice);
}
// Recover a pending logout first, then ask the API whether it can resume an
// existing session or needs to provide a challenge for a new login.
async function initialize() {
  if (logoutPending) return performLogout();
  const generation = sessionGeneration;
  if (location.protocol === 'file:') {
    showAuthError('Aplikacja została otwarta jako plik. Zalogowanie wymaga strony uruchomionej na hostingu z PHP.', true,
      'The application was opened as a file. Serve the page from a PHP host to sign in.');
    return;
  }
  try {
    const initial = await apiRequest('GET', undefined, generation);
    ensureCurrentSession(generation);
    if (freshLoginRequired || readStoredFlag(FRESH_LOGIN_REQUIRED_KEY)) {
      lockUnexpectedSession();
      return;
    }
    await acceptAuthenticated(initial.games, generation);
  } catch (error) {
    if (ignoredSessionError(error) || generation !== sessionGeneration || logoutPending) return;
    if (error.status === 401 && (error.payload?.authRequired === true || hasCaptchaChallenge(error.payload?.captcha))) {
      if (!hasCaptchaChallenge(error.payload?.captcha)) {
        showAuthError('Serwer ma starszą wersję API logowania i nie udostępnia CAPTCHA. Wgraj aktualny plik api/games.php z projektu i odśwież stronę.', true,
          'The server uses an older sign-in API without CAPTCHA. Upload the current api/games.php from the project and reload the page.');
        return;
      }
      showLogin();
      prepareCaptcha(error.payload?.captcha);
      return;
    }
    const [polish, english] = uiErrorText(error);
    setConnectionStatus('błąd połączenia z serwerem', true, 'server connection error');
    showAuthError(polish, true, english);
  }
}
// Consume the challenge once. Clear the password field as soon as the request
// captures it, and ignore callbacks from a login that no longer owns the form.
async function submitLogin(event) {
  event.preventDefault();
  if ($('loginButton').disabled) return;
  const generation = sessionGeneration;
  $('loginButton').disabled = true;
  setUiText($('loginButton'), 'Sprawdzam zabezpieczenie…', 'Verifying…');
  setUiText($('authMessage'), '');
  setUiText($('captchaStatus'), 'Trwa automatyczna weryfikacja zabezpieczenia…', 'Running automatic verification…');
  let requestSent = false;
  try {
    if (!captchaChallenge) {
      throw uiError('Odśwież stronę, aby uruchomić automatyczną weryfikację.', 'Reload the page to start automatic verification.');
    }
    const challenge = captchaChallenge;
    const solution = challenge.provider === 'turnstile'
      ? captchaSolution
      : captchaSolution || (captchaSolvePromise ? await captchaSolvePromise : null);
    ensureCurrentSession(generation);
    if (!solution) {
      throw uiError('Automatyczna weryfikacja nie powiodła się. Odśwież stronę.', 'Automatic verification failed. Reload the page.');
    }
    captchaChallenge = null;
    captchaSolution = null;
    captchaSolvePromise = null;
    requestSent = true;
    const loginRequest = apiRequest('POST', {
      action: 'login',
      username: $('loginUsername').value,
      password: $('loginPassword').value,
      website: $('websiteField').value,
      captcha: challenge.provider === 'turnstile'
        ? { token: solution }
        : { nonce: challenge.nonce, solution }
    }, generation);
    clearLoginPassword();
    const result = await loginRequest;
    ensureCurrentSession(generation);
    freshLoginRequired = false;
    storeFlag(FRESH_LOGIN_REQUIRED_KEY, false);
    await acceptAuthenticated(result.games, generation);
  } catch (error) {
    if (ignoredSessionError(error) || generation !== sessionGeneration || logoutPending) return;
    showAuthenticatedError(...uiErrorText(error));
    if (error.payload?.captcha) prepareCaptcha(error.payload.captcha);
    else {
      setUiText($('captchaStatus'),
        requestSent ? 'Weryfikacja została zużyta. Uruchom ją ponownie, aby spróbować zalogować się jeszcze raz.'
          : 'Automatyczna weryfikacja nie powiodła się. Uruchom ją ponownie.',
        requestSent ? 'This verification has been used. Complete it again to retry sign-in.'
          : 'Automatic verification failed. Start it again.');
      $('retryConnection').hidden = false;
    }
  } finally {
    if (generation === sessionGeneration) {
      clearLoginPassword();
      if (!logoutPending) {
        $('loginButton').disabled = !captchaSolution;
        setUiText($('loginButton'), 'Zaloguj się', 'Sign in');
      }
    }
  }
}
function showAuthenticatedError(message, english) {
  setUiText($('authMessage'), message, english);
}
$('loginForm').addEventListener('submit', submitLogin);
$('retryConnection').onclick = () => {
  if (logoutPending) return performLogout();
  if (privacySuspended && authenticated) return revalidatePrivateSession();
  return initialize();
};
$('logoutBtn').onclick = performLogout;
// Propagate logout locks to other tabs that share the same session cookie.
addEventListener('storage', event => {
  if (event.key === FRESH_LOGIN_REQUIRED_KEY && event.newValue === '1') freshLoginRequired = true;
  if (event.key === PENDING_LOGOUT_KEY && event.newValue === '1' && !logoutPending) performLogout();
});
// Use one form for new and existing games. Clear stale previews and selections
// before populating an edit, then focus the title in the current session.
let gameDraft = null;
const gameSaveButton = $('gameForm').querySelector('button[type="submit"]');
function gameDraftValues() {
  return {
    titleInput: $('title').value,
    selection: getSelectedPlatforms(),
    edition: $('edition').value,
    coverInput: $('coverUrl').value,
    status: $('status').value
  };
}
function setDraftOption(id, value) {
  const select = $(id);
  select.querySelector('[data-legacy-value]')?.remove();
  if (!value) return;
  if (![...select.querySelectorAll('option')].some(option => option.value === value)) {
    const option = document.createElement('option');
    option.dataset.legacyValue = 'true';
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
  select.value = value;
}
function requestCloseModal() {
  if (!gameDraft) return true;
  if (gameDraft.pending) return false;
  if (gameDraft.original !== JSON.stringify(gameDraftValues()) && !confirm(uiText(
    'Odrzucić niezapisane zmiany w grze?', 'Discard the unsaved changes to this game?'))) return false;
  closeModal();
  return true;
}
function updateOrdinaryModalState() {
  $('appShell').inert = Boolean(gameDraft || pendingDeleteConfirmation);
}
function restoreCollectionFocus(target) {
  if (!logoutPending && !$('appShell').hidden) {
    const focusTarget = target?.isConnected ? target : $('addBtn');
    focusTarget?.focus();
  }
}
function openModal(game) {
  if (!privateViewUsable() || !requestCloseModal()) return;
  aiImportController?.close();
  duplicatesController?.close();
  closeAppMenu();
  clearCoverPreview();
  resolveDeleteConfirmation(false);
  const generation = sessionGeneration;
  const focusTarget = document.activeElement;
  $('gameForm').reset();
  setAiCoverSearchVisible(true);
  setPlatformSelection(game?.platform);
  $('gameId').value = game?.id || '';
  setUiText($('modalTitle'), game ? 'Edytuj grę' : 'Dodaj grę do kolekcji',
    game ? 'Edit game' : 'Add a game to your collection');
  setUiText($('modalBackdrop').querySelector('.modal-sub'),
    game ? 'Uzupełnij szczegóły swojego egzemplarza.' : 'Nowy tytuł, kolejny zapis w Twojej bibliotece.',
    game ? 'Update the details of your copy.' : 'Add another title to your library.');
  if (game) {
    $('title').value = game.title;
    setDraftOption('edition', game.edition || 'Fizyczne');
    $('coverUrl').value = game.coverUrl || '';
    setDraftOption('status', game.status || 'Do ogrania');
  }
  const draft = { id: game?.id || '', revision: game?.revision, createdAt: game?.createdAt ?? Date.now(),
    savedCover: game?.coverUrl || '',
    focusTarget, original: JSON.stringify(gameDraftValues()), pending: false };
  gameDraft = draft;
  updateOrdinaryModalState();
  updateCoverSearchLinks();
  $('modalBackdrop').classList.add('open');
  $('gameForm').querySelector('.form-grid').scrollTop = 0;
  updateCoverPreview(true);
  setTimeout(() => {
    if (generation === sessionGeneration && !logoutPending && gameDraft === draft) $('title').focus();
  }, 40);
}
// A single pending promise represents the delete dialog. Dismissal, another
// action, and logout resolve it without allowing the old delete to proceed.
let pendingDeleteConfirmation = null;
function resolveDeleteConfirmation(confirmed) {
  const pending = pendingDeleteConfirmation;
  pendingDeleteConfirmation = null;
  $('deleteModalBackdrop').classList.remove('open');
  setUiText($('deleteGameName'), '');
  setUiText($('deleteGamePlatforms'), '');
  updateOrdinaryModalState();
  if (pending) {
    restoreCollectionFocus(pending.focusTarget);
    pending.resolve(confirmed === true);
  }
}
function confirmGameDeletion(game) {
  aiImportController?.close();
  duplicatesController?.close();
  closeAppMenu();
  resolveDeleteConfirmation(false);
  if (!privateViewUsable() || !requestCloseModal()) return Promise.resolve(false);
  setUiText($('deleteGameName'), '„' + game.title + '”', '“' + game.title + '”');
  const platforms = gamePlatforms(game.platform);
  setUiText($('deleteGamePlatforms'), platforms.join(' · '),
    platforms.map(platform => englishGameLabels.platform.get(platform) ?? platform).join(' · '));
  const promise = new Promise(resolve => { pendingDeleteConfirmation = { resolve, focusTarget: document.activeElement }; });
  updateOrdinaryModalState();
  $('deleteModalBackdrop').classList.add('open');
  $('deleteCancelButton').focus();
  return promise;
}
function closeModal() {
  const closed = gameDraft;
  gameDraft = null;
  $('modalBackdrop').classList.remove('open');
  setAiCoverSearchVisible(false);
  clearCoverPreview();
  setDraftOption('edition');
  setDraftOption('status');
  $('gameForm').reset();
  $('gameForm').inert = false;
  $('title').setCustomValidity('');
  $('coverUrl').setCustomValidity('');
  if (gameSaveButton) gameSaveButton.disabled = false;
  updateCoverSearchLinks();
  setPlatformSelection();
  $('gameId').value = '';
  resolveDeleteConfirmation(false);
  if (closed) restoreCollectionFocus(closed.focusTarget);
}
// Card actions look up the current record by ID before opening a dialog.
window.openModal = openModal;
window.editGame = id => {
  const game = games.find(item => item.id === id);
  if (game) openModal(game);
};
const pendingGameDeletes = new Set();
window.deleteGame = async id => {
  const generation = sessionGeneration;
  const game = games.find(item => item.id === id);
  if (!game || pendingGameDeletes.has(game)) return;
  pendingGameDeletes.add(game);
  try {
    if (!await confirmGameDeletion(game)) return;
    ensureCurrentSession(generation);
    await apiRequest('POST', { action: 'delete', id, revision: game.revision, delta: true }, generation);
    ensureCurrentSession(generation);
    if (!document.activeElement?.isConnected) restoreCollectionFocus();
    notify('Gra usunięta z kolekcji', 'Game removed from your collection');
  } catch (error) {
    if (!ignoredSessionError(error) && generation === sessionGeneration && !logoutPending) {
      notify(...uiErrorText(error));
      if (error.payload?.code === 'collection_conflict') {
        await apiRequest('GET', undefined, generation, { reloadCollection: true }).catch(() => {});
      }
    }
  } finally { pendingGameDeletes.delete(game); }
};
// Delegate events to the stable grid element. Capture is needed for load and
// error events from images, which do not bubble from the replacement cards.
$('grid').addEventListener('error', event => {
  if (!event.target.matches?.('img.cover-image')) return;
  const image = event.target;
  const state = currentCoverImage(image);
  if (!state || !image.hasAttribute('src')) return;
  if (state.local && !state.directTried) {
    useOriginalCover(image, state);
    scheduleCoverProbe(image, state);
  } else if (!state.local && !coverBackupReady.has(state.key)) useLocalCover(image);
}, true);
$('grid').addEventListener('load', event => {
  const state = coverImageStates.get(event.target);
  if (state) { clearTimeout(state.timer); state.timer = null; clearCoverProbe(state); }
}, true);
$('grid').addEventListener('click', event => {
  const button = event.target.closest('[data-action], [data-game-action]');
  if (!button || !$('grid').contains(button)) return;
  if (button.dataset.action === 'add-first') openModal();
  if (button.dataset.gameAction === 'edit') window.editGame(button.dataset.gameId);
  if (button.dataset.gameAction === 'delete') window.deleteGame(button.dataset.gameId);
});
$('addBtn').onclick = () => openModal();
$('aiCoverSearch')?.addEventListener('click', searchGameCover);
for (const eventName of ['input', 'change']) {
  $('gameForm').addEventListener(eventName, event => {
    if (['title', 'coverUrl'].includes(event.target.id) || event.target.name === 'platform') clearAiCoverSearch();
  });
}
$('title').addEventListener('input', () => {
  $('title').setCustomValidity('');
  updateCoverSearchLinks();
  updateCoverPreviewTitle();
});
$('coverUrl').addEventListener('input', () => $('coverUrl').setCustomValidity(''));
$('closeModal').onclick = requestCloseModal;
$('cancelBtn').onclick = requestCloseModal;
$('modalBackdrop').onclick = event => { if (event.target === $('modalBackdrop')) requestCloseModal(); };
$('deleteClose').onclick = () => resolveDeleteConfirmation(false);
$('deleteCancelButton').onclick = () => resolveDeleteConfirmation(false);
$('deleteConfirmButton').onclick = () => resolveDeleteConfirmation(true);
$('deleteModalBackdrop').onclick = event => { if (event.target === $('deleteModalBackdrop')) resolveDeleteConfirmation(false); };
document.addEventListener('keydown', event => {
  if (handleAppMenuKeydown(event)) return;
  const dialog = pendingDeleteConfirmation ? $('deleteModalBackdrop') : gameDraft ? $('modalBackdrop') : null;
  if (!dialog) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (pendingDeleteConfirmation) resolveDeleteConfirmation(false);
    else requestCloseModal();
  } else if (event.key === 'Tab') {
    const controls = [...dialog.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
      .filter(control => !control.disabled && control.type !== 'hidden' && control.tabIndex >= 0 &&
        !control.closest('[hidden], fieldset[disabled]'));
    const active = document.activeElement;
    if (!controls.length) return;
    const first = controls[0], last = controls[controls.length - 1];
    if (!controls.includes(active) || (event.shiftKey ? active === first : active === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }
});
initializeGameFormPresentation();
// Capture the draft revision and reuse the same ID across retries. A reply
// that belongs to another session or editor cannot reset the current form.
$('gameForm').onsubmit = async event => {
  event.preventDefault();
  const generation = sessionGeneration;
  const draft = gameDraft;
  if (!draft || draft.pending || logoutPending) return;
  const { titleInput, selection, edition, coverInput, status } = gameDraftValues();
  const title = titleInput.trim();
  const platform = platformListForStorage(selection);
  const coverUrl = safeImageUrl(coverInput);
  if (!title || Array.from(title).length > 255) {
    $('title').setCustomValidity(uiText('Podaj tytuł od 1 do 255 znaków.', 'Enter a title between 1 and 255 characters.'));
    $('title').reportValidity();
    return;
  }
  if (coverInput.trim() && !coverUrl) {
    $('coverUrl').setCustomValidity(uiText('Podaj adres HTTP lub HTTPS bez danych logowania.',
      'Enter an HTTP or HTTPS address without login information.'));
    $('coverUrl').reportValidity();
    return;
  }
  if (!validatePlatformSelection()) {
    const first = platformCheckboxes()[0];
    const group = getPlatformGroups().find(group => group.inputs.includes(first));
    if (group) activatePlatformGroup(group.name);
    first.reportValidity();
    return;
  }
  if (selection.length > 50 || Array.from(platform).length > 400) {
    notify('Lista platform przekracza limit 50 pozycji lub 400 znaków.',
      'The platform list exceeds 50 entries or 400 characters.');
    return;
  }
  if (aiCoverSearchRequest) clearAiCoverSearch();
  const mode = draft.id ? 'edit' : 'create';
  const id = draft.id || (draft.newId ??= crypto.randomUUID());
  const game = { id, title, platform, edition, coverUrl: coverInput === draft.savedCover ? draft.savedCover : coverUrl,
    status, createdAt: draft.createdAt };
  draft.pending = true;
  $('gameForm').inert = true;
  if (gameSaveButton) gameSaveButton.disabled = true;
  try {
    await apiRequest('POST', { action: 'save', mode, game, revision: draft.revision, delta: true }, generation);
    ensureCurrentSession(generation);
    if (gameDraft === draft) closeModal();
    notify(mode === 'edit' ? 'Zmiany zapisane' : 'Gra dodana do kolekcji',
      mode === 'edit' ? 'Changes saved' : 'Game added to your collection');
  } catch (error) {
    if (!ignoredSessionError(error) && generation === sessionGeneration && !logoutPending) {
      notify(...uiErrorText(error));
      if (error.payload?.code === 'collection_conflict') {
        await apiRequest('GET', undefined, generation, { reloadCollection: true }).catch(() => {});
      }
    }
  } finally {
    if (gameDraft === draft) {
      draft.pending = false;
      $('gameForm').inert = false;
      if (gameSaveButton) gameSaveButton.disabled = false;
    }
  }
};
['search', 'platformFilter', 'editionFilter', 'statusFilter', 'sort'].forEach(id =>
  $(id).addEventListener(id === 'search' ? 'input' : 'change', render));
initializeCollectionTransfer();

function initializeUiLanguage() {
  // data-en replaces textContent. Use it on text-only elements so translation
  // preserves any icons or controls in their parent elements.
  const translatedFields = [
    ['data-en', 'textContent'],
    ['data-en-aria-label', 'aria-label'],
    ['data-en-placeholder', 'placeholder'],
    ['data-en-title', 'title'],
    ['data-en-alt', 'alt'],
    ['data-en-label', 'label']
  ];
  for (const [attribute, field] of translatedFields) {
    for (const node of document.querySelectorAll(`[${attribute}]`)) {
      const polish = field === 'textContent' ? node.textContent : node.getAttribute(field);
      bindUiText(node, field, polish, node.getAttribute(attribute));
    }
  }

  document.documentElement?.setAttribute('lang', uiLanguage);
  const controls = document.querySelectorAll('[data-ui-language]');
  for (const control of controls) {
    control.value = uiLanguage;
    control.addEventListener('change', () => {
      const language = control.value === 'en' ? 'en' : 'pl';
      if (language === uiLanguage) return;
      uiLanguage = language;
      aiImportController?.refreshLanguage();
      duplicatesController?.refreshLanguage();
      try { localStorage.setItem(LANGUAGE_KEY, language); } catch {}
      document.documentElement?.setAttribute('lang', language);
      for (const selector of controls) selector.value = language;
      for (const [node, fields] of uiBindings) {
        for (const [field, [polish, english]] of fields) applyUiText(node, field, uiText(polish, english));
      }
      if (gameFormPresentationAvailable) {
        const extra = $('platformOptions').querySelector('[data-extra-platforms] legend');
        if (extra) extra.textContent = uiText('Inne zapisane konsole', 'Other saved platforms');
        rebuildPlatformTabs();
        updatePlatformSelectionSummary();
        validatePlatformSelection();
      }
      if (authenticated && !$('appShell').hidden && !logoutPending && !privacySuspended) render();
      // Turnstile sets its language on creation. Rebuild it only when the
      // login form is visible so an error screen can keep its Retry action.
      if (!authenticated && !logoutPending && !$('loginForm').hidden && captchaChallenge?.provider === 'turnstile') {
        prepareCaptcha(captchaChallenge);
      }
    });
  }
}

// The photo workflow uses only authenticated API hooks. It cannot modify the
// collection until its explicit review sends a separate, tracked batch save.
function initializeAiImport() {
  const button = $('addAiBtn');
  const backdrop = $('aiImportBackdrop');
  // An older cached document can briefly load a newer script during upload.
  // Keep ordinary sign-in and collection controls usable without the new UI.
  if (!button || !backdrop || aiImportController) return;
  if (!window.SavepointAiImport) {
    button.onclick = () => notify('Nie udało się uruchomić funkcji AI. Odśwież stronę.',
      'Could not start the AI feature. Reload the page.');
    return;
  }
  aiImportController = window.SavepointAiImport.create({
    button,
    backdrop,
    request: (body, generation, signal) => apiRequest('POST', body, generation, {
      abortableAiRequest: body.action !== 'ai-add', signal
    }),
    ensureReady: generation => ensurePrivateSessionReady(generation),
    getGeneration: () => sessionGeneration,
    isCurrent: generation => authenticated && !logoutPending && !privacySuspended && generation === sessionGeneration,
    getGames: () => games,
    getLanguage: () => uiLanguage,
    errorText: uiErrorText,
    notify,
    beforeOpen: () => {
      if (!requestCloseModal()) return false;
      duplicatesController?.close();
      closeAppMenu();
    },
    onSaved: (result, count) => {
      notify(count === 1 ? 'Dodano grę do kolekcji' : `Dodano ${count} gier do kolekcji`,
        count === 1 ? 'Added a game to your collection' : `Added ${count} games to your collection`);
    },
    // Share the ordinary form's presets without carrying over extra platforms
    // that belong only to a previously edited collection entry.
    platformGroups: getPlatformGroups().filter(group => !group.element.dataset.extraPlatforms).map(group => ({
      name: group.name,
      englishName: group.element.querySelector('legend').getAttribute('data-en') || group.name,
      platforms: group.inputs.map(control => control.value)
    })),
    platforms: platformCheckboxes().map(control => control.value)
  });
}

function initializeDuplicates() {
  const button = $('findDuplicatesBtn');
  const backdrop = $('duplicatesBackdrop');
  if (!button || !backdrop || duplicatesController) return;
  if (!window.SavepointDuplicates) {
    button.onclick = () => notify('Nie udało się otworzyć wyszukiwania powtórzeń. Odśwież stronę.',
      'Could not open duplicate detection. Reload the page.');
    return;
  }
  duplicatesController = window.SavepointDuplicates.create({
    button,
    backdrop,
    request: (body, generation, signal) => apiRequest('POST', body, generation, {
      abortableAiRequest: body.action === 'ai-duplicates-scan', signal
    }),
    reloadCollection: generation => apiRequest('GET', undefined, generation, { reloadCollection: true }),
    ensureReady: generation => ensurePrivateSessionReady(generation),
    getGeneration: () => sessionGeneration,
    isCurrent: generation => authenticated && !logoutPending && !privacySuspended && generation === sessionGeneration,
    getLanguage: () => uiLanguage,
    gameLabel,
    errorText: uiErrorText,
    notify,
    beforeOpen: () => {
      if (!requestCloseModal()) return false;
      aiImportController?.close();
      closeAppMenu();
    },
    onSaved: () => {}
  });
}

// The optional controllers are needed only after sign-in. Keep the buttons
// retryable if one script fails, without affecting the ordinary collection.
function loadCollectionTool(id, factory, initializeTool) {
  const button = $(id);
  if (!button) return;
  if (window[factory] || !button.dataset.moduleSrc) {
    initializeTool();
    return;
  }
  if (button.getAttribute('aria-busy') === 'true') return;
  const script = document.createElement('script');
  const retry = () => { if (privateViewUsable()) loadCollectionTool(id, factory, initializeTool); };
  const finish = loaded => {
    clearTimeout(timeout);
    script.onload = null;
    script.onerror = null;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (loaded && window[factory]) {
      button.onclick = null;
      initializeTool();
    } else {
      script.remove();
      button.onclick = retry;
      if (privateViewUsable()) {
        notify('Nie udało się wczytać narzędzia AI. Kliknij przycisk, aby spróbować ponownie.',
          'Could not load the AI tool. Click its button to try again.');
      }
    }
  };
  const timeout = setTimeout(() => finish(false), 12000);
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  script.src = button.dataset.moduleSrc;
  script.async = true;
  script.onload = () => finish(true);
  script.onerror = () => finish(false);
  document.head.append(script);
}
function loadCollectionTools() {
  loadCollectionTool('addAiBtn', 'SavepointAiImport', initializeAiImport);
  loadCollectionTool('findDuplicatesBtn', 'SavepointDuplicates', initializeDuplicates);
}

// Install page controls before the first session request updates the UI.
initializeUiLanguage();
initializeAppMenu();
initializeLoginPresentation();
initializeSessionPrivacy();
if (window.SavepointAiImport) initializeAiImport();
if (window.SavepointDuplicates) initializeDuplicates();
initialize();
