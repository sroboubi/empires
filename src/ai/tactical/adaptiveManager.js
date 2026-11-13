import { BaseManager } from '../baseManager.js';

/**
 * AdaptiveManager - configuration-driven tactical AI.
 *
 * Design goals (from src/ai/spec.md and src/ai/hybrid-ai-directive.md):
 * - Never hardcode entity names, actions, unit roles, costs, or yields. All of
 *   those are derived from the active manifest and from Entity.getActions().
 * - Avoid the one unrecoverable failure mode: resource deadlock. Critical
 *   deficits are repaired first, including walking down the production
 *   dependency chain (e.g. farm -> worker -> village -> settler).
 * - Respect hybrid directives (focus, per-opponent stance, ordered goals) when
 *   they are present; otherwise use balanced/neutral defaults.
 * - Defend and retaliate first, then opportunistically attack weak visible
 *   enemies when the local force balance is safe.
 * - Log every meaningful decision with the acting unit, source/target cells,
 *   owning player, and the reason.
 *
 * This manager is intentionally stateless across turns. All planning is
 * recomputed from the game state each turn so saves/reloads behave identically.
 */

const ORDERS_RESOURCE = 'orders';

/** The six axial directions understood by AiHelper.explore(). */
const EXPLORE_DIRECTIONS = ['E', 'NE', 'NW', 'W', 'SW', 'SE'];

/** AI heuristics. These can be overridden through player.controller.config. */
const DEFAULT_AI_CONFIG = {
    targetUpkeepTurns: 6,
    criticalTurnsRemaining: 2,
    lowStockTurnsRemaining: 6,
    maintenanceReserveTurns: 1,
    repairHealthRatio: 0.5,
    yieldRepairRatio: 0.95,
    maxIterationsPerOrder: 4,
    minimumIterations: 40,
    threatRadius: 3,
    opportunisticRange: 10,
    opportunisticEnemyRadius: 5,
    offensivePowerRatio: 1.05,
    maxProductionSteps: 20,
    maxProductionDepth: 4,
    maxBuildAttempts: 12,
};

function asNumber(value, fallback = 0) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stripOrders(map) {
    const result = {};
    for (const [key, value] of Object.entries(map || {})) {
        if (key === ORDERS_RESOURCE) continue;
        result[key] = value;
    }
    return result;
}

function normalizeFocus(value) {
    const text = String(value || '').toLowerCase();
    if (text.includes('econ') || text.includes('expansion') || text.includes('growth')) return 'economy';
    if (text.includes('milit') || text.includes('defen') || text.includes('aggress') || text.includes('war')) return 'military';
    if (text.includes('explor')) return 'exploration';
    return 'balanced';
}

function focusToBias(focus) {
    switch (focus) {
        case 'economy':
            return { economy: 1.8, military: 0.6, exploration: 0.8 };
        case 'military':
            return { economy: 0.7, military: 1.8, exploration: 0.7 };
        case 'exploration':
            return { economy: 0.8, military: 0.7, exploration: 1.8 };
        default:
            return { economy: 1, military: 1, exploration: 1 };
    }
}

/**
 * Maps the descriptive leader focus array from definitions/leaders.json
 * (e.g. ["exploration", "military", "expansion"]) to relative pillar weights.
 * The hybrid directive's single focus string takes precedence when supplied.
 */
function leaderFocusBias(focusList) {
    const bias = { economy: 1, military: 1, exploration: 1 };
    if (!Array.isArray(focusList)) return bias;
    for (const raw of focusList) {
        const focus = normalizeFocus(raw);
        if (focus === 'economy') bias.economy += 0.6;
        else if (focus === 'military') bias.military += 0.6;
        else if (focus === 'exploration') bias.exploration += 0.6;
    }
    return bias;
}

/** AiHelper.explore() normally returns { ordersUsed }, but one branch returns 0. */
function ordersUsedFrom(result) {
    return typeof result === 'number' ? result : asNumber(result?.ordersUsed, 0);
}

function statusDesirability(status) {
    switch (status) {
        case 'critical': return 8;
        case 'deficit': return 6;
        case 'low': return 4;
        case 'negative': return 3;
        case 'balanced': return 1.5;
        case 'surplus': return 0.1;
        default: return 1;
    }
}

function canonicalKey(manifestEntities, name) {
    if (!name) return null;
    if (manifestEntities[name]) return name;
    const lower = String(name).toLowerCase();
    return Object.keys(manifestEntities).find(key => key.toLowerCase() === lower) || null;
}

export class AdaptiveManager extends BaseManager {
    constructor(player, helper) {
        super(player, helper);

        const rawConfig = player.controller?.config || {};
        this.config = { ...DEFAULT_AI_CONFIG };
        for (const key of Object.keys(DEFAULT_AI_CONFIG)) {
            if (typeof rawConfig[key] === 'number' && Number.isFinite(rawConfig[key])) {
                this.config[key] = rawConfig[key];
            }
        }

        this.turnState = this.createTurnState();
    }

    get manifest() {
        return this.gameState?.manifestData || { entities: {} };
    }

    get manifestEntities() {
        return this.manifest.entities || {};
    }

    createTurnState() {
        return {
            directive: {
                focus: 'balanced',
                focusBias: { economy: 1, military: 1, exploration: 1 },
                stance: {},
                goals: []
            },
            reservedResources: {},
            targetedCells: new Set(),
            usedExploreDirections: {},
            militaryExplorers: 0,
            prioritizedExplorations: 0,
            attackerHistory: null,
            loggedGoals: new Set(),
            noProducerLogged: new Set(),
            fullyExploredLogged: false,
        };
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

        this.helper.aiLog(
            player,
            'turn',
            `Adaptive turn start | Round ${gameState.currentRound || 1} | Orders: ${player.orders}/${player.maxOrders} `
            + `| Focus: ${directive.focus} | Stances: [${stanceSummary}] | Goals: [${goalSummary}] `
            + `| Scores -> Military: ${player.score?.military || 0}, Economic: ${player.score?.economic || 0}, Exploration: ${player.score?.exploration || 0}`
        );

        const maxIterations = Math.max(player.orders * this.config.maxIterationsPerOrder, this.config.minimumIterations);
        let iterations = 0;

        while (player.orders > 0 && iterations++ < maxIterations) {
            const own = this.getActiveEntities();
            if (own.length === 0) {
                this.helper.aiLog(player, 'warn', 'No active entities remain; cannot act this turn.');
                break;
            }

            const econ = this.analyzeEconomy(directive);
            const involvedCells = [];
            let actionLabel = null;

            // 1. Immediate self-defence: kill or evade an adjacent/attacking enemy.
            if (this.attemptEmergencyDefense(econ, involvedCells)) {
                actionLabel = 'Emergency defence';
            }
            // 2. Resource deadlock prevention.
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
            // 8. Proactive economic/military growth.
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

        this.helper.aiLog(player, 'turn', `Adaptive turn ended | Remaining orders: ${player.orders}`);
    }

    // ==================== Directives & weights ====================

    /** The directive set by a director/LLM or the config, or null when none is set. */
    getExplicitDirective() {
        const controller = this.player.controller || {};
        const config = controller.config || {};
        return controller.directive || config.directive || config.aiDirective || null;
    }

    resolveDirective() {
        const controller = this.player.controller || {};
        const config = controller.config || {};
        const explicit = this.getExplicitDirective();

        let focus = 'balanced';
        let focusBias = { economy: 1, military: 1, exploration: 1 };

        if (explicit) {
            if (explicit.focus) {
                focus = normalizeFocus(explicit.focus);
                focusBias = focusToBias(focus);
            } else if (Array.isArray(controller.focus)) {
                // An explicit directive without focus still inherits the leader's bias.
                focusBias = leaderFocusBias(controller.focus);
            }
        } else if (config.focus) {
            focus = normalizeFocus(config.focus);
            focusBias = focusToBias(focus);
        } else if (Array.isArray(controller.focus)) {
            focusBias = leaderFocusBias(controller.focus);
        }

        return {
            focus,
            focusBias,
            stance: (explicit && explicit.stance) || {},
            goals: (explicit && Array.isArray(explicit.goals)) ? explicit.goals : [],
        };
    }

    /**
     * Blend directive bias with the current pillar scores so the geometric mean
     * (the real win condition) improves fastest. A zero pillar is urgent.
     */
    computeWeights(directive) {
        const scores = this.player.score || {};
        const rawNeed = {
            military: 1 / (Math.max(0, asNumber(scores.military)) + 1),
            economic: 1 / (Math.max(0, asNumber(scores.economic)) + 1),
            exploration: 1 / (Math.max(0, asNumber(scores.exploration)) + 1),
        };
        const meanNeed = (rawNeed.military + rawNeed.economic + rawNeed.exploration) / 3 || 1;
        const need = {
            military: Math.min(3, Math.max(0.5, rawNeed.military / meanNeed)),
            economic: Math.min(3, Math.max(0.5, rawNeed.economic / meanNeed)),
            exploration: Math.min(3, Math.max(0.5, rawNeed.exploration / meanNeed)),
        };

        const own = this.getActiveEntities();
        const hasDedicatedMilitary = own.some(entity => this.helper.isDedicatedMilitary(entity, this.manifest));
        const summary = this.getThreatSummary();
        const securityMultiplier = (!hasDedicatedMilitary && summary.hasThreats) ? 2.5 : 1;

        const bias = directive.focusBias || { economy: 1, military: 1, exploration: 1 };
        return {
            military: bias.military * need.military * securityMultiplier,
            economic: bias.economy * need.economic,
            exploration: bias.exploration * need.exploration,
        };
    }

    // ==================== Economy analysis ====================

    analyzeEconomy(directive) {
        const profile = this.player.getResourceProfile
            ? this.player.getResourceProfile()
            : { stock: this.player.resources, totalUpkeep: {}, totalYields: {}, netIncome: {}, turnsRemaining: {} };
        const stock = this.player.resources || {};
        const startingResources = this.gameState?.initializationSettings?.startingResources
            || this.gameState?.settings?.initialization?.startingResources
            || {};

        // B (Shahin, 2026-11-05): no manual yield adjustment here anymore.
        // getResourceProfile() already excludes entities that can't yield
        // (damaged or inactive) via Entity.canYield(), so subtracting their
        // yields again double-counted — a healthy farm plus a damaged farm
        // read as zero income. totalYields is the actual income as-is.
        const effectiveProfile = { ...profile };

        const resourceKeys = new Set([
            ...Object.keys(stock),
            ...Object.keys(effectiveProfile.totalUpkeep || {}),
            ...Object.keys(effectiveProfile.totalYields || {}),
            ...Object.keys(startingResources),
        ]);
        for (const meta of Object.values(this.manifestEntities)) {
            for (const key of Object.keys(meta?.spawnCost || {})) resourceKeys.add(key);
            for (const key of Object.keys(meta?.maintenance || {})) resourceKeys.add(key);
            for (const key of Object.keys(meta?.yields || {})) resourceKeys.add(key);
        }
        resourceKeys.delete(ORDERS_RESOURCE);

        const resources = {};
        for (const res of resourceKeys) {
            const resStock = asNumber(stock[res]);
            const net = asNumber(effectiveProfile.netIncome?.[res]);
            const upkeep = asNumber(effectiveProfile.totalUpkeep?.[res]);
            const yields = asNumber(effectiveProfile.totalYields?.[res]);
            const turnsRemaining = net < 0 ? resStock / -net : Infinity;
            const start = asNumber(startingResources[res]);
            const floor = start > 0 ? start : Math.max(1, upkeep * 2);
            const target = Math.max(floor, upkeep * this.config.targetUpkeepTurns);
            const needsAttention = upkeep > 0 || net < 0 || start > 0;

            let status = 'balanced';
            if (net < 0 && (turnsRemaining <= this.config.criticalTurnsRemaining || resStock <= 0)) {
                status = 'critical';
            } else if (net < 0 && turnsRemaining <= this.config.lowStockTurnsRemaining) {
                status = 'deficit';
            } else if (net < 0) {
                status = 'negative';
            } else if (needsAttention && resStock < target * 0.5) {
                status = 'low';
            } else if (net > 0 && resStock >= target * 2) {
                status = 'surplus';
            }

            const scarcity = status === 'critical' ? 4
                : status === 'deficit' ? 3
                    : status === 'negative' ? 2
                        : status === 'low' ? 1.5
                            : status === 'surplus' ? 0
                                : 1;

            resources[res] = {
                res,
                stock: resStock,
                net,
                upkeep,
                yields,
                turnsRemaining,
                target,
                status,
                scarcity,
            };
        }

        const all = Object.values(resources);
        const critical = all
            .filter(info => info.status === 'critical')
            .sort((a, b) => a.turnsRemaining - b.turnsRemaining);
        const deficits = all
            .filter(info => info.status === 'deficit')
            .sort((a, b) => a.turnsRemaining - b.turnsRemaining);
        const negative = all
            .filter(info => info.status === 'negative');
        const lowStock = all
            .filter(info => info.status === 'low')
            .sort((a, b) => (a.stock - a.target) - (b.stock - b.target));
        const surpluses = all.filter(info => info.status === 'surplus');

        // Urgent = likely to starve soon, or already negative with stock below target.
        const urgentMap = new Map();
        for (const info of [...critical, ...deficits]) urgentMap.set(info.res, info);
        for (const info of negative) {
            if (info.stock < info.target) urgentMap.set(info.res, info);
        }
        const urgent = Array.from(urgentMap.values())
            .sort((a, b) => (a.status === 'critical' ? 0 : 1) - (b.status === 'critical' ? 0 : 1)
                || a.turnsRemaining - b.turnsRemaining);

        const weights = this.computeWeights(directive);

        if (critical.length > 0 || deficits.length > 0) {
            // B15: analyzeEconomy runs every action step — only log when
            // the pressure actually changed, not the same line each time.
            const signature = JSON.stringify({
                c: critical.map(i => [i.res, i.stock, i.net]),
                d: deficits.map(i => [i.res, i.stock, i.net]),
            });
            if (this.turnState.lastPressureLog !== signature) {
                this.turnState.lastPressureLog = signature;
                this.helper.aiLog(
                    this.player,
                    'econ',
                    `Resource pressure | Critical: [${critical.map(info => `${info.res}(stock=${info.stock}, net=${info.net}, turns=${Number.isFinite(info.turnsRemaining) ? info.turnsRemaining : 'inf'})`).join(', ') || 'none'}] `
                    + `| Deficit: [${deficits.map(info => `${info.res}(stock=${info.stock}, net=${info.net}, turns=${Number.isFinite(info.turnsRemaining) ? info.turnsRemaining : 'inf'})`).join(', ') || 'none'}]`
                );
            }
        }

        return { profile: effectiveProfile, stock, resources, critical, deficits, negative, lowStock, surpluses, urgent, weights };
    }

    weightedCost(cost, econ) {
        let total = 0;
        for (const [res, amount] of Object.entries(stripOrders(cost))) {
            const scarcity = econ?.resources?.[res]?.scarcity ?? 1;
            total += asNumber(amount) * (1 + scarcity);
        }
        return Math.max(1, total);
    }

    findProducersForResource(res, econ) {
        const producers = [];
        for (const [name, meta] of Object.entries(this.manifestEntities)) {
            const gross = asNumber(meta?.yields?.[res]);
            if (gross <= 0) continue;
            const ownMaintenance = asNumber(meta?.maintenance?.[res]);
            const net = gross - ownMaintenance;
            if (net <= 0) continue;

            const costWeight = this.weightedCost(meta?.spawnCost, econ);

            // Penalise producers whose maintenance drains other scarce resources.
            let burden = 0;
            for (const [maintRes, amount] of Object.entries(meta?.maintenance || {})) {
                if (maintRes === res || maintRes === ORDERS_RESOURCE) continue;
                const scarcity = econ?.resources?.[maintRes]?.scarcity ?? 1;
                burden += asNumber(amount) * scarcity;
            }

            producers.push({
                name,
                meta,
                net,
                gross,
                costWeight,
                score: net / costWeight - burden * 0.05,
            });
        }

        producers.sort((a, b) => b.score - a.score);
        return producers;
    }

    // ==================== Production dependency chains ====================

    getBuilderBuildables(entity) {
        if (Array.isArray(entity?.state?.buildables)) return entity.state.buildables;
        if (Array.isArray(entity?.data?.buildables)) return entity.data.buildables;
        return [];
    }

    getRepairables(entity) {
        if (Array.isArray(entity?.state?.repairables)) return entity.state.repairables;
        if (Array.isArray(entity?.data?.repairables)) return entity.data.repairables;
        return [];
    }

    getBuildCharges(entity) {
        const charges = entity?.state?.buildCharges;
        return charges === undefined ? Infinity : asNumber(charges);
    }

    /**
     * Returns every immediate build step that can contribute to producing
     * `targetName`, ordered direct-first and then by prerequisite depth.
     *
     * A step is { builder, targetName, finalTarget, depth }. Recursive steps
     * build a prerequisite builder (e.g. village -> worker -> farm). The caller
     * tries steps in order and only executes one per action.
     */
    findProductionSteps(targetName, econ, visited = new Set(), depth = 0, out = [], rootTarget = null) {
        const manifestEntities = this.manifestEntities;
        const canonical = canonicalKey(manifestEntities, targetName);
        if (!canonical) return out;

        const root = rootTarget || canonical;
        const lower = canonical.toLowerCase();
        if (visited.has(lower) || depth > this.config.maxProductionDepth) return out;

        const nextVisited = new Set(visited);
        nextVisited.add(lower);

        // Direct: an owned active builder already knows how to build the target.
        for (const builder of this.getActiveEntities()) {
            if (!this.helper.isBuilder(builder)) continue;
            if (this.getBuildCharges(builder) <= 0) continue;
            const buildables = this.getBuilderBuildables(builder);
            if (!buildables.some(item => String(item).toLowerCase() === lower)) continue;
            out.push({ builder, targetName: canonical, finalTarget: root, depth });
        }

        // Recursive: find a type that can build the target, then find how to obtain that type.
        if (depth < this.config.maxProductionDepth) {
            for (const [builderType, meta] of Object.entries(manifestEntities)) {
                if (builderType.toLowerCase() === lower) continue;
                if (!Array.isArray(meta?.buildables)) continue;
                if (!meta.buildables.some(item => String(item).toLowerCase() === lower)) continue;

                this.findProductionSteps(builderType, econ, new Set(nextVisited), depth + 1, out, root);
                if (out.length >= this.config.maxProductionSteps) break;
            }
        }

        // Deduplicate and prefer fewer prerequisite hops, then cheaper steps.
        const unique = new Map();
        for (const step of out) {
            const key = `${step.builder?.id || step.builder?.name}:${step.targetName}`;
            if (!unique.has(key)) unique.set(key, step);
        }
        const steps = Array.from(unique.values());
        steps.sort((a, b) => {
            if (a.depth !== b.depth) return a.depth - b.depth;
            const costA = this.weightedCost(manifestEntities[a.targetName]?.spawnCost, econ);
            const costB = this.weightedCost(manifestEntities[b.targetName]?.spawnCost, econ);
            return costA - costB;
        });
        return steps.slice(0, this.config.maxProductionSteps);
    }

    reserveCost(cost) {
        for (const [res, amount] of Object.entries(stripOrders(cost))) {
            const value = asNumber(amount);
            if (value <= 0) continue;
            this.turnState.reservedResources[res] = Math.max(
                asNumber(this.turnState.reservedResources[res]),
                value
            );
        }
    }

    wouldSpendReserved(cost) {
        for (const [res, needed] of Object.entries(this.turnState.reservedResources)) {
            const spend = asNumber(stripOrders(cost)[res]);
            if (spend <= 0) continue;
            const stock = asNumber(this.player.resources?.[res]);
            if (stock - spend < needed) return true;
        }
        return false;
    }

    /**
     * Reject proactive builds that would create a new unrecoverable deficit.
     * Deficit-recovery steps deliberately bypass this (a worker may temporarily
     * worsen food while being built to unlock a farm).
     */
    isBuildSustainable(meta, econ) {
        for (const [res, amount] of Object.entries(meta?.maintenance || {})) {
            if (res === ORDERS_RESOURCE) continue;
            const gain = asNumber(meta?.yields?.[res]);
            const netDelta = gain - asNumber(amount);

            // If the build improves (or maintains) this resource's net income,
            // it is a remedy, not a new risk, even if the resource is still
            // negative overall. Do not block it.
            if (netDelta >= 0) continue;

            const projectedNet = asNumber(econ?.profile?.netIncome?.[res]) + netDelta;
            const stock = asNumber(econ?.stock?.[res]);
            if (projectedNet < 0 && stock < Math.abs(projectedNet) * this.config.lowStockTurnsRemaining) {
                return false;
            }
        }
        return true;
    }

    /**
     * Never spend so much of a resource with recurring upkeep that the next
     * turn's maintenance cannot be paid. Deficit recovery bypasses this;
     * proactive growth must not cause the very deadlock it is trying to avoid.
     */
    isCostSafeToSpend(cost, econ) {
        for (const [res, amount] of Object.entries(stripOrders(cost))) {
            const info = econ?.resources?.[res];
            if (!info || info.upkeep <= 0) continue;
            const after = info.stock - asNumber(amount);
            const reserve = info.upkeep * Math.max(1, this.config.maintenanceReserveTurns);
            if (after < reserve) return false;
        }
        return true;
    }

    // ==================== Actions ====================

    executeBuild(builder, targetName, category, reason, involvedCells) {
        if (!builder || !builder.active) return 0;
        if (this.getBuildCharges(builder) <= 0) return 0;

        const meta = this.manifestEntities[targetName];
        const cost = meta?.spawnCost || {};
        const costText = Object.entries(stripOrders(cost)).map(([res, amount]) => `${amount} ${res}`).join(', ') || 'free';
        const start = { q: builder.q, r: builder.r };
        // Snapshot entity IDs so we can find the newly built entity's cell.
        const beforeIds = new Set(this.getActiveEntities().map(e => e.id));

        this.helper.aiLog(
            this.player,
            category,
            `Build decision | Builder: ${builder.name}#${String(builder.id).slice(-4)} (${this.player.name}) at (${builder.q},${builder.r}) `
            + `| Target: ${this.helper.camelToTitle(targetName)} | Cost: ${costText} | Reason: ${reason}`
        );

        const result = this.helper.build(this.gameState, builder, targetName);
        const used = ordersUsedFrom(result);
        if (used > 0) {
            // B15: log the BUILT cell, not the builder's cell — the UI
            // refreshes involvedCells, and the built entity is adjacent.
            const built = this.getActiveEntities().find(e => !beforeIds.has(e.id) && e.name === targetName);
            const builtCell = built ? { q: built.q, r: built.r } : builder.cell;
            involvedCells.push(start, builtCell);
            this.helper.aiLog(
                this.player,
                category,
                `Build result | ${builder.name}#${String(builder.id).slice(-4)} -> ${this.helper.camelToTitle(targetName)} `
                + `at (${builtCell?.q},${builtCell?.r}) | Orders used: ${used} | ${result?.result?.message || 'done'}`
            );
        }
        return used;
    }

    attemptCriticalDeficits(econ, involvedCells) {
        if (!econ.urgent || econ.urgent.length === 0) return false;

        for (const need of econ.urgent) {
            // A damaged producer of this resource is producing nothing (yields
            // stop at <=95% HP). Repairing it is cheaper than building a
            // replacement, so try that before spawning anything new.
            if (this.attemptRepairForResource(need.res, involvedCells)) {
                return true;
            }

            const producers = this.findProducersForResource(need.res, econ);
            if (producers.length === 0) {
                if (!this.turnState.noProducerLogged.has(need.res)) {
                    this.turnState.noProducerLogged.add(need.res);
                    this.helper.aiLog(
                        this.player,
                        'warn',
                        `No entity in the manifest yields ${need.res}; cannot build a producer for this deficit.`
                    );
                }
                continue;
            }

            // Compare every affordable immediate step across all viable
            // producers. This weighs "build the best producer now" against
            // "build a prerequisite for the best producer" and against a
            // directly-affordable alternative, instead of blindly building
            // both producers (spec hint 12).
            const actionCandidates = [];

            for (const producer of producers) {
                const steps = this.findProductionSteps(producer.name, econ);
                for (const step of steps) {
                    const meta = this.manifestEntities[step.targetName];
                    if (!meta) continue;
                    const cost = meta.spawnCost || {};
                    if (!this.player.hasResources(cost)) continue;

                    const stepCostWeight = this.weightedCost(cost, econ);
                    const score = (producer.net / stepCostWeight) / (1 + step.depth * 0.5);
                    actionCandidates.push({ step, producer, score });
                }
            }

            if (actionCandidates.length === 0) {
                // Nothing is affordable yet. Remember the most effective
                // producer's first step so proactive growth does not spend the
                // resources being saved for the remedy.
                const topProducer = producers[0];
                const topSteps = this.findProductionSteps(topProducer.name, econ);
                if (topSteps.length > 0) {
                    const pendingCost = this.manifestEntities[topSteps[0].targetName]?.spawnCost || {};
                    this.reserveCost(pendingCost);
                    this.helper.aiLog(
                        this.player,
                        'econ',
                        `Cannot yet afford the remedy for ${need.res}. Reserving ${JSON.stringify(stripOrders(pendingCost))} from proactive spending.`
                    );
                } else {
                    this.helper.aiLog(
                        this.player,
                        'warn',
                        `No owned builder can reach a producer of ${need.res} yet; the production dependency chain is blocked.`
                    );
                }
                continue;
            }

            for (const candidate of this.rankDeficitCandidates(actionCandidates)) {
                const { step, producer } = candidate;
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
                    // B13: if this was a prerequisite step, reserve the final
                    // producer's cost so proactive growth doesn't spend it
                    // before the chain completes.
                    if (step.finalTarget && step.finalTarget !== step.targetName) {
                        const finalCost = this.manifestEntities[step.finalTarget]?.spawnCost || {};
                        this.reserveCost(finalCost);
                    }
                    return true;
                }
            }
        }

        // TODO: Entity scrapping. If a resource deadlock is unavoidable and
        // inactive/low-value entities are draining maintenance, implement
        // scrapping here: prefer destroying the lowest-value entity whose
        // maintenance is blocking recovery, and remove it from the game state.
        return false;
    }

    /** Order in which affordable deficit-remedy steps are tried: best score first. */
    rankDeficitCandidates(candidates) {
        return candidates.sort((a, b) => b.score - a.score);
    }

    // ==================== Combat ====================

    getActiveEntities() {
        const entities = this.player.getEntities ? this.player.getEntities() : [];
        return entities.filter(entity => entity && entity.active && !entity.destroyed);
    }

    getEntityMeta(entity) {
        return this.manifestEntities[entity?.name] || entity?.state || entity?.data || {};
    }

    getEntityValue(entity) {
        const meta = this.getEntityMeta(entity);
        const score = meta.score || {};
        let yieldValue = 0;
        for (const [res, amount] of Object.entries(meta.yields || {})) {
            if (res === ORDERS_RESOURCE) continue;
            yieldValue += asNumber(amount);
        }
        return 1
            + asNumber(score.military)
            + asNumber(score.economic)
            + yieldValue * 2
            + asNumber(meta.ordersPerTurn) * 5;
    }

    /**
     * Visible foreign entities, grouped by owner id. Uses Player.getOpponents()
     * exactly as required by the spec; the same list is used for enemies, allies
     * and neutral bystanders, then classified by stance.
     */
    getVisibleForeignEntities() {
        const groups = this.player.getOpponents ? this.player.getOpponents(this.gameState) : {};
        const list = [];
        const seen = new Set();
        for (const [ownerKey, group] of Object.entries(groups || {})) {
            for (const entity of group.entities || []) {
                if (!entity || entity.destroyed || asNumber(entity.health) <= 0) continue;
                if (seen.has(entity.id)) continue;
                seen.add(entity.id);
                list.push({
                    entity,
                    ownerId: entity.owner ? entity.owner.id : null,
                    ownerName: group.name || entity.owner?.name || 'Neutral',
                    group,
                });
            }
        }
        return list;
    }

    getStance(ownerId) {
        const stanceMap = this.turnState.directive?.stance || {};
        // Ownerless entities are barbarians: treat the stance toward them
        // as defensive — engage if they come within threat range.
        if (ownerId === null || ownerId === undefined) return 'defensive';
        return stanceMap[ownerId] || stanceMap[String(ownerId)] || 'neutral';
    }

    /**
     * This engine records incoming damage in Player.history with structured
     * attackerId fields (Entity.attackHistory does not exist here), so the
     * per-round history is the authoritative threat source.
     */
    getAttackerHistory() {
        if (this.turnState.attackerHistory) return this.turnState.attackerHistory;

        const currentRound = this.gameState?.currentRound || 1;
        const startRound = Math.max(1, currentRound - 2);
        const entries = this.player.getHistoryRange
            ? this.player.getHistoryRange(startRound, currentRound)
            : [];
        const map = new Map();

        for (const entry of entries) {
            if (!entry) continue;
            if (entry.category !== 'damaged' && entry.category !== 'destroy') continue;
            const extra = entry.extra || {};
            const attackerId = extra.attackerId;
            if (!attackerId) continue;
            const damage = asNumber(extra.damage, entry.category === 'destroy' ? 1 : 0);
            map.set(attackerId, asNumber(map.get(attackerId)) + damage);
        }

        this.turnState.attackerHistory = map;
        return map;
    }

    getThreatSummary() {
        const own = this.getActiveEntities();
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

            // Unowned barbarians are threats when near. Player-owned units are
            // only proximity-threats for the defensive stance; neutral players
            // are engaged only via attacker history or a safe opportunity, and
            // caution players only when they actually attack us.
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

    selectAttackers(target, options = {}) {
        const own = this.getActiveEntities().filter(entity =>
            this.helper.isCombatCapable(entity) && asNumber(entity.actionPoints, 0) > 0
        );
        if (own.length === 0) return [];

        const dedicated = own.filter(entity => this.helper.isDedicatedMilitary(entity, this.manifest));

        let pool;
        if (options.emergency) {
            const nonBuilders = own.filter(entity => !this.helper.isBuilder(entity));
            pool = dedicated.length > 0 ? dedicated : (nonBuilders.length > 0 ? nonBuilders : own);
            // Emergency defence only pulls nearby units — a unit 10+ hexes
            // away can't help with a threat here now. (B2's canAttackTarget
            // check was reverted: helper.attack already closes distance or
            // burns nothing, so the check only removed useful progress.)
            pool = pool.filter(entity =>
                this.helper.distance(entity, target) <= this.config.opportunisticRange
            );
        } else {
            const nonSupport = own.filter(entity =>
                !this.helper.isBuilder(entity) && !this.helper.isRepairer(entity)
            );
            // Do not send workers/builders on opportunistic attacks. If no
            // proper combat unit exists, skip and let proactive growth build one.
            pool = dedicated.length > 0 ? dedicated : nonSupport;
        }

        return [...pool].sort((a, b) => {
            const distA = this.helper.distance(a, target);
            const distB = this.helper.distance(b, target);
            if (distA !== distB) return distA - distB;
            return this.helper.getCombatPower(b, this.getEntityMeta(b))
                - this.helper.getCombatPower(a, this.getEntityMeta(a));
        });
    }

    attemptEmergencyDefense(econ, involvedCells) {
        const own = this.getActiveEntities();
        const foreign = this.getVisibleForeignEntities();
        if (own.length === 0 || foreign.length === 0) return false;

        const immediate = this.getImmediateThreats(own, foreign);
        return this.respondToImmediateThreats(immediate, econ, involvedCells);
    }

    /**
     * Foreign entities that need an answer this action (attacked us, can
     * strike us now, or are striking an ally), most urgent first.
     */
    getImmediateThreats(own, foreign) {
        const history = this.getAttackerHistory();
        const immediate = [];
        const alliedEntities = foreign
            .filter(item => this.getStance(item.ownerId) === 'ally')
            .map(item => item.entity);

        for (const item of foreign) {
            const target = item.entity;
            const stance = this.getStance(item.ownerId);
            const friendly = stance === 'friendly' || stance === 'ally';
            const nearestOwn = Math.min(...own.map(unit => this.helper.distance(unit, target)));
            const nearestAlly = alliedEntities.length
                ? Math.min(...alliedEntities.map(ally => this.helper.distance(target, ally)))
                : Infinity;
            const attackerDamage = asNumber(history.get(target.id));
            const rangeMax = asNumber(target.range?.maxCells, 1);
            const moveBonus = target.isConstruct ? 0 : 1;
            const canStrike = nearestOwn <= Math.max(1, rangeMax) + moveBonus;
            const alliedThreat = alliedEntities.length > 0
                && nearestAlly <= Math.max(1, rangeMax) + moveBonus;

            // Friendly/ally units are only defended against if they actually
            // attacked us. Caution-stance units are avoided and only engaged
            // in self-defence. Neutral units are treated the same as caution:
            // proximity alone is not hostility — engage only after they
            // actually attack. A strike on an ally is defended.
            const passiveCaution = stance === 'caution' && attackerDamage === 0;
            const passiveNeutral = stance === 'neutral' && attackerDamage === 0;
            const isImmediate = attackerDamage > 0
                || (!friendly && ((!passiveCaution && !passiveNeutral && (nearestOwn <= 1 || canStrike)) || alliedThreat));
            if (!isImmediate) continue;

            immediate.push({ ...item, stance, nearestOwn, nearestAlly, attackerDamage, alliedThreat });
        }

        immediate.sort((a, b) => b.attackerDamage - a.attackerDamage
            || Math.min(a.nearestOwn, a.nearestAlly) - Math.min(b.nearestOwn, b.nearestAlly));
        return immediate;
    }

    /** Attack the most urgent immediate threat, else save adjacent vulnerable units. */
    respondToImmediateThreats(immediate, econ, involvedCells) {
        for (const item of immediate) {
            const target = item.entity;
            const candidates = this.selectAttackers(target, { emergency: true });
            if (candidates.length === 0) continue;

            this.helper.aiLog(
                this.player,
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
                const result = this.helper.attack(this.gameState, attacker, target, 1);
                const used = ordersUsedFrom(result);
                if (used > 0) {
                    involvedCells.push(from, attacker.cell);
                    this.helper.aiLog(
                        this.player,
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

    isFavorableEngagement(target, foreign, powerRatio, requireKill) {
        const own = this.getActiveEntities().filter(entity =>
            this.helper.isCombatCapable(entity)
            && asNumber(entity.actionPoints, 0) > 0
            && !this.helper.isBuilder(entity)
        );
        if (own.length === 0) return false;

        const localOwn = own.filter(unit =>
            this.helper.distance(unit, target) <= this.config.opportunisticRange
        );
        if (localOwn.length === 0) return false;

        const localPower = localOwn.reduce(
            (sum, unit) => sum + this.helper.getCombatPower(unit, this.getEntityMeta(unit)),
            0
        );
        const enemyPower = foreign
            .filter(item => {
                const stance = this.getStance(item.ownerId);
                if (stance === 'friendly' || stance === 'ally') return false;
                return this.helper.distance(item.entity, target) <= this.config.opportunisticEnemyRadius;
            })
            .reduce((sum, item) => sum + this.helper.getCombatPower(item.entity, this.getEntityMeta(item.entity)), 0);
        const targetPower = this.helper.getCombatPower(target, this.getEntityMeta(target));

        // Unowned barbarians/neutrals only become targets when near our territory.
        if (target.owner === null || target.owner === undefined) {
            const nearestOwn = Math.min(...this.getActiveEntities().map(unit => this.helper.distance(unit, target)));
            if (nearestOwn > this.config.threatRadius * 2) return false;
        }

        // B1: the construct branch used to return before the requireKill
        // check, so one swordsman qualified against any farm/mine (construct
        // power is armor×10, tiny vs a unit). Apply the same kill threshold
        // as for units — an opportunistic attack must be able to finish the
        // target, not just out-power it 0.5x.
        if (target.isConstruct) {
            const killRatio = requireKill ? 1.2 : 0.5;
            return localPower >= enemyPower * 1.1 && localPower >= targetPower * killRatio;
        }

        if (requireKill && localPower < targetPower * 1.2) return false;
        return localPower >= enemyPower * powerRatio
            && localPower >= targetPower * (requireKill ? 1.2 : 0.8);
    }

    hasOffensiveAdvantage(target, foreign) {
        return this.isFavorableEngagement(target, foreign, this.config.offensivePowerRatio, false);
    }

    attemptCombat(econ, involvedCells) {
        const own = this.getActiveEntities();
        const foreign = this.getVisibleForeignEntities();
        if (foreign.length === 0) return false;

        const summary = this.getThreatSummary();
        const history = this.getAttackerHistory();
        const hasCombat = own.some(entity =>
            this.helper.isCombatCapable(entity) && asNumber(entity.actionPoints, 0) > 0
        );

        if (!hasCombat) {
            // No military at all: if threatened, spend this action on a defender.
            if (summary.hasThreats) {
                return this.attemptProactiveBuild(econ, {
                    category: 'military',
                    defensive: true,
                    involvedCells,
                });
            }
            return false;
        }

        const targets = [];
        const alliedEntities = foreign
            .filter(item => this.getStance(item.ownerId) === 'ally')
            .map(item => item.entity);

        for (const item of foreign) {
            const target = item.entity;
            const stance = this.getStance(item.ownerId);
            if (stance === 'friendly' || stance === 'ally') continue;

            const nearestOwn = own.length
                ? Math.min(...own.map(unit => this.helper.distance(unit, target)))
                : Infinity;
            const nearestAlly = alliedEntities.length
                ? Math.min(...alliedEntities.map(ally => this.helper.distance(target, ally)))
                : Infinity;
            const attackerDamage = asNumber(history.get(target.id));
            const engagementDistance = this.getEngagementDistance(target, own, nearestOwn);

            const isBarbarian = item.ownerId === null || item.ownerId === undefined;
            const hostileStance = stance === 'offensive';
            const targetReach = Math.max(1, asNumber(target.range?.maxCells, 1))
                + (target.isConstruct ? 0 : 1);
            const proximityThreat = isBarbarian
                ? nearestOwn <= this.config.threatRadius
                : (stance === 'defensive' && nearestOwn <= this.config.threatRadius);
            const alliedThreat = alliedEntities.length > 0 && nearestAlly <= targetReach;
            // B9: a hostile-stance enemy within threat radius is NOT an
            // automatic threat — it must go through hasOffensiveAdvantage
            // (the hostileStance branch below). Auto-allowing it skipped the
            // force-balance check entirely (mistakes.md #13 regression).
            const isThreat = attackerDamage > 0
                || proximityThreat
                || alliedThreat;

            let allowed = false;
            let reason = '';

            if (isThreat) {
                allowed = true;
                reason = attackerDamage > 0
                    ? 'retaliation'
                    : alliedThreat ? 'defending ally' : 'threat in territory';
            } else if (hostileStance) {
                allowed = this.hasOffensiveAdvantage(target, foreign);
                reason = allowed ? 'offensive stance' : 'offensive stance (unfavorable local balance)';
            } else if (stance === 'defensive') {
                allowed = engagementDistance <= this.config.threatRadius + 2;
                reason = 'defensive engagement range';
            } else if (stance === 'caution' || stance === 'neutral') {
                // Neutral is below caution: no special targeting — never
                // initiate an attack. (Retaliation/defense still apply via
                // the isThreat branch above, same as caution.)
                allowed = false;
            }

            if (!allowed) continue;

            const meta = this.getEntityMeta(target);
            const score = meta.score || {};
            let yieldValue = 0;
            for (const [res, amount] of Object.entries(meta.yields || {})) {
                if (res === ORDERS_RESOURCE) continue;
                yieldValue += asNumber(amount);
            }
            const value = asNumber(score.military)
                + asNumber(score.economic)
                + yieldValue * 2
                + asNumber(meta.ordersPerTurn) * 10
                + asNumber(meta.damage?.value) * 0.2
                + (this.helper.isBuilder(target) ? 5 : 0)
                + (this.helper.isRepairer(target) ? 5 : 0);
            const ownerScore = asNumber(item.group?.score?.total);

            targets.push({
                ...item,
                stance,
                nearestOwn,
                nearestAlly,
                engagementDistance,
                attackerDamage,
                isThreat,
                reason,
                priority: (isThreat ? 1000 + attackerDamage * 10 : 0)
                    + value
                    - Math.min(engagementDistance, nearestAlly) * 2
                    + (stance === 'offensive' ? 50 : 0)
                    + ownerScore * 0.05,
            });
        }

        targets.sort((a, b) => b.priority - a.priority);
        if (this.engageCombatTargets(targets, involvedCells)) return true;

        // Only workers/repairers are combat-capable but none was suitable for
        // offensive action. If threatened, invest this action in a real defender.
        const hasDedicated = own.some(entity =>
            this.helper.isDedicatedMilitary(entity, this.manifest)
            && asNumber(entity.actionPoints, 0) > 0
        );
        if (!hasDedicated && summary.hasThreats) {
            return this.attemptProactiveBuild(econ, {
                category: 'military',
                defensive: true,
                involvedCells,
            });
        }

        return false;
    }

    /**
     * Distance used for the defensive engagement range and for target
     * priority. Adaptive measures it from any own entity (nearestOwn).
     */
    getEngagementDistance(target, own, nearestOwn) {
        return nearestOwn;
    }

    /** Attack the highest-priority target any candidate can engage. True if an order was spent. */
    engageCombatTargets(targets, involvedCells) {
        for (const item of targets) {
            const target = item.entity;
            const candidates = this.selectAttackers(target, { emergency: item.isThreat });
            if (candidates.length === 0) continue;

            this.helper.aiLog(
                this.player,
                'combat',
                `Engagement decision | Target: ${target.name}#${String(target.id).slice(-4)} (${item.ownerName}) at (${target.q},${target.r}) `
                + `| Stance: ${item.stance} | Reason: ${item.reason} | Distance: ${item.nearestOwn} | Threat: ${item.isThreat} `
                + `| Candidates: [${candidates.map(unit => `${unit.name}#${String(unit.id).slice(-4)}@(${unit.q},${unit.r}) dist=${this.helper.distance(unit, target)}`).join(', ')}]`
            );

            for (const attacker of candidates) {
                const from = { q: attacker.q, r: attacker.r };
                const result = this.helper.attack(this.gameState, attacker, target, 1);
                const used = ordersUsedFrom(result);
                if (used > 0) {
                    involvedCells.push(from, attacker.cell);
                    this.helper.aiLog(
                        this.player,
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

    attemptRetreats(econ, involvedCells, immediateOnly) {
        const own = this.getActiveEntities();
        const foreign = this.getVisibleForeignEntities();
        if (own.length === 0 || foreign.length === 0) return false;

        const threats = foreign.filter(item => this.isRetreatThreat(item));
        if (threats.length === 0) return false;

        const vulnerable = own.filter(entity =>
            !entity.isConstruct
            && this.helper.isMobile(entity)
            && asNumber(entity.actionPoints, 0) > 0
            && !this.helper.isDedicatedMilitary(entity, this.manifest)
        );

        for (const unit of vulnerable) {
            const currentMin = Math.min(...threats.map(item => this.helper.distance(unit, item.entity)));
            if (immediateOnly ? currentMin > 1 : currentMin > 2) continue;

            const moveAction = unit.getActions ? unit.getActions().find(action => action.name === 'Move') : null;
            if (!moveAction) continue;

            const { cell: bestCell, score: bestScore } = this.pickRetreatCell(unit, threats, currentMin, moveAction);

            const from = { q: unit.q, r: unit.r };
            if (bestCell && moveAction.do(bestCell, null)) {
                involvedCells.push(from, bestCell);
                this.helper.aiLog(
                    this.player,
                    'warn',
                    `Retreat | ${unit.name}#${String(unit.id).slice(-4)} (${this.player.name}) from (${from.q},${from.r}) to (${bestCell.q},${bestCell.r}) `
                    + `| Nearest threat moved from ${currentMin} to ${bestScore} hex(es).`
                );
                return true;
            }
        }

        return false;
    }

    /** Foreign entities that vulnerable units retreat from: everyone but friendly/ally. */
    isRetreatThreat(item) {
        const stance = this.getStance(item.ownerId);
        return stance !== 'friendly' && stance !== 'ally';
    }

    /**
     * The free neighbouring cell that moves `unit` farthest from the nearest
     * threat. Returns { cell, score }; cell is null when no move improves on
     * `currentMin` (score is then currentMin).
     */
    pickRetreatCell(unit, threats, currentMin, moveAction) {
        let bestCell = null;
        let bestScore = currentMin;
        for (const cell of this.helper.getNeighbors(unit.q, unit.r)) {
            if (this.gameState.getEntityAt(cell.q, cell.r)) continue;
            if (!Number.isFinite(unit.getMovementCost(cell))) continue;
            const check = moveAction.canDo(cell, null);
            if (!check || !check.possible) continue;
            const score = Math.min(...threats.map(item => this.helper.distance(cell, item.entity)));
            if (score > bestScore) {
                bestScore = score;
                bestCell = cell;
            }
        }
        return { cell: bestCell, score: bestScore };
    }

    // ==================== Repairs ====================

    /**
     * Repairs are normally limited to heavy damage (<50%). Economic producers
     * are the exception: Entity.step() stops all yields while health <= 95%,
     * so a 90%-HP farm is effectively disabled. Repairing it is far cheaper
     * than building a replacement.
     */
    isDamageWorthRepair(entity) {
        const maxHealth = asNumber(entity?.maxHealth);
        if (maxHealth <= 0) return false;
        const ratio = asNumber(entity.health) / maxHealth;
        const meta = this.getEntityMeta(entity);
        const producesYields = Object.keys(stripOrders(meta.yields)).length > 0;
        const threshold = producesYields
            ? Math.max(this.config.repairHealthRatio, this.config.yieldRepairRatio)
            : this.config.repairHealthRatio;
        return ratio <= threshold;
    }

    attemptRepairs(econ, involvedCells) {
        const own = this.getActiveEntities();
        const foreign = this.getVisibleForeignEntities();
        const allies = foreign
            .filter(item => ['ally', 'friendly'].includes(this.getStance(item.ownerId)))
            .map(item => item.entity);

        const damaged = [...own, ...allies].filter(entity =>
            entity
            && entity.active
            && !entity.destroyed
            && this.isDamageWorthRepair(entity)
        );
        if (damaged.length === 0) return false;

        const repairers = own.filter(entity =>
            this.helper.isRepairer(entity) && asNumber(entity.actionPoints, 0) > 0
        );
        if (repairers.length === 0) return false;

        let repairableTargets = damaged.filter(target =>
            repairers.some(repairer =>
                repairer.id !== target.id
                && this.getRepairables(repairer).some(name => String(name).toLowerCase() === String(target.name).toLowerCase())
            )
        );
        if (repairableTargets.length === 0) return false;

        // Proxied arrays sort a copy — capture the return value (see ai-interface-spec.md).
        repairableTargets = repairableTargets.sort((a, b) => {
            const damageA = 1 - (asNumber(a.health) / asNumber(a.maxHealth));
            const damageB = 1 - (asNumber(b.health) / asNumber(b.maxHealth));
            return (damageB * this.getEntityValue(b)) - (damageA * this.getEntityValue(a));
        });

        for (const target of repairableTargets) {
            const candidates = repairers
                .filter(repairer =>
                    repairer.id !== target.id
                    && this.getRepairables(repairer).some(name => String(name).toLowerCase() === String(target.name).toLowerCase())
                )
                .sort((a, b) => this.helper.distance(a, target) - this.helper.distance(b, target));
            if (candidates.length === 0) continue;
            if (this.executeRepairAttempt(target, candidates, involvedCells) > 0) return true;
        }

        return false;
    }

    /**
     * Repairs an active damaged producer of `res` before a replacement is
     * spawned for a deficit. Returns true if an order was spent repairing.
     */
    attemptRepairForResource(res, involvedCells) {
        const own = this.getActiveEntities();
        const repairers = own.filter(entity =>
            this.helper.isRepairer(entity) && asNumber(entity.actionPoints, 0) > 0
        );
        if (repairers.length === 0) return false;

        const targets = own
            .filter(entity => {
                const meta = this.getEntityMeta(entity);
                return asNumber(meta.yields?.[res]) > 0 && this.isDamageWorthRepair(entity);
            })
            .sort((a, b) => {
                const damageA = 1 - (asNumber(a.health) / asNumber(a.maxHealth));
                const damageB = 1 - (asNumber(b.health) / asNumber(b.maxHealth));
                return (damageB * this.getEntityValue(b)) - (damageA * this.getEntityValue(a));
            });

        for (const target of targets) {
            const candidates = repairers
                .filter(repairer =>
                    repairer.id !== target.id
                    && this.getRepairables(repairer).some(name => String(name).toLowerCase() === String(target.name).toLowerCase())
                )
                .sort((a, b) => this.helper.distance(a, target) - this.helper.distance(b, target));
            if (candidates.length === 0) continue;
            if (this.executeRepairAttempt(target, candidates, involvedCells) > 0) return true;
        }

        return false;
    }

    executeRepairAttempt(target, candidates, involvedCells) {
        for (const repairer of candidates) {
            const from = { q: repairer.q, r: repairer.r };
            this.helper.aiLog(
                this.player,
                'build',
                `Repair decision | Repairer: ${repairer.name}#${String(repairer.id).slice(-4)} (${this.player.name}) at (${repairer.q},${repairer.r}) `
                + `| Target: ${target.name}#${String(target.id).slice(-4)} (${target.owner?.name || 'Neutral'}) at (${target.q},${target.r}) `
                + `| HP: ${Math.round(target.health)}/${target.maxHealth}`
            );
            // B7: maxOrders 2, not 1 — with 1 order, support() could move the
            // repairer adjacent but never repair in the same call, so the unit
            // ping-ponged between retreat (step 4, outranks repair) and repair.
            const result = this.helper.support(this.gameState, repairer, target, 'Repair', 2);
            const used = ordersUsedFrom(result);
            if (used > 0) {
                involvedCells.push(from, repairer.cell);
                this.helper.aiLog(
                    this.player,
                    'build',
                    `Repair result | ${repairer.name}#${String(repairer.id).slice(-4)} -> ${target.name}#${String(target.id).slice(-4)} | ${result?.result?.message || 'repaired'}`
                );
                return used;
            }
        }
        return 0;
    }

    // ==================== Directive goals ====================

    getStartCell() {
        const coord = this.player.startCoord;
        if (!coord) return null;
        return this.helper.getCell(coord.q, coord.r) || null;
    }

    getGoalTargetCoord(goal) {
        if (!goal || !goal.target) return null;
        if (typeof goal.target.q === 'number' && typeof goal.target.r === 'number') {
            return { q: goal.target.q, r: goal.target.r };
        }
        if (goal.target.entityId) {
            const entity = this.gameState.entities?.find(item => item.id === goal.target.entityId);
            if (!entity || entity.destroyed) return null;
            return { q: entity.q, r: entity.r };
        }
        return null;
    }

    isReinforced(coord) {
        if (!coord) return true;
        const own = this.getActiveEntities().filter(entity => this.helper.isCombatCapable(entity));
        const nearby = own.filter(entity => this.helper.distance(entity, coord) <= 1);
        if (nearby.length === 0) return false;

        const power = nearby.reduce(
            (sum, entity) => sum + this.helper.getCombatPower(entity, this.getEntityMeta(entity)),
            0
        );
        const enemyPower = this.getVisibleForeignEntities()
            .filter(item => {
                const stance = this.getStance(item.ownerId);
                if (stance === 'friendly' || stance === 'ally') return false;
                return this.helper.distance(item.entity, coord) <= this.config.threatRadius;
            })
            .reduce((sum, item) => sum + this.helper.getCombatPower(item.entity, this.getEntityMeta(item.entity)), 0);

        const required = enemyPower > 0 ? enemyPower * 1.25 : 1;
        return power >= required;
    }

    isExploreGoalComplete(goal) {
        const startCell = this.getStartCell();
        if (!startCell) return false;

        if (goal?.target) {
            const coord = this.getGoalTargetCoord(goal);
            if (!coord) return true;
            const remaining = this.helper.getCellsArray().some(cell =>
                cell
                && !this.player.isExplored(cell.q, cell.r)
                && this.helper.distance(cell, coord) <= 3
            );
            return !remaining;
        }

        if (goal?.direction) {
            const direction = this.normalizeExploreDirection(goal.direction, this.getUnexploredDirectionStats(startCell));
            if (!direction) return true;
            const stats = this.getUnexploredDirectionStats(startCell);
            const entry = stats.find(item => item.direction === direction);
            return !entry || entry.count === 0;
        }

        return !this.helper.getCellsArray().some(cell => cell && !this.player.isExplored(cell.q, cell.r));
    }

    processGoals(econ, involvedCells) {
        const goals = this.turnState.directive?.goals || [];

        for (const goal of goals) {
            if (!goal || !goal.type) continue;

            if (goal.type === 'reinforce') {
                const coord = this.getGoalTargetCoord(goal);
                if (!coord) continue;
                if (this.isReinforced(coord)) {
                    const key = `reinforce:${coord.q},${coord.r}`;
                    if (!this.turnState.loggedGoals.has(key)) {
                        this.turnState.loggedGoals.add(key);
                        this.helper.aiLog(this.player, 'combat', `Goal complete | Reinforce (${coord.q},${coord.r}) has sufficient force.`);
                    }
                    continue;
                }

                const candidates = this.getActiveEntities()
                    .filter(entity =>
                        this.helper.isCombatCapable(entity)
                        && this.helper.isMobile(entity)
                        && !this.helper.isBuilder(entity)
                        && !this.helper.isRepairer(entity)
                        && asNumber(entity.actionPoints, 0) > 0
                        && this.helper.distance(entity, coord) > 1
                    )
                    .sort((a, b) => this.helper.distance(a, coord) - this.helper.distance(b, coord));
                if (candidates.length === 0) continue;

                for (const unit of candidates) {
                    const used = this.moveUnitToward(unit, coord, `reinforce goal (${coord.q},${coord.r})`, involvedCells);
                    if (used > 0) return true;
                }
                continue;
            }

            if (goal.type === 'explore') {
                if (this.isExploreGoalComplete(goal)) {
                    const key = `explore:${goal.direction || `${goal.target?.q},${goal.target?.r}`}`;
                    if (!this.turnState.loggedGoals.has(key)) {
                        this.turnState.loggedGoals.add(key);
                        this.helper.aiLog(this.player, 'explore', `Goal complete | Explore ${key.replace('explore:', '')}.`);
                    }
                    continue;
                }

                if (this.attemptExploration(econ, involvedCells, {
                    preferredDirection: goal.direction || null,
                    targetCoord: this.getGoalTargetCoord(goal),
                    goalOnly: true,
                })) {
                    return true;
                }
                continue;
            }

            if (goal.type === 'buildEconomy' || goal.type === 'buildMilitary') {
                const category = goal.type === 'buildEconomy' ? 'economy' : 'military';
                if (this.attemptProactiveBuild(econ, {
                    category,
                    goal,
                    involvedCells,
                })) {
                    return true;
                }
                this.helper.aiLog(
                    this.player,
                    'detail',
                    `Goal ${goal.type}: no affordable/valid ${category} build is available right now.`
                );
                continue;
            }

            this.helper.aiLog(this.player, 'detail', `Unknown directive goal type "${goal.type}" ignored.`);
        }

        return false;
    }

    moveUnitToward(unit, coord, reason, involvedCells) {
        if (!unit || !unit.active || asNumber(unit.actionPoints, 0) <= 0) return 0;
        const moveAction = unit.getActions ? unit.getActions().find(action => action.name === 'Move') : null;
        if (!moveAction) return 0;

        let destination = { q: coord.q, r: coord.r };
        if (this.gameState.getEntityAt(destination.q, destination.r)) {
            const adjacent = this.helper.getNeighbors(coord.q, coord.r)
                .filter(cell =>
                    !this.gameState.getEntityAt(cell.q, cell.r)
                    && Number.isFinite(unit.getMovementCost(cell))
                )
                .sort((a, b) => this.helper.distance(unit, a) - this.helper.distance(unit, b));
            if (adjacent.length === 0) return 0;
            destination = adjacent[0];
        }

        // G1: A* (detour mode) replaces the deleted BFS. The returned
        // path includes the source cell; slice it off for moveAlongPath.
        const res = this.helper.movementCostTo(unit.cell, destination, unit.getMovementCost.bind(unit), { allowDetours: true });
        const path = res ? res.path.slice(1) : [];
        if (path.length === 0) return 0;

        const from = { q: unit.q, r: unit.r };
        const used = this.helper.moveAlongPath(
            this.player,
            unit,
            moveAction,
            path,
            this.gameState,
            'combat',
            reason
        );
        if (used > 0) {
            involvedCells.push(from, unit.cell);
            this.helper.aiLog(
                this.player,
                'combat',
                `Move decision | ${unit.name}#${String(unit.id).slice(-4)} (${this.player.name}) from (${from.q},${from.r}) to (${unit.q},${unit.r}) | Reason: ${reason}`
            );
        }
        return used;
    }

    // ==================== Proactive growth ====================

    isEconomicTarget(meta) {
        if (!meta) return false;
        if (asNumber(meta.score?.economic) > 0) return true;
        return Object.keys(stripOrders(meta.yields)).length > 0;
    }

    isMilitaryTarget(meta) {
        if (!meta) return false;
        const militaryScore = asNumber(meta.score?.military);
        const economicScore = asNumber(meta.score?.economic);

        // A real combat unit/structure has more military than economic value,
        // or deals damage while having no economy role (towers). Token attack
        // damage on workers/settlers/economic structures must not qualify.
        if (militaryScore > economicScore && militaryScore > 0) return true;
        if (asNumber(meta.damage?.value) > 0 && economicScore === 0) return true;

        // A military production structure (e.g. barracks or temple) has
        // buildables that are themselves combat-oriented.
        if (Array.isArray(meta.buildables) && meta.buildables.length > 0
            && militaryScore > 0 && militaryScore >= economicScore * 0.5) {
            const producesCombat = meta.buildables.some(rawName => {
                const name = canonicalKey(this.manifestEntities, rawName);
                const buildable = name ? this.manifestEntities[name] : null;
                if (!buildable) return false;
                const bMil = asNumber(buildable.score?.military);
                const bEco = asNumber(buildable.score?.economic);
                return (bMil > bEco && bMil > 0)
                    || (asNumber(buildable.damage?.value) > 0 && bEco === 0);
            });
            if (producesCombat) return true;
        }

        return false;
    }

    attemptProactiveBuild(econ, options = {}) {
        const involvedCells = options.involvedCells || [];
        const category = options.category || null;
        const goal = options.goal || null;
        const own = this.getActiveEntities();

        const candidates = [];
        for (const builder of own) {
            if (!this.helper.isBuilder(builder)) continue;
            if (this.getBuildCharges(builder) <= 0) continue;
            // B15: build costs 1 AP — a builder with 0 < AP < 1 can never
            // build, but was retried up to 12× per iteration.
            if (asNumber(builder.actionPoints, 0) < 1) continue;

            for (const rawTarget of this.getBuilderBuildables(builder)) {
                const targetName = canonicalKey(this.manifestEntities, rawTarget);
                if (!targetName) continue;
                const meta = this.manifestEntities[targetName];
                if (!meta) continue;

                if (category === 'economy' && !this.isEconomicTarget(meta)) continue;
                if (category === 'military' && !this.isMilitaryTarget(meta)) continue;

                const cost = meta.spawnCost || {};
                if (!this.player.hasResources(cost)) continue;
                if (this.wouldSpendReserved(cost)) continue;
                if (!this.isBuildSustainable(meta, econ)) continue;
                if (!this.isCostSafeToSpend(cost, econ)) continue;

                const score = this.scoreBuildCandidate(builder, targetName, meta, econ, own, category);
                if (score <= 0) continue;

                candidates.push({ builder, targetName, meta, score, roi: score / this.weightedCost(cost, econ) });
            }
        }

        if (candidates.length === 0) return false;

        candidates.sort((a, b) => b.roi - a.roi);
        const attempts = candidates.slice(0, this.config.maxBuildAttempts);

        for (const candidate of attempts) {
            this.helper.aiLog(
                this.player,
                'build',
                `Proactive candidate | ${candidate.builder.name}#${String(candidate.builder.id).slice(-4)} @(${candidate.builder.q},${candidate.builder.r}) `
                + `-> ${this.helper.camelToTitle(candidate.targetName)} | ROI ${candidate.roi.toFixed(2)}`
                + (category ? ` | Category: ${category}` : '')
            );

            const used = goal
                ? this.executeBuildWithGoal(candidate.builder, candidate.targetName, goal, involvedCells)
                : this.executeBuild(
                    candidate.builder,
                    candidate.targetName,
                    'build',
                    `proactive ${category || 'balanced'} growth (ROI ${candidate.roi.toFixed(2)})`,
                    involvedCells
                );

            if (used > 0) return true;
        }

        return false;
    }

    scoreBuildCandidate(builder, targetName, meta, econ, own, category) {
        const weights = econ.weights;
        const militaryScore = asNumber(meta.score?.military);
        const economicScore = asNumber(meta.score?.economic);

        let value = militaryScore * weights.military + economicScore * weights.economic;

        let yieldValue = 0;
        let producedOnlySurplus = true;
        let producesSomething = false;
        for (const [res, amount] of Object.entries(meta.yields || {})) {
            if (res === ORDERS_RESOURCE) continue;
            const numeric = asNumber(amount);
            if (numeric <= 0) continue;
            producesSomething = true;
            const info = econ.resources[res];
            if (!info || info.status !== 'surplus') producedOnlySurplus = false;
            const deficitBoost = info && (info.status === 'critical' || info.status === 'deficit' || info.status === 'negative')
                ? 2
                : 1;
            yieldValue += numeric * statusDesirability(info?.status) * deficitBoost;
        }
        value += yieldValue * 1.35;

        // Orders are strategically valuable even though they are filtered from
        // normal resource accounting.
        value += asNumber(meta.ordersPerTurn) * 25;
        if (asNumber(meta.yields?.[ORDERS_RESOURCE]) > 0) value += 25;

        value += asNumber(meta.damage?.value) * 0.5 * weights.military;

        if (meta.movement) {
            value += (asNumber(meta.maxActionPoints) + asNumber(meta.sightRange)) * 0.3 * weights.exploration;
        }

        // Recurring maintenance burden, netted against any yield of the same resource.
        for (const [res, amount] of Object.entries(meta.maintenance || {})) {
            if (res === ORDERS_RESOURCE) continue;
            const beneficial = asNumber(meta.yields?.[res]);
            const netBurden = Math.max(0, asNumber(amount) - beneficial);
            const scarcity = econ.resources[res]?.scarcity ?? 1;
            value -= netBurden * (1 + scarcity) * 2;
        }

        // Do not keep spamming producers of a resource that is already in surplus
        // unless the entity itself contributes meaningfully to the score.
        if (producesSomething && producedOnlySurplus && militaryScore < 5 && economicScore < 5 && asNumber(meta.ordersPerTurn) <= 0) {
            value *= 0.3;
        }

        const duplicateCount = own.filter(entity => entity.name === targetName).length;
        const duplicatePenalty = producesSomething ? 0.35 : 0.6;
        value /= (1 + duplicateCount * duplicatePenalty);

        if (category === 'economy') value *= 1.6;
        if (category === 'military') value *= 1.6;

        return value;
    }

    /**
     * Build at a site that best matches a buildEconomy/buildMilitary goal's
     * direction or target coordinate. Falls back to all valid candidates when
     * the goal cannot be satisfied geometrically.
     */
    executeBuildWithGoal(builder, targetName, goal, involvedCells) {
        const actions = builder.getActions ? builder.getActions() : [];
        const expectedName = `Build ${this.helper.camelToTitle(targetName)}`;
        const buildAction = actions.find(action =>
            action.name.toLowerCase() === expectedName.toLowerCase()
            || action.name.toLowerCase() === `build ${String(targetName).toLowerCase()}`
        );
        if (!buildAction) return 0;

        const { candidates: found } = this.helper.findBuildCandidates(this.gameState, builder, targetName);
        const candidates = this.filterBuildCandidates(found || []);
        if (candidates.length === 0) return 0;

        let pool = candidates;

        if (goal?.direction) {
            const startCell = this.getStartCell();
            if (startCell) {
                const wanted = String(goal.direction).toUpperCase();
                const filtered = candidates.filter(candidate => {
                    const direction = this.helper.directionTo(startCell, candidate.cell, true).fromSource;
                    return direction === wanted;
                });
                if (filtered.length > 0) pool = filtered;
            }
        }

        const targetCoord = this.getGoalTargetCoord(goal);
        if (targetCoord) {
            pool = [...pool].sort((a, b) =>
                this.helper.distance(a.cell, targetCoord) - this.helper.distance(b.cell, targetCoord)
            );
        } else {
            pool = [...pool].sort((a, b) => a.dist - b.dist || b.yield - a.yield);
        }

        const best = pool[0];
        const moveAction = actions.find(action => action.name === 'Move');
        const start = { q: builder.q, r: builder.r };
        let ordersUsed = 0;

        if (best.stage.path.length > 0) {
            if (!moveAction || asNumber(builder.actionPoints, 0) <= 0) return 0;
            const moved = this.helper.moveAlongPath(
                this.player,
                builder,
                moveAction,
                best.stage.path,
                this.gameState,
                'build',
                `moving toward goal build site for ${this.helper.camelToTitle(targetName)} at (${best.cell.q},${best.cell.r})`
            );
            if (!moved) return 0;
            ordersUsed = 1;
            involvedCells.push(start, builder.cell);
        }

        // B14: check REMAINING orders, not orders-used-so-far. The old check
        // compared live player.orders against the local ordersUsed count, so
        // after a move (1 spent, 1 left) it read 1 <= 1 and returned without
        // building, even though an order remained.
        if (this.player.orders <= 0) return ordersUsed;
        if (this.helper.distance(builder, best.cell) !== 1) return ordersUsed;

        const check = buildAction.canDo(best.cell, null);
        if (check?.possible && buildAction.do(best.cell, null)) {
            involvedCells.push(start, best.cell);
            this.helper.aiLog(
                this.player,
                'build',
                `Goal build | ${builder.name}#${String(builder.id).slice(-4)} built ${this.helper.camelToTitle(targetName)} at (${best.cell.q},${best.cell.r}) for goal ${goal?.type || 'build'}.`
            );
            return ordersUsed + 1;
        }

        return ordersUsed;
    }

    /** Hook to drop build sites a subclass must not use. Adaptive keeps every site. */
    filterBuildCandidates(candidates) {
        return candidates;
    }

    // ==================== Exploration ====================

    shouldPrioritizeExploration(econ) {
        const cap = this.turnState.directive?.focus === 'exploration' ? 2 : 1;
        if (this.turnState.prioritizedExplorations >= cap) return false;

        const weights = econ?.weights || {};
        const explorationIsWeakest = asNumber(weights.exploration) >= asNumber(weights.economic)
            && asNumber(weights.exploration) >= asNumber(weights.military);
        if (!explorationIsWeakest) return false;

        const hasExplorer = this.getActiveEntities().some(entity =>
            !entity.isConstruct
            && this.helper.isMobile(entity)
            && asNumber(entity.actionPoints, 0) > 0
            && !this.helper.isBuilder(entity)
        );
        if (!hasExplorer) return false;

        return this.helper.getCellsArray().some(cell =>
            cell && !this.player.isExplored(cell.q, cell.r)
        );
    }

    getUnexploredDirectionStats(startCell) {
        const stats = EXPLORE_DIRECTIONS.map(direction => ({ direction, count: 0 }));
        if (!startCell) return stats;
        const byDirection = new Map(stats.map(item => [item.direction, item]));

        for (const cell of this.helper.getCellsArray()) {
            if (!cell) continue;
            if (this.player.isExplored(cell.q, cell.r)) continue;
            const direction = this.helper.directionTo(startCell, cell, false).fromSource;
            const entry = byDirection.get(direction);
            if (entry) entry.count += 1;
        }

        return stats;
    }

    normalizeExploreDirection(direction, stats) {
        if (!direction) return null;
        const upper = String(direction).toUpperCase();
        if (EXPLORE_DIRECTIONS.includes(upper)) return upper;
        if (upper === 'N') {
            const ne = stats.find(item => item.direction === 'NE')?.count || 0;
            const nw = stats.find(item => item.direction === 'NW')?.count || 0;
            return ne >= nw ? 'NE' : 'NW';
        }
        if (upper === 'S') {
            const se = stats.find(item => item.direction === 'SE')?.count || 0;
            const sw = stats.find(item => item.direction === 'SW')?.count || 0;
            return se >= sw ? 'SE' : 'SW';
        }
        return null;
    }

    pickExploreDirection(stats, exclude = null) {
        return [...stats]
            .filter(item => item.count > 0 && item.direction !== exclude)
            .sort((a, b) => {
                const scoreA = a.count / (1 + asNumber(this.turnState.usedExploreDirections[a.direction]));
                const scoreB = b.count / (1 + asNumber(this.turnState.usedExploreDirections[b.direction]));
                if (scoreA !== scoreB) return scoreB - scoreA;
                return b.count - a.count;
            })[0] || null;
    }

    attemptExploration(econ, involvedCells, options = {}) {
        const own = this.getActiveEntities();
        const summary = this.getThreatSummary();
        const damaged = own.filter(entity => this.isDamageWorthRepair(entity));
        const dedicated = own.filter(entity => this.helper.isDedicatedMilitary(entity, this.manifest));
        const militaryExplorerCap = summary.hasThreats ? 0 : Math.max(1, Math.floor(dedicated.length / 2));

        const context = { econ, options, summary, damaged, militaryExplorerCap };
        let explorers = own.filter(entity => this.isExplorerCandidate(entity, context));

        if (explorers.length === 0) return false;

        // Proxied arrays sort a copy — capture the return value (see ai-interface-spec.md).
        explorers = explorers.sort((a, b) => {
            const apA = asNumber(a.maxActionPoints, asNumber(a.actionPoints));
            const apB = asNumber(b.maxActionPoints, asNumber(b.actionPoints));
            if (apA !== apB) return apB - apA;
            const sightA = asNumber(a.sightRange);
            const sightB = asNumber(b.sightRange);
            if (sightA !== sightB) return sightB - sightA;
            return asNumber(b.damage?.value) - asNumber(a.damage?.value);
        });

        if (options.targetCoord) {
            if (this.exploreTowardCoord(options.targetCoord, explorers, involvedCells)) return true;
            if (options.goalOnly) return false;
        }

        // B8: measure direction stats from the EXPLORER's cell, not the
        // player's start coord — the old code picked a direction relative to
        // home, but the explorer moves relative to where it stands, so the
        // target hopped every turn as the unit moved.
        const startCell = explorers.length > 0
            ? { q: explorers[0].q, r: explorers[0].r }
            : this.getStartCell();
        const stats = this.getUnexploredDirectionStats(startCell);
        const hasUnexplored = stats.some(item => item.count > 0);

        if (!hasUnexplored) {
            if (!this.turnState.fullyExploredLogged) {
                this.turnState.fullyExploredLogged = true;
                this.helper.aiLog(this.player, 'explore', 'All map territory is fully explored.');
            }
            return false;
        }

        const preferred = options.preferredDirection
            ? this.normalizeExploreDirection(options.preferredDirection, stats)
            : null;

        let chosen = preferred
            ? stats.find(item => item.direction === preferred && item.count > 0)
            : this.pickExploreDirection(stats);

        for (const explorer of explorers) {
            let direction = chosen?.direction || this.pickExploreDirection(stats)?.direction;
            if (!direction) break;

            for (let attempt = 0; attempt < 3 && direction; attempt++) {
                const from = { q: explorer.q, r: explorer.r };
                const result = this.helper.explore(
                    this.gameState,
                    explorer,
                    direction,
                    false,
                    this.turnState.targetedCells
                );
                const used = ordersUsedFrom(result);
                if (used > 0) {
                    this.turnState.usedExploreDirections[direction] = asNumber(this.turnState.usedExploreDirections[direction]) + 1;
                    if (this.helper.isDedicatedMilitary(explorer, this.manifest)) {
                        this.turnState.militaryExplorers += 1;
                    }
                    involvedCells.push(from, explorer.cell);
                    this.helper.aiLog(
                        this.player,
                        'explore',
                        `Explore decision | ${explorer.name}#${String(explorer.id).slice(-4)} (${this.player.name}) `
                        + `from (${from.q},${from.r}) toward ${direction} | Orders used: ${used}`
                    );
                    return true;
                }
                direction = this.pickExploreDirection(stats, direction)?.direction || null;
            }
        }

        // Fallback: nearest unexplored cell (still respects per-turn targeted cells).
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
                this.helper.aiLog(
                    this.player,
                    'explore',
                    `Explore fallback | ${explorer.name}#${String(explorer.id).slice(-4)} moved from (${from.q},${from.r}) toward the nearest unexplored cell | Orders used: ${used}`
                );
                return true;
            }
        }

        return false;
    }

    /** May `entity` be sent exploring now? context: { econ, options, summary, damaged, militaryExplorerCap }. */
    isExplorerCandidate(entity, context) {
        const { econ, options, summary, damaged, militaryExplorerCap } = context;
        if (!this.helper.isMobile(entity)) return false;
        if (asNumber(entity.actionPoints, 0) <= 0) return false;
        if (options.excludeSupport && (this.helper.isBuilder(entity) || this.helper.isRepairer(entity))) {
            return false;
        }
        if (asNumber(entity.maxHealth) > 0
            && asNumber(entity.health) <= asNumber(entity.maxHealth) * this.config.repairHealthRatio) {
            return false;
        }
        if (this.helper.isDedicatedMilitary(entity, this.manifest)) {
            if (this.turnState.militaryExplorers >= militaryExplorerCap) return false;
        }
        if (this.helper.isBuilder(entity) && (econ.urgent.length > 0 || summary.hasThreats)) return false;
        if (this.helper.isRepairer(entity) && (damaged.length > 0 || summary.hasThreats)) return false;
        return true;
    }

    exploreTowardCoord(coord, explorers, involvedCells) {
        const targetCells = this.helper.getCellsArray().filter(cell =>
            cell
            && !this.player.isExplored(cell.q, cell.r)
            && this.helper.distance(cell, coord) <= 3
        );
        if (targetCells.length === 0) return false;

        for (const explorer of explorers) {
            const pathResult = this.helper.findPathTowardsUnexplored(
                explorer,
                this.gameState,
                this.player,
                this.turnState.targetedCells,
                targetCells
            );
            if (!pathResult?.targetCell || !pathResult.path || pathResult.path.length === 0) continue;

            const moveAction = explorer.getActions
                ? explorer.getActions().find(action => action.name === 'Move')
                : null;
            if (!moveAction) continue;

            const from = { q: explorer.q, r: explorer.r };
            const used = this.helper.moveAlongPath(
                this.player,
                explorer,
                moveAction,
                pathResult.path,
                this.gameState,
                'explore',
                `exploring toward goal target (${coord.q},${coord.r})`
            );
            if (used > 0) {
                this.turnState.targetedCells.add(`${pathResult.targetCell.q},${pathResult.targetCell.r}`);
                involvedCells.push(from, explorer.cell);
                this.helper.aiLog(
                    this.player,
                    'explore',
                    `Explore goal | ${explorer.name}#${String(explorer.id).slice(-4)} moved from (${from.q},${from.r}) toward (${coord.q},${coord.r}); `
                    + `target cell (${pathResult.targetCell.q},${pathResult.targetCell.r}) | Orders used: ${used}`
                );
                return true;
            }
        }

        return false;
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

    async handleTradeOffer(proposer, offer) {
        return {
            action: 'reject',
            message: "Our resources are reserved for our own realm's defense and development."
        };
    }
}

export default AdaptiveManager;