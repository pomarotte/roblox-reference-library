const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
process.env.TZ = 'America/Los_Angeles';

const game = {id: 7, status: 'ready', genre: 'Simulation', subgenre: 'Tycoon', images: [{id: 3, kind: 'thumbs', filename: '7 test.webp'}, {id: 4, kind: 'thumbs', captured: '20261119_000000', object_key: 'daily/test.webp'}, {id: 5, kind: 'icons', captured: '20261120_000000', object_key: 'daily/icon.webp'}]};
let savedOptions;
const lastUpdated = {hidden: true, dataset: {time: '14:32 UTC'}};
class Worker {
  postMessage({id, action}) {
    queueMicrotask(() => this.onmessage({data: {id, result: action === 'init' ? {games: [game]} : action === 'query' ? {total: 1} : {}}}));
  }
}
const window = {galleryCollections: {initialize(options) { savedOptions = options; return {}; }}};
const context = {window, Worker, Map, URL, DOMException, queueMicrotask, document: {getElementById() { return lastUpdated; }}, fetch: async url => ({ok: true, blob: async () => ({url})})};
vm.runInNewContext(fs.readFileSync('cloud-host.js', 'utf8'), context);
(async () => {
  const status = await window.galleryHost.api('/api/status');
  assert.equal(status.games, 1);
  assert.equal(status.images, 3);
  assert.match(lastUpdated.textContent, /Nov 19, 2026, 6:32/);
  assert.equal(lastUpdated.hidden, false);
  const image = {tagName: 'IMG'};
  window.galleryHost.imageSource(image, 3);
  assert.equal(image.src, 'https://rolibrary.win/thumbs/7%20test.webp');
  assert.equal((await savedOptions.getFile(3)).url, image.src);
  await assert.rejects(() => savedOptions.getFile(999), /unavailable/);
  assert.equal((await window.galleryHost.api('/api/library?kind=thumbs')).total, 1);
  console.log('Cloud catalogue initialization, image URLs, collection fetch, and search routing passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
