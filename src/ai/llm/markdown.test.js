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

// --- Descriptor mapping tests ---

console.log('\n## Descriptors');

test('movement descriptors replace raw numbers', () => {
    const md = manifestToMarkdown(entities);
    // Should not contain raw multipliers like "1.5x" or "0.8x"
    assert(!md.includes('1.5x'), 'should not show raw 1.5x');
    assert(!md.includes('0.8x'), 'should not show raw 0.8x');
    // Should contain descriptors
    assert(md.includes('slow on') || md.includes('very slow on'), 'should describe slow terrain');
});

test('armor descriptors replace raw numbers', () => {
    const md = manifestToMarkdown(entities);
    const knightSec = md.split('### KNIGHT')[1].split('###')[0];
    // Knight has 2.5/2.5/2 armor = "very resistant" (>=2)
    assert(knightSec.includes('very resistant to'), 'knight should show very resistant');
    assert(!knightSec.includes(': 2.5'), 'should not show raw armor numbers');
    // Scout has no armor — should not show armor line
    const scoutSec = md.split('### SCOUT')[1].split('###')[0];
    assert(!scoutSec.includes('resistant to'), 'scout has no armor, should omit');
});

// --- Orders, score, terrain tests ---

console.log('\n## State formatting');

test('orders show as X out of Y', () => {
    const summary = {
        turn: 5, orders: 4, maxOrders: 6,
        resources: { stock: {}, netIncome: {}, turnsRemaining: {} },
        score: 0, entities: [], opponents: {}
    };
    const md = serializeStateToMarkdown(summary, entities);
    assert(md.includes('4 out of 6 orders remaining'), 'orders format wrong');
});

test('score shows breakdown', () => {
    const summary = {
        turn: 10, orders: 5, maxOrders: 8,
        resources: { stock: {}, netIncome: {}, turnsRemaining: {} },
        score: { total: 150, military: 40, economic: 60, exploration: 50 },
        entities: [], opponents: {}
    };
    const md = serializeStateToMarkdown(summary, entities);
    assert(md.includes('Total: 150'), 'total score missing');
    assert(md.includes('Military: 40'), 'military breakdown missing');
    assert(md.includes('Economic: 60'), 'economic breakdown missing');
    assert(md.includes('Exploration: 50'), 'exploration breakdown missing');
});

test('entity shows terrain', () => {
    const summary = {
        turn: 5, orders: 4, maxOrders: 6,
        resources: { stock: {}, netIncome: {}, turnsRemaining: {} },
        score: 0,
        entities: [{
            id: 'scout_1', name: 'scout', health: 80, maxHealth: 80, actionPoints: 8,
            fromStart: { direction: 'NE', distance: 4 }, terrain: 'plains'
        }],
        opponents: {}
    };
    const md = serializeStateToMarkdown(summary, entities);
    assert(md.includes('on plains'), 'terrain missing from entity output');
});

test('AP spelled out as action points', () => {
    const summary = {
        turn: 5, orders: 4, maxOrders: 6,
        resources: { stock: {}, netIncome: {}, turnsRemaining: {} },
        score: 0,
        entities: [{
            id: 'scout_1', name: 'scout', health: 80, maxHealth: 80, actionPoints: 8,
            fromStart: { direction: 'NE', distance: 4 }
        }],
        opponents: {}
    };
    const md = serializeStateToMarkdown(summary, entities);
    assert(md.includes('8 action points'), 'should spell out action points');
    assert(!md.includes('8 AP'), 'should not use AP abbreviation');
});

// --- Late game scenario ---

console.log('\n## Late game');

test('late game with opponents and barbarians', () => {
    const summary = {
        turn: 80, orders: 10, maxOrders: 12,
        resources: {
            stock: { gold: 500, wood: 300, food: 800, iron: 150, gems: 25 },
            netIncome: { gold: 50, wood: 30, food: 20, iron: 10, gems: 2 },
            turnsRemaining: {},
        },
        score: { total: 850, military: 300, economic: 400, exploration: 150 },
        entities: [
            { id: 'knight_1', name: 'knight', health: 200, maxHealth: 250, actionPoints: 6,
              fromStart: { direction: 'W', distance: 15 }, terrain: 'hills',
              damage: { value: 60, type: 'blunt' } },
            { id: 'village_1', name: 'village', health: 500, maxHealth: 500, actionPoints: 0,
              fromStart: { direction: 'N', distance: 0 }, terrain: 'plains',
              buildableNow: ['pikeman', 'swordsman'], buildableLater: [] },
        ],
        opponents: {
            'Red': {
                score: 700,
                entities: [
                    { id: 'red_knight_1', name: 'knight', health: 180, maxHealth: 250,
                      fromStart: { direction: 'W', distance: 18 }, terrain: 'forest' },
                    { id: 'red_archer_1', name: 'bowman', health: 120, maxHealth: 120,
                      fromStart: { direction: 'W', distance: 20 }, terrain: 'hills' },
                ]
            },
            'Barbarians': {
                score: 100,
                entities: [
                    { id: 'barb_1', name: 'barbarian', health: 250, maxHealth: 300,
                      fromStart: { direction: 'E', distance: 12 }, terrain: 'desert' },
                ]
            }
        }
    };
    const md = serializeStateToMarkdown(summary, entities);
    // All 5 resources shown
    assert(md.includes('**Gold**'), 'gold missing');
    assert(md.includes('**Iron**'), 'iron missing');
    assert(md.includes('**Gems**'), 'gems missing');
    // Opponents shown with entity details
    assert(md.includes('**Red**'), 'Red opponent missing');
    assert(md.includes('**Barbarians**'), 'Barbarians missing');
    assert(md.includes('red_knight_1 (Knight)'), 'opponent knight details missing');
    assert(md.includes('18 W of start'), 'opponent position missing');
    assert(md.includes('on forest'), 'opponent terrain missing');
    assert(md.includes('180/250 HP'), 'opponent health missing');
    assert(md.includes('60 blunt dmg'), 'opponent damage missing (threat assessment)');
    // Score breakdown
    assert(md.includes('Total: 850'), 'late game score missing');
});

// --- AP-gated buildables ---

console.log('\n## AP gating');

test('unit with <1 AP cannot build', () => {
    const summary = {
        turn: 5, orders: 4, maxOrders: 6,
        resources: { stock: { gold: 100, wood: 100 }, netIncome: {}, turnsRemaining: {} },
        score: 0,
        entities: [{
            id: 'worker_1', name: 'worker', health: 100, maxHealth: 100, actionPoints: 0.5,
            fromStart: { direction: 'E', distance: 2 },
            buildableNow: [],
            buildableLater: [{ name: 'mine', missing: 'insufficient AP (0.5 < 1 required)' }]
        }],
        opponents: {}
    };
    const md = serializeStateToMarkdown(summary, entities);
    assert(md.includes('Cannot build mine (insufficient AP'), 'should show AP reason, not affordability');
    assert(!md.includes('Can build now'), 'should not show buildable when AP < 1');
});

// --- summarizeTerrain tests ---

console.log('\n## summarizeTerrain');

test('handles empty game state gracefully', () => {
    const result = summarizeTerrain({ hexGrid: { getCellsArray: () => [] } }, { isExplored: () => false });
    assert(result === '' || typeof result === 'string', 'should return string');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
