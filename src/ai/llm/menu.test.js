/**
 * Node-based tests for the menu interface (src/ai/llm/menu.js).
 * Run with: node --import ./tests/headless/stubs.mjs --loader ./tests/headless/loader.mjs --input-type=module -e "import('./src/ai/llm/menu.test.js')"
 *
 * Uses mocked game states to validate option building, X/Y candidate
 * filtering, the 0-orders collapse, and response parsing — without a browser.
 */
import { buildMenu, parseMenuResponse, renderMenuPrompt } from './menu.js';

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

const RED = { id: 2, name: 'Red' };
const GREEN = { id: 1, name: 'Green' };

function mockEntity(o) {
    return {
        id: o.id,
        name: o.name,
        q: o.q, r: o.r,
        cell: { q: o.q, r: o.r },
        owner: o.owner,
        actionPoints: o.ap ?? 2,
        maxActionPoints: o.ap ?? 2,
        health: o.hp ?? 100,
        maxHealth: 100,
        active: true,
        destroyed: false,
        damage: o.damage ?? { value: 0 },
        getActions: () => o.actions || [],
    };
}

const MANIFEST = {
    entities: [
        { name: 'swordsman', buildables: [], repairables: [] },
        { name: 'worker', buildables: ['farm', 'mine'], repairables: ['farm'] },
        { name: 'village', buildables: ['swordsman'], repairables: [] },
        { name: 'farm', buildables: [], repairables: [] },
    ],
};

function mockGame(entities, orders = 5) {
    const player = {
        ...GREEN,
        orders, maxOrders: 6,
        resources: { gold: 1000, wood: 1000, iron: 1000, food: 1000, gems: 100 },
        getEntities: (gs) => gs.entities.filter(e => e.owner && e.owner.id === 1),
        getOpponents: () => ({ 2: { id: 2, name: 'Red' } }),
        isVisible: () => true,
    };
    return {
        gameState: {
            entities,
            players: [player, RED],
            manifestData: MANIFEST,
        },
        player,
    };
}

const SWORD_ACTIONS = [{ name: 'Attack', range: { maxCells: 1 } }, { name: 'Move' }];
const WORKER_ACTIONS = [{ name: 'Move' }];

// --- buildMenu ---

test('options are globally numbered from 1 with no gaps', () => {
    const { gameState, player } = mockGame([
        mockEntity({ id: 'swordsman_1_x', name: 'swordsman', q: 0, r: 0, owner: GREEN, actions: SWORD_ACTIONS, damage: { value: 30 } }),
        mockEntity({ id: 'swordsman_2_y', name: 'swordsman', q: 1, r: 0, owner: RED, actions: SWORD_ACTIONS }),
    ]);
    const { options } = buildMenu(gameState, player, {});
    assert(options.length > 0, 'expected options');
    options.forEach((o, i) => assert(o.n === i + 1, `option ${i} numbered ${o.n}`));
});

test('0 orders collapses the menu to End turn only', () => {
    const { gameState, player } = mockGame([
        mockEntity({ id: 'swordsman_1_x', name: 'swordsman', q: 0, r: 0, owner: GREEN, actions: SWORD_ACTIONS, damage: { value: 30 } }),
    ], 0);
    const { options } = buildMenu(gameState, player, {});
    assert(options.length === 1, `expected 1 option, got ${options.length}`);
    assert(options[0].label === 'End turn', `got "${options[0].label}"`);
    assert(options[0].action.verb === 'end', 'verb should be end');
});

test('exhausted units (AP < 1) get no options', () => {
    const { gameState, player } = mockGame([
        mockEntity({ id: 'swordsman_1_x', name: 'swordsman', q: 0, r: 0, owner: GREEN, actions: SWORD_ACTIONS, ap: 0, damage: { value: 30 } }),
    ]);
    const { options } = buildMenu(gameState, player, {});
    const mine = options.filter(o => o.action.actorId === 'swordsman_1_x');
    assert(mine.length === 0, `exhausted unit got ${mine.length} options`);
});

test('attackTargets=X keeps only the X closest enemies', () => {
    const { gameState, player } = mockGame([
        mockEntity({ id: 'swordsman_1_x', name: 'swordsman', q: 0, r: 0, owner: GREEN, actions: SWORD_ACTIONS, damage: { value: 30 } }),
        mockEntity({ id: 'e1', name: 'swordsman', q: 1, r: 0, owner: RED, actions: SWORD_ACTIONS }),
        mockEntity({ id: 'e2', name: 'swordsman', q: 2, r: 0, owner: RED, actions: SWORD_ACTIONS }),
        mockEntity({ id: 'e3', name: 'swordsman', q: 3, r: 0, owner: RED, actions: SWORD_ACTIONS }),
    ]);
    const { options } = buildMenu(gameState, player, { attackTargets: 1, attackOrders: 9 });
    const attacks = options.filter(o => o.action.verb === 'attack');
    assert(attacks.length === 1, `expected 1 attack option, got ${attacks.length}`);
    assert(attacks[0].action.targetId === 'e1', `expected closest enemy e1, got ${attacks[0].action.targetId}`);
});

test('attackOrders=Y filters out enemies beyond reach', () => {
    const mk = (y) => {
        const { gameState, player } = mockGame([
            mockEntity({ id: 'swordsman_1_x', name: 'swordsman', q: 0, r: 0, owner: GREEN, actions: SWORD_ACTIONS, damage: { value: 30 } }),
            mockEntity({ id: 'e1', name: 'swordsman', q: 1, r: 0, owner: RED, actions: SWORD_ACTIONS }),
            mockEntity({ id: 'e9', name: 'swordsman', q: 9, r: 0, owner: RED, actions: SWORD_ACTIONS }),
        ]);
        return buildMenu(gameState, player, { attackTargets: 5, attackOrders: y }).options
            .filter(o => o.action.verb === 'attack').map(o => o.action.targetId);
    };
    assert(JSON.stringify(mk(0)) === JSON.stringify(['e1']), `Y=0 should keep only adjacent: ${mk(0)}`);
    assert(mk(9).includes('e9'), `Y=9 should include far enemy: ${mk(9)}`);
});

test('attack labels show distance', () => {
    const { gameState, player } = mockGame([
        mockEntity({ id: 'swordsman_1_x', name: 'swordsman', q: 0, r: 0, owner: GREEN, actions: SWORD_ACTIONS, damage: { value: 30 } }),
        mockEntity({ id: 'e1', name: 'swordsman', q: 1, r: 0, owner: RED, actions: SWORD_ACTIONS }),
        mockEntity({ id: 'e3', name: 'swordsman', q: 3, r: 0, owner: RED, actions: SWORD_ACTIONS }),
    ]);
    const { options } = buildMenu(gameState, player, { attackTargets: 5, attackOrders: 9 });
    const labels = options.filter(o => o.action.verb === 'attack').map(o => o.label);
    assert(labels.some(l => l.includes('adjacent')), `missing "adjacent": ${labels}`);
    assert(labels.some(l => l.includes('3 away')), `missing "3 away": ${labels}`);
});

test('move towards offers targets plus 8 compass directions', () => {
    const { gameState, player } = mockGame([
        mockEntity({ id: 'swordsman_1_x', name: 'swordsman', q: 0, r: 0, owner: GREEN, actions: SWORD_ACTIONS, damage: { value: 30 } }),
        mockEntity({ id: 'e1', name: 'swordsman', q: 5, r: 0, owner: RED, actions: SWORD_ACTIONS }),
    ]);
    const { options } = buildMenu(gameState, player, { moveTargets: 3 });
    const moves = options.filter(o => o.action.verb === 'move');
    const dirs = moves.filter(o => o.action.direction);
    const tgts = moves.filter(o => o.action.targetId);
    assert(dirs.length === 8, `expected 8 direction moves, got ${dirs.length}`);
    assert(tgts.length >= 1, `expected target moves, got ${tgts.length}`);
    assert(dirs.some(o => o.action.direction === 'W'), 'missing W direction');
});

test('repair lists damaged own repairables, never enemies', () => {
    const { gameState, player } = mockGame([
        mockEntity({ id: 'worker_1_x', name: 'worker', q: 0, r: 0, owner: GREEN, actions: WORKER_ACTIONS }),
        mockEntity({ id: 'farm_1_x', name: 'farm', q: 1, r: 0, owner: GREEN, hp: 50 }),
        mockEntity({ id: 'farm_2_e', name: 'farm', q: 1, r: 1, owner: RED, hp: 50 }),
        mockEntity({ id: 'farm_3_ok', name: 'farm', q: 2, r: 0, owner: GREEN, hp: 100 }),
    ]);
    const { options } = buildMenu(gameState, player, { repairTargets: 5, repairOrders: 3 });
    const repairs = options.filter(o => o.action.verb === 'repair');
    assert(repairs.length === 1, `expected 1 repair option, got ${repairs.length}: ${repairs.map(r => r.label)}`);
    assert(repairs[0].action.targetId === 'farm_1_x', 'should repair own damaged farm');
    assert(repairs[0].label.includes('50/100'), `label should show HP: ${repairs[0].label}`);
});

test('chat has one option per opponent and End turn is last', () => {
    const { gameState, player } = mockGame([
        mockEntity({ id: 'swordsman_1_x', name: 'swordsman', q: 0, r: 0, owner: GREEN, actions: SWORD_ACTIONS, damage: { value: 30 } }),
    ]);
    const { options } = buildMenu(gameState, player, {});
    const chats = options.filter(o => o.action.verb === 'chat');
    assert(chats.length === 1 && chats[0].action.playerName === 'Red', `chat options: ${JSON.stringify(chats)}`);
    assert(options[options.length - 1].action.verb === 'end', 'last option should be End turn');
});

test('build options use affordable items', () => {
    const { gameState, player } = mockGame([
        mockEntity({ id: 'worker_1_x', name: 'worker', q: 0, r: 0, owner: GREEN, actions: WORKER_ACTIONS }),
    ]);
    const { options } = buildMenu(gameState, player, {});
    const builds = options.filter(o => o.action.verb === 'build');
    assert(builds.length === 2, `expected 2 build options, got ${builds.length}`);
    assert(builds.every(o => o.action.actorId === 'worker_1_x'), 'actor should be the worker');
});

// --- parseMenuResponse ---

const FAKE_OPTIONS = [
    { n: 1, label: 'Attack Red\'s swordsman (adjacent) with your swordsman', action: { verb: 'attack' } },
    { n: 2, label: 'End turn', action: { verb: 'end' } },
];

test('parse accepts a valid option number', () => {
    const r = parseMenuResponse(JSON.stringify({ thoughtProcess: 't', option: 1, note: 'n' }), FAKE_OPTIONS);
    assert(!r.error, `unexpected error: ${r.error}`);
    assert(r.n === 1 && r.action.verb === 'attack', 'wrong action');
    assert(r.note === 'n', 'note lost');
});

test('parse rejects out-of-range option', () => {
    const r = parseMenuResponse(JSON.stringify({ thoughtProcess: 't', option: 9, note: 'n' }), FAKE_OPTIONS);
    assert(r.error && r.error.includes('1 to 2'), `expected range error, got: ${r.error}`);
});

test('parse tolerates the label text instead of the number', () => {
    const r = parseMenuResponse(JSON.stringify({ thoughtProcess: 't', option: 'End turn', note: 'n' }), FAKE_OPTIONS);
    assert(!r.error && r.n === 2, `label tolerance failed: ${r.error}`);
});

test('parse strips fenced JSON', () => {
    const r = parseMenuResponse('```json\n{"thoughtProcess":"t","option":2,"note":"n"}\n```', FAKE_OPTIONS);
    assert(!r.error && r.n === 2, `fence strip failed: ${r.error}`);
});

test('parse rejects garbage', () => {
    const r = parseMenuResponse('not json at all', FAKE_OPTIONS);
    assert(r.error, 'expected an error for garbage input');
});

// --- renderMenuPrompt ---

test('renderMenuPrompt numbers every option', () => {
    const out = renderMenuPrompt('## State', FAKE_OPTIONS);
    assert(out.includes('1. Attack Red\'s swordsman (adjacent) with your swordsman'), 'missing option 1');
    assert(out.includes('2. End turn'), 'missing option 2');
    assert(out.includes('## State'), 'missing state markdown');
});

console.log(`\nmenu.test.js: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
