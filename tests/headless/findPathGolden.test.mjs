/**
 * Golden-output guard for AiHelper.findPathTowardsUnexplored (issue #72).
 *
 * The helper is shared by Adaptive, Fable, Apex and Hark, and its behaviour is
 * subtle: BFS visitation order, parent-pointer paths, direct/border target
 * selection, and the nearest-reachable fallback. It was rewritten for speed in
 * round 3 on the promise that nothing observable changed, so this pins what
 * explorers actually do on a fixed map and seed.
 *
 * Captured (per call): target cell, path length, first and last path cell,
 * fullyExplored, arrivedAtBestReachable.
 *
 * On a fixed seed the map, starting units and visibility are deterministic, so
 * these values must never change. If map generation changes on purpose,
 * re-emit with --emit and re-baseline.
 *
 * Run from tests/headless:
 *   node --import ./preload.mjs ./findPathGolden.test.mjs          # check
 *   node --import ./preload.mjs ./findPathGolden.test.mjs --emit   # re-baseline
 */
import { GameState } from '../../src/gameState.js';
import { loadGameManifest } from '../../src/manifestLoader.js';

const EMIT = process.argv.includes('--emit');

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

function describe(result) {
  const target = result.targetCell ? `${result.targetCell.q},${result.targetCell.r}` : '-';
  const first = result.path.length > 0 ? `${result.path[0].q},${result.path[0].r}` : '-';
  const last = result.path.length > 0 ? `${result.path[result.path.length - 1].q},${result.path[result.path.length - 1].r}` : '-';
  return `${target}|${result.path.length}|${first}|${last}|${result.fullyExplored ? 1 : 0}|${result.arrivedAtBestReachable ? 1 : 0}`;
}

const manifest = await loadGameManifest();
const ds = manifest.defaultSettings || {};
const players = [
  { id: 1, name: 'Blue', color: '#00f', controller: { url: './ai/standard/smartManager.js' } },
  { id: 2, name: 'Red', color: '#f00', controller: { url: './ai/standard/smartManager.js' } },
];
const gameState = new GameState();
gameState.generateMap(24, manifest.terrains, manifest, 424242);
gameState.initializeManifest(manifest, {
  players,
  initialization: ds.initialization || {},
  winCondition: null,
  barbarians: null,
});
const helper = gameState.aiHelper;

// Deterministic targetCells sample: the first 24 unexplored cells in grid order.
const unexploredSample = helper.getCellsArray()
  .filter(c => c && !gameState.players[0].isExplored(c.q, c.r))
  .slice(0, 24);

const observations = [];
for (const player of gameState.players) {
  const units = player.getEntities()
    .filter(e => e.getActions && e.getActions().some(a => a.name === 'Move') && (e.actionPoints ?? 0) > 0)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  for (const unit of units) {
    const label = `p${player.id}/${unit.name}#${unit.id}`;

    // a) plain: nearest unexplored, nothing targeted yet
    observations.push({ label: `${label}/plain`, value: describe(helper.findPathTowardsUnexplored(unit, gameState, player, new Set(), null)) });

    // b) with another cell already claimed this turn
    const claimed = new Set([`${unit.q},${unit.r}`]);
    observations.push({ label: `${label}/claimed`, value: describe(helper.findPathTowardsUnexplored(unit, gameState, player, claimed, null)) });

    // c) explicit candidate list
    if (unexploredSample.length > 0) {
      observations.push({ label: `${label}/targets`, value: describe(helper.findPathTowardsUnexplored(unit, gameState, player, new Set(), unexploredSample)) });
    }
  }
}

assert(observations.length > 0, 'no observations captured');

if (EMIT) {
  // Write beside the test so the baseline is easy to copy in; stdout carries
  // the preload/config noise, so a file is cleaner than parsing output.
  const { writeFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const outPath = fileURLToPath(new URL('./findPathGolden.expected.json', import.meta.url));
  writeFileSync(outPath, JSON.stringify(observations, null, 2) + '\n');
  console.log(`emitted ${observations.length} observations to ${outPath}`);
  process.exit(0);
}

// Baseline is committed next to this test; re-baseline with --emit.
const { readFileSync, existsSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const expectedPath = fileURLToPath(new URL('./findPathGolden.expected.json', import.meta.url));
const EXPECTED = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, 'utf8')) : [];

for (const [i, expected] of EXPECTED.entries()) {
  const actual = observations[i];
  if (!actual) {
    assert(false, `missing observation ${i} (${expected.label})`);
    continue;
  }
  assert(actual.label === expected.label, `observation ${i} label ${actual.label} != ${expected.label}`);
  assert(actual.value === expected.value, `${expected.label}: ${actual.value} != ${expected.value}`);
}
assert(observations.length === EXPECTED.length,
  `${observations.length} observations vs ${EXPECTED.length} baselined (re-run with --emit if the map changed on purpose)`);

console.log(failures === 0
  ? `findPathGolden: PASS (${observations.length} observations)`
  : `findPathGolden: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
