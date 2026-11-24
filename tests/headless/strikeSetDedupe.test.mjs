/**
 * Entity strike-set dedupe equivalence test (issue #72).
 *
 * computeEnemyReach used to run findReachableCells twice per enemy: once
 * at maxSteps (threat set) and once at ceil(maxAP) (strike set). It now
 * runs one BFS and derives the strike set from the returned `dist`.
 * This test checks, on a real game state through the AI proxy, that the
 * derived strike set equals the old second-BFS set for every entity.
 *
 * Run from tests/headless:
 *   node --import ./preload.mjs ./strikeSetDedupe.test.mjs
 */
import { GameState } from '../../src/gameState.js';
import { loadGameManifest } from '../../src/manifestLoader.js';
import { createAiManager } from '../../src/aiInterfaceProxy.js';
import SmartManager from '../../src/ai/standard/smartManager.js';

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
gameState.generateMap(16, manifest.terrains, manifest, 777);
gameState.initializeManifest(manifest, {
  players,
  initialization: ds.initialization || {},
  winCondition: null,
  barbarians: null,
});

const MARGIN = 2; // entityCentricAi reachStepMargin default is >= 0; test a couple
let checked = 0;
for (const player of gameState.players) {
  const manager = createAiManager(SmartManager, player, gameState.aiHelper);
  const helper = manager.helper;
  const proxiedGs = manager.gameState;
  for (const entity of proxiedGs.entities) {
    const maxAP = entity.maxActionPoints ?? entity.actionPoints ?? 0;
    if (!(maxAP > 0)) continue;
    for (const margin of [0, MARGIN]) {
      const maxSteps = Math.ceil(maxAP) + margin;
      const threat = helper.findReachableCells(proxiedGs, entity, maxSteps);
      // old way
      const strikeOld = new Set(helper.findReachableCells(proxiedGs, entity, Math.ceil(maxAP)).keys());
      // new way
      const strikeNew = new Set();
      for (const [key, entry] of threat) {
        assert(typeof entry.dist === 'number', `entry for ${key} missing dist`);
        if (entry.dist <= Math.ceil(maxAP)) strikeNew.add(key);
      }
      const same = strikeOld.size === strikeNew.size && [...strikeOld].every(k => strikeNew.has(k));
      assert(same, `strike set mismatch for entity ${entity.id} (margin ${margin}): old=${strikeOld.size} new=${strikeNew.size}`);
      // strike must be a subset of threat
      assert([...strikeNew].every(k => threat.has(k)), `strike not subset of threat for entity ${entity.id}`);
      checked++;
    }
  }
}
assert(checked > 0, 'no entities checked');
console.log(failures === 0 ? `strikeSetDedupe: PASS (${checked} entity/margin combos)` : `strikeSetDedupe: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
