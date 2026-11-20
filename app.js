'use strict';
const $ = id => document.getElementById(id);
const format = new Intl.NumberFormat('en');
const compact = new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1});
let pageSize = 240;
let kind = 'thumbs', page = 0, total = 0, generation = 0, activeRequest;
let facets = [], facetKey = '', selectedGame, selectedImages = [], imageIndex = 0, lastTrigger;
let statusTimer, reference = null, stopHover = () => {};
let viewBeforeSimilarity;
let hoverGeneration = 0;
const imageLists = new Map();
const saved = window.galleryHost?.saved;

async function api(path, options = {}) {
  if (window.galleryHost) return window.galleryHost.api(path, options);
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function imageSource(element, id) {
  if (window.galleryHost) return window.galleryHost.imageSource(element, id);
  element[element.tagName === 'A' ? 'href' : 'src'] = `/image/${id}`;
}
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function options(select, values, label) {
  const previous = select.value;
  select.replaceChildren(new Option(label, ''), ...values.map(value => new Option(value, value)));
  if (values.includes(previous)) select.value = previous;
}
function updateSubgenres() {
  const values = [...new Set(facets.filter(f => !$('genre').value || f.genre === $('genre').value).map(f => f.subgenre))].sort();
  options($('subgenre'), values, 'All subgenres');
}
async function status() {
  try {
    const data = await api('/api/status');
    $('collection-count').textContent = `${format.format(data.thumbnails)} thumbnails · ${format.format(data.icons)} icons`;
    $('collection-games').textContent = `${format.format(data.games)} games tracked`;
    $('sync-title').textContent = data.pending ? `${format.format(data.ready)} / ${format.format(data.games)} games ready to filter` : `${format.format(data.ready)} games ready to explore`;
    $('sync-message').textContent = data.message + (data.unavailable ? ` ${format.format(data.unavailable)} games with metadata unavailable.` : '');
    $('sync-progress').max = data.games || 1;
    $('sync-progress').value = data.ready + data.unavailable;
    $('sync-button').hidden = !data.pending;
    $('sync-button').disabled = data.running;
    $('sync-button').textContent = data.running ? 'Collecting…' : 'Resume metadata';
    if (data.visual) {
      const visual = data.visual;
      $('visual-title').textContent = `${format.format(visual.ready)} / ${format.format(visual.total)} images ready for visual matching`;
      $('visual-message').textContent = visual.message + (visual.failed ? ` ${format.format(visual.failed)} unreadable images skipped.` : '');
      $('visual-progress').max = visual.total || 1;
      $('visual-progress').value = visual.ready + visual.failed;
      $('visual-button').hidden = visual.ready + visual.failed >= visual.total;
      $('visual-button').disabled = visual.running;
      $('visual-button').textContent = visual.running ? 'Indexing…' : 'Resume visual index';
    }
    const key = JSON.stringify(data.facets);
    if (facetKey !== key) {
      facetKey = key;
      facets = data.facets;
      options($('genre'), [...new Set(facets.map(f => f.genre).concat(['Unknown']))].sort(), 'All genres');
      updateSubgenres();
    }
  } catch (error) {
    $('sync-message').textContent = window.galleryHost ? error.message : 'Cannot reach the local server. Start the gallery launcher to reconnect.';
  } finally {
    clearTimeout(statusTimer);
    if (!window.galleryHost) statusTimer = setTimeout(status, 5000);
  }
}
function dailyCategory() {
  return !reference && !saved?.active ? $('daily-category')?.value : '';
}
function parameters() {
  const params = new URLSearchParams({kind, offset: page * pageSize, limit: pageSize, sort: $('sort').value});
  params.set('all_images', $('all-images').checked ? '1' : '0');
  const daily = dailyCategory();
  if (daily) {
    params.set('daily_category', daily);
    if (daily === 'new-images') params.set('all_images', '1');
  }
  if (saved?.active) {
    params.set('saved_ids', JSON.stringify(saved.ids));
    params.set('all_images', '1');
  }
  if (reference) {
    if (reference.uploaded) params.set('uploaded', '1');
    else params.set('seed_image', reference.imageId);
    params.set('similarity', $('similarity-mode').value);
  }
  for (const id of ['search', 'genre', 'subgenre', 'min_visits', 'max_visits']) {
    if ($(id).value) params.set(id, $(id).value);
  }
  for (const id of ['first_from', 'first_to']) {
    if ($(id)?.value) params.set(id, $(id).value);
  }
  return params;
}
function missingImage(event) {
  event.currentTarget.replaceWith(node('span', 'missing-image', 'Image unavailable'));
}
function card(game) {
  const cardKind = kind;
  let displayedImageId = game.image_id;
  const button = node('button', 'card');
  button.type = 'button';
  button.setAttribute('aria-label', `Explore ${game.name || 'game ' + game.id}`);
  const imageBox = node('div', 'card-image');
  const image = node('img');
  imageSource(image, game.image_id);
  image.alt = `${kind === 'icons' ? 'Icon' : 'Thumbnail'} for ${game.name || 'game ' + game.id}`;
  image.loading = 'lazy';
  image.decoding = 'async';
  image.addEventListener('error', missingImage, {once: true});
  const counter = node('span', 'image-total', `${game.image_count} saved`);
  imageBox.append(image);
  if (game.similarity_score === undefined) imageBox.append(counter);
  const meta = node('div', 'card-meta');
  const visits = game.visits === null ? 'Visits unknown' : `${compact.format(game.visits)} visits`;
  const visitLabel = node('span', '', visits);
  if (game.visits !== null) visitLabel.title = `${format.format(game.visits)} lifetime visits`;
  meta.append(node('span', '', game.genre || 'Awaiting metadata'), visitLabel);
  button.append(imageBox, node('h3', '', game.name || `Game ${game.id}`), meta, node('span', 'card-subgenre', game.subgenre || (game.status === 'unavailable' ? 'Metadata unavailable' : 'Information still being collected')));
  if (game.similarity_score !== undefined) button.append(node('span', 'match-score', `Visual match · ${game.similarity_score.toFixed(2)}`));
  let ownStop = () => {};
  const root = saved ? saved.card(button, game, () => displayedImageId) : button;
  async function cycle() {
    stopHover();
    if (game.similarity_score !== undefined || saved?.active || dailyCategory() === 'new-images') return;
    if (game.image_count < 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const token = ++hoverGeneration;
    let timer;
    ownStop = () => {
      if (token === hoverGeneration) hoverGeneration++;
      clearInterval(timer);
      displayedImageId = game.image_id;
      imageSource(image, game.image_id);
      counter.textContent = `${game.image_count} saved`;
    };
    stopHover = ownStop;
    try {
      if (!imageLists.has(game.id)) imageLists.set(game.id, api(`/api/game/${game.id}`).then(g => g.images).catch(error => { imageLists.delete(game.id); throw error; }));
      const images = (await imageLists.get(game.id)).filter(item => item.kind === cardKind);
      if (token !== hoverGeneration || !button.isConnected || images.length < 2) return;
      let index = Math.max(0, images.findIndex(item => item.id === game.image_id));
      timer = setInterval(() => {
        if (!button.isConnected) return ownStop();
        if (root.querySelector('.card-save-actions:hover, .card-save-actions:focus-within')) return;
        index = (index + 1) % images.length;
        displayedImageId = images[index].id;
        imageSource(image, displayedImageId);
        counter.textContent = `${index + 1} / ${images.length}`;
      }, 1000);
    } catch (_) { ownStop(); }
  }
  root.addEventListener('pointerenter', cycle);
  root.addEventListener('pointerleave', () => ownStop());
  button.addEventListener('focus', () => { if (!button.matches(':hover')) cycle(); });
  button.addEventListener('blur', () => ownStop());
  button.addEventListener('click', () => openGame(game.id, button, displayedImageId));
  return root;
}
async function load(reset = false) {
  stopHover();
  $('explore-title').textContent = saved?.title || (kind === 'icons' ? 'Explore Icons' : 'Explore Thumbnails');
  if ($('daily-category')) $('all-images').closest('label').hidden = dailyCategory() === 'new-images';
  if (reset) { page = 0; window.scrollTo({top: 0}); }
  const current = ++generation;
  activeRequest?.abort();
  activeRequest = new AbortController();
  $('grid').setAttribute('aria-busy', 'true');
  $('grid').replaceChildren();
  $('empty').hidden = true;
  $('result-count').textContent = '';
  $('page-label').textContent = 'Loading…';
  $('loading-message').textContent = reference ? 'Finding similar images…' : 'Loading images…';
  $('loading').hidden = false;
  $('error').hidden = true;
  $('previous').disabled = $('next').disabled = true;
  try {
    const data = await api(`/api/library?${parameters()}`, {signal: activeRequest.signal});
    if (current !== generation) return;
    total = data.total;
    $('grid').classList.toggle('icons', kind === 'icons');
    $('grid').replaceChildren(...data.items.map(card));
    $('empty').hidden = total !== 0;
    const unit = dailyCategory() === 'new-images' ? (kind === 'icons' ? 'icons' : 'thumbnails') : saved?.active || $('all-images').checked ? 'images' : 'games';
    if ($('daily-category')) {
      $('empty').querySelector('h3').textContent = dailyCategory() === 'new-games' ? 'No matching games added in the latest scan.'
        : dailyCategory() === 'new-images' ? 'No matching new images in the latest scan.' : 'No games in this view.';
    }
    const prefix = reference && $('similarity-mode').value !== 'type' ? 'Closest ' : '';
    $('result-count').textContent = total ? `${prefix}${format.format(total)} ${unit} · Showing ${format.format(page * pageSize + 1)}–${format.format(page * pageSize + data.items.length)}` : `0 matching ${unit}`;
    $('page-label').textContent = `Page ${page + 1} of ${Math.max(1, Math.ceil(total / pageSize))}`;
    $('previous').disabled = page === 0;
    $('next').disabled = (page + 1) * pageSize >= total;
  } catch (error) {
    if (error.name === 'AbortError' || current !== generation) return;
    $('error').textContent = error.message;
    $('error').hidden = false;
    $('result-count').textContent = 'Unable to load these results';
    $('grid').replaceChildren();
  } finally {
    if (current === generation) {
      $('grid').setAttribute('aria-busy', 'false');
      $('loading').hidden = true;
    }
  }
}
function savedDate(value) {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)} ${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}`;
}
async function openGame(id, trigger, imageId) {
  stopHover();
  lastTrigger = trigger;
  try {
    const game = await api(`/api/game/${id}`);
    selectedGame = game;
    selectedImages = game.images.filter(image => image.kind === kind);
    if (!selectedImages.length) throw new Error('No images of this type are available.');
    imageIndex = 0;
    $('viewer-title').textContent = game.name || `Game ${game.id}`;
    $('viewer-genre').textContent = `${game.genre || 'Unknown genre'} / ${game.subgenre || 'Unknown subgenre'}`;
    $('viewer-visits').textContent = game.visits === null ? 'Visits unknown' : `${format.format(game.visits)} lifetime visits`;
    const placeId = game.root_place_id;
    const hasGameLink = Number.isSafeInteger(placeId) && placeId > 0;
    $('game-page').hidden = !hasGameLink && !game.name;
    $('game-page').setAttribute('aria-label', hasGameLink ? 'Open game page' : 'Find on Roblox');
    if (hasGameLink) {
      $('game-page').href = `https://www.roblox.com/games/${placeId}`;
    } else {
      if (game.name) $('game-page').href = `https://www.roblox.com/discover/?Keyword=${encodeURIComponent(game.name)}`;
      else $('game-page').removeAttribute('href');
    }
    $('viewer-error').hidden = true;
    $('filmstrip').replaceChildren(...selectedImages.map((image, index) => {
      const button = node('button');
      button.type = 'button';
      button.setAttribute('aria-label', `Saved image ${index + 1}, ${savedDate(image.captured)}`);
      const preview = node('img');
      imageSource(preview, image.id);
      preview.alt = '';
      preview.loading = 'lazy';
      button.append(preview);
      button.addEventListener('click', () => showImage(index));
      return button;
    }));
    showImage(Math.max(0, selectedImages.findIndex(image => image.id === imageId)));
    $('viewer').showModal();
  } catch (error) {
    $('error').textContent = error.message;
    $('error').hidden = false;
  }
}
function showImage(index) {
  imageIndex = (index + selectedImages.length) % selectedImages.length;
  const image = selectedImages[imageIndex];
  saved?.showImage(image.id);
  imageSource($('preview'), image.id);
  $('preview').alt = `${selectedGame.name || 'Game ' + selectedGame.id}, saved image ${imageIndex + 1}`;
  $('image-info').textContent = `${imageIndex + 1} / ${selectedImages.length} · Saved ${savedDate(image.captured)}`;
  imageSource($('open-image'), image.id);
  $('image-prev').disabled = $('image-next').disabled = selectedImages.length < 2;
  [...$('filmstrip').children].forEach((button, i) => button.setAttribute('aria-pressed', String(i === imageIndex)));
  $('filmstrip').children[imageIndex]?.scrollIntoView({block: 'nearest', inline: 'nearest'});
}
let debounce;
function scheduleLoad() { clearTimeout(debounce); debounce = setTimeout(() => load(true), 300); }
$('filters').addEventListener('submit', event => event.preventDefault());
for (const id of ['search', 'min_visits', 'max_visits']) $(id).addEventListener('input', () => {
  if (id !== 'search') $('range').value = '';
  scheduleLoad();
});
$('genre').addEventListener('change', () => { $('subgenre').value = ''; updateSubgenres(); load(true); });
$('subgenre').addEventListener('change', () => load(true));
for (const id of ['first_from', 'first_to']) $(id)?.addEventListener('change', () => load(true));
$('range').addEventListener('change', () => {
  const [minimum = '', maximum = ''] = $('range').value.split(':');
  $('min_visits').value = minimum;
  $('max_visits').value = maximum;
  load(true);
});
$('sort').addEventListener('change', () => load(true));
$('clear-filters').addEventListener('click', () => { $('filters').reset(); clearSimilarity(); updateSubgenres(); load(true); });
document.querySelector('.brand').addEventListener('click', event => {
  if (!window.galleryHost) return;
  event.preventDefault();
  $('viewer').close();
  $('filters').reset();
  if ($('daily-category')) $('daily-category').value = '';
  saved?.reset();
  clearSimilarity();
  kind = 'thumbs';
  pageSize = 240;
  $('all-images').checked = false;
  $('page-size').value = '240';
  $('sort').value = 'visits';
  $('size').value = '260';
  document.documentElement.style.setProperty('--card-width', '260px');
  document.querySelectorAll('[data-kind]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.kind === kind)));
  updateSubgenres();
  load(true);
});
$('all-images').addEventListener('change', () => load(true));
$('page-size').addEventListener('change', () => { pageSize = Number($('page-size').value); load(true); });
document.querySelectorAll('[data-kind]').forEach(button => button.addEventListener('click', () => {
  kind = button.dataset.kind;
  document.querySelectorAll('[data-kind]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  load(true);
}));
$('size').addEventListener('input', () => document.documentElement.style.setProperty('--card-width', `${$('size').value}px`));
$('previous').addEventListener('click', () => { if (page > 0) { page--; load(); window.scrollTo({top: 0}); } });
$('next').addEventListener('click', () => { if ((page + 1) * pageSize < total) { page++; load(); window.scrollTo({top: 0}); } });
$('refresh').addEventListener('click', () => { status(); load(true); });
$('sync-button').addEventListener('click', async () => {
  $('sync-button').disabled = true;
  try { await api('/api/sync', {method: 'POST'}); await status(); }
  catch (error) { $('sync-message').textContent = error.message; $('sync-button').disabled = false; }
});
$('visual-button').addEventListener('click', async () => {
  $('visual-button').disabled = true;
  try { await api('/api/visual-start', {method: 'POST'}); await status(); }
  catch (error) { $('visual-message').textContent = error.message; $('visual-button').disabled = false; }
});
function similaritySort() {
  const visual = reference && $('similarity-mode').value !== 'type';
  $('all-images').disabled = Boolean(visual || saved?.active);
  if (visual || saved?.active) $('all-images').checked = true;
  $('sort').disabled = Boolean(visual);
  $('sort').options[0].textContent = visual ? 'Best visual match' : 'Most visits';
  if (visual) $('sort').value = 'visits';
}
function clearSimilarity() {
  if (reference) $('all-images').checked = viewBeforeSimilarity;
  if (reference?.url) URL.revokeObjectURL(reference.url);
  reference = null;
  $('similarity-mode').closest('label').hidden = false;
  $('similarity-panel').hidden = true;
  similaritySort();
}
$('find-similar').addEventListener('click', () => {
  saved?.reset();
  if (reference?.url) URL.revokeObjectURL(reference.url);
  $('similarity-mode').closest('label').hidden = false;
  if (!reference) viewBeforeSimilarity = $('all-images').checked;
  reference = {imageId: selectedImages[imageIndex].id, name: selectedGame.name || `Game ${selectedGame.id}`};
  imageSource($('reference-image'), reference.imageId);
  $('reference-name').textContent = reference.name;
  $('similarity-panel').hidden = false;
  $('similarity-mode').value = selectedGame.genre && selectedGame.genre !== 'Unknown' ? 'both' : 'visual';
  for (const id of ['search', 'genre', 'subgenre']) $(id).value = '';
  updateSubgenres();
  similaritySort();
  lastTrigger = null;
  $('viewer').close();
  load(true);
  window.scrollTo({top: 0});
});
$('upload-search')?.addEventListener('click', () => $('upload-input').click());
$('upload-input')?.addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  $('upload-search').disabled = true;
  $('loading').hidden = false;
  $('loading-message').textContent = 'Preparing image search…';
  $('error').hidden = true;
  try {
    await window.galleryHost.searchImage(file);
    saved?.reset();
    if (!reference) viewBeforeSimilarity = $('all-images').checked;
    if (reference?.url) URL.revokeObjectURL(reference.url);
    reference = {uploaded: true, url: URL.createObjectURL(file)};
    $('reference-image').src = reference.url;
    $('reference-name').textContent = file.name;
    $('similarity-panel').hidden = false;
    $('similarity-mode').value = 'visual';
    $('similarity-mode').closest('label').hidden = true;
    $('search').value = '';
    similaritySort();
    load(true);
  } catch (error) {
    $('loading').hidden = true;
    $('error').textContent = error.message;
    $('error').hidden = false;
  } finally { $('upload-search').disabled = false; }
});
$('similarity-mode').addEventListener('change', () => { similaritySort(); load(true); });
$('clear-similarity').addEventListener('click', () => { clearSimilarity(); load(true); });
$('close-viewer').addEventListener('click', () => $('viewer').close());
$('viewer').addEventListener('close', () => lastTrigger?.focus());
$('viewer').addEventListener('click', event => { if (event.target === $('viewer')) { const r = $('viewer').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('viewer').close(); } });
$('image-prev').addEventListener('click', () => showImage(imageIndex - 1));
$('image-next').addEventListener('click', () => showImage(imageIndex + 1));
$('viewer').addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); showImage(imageIndex + (event.key === 'ArrowLeft' ? -1 : 1)); }
});
$('download-image').addEventListener('click', async () => {
  try {
    const image = selectedImages[imageIndex];
    let file;
    if (window.galleryHost) file = await window.galleryHost.imageFile(image.id);
    else {
      const response = await fetch(`/image/${image.id}`);
      if (!response.ok) throw new Error('Could not download this image.');
      file = await response.blob();
    }
    const url = URL.createObjectURL(file);
    const link = node('a');
    link.href = url; link.download = image.filename; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('viewer-error').hidden = true;
  } catch (error) { $('viewer-error').textContent = error.message; $('viewer-error').hidden = false; }
});
$('reveal').addEventListener('click', async () => {
  try { await api(`/api/reveal/${selectedImages[imageIndex].id}`, {method: 'POST'}); }
  catch (error) { $('viewer-error').textContent = error.message; $('viewer-error').hidden = false; }
});
$('quit').addEventListener('click', async () => {
  try {
    await api('/api/quit', {method: 'POST'});
    if (window.galleryHost) return;
    clearTimeout(statusTimer);
    activeRequest?.abort();
    $('sync-title').textContent = 'Gallery stopped';
    $('sync-message').textContent = 'Run Start Gallery.cmd to reopen. Metadata collection will resume from saved progress.';
    $('sync-button').hidden = true;
    $('quit').disabled = true;
  } catch (error) { $('sync-message').textContent = error.message; }
});
window.addEventListener('gallery:connected', () => { imageLists.clear(); status(); load(true); });
window.addEventListener('gallery:saved-view', () => { $('filters').reset(); clearSimilarity(); updateSubgenres(); load(true); });
window.addEventListener('gallery:saved', () => { if (saved?.active) load(true); });
$('daily-category')?.addEventListener('change', () => load(true));
status();
load();


