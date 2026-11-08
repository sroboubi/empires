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
 *       (A territory-based retreat step was tested on paired seeds and not
 *       kept: it lost more games than it won; see the PR notes.)
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
 * - Dynamic stance: ONLY when no directive is set, per-opponent stances are
 *   chosen each turn from the game state (chooseDynamicStances). A provided
 *   directive always overrides this completely.
 *
 * The strategy points are AdaptiveManager hooks (respondToImmediateThreats,
 * getEngagementDistance, engageCombatTargets, isRetreatThreat,
 * rankDeficitCandidates, isExplorerCandidate,
 * filterBuildCandidates, resolveDirective), so nothing is copied from it.
 */

const ORDERS_RESOURCE = 'orders';

/** Hark's own config keys (definitions/ai.json -> controllers.hark.config). */
const HARK_CONFIG_KEYS = [
    'foreignStructureBuffer',
    'builderCombatRatio',
    'builderLastResortRatio',
    'territoryRadius',
    'stanceOffensiveRatio',
    'stanceCautionRatio',
    'offenceEnterRatio',
    'offenceExitRatio',
    'offenceMemoryRounds',
    'offenceHomeGarrison',
    'offenceMaxDistance',
    'offenceLeash',
];

/** Keys the dynamic stance needs; if any is missing it stays off (all neutral). */
const DYNAMIC_STANCE_KEYS = ['territoryRadius', 'stanceOffensiveRatio', 'stanceCautionRatio'];
/** Keys the proactive offence (part of the dynamic stance) needs; if any is missing it stays off. */
const OFFENCE_KEYS = ['offenceEnterRatio', 'offenceExitRatio', 'offenceMemoryRounds', 'offenceHomeGarrison', 'offenceMaxDistance', 'offenceLeash'];

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

    // ==================== Dynamic stance (only when no directive is set) ====================

    /**
     * A provided directive (director/LLM or config) always wins and is used
     * unchanged. Only when none is set does Hark pick per-opponent stances
     * from the game state (chooseDynamicStances). Focus is left to the
     * adaptive pillar weighting.
     */
    resolveDirective() {
        const directive = super.resolveDirective();
        if (this.getExplicitDirective()) return directive;
        const stance = this.chooseDynamicStances();
        return stance ? { ...directive, stance } : directive;
    }

    /**
     * Per visible opponent player (barbarians keep their fixed stance).
     * Power = summed combat power of mobile combat-capable units (ours, and
     * their visible ones); structures are left out so a village's armour
     * does not read as an army.
     * - attacked us in the attacker-history window: offensive if our power
     *   is at least `stanceOffensiveRatio` x theirs, else defensive;
     * - else their military units are inside our territory (within
     *   `territoryRadius` hexes of one of our structures): defensive;
     * - else their power is at least `stanceCautionRatio` x ours: caution;
     * - else neutral (the default). Hark never turns offensive on a player
     *   that has not attacked it: a tested pre-emptive rule (offensive when
     *   3x stronger) lost more games than it won against adaptive.
     * Returns null (feature off) when one of DYNAMIC_STANCE_KEYS is missing.
     */
    chooseDynamicStances() {
        if (DYNAMIC_STANCE_KEYS.some(key => typeof this.harkConfig[key] !== 'number')) return null;
        const { territoryRadius, stanceOffensiveRatio, stanceCautionRatio } = this.harkConfig;
        const offenceOn = OFFENCE_KEYS.every(key => typeof this.harkConfig[key] === 'number');
        const round = num(this.gameState?.currentRound, 1);

        const own = this.getActiveEntities();
        const anchors = own.filter(entity => entity.isConstruct);
        const isArmy = entity => !entity.isConstruct && this.helper.isCombatCapable(entity);
        const ourPower = own.filter(isArmy).reduce((sum, entity) => sum + this.combatPower(entity), 0);
        const history = this.getAttackerHistory();

        const byOwner = new Map();
        for (const item of this.getVisibleForeignEntities()) {
            if (this.isBarbarianOwner(item.ownerId)) continue;
            if (!byOwner.has(item.ownerId)) {
                byOwner.set(item.ownerId, { power: 0, attacked: false, intruding: false, entities: [] });
            }
            const record = byOwner.get(item.ownerId);
            const entity = item.entity;
            record.entities.push(entity);
            if (num(history.get(entity.id)) > 0) record.attacked = true;
            if (!isArmy(entity)) continue;
            record.power += this.combatPower(entity);
            if (this.helper.isDedicatedMilitary(entity, this.manifest)
                && this.distanceToTerritory(entity, anchors) <= territoryRadius) {
                record.intruding = true;
            }
        }

        const offence = offenceOn ? this.updateOffence(byOwner, own, anchors, round) : null;

        const stance = {};
        const notes = [];
        for (const [ownerId, record] of byOwner) {
            let choice = 'neutral';
            let why = '';
            if (record.attacked) {
                choice = ourPower >= record.power * stanceOffensiveRatio ? 'offensive' : 'defensive';
                why = 'attacked us';
            } else if (record.intruding) {
                choice = 'defensive';
                why = 'military units in our territory';
            } else if (offence && String(offence.ownerId) === String(ownerId)) {
                choice = 'offensive';
                why = `proactive: strike force ${Math.round(offence.strike)} vs known army ${Math.round(offence.known)}`;
            } else if (record.power > 0 && record.power >= ourPower * stanceCautionRatio) {
                choice = 'caution';
                why = 'much stronger';
            }
            if (choice === 'neutral') continue;
            stance[ownerId] = choice;
            notes.push(`${ownerId}:${choice} (${why}; power ours ${Math.round(ourPower)} / theirs ${Math.round(record.power)})`);
        }
        this.turnState.proactiveOwner = offence && stance[offence.ownerId] === 'offensive'
            && !byOwner.get(offence.ownerId)?.attacked ? String(offence.ownerId) : null;
        if (notes.length > 0) {
            this.helper.aiLog(this.player, 'turn', `Dynamic stance (no directive set) | ${notes.join(', ')}`);
        }
        return stance;
    }

    // ==================== Proactive offence (dynamic stance, no directive only) ====================

    /**
     * Dedicated military units kept home: the `offenceHomeGarrison` closest
     * to our structures. They never join a proactive attack.
     */
    getHomeGarrison(own, anchors) {
        const count = this.harkConfig.offenceHomeGarrison;
        if (!(count > 0) || anchors.length === 0) return new Set();
        const dedicated = own.filter(entity => !entity.isConstruct
            && this.helper.isDedicatedMilitary(entity, this.manifest));
        const sorted = [...dedicated].sort((a, b) =>
            this.distanceToTerritory(a, anchors) - this.distanceToTerritory(b, anchors));
        return new Set(sorted.slice(0, count).map(entity => entity.id));
    }

    /**
     * Picks at most one opponent to attack without having been attacked.
     * Their army is what we have SEEN in the last `offenceMemoryRounds`
     * rounds (not just what is visible now). Our strike force is our
     * dedicated military minus the home garrison. Enter when strike >=
     * `offenceEnterRatio` x known army and one of their entities is within
     * `offenceMaxDistance` of our strike force; stay while strike >=
     * `offenceExitRatio` x known army (hysteresis).
     */
    updateOffence(byOwner, own, anchors, round) {
        const { offenceEnterRatio, offenceExitRatio, offenceMemoryRounds, offenceMaxDistance } = this.harkConfig;
        if (!this.enemyArmyMemory) this.enemyArmyMemory = new Map();
        const memory = this.enemyArmyMemory;
        for (const [ownerId, record] of byOwner) {
            if (!memory.has(ownerId)) memory.set(ownerId, new Map());
            const seen = memory.get(ownerId);
            for (const entity of record.entities) {
                // Their fighting force: dedicated military and armed structures
                // (towers). Workers and settlers do not defend against a raid.
                const armed = entity.isConstruct
                    ? this.helper.isCombatCapable(entity) && this.combatPower(entity) > 0
                    : this.helper.isDedicatedMilitary(entity, this.manifest);
                if (!armed) continue;
                seen.set(entity.id, { entity, power: this.combatPower(entity), round });
            }
        }
        const known = new Map();
        for (const [ownerId, seen] of memory) {
            let power = 0;
            for (const [id, info] of seen) {
                if (info.entity.destroyed || num(info.entity.health) <= 0 || round - info.round > offenceMemoryRounds) {
                    seen.delete(id);
                    continue;
                }
                power += info.power;
            }
            known.set(ownerId, power);
        }

        const garrison = this.getHomeGarrison(own, anchors);
        const strikers = own.filter(entity => !entity.isConstruct
            && this.helper.isDedicatedMilitary(entity, this.manifest) && !garrison.has(entity.id));
        const strike = strikers.reduce((sum, entity) => sum + this.combatPower(entity), 0);
        this.turnState.homeGarrison = garrison;

        const previous = this.offence?.ownerId;
        let best = null;
        for (const [ownerId, record] of byOwner) {
            const theirs = known.get(ownerId) || 0;
            this.helper.aiLog(this.player, 'detail', `Offence check | owner ${ownerId} | strike ${Math.round(strike)} (${strikers.length} units, garrison ${garrison.size}) | known army ${Math.round(theirs)} | attacked ${record.attacked} | intruding ${record.intruding}`);
            if (record.attacked || record.intruding || strike <= 0) continue;
            const ratio = theirs > 0 ? strike / theirs : Infinity;
            const needed = String(ownerId) === String(previous) ? offenceExitRatio : offenceEnterRatio;
            if (ratio < needed) continue;
            const reach = strikers.length && record.entities.length
                ? Math.min(...record.entities.map(target =>
                    Math.min(...strikers.map(unit => this.helper.distance(unit, target)))))
                : Infinity;
            if (reach > offenceMaxDistance) continue;
            const candidate = { ownerId, ratio, reach, strike, known: theirs };
            // One target at a time: keep the current one, else the weakest, then the nearest.
            if (!best
                || (String(ownerId) === String(previous)) && String(best.ownerId) !== String(previous)
                || (String(best.ownerId) !== String(previous) && (ratio > best.ratio || (ratio === best.ratio && reach < best.reach)))) {
                best = candidate;
            }
        }
        this.offence = best;
        return best;
    }

    /**
     * Leash: a proactive (not provoked) attack only goes after targets
     * within `offenceLeash` hexes of one of our structures, so the strike
     * force does not march into the opponent's base (and the barbarians
     * around it). Everything else is the adaptive local-balance check.
     */
    hasOffensiveAdvantage(target, foreign) {
        const owner = this.turnState?.proactiveOwner;
        if (owner && String(target.owner?.id) === owner) {
            const anchors = this.getActiveEntities().filter(entity => entity.isConstruct);
            if (this.distanceToTerritory(target, anchors) > this.harkConfig.offenceLeash) return false;
        }
        return super.hasOffensiveAdvantage(target, foreign);
    }

    /**
     * Adaptive makes every unit of an offensive-stance owner that can reach
     * us an immediate threat, struck by the emergency pool with no force
     * check. For a proactive target that has not attacked us, the attack
     * goes through attemptCombat instead (local balance + leash).
     */
    getImmediateThreats(own, foreign) {
        const immediate = super.getImmediateThreats(own, foreign);
        const owner = this.turnState?.proactiveOwner;
        if (!owner) return immediate;
        return immediate.filter(item => !(String(item.ownerId) === owner
            && num(item.attackerDamage) === 0 && !item.alliedThreat));
    }

    /**
     * A proactive target's units far from us are not threats: adaptive
     * counts every unit of an offensive-stance owner as a threat, which
     * stops military exploration and skews building while we are the
     * attacker. They count again once they attack us or come within
     * threatRadius.
     */
    getThreatSummary() {
        const summary = super.getThreatSummary();
        const owner = this.turnState?.proactiveOwner;
        if (!owner) return summary;
        const threats = summary.threats.filter(item => !(String(item.ownerId) === owner
            && num(item.attackerDamage) === 0 && item.nearestOwn > this.config.threatRadius));
        if (threats.length === summary.threats.length) return summary;
        const power = threats.reduce((sum, item) => sum + this.combatPower(item.entity), 0);
        return { threats, power, hasThreats: threats.length > 0 };
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
        if (!options.emergency && !options.advance) {
            const pool = super.selectAttackers(target, options);
            const garrison = this.turnState.homeGarrison;
            const proactive = this.turnState.proactiveOwner;
            if (!garrison || garrison.size === 0 || !proactive || String(target.owner?.id) !== proactive) return pool;
            return pool.filter(unit => !garrison.has(unit.id));
        }
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

    /**
     * B2 response to the adaptive immediate-threat list:
     * (1) strike any immediate threat a unit can hit now, (2) save vulnerable
     * units standing next to a threat, (3) advance units that cannot strike yet.
     */
    respondToImmediateThreats(immediate, econ, involvedCells) {
        if (immediate.length === 0) return false;

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

        if (this.attemptRetreats(econ, involvedCells, true)) return true;

        for (const item of immediate) {
            const target = item.entity;
            for (const unit of this.selectAttackers(target, { advance: true })) {
                if (this.engage(unit, target, 'Emergency advance', item.ownerName, involvedCells) > 0) return true;
            }
        }
        return false;
    }

    // ==================== General combat (B2 advance, B9) ====================

    /**
     * B9: threat DETECTION stays on the distance to any own entity (adaptive's
     * nearestOwn); the defensive engagement range and target priority use the
     * distance to the nearest combat-capable own unit (can we reach it?).
     */
    getEngagementDistance(target, own, nearestOwn) {
        const combatUnits = own.filter(entity => this.helper.isCombatCapable(entity));
        return combatUnits.length
            ? Math.min(...combatUnits.map(unit => this.helper.distance(unit, target)))
            : Infinity;
    }

    /**
     * Strike pass: threats use the B2/B4 strike pool; offensive targets use
     * the adaptive opportunistic pool (which closes distance itself). Then an
     * advance pass (B2) closes distance on threats nobody can hit yet.
     */
    engageCombatTargets(targets, involvedCells) {
        for (const item of targets) {
            const target = item.entity;
            const candidates = this.selectAttackers(target, { emergency: item.isThreat });
            if (candidates.length === 0) continue;
            this.helper.aiLog(
                this.player,
                'combat',
                `Engagement decision | Target: ${target.name}#${shortId(target)} (${item.ownerName}) at (${target.q},${target.r}) `
                + `| Stance: ${item.stance} | Reason: ${item.reason} | Dist(any/combat): ${item.nearestOwn}/${item.engagementDistance} `
                + `| Candidates: [${candidates.map(unit => `${unit.name}#${shortId(unit)}@(${unit.q},${unit.r})`).join(', ')}]`
            );
            for (const attacker of candidates) {
                if (this.engage(attacker, target, 'Engagement', item.ownerName, involvedCells) > 0) return true;
            }
        }

        for (const item of targets) {
            if (!item.isThreat) continue;
            for (const unit of this.selectAttackers(item.entity, { advance: true })) {
                if (this.engage(unit, item.entity, 'Advance on threat', item.ownerName, involvedCells) > 0) return true;
            }
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

    /** Hex distance from `cell` to our nearest structure (Infinity with none). */
    distanceToTerritory(cell, anchors) {
        return anchors.length
            ? Math.min(...anchors.map(anchor => this.helper.distance(cell, anchor)))
            : Infinity;
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

    /** B5 (2): a directly-affordable producer (depth 0) always beats a prerequisite step; score only orders steps of equal class. */
    rankDeficitCandidates(candidates) {
        return [...candidates].sort((a, b) =>
            ((a.step.depth === 0 ? 0 : 1) - (b.step.depth === 0 ? 0 : 1)) || (b.score - a.score)
        );
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

    isExplorerCandidate(entity, context) {
        // B3: a builder sent exploring is a village or farm lost to the first raider.
        if (this.helper.isBuilder(entity)) return false;
        return super.isExplorerCandidate(entity, context);
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
}

export default HarkManager;
