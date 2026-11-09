import { BaseManager } from '../baseManager.js';

/**
 * EntityCentricAI - tactical AI using Shahin's entity-centric design.
 *
 * Each entity independently asks:
 *   1. What is the best thing I can do?
 *   2. How important is it? (0-10 scale)
 *
 * All candidates are ranked by importance, top N executed until orders run out.
 * Coordination emerges from ranking — no explicit threat→attacker assignment —
 * plus a per-turn support-request list: an entity that expects protection
 * registers itself, and military units consider guarding it.
 *
 * Design rules (spec-addendum.md):
 * - Decide from attributes and available actions, never from names or roles.
 *   A unit that builds today may be a strong combat unit tomorrow.
 * - No hardcoded thresholds: reach is computed from movement (can the enemy
 *   actually get here?), and every tunable lives in the AI config below,
 *   overridable through player.controller.config (definitions/ai.json).
 * - Don't duplicate engine guarantees: whether an attack is possible is
 *   asked of the engine (Attack/Move canDo), not re-derived.
 * - Detection and response are different measures: threat detection asks
 *   "is an enemy near our stuff?", engagement asks "can we reach it?".
 */

const ORDERS_RESOURCE = 'orders';

/** AI heuristics. Overridable through player.controller.config (definitions/ai.json). */
const DEFAULT_ENTITY_CONFIG = {
  // Importance values (0-10 scale)
  fleeImportance: 9,
  attackImmediate: 8,
  attackEasy: 7,
  attackFavorable: 6,
  attackRisky: 4,
  retaliationBoost: 1,
  guardImportance: 8,
  exploreImportance: 6,
  exploreFallbackImportance: 2,
  buildEconomy: 6,
  buildMilitary: 5,
  buildWorker: 6,
  // Value of a builder unit when we own NO economy builder at all: the
  // economy is dead without one, so rebuilding it outranks everything
  // the village can build (scout 7.5, swordsman 8.7 at the neutral floor
  // — and up to ~13 under threat). Once one builder exists, the normal
  // buildWorker value applies. Without this, a dead worker is never
  // rebuilt: the village keeps building scouts while the economy stalls.
  buildWorkerScarce: 14,
  buildSettlement: 8,
  buildEnabler: 7,
  deficitBoost: 2,
  deficitPenalty: 3,
  // Diminishing returns for duplicates (value /= 1 + count * penalty)
  duplicatePenalty: 0.35,
  duplicatePenaltyMilitary: 0.6,
  // Power ratios
  neutralPowerRatio: 1.5,
  easyPowerRatio: 2.0,
  // Counts
  targetBuilderCount: 2,
  // Reach, in turns of movement (not hexes)
  attackReachTurns: 2,
  fleeThreatTurns: 2,
  // Deficit: critical iff runway below this many turns
  criticalRunwayTurns: 3,
  // Military need (0-1 signal)
  militaryNeedFloor: 0.5,
  militaryNeedThreatFloor: 0.8,
  // Standing floor on military need regardless of focus: 0 = fully reactive
  // (build the army only when enemies are seen); >0 = proactively keep an
  // army even at peace. Design-doc Q2 (proactive vs reactive first barracks).
  militaryNeedMin: 0,
  // Surplus-gated proactive floor (pipeline Q2): the floor that applies
  // once the economy produces a surplus. A fixed floor was worse than
  // reactive (63 vs 76) — early military spending starved the economy.
  // The floor is small (0.2) AND the surplus gate is a real stock buffer
  // (surplusStockMultiple below), not just positive income — the 0.4 floor
  // with the weak gate regressed Entity vs Smart 138 -> 38, because
  // military units (importance 12-27) crowded out the worker (6) before
  // the economy was established.
  militaryNeedMinSurplus: 0.2,
  // Standing army when all stances are neutral (pipeline Q4): something in
  // case of attack or barbarians, but smaller than the wartime floor.
  neutralStandingNeed: 0.1,
  // Surplus gate: stock must be at least this many times the median build
  // cost for every core resource before the proactive floor (or an
  // additional settlement) is allowed. Median spawn cost is ~130, so 3x
  // is ~390/resource — well above the starting stock (300/300/300/200),
  // so the economy must actually grow before military/expansion spending
  // ramps up. Net income must still be positive for every core resource.
  surplusStockMultiple: 3,
  // Reach computation margin (steps beyond maxAP, for cheap terrain)
  reachStepMargin: 2,
  // Loop bounds
  maxIterationsPerOrder: 4,
  minimumIterations: 40,
};

function asNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export class EntityCentricAI extends BaseManager {
  constructor(player, helper) {
    super(player, helper);
    // Importance multipliers from directive focus
    this.focusMultipliers = {
      economy: { economy: 1.5, military: 0.8, exploration: 0.9 },
      military: { economy: 0.8, military: 1.5, exploration: 0.9 },
      exploration: { economy: 0.9, military: 0.8, exploration: 1.5 },
      balanced: { economy: 1.0, military: 1.0, exploration: 1.0 },
    };
    // Config overlay (adaptiveManager pattern): only finite numbers, only
    // keys that exist in the defaults.
    const rawConfig = player.controller?.config || {};
    this.config = { ...DEFAULT_ENTITY_CONFIG };
    for (const key of Object.keys(DEFAULT_ENTITY_CONFIG)) {
      if (typeof rawConfig[key] === 'number' && Number.isFinite(rawConfig[key])) {
        this.config[key] = rawConfig[key];
      }
    }
    this.turnState = null;
  }

  getDirective() {
    // Mirror adaptiveManager.resolveDirective: an explicit directive may
    // live on controller.directive, controller.config.directive, or
    // controller.config.aiDirective. Focus falls back to config.focus,
    // then the leader's focus (controller.focus, an array), then balanced.
    // Stance/goals default to empty so a partial directive ({focus} alone)
    // never crashes getStance (N2).
    const controller = this.player.controller || {};
    const config = controller.config || {};
    const explicit = controller.directive || config.directive || config.aiDirective || null;
    let focus = 'balanced';
    if (explicit?.focus) {
      focus = explicit.focus;
    } else if (config.focus) {
      focus = config.focus;
    } else if (Array.isArray(controller.focus) && controller.focus.length > 0) {
      focus = controller.focus[0];
    }
    return {
      focus,
      stance: (explicit && explicit.stance) || {},
      goals: (explicit && Array.isArray(explicit.goals)) ? explicit.goals : [],
    };
  }

  getStance(playerId) {
    // Ownerless entities are barbarians: treat the stance toward them
    // as defensive — engage if they come within threat range. (adaptiveManager)
    if (playerId === null || playerId === undefined) return 'defensive';
    const directive = this.getDirective();
    return directive.stance?.[playerId] || 'neutral';
  }

  // ==================== Turn setup ====================

  async processTurn() {
    const helper = this.helper;
    const player = this.player;
    const gameState = this.gameState;

    if (!player || player.orders <= 0) return;

    const directive = this.getDirective();
    helper.aiLog(player, 'turn',
      `=== EntityCentric Turn Start (Round ${gameState.currentRound}) | Focus: ${directive.focus} | Orders: ${player.orders}/${player.maxOrders} ===`
    );

    // Per-turn state: enemy/protector reach (enemy positions are fixed
    // during our turn, so one computation stays valid), military need, and
    // the deficit descriptor. Support requests are re-validated each
    // generation, since our own units move.
    this.beginTurn(directive);

    // Main loop: generate candidates, execute best, repeat.
    // A failed candidate is skipped, not fatal: the next-best candidate is
    // tried in the same pass. Only when nothing in a full generation can
    // execute does the turn end (remaining orders convert via overflow).
    let iterations = 0;
    const maxIterations = Math.max(
      player.orders * this.config.maxIterationsPerOrder,
      this.config.minimumIterations
    );

    while (player.orders > 0 && iterations++ < maxIterations) {
      const candidates = this.generateCandidates(directive);
      if (candidates.length === 0) break;

      // Sort by importance (descending). candidates is a plain array we
      // built, so sorting in place is fine (never sort a proxied array).
      candidates.sort((a, b) => b.importance - a.importance);

      // Try candidates in order; execute the first that works, then
      // regenerate (state changed). A failed candidate is skipped —
      // one unaffordable build must not end the whole turn.
      let progressed = false;
      for (const candidate of candidates) {
        if (player.orders <= 0) break;
        // R2: a candidate that failed this turn on a shortfall that
        // cannot improve is not retried — the next generation would
        // otherwise re-check the same unaffordable build every iteration.
        if (this.turnState?.failedCandidates?.has(this.failedCandidateKey(candidate))) continue;
        const beforeCell = candidate.entity.cell;
        const executed = await this.executeCandidate(candidate, directive);
        if (executed) {
          progressed = true;
          // Refresh the UI after each action (replay snapshot, fog, and the
          // AI_ACTION_SLEEP pacing that makes moves visible one by one).
          const involvedCells = [beforeCell, candidate.entity.cell];
          if (candidate.target?.cell) involvedCells.push(candidate.target.cell);
          await helper.onActionDone(gameState, involvedCells.filter(Boolean), candidate.description || 'Entity action');
          break;
        }
      }
      if (!progressed) break;
    }

    helper.aiLog(player, 'turn', `=== EntityCentric Turn End | Remaining Orders: ${player.orders} ===`);
    this.turnState = null;
  }

  beginTurn(directive) {
    const state = {
      directive,
      enemyReach: this.computeEnemyReach(),
      protectorReach: this.computeProtectorReach(),
      supportRequests: new Map(),
      // R2: candidates that failed this turn on a shortfall that cannot
      // improve (resources/orders/AP only decrease during our turn), so
      // the next generation does not retry them.
      failedCandidates: new Set(),
      militaryNeed: 0,
      deficit: null,
      hostileOwners: this.getHostileOwnerIds(),
    };
    this.turnState = state;
    state.deficit = this.computeDeficit();
    state.militaryNeed = this.computeMilitaryNeed(directive);
    return state;
  }

  // ==================== Reach (computed once per turn) ====================

  /**
   * For each visible combat-capable enemy: the cells it could stand on in a
   * full turn (its own movement, terrain, occupancy), plus its attack range
   * and power. Enemy positions are fixed during our turn, so this stays valid.
   * Non-combat enemies are not threats and are skipped.
   */
  computeEnemyReach() {
    const reach = new Map();
    const helper = this.helper;
    for (const enemy of this.getVisibleEnemies()) {
      if (!helper.isCombatCapable(enemy)) continue;
      const maxAP = asNumber(enemy.maxActionPoints, asNumber(enemy.actionPoints, 0));
      if (maxAP <= 0) continue;
      const maxSteps = Math.ceil(maxAP) + this.config.reachStepMargin;
      const cells = helper.findReachableCells(this.gameState, enemy, maxSteps);
      // R1: a no-margin strike set — the cells the enemy can stand on
      // within one turn of movement (ceil(maxAP) hops). The reach set
      // above includes reachStepMargin, so it is the threat set, not the
      // strike set; testing it for "can strike now" made canStrikeNow
      // true for every threat.
      const strikeCells = helper.findReachableCells(this.gameState, enemy, Math.ceil(maxAP));
      const range = this.attackRange(enemy);
      reach.set(enemy.id, {
        enemy,
        reachable: new Set(cells.keys()),
        strikeReachable: new Set(strikeCells.keys()),
        range,
        power: helper.getCombatPower(enemy) || 1,
      });
    }
    return reach;
  }

  /** Same, for our own combat-capable units (used for the protector check). */
  computeProtectorReach() {
    const reach = new Map();
    const helper = this.helper;
    for (const unit of this.getMyUnits()) {
      if (!helper.isCombatCapable(unit)) continue;
      const maxAP = asNumber(unit.maxActionPoints, asNumber(unit.actionPoints, 0));
      if (maxAP <= 0) continue;
      const maxSteps = Math.ceil(maxAP) + this.config.reachStepMargin;
      const cells = helper.findReachableCells(this.gameState, unit, maxSteps);
      reach.set(unit.id, {
        unit,
        reachable: new Set(cells.keys()),
        range: this.attackRange(unit),
        power: helper.getCombatPower(unit) || 1,
      });
    }
    return reach;
  }

  /** Attack range {min, max} in hexes; melee is 1. */
  attackRange(entity) {
    const range = entity?.range;
    if (range && typeof range === 'object') {
      return { min: asNumber(range.minCells, 1), max: asNumber(range.maxCells, 1) };
    }
    return { min: 1, max: 1 };
  }

  /** Cells within `radius` hexes of `center` (BFS over the grid). */
  cellsWithin(center, radius) {
    const seen = new Map([[`${center.q},${center.r}`, center]]);
    let frontier = [center];
    for (let step = 0; step < radius; step++) {
      const next = [];
      for (const cell of frontier) {
        for (const nb of this.helper.getNeighbors(cell.q, cell.r)) {
          const key = `${nb.q},${nb.r}`;
          if (seen.has(key)) continue;
          seen.set(key, nb);
          next.push(nb);
        }
      }
      frontier = next;
    }
    return [...seen.values()];
  }

  /**
   * Can `unit` land an attack on `target` this turn (from where it stands,
   * or after one move that leaves enough AP for the attack)? Asks the engine
   * (Attack/Move canDo), not a re-derived distance. Adapted from Hark's
   * canStrikeThisTurn (harkManager.js).
   *
   * Only for OUR OWN units. canDo on a foreign unit's actions reads the
   * opponent's private orders through checkActionAffordability (S1) — so
   * this returns false for any unit we don't own. Use enemyCanStrike for
   * enemies instead.
   */
  canStrike(unit, target) {
    if (!unit) return false;
    const ownerId = unit.ownerId ?? unit.owner?.id;
    if (ownerId !== this.player.id) return false;
    const actions = unit.getActions ? unit.getActions() : [];
    const attackAction = actions.find(a => a.name === 'Attack');
    if (!attackAction) return false;
    const targetCell = target.cell;
    if (!targetCell) return false;

    const now = attackAction.canDo(targetCell, target);
    if (now?.possible) return true;

    const moveAction = actions.find(a => a.name === 'Move');
    if (!moveAction || asNumber(unit.actionPoints) <= 0) return false;
    // Moving costs an order, attacking another.
    if (asNumber(this.player.orders) < 2) return false;

    const range = this.attackRange(unit);
    const scale = asNumber(unit.attackCostScale, 1);
    const exhaustion = asNumber(unit.state?.battleExhaustion, 1);
    const costFunc = typeof unit.getMovementCost === 'function'
      ? unit.getMovementCost.bind(unit)
      : null;
    if (range.max <= 1 && !costFunc) return false;

    for (const cell of this.cellsWithin(targetCell, range.max)) {
      const dist = this.helper.distance(cell, targetCell);
      if (dist < range.min || dist > range.max) continue;
      if (this.gameState.getEntityAt(cell.q, cell.r)) continue;
      if (!unit.canStandOn(cell)) continue;
      const move = moveAction.canDo(cell, null);
      if (!move?.possible) continue;

      let attackCost;
      if (range.max > 1) {
        const sight = this.helper.getSightAndTrajectory(cell, targetCell);
        const trajectoryOk = sight.visible
          || (sight.maxObstructionDelta < asNumber(unit.range?.arcHeight, 0));
        if (!trajectoryOk) continue;
        attackCost = Math.ceil(scale * exhaustion * dist);
      } else {
        const path = this.helper.movementCostTo(cell, targetCell, costFunc, { allowDetours: true });
        if (!path || !path.reached) continue;
        attackCost = Math.ceil(scale * exhaustion * path.cost);
      }
      if (asNumber(unit.actionPoints) - asNumber(move.cost) >= attackCost) return true;
    }
    return false;
  }

  /**
   * Can the enemy in `info` land an attack on `entity` on its next turn?
   * Tests the no-margin strike set (cells the enemy can stand on within
   * ceil(maxAP) hops) plus attack range — the same test as
   * enemyThreatensEntity, but on the 1-turn set. The reach set includes
   * reachStepMargin, so testing it made canStrikeNow true for every
   * threat (R1). Never calls the enemy's actions, so no private state
   * (leftover AP/orders) leaks through canDo (S1, S2).
   * The old canStrike(enemy, …) tested the enemy's leftover AP/orders
   * from its last turn (usually 0), so canStrikeNow was effectively always
   * false against other players.
   */
  enemyCanStrike(info, entity) {
    if (!info || !entity?.cell) return false;
    if (info.enemy?.destroyed) return false;
    if (!info.strikeReachable) return false;
    return this.enemyThreatensEntity(info, entity, info.strikeReachable);
  }

  /**
   * Turns of movement for `unit` to reach `target`'s cell, from the unit's
   * own movement cost and max AP. Infinity when unreachable. This is a
   * derived measure (turns), not a hex distance.
   */
  turnsToReach(unit, target) {
    if (!unit || !target?.cell) return Infinity;
    const costFunc = typeof unit.getMovementCost === 'function'
      ? unit.getMovementCost.bind(unit)
      : null;
    if (!costFunc) return Infinity;
    const path = this.helper.movementCostTo(unit.cell, target.cell, costFunc, { allowDetours: true });
    if (!path || !path.reached) return Infinity;
    const maxAP = asNumber(unit.maxActionPoints, asNumber(unit.actionPoints, 0));
    if (maxAP <= 0) return Infinity;
    return Math.max(1, Math.ceil(path.cost / maxAP));
  }

  // ==================== Threat assessment ====================

  /**
   * The most imminent threat to `entity`, or null. Detection asks "is an
   * enemy near our stuff?" — an enemy threatens the entity if one of its
   * reachable cells is within its attack range of the entity's current cell.
   * Returns { enemy, canStrikeNow, turnsToReach }.
   */
  assessThreat(entity) {
    if (!this.turnState) return null;
    let best = null;
    for (const info of this.turnState.enemyReach.values()) {
      const { enemy } = info;
      if (enemy.id === entity.id) continue;
      // N1: the reach map is built once per turn — skip enemies killed
      // this turn, or support/guard would target a corpse.
      if (enemy.destroyed) continue;
      if (!this.enemyThreatensEntity(info, entity)) continue;
      const turns = this.turnsToReach(enemy, entity);
      const canStrikeNow = this.enemyCanStrike(info, entity);
      const threat = { enemy, canStrikeNow, turnsToReach: turns };
      if (!best || threat.turnsToReach < best.turnsToReach
        || (threat.turnsToReach === best.turnsToReach && canStrikeNow && !best.canStrikeNow)) {
        best = threat;
      }
    }
    return best;
  }

  /** Cheap detection check: is any cell the enemy could stand on within its attack range of the entity? `reachable` defaults to the margin reach set; pass the strike set for the 1-turn test (R1). */
  enemyThreatensEntity(info, entity, reachable = info.reachable) {
    const { range } = info;
    for (const cell of this.cellsWithin(entity.cell, range.max)) {
      const dist = this.helper.distance(cell, entity.cell);
      if (dist < range.min || dist > range.max) continue;
      if (reachable.has(`${cell.q},${cell.r}`)) return true;
    }
    return false;
  }

  /**
   * Is there an effective protector for `entity` against `threat`? A
   * protector is one of our combat-capable units that is either adjacent
   * to the threatened entity (bodyguard) or can reach a cell from which it
   * could attack the threat (interceptor — position-based, full-turn reach,
   * not current AP: it needs to be there when the enemy arrives).
   */
  isProtected(entity, threat) {
    if (!this.turnState || !threat) return false;
    // N1: a dead threat needs no protector; a dead protector protects no one.
    if (threat.enemy?.destroyed) return false;
    const helper = this.helper;
    for (const info of this.turnState.protectorReach.values()) {
      const protector = info.unit;
      if (protector.id === entity.id) continue;
      if (protector.destroyed) continue;
      if (helper.distance(protector, entity) <= 1) return true;
      const range = info.range;
      for (const cell of this.cellsWithin(threat.enemy.cell, range.max)) {
        const dist = helper.distance(cell, threat.enemy.cell);
        if (dist < range.min || dist > range.max) continue;
        if (info.reachable.has(`${cell.q},${cell.r}`)) return true;
      }
    }
    return false;
  }

  // ==================== Military need & deficit ====================

  /**
   * Military need, 0-1 (Stage B signal). From the force ratio against
   * visible enemies, floored by directive focus and by imminent threat.
   */
  computeMilitaryNeed(directive) {
    const cfg = this.config;
    let myPower = 0;
    for (const unit of this.getMyUnits()) {
      if (this.helper.isDedicatedMilitary(unit, this.gameState.manifestData)) {
        myPower += this.helper.getCombatPower(unit) || 0;
      }
    }
    let enemyPower = 0;
    let imminent = false;
    for (const info of this.turnState.enemyReach.values()) {
      enemyPower += info.power;
      // An enemy that could strike one of our entities (cheap detection
      // check, not a full canStrike per pair).
      if (!imminent) {
        for (const entity of this.getMyUnits()) {
          if (this.enemyThreatensEntity(info, entity)) { imminent = true; break; }
        }
      }
    }
    let need = enemyPower / (myPower + enemyPower + 1);
    if (directive.focus === 'military') need = Math.max(need, cfg.militaryNeedFloor);
    if (imminent) need = Math.max(need, cfg.militaryNeedThreatFloor);
    need = Math.max(need, cfg.militaryNeedMin);
    // Surplus-gated proactive floor (pipeline Q2): only once the economy
    // produces a surplus — a fixed floor starved the economy (63 vs 76).
    if (this.hasEconomicSurplus()) need = Math.max(need, cfg.militaryNeedMinSurplus);
    // Standing army when all stances are neutral (pipeline Q4): something
    // in case of attack or barbarians, but smaller than wartime.
    if (this.allStancesNeutral(directive)) need = Math.max(need, cfg.neutralStandingNeed);
    return Math.min(1, Math.max(0, need));
  }

  /**
   * Economic surplus: no critical resource deficit AND positive net income
   * for every core resource AND stock at least surplusStockMultiple times
   * the median build cost for every core resource. The proactive military
   * floor (and an additional settlement) only applies once the economy can
   * afford it — positive income alone passes far too early (right after
   * the first farm), which is what starved the economy in the 4-fixes
   * regression. (netIncome/stock/medianCost come from the deficit
   * descriptor, computed from the player's own resource profile.)
   */
  hasEconomicSurplus() {
    const deficit = this.turnState?.deficit;
    if (!deficit || deficit.critical.size > 0) return false;
    const threshold = asNumber(this.config.surplusStockMultiple, 3)
      * asNumber(deficit.medianCost, 0);
    for (const res of ['food', 'wood', 'iron', 'gold']) {
      if (asNumber(deficit.netIncome?.[res], 0) <= 0) return false;
      if (asNumber(deficit.stock?.[res], 0) < threshold) return false;
    }
    return true;
  }

  /** True when no opponent's stance is defensive or offensive (all neutral by default). */
  allStancesNeutral(directive) {
    const stances = Object.values(directive?.stance || {});
    return !stances.some(s => s === 'defensive' || s === 'offensive');
  }

  /**
   * Owner ids that damaged one of our entities in the last 2 rounds
   * (from our own history — legal through the proxy). An owner that hit
   * us is hostile; neutral stance only attacks hostile owners (S6).
   * Attackers that are dead or out of sight can't be resolved to an owner
   * via getEntityById, so they are skipped.
   */
  getHostileOwnerIds() {
    const hostile = new Set();
    const currentRound = this.gameState?.currentRound || 1;
    const startRound = Math.max(1, currentRound - 2);
    const entries = this.player.getHistoryRange
      ? this.player.getHistoryRange(startRound, currentRound)
      : [];
    for (const entry of entries || []) {
      if (!entry) continue;
      if (entry.category !== 'damaged' && entry.category !== 'destroy') continue;
      const attackerId = entry.extra?.attackerId;
      if (!attackerId) continue;
      const attacker = this.gameState.getEntityById?.(attackerId);
      const ownerId = attacker?.ownerId ?? attacker?.owner?.id;
      if (ownerId !== undefined && ownerId !== null) hostile.add(ownerId);
    }
    return hostile;
  }

  /**
   * Deficit descriptor (design doc §7.4), from the player's own resource
   * profile — legal through the proxy. Critical iff runway (stock / net
   * drain) is below the configured threshold for a resource, or a core
   * resource has net income <= 0 with stock below twice the median build
   * cost. Returns { critical: Set, deficit: Set, runway: {}, criticalResource }.
   * The runway here uses current net income (getResourceProfile's
   * turnsRemaining); a rolling history window would be the refinement.
   */
  computeDeficit() {
    const cfg = this.config;
    const profile = this.player.getResourceProfile
      ? this.player.getResourceProfile()
      : null;
    const critical = new Set();
    const deficit = new Set();
    const runway = {};
    const netIncome = {};
    if (!profile) return { critical, deficit, runway, netIncome, criticalResource: null };

    // Median build cost across the manifest, for the low-stock check.
    const costs = [];
    for (const meta of Object.values(this.gameState.manifestData?.entities || {})) {
      const total = Object.values(meta?.spawnCost || {})
        .filter(v => typeof v === 'number')
        .reduce((s, v) => s + v, 0);
      if (total > 0) costs.push(total);
    }
    costs.sort((a, b) => a - b);
    const medianCost = costs.length > 0 ? costs[Math.floor(costs.length / 2)] : 0;

    const core = new Set(['food', 'wood', 'iron', 'gold']);
    const stock = {};
    for (const [res, v] of Object.entries(profile.stock || {})) {
      stock[res] = asNumber(v, 0);
    }
    for (const [res, turns] of Object.entries(profile.turnsRemaining || {})) {
      if (res === ORDERS_RESOURCE) continue;
      const t = asNumber(turns, Infinity);
      runway[res] = t;
      const net = asNumber(profile.netIncome?.[res], 0);
      const stockRes = asNumber(profile.stock?.[res], 0);
      netIncome[res] = net;
      if (Number.isFinite(t) && t < cfg.criticalRunwayTurns) {
        critical.add(res);
      } else if (Number.isFinite(t) && t < cfg.criticalRunwayTurns * 2) {
        deficit.add(res);
      } else if (core.has(res) && net <= 0 && stockRes < 2 * medianCost) {
        critical.add(res);
      }
    }
    return { critical, deficit, runway, netIncome, stock, medianCost, criticalResource: profile.criticalResource || null };
  }

  /** Backwards-compatible accessor: the most critical resource, or null. */
  getCriticalResourceDeficit() {
    const d = this.turnState?.deficit;
    if (!d || d.critical.size === 0) return null;
    return d.criticalResource || [...d.critical][0];
  }

  // ==================== Candidate generation ====================

  /**
   * Generate candidate actions for all entities.
   * Each candidate: { entity, action, importance, description, data }
   */
  generateCandidates(directive) {
    const candidates = [];
    const myUnits = this.getMyUnits();

    // Re-validate support requests against current positions: a requester
    // that moved to safety, or that a protector now covers, drops off.
    this.refreshSupportRequests();

    for (const entity of myUnits) {
      if ((entity.actionPoints ?? 0) <= 0) continue;
      candidates.push(...this.getEntityCandidates(entity, directive));
    }
    return candidates;
  }

  refreshSupportRequests() {
    if (!this.turnState) return;
    for (const [id, req] of [...this.turnState.supportRequests]) {
      const entity = this.getMyUnits().find(e => e.id === id);
      if (!entity || (entity.actionPoints ?? 0) <= 0) {
        this.turnState.supportRequests.delete(id);
        continue;
      }
      const threat = this.assessThreat(entity);
      if (!threat || this.isProtected(entity, threat)) {
        this.turnState.supportRequests.delete(id);
      } else {
        req.threat = threat;
        req.entity = entity;
      }
    }
  }

  /**
   * Route by capability, never by name. Every entity gets the candidates
   * its capabilities support; importance ranking decides what it actually
   * does. A builder that can fight gets attack candidates too (scored by
   * its power, not banned); a fighter that can build gets build candidates.
   */
  getEntityCandidates(entity, directive) {
    const helper = this.helper;
    const candidates = [];
    const isFighter = helper.isCombatCapable(entity);
    const isDedicated = helper.isDedicatedMilitary(entity, this.gameState.manifestData);
    const isBuilder = helper.isBuilder(entity);
    const isMobile = helper.isMobile(entity);

    // Threat first: a non-fighter that an enemy can reach registers for
    // support, and flees if the threat is imminent and no protector covers it.
    if (isMobile && !isDedicated) {
      const flee = this.getFleeCandidate(entity, directive);
      if (flee) {
        // Fleeing is the only sensible action while in imminent danger.
        return [flee];
      }
    }

    if (isFighter) {
      candidates.push(...this.getAttackCandidates(entity, directive));
      candidates.push(...this.getGuardCandidates(entity, directive));
    }
    if (isBuilder) {
      candidates.push(...this.getBuildCandidates(entity, directive));
    }
    if (isMobile) {
      candidates.push(...this.getExploreCandidates(entity, directive));
    }
    return candidates;
  }

  // ==================== Flee / support ====================

  /**
   * Flee candidate for a threatened non-fighter, or null. Registers a
   * support request when no protector is effective, so military units can
   * be diverted to guard it. Flees only when the threat is imminent
   * (reachable within the configured number of turns).
   */
  getFleeCandidate(entity, directive) {
    const threat = this.assessThreat(entity);
    if (!threat) return null;
    if (this.isProtected(entity, threat)) return null;

    // Register for support whenever a genuine threat has no effective
    // protector — not only when fleeing. Military units see the request in
    // the next candidate generation (the loop regenerates after each action)
    // and can pre-position before the threat becomes imminent.
    const urgency = threat.canStrikeNow ? 1
      : threat.turnsToReach <= 1 ? 0.85
        : 0.7;
    this.turnState.supportRequests.set(entity.id, { entity, threat, urgency });

    // Flee only when the threat is imminent.
    if (threat.turnsToReach > this.config.fleeThreatTurns && !threat.canStrikeNow) {
      return null;
    }

    return {
      entity,
      action: 'flee',
      threat: threat.enemy,
      importance: this.config.fleeImportance * urgency,
      description: `Flee from ${threat.enemy.name}`,
    };
  }

  // ==================== Attack candidates ====================

  getAttackCandidates(entity, directive) {
    const candidates = [];
    const helper = this.helper;
    const cfg = this.config;
    const enemies = this.getVisibleEnemies();

    for (const enemy of enemies) {
      const stance = this.getStance(enemy.ownerId ?? enemy.owner?.id);
      if (stance === 'friendly' || stance === 'ally' || stance === 'caution') continue;

      const myPower = helper.getCombatPower(entity) || 1;
      const enemyPower = helper.getCombatPower(enemy) || 1;

      // Reach, in turns of movement — not a hex distance. Only consider
      // enemies we can get to soon; the explore action covers the rest.
      const canStrikeNow = this.canStrike(entity, enemy);
      const turns = canStrikeNow ? 0 : this.turnsToReach(entity, enemy);
      if (!canStrikeNow && turns > cfg.attackReachTurns) continue;

      // In neutral stance, only attack if favorable or immediately reachable.
      // Neutral sits below caution and never initiates opportunistically (S6):
      // the owner must be hostile (it hit us recently) or threaten one of
      // our support requesters. Without this gate, defenceless buildings
      // (power 0||1) always qualified under the ratio check, so neutral
      // attacked first and unprovoked.
      if (stance === 'neutral') {
        const enemyOwnerId = enemy.ownerId ?? enemy.owner?.id;
        const isHostileOwner = this.turnState.hostileOwners?.has(enemyOwnerId);
        const threatensRequester = [...this.turnState.supportRequests.values()]
          .some(req => req.threat?.enemy?.id === enemy.id);
        if (!isHostileOwner && !threatensRequester) continue;
        if (!canStrikeNow && turns > 1) continue;
        if (myPower < enemyPower * cfg.neutralPowerRatio && !canStrikeNow) continue;
      }

      // Importance by odds and reach.
      let importance;
      if (canStrikeNow) importance = cfg.attackImmediate;
      else if (myPower >= enemyPower * cfg.easyPowerRatio) importance = cfg.attackEasy;
      else if (myPower >= enemyPower) importance = cfg.attackFavorable;
      else importance = cfg.attackRisky;
      // Reaching later is worth less than striking now.
      if (!canStrikeNow) importance *= (turns <= 1 ? 0.9 : 0.7);

      // Retaliation: the enemy threatens one of our non-fighters.
      for (const req of this.turnState.supportRequests.values()) {
        if (req.threat?.enemy?.id === enemy.id) { importance += cfg.retaliationBoost; break; }
      }

      importance = this.applyFocusMultiplier(importance, 'military', directive);

      candidates.push({
        entity,
        action: 'attack',
        target: enemy,
        importance,
        description: `Attack ${enemy.name} (power ${myPower.toFixed(0)} vs ${enemyPower.toFixed(0)}${canStrikeNow ? ', in range' : `, ${turns} turn${turns > 1 ? 's' : ''} away`})`,
      });
    }
    return candidates;
  }

  /**
   * Guard candidates: move toward (or strike) the threat facing an entity
   * that requested support. Importance from the request's urgency, so the
   * most exposed requester diverts a unit first.
   */
  getGuardCandidates(entity, directive) {
    const candidates = [];
    if (!this.turnState) return candidates;
    // N4: only mobile entities can guard — a tower (or any construct)
    // given a guard candidate would call explore on a construct, which
    // always fails and burns loop iterations.
    if (!this.helper.isMobile(entity)) return candidates;
    for (const req of this.turnState.supportRequests.values()) {
      if (req.entity.id === entity.id) continue;
      const importance = this.config.guardImportance * req.urgency;
      candidates.push({
        entity,
        action: 'guard',
        target: req.entity,
        threat: req.threat?.enemy,
        importance: this.applyFocusMultiplier(importance, 'military', directive),
        description: `Guard ${req.entity.name} from ${req.threat?.enemy?.name || 'threat'}`,
      });
    }
    return candidates;
  }

  // ==================== Build candidates ====================

  /**
   * Build candidates for every buildable the entity knows — no truncation.
   * Producers (buildings with buildables) are categorized from the manifest:
   * military-enabler, settlement, worker, economy, defense. Units are valued
   * from their own attributes (military score, economy score, sight and
   * movement for exploration, damage) — so a scout's exploration value comes
   * from its sight and speed, not its name.
   */
  getBuildCandidates(entity, directive) {
    const candidates = [];
    const cfg = this.config;
    const deficit = this.turnState?.deficit;
    const militaryNeed = this.turnState?.militaryNeed ?? 0;
    const myUnits = this.getMyUnits();

    for (const rawTarget of this.getBuildables(entity)) {
      const targetName = this.canonicalName(rawTarget);
      if (!targetName) continue;
      const meta = this.gameState.manifestData?.entities?.[targetName]
        || this.getEntityDef(targetName);
      if (!meta) continue;

      const isUnit = !!meta.movement;
      let importance;
      let category;
      if (isUnit) {
        const value = this.scoreUnitBuildable(meta, militaryNeed, myUnits);
        if (value == null) continue;
        importance = value.importance;
        category = value.category;
        // Pause unit production entirely when critical on a resource the
        // unit costs (omitted, not low-scored).
        if (deficit && this.costUsesCritical(meta, deficit)) continue;
      } else {
        const cat = this.categorizeProducer(targetName, meta);
        if (cat == null) continue;
        importance = cat.importance;
        category = cat.category;
        // Building a producer while critical on a resource it costs is
        // penalized, never deleted (the floor keeps it visible).
        if (deficit && this.costUsesCritical(meta, deficit)) {
          importance = Math.max(2, importance - cfg.deficitPenalty);
        }
        // Economy producers for a deficit resource are worth more.
        if (deficit && cat.isEconomy && this.producesDeficit(meta, deficit)) {
          importance += cfg.deficitBoost;
        }
      }

      // Diminishing returns on duplicates.
      const duplicateCount = myUnits.filter(e => e.name === targetName).length;
      const penalty = category === 'military' ? cfg.duplicatePenaltyMilitary : cfg.duplicatePenalty;
      importance /= (1 + duplicateCount * penalty);

      importance = this.applyFocusMultiplier(importance, category, directive);

      candidates.push({
        entity,
        action: 'build',
        targetName,
        importance,
        description: `Build ${targetName}`,
      });
    }
    return candidates;
  }

  /**
   * Value a unit buildable from its manifest attributes. Military score
   * scales with military need; sight + movement is exploration value;
   * damage is combat value. The focus category is whichever term dominates.
   * A builder unit (it has buildables) is different: its value is the
   * economy it unlocks, not its own score — so while we own fewer than the
   * target count of builders it is valued as a worker (buildWorker), and
   * only extra builders fall back to their own stats. Without this, a
   * village ranks swordsmen and scouts above workers and the economy stalls.
   * Returns { importance, category }.
   */
  scoreUnitBuildable(meta, militaryNeed, myUnits = []) {
    if ((meta?.buildables || []).length > 0) {
      // Scarce economy builder: if we own no economy builder at all,
      // rebuilding one outranks everything — without it nothing gets
      // built and the economy is dead. (A settler is not an economy
      // builder: it founds villages, it cannot build farms or mines.)
      if (this.isEconomyBuilderMeta(meta) && this.countEconomyBuilders() === 0) {
        return { importance: this.config.buildWorkerScarce, category: 'economy' };
      }
      const owned = myUnits.filter(e => {
        const m = this.gameState.manifestData?.entities?.[e.name] || this.getEntityDef(e.name);
        return (m?.buildables || []).length > 0;
      }).length;
      if (owned < this.config.targetBuilderCount) {
        return { importance: this.config.buildWorker, category: 'economy' };
      }
    }
    const milScore = asNumber(meta?.score?.military, 0);
    const econScore = asNumber(meta?.score?.economic, 0);
    const sight = asNumber(meta?.sightRange, 0);
    const maxAP = asNumber(meta?.maxActionPoints, 0);
    const damage = asNumber(meta?.damage?.value, 0);
    const militaryTerm = milScore * (0.3 + militaryNeed) + damage * 0.1 * (0.3 + militaryNeed);
    const economyTerm = econScore;
    const explorationTerm = (sight + maxAP) * 0.3;
    const importance = militaryTerm + economyTerm + explorationTerm;
    if (importance <= 0) return null;
    let category = 'economy';
    if (militaryTerm >= economyTerm && militaryTerm >= explorationTerm) category = 'military';
    else if (explorationTerm >= economyTerm) category = 'exploration';
    return { importance, category };
  }

  /**
   * Categorize a producer (a building with buildables) from its manifest
   * entry — never from its name.
   * - military-enabler: one of its buildables is a dedicated-military unit.
   *   Its value is the army it unlocks, scaled by military need.
   * - settlement: it builds something that itself builds (founds a base);
   *   valued at buildSettlement whatever we already own (no count cap —
   *   the duplicate penalty handles diminishing returns).
   * - worker: it builds things but is not military and not a settlement
   *   (enables the economy).
   * - defense: a construct with no yields and no buildables whose military
   *   score beats its economy score (a tower); valued by military need.
   * - economy: anything else that yields or scores economically.
   * Returns { importance, category, isEconomy } or null to skip.
   */
  categorizeProducer(targetName, meta) {
    const cfg = this.config;
    const militaryNeed = this.turnState?.militaryNeed ?? 0;
    const manifest = this.gameState.manifestData;
    const buildables = meta?.buildables || [];
    let isMilitaryEnabler = false;
    let isSettlement = false;
    for (const childName of buildables) {
      const childMeta = manifest?.entities?.[childName] || this.getEntityDef(childName);
      if (!childMeta) continue;
      if (this.isMilitaryMeta(childMeta, childName)) isMilitaryEnabler = true;
      if ((childMeta.buildables || []).length > 0) isSettlement = true;
    }
    const yields = meta?.yields || {};
    const hasYields = Object.keys(yields).length > 0;
    const econScore = asNumber(meta?.score?.economic, 0);
    const milScore = asNumber(meta?.score?.military, 0);
    const isEconomy = hasYields || econScore > milScore;

    // Settlement first (S3): a village builds a scout (military), so the
    // military-enabler branch used to return before the settlement branch
    // was ever reached — the surplus gate never ran and villages were
    // valued as military. A producer that founds a base is a settlement,
    // whatever else it builds.
    if (isSettlement) {
      // A settlement beyond the first waits for a real economic surplus:
      // founding a base too early starves the economy (the 4-fixes
      // regression: the uncapped 2nd village was built before the economy
      // could carry it). The first village stays ungated — it is the
      // starting expansion. The duplicate penalty still applies on top,
      // for diminishing returns.
      if (this.countSettlements() >= 1 && !this.hasEconomicSurplus()) return null;
      return {
        importance: cfg.buildSettlement,
        category: 'economy',
        isEconomy: true,
      };
    }
    if (isMilitaryEnabler) {
      return {
        importance: cfg.buildEnabler * (0.3 + militaryNeed),
        category: 'military',
        isEconomy: false,
      };
    }
    if (buildables.length > 0 && !isEconomy) {
      // A producer that is neither military nor economic: a worker-like
      // enabler of everything (builds, but what it builds is not military).
      return { importance: cfg.buildWorker, category: 'economy', isEconomy: true };
    }
    if (!hasYields && buildables.length === 0 && milScore > econScore) {
      // Static defense (a tower): valued by military need, never by economy.
      return {
        importance: cfg.buildMilitary * (0.3 + militaryNeed),
        category: 'military',
        isEconomy: false,
      };
    }
    if (isEconomy) {
      return { importance: cfg.buildEconomy, category: 'economy', isEconomy: true };
    }
    return null;
  }

  /**
   * Dedicated-military test on a manifest entry (no entity needed). Mirrors
   * helper.isDedicatedMilitary: has an Attack action (damage > 0) and either
   * high damage or a military score with real damage. Only units (has
   * movement) count — a tower is defense, not a military unit.
   */
  isMilitaryMeta(meta, name) {
    if (!meta || !meta.movement) return false;
    const dmg = asNumber(meta.damage?.value, 0);
    if (dmg <= 0) return false;
    const milScore = asNumber(meta.score?.military, 0);
    const isBuilder = (meta.buildables || []).length > 0;
    if (dmg <= 10 && isBuilder) return false;
    return dmg >= 20 || (milScore >= 5 && dmg > 10);
  }

  /** Is this manifest entry an economy builder — can it build a yield-producing construct that is not itself a settlement? (Worker yes; settler no.) */
  isEconomyBuilderMeta(meta) {
    for (const childName of meta?.buildables || []) {
      const childMeta = this.gameState.manifestData?.entities?.[childName]
        || this.getEntityDef(childName);
      if (!childMeta || childMeta.movement) continue;
      if (Object.keys(childMeta.yields || {}).length === 0) continue;
      const isSettlement = (childMeta.buildables || []).some(grandName => {
        const grandMeta = this.gameState.manifestData?.entities?.[grandName]
          || this.getEntityDef(grandName);
        return (grandMeta?.buildables || []).length > 0;
      });
      if (!isSettlement) return true;
    }
    return false;
  }

  /** Number of economy builders we own. */
  countEconomyBuilders() {
    let count = 0;
    for (const e of this.getMyUnits()) {
      const meta = this.gameState.manifestData?.entities?.[e.name]
        || this.getEntityDef(e.name);
      if (meta && this.isEconomyBuilderMeta(meta)) count++;
    }
    return count;
  }

  /** Is this owned entity a settlement (founds a base)? Only constructs
   * count — a village. Units that build (settler, worker) are builders,
   * not settlements: counting them made the "first village is ungated"
   * check see settlements before any village existed (S4). */
  isSettlementEntity(entity) {
    const meta = this.gameState.manifestData?.entities?.[entity.name]
      || this.getEntityDef(entity.name);
    if (!meta) return false;
    if (meta.movement) return false;
    const buildables = meta.buildables || [];
    return buildables.some(childName => {
      const childMeta = this.gameState.manifestData?.entities?.[childName]
        || this.getEntityDef(childName);
      return (childMeta?.buildables || []).length > 0;
    });
  }

  /** Number of settlements we own. */
  countSettlements() {
    let count = 0;
    for (const e of this.getMyUnits()) {
      if (this.isSettlementEntity(e)) count++;
    }
    return count;
  }

  /** Does this buildable's cost use a critically-short resource? */
  costUsesCritical(meta, deficit) {
    if (!deficit || deficit.critical.size === 0) return false;
    for (const res of Object.keys(meta?.spawnCost || {})) {
      if (res !== ORDERS_RESOURCE && deficit.critical.has(res)) return true;
    }
    return false;
  }

  /** Does this buildable produce a resource we are critical on? */
  producesDeficit(meta, deficit) {
    if (!deficit || deficit.critical.size === 0) return false;
    for (const res of Object.keys(meta?.yields || {})) {
      if (res !== ORDERS_RESOURCE && deficit.critical.has(res)) return true;
    }
    return false;
  }

  // ==================== Explore candidates ====================

  /**
   * Explore candidates for any mobile entity. Importance by capability:
   * a pure mover (mobile, no build, no attack) is a dedicated explorer;
   * a builder or fighter explores only as a fallback.
   */
  getExploreCandidates(entity, directive) {
    const helper = this.helper;
    const isBuilder = helper.isBuilder(entity);
    const isFighter = helper.isCombatCapable(entity);
    const importance = (!isBuilder && !isFighter)
      ? this.config.exploreImportance
      : this.config.exploreFallbackImportance;
    return [{
      entity,
      action: 'explore',
      importance: this.applyFocusMultiplier(importance, 'exploration', directive),
      description: `Explore`,
    }];
  }

  // ==================== Execution ====================

  async executeCandidate(candidate, directive) {
    const helper = this.helper;
    const player = this.player;
    const gameState = this.gameState;
    const { entity, action } = candidate;

    if (player.orders <= 0) return false;

    helper.aiLog(player, 'action',
      `${entity.name} → ${candidate.description} (importance ${candidate.importance.toFixed(1)})`
    );

    let result;
    switch (action) {
      case 'attack':
        result = helper.attack(gameState, entity, candidate.target, 2);
        break;
      case 'build':
        result = helper.build(gameState, entity, candidate.targetName);
        break;
      case 'explore':
        result = helper.explore(gameState, entity, null, false, null);
        break;
      case 'flee':
        result = this.executeFlee(entity, candidate.threat);
        break;
      case 'guard':
        result = this.executeGuard(entity, candidate.target, candidate.threat);
        break;
      default:
        return false;
    }

    // The engine deducts orders when the action executes (action.do()), so
    // the proxied player.orders already reflects the spend — and writing it
    // is an illegal write under the AI interface proxy (PR #38). Just report success.
    if (result && result.ordersUsed > 0) {
      // N1: a unit built this turn can be a protector — refresh the
      // per-turn reach map so isProtected sees it.
      if (action === 'build' && this.turnState) {
        this.turnState.protectorReach = this.computeProtectorReach();
      }
      return true;
    }
    // R2: remember a shortfall failure for the rest of the turn, so the
    // next generation does not retry it.
    if (this.turnState && this.isShortfallFailure(result)) {
      this.turnState.failedCandidates.add(this.failedCandidateKey(candidate));
    }
    return false;
  }

  /**
   * Stable key for a candidate: (action, entity, target). Used by the
   * per-turn failed-candidate skip set (R2).
   */
  failedCandidateKey(candidate) {
    const targetId = candidate.target?.id ?? candidate.targetName ?? candidate.threat?.id ?? '';
    return `${candidate.action}:${candidate.entity.id}:${targetId}`;
  }

  /**
   * Did `result` fail on a shortfall that cannot improve during our turn?
   * Resources, orders and AP only decrease during the action loop (they
   * are replenished at turn start), so a candidate that fails on one of
   * these cannot succeed later in the same turn. Target/path failures are
   * NOT shortfalls — a blocked path can clear if our own unit moves.
   */
  isShortfallFailure(result) {
    const message = result?.result?.message || '';
    return /insufficient/i.test(message) || /no action points/i.test(message);
  }

  /**
   * Guard: if the threat can be struck, strike it; otherwise move toward
   * the entity that requested support.
   */
  executeGuard(entity, requester, threat) {
    const helper = this.helper;
    const gameState = this.gameState;
    if (threat && this.canStrike(entity, threat)) {
      return helper.attack(gameState, entity, threat, 2);
    }
    if (requester?.cell) {
      const moveAction = entity.getActions ? entity.getActions().find(a => a.name === 'Move') : null;
      if (!moveAction) return null;
      // B1: move directly toward the requester. explore's 5th argument is
      // an ignore-list (cells already claimed), not a destination — passing
      // the requester cell there made the guard walk toward the fog
      // instead. findPathTowardsUnexplored with an explicit target returns
      // the shortest path to that cell (or the closest reachable cell);
      // moveAlongPath then moves as far along it as AP allows, stopping
      // adjacent if the cell itself is occupied.
      const res = helper.findPathTowardsUnexplored(entity, gameState, this.player, null, [requester.cell]);
      if (!res || !res.path || res.path.length === 0) return null;
      const moved = helper.moveAlongPath(this.player, entity, moveAction, res.path, gameState, 'guard', `Guard ${requester.name}`);
      return { ordersUsed: moved ? 1 : 0 };
    }
    return null;
  }

  /**
   * Flee to the reachable cell that best escapes the threat: farthest from
   * it, with a pull toward a protector if one exists. Reach is real
   * movement (findReachableCells), not a fixed distance.
   */
  executeFlee(entity, threat) {
    const helper = this.helper;
    const gameState = this.gameState;
    const maxAP = asNumber(entity.maxActionPoints, asNumber(entity.actionPoints, 0));
    const cells = helper.findReachableCells(gameState, entity, Math.ceil(maxAP) + this.config.reachStepMargin);
    if (cells.size <= 1) return helper.explore(gameState, entity, null, false, null);

    const protectors = this.getMyUnits().filter(u =>
      u.id !== entity.id && helper.isCombatCapable(u)
    );
    let best = null;
    let bestScore = -Infinity;
    for (const { cell } of cells.values()) {
      if (cell.q === entity.q && cell.r === entity.r) continue;
      let score = threat ? helper.distance(cell, threat) : 0;
      // Pull toward the nearest protector.
      if (protectors.length > 0) {
        let nearest = Infinity;
        for (const p of protectors) nearest = Math.min(nearest, helper.distance(cell, p));
        score -= nearest * 0.5;
      }
      if (score > bestScore) { bestScore = score; best = cell; }
    }
    if (!best) return helper.explore(gameState, entity, null, false, null);
    // B1: move directly along the path to the best cell. explore's 5th
    // argument is an ignore-list, not a destination — passing the best cell
    // there made the unit walk toward the fog (possibly toward the enemy)
    // instead of fleeing. findReachableCells returns {cell, path} per key,
    // so take the path to the best cell and move along it; moveAlongPath
    // returns 1/0, so wrap it in {ordersUsed} for executeCandidate.
    const moveAction = entity.getActions ? entity.getActions().find(a => a.name === 'Move') : null;
    if (!moveAction) return helper.explore(gameState, entity, null, false, null);
    const entry = cells.get(`${best.q},${best.r}`);
    const path = entry?.path || [];
    if (path.length === 0) return helper.explore(gameState, entity, null, false, null);
    const moved = helper.moveAlongPath(this.player, entity, moveAction, path, gameState, 'flee', `Flee from ${threat?.name || 'threat'}`);
    return { ordersUsed: moved ? 1 : 0 };
  }

  // ==================== Helpers ====================

  getBuildables(entity) {
    if (entity.buildables) return entity.buildables;
    const def = this.getEntityDef(entity.name ?? entity.type);
    return def?.buildables || [];
  }

  getEntityDef(name) {
    const manifest = this.gameState.manifestData;
    if (!manifest) return null;
    const entities = manifest.entities;
    if (!entities) return null;
    if (!Array.isArray(entities) && entities[name]) return entities[name];
    if (Array.isArray(entities)) return entities.find(d => d.name === name) || null;
    const wrapped = entities.entities || [];
    return wrapped.find(d => d.name === name) || null;
  }

  /** Canonical manifest key for a buildable name (case-insensitive). */
  canonicalName(name) {
    const entities = this.gameState.manifestData?.entities || {};
    if (!name) return null;
    if (entities[name]) return name;
    const lower = String(name).toLowerCase();
    return Object.keys(entities).find(k => k.toLowerCase() === lower) || null;
  }

  isMilitary(entity) {
    return this.helper.isDedicatedMilitary(entity, this.gameState.manifestData);
  }

  isBuilder(entity) {
    return this.helper.isBuilder(entity);
  }

  getVisibleEnemies() {
    const groups = this.player.getOpponents ? this.player.getOpponents(this.gameState) : {};
    const enemies = [];
    for (const group of Object.values(groups || {})) {
      for (const e of group.entities || []) {
        if (e && !e.destroyed) enemies.push(e);
      }
    }
    return enemies;
  }

  getMyUnits() {
    const gameState = this.gameState;
    const player = this.player;
    if (!gameState || !gameState.entities) return [];
    return gameState.entities.filter(e =>
      e && !e.destroyed && (e.ownerId === player.id || e.owner?.id === player.id)
    );
  }

  applyFocusMultiplier(importance, category, directive) {
    const focus = directive.focus || 'balanced';
    const multipliers = this.focusMultipliers[focus] || this.focusMultipliers.balanced;
    return importance * (multipliers[category] || 1.0);
  }

  // ==================== Chat stubs ====================

  async summarizeChatAndAddNote(otherPlayer) {
    // The tactical AI does not own diplomacy; the optional LLM director does.
  }

  async generateChatReply(otherPlayer, contextPrompt = null) {
    return {
      content: 'Our actions will speak for us.',
      ended: true,
    };
  }
}

export default EntityCentricAI;
