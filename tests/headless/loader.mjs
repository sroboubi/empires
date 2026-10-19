/**
 * Node.js module loader that stubs out browser-heavy modules.
 * Usage: node --import ./tests/stubs.mjs --loader ./tests/loader.mjs ./tests/headless.mjs
 */
import { pathToFileURL, fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Pre-generated stubs
const RENDERER_STUB = readFileSync(path.join(__dirname, 'renderer-stub.mjs'), 'utf-8');
const AUDIO_STUB = `
const noop = () => {};
const noopAsync = () => Promise.resolve();
export const audio = {
  play: noop, stop: noop, init: noopAsync,
  playEntitySfx: noop, playUi: noop, setManifest: noop,
  toggleMute: noop, muted: false, sfx: {},
};
export default audio;
`;
const MAIN_STUB = `
export async function nextTurn() {}
export function updatePlayersUI() {}
export default {};
`;

export async function resolve(specifier, context, nextResolve) {
  const baseName = path.basename(specifier);
  if (baseName === 'renderer.js' || baseName === 'audio.js' || baseName === 'main.js') {
    return { url: `stub:${baseName}`, shortCircuit: true };
  }
  // Bare imports (three, ajv, simplex-noise) from src/ files: resolve against
  // tests/headless/node_modules directly, since Node only looks upward from src/
  // and never sideways into tests/.
  if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:') && !specifier.startsWith('https:')) {
    const pkgPath = path.join(__dirname, 'node_modules', specifier, 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const entry = pkg.exports?.['.']?.import || pkg.module || pkg.main;
      if (entry) {
        return { url: pathToFileURL(path.join(__dirname, 'node_modules', specifier, entry)).href, shortCircuit: true };
      }
    } catch {
      // fall through
    }
  }
  // Redirect esm.sh CDN imports to local node_modules
  if (specifier.startsWith('https://esm.sh/simplex-noise')) {
    return resolve('simplex-noise', context, nextResolve);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === 'stub:renderer.js') {
    return { format: 'module', source: RENDERER_STUB, shortCircuit: true };
  }
  if (url === 'stub:audio.js') {
    return { format: 'module', source: AUDIO_STUB, shortCircuit: true };
  }
  if (url === 'stub:main.js') {
    return { format: 'module', source: MAIN_STUB, shortCircuit: true };
  }
  return nextLoad(url, context);
}
