/**
 * Regression test: AiHelper.countUnexploredByDirection must agree with a naive
 * per-cell directionTo loop (issue #72, round 3).
 *
 * The bulk scan replaced ~49k proxied directionTo() calls per explorer per turn
 * on a 128 map. It is a pure optimisation, so the histogram has to stay exactly
 * what the naive loop produced. This guards both the engine-side scan and the
 * allocation-light HexGrid.directionName it uses.
 *
 * Run from tests/headless:
 *   node --import ./preload.mjs ./directionHistogram.test.mjs
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
gameState.generateMap(32, manifest.terrains, manifest, 2026);
gameState.initializeManifest(manifest, {
  players,
  initialization: ds.initialization || {},
  winCondition: null,
  barbarians: null,
});
const helper = gameState.aiHelper;

// Naive reference: exactly what AdaptiveManager used to do.
function naiveCounts(player, startCell) {
  const counts = { E: 0, NE: 0, NW: 0, W: 0, SW: 0, SE: 0 };
  for (const cell of helper.getCellsArray()) {
    if (!cell || player.isExplored(cell.q, cell.r)) continue;
    const direction = helper.directionTo(startCell, cell, false).fromSource;
    if (direction in counts) counts[direction] += 1;
  }
  return counts;
}

// Also check the raw-grid scan sees the same cell set as getCellsArray().
const gridCells = helper.getCellsArray();
assert(gridCells.length === gameState.hexGrid.cells.size,
  `getCellsArray ${gridCells.length} != grid cells ${gameState.hexGrid.cells.size}`);

let compared = 0;
for (const player of gameState.players) {
  const starts = player.getEntities()
    .filter(e => e.getActions && e.getActions().some(a => a.name === 'Move'))
    .map(e => e.cell)
    .filter(Boolean);
  // Also probe a couple of arbitrary cells, including ones far from the units.
  starts.push(gameState.hexGrid.getCell(0, 0), gameState.hexGrid.getCell(7, -3));

  for (const start of starts) {
    if (!start) continue;
    const expected = naiveCounts(player, start);
    const actual = helper.countUnexploredByDirection(start, player.id);
    compared++;
    for (const direction of Object.keys(expected)) {
      assert(actual[direction] === expected[direction],
        `${player.name} @ ${start.q},${start.r} ${direction}: ${actual[direction]} != ${expected[direction]}`);
    }
  }
}

assert(compared > 0, 'no start cells checked');
console.log(failures === 0 ? `directionHistogram: PASS (${compared} start cells)` : `directionHistogram: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
