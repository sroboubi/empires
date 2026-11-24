/**
 * Regression test: OpusAI must not depend on `forbidden` being initialised by
 * a previous refresh.
 *
 * refresh() runs computeThreats() BEFORE computeForbidden():
 *   computeThreats -> assetValue -> planFor -> hasAnySite -> siteOk
 * and siteOk reads `this.forbidden`. On a fresh instance the set did not exist
 * yet, so the first refresh threw
 *   TypeError: Cannot read properties of undefined (reading 'has')
 * and because the throw aborted refresh before computeForbidden() ran, that AI
 * stayed broken every following turn.
 *
 * The state below mirrors refresh() just before computeThreats(): `occ` is
 * populated, `forbidden` has not been computed yet.
 *
 * Run from tests/headless:
 *   node --import ./preload.mjs ./opusForbiddenInit.test.mjs
 */
import { GameState } from '../../src/gameState.js';
import { loadGameManifest } from '../../src/manifestLoader.js';
import OpusAI from '../../src/ai/tactical/opusAi.js';

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

const manifest = await loadGameManifest();
const ds = manifest.defaultSettings || {};
const players = [
  { id: 1, name: 'Blue', color: '#00f', controller: { url: './ai/standard/smartManager.js' } },
  { id: 2, name: 'Red', color: '#f00', controller: { url: './ai/standard/smartManager.js' } },
];
const gameState = new GameState();
gameState.generateMap(12, manifest.terrains, manifest, 4242);
gameState.initializeManifest(manifest, {
  players,
  initialization: ds.initialization || {},
  winCondition: null,
  barbarians: null,
});

const ai = new OpusAI(gameState.players[0], gameState.aiHelper);

// Invariant: a constructed AI can be asked about sites before its first
// refresh has finished.
assert(ai.forbidden instanceof Set, 'constructor did not initialise forbidden');

// Mirror the real preconditions of the failing call: processTurn() loads the
// static defs, and refresh() populates mine/foreign/occ/cells before it runs
// computeThreats(). `forbidden` is the one field that is still unset there.
ai.loadStatic();
ai.mine = [];
ai.foreign = [];
ai.occ = new Map();
// refresh() also resets these caches immediately before computeThreats().
ai.valueCache = new Map();
ai.blockedCache = new Map();
ai.planCache = new Map();
for (const [key, c] of gameState.hexGrid.cells) {
  ai.cells.set(key, {
    q: c.q,
    r: c.r,
    t: c.terrain?.name,
    mc: c.terrain?.movementCost,
    h: 0,
    res: c.resource || null,
  });
}
assert(ai.cells.size > 0, 'no explored cells seeded');

let threw = null;
let ok = null;
try {
  ok = ai.siteOk('swordsman', '0,0');
} catch (error) {
  threw = error;
}
assert(!threw, `siteOk threw before computeForbidden: ${threw?.message}`);
assert(typeof ok === 'boolean', `siteOk returned ${typeof ok}, expected boolean`);

// Find a (type, cell) the AI accepts, so the forbidden check is meaningful
// rather than short-circuited by terrain or min-separation.
let accepted = null;
const types = Object.keys(manifest.entities || {});
const cellsToTry = [...gameState.hexGrid.cells.keys()].slice(0, 80);
outer:
for (const k of cellsToTry) {
  const c = gameState.hexGrid.getCell(Number(k.split(',')[0]), Number(k.split(',')[1]));
  if (!c) continue;
  for (const type of types) {
    if (!manifest.entities[type]?.spawnConditions) continue;
    if (ai.siteOk(type, k) === true) { accepted = { type, key: k }; break outer; }
  }
}
assert(accepted, 'no free build cell found — test setup invalid');

// An empty forbidden set must mean "nothing forbidden".
if (accepted) {
  const before = ai.siteOk(accepted.type, accepted.key);
  ai.forbidden.add(accepted.key);
  const after = ai.siteOk(accepted.type, accepted.key);
  assert(before === true && after === false, 'forbidden set did not reject a previously accepted cell');
}

console.log(failures === 0 ? 'opusForbiddenInit: PASS' : `opusForbiddenInit: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
