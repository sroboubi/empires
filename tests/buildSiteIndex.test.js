/**
 * Node-based equivalence tests for the build-site potential index +
 * disk enumeration in AiHelper.findBuildCandidates (issue #72).
 * Run from the repo root with:
 *   node --import=./tests/headless/preload.mjs --input-type=module -e "import('./tests/buildSiteIndex.test.js')"
 *
 * The new implementation must return the FULL candidate set the old
 * full-map scan returned — same cells, same order, same dist/yield/stage —
 * because several AIs score every candidate strategically (Adaptive goal
 * direction, Apex/Fable exposure/home bias). Each scenario compares the
 * new code against a reference copy of the old algorithm on the same
 * fake game state.
 *
 * This tests GAME code (AiHelper in src/), so it lives in the root tests
 * dir, not under src/ai.
 */
import { HexGrid } from '../src/hexGrid.js';
import { AiHelper } from '../src/aiHelper.js';

let passed = 0, failed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.log(`  ✗ ${name}: ${e.message}`);
    }
}
function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}
function assertDeepEqual(a, b, msg) {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa !== sb) throw new Error(`${msg}\n  got:  ${sa}\n  want: ${sb}`);
}

// --- fixtures ---------------------------------------------------------------

const GRASS = { name: 'Grasslands', movementCost: 1 };
const HILLS = { name: 'Hills', movementCost: 2 };
const OCEAN = { name: 'Ocean', movementCost: 1 };

const MANIFEST_ENTITIES = {
    forge: {
        yields: { iron: 12 },
        spawnConditions: { terrain: ['Grasslands', 'Hills'] },
    },
    village: {
        yields: { gold: 10, food: 6, gems: 1 },
        spawnConditions: { terrain: ['Grasslands', 'Desert', 'FootHills', 'Tundra', 'Hills'], minSeparation: 4 },
    },
    barracks: {
        spawnConditions: { terrain: ['Grasslands', 'Hills'], minSeparation: 3 },
    },
    temple: {
        spawnConditions: { terrain: ['Grasslands'] },
    },
};

const NATURAL_RESOURCES = [
    { name: 'Iron Deposit', improvement: { forge: { type: 'iron', yieldMultiplier: 1 } } },
    { name: 'Gold Vein', improvement: { village: { type: 'gold', yieldMultiplier: 1 }, mine: { type: 'gold', yieldMultiplier: 1 } } },
    { name: 'Wheat Field', improvement: { village: { type: 'food', yieldMultiplier: 1 } } },
];

/** Build a hex-shaped grid of the given radius via HexGrid.fromCells. */
function makeGrid(radius, decorate) {
    const cells = {};
    for (let q = -radius; q <= radius; q++) {
        const rMin = Math.max(-radius, -q - radius);
        const rMax = Math.min(radius, -q + radius);
        for (let r = rMin; r <= rMax; r++) {
            cells[`${q},${r}`] = { q, r, terrain: GRASS };
        }
    }
    const grid = HexGrid.fromCells(cells);
    if (decorate) decorate(grid);
    return grid;
}

function putResource(grid, q, r, name, quantity) {
    grid.getCell(q, r).resource = { kind: 'natural', name, quantity };
}

function makeGameState(grid, entities = []) {
    return {
        hexGrid: grid,
        entities,
        manifestData: { entities: MANIFEST_ENTITIES, naturalResources: NATURAL_RESOURCES },
        getEntityAt(q, r) {
            return entities.find(e => e.q === q && e.r === r) || null;
        },
    };
}

function makeBuilder(grid, { q = 0, r = 0, explored = null, move = true } = {}) {
    const owner = {
        isExplored: explored ? (cq, cr) => explored.has(`${cq},${cr}`) : () => true,
    };
    return {
        id: 1,
        name: 'worker',
        q, r,
        cell: grid.getCell(q, r),
        owner,
        maxActionPoints: 99,
        actionPoints: 99,
        getActions: () => (move ? [{ name: 'Move' }] : []),
        getMovementCost: () => 1,
    };
}

// --- reference implementation (the old full-map scan) -----------------------

function referenceFindBuildCandidates(helper, gameState, sourceEntity, targetName, maxDistance = 10) {
    const grid = gameState?.hexGrid;
    if (!grid || !sourceEntity || !targetName) return { candidates: [], canonicalName: targetName };
    const owner = sourceEntity.owner;
    const actions = sourceEntity.getActions ? sourceEntity.getActions() : [];
    const moveAction = actions.find(a => a.name === 'Move');

    const manifestEntities = gameState.manifestData?.entities || {};
    const canonicalName = Object.keys(manifestEntities).find(k => k.toLowerCase() === String(targetName).toLowerCase()) || targetName;
    const meta = manifestEntities[canonicalName];
    const spawnConditions = meta?.spawnConditions;
    const baseYields = meta?.yields;

    const startCell = sourceEntity.cell || grid.getCell(sourceEntity.q, sourceEntity.r);
    const reachable = moveAction
        ? helper.findReachableCells(gameState, sourceEntity, maxDistance)
        : new Map([[`${sourceEntity.q},${sourceEntity.r}`, { cell: startCell, path: [] }]]);
    const canStageFrom = (cell) => {
        if (!reachable.has(`${cell.q},${cell.r}`)) return false;
        const occupant = gameState.getEntityAt(cell.q, cell.r);
        return !occupant || occupant.id === sourceEntity.id;
    };

    const isExplored = owner && typeof owner.isExplored === 'function'
        ? (q, r) => owner.isExplored(q, r)
        : () => true;

    const candidates = [];
    for (const cell of helper.getCellsArray()) {
        if (!cell || !cell.terrain) continue;
        if (helper.distance(sourceEntity, cell) > maxDistance) continue;
        if (!isExplored(cell.q, cell.r)) continue;
        if (gameState.getEntityAt(cell.q, cell.r)) continue;

        if (spawnConditions) {
            if (Array.isArray(spawnConditions.terrain) && spawnConditions.terrain.length > 0) {
                const tName = cell.terrain.name || '';
                if (!spawnConditions.terrain.some(t => t.toLowerCase() === tName.toLowerCase())) continue;
            }
            if (typeof spawnConditions.minSeparation === 'number') {
                const reqSep = spawnConditions.minSeparation;
                let ok = true;
                for (const e of gameState.entities || []) {
                    const eSep = manifestEntities[e.name]?.spawnConditions?.minSeparation;
                    if (typeof eSep === 'number' && helper.distance(cell, e) < Math.max(reqSep, eSep)) {
                        ok = false;
                        break;
                    }
                }
                if (!ok) continue;
            }
        }

        let stage = null;
        for (const nb of helper.getNeighbors(cell.q, cell.r)) {
            if (!canStageFrom(nb)) continue;
            const entry = reachable.get(`${nb.q},${nb.r}`);
            if (!stage || entry.path.length < stage.path.length) stage = entry;
        }
        if (!stage) continue;

        candidates.push({
            cell,
            stage,
            dist: helper.distance(sourceEntity, cell),
            yield: helper._expectedYieldAt(gameState, cell, canonicalName, baseYields),
        });
    }
    return { candidates, canonicalName };
}

function summarize(result) {
    return {
        canonicalName: result.canonicalName,
        candidates: result.candidates.map(c => ({
            q: c.cell.q,
            r: c.cell.r,
            dist: c.dist,
            yield: c.yield,
            stagePath: c.stage.path.map(p => `${p.q},${p.r}`),
        })),
    };
}

function assertEquivalent(helper, gameState, builder, targetName, maxDistance, msg) {
    const got = summarize(helper.findBuildCandidates(gameState, builder, targetName, maxDistance));
    const want = summarize(referenceFindBuildCandidates(helper, gameState, builder, targetName, maxDistance));
    assertDeepEqual(got, want, msg);
    return got;
}

// --- tests ------------------------------------------------------------------

test('forge: bonus sites from adjacent iron deposits match reference', () => {
    const grid = makeGrid(6, (g) => {
        putResource(g, 2, 0, 'Iron Deposit', 4);
        putResource(g, 2, 1, 'Iron Deposit', 9);
        putResource(g, -3, 2, 'Iron Deposit', 1);
        g.getCell(1, -2).terrain = OCEAN; // invalid terrain for forge
        g.getCell(-1, 3).terrain = HILLS; // valid
    });
    const gameState = makeGameState(grid);
    const helper = new AiHelper(gameState);
    const builder = makeBuilder(grid);
    const got = assertEquivalent(helper, gameState, builder, 'forge', 10, 'forge candidates');
    assert(got.candidates.length > 20, `expected many candidates, got ${got.candidates.length}`);
    assert(got.candidates.some(c => c.yield > 12), 'expected at least one bonus-yield candidate');
    assert(!got.candidates.some(c => c.q === 1 && c.r === -2), 'ocean cell must not be a candidate');
});

test('village: minSeparation against existing village matches reference', () => {
    const grid = makeGrid(7, (g) => {
        putResource(g, 3, -1, 'Gold Vein', 16);
        putResource(g, -2, -2, 'Wheat Field', 4);
    });
    const existingVillage = { id: 99, name: 'village', q: 1, r: 1 };
    const gameState = makeGameState(grid, [existingVillage]);
    const helper = new AiHelper(gameState);
    const builder = makeBuilder(grid);
    const got = assertEquivalent(helper, gameState, builder, 'village', 10, 'village candidates');
    assert(got.candidates.length > 0, 'expected village candidates');
    assert(got.candidates.every(c => Math.abs(c.q - 1) + Math.abs(c.r - 1) > 0), 'occupied cell excluded');
});

test('barracks: no-yield type (yield 1) with minSeparation matches reference', () => {
    const grid = makeGrid(6);
    const existing = { id: 50, name: 'barracks', q: -2, r: 0 };
    const gameState = makeGameState(grid, [existing]);
    const helper = new AiHelper(gameState);
    const builder = makeBuilder(grid);
    const got = assertEquivalent(helper, gameState, builder, 'barracks', 10, 'barracks candidates');
    assert(got.candidates.length > 0, 'expected barracks candidates');
    assert(got.candidates.every(c => c.yield === 1), 'no-yield type yields 1 everywhere');
});

test('partially explored map: unexplored cells excluded, matches reference', () => {
    const grid = makeGrid(6, (g) => putResource(g, 4, 0, 'Iron Deposit', 25));
    const explored = new Set();
    for (const c of grid.getCellsArray()) {
        if (c.q <= 1) explored.add(`${c.q},${c.r}`);
    }
    const gameState = makeGameState(grid);
    const helper = new AiHelper(gameState);
    const builder = makeBuilder(grid, { explored });
    const got = assertEquivalent(helper, gameState, builder, 'forge', 10, 'explored-only candidates');
    assert(got.candidates.every(c => c.q <= 1), 'no unexplored candidate');
    assert(got.candidates.every(c => c.yield === 12), 'unexplored bonus must not leak into candidates');
});

test('occupied staging cells and candidates match reference', () => {
    const grid = makeGrid(5, (g) => putResource(g, 1, 1, 'Iron Deposit', 4));
    const blockers = [
        { id: 7, name: 'swordsman', q: 1, r: 0 },
        { id: 8, name: 'swordsman', q: 0, r: 1 },
        { id: 9, name: 'swordsman', q: 2, r: 2 },
    ];
    const gameState = makeGameState(grid, blockers);
    const helper = new AiHelper(gameState);
    const builder = makeBuilder(grid);
    assertEquivalent(helper, gameState, builder, 'forge', 10, 'occupied-cell candidates');
});

test('stationary builder (no Move action) matches reference', () => {
    const grid = makeGrid(5, (g) => putResource(g, 0, 2, 'Iron Deposit', 9));
    const gameState = makeGameState(grid);
    const helper = new AiHelper(gameState);
    const builder = makeBuilder(grid, { move: false });
    const got = assertEquivalent(helper, gameState, builder, 'forge', 10, 'stationary candidates');
    assert(got.candidates.every(c => c.dist <= 1), 'stationary builder can only stage adjacent');
});

test('small maxDistance (disk boundary) matches reference', () => {
    const grid = makeGrid(8, (g) => putResource(g, 5, 0, 'Iron Deposit', 100));
    const gameState = makeGameState(grid);
    const helper = new AiHelper(gameState);
    const builder = makeBuilder(grid);
    const got = assertEquivalent(helper, gameState, builder, 'forge', 3, 'radius-3 candidates');
    assert(got.candidates.every(c => c.dist <= 3), 'all candidates within maxDistance');
});

test('maxDistance beyond map size matches reference', () => {
    const grid = makeGrid(4, (g) => putResource(g, -2, 1, 'Iron Deposit', 2));
    const gameState = makeGameState(grid);
    const helper = new AiHelper(gameState);
    const builder = makeBuilder(grid);
    assertEquivalent(helper, gameState, builder, 'forge', 50, 'oversized-radius candidates');
});

test('potential cache: repeat query recomputes nothing; resource destruction recomputes only neighbors', () => {
    const grid = makeGrid(6, (g) => {
        putResource(g, 2, 0, 'Iron Deposit', 4);
        putResource(g, -3, 1, 'Iron Deposit', 9);
    });
    const gameState = makeGameState(grid);
    const helper = new AiHelper(gameState);
    const builder = makeBuilder(grid);

    let computations = 0;
    const original = helper._expectedYieldAt.bind(helper);
    helper._expectedYieldAt = (...args) => { computations++; return original(...args); };

    const first = summarize(helper.findBuildCandidates(gameState, builder, 'forge', 10));
    const firstCount = computations;
    assert(firstCount > 0, 'first query computes potentials');

    computations = 0;
    const second = summarize(helper.findBuildCandidates(gameState, builder, 'forge', 10));
    assert(computations === 0, `repeat query must hit the cache (recomputed ${computations})`);
    assertDeepEqual(second, first, 'repeat query returns identical candidates');

    // Destroy one resource (as building on its cell does): only its
    // neighbors' potentials may recompute, and results must still match
    // the reference implementation.
    delete grid.getCell(2, 0).resource;
    computations = 0;
    const third = summarize(helper.findBuildCandidates(gameState, builder, 'forge', 10));
    assert(computations > 0 && computations <= 6,
        `destruction recomputes only neighbor potentials (recomputed ${computations})`);
    const want = summarize(referenceFindBuildCandidates(helper, gameState, builder, 'forge', 10));
    assertDeepEqual(third, want, 'post-destruction candidates match reference');
    assert(JSON.stringify(third) !== JSON.stringify(first), 'destruction changed some yields');
});

test('treasure on a cell does not affect potentials (kind filter)', () => {
    const grid = makeGrid(5, (g) => {
        g.getCell(1, 0).resource = { kind: 'treasure', name: 'Gold Cache', quantity: 3 };
        putResource(g, -1, 2, 'Iron Deposit', 4);
    });
    const gameState = makeGameState(grid);
    const helper = new AiHelper(gameState);
    const builder = makeBuilder(grid);
    assertEquivalent(helper, gameState, builder, 'forge', 10, 'treasure-cell candidates');
    // Picking the treasure up deletes it — potentials must be unchanged.
    delete grid.getCell(1, 0).resource;
    assertEquivalent(helper, gameState, builder, 'forge', 10, 'post-treasure-pickup candidates');
});

console.log(`\nbuildSiteIndex: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
