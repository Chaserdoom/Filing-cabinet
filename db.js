// Tiny IndexedDB wrapper. Everything lives in one "items" store:
//   drawer  { id, kind:'drawer', name, color, order }
//   folder  { id, kind:'folder', parentId, name, color }
//   doc     { id, kind:'doc', parentId, name, mime, size, blob, tags, note, text? }
const DB = (() => {
  const NAME = 'filing-cabinet';
  const STORE = 'items';
  let dbPromise;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(NAME, 1);
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('parentId', 'parentId');
          store.createIndex('kind', 'kind');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      Promise.resolve(fn(store)).then(r => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const wrap = req => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return {
    get: id => tx('readonly', s => wrap(s.get(id))),
    all: () => tx('readonly', s => wrap(s.getAll())),
    byKind: kind => tx('readonly', s => wrap(s.index('kind').getAll(kind))),
    children: parentId => tx('readonly', s => wrap(s.index('parentId').getAll(parentId))),
    put: item => tx('readwrite', s => { s.put({ ...item, updatedAt: Date.now() }); }),
    putMany: items => tx('readwrite', s => { items.forEach(i => s.put(i)); }),
    remove: ids => tx('readwrite', s => { [].concat(ids).forEach(id => s.delete(id)); }),
    clear: () => tx('readwrite', s => { s.clear(); }),
  };
})();
