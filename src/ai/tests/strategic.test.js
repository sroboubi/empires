/**
 * Node-based tests for Phase 26 — the LLM Director (strategic AI).
 * Run from the repo root with:
 *   node --import ./tests/headless/stubs.mjs --loader ./tests/headless/loader.mjs --input-type=module -e "import('./src/ai/tests/strategic.test.js')"
 *
 * Covers: directive validation (validateDirective), JSON extraction
 * (extractJsonObject), the dummy strategic AI, the LLM strategic harness
 * (three-phase turn with a stubbed client: LLM trade review, chats with
 * trade proposals, directive), the tactical trade-phase gating
 * (runTradePhase), the directive in LLM tactical prompts (directiveBlock),
 * getChatManager() routing, the step() fallback (strategic throw → tactical
 * still runs, directive untouched), and the trade hooks on the helper
 * (AiHelper.reviewTrades / maybeInitiateTrade, including the proxy
 * allow-list end-to-end). The final section proves, with the real AiHelper,
 * that a strategic trade proposal made inline with a chat is negotiated
 * in the chat thread (Part 2 probe).
 *
 * The LLM client and the system prompt are stubbed — no live model is
 * needed. The directive-validation and trade-hook logic are exercised
 * directly; the headless strategic-dummy run covers the real turn flow.
 */
import { readFileSync } from 'fs';
import { validateDirective } from '../strategic/directive.js';
import { extractJsonObject, LlmStrategicManager } from '../llm/strategic/harness.js';
import { DummyStrategicAi } from '../strategic/dummyStrategicAi.js';
import { MenuHarness } from '../llm/menu/harness.js';
import { Player } from '../../player.js';
import { AiHelper } from '../../aiHelper.js';
import { createAiManager } from '../../aiInterfaceProxy.js';

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
async function asyncTest(name, fn) {
    try {
        await fn();
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
function assertEqual(a, b, msg) {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

const GS2 = { players: [{ id: 1, name: 'Blue' }, { id: 2, name: 'Red' }] };

console.log('\n## validateDirective');

test('valid full directive normalizes stance keys to strings', () => {
    const d = validateDirective({
        focus: 'military',
        stance: { 2: 'defensive' },
        goals: [{ type: 'reinforce', target: { q: 1, r: 0 } }]
    }, GS2, 1);
    assertEqual(d, {
        focus: 'military',
        stance: { '2': 'defensive' },
        goals: [{ type: 'reinforce', target: { q: 1, r: 0 } }]
    }, 'normalized directive');
});

test('partial {focus}-only directive is valid, stance/goals default empty', () => {
    const d = validateDirective({ focus: 'economy' }, GS2, 1);
    assertEqual(d, { focus: 'economy', stance: {}, goals: [] }, 'partial directive');
});

test('missing focus defaults to balanced', () => {
    const d = validateDirective({ stance: { 2: 'neutral' } }, GS2, 1);
    assertEqual(d.focus, 'balanced', 'focus default');
});

test('invalid focus rejects the whole directive', () => {
    assertEqual(validateDirective({ focus: 'conquer' }, GS2, 1), null, 'bad focus');
});

test('unknown stance value rejects the whole directive', () => {
    assertEqual(validateDirective({ focus: 'balanced', stance: { 2: 'hostile' } }, GS2, 1), null, 'bad stance value');
});

test('stance key for a nonexistent player rejects the whole directive', () => {
    assertEqual(validateDirective({ focus: 'balanced', stance: { 99: 'ally' } }, GS2, 1), null, 'bad player id');
});

test('stance toward self is rejected', () => {
    assertEqual(validateDirective({ focus: 'balanced', stance: { 1: 'ally' } }, GS2, 1), null, 'self stance');
});

test('empty directive, null, and non-objects are invalid', () => {
    assertEqual(validateDirective({}, GS2, 1), null, 'empty object');
    assertEqual(validateDirective(null, GS2, 1), null, 'null');
    assertEqual(validateDirective('attack!', GS2, 1), null, 'string');
    assertEqual(validateDirective([{ focus: 'economy' }], GS2, 1), null, 'array');
});

test('unknown top-level fields are dropped, not fatal', () => {
    const d = validateDirective({ focus: 'exploration', notes: 'go north', priority: 3 }, GS2, 1);
    assertEqual(d, { focus: 'exploration', stance: {}, goals: [] }, 'extra fields dropped');
});

test('a goal with an unknown type is dropped, good goals kept', () => {
    const d = validateDirective({
        focus: 'balanced',
        goals: [{ type: 'attack', target: { q: 0, r: 0 } }, { type: 'explore', direction: 'NE' }]
    }, GS2, 1);
    assertEqual(d.goals, [{ type: 'explore', direction: 'NE' }], 'bad goal dropped');
});

test('goals must be an array; stance must be an object', () => {
    assertEqual(validateDirective({ focus: 'balanced', goals: 'explore' }, GS2, 1), null, 'goals not array');
    assertEqual(validateDirective({ focus: 'balanced', stance: 'friendly' }, GS2, 1), null, 'stance not object');
});

console.log('\n## extractJsonObject');

test('passes an object through and parses a plain JSON string', () => {
    assertEqual(extractJsonObject({ a: 1 }), { a: 1 }, 'object passthrough');
    assertEqual(extractJsonObject('{"targetPlayerId": 2}'), { targetPlayerId: 2 }, 'plain string');
});

test('strips fenced code blocks and surrounding prose', () => {
    assertEqual(extractJsonObject('```json\n{"targetPlayerId": null}\n```'), { targetPlayerId: null }, 'fence stripped');
    assertEqual(extractJsonObject('Here you go: {"focus": "economy"} — good luck.'),
        { focus: 'economy' }, 'prose ignored');
});

test('garbage and empty input return null', () => {
    assertEqual(extractJsonObject('no json here'), null, 'garbage');
    assertEqual(extractJsonObject(''), null, 'empty');
    assertEqual(extractJsonObject(null), null, 'null');
});

console.log('\n## DummyStrategicAi');

function mockDummyPlayer(directive) {
    return {
        id: 1, name: 'Blue',
        controller: { key: 'entity', config: {} },
        strategicController: {
            key: 'strategic-dummy',
            config: { directive }
        },
    };
}
function mockDummyHelper(spies) {
    return {
        getGameState: () => ({ currentRound: 3, players: GS2.players }),
        reviewTrades: async () => { spies.reviewed++; },
    };
}

await asyncTest('dummy returns its config directive, stamped', async () => {
    const spies = { reviewed: 0 };
    const mgr = new DummyStrategicAi(mockDummyPlayer({ focus: 'economy', stance: {}, goals: [{ type: 'explore', direction: 'NE' }] }), mockDummyHelper(spies));
    const d = await mgr.runStrategicTurn();
    assertEqual(spies.reviewed, 1, 'dummy uses helper.reviewTrades as its stand-in (it has no LLM to ask)');
    assertEqual(d.focus, 'economy', 'focus');
    assertEqual(d.setAtTurn, 3, 'setAtTurn is the current round');
    assertEqual(d.setBy, 'strategic-dummy', 'setBy is the controller key');
});

await asyncTest('dummy with no directive in config returns null', async () => {
    const mgr = new DummyStrategicAi(mockDummyPlayer(undefined), mockDummyHelper({ reviewed: 0 }));
    assertEqual(await mgr.runStrategicTurn(), null, 'no directive');
});

await asyncTest('dummy with an invalid directive in config returns null', async () => {
    const mgr = new DummyStrategicAi(mockDummyPlayer({ focus: 'conquer' }), mockDummyHelper({ reviewed: 0 }));
    assertEqual(await mgr.runStrategicTurn(), null, 'invalid directive');
});

await asyncTest('dummy chat reply is canned and ends the chat', async () => {
    const mgr = new DummyStrategicAi(mockDummyPlayer({ focus: 'balanced' }), mockDummyHelper({ reviewed: 0 }));
    const reply = await mgr.generateChatReply({ name: 'Red' });
    assert(reply.ended === true, 'ended');
    assert(typeof reply.content === 'string' && reply.content.length > 0, 'has content');
});

console.log('\n## LlmStrategicManager (stubbed client)');

function mockStrategicPlayer() {
    return {
        id: 1, name: 'Blue',
        orders: 6, maxOrders: 6,
        resources: { gold: 100, wood: 100, food: 100, iron: 100, gems: 10 },
        score: { military: 10, economic: 20, exploration: 5, total: 10 },
        exploredCells: new Set(['0,0']),
        controller: { key: 'entity', config: {} },
        strategicController: { key: 'strategic-llm', config: { provider: 'local', model: 'x' } },
        getResourceProfile: () => ({
            stock: { gold: 100, wood: 100, food: 100, iron: 100, gems: 10 },
            netIncome: { gold: 1, wood: 1, food: 1, iron: 1, gems: 0 },
            turnsRemaining: { gold: Infinity },
            criticalResource: null,
            activeTrades: []
        }),
        getEntities: () => [],
        getOpponents: () => ({ 2: { id: 2, name: 'Red', score: { total: 5 }, entities: [] } }),
        getHistory: () => [],
    };
}

function mockStrategicHelper(spies) {
    return {
        getGameState: () => ({
            currentRound: 3,
            players: [
                { id: 1, name: 'Blue', score: { total: 10 } },
                { id: 2, name: 'Red', score: { total: 5 } },
            ],
            getActiveTradesForPlayer: () => spies.activeTrades || [],
            cancelTrade: (id) => { spies.canceled.push(id); return true; },
        }),
        reviewTrades: async () => { spies.reviewed++; },
        maybeInitiateTrade: async () => { spies.initiated++; },
        initiateTrade: async (player, target, offer) => {
            // Mirrors the real signature: the receiver is a player, not an id.
            spies.tradeProposals.push({ targetId: target?.id ?? target, offer });
            return { status: 'accepted' };
        },
        // Mirrors AiHelper.chat: each chat deducts 1 order from the initiator,
        // which is what bounds the strategic chat loop.
        chat: async (initiator, target) => {
            spies.chats.push(target.id);
            initiator.orders = (initiator.orders ?? 1) - 1;
            return true;
        },
        getCellCount: () => 100,
        aiLog: () => {},
    };
}

function scriptedClient(responses) {
    let i = 0;
    return {
        generate: async () => {
            const next = responses[i++];
            if (next instanceof Error) throw next;
            return next;
        }
    };
}

function strategicManager(spies, responses) {
    const mgr = new LlmStrategicManager(mockStrategicPlayer(), mockStrategicHelper(spies));
    // One scripted client for the whole turn — getLLMClient is called fresh
    // for each phase, so sharing the instance is what advances the script.
    const client = scriptedClient(responses);
    mgr.getLLMClient = () => client;
    mgr.getStrategicSystemPrompt = async () => 'TEST STRATEGIC PROMPT';
    return mgr;
}

await asyncTest('strategic turn: no chats, valid directive returned stamped', async () => {
    const spies = { reviewed: 0, initiated: 0, chats: [], tradeProposals: [], canceled: [], activeTrades: [] };
    const mgr = strategicManager(spies, [
        '{"targetPlayerId": null}',
        '{"focus": "military", "stance": {"2": "defensive"}, "goals": [{"type": "reinforce", "target": {"q": 1, "r": 0}}]}',
    ]);
    const d = await mgr.runStrategicTurn();
    assertEqual(spies.reviewed, 0, 'LLM harness never calls helper.reviewTrades');
    assertEqual(spies.initiated, 0, 'LLM harness never calls helper.maybeInitiateTrade');
    assertEqual(spies.tradeProposals, [], 'no trade proposals');
    assertEqual(spies.chats, [], 'no chats');
    assertEqual(d.focus, 'military', 'focus');
    assertEqual(d.stance, { '2': 'defensive' }, 'stance');
    assertEqual(d.setAtTurn, 3, 'setAtTurn');
    assertEqual(d.setBy, 'strategic-llm', 'setBy');
});

await asyncTest('strategic turn: chat loop chats once, then stops on null', async () => {
    const spies = { reviewed: 0, initiated: 0, chats: [], tradeProposals: [], canceled: [], activeTrades: [] };
    const mgr = strategicManager(spies, [
        '{"targetPlayerId": 2}',
        '{"targetPlayerId": null}',
        '{"focus": "balanced"}',
    ]);
    const d = await mgr.runStrategicTurn();
    assertEqual(spies.chats, [2], 'one chat with player 2');
    assertEqual(spies.tradeProposals, [], 'no proposal without a tradeProposal field');
    assert(d && d.focus === 'balanced', 'directive still produced');
});

await asyncTest('strategic turn: invalid directive returns null (keep last valid)', async () => {
    const spies = { reviewed: 0, initiated: 0, chats: [], tradeProposals: [], canceled: [], activeTrades: [] };
    const mgr = strategicManager(spies, [
        '{"targetPlayerId": null}',
        '{"focus": "conquer"}',
    ]);
    assertEqual(await mgr.runStrategicTurn(), null, 'invalid directive -> null');
});

await asyncTest('strategic turn: a failed chat stops the loop, directive still produced', async () => {
    const spies = { reviewed: 0, initiated: 0, chats: [], tradeProposals: [], canceled: [], activeTrades: [] };
    const helper = mockStrategicHelper(spies);
    helper.chat = async (initiator, target) => { spies.chats.push(target.id); return false; };
    const mgr = new LlmStrategicManager(mockStrategicPlayer(), helper);
    const client = scriptedClient([
        '{"targetPlayerId": 2}',
        '{"focus": "economy"}',
    ]);
    mgr.getLLMClient = () => client;
    mgr.getStrategicSystemPrompt = async () => 'TEST STRATEGIC PROMPT';
    const d = await mgr.runStrategicTurn();
    assertEqual(spies.chats, [2], 'one chat attempt');
    assertEqual(spies.tradeProposals, [], 'failed chat proposes no trade');
    assert(d && d.focus === 'economy', 'directive still produced after failed chat');
});

await asyncTest('strategic turn: chat loop stops when orders run out', async () => {
    const spies = { reviewed: 0, initiated: 0, chats: [], tradeProposals: [], canceled: [], activeTrades: [] };
    const player = mockStrategicPlayer();
    player.orders = 0;
    const mgr = new LlmStrategicManager(player, mockStrategicHelper(spies));
    const client = scriptedClient(['{"focus": "balanced"}']);
    mgr.getLLMClient = () => client;
    mgr.getStrategicSystemPrompt = async () => 'TEST STRATEGIC PROMPT';
    const d = await mgr.runStrategicTurn();
    assertEqual(spies.chats, [], 'no chats with 0 orders');
    assert(d && d.focus === 'balanced', 'directive still produced');
});

await asyncTest('strategic turn: review phase cancels only the ids the LLM names (bogus ignored)', async () => {
    const spies = { reviewed: 0, initiated: 0, chats: [], tradeProposals: [], canceled: [], activeTrades: [
        { id: 't1', type: 'per_turn', player1Id: 1, player2Id: 2, bundle1: { gold: 5 }, bundle2: { food: 5 } },
        { id: 't2', type: 'per_turn', player1Id: 1, player2Id: 2, bundle1: { food: 5 }, bundle2: { gold: 5 } },
    ] };
    const mgr = strategicManager(spies, [
        '{"cancelTradeIds": ["t1", "bogus"]}',
        '{"targetPlayerId": null}',
        '{"focus": "balanced"}',
    ]);
    const d = await mgr.runStrategicTurn();
    assertEqual(spies.canceled, ['t1'], 'only the real, named deal canceled');
    assertEqual(spies.reviewed, 0, 'deterministic helper.reviewTrades never used');
    assert(d && d.focus === 'balanced', 'directive still produced');
});

await asyncTest('strategic turn: review phase keeps everything when the LLM cancels nothing', async () => {
    const spies = { reviewed: 0, initiated: 0, chats: [], tradeProposals: [], canceled: [], activeTrades: [
        { id: 't1', type: 'per_turn', player1Id: 1, player2Id: 2, bundle1: { gold: 5 }, bundle2: { food: 5 } },
    ] };
    const mgr = strategicManager(spies, [
        '{"cancelTradeIds": []}',
        '{"targetPlayerId": null}',
        '{"focus": "economy"}',
    ]);
    const d = await mgr.runStrategicTurn();
    assertEqual(spies.canceled, [], 'nothing canceled');
    assert(d && d.focus === 'economy', 'directive still produced');
});

await asyncTest('strategic turn: trade proposal rides the chat-target reply into initiateTrade', async () => {
    const spies = { reviewed: 0, initiated: 0, chats: [], tradeProposals: [], canceled: [], activeTrades: [] };
    const mgr = strategicManager(spies, [
        '{"targetPlayerId": 2, "tradeProposal": {"type": "one_time", "gives": {"wood": 5}, "asks": {"gold": 5}}}',
        '{"targetPlayerId": null}',
        '{"focus": "balanced"}',
    ]);
    const d = await mgr.runStrategicTurn();
    assertEqual(spies.chats, [2], 'chat opened first');
    assertEqual(spies.tradeProposals, [
        { targetId: 2, offer: { type: 'one_time', proposerGives: { wood: 5 }, proposerAsks: { gold: 5 } } },
    ], 'proposal mapped into initiateTrade frame');
    assert(d && d.focus === 'balanced', 'directive still produced');
});

await asyncTest('strategic turn: malformed trade proposal is ignored, chat still happens', async () => {
    const spies = { reviewed: 0, initiated: 0, chats: [], tradeProposals: [], canceled: [], activeTrades: [] };
    const mgr = strategicManager(spies, [
        '{"targetPlayerId": 2, "tradeProposal": {"type": "barter", "gives": {"wood": 5}, "asks": {"gold": 5}}}',
        '{"targetPlayerId": null}',
        '{"focus": "balanced"}',
    ]);
    const d = await mgr.runStrategicTurn();
    assertEqual(spies.chats, [2], 'chat still happens');
    assertEqual(spies.tradeProposals, [], 'bad proposal never sent');
    assert(d && d.focus === 'balanced', 'directive still produced');
});

await asyncTest('strategic turn: proposal with a null target is ignored', async () => {
    const spies = { reviewed: 0, initiated: 0, chats: [], tradeProposals: [], canceled: [], activeTrades: [] };
    const mgr = strategicManager(spies, [
        '{"targetPlayerId": null, "tradeProposal": {"type": "one_time", "gives": {"wood": 5}, "asks": {"gold": 5}}}',
        '{"focus": "economy"}',
    ]);
    const d = await mgr.runStrategicTurn();
    assertEqual(spies.chats, [], 'no chat without a target');
    assertEqual(spies.tradeProposals, [], 'no proposal without a target');
    assert(d && d.focus === 'economy', 'directive still produced');
});

console.log('\n## Tactical trade phase + directive prompt');

function mockTacticalPlayer(directive) {
    return {
        id: 1, name: 'Blue',
        orders: 5, maxOrders: 6,
        description: '',
        controller: directive
            ? { key: 'entity', config: {}, directive }
            : { key: 'entity', config: {} },
    };
}
function mockTacticalHelper(calls) {
    return {
        getGameState: () => ({
            currentRound: 3,
            settings: { winCondition: { absoluteScore: 500, relativeScore: 2 } },
            players: [
                { id: 1, name: 'Blue', score: { total: 10 } },
                { id: 2, name: 'Red', score: { total: 5 } },
            ],
        }),
        reviewTrades: async () => { calls.push('review'); },
        maybeInitiateTrade: async () => { calls.push('initiate'); },
    };
}

await asyncTest('runTradePhase calls both helper methods when no directive is set', async () => {
    const calls = [];
    const harness = new MenuHarness(mockTacticalPlayer(null), mockTacticalHelper(calls));
    await harness.runTradePhase();
    assertEqual(calls, ['review', 'initiate'], 'both called');
});

await asyncTest('runTradePhase calls neither when a directive is set', async () => {
    const calls = [];
    const harness = new MenuHarness(
        mockTacticalPlayer({ focus: 'economy', stance: {}, goals: [] }),
        mockTacticalHelper(calls));
    await harness.runTradePhase();
    assertEqual(calls, [], 'neither called');
});

test('directiveBlock renders focus, stances by name, and goals', () => {
    const harness = new MenuHarness(
        mockTacticalPlayer({ focus: 'military', stance: { 2: 'defensive' }, goals: [{ type: 'explore', direction: 'NE' }] }),
        mockTacticalHelper([]));
    const block = harness.directiveBlock();
    assert(block.includes('military'), 'focus rendered');
    assert(block.includes('Red: defensive'), 'stance rendered with player name');
    assert(block.includes('explore'), 'goal rendered');
});

test('directiveBlock is empty when no directive is set', () => {
    const harness = new MenuHarness(mockTacticalPlayer(null), mockTacticalHelper([]));
    assertEqual(harness.directiveBlock(), '', 'empty block');
});

await asyncTest('menu system prompt renders the directive fresh each turn', async () => {
    const player = mockTacticalPlayer({ focus: 'economy', stance: {}, goals: [] });
    const harness = new MenuHarness(player, mockTacticalHelper([]));
    const first = await harness.getMenuSystemPrompt();
    assert(first.includes('economy'), 'first prompt has the directive');
    assert(!first.includes('{DIRECTIVE}'), 'placeholder replaced');
    player.controller.directive = { focus: 'military', stance: {}, goals: [] };
    const second = await harness.getMenuSystemPrompt();
    assert(second.includes('military'), 'second prompt has the NEW directive (no stale cache)');
});

test('json system prompt file carries the {DIRECTIVE} placeholder', () => {
    const md = readFileSync('src/ai/llm/json/systemPrompt.command.md', 'utf8');
    assert(md.includes('{DIRECTIVE}'), 'placeholder present in command prompt');
    const menuMd = readFileSync('src/ai/llm/menu/systemPrompt.menu.md', 'utf8');
    assert(menuMd.includes('{DIRECTIVE}'), 'placeholder present in menu prompt');
});

test('strategic system prompt states the per-chat order cost', () => {
    const md = readFileSync('src/ai/llm/strategic/systemPrompt.strategic.md', 'utf8');
    assert(/each chat costs 1 order/i.test(md), 'order cost stated');
    assert(md.includes('targetPlayerId'), 'chat-target JSON described');
});

test('strategic system prompt covers all three phases', () => {
    const md = readFileSync('src/ai/llm/strategic/systemPrompt.strategic.md', 'utf8');
    assert(md.includes('Phase 0'), 'trade-review phase present');
    assert(md.includes('cancelTradeIds'), 'review reply shape described');
    assert(md.includes('tradeProposal'), 'chat trade proposal described');
});

console.log('\n## getChatManager routing + step() fallback');

function mockPlayerGameState() {
    const gs = {
        entities: [],
        players: [],
        currentRound: 3,
        manifestData: { entities: {} },
        getActiveTradesForPlayer: () => [],
        cancelTrade: () => true,
    };
    gs.aiHelper = new AiHelper(gs);
    return gs;
}
const RES = { food: 100, gold: 100, iron: 100, wood: 100, gems: 10 };
const ORDERS = { max: 6, perTurn: 5 };

await asyncTest('getChatManager returns the strategic manager when one exists', async () => {
    const gs = mockPlayerGameState();
    const player = new Player(1, 'Blue', gs, '#0000ff', RES, '', { key: 'entity', url: './ai/standard/smartManager.js', config: {} }, ORDERS, false,
        { key: 'strategic-dummy', url: './ai/strategic/dummyStrategicAi.js', config: { directive: { focus: 'economy' } } });
    gs.players = [player, { id: 2, name: 'Red' }];
    const mgr = await player.getChatManager();
    assert(mgr instanceof DummyStrategicAi, `expected DummyStrategicAi, got ${mgr?.constructor?.name}`);
    assert((await player.getStrategicManager()) === mgr, 'strategic manager cached');
});

await asyncTest('getChatManager falls back to the tactical manager when no strategic AI exists', async () => {
    const gs = mockPlayerGameState();
    const player = new Player(2, 'Red', gs, '#ff0000', RES, '', { key: 'standard', url: './ai/standard/smartManager.js', config: {} }, ORDERS);
    gs.players = [player];
    assertEqual(await player.getStrategicManager(), null, 'no strategic manager');
    const mgr = await player.getChatManager();
    assert(mgr && typeof mgr.processTurn === 'function', 'tactical manager returned');
    assert(typeof mgr.runStrategicTurn !== 'function', 'tactical manager is not a strategic one');
});

await asyncTest('getChatManager returns null for a human player', async () => {
    const gs = mockPlayerGameState();
    const player = new Player(3, 'Human', gs, '#00ff00', RES, '', null, ORDERS);
    gs.players = [player];
    assertEqual(await player.getChatManager(), null, 'human has no chat manager');
});

await asyncTest('step(): strategic throw still runs the tactical turn, directive untouched', async () => {
    const gs = mockPlayerGameState();
    const controller = { key: 'entity', url: './ai/standard/smartManager.js', config: {} };
    const player = new Player(1, 'Blue', gs, '#0000ff', RES, '', controller, ORDERS);
    gs.players = [player];
    let tacticalRan = false, ended = false;
    player.getStrategicManager = async () => ({ runStrategicTurn: async () => { throw new Error('king is dead'); } });
    player.getAiManager = async () => ({ processTurn: async () => { tacticalRan = true; } });
    await player.step(() => { ended = true; });
    assert(tacticalRan, 'tactical processTurn ran');
    assert(ended, 'onTurnEnd ran');
    assert(!controller.directive, 'directive untouched');
});

await asyncTest('step(): strategic directive is stored on the tactical controller', async () => {
    const gs = mockPlayerGameState();
    const controller = { key: 'entity', url: './ai/standard/smartManager.js', config: {} };
    const player = new Player(1, 'Blue', gs, '#0000ff', RES, '', controller, ORDERS);
    gs.players = [player];
    player.getStrategicManager = async () => ({
        runStrategicTurn: async () => ({ focus: 'economy', stance: {}, goals: [], setAtTurn: 3, setBy: 'strategic-dummy' })
    });
    player.getAiManager = async () => ({ processTurn: async () => {} });
    await player.step(() => {});
    assertEqual(controller.directive?.focus, 'economy', 'directive stored');
    assertEqual(controller.directive?.setBy, 'strategic-dummy', 'setBy stored');
});

await asyncTest('step(): null directive keeps the last valid one', async () => {
    const gs = mockPlayerGameState();
    const controller = {
        key: 'entity', url: './ai/standard/smartManager.js', config: {},
        directive: { focus: 'military', stance: {}, goals: [], setAtTurn: 2, setBy: 'strategic-dummy' }
    };
    const player = new Player(1, 'Blue', gs, '#0000ff', RES, '', controller, ORDERS);
    gs.players = [player];
    player.getStrategicManager = async () => ({ runStrategicTurn: async () => null });
    player.getAiManager = async () => ({ processTurn: async () => {} });
    await player.step(() => {});
    assertEqual(controller.directive?.focus, 'military', 'last valid kept');
    assertEqual(controller.directive?.setAtTurn, 2, 'stamp untouched');
});

console.log('\n## AiHelper trade methods');

function tradeGameState() {
    const trades = [];
    const gs = {
        entities: [], players: [], currentRound: 5,
        trades,
        getActiveTradesForPlayer: (player) => trades.filter(t => t.active &&
            (String(t.player1Id) === String(player.id) || String(t.player2Id) === String(player.id))),
        cancelTrade: (id) => {
            const t = trades.find(t => t.id === id);
            if (!t) return false;
            t.active = false;
            return true;
        },
    };
    return { gs, trades };
}
function tradePlayer(id, resources, profile) {
    return {
        id, name: `P${id}`,
        resources,
        hasResources: (bundle) => Object.entries(bundle || {}).every(([r, a]) => (resources[r] || 0) >= a),
        getResourceProfile: () => profile,
        getOpponents: () => ({ 2: { id: 2, name: 'Red' } }),
    };
}

await asyncTest('reviewTrades cancels an unaffordable per-turn deal, keeps an affordable one', async () => {
    const { gs, trades } = tradeGameState();
    trades.push(
        { id: 't1', type: 'per_turn', active: true, createdRound: 1, player1Id: 1, player2Id: 2, bundle1: { gold: 50 }, bundle2: { food: 10 } },
        { id: 't2', type: 'per_turn', active: true, createdRound: 1, player1Id: 1, player2Id: 2, bundle1: { food: 5 }, bundle2: { gold: 5 } },
    );
    const helper = new AiHelper(gs);
    const logs = [];
    helper.aiLog = (p, c, m) => logs.push(m);
    let actionDone = 0;
    helper.onActionDone = async () => { actionDone++; };
    await helper.reviewTrades(tradePlayer(1, { gold: 0, food: 100 }));
    assert(!trades[0].active, 'unaffordable deal canceled');
    assert(trades[1].active, 'affordable deal kept');
    assert(logs.some(m => m.includes('t1')), 'cancel logged');
    assertEqual(actionDone, 1, 'onActionDone called once');
});

await asyncTest('reviewTrades skips fresh deals and one-time deals', async () => {
    const { gs, trades } = tradeGameState();
    trades.push(
        { id: 'fresh', type: 'per_turn', active: true, createdRound: 5, player1Id: 1, player2Id: 2, bundle1: { gold: 50 }, bundle2: { food: 10 } },
        { id: 'once', type: 'one_time', active: true, createdRound: 1, player1Id: 1, player2Id: 2, bundle1: { gold: 50 }, bundle2: { food: 10 } },
    );
    const helper = new AiHelper(gs);
    helper.aiLog = () => {};
    await helper.reviewTrades(tradePlayer(1, { gold: 0, food: 100 }));
    assert(trades[0].active, 'fresh deal kept (not yet exchanged)');
    assert(trades[1].active, 'one-time deal untouched');
});

await asyncTest('maybeInitiateTrade proposes a per-turn import for an acute deficit', async () => {
    const { gs } = tradeGameState();
    const helper = new AiHelper(gs);
    const calls = [];
    helper.initiateTrade = async (player, targetId, offer) => {
        calls.push({ targetId, offer });
        return { status: 'accepted' };
    };
    helper.aiLog = () => {};
    const player = tradePlayer(1, { gold: 5, wood: 100 }, {
        stock: { gold: 5, wood: 100 },
        netIncome: { gold: -5, wood: 10 },
        turnsRemaining: { gold: 2 },
        criticalResource: 'gold',
    });
    await helper.maybeInitiateTrade(player);
    assertEqual(calls.length, 1, 'one proposal');
    assertEqual(calls[0].targetId, 2, 'first visible opponent');
    assertEqual(calls[0].offer, { type: 'per_turn', proposerGives: { wood: 3 }, proposerAsks: { gold: 3 } }, 'offer shape');
});

await asyncTest('maybeInitiateTrade cooldown is per-player on the helper', async () => {
    const { gs } = tradeGameState();
    const helper = new AiHelper(gs);
    const calls = [];
    helper.initiateTrade = async (player, targetId, offer) => {
        calls.push(player.id);
        return { status: 'accepted' };
    };
    helper.aiLog = () => {};
    const profile = {
        stock: { gold: 5, wood: 100 },
        netIncome: { gold: -5, wood: 10 },
        turnsRemaining: { gold: 8 },
        criticalResource: 'gold',
    };
    const p1 = tradePlayer(1, { gold: 5, wood: 100 }, profile);
    const p3 = tradePlayer(3, { gold: 5, wood: 100 }, profile);
    await helper.maybeInitiateTrade(p1);
    await helper.maybeInitiateTrade(p1);
    assertEqual(calls, [1], 'same player cannot propose twice in the cooldown window');
    await helper.maybeInitiateTrade(p3);
    assertEqual(calls, [1, 3], 'a different player is not blocked by the first cooldown');
});

await asyncTest('maybeInitiateTrade stays silent with no deficit or no surplus', async () => {
    const { gs } = tradeGameState();
    const helper = new AiHelper(gs);
    const calls = [];
    helper.initiateTrade = async () => { calls.push(1); return { status: 'accepted' }; };
    helper.aiLog = () => {};
    await helper.maybeInitiateTrade(tradePlayer(1, { gold: 100, wood: 100 }, {
        stock: { gold: 100, wood: 100 }, netIncome: { gold: 1, wood: 1 },
        turnsRemaining: { gold: Infinity }, criticalResource: null,
    }));
    await helper.maybeInitiateTrade(tradePlayer(1, { gold: 5, wood: 5 }, {
        stock: { gold: 5, wood: 5 }, netIncome: { gold: -5, wood: -1 },
        turnsRemaining: { gold: 2 }, criticalResource: 'gold',
    }));
    assertEqual(calls, [], 'no proposals');
});

await asyncTest('helper.reviewTrades is reachable through the proxy (dummy via createAiManager)', async () => {
    const { gs, trades } = tradeGameState();
    trades.push({ id: 't1', type: 'per_turn', active: true, createdRound: 1, player1Id: 1, player2Id: 2, bundle1: { gold: 50 }, bundle2: { food: 10 } });
    const helper = new AiHelper(gs);
    helper.aiLog = () => {};
    helper.onActionDone = async () => {};
    const realPlayer = {
        id: 1, name: 'Blue',
        resources: { gold: 0, food: 100 }, orders: 5,
        getEntities: () => [],
        controller: { config: {} },
        strategicController: {
            key: 'strategic-dummy',
            url: './ai/strategic/dummyStrategicAi.js',
            config: { directive: { focus: 'balanced', stance: {}, goals: [] } }
        },
        hasResources: (b) => Object.entries(b || {}).every(([r, a]) => (realPlayer.resources[r] || 0) >= a),
        getResourceProfile: () => ({ criticalResource: null, netIncome: {}, stock: realPlayer.resources }),
        getOpponents: () => ({}),
    };
    gs.players = [realPlayer];
    const mgr = createAiManager(DummyStrategicAi, realPlayer, helper);
    const directive = await mgr.runStrategicTurn();
    assert(!trades[0].active, 'unaffordable deal canceled through the proxied helper');
    assert(directive && directive.focus === 'balanced', 'directive returned');
});

console.log('\n## Strategic trade initiation inline with chat (real AiHelper)');

// Part 2 probe: the strategic harness's chat-phase trade proposal, driven
// end to end through the REAL AiHelper.chat + AiHelper.initiateTrade, with
// scripted LLM clients on both sides. The only calls the test itself makes
// are runStrategicTurn() on Blue's manager — the chat, the proposal, the
// target's evaluation, and the recording in the thread all happen through
// the production machinery. The fake gameState implements exactly the
// surface initiateTrade/chat need (validateTradeOffer, addChatMessage /
// getChatHistory, executeOneTimeTrade, getPlayerById, onActionDone).
function inlineTradeSetup() {
    const threads = new Map();
    const keyFor = (a, b) => [a.id, b.id].sort((x, y) => x - y).join(':');
    const trades = [];
    const stock = () => ({ gold: 100, wood: 100, food: 100, iron: 100, gems: 10 });
    let blueMgr, redMgr;
    const notes = [];
    const bluePlayer = {
        id: 1, name: 'Blue', description: '', orders: 6, maxOrders: 6, isAI: true,
        resources: stock(), score: { military: 10, economic: 20, exploration: 5, total: 10 },
        exploredCells: new Set(['0,0']),
        controller: { key: 'entity', config: {} },
        strategicController: { key: 'strategic-llm', config: { provider: 'local', model: 'x' } },
        getResourceProfile: () => ({ stock: { ...bluePlayer.resources }, netIncome: { gold: 1, wood: 1, food: 1, iron: 1, gems: 0 }, turnsRemaining: {}, criticalResource: null, activeTrades: [] }),
        getEntities: () => [],
        getOpponents: () => ({ 2: { id: 2, name: 'Red', score: { total: 5 }, entities: [] } }),
        getHistory: () => [],
        hasResources: (bundle) => Object.entries(bundle || {}).every(([r, a]) => (bluePlayer.resources[r] || 0) >= a),
        consumeOrders: (n) => { if (bluePlayer.orders < n) return false; bluePlayer.orders -= n; return true; },
        addHistoryEntry: (round, entry) => notes.push(entry),
        getChatManager: async () => blueMgr,
    };
    const redPlayer = {
        id: 2, name: 'Red', description: '', orders: 6, maxOrders: 6, isAI: true,
        resources: stock(), score: { military: 8, economic: 12, exploration: 4, total: 8 },
        exploredCells: new Set(['1,1']),
        controller: { key: 'llm-menu', config: {} },
        getResourceProfile: () => ({ stock: { ...redPlayer.resources }, netIncome: { gold: 1, wood: 1, food: 1, iron: 1, gems: 0 }, turnsRemaining: {}, criticalResource: null, activeTrades: [] }),
        getEntities: () => [],
        getOpponents: () => ({ 1: { id: 1, name: 'Blue', score: { total: 10 }, entities: [] } }),
        getHistory: () => [],
        hasResources: (bundle) => Object.entries(bundle || {}).every(([r, a]) => (redPlayer.resources[r] || 0) >= a),
        consumeOrders: (n) => { if (redPlayer.orders < n) return false; redPlayer.orders -= n; return true; },
        addHistoryEntry: (round, entry) => notes.push(entry),
        getChatManager: async () => redMgr,
    };
    const gs = {
        entities: [], players: [bluePlayer, redPlayer], currentRound: 3, settings: {},
        getPlayerById: (id) => gs.players.find(p => String(p.id) === String(id)) || null,
        addChatMessage: (sender, receiver, content, ended = false, emote = null) => {
            const key = keyFor(sender, receiver);
            if (!threads.has(key)) threads.set(key, []);
            threads.get(key).push({ sender: sender.name, senderId: sender.id, content, ended, emote, round: gs.currentRound });
        },
        getChatHistory: (a, b) => [...(threads.get(keyFor(a, b)) || [])],
        getActiveTradesForPlayer: () => [],
        cancelTrade: () => true,
        validateTradeOffer: (proposer, target, offer) => {
            if (!proposer || !target || String(proposer.id) === String(target.id)) return { ok: false, reason: 'bad players' };
            const okBundle = (b) => b && typeof b === 'object' && Object.keys(b).length > 0
                && Object.values(b).every(v => typeof v === 'number' && v > 0);
            if (!okBundle(offer?.proposerGives) || !okBundle(offer?.proposerAsks)) return { ok: false, reason: 'bad bundles' };
            if (offer.type === 'one_time' && !proposer.hasResources(offer.proposerGives)) return { ok: false, reason: 'cannot afford' };
            return { ok: true };
        },
        executeOneTimeTrade: (proposer, receiver, gives, asks) => {
            for (const [r, a] of Object.entries(gives)) { proposer.resources[r] -= a; receiver.resources[r] = (receiver.resources[r] || 0) + a; }
            for (const [r, a] of Object.entries(asks)) { receiver.resources[r] -= a; proposer.resources[r] = (proposer.resources[r] || 0) + a; }
            return { success: true };
        },
        createPerTurnTrade: (p1, p2, b1, b2) => {
            const t = { id: `trade-${trades.length + 1}`, type: 'per_turn', player1Id: p1.id, player2Id: p2.id, bundle1: b1, bundle2: b2 };
            trades.push(t);
            return t;
        },
        onActionDone: async () => {},
    };
    const helper = new AiHelper(gs);
    helper.aiLog = () => {};
    blueMgr = new LlmStrategicManager(bluePlayer, helper);
    redMgr = new MenuHarness(redPlayer, helper);
    return { gs, threads, bluePlayer, redPlayer, blueMgr, redMgr, helper };
}

await asyncTest('strategic chat-phase trade proposal is negotiated in the chat thread (real AiHelper)', async () => {
    const { threads, bluePlayer, redPlayer, blueMgr, redMgr } = inlineTradeSetup();
    let handleCalls = 0;
    const origHandle = redMgr.handleTradeOffer.bind(redMgr);
    redMgr.handleTradeOffer = async (...args) => { handleCalls++; return origHandle(...args); };
    // Blue's client, in call order: chat target (+ proposal), chat opening,
    // chat summary, next chat target (null), directive. (No trade-review
    // call: no active trades, so the review phase spends no LLM call.)
    const blueClient = scriptedClient([
        '{"targetPlayerId": 2, "tradeProposal": {"type": "one_time", "gives": {"wood": 5}, "asks": {"gold": 5}}}',
        'Greetings, Red. Shall we talk trade? [END_CHAT]',
        'Chatted with Red about trade.',
        '{"targetPlayerId": null}',
        '{"focus": "balanced"}',
    ]);
    blueMgr.getLLMClient = () => blueClient;
    blueMgr.getStrategicSystemPrompt = async () => 'TEST STRATEGIC PROMPT';
    // Red's client, in call order: chat reply (ends the loop), chat
    // summary, trade-offer evaluation (accept).
    const redClient = scriptedClient([
        'Red here — I am listening. [END_CHAT]',
        'Chatted with Blue.',
        '{"action": "accept", "message": "Agreed, Blue — a fair exchange."}',
    ]);
    redMgr.getLLMClient = () => redClient;

    const d = await blueMgr.runStrategicTurn();
    assert(d && d.focus === 'balanced', 'directive still produced');
    assertEqual(bluePlayer.orders, 5, 'one chat deducted exactly 1 order');
    assertEqual(handleCalls, 1, 'target handleTradeOffer invoked once');
    const thread = threads.get('1:2') || [];
    assertEqual(thread.length, 5, 'thread holds opening, reply, proposal, decision, acceptance');
    assert(thread[0].sender === 'Blue' && thread[0].content.includes('Greetings'), 'opening first');
    assert(thread[1].sender === 'Red', 'reply second');
    assert(thread[2].sender === 'Blue' && /Trade Proposal/.test(thread[2].content)
        && thread[2].content.includes('5 wood') && thread[2].content.includes('5 gold'), 'proposal recorded in thread');
    assert(thread[3].sender === 'Red' && thread[3].content.includes('Agreed, Blue'), 'decision message in thread');
    assert(thread[4].sender === 'Red' && /Trade accepted/.test(thread[4].content), 'acceptance recorded in thread');
    assertEqual(bluePlayer.resources.wood, 95, 'Blue sent 5 wood');
    assertEqual(bluePlayer.resources.gold, 105, 'Blue received 5 gold');
    assertEqual(redPlayer.resources.wood, 105, 'Red received 5 wood');
    assertEqual(redPlayer.resources.gold, 95, 'Red sent 5 gold');
});

console.log(`\nstrategic.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
