// Read and write collection backups using the same game shape as the API.
// File limits apply separately because import re-serializes the JSON.
const MAX_IMPORT_FILE_BYTES = 16 * 1024 * 1024;
const IMPORT_CHUNK_BYTES = 32768;
const MAX_IMPORT_GAMES = 5000;
let importPending = null;

function clearCollectionImport() {
  $('importFile').value = '';
  importPending = null;
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
      || !game.title.trim() || Array.from(game.title.trim()).length > 255 || !gamePlatforms(game.platform).length)) {
    throw uiError('Plik JSON nie zawiera poprawnej kolekcji gier.', 'The JSON file does not contain a valid game collection.');
  }
  if (records.length > MAX_IMPORT_GAMES) {
    throw uiError('Plik zawiera ponad 5000 gier.', 'The file contains more than 5,000 games.');
  }
  return records.map(record => ({
    ...backupGame(record),
    platform: Array.isArray(record.platform) ? platformListForStorage(gamePlatforms(record.platform)) : record.platform,
    id: record.id || crypto.randomUUID(),
    createdAt: record.createdAt ?? Date.now()
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

// Small imports fit in one JSON request. Larger imports use a private staging
// upload with decoded byte offsets. Its final request applies the collection
// once, and a lost reply can be retried with the same upload ID.
async function submitCollectionTransfer(mode, records, generation) {
  const collection = normalizeImportedGames(records);
  const encoder = new TextEncoder();
  const singleRequest = { action: mode, games: collection };
  if (encoder.encode(JSON.stringify(singleRequest)).byteLength <= MAX_REQUEST_BYTES) {
    return apiRequest('POST', singleRequest, generation);
  }
  const bytes = encoder.encode(JSON.stringify(collection));
  if (bytes.byteLength > MAX_IMPORT_FILE_BYTES) {
    throw uiError('Kolekcja przekracza limit importu 16 MiB.', 'The collection exceeds the 16 MiB import limit.');
  }
  const start = await apiRequest('POST', {
    action: 'collection-upload-start', mode, size: bytes.byteLength
  }, generation);
  if (typeof start.uploadId !== 'string' || !start.uploadId || start.offset !== 0) {
    throw uiError('Nie udało się rozpocząć przesyłania kolekcji.', 'Could not start the collection upload.');
  }
  const uploadId = start.uploadId;
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += IMPORT_CHUNK_BYTES) {
      const end = Math.min(offset + IMPORT_CHUNK_BYTES, bytes.byteLength);
      const data = btoa(String.fromCharCode(...bytes.subarray(offset, end)));
      const chunk = await sendCollectionPart({ action: 'collection-upload-chunk', uploadId, offset, data }, generation);
      if (chunk.offset !== end) {
        throw uiError('Zapis przesyłanej kolekcji został przerwany.', 'The collection upload was interrupted.');
      }
    }
    return await sendCollectionPart({ action: 'collection-upload-finish', uploadId }, generation);
  } catch (error) {
    if (!ignoredSessionError(error) && generation === sessionGeneration) {
      // Cancel unfinished staging and reload the database view if the commit
      // result is unknown.
      void apiRequest('POST', { action: 'collection-upload-cancel', uploadId }, generation).catch(() => {});
      if (error.payload?.code === 'collection_upload_uncertain' || error.timeout || error instanceof TypeError) {
        await apiRequest('GET', undefined, generation, { reloadCollection: true }).catch(() => {});
      }
    }
    throw error;
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
  // Read and validate a bounded JSON file, then require explicit confirmation
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
      if (file.size > MAX_IMPORT_FILE_BYTES) {
        throw uiError('Plik importu przekracza limit 16 MiB.', 'The import file exceeds the 16 MiB limit.');
      }
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
        await submitCollectionTransfer('replace', collection, generation);
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
