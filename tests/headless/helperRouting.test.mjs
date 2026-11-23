/**
 * Helper-routing equivalence test for the AI proxy.
 *
 * Run from tests/headless:
 *   node --import ./preload.mjs ./helperRouting.test.mjs
 *
 * `helper.getCellsArray()` / `helper.getNeighbors()` are routed through the
 * gameState.hexGrid proxy so there is one masking/caching implementation.
 * This test checks the routed results against the raw grid with the same
 * fog rules, and verifies that sorting/reversing the returned array cannot
 * mutate the cached view.
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

function rawCellMap(gameState) {
  return new Map(
    Array.from(gameState.hexGrid.cells.entries()).map(([key, cell]) => [key, cell])
  );
}

function checkMaskedCell(cell, rawCell, player, label) {
  assert(cell && typeof cell.q === 'number' && typeof cell.r === 'number', `${label}: missing coordinates`);
  const explored = player.isExplored(cell.q, cell.r);
  if (explored) {
    assert(cell.terrain?.name === rawCell.terrain?.name, `${label}: explored terrain mismatch at ${cell.q},${cell.r}`);
    assert(!!cell.resource === !!rawCell.resource, `${label}: explored resource presence mismatch at ${cell.q},${cell.r}`);
  } else {
    assert(cell.terrain === undefined, `${label}: unexplored terrain leaked at ${cell.q},${cell.r}`);
    assert(cell.resource === undefined, `${label}: unexplored resource leaked at ${cell.q},${cell.r}`);
  }
}

const manifest = await loadGameManifest();
const ds = manifest.defaultSettings || {};
const players = [
  { id: 1, name: 'Blue', color: '#00f', controller: { url: './ai/standard/smartManager.js' } },
  { id: 2, name: 'Red', color: '#f00', controller: { url: './ai/standard/smartManager.js' } },
];
const gameState = new GameState();
gameState.generateMap(8, manifest.terrains, manifest, 4242);
gameState.initializeManifest(manifest, {
  players,
  initialization: ds.initialization || {},
  winCondition: null,
  barbarians: null,
});
const player = gameState.players[0];
const manager = createAiManager(SmartManager, player, gameState.aiHelper);
const helper = manager.helper;
const raw = rawCellMap(gameState);

const cells = helper.getCellsArray();
assert(cells.length === raw.size, `getCellsArray length ${cells.length} != raw ${raw.size}`);
for (let i = 0; i < cells.length; i++) {
  const cell = cells[i];
  const rawCell = raw.get(`${cell.q},${cell.r}`);
  assert(rawCell, `getCellsArray returned unknown cell ${cell.q},${cell.r}`);
  if (rawCell) checkMaskedCell(cell, rawCell, player, 'getCellsArray');
}

for (const key of ['0,0', `${player.startCoord.q},${player.startCoord.r}`]) {
  const [q, r] = key.split(',').map(Number);
  const adjacent = helper.getNeighbors(q, r);
  const rawAdjacent = gameState.hexGrid.getNeighbors(q, r);
  assert(adjacent.length === rawAdjacent.length, `getNeighbors(${key}) length ${adjacent.length} != ${rawAdjacent.length}`);
  for (const cell of adjacent) {
    const rawCell = raw.get(`${cell.q},${cell.r}`);
    assert(rawCell, `getNeighbors(${key}) returned unknown cell ${cell.q},${cell.r}`);
    if (rawCell) checkMaskedCell(cell, rawCell, player, `getNeighbors(${key})`);
  }
}

// The cached arrays are proxies: mutating array methods must operate on a
// copy and leave the cached order intact.
const before = helper.getCellsArray().map(cell => `${cell.q},${cell.r}`).join('|');
helper.getCellsArray().sort((a, b) => b.q - a.q || b.r - a.r);
const after = helper.getCellsArray().map(cell => `${cell.q},${cell.r}`).join('|');
assert(before === after, 'sort() mutated the cached getCellsArray() result');

// Entity-view cache invalidation: a real engine action (the human path) must
// bump the game-state version and the next proxy read must see the new
// position, not the cached array.
const unit = player.getEntities().find(e => e.getActions().some(a => a.name === 'Move'));
if (unit) {
  const cachedBefore = manager.gameState.entities.find(e => e.id === unit.id);
  assert(cachedBefore, 'entity view did not see an owned entity');
  const move = unit.getActions().find(a => a.name === 'Move');
  const destination = gameState.hexGrid.getNeighbors(unit.q, unit.r)
    .find(cell => move.canDo(cell, null).possible && !gameState.getEntityAt(cell.q, cell.r));
  if (destination) {
    const versionBefore = gameState.stateVersion;
    const moved = move.do(destination, null);
    assert(moved, 'move action failed during cache invalidation test');
    assert(gameState.stateVersion > versionBefore, 'entity action did not bump stateVersion');
    const cachedAfter = manager.gameState.entities.find(e => e.id === unit.id);
    assert(cachedAfter, 'entity view lost the entity after moving');
    assert(cachedAfter.q === destination.q && cachedAfter.r === destination.r,
      'entity view cache was stale after an action');
  }
}

if (failures === 0) {
  console.log('Helper routing equivalence: PASS');
} else {
  console.error(`Helper routing equivalence: ${failures} failure(s)`);
  process.exit(1);
}
