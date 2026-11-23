'use strict';
(() => {
  const worker = new Worker('./search-worker.js', {type: 'module'});
  const pending = new Map(), urls = new Map(), imageRequests = new WeakMap();
  const el = id => document.getElementById(id);
  let sequence = 0, catalogue, images, folder, localFiles = new Map(), remembered, connected = false, connectionVersion = 0;
  const nextPaint = () => new Promise(resolve => setTimeout(resolve, 0));
  function datasetLoading(title, message, checked = 0, total = 0) {
    el('dataset-loading').hidden = false;
    el('dataset-loading-title').textContent = title;
    el('dataset-loading-message').textContent = message;
    if (total) {
      el('dataset-loading-progress').max = total;
      el('dataset-loading-progress').value = checked;
    } else el('dataset-loading-progress').removeAttribute('value');
    el('choose-folder').disabled = el('reconnect-folder').disabled = true;
  }
  function finishDatasetLoading() {
    el('dataset-loading').hidden = true;
    el('choose-folder').disabled = !images;
    el('reconnect-folder').disabled = false;
  }
  function folderError(error) {
    el('folder-status').textContent = error.message;
    if (connected) {
      el('error').textContent = error.message;
      el('error').hidden = false;
    }
  }
  worker.onmessage = ({data}) => {
    if ('progress' in data) {
      el('visual-message').textContent = data.progress;
      el('visual-message').closest('section').hidden = true;
      if (data.busy && !el('loading').hidden && (!el('similarity-panel').hidden || el('upload-search').disabled) && el('similarity-mode').value !== 'type') el('loading-message').textContent = data.progress;
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
    datasetLoading('Opening gallery', `${available.length.toLocaleString()} local images ready`, available.length, available.length);
    await rpc('available', available);
    connectionVersion++;
    revokeImages();
    folder = candidate;
    localFiles = files;
    connected = true;
    document.body.classList.remove('web-disconnected');
    el('folder-title').textContent = label;
    el('folder-status').textContent = `${available.length.toLocaleString()} / ${images.size.toLocaleString()} saved images connected${available.length === images.size ? '. Ready to explore.' : '. Missing files are left out of results.'}`;
    el('choose-folder').textContent = 'Change folder';
    el('choose-folder').className = 'text-button';
    el('quit').before(el('choose-folder'));
    el('reconnect-folder').hidden = true;
    el('quit').disabled = false;
    document.querySelector('.folder-panel').classList.add('connected');
    refreshed();
  }
  async function connectHandle(handle) {
    datasetLoading('Loading dataset', 'Reading your local image folders…');
    await nextPaint();
    try {
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
      let checked = 0;
      for (const kind of ['icons', 'thumbs']) {
        for await (const [name, entry] of directories[kind].entries()) {
          const id = byPath.get(`${kind}/${name}`);
          if (entry.kind === 'file' && id !== undefined) available.push(id);
          if (++checked % 2000 === 0) {
            datasetLoading('Loading dataset', `${checked.toLocaleString()} local files checked`);
            await nextPaint();
          }
        }
      }
      await activate(available, candidate.name, directories);
      remembered = candidate;
      await storeHandle(candidate);
    } finally {
      finishDatasetLoading();
    }
  }
  async function choose() {
    if (!window.showDirectoryPicker) return el('folder-input').click();
    try {
      const handle = await window.showDirectoryPicker({mode: 'read', id: 'roblox-dataset'});
      await connectHandle(handle);
    } catch (error) {
      if (error.name === 'SecurityError' || error.name === 'TypeError') el('folder-input').click();
      else if (error.name !== 'AbortError') folderError(error);
    }
  }
  const ready = rpc('init').then(async data => {
    catalogue = data;
    images = new Map();
    for (const game of data.games) for (const image of game.images) images.set(image.id, image);
    el('folder-status').textContent = '';
    el('quit').disabled = true;
    remembered = await storeHandle();
    if (remembered && window.showDirectoryPicker) {
      if (await remembered.queryPermission({mode: 'read'}) === 'granted') {
        try { await connectHandle(remembered); } catch (error) { folderError(error); el('reconnect-folder').hidden = false; }
      } else el('reconnect-folder').hidden = false;
    }
    return data;
  }).catch(error => { el('folder-status').textContent = error.message; throw error; }).finally(finishDatasetLoading);
  el('choose-folder').addEventListener('click', choose);
  el('reconnect-folder').addEventListener('click', async () => {
    try {
      if (await remembered.requestPermission({mode: 'read'}) !== 'granted') throw new Error('Folder access was not granted. You can choose the folder again.');
      await connectHandle(remembered);
    } catch (error) { folderError(error); }
  });
  el('folder-input').addEventListener('change', async event => {
    if (!event.target.files.length) return;
    datasetLoading('Loading dataset', 'Checking your local image files…');
    try {
      await nextPaint();
      const {matchLocalFiles} = await import('./web-core.mjs');
      const files = await matchLocalFiles(event.target.files, images, async (checked, total) => {
        datasetLoading('Loading dataset', `${checked.toLocaleString()} / ${total.toLocaleString()} files checked`, checked, total);
        await nextPaint();
      });
      await activate([...files.keys()], event.target.files[0]?.webkitRelativePath.split('/')[0] || 'Local dataset', null, files);
      remembered = null;
      await storeHandle(null);
    } catch (error) { folderError(error); }
    finally { finishDatasetLoading(); }
    event.target.value = '';
  });
  async function imageURL(id) {
    if (urls.has(id)) return urls.get(id);
    const image = images.get(id), version = connectionVersion;
    if (!connected || !image) throw new Error('Connect your dataset folder first.');
    const request = (async () => {
      const file = await imageFile(id);
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
  async function imageFile(id) {
    const image = images?.get(id), version = connectionVersion;
    if (!connected || !image) throw new Error('Connect the original dataset folder to download your saved images.');
    const file = folder ? await (await folder[image.kind].getFileHandle(image.filename)).getFile() : localFiles.get(id);
    if (!file?.size || version !== connectionVersion) throw new Error('An image is unavailable. Reconnect the complete original dataset to export this collection.');
    return file;
  }
  window.galleryHost = {
    ready,
    async chartCards(games) {
      return Promise.all(games.map(async game => {
        const saved = catalogue.games.find(item => item.name === game.name && item.status === 'ready');
        const image = saved?.images.find(item => item.kind === 'thumbs');
        if (!image) return game;
        try { return {...game, image: URL.createObjectURL(await imageFile(image.id))}; }
        catch { return game; }
      }));
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
        return {games: catalogue.games.length, images: images.size, thumbnails: [...images.values()].filter(image => image.kind === 'thumbs').length, icons: [...images.values()].filter(image => image.kind === 'icons').length, ready: catalogue.games.filter(g => g.status === 'ready').length, pending: 0, unavailable: catalogue.games.filter(g => g.status === 'unavailable').length, facets: [...facets.values()], message: 'Saved game metadata. No collection or API requests needed.', visual: {ready: images.size, total: images.size, failed: 0, message: 'The prepared scene index downloads on first visual search and is cached when browser storage is available.'}};
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
        el('choose-folder').textContent = 'Select folder';
        el('choose-folder').className = 'primary';
        document.querySelector('.folder-actions').prepend(el('choose-folder'));
        document.querySelector('.folder-panel').classList.remove('connected');
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

