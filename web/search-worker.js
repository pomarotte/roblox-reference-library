import {prepareCatalogue, decodeHalf, queryLibrary, sceneScore} from './web-core.mjs';

let state, available = new Set(), sections, locations, clustered, uploaded, imageModel;
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

function prepareIndex() {
  const {parts, dimensions} = state.catalogue.visual;
  if (dimensions !== 560) throw new Error('Incorrect search-index dimensions.');
  const hasCenters = parts.length > 0 && parts.every(part =>
    Array.isArray(part.center) && part.center.length === 512 && part.center.every(Number.isFinite));
  const index = parts.map(part => ({part, rows: 0, url: new URL(part.url, self.location.href).href}));
  let next = 0;
  const positions = state.ordered.map(image => {
    while (!hasCenters && index[next] && index[next].rows === index[next].part.rows) next++;
    const section = index[hasCenters ? image.visual_part : next];
    if (!section || section.rows >= section.part.rows) throw new Error('Incomplete scene index.');
    return {section, row: section.rows++};
  });
  if (index.some(section => section.rows !== section.part.rows)) throw new Error('Incomplete scene index.');
  sections = index;
  locations = positions;
  clustered = hasCenters;
}

async function openIndexCache() {
  try {
    const cache = await caches.open('roblox-scenes-v1');
    const directory = new URL('./data/', self.location.href).href;
    const expected = new Set(sections.map(section => section.url));
    for (const request of await cache.keys()) {
      if (request.url.startsWith(directory) && !expected.has(request.url)) await cache.delete(request);
    }
    return cache;
  } catch (_) { /* Searching works without browser storage. */ }
}

let indexCache;
function loadSection(section) {
  return section.loading ??= (async () => {
    const cache = await (indexCache ??= openIndexCache());
    const {part, url} = section;
    const cached = await cache?.match(url);
    const response = cached || await fetch(url);
    if (!response.ok) throw new Error('Could not download the scene index. Check your connection and retry.');
    const compressed = await response.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', compressed)), n => n.toString(16).padStart(2, '0')).join('');
    if (digest !== part.sha256) {
      await cache?.delete(url);
      throw new Error('A search-index download is damaged. Please retry.');
    }
    const bytes = await gunzip(new Response(compressed));
    if (bytes.byteLength !== part.rows * 560 * 2) throw new Error('Incorrect search-index size.');
    const values = decodeHalf(bytes);
    if (cache && !cached) {
      try { await cache.put(url, new Response(compressed)); } catch (_) { /* Searching works when storage is full. */ }
    }
    return values;
  })().catch(error => {
    section.loading = null;
    throw error;
  });
}

async function searchIndex(params, available, reference) {
  const external = params.get('uploaded') === '1';
  const seed = state.images.get(Number(params.get('seed_image')));
  const mode = params.get('similarity');
  if (external ? mode !== 'visual' || !reference : !seed) {
    return queryLibrary(state, params, available, null, reference);
  }
  if (!sections) prepareIndex();
  const anchor = external ? null : locations[seed.vectorIndex];
  const loaded = new Map();
  async function load(requested) {
    const missing = requested.filter(section => !loaded.has(section));
    for (let start = 0; start < missing.length; start += 4) {
      self.postMessage({progress: `Loading scene search: ${start} / ${missing.length}`, busy: true});
      const results = await Promise.allSettled(missing.slice(start, start + 4).map(async section => {
        loaded.set(section, await loadSection(section));
      }));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
  }
  try {
    if (anchor) await load([anchor.section]);
    const vector = anchor ? loaded.get(anchor.section) : reference;
    const row = anchor?.row ?? 0;
    const filtered = available.size !== state.ordered.length ||
      ['search', 'genre', 'subgenre', 'min_visits', 'max_visits', 'first_from', 'first_to', 'daily_category', 'saved_ids'].some(key => params.get(key));
    const approximate = clustered && !filtered && sections.length > 8;
    const eligible = new Set();
    if (!approximate || mode === 'both') {
      queryLibrary(state, params, available, index => { eligible.add(locations[index].section); }, reference);
    }
    const candidates = !approximate || mode === 'both' ? [...eligible] : sections;
    // shortcut: fixed probe count can miss close matches; tune using measured recall as the catalogue grows.
    if (approximate) {
      const nearest = candidates.map(section => {
        let score = 0;
        for (let d = 0; d < 512; d++) score += section.part.center[d] * vector[row * 560 + d];
        return {section, score};
      }).sort((a, b) => b.score - a.score);
      await load(nearest.slice(0, 8).map(item => item.section));
    } else await load(candidates);
    const score = index => {
      const candidate = locations[index];
      const values = loaded.get(candidate.section);
      if (values) return sceneScore(values, candidate.row, row, 560, vector);
    };
    const result = queryLibrary(state, params, available, score, reference);
    if (!approximate || result.total >= 480 || candidates.every(section => loaded.has(section))) return result;
    await load(candidates);
    return queryLibrary(state, params, available, score, reference);
  } finally { self.postMessage({progress: '', busy: false}); }
}

self.onmessage = async ({data}) => {
  const {id, action, value} = data;
  try {
    const catalogue = await initialized;
    let result;
    if (action === 'init') result = catalogue;
    else if (action === 'reference') { uploaded = await encodeReference(value); result = true; }
    else if (action === 'available') { available = new Set(value); result = {images: available.size}; }
    else if (action === 'game') {
      const game = state.games.get(value);
      if (!game) throw new Error('Game not found.');
      result = {...game, images: game.images.filter(image => available.has(image.id))};
    } else if (action === 'query') {
      const params = new URLSearchParams(value);
      result = ['visual', 'both'].includes(params.get('similarity'))
        ? await searchIndex(params, available, uploaded)
        : queryLibrary(state, params, available);
    } else throw new Error('Unknown gallery action.');
    self.postMessage({id, result});
  } catch (error) { self.postMessage({id, error: error.message}); }
};

async function encodeReference(file) {
  if (!file || !file.type.startsWith('image/') || !file.size || file.size > 20 * 1024 * 1024) throw new Error('Choose an image smaller than 20 MB.');
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch (_) { throw new Error('This image could not be opened.'); }
  try {
    if (bitmap.width * bitmap.height > 40000000) throw new Error('Choose an image smaller than 40 megapixels.');
    self.postMessage({progress: 'Loading image search…', busy: true});
    if (!imageModel) {
      const {AutoProcessor, CLIPVisionModelWithProjection, RawImage} = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js');
      const name = 'Xenova/clip-vit-base-patch32';
      const [processor, model] = await Promise.all([AutoProcessor.from_pretrained(name, {revision: 'd15189d'}), CLIPVisionModelWithProjection.from_pretrained(name, {revision: 'd15189d', dtype: 'q8'})]);
      imageModel = {processor, model, RawImage};
    }
    self.postMessage({progress: 'Analyzing your image on this device…', busy: true});
    const canvas = new OffscreenCanvas(224, 224), context = canvas.getContext('2d');
    context.fillStyle = 'rgb(123,117,104)'; context.fillRect(0, 0, 224, 224);
    const scale = Math.min(224 / bitmap.width, 224 / bitmap.height);
    const width = Math.round(bitmap.width * scale), height = Math.round(bitmap.height * scale);
    context.drawImage(bitmap, Math.floor((224 - width) / 2), Math.floor((224 - height) / 2), width, height);
    const pixels = context.getImageData(0, 0, 224, 224).data;
    const rgb = new Uint8Array(224 * 224 * 3);
    for (let i = 0; i < 224 * 224; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = pixels[i * 4 + c];
    const input = await imageModel.processor(new imageModel.RawImage(rgb, 224, 224, 3));
    const {image_embeds} = await imageModel.model(input);
    const vector = image_embeds.data, norm = Math.hypot(...vector);
    if (vector.length !== 512 || !Number.isFinite(norm) || !norm) throw new Error('Could not analyze this image.');
    const result = new Float32Array(560);
    for (let i = 0; i < 512; i++) result[i] = vector[i] / norm;
    const small = new OffscreenCanvas(64, 64), colors = small.getContext('2d');
    colors.fillStyle = '#000'; colors.fillRect(0, 0, 64, 64); colors.drawImage(bitmap, 0, 0, 64, 64);
    const data = colors.getImageData(0, 0, 64, 64).data;
    for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) result[512 + c * 16 + (data[i + c] >> 4)]++;
    for (let i = 512; i < 560; i++) result[i] = Math.sqrt(result[i] / (64 * 64 * 3));
    return result;
  } finally { bitmap.close(); self.postMessage({progress: '', busy: false}); }
}


