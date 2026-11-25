// Gemini proposes pairs. Collection writes require a separate, explicit choice.
(() => {
  'use strict';

  const EDITIONS = ['Fizyczne', 'Cyfrowe', 'Fizyczne i cyfrowe'];

  function element(parent, tag, className = '') {
    const child = document.createElement(tag);
    child.className = className;
    parent.append(child);
    return child;
  }

  function control(parent, className = 'secondary') {
    const button = element(parent, 'button', className);
    button.type = 'button';
    return button;
  }

  function platforms(game) {
    return game.platform.split(',').map(platform => platform.trim()).filter(Boolean);
  }

  function validPair(pair) {
    const validGame = game => typeof game?.id === 'string' && game.id !== ''
      && typeof game.title === 'string' && typeof game.platform === 'string';
    return typeof pair?.ticket === 'string' && pair.ticket !== ''
      && ['merge', 'delete'].includes(pair.recommendation) && validGame(pair.left)
      && validGame(pair.right) && pair.left.id !== pair.right.id;
  }

  function create(options) {
    const { button, backdrop } = options;
    if (!button || !backdrop) return null;

    let opened = null;
    let pendingWrite = false;
    const language = () => options.getLanguage() === 'en' ? 'en' : 'pl';
    const text = (polish, english) => language() === 'en' ? english : polish;
    const current = view => opened === view && options.isCurrent(view.generation);
    const gameLabel = (field, value) => options.gameLabel?.(field, value) || value;
    const platformLabels = values => values.map(platform => gameLabel('platform', platform)).join(', ');

    function label(bindings, node, polish, english, attribute) {
      const update = () => {
        const value = text(polish, english);
        if (attribute) node.setAttribute(attribute, value);
        else node.textContent = value;
      };
      bindings.push(update);
      update();
      return node;
    }

    function updateStatus(view) {
      const status = view.status;
      view.notice.hidden = status === null;
      view.notice.textContent = status ? text(status.polish, status.english) : '';
      view.notice.classList.toggle('duplicates-error', Boolean(status?.error));
      view.notice.setAttribute('role', status?.error ? 'alert' : 'status');
    }

    function status(view, polish, english, error = false) {
      view.status = { polish, english, error };
      updateStatus(view);
    }

    function showError(view, error, polish, english) {
      const translated = error?.payload?.error || error?.englishMessage ? options.errorText?.(error) : null;
      status(view, translated?.[0] || polish, translated?.[1] || english, true);
    }

    function updateControls(view) {
      const busy = Boolean(view.scan || pendingWrite);
      view.scanButton.disabled = busy;
      view.scanButton.textContent = view.cursor
        ? text('Sprawdź kolejne pary z Gemini', 'Check more pairs with Gemini')
        : text('Sprawdź z Gemini', 'Check with Gemini');
      view.results.setAttribute('aria-busy', String(busy));
      for (const panel of view.panels) {
        for (const radio of panel.radios) radio.disabled = busy;
        panel.merge.disabled = busy || panel.keepId === null;
        panel.remove.disabled = busy || panel.keepId === null;
        panel.cancel.disabled = busy;
        panel.apply.disabled = busy;
      }
    }

    function selectedGames(panel) {
      return panel.keepId === panel.pair.left.id ? [panel.pair.left, panel.pair.right]
        : [panel.pair.right, panel.pair.left];
    }

    function refreshPreview(panel) {
      if (!panel.mode) return;
      const [keep, remove] = selectedGames(panel);
      const merge = panel.mode === 'merge';
      panel.preview.textContent = text(`Po potwierdzeniu wpis „${remove.title}” zostanie usunięty.`,
        `Confirm to remove the entry “${remove.title}”.`);
      panel.mergeDetails.hidden = !merge;
      if (merge) {
        // Keep the preview in step with the server's edition and platform merge.
        const combineEditions = EDITIONS.includes(keep.edition) && EDITIONS.includes(remove.edition)
          && keep.edition !== remove.edition;
        const edition = combineEditions ? 'Fizyczne i cyfrowe' : keep.edition;
        panel.mergedPlatforms.textContent = platformLabels([...new Set([...platforms(keep), ...platforms(remove)])]);
        panel.mergedEdition.textContent = gameLabel('edition', edition || '') || '—';
      }
      panel.apply.textContent = merge ? text('Potwierdź połączenie', 'Confirm merge') : text('Potwierdź usunięcie', 'Confirm removal');
    }

    function chooseAction(view, panel, mode) {
      if (!current(view) || pendingWrite || view.scan || panel.keepId === null) return;
      for (const other of view.panels) {
        other.mode = null;
        other.confirmation.hidden = true;
      }
      panel.mode = mode;
      refreshPreview(panel);
      panel.confirmation.hidden = false;
      panel.cancel.focus();
    }

    function addRecord(view, panel, group, game, index) {
      const card = element(group, 'div', 'duplicates-record');
      const choice = element(card, 'label', 'duplicates-keep');
      const radio = element(choice, 'input');
      radio.type = 'radio';
      radio.name = 'duplicates-keep-' + index;
      radio.value = game.id;
      const name = element(choice, 'span');
      element(name, 'strong').textContent = game.title;
      label(panel.bindings, element(name, 'small'), 'Zachowaj ten wpis', 'Keep this entry');
      panel.radios.push(radio);
      radio.addEventListener('change', () => {
        if (!current(view) || !radio.checked) return;
        panel.keepId = game.id;
        panel.mode = null;
        panel.confirmation.hidden = true;
        updateControls(view);
      });

      const details = element(card, 'dl', 'duplicates-details');
      const other = game === panel.pair.left ? panel.pair.right : panel.pair.left;
      const coverLabel = () => {
        if (!game.coverUrl) return text('Brak', 'None');
        if (other.coverUrl && game.coverUrl !== other.coverUrl) {
          return text('Inna niż w drugim wpisie', 'Different from the other entry');
        }
        return text('Przypisana', 'Assigned');
      };
      const fields = [
        ['Platformy', 'Platforms', () => platformLabels(platforms(game))],
        ['Wydanie', 'Edition', () => gameLabel('edition', game.edition || '')],
        ['Status', 'Status', () => gameLabel('status', game.status || '')],
        ['Okładka', 'Cover', coverLabel]
      ];
      if (Number.isSafeInteger(game.createdAt) && game.createdAt > 0) {
        const date = new Date(game.createdAt);
        if (Number.isFinite(date.getTime())) fields.push(['Dodano', 'Added', () => date.toLocaleDateString(language())]);
      }
      for (const [polish, english, value] of fields) {
        label(panel.bindings, element(details, 'dt'), polish, english);
        const node = element(details, 'dd');
        const update = () => { node.textContent = value() || '—'; };
        panel.bindings.push(update);
        update();
      }
    }

    function addPanel(view, pair, index) {
      const panel = { pair, bindings: [], radios: [], keepId: null, mode: null };
      const row = element(view.results, 'fieldset', 'duplicates-pair');
      panel.row = row;
      if (pair.recommendation === 'merge') {
        label(panel.bindings, element(row, 'legend'), 'Sugerowane połączenie', 'Suggested merge');
      } else {
        label(panel.bindings, element(row, 'legend'), 'Sugerowane usunięcie powtórzenia', 'Suggested removal');
      }
      const records = element(row, 'div', 'duplicates-records');
      addRecord(view, panel, records, pair.left, index);
      addRecord(view, panel, records, pair.right, index);

      const actions = element(row, 'div', 'duplicates-actions');
      panel.merge = label(panel.bindings, control(actions, pair.recommendation === 'merge' ? 'primary' : 'secondary'),
        'Połącz wpisy', 'Merge entries');
      panel.remove = label(panel.bindings, control(actions, pair.recommendation === 'delete' ? 'primary' : 'secondary'),
        'Usuń drugi wpis', 'Remove the other entry');
      panel.merge.addEventListener('click', () => chooseAction(view, panel, 'merge'));
      panel.remove.addEventListener('click', () => chooseAction(view, panel, 'delete'));

      panel.confirmation = element(row, 'div', 'duplicates-confirmation');
      panel.confirmation.hidden = true;
      panel.preview = element(panel.confirmation, 'p');
      panel.mergeDetails = element(panel.confirmation, 'dl', 'duplicates-details duplicates-merged-details');
      label(panel.bindings, element(panel.mergeDetails, 'dt'), 'Platformy po połączeniu', 'Merged platforms');
      panel.mergedPlatforms = element(panel.mergeDetails, 'dd');
      label(panel.bindings, element(panel.mergeDetails, 'dt'), 'Wydanie po połączeniu', 'Merged edition');
      panel.mergedEdition = element(panel.mergeDetails, 'dd');
      const confirmActions = element(panel.confirmation, 'div', 'duplicates-actions');
      panel.cancel = label(panel.bindings, control(confirmActions), 'Wróć', 'Go back');
      panel.apply = control(confirmActions, 'primary');
      panel.cancel.addEventListener('click', () => {
        const previous = panel.mode === 'merge' ? panel.merge : panel.remove;
        panel.mode = null;
        panel.confirmation.hidden = true;
        previous.focus();
      });
      panel.apply.addEventListener('click', () => void apply(view, panel));
      view.panels.push(panel);
    }

    function clearProposals(view) {
      view.cursor = null;
      view.limit.hidden = true;
      view.results.replaceChildren();
      view.panels = [];
      view.nextPanel = 0;
    }

    async function scan(view) {
      if (!current(view) || view.scan || pendingWrite) return;
      const controller = new AbortController();
      view.scan = controller;
      // The cursor belongs to the current collection snapshot. A continuation
      // appends to this review, while a new scan starts with an empty list.
      if (!view.cursor) clearProposals(view);
      status(view, view.cursor ? 'Sprawdzam kolejne pary…' : 'Sprawdzam kolekcję…',
        view.cursor ? 'Checking more pairs…' : 'Checking the collection…');
      updateControls(view);

      try {
        await options.ensureReady(view.generation);
        if (!current(view)) return;
        const body = { action: 'ai-duplicates-scan' };
        if (view.cursor) body.cursor = view.cursor;
        const result = await options.request(body, view.generation, controller.signal);
        if (!current(view)) return;
        if (!Array.isArray(result?.pairs) || !result.pairs.every(validPair)) throw new Error('Invalid duplicate scan response');
        view.cursor = typeof result.cursor === 'string' && result.cursor ? result.cursor : null;
        view.limit.hidden = !view.cursor && result.limited !== true;
        result.pairs.forEach(pair => addPanel(view, pair, view.nextPanel++));
        if (result.pairs.length) {
          status(view, 'Sprawdź propozycje i wybierz, które wpisy zachować.', 'Review the suggestions and choose which entries to keep.');
        } else {
          status(view, 'Nie znaleziono powtórzeń w sprawdzonych parach.', 'No duplicates were found among the pairs checked.');
        }
      } catch (error) {
        if (!current(view)) return;
        if (error?.status === 409 && view.cursor) clearProposals(view);
        showError(view, error, 'Nie udało się sprawdzić powtórzeń.', 'Could not check for duplicates.');
      } finally {
        view.scan = null;
        if (current(view)) updateControls(view);
      }
    }

    async function apply(view, panel) {
      if (!current(view) || pendingWrite || view.scan || !panel.mode || panel.keepId === null) return;
      const { mode, keepId } = panel;
      const affected = [panel.pair.left.id, panel.pair.right.id];
      let writeDispatched = false;
      pendingWrite = true;
      status(view, 'Zapisuję potwierdzoną zmianę…', 'Saving the confirmed change…');
      updateControls(view);

      try {
        await options.ensureReady(view.generation);
        if (!current(view)) return;
        // Do not attach a cancellation signal to a collection write. Closing
        // the dialog must not make the result of a confirmed update ambiguous.
        writeDispatched = true;
        const result = await options.request({ action: 'ai-duplicates-apply', ticket: panel.pair.ticket,
          mode, keepId, confirmed: true, delta: true }, view.generation);
        if (!options.isCurrent(view.generation)) return;
        if (!Array.isArray(result?.games)
          && !(result?.game?.id === keepId && affected.includes(result?.deletedId) && result.deletedId !== keepId)) {
          throw new Error('Invalid duplicate update response');
        }
        options.onSaved(result, mode);
        if (!current(view)) {
          options.notify?.('Zapisano zmianę w kolekcji.', 'Collection change saved.');
          return;
        }
        // A merge or removal can invalidate other proposals for either record.
        view.cursor = null;
        view.limit.hidden = true;
        view.panels = view.panels.filter(item => {
          if (!affected.includes(item.pair.left.id) && !affected.includes(item.pair.right.id)) return true;
          item.row.remove();
          return false;
        });
        status(view, 'Zapisano zmianę. Możesz ponownie sprawdzić kolekcję.', 'Change saved. You can check the collection again.');
        view.notice.focus();
      } catch (error) {
        if (!options.isCurrent(view.generation)) return;
        // Once dispatched, a lost or malformed reply can hide a successful
        // commit. Refresh the collection before asking for a new decision.
        const uncertain = writeDispatched && (!error?.status || error.status === 408 || error.status >= 500 || error.status < 300);
        let refreshed = false;
        if ((uncertain || error?.status === 409) && options.reloadCollection) {
          try {
            await options.reloadCollection(view.generation);
            refreshed = true;
          } catch { /* Keep the original error if the refresh also fails. */ }
        }
        if (!current(view)) return;
        if (uncertain || error?.status === 409) clearProposals(view);
        if (uncertain && refreshed) {
          status(view, 'Odświeżono kolekcję po przerwanym zapisie. Sprawdź, które wpisy pozostały.',
            'The collection was refreshed after the interrupted save. Check which entries remain.', true);
        } else if (uncertain) {
          status(view, 'Nie udało się potwierdzić zapisu. Sprawdź kolekcję przed ponowieniem zmiany.',
            'The save could not be confirmed. Check the collection before retrying the change.', true);
        } else {
          showError(view, error, 'Nie udało się zapisać zmiany. Sprawdź kolekcję ponownie.', 'Could not save the change. Check the collection again.');
        }
        view.notice.focus();
      } finally {
        pendingWrite = false;
        if (opened && current(opened)) updateControls(opened);
      }
    }

    function build(view) {
      const labelNode = (...args) => label(view.bindings, ...args);
      const dialog = element(backdrop, 'section', 'modal duplicates-modal');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'duplicatesTitle');
      dialog.setAttribute('aria-describedby', 'duplicatesExplanation');
      view.dialog = dialog;

      const header = element(dialog, 'div', 'modal-head');
      labelNode(element(header, 'h2'), 'Znajdź powtórzenia', 'Find duplicates').id = 'duplicatesTitle';
      const closeButton = labelNode(control(header, 'close'), '×', '×');
      labelNode(closeButton, 'Zamknij', 'Close', 'aria-label');
      closeButton.addEventListener('click', () => close());

      const body = element(dialog, 'div', 'duplicates-body');
      const explanation = labelNode(element(body, 'p'),
        'Google Gemini otrzyma tytuły i platformy prawdopodobnych powtórzeń. Samodzielnie sprawdzisz propozycje przed zapisaniem zmian.',
        'Google Gemini receives the titles and platforms of likely duplicates. Review the suggestions before saving changes.');
      explanation.id = 'duplicatesExplanation';
      view.scanButton = control(body, 'primary');
      view.scanButton.id = 'duplicatesScan';
      view.scanButton.addEventListener('click', () => void scan(view));
      view.notice = element(body, 'p', 'duplicates-notice');
      view.notice.id = 'duplicatesStatus';
      view.notice.tabIndex = -1;
      view.limit = labelNode(element(body, 'p', 'duplicates-limit'),
        'Jedno wyszukiwanie sprawdza część podobnych par. Możesz samodzielnie uruchomić kolejne sprawdzenie.',
        'Each scan checks a batch of similar pairs. You can choose to check the next batch.');
      view.limit.hidden = true;
      view.results = element(body, 'div', 'duplicates-results');
      view.results.id = 'duplicatesResults';
      labelNode(element(dialog, 'div', 'form-actions duplicates-help'),
        'Połączenie łączy platformy oraz zapisane wydania fizyczne i cyfrowe. Zachowuje tytuł, status i okładkę wybranego wpisu.',
        'A merge combines platforms and saved physical and digital editions. It keeps the selected entry’s title, status and cover.');
      updateStatus(view);
      updateControls(view);
    }

    function open() {
      if (opened) return;
      const generation = options.getGeneration();
      if (!options.isCurrent(generation)) return;
      if (options.beforeOpen?.() === false) return;
      opened = { generation, bindings: [], panels: [], scan: null, status: null, cursor: null, nextPanel: 0 };
      build(opened);
      backdrop.hidden = false;
      backdrop.classList.add('open');
      opened.scanButton.focus();
    }

    function close(restoreFocus = true) {
      if (!opened) return;
      const { scan: controller } = opened;
      opened = null;
      controller?.abort();
      backdrop.classList.remove('open');
      backdrop.hidden = true;
      backdrop.replaceChildren();
      if (restoreFocus && button.isConnected) button.focus();
    }

    function refreshLanguage() {
      if (!opened) return;
      for (const update of opened.bindings) update();
      for (const panel of opened.panels) {
        for (const update of panel.bindings) update();
        refreshPreview(panel);
      }
      updateStatus(opened);
      updateControls(opened);
    }

    button.addEventListener('click', open);
    backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
    document.addEventListener('keydown', event => {
      if (!opened) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const controls = [...opened.dialog.querySelectorAll('button, input')]
        .filter(node => node.tabIndex !== -1 && !node.disabled && !node.closest('[hidden]'));
      const active = document.activeElement;
      const outside = !opened.dialog.contains(active);
      if (event.shiftKey && (outside || active === controls[0])) {
        event.preventDefault();
        controls.at(-1)?.focus();
      } else if (!event.shiftKey && (outside || active === controls.at(-1))) {
        event.preventDefault();
        controls[0]?.focus();
      }
    });
    backdrop.hidden = true;
    return { open, close, clearPrivateData: () => close(false), refreshLanguage };
  }

  window.SavepointDuplicates = Object.freeze({ create });
})();
