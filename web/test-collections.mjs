import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {webcrypto} from 'node:crypto';

globalThis.window = {};
globalThis.crypto ??= webcrypto;
await import('./collections.js');
const {createStore, writeZip, storageKey} = window.galleryCollections;
const values = new Map(), storage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
let store = createStore(storage);
store.favorite(2);
const collection = store.create('Racing', 3);
store.include(collection, 2, true);
store.include(collection, 2, true);
store = createStore(storage);
assert.deepEqual(store.data.favorites, [2]);
assert.deepEqual(store.data.collections[0].images, [3, 2]);
assert.equal(store.data.lastCollection, collection);
const otherCollection = store.create('Other');
store.include(otherCollection, 9, true);
assert.equal(createStore(storage).data.lastCollection, otherCollection);
store.include(otherCollection, 9, false);
assert.equal(store.data.lastCollection, otherCollection);
store.remove(otherCollection);
assert.equal(createStore(storage).data.lastCollection, null);
store.include(collection, 2, true);
assert.equal(store.data.lastCollection, collection);
store.favorite(2);
store.include(collection, 3, false);
store.rename(collection, 'Motorcycles');
assert.equal(createStore(storage).data.collections[0].name, 'Motorcycles');
assert.deepEqual(store.data.collections[0].images, [2]);
assert.throws(() => store.create(' '), /name/);
assert.throws(() => store.favorite(-1), /Invalid image/);
assert.throws(() => store.rename('missing', 'Name'), /no longer exists/);
const before = store.data;
storage.setItem = () => { throw new Error('QuotaExceededError'); };
assert.throws(() => store.favorite(9), /storage is unavailable or full/);
assert.deepEqual(store.data, before);
assert.deepEqual(createStore(storage).data, before);
storage.setItem = (key, value) => values.set(key, value);
store.remove(collection);
assert.equal(store.data.collections.length, 0);
assert.equal(store.data.lastCollection, null);
values.set(storageKey, '{damaged');
assert.throws(() => createStore(storage));
assert.equal(values.get(storageKey), '{damaged');
values.set(storageKey, JSON.stringify({version: 1, favorites: ['bad'], collections: []}));
assert.throws(() => createStore(storage), /left unchanged/);

const binary = Uint8Array.from({length: 2048}, (_, i) => i % 256);
const files = [{name: 'é image.webp', file: new Blob([binary])}, {name: 'another.webp', file: new Blob(['test'])}, {name: 'empty', file: new Blob([])}];
const chunks = [], progress = [];
await writeZip(files, {write: bytes => chunks.push(bytes)}, (done, total) => progress.push([done, total]));
const zip = Buffer.from(await new Blob(chunks).arrayBuffer());
const python = process.platform === 'win32' ? 'python' : 'python3';
execFileSync(python, ['-c', `import io,sys,zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
 assert z.namelist()==['é image.webp','another.webp','empty']
 assert all('/' not in name for name in z.namelist())
 assert z.testzip() is None
 assert z.read(z.namelist()[0])==bytes(range(256))*8
 assert z.read('another.webp')==b'test'
 assert z.read('empty')==b''
`], {input: zip});
assert.deepEqual(progress.at(-1), [3, 3]);
await assert.rejects(() => writeZip([{name: '../unsafe', file: new Blob()}], {write() {}}), /Invalid ZIP/);
await assert.rejects(() => writeZip([{name: 'huge', file: {size: 0xffffffff}}], {write() {}}), /too large/);
await assert.rejects(() => writeZip(files, {write() {}}, () => {}, AbortSignal.abort()), {name: 'AbortError'});
await assert.rejects(() => writeZip(files, {write() {throw new Error('Disk full');}}), /Disk full/);
console.log('Collection persistence, exact image membership, storage failures, ZIP integrity/UTF-8/binary files, bounds, cancellation, and write errors passed.');
