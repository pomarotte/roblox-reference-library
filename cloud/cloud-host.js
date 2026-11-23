'use strict';
(() => {
  const worker = new Worker('./search-worker.js', {type: 'module'});
  const pending = new Map(), el = id => document.getElementById(id);
  const imageOrigin = 'https://rolibrary.win/';
  let sequence = 0, catalogue, images;
  worker.onmessage = ({data}) => {
    if ('progress' in data) {
      el('visual-message').textContent = data.progress;
      if (data.busy && !el('loading').hidden && (!el('similarity-panel').hidden || el('upload-search').disabled)) el('loading-message').textContent = data.progress;
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
    const url = imageURL(id);
    let response;
    try {
      // Keep ZIP fetches separate from cached preview responses without CORS headers.
      response = await fetch(`${url}?download=1`);
    } catch (error) {
      throw new Error(`Could not fetch "${images.get(id).filename}" from rolibrary.win. Check your connection or try again.`, {cause: error});
    }
    if (!response.ok) throw new Error(`Could not download "${images.get(id).filename}" (HTTP ${response.status}).`);
    return response.blob();
  }
  function isRobloxThumbnail(url) {
    return typeof url === 'string' && /^https:\/\/(?:[a-z0-9-]+\.)+rbxcdn\.com\//i.test(url);
  }
  const ready = rpc('init').then(async data => {
    catalogue = data;
    images = new Map();
    for (const game of data.games) for (const image of game.images) images.set(image.id, image);
    const dates = [...images.values()].filter(image => image.kind === 'thumbs' && image.object_key && /^\d{8}_/.test(image.captured)).map(image => image.captured.slice(0, 8));
    if (dates.length) {
      const date = dates.reduce((latest, current) => current > latest ? current : latest);
      const time = el('last-updated').dataset.time;
      const day = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
      const match = /^(around )?(\d{2}:\d{2}) UTC$/.exec(time || '');
      const updated = match
        ? new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(new Date(`${day}T${match[2]}:00Z`))
        : day;
      el('last-updated').textContent = `Last updated ${updated}`;
      el('last-updated').hidden = false;
    }
    await rpc('available', [...images.keys()]);
    return data;
  });
  window.galleryHost = {
    ready,
    async chartCards(games) {
      const data = await ready.catch(() => ({games: []}));
      const byId = new Map(data.games.map(game => [game.id, game]));
      const byPlace = new Map(data.games.filter(game => game.root_place_id)
        .map(game => [game.root_place_id, game]));
      return games.map(game => {
        const saved = byId.get(game.id) || byPlace.get(game.place);
        const archived = (saved?.images || []).filter(image => image.kind === 'thumbs');
        const current = [...new Set([...(game.thumbnails || []), game.image].filter(isRobloxThumbnail))]
          .map(url => ({id: url, url, kind: 'thumbs', filename: `roblox-${game.place}-thumbnail.${/\/webp\//i.test(url) ? 'webp' : 'png'}`}));
        return {...game, id: game.id ?? saved?.id, root_place_id: game.place,
          genre: game.genre || saved?.genre, subgenre: game.subgenre || saved?.subgenre,
          visits: game.visits ?? saved?.visits ?? null, images: [...archived, ...current]};
      });
    },
    imageFile,
    searchImage: file => rpc('reference', file),
    saved: window.galleryCollections.initialize({getFile: imageFile, getImage: id => images?.get(id)}),
    async api(path, {signal} = {}) {
      await ready;
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (path === '/api/status') {
        const facets = new Map();
        for (const game of catalogue.games) if (game.status === 'ready') facets.set(`${game.genre}\0${game.subgenre}`, {genre: game.genre, subgenre: game.subgenre});
        return {games: catalogue.games.length, images: images.size, thumbnails: [...images.values()].filter(image => image.kind === 'thumbs').length, icons: [...images.values()].filter(image => image.kind === 'icons').length, ready: catalogue.games.filter(g => g.status === 'ready').length, pending: 0, unavailable: catalogue.games.filter(g => g.status === 'unavailable').length, facets: [...facets.values()]};
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

