/**
 * Node-based tests for the LLM Markdown serializers.
 * Run with: node --input-type=module -e "import('./src/ai/llm/markdown.test.js')"
 *
 * These use mocked game states to validate the *ToMarkdown() output
 * across various scenarios without needing a browser.
 */
import { manifestToMarkdown, serializeStateToMarkdown, summarizeTerrain } from './markdown.js';
import { readFileSync } from 'fs';

const entities = JSON.parse(readFileSync('definitions/entities.json', 'utf8'));
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

// --- manifestToMarkdown tests ---

console.log('\n## manifestToMarkdown');

test('includes combat info for military units', () => {
    const md = manifestToMarkdown(entities);
    assert(md.includes('60 blunt damage'), 'knight damage missing');
    assert(md.includes('250 HP'), 'knight HP missing');
    assert(md.includes('resistant to slashing'), 'armor info missing');
});

test('non-combat entities show HP but no damage', () => {
    const md = manifestToMarkdown(entities);
    const farmSec = md.split('### FARM')[1].split('###')[0];
    assert(farmSec.includes('**Combat**'), 'farm should show HP');
    assert(farmSec.includes('HP'), 'farm HP missing');
    assert(!farmSec.includes('damage;'), 'farm should not show damage');
});

test('still has builds, cost, yields for build decisions', () => {
    const md = manifestToMarkdown(entities);
    const villageSec = md.split('### VILLAGE')[1].split('###')[0];
    assert(villageSec.includes('**Builds**'), 'village builds missing');
    assert(villageSec.includes('**Cost**'), 'village cost missing');
});

// --- serializeStateToMarkdown tests ---

console.log('\n## serializeStateToMarkdown');

const baseSummary = {
    turn: 10, orders: 5,
    resources: {
        stock: { gold: 100, wood: 50, food: 300 },
        netIncome: { gold: 20, wood: 10, food: 0 },
        turnsRemaining: {},
    },
    score: 100,
    entities: [],
    opponents: {}
};

test('early game: worker with affordable builds, nothing damaged', () => {
    const summary = {
        ...baseSummary,
        entities: [{
            id: 'worker_1', name: 'worker', health: 100, maxHealth: 100, actionPoints: 5,
            fromStart: { direction: 'E', distance: 2 },
            buildableNow: ['farm', 'mine', 'lumberMill'],
            buildableLater: [],
            damagedRepairables: []
        }]
    };
    const md = serializeStateToMarkdown(summary, entities);
    assert(md.includes('Can build now: farm, mine, lumberMill'), 'affordable builds missing');
    assert(!md.includes('Can repair'), 'should omit repair when nothing damaged');
    assert(!md.includes('Cannot afford'), 'should omit unaffordable section when empty');
});

test('mid game: damaged farm shows in repairables', () => {
    const summary = {
        ...baseSummary,
        entities: [{
            id: 'worker_1', name: 'worker', health: 80, maxHealth: 100, actionPoints: 3,
            fromStart: { direction: 'E', distance: 2 },
            buildableNow: ['farm'],
            buildableLater: [{ name: 'temple', missing: '50 gold' }],
            damagedRepairables: [{ id: 'farm_2', name: 'farm', health: 30, maxHealth: 100 }]
        }]
    };
    const md = serializeStateToMarkdown(summary, entities);
    assert(md.includes('Can repair (damaged): farm_2 (30/100 HP)'), 'damaged farm missing');
    assert(md.includes('Cannot afford temple (need 50 gold)'), 'unaffordable with deficit missing');
});

test('settler that cannot afford village', () => {
    const summary = {
        ...baseSummary,
        resources: { ...baseSummary.resources, stock: { gold: 10, wood: 5, food: 20 } },
        entities: [{
            id: 'settler_1', name: 'settler', health: 150, maxHealth: 150, actionPoints: 5,
            fromStart: { direction: 'N', distance: 0 },
            buildableNow: [],
            buildableLater: [{ name: 'village', missing: '90 gold, 80 food' }]
        }]
    };
    const md = serializeStateToMarkdown(summary, entities);
    assert(md.includes('Cannot afford village'), 'settler unaffordable village missing');
    assert(!md.includes('Can build now'), 'should not show empty buildable section');
});

test('fallback to static manifest when state fields absent', () => {
    const summary = {
        ...baseSummary,
        entities: [{
            id: 'worker_1', name: 'worker', health: 100, maxHealth: 100, actionPoints: 5,
            fromStart: { direction: 'E', distance: 2 }
            // No buildableNow/buildableLater/damagedRepairables — should fall back
        }]
    };
    const md = serializeStateToMarkdown(summary, entities);
    assert(md.includes('Builds:'), 'should fall back to static builds list');
});

// --- summarizeTerrain tests ---

console.log('\n## summarizeTerrain');

test('handles empty game state gracefully', () => {
    const result = summarizeTerrain({ hexGrid: { getCellsArray: () => [] } }, { isExplored: () => false });
    assert(result === '' || typeof result === 'string', 'should return string');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
