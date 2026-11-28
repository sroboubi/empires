/**
 * Browser API stubs for headless Node.js testing.
 * Import this BEFORE any game modules.
 */

// --- window / document / navigator ---
globalThis.window = globalThis;
globalThis.location = { search: '', href: 'http://localhost/', pathname: '/' };
globalThis.document = {
  createElement: () => ({
    style: {},
    addEventListener: () => {},
    removeEventListener: () => {},
    getContext: () => null,
    appendChild: () => {},
  }),
  getElementById: () => null,
  querySelector: () => null,
  body: { appendChild: () => {} },
};
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'node-headless' },
  configurable: true,
});

// --- requestAnimationFrame (manual control) ---
let rafCallbacks = [];
globalThis.requestAnimationFrame = (cb) => {
  rafCallbacks.push(cb);
  return rafCallbacks.length;
};
globalThis.cancelAnimationFrame = (id) => {
  rafCallbacks.splice(id - 1, 1);
};
// Test helper: advance one frame
globalThis.__stepFrame = (t = performance.now()) => {
  const cbs = [...rafCallbacks];
  rafCallbacks = [];
  cbs.forEach(cb => cb(t));
};

// --- AudioContext ---
globalThis.AudioContext = class {
  constructor() {}
  createBuffer() { return {}; }
  createBufferSource() { return { connect: () => {}, start: () => {} }; }
  get destination() { return {}; }
  resume() { return Promise.resolve(); }
};
globalThis.webkitAudioContext = globalThis.AudioContext;

// --- fetch: serve local files from disk ---
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Test-only definitions overlay. The tournament resolves `definitionsDir`
// relative to the suite file, validates it, and passes it here. A variant
// directory contains full replacement files (entities.json, terrains.json,
// ...); files it does not contain fall back to the repo copies.
const DEFINITIONS_DIR = process.env.HEADLESS_DEFINITIONS_DIR
  ? path.resolve(process.env.HEADLESS_DEFINITIONS_DIR)
  : null;

const origFetch = globalThis.fetch;
globalThis.fetch = async (url, ...args) => {
  const urlStr = url.toString();
  // Serve local definition files and assets from disk
  if (urlStr.startsWith('./') || urlStr.startsWith('../') || urlStr.includes('definitions/')) {
    const relative = urlStr.replace(/^\.\//, '');
    const candidates = [];
    if (DEFINITIONS_DIR && relative.includes('definitions/')) {
      candidates.push(path.join(DEFINITIONS_DIR, path.basename(relative)));
    }
    candidates.push(path.resolve(REPO_ROOT, relative));
    for (const localPath of candidates) {
      try {
        const data = await readFile(localPath, 'utf-8');
        return {
          ok: true,
          json: async () => JSON.parse(data),
          text: async () => data,
        };
      } catch (e) {
        // Try the next candidate, then fall through to original fetch
      }
    }
  }
  if (origFetch) return origFetch(url, ...args);
  throw new Error(`fetch not available for ${urlStr}`);
};

// --- IndexedDB (in-memory stub) ---
const idbStore = new Map();
globalThis.indexedDB = {
  open: () => {
    const req = {
      onsuccess: null, onerror: null, onupgradeneeded: null,
      result: {
        transaction: () => ({
          objectStore: () => ({
            get: (k) => ({ result: idbStore.get(k), onsuccess: null }),
            put: (v, k) => { idbStore.set(k, v); },
          }),
        }),
      },
    };
    setTimeout(() => req.onsuccess && req.onsuccess({ target: req }), 0);
    return req;
  },
};

// --- localStorage ---
const lsStore = new Map();
globalThis.localStorage = {
  getItem: (k) => lsStore.get(k) ?? null,
  setItem: (k, v) => lsStore.set(k, v),
  removeItem: (k) => lsStore.delete(k),
};

console.log('[stubs] Browser APIs stubbed for headless testing');
