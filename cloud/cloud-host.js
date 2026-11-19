'use strict';
(() => {
  const worker = new Worker('./search-worker.js', {type: 'module'});
  const pending = new Map(), el = id => document.getElementById(id);
  const imageOrigin = 'https://rolibrary.win/';
  let sequence = 0, catalogue, images;
  worker.onmessage = ({data}) => {
    if ('progress' in data) {
      el('visual-message').textContent = data.progress;
      if (data.busy && !el('loading').hidden && !el('similarity-panel').hidden) el('loading-message').textContent = data.progress;
      return;
    }
    const task = pending.get(data.id);
    if (!task) return;
    pending.delete(data.id);
    if (data.error) task.reject(new Error(data.error)); else task.resolve(data.result);
  };
  worker.onerror = () => {
    for (const task of pending.values()) task.reject(new Error('Search could not start. Reload the page.'));
    pending.clear();
  };
  function rpc(action, value) {
    const id = ++sequence;
    return new Promise((resolve, reject) => { pending.set(id, {resolve, reject}); worker.postMessage({id, action, value}); });
  }
  function imageURL(id) {
    const image = images?.get(id);
    if (!image || !['icons', 'thumbs'].includes(image.kind) || /[\\/]/.test(image.filename)) throw new Error('Image unavailable.');
    const path = image.object_key || `${image.kind}/${encodeURIComponent(image.filename)}`;
    if (image.object_key && !/^daily\/[a-f0-9]{64}\.(webp|png|jpg|gif)$/.test(path)) throw new Error('Invalid daily image path.');
    return new URL(path, imageOrigin).href;
  }
  async function imageFile(id) {
    const response = await fetch(imageURL(id));
    if (!response.ok) throw new Error('Image download failed. Please retry.');
    return response.blob();
  }
  const ready = rpc('init').then(async data => {
    catalogue = data;
    images = new Map();
    for (const game of data.games) for (const image of game.images) images.set(image.id, image);
    await rpc('available', [...images.keys()]);
    return data;
  });
  window.galleryHost = {
    saved: window.galleryCollections.initialize({getFile: imageFile, getImage: id => images?.get(id)}),
    async api(path, {signal} = {}) {
      await ready;
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (path === '/api/status') {
        const facets = new Map();
        for (const game of catalogue.games) if (game.status === 'ready') facets.set(`${game.genre}\0${game.subgenre}`, {genre: game.genre, subgenre: game.subgenre});
        return {games: catalogue.games.length, images: images.size, ready: catalogue.games.filter(g => g.status === 'ready').length, pending: 0, unavailable: catalogue.games.filter(g => g.status === 'unavailable').length, facets: [...facets.values()]};
      }
      if (path.startsWith('/api/library?')) return rpc('query', path.split('?')[1]);
      if (path.startsWith('/api/game/')) return rpc('game', Number(path.split('/').pop()));
      throw new Error('This action is unavailable.');
    },
    imageSource(element, id) {
      try { element[element.tagName === 'A' ? 'href' : 'src'] = imageURL(id); }
      catch (error) { if (element.tagName === 'IMG') element.alt = error.message; }
    }
  };
})();
