// Read and write collection backups using the same game shape as the API.
let importPending = null;
let collectionUpload = null;
let previousCollectionUpload = null;

function clearCollectionImport() {
  $('importFile').value = '';
  importPending = null;
  collectionUpload = null;
  previousCollectionUpload = null;
}

function backupGame({ id, title, platform, edition, coverUrl, status, createdAt }) {
  return { id, title, platform, edition, coverUrl, status, createdAt };
}

function platformListForStorage(platforms) {
  const spaced = platforms.join(', ');
  return Array.from(spaced).length <= 400 ? spaced : platforms.join(',');
}

function normalizeImportedGames(records) {
  if (!Array.isArray(records) || records.some(game => !game || typeof game.title !== 'string'
      || !game.title.trim() || Array.from(game.title.trim()).length > 255
      || (typeof game.platform !== 'string' && (!Array.isArray(game.platform)
        || !game.platform.every(platform => typeof platform === 'string')))
      || !gamePlatforms(game.platform).length)) {
    throw uiError('Plik JSON nie zawiera poprawnej kolekcji gier.', 'The JSON file does not contain a valid game collection.');
  }
  return records.map(record => ({
    ...backupGame(record),
    platform: Array.isArray(record.platform) ? platformListForStorage(gamePlatforms(record.platform)) : record.platform,
  }));
}

// Retry only when the response was lost or the server was temporarily
// unavailable. Chunks and the final action support replay with the same ID.
async function sendCollectionPart(body, generation) {
  try { return await apiRequest('POST', body, generation); }
  catch (error) {
    if (ignoredSessionError(error)
        || !(error.timeout || error instanceof TypeError || [502, 503, 504].includes(error.status))) throw error;
    return apiRequest('POST', body, generation);
  }
}

function fitsCollectionRequest({ action, games }, encoder) {
  if (games.length > 5000) return false;
  let bytes = encoder.encode(JSON.stringify({ action, games: [] })).byteLength;
  for (const [index, game] of games.entries()) {
    bytes += encoder.encode(JSON.stringify(game)).byteLength + (index === 0 ? 0 : 1);
    if (bytes > MAX_REQUEST_BYTES) return false;
  }
  return true;
}

function* collectionGroups(collection, encoder) {
  let group = [];
  let bytes = 0;
  for (const game of collection) {
    const size = encoder.encode(JSON.stringify(game)).byteLength + 1;
    if (group.length && (group.length === 128 || bytes + size > 48000)) {
      yield group;
      group = [];
      bytes = 0;
    }
    group.push(game);
    bytes += size;
  }
  if (group.length) yield group;
}

// Stage large JSON backups in normalized groups for one final transaction.
async function submitCollectionTransfer(mode, records, generation, normalize = true) {
  const collection = normalize ? normalizeImportedGames(records) : records;
  const encoder = new TextEncoder();
  const singleRequest = { action: mode, games: collection };
  if (fitsCollectionRequest(singleRequest, encoder)) {
    return apiRequest('POST', singleRequest, generation);
  }
  const transfer = { id: crypto.randomUUID().replaceAll('-', ''), generation };
  const previous = previousCollectionUpload;
  collectionUpload = transfer;
  try {
    const start = await sendCollectionPart({ action: 'collection-upload-start', uploadId: transfer.id, mode,
      size: collection.length, format: 'rows',
      ...(previous?.generation === generation && previous.id !== transfer.id ? { supersedes: previous.id } : {}),
    }, generation);
    if (typeof start.uploadId !== 'string' || !start.uploadId || start.offset !== 0) {
      throw uiError('Nie udało się rozpocząć przesyłania kolekcji.', 'Could not start the collection upload.');
    }
    if (previousCollectionUpload === previous) previousCollectionUpload = null;
    const uploadId = transfer.id = start.uploadId;
    let offset = 0;
    for (const games of collectionGroups(collection, encoder)) {
      const group = await sendCollectionPart({ action: 'collection-upload-group', uploadId, offset, games }, generation);
      offset += games.length;
      if (group.offset !== offset) {
        throw uiError('Zapis przesyłanej kolekcji został przerwany.', 'The collection upload was interrupted.');
      }
    }
    return await sendCollectionPart({ action: 'collection-upload-finish', uploadId }, generation);
  } catch (error) {
    if (!ignoredSessionError(error) && generation === sessionGeneration) {
      // Cancel unfinished staging and reload the database view if the commit
      // result is unknown.
      previousCollectionUpload = transfer;
      void apiRequest('POST', { action: 'collection-upload-cancel', uploadId: transfer.id }, generation).catch(() => {});
      if (error.payload?.code === 'collection_upload_uncertain' || error.timeout || error instanceof TypeError) {
        await apiRequest('GET', undefined, generation, { reloadCollection: true }).catch(() => {});
      }
    }
    throw error;
  } finally {
    if (collectionUpload === transfer) collectionUpload = null;
  }
}

// Release the object URL once the browser has started the download.
function downloadCollectionJson(contents, filename) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function initializeCollectionTransfer() {
  addEventListener('pagehide', event => {
    if (event.persisted || !collectionUpload || collectionUpload.generation !== sessionGeneration) return;
    void fetch(API_URL, { method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'collection-upload-cancel', uploadId: collectionUpload.id }),
    }).catch(() => {});
  });
  $('exportBtn').onclick = () => {
    if (!privateViewUsable()) return;
    downloadCollectionJson(JSON.stringify(games.map(backupGame)), 'savepoint-kolekcja.json');
    notify('Kopia kolekcji pobrana', 'Collection backup downloaded');
  };
  // A failed migration must leave a recovery path. On shared devices the owner
  // can download the original bytes and then clear only the legacy local copy.
  const downloadLegacyButton = $('downloadLegacyBtn');
  if (downloadLegacyButton) downloadLegacyButton.onclick = () => {
    if (!privateViewUsable()) return;
    const original = readLegacyArchive();
    if (original !== null) downloadCollectionJson(original, 'savepoint-stara-kolekcja.json');
  };
  const removeLegacyButton = $('removeLegacyBtn');
  if (removeLegacyButton) removeLegacyButton.onclick = () => {
    if (!privateViewUsable() || readLegacyArchive() === null) return;
    if (!confirm(uiText('Czy zapisałeś plik ze starszą kolekcją? Potwierdź, aby usunąć jej kopię z tej przeglądarki.',
      'Have you saved the older collection file? Confirm to remove its copy from this browser.'))) return;
    try {
      localStorage.removeItem(LEGACY_KEY);
      showLegacyArchiveControls(false);
      notify('Usunięto starszą kopię z przeglądarki', 'Removed the older copy from this browser');
    } catch {
      notify('Nie udało się usunąć starszej kopii', 'Could not remove the older copy');
    }
  };
  $('importBtn').onclick = () => { if (!importPending && privateViewUsable()) $('importFile').click(); };
  // Read and validate the JSON file, then require explicit confirmation
  // before asking the server to replace the current collection.
  $('importFile').onchange = async event => {
    const file = event.target.files[0];
    if (!file) {
      event.target.value = '';
      return;
    }
    if (importPending) return;
    const generation = sessionGeneration;
    const pending = {};
    const input = event.target;
    // Clear the picker immediately so the same backup can be retried. A late
    // result must not clear the value of a file picked by a newer session.
    input.value = '';
    importPending = pending;
    try {
      await ensurePrivateSessionReady(generation);
      ensureCurrentSession(generation);
      let imported;
      try { imported = JSON.parse(await file.text()); }
      catch {
        throw uiError('Nie udało się odczytać pliku JSON. Wybierz poprawny eksport Savepoint.',
          'Could not read the JSON file. Choose a valid Savepoint export.');
      }
      ensureCurrentSession(generation);
      await ensurePrivateSessionReady(generation);
      const collection = normalizeImportedGames(imported);
      const count = collection.length;
      const unit = count === 1 ? 'game' : 'games';
      if (confirm(uiText(`Zaimportować ${count} gier? Obecna kolekcja zostanie zastąpiona.`,
        `Import ${count} ${unit}? This will replace your current collection.`))) {
        ensureCurrentSession(generation);
        await submitCollectionTransfer('replace', collection, generation, false);
        ensureCurrentSession(generation);
        notify('Kolekcja zaimportowana do bazy danych', 'Collection imported into the database');
      }
    } catch (error) {
      if (!ignoredSessionError(error) && generation === sessionGeneration && !logoutPending) {
        alert(uiText(...uiErrorText(error)) || uiText('Nie udało się zaimportować kolekcji.', 'Could not import the collection.'));
      }
    } finally {
      if (importPending === pending) {
        importPending = null;
      }
    }
  };
}
