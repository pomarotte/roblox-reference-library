'use strict';
(() => {
  const section = get('autopilot'), status = get('autopilot-status');
  const reviewSet = new Set(), editedDescriptions = new Map();
  const params = new URLSearchParams(location.search);
  let requestedGame = params.get('game'), requestedBatch = params.get('batch');
  let enabled = false, selected, game, round, busy = false, selection = 0;
  let infoVersion, cardsVersion, libraryVersion, liveVersion, briefVersion, tabsVersion, batchOptions;
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

  function card(name, image, state) {
    const node = el('article', '', 'thumbnail-card');
    node.append(preview(image, name), el('strong', name));
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
    if (!enabled || selected === entry?.universe && game) return;
    const ticket = ++selection;
    selected = entry?.universe;
    game = null;
    round = null;
    briefVersion = cardsVersion = libraryVersion = liveVersion = infoVersion = batchOptions = undefined;
    reviewSet.clear();
    editedDescriptions.clear();
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
    busy = true;
    section.setAttribute('aria-busy', 'true');
    status.textContent = 'Saving…';
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
      if (['brief', 'references'].includes(action)) briefVersion = undefined;
      status.textContent = action === 'approve' ? 'Approved. Autopilot will submit the selected images.' : '';
      renderAutopilot(view);
      refreshTabs().catch(() => {});
      if (action === 'key') {
        get('autopilot-key-input').value = '';
        get('autopilot-key').hidden = true;
        loadPerformance();
      }
      return true;
    } catch (error) {
      if (selection === ticket) status.textContent = error.message;
      return false;
    } finally {
      busy = false;
      section.removeAttribute('aria-busy');
    }
  }

  function renderBrief(view) {
    const {brief, suggestions} = view, node = get('autopilot-description');
    const fingerprint = JSON.stringify([brief, suggestions]);
    if (briefVersion === fingerprint) return;
    if (briefVersion === undefined || node.value === node.defaultValue) node.value = brief.description;
    node.defaultValue = brief.description;
    briefVersion = fingerprint;
    const saved = new Set(brief.references.map(item => item.id));
    const offered = [...new Map([...brief.references, ...suggestions].map(item => [item.id, item])).values()];
    get('autopilot-reference-list').replaceChildren(...offered.map(item => {
      const label = el('label', '', 'thumbnail-card'), checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.value = item.id;
      checkbox.checked = saved.has(item.id);
      const row = el('span', '', 'check-label');
      row.append(checkbox, item.name);
      label.append(preview(item.image, ''), row);
      return label;
    }));
    get('autopilot-assets').replaceChildren(...brief.assets.map(asset => {
      const node = card(asset.name, media(asset.id), `${asset.kind}${asset.required ? ' · Must include' : ''}`);
      node.append(button('Remove asset', () => act('removeAsset', {id: asset.id})));
      return node;
    }));
  }

  function renderPool(view, editable) {
    const fingerprint = JSON.stringify([view.starting, view.library, editable]);
    if (libraryVersion === fingerprint) return;
    libraryVersion = fingerprint;
    get('autopilot-starting').replaceChildren(...view.starting.map(item => {
      const node = card(item.label, item.existing ? item.image : media(item.id));
      node.append(button('Remove from pool', () => act('removeStarting', {id: item.id})));
      return node;
    }));
    get('autopilot-target').min = Math.max(1, view.starting.length);
    if (Number(get('autopilot-target').value) < view.starting.length) get('autopilot-target').value = view.starting.length;
    const nodes = view.library.filter(item => item.approved && item.image).map(item => {
      const node = card(item.label, item.image, item.active ? 'Currently active' : 'Previously uploaded');
      const add = button('Add to pool', () => act('pick', {id: item.homeId}));
      add.disabled = view.starting.length >= 10 || view.starting.some(candidate => candidate.homeId === item.homeId);
      node.append(add);
      return node;
    });
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
    const fingerprint = JSON.stringify([view.active, view.measurements, view.library, view.batches.flatMap(batch =>
      batch.items.filter(item => view.active.includes(item.homeId)))]);
    if (liveVersion === fingerprint) return;
    liveVersion = fingerprint;
    const history = view.batches.flatMap(batch => batch.items);
    get('autopilot-live').replaceChildren(...view.active.map(id => {
      const item = history.find(candidate => candidate.homeId === id && (candidate.imageReady || candidate.image))
        || view.library.find(candidate => candidate.homeId === id);
      const result = view.measurements?.find(row => row.homeId === id);
      return card(item?.label || `Thumbnail ${id}`, item && (item.image || (item.id ? media(item.id) : null)), metrics(result));
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
        const node = card(item.label, image, state);
        if (image) {
          const link = el('a', 'View full image');
          link.href = image;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          node.append(link);
        }
        if (item.parent) node.append(el('p', `From ${item.parent.label}`, 'muted'));
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
    game = view;
    const current = game.batches.at(-1);
    const editable = !current || current.phase === 'complete';
    get('autopilot-game').hidden = false;
    get('autopilot-pool').hidden = !editable;
    const message = game.paused ? 'Paused' : current ? ({
      generating: `Generating round ${current.number} · ${current.items.filter(item => item.stage !== 'generating').length} of ${current.items.length} processed`,
      review: 'Batch ready for your review', testing: `Testing round ${current.number}`, complete: 'Campaign complete'
    })[current.phase] : 'Set up your creative brief and starting pool.';
    const progress = `${game.active.length} of 5 active · ${message}${game.problem ? ` · ${game.problem}` : ''}`;
    if (infoVersion !== progress) {
      infoVersion = progress;
      get('autopilot-progress').textContent = progress;
      const controls = [button('Update saved key', () => {
        get('autopilot-key').hidden = false;
        get('autopilot-connect').textContent = 'Update saved key';
        get('autopilot-key-input').focus();
      })];
      if (!editable) controls.unshift(button(game.paused ? 'Resume' : 'Pause', () => act(game.paused ? 'resume' : 'pause')));
      if (['review', 'testing'].includes(current?.phase)) controls.push(button('Sync active set', () => act('sync')));
      get('autopilot-controls').replaceChildren(...controls);
    }
    renderBrief(view);
    renderPool(view, editable);
    renderLive(view);
    renderDrafts(view, current);
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
    act('brief', {description: get('autopilot-description').value, references: [...get('autopilot-reference-list')
      .querySelectorAll('input:checked')].map(input => input.value)});
  });
  get('autopilot-find').addEventListener('click', () =>
    act('references', {description: get('autopilot-description').value}));
  get('autopilot-asset-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (await act('image', {}, get('autopilot-asset-file').files[0], {type: 'asset', name: get('autopilot-asset-name').value,
      kind: get('autopilot-asset-kind').value, required: get('autopilot-asset-required').checked ? '1' : '0'})) event.target.reset();
  });
  get('autopilot-upload-form').addEventListener('submit', async event => {
    event.preventDefault();
    const file = get('autopilot-upload-file').files[0];
    if (await act('image', {}, file, {type: 'starting', name: file.name.slice(0, 80)})) event.target.reset();
  });
  get('autopilot-load-library').addEventListener('click', () => act('library'));
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
