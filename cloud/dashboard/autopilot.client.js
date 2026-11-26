'use strict';
(() => {
  const section = get('autopilot'), status = get('autopilot-status');
  const referenceStatus = get('autopilot-reference-status');
  const manualReferenceStatus = get('autopilot-manual-reference-status');
  const reviewSet = new Set(), editedDescriptions = new Map();
  const referenceChoices = new Map();
  const params = new URLSearchParams(location.search);
  let requestedGame = params.get('game'), requestedBatch = params.get('batch');
  let enabled = false, selected, game, round, busy = false, selection = 0;
  let infoVersion, cardsVersion, libraryVersion, liveVersion, briefVersion, tabsVersion, batchOptions;
  let manualVersion;
  const stages = {
    generating: 'Generating', draft: 'Ready to review', generationFailed: 'Generation failed',
    excluded: 'Skipped', queued: 'Approved for submission', submitting: 'Upload unconfirmed',
    uploading: 'Uploading to Roblox', moderating: 'Awaiting Roblox moderation', ready: 'Waiting for rotation',
    live: 'Live · Collecting data', tested: 'Tested', rejected: 'Roblox declined'
  };

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(text, onClick) {
    const node = el('button', text, 'secondary');
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function preview(url, name) {
    if (!url) return el('div', 'Preview unavailable', 'preview-missing muted');
    const node = el('img');
    node.src = url;
    node.alt = name;
    node.loading = 'lazy';
    return node;
  }

  function media(id) {
    return `/api/autopilot?game=${game.universe}&image=${id}`;
  }

  function card(name, image, state, showName = true) {
    const node = el('article', '', 'thumbnail-card');
    node.append(preview(image, name));
    if (showName) node.append(el('strong', name));
    if (state) node.append(el('p', state, 'muted'));
    return node;
  }

  async function api(universe, body, file, query = {}) {
    const search = new URLSearchParams({...query, ...(universe ? {game: universe} : {})});
    const init = file ? {method: 'POST', headers: {'Content-Type': file.type}, body: file}
      : body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : undefined;
    return responseData(await fetch(`/api/autopilot?${search}`, init));
  }

  function showBatchLink(universe, id) {
    const url = new URL(location.href);
    if (universe) url.searchParams.set('game', universe);
    else url.searchParams.delete('game');
    if (id) url.searchParams.set('batch', id);
    else url.searchParams.delete('batch');
    history.replaceState(null, '', url);
  }

  async function refreshTabs(initial = false) {
    const data = await api();
    enabled = data.enabled;
    if (!enabled) return;
    get('connect-direct').hidden = Boolean(connection);
    const summary = JSON.stringify(data.games.map(entry => [entry.universe, entry.name, entry.review]));
    let loadSelectedPerformance = false;
    for (const entry of data.games) {
      const existing = games.get(entry.universe);
      const gameEntry = existing || {universe: entry.universe};
      if (entry.since && gameEntry.serverSince !== entry.since) {
        gameEntry.serverSince = entry.since;
        gameEntry.activatedAt = undefined;
        gameEntry.localActivation = '';
        if (connection === gameEntry) {
          get('activated').value = '';
          loadSelectedPerformance = !activeRequest;
        }
      }
      Object.assign(gameEntry, {name: entry.name, stored: true, review: entry.review});
      delete gameEntry.key;
      games.set(entry.universe, gameEntry);
    }
    if (summary !== tabsVersion) {
      tabsVersion = summary;
      renderGames();
    }
    if (initial) {
      if (requestedGame && !games.has(requestedGame)) {
        get('universe').value = /^[1-9]\d{0,19}$/.test(requestedGame) ? requestedGame : '';
        get('connection-status').textContent = requestedBatch
          ? 'This review link requires the account that owns the campaign.' : '';
      } else if (!connection && games.size) {
        selectGame(requestedGame || games.keys().next().value);
      } else window.autopilotSelection(connection);
    } else if (loadSelectedPerformance) loadPerformance();
  }

  async function refreshGame() {
    if (!game || busy || document.hidden || get('autopilot-drafts').contains(document.activeElement)) return;
    const ticket = selection;
    try {
      const view = await api(game.universe);
      if (selection === ticket && !busy) renderAutopilot(view);
    } catch (error) {
      if (selection === ticket && !busy) status.textContent = error.message;
    }
  }

  window.autopilotSelection = async entry => {
    get('connect-direct').hidden = !enabled || Boolean(entry);
    if (!enabled) return;
    if (selected === entry?.universe && game) {
      renderLive(game);
      return;
    }
    const ticket = ++selection;
    selected = entry?.universe;
    game = null;
    round = null;
    briefVersion = cardsVersion = libraryVersion = liveVersion = infoVersion = batchOptions = undefined;
    reviewSet.clear();
    editedDescriptions.clear();
    referenceChoices.clear();
    referenceStatus.textContent = '';
    manualReferenceStatus.textContent = '';
    get('autopilot-asset-feedback').textContent = '';
    get('autopilot-upload-feedback').textContent = '';
    get('autopilot-asset-form').reset();
    get('autopilot-upload-form').reset();
    get('autopilot-game-search').value = '';
    manualVersion = undefined;
    get('autopilot-game').hidden = true;
    get('autopilot-key').hidden = Boolean(entry?.stored);
    section.hidden = !entry;
    if (!entry) {
      if (!requestedGame) showBatchLink();
      return;
    }
    get('autopilot-name').value = entry.name || '';
    get('autopilot-key-input').value = '';
    get('autopilot-connect').textContent = entry.stored ? 'Update saved key' : 'Connect Autopilot';
    status.textContent = '';
    if (entry.universe === requestedGame && requestedBatch) round = requestedBatch;
    showBatchLink(entry.universe, round);
    if (!entry.stored) return;
    try {
      const view = await api(entry.universe);
      if (selection !== ticket) return;
      renderAutopilot(view);
      if (round && round === requestedBatch) get('autopilot-review-heading').focus();
      requestedGame = requestedBatch = null;
    } catch (error) {
      if (selection === ticket) status.textContent = error.message;
    }
  };

  async function act(action, payload = {}, file, query) {
    if (!selected || busy) return false;
    const ticket = selection, universe = selected;
    const searching = action === 'references';
    const manualSearch = action === 'searchGames';
    const feedback = searching || action === 'brief' ? referenceStatus
      : manualSearch || action === 'addReference' ? manualReferenceStatus : status;
    busy = true;
    section.setAttribute('aria-busy', 'true');
    feedback.textContent = searching || manualSearch ? 'Searching for thumbnail references…' : 'Saving…';
    if (searching) get('autopilot-find').disabled = true;
    if (manualSearch) get('autopilot-game-search-button').disabled = true;
    try {
      const view = await api(universe, {action, ...payload}, file, query);
      if (selection !== ticket) return false;
      if (action === 'connect') {
        const entry = games.get(universe);
        entry.stored = true;
        entry.name = view.name;
        delete entry.key;
        game = view;
        showGame(entry);
        get('autopilot-key').hidden = true;
        loadPerformance();
      }
      if (action === 'start') round = null;
      if (['start', 'approve', 'regenerate'].includes(action)) reviewSet.clear();
      if (action === 'brief') referenceChoices.clear();
      if (action === 'addReference') referenceChoices.delete(payload.id);
      if (action === 'brief') briefVersion = undefined;
      status.textContent = action === 'approve' ? 'Approved. Autopilot will submit the selected images.' : '';
      renderAutopilot(view);
      if (searching) {
        const count = view.suggestions.length;
        feedback.textContent = count
          ? `Found ${count} ${count === 1 ? 'similar game' : 'similar games'}. Select up to three thumbnails, then click Save brief.`
          : 'No similar games found. Try including the genre or main gameplay mechanic in your description.';
      }
      if (manualSearch) feedback.textContent = view.manualSuggestions.length
        ? 'Choose a thumbnail to add it to your brief.' : 'No thumbnails found. Try a different title or paste the game’s Roblox link.';
      if (action === 'addReference') feedback.textContent = 'Thumbnail added to your creative brief.';
      if (action === 'brief') feedback.textContent = 'Creative brief saved.';
      refreshTabs().catch(() => {});
      if (action === 'key') {
        get('autopilot-key-input').value = '';
        get('autopilot-key').hidden = true;
        loadPerformance();
      }
      return true;
    } catch (error) {
      if (selection === ticket) feedback.textContent = error.message;
      return false;
    } finally {
      busy = false;
      section.removeAttribute('aria-busy');
      if (searching) get('autopilot-find').disabled = false;
      if (manualSearch) get('autopilot-game-search-button').disabled = false;
    }
  }

  function renderBrief(view) {
    const {brief, suggestions} = view, node = get('autopilot-description');
    const allow = get('autopilot-allow-text'), wording = get('autopilot-wording');
    const fingerprint = JSON.stringify([brief, suggestions]);
    if (briefVersion === fingerprint) return;
    if (briefVersion === undefined || node.value === node.defaultValue) node.value = brief.description;
    node.defaultValue = brief.description;
    if (briefVersion === undefined || allow.checked === allow.defaultChecked) allow.checked = Boolean(brief.allowText);
    if (briefVersion === undefined || wording.value === wording.defaultValue) wording.value = brief.wording || '';
    allow.defaultChecked = Boolean(brief.allowText);
    wording.defaultValue = brief.wording || '';
    get('autopilot-wording-field').hidden = !allow.checked;
    briefVersion = fingerprint;
    const saved = new Set(brief.references.map(item => item.id));
    const offered = [...new Map([...brief.references, ...suggestions].map(item => [item.id, item])).values()];
    get('autopilot-reference-list').replaceChildren(...offered.map(item => {
      const label = el('label', '', 'thumbnail-card'), checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.value = item.id;
      checkbox.checked = referenceChoices.get(item.id) ?? saved.has(item.id);
      checkbox.addEventListener('change', () => referenceChoices.set(item.id, checkbox.checked));
      const row = el('span', '', 'check-label');
      row.append(checkbox, item.name);
      label.append(preview(item.image, ''), row);
      if (item.reason) label.append(el('p', item.reason, 'muted'));
      return label;
    }));
    get('autopilot-assets').replaceChildren(...brief.assets.map(asset => {
      const node = card(asset.name, media(asset.id), `${asset.kind}${asset.required ? ' · Must include' : ''}`);
      node.append(button('Remove asset', () => act('removeAsset', {id: asset.id})));
      return node;
    }));
  }

  function thumbnailChoice(view, id, image, name, details) {
    const picked = view.starting.find(item => item.homeId === id);
    const choice = button('', async () => {
      const grid = document.activeElement === choice ? choice.parentElement : null;
      const updated = picked ? await act('removeStarting', {id: picked.id}) : await act('pick', {id});
      if (updated && grid) [...grid.children].find(item => item.dataset.homeId === id)?.focus();
    });
    choice.className = 'thumbnail-card thumbnail-choice secondary';
    choice.dataset.homeId = id;
    choice.setAttribute('aria-pressed', String(Boolean(picked)));
    choice.setAttribute('aria-label', name);
    choice.disabled = !picked && view.starting.length >= 10;
    choice.append(preview(image, ''), el('span', picked ? 'In starting pool' : 'Add to starting pool', 'thumbnail-choice-status'));
    if (details) choice.append(el('span', details, 'muted'));
    return choice;
  }

  function renderManualReferences(view) {
    const results = view.manualSuggestions || [];
    const selected = view.brief.references.map(item => item.id);
    const fingerprint = JSON.stringify([results, selected]);
    if (manualVersion === fingerprint) return;
    manualVersion = fingerprint;
    get('autopilot-manual-reference-list').replaceChildren(...results.map(item => {
      const node = card(item.name, item.image);
      const added = selected.includes(item.id);
      const add = button(added ? 'Added' : 'Add thumbnail', () => act('addReference', {id: item.id}));
      add.disabled = added;
      node.append(add);
      return node;
    }));
  }

  function renderPool(view, editable) {
    const fingerprint = JSON.stringify([view.starting, view.library, editable]);
    if (libraryVersion === fingerprint) return;
    libraryVersion = fingerprint;
    get('autopilot-pool-count').textContent = `${view.starting.length} of 10 selected`;
    const starting = view.starting.map(item => {
      const node = card('Starting thumbnail', item.existing ? item.image : media(item.id), null, false);
      node.append(button('Remove from pool', () => act('removeStarting', {id: item.id})));
      return node;
    });
    get('autopilot-starting').replaceChildren(...(starting.length ? starting : [
      el('p', 'Start with a live thumbnail, an upload, or an image from history.', 'muted full-width')
    ]));
    get('autopilot-target').min = Math.max(1, view.starting.length);
    if (Number(get('autopilot-target').value) < view.starting.length) get('autopilot-target').value = view.starting.length;
    const nodes = view.library.filter(item => item.approved && item.image && !view.active.includes(item.homeId))
      .map((item, index) => thumbnailChoice(view, item.homeId, item.image, `Archived thumbnail ${index + 1}`));
    get('autopilot-library-list').replaceChildren(...(nodes.length ? nodes : [
      el('p', 'Refresh to show available Home thumbnails for this game.', 'muted')
    ]));
  }

  function metrics(row) {
    return row?.qualifiedPlayRate != null
      ? `${percent.format(row.qualifiedPlayRate)} qualified play rate · ${numbers.format(row.impressions)} impressions`
      : 'Collecting data';
  }

  function renderLive(view) {
    const activePreviews = view.active.map(id => connection?.thumbnailImages?.get(id));
    const editable = !view.batches.length || view.batches.at(-1).phase === 'complete';
    const activeResults = view.active.map(id => metrics(view.measurements?.find(row => row.homeId === id)
      || connection?.data?.rows.find(row => row.homeId === id)));
    const fingerprint = JSON.stringify([view.active, activePreviews, activeResults, view.library, editable, view.starting, view.batches.flatMap(batch =>
      batch.items.filter(item => view.active.includes(item.homeId)))]);
    if (liveVersion === fingerprint) return;
    liveVersion = fingerprint;
    const history = view.batches.flatMap(batch => batch.items);
    get('autopilot-live').replaceChildren(...view.active.map((id, index) => {
      const item = history.find(candidate => candidate.homeId === id && (candidate.imageReady || candidate.image))
        || view.library.find(candidate => candidate.homeId === id);
      const image = item?.image || (item?.id ? media(item.id) : activePreviews[index]);
      const name = `Active thumbnail ${index + 1}`;
      return editable ? thumbnailChoice(view, id, image, name, activeResults[index]) : card(name, image, activeResults[index], false);
    }));
  }

  function renderDrafts(view, current) {
    const displayed = view.batches.find(batch => batch.id === round) || current;
    const canReview = displayed === current && current?.phase === 'review' && !view.paused;
    get('autopilot-review').hidden = !displayed;
    if (!displayed) return;
    const select = get('autopilot-batches');
    const options = view.batches.map(batch => batch.id).join(',');
    if (options !== batchOptions) {
      batchOptions = options;
      select.replaceChildren(...[...view.batches].reverse().map(batch => new Option(`Round ${batch.number}`, batch.id)));
    }
    select.value = displayed.id;
    get('autopilot-review-heading').textContent = `${view.name} · Round ${displayed.number}${canReview ? ' · Review batch' : ''}`;
    const fingerprint = JSON.stringify([displayed.id, displayed.items, canReview, view.active]);
    if (cardsVersion !== fingerprint) {
      cardsVersion = fingerprint;
      get('autopilot-drafts').replaceChildren(...displayed.items.map(item => {
        const image = item.existing ? item.image : item.imageReady ? media(item.id) : null;
        const state = view.active.includes(item.homeId) && item.stage === 'tested' ? 'Live · Tested' : stages[item.stage];
        const node = card('Batch thumbnail', image, state, false);
        if (image) {
          const link = el('a', 'View full image');
          link.href = image;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          node.append(link);
        }
        if (item.parent) {
          const source = el('div', 'Based on', 'activity-thumbnail muted');
          source.append(thumbnailPreview(item.parent.id ? media(item.parent.id) : item.parent.image, 'Source thumbnail'));
          node.append(source);
        }
        if (item.result) node.append(el('p', metrics(item.result), 'muted'));
        if (item.detail) node.append(el('p', item.detail, 'muted'));
        if (canReview && item.stage === 'draft') {
          const label = el('label', '', 'check-label'), input = el('input');
          input.type = 'checkbox';
          input.checked = reviewSet.has(item.id);
          input.addEventListener('change', () => {
            if (input.checked) reviewSet.add(item.id);
            else reviewSet.delete(item.id);
            get('autopilot-approve').disabled = !reviewSet.size;
          });
          label.append(input, 'Approve this thumbnail');
          node.append(label);
        }
        if (item.description) {
          const details = el('details'), instructions = el('textarea');
          details.append(el('summary', 'Generation description'));
          if (canReview && ['draft', 'generationFailed'].includes(item.stage)) {
            instructions.value = editedDescriptions.get(item.id) || item.description;
            instructions.rows = 7;
            instructions.maxLength = 6000;
            instructions.setAttribute('aria-label', `Generation description for ${item.label}`);
            instructions.addEventListener('input', () => editedDescriptions.set(item.id, instructions.value));
            details.append(instructions, button('Regenerate', () =>
              act('regenerate', {batch: displayed.id, id: item.id, description: instructions.value})));
          } else details.append(el('p', item.description, 'generation-description'));
          node.append(details);
        }
        if (displayed === current && item.stage === 'submitting') node.append(button('Skip unconfirmed upload',
          () => act('recover', {batch: displayed.id, id: item.id})));
        return node;
      }));
    }
    get('autopilot-approval').hidden = !canReview;
    get('autopilot-approve').disabled = !reviewSet.size;
  }

  function renderAutopilot(view) {
    const minimum = get('autopilot-minimum');
    if (!game || minimum.value === minimum.defaultValue) minimum.value = String(view.minimum);
    minimum.defaultValue = String(view.minimum);
    if (!game) get('autopilot-brief').open = !view.batches.length;
    game = view;
    const current = game.batches.at(-1);
    const editable = !current || current.phase === 'complete';
    get('autopilot-game').hidden = false;
    get('autopilot-pool').hidden = !editable;
    get('autopilot-pick-help').hidden = !editable || !game.active.length;
    const message = game.paused ? 'Paused' : current ? ({
      generating: `Generating round ${current.number} · ${current.items.filter(item => item.stage !== 'generating').length} of ${current.items.length} processed`,
      review: 'Batch ready for your review', testing: `Testing round ${current.number}`, complete: 'Campaign complete'
    })[current.phase] : 'Set up your creative brief and starting pool.';
    const progress = `${game.active.length} of 5 active · ${message}${game.problem ? ` · ${game.problem}` : ''}`;
    if (infoVersion !== progress) {
      infoVersion = progress;
      get('autopilot-progress').textContent = progress;
      const controls = [];
      if (!editable) controls.unshift(button(game.paused ? 'Resume' : 'Pause', () => act(game.paused ? 'resume' : 'pause')));
      if (['review', 'testing'].includes(current?.phase)) controls.push(button('Sync active set', () => act('sync')));
      get('autopilot-controls').replaceChildren(...controls);
    }
    renderBrief(view);
    renderManualReferences(view);
    renderPool(view, editable);
    renderLive(view);
    renderDrafts(view, current);
  }

  async function uploadImages(event, asset) {
    event.preventDefault();
    if (!game || busy) return;
    const prefix = asset ? 'autopilot-asset' : 'autopilot-upload';
    const files = [...get(`${prefix}-file`).files];
    const feedback = get(`${prefix}-feedback`), submit = get(`${prefix}-submit`);
    const remaining = asset ? 8 - game.brief.assets.length : 10 - game.starting.length;
    if (!files.length) return;
    if (files.length > remaining) {
      feedback.textContent = remaining ? `Choose up to ${remaining} more ${remaining === 1 ? 'image' : 'images'}.` : 'The list is full. Remove an image before adding another.';
      return;
    }
    const universe = game.universe, ticket = selection;
    const settings = asset ? {type: 'asset', kind: get('autopilot-asset-kind').value,
      required: get('autopilot-asset-required').checked ? '1' : '0'} : {type: 'starting'};
    const customName = asset && files.length === 1 ? get('autopilot-asset-name').value.trim() : '';
    const errors = [];
    busy = submit.disabled = true;
    try {
      for (const [index, file] of files.entries()) {
        if (selection !== ticket) return;
        feedback.textContent = `Uploading ${index + 1} of ${files.length}…`;
        const name = (customName || file.name.replace(/\.[^.]+$/, '').trim() || 'Image').slice(0, 80);
        try {
          const view = await api(universe, null, file, {...settings, name});
          if (selection === ticket) renderAutopilot(view);
        } catch (error) { errors.push(`${file.name} (${error.message})`); }
      }
      if (selection === ticket) {
        if (errors.length < files.length) event.target.reset();
        const added = files.length - errors.length;
        feedback.textContent = `${added} ${added === 1 ? 'image' : 'images'} added.${errors.length ? ` Could not add: ${errors.join(', ')}` : ''}`;
      }
    } finally {
      busy = submit.disabled = false;
    }
  }

  get('autopilot-key').addEventListener('submit', event => {
    event.preventDefault();
    const field = get('autopilot-key-input'), key = field.value.trim();
    field.value = '';
    act(game ? 'key' : 'connect', {key, name: get('autopilot-name').value}).then(connected => {
      if (connected && !game.library.length) act('library');
    });
  });
  get('connect-direct').addEventListener('click', async () => {
    if (busy || !get('connection').reportValidity()) return;
    const universe = get('universe').value.trim(), field = get('key');
    const name = get('game-name').value.trim() || `Universe ${universe}`;
    const key = field.value.trim();
    field.value = '';
    const submit = get('connect-direct'), ticket = selection;
    submit.disabled = true;
    try {
      await api(universe, {action: 'connect', key, name});
      await refreshTabs();
      if (ticket !== selection) return;
      selectGame(universe);
      get('autopilot-brief').open = true;
    } catch (error) {
      if (ticket === selection) get('connection-status').textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
  get('autopilot-brief-form').addEventListener('submit', event => {
    event.preventDefault();
    return act('brief', {description: get('autopilot-description').value, references: [...get('autopilot-reference-list')
      .querySelectorAll('input:checked')].map(input => input.value), allowText: get('autopilot-allow-text').checked,
      wording: get('autopilot-wording').value});
  });
  get('autopilot-allow-text').addEventListener('change', event => {
    get('autopilot-wording-field').hidden = !event.target.checked;
  });
  get('autopilot-find').addEventListener('click', () =>
    act('references', {description: get('autopilot-description').value}));
  get('autopilot-manual-reference-form').addEventListener('submit', event => {
    event.preventDefault();
    return act('searchGames', {query: get('autopilot-game-search').value});
  });
  get('autopilot-asset-form').addEventListener('submit', event => uploadImages(event, true));
  get('autopilot-upload-form').addEventListener('submit', event => uploadImages(event, false));
  get('autopilot-load-library').addEventListener('click', () => act('library'));
  get('autopilot-library').addEventListener('toggle', event => {
    if (event.target.open && game && !game.library.length) act('library');
  });
  get('autopilot-replace-key').addEventListener('click', () => {
    get('autopilot-key').hidden = false;
    get('autopilot-connect').textContent = 'Update saved key';
    get('autopilot-key-input').focus();
  });
  get('autopilot-minimum-form').addEventListener('submit', async event => {
    event.preventDefault();
    const field = get('autopilot-minimum'), minimum = field.valueAsNumber;
    if (await act('minimum', {minimum})) {
      status.textContent = 'Impression minimum saved.';
      if (connection?.data) {
        connection.data.minimum = minimum;
        render(connection.data);
      }
    }
  });
  get('autopilot-start-form').addEventListener('submit', event => {
    event.preventDefault();
    act('start', {target: Number(get('autopilot-target').value), rounds: Number(get('autopilot-rounds').value)});
  });
  get('autopilot-batches').addEventListener('change', event => {
    round = event.target.value;
    showBatchLink(game.universe, round);
    renderAutopilot(game);
  });
  get('autopilot-approve').addEventListener('click', () =>
    act('approve', {batch: game.batches.at(-1).id, ids: [...reviewSet]}));

  refreshTabs(true).catch(error => { get('connection-status').textContent = error.message; });
  setInterval(() => {
    if (document.hidden) return;
    refreshTabs().catch(() => {});
    refreshGame();
  }, 20_000);
})();
