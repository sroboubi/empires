/**
 * Focused test for the test-only definitions overlay used by the suite runner.
 *
 * Runs a child with HEADLESS_DEFINITIONS_DIR pointing at a temp variant that
 * contains a patched entities.json. Asserts:
 *  - a file present in the overlay is served from the overlay;
 *  - a file absent from the overlay falls back to the repo copy.
 *
 * Run with: node --import ./preload.mjs ./definitionsOverride.test.mjs
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  \u2713 ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'definitions-override-'));
try {
  const entitiesPath = path.join(REPO_ROOT, 'definitions', 'entities.json');
  const terrainsPath = path.join(REPO_ROOT, 'definitions', 'terrains.json');
  const entities = JSON.parse(readFileSync(entitiesPath, 'utf-8'));
  const terrains = JSON.parse(readFileSync(terrainsPath, 'utf-8'));

  const patched = structuredClone(entities);
  const first = Array.isArray(patched) ? patched[0] : Object.values(patched)[0];
  first.spawnCost = { ...(first.spawnCost || {}), food: 12345 };
  writeFileSync(path.join(tmp, 'entities.json'), JSON.stringify(patched));

  const script = `
    const entities = await (await fetch('./definitions/entities.json')).json();
    const terrains = await (await fetch('./definitions/terrains.json')).json();
    const first = Array.isArray(entities) ? entities[0] : Object.values(entities)[0];
    console.log(JSON.stringify({ foodCost: (first.spawnCost || {}).food, terrains: Array.isArray(terrains) ? terrains.length : -1 }));
  `;
  const out = execFileSync(process.execPath, [
    '--import', './preload.mjs',
    '--input-type=module',
    '-e', script,
  ], {
    cwd: __dirname,
    env: { ...process.env, HEADLESS_DEFINITIONS_DIR: tmp },
    encoding: 'utf-8',
  });
  const result = JSON.parse(out.trim().split('\n').pop());
  assert(result.foodCost === 12345, 'overlay entities.json is served from definitionsDir');
  assert(result.terrains === (Array.isArray(terrains) ? terrains.length : -1),
    'terrains.json absent from the overlay falls back to the repo copy');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failed > 0) process.exit(1);
console.log('definitionsOverride.test.js: all checks passed');
