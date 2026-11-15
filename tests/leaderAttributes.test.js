/**
 * Node-based tests for leader attributes (twists, Phase 25) and the
 * barbarian encounter mechanic.
 * Run from the repo root with:
 *   node --import ./tests/headless/stubs.mjs --loader ./tests/headless/loader.mjs --input-type=module -e "import('./tests/leaderAttributes.test.js')"
 *
 * Uses mocked game states and a small inline leaders list — no browser,
 * no live game. One test also reads the real definitions/leaders.json to
 * pin Meera's score multiplier.
 *
 * This tests GAME code (Player/Entity/barbarians/AI proxy), so it lives in
 * the root tests dir, not under src/ai. The src/ai boundary is strict in
 * both directions.
 */
import { readFileSync } from 'fs';
import Entity from '../src/entity.js';
import { Player } from '../src/player.js';
import { barbarianTargetProbability, clearDecisionsIfDamaged } from '../src/barbarians/manager.js';
import { createGameStateProxy, createAiManager } from '../src/aiInterfaceProxy.js';
import { AiHelper } from '../src/aiHelper.js';
import { calculateAttackMultiplier } from '../src/utils.js';

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
function assertClose(a, b, msg) {
  if (Math.abs(a - b) > 1e-9) throw new Error(`${msg} (got ${a}, want ${b})`);
}
function assertDeepEqual(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg} (got ${sa}, want ${sb})`);
}

// --- fixtures ---------------------------------------------------------------

const LEADERS = [
  {
    name: 'Meera',
    attributes: {
      economyMultipliers: { income: { gems: 1.5 }, spawnCost: { worker: 0.8 }, maintenanceCost: { farm: 0.8 } },
      combatMultipliers: { damage: { slashing: 1.2 }, armor: { slashing: 1.5 }, attackCost: { swordsman: 1.2 }, damageVs: { horseman: 1.2 }, terrain: { Desert: 1.2 } },
      movementCostMultiplier: { Desert: 0.5 },
      scoreMultiplier: { economic: 1.1 },
      barbarianAggressionMultiplier: 0.8,
    },
  },
  { name: 'Anselm', attributes: { barbarianAggressionMultiplier: 0.8 } },
];

// Manifest entity definitions the Player functions read. These mirror the
// meta passed to makeEntity in the tests below, so the Player functions
// (which read the manifest by name) and the entity's own state agree — as
// they do in a real game, where the entity is built from the manifest.
const TEST_ENTITIES = {
  mine: { yields: { gems: 2, iron: 4 } },
  farm: { maintenance: { food: 5, gold: 2 }, yields: { gold: 4, food: 2 } },
  worker: { spawnCost: { food: 10, wood: 4 }, maintenance: { gold: 2 }, attackCostScale: 10 },
  scout: { movement: { terrainCostScale: { Desert: 2 } } },
  barbarian: { movement: { terrainCostScale: { Desert: 2 } }, armor: {}, damage: { value: 5, type: 'blunt' } },
  swordsman: {
    movement: {},
    armor: { slashing: 2, blunt: 1 },
    damage: { value: 5, type: 'slashing' },
    attackCostScale: 10,
    spawnCost: { food: 10, gold: 5 },
    maintenance: { gold: 2 },
    yields: { gold: 4 },
  },
  pikeman: { damage: { value: 4, type: 'polearm' }, armor: { polearm: 1 } },
};

function mockGameState(leaders = LEADERS, entities = TEST_ENTITIES) {
  return {
    manifestData: { leaders, entities, naturalResources: [] },
    entities: [],
    hexGrid: null,
    currentRound: 1,
    random: Math.random,
    players: [],
    isVisibleToHuman: () => false,
  };
}

function aiPlayer(name, gs, controller = { url: 'test://meera' }) {
  // Simulates setup (buildController): the leader's attributes ride on
  // the controller, and the Player copies them at construction. The
  // Player itself never looks a leader up by name — this helper is the
  // only place a name is resolved, exactly as setup does it.
  const leader = (gs.manifestData?.leaders || []).find(l => l.name === name);
  const ctrl = { ...controller };
  if (leader?.attributes) ctrl.attributes = { ...leader.attributes };
  return new Player(1, name, gs, 'red', {}, '', ctrl);
}
function humanPlayer(name, gs) {
  return new Player(2, name, gs, 'blue', {}, '', null);
}

// --- Player.attributes ------------------------------------------------------

test('human player gets no twists even when named after a leader', () => {
  const gs = mockGameState();
  const p = humanPlayer('Meera', gs);
  assert(Object.keys(p.attributes).length === 0, 'human should have empty attributes');
});

test('AI player resolves its leader attributes by name', () => {
  const gs = mockGameState();
  const p = aiPlayer('Meera', gs);
  assert(p.attributes.scoreMultiplier?.economic === 1.1, 'Meera economic score multiplier');
  assert(p.attributes.economyMultipliers?.income?.gems === 1.5, 'Meera gems income');
});

test('AI player with an unmatched name gets no twists', () => {
  const gs = mockGameState();
  const p = aiPlayer('Nobody', gs);
  assert(Object.keys(p.attributes).length === 0, 'unmatched AI should have empty attributes');
});

test('AI player with no leaders in the manifest gets no twists', () => {
  const gs = mockGameState([]);
  const p = aiPlayer('Meera', gs);
  assert(Object.keys(p.attributes).length === 0, 'missing leaders should give empty attributes');
});

// --- score ------------------------------------------------------------------

test('recalculateScore applies the economic score multiplier (Meera 1.1)', () => {
  const gs = mockGameState();
  const p = aiPlayer('Meera', gs);
  // One owned entity with score 10/10; 8 explored/visible cells so the
  // geometric mean is non-zero (exploration = round((8*8)^(1/3)) = 4).
  gs.entities.push({ owner: p, state: { score: { military: 10, economic: 10 } } });
  const cells = ['0,0', '1,0', '0,1', '1,1', '2,0', '0,2', '2,2', '1,2'];
  p.visibleCells = new Set(cells);
  p.exploredCells = new Set(cells);
  p.recalculateScore();
  assertClose(p.score.military, 10, 'military unchanged');
  assertClose(p.score.economic, 11, 'economic x1.1');
  assertClose(p.score.exploration, 4, 'exploration unchanged');
  // total = round((10 * 11 * 4)^(1/3)) = round(7.59) = 8
  assert(p.score.total === 8, `total should be 8, got ${p.score.total}`);
});

test('recalculateScore without a multiplier leaves scores unchanged', () => {
  const gs = mockGameState();
  const p = humanPlayer('Human', gs);
  gs.entities.push({ owner: p, state: { score: { military: 10, economic: 10 } } });
  const cells = ['0,0', '1,0', '0,1', '1,1', '2,0', '0,2', '2,2', '1,2'];
  p.visibleCells = new Set(cells);
  p.exploredCells = new Set(cells);
  p.recalculateScore();
  assertClose(p.score.economic, 10, 'economic unchanged for human');
  assert(p.score.total === 7, `total should be 7, got ${p.score.total}`);
});

// --- entity economy ---------------------------------------------------------

function makeEntity(name, data, owner, gs) {
  const cell = { q: 0, r: 0, terrain: { name: 'Grasslands', movementCost: 1, height: 1 } };
  return new Entity({ name, ...data }, owner, gs, cell);
}

test('yields apply the income multiplier per resource', () => {
  const gs = mockGameState();
  const p = aiPlayer('Meera', gs);
  const e = makeEntity('mine', { yields: { gems: 2, iron: 4 } }, p, gs);
  assertClose(e.yields.gems, 3, 'gems 2 x 1.5');
  assertClose(e.yields.iron, 4, 'iron unchanged (no multiplier)');
});

test('getCostToMaintain applies the maintenance multiplier per entity', () => {
  const gs = mockGameState();
  const p = aiPlayer('Meera', gs);
  const e = makeEntity('farm', { maintenance: { food: 5, gold: 2 } }, p, gs);
  const cost = e.getCostToMaintain();
  assertClose(cost.food, 4, 'farm food 5 x 0.8');
  assertClose(cost.gold, 1.6, 'farm gold 2 x 0.8');
});

test('getCostToSpawn applies the spawn multiplier per entity', () => {
  const gs = mockGameState();
  const p = aiPlayer('Meera', gs);
  const e = makeEntity('worker', { spawnCost: { food: 10, wood: 4 } }, p, gs);
  const cost = e.getCostToSpawn();
  assertClose(cost.food, 8, 'worker food 10 x 0.8');
  assertClose(cost.wood, 3.2, 'worker wood 4 x 0.8');
});

test('getCostToMaintain without a multiplier is unchanged', () => {
  const gs = mockGameState();
  const p = humanPlayer('Human', gs);
  const e = makeEntity('farm', { maintenance: { food: 5 } }, p, gs);
  assertClose(e.getCostToMaintain().food, 5, 'human farm maintenance unchanged');
});

// --- movement ---------------------------------------------------------------

test('getMovementCost applies the movement multiplier per terrain', () => {
  const gs = mockGameState();
  const p = aiPlayer('Meera', gs);
  const e = makeEntity('scout', { movement: { terrainCostScale: { Desert: 2 } } }, p, gs);
  const desert = { name: 'Desert', movementCost: 1 };
  const grass = { name: 'Grasslands', movementCost: 1 };
  assertClose(e.getMovementCost(desert), 1, 'Desert 1 x 2 x 0.5');
  assertClose(e.getMovementCost(grass), 1, 'Grasslands 1 x 1 x 1');
});

test('getMovementCost for an ownerless entity ignores the multiplier', () => {
  const gs = mockGameState();
  const e = makeEntity('barbarian', { movement: { terrainCostScale: { Desert: 2 } } }, null, gs);
  const desert = { name: 'Desert', movementCost: 1 };
  assertClose(e.getMovementCost(desert), 2, 'barbarian Desert 1 x 2 x 1');
});

// --- combat: armor + barbarian decision clear -------------------------------

test('receiveDamage scales armor by the defender multiplier and terrain', () => {
  const gs = mockGameState();
  const p = aiPlayer('Meera', gs);
  const e = makeEntity('swordsman', { armor: { slashing: 2 }, damage: { value: 5, type: 'slashing' } }, p, gs);
  // Cell terrain is Grasslands (no terrain multiplier); armor slashing 1.5.
  // 10 slashing damage / (2 x 1.5) = 3.3 (rounded to 1dp).
  e.receiveDamage({ value: 10, type: 'slashing' });
  assertClose(e.health, 100 - 3.3, 'health after armor-scaled damage');
});

test('receiveDamage without a multiplier divides by base armor only', () => {
  const gs = mockGameState();
  const p = humanPlayer('Human', gs);
  const e = makeEntity('swordsman', { armor: { slashing: 2 } }, p, gs);
  e.receiveDamage({ value: 10, type: 'slashing' });
  assertClose(e.health, 95, 'health after base armor damage');
});

// --- barbarian decision memory (manager owns it, not Entity) -------------

test('clearDecisionsIfDamaged clears decisions when health dropped', () => {
  const gs = mockGameState();
  const e = makeEntity('barbarian', { armor: {} }, null, gs);
  e.state.previousHealth = 100;
  e.state.barbarianDecisions = { someEntity: 'ignore', otherEntity: 'target' };
  e.health = 80;
  clearDecisionsIfDamaged(e);
  assert(Object.keys(e.state.barbarianDecisions).length === 0, 'decisions cleared after damage');
});

test('clearDecisionsIfDamaged keeps decisions when health is unchanged', () => {
  const gs = mockGameState();
  const e = makeEntity('barbarian', { armor: {} }, null, gs);
  e.state.previousHealth = 100;
  e.state.barbarianDecisions = { someEntity: 'ignore' };
  e.health = 100;
  clearDecisionsIfDamaged(e);
  assert(Object.keys(e.state.barbarianDecisions).length === 1, 'decisions kept when undamaged');
});

test('clearDecisionsIfDamaged keeps decisions when healed above previous', () => {
  const gs = mockGameState();
  const e = makeEntity('barbarian', { armor: {} }, null, gs);
  e.state.previousHealth = 80;
  e.state.barbarianDecisions = { someEntity: 'ignore' };
  e.health = 90;
  clearDecisionsIfDamaged(e);
  assert(Object.keys(e.state.barbarianDecisions).length === 1, 'decisions kept when healed');
});

test('clearDecisionsIfDamaged is a no-op on the first turn (no previousHealth)', () => {
  const gs = mockGameState();
  const e = makeEntity('barbarian', { armor: {} }, null, gs);
  e.state.barbarianDecisions = { someEntity: 'ignore' };
  e.health = 80;
  clearDecisionsIfDamaged(e);
  assert(Object.keys(e.state.barbarianDecisions).length === 1, 'decisions kept on first turn');
});

// --- barbarian target probability -------------------------------------------

test('barbarianTargetProbability: leader at max score is P = aggression', () => {
  const gs = mockGameState();
  const leader = aiPlayer('Meera', gs);
  const other = aiPlayer('Anselm', gs);
  leader.score = { total: 100, military: 0, economic: 0, exploration: 0 };
  other.score = { total: 50, military: 0, economic: 0, exploration: 0 };
  gs.players = [leader, other];
  // Meera's own aggression multiplier is 0.8 (she is the owner here).
  const p = barbarianTargetProbability({ aggression: 1 }, gs, leader);
  assertClose(p, 0.8, 'P = 1 x 0.8 x (100/100)^3');
});

test('barbarianTargetProbability: trailing player is cubed down', () => {
  const gs = mockGameState();
  const leader = aiPlayer('Meera', gs);
  const other = aiPlayer('Anselm', gs);
  leader.score = { total: 100, military: 0, economic: 0, exploration: 0 };
  other.score = { total: 50, military: 0, economic: 0, exploration: 0 };
  gs.players = [leader, other];
  // Anselm's multiplier is 0.8 too; (50/100)^3 = 0.125 -> P = 0.1.
  const p = barbarianTargetProbability({ aggression: 1 }, gs, other);
  assertClose(p, 0.1, 'P = 1 x 0.8 x 0.125');
});

test('barbarianTargetProbability: all scores zero guards to ratio 1', () => {
  const gs = mockGameState();
  const leader = aiPlayer('Meera', gs);
  const other = aiPlayer('Anselm', gs);
  leader.score = { total: 0, military: 0, economic: 0, exploration: 0 };
  other.score = { total: 0, military: 0, economic: 0, exploration: 0 };
  gs.players = [leader, other];
  const p = barbarianTargetProbability({ aggression: 1 }, gs, leader);
  assertClose(p, 0.8, 'P = 1 x 0.8 x 1 (guard)');
});

test('barbarianTargetProbability: defaults to aggression 1 and multiplier 1', () => {
  const gs = mockGameState();
  const leader = aiPlayer('Meera', gs);
  leader.score = { total: 100, military: 0, economic: 0, exploration: 0 };
  gs.players = [leader];
  const p = barbarianTargetProbability({}, gs, null);
  assertClose(p, 0, 'ownerless target with max > 0 has score 0 -> P = 0');
  const p2 = barbarianTargetProbability({ aggression: 2 }, gs, leader);
  assertClose(p2, 1, 'P clamps to 1 (2 x 0.8 = 1.6)');
});

// --- real leaders.json ------------------------------------------------------

test('real leaders.json: Meera has scoreMultiplier.economic 1.1', () => {
  const leaders = JSON.parse(readFileSync(new URL('../definitions/leaders.json', import.meta.url), 'utf-8'));
  const meera = leaders.find(l => l.name === 'Meera');
  assert(meera, 'Meera exists in leaders.json');
  assert(meera.attributes?.scoreMultiplier?.economic === 1.1, 'Meera economic score multiplier is 1.1');
});

// --- Player functions: the AI sees the real (twist-adjusted) values -----
// The adjustment multipliers live only in the Player class; the engine and
// the AI both call these. A leader with a fuller twist set than Meera, so
// every multiplier path is covered.

const twistAttrs = {
  economyMultipliers: {
    income: { gold: 2 },
    spawnCost: { swordsman: 0.5 },
    maintenanceCost: { swordsman: 1.5 },
  },
  combatMultipliers: {
    damage: { slashing: 1.2 },
    armor: { slashing: 0.5 },
    attackCost: { swordsman: 0.8 },
    damageVs: { pikeman: 2 },
    terrain: { Desert: 1.5 },
  },
  movementCostMultiplier: { Desert: 0.5 },
};
const TWIST_LEADER = { name: 'Twisty', attributes: twistAttrs };

function twistPlayer(gs = mockGameState([TWIST_LEADER])) {
  return aiPlayer('Twisty', gs);
}

test('getSpawnCost scales per-entity, defaults to 1', () => {
  const p = twistPlayer();
  assertDeepEqual(p.getSpawnCost('swordsman'), { food: 5, gold: 2.5 }, 'discounted');
  assertDeepEqual(p.getSpawnCost('worker'), { food: 10, wood: 4 }, 'unlisted type unchanged');
  const human = humanPlayer('Human', mockGameState([TWIST_LEADER]));
  assertDeepEqual(human.getSpawnCost('swordsman'), { food: 10, gold: 5 }, 'human (no twists) unchanged');
});

test('getYields scales per-resource, defaults to 1', () => {
  const p = twistPlayer();
  assertDeepEqual(p.getYields('farm'), { gold: 8, food: 2 }, 'gold doubled, food unchanged');
  const human = humanPlayer('Human', mockGameState([TWIST_LEADER]));
  assertDeepEqual(human.getYields('farm'), { gold: 4, food: 2 }, 'human unchanged');
});

test('getMaintenanceCost scales per-entity, defaults to 1', () => {
  const p = twistPlayer();
  assertDeepEqual(p.getMaintenanceCost('swordsman'), { gold: 3 }, '1.5x upkeep');
  assertDeepEqual(p.getMaintenanceCost('worker'), { gold: 2 }, 'unlisted type unchanged');
});

test('getAttackCost scales per-entity, defaults to 1', () => {
  const p = twistPlayer();
  assert(p.getAttackCost('swordsman') === 8, '0.8x cost');
  assert(p.getAttackCost('worker') === 10, 'unlisted type unchanged');
  const human = humanPlayer('Human', mockGameState([TWIST_LEADER]));
  assert(human.getAttackCost('swordsman') === 10, 'human unchanged');
});

test('getAttackValue applies damage type, damageVs and terrain multipliers', () => {
  const p = twistPlayer();
  // swordsman damage is { value: 5, type: 'slashing' } in the manifest.
  const generic = p.getAttackValue('swordsman');
  assertClose(generic.value, 6, 'damage-type only (5 x 1.2)');
  assert(generic.type === 'slashing', 'type is slashing');
  assertClose(p.getAttackValue('swordsman', { targetType: 'pikeman' }).value, 12, 'plus damageVs (5 x 1.2 x 2)');
  assertClose(p.getAttackValue('swordsman', { targetType: 'pikeman', terrainType: 'Desert' }).value, 18, 'plus terrain (5 x 1.2 x 2 x 1.5)');
  assertClose(p.getAttackValue('barbarian').value, 5, 'unlisted damage type unchanged (blunt)');
});

test('getArmorValue returns one value per damage type, with armor and terrain multipliers', () => {
  const p = twistPlayer();
  // swordsman armor is { slashing: 2, blunt: 1 } in the manifest.
  const armor = p.getArmorValue('swordsman');
  assertClose(armor.slashing, 1, 'armor-type only (2 x 0.5)');
  assertClose(armor.blunt, 1, 'unlisted armor type unchanged');
  const desert = p.getArmorValue('swordsman', { terrainType: 'Desert' });
  assertClose(desert.slashing, 1.5, 'plus terrain (2 x 0.5 x 1.5)');
  assertClose(desert.blunt, 1.5, 'terrain applies to every type');
  // A damage type the entity has no armor for still defends at base 1,
  // scaled by its armor and terrain multipliers (poison is the only such
  // type today).
  assertClose(armor.poison, 1, 'missing type defends at 1');
});

test('getMovementCostMultiplier scales per-terrain, defaults to 1', () => {
  const p = twistPlayer();
  assert(p.getMovementCostMultiplier('Desert') === 0.5, 'Desert halved');
  assert(p.getMovementCostMultiplier('Grasslands') === 1, 'unlisted terrain unchanged');
});

test('getAttackValue / getArmorValue return fresh objects (manifest never mutated)', () => {
  const gs = mockGameState([TWIST_LEADER]);
  const p = aiPlayer('Twisty', gs);
  const cost = p.getSpawnCost('swordsman');
  cost.food = 999;
  assertDeepEqual(gs.manifestData.entities.swordsman.spawnCost, { food: 10, gold: 5 }, 'manifest spawnCost untouched');
  const armor = p.getArmorValue('swordsman');
  armor.slashing = 999;
  assert(gs.manifestData.entities.swordsman.armor.slashing === 2, 'manifest armor untouched');
});

// --- AI proxy isolation: visible entity properties and empire privacy --------

class NoopManager {
  constructor(player, helper) {
    this.player = player;
    this.helper = helper;
  }
}

function proxyFixture() {
  const gs = mockGameState();
  const p1 = aiPlayer('Meera', gs); // own twists: income gems 1.5, desert move 0.5
  const p2 = new Player(2, 'Anselm', gs, 'blue', {}, '', {
    url: 'test://anselm',
    attributes: {
      economyMultipliers: {
        income: { gold: 2 },
        maintenanceCost: { farm: 0.5 },
        spawnCost: { worker: 0.5 },
      },
      movementCostMultiplier: { Grasslands: 0.5, Desert: 0.5 },
      combatMultipliers: { damage: { slashing: 2 }, armor: { slashing: 2 } },
    },
  });
  const ownFarm = makeEntity('farm', TEST_ENTITIES.farm, p1, gs);
  const ownMine = makeEntity('mine', TEST_ENTITIES.mine, p1, gs);
  const ownSword = makeEntity('swordsman', TEST_ENTITIES.swordsman, p1, gs);
  const ownScout = makeEntity('scout', TEST_ENTITIES.scout, p1, gs);
  const foreignFarm = makeEntity('farm', TEST_ENTITIES.farm, p2, gs);
  const foreignWorker = makeEntity('worker', TEST_ENTITIES.worker, p2, gs);
  const foreignSword = makeEntity('swordsman', TEST_ENTITIES.swordsman, p2, gs);
  const foreignScout = makeEntity('scout', TEST_ENTITIES.scout, p2, gs);

  gs.players = [p1, p2];
  gs.entities = [ownFarm, ownMine, ownSword, ownScout, foreignFarm, foreignWorker, foreignSword, foreignScout];
  gs.hexGrid = { getNeighbors: () => [], getCell: () => null };
  gs.getEntityAt = () => null;
  p1.visibleCells = new Set(['0,0']);
  p1.exploredCells = new Set(['0,0']);

  const proxy = createGameStateProxy(gs, p1, 'test');
  const find = (name, owner) => proxy.entities.find(e => e.name === name && e.owner?.id === owner.id);
  return {
    gs, p1, p2, proxy,
    ownFarm, ownMine, ownSword, ownScout,
    foreignFarm, foreignWorker, foreignSword, foreignScout,
    ownFarmP: find('farm', p1), ownMineP: find('mine', p1),
    ownSwordP: find('swordsman', p1), ownScoutP: find('scout', p1),
    foreignFarmP: find('farm', p2), foreignWorkerP: find('worker', p2),
    foreignSwordP: find('swordsman', p2), foreignScoutP: find('scout', p2),
  };
}

test('AI proxy: visible foreign entity properties are adjusted; empire profile is hidden', () => {
  const f = proxyFixture();
  // Adjusted instance properties of a VISIBLE foreign entity are public.
  assertDeepEqual(f.foreignFarmP.getCostToMaintain(), { food: 2.5, gold: 1 }, 'foreign farm maintenance adjusted');
  assertDeepEqual(f.foreignWorkerP.getCostToSpawn(), { food: 5, wood: 2 }, 'foreign worker spawn adjusted');
  assert(
    typeof f.foreignScoutP.getMovementCost === 'undefined',
    'foreign movement cost hidden'
  );
  assertClose(f.foreignFarmP.yields.gold, 8, 'foreign visible yields adjusted');
  assertClose(f.foreignFarmP.baseYields.gold, 4, 'base yields stay the public base');
  assert(/8 gold/.test(f.foreignFarmP.info()), 'foreign info shows adjusted yields');
  assert(/Atk: 10/.test(f.foreignSwordP.info()), 'foreign info shows adjusted attack (5 x 2)');
  assertClose(f.foreignFarm.getCostToMaintain().food, 2.5, 'direct foreign maintenance adjusted');

  // Own twists still apply.
  assertDeepEqual(f.ownFarmP.getCostToMaintain(), { food: 4, gold: 1.6 }, 'own farm maintenance twisted');
  assertClose(f.ownMineP.yields.gems, 3, 'own mine yields twisted');
  assertClose(
    f.ownScoutP.getMovementCost({ terrain: { name: 'Desert', movementCost: 1 } }),
    1,
    'own movement: Desert scale 2 x 0.5 twist'
  );

  // The total empire resource profile of another player stays private.
  const foreignPlayer = f.proxy.players.find(p => p.id === f.p2.id);
  assert(foreignPlayer.resources === undefined, 'foreign resources hidden');
  assert(foreignPlayer.history === undefined, 'foreign history hidden');
  assert(foreignPlayer.orders === undefined, 'foreign orders hidden');
  assert(foreignPlayer.attributes === undefined, 'foreign twist map hidden');
  assert(foreignPlayer.getResourceProfile() === undefined, 'foreign resource profile hidden');
  // The AI's own profile is available.
  const ownPlayer = f.proxy.players.find(p => p.id === f.p1.id);
  assert(ownPlayer.getResourceProfile()?.stock, 'own resource profile visible');
});

test('AI proxy: visible foreign entity combat properties are adjusted', () => {
  const f = proxyFixture();
  const mgr = createAiManager(NoopManager, f.p1, new AiHelper(f.gs));

  // Foreign visible swordsman: 5 x 2 dmg * 100 hp + (2 x 2 slashing + 1 blunt) * 10 = 1050.
  assertClose(mgr.helper.getCombatPower(f.foreignSwordP), 1050, 'foreign visible power adjusted');
  // Own (Meera): 5 x 1.2 dmg * 100 + (2 x 1.5 + 1) * 10 = 640.
  assertClose(mgr.helper.getCombatPower(f.ownSwordP), 640, 'own power twisted');

  const sorted = mgr.helper.getEntitiesSortedByPower(
    [f.foreignSword, f.ownSword], { entities: TEST_ENTITIES }, false
  );
  assert(sorted[0].id === f.foreignSword.id, 'adjusted foreign unit ranks above own');

  // Visible entity properties are public in BOTH engine and AI views.
  // A construct target isolates the leader-twist factor without needing the
  // hex direction lookup from the mock grid.
  const target = f.ownFarm;
  const base = calculateAttackMultiplier(f.gs, null, 0, target, null);
  const engineForeign = calculateAttackMultiplier(f.gs, null, 0, target, f.foreignSword);
  const aiForeign = mgr.helper.calculateAttackMultiplier(f.gs, null, 0, target, f.foreignSwordP);
  assertClose(engineForeign.total / base.total, 2, 'foreign damage twist in engine view');
  assertClose(aiForeign.total / base.total, 2, 'foreign damage twist visible to the AI');

  const engineOwn = calculateAttackMultiplier(f.gs, null, 0, target, f.ownSword);
  const aiOwn = mgr.helper.calculateAttackMultiplier(f.gs, null, 0, target, f.ownSwordP);
  assertClose(engineOwn.total / base.total, 1.2, 'own damage twist in engine view');
  assertClose(aiOwn.total / base.total, 1.2, 'own damage twist visible to the AI');
});

console.log(`\nleaderAttributes: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
