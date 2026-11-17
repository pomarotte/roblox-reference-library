import {prepareCatalogue, decodeHalf, queryLibrary} from './web-core.mjs';

let state, available = new Set(), matrix, loading;
const initialized = initialize();

async function gunzip(response) {
  if (!response.ok) throw new Error(`Could not download saved data (${response.status}). Please retry.`);
  return new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

async function initialize() {
  const bytes = await gunzip(await fetch('./data/catalog.json.gz'));
  state = prepareCatalogue(JSON.parse(new TextDecoder().decode(bytes)));
  return state.catalogue;
}

async function loadIndex() {
  if (matrix) return;
  if (loading) return loading;
  loading = (async () => {
    const {parts, dimensions} = state.catalogue.visual;
    const values = new Float32Array(state.ordered.length * dimensions);
    let offset = 0, completed = 0;
    let cache;
    try { cache = await caches.open('roblox-scenes-v1'); } catch (_) { /* Browser storage can be disabled. */ }
    const expected = new Set(parts.map(part => new URL(part.url, self.location.href).href));
    if (cache) for (const request of await cache.keys()) if (!expected.has(request.url)) await cache.delete(request);
    for (const part of parts) {
      const url = new URL(part.url, self.location.href).href;
      self.postMessage({progress: `Loading saved scene index: ${completed} / ${parts.length} parts. Images stay on your computer.`});
      let response = await cache?.match(url);
      if (!response) response = await fetch(url);
      if (!response.ok) throw new Error('Could not download the scene index. Check your connection and retry.');
      const compressed = await response.arrayBuffer();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', compressed)), n => n.toString(16).padStart(2, '0')).join('');
      if (digest !== part.sha256) {
        await cache?.delete(url);
        throw new Error('A search-index download is damaged. Please retry.');
      }
      if (cache) {
        try { await cache.put(url, new Response(compressed)); } catch (_) { /* Searching still works when storage is full. */ }
      }
      const bytes = await gunzip(new Response(compressed));
      if (bytes.byteLength !== part.rows * dimensions * 2) throw new Error('Incorrect search-index size.');
      values.set(decodeHalf(bytes), offset);
      offset += part.rows * dimensions;
      completed++;
    }
    if (offset !== values.length) throw new Error('Incomplete scene index.');
    matrix = values;
    self.postMessage({progress: 'Scene index loaded. Matches prioritize scene content, with colors secondary.'});
  })();
  try { await loading; } finally { loading = null; }
}

self.onmessage = async ({data}) => {
  const {id, action, value} = data;
  try {
    const catalogue = await initialized;
    let result;
    if (action === 'init') result = catalogue;
    else if (action === 'available') { available = new Set(value); result = {images: available.size}; }
    else if (action === 'game') {
      const game = state.games.get(value);
      if (!game) throw new Error('Game not found.');
      result = {...game, images: game.images.filter(image => available.has(image.id))};
    } else if (action === 'query') {
      const params = new URLSearchParams(value);
      if (['visual', 'both'].includes(params.get('similarity'))) await loadIndex();
      result = queryLibrary(state, params, available, matrix);
    } else throw new Error('Unknown gallery action.');
    self.postMessage({id, result});
  } catch (error) { self.postMessage({id, error: error.message}); }
};
