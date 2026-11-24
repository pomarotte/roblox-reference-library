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
  const grid = $('thumbnail-collection-images');
  const gameGrid = $('thumbnail-game-images');
  const conceptInput = $('thumbnail-concept');
  const mentionPreview = $('thumbnail-mention-preview');
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
    return text.matchAll(/@Image ([1-9]\d*)(?![\p{L}\p{N}_])/giu);
  }

  function updateMentionPreview() {
    const {value, selectionStart, selectionEnd} = conceptInput;
    const mention = document.activeElement === conceptInput && [...referenceMentions(value)].find(match => {
      const end = match.index + match[0].length;
      return (match.index <= selectionStart && selectionEnd <= end) ||
        (selectionStart === selectionEnd && selectionEnd === end + 1 && value[end] === ' ');
    });
    const reference = mention && [...references.values()].find(item => item.number === Number(mention[1]));
    mentionPreview.hidden = !reference;
    if (!reference) {
      mentionPreview.replaceChildren();
    } else if (mentionPreview.textContent !== reference.name) {
      mentionPreview.replaceChildren(referenceImage(reference), reference.name);
    }
  }

  for (const event of ['input', 'select', 'selectionchange', 'click', 'focus', 'blur']) {
    conceptInput.addEventListener(event, updateMentionPreview);
  }

  function insertMention(reference) {
    const {value, selectionStart, selectionEnd} = conceptInput;
    const before = selectionStart && !/\s/.test(value[selectionStart - 1]) ? ' ' : '';
    const atEnd = selectionEnd === value.length;
    const after = atEnd || /[\p{L}\p{N}_@]/u.test(value[selectionEnd]) ? ' ' : '';
    const mention = `@${reference.name}`;
    conceptInput.setRangeText(`${before}${mention}${after}`, selectionStart, selectionEnd, 'end');
    conceptInput.focus();
    const end = selectionStart + before.length + mention.length + (atEnd ? 1 : 0);
    conceptInput.setSelectionRange(end, end);
    updateMentionPreview();
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
    references.set(id, {...reference, id, number, name: `Image ${number}`});
  }

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
      row.append(heading, tagsGroup);
      $('thumbnail-references').append(row);
    }
    updateMentionPreview();
  }

  function toggleReference(id, reference) {
    const status = $('thumbnail-status');
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
      : 'Save images using the heart or + in the gallery to choose them here.';
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

  async function openGenerator() {
    const dialog = $('thumbnail-dialog');
    const help = $('thumbnail-collection-help');
    dialog.showModal();
    picker.disabled = true;
    help.textContent = 'Loading collection previews…';
    try {
      await host.ready;
    } catch {
      help.textContent = 'Collection previews could not load. Reload the page or upload your own references.';
      return;
    }
    if (!dialog.open) return;
    collections = host.saved?.referenceCollections() || [];
    const previous = picker.value;
    picker.replaceChildren(...collections.map(collection =>
      new Option(`${collection.name} (${collection.images.length})`, collection.id)));
    if (collections.some(collection => collection.id === previous)) picker.value = previous;
    else picker.value = (collections.find(collection => collection.images.length) || collections[0])?.id || '';
    picker.disabled = !collections.length;
    showCollection();
  }

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
  window.addEventListener('gallery:connected', () => {
    if ($('thumbnail-dialog').open) showCollection();
  });
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
  $('thumbnail-open').addEventListener('click', openGenerator);
  $('thumbnail-close').addEventListener('click', () => $('thumbnail-dialog').close());
  window.addEventListener('DOMContentLoaded', openGenerator);
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
  async function generationParts(concept, textEnabled, wording) {
    const selected = [...references.values()].map(reference => ({...reference, tags: new Set(reference.tags)}));
    for (const mention of referenceMentions(concept)) {
      if (!selected.some(reference => reference.number === Number(mention[1]))) {
        throw new Error(`Remove or replace ${mention[0]} in the description. That image is no longer selected.`);
      }
    }
    if (selected.some(reference => !reference.tags.size)) {
      throw new Error('Choose at least one tag for each reference image.');
    }
    const promptResponse = await fetch('./thumbnail-prompt.txt');
    if (!promptResponse.ok) throw new Error('The background prompt could not be loaded.');
    const prompt = await promptResponse.text();
    const textInstruction = textEnabled
      ? wording ? `Render this exact text with the same spelling, punctuation and capitalization: ${JSON.stringify(wording)}. Avoid unrelated lettering and watermarks.`
        : 'Text is allowed. Use wording from the scene description if provided, or use a short title if it fits. Avoid unrelated lettering and watermarks.'
      : 'Do not add titles, captions, signage, watermarks, or other text. Preserve any lettering that is part of a Logo-tagged reference within the logo itself. Do not repeat that lettering elsewhere.';
    const scene = concept || (selected.length
      ? 'Create a coherent Roblox thumbnail using the attached images according to their reference tags. Fill in unspecified scene details to fit those references.'
      : 'Create an original Roblox game thumbnail with a clear subject, action, and setting.');
    const parts = [{text: `${prompt}\n\nUSER REQUEST:\n${scene}\n\nTEXT SETTINGS:\n${textInstruction}`}];
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
      let file = reference.file;
      if (reference.url) {
        const response = await fetch(reference.url, {cache: 'no-store'});
        if (!response.ok) throw new Error('Could not download a Roblox reference. Reload the game thumbnails and try again.');
        const downloaded = await response.blob();
        file = new Blob([downloaded], {type: downloaded.type.toLowerCase()});
      }
      if (!file) file = await host.imageFile(reference.id);
      if (file.size > 10 * 1024 * 1024) throw new Error('A reference exceeds 10 MB. Choose a smaller image.');
      const dataUrl = await asDataUrl(file);
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/s.exec(dataUrl);
      if (!match) throw new Error('A reference must be a PNG, JPEG, WEBP, or GIF image.');
      const instructions = Object.keys(tagDescriptions)
        .filter(tag => reference.tags.has(tag))
        .map(tag => `${tag}: ${tagDescriptions[tag]}`);
      parts.push({text: `@${reference.name} refers to the single image attached immediately after this note. Default uses: ${instructions.join('; ')}. Use this image as directed by any explicit mention in the description. Follow the text settings above.`});
      parts.push({inlineData: {mimeType: match[1], data: match[2]}});
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
