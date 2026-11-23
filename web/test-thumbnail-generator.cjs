const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const elements = new Map(), events = {};
function element(id) {
  if (!elements.has(id)) elements.set(id, {id, value: '', hidden: false, children: [], handlers: {}, addEventListener(type, fn) {this.handlers[type] = fn;}, replaceChildren() {this.children = [];}, append(...nodes) {this.children.push(...nodes);}, setAttribute() {}, showModal() {}, close() {}});
  return elements.get(id);
}
const calls = [];
class Reader { readAsDataURL(file) { this.result = `data:${file.type};base64,YQ==`; this.onload(); } }
const document = {getElementById: element, createElement: () => element(Symbol())};
const window = {addEventListener(type, fn) {events[type] = fn;}, galleryHost: {imageFile() {throw Error('Uploaded file should not be loaded from gallery');}}};
const context = {document, window, FileReader: Reader, Uint8Array, Blob, atob, URL: {createObjectURL: () => 'blob:result', revokeObjectURL() {}}, fetch: async (url, options) => {
  if (!options) return {ok: true, text: async () => 'background prompt'};
  calls.push(JSON.parse(options.body));
  return {ok: true, json: async () => ({steps: [{type: 'model_output', content: [{type: 'image', data: 'YQ==', mime_type: 'image/png'}]}]})};
}};
vm.runInNewContext(fs.readFileSync('web/thumbnail-generator.js', 'utf8'), context);
(async () => {
  const file = {name: 'my-reference.png', type: 'image/png', size: 1};
  element('thumbnail-upload').handlers.change({target: {files: [file], value: 'selected'}});
  assert.equal(element('thumbnail-count').textContent, '(1 reference)');
  element('thumbnail-key').value = 'key'; element('thumbnail-concept').value = 'a dragon'; element('thumbnail-aspect').value = '16:9';
  await element('thumbnail-form').handlers.submit({preventDefault() {}});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input[1].data, 'YQ==');
  assert.equal(calls[0].input[1].mime_type, 'image/png');
  assert.equal(calls[0].store, false);
  assert.equal(element('thumbnail-status').textContent, 'Thumbnail ready.');
  element('thumbnail-upload').handlers.change({target: {files: Array(5).fill(file), value: 'selected'}});
  assert.match(element('thumbnail-status').textContent, /up to 5/);
  assert.equal(element('thumbnail-count').textContent, '(1 reference)');
  console.log('Temporary reference upload and generation request passed.');
})().catch(error => {console.error(error); process.exitCode = 1;});
