import { AdaptiveManager } from './adaptiveManager.js';

/**
 * HarkManager - Hark's tactical AI, a subclass of AdaptiveManager.
 *
 * It keeps the adaptive AI's turn loop, economy analysis and scoring, and
 * overrides only the strategy choices listed in the PR #46 review as
 * "not taken" for the adaptive AI (B2-B11). Each override is tagged with its
 * item id. B12 is deliberately NOT implemented: whether to treat an attacking
 * friendly/ally as a threat is a diplomacy decision for the director layer,
 * not the tactical AI.
 *
 * Tunables are read from the controller config in definitions/ai.json
 * ("hark"). Per mistakes.md #3 there are no in-code fallbacks for Hark's own
 * keys: a missing key disables the behaviour it controls (logged once).
 *
 * - B2  Emergency defence strikes first: only units that can attack a target
 *       THIS turn are sent to attack, across every immediate target, before
 *       any order is spent closing distance. Units that cannot strike yet are
 *       not dropped: a separate ADVANCE step moves them toward the threat
 *       (after strikes and after saving adjacent vulnerable units). A unit
 *       whose attempt on a target used zero orders is skipped for THAT target
 *       for the rest of the turn (failure is target-specific).
 * - B3  Builders never explore.
 * - B4  No role ban and no blanket builder fallback: each candidate gets a
 *       "best use" check. A builder that still has build charges fights only
 *       if its current combat power is at least `builderCombatRatio` of the
 *       target's current power, or, when no other unit can answer the
 *       threat, at least `builderLastResortRatio` of it.
 * - B5  Never build a second prerequisite builder while one of that type with
 *       build charges is owned; directly-affordable (depth-0) remedy steps
 *       always outrank prerequisite steps.
 * - B6  Retreat threats are combat-capable AND (hostile stance, or have
 *       attacked us). Hostile = barbarian, offensive, defensive, caution.
 * - B9  Two distance measures in general combat: threat DETECTION uses the
 *       distance to ANY own entity (an enemy next to a farm is a threat to
 *       the farm); engagement RANGE and PRIORITY use the distance to the
 *       nearest combat-capable own unit (can we reach it?). Part 2 (hostile
 *       stance goes through hasOffensiveAdvantage) is inherited unchanged.
 * - B10 While any resource is urgent (deficit), producers of resources that
 *       are already in surplus are hard-skipped (score 0), not just damped.
 * - B11 Build sites within `foreignStructureBuffer` hexes of a visible
 *       structure owned by a player we are neutral or cautious toward are
 *       excluded. Friendly/ally (and hostile) owners: no restriction.
 */

const ORDERS_RESOURCE = 'orders';
const EXPLORE_RETRY_DIRECTIONS = 3; // same as the adaptive explorer's retry loop

/** Hark's own config keys (definitions/ai.json -> controllers.hark.config). */
const HARK_CONFIG_KEYS = [
    'foreignStructureBuffer',
    'builderCombatRatio',
    'builderLastResortRatio',
];

/** Stances under which an opponent's combat units are retreat threats (B6). */
const HOSTILE_STANCES = new Set(['offensive', 'defensive', 'caution']);
/** Stances whose structures we keep a building buffer from (B11). */
const BUILD_BUFFER_STANCES = new Set(['neutral', 'caution']);
/** Stances we never target or flee from (B12 skipped: no override here). */
const FRIENDLY_STANCES = new Set(['friendly', 'ally']);

function num(value, fallback = 0) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function ordersUsedFrom(result) {
    return typeof result === 'number' ? result : num(result?.ordersUsed, 0);
}

function shortId(entity) {
    return String(entity?.id).slice(-4);
}

export class HarkManager extends AdaptiveManager {
    constructor(player, helper) {
        super(player, helper);
        const rawConfig = player.controller?.config || {};
        this.harkConfig = {};
        const missing = [];
        for (const key of HARK_CONFIG_KEYS) {
            if (typeof rawConfig[key] === 'number' && Number.isFinite(rawConfig[key])) {
                this.harkConfig[key] = rawConfig[key];
            } else {
                missing.push(key);
            }
        }
        if (missing.length > 0) {
            this.helper.aiLog(
                player,
                'warn',
                `Hark AI: config key(s) [${missing.join(', ')}] missing from definitions/ai.json; the behaviour they control is disabled.`
            );
        }
    }

    createTurnState() {
        return {
            ...super.createTurnState(),
            // B2: "unitId:targetId" pairs whose attack attempt used no orders this turn.
            failedAttacks: new Set(),
            restrictedStructures: null,
            loggedOnce: new Set(),
        };
    }

    // ==================== Shared predicates ====================

    isBarbarianOwner(ownerId) {
        return ownerId === null || ownerId === undefined;
    }

    /** True if this builder still has something to build (charges left). */
    hasBuildPotential(entity) {
        if (!this.helper.isBuilder(entity)) return false;
        if (this.getBuildCharges(entity) <= 0) return false;
        return this.getBuilderBuildables(entity).length > 0;
    }

    combatPower(entity) {
        return this.helper.getCombatPower(entity, this.getEntityMeta(entity));
    }

    failKey(unit, target) {
        return `${unit.id}:${target.id}`;
    }

    // ==================== B2: strike feasibility ====================

    /**
     * Can `unit` land an attack on `target` this turn (from where it stands,
     * or after one move that leaves enough AP for the attack)?
     */
    canStrikeThisTurn(unit, target) {
        const actions = unit.getActions ? unit.getActions() : [];
        const attackAction = actions.find(action => action.name === 'Attack');
        if (!attackAction) return false;
        const targetCell = target.cell;
        if (!targetCell) return false;

        const now = attackAction.canDo(targetCell, target);
        if (now?.possible) return true;

        const moveAction = actions.find(action => action.name === 'Move');
        if (!moveAction || num(unit.actionPoints) <= 0) return false;
        // Moving costs an order, attacking another.
        if (num(this.player.orders) < 2) return false;

        const ranged = unit.range && typeof unit.range === 'object';
        const minD = ranged ? num(unit.range.minCells, 1) : 1;
        const maxD = ranged ? num(unit.range.maxCells, 1) : 1;
        const scale = num(unit.attackCostScale, 1);
        const exhaustion = num(unit.state?.battleExhaustion, 1);
        const costFunc = typeof unit.getMovementCost === 'function'
            ? unit.getMovementCost.bind(unit)
            : null;
        if (!ranged && !costFunc) return false;

        for (const cell of this.cellsWithin(targetCell, maxD)) {
            const dist = this.helper.distance(cell, targetCell);
            if (dist < minD || dist > maxD) continue;
            if (this.gameState.getEntityAt(cell.q, cell.r)) continue;
            if (!unit.canStandOn(cell)) continue;
            const move = moveAction.canDo(cell, null);
            if (!move?.possible) continue;

            let attackCost;
            if (ranged) {
                const sight = this.helper.getSightAndTrajectory(cell, targetCell);
                const trajectoryOk = sight.visible || (sight.maxObstructionDelta < num(unit.range.arcHeight));
                if (!trajectoryOk) continue;
                attackCost = Math.ceil(scale * exhaustion * dist);
            } else {
                const path = this.helper.movementCostTo(cell, targetCell, costFunc, { allowDetours: true });
                if (!path || !path.reached) continue;
                attackCost = Math.ceil(scale * exhaustion * path.cost);
            }
            if (num(unit.actionPoints) - num(move.cost) >= attackCost) return true;
        }
        return false;
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

    // ==================== B4: per-unit best use ====================

    /**
     * Combat-capable units with AP within the emergency cap of `target`,
     * each checked for its best use (B4). Builders with build potential are
     * kept only if their combat value clearly beats their build value
     * relative to this target, or if nothing else can answer the threat.
     */
    getDefencePool(target) {
        const inRange = this.getActiveEntities().filter(entity =>
            this.helper.isCombatCapable(entity)
            && num(entity.actionPoints) > 0
            && this.helper.distance(entity, target) <= this.config.opportunisticRange
        );
        const fighters = inRange.filter(entity => !this.hasBuildPotential(entity));
        const builders = inRange.filter(entity => this.hasBuildPotential(entity));
        const targetPower = Math.max(1, this.combatPower(target));
        const hasAlternative = fighters.length > 0;

        const ratioKey = hasAlternative ? 'builderCombatRatio' : 'builderLastResortRatio';
        const ratio = this.harkConfig[ratioKey];
        const keptBuilders = typeof ratio === 'number'
            ? builders.filter(builder => this.combatPower(builder) / targetPower >= ratio)
            : [];

        if (builders.length > 0) {
            this.helper.aiLog(
                this.player,
                'detail',
                `Best-use check vs ${target.name}#${shortId(target)} (power ${Math.round(targetPower)}) | `
                + `bar ${ratioKey}=${ratio} | `
                + builders.map(builder => `${builder.name}#${shortId(builder)} power ${Math.round(this.combatPower(builder))} -> `
                    + (keptBuilders.some(kept => kept.id === builder.id) ? 'fight' : 'keep building')).join(', ')
            );
        }
        return [...fighters, ...keptBuilders];
    }

    sortForEngagement(units, target) {
        return [...units].sort((a, b) => {
            const distA = this.helper.distance(a, target);
            const distB = this.helper.distance(b, target);
            if (distA !== distB) return distA - distB;
            return this.combatPower(b) - this.combatPower(a);
        });
    }

    /**
     * options.emergency: B2+B4 strikers (can attack this turn).
     * options.advance:   B4 pool members that cannot strike yet (close distance).
     * otherwise:         the adaptive AI's opportunistic pool, unchanged.
     */
    selectAttackers(target, options = {}) {
        if (!options.emergency && !options.advance) return super.selectAttackers(target, options);
        const failed = this.turnState.failedAttacks;
        const pool = this.getDefencePool(target)
            .filter(unit => !failed.has(this.failKey(unit, target)));
        const chosen = options.advance
            ? pool.filter(unit => this.helper.isMobile(unit) && !this.canStrikeThisTurn(unit, target))
            : pool.filter(unit => this.canStrikeThisTurn(unit, target));
        return this.sortForEngagement(chosen, target);
    }

    /** helper.attack with B2 failure bookkeeping. Returns orders used. */
    engage(attacker, target, label, ownerName, involvedCells) {
        const from = { q: attacker.q, r: attacker.r };
        const result = this.helper.attack(this.gameState, attacker, target, 1);
        const used = ordersUsedFrom(result);
        if (used > 0) {
            involvedCells.push(from, attacker.cell);
            this.helper.aiLog(
                this.player,
                'combat',
                `${label} result | ${attacker.name}#${shortId(attacker)} from (${from.q},${from.r}) -> ${target.name}#${shortId(target)} `
                + `(${ownerName}) at (${target.q},${target.r}) | Orders used: ${used} | ${result?.result?.message || 'engaged'}`
            );
        } else {
            this.turnState.failedAttacks.add(this.failKey(attacker, target));
        }
        return used;
    }

    // ==================== Emergency defence (B2, B4) ====================

    getImmediateThreats() {
        const own = this.getActiveEntities();
        const foreign = this.getVisibleForeignEntities();
        if (own.length === 0 || foreign.length === 0) return [];

        const history = this.getAttackerHistory();
        const immediate = [];
        const alliedEntities = foreign
            .filter(item => this.getStance(item.ownerId) === 'ally')
            .map(item => item.entity);

        // Same immediacy rules as AdaptiveManager.attemptEmergencyDefense.
        for (const item of foreign) {
            const target = item.entity;
            const stance = this.getStance(item.ownerId);
            const friendly = FRIENDLY_STANCES.has(stance);
            const nearestOwn = Math.min(...own.map(unit => this.helper.distance(unit, target)));
            const nearestAlly = alliedEntities.length
                ? Math.min(...alliedEntities.map(ally => this.helper.distance(target, ally)))
                : Infinity;
            const attackerDamage = num(history.get(target.id));
            const rangeMax = num(target.range?.maxCells, 1);
            const moveBonus = target.isConstruct ? 0 : 1;
            const canStrike = nearestOwn <= Math.max(1, rangeMax) + moveBonus;
            const alliedThreat = alliedEntities.length > 0
                && nearestAlly <= Math.max(1, rangeMax) + moveBonus;
            const passive = (stance === 'caution' || stance === 'neutral') && attackerDamage === 0;
            const isImmediate = attackerDamage > 0
                || (!friendly && ((!passive && (nearestOwn <= 1 || canStrike)) || alliedThreat));
            if (!isImmediate) continue;
            immediate.push({ ...item, stance, nearestOwn, nearestAlly, attackerDamage, alliedThreat });
        }

        return immediate.sort((a, b) => b.attackerDamage - a.attackerDamage
            || Math.min(a.nearestOwn, a.nearestAlly) - Math.min(b.nearestOwn, b.nearestAlly));
    }

    attemptEmergencyDefense(econ, involvedCells) {
        const immediate = this.getImmediateThreats();
        if (immediate.length === 0) return false;

        // Phase 1 - strike: any unit that can hit any immediate threat now.
        for (const item of immediate) {
            const target = item.entity;
            const strikers = this.selectAttackers(target, { emergency: true });
            if (strikers.length === 0) continue;
            this.helper.aiLog(
                this.player,
                'combat',
                `Emergency strike | Target: ${target.name}#${shortId(target)} (${item.ownerName}) at (${target.q},${target.r}) `
                + `| Threat: ${item.attackerDamage > 0 ? `attacked us for ${item.attackerDamage.toFixed(1)}` : item.alliedThreat ? 'striking an ally' : `within striking distance (${item.nearestOwn} hex)`} `
                + `| Stance: ${item.stance} | Strikers: [${strikers.map(unit => `${unit.name}#${shortId(unit)}`).join(', ')}]`
            );
            for (const attacker of strikers) {
                if (this.engage(attacker, target, 'Emergency strike', item.ownerName, involvedCells) > 0) return true;
            }
        }

        // Phase 2 - save vulnerable units standing next to a threat.
        if (this.attemptRetreats(econ, involvedCells, true)) return true;

        // Phase 3 - advance: units that cannot strike yet close the distance.
        for (const item of immediate) {
            const target = item.entity;
            const advancers = this.selectAttackers(target, { advance: true });
            for (const unit of advancers) {
                if (this.engage(unit, target, 'Emergency advance', item.ownerName, involvedCells) > 0) return true;
            }
        }
        return false;
    }

    // ==================== General combat (B2 advance, B9) ====================

    attemptCombat(econ, involvedCells) {
        const own = this.getActiveEntities();
        const foreign = this.getVisibleForeignEntities();
        if (foreign.length === 0) return false;

        const summary = this.getThreatSummary();
        const history = this.getAttackerHistory();
        const combatUnits = own.filter(entity => this.helper.isCombatCapable(entity));
        const hasCombat = combatUnits.some(entity => num(entity.actionPoints) > 0);

        if (!hasCombat) {
            if (summary.hasThreats) {
                return this.attemptProactiveBuild(econ, { category: 'military', defensive: true, involvedCells });
            }
            return false;
        }

        const alliedEntities = foreign
            .filter(item => this.getStance(item.ownerId) === 'ally')
            .map(item => item.entity);
        const targets = [];

        for (const item of foreign) {
            const target = item.entity;
            const stance = this.getStance(item.ownerId);
            if (FRIENDLY_STANCES.has(stance)) continue;

            // B9: detection measure (any own entity) ...
            const nearestOwn = Math.min(...own.map(unit => this.helper.distance(unit, target)));
            // ... and engagement measure (combat-capable own units only).
            const nearestCombat = combatUnits.length
                ? Math.min(...combatUnits.map(unit => this.helper.distance(unit, target)))
                : Infinity;
            const nearestAlly = alliedEntities.length
                ? Math.min(...alliedEntities.map(ally => this.helper.distance(target, ally)))
                : Infinity;
            const attackerDamage = num(history.get(target.id));

            const isBarbarian = this.isBarbarianOwner(item.ownerId);
            const targetReach = Math.max(1, num(target.range?.maxCells, 1)) + (target.isConstruct ? 0 : 1);
            const proximityThreat = (isBarbarian || stance === 'defensive') && nearestOwn <= this.config.threatRadius;
            const alliedThreat = alliedEntities.length > 0 && nearestAlly <= targetReach;
            const isThreat = attackerDamage > 0 || proximityThreat || alliedThreat;

            let allowed = false;
            let reason = '';
            if (isThreat) {
                allowed = true;
                reason = attackerDamage > 0 ? 'retaliation' : alliedThreat ? 'defending ally' : 'threat in territory';
            } else if (stance === 'offensive') {
                allowed = this.hasOffensiveAdvantage(target, foreign);
                reason = 'offensive stance';
            } else if (stance === 'defensive') {
                // B9: engagement range measured from our combat units.
                allowed = nearestCombat <= this.config.threatRadius + 2;
                reason = 'defensive engagement range';
            }
            if (!allowed) continue;

            const meta = this.getEntityMeta(target);
            let yieldValue = 0;
            for (const [res, amount] of Object.entries(meta.yields || {})) {
                if (res === ORDERS_RESOURCE) continue;
                yieldValue += num(amount);
            }
            const value = num(meta.score?.military)
                + num(meta.score?.economic)
                + yieldValue * 2
                + num(meta.ordersPerTurn) * 10
                + num(meta.damage?.value) * 0.2
                + (this.helper.isBuilder(target) ? 5 : 0)
                + (this.helper.isRepairer(target) ? 5 : 0);

            targets.push({
                ...item,
                stance,
                nearestOwn,
                nearestCombat,
                nearestAlly,
                attackerDamage,
                isThreat,
                reason,
                // B9: priority distance from our combat units, not from any entity.
                priority: (isThreat ? 1000 + attackerDamage * 10 : 0)
                    + value
                    - Math.min(nearestCombat, nearestAlly) * 2
                    + (stance === 'offensive' ? 50 : 0)
                    + num(item.group?.score?.total) * 0.05,
            });
        }

        const sorted = [...targets].sort((a, b) => b.priority - a.priority);

        // Strike pass: threats use the B2/B4 strike pool; offensive targets
        // use the adaptive opportunistic pool (which closes distance itself).
        for (const item of sorted) {
            const target = item.entity;
            const candidates = this.selectAttackers(target, { emergency: item.isThreat });
            if (candidates.length === 0) continue;
            this.helper.aiLog(
                this.player,
                'combat',
                `Engagement decision | Target: ${target.name}#${shortId(target)} (${item.ownerName}) at (${target.q},${target.r}) `
                + `| Stance: ${item.stance} | Reason: ${item.reason} | Dist(any/combat): ${item.nearestOwn}/${item.nearestCombat} `
                + `| Candidates: [${candidates.map(unit => `${unit.name}#${shortId(unit)}@(${unit.q},${unit.r})`).join(', ')}]`
            );
            for (const attacker of candidates) {
                if (this.engage(attacker, target, 'Engagement', item.ownerName, involvedCells) > 0) return true;
            }
        }

        // Advance pass (B2): close distance on threats nobody can hit yet.
        for (const item of sorted) {
            if (!item.isThreat) continue;
            for (const unit of this.selectAttackers(item.entity, { advance: true })) {
                if (this.engage(unit, item.entity, 'Advance on threat', item.ownerName, involvedCells) > 0) return true;
            }
        }

        const hasDedicated = own.some(entity =>
            this.helper.isDedicatedMilitary(entity, this.manifest) && num(entity.actionPoints) > 0
        );
        if (!hasDedicated && summary.hasThreats) {
            return this.attemptProactiveBuild(econ, { category: 'military', defensive: true, involvedCells });
        }
        return false;
    }

    // ==================== B6: retreats ====================

    isRetreatThreat(item) {
        const stance = this.getStance(item.ownerId);
        if (FRIENDLY_STANCES.has(stance)) return false;
        if (!this.helper.isCombatCapable(item.entity)) return false;
        const attacked = num(this.getAttackerHistory().get(item.entity.id)) > 0;
        const hostile = this.isBarbarianOwner(item.ownerId) || HOSTILE_STANCES.has(stance);
        return hostile || attacked;
    }

    attemptRetreats(econ, involvedCells, immediateOnly) {
        const own = this.getActiveEntities();
        const threats = this.getVisibleForeignEntities().filter(item => this.isRetreatThreat(item));
        if (own.length === 0 || threats.length === 0) return false;

        const vulnerable = own.filter(entity =>
            !entity.isConstruct
            && this.helper.isMobile(entity)
            && num(entity.actionPoints) > 0
            && !this.helper.isDedicatedMilitary(entity, this.manifest)
        );

        for (const unit of vulnerable) {
            const currentMin = Math.min(...threats.map(item => this.helper.distance(unit, item.entity)));
            if (immediateOnly ? currentMin > 1 : currentMin > 2) continue;

            const moveAction = unit.getActions ? unit.getActions().find(action => action.name === 'Move') : null;
            if (!moveAction) continue;

            let bestCell = null;
            let bestScore = currentMin;
            for (const cell of this.helper.getNeighbors(unit.q, unit.r)) {
                if (this.gameState.getEntityAt(cell.q, cell.r)) continue;
                if (!unit.canStandOn(cell)) continue;
                const check = moveAction.canDo(cell, null);
                if (!check || !check.possible) continue;
                const score = Math.min(...threats.map(item => this.helper.distance(cell, item.entity)));
                if (score > bestScore) {
                    bestScore = score;
                    bestCell = cell;
                }
            }

            const from = { q: unit.q, r: unit.r };
            if (bestCell && moveAction.do(bestCell, null)) {
                involvedCells.push(from, bestCell);
                this.helper.aiLog(
                    this.player,
                    'warn',
                    `Retreat | ${unit.name}#${shortId(unit)} (${this.player.name}) from (${from.q},${from.r}) to (${bestCell.q},${bestCell.r}) `
                    + `| Nearest hostile combat threat moved from ${currentMin} to ${bestScore} hex(es).`
                );
                return true;
            }
        }
        return false;
    }

    // ==================== B5: production chains ====================

    ownsBuilderWithCharges(typeName) {
        const lower = String(typeName).toLowerCase();
        return this.getActiveEntities().some(entity =>
            String(entity.name).toLowerCase() === lower && this.hasBuildPotential(entity)
        );
    }

    findProductionSteps(targetName, econ, visited = new Set(), depth = 0, out = [], rootTarget = null) {
        const steps = super.findProductionSteps(targetName, econ, visited, depth, out, rootTarget);
        // B5 (1): a prerequisite step that builds a builder type we already
        // own with charges adds maintenance without adding build capacity
        // we lack (the owned one already provides the direct step).
        return steps.filter(step => !(step.depth > 0 && this.ownsBuilderWithCharges(step.targetName)));
    }

    attemptCriticalDeficits(econ, involvedCells) {
        if (!econ.urgent || econ.urgent.length === 0) return false;

        for (const need of econ.urgent) {
            if (this.attemptRepairForResource(need.res, involvedCells)) return true;

            const producers = this.findProducersForResource(need.res, econ);
            if (producers.length === 0) {
                if (!this.turnState.noProducerLogged.has(need.res)) {
                    this.turnState.noProducerLogged.add(need.res);
                    this.helper.aiLog(this.player, 'warn', `No entity in the manifest yields ${need.res}; cannot build a producer for this deficit.`);
                }
                continue;
            }

            const actionCandidates = [];
            for (const producer of producers) {
                for (const step of this.findProductionSteps(producer.name, econ)) {
                    const meta = this.manifestEntities[step.targetName];
                    if (!meta) continue;
                    const cost = meta.spawnCost || {};
                    if (!this.player.hasResources(cost)) continue;
                    const score = (producer.net / this.weightedCost(cost, econ)) / (1 + step.depth * 0.5);
                    actionCandidates.push({ step, producer, score });
                }
            }

            if (actionCandidates.length === 0) {
                const topSteps = this.findProductionSteps(producers[0].name, econ);
                if (topSteps.length > 0) {
                    const pendingCost = this.manifestEntities[topSteps[0].targetName]?.spawnCost || {};
                    this.reserveCost(pendingCost);
                    this.helper.aiLog(this.player, 'econ', `Cannot yet afford the remedy for ${need.res}. Reserving the cost of ${this.helper.camelToTitle(topSteps[0].targetName)} from proactive spending.`);
                } else {
                    this.helper.aiLog(this.player, 'warn', `No owned builder can reach a producer of ${need.res} yet; the production dependency chain is blocked.`);
                }
                continue;
            }

            // B5 (2): a directly-affordable producer (depth 0) always beats a
            // prerequisite step; score only orders steps of equal class.
            const ranked = [...actionCandidates].sort((a, b) =>
                ((a.step.depth === 0 ? 0 : 1) - (b.step.depth === 0 ? 0 : 1)) || (b.score - a.score)
            );

            for (const { step, producer } of ranked) {
                const chainText = step.finalTarget && step.finalTarget !== step.targetName
                    ? `${this.helper.camelToTitle(step.targetName)} (prerequisite for ${this.helper.camelToTitle(step.finalTarget)})`
                    : this.helper.camelToTitle(step.targetName);
                const used = this.executeBuild(
                    step.builder,
                    step.targetName,
                    'econ',
                    `resolve ${need.res} ${need.status} (stock=${need.stock}, net=${need.net}, target producer=${this.helper.camelToTitle(producer.name)}); building ${chainText}`,
                    involvedCells
                );
                if (used > 0) {
                    if (step.finalTarget && step.finalTarget !== step.targetName) {
                        this.reserveCost(this.manifestEntities[step.finalTarget]?.spawnCost || {});
                    }
                    return true;
                }
            }
        }
        return false;
    }

    // ==================== B10: surplus producers under deficit ====================

    scoreBuildCandidate(builder, targetName, meta, econ, own, category) {
        if (econ.urgent.length > 0) {
            let producesSomething = false;
            let onlySurplus = true;
            for (const [res, amount] of Object.entries(meta.yields || {})) {
                if (res === ORDERS_RESOURCE || num(amount) <= 0) continue;
                producesSomething = true;
                if (econ.resources[res]?.status !== 'surplus') onlySurplus = false;
            }
            if (producesSomething && onlySurplus) {
                const key = `b10:${targetName}`;
                if (!this.turnState.loggedOnce.has(key)) {
                    this.turnState.loggedOnce.add(key);
                    this.helper.aiLog(
                        this.player,
                        'build',
                        `Skip ${this.helper.camelToTitle(targetName)}: it only produces surplus resources while `
                        + `[${econ.urgent.map(info => info.res).join(', ')}] is in deficit; stock is reserved for the remedy.`
                    );
                }
                return 0;
            }
        }
        return super.scoreBuildCandidate(builder, targetName, meta, econ, own, category);
    }

    // ==================== B3: builders never explore ====================

    attemptExploration(econ, involvedCells, options = {}) {
        const own = this.getActiveEntities();
        const summary = this.getThreatSummary();
        const damaged = own.filter(entity => this.isDamageWorthRepair(entity));
        const dedicated = own.filter(entity => this.helper.isDedicatedMilitary(entity, this.manifest));
        const militaryExplorerCap = summary.hasThreats ? 0 : Math.max(1, Math.floor(dedicated.length / 2));

        let explorers = own.filter(entity => {
            if (!this.helper.isMobile(entity)) return false;
            if (num(entity.actionPoints) <= 0) return false;
            // B3: a builder sent exploring is a village or farm lost to the first raider.
            if (this.helper.isBuilder(entity)) return false;
            if (options.excludeSupport && this.helper.isRepairer(entity)) return false;
            if (num(entity.maxHealth) > 0 && num(entity.health) <= num(entity.maxHealth) * this.config.repairHealthRatio) return false;
            if (this.helper.isDedicatedMilitary(entity, this.manifest)
                && this.turnState.militaryExplorers >= militaryExplorerCap) return false;
            if (this.helper.isRepairer(entity) && (damaged.length > 0 || summary.hasThreats)) return false;
            return true;
        });
        if (explorers.length === 0) return false;

        explorers = explorers.sort((a, b) => {
            const apA = num(a.maxActionPoints, num(a.actionPoints));
            const apB = num(b.maxActionPoints, num(b.actionPoints));
            if (apA !== apB) return apB - apA;
            const sightA = num(a.sightRange);
            const sightB = num(b.sightRange);
            if (sightA !== sightB) return sightB - sightA;
            return num(b.damage?.value) - num(a.damage?.value);
        });

        if (options.targetCoord) {
            if (this.exploreTowardCoord(options.targetCoord, explorers, involvedCells)) return true;
            if (options.goalOnly) return false;
        }

        const stats = this.getUnexploredDirectionStats({ q: explorers[0].q, r: explorers[0].r });
        if (!stats.some(item => item.count > 0)) {
            if (!this.turnState.fullyExploredLogged) {
                this.turnState.fullyExploredLogged = true;
                this.helper.aiLog(this.player, 'explore', 'All map territory is fully explored.');
            }
            return false;
        }

        const preferred = options.preferredDirection
            ? this.normalizeExploreDirection(options.preferredDirection, stats)
            : null;
        const chosen = preferred
            ? stats.find(item => item.direction === preferred && item.count > 0)
            : this.pickExploreDirection(stats);

        const recordExplorer = (explorer, from, used, label) => {
            if (this.helper.isDedicatedMilitary(explorer, this.manifest)) this.turnState.militaryExplorers += 1;
            involvedCells.push(from, explorer.cell);
            this.helper.aiLog(
                this.player,
                'explore',
                `${label} | ${explorer.name}#${shortId(explorer)} (${this.player.name}) from (${from.q},${from.r}) to (${explorer.q},${explorer.r}) | Orders used: ${used}`
            );
        };

        for (const explorer of explorers) {
            let direction = chosen?.direction || this.pickExploreDirection(stats)?.direction;
            for (let attempt = 0; attempt < EXPLORE_RETRY_DIRECTIONS && direction; attempt++) {
                const from = { q: explorer.q, r: explorer.r };
                const used = ordersUsedFrom(this.helper.explore(this.gameState, explorer, direction, false, this.turnState.targetedCells));
                if (used > 0) {
                    this.turnState.usedExploreDirections[direction] = num(this.turnState.usedExploreDirections[direction]) + 1;
                    recordExplorer(explorer, from, used, `Explore decision toward ${direction}`);
                    return true;
                }
                direction = this.pickExploreDirection(stats, direction)?.direction || null;
            }
        }

        for (const explorer of explorers) {
            const from = { q: explorer.q, r: explorer.r };
            const used = ordersUsedFrom(this.helper.explore(this.gameState, explorer, null, false, this.turnState.targetedCells));
            if (used > 0) {
                recordExplorer(explorer, from, used, 'Explore fallback (nearest unexplored)');
                return true;
            }
        }
        return false;
    }

    // ==================== B11: stance-aware build sites ====================

    /** Visible structures of owners whose stance asks us to keep our distance. */
    getRestrictedStructures() {
        if (this.turnState.restrictedStructures) return this.turnState.restrictedStructures;
        const list = typeof this.harkConfig.foreignStructureBuffer === 'number'
            ? this.getVisibleForeignEntities()
                .filter(item => !this.isBarbarianOwner(item.ownerId)
                    && item.entity.isConstruct
                    && BUILD_BUFFER_STANCES.has(this.getStance(item.ownerId)))
                .map(item => item.entity)
            : [];
        this.turnState.restrictedStructures = list;
        return list;
    }

    filterBuildCandidates(candidates) {
        const restricted = this.getRestrictedStructures();
        if (restricted.length === 0) return candidates;
        const buffer = this.harkConfig.foreignStructureBuffer;
        return candidates.filter(candidate =>
            restricted.every(structure => this.helper.distance(candidate.cell, structure) > buffer)
        );
    }

    /**
     * Picks a site the same way AiHelper.build does (nearest, upgraded to a
     * farther site when its yield gain beats the distance penalty).
     */
    pickBuildSite(candidates) {
        let pool = [...candidates].sort((a, b) => a.dist - b.dist || b.yield - a.yield);
        const penalty = this.helper.getConfig().buildDistancePenalty;
        let best = pool[0];
        if (typeof penalty !== 'number') return best;
        for (const candidate of pool.slice(1)) {
            if (candidate.yield <= best.yield) continue;
            const gain = best.yield > 0 ? candidate.yield / best.yield - 1 : Infinity;
            if (penalty * (candidate.dist - best.dist) < gain) best = candidate;
        }
        return best;
    }

    /** Move to (if needed) and build at a specific site. Returns orders used. */
    buildAtSite(builder, targetName, site, category, reason, involvedCells) {
        const actions = builder.getActions ? builder.getActions() : [];
        const expected = `build ${this.helper.camelToTitle(targetName)}`.toLowerCase();
        const buildAction = actions.find(action =>
            action.name.toLowerCase() === expected || action.name.toLowerCase() === `build ${String(targetName).toLowerCase()}`
        );
        if (!buildAction) return 0;
        const moveAction = actions.find(action => action.name === 'Move');
        const start = { q: builder.q, r: builder.r };

        this.helper.aiLog(
            this.player,
            category,
            `Build decision | Builder: ${builder.name}#${shortId(builder)} (${this.player.name}) at (${start.q},${start.r}) `
            + `| Target: ${this.helper.camelToTitle(targetName)} at (${site.cell.q},${site.cell.r}) | Reason: ${reason} `
            + `| Site kept ${this.harkConfig.foreignStructureBuffer}+ hexes from neutral/caution structures`
        );

        let used = 0;
        if (site.stage.path.length > 0) {
            if (!moveAction || num(builder.actionPoints) <= 0) return 0;
            const moved = this.helper.moveAlongPath(
                this.player, builder, moveAction, site.stage.path, this.gameState, category,
                `moving to build ${this.helper.camelToTitle(targetName)} at (${site.cell.q},${site.cell.r})`
            );
            if (!moved) return 0;
            used = 1;
            involvedCells.push(start, builder.cell);
        }
        if (this.player.orders <= 0) return used;
        if (this.helper.distance(builder, site.cell) !== 1) return used;

        const check = buildAction.canDo(site.cell, null);
        if (check?.possible && buildAction.do(site.cell, null)) {
            involvedCells.push(start, site.cell);
            this.helper.aiLog(this.player, category, `Build result | ${builder.name}#${shortId(builder)} -> ${this.helper.camelToTitle(targetName)} at (${site.cell.q},${site.cell.r})`);
            return used + 1;
        }
        return used;
    }

    executeBuild(builder, targetName, category, reason, involvedCells) {
        if (!builder || !builder.active || this.getBuildCharges(builder) <= 0) return 0;
        if (this.getRestrictedStructures().length === 0) {
            return super.executeBuild(builder, targetName, category, reason, involvedCells);
        }
        const { candidates } = this.helper.findBuildCandidates(this.gameState, builder, targetName);
        const allowed = this.filterBuildCandidates(candidates || []);
        if (allowed.length === (candidates || []).length) {
            return super.executeBuild(builder, targetName, category, reason, involvedCells);
        }
        if (allowed.length === 0) {
            const key = `${builder.id}:${targetName}`;
            if (!this.turnState.loggedOnce.has(key)) {
                this.turnState.loggedOnce.add(key);
                this.helper.aiLog(
                    this.player,
                    'build',
                    `Skip build | ${builder.name}#${shortId(builder)}: every ${this.helper.camelToTitle(targetName)} site is within `
                    + `${this.harkConfig.foreignStructureBuffer} hexes of a neutral/caution player's structure.`
                );
            }
            return 0;
        }
        return this.buildAtSite(builder, targetName, this.pickBuildSite(allowed), category, reason, involvedCells);
    }

    executeBuildWithGoal(builder, targetName, goal, involvedCells) {
        if (this.getRestrictedStructures().length === 0) {
            return super.executeBuildWithGoal(builder, targetName, goal, involvedCells);
        }
        const { candidates } = this.helper.findBuildCandidates(this.gameState, builder, targetName);
        let pool = this.filterBuildCandidates(candidates || []);
        if (pool.length === 0) return 0;

        if (goal?.direction) {
            const startCell = this.getStartCell();
            if (startCell) {
                const wanted = String(goal.direction).toUpperCase();
                const filtered = pool.filter(candidate =>
                    this.helper.directionTo(startCell, candidate.cell, true).fromSource === wanted
                );
                if (filtered.length > 0) pool = filtered;
            }
        }
        const targetCoord = this.getGoalTargetCoord(goal);
        const site = targetCoord
            ? [...pool].sort((a, b) => this.helper.distance(a.cell, targetCoord) - this.helper.distance(b.cell, targetCoord))[0]
            : this.pickBuildSite(pool);
        return this.buildAtSite(builder, targetName, site, 'build', `goal ${goal?.type || 'build'}`, involvedCells);
    }
}

export default HarkManager;
