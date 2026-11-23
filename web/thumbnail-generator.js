'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const references = new Map();
  let current, resultUrl, uploadId = 0;
  const add = $('thumbnail-add');
  add.hidden = false;
  function update() {
    $('thumbnail-count').textContent = `(${references.size} reference${references.size === 1 ? '' : 's'})`;
    add.textContent = current && references.has(current.id) ? 'Remove reference' : 'Add as reference';
    $('thumbnail-references').replaceChildren();
    for (const [id, reference] of references) {
      const name = reference.name;
      const row = document.createElement('div');
      row.className = 'thumbnail-reference';
      const label = document.createElement('span');
      label.textContent = name;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'text-button'; button.textContent = 'Remove';
      button.setAttribute('aria-label', `Remove ${name} reference`);
      button.addEventListener('click', () => { references.delete(id); update(); });
      row.append(label, button); $('thumbnail-references').append(row);
    }
  }
  window.addEventListener('gallery:preview-image', event => { current = event.detail; update(); });
  add.addEventListener('click', () => {
    if (!current) return;
    if (references.has(current.id)) references.delete(current.id);
    else if (references.size < 5) references.set(current.id, {name: current.name});
    else { $('viewer-error').textContent = 'Choose up to 5 references.'; $('viewer-error').hidden = false; }
    update();
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
  $('thumbnail-open').addEventListener('click', () => $('thumbnail-dialog').showModal());
  $('thumbnail-close').addEventListener('click', () => $('thumbnail-dialog').close());
  window.addEventListener('DOMContentLoaded', () => $('thumbnail-dialog').showModal());
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
    if (!$('thumbnail-key').value.trim() || !$('thumbnail-concept').value.trim()) { status.textContent = 'Enter an API key and thumbnail description.'; return; }
    button.disabled = true; status.textContent = 'Generating thumbnail…';
    try {
      const promptResponse = await fetch('./thumbnail-prompt.txt');
      if (!promptResponse.ok) throw new Error('The background prompt could not be loaded.');
      const prompt = await promptResponse.text();
      const input = [{type: 'text', text: `${prompt}\n\nUSER REQUEST:\n${$('thumbnail-concept').value.trim()}`}];
      for (const [id, reference] of references) {
        const file = reference.file || await window.galleryHost.imageFile(id);
        if (file.size > 10 * 1024 * 1024) throw new Error('A reference exceeds 10 MB. Choose a smaller image.');
        const dataUrl = await asDataUrl(file);
        const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/s.exec(dataUrl);
        if (!match) throw new Error('A reference must be a PNG, JPEG, WEBP, or GIF image.');
        input.push({type: 'image', mime_type: match[1], data: match[2]});
      }
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST', headers: {'Content-Type': 'application/json', 'x-goog-api-key': $('thumbnail-key').value.trim(), 'Api-Revision': '2026-05-20'},
        body: JSON.stringify({model: 'gemini-nano-banana-2.1', store: false, input, response_format: {type: 'image', mime_type: 'image/png', aspect_ratio: $('thumbnail-aspect').value, image_size: '2K'}})
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || `Google returned error ${response.status}.`);
      const image = (data.steps || []).filter(step => step.type === 'model_output').flatMap(step => step.content || []).find(part => part.type === 'image' && part.data);
      if (!image) throw new Error('Google did not return an image. Try adjusting your description or references.');
      const bytes = Uint8Array.from(atob(image.data), c => c.charCodeAt(0));
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      resultUrl = URL.createObjectURL(new Blob([bytes], {type: image.mime_type || 'image/png'}));
      $('thumbnail-result').src = resultUrl; $('thumbnail-result').hidden = false;
      $('thumbnail-download').href = resultUrl; $('thumbnail-download').hidden = false;
      status.textContent = 'Thumbnail ready.';
    } catch (error) { status.textContent = error.message || 'Generation failed. Please try again.'; }
    finally { button.disabled = false; }
  });
})();
