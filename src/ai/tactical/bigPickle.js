import { AdaptiveManager } from './adaptiveManager.js';

/**
 * BigPickleManager - an aggressive, deadlock-resistant tactical AI.
 *
 * This manager deliberately reuses the solid economic analysis and directive
 * handling in AdaptiveManager, then fixes the weaknesses that matter most for
 * "maximise total score as fast as possible relative to everyone else":
 *
 * - Deficit recovery: production chains and reservations are attempted before
 *   any deadlock escape. The engine already makes unpaid entities inactive
 *   reversibly, so permanent Self Destruct scrapping is available but disabled
 *   unless explicitly enabled through the controller config.
 * - Proactive production chains: growth is not limited to what an existing
 *   builder already knows. The manager walks the manifest's build graph and
 *   builds prerequisite builders (village -> worker -> farm, etc.) before a
 *   deficit becomes critical.
 * - Combat tempo: attack sequences may spend two orders, so a unit can close
 *   distance and still strike. Attackers are ranked by power, role value and
 *   time-to-reach instead of being taken from a role-filtered pool.
 * - Distributed exploration: each explorer picks the best direction from its
 *   own position, and directions already used this turn are penalised, so the
 *   whole party does not walk into the same fog bank.
 * - Threat detection includes inactive/damaged assets: an enemy standing next
 *   to a farm is a threat to the farm even if the farm cannot act right now.
 *
 * Hard rules honoured throughout:
 * - No entity/action/role names drive decisions. Names are only used to look
 *   entities up in the manifest; capabilities come from getActions() and the
 *   manifest's attributes (yields, damage, buildables, repairables, score...).
 * - "orders" is the single hardcoded resource name and is filtered out of all
 *   normal accounting.
 * - Every mutation goes through an entity's action (action.do()).
 * - Directives are obeyed when present. Internal focus/stances are only
 *   invented when no directive exists (see hybrid-ai-directive.md).
 */

const ORDERS_RESOURCE = 'orders';

/** The six axial directions understood by AiHelper.explore(). */
const EXPLORE_DIRECTIONS = ['E', 'NE', 'NW', 'W', 'SW', 'SE'];

/**
 * All BigPickle tuning lives here so every threshold is visible, named and
 * overridable through player.controller.config. The comments explain what each
 * number is protecting against; none of them depend on a particular manifest.
 */
const DEFAULT_BIG_PICKLE_CONFIG = {
    // Descriptive logging. Inherited AdaptiveManager logs are unaffected; this
    // flag only gates BigPickle-specific decision lines.
    logging: true,

    // --- Combat tempo -----------------------------------------------------
    // Two orders allow a unit to move into range and attack in one sequence.
    // helper.attack() spends nothing when the target is unreachable, so this
    // does not burn orders on hopeless targets.
    combatOrders: 2,
    emergencyCombatOrders: 2,
    // A unit more than this many "movement turns" away is not considered for
    // an attack, so far-away units are not marched across the map while closer
    // ones could act. Derived from the unit's own max AP.
    attackReachTurns: 3,
    // Score modifiers for selectAttackers(). These are preferences, not bans:
    // a builder or repairer can still attack when it is the only capable unit.
    attackerDedicatedBonus: 1.6,
    attackerBuilderPenalty: 0.6,
    attackerRepairerPenalty: 0.85,
    attackerInRangeBonus: 1.2,
    attackerOneTurnBonus: 0.5,
    attackerTurnPenalty: 0.6,

    // --- Deadlock escape / scrapping --------------------------------------
    // Disabled by default: unpaid upkeep already makes an entity inactive and
    // stops its consumption reversibly. Self Destruct permanently removes its
    // military/economic score and can remove the only builder capable of
    // recovery, so it is only an explicit opt-in for custom configurations.
    enableScrapping: false,
    // Cap per turn so one bad read of a deficit cannot delete the empire.
    // Scrapping is a last resort after maintenance has actually failed; one
    // removal per turn is enough to change the trajectory and is easy to
    // reason about in the logs.
    maxScrapsPerTurn: 1,
    // Only scrap when the worst urgent resource is this close to empty.
    scrapTurnsRemaining: 3,
    // An inactive consumer is pure drain, so it is a better scrap candidate.
    scrapInactiveBonus: 1.5,
    // Higher-value entities are more expensive to lose.
    scrapValuePenalty: 0.08,
    // Heavy penalties for removing the only builder able to fix the deficit,
    // or the last defender while enemies are around.
    scrapRemedyBuilderPenalty: 0.15,
    scrapDefenderPenalty: 0.25,

    // --- Proactive growth through prerequisite chains ---------------------
    // How many desirable target types are expanded into production chains per
    // action. The manifest is small; this keeps the work bounded anyway.
    proactiveTargetLimit: 16,
    // A prerequisite step inherits part of the value of the final target it
    // unlocks, discounted for each extra hop in the chain.
    chainStepValueBonus: 0.6,
    chainDepthPenalty: 0.3,
    // Small tie-breaker for entities that can build useful things. Kept low so
    // a builder is not preferred over the producer it would build.
    enablerValueBonus: 0.15,
    // Value of a repair-capable unit when something actually needs repairs.
    repairCapabilityBonus: 4,

    // --- Exploration ------------------------------------------------------
    // Penalty multiplier for a direction already assigned to another explorer.
    exploreDirectionSpread: 1.5,
    // At most this fraction of dedicated military units explore while the map
    // is calm. At least one is allowed, so a lone military unit can still scout.
    exploreMilitaryCapFraction: 0.5,
    // Dedicated military units do not explore at all while threats exist.
    exploreThreatMilitaryCapFraction: 0,

    // --- Internal focus/stance (only used when no directive is supplied) --
    internalOffensiveRatio: 1.25,
    internalOffensiveRange: 12,

    // --- Retreats ---------------------------------------------------------
    // Extra safety margin (in hexes) before a vulnerable unit flees a unit
    // that could strike it next turn.
    retreatThreatMargin: 1,
};

const INTERNAL_FOCUS_BIAS = {
    economy: { economy: 1.35, military: 0.8, exploration: 0.9 },
    military: { economy: 0.8, military: 1.35, exploration: 0.9 },
    exploration: { economy: 0.9, military: 0.8, exploration: 1.35 },
    balanced: { economy: 1, military: 1, exploration: 1 },
};

function asNumber(value, fallback = 0) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function withoutOrders(map) {
    const result = {};
    for (const [key, value] of Object.entries(map || {})) {
        if (key === ORDERS_RESOURCE) continue;
        result[key] = value;
    }
    return result;
}

function ordersUsedFrom(result) {
    return typeof result === 'number' ? result : asNumber(result?.ordersUsed, 0);
}

function canonicalKey(manifestEntities, name) {
    if (!name) return null;
    if (manifestEntities[name]) return name;
    const lower = String(name).toLowerCase();
    return Object.keys(manifestEntities).find(key => key.toLowerCase() === lower) || null;
}

export class BigPickleManager extends AdaptiveManager {
    constructor(player, helper) {
        super(player, helper);

        // AdaptiveManager has already merged its own defaults. Extend that
        // config rather than replacing it, then merge overrides from the
        // controller config for BigPickle's keys.
        const rawConfig = player.controller?.config || {};
        this.config = { ...this.config, ...DEFAULT_BIG_PICKLE_CONFIG };
        for (const [key, fallback] of Object.entries(DEFAULT_BIG_PICKLE_CONFIG)) {
            const raw = rawConfig[key];
            if (typeof fallback === 'number' && typeof raw === 'number' && Number.isFinite(raw)) {
                this.config[key] = raw;
            } else if (typeof fallback === 'boolean' && typeof raw === 'boolean') {
                this.config[key] = raw;
            }
        }

        this.turnState = this.createTurnState();
    }

    createTurnState() {
        const state = super.createTurnState();
        return {
            ...state,
            scrapsThisTurn: 0,
            scrapBlockedLogged: new Set(),
        };
    }

    log(category, message) {
        if (this.config.logging === false) return;
        this.helper.aiLog(this.player, category, message);
    }

    // ==================== Turn lifecycle ====================

    async processTurn() {
        const player = this.player;
        const gameState = this.gameState;

        if (!player || player.orders <= 0) return;

        const manifest = this.manifest;
        if (!manifest || !manifest.entities) return;

        this.turnState = this.createTurnState();
        const directive = this.resolveDirective();
        this.turnState.directive = directive;

        const stanceSummary = Object.entries(directive.stance || {})
            .map(([id, stance]) => `${id}:${stance}`)
            .join(', ') || 'all neutral';
        const goalSummary = (directive.goals || []).map(goal => goal?.type).filter(Boolean).join(', ') || 'none';

        this.log(
            'turn',
            `BigPickle turn start | Round ${gameState.currentRound || 1} | Orders: ${player.orders}/${player.maxOrders} `
            + `| Focus: ${directive.focus} | Stances: [${stanceSummary}] | Goals: [${goalSummary}] `
            + `| Scores -> Military: ${player.score?.military || 0}, Economic: ${player.score?.economic || 0}, Exploration: ${player.score?.exploration || 0}`
        );

        const maxIterations = Math.max(player.orders * this.config.maxIterationsPerOrder, this.config.minimumIterations);
        let iterations = 0;

        while (player.orders > 0 && iterations++ < maxIterations) {
            const own = this.getActiveEntities();
            if (own.length === 0) {
                this.log('warn', 'No active entities remain; cannot act this turn.');
                break;
            }

            const econ = this.analyzeEconomy(directive);
            const involvedCells = [];
            let actionLabel = null;

            // 1. Immediate self-defence: kill or evade an adjacent/attacking enemy.
            if (this.attemptEmergencyDefense(econ, involvedCells)) {
                actionLabel = 'Emergency defence';
            }
            // 2. Resource deadlock prevention (build, repair, or scrap).
            else if (this.attemptCriticalDeficits(econ, involvedCells)) {
                actionLabel = 'Critical deficit recovery';
            }
            // 3. General combat under stance rules.
            else if (this.attemptCombat(econ, involvedCells)) {
                actionLabel = 'Combat';
            }
            // 4. Retreat vulnerable non-combat units away from threats.
            else if (this.attemptRetreats(econ, involvedCells, false)) {
                actionLabel = 'Retreat';
            }
            // 5. Heavy repairs only.
            else if (this.attemptRepairs(econ, involvedCells)) {
                actionLabel = 'Repair';
            }
            // 6. Directive goals, in priority order.
            else if (this.processGoals(econ, involvedCells)) {
                actionLabel = 'Directive goal';
            }
            // 7. If exploration is the weakest pillar, spend at least one
            // action on it before build orders consume the whole turn.
            else if (this.shouldPrioritizeExploration(econ)
                && this.attemptExploration(econ, involvedCells, { excludeSupport: true })) {
                this.turnState.prioritizedExplorations += 1;
                actionLabel = 'Prioritized exploration';
            }
            // 8. Proactive economic/military growth (including prerequisites).
            else if (this.attemptProactiveBuild(econ, { involvedCells })) {
                actionLabel = 'Proactive growth';
            }
            // 9. Exploration.
            else if (this.attemptExploration(econ, involvedCells)) {
                actionLabel = 'Exploration';
            }

            if (!actionLabel) break;
            await this.helper.onActionDone(gameState, involvedCells, actionLabel);
        }

        this.log('turn', `BigPickle turn ended | Remaining orders: ${player.orders}`);
    }

    // ==================== Directives & internal stances ====================

    /**
     * Obey an explicit directive completely. Only when none exists may the
     * tactical AI pick its own focus and per-opponent stances (see
     * hybrid-ai-directive.md, "Internal stance/focus").
     */
    resolveDirective() {
        const controller = this.player.controller || {};
        const config = controller.config || {};
        const explicit = this.getExplicitDirective();
        const base = super.resolveDirective();

        if (explicit) return base;

        // Let the provisional balanced directive drive threat detection while
        // the internal stance map is being computed.
        this.turnState.directive = base;

        const hasConfiguredFocus = Boolean(config.focus) || Array.isArray(controller.focus);
        const stance = this.computeInternalStances();
        const focus = hasConfiguredFocus ? base.focus : this.computeInternalFocus(base);
        const focusBias = hasConfiguredFocus ? base.focusBias : (INTERNAL_FOCUS_BIAS[focus] || INTERNAL_FOCUS_BIAS.balanced);

        return { ...base, focus, focusBias, stance };
    }

    /**
     * Choose a focus only when one pillar is clearly lagging. Balanced is the
     * safe default because AdaptiveManager.computeWeights already biases
     * toward the weakest pillar on every turn.
     */
    computeInternalFocus() {
        const scores = this.player.score || {};
        const military = Math.max(0, asNumber(scores.military));
        const economic = Math.max(0, asNumber(scores.economic));
        const exploration = Math.max(0, asNumber(scores.exploration));
        const highest = Math.max(military, economic, exploration, 1);

        const dedicated = this.getActiveEntities().some(entity =>
            this.helper.isDedicatedMilitary(entity, this.manifest)
        );
        const summary = this.getThreatSummary();
        if (summary.hasThreats && !dedicated) return 'military';

        const hasUnexplored = this.helper.getCellsArray().some(cell =>
            cell && !this.player.isExplored(cell.q, cell.r)
        );

        // Only override balanced when a pillar is less than half of the best
        // pillar. Otherwise the inherited need-based weighting is sufficient.
        if (hasUnexplored && exploration < highest * 0.5) return 'exploration';
        if (economic < highest * 0.5) return 'economy';
        if (military < highest * 0.5) return 'military';
        return 'balanced';
    }

    /**
     * Internal per-opponent stance policy (no directive):
     * - anyone who damaged us recently is treated as defensive;
     * - a visible, clearly weaker opponent nearby may be treated offensively;
     * - everyone else stays neutral (no special targeting).
     */
    computeInternalStances() {
        const stances = {};
        const groups = this.player.getOpponents ? this.player.getOpponents(this.gameState) : {};
        const own = this.getOwnEntities();
        const foreign = this.getVisibleForeignEntities();
        const history = this.getAttackerHistory();
        const dedicated = own.filter(entity =>
            entity.active && this.helper.isDedicatedMilitary(entity, this.manifest)
        );

        const ownerByEntityId = new Map();
        for (const item of foreign) {
            ownerByEntityId.set(item.entity.id, item.ownerId);
        }
        const attackers = new Set();
        for (const [entityId, damage] of history.entries()) {
            if (asNumber(damage) <= 0) continue;
            const ownerId = ownerByEntityId.get(entityId);
            if (ownerId !== null && ownerId !== undefined) attackers.add(ownerId);
        }

        for (const [key, group] of Object.entries(groups || {})) {
            const ownerId = group?.id ?? (key === 'null' ? null : Number(key));
            if (ownerId === null || ownerId === undefined) continue;

            stances[ownerId] = 'neutral';

            if (attackers.has(ownerId)) {
                stances[ownerId] = 'defensive';
                continue;
            }

            const theirEntities = group?.entities || [];
            if (theirEntities.length === 0 || own.length === 0 || dedicated.length === 0) continue;

            const nearest = Math.min(...own.map(unit =>
                Math.min(...theirEntities.map(entity => this.helper.distance(unit, entity)))
            ));
            if (!Number.isFinite(nearest) || nearest > this.config.internalOffensiveRange) continue;

            const myMilitary = asNumber(this.player.score?.military);
            const theirMilitary = asNumber(group?.score?.military);
            if (myMilitary > 0
                && myMilitary >= Math.max(1, theirMilitary) * this.config.internalOffensiveRatio) {
                stances[ownerId] = 'offensive';
            }
        }

        return stances;
    }

    // ==================== Own entities & meta helpers ====================

    /** All owned entities, including inactive ones (useful for scrapping/detection). */
    getOwnEntities() {
        const entities = this.player.getEntities ? this.player.getEntities() : [];
        return entities.filter(entity => entity && !entity.destroyed);
    }

    getMaintenance(entity) {
        if (!entity) return {};
        if (typeof entity.getCostToMaintain === 'function') {
            return entity.getCostToMaintain() || {};
        }
        return this.getEntityMeta(entity)?.maintenance || {};
    }

    findSelfDestructAction(entity) {
        if (!entity || typeof entity.getActions !== 'function') return null;
        return entity.getActions().find(action => {
            const name = String(action?.name || '').toLowerCase();
            return name === 'self destruct' || (name.includes('self') && name.includes('destruct'));
        }) || null;
    }

    // ==================== Threat detection ====================

    /**
     * Same classification as AdaptiveManager, but "is it near our stuff?" is
     * measured against every owned entity, not only active ones. An enemy
     * adjacent to an inactive farm is still a threat to the farm (spec
     * addendum #6: split detection from engagement reach).
     */
    getThreatSummary() {
        const own = this.getOwnEntities();
        const foreign = this.getVisibleForeignEntities();
        const history = this.getAttackerHistory();
        const threats = [];
        const alliedEntities = foreign
            .filter(item => this.getStance(item.ownerId) === 'ally')
            .map(item => item.entity);

        for (const item of foreign) {
            const stance = this.getStance(item.ownerId);
            if (stance === 'friendly' || stance === 'ally') continue;

            const entity = item.entity;
            const nearestOwn = own.length
                ? Math.min(...own.map(unit => this.helper.distance(unit, entity)))
                : Infinity;
            const nearestAlly = alliedEntities.length
                ? Math.min(...alliedEntities.map(ally => this.helper.distance(entity, ally)))
                : Infinity;
            const attackerDamage = asNumber(history.get(entity.id));

            const isBarbarian = item.ownerId === null || item.ownerId === undefined;
            const targetReach = Math.max(1, asNumber(entity.range?.maxCells, 1))
                + (entity.isConstruct ? 0 : 1);
            const proximityThreat = isBarbarian
                ? nearestOwn <= this.config.threatRadius
                : (stance === 'defensive' && nearestOwn <= this.config.threatRadius);
            const alliedThreat = alliedEntities.length > 0 && nearestAlly <= targetReach;
            const isThreat = attackerDamage > 0
                || proximityThreat
                || alliedThreat
                || stance === 'offensive';

            if (isThreat) {
                threats.push({ ...item, stance, nearestOwn, nearestAlly, attackerDamage, alliedThreat });
            }
        }

        const power = threats.reduce(
            (sum, item) => sum + this.helper.getCombatPower(item.entity, this.getEntityMeta(item.entity)),
            0
        );
        return { threats, power, hasThreats: threats.length > 0 };
    }

    /**
     * Emergency defence must consider threats to inactive assets too, so pass
     * every owned entity into detection (response still uses active units).
     */
    attemptEmergencyDefense(econ, involvedCells) {
        const own = this.getOwnEntities();
        const foreign = this.getVisibleForeignEntities();
        if (own.length === 0 || foreign.length === 0) return false;

        const immediate = this.getImmediateThreats(own, foreign);
        return this.respondToImmediateThreats(immediate, econ, involvedCells);
    }

    /**
     * Engagement distance is measured from units that can actually fight.
     * Detection above still uses the nearest owned entity.
     */
    getEngagementDistance(target, own, nearestOwn) {
        const active = own.filter(entity => entity && entity.active && !entity.destroyed);
        const capable = active.filter(entity =>
            this.helper.isCombatCapable(entity) && asNumber(entity.actionPoints, 0) > 0
        );
        const nonBuilders = capable.filter(entity => !this.helper.isBuilder(entity));
        const pool = nonBuilders.length > 0 ? nonBuilders : (capable.length > 0 ? capable : active);
        if (pool.length === 0) return nearestOwn;
        return Math.min(...pool.map(unit => this.helper.distance(unit, target)));
    }

    // ==================== Combat selection ====================

    /**
     * Rank every combat-capable unit that could meaningfully contribute.
     * Role-based modifiers are preferences; nothing is banned. Closer units
     * and units that can strike immediately come first.
     */
    selectAttackers(target, options = {}) {
        const own = this.getActiveEntities().filter(entity =>
            this.helper.isCombatCapable(entity) && asNumber(entity.actionPoints, 0) > 0
        );
        if (own.length === 0) return [];

        const maxPower = Math.max(
            1,
            ...own.map(entity => this.helper.getCombatPower(entity, this.getEntityMeta(entity)))
        );

        const ranked = [];
        for (const entity of own) {
            const meta = this.getEntityMeta(entity);
            const distance = this.helper.distance(entity, target);
            const maxAp = Math.max(1, asNumber(entity.maxActionPoints, asNumber(entity.actionPoints, 1)));
            const reachTurns = distance / maxAp;
            if (reachTurns > this.config.attackReachTurns) continue;
            if (entity.isConstruct && reachTurns > 0 && distance > Math.max(1, asNumber(entity.range?.maxCells, 1))) {
                // A stationary structure cannot close distance.
                continue;
            }

            const attackAction = entity.getActions
                ? entity.getActions().find(action => action.name === 'Attack')
                : null;
            const check = attackAction ? attackAction.canDo(target.cell, target) : null;
            const inRange = Boolean(check?.possible);

            const power = this.helper.getCombatPower(entity, meta) / maxPower;
            let score = power * 1.5;
            if (this.helper.isDedicatedMilitary(entity, this.manifest)) {
                score *= this.config.attackerDedicatedBonus;
            }
            if (this.helper.isBuilder(entity)) score *= this.config.attackerBuilderPenalty;
            if (this.helper.isRepairer(entity)) score *= this.config.attackerRepairerPenalty;
            if (inRange) score += this.config.attackerInRangeBonus;
            if (reachTurns <= 1) score += this.config.attackerOneTurnBonus;
            score -= reachTurns * this.config.attackerTurnPenalty;

            ranked.push({ entity, score, distance, reachTurns, inRange, power });
        }

        ranked.sort((a, b) => {
            if (a.inRange !== b.inRange) return a.inRange ? -1 : 1;
            if (a.score !== b.score) return b.score - a.score;
            if (a.distance !== b.distance) return a.distance - b.distance;
            return b.power - a.power;
        });

        return ranked.map(item => item.entity);
    }

    getCombatOrderBudget(emergency) {
        return emergency ? this.config.emergencyCombatOrders : this.config.combatOrders;
    }

    /** Attack the most urgent immediate threat, else save adjacent vulnerable units. */
    respondToImmediateThreats(immediate, econ, involvedCells) {
        for (const item of immediate) {
            const target = item.entity;
            const candidates = this.selectAttackers(target, { emergency: true });
            if (candidates.length === 0) continue;

            this.log(
                'combat',
                `Emergency defence | Target: ${target.name}#${String(target.id).slice(-4)} (${item.ownerName}) at (${target.q},${target.r}) `
                + `| Threat: ${item.attackerDamage > 0
                    ? `attacked us for ${item.attackerDamage.toFixed(1)} damage`
                    : item.alliedThreat
                        ? `striking an ally (${item.nearestAlly} hex)`
                        : `within striking distance (${item.nearestOwn} hex)`} `
                + `| Stance: ${item.stance}`
            );

            for (const attacker of candidates) {
                const from = { q: attacker.q, r: attacker.r };
                const result = this.helper.attack(
                    this.gameState,
                    attacker,
                    target,
                    this.getCombatOrderBudget(true)
                );
                const used = ordersUsedFrom(result);
                if (used > 0) {
                    involvedCells.push(from, attacker.cell);
                    this.log(
                        'combat',
                        `Emergency defence result | ${attacker.name}#${String(attacker.id).slice(-4)} -> ${target.name}#${String(target.id).slice(-4)} `
                        + `| Orders used: ${used} | ${result?.result?.message || 'engaged'}`
                    );
                    return true;
                }
            }
        }

        // No attack was possible: try to save vulnerable adjacent units instead.
        return this.attemptRetreats(econ, involvedCells, true);
    }

    /** Attack the highest-priority target any candidate can engage. */
    engageCombatTargets(targets, involvedCells) {
        for (const item of targets) {
            const target = item.entity;
            const candidates = this.selectAttackers(target, { emergency: item.isThreat });
            if (candidates.length === 0) continue;

            this.log(
                'combat',
                `Engagement decision | Target: ${target.name}#${String(target.id).slice(-4)} (${item.ownerName}) at (${target.q},${target.r}) `
                + `| Stance: ${item.stance} | Reason: ${item.reason} | Distance: ${item.nearestOwn} | Threat: ${item.isThreat} `
                + `| Candidates: [${candidates.map(unit => `${unit.name}#${String(unit.id).slice(-4)}@(${unit.q},${unit.r}) dist=${this.helper.distance(unit, target)}`).join(', ')}]`
            );

            for (const attacker of candidates) {
                const from = { q: attacker.q, r: attacker.r };
                const result = this.helper.attack(
                    this.gameState,
                    attacker,
                    target,
                    this.getCombatOrderBudget(item.isThreat)
                );
                const used = ordersUsedFrom(result);
                if (used > 0) {
                    involvedCells.push(from, attacker.cell);
                    this.log(
                        'combat',
                        `Engagement result | ${attacker.name}#${String(attacker.id).slice(-4)} -> ${target.name}#${String(target.id).slice(-4)} `
                        + `(${item.ownerName}) | Orders used: ${used} | ${result?.result?.message || 'engaged'}`
                    );
                    return true;
                }
            }
        }
        return false;
    }

    // ==================== Retreats ====================

    /**
     * Flee from real danger, not from every foreign unit. Neutral opponents
     * should be freely passable (hybrid-ai-directive.md); caution opponents and
     * units that actually attacked us are worth avoiding.
     */
    isRetreatThreat(item) {
        const stance = this.getStance(item.ownerId);
        if (stance === 'friendly' || stance === 'ally') return false;

        const target = item.entity;
        if (!this.helper.isCombatCapable(target)) return false;

        const attackerDamage = asNumber(this.getAttackerHistory().get(target.id));
        if (attackerDamage > 0) return true;
        if (stance === 'caution') return true;
        if (stance === 'offensive') return false;

        const own = this.getOwnEntities();
        if (own.length === 0) return false;
        const nearest = Math.min(...own.map(unit => this.helper.distance(unit, target)));
        const reach = Math.max(1, asNumber(target.range?.maxCells, 1))
            + (target.isConstruct ? 0 : 1)
            + this.config.retreatThreatMargin;
        return nearest <= reach;
    }

    // ==================== Deadlock escape ====================

    attemptCriticalDeficits(econ, involvedCells) {
        if (super.attemptCriticalDeficits(econ, involvedCells)) return true;
        if (!econ?.urgent || econ.urgent.length === 0) return false;
        return this.attemptScrapping(econ, involvedCells);
    }

    /**
     * Last-resort deadlock escape: destroy a low-value consumer of the scarcest
     * resource so the rest of the empire can pay maintenance again. This runs
     * only after repairing and building have both failed, and is strictly
     * capped per turn.
     */
    attemptScrapping(econ, involvedCells) {
        if (!this.config.enableScrapping) return false;
        if (this.turnState.scrapsThisTurn >= this.config.maxScrapsPerTurn) return false;

        const need = (econ.urgent || []).find(info =>
            Number.isFinite(info.turnsRemaining)
            && info.turnsRemaining <= this.config.scrapTurnsRemaining
        );
        if (!need) return false;

        const summary = this.getThreatSummary();
        const own = this.getOwnEntities();
        const producers = this.findProducersForResource(need.res, econ);
        const producerNames = new Set(producers.map(producer => producer.name.toLowerCase()));
        const candidates = [];

        for (const entity of own) {
            if (entity.destroyed) continue;
            const maintenance = withoutOrders(this.getMaintenance(entity));
            const relief = asNumber(maintenance[need.res]);
            if (relief <= 0) continue;

            // Keep producers of the scarce resource unless their own upkeep
            // for that resource is even larger than their output.
            const yields = withoutOrders(entity.yields || this.getEntityMeta(entity)?.yields);
            const netForResource = asNumber(yields[need.res]) - relief;
            if (netForResource > 0) continue;

            const value = this.getEntityValue(entity);
            const capability = this.scrapCapabilityFactor(
                entity,
                need,
                producerNames,
                own,
                summary
            );
            if (capability <= 0) continue;

            const inactiveBonus = entity.active ? 1 : this.config.scrapInactiveBonus;
            const score = (relief * inactiveBonus * capability)
                / (1 + value * this.config.scrapValuePenalty);

            candidates.push({ entity, score, relief, capability, inactive: !entity.active });
        }

        if (candidates.length === 0) {
            if (!this.turnState.scrapBlockedLogged.has(need.res)) {
                this.turnState.scrapBlockedLogged.add(need.res);
                this.log(
                    'warn',
                    `Deadlock risk | ${need.res} has ${need.stock} stock and net ${need.net} (${need.turnsRemaining} turns). `
                    + `No safe consumer can be scrapped because every candidate is a needed producer/defender.`
                );
            }
            return false;
        }

        candidates.sort((a, b) => b.score - a.score);

        for (const candidate of candidates) {
            const entity = candidate.entity;
            const cell = { q: entity.q, r: entity.r };
            const action = this.findSelfDestructAction(entity);
            if (!action) continue;

            const check = action.canDo(cell, null);
            if (!check || !check.possible) continue;
            if (!action.do(cell, null)) continue;

            this.turnState.scrapsThisTurn += 1;
            involvedCells.push(cell);
            this.log(
                'econ',
                `Scrap decision | ${entity.name}#${String(entity.id).slice(-4)} (${this.player.name}) at (${cell.q},${cell.r}) self-destructed `
                + `| Relief: ${candidate.relief} ${need.res}/turn (${candidate.inactive ? 'inactive, not yielding' : 'active'}) `
                + `| ${need.res} stock=${need.stock}, net=${need.net}, turns=${need.turnsRemaining} `
                + `| Reason: no affordable producer or repair remains and this consumer blocks maintenance recovery.`
            );
            return true;
        }

        return false;
    }

    /**
     * Multiplier for how costly it is to lose this entity in a scrap decision.
     * Low values mean "avoid scrapping"; higher values mean "safe to remove".
     */
    scrapCapabilityFactor(entity, need, producerNames, own, summary) {
        let factor = 1;

        if (this.helper.isBuilder(entity)) {
            const otherBuilders = own.filter(other =>
                other.id !== entity.id
                && !other.destroyed
                && this.helper.isBuilder(other)
                && this.getBuildCharges(other) > 0
            );
            if (otherBuilders.length === 0) factor *= 0.2;

            const buildables = this.getBuilderBuildables(entity)
                .map(name => String(name).toLowerCase());
            if (buildables.some(name => producerNames.has(name))) {
                factor *= this.config.scrapRemedyBuilderPenalty;
            }

            // Hard block: if this builder is the only owned unit that can
            // (directly or through the manifest's build graph) construct a
            // producer of the scarce resource, scrapping it would remove the
            // one permanent remedy for the deficit. Immediate upkeep relief is
            // never worth that trade, so keep it regardless of its value.
            if (producerNames.size > 0
                && this.builderCanReachProducer([entity], producerNames)
                && !this.builderCanReachProducer(otherBuilders, producerNames)) {
                return 0;
            }
        }

        if (this.helper.isDedicatedMilitary(entity, this.manifest) && summary.hasThreats) {
            const otherDefenders = own.filter(other =>
                other.id !== entity.id
                && other.active
                && this.helper.isDedicatedMilitary(other, this.manifest)
            );
            factor *= otherDefenders.length > 0 ? 0.6 : this.config.scrapDefenderPenalty;
        }

        // An active entity also contributes actions and (usually) yields.
        if (entity.active) factor *= 0.8;

        return factor;
    }

    /**
     * True when at least one of `builders` can eventually construct one of
     * `producerNames`: either directly from its buildables, or by building an
     * intermediate type whose own buildables lead to a producer. The walk is
     * over the manifest graph, so it does not assume any particular entity or
     * role name beyond what the current settings define.
     */
    builderCanReachProducer(builders, producerNames) {
        if (!producerNames || producerNames.size === 0) return true;
        if (!builders || builders.length === 0) return false;

        const queue = [];
        for (const builder of builders) {
            for (const name of this.getBuilderBuildables(builder)) {
                queue.push(String(name).toLowerCase());
            }
        }

        const visited = new Set();
        while (queue.length > 0) {
            const name = queue.shift();
            if (visited.has(name)) continue;
            visited.add(name);

            if (producerNames.has(name)) return true;

            const canonical = canonicalKey(this.manifestEntities, name);
            const meta = canonical ? this.manifestEntities[canonical] : null;
            if (!Array.isArray(meta?.buildables)) continue;
            for (const child of meta.buildables) {
                queue.push(String(child).toLowerCase());
            }
        }
        return false;
    }

    // ==================== Proactive growth ====================

    /**
     * Growth is planned against the whole manifest build graph, not just the
     * buildables of the units that happen to exist today. For each desirable
     * final target the manager finds the first reachable step in its
     * prerequisite chain (village -> worker -> farm, barracks -> swordsman...)
     * and ranks that step by downstream value per unit of resource spent.
     */
    attemptProactiveBuild(econ, options = {}) {
        const involvedCells = options.involvedCells || [];
        const category = options.category || null;
        const goal = options.goal || null;
        const own = this.getActiveEntities();
        const builders = own.filter(entity =>
            this.helper.isBuilder(entity)
            && this.getBuildCharges(entity) > 0
            && asNumber(entity.actionPoints, 0) >= 1
        );
        if (builders.length === 0) return false;

        const targetNames = this.collectProactiveTargets(econ, category, own);
        if (targetNames.length === 0) return false;

        const candidates = [];
        for (const targetName of targetNames) {
            const steps = this.findProductionSteps(targetName, econ);
            if (steps.length === 0) continue;

            // Only pursue the shallowest missing step toward this final target.
            // A deeper prerequisite (e.g. village -> worker when the next step
            // is really worker -> barracks -> catapult) inherits the same
            // downstream value and is usually cheaper, so ROI would make the AI
            // build enablers forever instead of advancing the chain. The depth
            // is measured from the full graph, before affordability/AP filters:
            // if the next builder is simply unable to act this turn, wait for
            // it rather than replacing it with another enabler.
            const shallowestDepth = Math.min(...steps.map(step => asNumber(step.depth, 0)));
            for (const step of steps) {
                if (asNumber(step.depth, 0) !== shallowestDepth) continue;

                const builder = step.builder;
                if (!builder || !builder.active) continue;
                if (this.getBuildCharges(builder) <= 0) continue;
                if (asNumber(builder.actionPoints, 0) < 1) continue;

                const meta = this.manifestEntities[step.targetName];
                if (!meta) continue;

                const finalMeta = this.manifestEntities[step.finalTarget] || meta;
                // A prerequisite may not itself be an economic/military entity
                // but is still valid when it unlocks one.
                if (category === 'economy'
                    && !this.isEconomicTarget(meta)
                    && !this.isEconomicTarget(finalMeta)) continue;
                if (category === 'military'
                    && !this.isMilitaryTarget(meta)
                    && !this.isMilitaryTarget(finalMeta)) continue;

                const cost = meta.spawnCost || {};
                if (!this.player.hasResources(cost)) continue;
                if (this.wouldSpendReserved(cost)) continue;
                if (!this.isBuildSustainable(meta, econ)) continue;
                if (!this.isCostSafeToSpend(cost, econ)) continue;

                let value = this.scoreBuildCandidate(
                    builder,
                    step.targetName,
                    meta,
                    econ,
                    own,
                    category,
                    step.finalTarget
                );
                value *= 1 / (1 + step.depth * this.config.chainDepthPenalty);
                if (value <= 0) continue;

                const costWeight = this.weightedCost(cost, econ);
                candidates.push({
                    builder,
                    step,
                    targetName: step.targetName,
                    finalTarget: step.finalTarget,
                    meta,
                    value,
                    roi: value / costWeight,
                });
            }
        }

        if (candidates.length === 0) return false;

        // A single prerequisite step can unlock several final targets; keep
        // the best-valued occurrence so the same build is not attempted twice.
        const bestByStep = new Map();
        for (const candidate of candidates) {
            const key = `${candidate.builder?.id}:${candidate.targetName}`;
            const existing = bestByStep.get(key);
            if (!existing || candidate.roi > existing.roi) bestByStep.set(key, candidate);
        }

        const ranked = Array.from(bestByStep.values())
            .sort((a, b) => b.roi - a.roi)
            .slice(0, this.config.maxBuildAttempts);

        for (const candidate of ranked) {
            const chainText = candidate.finalTarget && candidate.finalTarget !== candidate.targetName
                ? `${this.helper.camelToTitle(candidate.targetName)} (prerequisite for ${this.helper.camelToTitle(candidate.finalTarget)})`
                : this.helper.camelToTitle(candidate.targetName);

            const reason = `proactive ${category || 'balanced'} growth (ROI ${candidate.roi.toFixed(2)}, value ${candidate.value.toFixed(1)}); ${chainText}`;
            this.log(
                'build',
                `Proactive candidate | ${candidate.builder.name}#${String(candidate.builder.id).slice(-4)} `
                + `(${this.player.name}) @(${candidate.builder.q},${candidate.builder.r}) -> ${this.helper.camelToTitle(candidate.targetName)} `
                + `| Final target: ${this.helper.camelToTitle(candidate.finalTarget)} | ROI ${candidate.roi.toFixed(2)}`
                + (category ? ` | Category: ${category}` : '')
            );

            const used = goal
                ? this.executeBuildWithGoal(candidate.builder, candidate.targetName, goal, involvedCells)
                : this.executeBuild(candidate.builder, candidate.targetName, 'build', reason, involvedCells);

            if (used > 0) {
                if (candidate.finalTarget && candidate.finalTarget !== candidate.targetName) {
                    const finalCost = this.manifestEntities[candidate.finalTarget]?.spawnCost || {};
                    this.reserveCost(finalCost);
                    this.log(
                        'econ',
                        `Chain progress | Reserved ${JSON.stringify(withoutOrders(finalCost))} for `
                        + `${this.helper.camelToTitle(candidate.finalTarget)} after building `
                        + `${this.helper.camelToTitle(candidate.targetName)}.`
                    );
                }
                return true;
            }
        }

        return false;
    }

    /**
     * Rank candidate final targets by their standalone value. The full build
     * graph is expanded later by findProductionSteps(); this list only decides
     * which final targets deserve that expansion.
     */
    collectProactiveTargets(econ, category, own) {
        const scored = [];
        for (const [name, meta] of Object.entries(this.manifestEntities)) {
            if (!meta) continue;
            if (category === 'economy' && !this.isEconomicTarget(meta)) continue;
            if (category === 'military' && !this.isMilitaryTarget(meta)) continue;

            const value = this.scoreBuildCandidate(null, name, meta, econ, own, category, name);
            if (value <= 0) continue;
            scored.push({ name, value });
        }

        scored.sort((a, b) => b.value - a.value);
        return scored
            .slice(0, this.config.proactiveTargetLimit)
            .map(entry => entry.name);
    }

    /**
     * Adaptive's build value plus:
     * - downstream value for prerequisite steps (a worker built to unlock a
     *   farm inherits a discounted fraction of the farm's value);
     * - a small bonus for build/repair capability, so capable units win ties
     *   without being blindly spam-built;
     * - the existing duplicate and surplus penalties still apply.
     */
    scoreBuildCandidate(builder, targetName, meta, econ, own, category = null, finalTarget = null) {
        let value = super.scoreBuildCandidate(builder, targetName, meta, econ, own, category);
        if (!meta) return value;

        if (finalTarget && finalTarget !== targetName) {
            const finalMeta = this.manifestEntities[finalTarget];
            if (finalMeta) {
                // Call the base implementation to avoid recursing through this
                // override (chains can be cyclic in an arbitrary manifest).
                const finalValue = super.scoreBuildCandidate(null, finalTarget, finalMeta, econ, own, category);
                value += finalValue * this.config.chainStepValueBonus;
            }
        }

        const canBuild = Array.isArray(meta.buildables)
            && meta.buildables.length > 0
            && meta.buildCharges !== 0;
        if (canBuild) {
            let bestChild = 0;
            for (const rawName of meta.buildables) {
                const childName = canonicalKey(this.manifestEntities, rawName);
                const childMeta = childName ? this.manifestEntities[childName] : null;
                if (!childMeta) continue;
                const childValue = super.scoreBuildCandidate(null, childName, childMeta, econ, own, null);
                if (childValue > bestChild) bestChild = childValue;
            }
            value += bestChild * this.config.enablerValueBonus;
        }

        if (Array.isArray(meta.repairables) && meta.repairables.length > 0) {
            const somethingDamaged = own.some(entity => this.isDamageWorthRepair(entity));
            if (somethingDamaged) value += this.config.repairCapabilityBonus;
        }

        return value;
    }

    // ==================== Exploration ====================

    /**
     * Send the best explorers to different frontiers. Each explorer measures
     * directions from its own cell, and directions already used this turn are
     * divided down so multiple explorers spread out instead of following the
     * same path.
     */
    attemptExploration(econ, involvedCells, options = {}) {
        const own = this.getActiveEntities();
        const summary = this.getThreatSummary();
        const damaged = own.filter(entity => this.isDamageWorthRepair(entity));
        const dedicated = own.filter(entity => this.helper.isDedicatedMilitary(entity, this.manifest));
        const militaryExplorerCap = summary.hasThreats
            ? Math.floor(dedicated.length * this.config.exploreThreatMilitaryCapFraction)
            : Math.max(1, Math.floor(dedicated.length * this.config.exploreMilitaryCapFraction));

        const context = { econ, options, summary, damaged, militaryExplorerCap };
        let explorers = own.filter(entity => this.isExplorerCandidate(entity, context));
        if (explorers.length === 0) return false;

        // Best explorers: high AP, wide sight, and some ability to defend
        // themselves. Proxied arrays sort a copy, so capture the return value.
        explorers = explorers.sort((a, b) => {
            const apA = asNumber(a.maxActionPoints, asNumber(a.actionPoints));
            const apB = asNumber(b.maxActionPoints, asNumber(b.actionPoints));
            if (apA !== apB) return apB - apA;
            const sightA = asNumber(a.sightRange);
            const sightB = asNumber(b.sightRange);
            if (sightA !== sightB) return sightB - sightA;
            return this.helper.getCombatPower(b, this.getEntityMeta(b))
                - this.helper.getCombatPower(a, this.getEntityMeta(a));
        });

        if (options.targetCoord) {
            if (this.exploreTowardCoord(options.targetCoord, explorers, involvedCells)) return true;
            if (options.goalOnly) return false;
        }

        const preferred = options.preferredDirection
            ? this.normalizeExploreDirection(
                options.preferredDirection,
                this.getUnexploredDirectionStats(this.getStartCell())
            )
            : null;

        for (const explorer of explorers) {
            const fromCell = { q: explorer.q, r: explorer.r };
            const stats = this.getUnexploredDirectionStats(fromCell);
            if (!stats.some(entry => entry.count > 0)) continue;

            let ranked = this.rankExploreDirections(stats);
            if (preferred) {
                const match = ranked.find(entry => entry.direction === preferred);
                if (match) ranked = [match, ...ranked.filter(entry => entry.direction !== preferred)];
            }

            for (const entry of ranked) {
                const from = { q: explorer.q, r: explorer.r };
                const result = this.helper.explore(
                    this.gameState,
                    explorer,
                    entry.direction,
                    false,
                    this.turnState.targetedCells
                );
                const used = ordersUsedFrom(result);
                if (used > 0) {
                    this.turnState.usedExploreDirections[entry.direction] =
                        asNumber(this.turnState.usedExploreDirections[entry.direction]) + 1;
                    if (this.helper.isDedicatedMilitary(explorer, this.manifest)) {
                        this.turnState.militaryExplorers += 1;
                    }
                    involvedCells.push(from, explorer.cell);
                    this.log(
                        'explore',
                        `Explore decision | ${explorer.name}#${String(explorer.id).slice(-4)} (${this.player.name}) `
                        + `from (${from.q},${from.r}) toward ${entry.direction} `
                        + `(frontier cells: ${entry.count}) | Orders used: ${used}`
                    );
                    return true;
                }
            }
        }

        // Fallback: nearest unexplored cell for any explorer that could not
        // take a directional path (still respects per-turn claimed cells).
        for (const explorer of explorers) {
            const from = { q: explorer.q, r: explorer.r };
            const result = this.helper.explore(
                this.gameState,
                explorer,
                null,
                false,
                this.turnState.targetedCells
            );
            const used = ordersUsedFrom(result);
            if (used > 0) {
                if (this.helper.isDedicatedMilitary(explorer, this.manifest)) {
                    this.turnState.militaryExplorers += 1;
                }
                involvedCells.push(from, explorer.cell);
                this.log(
                    'explore',
                    `Explore fallback | ${explorer.name}#${String(explorer.id).slice(-4)} (${this.player.name}) `
                    + `moved from (${from.q},${from.r}) toward the nearest unexplored cell | Orders used: ${used}`
                );
                return true;
            }
        }

        if (!this.turnState.fullyExploredLogged
            && !this.helper.getCellsArray().some(cell => cell && !this.player.isExplored(cell.q, cell.r))) {
            this.turnState.fullyExploredLogged = true;
            this.log('explore', 'All map territory is fully explored.');
        }

        return false;
    }

    rankExploreDirections(stats) {
        return [...stats]
            .filter(entry => entry.count > 0)
            .map(entry => ({
                ...entry,
                score: entry.count
                    / (1 + asNumber(this.turnState.usedExploreDirections[entry.direction])
                        * this.config.exploreDirectionSpread),
            }))
            .sort((a, b) => b.score - a.score || b.count - a.count);
    }
}

export default BigPickleManager;
