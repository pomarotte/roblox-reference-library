'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const references = new Map();
  let resultUrl, uploadId = 0, collections = [];
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
  const previewObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      previewObserver.unobserve(entry.target);
      host.imageSource(entry.target, Number(entry.target.dataset.imageId));
    }
  });

  function update() {
    const count = `${references.size} of 5 references selected`;
    $('thumbnail-count').textContent = `(${references.size})`;
    $('thumbnail-selected-count').textContent = count;
    for (const tile of grid.children) {
      tile.setAttribute('aria-pressed', String(references.has(Number(tile.dataset.imageId))));
    }
    $('thumbnail-references').replaceChildren();
    for (const [id, {name}] of references) {
      const row = document.createElement('div');
      row.className = 'thumbnail-reference';
      const label = document.createElement('span');
      label.textContent = name;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-button';
      button.textContent = 'Remove';
      button.setAttribute('aria-label', `Remove ${name} reference`);
      button.addEventListener('click', () => {
        references.delete(id);
        $('thumbnail-status').textContent = '';
        update();
      });
      row.append(label, button);
      $('thumbnail-references').append(row);
    }
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
      tile.addEventListener('click', () => {
        const status = $('thumbnail-status');
        if (references.has(id)) references.delete(id);
        else if (references.size < 5) references.set(id, {name});
        else {
          status.textContent = 'Remove a reference before adding another. The limit is five.';
          return;
        }
        status.textContent = '';
        update();
      });
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
      for (const file of files) references.set(`upload-${++uploadId}`, {name: file.name, file});
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
  $('thumbnail-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('thumbnail-generate'), status = $('thumbnail-status');
    const key = keyInput.value.trim();
    if (!key || !$('thumbnail-concept').value.trim()) { status.textContent = 'Enter an API key and thumbnail description.'; return; }
    button.disabled = true; status.textContent = 'Generating thumbnail…';
    try {
      const promptResponse = await fetch('./thumbnail-prompt.txt');
      if (!promptResponse.ok) throw new Error('The background prompt could not be loaded.');
      const prompt = await promptResponse.text();
      const parts = [{text: `${prompt}\n\nUSER REQUEST:\n${$('thumbnail-concept').value.trim()}`}];
      if (references.size) parts.push({text: 'The next images are the user-selected thumbnail style and composition references, in selection order. The first is the primary visual template.'});
      for (const [id, reference] of [...references]) {
        const file = reference.file || await host.imageFile(id);
        if (file.size > 10 * 1024 * 1024) throw new Error('A reference exceeds 10 MB. Choose a smaller image.');
        const dataUrl = await asDataUrl(file);
        const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/s.exec(dataUrl);
        if (!match) throw new Error('A reference must be a PNG, JPEG, WEBP, or GIF image.');
        parts.push({inlineData: {mimeType: match[1], data: match[2]}});
      }
      parts.push({text: 'The following three character reference sheets illustrate Roblox character proportions, blocky bodies, hands and hair. Use them only for Roblox player anatomy when a player is requested. The selected thumbnail controls the rendering style, composition, framing, lighting, and palette. Do not add a player unless requested. Ignore these sheets’ labels, colors, rendering style and layout.'});
      for (let i = 1; i <= 3; i++) {
        const response = await fetch(`./character-references/character-${i}.jpeg`);
        if (!response.ok) throw new Error('Could not load the character references. Please try again.');
        const dataUrl = await asDataUrl(await response.blob());
        parts.push({inlineData: {mimeType: 'image/jpeg', data: dataUrl.split(',')[1]}});
      }
      parts.push({text: 'The following three face reference sheets contain examples of Roblox GFX facial expressions. Use only when a player character is requested. Choose an appropriate expression and render it in the visual style of the primary thumbnail, not the rendering style of these sheets. Do not copy the sheet layout.'});
      for (let i = 1; i <= 3; i++) {
        const response = await fetch(`./character-references/faces-${i}.png`);
        if (!response.ok) throw new Error('Could not load the face references. Please try again.');
        const dataUrl = await asDataUrl(await response.blob());
        parts.push({inlineData: {mimeType: 'image/png', data: dataUrl.split(',')[1]}});
      }
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent', {
        method: 'POST', headers: {'Content-Type': 'application/json', 'x-goog-api-key': key},
        body: JSON.stringify({contents: [{parts}], generationConfig: {responseModalities: ['IMAGE'], imageConfig: {aspectRatio: $('thumbnail-aspect').value, imageSize: '2K'}}})
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || `Google returned error ${response.status}.`);
      const image = (data.candidates || []).flatMap(candidate => candidate.content?.parts || [])
        .find(part => !part.thought && part.inlineData?.data)?.inlineData;
      if (!image) throw new Error('Google did not return an image. Try adjusting your description or references.');
      const bytes = Uint8Array.from(atob(image.data), c => c.charCodeAt(0));
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      resultUrl = URL.createObjectURL(new Blob([bytes], {type: image.mimeType || 'image/png'}));
      $('thumbnail-result').src = resultUrl; $('thumbnail-result').hidden = false;
      $('thumbnail-download').href = resultUrl; $('thumbnail-download').hidden = false;
      status.textContent = 'Thumbnail ready.';
    } catch (error) { status.textContent = error instanceof TypeError ? 'Could not reach the generation service. Check your connection and try again.' : error.message; }
    finally { button.disabled = false; }
  });
})();
