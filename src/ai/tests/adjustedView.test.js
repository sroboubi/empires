/**
 * Node-based tests for src/ai/adjustedView.js.
 * Run from the repo root with:
 *   node --input-type=module -e "import('./src/ai/tests/adjustedView.test.js')"
 *
 * This is AI-code-only: the player/entity inputs are mocks, so the test
 * lives under src/ai/tests and imports nothing from outside src/ai.
 */
import { adjustedView, adjustedEntityView } from '../adjustedView.js';

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
function equal(a, b, msg) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
        throw new Error(`${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
    }
}

const META = {
    spawnCost: { food: 10, gold: 5 },
    maintenance: { gold: 3 },
    yields: { gold: 4 },
    attackCostScale: 10,
    damage: { value: 5, type: 'slashing', lifeFraction: 0 },
    armor: { slashing: 2 },
    movement: {},
};

const twistedPlayer = {
    getSpawnCost: () => ({ food: 5, gold: 2.5 }),
    getMaintenanceCost: () => ({ gold: 3 }),
    getYields: () => ({ gold: 8 }),
    getAttackCost: () => 8,
    getAttackValue: () => ({ value: 6, type: 'slashing' }),
    getArmorValue: () => ({ slashing: 1 }),
};

const rawPlayer = {
    getSpawnCost: () => ({ food: 10, gold: 5 }),
    getMaintenanceCost: () => ({ gold: 3 }),
    getYields: () => ({ gold: 4 }),
    getAttackCost: () => 10,
    getAttackValue: () => ({ value: 5, type: 'slashing' }),
    getArmorValue: () => ({ slashing: 2 }),
};

test('adjustedView applies the acting player twists and never mutates meta', () => {
    const adjusted = adjustedView(twistedPlayer, META, 'swordsman');
    equal(adjusted.spawnCost, { food: 5, gold: 2.5 }, 'spawnCost adjusted');
    equal(adjusted.yields, { gold: 8 }, 'yields adjusted');
    equal(adjusted.maintenance, { gold: 3 }, 'maintenance adjusted');
    assert(adjusted.attackCostScale === 8, 'attackCostScale adjusted');
    assert(adjusted.damage.value === 6, 'damage adjusted');
    assert(adjusted.armor.slashing === 1, 'armor adjusted');
    equal(META.spawnCost, { food: 10, gold: 5 }, 'manifest meta untouched');
    assert(META.damage.value === 5, 'manifest damage untouched');
});

test('adjustedView with no twists returns the raw values', () => {
    const adjusted = adjustedView(rawPlayer, META, 'swordsman');
    equal(adjusted.spawnCost, { food: 10, gold: 5 }, 'spawnCost unchanged');
    equal(adjusted.yields, { gold: 4 }, 'yields unchanged');
    assert(adjusted.attackCostScale === 10, 'attackCostScale unchanged');
});

test('adjustedView with hidden foreign value functions falls back to raw meta', () => {
    const foreignLike = { getAttackValue: () => undefined };
    const adjusted = adjustedView(foreignLike, META, 'swordsman');
    equal(adjusted.spawnCost, { food: 10, gold: 5 }, 'raw spawnCost');
    equal(adjusted.yields, { gold: 4 }, 'raw yields');
    assert(adjusted.damage.value === 5, 'raw damage');
});

test('adjustedEntityView applies visible-entity adjusted properties', () => {
    const entity = {
        getCostToSpawn: () => ({ food: 5, gold: 2.5 }),
        getCostToMaintain: () => ({ gold: 3 }),
        yields: { gold: 8 },
        getAttackCost: () => 8,
        getAttackValue: () => ({ value: 6, type: 'slashing' }),
        getArmorValue: () => ({ slashing: 1 }),
    };
    const adjusted = adjustedEntityView(entity, META);
    equal(adjusted.spawnCost, { food: 5, gold: 2.5 }, 'spawnCost adjusted');
    equal(adjusted.maintenance, { gold: 3 }, 'maintenance adjusted');
    equal(adjusted.yields, { gold: 8 }, 'yields adjusted');
    assert(adjusted.attackCostScale === 8, 'attackCostScale adjusted');
    assert(adjusted.damage.value === 6, 'damage adjusted');
    assert(adjusted.armor.slashing === 1, 'armor adjusted');
    equal(META.spawnCost, { food: 10, gold: 5 }, 'manifest meta untouched');
});

test('adjustedEntityView with no meta returns null', () => {
    assert(adjustedEntityView({}, null) === null, 'null meta');
});

console.log(`\nadjustedView: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
