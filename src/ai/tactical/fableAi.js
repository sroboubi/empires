import { BaseManager } from '../baseManager.js';

/**
 * FableAi - a utility-driven tactical AI (see src/ai/spec.md and addenda).
 *
 * How a turn is decided
 * ---------------------
 * While orders remain, every owned entity proposes the things its own
 * attributes and actions allow (build each of its buildables, attack, repair,
 * retreat, explore, march to a goal, self-destruct). Every proposal is valued
 * in ONE currency and the best value per order is executed; then everything
 * is re-evaluated. There are no roles and no fixed priorities: a choice that
 * is bad simply scores badly.
 *
 * The currency is "relative gain of the total score, times 3". The total is
 * the geometric mean of military (M), economic (E) and exploration (X), so
 *   d(total)/total = 1/3 * (dM/M + dE/E + dX/X)
 * and a build worth m military points is worth m/M: the lowest pillar is
 * automatically the most valuable one (spec hint 7). Everything else is
 * converted into that currency:
 *   - resources: a "typical purchase" of a resource (its mean spawn cost in
 *     the manifest) buys the manifest's mean score-per-cost; that value is
 *     scaled up for resources whose income covers fewer purchases than the
 *     others and down for resources in surplus (hints 12, 17), to the cap
 *     for a resource we spend but have no income of, and sharply beyond it
 *     for a deficit that runs dry within the horizon (hints 4, 9). Yields
 *     and upkeep use this price. A spawn cost is not subtracted (stock that
 *     is never spent is worth nothing); instead the best build we cannot pay
 *     for yet becomes a savings goal that cheaper builds may not delay
 *     (hint 21), upkeep we could not sustain is not taken on, and the stock
 *     that pays a running deficit is not spent on anything else.
 *   - builders: a builder is worth the builds it adds beyond the capacity we
 *     own, each discounted by the wait until we can pay for it, recursively
 *     (hint 10: need food -> farm -> worker -> village -> settler).
 *   - orders: an extra order per turn is worth what the last order of the
 *     previous turn would have bought; an order that would overflow is worth
 *     the resources the game converts it to (rate learned from history).
 *   - danger: an enemy is worth attacking for what it could destroy, but
 *     only in a fight we expect to win (health x damage per turn of both
 *     sides, our damage capped by our orders); otherwise mobile units step
 *     out of its reach and a doomed builder spawns its own replacement.
 *
 * Nothing here names a unit, a resource (except "orders", hint 20) or an
 * action other than the engine's own action identifiers. All numbers are the
 * tunables in DEFAULTS, overridable from definitions/ai.json.
 */

const ORDERS = 'orders'; // spec hint 20: the one resource name that may be hardcoded

/** Engine action identifiers (the same strings AiHelper looks actions up by). */
const ACTION = { move: 'Move', selfDestruct: 'Self Destruct', repair: 'Repair' };

const PEACEFUL = new Set(['friendly', 'ally']);

/** The engine scores exploration as the cube root of visible cells x explored cells. */
const EXPLORATION_ROOT = 3;

/**
 * Tunables. definitions/ai.json ("fable".config) carries the same keys and
 * overrides them; these in-code values only keep the AI playable when it is
 * started with an empty controller config. Each has a reason, none is tied to
 * a manifest value.
 */
const DEFAULTS = {
    planningHorizon: 10,      // turns of yields / upkeep / extra orders a build is credited with
    stockHorizon: 30,         // turns a stockpile is spread over when judging scarcity: income balance matters more than the bank
    buildShare: 0.5,          // share of orders expected to be spent building (rest: moving, fighting)
    enableDiscount: 0.5,      // value that still needs later orders (a builder's builds, extra orders) counts this much
    chainDepth: 3,            // how deep to follow "builder of a builder" chains (spec hint 10 example is 3 deep)
    scarcityCap: 4,           // a resource is priced at most this many times above / below the average
    crisisBoost: 4,           // extra price multiplier for a resource that runs out within the horizon
    siteEvalLimit: 4,         // build options whose sites are searched per decision (CPU bound)
    threatTurns: 2,           // an enemy is a threat if it can reach one of our entities within this many turns
    threatHorizon: 5,         // turns an unanswered threat is assumed to keep attacking
    threatWeight: 1,          // weight of "what the enemy could destroy" against our own growth
    retaliationBoost: 0.5,    // extra target value for a unit that actually attacked us (spec hint 19)
    riskWeight: 1,            // weight of the damage a unit takes when it walks into an enemy's reach
    defenseMargin: 1.5,       // combat power wanted relative to the hostile power we have seen
    threatMemory: 0.9,        // per-turn decay of the remembered hostile power
    guardShare: 0.5,          // share of our combat power that stays home instead of exploring (spec hint 18)
    guardExploreFactor: 0.2,  // exploration value multiplier for a unit that is on guard
    builderExploreFactor: 0.2,// exploration value multiplier for a unit that can still build or repair (hint 18)
    detourTurns: 2,           // a treasure at most this many turns of marching away is worth a detour
    sightEfficiency: 0.5,     // share of a sight disk that is new / not blocked when exploring or placing a construct
    repairThreshold: 0.5,     // "heavily damaged" health fraction (spec hint 16)
    foreignStructureBuffer: 3,// neutral / caution stance: hexes kept from that player's structures
    offensiveRatio: 2,        // own military score / theirs needed to self-select an offensive stance
    cautionRatio: 2,          // their military score / ours at which an aggressor is avoided instead of fought
    grudgeTurns: 5,           // turns an attack keeps an opponent out of the neutral stance (no directive only)
    rivalWeight: 0.5,         // value of an opponent's relative score loss against our own relative gain
    focusBoost: 2,            // directive focus: weight multiplier of the focused pillar
    goalBoost: 2,             // directive goals: value multiplier for actions that serve the first goal
    targetLimit: 4,           // nearest targets each unit considers (CPU bound)
    maxIterationsPerOrder: 4, // safety bound on decision loops per order
};

const hexDist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = (list) => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : 0);
const fmt = (x) => (Math.round(x * 100) / 100).toString();

/** Copies a (proxied) value into plain objects; keeps Infinity, unlike JSON. */
function plain(value) {
    if (Array.isArray(value)) {
        const out = [];
        for (let i = 0; i < value.length; i++) out.push(plain(value[i]));
        return out;
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const k of Object.keys(value)) out[k] = plain(value[k]);
        return out;
    }
    return value;
}

/** Plain array of the (still proxied) elements of a proxied array. */
function toArray(list) {
    const out = [];
    for (let i = 0; i < (list?.length || 0); i++) out.push(list[i]);
    return out;
}

/** Attacks that fit in `ap`: each one costs ceil(scale * exhaustion * baseCost), exhaustion grows by one per attack. */
function attacksWithin(ap, scale, baseCost, exhaustion = 1) {
    let n = 0;
    for (;;) {
        const cost = Math.ceil(scale * (exhaustion + n) * baseCost);
        if (!(cost > 0) || cost > ap) return n;   // each attack costs at least 1 AP, so this ends
        ap -= cost;
        n++;
    }
}

/** Everything the AI needs to know about an entity type, read from its manifest attributes. */
function describeType(name, meta) {
    const dmg = meta.damage?.value > 0 ? meta.damage.value : 0;
    const ap = meta.maxActionPoints || 0;
    const t = {
        name,
        mil: meta.score?.military || 0,
        eco: meta.score?.economic || 0,
        cost: meta.spawnCost || {},
        maint: meta.maintenance || {},
        yields: meta.yields || {},
        orders: (meta.ordersPerTurn || 0) + (meta.yields?.[ORDERS] || 0),
        buildables: meta.buildables || [],
        charges: meta.buildCharges,                 // undefined = unlimited
        repairables: (meta.repairables || []).map(n => n.toLowerCase()),
        repairPerAp: meta.repairAmountPerAp || 1,
        mobile: !!meta.movement,
        terrainScale: meta.movement?.terrainCostScale || {},
        ap,
        sight: meta.sightRange || 0,
        hp: meta.maxHealth || meta.health || 1,
        dmg,
        lifeFraction: meta.damage?.lifeFraction || 0,
        dmgType: meta.damage?.type,
        ranged: !!meta.range,
        minRange: meta.range?.minCells || 1,
        maxRange: meta.range?.maxCells || 1,
        scale: meta.attackCostScale ?? 1,
        armor: meta.armor || {},
        separation: meta.spawnConditions?.minSeparation,
    };
    t.attacks = dmg > 0 ? attacksWithin(ap, t.scale, t.ranged ? t.minRange : 1) : 0;
    return t;
}

export default class FableAi extends BaseManager {
    constructor(player, helper) {
        super(player, helper);
        const raw = player.controller?.config || {};
        this.cfg = { ...DEFAULTS };
        for (const k of Object.keys(DEFAULTS)) {
            if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) this.cfg[k] = raw[k];
        }
        // Cross-turn memory. Lost on save/load; everything in it is re-learned from the game state.
        this.memory = { aggressors: new Map(), exploreDir: new Map(), projects: new Map(), threat: 0, orderValue: 0, orderRate: 0 };
        this.types = null;
    }

    // ------------------------------------------------------------------ chat

    async generateChatReply(otherPlayer, contextPrompt = null) {
        return { content: 'My deeds will answer for me.', ended: true };
    }

    async summarizeChatAndAddNote(otherPlayer) {
        // This AI does not negotiate (diplomacy belongs to a director, see hybrid-ai-directive.md);
        // it only records that the conversation took place.
        this.player.addHistoryEntry(this.gameState.currentRound, {
            category: 'diplomacy',
            details: `Spoke with ${otherPlayer?.name || 'another leader'}; no agreement was made.`,
        });
    }

    // ------------------------------------------------------------------ turn

    async processTurn() {
        const { player, helper, gameState, cfg } = this;
        if (!gameState?.manifestData?.entities || !(player.orders > 0)) return;
        this.beginTurn();

        let budget = Math.ceil(player.orders * cfg.maxIterationsPerOrder) + cfg.maxIterationsPerOrder;
        let marginal = 0;
        while (player.orders > 0 && budget-- > 0) {
            const ctx = this.snapshot();
            if (ctx.mine.length === 0) {
                this.log('warn', 'No active entity left to act with.');
                break;
            }
            const options = [
                ...this.buildOptions(ctx), ...this.attackOptions(ctx), ...this.repairOptions(ctx),
                ...this.retreatOptions(ctx), ...this.exploreOptions(ctx), ...this.goalOptions(ctx),
                ...this.scrapOptions(ctx),
            ].filter(o => o.value > 0 && !this.turn.failed.has(o.key));
            if (options.length === 0) {
                this.log('turn', `Nothing useful left to do with ${player.orders} order(s)` +
                    (ctx.goal ? `; saving for ${ctx.goal.t.name}.` : '.'));
                break;
            }
            let best = options[0];
            for (const o of options) if (o.value / o.orders > best.value / best.orders) best = o;
            // What one more order would have bought: the best option we did not take this time.
            marginal = options.reduce((m, o) => (o === best ? m : Math.max(m, o.value / o.orders)), 0);
            // Orders that would overflow are converted into resources by the game (rate learned from our
            // history); an action worth less than that is not taken.
            const overflowing = player.orders + player.ordersPerTurn - player.maxOrders > 0;
            const floor = this.memory.orderRate * (ctx.critical ? ctx.price(ctx.critical) : ctx.meanPrice);
            if (overflowing && best.value / best.orders < floor) {
                this.log('econ', `Keeping ${player.orders} order(s): the best action left (${best.text}) is worth ${fmt(best.value / best.orders)} per order, ` +
                    `less than the ~${fmt(this.memory.orderRate)} ${ctx.critical || 'resource'} an unused order converts to (${fmt(floor)}).`);
                break;
            }

            const before = player.orders;
            const from = { q: best.unit.q, r: best.unit.r };
            const failure = best.run();
            const used = before - player.orders;
            if (used <= 0) {
                // Remember WHY, and only for this exact unit + action + target (addendum #3).
                this.turn.failed.set(best.key, failure || 'no order was spent');
                this.log('detail', `Skipped: ${best.text} - ${failure || 'no order was spent'}`);
                continue;
            }
            this.log(best.category, `${best.text} | value ${fmt(best.value)} for ~${best.orders} order(s), used ${used}` +
                (failure ? ` | incomplete: ${failure}` : ''));
            await helper.onActionDone(gameState, [from, { q: best.unit.e.q, r: best.unit.e.r }], best.text);
        }
        this.memory.orderValue = player.orders > 0 ? 0 : marginal;
        this.log('turn', `Turn end. Orders left: ${player.orders}.`);
    }

    log(category, message) {
        this.helper.aiLog(this.player, category, `[fable R${this.gameState.currentRound}] ${message}`);
    }

    /** "name#n of Owner at (q,r)" for log lines (spec hint 11). */
    tag(v) {
        const owner = v.ownerId === this.player.id ? this.player.name : (v.ownerName || 'no owner');
        return `${v.name}#${String(v.id).split('_').pop()} of ${owner} at (${v.q},${v.r})`;
    }

    /** One-off, per-turn inputs: manifest catalog, recent attackers, directive / stances / focus / goals. */
    beginTurn() {
        const { player, gameState, cfg } = this;
        if (!this.types) this.loadCatalog();
        const round = gameState.currentRound || 1;

        // Who damaged us since our last turn (spec hint 19; history is the engine's record of it).
        const attackers = new Set();
        for (const entry of toArray(player.getHistoryRange(round - 1, round))) {
            // The game converts overflowing orders into resources; learn the rate from its own record.
            if (entry.extra?.overflowOrders > 0 && entry.extra.amount > 0) this.memory.orderRate = entry.extra.amount / entry.extra.overflowOrders;
            const id = entry.category === 'damaged' ? entry.extra?.attackerId : null;
            if (!id) continue;
            attackers.add(id);
            const attacker = gameState.getEntityById(id); // null when it is no longer visible
            if (attacker?.owner) this.memory.aggressors.set(attacker.owner.id, round);
        }

        // A directive on the controller is obeyed as given; without one the AI picks its own stances.
        const controller = player.controller || {};
        const given = controller.directive || controller.config?.directive || null;
        const directive = given ? plain(given) : null;
        const stances = directive ? (directive.stance || {}) : this.chooseStances(round);
        const focus = directive?.focus || 'balanced';
        const weights = { mil: 1, eco: 1, exp: 1 };
        const focused = { economy: 'eco', military: 'mil', exploration: 'exp' }[focus];
        if (focused) weights[focused] = cfg.focusBoost;

        this.turn = {
            round, attackers, stances, focus, weights,
            explicit: !!directive,
            goals: (directive?.goals || []).filter(g => g && g.type),
            failed: new Map(),      // option key -> reason it could not be done this turn
            claimed: new Set(),     // exploration targets already taken this turn (spread, hint 18)
        };
        this.memory.threat *= cfg.threatMemory;
        const stanceText = Object.entries(stances).map(([id, s]) => `${id}:${s}`).join(', ') || 'all neutral';
        this.log('turn', `Turn start. Orders ${player.orders}/${player.maxOrders}. Score M${player.score?.military} ` +
            `E${player.score?.economic} X${player.score?.exploration}. ` +
            `${directive ? 'Directive' : 'Own choice'}: focus ${focus}, stances [${stanceText}], ` +
            `goals [${this.turn.goals.map(g => g.type).join(', ') || 'none'}].`);
    }

    /**
     * Stances chosen by the AI itself, only when no directive is set
     * (hybrid-ai-directive.md, "Internal stance/focus"). Neutral by default;
     * an opponent that attacked us recently is fought near our land, or
     * avoided if it is much stronger; an opponent we clearly out-power is
     * attacked if it hit us or is the rival that stands between us and the win.
     */
    chooseStances(round) {
        const { player, gameState, cfg } = this;
        const others = toArray(gameState.players).filter(p => p.id !== player.id);
        const myMil = player.score?.military || 0;
        const topTotal = Math.max(0, ...others.map(p => p.score?.total || 0));
        const stances = {};
        for (const p of others) {
            const theirMil = p.score?.military || 0;
            const total = p.score?.total || 0;
            const attacked = round - (this.memory.aggressors.get(p.id) ?? -Infinity) <= cfg.grudgeTurns;
            const outpowered = total > 0 && myMil >= cfg.offensiveRatio * Math.max(1, theirMil);
            if (outpowered && (attacked || total >= topTotal)) stances[p.id] = 'offensive';
            else if (attacked) stances[p.id] = theirMil >= cfg.cautionRatio * Math.max(1, myMil) ? 'caution' : 'defensive';
        }
        return stances;
    }

    stanceOf(ownerId) {
        if (ownerId === null || ownerId === undefined) return 'defensive'; // ownerless raiders (addendum #4)
        return this.turn.stances[ownerId] || 'neutral';
    }

    /** Reads the manifest once into plain type descriptions and derives the scales used for valuation. */
    loadCatalog() {
        const manifest = this.gameState.manifestData;
        const metas = plain(manifest.entities);
        this.types = {};
        for (const [name, meta] of Object.entries(metas)) this.types[name] = describeType(name, meta);
        const all = Object.values(this.types);

        // Typical purchase size of each resource: the mean amount entities cost in it.
        this.norm = {};
        const amounts = {};
        for (const t of all) {
            for (const [r, c] of Object.entries(t.cost)) if (c > 0 && r !== ORDERS) (amounts[r] ||= []).push(c);
        }
        for (const [r, list] of Object.entries(amounts)) this.norm[r] = mean(list);

        // Combat power = sqrt(damage per turn * effective health), from attributes only.
        const fighters = all.filter(t => t.dmg > 0);
        this.refHp = mean(fighters.map(t => t.hp)) || 1;
        for (const t of all) {
            const armor = Object.values(t.armor);
            const perTurn = (t.dmg + t.lifeFraction * this.refHp) * t.attacks;
            t.power = Math.sqrt(perTurn * t.hp * (armor.length ? mean(armor) : 1));
        }

        // Mean reward of each treasure kind, per pick.
        this.treasures = {};
        for (const def of plain(manifest.treasures || [])) {
            const rewards = def.rewards || [];
            this.treasures[def.name] = rewards.map(rw => ({ type: rw.type, quantity: (rw.quantity || 0) / rewards.length }));
        }

        this.cells = toArray(this.helper.getCellsArray()).map(c => ({ q: c.q, r: c.r }));
        this.buildRange = this.helper.getConfig().buildMaxDistance;
    }

    typeOf(entity) {
        return this.types[entity.name] || (this.types[entity.name] = Object.assign(describeType(entity.name, plain(entity.data)), { power: 0 }));
    }

    view(e) {
        const type = this.typeOf(e);
        return {
            e, id: e.id, name: e.name, type, q: e.q, r: e.r,
            ownerId: e.owner ? e.owner.id : null,
            ownerName: e.owner ? e.owner.name : null,
            hp: e.health, maxHp: e.maxHealth,
            ap: e.actionPoints ?? 0,
            active: e.active !== false,
            charges: e.state?.buildCharges,
            power: type.power * Math.sqrt(Math.max(0, e.health) / type.hp),
        };
    }

    /** Damage one hit of `a` does to `b` (the engine's formula without position multipliers). */
    hit(a, b) {
        return (a.type.dmg + a.type.lifeFraction * b.hp) / (b.type.armor[a.type.dmgType] || 1);
    }

    // -------------------------------------------------------------- snapshot

    /** The game as this AI sees it right now, plus the valuation functions built on it. */
    snapshot() {
        const { player, helper, gameState, cfg, types, turn } = this;
        const H = cfg.planningHorizon;
        const mineAll = toArray(player.getEntities()).filter(e => !e.destroyed).map(e => this.view(e));
        const mine = mineAll.filter(v => v.active);
        const M = mineAll.reduce((s, v) => s + v.type.mil, 0);
        const E = mineAll.reduce((s, v) => s + v.type.eco, 0);
        const explored = player.exploredCells.size;
        const visible = player.visibleCells.size;
        const unexplored = Math.max(0, this.cells.length - explored);

        // Pillar weights: directive focus and build goals multiply the natural 1/pillar weight.
        const w = { ...turn.weights };
        const firstGoal = turn.goals[0];
        if (firstGoal?.type === 'buildMilitary') w.mil *= cfg.goalBoost;
        if (firstGoal?.type === 'buildEconomy') w.eco *= cfg.goalBoost;
        if (firstGoal?.type === 'explore') w.exp *= cfg.goalBoost;
        const scoreValue = (t) => w.mil * t.mil / Math.max(1, M) + w.eco * t.eco / Math.max(1, E);

        // ---- economy: stock, income and a price per resource (spec hints 9, 12, 13, 17)
        const profile = player.getResourceProfile();
        const names = new Set([...Object.keys(this.norm), ...Object.keys(profile.stock || {}), ...Object.keys(profile.netIncome || {})]);
        names.delete(ORDERS);
        const scored = Object.values(types).filter(t => t.mil + t.eco > 0);
        const normCost = (t) => Object.entries(t.cost).reduce((s, [r, c]) => s + c / (this.norm[r] || 1), 0);
        const unitValue = mean(scored.filter(t => normCost(t) > 0).map(t => scoreValue(t) / normCost(t)));
        // An extra order is worth what the last order of the previous turn bought (nothing if orders were left over).
        const orderValue = this.memory.orderValue;
        const pending = {};   // yields of builds that builders are already walking to (hint 12: not both X and Y)
        for (const pr of this.memory.projects.values()) {
            for (const [r, y] of Object.entries(types[pr.type]?.yields || {})) pending[r] = (pending[r] || 0) + y;
        }
        const res = {};
        for (const r of names) {
            const stock = profile.stock?.[r] || 0;
            const net = (profile.netIncome?.[r] || 0) + (pending[r] || 0);
            const norm = this.norm[r] || Math.max(1, stock);
            const runway = net < 0 ? stock / -net : Infinity;
            // Typical builds per turn this resource can pay for: income, plus the stockpile spread thinly.
            res[r] = { name: r, stock, net, norm, runway, cover: (Math.max(0, net) + stock / cfg.stockHorizon) / norm };
        }
        const meanCover = mean(Object.values(res).map(x => x.cover));
        // Builds per turn the orders allow; if resources cover far more than that, they stop mattering.
        const demand = (player.ordersPerTurn || 1) * cfg.buildShare;
        const level = demand / (demand + meanCover);
        for (const x of Object.values(res)) {
            x.scarcity = clamp(meanCover / Math.max(x.cover, Number.EPSILON), 1 / cfg.scarcityCap, cfg.scarcityCap);
            // A resource we spend but have no income of runs out sooner or later: securing an income
            // comes first (hints 4, 9); one that runs dry within the horizon is a crisis.
            x.unsecured = x.net <= 0 && this.norm[x.name] > 0;
            x.crisis = x.runway < H;
            if (x.unsecured) x.scarcity = cfg.scarcityCap;
            if (x.crisis) x.scarcity = cfg.scarcityCap * (1 + cfg.crisisBoost * (1 - x.runway / H));
            x.price = unitValue * level * x.scarcity / x.norm;
        }
        const price = (r) => res[r]?.price || 0;
        /** Turns until `need` (resource -> amount) can be paid from stock plus income; Infinity if never. */
        const eta = (need) => {
            let turns = 0;
            for (const [r, c] of Object.entries(need)) {
                const stock = res[r]?.stock || 0;
                if (c <= stock) continue;
                const net = res[r]?.net || 0;
                if (net <= 0) return Infinity;
                turns = Math.max(turns, (c - stock) / net);
            }
            return turns;
        };
        // ---- builder capacity already owned: uses available per buildable
        const capacity = new Map();
        for (const v of mine) {
            const uses = Math.min(v.charges ?? H, H);
            for (const b of v.type.buildables) capacity.set(b, (capacity.get(b) || 0) + uses);
        }
        /**
         * True if `t` helps with a resource we have no income of or are running out of: it yields one, or it
         * can build - which nothing we own can - something that does (spec hint 10: work down the chain).
         */
        const relieves = (t, depth = 0) => Object.keys(t.yields).some(y => res[y]?.crisis || res[y]?.unsecured) ||
            (depth < cfg.chainDepth && t.buildables.some(b => types[b] && !(capacity.get(b) > 0) && relieves(types[b], depth + 1)));
        /** True if the upkeep of one more `t` would empty a resource within the planning horizon (spec hint 9). */
        const unsustainable = (t) => !relieves(t) && Object.entries(t.maint).some(([r, m]) => {
            const net = (res[r]?.net || 0) - m + (t.yields[r] || 0);
            return net < 0 && (res[r]?.stock || 0) - (t.cost[r] || 0) < -net * H;
        });
        /**
         * True if paying for `t` would cut into the reserve that pays the horizon's upkeep of a resource we
         * are losing every turn (spec hints 4, 9) - unless `t` is itself part of the remedy.
         */
        const drainsReserve = (t) => !relieves(t) &&
            Object.entries(t.cost).some(([r, c]) => {
                const x = res[r];
                return x && c > 0 && x.net < 0 && !(t.yields[r] > 0) && x.stock - c < -x.net * H;
            });

        // ---- foreign entities, by stance (spec hint 19: via getOpponents)
        const foes = [];
        const opponents = player.getOpponents() || {};
        for (const k of Object.keys(opponents)) {
            for (const e of toArray(opponents[k].entities)) {
                if (!e || e.destroyed || !(e.health > 0)) continue;
                const f = this.view(e);
                f.stance = this.stanceOf(f.ownerId);
                f.attackedUs = turn.attackers.has(f.id);
                const move = f.type.mobile ? f.type.ap : 0;
                f.reach = move * cfg.threatTurns + f.type.maxRange;   // detection: near our stuff?
                f.strike = move + f.type.maxRange;                    // can it hit this cell next turn?
                // Units we must expect to be attacked by: those of a neutral / friendly / ally player only
                // once they have attacked us (mistakes.md #13: proximity is not hostility).
                f.menace = f.type.dmg > 0 && (f.attackedUs || (!PEACEFUL.has(f.stance) && f.stance !== 'neutral'));
                foes.push(f);
            }
        }
        const allies = foes.filter(f => f.stance === 'ally');
        const assets = [...mineAll, ...allies];
        for (const f of foes) f.near = f.menace && assets.some(a => hexDist(a, f) <= f.reach);

        // ---- defence need: hostile power we have seen (remembered, decaying) against our own.
        // What it protects is everything of ours that cannot run away.
        const fighters = mine.filter(v => v.type.dmg > 0 && v.type.mobile);
        const ownPower = fighters.reduce((s, v) => s + v.power, 0);
        const seen = foes.filter(f => f.menace).reduce((s, f) => s + f.power, 0);
        this.memory.threat = Math.max(this.memory.threat, seen);
        const wanted = this.memory.threat * cfg.defenseMargin;
        const shortfall = wanted > 0 ? clamp(1 - ownPower / wanted, 0, 1) : 0;
        const atRisk = mineAll.filter(v => !v.type.mobile).reduce((s, v) => s + scoreValue(v.type), 0);

        const mobileCount = mine.filter(v => v.type.mobile).length;

        // ---- value of an entity type (see the file header)
        const memo = new Map();
        const parts = (name, depth = 0, chain = []) => {
            if (depth === 0 && memo.has(name)) return memo.get(name);
            const t = types[name];
            const p = { score: scoreValue(t), yields: 0, orders: 0, upkeep: 0, defense: 0, explore: 0, enable: 0 };
            for (const [r, y] of Object.entries(t.yields)) p.yields += y * price(r) * H;
            p.orders = t.orders * H * orderValue;
            for (const [r, m] of Object.entries(t.maint)) p.upkeep += m * price(r) * H;
            if (t.dmg > 0 && t.mobile && shortfall > 0) p.defense = cfg.threatWeight * atRisk * Math.min(1, t.power / wanted);
            if (t.mobile && unexplored > 0) {
                const perOrder = Math.min(t.ap, t.sight) * (2 * t.sight + 1) * cfg.sightEfficiency;
                p.explore = cfg.enableDiscount * (w.exp / EXPLORATION_ROOT) * Math.min(unexplored, perOrder * H) / (explored + 1) / (1 + mobileCount);
            }
            if (t.buildables.length && depth < cfg.chainDepth) {
                // A builder is worth the builds it adds beyond the capacity we already own, each
                // discounted by how long we would wait to pay for it (after paying for the builder).
                const uses = Math.min(t.charges ?? H, H);
                let best = 0;
                for (const b of t.buildables) {
                    const tb = types[b];
                    if (!tb || b === name || chain.includes(b) || unsustainable(tb)) continue;
                    const v = parts(b, depth + 1, [...chain, name]).net;
                    if (v <= 0) continue;
                    const owned = capacity.get(b) || 0;
                    let total = 0;
                    for (let k = 1; k <= uses; k++) {
                        const need = { ...t.cost };
                        for (const [r, c] of Object.entries(tb.cost)) need[r] = (need[r] || 0) + (owned + k) * c;
                        const wait = eta(need);
                        if (wait > H) break;
                        total += v / (1 + wait);
                    }
                    best = Math.max(best, total);
                }
                p.enable = cfg.enableDiscount * best;
            }
            p.worth = p.score + p.yields + p.orders + p.enable;
            p.net = p.worth + p.defense + p.explore - p.upkeep;
            if (depth === 0) memo.set(name, p);
            return p;
        };
        /** What losing this entity would cost us. */
        const worth = (v) => {
            const p = parts(v.name);
            const left = v.type.charges ? (v.charges ?? 0) / v.type.charges : 1;
            return p.score + p.yields + p.orders + p.enable * left;
        };

        // ---- target value of each foreign entity (detection above, response here: addendum #6)
        const rivalTop = Math.max(1, ...toArray(gameState.players).filter(p => p.id !== player.id).map(p => p.score?.total || 0));
        for (const f of foes) {
            f.threat = 0;
            f.victim = null;
            if (f.near) {
                for (const a of assets) {
                    if (hexDist(a, f) > f.reach) continue;
                    const loss = worth(a) * Math.min(1, cfg.threatHorizon * this.hit(f, a) * f.type.attacks / Math.max(1, a.hp));
                    if (loss > f.threat) { f.threat = loss; f.victim = a; }
                }
            }
            let value = 0;
            if (f.stance === 'offensive') {
                const score = f.e.owner?.score || {};
                const loss = f.type.mil / Math.max(1, score.military || 0) + f.type.eco / Math.max(1, score.economic || 0);
                value = cfg.threatWeight * f.threat + cfg.rivalWeight * loss * (score.total || 0) / rivalTop;
            } else if (f.stance === 'defensive') {
                value = cfg.threatWeight * f.threat;
            } else if (f.attackedUs) {
                value = cfg.threatWeight * f.threat;   // any other stance: self-defence only, never initiated
            }
            if (f.attackedUs) value *= 1 + cfg.retaliationBoost;
            // Would we win the fight around this target? Compare how long its group (every menace that can
            // join it next turn) survives our fighters within reach with how long they survive the group.
            // Every attack costs an order, so our damage per turn is capped by the orders we get.
            f.rawValue = value;
            f.odds = Infinity;
            if (value > 0 && f.type.dmg > 0) {
                const group = foes.filter(g => g.menace && hexDist(g, f) <= g.strike);
                if (!group.includes(f)) group.push(f);
                const ours = mine.filter(u => u.type.dmg > 0 &&
                    hexDist(u, f) <= (u.type.mobile ? u.type.ap * cfg.threatTurns : 0) + u.type.maxRange);
                const hits = ours.flatMap(u => Array(Math.max(1, Math.floor(u.type.attacks))).fill(this.hit(u, f)))
                    .sort((a, b) => b - a).slice(0, Math.max(1, player.ordersPerTurn || 1));
                const ourDpt = hits.reduce((s, h) => s + h, 0);
                const ourHp = ours.reduce((s, u) => s + u.hp, 0);
                const theirHp = group.reduce((s, g) => s + g.hp, 0);
                const theirDpt = group.reduce((s, g) => s + mean(ours.map(u => this.hit(g, u))) * g.type.attacks, 0);
                f.odds = theirDpt > 0 ? (ourHp / theirDpt) / (theirHp / Math.max(ourDpt, Number.EPSILON)) : Infinity;
            }
            f.value = f.odds >= 1 ? value : 0;   // a fight we would lose only feeds them
        }

        // ---- guards: the strongest units, which must not wander off (spec hint 18)
        const homes = mineAll.filter(v => !v.type.mobile);
        const homeDist = (v) => (homes.length ? Math.min(...homes.map(h => hexDist(h, v))) : 0);
        const guards = new Set();
        let held = 0;
        const guardNeed = Math.max(wanted, cfg.guardShare * ownPower);
        for (const v of [...fighters].sort((a, b) => b.power - a.power || homeDist(a) - homeDist(b))) {
            if (held >= guardNeed) break;
            guards.add(v.id);
            held += v.power;
        }

        // ---- structures whose owner's stance tells us to keep our distance
        const keepOff = foes.filter(f => !f.type.mobile && ['neutral', 'caution', 'defensive'].includes(f.stance) && f.ownerId !== null);
        const tooClose = (c) => keepOff.some(f => hexDist(f, c) <= cfg.foreignStructureBuffer);

        return {
            H, mine, mineAll, M, E, explored, visible, unexplored, w, res, price, parts, worth, eta, unsustainable, drainsReserve,
            critical: profile.criticalResource, meanPrice: mean(Object.values(res).map(x => x.price)),
            foes, assets, guards, homes, homeDist, tooClose, shortfall, fighters, goal: null,
            stock: (r) => res[r]?.stock || 0,
            net: (r) => res[r]?.net || 0,
        };
    }

    // ----------------------------------------------------------------- build

    /**
     * Every "builder builds one of its buildables" option, valued by type, then by site.
     * Also picks the savings goal: the best option we cannot pay for yet. Cheaper
     * options may not delay it unless they are a better use of the contested
     * resource (spec hint 21, generalised from deficits to any goal).
     * A builder that set off for a distant site stays committed to that project
     * while it remains valid, so it does not wander between sites.
     */
    buildOptions(ctx) {
        const { player, cfg, types } = this;
        const projects = this.memory.projects;
        for (const id of [...projects.keys()]) if (!ctx.mine.some(v => v.id === id)) projects.delete(id);
        const all = [];
        for (const u of ctx.mine) {
            for (const b of u.type.buildables) {
                const t = types[b];
                if (!t) continue;
                const p = ctx.parts(b);
                // The builder disappears with its last charge: its own score is lost.
                let value = p.net - (u.charges === 1 ? ctx.parts(u.name).score : 0);
                // A builder that cannot move and is about to be lost to a fight we cannot win is worth
                // replacing in advance: a mobile unit that can build its kind again carries that value away.
                if (!u.type.mobile && t.mobile && t.buildables.includes(u.name) && !ctx.mine.some(v => v.name === b) &&
                    ctx.foes.some(f => f.menace && f.odds < 1 && hexDist(f, u) <= f.reach)) value += ctx.worth(u);
                all.push({ u, t, p, value, affordable: player.hasResources(t.cost) });
            }
        }
        all.sort((a, b) => b.value - a.value);
        if (!this.turn.ranked) {
            this.turn.ranked = true;
            const seen = new Set();
            const top = all.filter(o => !seen.has(o.t.name) && seen.add(o.t.name)).map(o =>
                `${o.t.name} ${fmt(o.value)}${o.affordable ? '' : ' (cannot pay)'}${ctx.unsustainable(o.t) ? ' (upkeep unsustainable)' : ''}${ctx.drainsReserve(o.t) ? ' (would drain an upkeep reserve)' : ''}`);
            const stock = Object.entries(ctx.res).map(([r, x]) => `${r} ${Math.round(x.stock)}${x.net >= 0 ? '+' : ''}${fmt(x.net)}${x.crisis ? '!' : x.unsecured ? '?' : ''}`);
            this.log('econ', `Resources [${stock.join(', ')}]. Build values: ${top.join(', ') || 'none'}.`);
        }

        for (const o of all) {
            if (o.affordable || o.value <= 0 || ctx.unsustainable(o.t)) continue;
            const eta = ctx.eta(o.t.cost);
            if (eta <= ctx.H && (!ctx.goal || o.value / (1 + eta) > ctx.goal.value / (1 + ctx.goal.eta))) ctx.goal = { ...o, eta };
        }
        if (ctx.goal && this.turn.goalLogged !== ctx.goal.t.name) {
            this.turn.goalLogged = ctx.goal.t.name;
            this.log('econ', `Saving for ${ctx.goal.t.name} (value ${fmt(ctx.goal.value)}, affordable in ~${Math.ceil(ctx.goal.eta)} turn(s)); ` +
                `cheaper builds may not delay it unless they use the contested resource better.`);
        }

        const usable = (o) => o.affordable && o.value > 0 && !this.delaysGoal(ctx, o) && !ctx.unsustainable(o.t) && !ctx.drainsReserve(o.t);
        const out = [];
        let searched = 0;
        for (const o of all) {
            if (o.u.ap <= 0) continue;
            const project = projects.get(o.u.id);
            if (project && project.type !== o.t.name) continue;      // on its way to build something else
            const key = `build:${o.u.id}:${o.t.name}@${o.u.q},${o.u.r}`;
            if (!usable(o)) {
                if (project) projects.delete(o.u.id);                // no longer valid: plan afresh next decision
                continue;
            }
            if (this.turn.failed.has(key) || (!project && searched >= cfg.siteEvalLimit)) continue;
            if (!project) searched++;
            const site = this.findSite(ctx, o, project);
            if (!site) {
                if (project) projects.delete(o.u.id);
                else this.turn.failed.set(key, 'no usable site in range');
                continue;
            }
            const why = `score ${fmt(o.p.score)}, yields ${fmt(o.p.yields)}, orders ${fmt(o.p.orders)}, enables ${fmt(o.p.enable)}, ` +
                `defence ${fmt(o.p.defense)}, scouting ${fmt(o.p.explore)}, upkeep -${fmt(o.p.upkeep)}`;
            out.push({
                key, unit: o.u, category: 'build', value: site.value, orders: site.orders,
                text: `${this.tag(o.u)} builds ${o.t.name} at (${site.cell.q},${site.cell.r})` +
                    `${site.turns ? ` (arrives in ~${site.turns} turn(s))` : ''}: ${why}`,
                run: () => this.runBuild(o, site),
            });
        }
        return out;
    }

    /** True if paying for `o` now would postpone the savings goal and `o` is the poorer use of that resource. */
    delaysGoal(ctx, o) {
        const goal = ctx.goal;
        if (!goal || (goal.u === o.u && goal.t === o.t)) return false;
        for (const [r, c] of Object.entries(o.t.cost)) {
            const need = goal.t.cost[r] || 0;
            if (!need || !c) continue;
            const atGoalTime = ctx.stock(r) - c + Math.max(0, ctx.net(r)) * goal.eta;
            if (atGoalTime < need && o.value / c < goal.value / need) return true;
        }
        return false;
    }

    /**
     * Best site for option `o` among the helper's legal candidates
     * (only the committed project's cell when there is one).
     */
    findSite(ctx, o, project = null) {
        const { helper, gameState, cfg, types } = this;
        const { u, t, p } = o;
        const { candidates } = helper.findBuildCandidates(gameState, u.e, t.name);
        const baseYield = Object.values(t.yields).reduce((s, y) => s + y, 0);
        const stepCost = u.type.mobile ? this.stepCost(u) : 1;
        const disk = 3 * t.sight * (t.sight + 1) + 1;
        const anchor = this.goalAnchor(['buildEconomy', 'buildMilitary']);
        const action = this.buildAction(u, t);
        const others = [...this.memory.projects].filter(([id]) => id !== u.id).map(([, pr]) => pr);
        let best = null;
        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];
            const cell = c.cell;
            const pos = { q: cell.q, r: cell.r };
            if (project && (project.q !== pos.q || project.r !== pos.r)) continue;
            if (t.mobile) {
                // A unit placed on terrain it cannot stand on would be stranded.
                const terrain = cell.terrain;
                const scale = terrain && terrain.name in t.terrainScale ? t.terrainScale[terrain.name] : 1;
                if (!Number.isFinite(scale * (terrain?.movementCost || 1))) continue;
            } else if (ctx.tooClose(pos)) {
                continue; // stance: do not build near that player's structures
            }
            // Leave room for what other builders are already walking to (same separation rule as the engine).
            if (others.some(pr => {
                const d = hexDist(pr, pos);
                const sep = t.separation !== undefined && types[pr.type]?.separation !== undefined ? Math.max(t.separation, types[pr.type].separation) : 1;
                return d < sep;
            })) continue;
            const path = c.stage.path;
            const steps = path.length;
            // Capability checks: enough AP for the first step, or for the build itself when already in place.
            if (steps > 0 ? !(u.e.getMovementCost(path[0]) <= u.ap) : !action?.canDo(cell, null).possible) continue;
            const apNeeded = steps * stepCost + 1;
            const turns = apNeeded <= u.ap ? 0 : Math.ceil((apNeeded - u.ap) / Math.max(1, u.type.ap));
            let value = o.value;
            if (baseYield > 0) value += p.yields * (c.yield / baseYield - 1);   // natural-resource bonus of this cell
            if (!t.mobile && t.sight > 0) {
                // New visible cells: the part of its sight disk not already covered by our nearest entity.
                const nearest = ctx.mineAll.reduce((d, v) => Math.min(d, hexDist(v, pos)), Infinity);
                const fresh = disk * clamp(nearest / (2 * t.sight), 0, 1) * cfg.sightEfficiency;
                value += (ctx.w.exp / EXPLORATION_ROOT) * fresh / (ctx.visible + 1);
            }
            if (ctx.foes.some(f => f.menace && hexDist(f, pos) <= f.strike)) value -= p.worth; // would be built under attack
            if (anchor) value += Math.abs(value) * (cfg.goalBoost - 1) / (1 + hexDist(anchor, pos) / this.buildRange);
            if (!project) value /= 1 + turns;      // a committed builder's travel is already paid for
            const orders = (steps > 0 ? 1 : 0) + 1;
            if (!best || value / orders > best.value / best.orders) best = { cell, pos, path, turns, value, orders };
        }
        return best && best.value > 0 ? best : null;
    }

    stepCost(u) {
        const cost = u.e.getMovementCost(u.e.cell);
        return Number.isFinite(cost) && cost > 0 ? cost : 1;
    }

    moveAction(u) {
        return u.e.getActions().find(a => a.name === ACTION.move);
    }

    buildAction(u, t) {
        const wanted = `build ${this.helper.camelToTitle(t.name)}`.toLowerCase();
        return u.e.getActions().find(a => a.name.toLowerCase() === wanted);
    }

    /** Walks `u` toward `target` along the cheapest explored path, as far as its AP allows (one order). */
    march(u, target, category, reason) {
        const { helper, gameState, player } = this;
        const route = helper.movementCostTo(u.e.cell, target, (c) => u.e.getMovementCost(c), { allowDetours: true });
        const path = route ? toArray(route.path).slice(1) : [];
        if (path.length === 0) return 'no path toward the target';
        return helper.moveAlongPath(player, u.e, this.moveAction(u), path, gameState, category, reason) ? null : 'could not move along the path';
    }

    runBuild(o, site) {
        const { helper, gameState, player } = this;
        const { u, t } = o;
        const projects = this.memory.projects;
        if (site.path.length > 0) {
            const moved = helper.moveAlongPath(player, u.e, this.moveAction(u), site.path, gameState, 'build',
                `heading to build ${t.name} at (${site.pos.q},${site.pos.r})`);
            if (!moved) {
                projects.delete(u.id);
                return 'could not move toward the site (path blocked or not enough AP)';
            }
        }
        projects.set(u.id, { type: t.name, q: site.pos.q, r: site.pos.r });   // stays until built or invalid
        if (helper.distance(u.e, site.cell) !== 1) return null;                // still travelling
        if (!(player.orders > 0)) return 'out of orders before the build';
        const action = this.buildAction(u, t);
        const check = action ? action.canDo(site.cell, null) : { possible: false, reason: 'no such build action' };
        if (!check.possible) return check.reason;
        projects.delete(u.id);
        return action.do(site.cell, null) ? null : 'build action refused';
    }


    // ---------------------------------------------------------------- combat

    /**
     * What `u` could do to `f` this turn: moves needed, attacks that fit in its AP, damage.
     * Used to VALUE the engagement only; legality stays with helper.attack (addendum #2).
     */
    estimateStrike(u, f) {
        const t = u.type;
        const d = hexDist(u, f);
        const steps = t.ranged ? (d > t.maxRange ? d - t.maxRange : Math.max(0, t.minRange - d)) : Math.max(0, d - 1);
        if (steps > 0 && !t.mobile) return null;
        const exhaustion = u.e.state?.battleExhaustion || 1;
        let baseCost = clamp(d, t.minRange, t.maxRange);
        if (!t.ranged) {
            const enter = u.e.getMovementCost(f.e.cell);
            baseCost = Number.isFinite(enter) ? enter : 1;
        }
        const moveAp = steps > 0 ? steps * this.stepCost(u) : 0;
        const attacks = attacksWithin(u.ap - moveAp, t.scale, baseCost, exhaustion);
        let hp = f.hp;
        for (let i = 0; i < attacks && hp > 0; i++) hp -= (t.dmg + t.lifeFraction * hp) / (f.type.armor[t.dmgType] || 1);
        const firstCost = Math.ceil(t.scale * exhaustion * baseCost);
        const turns = attacks > 0 ? 0 : Math.ceil(Math.max(1, moveAp + firstCost - u.ap) / Math.max(1, t.ap));
        return { steps, attacks, damage: f.hp - Math.max(0, hp), turns, orders: (steps > 0 ? 1 : 0) + attacks };
    }

    /** Attack (or close in on) hostile entities; the best units for a target score highest (spec hint 15). */
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
                // A fight we expect to lose is only taken by units that cannot get away from it.
                const cornered = !u.type.mobile || this.turn.failed.has(`retreat:${u.id}`);
                const worthIt = cornered ? f.rawValue : f.value;
                if (!(worthIt > 0)) continue;
                // Stepping into an enemy's attack range costs what it can do to us; being there already is sunk.
                const d = hexDist(u, f);
                const standoff = u.type.ranged ? clamp(d, u.type.minRange, u.type.maxRange) : 1;
                const exposed = f.type.dmg > 0 && standoff <= f.type.maxRange && d > f.type.maxRange;
                const risk = exposed ? cfg.riskWeight * ctx.worth(u) * Math.min(1, this.hit(f, u) * f.type.attacks / Math.max(1, u.hp)) : 0;
                // A guard does not leave home to chase a target that threatens nothing.
                const leash = f.threat <= 0 && ctx.guards.has(u.id) ? 0 : 1;
                let value, orders, plan;
                if (est.attacks > 0) {
                    value = leash * worthIt * Math.min(1, est.damage / f.hp) - risk;
                    orders = est.orders;
                    plan = `~${est.attacks} hit(s) for ~${Math.round(est.damage)} of ${Math.round(f.hp)} HP`;
                } else {
                    // Cannot strike yet: closing in is worth less the longer it takes, so nearer units go first.
                    value = leash * worthIt * Math.min(1, this.hit(u, f) * Math.max(1, u.type.attacks) / f.hp) / (1 + est.turns) - risk;
                    orders = 1;
                    plan = `closing in, ~${est.turns} turn(s) from striking`;
                }
                const why = f.victim ? `it threatens ${this.tag(f.victim)}` : `stance ${f.stance}`;
                out.push({
                    key: `attack:${u.id}:${f.id}`, unit: u, category: 'combat', value, orders,
                    text: `${this.tag(u)} attacks ${this.tag(f)}: ${why}${f.attackedUs ? ', it attacked us' : ''}; ${plan}`,
                    run: () => {
                        const result = helper.attack(gameState, u.e, f.e, Math.max(1, Math.min(player.orders, orders)));
                        return result.ordersUsed > 0 ? null : (result.result?.message || 'attack not possible');
                    },
                });
            }
        }
        return out;
    }

    /** Repair what is heavily damaged or has stopped yielding because of damage (spec hint 16). */
    repairOptions(ctx) {
        const { helper, gameState, cfg } = this;
        const out = [];
        for (const u of ctx.mine) {
            if (!u.type.repairables.length || u.ap <= 0) continue;
            for (const a of ctx.mineAll) {
                if (a.id === u.id || a.hp >= a.maxHp || !u.type.repairables.includes(a.name.toLowerCase())) continue;
                const heavy = a.hp < cfg.repairThreshold * a.maxHp;
                const idle = Object.keys(a.type.yields).length > 0 && a.active && !a.e.canYield();
                if (!heavy && !idle) continue;
                const d = hexDist(u, a);
                const moveAp = d > 1 ? (d - 1) * this.stepCost(u) : 0;
                if (moveAp > 0 && !u.type.mobile) continue;
                const turns = moveAp < u.ap ? 0 : Math.ceil((moveAp - u.ap + 1) / Math.max(1, u.type.ap));
                const missing = a.maxHp - a.hp;
                const heal = Math.min(missing, u.type.repairPerAp * Math.max(1, u.ap - moveAp));
                const p = ctx.parts(a.name);
                const value = ((heavy ? ctx.worth(a) * heal / a.maxHp : 0) + (idle ? p.yields * heal / missing : 0)) / (1 + turns);
                out.push({
                    key: `repair:${u.id}:${a.id}`, unit: u, category: 'build', value, orders: d > 1 ? 2 : 1,
                    text: `${this.tag(u)} repairs ${this.tag(a)} (${Math.round(a.hp)}/${a.maxHp} HP${idle ? ', not yielding' : ''}${heavy ? ', heavily damaged' : ''})`,
                    run: () => {
                        const result = helper.support(gameState, u.e, a.e, ACTION.repair, 2);
                        return result.ordersUsed > 0 ? null : (result.result?.message || 'repair not possible');
                    },
                });
            }
        }
        return out;
    }

    /**
     * Step out of the reach of units that would hurt us more than we can hurt them
     * (always, for a player we are cautious toward: "retreat if approached").
     */
    retreatOptions(ctx) {
        const out = [];
        for (const u of ctx.mine) {
            if (!u.type.mobile || u.ap <= 0) continue;
            const threats = ctx.foes.filter(f => f.menace && hexDist(f, u) <= f.strike);
            if (threats.length === 0) continue;
            const danger = Math.min(1, threats.reduce((s, f) => s + this.hit(f, u) * f.type.attacks, 0) / Math.max(1, u.hp));
            const typical = mean(threats.map(f => f.power));
            const avoid = threats.some(f => f.stance === 'caution');
            // 1 when we avoid them or expect to lose the fight around them; in a fight we expect to win,
            // 0 for a unit that is a match for one of them, up to 1 for a unit that cannot fight back at all.
            const losing = threats.some(f => f.odds < 1);
            const outmatched = avoid || losing ? 1 : clamp(1 - 2 * u.power / (u.power + typical || 1), 0, 1);
            out.push({
                key: `retreat:${u.id}`, unit: u, category: 'combat', value: ctx.worth(u) * danger * outmatched, orders: 1,
                text: `${this.tag(u)} retreats from ${threats.map(f => this.tag(f)).join(', ')}: ` +
                    `expected to lose ${Math.round(danger * 100)}% health per turn there`,
                run: () => this.runRetreat(ctx, u, threats),
            });
        }
        return out;
    }

    runRetreat(ctx, u, threats) {
        const move = this.moveAction(u);
        const radius = Math.floor(u.ap / this.stepCost(u));
        const spots = [];
        for (let dq = -radius; dq <= radius; dq++) {
            for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
                const pos = { q: u.q + dq, r: u.r + dr };
                // Out of their reach first, then as far from them as possible (not toward home: they follow).
                const gap = Math.min(...threats.map(f => hexDist(f, pos) - f.strike));
                spots.push({ pos, safe: gap > 0 ? 1 : 0, gap });
            }
        }
        spots.sort((a, b) => b.safe - a.safe || b.gap - a.gap);
        for (const s of spots.slice(0, this.cfg.siteEvalLimit * this.cfg.targetLimit)) {
            const cell = this.helper.getCell(s.pos.q, s.pos.r);
            if (!cell || (s.pos.q === u.q && s.pos.r === u.r)) continue;
            if (move.canDo(cell, null).possible && move.do(cell, null)) return null;
        }
        return 'no safer cell within reach';
    }

    // ----------------------------------------------------------- exploration

    /**
     * Explore with whoever is best at it: reach and sight raise the value; being able
     * to build or repair, being on guard, or being defenceless lowers it (spec hint 18).
     */
    exploreOptions(ctx) {
        const { cfg } = this;
        if (ctx.unexplored <= 0) return [];
        const refPower = mean(Object.values(this.types).filter(t => t.dmg > 0).map(t => t.power)) || 1;
        const out = [];
        for (const u of ctx.mine) {
            if (!u.type.mobile || this.memory.projects.has(u.id)) continue;
            const reach = Math.min(u.ap / this.stepCost(u), u.type.sight); // fog: one move cannot pass the edge of sight
            if (reach < 1) continue;                                        // not enough AP left for a step
            const cells = Math.min(ctx.unexplored, reach * (2 * u.type.sight + 1) * cfg.sightEfficiency);
            let value = (ctx.w.exp / EXPLORATION_ROOT) * cells / (ctx.explored + 1);
            const notes = [];
            const needed = [];
            if ((u.type.buildables.length && u.charges !== 0) || u.type.repairables.length) { value *= cfg.builderExploreFactor; needed.push('can build/repair'); }
            if (ctx.guards.has(u.id)) { value *= cfg.guardExploreFactor; needed.push('on guard'); }
            value *= (1 + u.power / (u.power + refPower)) / 2;      // equal parts "can go" and "can defend itself" (hint 18)
            if (needed.length) {
                // Units needed at home stay within one turn's march of it, and come back if they are farther.
                notes.push(...needed);
                const home = ctx.homes.length ? ctx.homes.reduce((a, b) => (hexDist(a, u) <= hexDist(b, u) ? a : b)) : null;
                if (home && hexDist(home, u) > u.type.ap) {
                    out.push({
                        key: `return:${u.id}`, unit: u, category: 'explore', value, orders: 1,
                        text: `${this.tag(u)} returns toward ${this.tag(home)}: ${needed.join(', ')} and more than a turn from home`,
                        run: () => this.march(u, home, 'explore', 'returning home'),
                    });
                    continue;
                }
            }
            const treasure = this.treasureNear(ctx, u);
            if (treasure) { value += treasure.value; notes.push(`treasure at (${treasure.q},${treasure.r})`); }
            out.push({
                key: `explore:${u.id}`, unit: u, category: 'explore', value, orders: 1,
                text: `${this.tag(u)} explores (reach ${fmt(reach)}, sight ${u.type.sight}${notes.length ? `; ${notes.join(', ')}` : ''})`,
                run: () => this.runExplore(ctx, u, !!treasure),
            });
        }
        return out;
    }

    /** A known treasure this unit can reach within about two turns, valued at its mean reward. */
    treasureNear(ctx, u) {
        if (!this.turn.treasures) {
            this.turn.treasures = [];
            if (Object.keys(this.treasures).length) {
                for (const c of toArray(this.helper.getCellsArray())) {
                    const resource = c.resource;   // masked (undefined) on unexplored cells
                    if (resource?.kind === 'treasure') this.turn.treasures.push({ q: c.q, r: c.r, name: resource.name, quantity: resource.quantity || 1 });
                }
            }
        }
        let best = null;
        for (const tr of this.turn.treasures) {
            const d = hexDist(tr, u);
            if (d === 0 || d > this.cfg.detourTurns * u.type.ap) continue;
            const reward = (this.treasures[tr.name] || []).reduce((s, rw) => s + rw.quantity * ctx.price(rw.type), 0) * tr.quantity;
            const value = reward / (1 + d / Math.max(1, u.type.ap));
            if (!best || value > best.value) best = { ...tr, value };
        }
        return best;
    }

    runExplore(ctx, u, forTreasure) {
        const { helper, gameState } = this;
        // Never head for cells next to structures we must keep away from.
        if (this.turn.claimed.size === 0) {
            for (const c of this.cells) if (ctx.tooClose(c)) this.turn.claimed.add(`${c.q},${c.r}`);
            this.turn.claimed.add('-'); // marks the set as initialised
        }
        if (forTreasure) {
            const result = helper.explore(gameState, u.e, null, true, this.turn.claimed);
            return result.ordersUsed > 0 ? null : result.result?.message;
        }
        const anchor = this.goalAnchor(['explore']);
        let direction = anchor ? helper.directionTo(u.e.cell, anchor).fromSource : this.memory.exploreDir.get(u.id);
        if (!direction) direction = this.pickDirection(u);
        if (direction) {
            const result = helper.explore(gameState, u.e, direction, false, this.turn.claimed);
            if (result.ordersUsed > 0) {
                this.memory.exploreDir.set(u.id, direction);
                return null;
            }
            this.memory.exploreDir.delete(u.id); // that direction is exhausted or unreachable: re-pick next time
        }
        const result = helper.explore(gameState, u.e, null, false, this.turn.claimed);
        return result.ordersUsed > 0 ? null : result.result?.message;
    }

    /** The direction with the most unexplored cells per explorer already heading that way (spread out, hint 18). */
    pickDirection(u) {
        const { helper, player } = this;
        const counts = {};
        const here = u.e.cell;
        for (const c of this.cells) {
            if (player.isExplored(c.q, c.r)) continue;
            const dir = helper.directionTo(here, c).fromSource;
            counts[dir] = (counts[dir] || 0) + 1;
        }
        const taken = {};
        for (const dir of this.memory.exploreDir.values()) taken[dir] = (taken[dir] || 0) + 1;
        let best = null;
        for (const dir of helper.getDirections8()) {
            const score = (counts[dir] || 0) / (1 + (taken[dir] || 0));
            if (score > 0 && (!best || score > best.score)) best = { dir, score };
        }
        return best?.dir || null;
    }

    // ----------------------------------------------------------------- goals

    /** Map position of the first directive goal of one of the given types, or null. */
    goalAnchor(goalTypes) {
        const goal = this.turn.goals[0];
        if (!goal || !goalTypes.includes(goal.type)) return null;
        const where = goal.target ?? goal.direction;
        if (where && typeof where === 'object') {
            if (typeof where.q === 'number' && typeof where.r === 'number') return { q: where.q, r: where.r };
            const entity = where.entityId ? this.gameState.getEntityById(where.entityId) : null;
            return entity ? { q: entity.q, r: entity.r } : null;
        }
        if (typeof where !== 'string') return null;
        // A compass direction means "from our start position": the farthest map cell that way.
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
        return this.turn[key];
    }

    /** Directive goal "reinforce": march combat units to the target until enough force is there. */
    goalOptions(ctx) {
        const { cfg } = this;
        const anchor = this.goalAnchor(['reinforce']);
        if (!anchor) return [];
        const radius = cfg.foreignStructureBuffer;
        const hostile = ctx.foes.filter(f => f.menace && hexDist(f, anchor) <= f.reach).reduce((s, f) => s + f.power, 0);
        const total = ctx.fighters.reduce((s, v) => s + v.power, 0);
        const present = ctx.fighters.filter(v => hexDist(v, anchor) <= radius).reduce((s, v) => s + v.power, 0);
        const needed = Math.max(hostile * cfg.defenseMargin, total * cfg.guardShare);
        if (present >= needed) return [];
        const out = [];
        for (const u of ctx.fighters) {
            const d = hexDist(u, anchor);
            if (d <= radius || u.ap <= 0) continue;
            const turns = Math.ceil(d * this.stepCost(u) / Math.max(1, u.type.ap));
            out.push({
                key: `reinforce:${u.id}`, unit: u, category: 'combat', orders: 1,
                value: cfg.goalBoost * ctx.parts(u.name).score * (u.power / (total || 1)) / turns,
                text: `${this.tag(u)} marches to reinforce (${anchor.q},${anchor.r}): directive goal, force there ${fmt(present)} of ${fmt(needed)} needed`,
                run: () => this.march(u, anchor, 'combat', 'reinforcing (directive goal)'),
            });
        }
        return out;
    }

    // ----------------------------------------------------------------- scrap

    /**
     * Last resort against a deficit that nothing we can build will fix (spec hints 4, 8):
     * if a resource is about to run dry and no affordable build yields it, remove the
     * entity that burns the most of it per unit of worth. At most one per turn.
     */
    scrapOptions(ctx) {
        if (this.turn.scrapped) return [];
        const out = [];
        for (const [r, x] of Object.entries(ctx.res)) {
            if (!(x.net < 0) || x.runway >= 1) continue;
            const remedy = ctx.mine.some(u => u.type.buildables.some(b => {
                const t = this.types[b];
                return t && (t.yields[r] > 0 || t.buildables.some(bb => this.types[bb]?.yields[r] > 0)) && this.player.hasResources(t.cost);
            }));
            if (remedy) continue;
            let worst = null;
            for (const v of ctx.mineAll) {
                const burn = v.type.maint[r] || 0;
                if (burn <= 0) continue;
                const ratio = burn / (ctx.worth(v) + Number.EPSILON);
                if (!worst || ratio > worst.ratio) worst = { v, ratio, burn };
            }
            if (!worst) continue;
            const v = worst.v;
            out.push({
                key: `scrap:${v.id}`, unit: v, category: 'econ', orders: 1,
                value: ctx.price(r) * worst.burn * ctx.H - ctx.worth(v),
                text: `${this.tag(v)} is dismissed: ${r} is at ${fmt(x.stock)} with ${fmt(x.net)}/turn and no affordable build yields it; ` +
                    `it burns ${worst.burn} ${r}/turn`,
                run: () => {
                    const action = v.e.getActions().find(a => a.name === ACTION.selfDestruct);
                    if (!action || !action.canDo(null, null).possible) return 'self-destruct not available';
                    this.turn.scrapped = true;
                    return action.do(null, null) ? null : 'self-destruct refused';
                },
            });
        }
        return out;
    }
}
