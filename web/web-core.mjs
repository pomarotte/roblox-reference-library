export function prepareCatalogue(catalogue) {
  const games = new Map(), images = new Map(), ordered = [];
  for (const game of catalogue.games) {
    games.set(game.id, game);
    game.images.sort((a, b) => b.captured.localeCompare(a.captured) || b.filename.localeCompare(a.filename));
    for (const image of game.images) {
      const item = {...image, game};
      images.set(image.id, item);
      ordered.push(item);
    }
  }
  ordered.sort((a, b) => a.id - b.id);
  ordered.forEach((image, index) => { image.vectorIndex = index; });
  return {catalogue, games, images, ordered};
}

export async function matchLocalFiles(files, images, onProgress = () => {}) {
  const available = new Map();
  const byPath = new Map([...images.values()].map(image => [`${image.kind}/${image.filename}`, image.id]));
  let checked = 0;
  for (const file of files) {
    const path = (file.webkitRelativePath || '').replaceAll('\\', '/').split('/');
    const key = path.slice(-2).join('/');
    const id = byPath.get(key);
    if (id !== undefined && file.size > 0) available.set(id, file);
    checked++;
    if (checked % 2000 === 0 || checked === files.length) await onProgress(checked, files.length);
  }
  return available;
}

export function decodeHalf(bytes) {
  if (bytes.byteLength % 2) throw new Error('Damaged visual index.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Float32Array(bytes.byteLength / 2);
  for (let i = 0; i < values.length; i++) {
    const n = view.getUint16(i * 2, true), sign = n & 32768 ? -1 : 1, exponent = (n >> 10) & 31, mantissa = n & 1023;
    if (exponent === 31) throw new Error('Invalid values in the visual index.');
    values[i] = sign * (exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24);
  }
  return values;
}

export function sceneScore(matrix, candidate, seed, dimensions = 560) {
  let scene = 0, palette = 0;
  const a = candidate * dimensions, b = seed * dimensions;
  for (let d = 0; d < 512; d++) scene += matrix[a + d] * matrix[b + d];
  for (let d = 512; d < dimensions; d++) palette += matrix[a + d] * matrix[b + d];
  return (scene + 0.03 * palette) / 1.03;
}

export function queryLibrary(state, params, available, matrix = null) {
  const kind = params.get('kind') || 'thumbs', mode = params.get('similarity') || '';
  const seed = mode ? state.images.get(Number(params.get('seed_image'))) : null;
  if (!['icons', 'thumbs'].includes(kind)) throw new Error('Invalid image type.');
  if (!['', 'visual', 'both', 'type'].includes(mode)) throw new Error('Invalid similarity mode.');
  if (mode && !seed) throw new Error('Select a reference image first.');
  if (['both', 'type'].includes(mode) && (!seed.game.genre || seed.game.genre === 'Unknown')) throw new Error('Choose Visual appearance: this game has no genre metadata.');
  const visual = mode === 'visual' || mode === 'both';
  if (visual && !matrix) throw new Error('Load the saved scene index first.');
  const allImages = visual || params.get('all_images') === '1';
  let selectedIds = null;
  if (params.has('saved_ids')) {
    const ids = JSON.parse(params.get('saved_ids'));
    if (!Array.isArray(ids) || !ids.every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('Invalid saved image selection.');
    selectedIds = new Set(ids);
  }
  const search = (params.get('search') || '').trim().slice(0, 200).toLowerCase();
  function visitBound(key) {
    const value = params.get(key);
    if (value === null || value === '') return null;
    if (!/^\d{1,18}$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Enter a valid non-negative visit count.');
    return Number(value);
  }
  const minimum = visitBound('min_visits'), maximum = visitBound('max_visits');
  if (minimum !== null && maximum !== null && minimum > maximum) throw new Error('Minimum visits must not exceed maximum visits.');
  const results = [];
  for (const game of state.games.values()) {
    if (seed && game.id === seed.game.id) continue;
    if (['both', 'type'].includes(mode) && (game.genre !== seed.game.genre || (seed.game.subgenre && seed.game.subgenre !== 'Unknown' && game.subgenre !== seed.game.subgenre))) continue;
    if (params.get('genre') && (game.genre || 'Unknown') !== params.get('genre')) continue;
    if (params.get('subgenre') && (game.subgenre || 'Unknown') !== params.get('subgenre')) continue;
    if (search && !(game.name || '').toLowerCase().includes(search) && String(game.id) !== search) continue;
    if (minimum !== null && (game.visits === null || game.visits < minimum)) continue;
    if (maximum !== null && (game.visits === null || game.visits > maximum)) continue;
    const saved = game.images.filter(image => image.kind === kind && available.has(image.id) && (!selectedIds || selectedIds.has(image.id)));
    for (const image of allImages ? saved : saved.slice(0, 1)) {
      const item = {id: game.id, name: game.name, genre: game.genre, subgenre: game.subgenre, visits: game.visits, status: game.status, image_count: saved.length, image_id: image.id, captured: image.captured};
      if (visual) item.score = sceneScore(matrix, state.images.get(image.id).vectorIndex, seed.vectorIndex);
      results.push(item);
    }
  }
  const sort = params.get('sort') || 'visits';
  results.sort((a, b) => {
    if (visual) return b.score - a.score || a.image_id - b.image_id;
    if (sort === 'name') return (a.name === null) - (b.name === null) || (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()) || a.id - b.id || b.image_id - a.image_id;
    if (sort === 'recent') return b.captured.localeCompare(a.captured) || a.id - b.id || b.image_id - a.image_id;
    if (sort === 'least') return (a.visits === null) - (b.visits === null) || a.visits - b.visits || a.id - b.id || b.image_id - a.image_id;
    return (a.visits === null) - (b.visits === null) || b.visits - a.visits || a.id - b.id || b.captured.localeCompare(a.captured) || b.image_id - a.image_id;
  });
  const matches = visual ? results.slice(0, 480) : results;
  const offset = Math.max(0, Number(params.get('offset')) || 0), limit = Math.min(480, Math.max(1, Number(params.get('limit')) || 240));
  return {total: matches.length, items: matches.slice(offset, offset + limit).map(item => {
    if (!visual) return item;
    const {score, ...rest} = item;
    return {...rest, similarity_score: Math.round(score * 1000) / 1000};
  })};
}
