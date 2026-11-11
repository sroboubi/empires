import FableAi from './fableAi.js';

/**
 * ApexAI - a score-maximising tactical manager built on FableAI's utility loop.
 *
 * Fable's design is the right foundation: every action is valued in the same
 * "marginal total score" currency and the best value per order wins. Apex keeps
 * that loop but fixes the places where the baseline leaves score on the table:
 *
 * - Savings goals are real reservations. When the best producer is unaffordable,
 *   cheaper builds may no longer eat the exact resources needed for it.
 * - Military/economy structures are not rejected merely because their upkeep is
 *   negative while the empire still has a healthy runway; that rejection kept
 *   the baseline from ever building a barracks early.
 * - Build value includes the opportunity cost of the resources spent, so a
 *   cheap high-yield improvement is not drowned out by an expensive score-only
 *   structure.
 * - Sites are valued from the real path cost and receive a defensive/visibility
 *   assessment; attacks are only committed when the estimated travel is within
 *   a short chase horizon.
 * - Idle orders are spent on safe exploration instead of being discarded.
 * - Scrapping is disabled unless explicitly enabled. The engine already makes
 *   unpaid entities inactive reversibly, so permanent self-destruction is a
 *   last resort only for custom configurations.
 *
 * The only hardcoded resource is "orders" (spec hint 20). Entity capabilities
 * come from getActions(), and all values come from the manifest.
 */

const ORDERS = 'orders';

const APEX_DEFAULTS = {
    // --- Reservation / economy safety ------------------------------------
    // When a savings goal exists, do not spend the goal's resources below its
    // full price. This is deliberately strict: a half-funded producer that is
    // never completed is worse than waiting two turns.
    goalReserve: true,
    // Switch a persistent savings goal only when the alternative is this much
    // better, so the AI does not thrash between near-equal targets.
    goalSwitchRatio: 1.25,
    // A non-urgent savings goal must be at least this fraction as valuable as
    // the best build we can already afford; otherwise we keep growing instead
    // of idling while saving for a marginal structure.
    goalMinRatio: 0.8,
    // How many turns of runway a new upkeep should leave, instead of the
    // planning horizon, when deciding whether a build is sustainable. Structures
    // with a large stock behind them are allowed to run a temporary deficit.
    sustainRunway: 3,
    // Value of one resource unit in the build opportunity cost (fraction of
    // the marginal score currency). 0 keeps Fable's "stock is free" behaviour.
    buildCostWeight: 0.12,
    // Extra value for a build that yields a resource in crisis.
    crisisBuildBoost: 0.35,
    // Builds that add military score while we are short of defensive power.
    defenseBuildBias: 1.35,
    // Do not keep adding producers for a resource that is already deeply
    // stockpiled while its income is non-negative (spec hint 17).
    surplusStockMultiple: 8,
    surplusProducerPenalty: 0.25,
    // The geometric mean rewards the lowest pillar. If military score has
    // fallen behind economic score, give military-producing builds a modest
    // boost even when no enemy is currently visible.
    militaryBalanceRatio: 0.9,
    militaryBalanceBias: 2.0,
    // With recurring barbarian waves, a slightly smaller permanent military
    // investment leaves more resources for the economy that replaces losses.
    militaryBalanceBiasThreat: 1.5,
    // Symmetric correction: when military has outgrown the economy, favour
    // economic and order-producing structures instead of more units.
    economyBalanceRatio: 0.95,
    economyBalanceBias: 1.5,
    // Types that unlock an order-producing structure (e.g. a settler that
    // founds a village) are strategic expansion, not a generic builder.
    expansionBias: 1.6,
    // The target's own value is added to the builder's value, undiscounted by
    // the long payback chain: an order-producing settlement is worth more than
    // the sum of its parts suggests in the baseline builder valuation.
    expansionChildValue: 2.0,
    // At most this many expansion builders (e.g. settlers) should exist at
    // once. Building a new one before the previous has founded its settlement
    // splits scarce food/gold/gems and stalls both.
    maxExpansionBuilders: 2,
    surplusExpansionPenalty: 0.05,
    // Stop producing more finite-charge builders once the workforce is this
    // large; extra builders consume upkeep and orders without adding capacity.
    maxBuilders: 4,
    surplusBuilderPenalty: 0.0,
    // Builds that add orders (villages/temples) are worth a little more,
    // because orders compound every later action.
    orderBuildBias: 1.2,
    // Fable learns an order's value from the last marginal action, which can
    // be zero when every order was spent. A floor keeps order-producing
    // villages/temples from looking worthless and stalling expansion.
    orderValueFloor: 0.2,
    // A site is discounted by the turns needed to reach it. A stronger
    // penalty keeps workers near the existing economy instead of marching
    // across the map while upkeep accrues.
    siteTravelPenalty: 2.0,
    // Barracks-like structures are score-light alone but unlock military
    // units. When military score lags the economy, credit part of the best
    // unlocked unit's value so the enabler is not dismissed as upkeep.
    militaryChildValue: 0.6,
    militaryChildRatio: 1.2,

    // --- Exploration ------------------------------------------------------
    // Global multiplier on Fable's exploration values. Exploration is one of
    // the three geometric-mean pillars, so leaving it at the baseline weight
    // makes the total score lopsided.
    exploreWeight: 1.5,
    // A pure explorer is a high-sight, low-damage mobile unit with no build or
    // repair capability. A few are useful; a pack of them starves the economy.
    maxExplorers: 3,
    explorerSight: 6,
    explorerDamage: 30,
    surplusExplorerPenalty: 0.1,
    guardShare: 0.35,
    guardExploreFactor: 0.7,
    // When barbarians are enabled, keep a larger guard share home; the map
    // has recurring ownerless attackers that can otherwise farm the economy.
    guardShareThreat: 0.5,
    guardExploreFactorThreat: 0.3,
    builderExploreFactor: 0.45,

    // --- Combat -----------------------------------------------------------
    // Do not chase a target for more than this many turns at the current pace.
    maxChaseTurns: 1,
    // Preferred maximum orders per attack sequence. The helper stops when the
    // target is unreachable, so this is a tempo knob, not a commitment.
    combatOrders: 3,
    // A builder already walking to a site may switch to a different project
    // only when the new option is this much better. This prevents early
    // low-value projects from monopolising the only available builder.
    projectSwitchRatio: 1.5,
    // Attackers that are also needed as builders/repairers are not banned, but
    // a dedicated fighter is preferred when both can do the job.
    builderAttackerPenalty: 0.75,
    repairerAttackerPenalty: 0.9,
    // Bonus for finishing a target that is already damaged enough to die.
    finishBonus: 1.3,
    // Extra value for a site close to home while we are short of defenders.
    homeSiteBias: 0.25,
    // Penalty for a site covered by enemy attack zones.
    exposurePenalty: 0.7,

    // --- Disposal / fallback ---------------------------------------------
    enableScrapping: false,
    fallbackExplore: true,
};

const hexDist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const fmt = (x) => (Math.round(x * 100) / 100).toString();

/** Attacks that fit in `ap`: each costs ceil(scale * exhaustion * baseCost). */
function attacksWithin(ap, scale, baseCost, exhaustion = 1) {
    let n = 0;
    for (;;) {
        const cost = Math.ceil(scale * (exhaustion + n) * baseCost);
        if (!(cost > 0) || cost > ap) return n;
        ap -= cost;
        n++;
    }
}

export default class ApexAi extends FableAi {
    constructor(player, helper) {
        super(player, helper);
        const raw = player.controller?.config || {};
        for (const [key, value] of Object.entries(APEX_DEFAULTS)) {
            if (typeof value === 'number' && typeof raw[key] === 'number' && Number.isFinite(raw[key])) {
                this.cfg[key] = raw[key];
            } else if (typeof value === 'boolean' && typeof raw[key] === 'boolean') {
                this.cfg[key] = raw[key];
            } else if (raw[key] === undefined) {
                this.cfg[key] = value;
            }
        }
        this.apex = { goal: null, battles: new Map() };
        this.apexBaseGuard = {
            share: this.cfg.guardShare,
            explore: this.cfg.guardExploreFactor,
        };
        this.apexBaseMilitaryBias = this.cfg.militaryBalanceBias;
    }

    beginTurn() {
        super.beginTurn();
        this.apex.battles.clear();
        // The savings goal is persistent within a turn. It is intentionally
        // not persisted across turns: prices and opportunities change.
        this.apex.goal = null;
        const threatSetting = !!this.gameState.settings?.barbarians;
        this.cfg.guardShare = threatSetting
            ? Math.max(this.apexBaseGuard.share, this.cfg.guardShareThreat)
            : this.apexBaseGuard.share;
        this.cfg.guardExploreFactor = threatSetting
            ? Math.min(this.apexBaseGuard.explore, this.cfg.guardExploreFactorThreat)
            : this.apexBaseGuard.explore;
        this.cfg.militaryBalanceBias = threatSetting
            ? this.cfg.militaryBalanceBiasThreat
            : this.apexBaseMilitaryBias;
        if (this.cfg.orderValueFloor > 0) {
            const total = Math.max(1, this.player.score?.total || 0);
            const floor = this.cfg.orderValueFloor * total
                / Math.max(1, (this.player.ordersPerTurn || 1) * this.cfg.planningHorizon);
            this.memory.orderValue = Math.max(this.memory.orderValue, floor);
        }
    }

    log(category, message) {
        this.helper.aiLog(this.player, category, `[apex R${this.gameState.currentRound}] ${message}`);
    }

    // ------------------------------------------------------------------ turn

    async processTurn() {
        const { player, gameState, cfg } = this;
        if (!gameState?.manifestData?.entities || !(player.orders > 0)) return;
        this.beginTurn();

        let budget = Math.ceil(player.orders * cfg.maxIterationsPerOrder) + cfg.maxIterationsPerOrder;
        let marginal = 0;
        let acted = 0;
        while (player.orders > 0 && budget-- > 0) {
            const ctx = this.snapshot();
            if (ctx.mine.length === 0) {
                this.log('warn', 'No active entity left to act with.');
                break;
            }
            const options = [
                ...this.buildOptions(ctx),
                ...this.attackOptions(ctx),
                ...this.repairOptions(ctx),
                ...this.retreatOptions(ctx),
                ...this.exploreOptions(ctx),
                ...this.goalOptions(ctx),
                ...this.scrapOptions(ctx),
            ].filter(o => o.value > 0 && !this.turn.failed.has(o.key));
            if (options.length === 0) {
                if (this.tryFallback(ctx)) {
                    acted++;
                    continue;
                }
                this.log('turn', `Nothing useful left to do with ${player.orders} order(s)` +
                    (this.apex.goal ? `; saving for ${this.apex.goal.t.name}.` : '.'));
                break;
            }
            let best = options[0];
            for (const o of options) if (o.value / o.orders > best.value / best.orders) best = o;
            marginal = options.reduce((m, o) => (o === best ? m : Math.max(m, o.value / o.orders)), 0);

            // An order that would overflow at refill is converted to resources;
            // an action worth less than that conversion is not worth taking.
            const overflowing = player.orders + player.ordersPerTurn - player.maxOrders > 0;
            const floor = this.memory.orderRate * (ctx.critical ? ctx.price(ctx.critical) : ctx.meanPrice);
            if (overflowing && best.value / best.orders < floor) {
                this.log('econ', `Keeping ${player.orders} order(s): best action (${best.text}) is worth ` +
                    `${fmt(best.value / best.orders)}/order, below the ~${fmt(floor)} resource-conversion value.`);
                break;
            }

            const before = player.orders;
            const from = { q: best.unit.q, r: best.unit.r };
            const failure = best.run();
            const used = before - player.orders;
            if (used <= 0) {
                this.turn.failed.set(best.key, failure || 'no order was spent');
                this.log('detail', `Skipped: ${best.text} - ${failure || 'no order was spent'}`);
                continue;
            }
            acted++;
            this.log(best.category, `${best.text} | value ${fmt(best.value)} for ~${best.orders} order(s), used ${used}` +
                (failure ? ` | incomplete: ${failure}` : ''));
            await this.helper.onActionDone(gameState, [from, { q: best.unit.e.q, r: best.unit.e.r }], best.text);
        }

        // If anything was possible this turn, the last marginal action is a
        // better estimate of an extra order's value than "unused = worthless".
        // Villages and other order-producing entities depend on this estimate.
        if (acted > 0) {
            const floor = marginal > 0 ? marginal : this.memory.orderValue * 0.5;
            this.memory.orderValue = this.memory.orderValue > 0
                ? this.memory.orderValue * 0.5 + floor * 0.5
                : floor;
        }
        this.log('turn', `Turn end. Orders left: ${player.orders}.`);
    }

    /** Last-resort spending: explore with a capable mobile unit when nothing scores. */
    tryFallback(ctx) {
        if (!this.cfg.fallbackExplore || ctx.unexplored <= 0) return false;
        const candidates = ctx.mine
            .filter(u => u.type.mobile && u.ap > 0 && !this.memory.projects.has(u.id))
            .sort((a, b) => (b.ap * b.type.sight) - (a.ap * a.type.sight));
        for (const u of candidates) {
            const before = this.player.orders;
            const failure = this.runExplore(ctx, u, false);
            if (this.player.orders < before) return true;
            this.turn.failed.set(`explore:${u.id}`, failure || 'no exploration progress');
        }
        return false;
    }

    // ------------------------------------------------------------------ economy

    /** Value of a spawn cost in the same currency as score/yield values. */
    costValue(ctx, cost) {
        let value = 0;
        for (const [r, amount] of Object.entries(cost || {})) {
            if (r === ORDERS || !(amount > 0)) continue;
            value += amount * (ctx.price(r) || 0);
        }
        return value;
    }

    /**
     * A build is sustainable if paying its cost and its upkeep still leaves
     * `sustainRunway` turns of stock. The baseline used the full planning
     * horizon, which blocked almost every military structure in the early game.
     */
    isSustainable(ctx, t) {
        for (const [r, maintenance] of Object.entries(t.maint || {})) {
            if (r === ORDERS || !(maintenance > 0)) continue;
            const net = ctx.net(r) - maintenance + (t.yields[r] || 0);
            if (net >= 0) continue;
            const left = ctx.stock(r) - (t.cost[r] || 0);
            if (left < -net * this.cfg.sustainRunway) return false;
        }
        return true;
    }

    /** Like Fable's drainsReserve, but with the shorter safety runway. */
    drainsReserve(ctx, t) {
        for (const [r, cost] of Object.entries(t.cost || {})) {
            if (r === ORDERS || !(cost > 0)) continue;
            const x = ctx.res[r];
            if (!x || x.net >= 0 || (t.yields[r] || 0) > 0) continue;
            if (x.stock - cost < -x.net * this.cfg.sustainRunway) return true;
        }
        return false;
    }

    /** True when spending `cost` would leave less than a target's full price. */
    breaksGoal(ctx, cost, typeName = null) {
        const goal = this.apex.goal;
        if (!this.cfg.goalReserve || !goal) return false;
        if (!goal.urgent && (!goal.strategic || goal.hasAffordable)) return false;
        if (typeName && typeName === goal.t.name) return false;
        for (const [r, amount] of Object.entries(cost || {})) {
            if (r === ORDERS || !(amount > 0)) continue;
            const reserve = goal.t.cost[r] || 0;
            if (reserve <= 0) continue;
            const x = ctx.res[r];
            // A resource whose stock already covers the goal does not need a
            // hard reserve; positive income replenishes it while cheaper builds
            // continue. Otherwise this is the bottleneck being saved for.
            if (x && x.net > 0 && x.stock >= reserve) continue;
            if (ctx.stock(r) - amount < reserve) return true;
        }
        return false;
    }

    /** Choose one persistent savings goal from the unaffordable, useful builds. */
    updateSavingsGoal(ctx, all) {
        const previous = this.apex.goal;
        const usable = all.filter(o => o.value > 0 && this.isSustainable(ctx, o.t) && !this.drainsReserve(ctx, o.t));
        const strategic = (t) => (t.buildables || []).some(b => (this.types[b]?.orders || 0) > 0)
            || (t.orders > 0 && t.eco >= 10);
        const affordableBest = usable
            .filter(o => o.affordable)
            .sort((a, b) => b.value - a.value)[0] || null;
        const candidates = usable
            .filter(o => !o.affordable)
            .filter(o => {
                if (strategic(o.t)) return true;
                // Urgent resource producers may be worth saving for even when
                // a cheap non-producer is available now.
                const urgent = Object.keys(o.t.yields || {}).some(r => ctx.res[r]?.crisis);
                if (urgent) return true;
                return !affordableBest || o.value >= this.cfg.goalMinRatio * affordableBest.value;
            })
            .sort((a, b) => b.value - a.value);
        if (candidates.length === 0) {
            this.apex.goal = null;
            return;
        }
        // An expansion builder is a compounding investment; choose it over
        // other unaffordable options even if its immediate score value is low.
        const expansion = candidates.filter(o => strategic(o.t));
        let best = (expansion.length > 0 ? expansion : candidates)[0];
        let bestEta = ctx.eta(best.t.cost);
        if (!(bestEta <= ctx.H)) {
            this.apex.goal = null;
            return;
        }
        if (previous) {
            const old = candidates.find(o => o.t.name === previous.t.name);
            if (old) {
                const oldEta = ctx.eta(old.t.cost);
                const oldScore = oldEta <= ctx.H ? old.value / (1 + oldEta) : 0;
                const bestScore = best.value / (1 + bestEta);
                if (oldScore * this.cfg.goalSwitchRatio >= bestScore) {
                    best = old;
                    bestEta = oldEta;
                }
            }
        }
        this.apex.goal = { ...best, eta: bestEta, hasAffordable: !!affordableBest };
        // Only an urgent producer earns a hard reservation. A high-score
        // structure such as a temple must not freeze every cheaper build while
        // we save for it; the opportunity system can still choose it later.
        this.apex.goal.urgent = Object.keys(ctx.res).some(r => {
            const x = ctx.res[r];
            if (!(x?.crisis || x?.unsecured)) return false;
            const t = best.t;
            if (t.yields?.[r] > 0) return true;
            return (t.buildables || []).some(b => (this.types[b]?.yields?.[r] || 0) > 0);
        });
        // Expansion builders (a type that can found an order-producing
        // structure) are worth reserving for, even when no resource is in
        // crisis: orders compound every later turn. This prevents a trickle of
        // cheap workers from consuming the settler's gold/gems forever.
        this.apex.goal.strategic = (best.t.buildables || []).some(b => (this.types[b]?.orders || 0) > 0);
        if (this.turn.goalLogged !== best.t.name) {
            this.turn.goalLogged = best.t.name;
            this.log('econ', `Saving for ${best.t.name} (value ${fmt(best.value)}, affordable in ~${Math.ceil(bestEta)} turn(s))` +
                `${this.apex.goal.urgent || this.apex.goal.strategic ? '; reserving its resources from cheaper builds' : ''}.`);
        }
    }

    /** True when a resource has a large stock and is not running down. */
    isSurplus(ctx, r) {
        const x = ctx.res[r];
        if (!x || x.net < 0) return false;
        return x.stock > Math.max(1, x.norm * this.cfg.surplusStockMultiple);
    }

    buildOptions(ctx) {
        const { player, cfg, types } = this;
        const projects = this.memory.projects;
        for (const id of [...projects.keys()]) if (!ctx.mine.some(v => v.id === id)) projects.delete(id);

        const all = [];
        const isExpansionType = (t) => (t.buildables || []).some(b => (this.types[b]?.orders || 0) > 0);
        const isPureExplorer = (t) => t.mobile
            && t.sight >= cfg.explorerSight
            && t.dmg > 0 && t.dmg <= cfg.explorerDamage
            && t.buildables.length === 0
            && t.repairables.length === 0;
        const expansionBuilders = ctx.mine.filter(v => isExpansionType(v.type)).length;
        const explorers = ctx.mine.filter(v => isPureExplorer(v.type)).length;
        const activeBuilders = ctx.mine.filter(v =>
            v.type.buildables.length > 0
            && typeof v.type.charges === 'number'
            && v.charges !== 0
        ).length;
        for (const u of ctx.mine) {
            if (u.ap <= 0 || u.charges === 0) continue;
            for (const b of u.type.buildables) {
                const t = types[b];
                if (!t) continue;
                const p = ctx.parts(b);
                let value = p.net;
                // Resource opportunity cost: a build that consumes a scarce
                // resource must beat the other things that resource could buy.
                value -= cfg.buildCostWeight * this.costValue(ctx, t.cost);
                // Losing the builder on its last charge costs its own score.
                if (u.charges === 1) value -= ctx.parts(u.name).score;
                // A structure that relieves a crisis is worth more than its
                // nominal yield because the alternative is an inactive empire.
                if (Object.keys(t.yields || {}).some(r => ctx.res[r]?.crisis || ctx.res[r]?.unsecured)) {
                    value *= 1 + cfg.crisisBuildBoost;
                }
                if (t.orders > 0) value *= cfg.orderBuildBias;
                const yields = Object.entries(t.yields || {}).filter(([, amount]) => amount > 0);
                if (yields.length > 0 && yields.every(([r]) => this.isSurplus(ctx, r))) {
                    value *= cfg.surplusProducerPenalty;
                }
                if (ctx.shortfall > 0 && t.mil > 0) value *= cfg.defenseBuildBias;
                if (t.mil > 0 && ctx.M < ctx.E * cfg.militaryBalanceRatio) value *= cfg.militaryBalanceBias;
                if (t.eco > 0 && ctx.E < ctx.M * cfg.economyBalanceRatio) value *= cfg.economyBalanceBias;
                // A type that can build an order-producing structure is an
                // expansion investment even when its own score is modest.
                const expansionTargets = (t.buildables || []).filter(b2 => (types[b2]?.orders || 0) > 0);
                if (expansionTargets.length > 0) {
                    const childValue = Math.max(...expansionTargets.map(b2 => ctx.parts(b2).net));
                    value += cfg.expansionChildValue * Math.max(0, childValue);
                    value *= cfg.expansionBias;
                }
                // A military enabler (barracks-like) unlocks units that carry
                // military score. Credit part of that value when the military
                // pillar is behind, instead of judging the enabler by its own
                // upkeep alone.
                if (t.mil > 0 && ctx.M < ctx.E * cfg.militaryChildRatio) {
                    const unitTargets = (t.buildables || []).filter(b2 => (types[b2]?.dmg || 0) > 0);
                    if (unitTargets.length > 0) {
                        const childValue = Math.max(...unitTargets.map(b2 => ctx.parts(b2).net));
                        value += cfg.militaryChildValue * Math.max(0, childValue);
                    }
                }
                if (isExpansionType(t) && expansionBuilders >= cfg.maxExpansionBuilders) {
                    value *= cfg.surplusExpansionPenalty;
                }
                if (isPureExplorer(t) && explorers >= cfg.maxExplorers) {
                    value *= cfg.surplusExplorerPenalty;
                }
                // Extra finite-charge builders stop adding capacity once the
                // workforce can already cover the available build queue.
                if (typeof t.charges === 'number' && t.buildables.length > 0
                    && activeBuilders >= cfg.maxBuilders) value *= cfg.surplusBuilderPenalty;
                all.push({ u, t, p, value, affordable: player.hasResources(t.cost) });
            }
        }
        all.sort((a, b) => b.value - a.value);
        if (!this.turn.ranked) {
            this.turn.ranked = true;
            const seen = new Set();
            const top = all.filter(o => !seen.has(o.t.name) && seen.add(o.t.name)).map(o =>
                `${o.t.name} ${fmt(o.value)}${o.affordable ? '' : ' (cannot pay)'}`);
            const stock = Object.entries(ctx.res).map(([r, x]) =>
                `${r} ${Math.round(x.stock)}${x.net >= 0 ? '+' : ''}${fmt(x.net)}${x.crisis ? '!' : x.unsecured ? '?' : ''}`);
            this.log('econ', `Resources [${stock.join(', ')}]. Build values: ${top.join(', ') || 'none'}.`);
        }

        this.updateSavingsGoal(ctx, all);
        const out = [];
        let searched = 0;
        for (const o of all) {
            if (!o.affordable || !(o.value > 0) || !this.isSustainable(ctx, o.t) || this.drainsReserve(ctx, o.t)) continue;
            const project = projects.get(o.u.id);
            if (project && project.type !== o.t.name) {
                // Let a clearly better project pre-empt a builder already
                // walking somewhere else. Without this, two cheap early
                // projects can lock both workers while a forge (and all iron)
                // waits for ten turns.
                if (!(o.value > (project.value || 0) * cfg.projectSwitchRatio)) continue;
                projects.delete(o.u.id);
            }
            if (this.breaksGoal(ctx, o.t.cost, o.t.name)) continue;
            const key = `build:${o.u.id}:${o.t.name}@${o.u.q},${o.u.r}`;
            if (this.turn.failed.has(key) || (!project && searched >= cfg.siteEvalLimit)) continue;
            if (!project) searched++;
            const site = this.findSite(ctx, o, project);
            if (!site) {
                if (project) projects.delete(o.u.id);
                else this.turn.failed.set(key, 'no usable site in range');
                continue;
            }
            const why = `score ${fmt(o.p.score)}, yields ${fmt(o.p.yields)}, orders ${fmt(o.p.orders)}, ` +
                `enables ${fmt(o.p.enable)}, defence ${fmt(o.p.defense)}, scouting ${fmt(o.p.explore)}, ` +
                `upkeep -${fmt(o.p.upkeep)}, cost ${fmt(this.costValue(ctx, o.t.cost))}`;
            out.push({
                key, unit: o.u, category: 'build', value: site.value, orders: site.orders,
                text: `${this.tag(o.u)} builds ${o.t.name} at (${site.cell.q},${site.cell.r})` +
                    `${site.turns ? ` (arrives in ~${site.turns} turn(s))` : ''}: ${why}`,
                run: () => this.runBuild(o, site),
            });
        }
        return out;
    }

    /** Actual path cost for a build stage, and a site value that includes travel and defence. */
    findSite(ctx, o, project = null) {
        const { helper, gameState, cfg, types } = this;
        const { u, t, p } = o;
        const { candidates } = helper.findBuildCandidates(gameState, u.e, t.name);
        const baseYield = Object.values(t.yields).reduce((s, y) => s + y, 0);
        const disk = 3 * t.sight * (t.sight + 1) + 1;
        const anchor = this.goalAnchor(['buildEconomy', 'buildMilitary']);
        const action = this.buildAction(u, t);
        const others = [...this.memory.projects].filter(([id]) => id !== u.id).map(([, pr]) => pr);
        let best = null;
        for (const c of candidates) {
            const cell = c.cell;
            const pos = { q: cell.q, r: cell.r };
            if (project && (project.q !== pos.q || project.r !== pos.r)) continue;
            if (t.mobile) {
                const terrain = cell.terrain;
                const scale = terrain && terrain.name in t.terrainScale ? t.terrainScale[terrain.name] : 1;
                if (!Number.isFinite(scale * (terrain?.movementCost || 1))) continue;
            } else if (ctx.tooClose(pos)) {
                continue;
            }
            if (others.some(pr => {
                const d = hexDist(pr, pos);
                const sep = t.separation !== undefined && types[pr.type]?.separation !== undefined
                    ? Math.max(t.separation, types[pr.type].separation) : 1;
                return d < sep;
            })) continue;

            const path = c.stage?.path || [];
            let pathCost = 0;
            let blocked = false;
            for (const step of path) {
                const cost = u.e.getMovementCost(step);
                if (!Number.isFinite(cost)) { blocked = true; break; }
                pathCost += cost;
            }
            if (blocked) continue;
            const steps = path.length;
            if (steps > 0 ? !(u.e.getMovementCost(path[0]) <= u.ap) : !action?.canDo(cell, null).possible) continue;

            const apNeeded = pathCost + 1;
            const turns = apNeeded <= u.ap ? 0 : Math.ceil((apNeeded - u.ap) / Math.max(1, u.type.ap));
            let value = o.value;
            if (baseYield > 0) value += p.yields * (c.yield / baseYield - 1);
            if (!t.mobile && t.sight > 0) {
                const nearest = ctx.mineAll.reduce((d, v) => Math.min(d, hexDist(v, pos)), Infinity);
                const fresh = disk * clamp(nearest / (2 * t.sight), 0, 1) * cfg.sightEfficiency;
                value += (ctx.w.exp / 3) * fresh / (ctx.visible + 1);
            }
            // Building under an enemy's reach is a real loss, not a discount.
            const exposure = ctx.foes.filter(f => f.menace && hexDist(f, pos) <= f.strike).length;
            if (exposure > 0) value -= p.worth * (1 - Math.exp(-exposure * cfg.exposurePenalty));
            // Prefer sites near our existing structures when threats exist:
            // reinforcements arrive sooner and the site is easier to defend.
            if (ctx.homes.length > 0 && ctx.shortfall > 0) {
                const home = Math.min(...ctx.homes.map(h => hexDist(h, pos)));
                value *= 1 + cfg.homeSiteBias * clamp(1 - home / Math.max(1, this.buildRange), 0, 1);
            }
            if (anchor) value += Math.abs(value) * (cfg.goalBoost - 1) / (1 + hexDist(anchor, pos) / this.buildRange);
            if (!project) value /= 1 + turns * cfg.siteTravelPenalty;
            const orders = (steps > 0 ? 1 : 0) + 1;
            if (!best || value / orders > best.value / best.orders) best = { cell, pos, path, turns, value, orders };
        }
        return best && best.value > 0 ? best : null;
    }

    runBuild(o, site) {
        const result = super.runBuild(o, site);
        const project = this.memory.projects.get(o.u.id);
        if (project) project.value = o.value;
        // An engine-rejected site must not stay as a multi-turn commitment,
        // or the builder walks back to the same illegal cell every turn.
        if (typeof result === 'string'
            && /too close|occupied|cannot build|no such build|refused/i.test(result)) {
            this.memory.projects.delete(o.u.id);
        }
        return result;
    }

    // ---------------------------------------------------------------- combat

    /**
     * How many hits `u` can land this turn. Movement is charged at the real
     * terrain cost where possible, and a target outside the chase horizon is
     * not treated as an immediate fight.
     */
    estimateStrike(u, f) {
        const t = u.type;
        const d = hexDist(u, f);
        const ranged = !!t.ranged;
        const steps = ranged
            ? (d > t.maxRange ? d - t.maxRange : Math.max(0, t.minRange - d))
            : Math.max(0, d - 1);
        if (steps > 0 && !t.mobile) return null;

        let moveAp = 0;
        let baseCost = 1;
        if (!ranged) {
            // The engine charges melee attacks the movement cost into the
            // target cell, not a flat 1 AP. Using 1 overestimates attacks on
            // rough terrain and produces failed attack orders.
            const route = this.helper.movementCostTo(u.e.cell, f.e.cell,
                (c) => u.e.getMovementCost(c), { allowDetours: true });
            if (!route || !route.reached) return null;
            baseCost = Math.max(1, route.cost);
            if (steps > 0) moveAp = Math.max(0, route.cost - baseCost);
        } else if (steps > 0) {
            moveAp = steps * this.stepCost(u);
        }
        if (moveAp > u.ap + 0.001) {
            const turns = Math.ceil((moveAp - u.ap) / Math.max(1, t.ap));
            if (turns > this.cfg.maxChaseTurns) return null;
        }

        const exhaustion = u.e.state?.battleExhaustion || 1;
        if (ranged) baseCost = clamp(d, t.minRange, t.maxRange);
        const attacks = attacksWithin(u.ap - moveAp, t.scale, baseCost, exhaustion);
        let hp = f.hp;
        for (let i = 0; i < attacks && hp > 0; i++) hp -= this.hit(u, f);
        const firstCost = Math.ceil(t.scale * exhaustion * baseCost);
        const turns = attacks > 0 ? 0 : Math.ceil(Math.max(0, moveAp + firstCost - u.ap) / Math.max(1, t.ap));
        if (turns > this.cfg.maxChaseTurns) return null;
        return { steps, attacks, damage: f.hp - Math.max(0, hp), turns, orders: (steps > 0 ? 1 : 0) + attacks };
    }

    attackOptions(ctx) {
        const { helper, gameState, player, cfg } = this;
        const targets = ctx.foes.filter(f => f.rawValue > 0);
        if (targets.length === 0) return [];
        const out = [];
        for (const u of ctx.mine) {
            if (!(u.type.dmg > 0) || u.ap <= 0) continue;
            const nearest = [...targets].sort((a, b) => hexDist(a, u) - hexDist(b, u)).slice(0, cfg.targetLimit);
            for (const f of nearest) {
                const est = this.estimateStrike(u, f);
                if (!est) continue;
                // Already in reach but unable to afford a hit: moving around
                // for a better multiplier only burns the order.
                if (est.attacks <= 0 && est.steps === 0) continue;
                const cornered = !u.type.mobile || this.turn.failed.has(`retreat:${u.id}`);
                const worthIt = cornered ? f.rawValue : f.value;
                if (!(worthIt > 0)) continue;

                const d = hexDist(u, f);
                const standoff = u.type.ranged ? clamp(d, u.type.minRange, u.type.maxRange) : 1;
                const exposed = f.type.dmg > 0 && standoff <= f.type.maxRange && d > f.type.maxRange;
                const risk = exposed ? cfg.riskWeight * ctx.worth(u) * Math.min(1, this.hit(f, u) * f.type.attacks / Math.max(1, u.hp)) : 0;
                const leash = f.threat <= 0 && ctx.guards.has(u.id) ? 0 : 1;

                let value;
                let orders;
                let plan;
                if (est.attacks > 0) {
                    const killed = est.damage >= f.hp;
                    value = leash * worthIt * Math.min(1, est.damage / f.hp) - risk;
                    if (killed) value *= cfg.finishBonus;
                    orders = est.orders;
                    plan = `~${est.attacks} hit(s) for ~${Math.round(est.damage)} of ${Math.round(f.hp)} HP${killed ? ' (kill)' : ''}`;
                } else {
                    value = leash * worthIt * Math.min(1, this.hit(u, f) * Math.max(1, u.type.attacks) / f.hp) / (1 + est.turns) - risk;
                    orders = 1;
                    plan = `closing in, ~${est.turns} turn(s) from striking`;
                }
                if (u.type.buildables.length > 0) value *= cfg.builderAttackerPenalty;
                if (u.type.repairables.length > 0) value *= cfg.repairerAttackerPenalty;

                const maxOrders = Math.min(player.orders, cfg.combatOrders, Math.max(1, orders));
                const why = f.victim ? `it threatens ${this.tag(f.victim)}` : `stance ${f.stance}`;
                out.push({
                    key: `attack:${u.id}:${f.id}`, unit: u, category: 'combat', value, orders,
                    text: `${this.tag(u)} attacks ${this.tag(f)}: ${why}${f.attackedUs ? ', it attacked us' : ''}; ${plan}`,
                    run: () => {
                        const result = helper.attack(gameState, u.e, f.e, maxOrders);
                        return result.ordersUsed > 0 ? null : (result.result?.message || 'attack not possible');
                    },
                });
            }
        }
        return out;
    }

    // ------------------------------------------------------------ exploration

    exploreOptions(ctx) {
        const out = super.exploreOptions(ctx);
        for (const option of out) option.value *= this.cfg.exploreWeight;
        return out;
    }

    // ------------------------------------------------------------- directives

    /** Use every directive goal, not only goals[0]. */
    goalAnchor(goalTypes) {
        for (const goal of this.turn.goals || []) {
            if (!goal || !goalTypes.includes(goal.type)) continue;
            const where = goal.target ?? goal.direction;
            if (where && typeof where === 'object') {
                if (typeof where.q === 'number' && typeof where.r === 'number') return { q: where.q, r: where.r };
                const entity = where.entityId ? this.gameState.getEntityById(where.entityId) : null;
                if (entity) return { q: entity.q, r: entity.r };
                continue;
            }
            if (typeof where !== 'string') continue;
            const key = `anchor:${where}`;
            if (!(key in this.turn)) {
                const start = this.player.startCoord;
                let far = null;
                for (const c of this.cells) {
                    if (this.helper.directionTo(start, c, true).fromSource !== where) continue;
                    const d = hexDist(start, c);
                    if (!far || d > far.d) far = { q: c.q, r: c.r, d };
                }
                this.turn[key] = far;
            }
            if (this.turn[key]) return this.turn[key];
        }
        return null;
    }

    // ------------------------------------------------------------------ scrap

    scrapOptions(ctx) {
        return this.cfg.enableScrapping ? super.scrapOptions(ctx) : [];
    }
}
