'use strict';
window.galleryCollections = (() => {
  const storageKey = 'thumbnail-explorer-collections-v1';
  function createStore(storage) {
    let data;
    function read() {
      const raw = storage.getItem(storageKey);
      const value = raw === null ? {version: 1, favorites: [], collections: []} : JSON.parse(raw);
      const ids = list => Array.isArray(list) && list.every(id => Number.isSafeInteger(id) && id > 0) && new Set(list).size === list.length;
      if (value?.version !== 1 || !ids(value.favorites) || !Array.isArray(value.collections) ||
          value.collections.some(c => !c || typeof c.id !== 'string' || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 80 || !ids(c.images)) ||
          new Set(value.collections.map(c => c.id)).size !== value.collections.length) throw new Error('Saved collections could not be read. Existing browser data has been left unchanged.');
      data = value;
    }
    read();
    function edit(change) {
      read();
      const next = structuredClone(data);
      change(next);
      try { storage.setItem(storageKey, JSON.stringify(next)); }
      catch (_) { throw new Error('Could not save. Browser storage is unavailable or full.'); }
      data = next;
    }
    function name(value) {
      value = value.trim();
      if (!value || value.length > 80) throw new Error('Use a collection name between 1 and 80 characters.');
      return value;
    }
    function collection(value, id) {
      const result = value.collections.find(c => c.id === id);
      if (!result) throw new Error('This collection no longer exists.');
      return result;
    }
    function toggle(list, id, included) {
      if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid image.');
      return included ? [...new Set([...list, id])] : list.filter(value => value !== id);
    }
    return {
      get data() { return structuredClone(data); },
      refresh: read,
      favorite(id) { edit(value => { value.favorites = toggle(value.favorites, id, !value.favorites.includes(id)); }); },
      create(label, image = null) {
        const id = crypto.randomUUID();
        edit(value => { value.collections.push({id, name: name(label), images: image === null ? [] : toggle([], image, true)}); });
        return id;
      },
      rename(id, label) { edit(value => { collection(value, id).name = name(label); }); },
      remove(id) { edit(value => { collection(value, id); value.collections = value.collections.filter(c => c.id !== id); }); },
      include(id, image, included) { edit(value => { const c = collection(value, id); c.images = toggle(c.images, image, included); }); }
    };
  }

  const crcTable = Uint32Array.from({length: 256}, (_, n) => {
    for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
    return n >>> 0;
  });
  async function checksum(file, signal) {
    let crc = 0xffffffff;
    for await (const block of file.stream()) {
      signal?.throwIfAborted();
      for (const byte of block) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  async function writeZip(entries, writer, onProgress = () => {}, signal) {
    // shortcut: ZIP32 only; split collections above 65,535 files or 4 GiB before exporting.
    const encoder = new TextEncoder();
    let estimate = 22;
    const prepared = entries.map(entry => {
      if (!entry.name || /[\\\x00]/.test(entry.name) || entry.name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid ZIP filename.');
      const name = encoder.encode(entry.name);
      if (name.length > 65535) throw new Error('ZIP filename is too long.');
      estimate += entry.file.size + 76 + 2 * name.length;
      return {...entry, name};
    });
    if (prepared.length > 65535 || estimate >= 0xffffffff) throw new Error('This collection is too large for one ZIP. Split it into collections below 4 GB and 65,535 images.');
    const directory = [];
    let offset = 0;
    async function write(bytes) { signal?.throwIfAborted(); await writer.write(bytes); offset += bytes.byteLength; }
    for (let i = 0; i < prepared.length; i++) {
      const {name, file} = prepared[i];
      signal?.throwIfAborted();
      onProgress(i, prepared.length);
      const crc = await checksum(file, signal), start = offset;
      const header = new Uint8Array(30 + name.length), h = new DataView(header.buffer);
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true);
      h.setUint16(12, 33, true); h.setUint32(14, crc, true); h.setUint32(18, file.size, true); h.setUint32(22, file.size, true); h.setUint16(26, name.length, true);
      header.set(name, 30);
      await write(header);
      for await (const block of file.stream()) await write(block);
      const central = new Uint8Array(46 + name.length), c = new DataView(central.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true);
      c.setUint16(14, 33, true); c.setUint32(16, crc, true); c.setUint32(20, file.size, true); c.setUint32(24, file.size, true); c.setUint16(28, name.length, true); c.setUint32(42, start, true);
      central.set(name, 46); directory.push(central);
    }
    const centralOffset = offset;
    for (const bytes of directory) await write(bytes);
    const end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true);
    e.setUint32(12, offset - centralOffset, true); e.setUint32(16, centralOffset, true);
    await write(end);
    onProgress(entries.length, entries.length);
  }

  function initialize({getFile, getImage}) {
    const el = id => document.getElementById(id);
    let store, view = '', pickerImage = null, editing = null, exportController;
    const report = error => {
      const target = el('collection-picker').open ? el('collection-picker-error') : el('delete-collection-dialog').open ? el('delete-collection-error') : el('viewer').open ? el('viewer-error') : el('saved-error');
      target.textContent = error.message; target.hidden = false;
    };
    try { store = createStore(localStorage); }
    catch (error) { report(error); return null; }
    const data = () => store.data;
    const active = () => view === 'favorites' ? {name: 'Favorites', images: data().favorites} : data().collections.find(c => c.id === view);
    function changed() {
      const previous = view;
      refresh();
      window.dispatchEvent(new Event(previous !== view ? 'gallery:saved-view' : 'gallery:saved'));
    }
    function attempt(action) {
      try { action(); el('saved-error').hidden = el('collection-picker-error').hidden = true; changed(); }
      catch (error) { report(error); }
    }
    function favoriteButton(id, currentImage) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'save-favorite'; button.dataset.favoriteId = id;
      button.addEventListener('click', () => attempt(() => store.favorite(currentImage ? currentImage() : Number(button.dataset.favoriteId))));
      updateFavorite(button, id);
      return button;
    }
    function updateFavorite(button, id) {
      const selected = data().favorites.includes(id);
      button.textContent = selected ? '♥' : '♡';
      button.setAttribute('aria-label', selected ? 'Remove image from favorites' : 'Favorite image');
      button.setAttribute('aria-pressed', String(selected));
    }
    function refreshPicker() {
      const collections = data().collections, list = el('collection-list');
      for (const label of [...list.children]) if (!collections.some(c => c.id === label.dataset.collectionId)) label.remove();
      for (const collection of collections) {
        let label = [...list.children].find(item => item.dataset.collectionId === collection.id);
        if (!label) {
          label = document.createElement('label'); label.dataset.collectionId = collection.id;
          const check = document.createElement('input'); check.type = 'checkbox';
          check.addEventListener('change', () => attempt(() => store.include(collection.id, pickerImage, check.checked)));
          label.append(check, document.createElement('span')); list.append(label);
        }
        const [check, text] = label.children;
        check.setAttribute('aria-label', collection.name);
        check.checked = collection.images.includes(pickerImage);
        text.textContent = `${collection.name} (${collection.images.length})`;
      }
      el('collection-list').hidden = pickerImage === null || editing !== null;
    }
    function refresh() {
      if (view && !active()) view = '';
      el('saved-view').replaceChildren(new Option('Explore all', ''), new Option(`Favorites (${data().favorites.length})`, 'favorites'), ...data().collections.map(c => new Option(`${c.name} (${c.images.length})`, c.id)));
      el('saved-view').value = view;
      el('saved-actions').hidden = !view;
      el('rename-collection').hidden = el('delete-collection').hidden = view === 'favorites';
      el('download-collection').disabled = !active()?.images.length || !!exportController;
      for (const button of document.querySelectorAll('[data-favorite-id]')) updateFavorite(button, Number(button.dataset.favoriteId));
      refreshPicker();
    }
    function openPicker(image = null, rename = null) {
      pickerImage = image; editing = rename;
      el('collection-picker-title').textContent = rename ? 'Rename collection' : image === null ? 'New collection' : 'Save image to collections';
      el('collection-name').value = rename ? active().name : '';
      el('create-collection').textContent = rename ? 'Save name' : 'Create collection';
      el('saved-error').hidden = el('collection-picker-error').hidden = true;
      refreshPicker();
      el('collection-picker').showModal();
      el('collection-name').focus();
    }
    el('saved-view').addEventListener('change', () => { view = el('saved-view').value; refresh(); window.dispatchEvent(new Event('gallery:saved-view')); });
    el('new-collection').addEventListener('click', () => openPicker());
    el('rename-collection').addEventListener('click', () => openPicker(null, view));
    el('delete-collection').addEventListener('click', () => {
      el('delete-collection-name').textContent = active().name;
      el('delete-collection-dialog').showModal();
    });
    el('confirm-delete-collection').addEventListener('click', () => attempt(() => {
      store.remove(view); view = ''; el('delete-collection-dialog').close(); window.dispatchEvent(new Event('gallery:saved-view'));
    }));
    for (const button of document.querySelectorAll('[data-close-collection-dialog]')) button.addEventListener('click', () => el(button.dataset.closeCollectionDialog).close());
    el('collection-form').addEventListener('submit', event => {
      event.preventDefault();
      attempt(() => {
        if (editing) store.rename(editing, el('collection-name').value);
        else {
          const id = store.create(el('collection-name').value, pickerImage);
          if (pickerImage === null) { view = id; window.dispatchEvent(new Event('gallery:saved-view')); }
        }
        el('collection-name').value = '';
        if (pickerImage === null) el('collection-picker').close();
      });
    });
    window.addEventListener('storage', event => {
      if (event.key !== storageKey && event.key !== null) return;
      try { store.refresh(); changed(); } catch (error) { report(error); }
    });
    el('download-collection').addEventListener('click', async () => {
      const collection = active();
      if (!collection?.images.length || exportController) return;
      const filename = (collection.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'Collection') + '.zip';
      let writer;
      exportController = new AbortController();
      const signal = exportController.signal;
      el('zip-progress').hidden = false; el('cancel-zip').hidden = false; refresh();
      const progress = (checked, total) => { el('zip-message').textContent = `Preparing ZIP · ${checked.toLocaleString()} / ${total.toLocaleString()} images`; };
      el('saved-error').hidden = true;
      progress(0, collection.images.length);
      try {
        if (window.showSaveFilePicker) {
          try {
            const handle = await window.showSaveFilePicker({suggestedName: filename, types: [{description: 'ZIP archive', accept: {'application/zip': ['.zip']}}]});
            writer = await handle.createWritable();
          } catch (error) { if (!['SecurityError', 'TypeError'].includes(error.name)) throw error; }
        }
        const entries = [];
        let bytes = 0;
        for (const id of collection.images) {
          signal.throwIfAborted();
          const image = getImage(id);
          if (!image) throw new Error('An image is missing from this catalogue. Reconnect the complete original dataset to export this collection.');
          const file = await getFile(id);
          bytes += file.size;
          // shortcut: bound memory for browsers without a streaming file picker.
          if (!writer && bytes > 512 * 1024 * 1024) throw new Error('For ZIPs over 512 MB, use desktop Chrome or Edge with the file-save picker, or split this collection.');
          entries.push({name: `${image.kind}/${image.filename}`, file});
          progress(entries.length, collection.images.length);
        }
        const chunks = [];
        await writeZip(entries, writer || {write: bytes => chunks.push(bytes)}, progress, signal);
        if (writer) await writer.close();
        else {
          const url = URL.createObjectURL(new Blob(chunks, {type: 'application/zip'})), link = document.createElement('a');
          link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        }
        el('zip-message').textContent = 'ZIP ready.';
      } catch (error) {
        try { await writer?.abort(); } catch (_) { /* The picker may already have closed. */ }
        if (error.name !== 'AbortError') report(error);
        el('zip-message').textContent = error.name === 'AbortError' ? 'Download cancelled.' : 'ZIP could not be created.';
      } finally { exportController = null; el('cancel-zip').hidden = true; refresh(); }
    });
    el('cancel-zip').addEventListener('click', () => exportController?.abort());
    const viewerFavorite = favoriteButton(1);
    el('viewer-saved-actions').append(viewerFavorite);
    const viewerCollect = document.createElement('button');
    viewerCollect.type = 'button'; viewerCollect.className = 'secondary'; viewerCollect.textContent = 'Add to collection';
    viewerCollect.addEventListener('click', () => openPicker(Number(viewerFavorite.dataset.favoriteId)));
    el('viewer-saved-actions').append(viewerCollect);
    el('saved-navigation').hidden = el('viewer-saved-actions').hidden = false;
    refresh();
    return {
      get active() { return !!view; },
      get ids() { return active()?.images || []; },
      get title() { return active()?.name; },
      reset() { view = ''; refresh(); },
      showImage(id) { viewerFavorite.dataset.favoriteId = id; updateFavorite(viewerFavorite, id); },
      card(button, game, currentImage) {
        const wrapper = document.createElement('article'); wrapper.className = 'card-shell';
        const actions = document.createElement('div'); actions.className = 'card-save-actions';
        const favorite = favoriteButton(game.image_id, currentImage), collect = document.createElement('button');
        collect.type = 'button'; collect.textContent = '+'; collect.setAttribute('aria-label', 'Add image to collection');
        collect.addEventListener('click', () => openPicker(currentImage()));
        favorite.addEventListener('pointerenter', () => { favorite.dataset.favoriteId = currentImage(); updateFavorite(favorite, currentImage()); });
        favorite.addEventListener('focus', () => { favorite.dataset.favoriteId = currentImage(); updateFavorite(favorite, currentImage()); });
        actions.append(favorite, collect); wrapper.append(button, actions); return wrapper;
      }
    };
  }
  return {createStore, writeZip, initialize, storageKey};
})();
