const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const elements = new Map(), events = {};
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    id, value: '', hidden: false, children: [], handlers: {}, dataset: {}, attributes: {}, style: {}, selectionStart: 0, selectionEnd: 0,
    addEventListener(type, fn) {this.handlers[type] = fn;},
    replaceChildren(...nodes) {this.children = nodes;},
    append(...nodes) {this.children.push(...nodes);},
    setAttribute(name, value) {this.attributes[name] = value;},
    hasAttribute(name) {return Object.hasOwn(this.attributes, name);},
    removeAttribute(name) {delete this.attributes[name];},
    toggleAttribute(name, force) {if (force) this.attributes[name] = ''; else delete this.attributes[name];},
    showModal() {this.open = true;}, close() {this.open = false;},
    async decode() {}, setPointerCapture() {},
    getBoundingClientRect() {return {left: 10, top: 20, width: 100, height: 100};},
    focus() {document.activeElement = this;},
    setRangeText(text, start, end) {this.value = this.value.slice(0, start) + text + this.value.slice(end);},
    setSelectionRange(start, end) {this.selectionStart = start; this.selectionEnd = end;}
  });
  return elements.get(id);
}
const calls = [];
class Reader {
  async readAsDataURL(file) {
    const data = file instanceof Blob ? Buffer.from(await file.arrayBuffer()).toString('base64') : 'YQ==';
    this.result = `data:${file.type};base64,${data}`;
    this.onload();
  }
}
const exportsMade = [];
const exposureAdjustments = [];
const brightPixel = [100, 190, 245, 255];
const darkPixel = [28, 32, 50, 255];
const galleryPixel = [100, 100, 100, 255];
const explorer = element('explorer');
const document = {getElementById: element, querySelectorAll: () => [explorer], createElement: tag => {
  if (tag !== 'canvas') return element(Symbol());
  const canvas = {
    getContext: () => ({
      drawImage(image, ...rectangle) {
        canvas.rectangle = rectangle;
        canvas.pixel = image.pixel;
      },
      getImageData() { return {data: new Uint8ClampedArray(canvas.pixel)}; },
      putImageData({data}) { exposureAdjustments.push([...data]); }
    }),
    toBlob: (callback, type) => {
      exportsMade.push({width: canvas.width, height: canvas.height, rectangle: canvas.rectangle, type});
      callback(new Blob([`output-${exportsMade.length}`], {type}));
    }
  };
  return canvas;
}};
const storage = new Map([['rolibrary-gemini-api-key', 'previous-key']]);
let finishCatalogue;
const ready = new Promise(resolve => { finishCatalogue = resolve; });
const previewRequests = [];
const upscaleInputs = [];
let failUpscale = true;
class Worker {
  constructor(path) { assert.equal(path, './thumbnail-upscaler.js'); }
  async postMessage(input) {
    upscaleInputs.push(await input.text());
    this.onmessage({data: {progress: 0.5}});
    this.onmessage({data: failUpscale ? {error: 'Test upscale failure'} : {image: new Blob(['upscaled'], {type: 'image/png'})}});
  }
  terminate() {}
}
const window = {
  localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
  addEventListener(type, fn) {events[type] = fn;},
  galleryHost: {
    ready,
    saved: {
      referenceCollections: () => [
        {id: 'collection:racing', name: 'Racing', images: [12]},
        {id: 'collection:horror', name: 'Horror', images: [12, 13]}
      ],
      referenceName: id => `Saved image ${id}`
    },
    imageFile(id) {assert.equal(id, 12); return {type: 'image/webp', size: 1};},
    imageSource(image, id) { previewRequests.push(id); image.src = `fixture-${id}.webp`; }
  }
};
class IntersectionObserver {
  constructor(callback) { this.callback = callback; }
  observe(target) { this.callback([{target, isIntersecting: true}]); }
  unobserve() {}
  disconnect() {}
}
class Option {constructor(label, value) {Object.assign(this, {label, value});}}
const gameImage = 'https://tr.rbxcdn.com/test/768/432/Image/Webp/noFilter';
const lookupRequests = [];
let failGeneration = false;
let exportedUrl = 0;
const context = {document, window, Worker, IntersectionObserver, ResizeObserver: class {observe() {}}, Option, FileReader: Reader, Uint8Array, Blob, atob, URLSearchParams, URL: class extends URL {
  static createObjectURL(value) { return value instanceof Blob ? `blob:result-${++exportedUrl}` : 'blob:result'; }
  static revokeObjectURL() {}
}, createImageBitmap: async file => ({
  width: 1920, height: 1088, close() {},
  pixel: file.name ? darkPixel : file.type === 'image/webp' ? galleryPixel : brightPixel
}), fetch: async (url, options) => {
  if (!options && url.includes('thumbnail-prompt')) return {ok: true, text: async () => 'background prompt'};
  if (!options && url.includes('character-references')) return {ok: true, blob: async () => ({type: url.endsWith('.png') ? 'image/png' : 'image/jpeg'})};
  if (url.startsWith('https://references.rolibrary.win/')) {
    lookupRequests.push(url);
    return {ok: true, json: async () => ({thumbnails: [gameImage]})};
  }
  if (url === gameImage) return {ok: true, blob: async () => new Blob(['webp'], {type: 'image/webp'})};
  assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\//);
  assert.equal(options.headers['x-goog-api-key'], 'key');
  calls.push(JSON.parse(options.body));
  if (failGeneration) return {ok: false, json: async () => ({error: {message: 'Test service error'}})};
  return {ok: true, json: async () => ({candidates: [{content: {parts: [{inlineData: {data: 'YQ==', mimeType: 'image/png'}}]}}]})};
}};
element('thumbnail-edit-fields').hidden = true;
element('thumbnail-upscale').hidden = true;
element('thumbnail-upscaled-download').hidden = true;
element('thumbnail-panel').inert = true;
element('thumbnail-open').setAttribute('data-open-on-load', '');
vm.runInNewContext(fs.readFileSync('web/thumbnail-generator.js', 'utf8'), context);
(async () => {
  const opening = events.DOMContentLoaded();
  const panel = element('thumbnail-panel');
  assert.equal(panel.inert, false);
  assert.equal(element('thumbnail-collection').disabled, true);
  assert.deepEqual(previewRequests, []);
  finishCatalogue();
  await opening;
  assert.equal(element('thumbnail-collection').disabled, false);
  assert.deepEqual(previewRequests, [12]);
  assert.equal(element('thumbnail-collection-images').children[0].children[0].src, 'fixture-12.webp');
  const keyInput = element('thumbnail-key');
  assert.equal(keyInput.value, 'previous-key');
  element('thumbnail-forget-key').handlers.click();
  assert.equal(keyInput.value, '');
  assert.equal(storage.size, 0);
  keyInput.value = 'key';
  keyInput.handlers.input();
  assert.equal(storage.get('rolibrary-gemini-api-key'), 'key');
  const picker = element('thumbnail-collection');
  assert.equal(picker.children.length, 2);
  assert.equal(picker.value, 'collection:racing');
  const grid = element('thumbnail-collection-images');
  window.galleryGenerator.addReference({id: 12});
  window.galleryGenerator.addReference({id: 12});
  assert.equal(element('thumbnail-count').textContent, '(1)');
  assert.match(element('thumbnail-gallery-status').textContent, /already a reference/);
  element('thumbnail-fullscreen').handlers.click();
  assert.equal(panel.hasAttribute('data-fullscreen'), true);
  assert.equal(explorer.inert, true);
  panel.handlers.keydown({key: 'Escape', preventDefault() {}});
  assert.equal(explorer.inert, false);
  assert.equal(panel.inert, false);
  element('thumbnail-close').handlers.click();
  assert.equal(panel.inert, true);
  window.galleryGenerator.addReference({id: 12}, true);
  assert.equal(panel.inert, false);
  assert.equal(element('thumbnail-count').textContent, '(1)');
  assert.equal(document.activeElement, element('thumbnail-title'));
  assert.equal(grid.children[0].attributes['aria-pressed'], 'true');
  picker.value = 'collection:horror';
  picker.handlers.change();
  assert.equal(grid.children.length, 2);
  assert.equal(grid.children[0].attributes['aria-pressed'], 'true');
  grid.children[0].handlers.click();
  assert.equal(grid.children[0].attributes['aria-pressed'], 'false');
  grid.children[0].handlers.click();
  const file = {name: 'my-reference.png', type: 'image/png', size: 1};
  element('thumbnail-upload').handlers.change({target: {files: [file], value: 'selected'}});
  assert.equal(element('thumbnail-count').textContent, '(2)');
  const selectedRows = element('thumbnail-references').children;
  const savedMention = selectedRows[0].children[0].children[0];
  const uploadMention = selectedRows[1].children[0].children[0];
  assert.equal(savedMention.children[0].src, 'fixture-12.webp');
  assert.equal(savedMention.children[1], 'Image 2');
  assert.equal(uploadMention.children[0].src, 'blob:result');
  assert.equal(uploadMention.children[1], 'Image 3');
  const concept = element('thumbnail-concept');
  const highlight = element('thumbnail-concept-highlight');
  const mentionPreview = element('thumbnail-mention-preview');
  concept.value = 'Set the scene in PLACE at night';
  concept.setSelectionRange(17, 22);
  savedMention.handlers.click();
  assert.equal(document.activeElement, concept);
  assert.equal(concept.value, 'Set the scene in @Image 2 at night');
  assert.equal(mentionPreview.hidden, true);
  assert.equal(highlight.children[1].textContent, '@Image 2');
  concept.setSelectionRange(concept.value.length, concept.value.length);
  uploadMention.handlers.click();
  assert.ok(concept.value.endsWith('@Image 3 '));
  assert.equal(concept.selectionStart, concept.value.length);
  assert.equal(mentionPreview.hidden, true);
  concept.setSelectionRange(17, 25);
  concept.handlers.select();
  assert.equal(mentionPreview.children[1], 'Image 2');
  assert.equal(mentionPreview.children[0].src, 'fixture-12.webp');
  concept.setSelectionRange(concept.value.length - 9, concept.value.length - 1);
  concept.handlers.selectionchange();
  assert.equal(mentionPreview.children[1], 'Image 3');
  assert.equal(mentionPreview.children[0].src, 'blob:result');
  concept.setSelectionRange(0, 3);
  concept.handlers.select();
  assert.equal(mentionPreview.hidden, true);
  const galleryTags = selectedRows[0].children[1].children;
  const environment = galleryTags[3].children[0];
  environment.checked = true;
  environment.handlers.change();
  const uploadTags = selectedRows[1].children[1].children;
  const character = uploadTags[4].children[0];
  character.checked = false;
  character.handlers.change();
  concept.value = 'Use @image 3 as the dragon and @image2 for the setting.';
  concept.setSelectionRange(4, 12);
  concept.handlers.input();
  assert.equal(highlight.children[1].textContent, '@image 3');
  assert.equal(highlight.children[3].textContent, '@image2');
  assert.equal(mentionPreview.children[1], 'Image 3');
  element('thumbnail-aspect').value = '16:9';
  await element('thumbnail-form').handlers.submit({preventDefault() {}});
  assert.equal(calls.length, 0);
  assert.match(element('thumbnail-status').textContent, /at least one tag/);
  character.checked = true;
  character.handlers.change();
  for (const tag of uploadTags.slice(5, 7)) {
    const checkbox = tag.children[0];
    checkbox.checked = true;
    checkbox.handlers.change();
  }
  const galleryColors = galleryTags[6].children[0];
  galleryColors.checked = true;
  galleryColors.handlers.change();
  await element('thumbnail-form').handlers.submit({preventDefault() {}});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].generationConfig.imageConfig.imageSize, '2K');
  const [background, characterBrief, ...labeledImages] = calls[0].contents[0].parts;
  assert.match(background.text, /Use @Image 3 as the dragon and @Image 2 for the setting/);
  assert.match(characterBrief.text, /use @Image 3 as the subject to restage/);
  const requestParts = [background, ...labeledImages];
  assert.match(requestParts[1].text, /^@Image 3 refers to the single image attached immediately after/);
  assert.match(requestParts[1].text, /Character: the exact subject identity/);
  assert.equal(requestParts[2].inlineData.mimeType, 'image/png');
  assert.match(requestParts[3].text, /^@Image 2 refers to the single image attached immediately after/);
  assert.match(requestParts[3].text, /Composition: framing/);
  assert.match(requestParts[3].text, /Environment: setting/);
  assert.doesNotMatch(requestParts[3].text, /Character:/);
  assert.equal(requestParts[4].inlineData.mimeType, 'image/webp');
  assert.equal(requestParts.filter(part => part.inlineData).length, 2);
  const finalInstructions = requestParts.at(-2).text;
  assert.match(finalInstructions, /Visual style: @Image 2/);
  assert.match(finalInstructions, /Composition: @Image 2/);
  assert.ok(requestParts.some(part => part.text?.includes('frame the scene through the player’s eyes')));
  assert.match(finalInstructions, /Environment: @Image 2/);
  assert.match(finalInstructions, /Character: @Image 3/);
  assert.match(finalInstructions, /Explicit uses of named images in the description take priority/);
  assert.match(finalInstructions, /replace characters from composition or style images/);
  assert.match(finalInstructions, /Lighting: @Image 3; Colors: @Image 2 \(supporting: @Image 3\)/);
  const colorDirection = requestParts.at(-1).text;
  assert.match(colorDirection, /Use @Image 3 \(Lighting\) for overall exposure/);
  assert.match(colorDirection, /Use @Image 2 \(Colors\) for the overall palette and saturation/);
  assert.match(colorDirection, /including the sky, background, props, and characters/);
  assert.match(colorDirection, /Ignore conflicting lighting or palette cues from images assigned to other roles/);
  assert.match(colorDirection, /If the exposure reference is dark, keep most of the scene dark/);
  assert.equal(calls[0].generationConfig.imageConfig.aspectRatio, '16:9');
  assert.match(background.text, /Do not add titles, captions/);
  assert.equal(element('thumbnail-status').textContent, 'Thumbnail ready · 1920 × 1080');
  assert.equal(element('thumbnail-upscale').hidden, true);
  assert.deepEqual(exportsMade[0], {width: 1920, height: 1080, rectangle: [0, -4, 1920, 1088], type: 'image/png'});
  assert.deepEqual(exposureAdjustments, [[24, 46, 60, 255]]);
  selectedRows[1].children[0].children[1].handlers.click();
  await element('thumbnail-form').handlers.submit({preventDefault() {}});
  assert.equal(calls.length, 1);
  assert.match(element('thumbnail-status').textContent, /Remove or replace @image 3/);
  concept.value = '  ';
  element('thumbnail-resolution').value = '1K';
  const colors = element('thumbnail-references').children[0].children[1].children[6].children[0];
  assert.equal(colors.checked, true);
  await element('thumbnail-form').handlers.submit({preventDefault() {}});
  assert.equal(calls.length, 2);
  assert.equal(calls[1].generationConfig.imageConfig.imageSize, '1K');
  assert.match(calls[1].contents[0].parts[0].text, /using the attached images according to their reference tags/);
  assert.equal(calls[1].contents[0].parts.filter(part => part.inlineData).length, 7);
  assert.match(calls[1].contents[0].parts[3].text, /character reference sheets/);
  assert.match(calls[1].contents[0].parts.at(-1).text, /Use @Image 2 \(Colors\) for overall brightness and contrast as well as palette/);
  colors.checked = false;
  colors.handlers.change();
  assert.deepEqual(exportsMade[1], {width: 960, height: 540, rectangle: [0, -2, 960, 544], type: 'image/png'});
  assert.deepEqual(exposureAdjustments[1], [63, 120, 154, 255]);
  assert.equal(element('thumbnail-upscale').hidden, false);
  element('thumbnail-upload').handlers.change({target: {files: [file], value: 'selected'}});
  element('thumbnail-upload').handlers.change({target: {files: Array(5).fill(file), value: 'selected'}});
  assert.match(element('thumbnail-status').textContent, /up to 5/);
  assert.equal(element('thumbnail-count').textContent, '(2)');
  const gameLink = element('thumbnail-game-url'), gameLookup = element('thumbnail-load-game');
  gameLink.value = 'https://roblox.com.example/games/123';
  await gameLookup.handlers.click();
  assert.equal(lookupRequests.length, 0);
  gameLink.value = 'https://www.roblox.com/games/123/Example';
  await gameLookup.handlers.click();
  assert.match(lookupRequests[0], /\?place=123$/);
  const gameTile = element('thumbnail-game-images').children[0];
  gameTile.handlers.click();
  assert.equal(gameTile.attributes['aria-pressed'], 'true');
  const tags = element('thumbnail-references').children[2].children[1].children;
  for (const tag of tags.slice(-3)) {
    tag.children[0].checked = true;
    tag.children[0].handlers.change();
  }
  const allow = element('thumbnail-allow-text');
  allow.checked = true;
  allow.handlers.change();
  assert.equal(element('thumbnail-wording-field').hidden, false);
  element('thumbnail-wording').value = 'Race Night!';
  await element('thumbnail-form').handlers.submit({preventDefault() {}});
  const parts = calls[2].contents[0].parts;
  assert.match(parts[0].text, /exact text.*"Race Night!"/);
  const gameReference = parts.findIndex(part => part.text?.startsWith('@Image 5 refers'));
  assert.match(parts[gameReference].text, /Object: .*Logo: .*Text style: /);
  assert.equal(parts[gameReference + 1].inlineData.mimeType, 'image/webp');
  allow.checked = false;
  await element('thumbnail-form').handlers.submit({preventDefault() {}});
  const logoParts = calls[3].contents[0].parts;
  assert.match(logoParts[0].text, /lettering that is part of a Logo-tagged reference/);
  assert.ok(logoParts.some(part => /Logo: .*preserving its graphic mark and any lettering/.test(part.text)));

  const edit = element('thumbnail-edit'), applyEdit = element('thumbnail-apply-edit');
  const editInput = element('thumbnail-edit-instructions');
  const submitEdit = () => element('thumbnail-form').handlers.submit({preventDefault() {}, submitter: applyEdit});
  assert.equal(edit.hidden, false);
  edit.handlers.click();
  assert.equal(element('thumbnail-edit-fields').hidden, false);
  element('thumbnail-concept').value = '';
  editInput.value = 'Make the sky purple';
  await submitEdit();
  const firstEdit = calls[4].contents[0].parts;
  assert.equal(firstEdit.length, 3);
  assert.equal(atob(firstEdit[1].inlineData.data), 'output-4');
  assert.match(firstEdit[2].text, /^Make the sky purple\nDo not add new lettering outside logos\.$/);
  assert.equal(element('thumbnail-status').textContent, 'Edit ready · 960 × 540');
  assert.equal(exposureAdjustments.length, 2);
  const editedDownload = element('thumbnail-download').href;
  editInput.value = 'Make it darker';
  failGeneration = true;
  await submitEdit();
  assert.equal(atob(calls[5].contents[0].parts[1].inlineData.data), 'output-5');
  assert.equal(element('thumbnail-download').href, editedDownload);
  assert.equal(editInput.value, 'Make it darker');
  assert.equal(element('thumbnail-status').textContent, 'Test service error');
  failGeneration = false;
  await submitEdit();
  assert.notEqual(element('thumbnail-download').href, editedDownload);

  const upscale = element('thumbnail-upscale'), upscaled = element('thumbnail-upscaled-download');
  const original = element('thumbnail-download').href;
  const requestCount = calls.length;
  await upscale.handlers.click();
  assert.equal(upscaled.hidden, true);
  assert.equal(upscale.disabled, false);
  assert.match(element('thumbnail-status').textContent, /Could not upscale/);
  failUpscale = false;
  await upscale.handlers.click();
  assert.deepEqual(upscaleInputs, ['output-6', 'output-6']);
  assert.equal(calls.length, requestCount);
  assert.equal(element('thumbnail-download').href, original);
  assert.equal(upscaled.hidden, false);
  assert.notEqual(upscaled.href, original);
  assert.equal(upscale.hidden, true);
  assert.equal(element('thumbnail-status').textContent, 'Upscaled thumbnail ready · 1920 × 1080');
  const previous = element('thumbnail-previous'), next = element('thumbnail-next');
  const upscaledUrl = upscaled.href;
  assert.equal(next.disabled, true);
  previous.handlers.click();
  assert.equal(element('thumbnail-result').src, editedDownload);
  assert.equal(element('thumbnail-download').href, editedDownload);
  assert.equal(upscaled.hidden, true);
  next.handlers.click();
  assert.equal(upscaled.href, upscaledUrl);
  assert.equal(upscaled.hidden, false);
  previous.handlers.click();
  editInput.value = 'Try a brighter color';
  await submitEdit();
  assert.equal(atob(calls.at(-1).contents[0].parts[1].inlineData.data), 'output-5');
  assert.equal(element('thumbnail-version').textContent, 'Version 7 of 7 · 960 × 540');
  previous.handlers.click();
  assert.equal(element('thumbnail-download').href, original);
  assert.equal(upscaled.href, upscaledUrl);
  next.handlers.click();
  assert.equal(upscaled.hidden, true);
  assert.equal(upscale.hidden, false);
  for (const row of element('thumbnail-references').children) row.children[0].children[1].handlers.click();
  assert.equal(element('thumbnail-count').textContent, '(0)');
  await element('thumbnail-form').handlers.submit({preventDefault() {}});
  assert.match(calls.at(-1).contents[0].parts[0].text, /Create an original Roblox game thumbnail/);
  assert.deepEqual([...storage], [['rolibrary-gemini-api-key', 'key']]);

  window.galleryGenerator.addReference({id: 12});
  const regionInput = element('thumbnail-region-name');
  const regionForm = element('thumbnail-region-form');
  const stage = element('thumbnail-region-stage');
  const regions = () => element('thumbnail-references').children[0].children[2].children;
  async function addBox(name, start, end) {
    await regions()[0].handlers.click();
    stage.handlers.pointerdown({button: 0, pointerId: 1, clientX: start, clientY: 30});
    stage.handlers.pointerup({pointerId: 1, clientX: end, clientY: 80});
    regionInput.value = name;
    regionForm.handlers.submit({preventDefault() {}});
  }
  await addBox('Red Knight', 20, 50);
  await addBox('Blue Wizard', 70, 100);
  await addBox('Unused Prop', 50, 60);
  assert.equal(regions().length, 4);
  concept.focus();
  concept.value = '@Red';
  concept.setSelectionRange(4, 4);
  concept.handlers.input();
  const choices = element('thumbnail-mention-suggestions');
  assert.deepEqual(choices.children.map(button => button.textContent), ['@[Red Knight]']);
  choices.children[0].handlers.click();
  assert.equal(concept.value, '@[Red Knight] ');
  assert.equal(mentionPreview.hidden, true);
  concept.setSelectionRange(0, '@[Red Knight]'.length);
  concept.handlers.select();
  assert.equal(mentionPreview.children[1], 'Red Knight');
  concept.value += 'rides while @[Blue Wizard] casts a spell.';
  await regions()[1].children[1].handlers.click();
  regionInput.value = 'Crimson Knight';
  regionForm.handlers.submit({preventDefault() {}});
  assert.match(concept.value, /^@\[Crimson Knight\] rides while @\[Blue Wizard\]/);
  const exportsBeforeCrops = exportsMade.length;
  await element('thumbnail-form').handlers.submit({preventDefault() {}});
  const cropParts = calls.at(-1).contents[0].parts;
  for (const name of ['Crimson Knight', 'Blue Wizard']) {
    const partIndex = cropParts.findIndex(part => part.text?.startsWith(`@[${name}] refers to the crop`));
    assert.ok(partIndex > 0);
    assert.equal(cropParts[partIndex + 1].inlineData.mimeType, 'image/webp');
  }
  assert.equal(cropParts.some(part => part.text?.includes('Unused Prop')), false);
  const crops = exportsMade.slice(exportsBeforeCrops, exportsBeforeCrops + 2);
  assert.deepEqual(crops.map(crop => crop.rectangle.slice(0, 2)), [[192, 108], [1152, 108]]);
  assert.ok(crops.every(crop => crop.width > 0 && crop.width < 1920 && crop.height > 0 && crop.height < 1088));
  await regions()[2].children[1].handlers.click();
  element('thumbnail-region-delete').handlers.click();
  const callsBeforeDeletedBox = calls.length;
  await element('thumbnail-form').handlers.submit({preventDefault() {}});
  assert.equal(calls.length, callsBeforeDeletedBox);
  assert.match(element('thumbnail-status').textContent, /Remove or replace @\[Blue Wizard\]/);
  for (const row of element('thumbnail-references').children) row.children[0].children[1].handlers.click();
  for (let id = 20; id < 26; id++) window.galleryGenerator.addReference({id});
  assert.equal(element('thumbnail-count').textContent, '(5)');
  assert.match(element('thumbnail-gallery-status').textContent, /limit is five/);
  for (const row of element('thumbnail-references').children) row.children[0].children[1].handlers.click();
  window.galleryHost.api = path => {
    assert.match(path, /similarity=both&seed_image=50/);
    return {items: [{id: 51, image_id: 12}, {id: 51, image_id: 13}]};
  };
  await window.galleryGenerator.startTest({id: 8, name: 'Racing', genre: 'Driving'}, 50);
  assert.equal(element('thumbnail-count').textContent, '(1)');
  assert.match(element('thumbnail-test-status').textContent, /Added 1 similar-game/);
  concept.value = 'Show racers drifting on the city track.';
  element('thumbnail-resolution').value = '2K';
  const submitTest = id => element('thumbnail-form').handlers.submit({preventDefault() {}, submitter: element(id)});
  const beforeBatch = calls.length;
  await submitTest('thumbnail-test-draft');
  const batch = calls.slice(beforeBatch);
  assert.equal(batch.length, 3);
  assert.equal(new Set(batch.map(request => request.contents[0].parts.at(-1).text)).size, 3);
  assert.ok(batch.every(request => request.generationConfig.imageConfig.imageSize === '1K'));
  const approve = element('thumbnail-test-approve'), list = element('thumbnail-test-approved');
  assert.equal(list.hidden, true);
  assert.equal(approve.disabled, true);
  await approve.handlers.click();
  assert.equal(list.hidden, true);
  const upscalesBeforeBatchReview = upscaleInputs.length;
  await upscale.handlers.click();
  assert.equal(element('thumbnail-result').src, upscaled.href);
  assert.equal(approve.disabled, false);
  await approve.handlers.click();
  previous.handlers.click();
  assert.equal(approve.disabled, true);
  await upscale.handlers.click();
  await approve.handlers.click();
  assert.equal(upscaleInputs.length - upscalesBeforeBatchReview, 2);
  assert.equal(calls.length - beforeBatch, 3);
  assert.equal(list.children.length, 2);
  assert.ok(list.children.every(item => /^roblox-home-8-[a-z0-9]+-v\d+\.png$/.test(item.children[0].download)));
  const approvedVersion = list.children[0].children[0].href;
  assert.equal(approvedVersion, upscaled.href);
  assert.notEqual(approvedVersion, element('thumbnail-download').href);
  const beforeIteration = calls.length;
  await submitTest('thumbnail-test-iterate');
  assert.equal(calls.length - beforeIteration, 3);
  const seeds = calls.slice(beforeIteration).map(request => request.contents[0].parts[1].inlineData.data);
  assert.deepEqual(seeds.map(atob), ['upscaled', 'upscaled', 'upscaled']);
  assert.ok(calls.slice(beforeIteration).every(request => request.generationConfig.imageConfig.imageSize === '1K'));
  assert.equal(list.children.length, 2);
  console.log('Generator references, export, edits, version history, Home test drafts, approvals, and iteration passed.');
})().catch(error => {console.error(error); process.exitCode = 1;});
