'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const references = new Map();
  const gameThumbnailApi = 'https://references.rolibrary.win/roblox-thumbnails';
  const tagDescriptions = {
    'Visual style': 'rendering technique, textures, level of realism, and outlines',
    'Composition': 'framing, camera viewpoint (first person or third person), camera angle, subject placement, scale, and layout',
    'Environment': 'setting, background, and environmental details',
    'Character': 'the exact subject identity, silhouette, anatomy, head and face, distinctive features, clothing, and colors; replace subjects from other references with this character',
    'Lighting': 'match exposure and brightness, light sources and direction, shadow depth, and contrast; preserve a dark image as dark',
    'Colors': 'match dominant hues, saturation, darkness, and overall color balance; do not brighten or add unrelated colors',
    'Object': 'include the referenced prop or vehicle and preserve its recognizable shape, materials and details',
    'Logo': 'place the complete referenced logo, preserving its graphic mark and any lettering, spelling, and typography that are part of the logo, even when other text is disabled',
    'Text style': 'when text is enabled, use the typeface, weight, color, outline and effects as inspiration for the requested wording'
  };
  let result, resultUrl, nextImageNumber = 0, collections = [];
  const host = window.galleryHost;
  const keyInput = $('thumbnail-key');
  const keyStorage = 'rolibrary-gemini-api-key';
  const keyStatus = $('thumbnail-key-status');
  try { keyInput.value = window.localStorage.getItem(keyStorage) || ''; }
  catch { keyStatus.textContent = 'Browser storage is unavailable.'; keyStatus.hidden = false; }

  function saveKey() {
    try {
      const key = keyInput.value.trim();
      if (key) window.localStorage.setItem(keyStorage, key);
      else window.localStorage.removeItem(keyStorage);
      keyStatus.hidden = true;
    } catch {
      keyStatus.textContent = 'Could not update the saved key. You can manage it in your browser’s site settings.';
      keyStatus.hidden = false;
    }
  }
  keyInput.addEventListener('input', saveKey);
  $('thumbnail-forget-key').addEventListener('click', () => {
    keyInput.value = '';
    saveKey();
    keyInput.focus();
  });

  const picker = $('thumbnail-collection');
  const panel = $('thumbnail-panel');
  const opener = $('thumbnail-open');
  const fullscreen = $('thumbnail-fullscreen');
  const grid = $('thumbnail-collection-images');
  const gameGrid = $('thumbnail-game-images');
  const conceptInput = $('thumbnail-concept');
  const conceptHighlight = $('thumbnail-concept-highlight');
  const mentionPreview = $('thumbnail-mention-preview');
  const suggestions = $('thumbnail-mention-suggestions');
  const allowText = $('thumbnail-allow-text');
  allowText.addEventListener('change', () => { $('thumbnail-wording-field').hidden = !allowText.checked; });
  const previewObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      previewObserver.unobserve(entry.target);
      host.imageSource(entry.target, Number(entry.target.dataset.imageId));
    }
  });

  function referenceMentions(text) {
    return text.matchAll(/@(?:Image ?([1-9]\d*)(?![\p{L}\p{N}_])|\[([^\]\n]+)\])/giu);
  }

  function mentionText(item) {
    return item.box ? `@[${item.name}]` : `@${item.name}`;
  }

  function findMention(match, items) {
    for (const reference of items) {
      if (reference.number === Number(match[1])) return {reference, item: reference};
      const region = reference.regions.find(item => item.name.toLowerCase() === match[2]?.toLowerCase());
      if (region) return {reference, item: region};
    }
  }

  function syncConceptScroll() {
    conceptHighlight.style.width = `${conceptInput.clientWidth}px`;
    conceptHighlight.scrollTop = conceptInput.scrollTop;
    conceptHighlight.scrollLeft = conceptInput.scrollLeft;
  }

  function updateDescription() {
    const {value, selectionStart, selectionEnd} = conceptInput;
    const nodes = [];
    let from = 0, selected;
    for (const match of referenceMentions(value)) {
      const found = findMention(match, references.values());
      if (!found) continue;
      const token = document.createElement('span');
      token.textContent = match[0];
      nodes.push(value.slice(from, match.index), token);
      from = match.index + match[0].length;
      if (document.activeElement === conceptInput && match.index <= selectionStart && selectionEnd <= from &&
          selectionStart < from && selectionEnd > match.index) selected = found;
    }
    conceptHighlight.replaceChildren(...nodes, value.slice(from), '\u200b');
    syncConceptScroll();
    updateMentionPreview(selected);
    updateSuggestions();
  }

  function updateMentionPreview(found) {
    mentionPreview.hidden = !found;
    if (!found) {
      mentionPreview.replaceChildren();
    } else if (mentionPreview.textContent !== found.item.name) {
      const {reference, item} = found;
      const image = referenceImage(reference);
      if (item.box) {
        const preview = document.createElement('span');
        preview.className = 'thumbnail-region-preview';
        preview.append(image, regionOverlay(item.box));
        mentionPreview.replaceChildren(preview, item.name);
      } else {
        mentionPreview.replaceChildren(image, item.name);
      }
    }
  }

  for (const event of ['input', 'select', 'selectionchange', 'click', 'focus', 'blur']) {
    conceptInput.addEventListener(event, updateDescription);
  }
  conceptInput.addEventListener('scroll', syncConceptScroll);
  new ResizeObserver(syncConceptScroll).observe(conceptInput);

  function updateSuggestions() {
    if (document.activeElement !== conceptInput) return;
    const {value, selectionStart, selectionEnd} = conceptInput;
    const insideMention = [...referenceMentions(value)].some(match => match.index < selectionStart && selectionStart < match.index + match[0].length);
    const query = selectionStart === selectionEnd && !insideMention && /(?:^|[^\p{L}\p{N}_])(@\[?([^\n@\[\]]*))$/u.exec(value.slice(0, selectionStart));
    const items = query ? [...references.values()].flatMap(reference => [reference, ...reference.regions]) : [];
    const matches = items.filter(item => item.name.toLowerCase().startsWith(query[2].toLowerCase()) &&
      (query[1][1] !== '[' || item.box) && mentionText(item).toLowerCase() !== query[1].toLowerCase());
    suggestions.hidden = !matches.length;
    suggestions.replaceChildren(...matches.map(item => regionButton(mentionText(item), () =>
      insertMention(item, selectionEnd - query[1].length, selectionEnd))));
  }

  function insertMention(item, selectionStart = conceptInput.selectionStart, selectionEnd = conceptInput.selectionEnd) {
    const {value} = conceptInput;
    const before = selectionStart && value[selectionStart] !== '@' && !/\s/.test(value[selectionStart - 1]) ? ' ' : '';
    const atEnd = selectionEnd === value.length;
    const after = atEnd || /[\p{L}\p{N}_@]/u.test(value[selectionEnd]) ? ' ' : '';
    const mention = mentionText(item);
    conceptInput.setRangeText(`${before}${mention}${after}`, selectionStart, selectionEnd, 'end');
    conceptInput.focus();
    const end = selectionStart + before.length + mention.length + (atEnd ? 1 : 0);
    conceptInput.setSelectionRange(end, end);
    updateDescription();
  }

  function referenceImage(reference) {
    const image = document.createElement('img');
    image.className = 'thumbnail-reference-preview';
    image.alt = '';
    if (reference.url) {
      image.src = reference.url;
    } else if (reference.file) {
      reference.previewUrl ||= URL.createObjectURL(reference.file);
      image.src = reference.previewUrl;
    } else {
      host.imageSource(image, reference.id);
    }
    return image;
  }

  function addReference(id, reference) {
    const number = ++nextImageNumber;
    id ??= `upload-${number}`;
    references.set(id, {...reference, id, number, name: `Image ${number}`, regions: []});
  }

  function regionButton(label, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
  }

  const regionDialog = $('thumbnail-region-dialog');
  const regionImage = $('thumbnail-region-image');
  const regionStage = $('thumbnail-region-stage');
  const regionName = $('thumbnail-region-name');
  const regionStatus = $('thumbnail-region-status');
  const regionSave = $('thumbnail-region-save');
  const regionDelete = $('thumbnail-region-delete');
  const draftOverlay = $('thumbnail-region-draft');
  let regionEditor;

  function paintBox(element, {x, y, width, height}) {
    element.style.left = `${x * 100}%`;
    element.style.top = `${y * 100}%`;
    element.style.width = `${width * 100}%`;
    element.style.height = `${height * 100}%`;
  }

  function regionOverlay(box, name = '') {
    const overlay = document.createElement('span');
    overlay.className = 'thumbnail-region-box';
    if (name) {
      const label = document.createElement('span');
      label.textContent = name;
      overlay.append(label);
    }
    paintBox(overlay, box);
    return overlay;
  }

  function setDraft(box) {
    regionEditor.box = box;
    draftOverlay.hidden = false;
    paintBox(draftOverlay, box);
  }

  async function openRegion(reference, item) {
    const editor = regionEditor = {reference, item, box: item?.box};
    regionName.value = item?.name || '';
    regionSave.disabled = regionName.disabled = regionStage.hidden = true;
    regionDelete.hidden = !item;
    draftOverlay.hidden = true;
    $('thumbnail-region-title').textContent = `${item ? 'Edit box' : 'Add a box'} · ${reference.name}`;
    regionStatus.textContent = 'Loading reference…';
    regionDialog.showModal();
    try {
      const file = await referenceFile(reference);
      if (regionEditor !== editor || !regionDialog.open) return;
      regionImage.src = editor.url = URL.createObjectURL(file);
      await regionImage.decode();
      if (regionEditor !== editor || !regionDialog.open) return;
      $('thumbnail-region-existing').replaceChildren(...reference.regions.filter(other => other !== item)
        .map(other => regionOverlay(other.box, other.name)));
      if (editor.box) setDraft(editor.box);
      regionSave.disabled = regionName.disabled = regionStage.hidden = false;
      regionStatus.textContent = '';
      regionStage.focus();
    } catch (error) {
      if (regionEditor === editor && regionDialog.open) regionStatus.textContent = `Could not open this reference. ${error.message}`;
    }
  }

  function boxPoint(event) {
    const bounds = regionImage.getBoundingClientRect();
    return {x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
      y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1)};
  }

  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

  regionStage.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !regionEditor || regionEditor.drag) return;
    regionStage.setPointerCapture(event.pointerId);
    regionEditor.drag = {id: event.pointerId, start: boxPoint(event), previous: regionEditor.box};
  });
  function moveBox(event) {
    const drag = regionEditor?.drag;
    if (drag?.id !== event.pointerId) return;
    const {x, y} = boxPoint(event);
    const start = drag.start;
    setDraft({x: Math.min(x, start.x), y: Math.min(y, start.y), width: Math.abs(x - start.x), height: Math.abs(y - start.y)});
  }
  regionStage.addEventListener('pointermove', moveBox);
  regionStage.addEventListener('pointerup', event => {
    if (regionEditor?.drag?.id !== event.pointerId) return;
    moveBox(event);
    const {width, height} = regionEditor.box;
    if (width < .005 || height < .005) restoreBox();
    else regionEditor.drag = null;
  });
  regionStage.addEventListener('pointercancel', restoreBox);
  function restoreBox() {
    if (!regionEditor?.drag) return;
    regionEditor.box = regionEditor.drag.previous;
    regionEditor.drag = null;
    if (regionEditor.box) setDraft(regionEditor.box);
    else draftOverlay.hidden = true;
  }

  regionStage.addEventListener('keydown', event => {
    const step = .01;
    const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
    const dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
    if (!dx && !dy) return;
    event.preventDefault();
    const {x, y, width, height} = regionEditor.box || {x: .3, y: .3, width: .4, height: .4};
    setDraft(event.shiftKey
      ? {x, y, width: clamp(width + dx, .005, 1 - x), height: clamp(height + dy, .005, 1 - y)}
      : {x: clamp(x + dx, 0, 1 - width), y: clamp(y + dy, 0, 1 - height), width, height});
  });

  $('thumbnail-region-form').addEventListener('submit', event => {
    event.preventDefault();
    const {reference, item, box} = regionEditor;
    const name = regionName.value.trim();
    if (!box) { regionStatus.textContent = 'Draw a box around the part of the image you want to name.'; regionStage.focus(); return; }
    if (!name || /[\[\]@\r\n]/u.test(name)) {
      regionStatus.textContent = 'Enter a name without brackets or @.';
      regionName.focus();
      return;
    }
    if ([...references.values()].some(ref => ref.regions.some(region => region !== item && region.name.toLowerCase() === name.toLowerCase()))) {
      regionStatus.textContent = 'That box name is already in use.';
      regionName.focus();
      return;
    }
    const saved = {name, box};
    if (item) {
      reference.regions = reference.regions.map(region => region === item ? saved : region);
      conceptInput.value = conceptInput.value.replace(/@\[([^\]\n]+)\]/gu, (token, label) =>
        label.toLowerCase() === item.name.toLowerCase() ? mentionText(saved) : token);
    } else reference.regions.push(saved);
    update();
    closeRegion();
  });
  regionDelete.addEventListener('click', () => {
    const {reference, item} = regionEditor;
    reference.regions = reference.regions.filter(region => region !== item);
    update();
    closeRegion();
  });
  function closeRegion() {
    const {reference, url} = regionEditor;
    if (url) URL.revokeObjectURL(url);
    regionImage.removeAttribute('src');
    regionEditor = null;
    regionDialog.close();
    $(`thumbnail-add-box-${reference.number}`)?.focus();
  }
  $('thumbnail-region-close').addEventListener('click', closeRegion);
  regionDialog.addEventListener('cancel', event => {
    event.preventDefault();
    closeRegion();
  });

  function update() {
    const count = `${references.size} of 5 references selected`;
    $('thumbnail-count').textContent = `(${references.size})`;
    $('thumbnail-selected-count').textContent = count;
    for (const tile of grid.children) {
      tile.setAttribute('aria-pressed', String(references.has(Number(tile.dataset.imageId))));
    }
    for (const tile of gameGrid.children) {
      tile.setAttribute('aria-pressed', String(references.has(tile.dataset.referenceId)));
    }
    $('thumbnail-references').replaceChildren();
    for (const [id, reference] of references) {
      const {name, tags} = reference;
      const row = document.createElement('div');
      row.className = 'thumbnail-reference';
      const mentionButton = document.createElement('button');
      mentionButton.type = 'button';
      mentionButton.className = 'secondary thumbnail-mention-button';
      mentionButton.setAttribute('aria-label', `Insert ${name} in description`);
      mentionButton.append(referenceImage(reference), name);
      mentionButton.addEventListener('click', () => insertMention(reference));
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-button';
      button.textContent = 'Remove';
      button.setAttribute('aria-label', `Remove ${name} reference`);
      button.addEventListener('click', () => {
        if (reference.previewUrl) URL.revokeObjectURL(reference.previewUrl);
        references.delete(id);
        $('thumbnail-status').textContent = '';
        $('thumbnail-gallery-status').textContent = '';
        update();
      });
      const heading = document.createElement('div');
      heading.className = 'thumbnail-reference-heading';
      heading.append(mentionButton, button);
      const tagsGroup = document.createElement('fieldset');
      tagsGroup.className = 'thumbnail-reference-tags';
      const legend = document.createElement('legend');
      legend.textContent = 'Use this image for';
      tagsGroup.append(legend);
      for (const tag of Object.keys(tagDescriptions)) {
        const choice = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = tags.has(tag);
        input.addEventListener('change', () => {
          if (input.checked) tags.add(tag);
          else tags.delete(tag);
        });
        const text = document.createElement('span');
        text.textContent = tag;
        choice.append(input, text);
        tagsGroup.append(choice);
      }
      const regions = document.createElement('div');
      regions.className = 'thumbnail-region-list';
      const addBox = regionButton('Add box', () => openRegion(reference));
      addBox.id = `thumbnail-add-box-${reference.number}`;
      addBox.setAttribute('aria-label', `Add a box to ${name}`);
      regions.append(addBox);
      for (const item of reference.regions) {
        const pair = document.createElement('span');
        const edit = regionButton('Edit', () => openRegion(reference, item));
        edit.setAttribute('aria-label', `Edit box ${item.name}`);
        pair.append(regionButton(mentionText(item), () => insertMention(item)), edit);
        regions.append(pair);
      }
      row.append(heading, tagsGroup, regions);
      $('thumbnail-references').append(row);
    }
    updateDescription();
  }

  function toggleReference(id, reference) {
    const status = $('thumbnail-status');
    $('thumbnail-gallery-status').textContent = '';
    if (references.has(id)) references.delete(id);
    else if (references.size < 5) addReference(id, reference);
    else {
      status.textContent = 'Remove a reference before adding another. The limit is five.';
      return;
    }
    status.textContent = '';
    update();
  }

  function showCollection() {
    previewObserver.disconnect();
    grid.replaceChildren();
    const collection = collections.find(item => item.id === picker.value);
    $('thumbnail-collection-help').textContent = collection?.images.length
      ? 'Click a thumbnail to select or deselect it.'
      : 'Save images to a collection with the heart in Explorer.';
    for (const id of collection?.images || []) {
      const tile = document.createElement('button');
      const image = document.createElement('img');
      const name = host.saved.referenceName(id);
      tile.type = 'button';
      tile.dataset.imageId = image.dataset.imageId = id;
      tile.setAttribute('aria-label', name);
      image.alt = '';
      tile.append(image);
      tile.addEventListener('click', () => toggleReference(id, {tags: new Set(['Visual style', 'Composition'])}));
      grid.append(tile);
      previewObserver.observe(image);
    }
    update();
  }

  async function refreshCollections() {
    const help = $('thumbnail-collection-help');
    picker.disabled = true;
    help.textContent = 'Loading collection previews…';
    try {
      await host.ready;
    } catch {
      help.textContent = 'Collection previews could not load. Reload the page or upload your own references.';
      return;
    }
    if (panel.inert) return;
    collections = host.saved?.referenceCollections() || [];
    const previous = picker.value;
    picker.replaceChildren(...collections.map(collection =>
      new Option(`${collection.name} (${collection.images.length})`, collection.id)));
    if (collections.some(collection => collection.id === previous)) picker.value = previous;
    else picker.value = (collections.find(collection => collection.images.length) || collections[0])?.id || '';
    picker.disabled = !collections.length;
    showCollection();
  }

  function openGenerator(focus = false) {
    const wasClosed = panel.inert;
    panel.inert = false;
    opener.setAttribute('aria-expanded', 'true');
    if (focus) $('thumbnail-title').focus();
    if (wasClosed) return refreshCollections();
  }

  function setFullscreen(expanded) {
    panel.toggleAttribute('data-fullscreen', expanded);
    fullscreen.setAttribute('aria-pressed', String(expanded));
    fullscreen.textContent = expanded ? 'Exit full screen' : 'Full screen';
    for (const element of document.querySelectorAll('body > main, body > .sidebar')) element.inert = expanded;
  }

  function closeGenerator() {
    setFullscreen(false);
    panel.inert = true;
    opener.setAttribute('aria-expanded', 'false');
    opener.focus();
  }

  window.galleryGenerator = {
    addReference({id, url}, focus = false) {
      openGenerator(focus);
      const status = $('thumbnail-gallery-status');
      if (references.has(id)) {
        status.textContent = `${references.get(id).name} is already a reference.`;
      } else if (references.size >= 5) {
        status.textContent = 'Remove a reference before adding another. The limit is five.';
      } else {
        addReference(id, {url, tags: new Set(['Visual style', 'Composition'])});
        update();
        status.textContent = `Added ${references.get(id).name} as a reference.`;
      }
    }
  };

  picker.addEventListener('change', showCollection);
  $('thumbnail-game-url').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    $('thumbnail-load-game').click();
  });
  $('thumbnail-load-game').addEventListener('click', async () => {
    const button = $('thumbnail-load-game'), status = $('thumbnail-game-status');
    let link;
    try { link = new URL($('thumbnail-game-url').value.trim()); } catch {}
    const place = link?.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?games\/([1-9]\d{0,19})(?:\/|$)/i)?.[1];
    if (!place || link.protocol !== 'https:' || !['roblox.com', 'www.roblox.com'].includes(link.host)) {
      status.textContent = 'Paste a Roblox game page link, such as https://www.roblox.com/games/12345.';
      return;
    }
    button.disabled = true;
    gameGrid.replaceChildren();
    status.textContent = 'Loading Roblox thumbnails…';
    try {
      const response = await fetch(`${gameThumbnailApi}?place=${place}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Roblox thumbnails are unavailable.');
      gameGrid.replaceChildren(...data.thumbnails.map((url, index) => {
        const tile = document.createElement('button'), image = document.createElement('img');
        const name = `Roblox thumbnail ${index + 1} (place ${place})`;
        tile.type = 'button';
        tile.dataset.referenceId = url;
        tile.setAttribute('aria-label', name);
        image.alt = '';
        image.src = url;
        image.loading = 'lazy';
        tile.append(image);
        tile.addEventListener('click', () => toggleReference(url, {url, tags: new Set(['Visual style', 'Composition'])}));
        return tile;
      }));
      update();
      status.textContent = data.thumbnails.length ? 'Select thumbnails to use as temporary references.' : 'Roblox returned no available thumbnails for this game.';
    } catch (error) {
      status.textContent = error instanceof TypeError || error instanceof SyntaxError ? 'Could not load Roblox thumbnails. Try again later.' : error.message;
    } finally { button.disabled = false; }
  });
  for (const event of ['gallery:connected', 'gallery:saved', 'gallery:saved-view']) {
    window.addEventListener(event, () => { if (!panel.inert) refreshCollections(); });
  }
  $('thumbnail-upload').addEventListener('change', event => {
    const files = [...event.target.files];
    const status = $('thumbnail-status');
    if (files.length + references.size > 5) {
      status.textContent = 'Choose up to 5 references in total.';
    } else if (files.some(file => !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 10 * 1024 * 1024 || !file.size)) {
      status.textContent = 'Choose nonempty PNG, JPEG, WEBP, or GIF images under 10 MB each.';
    } else {
      for (const file of files) addReference(null, {file, tags: new Set(['Character'])});
      status.textContent = '';
      update();
    }
    event.target.value = '';
  });
  opener.addEventListener('click', () => { if (panel.inert) openGenerator(true); else closeGenerator(); });
  $('thumbnail-close').addEventListener('click', closeGenerator);
  fullscreen.addEventListener('click', () => setFullscreen(!panel.hasAttribute('data-fullscreen')));
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    if (panel.hasAttribute('data-fullscreen')) setFullscreen(false);
    else closeGenerator();
  });
  if (opener.hasAttribute('data-open-on-load')) window.addEventListener('DOMContentLoaded', () => openGenerator());
  function asDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read a reference image.'));
      reader.readAsDataURL(file);
    });
  }
  async function exportThumbnail(blob, width, height) {
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const scale = Math.max(width / bitmap.width, height / bitmap.height);
      const drawnWidth = bitmap.width * scale, drawnHeight = bitmap.height * scale;
      canvas.getContext('2d').drawImage(bitmap, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
      return await new Promise((resolve, reject) => canvas.toBlob(file => {
        if (file) resolve(file);
        else reject(new Error('Could not prepare the thumbnail for download.'));
      }, 'image/png'));
    } finally { bitmap.close(); }
  }

  async function referenceFile(reference) {
    let file = reference.file;
    if (reference.url) {
      const response = await fetch(reference.url, {cache: 'no-store'});
      if (!response.ok) throw new Error('Could not download a Roblox reference. Reload the game thumbnails and try again.');
      const downloaded = await response.blob();
      file = new Blob([downloaded], {type: downloaded.type.toLowerCase()});
    }
    if (!file) file = await host.imageFile(reference.id);
    if (file.size > 10 * 1024 * 1024) throw new Error('A reference exceeds 10 MB. Choose a smaller image.');
    return file;
  }

  async function imagePart(file) {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/s.exec(await asDataUrl(file));
    if (!match) throw new Error('A reference must be a PNG, JPEG, WEBP, or GIF image.');
    return {inlineData: {mimeType: match[1], data: match[2]}};
  }

  async function cropPart(bitmap, {x, y, width, height}) {
    const left = Math.floor(x * bitmap.width), top = Math.floor(y * bitmap.height);
    const cropWidth = Math.min(bitmap.width, Math.ceil((x + width) * bitmap.width)) - left;
    const cropHeight = Math.min(bitmap.height, Math.ceil((y + height) * bitmap.height)) - top;
    const scale = Math.min(1, 1024 / Math.max(cropWidth, cropHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(cropWidth * scale));
    canvas.height = Math.max(1, Math.round(cropHeight * scale));
    canvas.getContext('2d').drawImage(bitmap, left, top, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
    const crop = await new Promise((resolve, reject) => canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('Could not prepare a named box. Try drawing it again.'));
    }, 'image/webp', .92));
    return imagePart(crop);
  }

  async function generationParts(concept, textEnabled, wording) {
    const selected = [...references.values()].map(reference => ({...reference, tags: new Set(reference.tags), regions: [...reference.regions]}));
    const mentionedBoxes = new Set();
    let description = '', from = 0;
    for (const mention of referenceMentions(concept)) {
      const found = findMention(mention, selected);
      if (!found) throw new Error(`Remove or replace ${mention[0]} in the description. That ${mention[2] ? 'box is no longer available' : 'image is no longer selected'}.`);
      if (found.item.box) mentionedBoxes.add(found.item);
      description += concept.slice(from, mention.index) + mentionText(found.item);
      from = mention.index + mention[0].length;
    }
    if (selected.some(reference => !reference.tags.size && !reference.regions.some(region => mentionedBoxes.has(region)))) {
      throw new Error('Choose at least one tag or mention a named box for each reference image.');
    }
    const promptResponse = await fetch('./thumbnail-prompt.txt');
    if (!promptResponse.ok) throw new Error('The background prompt could not be loaded.');
    const prompt = await promptResponse.text();
    const textInstruction = textEnabled
      ? wording ? `Render this exact text with the same spelling, punctuation and capitalization: ${JSON.stringify(wording)}. Avoid unrelated lettering and watermarks.`
        : 'Text is allowed. Use wording from the scene description if provided, or use a short title if it fits. Avoid unrelated lettering and watermarks.'
      : 'Do not add titles, captions, signage, watermarks, or other text. Preserve any lettering that is part of a Logo-tagged reference within the logo itself. Do not repeat that lettering elsewhere.';
    const scene = description + concept.slice(from) || (selected.length
      ? 'Create a coherent Roblox thumbnail using the attached images according to their reference tags. Fill in unspecified scene details to fit those references.'
      : 'Create an original Roblox game thumbnail with a clear subject, action, and setting.');
    const parts = [{text: `${prompt}\n\nUSER REQUEST:\n${scene}\n\nTEXT SETTINGS:\n${textInstruction}`}];
    if (mentionedBoxes.size) {
      parts.push({text: 'Each @[name] in the description refers to a separately attached crop from a reference image. Follow the requested action, pose, or position for that specific subject. When several crops come from one image, treat their contents as separate references and keep their identities and assigned roles distinct. These explicit assignments take priority over default whole-image tags. Do not render the mention names as text.'});
    }
    // Keep selection order within each group so the first reference for each tag remains primary.
    const ordered = [
      ...selected.filter(reference => reference.tags.has('Character')),
      ...selected.filter(reference => !reference.tags.has('Character'))
    ];
    const hasCharacter = ordered[0]?.tags.has('Character');
    if (hasCharacter) {
      parts.push({text: `By default, use @${ordered[0].name} as the subject to restage. Keep its recognizable geometry, face, silhouette, and distinctive features. When following the framing or pose from another image, put this subject in that pose and position. Follow any explicit character assignments in the description.`});
    }
    for (const reference of ordered) {
      const file = await referenceFile(reference);
      const instructions = Object.keys(tagDescriptions)
        .filter(tag => reference.tags.has(tag))
        .map(tag => `${tag}: ${tagDescriptions[tag]}`);
      const uses = instructions.length ? `Default uses: ${instructions.join('; ')}.` : 'Use the full image as context for its named crops.';
      parts.push({text: `@${reference.name} refers to the single image attached immediately after this note. ${uses} Use this image as directed by any explicit mention in the description. Follow the text settings above.`});
      parts.push(await imagePart(file));
      const crops = reference.regions.filter(region => mentionedBoxes.has(region));
      if (crops.length) {
        const bitmap = await createImageBitmap(file);
        try {
          for (const region of crops) {
            parts.push({text: `${mentionText(region)} refers to the crop from @${reference.name} attached immediately after this note. Use the subject shown in this crop for the role specified by this mention.`});
            parts.push(await cropPart(bitmap, region.box));
          }
        } finally { bitmap.close(); }
      }
    }
    if (!hasCharacter) {
      parts.push({text: 'The following three character reference sheets illustrate Roblox character proportions, blocky bodies, hands and hair. Use them only for Roblox player anatomy when a player is requested. Use only the selected reference tags to guide the rendering style, composition, lighting, and palette. Do not add a player unless requested. Ignore these sheets’ labels, colors, rendering style and layout.'});
      for (let i = 1; i <= 3; i++) {
        const response = await fetch(`./character-references/character-${i}.jpeg`);
        if (!response.ok) throw new Error('Could not load the character references. Please try again.');
        const dataUrl = await asDataUrl(await response.blob());
        parts.push({inlineData: {mimeType: 'image/jpeg', data: dataUrl.split(',')[1]}});
      }
      parts.push({text: 'The following three face reference sheets contain examples of Roblox GFX facial expressions. Use only when a player character is requested. Choose an appropriate expression and render it in the requested visual style, not the rendering style of these sheets. Do not copy the sheet layout.'});
      for (let i = 1; i <= 3; i++) {
        const response = await fetch(`./character-references/faces-${i}.png`);
        if (!response.ok) throw new Error('Could not load the face references. Please try again.');
        const dataUrl = await asDataUrl(await response.blob());
        parts.push({inlineData: {mimeType: 'image/png', data: dataUrl.split(',')[1]}});
      }
    }
    const assigned = Object.keys(tagDescriptions).flatMap(tag => {
      const images = selected.filter(reference => reference.tags.has(tag)).map(reference => `@${reference.name}`);
      if (!images.length) return [];
      return [`${tag}: ${images[0]}${images.length > 1 ? ` (supporting: ${images.slice(1).join(', ')})` : ''}`];
    });
    if (selected.some(reference => reference.tags.has('Composition'))) {
      parts.push({text: 'Keep the primary Composition camera viewpoint unless the description assigns a different viewpoint or Composition image. If first person, frame the scene through the player’s eyes with only visible hands, arms, or equipment. A player mentioned in the description remains the viewpoint character unless a different camera is explicitly requested.'});
    }
    if (assigned.length) {
      parts.push({text: `Default reference assignments: ${assigned.join('; ')}. Explicit uses of named images in the description take priority for the specified aspects. Combine the remaining assignments independently. For a Character assignment, use that character as the subject and replace characters from composition or style images. Use Lighting for exposure, illumination and shadows. Use Colors for palette, saturation and the balance of dark and light tones. If Colors is assigned without Lighting, match the overall brightness and contrast of the Colors image too. Apply this to the environment as well as the subject.`});
    }
    return parts;
  }
  const generate = $('thumbnail-generate'), applyEdit = $('thumbnail-apply-edit');
  const editButton = $('thumbnail-edit'), editFields = $('thumbnail-edit-fields');
  const editInstructions = $('thumbnail-edit-instructions');
  const upscaleButton = $('thumbnail-upscale'), upscaledDownload = $('thumbnail-upscaled-download');
  const status = $('thumbnail-status');
  let upscaleWorker, upscaledUrl;

  function setBusy(busy) {
    generate.disabled = applyEdit.disabled = upscaleButton.disabled = busy;
  }

  function upscaleThumbnail(image) {
    upscaleWorker ||= new Worker('./thumbnail-upscaler.js');
    return new Promise((resolve, reject) => {
      upscaleWorker.onerror = () => reject(new Error('The upscaler could not start.'));
      upscaleWorker.onmessage = ({data}) => {
        if (data.error) reject(new Error(data.error));
        else if (data.image) resolve(data.image);
        else status.textContent = `Upscaling thumbnail… ${Math.floor(data.progress * 100)}%`;
      };
      upscaleWorker.postMessage(image);
    });
  }

  upscaleButton.addEventListener('click', async () => {
    if (!result || generate.disabled || upscaleButton.hidden) return;
    setBusy(true);
    status.textContent = 'Loading the upscaling model…';
    try {
      upscaledUrl = URL.createObjectURL(await upscaleThumbnail(result));
      upscaledDownload.href = upscaledUrl;
      upscaledDownload.hidden = false;
      upscaleButton.hidden = true;
      upscaledDownload.focus();
      status.textContent = 'Upscaled thumbnail ready · 1920 × 1080';
    } catch {
      upscaleWorker?.terminate();
      upscaleWorker = undefined;
      status.textContent = 'Could not upscale this thumbnail. Try again or download the original.';
    } finally { setBusy(false); }
  });

  editButton.addEventListener('click', () => {
    editFields.hidden = !editFields.hidden;
    editButton.setAttribute('aria-expanded', String(!editFields.hidden));
    if (!editFields.hidden) editInstructions.focus();
  });
  $('thumbnail-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (generate.disabled) return;
    const editing = event.submitter === applyEdit;
    const key = keyInput.value.trim();
    const concept = conceptInput.value.trim();
    const changes = editInstructions.value.trim();
    const imageSize = $('thumbnail-resolution').value === '1K' ? '1K' : '2K';
    const [width, height] = imageSize === '1K' ? [960, 540] : [1920, 1080];
    if (!key || (editing && (!result || !changes))) {
      status.textContent = editing ? 'Enter an API key and describe what to change.' : 'Enter an API key.';
      return;
    }
    setBusy(true);
    status.textContent = editing ? 'Editing thumbnail…' : 'Generating thumbnail…';
    try {
      const parts = editing ? [
        {text: 'Edit this Roblox thumbnail according to the request below. Preserve the composition, subjects, style, and existing lettering except where the request calls for changes. Return the edited image only.'},
        {inlineData: {mimeType: result.type, data: (await asDataUrl(result)).split(',')[1]}},
        {text: allowText.checked ? changes : `${changes}\nDo not add new lettering outside logos.`}
      ] : await generationParts(concept, allowText.checked, $('thumbnail-wording').value.trim());
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent', {
        method: 'POST', headers: {'Content-Type': 'application/json', 'x-goog-api-key': key},
        body: JSON.stringify({contents: [{parts}], generationConfig: {responseModalities: ['IMAGE'], imageConfig: {aspectRatio: '16:9', imageSize}}})
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || `Google returned error ${response.status}.`);
      const image = (data.candidates || []).flatMap(candidate => candidate.content?.parts || [])
        .find(part => !part.thought && part.inlineData?.data)?.inlineData;
      if (!image) throw new Error('Google did not return an image. Try adjusting your description or references.');
      const bytes = Uint8Array.from(atob(image.data), c => c.charCodeAt(0));
      const exported = await exportThumbnail(new Blob([bytes], {type: image.mimeType || 'image/png'}), width, height);
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      result = exported;
      resultUrl = URL.createObjectURL(result);
      $('thumbnail-result').src = resultUrl; $('thumbnail-result').hidden = false;
      $('thumbnail-download').href = resultUrl; $('thumbnail-download').hidden = false;
      if (upscaledUrl) URL.revokeObjectURL(upscaledUrl);
      upscaledUrl = undefined;
      upscaledDownload.hidden = true;
      upscaleButton.hidden = imageSize !== '1K';
      editButton.hidden = false;
      editInstructions.value = '';
      if (!editing) {
        editFields.hidden = true;
        editButton.setAttribute('aria-expanded', 'false');
      }
      status.textContent = `${editing ? 'Edit ready' : 'Thumbnail ready'} · ${width} × ${height}`;
    } catch (error) { status.textContent = error instanceof TypeError ? 'Could not reach the generation service. Check your connection and try again.' : error.message; }
    finally { setBusy(false); }
  });
})();
