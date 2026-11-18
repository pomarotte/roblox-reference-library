'use strict';
(() => {
  const worker = new Worker('./search-worker.js', {type: 'module'});
  const pending = new Map(), urls = new Map(), imageRequests = new WeakMap();
  const el = id => document.getElementById(id);
  let sequence = 0, catalogue, images, folder, localFiles = new Map(), remembered, connected = false, connectionVersion = 0;
  worker.onmessage = ({data}) => {
    if ('progress' in data) {
      el('visual-message').textContent = data.progress;
      el('visual-message').closest('section').hidden = !data.busy;
      return;
    }
    const task = pending.get(data.id);
    if (!task) return;
    pending.delete(data.id);
    if (data.error) task.reject(new Error(data.error)); else task.resolve(data.result);
  };
  worker.onerror = () => {
    for (const task of pending.values()) task.reject(new Error('The browser search could not start. Reload the page in a current desktop browser.'));
    pending.clear();
  };
  function rpc(action, value) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject});
      worker.postMessage({id, action, value});
    });
  }
  async function storeHandle(value) {
    try {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('roblox-local-folder', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('folder');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const result = await new Promise((resolve, reject) => {
        const transaction = db.transaction('folder', value === undefined ? 'readonly' : 'readwrite');
        const store = transaction.objectStore('folder');
        const request = value === undefined ? store.get('dataset') : value === null ? store.delete('dataset') : store.put(value, 'dataset');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return result;
    } catch (_) { return null; }
  }
  function revokeImages() {
    for (const promise of urls.values()) promise.then(url => URL.revokeObjectURL(url)).catch(() => {});
    urls.clear();
  }
  function refreshed() { window.dispatchEvent(new Event('gallery:connected')); }
  async function activate(available, label, candidate, files = new Map()) {
    if (!available.length) throw new Error('No matching images found. Choose the extracted folder containing icons and thumbs, not the ZIP.');
    const counts = {icons: 0, thumbs: 0};
    for (const id of available) counts[images.get(id).kind]++;
    if (!counts.icons || !counts.thumbs) throw new Error('Select the parent dataset folder containing both icons and thumbs.');
    await rpc('available', available);
    connectionVersion++;
    revokeImages();
    folder = candidate;
    localFiles = files;
    connected = true;
    document.body.classList.remove('web-disconnected');
    el('folder-title').textContent = label;
    el('folder-status').textContent = `${available.length.toLocaleString()} / ${images.size.toLocaleString()} saved images connected${available.length === images.size ? '. Ready to explore.' : '. Missing files are left out of results.'}`;
    el('choose-folder').textContent = 'Change dataset folder ↗';
    el('reconnect-folder').hidden = true;
    el('quit').disabled = false;
    el('choose-folder').closest('section').classList.add('connected');
    refreshed();
  }
  async function connectHandle(handle) {
    el('folder-status').textContent = 'Checking image filenames on your computer…';
    let candidate = handle, directories;
    for (const child of [null, 'roblox-icons-thumbnails']) {
      try {
        candidate = child ? await handle.getDirectoryHandle(child) : handle;
        directories = {icons: await candidate.getDirectoryHandle('icons'), thumbs: await candidate.getDirectoryHandle('thumbs')};
        break;
      } catch (_) { directories = null; }
    }
    if (!directories) throw new Error('This folder needs icons and thumbs subfolders. Extract the Everything dataset first.');
    const byPath = new Map([...images].map(([id, image]) => [`${image.kind}/${image.filename}`, id]));
    const available = [];
    for (const kind of ['icons', 'thumbs']) {
      for await (const [name, handle] of directories[kind].entries()) {
        const id = byPath.get(`${kind}/${name}`);
        if (handle.kind === 'file' && id !== undefined) available.push(id);
      }
    }
    await activate(available, candidate.name, directories);
    remembered = candidate;
    await storeHandle(candidate);
  }
  async function choose() {
    if (!window.showDirectoryPicker) return el('folder-input').click();
    try {
      const handle = await window.showDirectoryPicker({mode: 'read', id: 'roblox-dataset'});
      await connectHandle(handle);
    } catch (error) {
      if (error.name !== 'AbortError') el('folder-status').textContent = error.message;
    }
  }
  const ready = rpc('init').then(async data => {
    catalogue = data;
    images = new Map();
    for (const game of data.games) for (const image of game.images) images.set(image.id, image);
    el('folder-status').textContent = 'Choose your extracted dataset folder. Images stay on this computer.';
    el('choose-folder').disabled = false;
    el('quit').disabled = true;
    el('fallback-folder').hidden = !window.showDirectoryPicker;
    remembered = await storeHandle();
    if (remembered && window.showDirectoryPicker) {
      if (await remembered.queryPermission({mode: 'read'}) === 'granted') {
        try { await connectHandle(remembered); } catch (error) { el('folder-status').textContent = error.message; el('reconnect-folder').hidden = false; }
      } else el('reconnect-folder').hidden = false;
    }
    return data;
  }).catch(error => { el('folder-status').textContent = error.message; throw error; });
  el('choose-folder').addEventListener('click', choose);
  el('fallback-folder').addEventListener('click', () => el('folder-input').click());
  el('reconnect-folder').addEventListener('click', async () => {
    try {
      if (await remembered.requestPermission({mode: 'read'}) !== 'granted') throw new Error('Folder access was not granted. You can choose the folder again.');
      await connectHandle(remembered);
    } catch (error) { el('folder-status').textContent = error.message; }
  });
  el('folder-input').addEventListener('change', async event => {
    try {
      const {matchLocalFiles} = await import('./web-core.mjs');
      const files = matchLocalFiles(event.target.files, images);
      await activate([...files.keys()], event.target.files[0]?.webkitRelativePath.split('/')[0] || 'Local dataset', null, files);
      remembered = null;
      await storeHandle(null);
    } catch (error) { el('folder-status').textContent = error.message; }
    event.target.value = '';
  });
  async function imageURL(id) {
    if (urls.has(id)) return urls.get(id);
    const image = images.get(id), version = connectionVersion;
    if (!connected || !image) throw new Error('Connect your dataset folder first.');
    const request = (async () => {
      const file = folder ? await (await folder[image.kind].getFileHandle(image.filename)).getFile() : localFiles.get(id);
      if (!file || !file.size || version !== connectionVersion) throw new Error('This image is no longer available. Reconnect its folder.');
      return URL.createObjectURL(file);
    })();
    urls.set(id, request);
    request.catch(() => { if (urls.get(id) === request) urls.delete(id); });
    if (urls.size > 2048) {
      const oldest = urls.keys().next().value;
      urls.get(oldest).then(url => URL.revokeObjectURL(url)).catch(() => {});
      urls.delete(oldest);
    }
    return request;
  }
  window.galleryHost = {
    async api(path, {signal} = {}) {
      await ready;
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (path === '/api/status') {
        const facets = new Map();
        for (const game of catalogue.games) if (game.status === 'ready') facets.set(`${game.genre}\0${game.subgenre}`, {genre: game.genre, subgenre: game.subgenre});
        return {games: catalogue.games.length, images: images.size, ready: catalogue.games.filter(g => g.status === 'ready').length, pending: 0, unavailable: catalogue.games.filter(g => g.status === 'unavailable').length, facets: [...facets.values()], message: 'Saved game metadata. No collection or API requests needed.', visual: {ready: images.size, total: images.size, failed: 0, message: 'The prepared scene index downloads on first visual search and is cached when browser storage is available.'}};
      }
      if (path.startsWith('/api/library?')) return rpc('query', path.split('?')[1]);
      if (path.startsWith('/api/game/')) return rpc('game', Number(path.split('/').pop()));
      if (path === '/api/quit') {
        connectionVersion++;
        folder = null;
        localFiles.clear();
        connected = false;
        document.body.classList.add('web-disconnected');
        remembered = null;
        await storeHandle(null);
        await rpc('available', []);
        revokeImages();
        el('folder-title').textContent = 'Connect your image collection.';
        el('folder-status').textContent = 'Folder disconnected. Choose it again whenever you want to browse.';
        el('choose-folder').textContent = 'Choose dataset folder ↗';
        el('choose-folder').closest('section').classList.remove('connected');
        el('quit').disabled = true;
        refreshed();
        return {};
      }
      throw new Error('This action is available in the desktop edition.');
    },
    async imageSource(element, id) {
      const token = {};
      imageRequests.set(element, token);
      if (element.tagName === 'A') element.removeAttribute('href');
      try {
        const url = await imageURL(id);
        if (imageRequests.get(element) !== token) return;
        element[element.tagName === 'A' ? 'href' : 'src'] = url;
      } catch (error) {
        if (imageRequests.get(element) !== token) return;
        if (element.tagName === 'IMG') element.alt = 'Image unavailable. Reconnect your dataset folder.';
        element.title = error.message;
      }
    }
  };
})();
