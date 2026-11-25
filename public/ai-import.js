// Photo recognition prepares suggestions only. The user must review and confirm
// a selection before the application sends an additive batch to the server.
(() => {
  'use strict';

  const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
  const MAX_PREPARED_BYTES = 2 * 1024 * 1024;
  const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const MAX_GAMES = 32;
  const MAX_CHUNK_BYTES = 45000;
  const CHUNK_RETRY_DELAYS = [300, 1000];
  const EDITIONS = [['Fizyczne', 'Physical'], ['Cyfrowe', 'Digital'], ['Fizyczne i cyfrowe', 'Physical and digital']];
  const STATUSES = [['Do ogrania', 'To play'], ['W trakcie', 'In progress'], ['Ograna', 'Completed']];
  const COVER_PROVIDERS = new Map([
    ['igdb', ['IGDB', 'IGDB']],
    ['steamgriddb', ['SteamGridDB', 'SteamGridDB']],
    ['wikipedia', ['Wikipedii', 'Wikipedia']]
  ]);
  const UNAVAILABLE = ['Funkcja Dodaj Gry AI jest niedostępna bez klucza Gemini API.',
    'Add Games AI is unavailable without a Gemini API key.'];

  function failure(polish, english) {
    const error = new Error(polish);
    error.englishMessage = english;
    return error;
  }

  function coverAddress(value, requireHttps = false) {
    if (typeof value !== 'string' || !value || new TextEncoder().encode(value).length > 2048) return '';
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
      if (requireHttps && (url.protocol !== 'https:' || new TextEncoder().encode(url.href).length > 2048)) return '';
      return url.href;
    } catch { return ''; }
  }

  function base64(bytes) {
    let binary = '';
    for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]);
    return btoa(binary);
  }

  // Canvas re-encoding strips source metadata. The original file never leaves
  // the browser, and only the resized JPEG is offered for explicit analysis.
  async function preparePhoto(file) {
    if (!file || !PHOTO_TYPES.includes(file.type)) {
      throw failure('Wybierz zdjęcie JPEG, PNG lub WebP.', 'Choose a JPEG, PNG or WebP photo.');
    }
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_PHOTO_BYTES) {
      throw failure('Zdjęcie może mieć maksymalnie 12 MiB.', 'The photo must be no larger than 12 MiB.');
    }
    let image;
    let release = () => {};
    try {
      if (typeof createImageBitmap === 'function') {
        image = await createImageBitmap(file, { imageOrientation: 'from-image' });
        release = () => image.close?.();
      } else {
        const source = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(failure('Nie udało się odczytać zdjęcia.', 'Could not read the photo.'));
          reader.readAsDataURL(file);
        });
        image = await new Promise((resolve, reject) => {
          const loader = new Image();
          loader.onload = () => resolve(loader);
          loader.onerror = () => reject(failure('Nie udało się otworzyć zdjęcia.', 'Could not open the photo.'));
          loader.src = source;
        });
        release = () => { image.onload = image.onerror = null; image.removeAttribute('src'); };
      }
      const width = image.width || image.naturalWidth;
      const height = image.height || image.naturalHeight;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width * height > 48000000) {
        throw failure('Wybierz zdjęcie o rozdzielczości do 48 megapikseli.', 'Choose a photo with a resolution of up to 48 megapixels.');
      }
      const canvas = document.createElement('canvas');
      try {
        const context = canvas.getContext('2d', { alpha: false });
        if (!context || typeof canvas.toBlob !== 'function') throw new Error('Canvas unavailable');
        for (const [side, quality] of [[1600, .85], [1600, .7], [1280, .65], [1000, .6]]) {
          const scale = Math.min(1, side / Math.max(width, height));
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
          if (blob?.type === 'image/jpeg' && blob.size > 0 && blob.size <= MAX_PREPARED_BYTES) {
            const bytes = new Uint8Array(await blob.arrayBuffer());
            return { bytes, preview: 'data:image/jpeg;base64,' + base64(bytes) };
          }
        }
      } finally { canvas.width = canvas.height = 1; }
      throw failure('Nie udało się zmniejszyć zdjęcia. Wybierz inne zdjęcie.', 'Could not resize the photo. Choose another photo.');
    } catch (error) {
      if (error?.englishMessage) throw error;
      throw failure('Nie udało się przygotować zdjęcia. Wybierz poprawny plik JPEG, PNG lub WebP.',
        'Could not prepare the photo. Choose a valid JPEG, PNG or WebP file.');
    } finally { release(); }
  }

  function node(tag, className, parent) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    parent?.append(element);
    return element;
  }

  function controlButton(parent, className = 'secondary') {
    const element = node('button', className, parent);
    element.type = 'button';
    return element;
  }

  function photoInput(parent, id) {
    const input = node('input', '', parent);
    input.type = 'file';
    input.accept = PHOTO_TYPES.join(',');
    input.id = id;
    input.hidden = true;
    return input;
  }

  function buildPhotoControls(body, label) {
    const fileLabel = node('div', 'ai-import-file', body);
    label(node('p', '', fileLabel), 'Zdjęcie gier: JPEG, PNG lub WebP, do 12 MiB. Możesz wybrać plik lub użyć aparatu.',
      'Game photo: JPEG, PNG or WebP, up to 12 MiB. Choose a file or use your camera.');
    const photoActions = node('div', 'ai-import-photo-actions', fileLabel);
    const choose = label(controlButton(photoActions), 'Wybierz zdjęcie', 'Choose photo');
    choose.id = 'aiImportChoose';
    const cameraButton = label(controlButton(photoActions), 'Zrób zdjęcie', 'Take photo');
    cameraButton.id = 'aiImportCamera';
    const file = photoInput(fileLabel, 'aiImportFile');
    const cameraFile = photoInput(fileLabel, 'aiImportCameraFile');
    cameraFile.setAttribute('capture', 'environment');

    const camera = node('div', 'ai-import-camera', body);
    camera.hidden = true;
    const video = node('video', 'ai-import-camera-video', camera);
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    label(video, 'Podgląd aparatu', 'Live camera preview', 'aria-label');
    const capture = label(controlButton(camera, 'primary'), 'Wykonaj zdjęcie', 'Capture photo');
    capture.id = 'aiImportCapture';
    const cameraCancel = label(controlButton(camera), 'Zamknij aparat', 'Close camera');

    const preview = node('img', 'ai-import-preview', body);
    preview.hidden = true;
    label(preview, 'Podgląd zdjęcia do rozpoznania', 'Preview of the photo to identify', 'alt');
    const analyze = label(controlButton(body, 'primary ai-import-analyze'), 'Rozpoznaj gry', 'Identify games');
    analyze.id = 'aiImportAnalyze';
    const status = node('p', 'ai-import-status', body);
    status.id = 'aiImportStatus';
    return { file, choose, cameraFile, cameraButton, camera, video, capture, cameraCancel, preview, analyze, status };
  }

  function buildReview(body, label) {
    const review = node('div', 'ai-import-review', body);
    review.hidden = true;
    const notes = node('p', 'ai-import-note', review);
    const coverNotice = label(node('p', 'ai-import-note ai-import-cover-notice', review),
      'Nie udało się automatycznie dobrać wszystkich okładek. Możesz wkleić własne adresy lub skorzystać z linków do wyszukiwania.',
      'Some covers could not be matched automatically. You can paste your own URLs or use the search links.');
    coverNotice.hidden = true;
    label(node('p', 'ai-import-review-help', review),
      'Niepewne wyniki i gry już obecne w kolekcji nie są zaznaczone automatycznie. Możesz je poprawić, zaznaczyć lub pominąć.',
      'Uncertain results and games already in your collection are not selected automatically. Correct, select or skip them.');
    const candidates = node('div', 'ai-import-candidates', review);
    candidates.id = 'aiImportCandidates';
    return { review, candidates, notes, coverNotice };
  }

  function buildFooter(dialog, label) {
    const footer = node('div', 'form-actions ai-import-footer', dialog);
    const summary = node('p', 'ai-import-summary', footer);
    summary.setAttribute('aria-live', 'polite');
    const confirmLabel = node('label', 'ai-import-confirm', footer);
    const confirm = node('input', '', confirmLabel);
    confirm.type = 'checkbox';
    confirm.id = 'aiImportConfirm';
    label(node('span', '', confirmLabel), 'Sprawdziłem zaznaczone gry i potwierdzam poprawność ich danych.',
      'I reviewed the selected games and confirm that their details are correct.');
    const retryHint = label(node('p', 'ai-import-retry-hint', footer),
      'Ponowienie użyje tych samych danych. Jeśli zapis się udał, gry nie zostaną dodane drugi raz.',
      'Retrying uses the same details. If the save succeeded, the games will not be added twice.');
    retryHint.hidden = true;
    const actions = node('div', 'ai-import-footer-buttons', footer);
    const cancel = label(controlButton(actions), 'Anuluj', 'Cancel');
    const save = label(controlButton(actions, 'primary'), 'Dodaj zaznaczone gry', 'Add selected games');
    save.id = 'aiImportSave';
    return { summary, confirm, retryHint, cancel, save };
  }

  function buildDialog(backdrop, label) {
    backdrop.replaceChildren();
    const dialog = node('section', 'modal ai-import-modal', backdrop);
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'aiImportTitle');
    dialog.setAttribute('aria-describedby', 'aiImportExplanation');
    const head = node('div', 'modal-head', dialog);
    const heading = node('div', '', head);
    const title = label(node('h2', '', heading), 'Dodaj Gry AI', 'Add Games AI');
    title.id = 'aiImportTitle';
    label(node('p', 'modal-sub', heading), 'Zdjęcie → sprawdzenie wyników → dodanie wybranych gier',
      'Photo → review results → add selected games');
    const close = label(controlButton(head, 'close'), '×', '×');
    label(close, 'Zamknij', 'Close', 'aria-label');

    const body = node('div', 'ai-import-body', dialog);
    const explanation = label(node('p', 'ai-import-explanation', body),
      'Wybierz zdjęcie z maksymalnie 32 grami. Przycisk „Rozpoznaj gry” wysyła zmniejszoną kopię do Google Gemini. Aplikacja szuka okładek w IGDB i SteamGridDB, a gdy nie znajdzie pasującej okładki, sprawdza Wikipedię. Gemini dopasowuje propozycje do gier i platform. Przed dodaniem gier możesz zmienić lub usunąć adresy okładek.',
      'Choose a photo with up to 32 games. Selecting “Identify games” sends a resized copy to Google Gemini. The app searches IGDB and SteamGridDB for covers and checks Wikipedia if it finds no match. Gemini verifies that each suggestion matches the game and platform. You can replace or clear the cover URLs before adding the games.');
    explanation.id = 'aiImportExplanation';
    return { dialog, close, ...buildPhotoControls(body, label), ...buildReview(body, label), ...buildFooter(dialog, label) };
  }

  function create(options) {
    const { button, backdrop } = options;
    if (!button || !backdrop) return null;
    let disposed = false;
    let opened = false;
    let available = false;
    // A session change invalidates the dialog. Within one session, replacing
    // the photo or closing the dialog invalidates the current operation.
    let generation;
    let operation = 0;
    let phase = 'idle';
    let nodes = null;
    let bindings = [];
    let rows = [];
    let photo = null;
    let upload = null;
    let previousCollection;
    let collectionKeys = new Set();
    // Keep an exact batch after an uncertain reply so retrying cannot insert
    // another copy. A definitive rejection lets the user edit it again.
    let pendingSave = null;
    let returnFocus = null;
    let cameraStream = null;
    let cameraGeneration = 0;
    let fieldSequence = 0;
    const controllers = new Set();
    const language = () => options.getLanguage?.() === 'en' ? 'en' : 'pl';
    const text = (polish, english) => language() === 'en' ? english : polish;
    const current = token => opened && !disposed && token === operation && options.isCurrent(generation);
    const busy = () => ['checking', 'preparing', 'camera-opening', 'uploading', 'recognizing', 'saving'].includes(phase);

    function label(element, polish, english, attribute = null) {
      bindings.push({ element, polish, english, attribute });
      if (attribute) element.setAttribute(attribute, text(polish, english));
      else element.textContent = text(polish, english);
      return element;
    }
    function status(polish, english, error = false) {
      if (!nodes) return;
      const old = bindings.find(entry => entry.element === nodes.status);
      if (old) { old.polish = polish; old.english = english; }
      else bindings.push({ element: nodes.status, polish, english, attribute: null });
      nodes.status.textContent = text(polish, english);
      nodes.status.classList.toggle('ai-import-error', error);
      nodes.status.setAttribute('role', error ? 'alert' : 'status');
      nodes.status.setAttribute('aria-live', error ? 'assertive' : 'polite');
    }
    function showError(error) {
      const messages = options.errorText?.(error) || [error?.message || '', error?.englishMessage || error?.message || ''];
      status(messages[0] || 'Nie udało się ukończyć operacji.', messages[1] || 'Could not complete the operation.', true);
    }
    function guard(token) {
      if (!current(token)) throw failure('Operacja została anulowana.', 'The operation was cancelled.');
    }
    async function request(body, token) {
      guard(token);
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      if (controller) controllers.add(controller);
      try {
        const result = await options.request(body, generation, controller?.signal);
        guard(token);
        return result;
      } finally { if (controller) controllers.delete(controller); }
    }
    function retryableChunkError(error) {
      return !error?.status || error.status === 408
        || (error.status === 409 && (!error.payload?.errorId || error.payload.errorId === 'ai_upload_busy'))
        || error.status >= 500;
    }
    async function sendChunk(body, token) {
      // The server accepts the same bytes at the same offset. Retrying the
      // original request is safe even if its first response was lost.
      for (const delay of CHUNK_RETRY_DELAYS) {
        try {
          return await request(body, token);
        } catch (error) {
          guard(token);
          if (!retryableChunkError(error)) throw error;
          status('Ponawiam wysyłanie fragmentu zdjęcia…', 'Retrying this part of the photo upload…');
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      return request(body, token);
    }
    function cancelUpload(id) {
      if (!id || !options.isCurrent(generation)) return;
      Promise.resolve(options.request({ action: 'ai-upload-cancel', uploadId: id }, generation)).catch(() => {});
    }

    function stopTracks(stream) {
      for (const track of stream?.getTracks?.() || []) {
        try { track.stop(); } catch {}
      }
    }
    function stopCamera() {
      cameraGeneration++;
      stopTracks(cameraStream);
      cameraStream = null;
      if (nodes?.video) {
        nodes.video.pause?.();
        nodes.video.srcObject = null;
        nodes.camera.hidden = true;
      }
    }

    // Closing destroys all photo and candidate nodes rather than hiding them.
    // Local bindings never enter the application's persistent language map.
    function close(restoreFocus = true) {
      const previousUpload = upload?.id;
      const focus = returnFocus;
      opened = false;
      operation++;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      stopCamera();
      for (const row of rows) row.preview.destroy();
      if (photo?.bytes) photo.bytes.fill(0);
      if (nodes?.preview) nodes.preview.removeAttribute('src');
      if (nodes?.file) nodes.file.value = '';
      photo = upload = pendingSave = returnFocus = null;
      previousCollection = undefined;
      collectionKeys.clear();
      rows = [];
      bindings = [];
      nodes = null;
      available = false;
      phase = 'idle';
      backdrop.classList.remove('open');
      backdrop.hidden = true;
      backdrop.replaceChildren();
      cancelUpload(previousUpload);
      if (restoreFocus && !disposed && options.isCurrent(generation) && focus?.isConnected) focus.focus();
    }

    function reviewKey(title, platform) {
      const normalize = value => String(value || '').trim().normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ');
      return JSON.stringify([normalize(title), String(platform || '').split(',').map(normalize).sort()]);
    }
    function duplicateFlags() {
      const games = options.getGames?.();
      // Collection updates replace the array. Reuse its index while the user
      // edits candidates, whose own duplicate flags may change on each edit.
      if (games !== previousCollection) {
        collectionKeys = new Set((games || []).map(game => reviewKey(game.title, game.platform)));
        previousCollection = games;
      }
      const keys = rows.map(row => reviewKey(row.title.value, row.platform.value));
      const counts = new Map();
      for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
      return keys.map(key => collectionKeys.has(key) || counts.get(key) > 1);
    }
    function updateSummary() {
      if (!nodes) return;
      const inProgress = busy();
      const draftLocked = inProgress || pendingSave !== null;
      const selected = rows.filter(row => row.selected.checked).length;
      nodes.summary.textContent = text(`Wybrane gry: ${selected} z ${rows.length}.`, `Selected games: ${selected} of ${rows.length}.`);
      nodes.save.disabled = inProgress || !rows.length || !selected || !nodes.confirm.checked;
      nodes.file.disabled = draftLocked;
      nodes.choose.disabled = draftLocked;
      nodes.cameraButton.disabled = draftLocked;
      nodes.cameraFile.disabled = draftLocked;
      nodes.capture.disabled = inProgress || !cameraStream || !(nodes.video.videoWidth > 0 && nodes.video.videoHeight > 0);
      nodes.analyze.disabled = !available || draftLocked || !photo;
      const duplicates = duplicateFlags();
      for (const [index, row] of rows.entries()) {
        for (const field of row.controls) field.disabled = draftLocked;
        row.duplicate.hidden = !duplicates[index];
      }
      nodes.confirm.disabled = inProgress || !rows.length || !selected;
      nodes.close.disabled = phase === 'saving';
      nodes.cancel.disabled = phase === 'saving';
      nodes.review.hidden = rows.length === 0;
      nodes.retryHint.hidden = pendingSave === null;
    }
    function changed() {
      if (!nodes || pendingSave || busy()) return;
      nodes.confirm.checked = false;
      updateSummary();
    }
    function field(parent, polish, english, name, value, type = 'text') {
      const wrapper = node('div', 'ai-import-field', parent);
      const caption = label(node('label', '', wrapper), polish, english);
      const input = node('input', '', wrapper);
      input.id = 'ai-import-field-' + (++fieldSequence);
      caption.setAttribute('for', input.id);
      input.type = type;
      input.value = value;
      input.setAttribute('data-ai-field', name);
      input.addEventListener('input', () => { input.setCustomValidity(''); changed(); });
      input.addEventListener('change', changed);
      return input;
    }
    function selectField(parent, polish, english, name, choices, value) {
      const wrapper = node('label', 'ai-import-field', parent);
      label(node('span', '', wrapper), polish, english);
      const select = node('select', '', wrapper);
      select.setAttribute('data-ai-field', name);
      for (const [polishValue, englishValue] of choices) {
        const option = label(node('option', '', select), polishValue, englishValue);
        option.value = polishValue;
      }
      select.value = value;
      select.addEventListener('change', changed);
      return select;
    }

    function icon(parent, name) {
      // Only application-owned symbol names enter this constant SVG markup.
      parent.innerHTML = `<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="#ui-icon-${name}"></use></svg>`;
    }

    // Each suggestion owns its selected platforms. Shared classes reuse the
    // ordinary form's responsive and theme rules.
    function platformPicker(parent, value, index) {
      const picker = node('fieldset', 'field full platform-picker', parent);
      picker.setAttribute('data-ai-field', 'platform');
      const prefix = 'ai-platform-' + index;
      picker.setAttribute('aria-describedby', prefix + '-help');
      const legend = node('legend', '', picker);
      const heading = node('span', 'platform-picker-label', legend);
      icon(heading, 'gamepad-2');
      label(node('span', '', heading), 'Konsole *', 'Consoles *');
      const count = node('span', 'platform-selection-count', legend);
      const box = node('div', 'platform-console-box', picker);
      const tabs = node('div', 'platform-tabs', box);
      tabs.setAttribute('role', 'tablist');
      label(tabs, 'Producent konsoli', 'Console manufacturer', 'aria-label');
      const panels = node('div', 'platform-options platform-tabs-ready', box);
      const help = label(node('small', 'platform-help', box),
        'Możesz zaznaczyć konsole z kilku grup. Wymagana jest przynajmniej jedna.',
        'You can select consoles from multiple groups. Select at least one.');
      help.id = prefix + '-help';
      const summary = node('div', 'selected-platforms', picker);
      summary.setAttribute('aria-live', 'polite');
      const selected = new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean));
      const presets = (options.platformGroups || [{ name: 'Pozostałe', englishName: 'Other', platforms: options.platforms || [] }])
        .map(group => ({ ...group, platforms: [...group.platforms] }));
      const known = new Set(presets.flatMap(group => group.platforms));
      const extra = [...selected].filter(platform => !known.has(platform));
      if (extra.length) presets.push({ name: 'Inne zapisane konsole', englishName: 'Other saved platforms', platforms: extra });
      const groups = [];
      function activate(group, focus = false) {
        for (const item of groups) {
          const active = item === group;
          item.panel.hidden = !active;
          item.tab.setAttribute('aria-selected', String(active));
          item.tab.tabIndex = active ? 0 : -1;
        }
        if (focus) group?.tab.focus();
      }
      for (const [groupIndex, preset] of presets.entries()) {
        const tab = node('button', 'platform-tab', tabs);
        tab.type = 'button';
        tab.id = prefix + '-tab-' + groupIndex;
        tab.dataset.platformGroup = preset.name;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-controls', prefix + '-panel-' + groupIndex);
        label(node('span', '', tab), preset.name, preset.englishName || preset.name);
        const badge = node('span', 'platform-tab-count', tab);
        const panel = node('fieldset', 'platform-group', panels);
        panel.dataset.platformGroup = preset.name;
        panel.id = prefix + '-panel-' + groupIndex;
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', tab.id);
        label(node('legend', '', panel), preset.name, preset.englishName || preset.name);
        const choices = node('div', 'platform-choice-grid', panel);
        const inputs = preset.platforms.map(platform => {
          const option = node('label', 'platform-option', choices);
          const input = node('input', '', option);
          input.type = 'checkbox';
          input.name = prefix;
          input.value = platform;
          input.checked = selected.has(platform);
          label(node('span', '', option), platform, platform === 'Inna' ? 'Other' : platform);
          input.addEventListener('change', () => {
            for (const group of groups) for (const control of group.inputs) control.setCustomValidity('');
            refresh();
            changed();
          });
          return input;
        });
        const group = { tab, badge, panel, inputs };
        groups.push(group);
        tab.addEventListener('click', () => activate(group));
        tab.addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const target = event.key === 'Home' ? 0 : event.key === 'End' ? groups.length - 1
            : (groups.indexOf(group) + (event.key === 'ArrowRight' ? 1 : -1) + groups.length) % groups.length;
          activate(groups[target], true);
        });
      }
      function refresh() {
        const values = groups.flatMap(group => group.inputs.filter(input => input.checked).map(input => input.value));
        count.textContent = text('Wybrano ' + values.length, values.length + ' selected');
        for (const group of groups) {
          const total = group.inputs.filter(input => input.checked).length;
          group.badge.textContent = total ? String(total) : '';
          group.badge.hidden = total === 0;
        }
        summary.replaceChildren();
        node('span', 'selected-platforms-label', summary).textContent = text('Wybrane:', 'Selected:');
        if (!values.length) {
          node('span', 'selected-platforms-empty', summary).textContent = text('Zaznacz przynajmniej jedną konsolę', 'Select at least one platform');
        }
        for (const platform of values) {
          const chip = node('span', 'selected-platform-chip', summary);
          icon(chip, 'check');
          node('span', '', chip).textContent = platform === 'Inna' ? text('Inna', 'Other') : platform;
        }
      }
      activate(groups.find(group => group.inputs.some(input => input.checked)) || groups[0]);
      refresh();
      return {
        get value() { return groups.flatMap(group => group.inputs.filter(input => input.checked).map(input => input.value)).join(', '); },
        controls: groups.flatMap(group => [group.tab, ...group.inputs]),
        refresh,
        // Native validity belongs to a real, visible checkbox so correction is
        // accessible even if the user was browsing a different manufacturer.
        setCustomValidity(message) { groups[0]?.inputs[0]?.setCustomValidity(message); },
        reportValidity() { activate(groups[0]); return groups[0]?.inputs[0]?.reportValidity(); },
        focus() { activate(groups[0]); groups[0]?.inputs[0]?.focus(); }
      };
    }

    function coverLink(parent, polish, english) {
      const anchor = node('a', 'cover-search', parent);
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
      icon(anchor, 'external-link');
      label(node('span', '', anchor), polish, english);
      return anchor;
    }

    function coverSearchLinks(parent, title) {
      const links = node('div', 'cover-search-links', parent);
      const google = coverLink(links, 'Szukaj w Grafice Google', 'Search Google Images');
      label(google, 'Szukaj okładki w Grafice Google (otwiera nową kartę)', 'Find a cover in Google Images (opens in a new tab)', 'aria-label');
      const coverProject = coverLink(links, 'Szukaj w The Cover Project', 'Search The Cover Project');
      function update() {
        const query = title.value.trim();
        google.href = 'https://www.google.com/search?udm=2&q=' + encodeURIComponent(query ? query + ' game cover' : 'video game cover');
        coverProject.href = 'https://www.thecoverproject.net/view.php?searchstring=' + encodeURIComponent(query);
        coverProject.style.opacity = query ? '1' : '.65';
      }
      title.addEventListener('input', update);
      title.addEventListener('change', update);
      update();
      label(node('small', 'field-help', parent), 'Po wybraniu okładki skopiuj adres obrazu i wklej go powyżej.',
        'Copy the image URL for your chosen cover and paste it above.');
    }

    function coverSuggestion(cover, originalUrl, candidate) {
      const suggestion = node('div', 'ai-import-cover-suggestion cover-search-links', cover.parentElement);
      label(node('span', 'field-help', suggestion), 'Okładka dobrana przez Gemini. Możesz zmienić lub usunąć adres.',
        'Cover selected by Gemini. You can replace or clear the URL.');
      const sourceUrl = coverAddress(candidate.coverSourceUrl, true);
      if (sourceUrl) {
        const provider = COVER_PROVIDERS.get(candidate.coverSource);
        const polish = provider ? `Źródło w ${provider[0]}` : 'Źródło okładki';
        const english = provider ? `Source on ${provider[1]}` : 'Cover source';
        const link = coverLink(suggestion, polish, english);
        if (provider) label(link, `${polish} (otwiera nową kartę)`, `${english} (opens in a new tab)`, 'aria-label');
        link.href = sourceUrl;
      }
      const refresh = () => { suggestion.hidden = cover.value.trim() !== originalUrl; };
      cover.addEventListener('input', refresh);
      cover.addEventListener('change', refresh);
    }

    // A draft cover belongs to one candidate, never to the collection. Cancel
    // pending work before replacing it so late image events cannot expose an
    // older URL or repopulate a skipped, closed or expired private view.
    function candidateCoverPreview(frame, title, cover) {
      label(frame, 'Podgląd okładki', 'Cover preview', 'aria-label');
      const media = node('div', 'cover-preview-media', frame);
      const image = node('img', 'cover-image ai-import-cover-image', media);
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      image.hidden = true;
      const placeholder = node('div', 'cover-preview-placeholder', media);
      icon(placeholder, 'gamepad-2');
      const caption = node('div', '', frame);
      const heading = node('p', 'cover-preview-title', caption);
      const message = node('p', 'cover-preview-status', caption);
      message.setAttribute('role', 'status');
      message.setAttribute('aria-live', 'polite');
      const messages = {
        empty: ['Wklej adres okładki', 'Paste a cover URL'],
        invalid: ['Wpisz poprawny adres okładki', 'Enter a valid cover URL'],
        loading: ['Wczytuję okładkę…', 'Loading cover…'],
        ready: ['Podgląd okładki', 'Cover preview'],
        error: ['Nie udało się wczytać okładki', 'Could not load the cover']
      };
      let previewPhase = 'empty';
      let disposed = false;
      let revision = 0;
      let timer = null;
      let loader = null;
      function refresh() {
        if (disposed) return;
        const name = title.value.trim();
        heading.textContent = name || text('Twoja okładka', 'Your cover');
        message.textContent = text(...messages[previewPhase]);
        image.setAttribute('alt', image.hidden ? '' : name
          ? text('Okładka gry ' + name, 'Game cover for ' + name)
          : text('Podgląd okładki', 'Cover preview'));
      }
      function clearLoader() {
        if (!loader) return;
        loader.onload = loader.onerror = null;
        loader.removeAttribute('src');
        loader = null;
      }
      function clear() {
        revision++;
        clearTimeout(timer);
        timer = null;
        clearLoader();
        image.onload = image.onerror = null;
        image.removeAttribute('src');
        image.hidden = true;
        placeholder.hidden = false;
      }
      function update(immediate = false) {
        if (disposed) return;
        clear();
        const value = cover.value.trim();
        const url = coverAddress(value);
        previewPhase = !value ? 'empty' : !url ? 'invalid' : 'loading';
        refresh();
        if (!url) return;
        const version = revision;
        const token = operation;
        const active = () => !disposed && version === revision && current(token) && frame.isConnected
          && coverAddress(cover.value.trim()) === url;
        function failed() {
          if (!active()) return;
          clearLoader();
          image.onerror = null;
          image.removeAttribute('src');
          image.hidden = true;
          placeholder.hidden = false;
          previewPhase = 'error';
          refresh();
        }
        function load() {
          timer = null;
          if (!active()) return;
          const pending = new Image();
          loader = pending;
          pending.referrerPolicy = 'no-referrer';
          pending.decoding = 'async';
          pending.onerror = failed;
          pending.onload = () => {
            if (!active() || loader !== pending) return;
            clearLoader();
            image.onerror = failed;
            image.src = url;
            image.hidden = false;
            placeholder.hidden = true;
            previewPhase = 'ready';
            refresh();
          };
          pending.src = url;
        }
        if (immediate) load();
        else timer = setTimeout(load, 200);
      }
      const typed = () => update();
      const committed = () => update(true);
      title.addEventListener('input', refresh);
      title.addEventListener('change', refresh);
      cover.addEventListener('input', typed);
      cover.addEventListener('change', committed);
      update(true);
      return {
        refresh,
        destroy() {
          if (disposed) return;
          clear();
          disposed = true;
          title.removeEventListener('input', refresh);
          title.removeEventListener('change', refresh);
          cover.removeEventListener('input', typed);
          cover.removeEventListener('change', committed);
          image.setAttribute('alt', '');
          heading.textContent = message.textContent = '';
        }
      };
    }

    function buildCandidateRow(candidate, index) {
      const card = node('fieldset', 'ai-import-candidate game-modal', nodes.candidates);
      card.setAttribute('data-ai-candidate', String(index));
      label(node('legend', '', card), `Gra ${index + 1}`, `Game ${index + 1}`);
      const top = node('div', 'ai-import-candidate-top', card);
      const include = node('label', 'ai-import-select', top);
      const selected = node('input', '', include);
      selected.type = 'checkbox';
      selected.setAttribute('data-ai-field', 'selected');
      label(node('span', '', include), 'Dodaj tę grę', 'Add this game');
      const confidence = candidate.confidence === 'high' ? 'high' : candidate.confidence === 'medium' ? 'medium' : 'low';
      const badge = node('span', 'ai-import-confidence', top);
      badge.dataset.confidence = confidence;
      const confidenceText = confidence === 'high' ? ['Wyraźny odczyt', 'Clear identification']
        : confidence === 'medium' ? ['Sprawdź wynik', 'Review identification'] : ['Niepewny wynik', 'Uncertain identification'];
      label(badge, ...confidenceText);
      const details = node('div', 'game-details', card);
      const previewFrame = node('aside', 'cover-preview-frame', details);
      const fields = node('div', 'ai-import-fields', details);
      const title = field(fields, 'Tytuł', 'Title', 'title', typeof candidate.title === 'string' ? candidate.title.slice(0, 255) : '');
      title.required = true;
      // HTML length is measured in UTF-16 units. Validate code points at save.
      title.maxLength = 510;
      const edition = selectField(fields, 'Wydanie', 'Edition', 'edition', EDITIONS, 'Fizyczne');
      const gameStatus = selectField(fields, 'Status', 'Status', 'status', STATUSES, 'Do ogrania');
      const suggestedCover = coverAddress(candidate.coverUrl, true);
      const cover = field(fields, 'Adres okładki (opcjonalnie)', 'Cover URL (optional)', 'coverUrl', suggestedCover, 'url');
      cover.maxLength = 2048;
      cover.placeholder = 'https://';
      if (suggestedCover) coverSuggestion(cover, suggestedCover, candidate);
      coverSearchLinks(cover.parentElement, title);
      const preview = candidateCoverPreview(previewFrame, title, cover);
      const platform = platformPicker(card, typeof candidate.platform === 'string' ? candidate.platform.slice(0, 400) : '', index);
      const warning = label(node('p', 'ai-import-warning', card), 'Ta gra i platforma są już w kolekcji lub powtarzają się na tej liście. Zaznacz ją tylko, jeśli chcesz dodać kolejną kopię.',
        'This game and platform are already in your collection or appear more than once in this list. Select it only if you want another copy.');
      const note = node('p', 'ai-import-note', card);
      note.textContent = typeof candidate.note === 'string' ? candidate.note.slice(0, 500) : '';
      note.hidden = !note.textContent;
      const remove = label(controlButton(card, 'secondary ai-import-remove'), 'Pomiń tę grę', 'Skip this game');
      const row = { id: crypto.randomUUID(), createdAt: Date.now(), card, selected, title, platform, edition, status: gameStatus, cover, preview,
        duplicate: warning, controls: [selected, title, ...platform.controls, edition, gameStatus, cover, remove] };
      selected.checked = confidence === 'high' && Boolean(title.value.trim() && platform.value.trim());
      selected.addEventListener('change', changed);
      remove.addEventListener('click', () => {
        if (busy() || pendingSave) return;
        preview.destroy();
        rows = rows.filter(item => item !== row);
        bindings = bindings.filter(entry => !card.contains(entry.element));
        card.remove();
        changed();
        nodes.confirm.focus();
      });
      return row;
    }
    function clearReview() {
      if (!nodes) return;
      for (const row of rows) row.preview.destroy();
      bindings = bindings.filter(entry => !nodes.candidates.contains(entry.element));
      rows = [];
      pendingSave = null;
      nodes.candidates.replaceChildren();
      nodes.confirm.checked = false;
      nodes.notes.textContent = '';
      nodes.coverNotice.hidden = true;
      nodes.review.hidden = true;
    }
    async function prepareSelection(file) {
      if (!opened || busy() || pendingSave) return;
      if (!file) return;
      stopCamera();
      const token = ++operation;
      clearReview();
      cancelUpload(upload?.id);
      upload = null;
      if (photo?.bytes) photo.bytes.fill(0);
      photo = null;
      nodes.preview.removeAttribute('src');
      nodes.preview.hidden = true;
      phase = 'preparing';
      status('Przygotowuję podgląd zdjęcia…', 'Preparing the photo preview…');
      updateSummary();
      try {
        const prepared = await preparePhoto(file);
        if (!current(token)) { prepared.bytes.fill(0); return; }
        photo = prepared;
        nodes.preview.src = photo.preview;
        nodes.preview.hidden = false;
        phase = 'ready';
        if (available) status('Podgląd jest gotowy. Sprawdź zdjęcie i wybierz „Rozpoznaj gry”.', 'The preview is ready. Check the photo and choose “Identify games”.');
        else status(...UNAVAILABLE, true);
      } catch (error) {
        if (!current(token)) return;
        phase = 'idle';
        showError(error);
      } finally { if (current(token)) updateSummary(); }
    }
    function choosePhoto() { return prepareSelection(nodes?.file.files?.[0]); }
    function chooseCameraPhoto() { return prepareSelection(nodes?.cameraFile.files?.[0]); }

    // Camera access starts only after a direct user action. A permission reply
    // arriving after close must stop its stream without reopening the dialog.
    async function startCamera() {
      if (!opened || busy() || pendingSave) return;
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        nodes.cameraFile.value = '';
        nodes.cameraFile.click();
        return;
      }
      stopCamera();
      clearReview();
      cancelUpload(upload?.id);
      upload = null;
      if (photo?.bytes) photo.bytes.fill(0);
      photo = null;
      nodes.preview.removeAttribute('src');
      nodes.preview.hidden = true;
      const token = ++operation;
      const cameraToken = cameraGeneration;
      phase = 'camera-opening';
      status('Zezwól na dostęp do aparatu. Zdjęcie wykonasz dopiero przyciskiem poniżej.',
        'Allow camera access. A photo is taken only when you press the capture button below.');
      updateSummary();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
          facingMode: { ideal: 'environment' }, width: { ideal: 1600 }, height: { ideal: 1200 }
        } });
        if (!current(token) || cameraToken !== cameraGeneration) { stopTracks(stream); return; }
        cameraStream = stream;
        nodes.video.srcObject = stream;
        nodes.camera.hidden = false;
        const playback = nodes.video.play?.();
        playback?.catch(() => {});
        phase = 'camera';
        status('Ustaw gry w kadrze i wybierz „Wykonaj zdjęcie”.', 'Frame the games and choose “Capture photo”.');
      } catch {
        if (!current(token)) return;
        phase = 'idle';
        showError(failure('Nie udało się uruchomić aparatu. Sprawdź uprawnienia i dostępność kamery lub wybierz zdjęcie z urządzenia.',
          'Could not start the camera. Check camera permissions and availability, or choose a photo from your device.'));
      } finally { if (current(token)) updateSummary(); }
    }
    async function capturePhoto() {
      if (!opened || phase !== 'camera' || !cameraStream || busy()) return;
      const width = nodes.video.videoWidth;
      const height = nodes.video.videoHeight;
      if (!(width > 0 && height > 0)) return;
      const token = operation;
      const canvas = document.createElement('canvas');
      try {
        const scale = Math.min(1, 1600 / Math.max(width, height));
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Camera capture unavailable');
        context.drawImage(nodes.video, 0, 0, canvas.width, canvas.height);
        // Freeze the frame first, then release the camera before JPEG encoding.
        stopCamera();
        phase = 'idle';
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .85));
        guard(token);
        if (!blob) throw new Error('Camera capture unavailable');
        await prepareSelection(blob);
      } catch (error) {
        if (!current(token)) return;
        stopCamera();
        phase = 'idle';
        showError(failure('Nie udało się wykonać zdjęcia. Spróbuj ponownie lub wybierz zdjęcie z urządzenia.',
          'Could not capture the photo. Try again or choose a photo from your device.'));
        updateSummary();
      } finally { canvas.width = canvas.height = 1; }
    }
    async function analyze() {
      if (!opened || !available || busy() || !photo || pendingSave) return;
      const token = ++operation;
      clearReview();
      phase = 'uploading';
      status('Przesyłam przygotowane zdjęcie…', 'Uploading the prepared photo…');
      updateSummary();
      try {
        await options.ensureReady(generation);
        guard(token);
        if (!upload || upload.expires <= Date.now()) {
          const start = await request({ action: 'ai-upload-start', size: photo.bytes.length, mime: 'image/jpeg' }, token);
          if (typeof start.uploadId !== 'string' || !/^[a-f0-9]{32}$/i.test(start.uploadId) || start.offset !== 0) {
            throw failure('Nie udało się rozpocząć przesyłania zdjęcia.', 'Could not start the photo upload.');
          }
          const chunkBytes = Number.isInteger(start.chunkBytes) && start.chunkBytes > 0 && start.chunkBytes <= MAX_CHUNK_BYTES
            ? start.chunkBytes : 32768;
          const lifetime = Number.isInteger(start.expiresIn) && start.expiresIn > 0 ? start.expiresIn : 900;
          upload = { id: start.uploadId, offset: 0, chunkBytes, expires: Date.now() + lifetime * 1000 };
        }
        while (upload.offset < photo.bytes.length) {
          guard(token);
          const { id, offset, chunkBytes } = upload;
          const end = Math.min(photo.bytes.length, offset + chunkBytes);
          const result = await sendChunk({ action: 'ai-upload-chunk', uploadId: id, offset,
            data: base64(photo.bytes.subarray(offset, end)) }, token);
          if (result.offset !== end) {
            cancelUpload(id);
            upload = null;
            throw failure('Przesyłanie zdjęcia zostało przerwane. Spróbuj ponownie.', 'The photo upload was interrupted. Try again.');
          }
          upload.offset = end;
          const percent = Math.round(end / photo.bytes.length * 100);
          status(`Przesyłam zdjęcie: ${percent}%.`, `Uploading photo: ${percent}%.`);
        }
        phase = 'recognizing';
        status('Rozpoznaję gry i dobieram okładki…', 'Identifying games and finding covers…');
        const result = await request({ action: 'ai-recognize', uploadId: upload.id }, token);
        upload = null;
        if (!Array.isArray(result.candidates) || result.candidates.length > MAX_GAMES || result.candidates.some(item => !item || typeof item !== 'object')) {
          throw failure('Otrzymano niepoprawny wynik rozpoznawania.', 'The identification result was invalid.');
        }
        rows = result.candidates.map(buildCandidateRow);
        for (const [index, duplicate] of duplicateFlags().entries()) {
          if (duplicate) rows[index].selected.checked = false;
        }
        nodes.notes.textContent = typeof result.notes === 'string' ? result.notes.slice(0, 1500) : '';
        nodes.coverNotice.hidden = result.coverSearch !== 'unavailable';
        phase = 'review';
        status(rows.length ? 'Sprawdź tytuły, platformy i okładki. Popraw wyniki i wybierz gry do dodania.' : 'Nie znaleziono gier. Wybierz wyraźniejsze zdjęcie.',
          rows.length ? 'Review titles, platforms and covers. Correct the results and select games to add.' : 'No games were found. Choose a clearer photo.');
        if (rows.length) rows[0].title.focus();
      } catch (error) {
        if (!current(token)) return;
        const recognizing = phase === 'recognizing';
        const canResume = phase === 'uploading' && upload && upload.expires > Date.now() && retryableChunkError(error);
        if (!canResume) {
          cancelUpload(upload?.id);
          upload = null;
        }
        phase = 'ready';
        if (canResume) {
          status('Nie udało się przesłać całego zdjęcia. Wybierz „Rozpoznaj gry”, aby wznowić przesyłanie.',
            'Could not finish uploading the photo. Select “Identify games” to resume the upload.', true);
        } else if (recognizing && !error?.status && !error?.englishMessage) {
          status('Utracono połączenie w trakcie rozpoznawania zdjęcia. Wybierz „Rozpoznaj gry”, aby zacząć ponownie.',
            'The connection was lost while identifying games. Select “Identify games” to start again.', true);
        } else showError(error);
      } finally { if (current(token)) updateSummary(); }
    }
    function selectedGames() {
      const bytes = value => new TextEncoder().encode(value).length;
      return rows.filter(row => row.selected.checked).map(row => {
        const title = row.title.value.trim();
        const platform = row.platform.value.trim();
        const cover = row.cover.value.trim();
        const coverUrl = coverAddress(cover, true);
        const controls = /[\u0000-\u001f\u007f]/;
        const invalid = !title || Array.from(title).length > 255 || bytes(title) > 1020 || controls.test(title) ? row.title
          : !platform || Array.from(platform.replace(/,\s*/g, ',')).length > 400 || controls.test(platform) ? row.platform : null;
        if (invalid) {
          invalid.setCustomValidity(text('Uzupełnij poprawny tytuł i platformę. Skróć zbyt długie wartości.', 'Enter a valid title and platform. Shorten values that are too long.'));
          invalid.reportValidity(); invalid.focus();
          throw failure('Popraw zaznaczone gry przed dodaniem.', 'Correct the selected games before adding them.');
        }
        if (cover && !coverUrl) {
          row.cover.setCustomValidity(text('Podaj poprawny adres HTTPS bez danych logowania albo pozostaw pole puste.', 'Enter a valid HTTPS URL without credentials, or leave this field blank.'));
          row.cover.reportValidity(); row.cover.focus();
          throw failure('Popraw adres okładki przed dodaniem.', 'Correct the cover URL before adding games.');
        }
        return { id: row.id, title, platform, edition: row.edition.value, status: row.status.value, coverUrl, createdAt: row.createdAt };
      });
    }
    async function save() {
      if (!opened || busy() || !nodes.confirm.checked || !rows.some(row => row.selected.checked)) return;
      const token = operation;
      phase = 'saving';
      updateSummary();
      try {
        await options.ensureReady(generation);
        guard(token);
        if (!pendingSave) pendingSave = selectedGames();
        if (!pendingSave.length || pendingSave.length > MAX_GAMES) throw new Error('Invalid selection');
        const body = { action: 'ai-add', confirmed: true, games: pendingSave, delta: true };
        if (new TextEncoder().encode(JSON.stringify(body)).length > 65536) {
          pendingSave = null;
          throw failure('Wybrane dane są zbyt duże. Skróć adresy okładek lub dodaj mniej gier naraz.', 'The selected data is too large. Shorten cover URLs or add fewer games at once.');
        }
        status('Dodaję potwierdzone gry…', 'Adding the confirmed games…');
        updateSummary();
        const result = await request(body, token);
        if (!(Array.isArray(result.addedGames) || Array.isArray(result.games))
          || !Number.isInteger(result.inserted) || result.inserted < 0 || result.inserted > pendingSave.length) {
          throw failure('Nie udało się potwierdzić zapisu gier. Możesz bezpiecznie ponowić zapis.', 'The game save could not be confirmed. You can safely retry it.');
        }
        options.onSaved(result, pendingSave.length);
        close();
      } catch (error) {
        if (!current(token)) return;
        // These statuses reject this attempt. Transport failures may have
        // happened after commit, so keep the batch available for exact replay.
        if ([400, 409, 413, 415, 422].includes(error?.status)) pendingSave = null;
        phase = 'review';
        showError(error);
        updateSummary();
      }
    }

    function bindDialogControls() {
      nodes.close.addEventListener('click', () => close());
      nodes.file.addEventListener('change', choosePhoto);
      nodes.choose.addEventListener('click', () => {
        nodes.file.value = '';
        nodes.file.click();
      });
      nodes.cameraButton.addEventListener('click', startCamera);
      nodes.cameraFile.addEventListener('change', chooseCameraPhoto);
      nodes.video.addEventListener('loadedmetadata', updateSummary);
      nodes.capture.addEventListener('click', capturePhoto);
      nodes.cameraCancel.addEventListener('click', () => {
        stopCamera();
        phase = 'idle';
        if (available) status('Możesz wybrać zdjęcie lub ponownie uruchomić aparat.', 'Choose a photo or start the camera again.');
        else status(...UNAVAILABLE, true);
        updateSummary();
      });
      nodes.analyze.addEventListener('click', analyze);
      nodes.confirm.addEventListener('change', updateSummary);
      nodes.cancel.addEventListener('click', () => { if (phase !== 'saving') close(); });
      nodes.save.addEventListener('click', save);
    }
    async function open() {
      if (disposed || opened) return;
      generation = options.getGeneration();
      if (!options.isCurrent(generation)) return;
      returnFocus = document.activeElement;
      if (options.beforeOpen?.() === false) return;
      opened = true;
      const token = ++operation;
      available = false;
      phase = 'checking';
      nodes = buildDialog(backdrop, label);
      bindDialogControls();
      backdrop.hidden = false;
      backdrop.classList.add('open');
      status('Sprawdzam dostępność rozpoznawania AI…', 'Checking AI identification availability…');
      updateSummary();
      nodes.close.focus();
      try {
        await options.ensureReady(generation);
        guard(token);
        const result = await request({ action: 'ai-status' }, token);
        phase = 'idle';
        available = result.available === true;
        if (!available) {
          status(...UNAVAILABLE, true);
          options.notify?.(...UNAVAILABLE);
        } else {
          status('Wybierz zdjęcie, aby przygotować podgląd. Na tym etapie nic nie jest wysyłane do Google Gemini.',
            'Choose a photo to prepare a preview. Nothing is sent to Google Gemini at this stage.');
          nodes.choose.focus();
        }
      } catch (error) {
        if (!current(token)) return;
        phase = 'idle';
        showError(error);
      } finally { if (current(token)) updateSummary(); }
    }
    function refreshLanguage() {
      for (const entry of bindings) {
        if (entry.attribute) entry.element.setAttribute(entry.attribute, text(entry.polish, entry.english));
        else entry.element.textContent = text(entry.polish, entry.english);
      }
      for (const row of rows) { row.platform.refresh(); row.preview.refresh(); }
      updateSummary();
    }
    function keydown(event) {
      if (!opened || !nodes) return;
      if (event.key === 'Escape') { event.preventDefault(); if (phase !== 'saving') close(); return; }
      if (event.key !== 'Tab') return;
      const fields = [...nodes.dialog.querySelectorAll('button, input, select, textarea, a[href]')]
        .filter(element => element.tabIndex !== -1 && !element.disabled && !element.hidden && !element.closest('[hidden]'));
      const first = fields[0], last = fields.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    const click = () => { void open(); };
    const outside = event => { if (event.target === backdrop && phase !== 'saving') close(); };
    button.addEventListener('click', click);
    backdrop.addEventListener('click', outside);
    document.addEventListener('keydown', keydown);
    backdrop.hidden = true;
    return {
      open, close, refreshLanguage,
      clearPrivateData() { close(false); },
      destroy() {
        if (disposed) return;
        close(false);
        disposed = true;
        button.removeEventListener('click', click);
        backdrop.removeEventListener('click', outside);
        document.removeEventListener('keydown', keydown);
      }
    };
  }

  window.SavepointAiImport = Object.freeze({ create });
})();
