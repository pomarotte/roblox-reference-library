const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const elements = new Map(), events = {};
function element(id) {
  if (!elements.has(id)) elements.set(id, {id, value: '', hidden: false, children: [], handlers: {}, dataset: {}, attributes: {}, addEventListener(type, fn) {this.handlers[type] = fn;}, replaceChildren(...nodes) {this.children = nodes;}, append(...nodes) {this.children.push(...nodes);}, setAttribute(name, value) {this.attributes[name] = value;}, showModal() {this.open = true;}, close() {this.open = false;}, focus() {}});
  return elements.get(id);
}
const calls = [];
class Reader { readAsDataURL(file) { this.result = `data:${file.type};base64,YQ==`; this.onload(); } }
const document = {getElementById: element, createElement: () => element(Symbol())};
const storage = new Map([['rolibrary-gemini-api-key', 'previous-key']]);
let finishCatalogue;
const ready = new Promise(resolve => { finishCatalogue = resolve; });
const previewRequests = [];
const window = {
  localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
  addEventListener(type, fn) {events[type] = fn;},
  galleryHost: {
    ready,
    saved: {
      referenceCollections: () => [
        {id: 'favorites', name: 'Favorites', images: [12]},
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
const context = {document, window, IntersectionObserver, Option, FileReader: Reader, Uint8Array, Blob, atob, URL: {createObjectURL: () => 'blob:result', revokeObjectURL() {}}, fetch: async (url, options) => {
  if (!options && url.includes('thumbnail-prompt')) return {ok: true, text: async () => 'background prompt'};
  if (!options && url.includes('character-references')) return {ok: true, blob: async () => ({type: url.endsWith('.png') ? 'image/png' : 'image/jpeg'})};
  assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\//);
  assert.equal(options.headers['x-goog-api-key'], 'key');
  calls.push(JSON.parse(options.body));
  return {ok: true, json: async () => ({candidates: [{content: {parts: [{inlineData: {data: 'YQ==', mimeType: 'image/png'}}]}}]})};
}};
vm.runInNewContext(fs.readFileSync('web/thumbnail-generator.js', 'utf8'), context);
(async () => {
  const opening = events.DOMContentLoaded();
  assert.equal(element('thumbnail-dialog').open, true);
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
  assert.equal(picker.value, 'favorites');
  const grid = element('thumbnail-collection-images');
  grid.children[0].handlers.click();
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
  assert.equal(selectedRows[0].children[0].children[0].src, 'fixture-12.webp');
  assert.equal(selectedRows[1].children[0].children[0].src, 'blob:result');
  assert.match(selectedRows[1].children[0].children[0].alt, /my-reference.png/);
  const galleryTags = selectedRows[0].children[1].children;
  const environment = galleryTags[3].children[0];
  environment.checked = true;
  environment.handlers.change();
  const uploadTags = selectedRows[1].children[1].children;
  const character = uploadTags[4].children[0];
  character.checked = false;
  character.handlers.change();
  element('thumbnail-concept').value = 'a dragon';
  element('thumbnail-aspect').value = '16:9';
  await element('thumbnail-form').handlers.submit({preventDefault() {}});
  assert.equal(calls.length, 0);
  assert.match(element('thumbnail-status').textContent, /at least one tag/);
  character.checked = true;
  character.handlers.change();
  element('thumbnail-concept').value = 'a dragon'; element('thumbnail-aspect').value = '16:9';
  await element('thumbnail-form').handlers.submit({preventDefault() {}});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].generationConfig.imageConfig.imageSize, '2K');
  const [background, characterBrief, ...labeledImages] = calls[0].contents[0].parts;
  assert.match(characterBrief.text, /first attached image as the subject to restage/);
  const requestParts = [background, ...labeledImages];
  assert.match(requestParts[1].text, /filename "my-reference.png"/);
  assert.match(requestParts[1].text, /Character: the exact subject identity/);
  assert.equal(requestParts[2].inlineData.mimeType, 'image/png');
  assert.match(requestParts[3].text, /Composition: framing/);
  assert.match(requestParts[3].text, /Environment: setting/);
  assert.doesNotMatch(requestParts[3].text, /Character:/);
  assert.equal(requestParts[4].inlineData.mimeType, 'image/webp');
  assert.equal(requestParts.filter(part => part.inlineData).length, 2);
  const finalInstructions = requestParts.at(-1).text;
  assert.match(finalInstructions, /Composition: reference image 2/);
  assert.match(finalInstructions, /Environment: reference image 2/);
  assert.match(finalInstructions, /Character: reference image 1/);
  assert.match(finalInstructions, /replace characters from composition or style images/);
  assert.match(finalInstructions, /match the overall brightness and contrast of the Colors image/);
  assert.equal(calls[0].generationConfig.imageConfig.aspectRatio, '16:9');
  assert.equal(element('thumbnail-status').textContent, 'Thumbnail ready.');
  selectedRows[1].children[0].children[1].handlers.click();
  element('thumbnail-resolution').value = '1K';
  await element('thumbnail-form').handlers.submit({preventDefault() {}});
  assert.equal(calls.length, 2);
  assert.equal(calls[1].generationConfig.imageConfig.imageSize, '1K');
  assert.equal(calls[1].contents[0].parts.filter(part => part.inlineData).length, 7);
  assert.match(calls[1].contents[0].parts[3].text, /character reference sheets/);
  element('thumbnail-upload').handlers.change({target: {files: [file], value: 'selected'}});
  element('thumbnail-upload').handlers.change({target: {files: Array(5).fill(file), value: 'selected'}});
  assert.match(element('thumbnail-status').textContent, /up to 5/);
  assert.equal(element('thumbnail-count').textContent, '(2)');
  console.log('Collection selection, temporary uploads, and the Gemini request passed.');
})().catch(error => {console.error(error); process.exitCode = 1;});
