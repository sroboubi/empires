/**
 * Regression tests for the two daily-review findings (2026-11-23):
 * 1. resolveController must throw on an unknown object-form controller key
 *    (tested indirectly: this file only covers the _diskCells half; the
 *    controller half is exercised by running headless with a typo config).
 * 2. AiHelper._diskCells / findBuildCandidates must terminate when
 *    maxDistance is Infinity (unbounded radius = whole map).
 *
 * Run from tests/headless:
 *   node --import ./preload.mjs ./reviewFindings.test.mjs
 */
import { GameState } from '../../src/gameState.js';
import { loadGameManifest } from '../../src/manifestLoader.js';

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
gameState.generateMap(12, manifest.terrains, manifest, 99);
gameState.initializeManifest(manifest, {
  players,
  initialization: ds.initialization || {},
  winCondition: null,
  barbarians: null,
});

const helper = gameState.aiHelper;
const player = gameState.players[0];
const builder = player.getEntities().find(e => (e.buildables || []).length > 0) || player.getEntities()[0];
assert(builder, 'no builder entity found');

// The hang: maxDistance = Infinity must return promptly.
const t0 = Date.now();
const disk = helper._diskCells(gameState.hexGrid, builder, Infinity);
const elapsed = Date.now() - t0;
assert(Array.isArray(disk) && disk.length > 0, 'Infinity disk returned nothing');
assert(elapsed < 5000, `Infinity disk took ${elapsed}ms (hang regression)`);
assert(disk.length === gameState.hexGrid.getCellsArray().length,
  `Infinity disk size ${disk.length} != map size ${gameState.hexGrid.getCellsArray().length}`);

// Finite radius still bounded and a subset of the full map.
const finite = helper._diskCells(gameState.hexGrid, builder, 2);
assert(finite.length > 0 && finite.length <= disk.length, 'finite disk not a bounded subset');

// findBuildCandidates with Infinity terminates and returns candidates.
const t1 = Date.now();
const { candidates } = helper.findBuildCandidates(gameState, builder, 'farm', Infinity);
assert(Date.now() - t1 < 5000, 'findBuildCandidates(Infinity) too slow');
assert(Array.isArray(candidates), 'findBuildCandidates(Infinity) did not return an array');

console.log(failures === 0 ? 'reviewFindings: PASS' : `reviewFindings: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
