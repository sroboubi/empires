/**
 * SaveManager — IndexedDB-based save/load for Empires game state.
 * 
 * Save record structure:
 * {
 *   name: string,         // Primary key
 *   timestamp: number,    // Date.now()
 *   turnNumber: number,
 *   auto: boolean,        // true = auto-save, false = manual
 *   data: string          // gameState.serialize() JSON payload
 * }
 */

const DB_NAME = 'EmpiresDB';
const DB_VERSION = 1;
const STORE_NAME = 'saves';

/**
 * Opens (or creates/upgrades) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'name' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('auto', 'auto', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Saves a game record to IndexedDB (put = insert or overwrite).
 * @param {{ name: string, turnNumber: number, auto: boolean, data: string }} record
 * @returns {Promise<void>}
 */
export async function saveGame(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({
      name: record.name,
      timestamp: Date.now(),
      turnNumber: record.turnNumber,
      auto: record.auto,
      data: record.data
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Loads a specific save by name.
 * @param {string} name
 * @returns {Promise<Object|null>}
 */
export async function loadGame(name) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(name);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Lists all saves sorted by timestamp descending (newest first).
 * @returns {Promise<Array>}
 */
export async function listSaves() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      const saves = request.result || [];
      saves.sort((a, b) => b.timestamp - a.timestamp);
      resolve(saves);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Deletes a specific save by name.
 * @param {string} name
 * @returns {Promise<void>}
 */
export async function deleteSave(name) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Prunes auto-saves to keep only the N most recent, deleting the rest.
 * Manual saves (auto === false) are never touched.
 * @param {number} maxCount - Maximum number of auto-saves to keep
 * @returns {Promise<void>}
 */
export async function pruneAutoSaves(maxCount) {
  const all = await listSaves();
  const autoSaves = all
    .filter(s => s.auto === true)
    .sort((a, b) => b.timestamp - a.timestamp);

  if (autoSaves.length <= maxCount) return;

  const toDelete = autoSaves.slice(maxCount);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const save of toDelete) {
      store.delete(save.name);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
