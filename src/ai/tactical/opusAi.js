import { BaseManager } from '../baseManager.js';

/**
 * OpusAI — a utility-driven tactical AI (spec: src/ai/spec.md + addendum,
 * hybrid-ai-directive.md, ai-interface-spec.md).
 *
 * How a turn is decided
 * ---------------------
 * Every action is valued in one currency: the expected change of OUR total
 * score (T = cbrt(military * economic * exploration)). A point on pillar p is
 * worth dT/dp = T / (3p), so the weakest pillar is automatically the most
 * valuable one (spec hint 7) and no pillar ratio is hardcoded.
 *
 * The turn is a loop: observe -> generate candidate actions for every unit
 * (build, attack, repair, move = explore / treasure / guard / retreat) ->
 * execute the candidate with the best value per order -> repeat until orders
 * run out or nothing has positive value. Nothing is keyed on entity names:
 * capabilities come from getActions() and manifest attributes (score, yields,
 * maintenance, spawnCost, ordersPerTurn, buildables, buildCharges, damage,
 * armor, range, movement, sightRange, repairables, spawnConditions).
 *
 * Economy: each resource r has a horizon budget S_r = stock + H * netIncome
 * (H = cfg.horizon). Spending c units of r costs c / S_r of that budget, so a
 * resource that is running out becomes expensive to spend and valuable to
 * produce: deficits are fixed by the same valuation that grows the economy
 * (hints 4, 9, 12, 17). A build is refused when its upkeep would leave a
 * resource with fewer than cfg.safetyRunway turns of stock. When the best
 * build is not affordable yet but will be within cfg.saveTurns, its cost is
 * reserved so that cheaper builds cannot eat it (hint 21). Builds that need
 * a builder we do not have are reached through builder chains (hint 10).
 *
 * Danger: hostile units seen near our cells feed a decaying hazard map
 * (hostile attack-zone coverage per observed cell-turn). Hazard lowers the
 * value of exposed sites and positions, and makes combat units worth keeping
 * within striking range of our structures (guard value), in proportion to
 * what they can actually kill. Stance gating follows hybrid-ai-directive.md.
 *
 * The only hardcoded resource name is "orders" (hint 20); action names
 * ("Move", "Attack", "Repair", "Build <Type>", "Self Destruct") are engine
 * API names, not manifest data.
 */

// Tunables. Every number the AI uses is either derived from the game state /
// manifest or is one of these (overridable from definitions/ai.json config).
const DEFAULT_CONFIG = {
    horizon: 15,            // turns over which a new entity's yields, upkeep and extra orders are valued
    yieldDiscount: 0.5,     // average share of the horizon that a new yield is actually collected (it starts later, the game may end)
    safetyRunway: 8,        // a build may not leave any resource with fewer turns of stock than this at its new net rate
    saveTurns: 6,           // reserve resources for the best unaffordable build if income pays for it within this many turns
    growthPerHorizon: 1,    // expected relative score growth over one horizon; sets what one order is worth
    threatTurns: 3,         // turns a hostile unit is expected to keep hurting us if it is left alive
    partialDamageCredit: 0.5, // share of a hostile's threat removed by damage that does not kill it this turn
    repairBelow: 0.5,       // "heavily damaged" health fraction (hint 16); yielding entities that lost their yield also qualify
    chainDepth: 3,          // max depth of builder chains (hint 10)
    enemyScoreWeight: 0.5,  // value of one score point of another player (removed from an offensive-stance enemy, or kept for an ally), relative to one of ours
    offensiveRatio: 2,      // self-chosen stance: offensive vs an attacker when our mobile combat power is this many times theirs
    cautionRatio: 2,        // self-chosen stance: caution when their visible power is this many times ours
    attackMemoryRounds: 3,  // rounds an attack on us is remembered when choosing stances
    neutralBuffer: 3,       // hexes kept from structures of neutral/defensive/caution opponents ("don't move or build too close")
    hazardMemory: 0.9,      // per-turn retention of hazard observations (~10 turns of memory)
    hazardPrior: 5,         // strength (in observed cell-turns) of the map-wide hazard average in each cell's estimate
    focusBoost: 2,          // directive focus: weight multiplier for the focused pillar (others get 1 / focusBoost)
    goalBoost: 2,           // directive goals: value multiplier for actions that serve the first open goal
    goalRadius: 3,          // directive goals with a target cell cover the cells within this distance of it
    frontierShare: 0.5,     // share of a sight disk a unit reveals on reaching an exploration frontier
    commitBonus: 0.25,      // hysteresis: a builder walking to a planned site keeps it unless another is this much better
    maxIterations: 80,      // safety cap on actions per turn
    verbose: 0,             // 1 = log the ranked build options once per turn (debugging)
};

const NB = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const K = (q, r) => q + ',' + r;
const hexDist = (aq, ar, bq, br) => (Math.abs(aq - bq) + Math.abs(ar - br) + Math.abs(aq + ar - bq - br)) / 2;
const parseK = (k) => { const i = k.indexOf(','); return [+k.slice(0, i), +k.slice(i + 1)]; };

/** Calls fn(q, r, d) for every cell within `rad` of (q, r) (d = hex distance). */
function forDisk(q, r, rad, fn) {
    for (let dq = -rad; dq <= rad; dq++) {
        const lo = Math.max(-rad, -dq - rad), hi = Math.min(rad, -dq + rad);
        for (let dr = lo; dr <= hi; dr++) fn(q + dq, r + dr, (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2);
    }
}

/** Deep plain copy of (possibly proxied) data, keeping Infinity (JSON would turn it into null). */
function plainCopy(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) {
        const out = [];
        for (let i = 0; i < v.length; i++) out.push(plainCopy(v[i]));
        return out;
    }
    const out = {};
    for (const k of Object.keys(v)) {
        const x = v[k];
        if (typeof x !== 'function') out[k] = plainCopy(x);
    }
    return out;
}

class MinHeap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(p, v) {
        const a = this.a; a.push([p, v]);
        let i = a.length - 1;
        while (i > 0) { const j = (i - 1) >> 1; if (a[j][0] <= a[i][0]) break; [a[i], a[j]] = [a[j], a[i]]; i = j; }
    }
    pop() {
        const a = this.a; const top = a[0]; const last = a.pop();
        if (a.length) {
            a[0] = last; let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = l + 1; let m = i;
                if (l < a.length && a[l][0] < a[m][0]) m = l;
                if (r < a.length && a[r][0] < a[m][0]) m = r;
                if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m;
            }
        }
        return top;
    }
}

export default class OpusAI extends BaseManager {
    constructor(player, helper) {
        super(player, helper);
        const raw = player.controller?.config || {};
        this.cfg = { ...DEFAULT_CONFIG };
        for (const k of Object.keys(DEFAULT_CONFIG)) {
            if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) this.cfg[k] = raw[k];
        }
        this.cells = new Map();     // explored-cell cache: key -> {q, r, t, mc, h, res}
        this.defs = null;           // plain copy of the manifest entity definitions
        this.mem = {
            plans: new Map(),       // builder id -> {type, q, r} (multi-turn walks to a build site)
            structures: new Map(),  // id -> last-seen foreign construct {q, r, ownerId, name}
            attackedBy: new Map(),  // owner id (null = ownerless) -> last round it damaged us
            hz: new Map(),          // cell key -> {hits, obs}: hostile zone coverage per observed turn (decaying)
            hzAll: { hits: 0, obs: 0 },
            hostileTypes: new Map(), // hostile type name -> decaying sighting weight
        };
    }

    // =====================================================================
    // Logging (hint 11): reasoning, source/target location, owning player.
    // =====================================================================
    log(msg) {
        console.log(`[OpusAI ${this.player.name} R${this.gameState.currentRound}] ${msg}`);
    }
    where(x) { return `(${x.q},${x.r})`; }
    ownerName(id) {
        if (id === null || id === undefined) return 'ownerless';
        const p = (this.gameState.players || []).find(pl => pl.id === id);
        return p ? p.name : `player ${id}`;
    }
    label(u) { return `${u.name}#${String(u.id).split('_').pop()}@${this.where(u)}[${this.ownerName(u.ownerId)}]`; }

    // =====================================================================
    // Static game data (the manifest is fixed for the whole game)
    // =====================================================================
    loadStatic() {
        const m = this.gameState.manifestData || {};
        this.defs = plainCopy(m.entities || {});
        this.treasureDefs = new Map();
        for (const t of plainCopy(m.treasures || [])) this.treasureDefs.set(t.name, t);
        this.naturalDefs = plainCopy(m.naturalResources || []);
        const names = new Set();
        for (const d of Object.values(this.defs)) {
            for (const f of ['spawnCost', 'maintenance', 'yields']) for (const r of Object.keys(d[f] || {})) names.add(r);
        }
        for (const r of Object.keys(plainCopy(this.player.resources || {}))) names.add(r);
        names.delete('orders'); // hint 20: orders is not a normal resource
        this.resNames = [...names];
        // NB: proxied arrays wrap whatever map/filter return, so build our own arrays with loops
        this.allKeys = new Set();
        for (const c of this.helper.getCellsArray()) this.allKeys.add(K(c.q, c.r));
        this.titles = new Map();
    }

    buildActionName(type) {
        if (!this.titles.has(type)) this.titles.set(type, `build ${this.helper.camelToTitle(type)}`.toLowerCase());
        return this.titles.get(type);
    }

    /** Refreshes the explored-cell cache (terrain is permanent; resources change). */
    updateMap(keys, refreshVisible) {
        for (const k of keys) {
            let c = this.cells.get(k);
            if (c && !(refreshVisible && this.visible.has(k))) continue;
            const [q, r] = parseK(k);
            const cell = this.helper.getCell(q, r);
            if (!cell || !cell.terrain) continue;
            if (!c) {
                c = { q, r, t: cell.terrain.name, mc: cell.terrain.movementCost || 1, h: cell.terrain.height ?? 1, res: false };
                this.cells.set(k, c);
            }
            const res = cell.resource;
            c.res = res ? { kind: res.kind, name: res.name, quantity: res.quantity || 1 } : false;
        }
    }

    // =====================================================================
    // Entity views (plain objects; the live proxy is kept in .e)
    // =====================================================================
    view(e, own) {
        const def = this.defs[e.name] || plainCopy(e.data || {});
        const v = {
            e, own, def, id: e.id, name: e.name, q: e.q, r: e.r,
            hp: e.health, maxHp: e.maxHealth, active: e.active,
            ap: e.actionPoints ?? 0, maxAp: e.maxActionPoints ?? 0,
            ownerId: e.owner ? e.owner.id : null,
            mobile: !!def.movement,
            dmg: def.damage?.value || 0,
        };
        if (own) {
            v.builds = new Map();
            for (const a of e.getActions()) {
                const n = a.name;
                if (n === 'Move') v.move = a;
                else if (n === 'Attack') v.attack = a;
                else if (n === 'Repair') v.repair = a;
                else if (n === 'Self Destruct') v.disband = a;
                else if (n.startsWith('Build ')) v.builds.set(n.toLowerCase(), a);
            }
            v.charges = e.state?.buildCharges;
            v.exh = e.state?.battleExhaustion ?? 1;
        }
        return v;
    }

    /** Same rule as Entity.getMovementCost (terrain cost x per-terrain scale; null scale = impassable). */
    moveCost(def, cell) {
        if (!cell || !def.movement) return Infinity;
        const tcs = def.movement.terrainCostScale;
        let s = (tcs && cell.t in tcs) ? tcs[cell.t] : 1;
        if (s === null) s = Infinity;
        return (cell.mc || 1) * s;
    }

    canStand(def, cell) {
        if (!cell) return false;
        if (!def.movement) {
            const t = def.spawnConditions?.terrain;
            return !t || t.some(n => n.toLowerCase() === String(cell.t).toLowerCase());
        }
        return Number.isFinite(this.moveCost(def, cell));
    }

    /** Dijkstra over explored cells; units may pass occupied cells but not stop on them. */
    reach(q, r, def, budget) {
        const start = K(q, r);
        const dist = new Map([[start, 0]]);
        const prev = new Map();
        const heap = new MinHeap();
        heap.push(0, start);
        while (heap.size) {
            const [c, k] = heap.pop();
            if (c > dist.get(k)) continue;
            const [cq, cr] = parseK(k);
            for (const [dq, dr] of NB) {
                const nk = K(cq + dq, cr + dr);
                const nc = this.cells.get(nk);
                if (!nc) continue;
                const step = this.moveCost(def, nc);
                if (!Number.isFinite(step)) continue;
                const c2 = c + step;
                if (c2 > budget) continue;
                if (c2 < (dist.get(nk) ?? Infinity)) { dist.set(nk, c2); prev.set(nk, k); heap.push(c2, nk); }
            }
        }
        return { dist, prev };
    }

    pathTo(rs, k) {
        const path = [];
        let cur = k;
        while (rs.prev.has(cur)) { path.push(cur); cur = rs.prev.get(cur); }
        return path.reverse();
    }

    unitReach(u) {
        if (!u._reach) u._reach = this.reach(u.q, u.r, u.def, u.mobile && u.move ? u.ap : 0);
        return u._reach;
    }

    unitReachFull(u) {
        if (!u._reachFull) u._reachFull = this.reach(u.q, u.r, u.def, Infinity);
        return u._reachFull;
    }

    /** Rough strike radius of a unit next turn: its AP in hexes plus its attack range. */
    strikeRadius(d) {
        return Math.floor(d.movement ? (d.maxActionPoints ?? 0) : 0) + (d.range ? (d.range.maxCells || 1) : 1);
    }

    // =====================================================================
    // Turn entry point
    // =====================================================================
    async processTurn() {
        const P = this.player;
        if (!P || P.orders <= 0) return;
        if (!this.defs) this.loadStatic();
        this.dumped = false;
        this.failed = new Map();      // candidate key -> reason (this turn only; failures are target-specific)
        this.longTargets = new Set(); // long-range exploration targets claimed this turn (spreads explorers out)
        this.turnSetup();
        const start = P.orders;
        let iter = 0;
        while (P.orders > 0 && iter++ < this.cfg.maxIterations) {
            this.refresh();
            let best = null;
            for (const c of this.candidates()) {
                if (!(c.value > 0) || this.failed.has(c.key)) continue;
                c.priority = c.value / Math.max(1, c.orders);
                if (!best || c.priority > best.priority) best = c;
            }
            if (!best) break;
            const before = P.orders;
            try {
                await best.exec();
            } catch (err) {
                this.log(`ERROR executing ${best.key}: ${err?.message || err}`);
            }
            if (!(P.orders < before)) {
                this.failed.set(best.key, best.why || 'no effect');
            } else {
                await this.helper.onActionDone(this.gameState, null, best.key);
            }
        }
        this.log(`turn end: used ${start - P.orders} of ${start} orders | score M${P.score?.military} E${P.score?.economic} X${P.score?.exploration} T${P.score?.total}`);
    }

    // =====================================================================
    // Once-per-turn setup: directive, stances, memory
    // =====================================================================
    turnSetup() {
        const P = this.player, gs = this.gameState;
        const round = gs.currentRound;
        this.visible = new Set(P.visibleCells);
        this.explored = new Set(P.exploredCells);
        this.updateMap(this.explored, true);

        // Who attacked us recently (hint 19: attack history)
        this.recentAttackers = new Set();
        for (const h of P.getHistoryRange(Math.max(1, round - 1), round) || []) {
            if (h.category !== 'damaged' || !h.extra?.attackerId) continue;
            this.recentAttackers.add(h.extra.attackerId);
            const att = gs.getEntityById(h.extra.attackerId);
            if (att) this.mem.attackedBy.set(att.owner ? att.owner.id : null, round);
        }

        // Directive (read fresh every turn). An explicit directive is obeyed as-is.
        const c = P.controller || {};
        const d = c.directive || c.config?.directive || c.config?.aiDirective || null;
        this.directive = d && typeof d === 'object'
            ? { explicit: true, focus: d.focus || 'balanced', stance: plainCopy(d.stance || {}), goals: plainCopy(Array.isArray(d.goals) ? d.goals : []) }
            : { explicit: false, focus: 'balanced', stance: {}, goals: [] };
        this.refresh();
        if (!this.directive.explicit) { this.chooseStances(); this.refresh(); }
        this.observeHazard();
        this.refresh();
        this.resolveGoals();
        this.planDisband();
        const st = Object.entries(this.directive.stance).map(([k, v]) => `${this.ownerName(Number(k))}:${v}`).join(', ') || 'all neutral';
        const pl = this.pillars;
        this.log(`turn start | orders ${P.orders} | focus ${this.directive.focus}${this.directive.explicit ? ' (directive)' : ' (own)'} | stances ${st} | goals ${this.directive.goals.map(g => g.type + (g === this.goal ? '*' : g.done ? '(done)' : '')).join(',') || 'none'} | M${pl.M} E${pl.E} X${pl.X.toFixed(1)} | hostiles in view ${this.hostiles.length}, map hazard ${this.hazardMean().toFixed(3)}`);
        const eco = this.eco;
        const seed = this.seedReserve();
        this.log(`economy: ${this.resNames.map(r => `${r} ${Math.round(eco.stock[r])}${eco.net[r] >= 0 ? '+' : ''}${Math.round(eco.net[r])}`).join(' ')}${seed.length ? ` | seed reserve for ${seed.map(x => `${x.type}(${x.res.join('/')})`).join(', ')}` : ''}`);
    }

    /** No directive: per-opponent stances from the game state, in order to win. */
    chooseStances() {
        const round = this.gameState.currentRound;
        let ourPow = 0;
        for (const u of this.mine) if (u.mobile && u.dmg > 0) ourPow += this.power(u.def, u.hp);
        const theirPow = new Map();
        for (const f of this.foreign) {
            if (f.ownerId === null || !f.mobile || f.dmg <= 0) continue;
            theirPow.set(f.ownerId, (theirPow.get(f.ownerId) || 0) + this.power(f.def, f.hp));
        }
        const stance = {};
        for (const p of this.gameState.players) {
            if (p.id === this.player.id) continue;
            const pow = theirPow.get(p.id) || 0;
            const attacked = round - (this.mem.attackedBy.get(p.id) ?? -Infinity) <= this.cfg.attackMemoryRounds;
            let s = 'neutral';
            if (attacked) s = ourPow >= this.cfg.offensiveRatio * pow ? 'offensive' : 'defensive';
            else if (pow > 0 && pow >= this.cfg.cautionRatio * ourPow) s = 'caution';
            if (s !== 'neutral') stance[p.id] = s;
        }
        this.directive.stance = stance;
    }

    stanceOf(ownerId) {
        if (ownerId === null || ownerId === undefined) return 'defensive'; // ownerless (barbarians): defensive (addendum 4)
        return this.directive.stance[ownerId] || 'neutral';
    }

    power(def, hp) { return (def.damage?.value || 0) * (hp ?? def.health ?? 1); }

    // =====================================================================
    // Hazard map (learned from what we see; nothing assumed about who the hostiles are)
    // =====================================================================
    observeHazard() {
        const keep = this.cfg.hazardMemory;
        const cover = new Map();
        for (const h of this.hostiles) {
            if (!h.mobile) continue;
            this.mem.hostileTypes.set(h.name, (this.mem.hostileTypes.get(h.name) || 0) + 1);
            for (const k of h.zone) if (this.visible.has(k)) cover.set(k, (cover.get(k) || 0) + 1);
        }
        for (const [n, w] of this.mem.hostileTypes) this.mem.hostileTypes.set(n, w * keep);
        for (const v of this.mem.hz.values()) { v.hits *= keep; v.obs *= keep; }
        const all = this.mem.hzAll;
        all.hits *= keep; all.obs *= keep;
        for (const k of this.visible) {
            let v = this.mem.hz.get(k);
            if (!v) { v = { hits: 0, obs: 0 }; this.mem.hz.set(k, v); }
            const c = cover.get(k) || 0;
            v.hits += c; v.obs += 1;
            all.hits += c; all.obs += 1;
        }
        this.typicalCache = new Map();
    }

    hazardMean() { const a = this.mem.hzAll; return a.obs > 0 ? a.hits / a.obs : 0; }

    /** Expected number of hostile attack zones covering cell k per turn (local estimate shrunk to the map mean). */
    hazard(k) {
        const v = this.mem.hz.get(k);
        const n0 = this.cfg.hazardPrior;
        const mean = this.hazardMean();
        return v ? (v.hits + n0 * mean) / (v.obs + n0) : mean;
    }

    /** Share of an entity's health a typical observed hostile removes per turn, and its hp/damage profile. */
    typicalHostile(def) {
        const key = def.name || JSON.stringify(def.armor || {});
        if (this.typicalCache?.has(key)) return this.typicalCache.get(key);
        let w = 0, frac = 0, hp = 0;
        for (const [n, wt] of this.mem.hostileTypes) {
            const hd = this.defs[n];
            if (!hd) continue;
            const hits = Math.max(1, this.hitsWith(hd, (hd.maxActionPoints ?? 0) - 1, 1));
            frac += wt * Math.min(1, hits * this.hitDamage(hd, def, def.health) / Math.max(1, def.maxHealth ?? def.health ?? 1));
            hp += wt * (hd.health || 1);
            w += wt;
        }
        const r = w > 0 ? { frac: frac / w, hp: hp / w, types: this.mem.hostileTypes } : { frac: 0, hp: 1, types: null };
        (this.typicalCache ||= new Map()).set(key, r);
        return r;
    }

    /** Share of a typical hostile's health this attacker type removes per turn. */
    killShare(def) {
        let w = 0, s = 0;
        for (const [n, wt] of this.mem.hostileTypes) {
            const hd = this.defs[n];
            if (!hd) continue;
            const hits = this.hitsWith(def, (def.maxActionPoints ?? 0) - (def.movement ? 1 : 0), def.range ? (def.range.minCells || 1) : 1);
            s += wt * Math.min(1, hits * this.hitDamage(def, hd, hd.health) / Math.max(1, hd.health || 1));
            w += wt;
        }
        return w > 0 ? s / w : 0;
    }

    // =====================================================================
    // Per-iteration observation
    // =====================================================================
    refresh() {
        const P = this.player;
        this.visible = new Set(P.visibleCells);
        const ex = P.exploredCells;
        if (ex.size !== this.explored.size) {
            const fresh = [];
            for (const k of ex) if (!this.explored.has(k)) fresh.push(k);
            this.explored = new Set(ex);
            this.updateMap(fresh, false);
        }
        this.mine = [];
        for (const e of P.getEntities()) if (!e.destroyed) this.mine.push(this.view(e, true));
        this.foreign = [];
        const opp = P.getOpponents() || {};
        for (const o of Object.values(opp)) for (const e of o.entities || []) if (!e.destroyed && e.health > 0) this.foreign.push(this.view(e, false));
        this.occ = new Map();
        for (const u of this.mine) this.occ.set(K(u.q, u.r), u);
        for (const f of this.foreign) this.occ.set(K(f.q, f.r), f);
        // remember foreign constructs (they do not move); forget them when their cell is visible and empty
        for (const f of this.foreign) if (!f.mobile && f.ownerId !== null) this.mem.structures.set(f.id, { q: f.q, r: f.r, ownerId: f.ownerId, name: f.name });
        for (const [id, s] of this.mem.structures) {
            const k = K(s.q, s.r);
            if (this.visible.has(k) && this.occ.get(k)?.id !== id) this.mem.structures.delete(id);
        }
        this.valueCache = new Map();
        this.blockedCache = new Map();
        this.planCache = new Map();
        this.coverage = null;
        this._engage = null;
        this.computePillars();
        this.computeEconomy();
        this.computeThreats();
        this.computeForbidden();
    }

    computePillars() {
        let M = 0, E = 0;
        for (const u of this.mine) { M += u.def.score?.military || 0; E += u.def.score?.economic || 0; }
        const V = Math.max(1, this.visible.size), Ex = Math.max(1, this.explored.size);
        const X = Math.cbrt(V * Ex);
        const T = Math.cbrt(Math.max(1, M) * Math.max(1, E) * Math.max(1, X));
        const f = this.directive.focus;
        const b = this.cfg.focusBoost;
        const mult = (p) => (f === 'balanced' || !f) ? 1 : (f === p ? b : 1 / b);
        this.pillars = { M, E, X, V, Ex, T };
        this.w = {
            mil: mult('military') * T / (3 * Math.max(1, M)),
            eco: mult('economy') * T / (3 * Math.max(1, E)),
            exp: mult('exploration') * T / (3 * Math.max(1, X)),
        };
    }

    computeEconomy() {
        const prof = this.player.getResourceProfile();
        const H = this.cfg.horizon;
        const eco = { stock: {}, net: {}, upkeep: {}, S: {}, price: {} };
        for (const r of this.resNames) {
            const stock = prof.stock?.[r] ?? 0, net = prof.netIncome?.[r] ?? 0, up = prof.totalUpkeep?.[r] ?? 0;
            eco.stock[r] = stock; eco.net[r] = net; eco.upkeep[r] = up;
            // horizon budget; floored at one turn of upkeep (+1) so prices stay finite
            eco.S[r] = Math.max(1 + up, stock + H * net);
            eco.price[r] = 1 / eco.S[r];
        }
        this.eco = eco;
        const ordersPerTurn = this.player.ordersPerTurn || 1;
        this.orderValue = this.cfg.growthPerHorizon * this.pillars.T / (ordersPerTurn * H);
        // resources that matter: used by anything our builder tree can produce
        this.relevant = new Set();
        for (const t of this.reachableTypes()) for (const f of ['spawnCost', 'maintenance']) for (const r of Object.keys(this.defs[t]?.[f] || {})) this.relevant.add(r);
        // rho: score value of one whole horizon budget, from the best direct-score build available now
        let rho = 0;
        for (const t of this.directTypes()) {
            const d = this.defs[t];
            const direct = this.directValue(d), cost = this.costOf(d);
            if (direct > 0 && cost > 0) rho = Math.max(rho, direct / cost);
        }
        this.rho = rho > 0 ? rho : 1;
    }

    /** Types some active builder of ours can build right now (builder chains start here). */
    directTypes() {
        const set = new Set();
        for (const u of this.mine) {
            if (!u.active || u.charges === 0) continue;
            for (const t of u.def.buildables || []) if (this.defs[t] && u.builds.has(this.buildActionName(t))) set.add(t);
        }
        return set;
    }

    reachableTypes() {
        const seen = new Set(), stack = [...this.directTypes()];
        while (stack.length) {
            const t = stack.pop();
            if (seen.has(t)) continue;
            seen.add(t);
            for (const c of this.defs[t]?.buildables || []) if (this.defs[c]) stack.push(c);
        }
        return seen;
    }

    // =====================================================================
    // Valuation
    // =====================================================================
    directValue(d) {
        return this.w.mil * (d.score?.military || 0) + this.w.eco * (d.score?.economic || 0);
    }

    /** Budget share consumed by building and maintaining an entity over the horizon. */
    costOf(d) {
        const H = this.cfg.horizon;
        let c = 0;
        for (const [r, v] of Object.entries(d.spawnCost || {})) if (this.eco.price[r] !== undefined) c += v * this.eco.price[r];
        for (const [r, v] of Object.entries(d.maintenance || {})) if (this.eco.price[r] !== undefined) c += H * v * this.eco.price[r];
        return c;
    }

    yieldValue(yields) {
        let f = 0;
        for (const [r, v] of Object.entries(yields || {})) {
            if (!this.relevant.has(r) || this.eco.price[r] === undefined) continue;
            f += v * this.eco.price[r];
        }
        return this.rho * this.cfg.yieldDiscount * this.cfg.horizon * f;
    }

    resourceValue(amounts) {
        let f = 0;
        for (const [r, v] of Object.entries(amounts || {})) if (this.eco.price[r] !== undefined) f += v * this.eco.price[r];
        return this.rho * f;
    }

    /** Hits per turn an attacker can make with `ap` AP; unitCost = AP of the first attack before exhaustion. */
    hitsWith(d, ap, unitCost, exh = 1) {
        if (!(d.damage?.value > 0)) return 0;
        const scale = d.attackCostScale ?? 1;
        let n = 0, spent = 0;
        if (!(scale * unitCost > 0)) return 0;
        for (let k = exh; ; k++) {
            const c = Math.ceil(scale * k * unitCost);
            if (spent + c > ap) break;
            spent += c; n++;
        }
        return n;
    }

    /** Damage of one hit (engine rule: (value*mult + lifeFraction*hp) / armor[type]), at multiplier `mult`. */
    hitDamage(ad, td, targetHp, mult = 1) {
        const dmg = ad.damage || {};
        const armor = (td.armor || {})[dmg.type] || 1;
        return ((dmg.value || 0) * mult + (dmg.lifeFraction || 0) * (targetHp ?? td.health ?? 0)) / armor;
    }

    /** Value of an entity of this type (for building it, and as what we lose if it dies). */
    typeValue(name, siteYields = null) {
        const cache = !siteYields && !this._partial;
        if (cache && this.valueCache.has(name)) return this.valueCache.get(name);
        const d = this.defs[name];
        if (!d) return 0;
        let v = this.directValue(d);
        v += this.yieldValue(siteYields || d.yields);
        v += (d.ordersPerTurn || 0) * this.cfg.horizon * this.cfg.yieldDiscount * this.orderValue;
        if (d.movement) v += this.mobilityValue(d);
        if (d.damage?.value > 0 && !this._partial) v += this.defenseValue(d);
        if (cache) this.valueCache.set(name, v);
        return v;
    }

    /** Exploration potential of a mobile type: cells it can reveal over the horizon, and its sight. */
    mobilityValue(d) {
        const { X, V, Ex } = this.pillars;
        const total = this.allKeys.size;
        const unexplored = total - this.explored.size;
        if (unexplored <= 0) return 0;
        const sight = d.sightRange ?? 2;
        const ap = d.maxActionPoints ?? d.actionPoints ?? 0;
        let explorers = 0;
        for (const u of this.mine) if (u.mobile && u.move) explorers++;
        const perTurn = (2 * sight + 1) * ap;
        const reveal = Math.min(unexplored, perTurn * this.cfg.horizon * this.cfg.yieldDiscount) * (unexplored / total) / (1 + explorers);
        const area = 3 * sight * (sight + 1) + 1;
        return this.w.exp * X / 3 * (reveal / Ex + area * (unexplored / total) / V);
    }

    /** Value of a combat type for defending our structures (current threats + learned hazard). */
    defenseValue(d) {
        const ks = this.killShare(d);
        let v = 0;
        for (const s of this.homeStructures()) v += s.threat * s.loss * ks / (1 + s.guards);
        // current threats it could help remove
        for (const h of this.hostiles) {
            if (h.risk <= 0) continue;
            const hits = this.hitsWith(d, (d.maxActionPoints ?? 0) - (d.movement ? 1 : 0), d.range ? (d.range.minCells || 1) : 1);
            v += h.risk * this.cfg.partialDamageCredit * Math.min(1, hits * this.hitDamage(d, h.def, h.hp) / Math.max(1, h.hp));
        }
        return v * this.cfg.threatTurns;
    }

    /** What we lose if u dies: its type value, and for a builder what it enables (shared with its peers). */
    assetValue(u) {
        const v = this.typeValue(u.name);
        if (!(u.def.buildables || []).length || !this.defs[u.name]) return v;
        return Math.max(v, this.planFor(u.name).value);
    }

    /** Our structures with their expected incoming threat per turn, loss per hostile-turn, and guard count. */
    homeStructures() {
        if (this._home) return this._home;
        if (this._partial) return [];
        const out = [];
        // While this list is being built, values are computed without defenseValue (which needs the list)
        // and are not cached, so no partial result leaks into later valuations (see computeThreats).
        this._partial = true;
        const guards = this.mine.filter(u => u.mobile && u.attack && this.killShare(u.def) > 0);
        for (const s of this.mine) {
            if (s.mobile) continue;
            const k = K(s.q, s.r);
            let current = 0;
            for (const h of this.hostiles) if (h.zone.has(k)) current++;
            const threat = this.hazard(k) + current;
            const loss = this.assetValue(s) * this.typicalHostile(s.def).frac;
            let g = 0;
            for (const u of guards) if (hexDist(u.q, u.r, s.q, s.r) <= this.strikeRadius(u.def)) g++;
            out.push({ s, k, threat, loss, guards: g });
        }
        this._partial = false;
        this._home = out;
        return out;
    }

    // =====================================================================
    // Threats
    // =====================================================================
    isDangerous(f) {
        if (f.dmg <= 0) return false;
        if (f.ownerId === null) return true;
        const s = this.stanceOf(f.ownerId);
        if (s === 'neutral' || s === 'friendly' || s === 'ally') return this.recentAttackers.has(f.id); // only if it attacked us
        return true; // offensive / defensive / caution
    }

    canEngage(f) {
        const s = this.stanceOf(f.ownerId);
        if (s === 'friendly' || s === 'ally') return false;          // never target them (we only shield ourselves)
        if (s === 'offensive') return true;
        if (this.recentAttackers.has(f.id)) return true;             // every other stance defends itself
        if (s === 'defensive') return f.risk > 0;                    // engage within threat range
        return false;                                                 // neutral / caution: no special targeting
    }

    computeThreats() {
        this._home = null;
        this._partial = false;
        this.hostiles = [];
        for (const f of this.foreign) {
            f.risk = 0;
            if (!this.isDangerous(f)) continue;
            const d = f.def;
            const scale = d.attackCostScale ?? 1;
            const lo = d.range ? (d.range.minCells || 1) : 1, hi = d.range ? (d.range.maxCells || 1) : 1;
            const first = Math.ceil(scale * lo);
            const maxAp = f.e.maxActionPoints ?? d.maxActionPoints ?? 0;
            const rs = f.mobile ? this.reach(f.q, f.r, d, Math.max(0, maxAp - first)) : { dist: new Map([[K(f.q, f.r), 0]]) };
            const zone = new Set();
            for (const k of rs.dist.keys()) {
                const [cq, cr] = parseK(k);
                forDisk(cq, cr, hi, (q, r, dd) => { if (dd >= lo) zone.add(K(q, r)); });
            }
            f.zone = zone;
            f.hits = Math.max(1, this.hitsWith(d, maxAp - (f.mobile ? 1 : 0), lo));
            // cells it sees from where it could stand next turn: it will come for what it sees
            f.engage = (f.mobile ? Math.floor(maxAp) : 0) + Math.max(hi, d.sightRange ?? 2);
            this.hostiles.push(f);
        }
        // risk each hostile poses to our assets, per turn: it goes for the closest target first.
        // Risks are incomplete until this loop ends: values computed meanwhile skip defenseValue (which
        // reads them) and are not cached.
        this.threatPressure = 0;
        this._partial = true;
        // ally stance: their entities are protected too, valued like enemy score (enemyScoreWeight)
        const allies = this.foreign.filter(f => f.ownerId !== null && this.stanceOf(f.ownerId) === 'ally');
        const assets = allies.length ? this.mine.concat(allies) : this.mine;
        for (const h of this.hostiles) {
            const targets = assets.filter(u => u.ownerId !== h.ownerId && (h.zone.has(K(u.q, u.r)) || hexDist(u.q, u.r, h.q, h.r) <= h.engage))
                .sort((a, b) => hexDist(a.q, a.r, h.q, h.r) - hexDist(b.q, b.r, h.q, h.r));
            let risk = 0;
            targets.forEach((u, i) => {
                const dmg = h.hits * this.hitDamage(h.def, u.def, u.hp);
                const now = h.zone.has(K(u.q, u.r)) ? 1 : this.cfg.partialDamageCredit; // next turn vs. the turn after
                const worth = u.own ? this.assetValue(u) : this.cfg.enemyScoreWeight * this.typeValue(u.name);
                risk += now / (i + 1) * Math.min(1, dmg / Math.max(1, u.hp)) * worth;
            });
            h.risk = risk;
            h.targets = targets;
            this.threatPressure += risk;
        }
        this._partial = false;
    }

    /** Expected loss if unit u ends the turn on cell key k (known hostiles + learned hazard). */
    exposure(u, k, ignore = null) {
        const [q, r] = parseK(k);
        let loss = 0;
        for (const h of this.hostiles) {
            if (h === ignore || !h.zone.has(k)) continue;
            const dmg = h.hits * this.hitDamage(h.def, u.def, u.hp);
            const myD = hexDist(q, r, h.q, h.r);
            // hostiles go for the closest target first: same harmonic rank weight as in computeThreats
            let closer = 0;
            for (const t of h.targets) if (t.id !== u.id && hexDist(t.q, t.r, h.q, h.r) < myD) closer++;
            loss += Math.min(1, dmg / Math.max(1, u.hp)) * this.assetValue(u) / (1 + closer);
        }
        const hz = this.hazard(k);
        if (hz > 0) loss += Math.min(1, hz * this.typicalHostile(u.def).frac) * this.assetValue(u);
        return loss;
    }

    /** Value of having combat unit u stationed at cell c: the threat to nearby structures it can answer. */
    guardAt(u, q, r) {
        const ks = this.killShare(u.def);
        if (ks <= 0) return 0;
        const R = this.strikeRadius(u.def);
        let v = 0;
        for (const s of this.homeStructures()) {
            if (hexDist(q, r, s.s.q, s.s.r) > R) continue;
            const self = hexDist(u.q, u.r, s.s.q, s.s.r) <= R ? 1 : 0; // u is already counted as a guard there
            v += s.threat * s.loss * ks / (1 + s.guards - self);
        }
        return v * this.cfg.threatTurns;
    }

    /** Cells we must not enter or build on: near structures of opponents whose stance says keep away. */
    computeForbidden() {
        this.forbidden = new Set();
        const b = this.cfg.neutralBuffer;
        for (const s of this.mem.structures.values()) {
            const st = this.stanceOf(s.ownerId);
            if (st !== 'neutral' && st !== 'defensive' && st !== 'caution') continue;
            forDisk(s.q, s.r, b, (q, r) => this.forbidden.add(K(q, r)));
        }
    }

    // =====================================================================
    // Candidates
    // =====================================================================
    candidates() {
        const out = [];
        this.buildCandidates(out);
        this.attackCandidates(out);
        this.repairCandidates(out);
        this.moveCandidates(out);
        this.disbandCandidates(out);
        return out;
    }

    // ---------------- builds ----------------

    blockedFor(type) {
        if (this.blockedCache.has(type)) return this.blockedCache.get(type);
        const sep = this.defs[type]?.spawnConditions?.minSeparation;
        const blocked = new Set();
        if (typeof sep === 'number') {
            const mark = (q, r, d) => {
                const es = d?.spawnConditions?.minSeparation;
                if (typeof es !== 'number') return;
                forDisk(q, r, Math.max(sep, es) - 1, (a, b) => blocked.add(K(a, b)));
            };
            for (const e of this.mine) mark(e.q, e.r, e.def);
            for (const e of this.foreign) mark(e.q, e.r, e.def);
            for (const s of this.mem.structures.values()) mark(s.q, s.r, this.defs[s.name]);
        }
        this.blockedCache.set(type, blocked);
        return blocked;
    }

    siteOk(type, k) {
        const c = this.cells.get(k);
        if (!c || this.occ.has(k) || this.forbidden.has(k)) return false;
        const terr = this.defs[type]?.spawnConditions?.terrain;
        if (Array.isArray(terr) && terr.length && !terr.some(t => t.toLowerCase() === String(c.t).toLowerCase())) return false;
        return !this.blockedFor(type).has(k);
    }

    /** Yields of `type` at cell c with natural-resource bonuses (same rule as the engine's yield bonus). */
    siteYields(type, c) {
        const base = { ...(this.defs[type]?.yields || {}) };
        for (const nd of this.naturalDefs) {
            const imp = nd.improvement?.[type];
            if (!imp || typeof base[imp.type] !== 'number') continue;
            let qty = 0;
            for (const [dq, dr] of NB) {
                const n = this.cells.get(K(c.q + dq, c.r + dr));
                if (n?.res && n.res.kind === 'natural' && n.res.name === nd.name) qty += n.res.quantity;
            }
            if (qty > 0 && imp.yieldMultiplier > 0) base[imp.type] = base[imp.type] * imp.yieldMultiplier * Math.sqrt(qty);
        }
        return base;
    }

    /** Exploration score from what a new entity on cell c would see that nothing of ours sees now. */
    sightGain(type, c) {
        const sight = this.defs[type]?.sightRange ?? 2;
        let unseen = 0, unexp = 0;
        forDisk(c.q, c.r, sight, (q, r) => {
            const k = K(q, r);
            if (!this.allKeys.has(k)) return;
            if (!this.visible.has(k)) unseen++;
            if (!this.explored.has(k)) unexp++;
        });
        const { X, V, Ex } = this.pillars;
        return this.w.exp * X / 3 * (unseen / V + unexp / Ex);
    }

    /** Expected loss of a structure of `type` placed on cell k over the horizon (learned hazard). */
    siteRisk(type, k, value) {
        const hz = this.hazard(k);
        if (hz <= 0) return 0;
        return Math.min(1, hz * this.cfg.horizon * this.cfg.yieldDiscount * this.typicalHostile(this.defs[type]).frac) * value;
    }

    /** Best plan (builder chain) starting with building `type`: {value, cost, chain}. */
    planFor(type, depth = 0, seen = new Set()) {
        if (depth === 0 && !this._partial && this.planCache.has(type)) return this.planCache.get(type);
        const d = this.defs[type];
        const own = { value: this.typeValue(type), cost: this.costOf(d), chain: [type] };
        let best = own;
        if (depth + 1 < this.cfg.chainDepth && (d.buildables || []).length) {
            let owned = 0;
            for (const u of this.mine) if (u.name === type && u.charges !== 0) owned++;
            const mult = typeof d.buildCharges === 'number' ? d.buildCharges : 1;
            const nseen = new Set(seen).add(type);
            for (const child of d.buildables) {
                if (!this.defs[child] || nseen.has(child)) continue;
                if (this.defs[child].spawnConditions && !this.hasAnySite(child)) continue;
                const sub = this.planFor(child, depth + 1, nseen);
                // what a new builder enables is shared with the builders of this type we already own
                const value = own.value + mult * sub.value / (1 + owned);
                const cost = own.cost + mult * sub.cost;
                if (value / Math.max(1e-9, cost) > best.value / Math.max(1e-9, best.cost)) best = { value, cost, chain: [type, ...sub.chain] };
            }
        }
        if (depth === 0 && !this._partial) this.planCache.set(type, best);
        return best;
    }

    hasAnySite(type) {
        const key = 'site:' + type;
        if (this.planCache.has(key)) return this.planCache.get(key);
        const maxD = this.helper.getConfig().buildMaxDistance ?? 10;
        let ok = false;
        for (const k of this.cells.keys()) {
            if (!this.siteOk(type, k)) continue;
            const c = this.cells.get(k);
            if (this.mine.some(a => hexDist(a.q, a.r, c.q, c.r) <= maxD)) { ok = true; break; }
        }
        this.planCache.set(key, ok);
        return ok;
    }

    affordable(cost, reserved) {
        for (const [r, v] of Object.entries(cost || {})) {
            if (r === 'orders') continue;
            if ((this.eco.stock[r] ?? 0) - (reserved[r] || 0) < v) return false;
        }
        return true;
    }

    turnsToAfford(cost) {
        let t = 0;
        for (const [r, v] of Object.entries(cost || {})) {
            if (r === 'orders') continue;
            const short = v - (this.eco.stock[r] ?? 0);
            if (short <= 0) continue;
            const n = this.eco.net[r] ?? 0;
            if (n <= 0) return Infinity;
            t = Math.max(t, short / n);
        }
        return t;
    }

    /**
     * Would this build leave a resource it consumes with fewer than safetyRunway turns of stock at the
     * new net rate? Builders that use themselves up (buildCharges) only need to last saveTurns.
     */
    sustainable(d) {
        const need = typeof d.buildCharges === 'number' ? Math.min(this.cfg.saveTurns, this.cfg.safetyRunway) : this.cfg.safetyRunway;
        for (const r of Object.keys(d.maintenance || {})) {
            if (this.eco.stock[r] === undefined || !(d.maintenance[r] > 0)) continue;
            const newNet = this.eco.net[r] - d.maintenance[r] + (d.yields?.[r] || 0);
            if (newNet >= 0) continue;
            const left = this.eco.stock[r] - (d.spawnCost?.[r] || 0);
            if (left / -newNet < need) return false;
        }
        return true;
    }

    buildCandidates(out) {
        const builders = this.mine.filter(u => u.active && u.builds.size && u.charges !== 0 && u.ap >= 1);
        if (!builders.length) return;
        const options = [];
        for (const b of builders) {
            for (const type of b.def.buildables || []) {
                const d = this.defs[type];
                if (!d || !b.builds.has(this.buildActionName(type))) continue;
                const plan = this.planFor(type);
                const site = this.chooseSite(b, type);
                if (!site) continue;
                const value = plan.value - this.typeValue(type) + site.value - this.chargeLoss(b);
                options.push({ b, type, d, plan, site, value, ratio: value / Math.max(1e-9, plan.cost) });
            }
        }
        options.sort((a, b) => b.ratio - a.ratio);
        if (this.cfg.verbose && !this.dumped) this.dumpOptions(options);
        const reserved = {};
        let saving = null;
        const seed = this.seedReserve();
        for (const o of options) {
            if (o.value <= 0 || !this.sustainable(o.d)) continue;
            if (!this.affordable(o.d.spawnCost, this.withSeed(reserved, seed, o.type))) {
                if (!saving && this.turnsToAfford(o.d.spawnCost) <= this.cfg.saveTurns) {
                    saving = o;
                    for (const [r, v] of Object.entries(o.d.spawnCost || {})) reserved[r] = (reserved[r] || 0) + v;
                }
                continue;
            }
            out.push({
                kind: 'build', key: `build:${o.b.id}:${o.type}:${K(o.site.q, o.site.r)}`, value: o.value, orders: o.site.orders,
                exec: () => this.execBuild(o, saving),
            });
        }
        if (saving && !(this.savingLogged ||= new Set()).has(saving.type)) {
            this.savingLogged.add(saving.type);
            this.log(`saving for ${saving.type} via ${this.label(saving.b)} (plan [${saving.plan.chain.join('>')}], ratio ${saving.ratio.toFixed(2)}, cost ${JSON.stringify(saving.d.spawnCost)}); cheaper builds may not touch it`);
        }
    }

    /**
     * Seed capital: for every relevant resource that nothing we own produces, keep enough stock to build
     * the cheapest type that produces it. Spending the starting stock on things that do not regrow it
     * otherwise deadlocks the economy (no wood -> no forge -> no iron -> no lumber mill ...).
     */
    seedReserve() {
        const produced = new Set();
        for (const u of this.mine) for (const [r, v] of Object.entries(u.def.yields || {})) if (v > 0) produced.add(r);
        const seed = [];
        // only producers we can build right now: reserving for one that needs a builder we lack would
        // block the very chain (e.g. the settlement) that leads to that builder
        const types = this.directTypes();
        for (const r of this.relevant) {
            if (produced.has(r)) continue;
            let best = null, bc = Infinity;
            for (const t of types) {
                const d = this.defs[t];
                if (!(d.yields?.[r] > 0) || (d.spawnConditions && !this.hasAnySite(t))) continue;
                const c = this.costOf({ spawnCost: d.spawnCost });
                if (c < bc) { bc = c; best = t; }
            }
            if (!best) continue;
            const e = seed.find(x => x.type === best);
            if (e) e.res.push(r);
            else seed.push({ type: best, res: [r], cost: this.defs[best].spawnCost || {} });
        }
        return seed;
    }

    /** Reserved amounts plus the seed capital, except the seed entries that building `type` itself provides. */
    withSeed(reserved, seed, type) {
        const out = { ...reserved };
        const y = this.defs[type]?.yields || {};
        for (const s of seed) {
            if (s.type === type || s.res.some(r => y[r] > 0)) continue;
            for (const [r, v] of Object.entries(s.cost)) out[r] = (out[r] || 0) + v;
        }
        return out;
    }

    dumpOptions(options) {
        this.dumped = true;
        const seen = new Set(), rows = [];
        for (const o of options) {
            if (seen.has(o.type)) continue;
            seen.add(o.type);
            const d = o.d;
            rows.push(`${o.type}: v ${o.value.toFixed(2)} tv ${this.typeValue(o.type).toFixed(2)} site ${o.site.value.toFixed(2)} plan ${o.plan.value.toFixed(2)} (dir ${this.directValue(d).toFixed(2)} yld ${this.yieldValue(d.yields).toFixed(2)} mob ${d.movement ? this.mobilityValue(d).toFixed(2) : 0} def ${d.damage?.value > 0 ? this.defenseValue(d).toFixed(2) : 0}) cost ${o.plan.cost.toFixed(2)} ratio ${o.ratio.toFixed(2)} [${o.plan.chain.join('>')}] site (${o.site.q},${o.site.r}) ord ${o.site.orders}${this.sustainable(d) ? '' : ' UNSUST'}${this.affordable(d.spawnCost, {}) ? '' : ' UNAFF'}`);
        }
        this.log(`build options (rho ${this.rho.toFixed(2)}, w mil ${this.w.mil.toFixed(2)} eco ${this.w.eco.toFixed(2)} exp ${this.w.exp.toFixed(2)}, orderValue ${this.orderValue.toFixed(2)}, prices x1000 ${this.resNames.map(r => r + ':' + (this.eco.price[r] * 1000).toFixed(2)).join(' ')}):\n    ${rows.join('\n    ')}`);
    }

    /** Builders with limited charges are used up: each use costs a share of their own score value. */
    chargeLoss(b) {
        if (typeof b.charges !== 'number' || b.charges <= 0) return 0;
        return this.directValue(b.def) / b.charges;
    }

    /** Best site for builder b to build `type`: {q, r, stage, orders, value}. */
    chooseSite(b, type) {
        const d = this.defs[type];
        const isUnit = !!d.movement;
        const here = K(b.q, b.r);
        const plan = this.mem.plans.get(b.id);
        let best = null;
        const consider = (c, stageKey, travel, penalty) => {
            const k = K(c.q, c.r);
            let v = this.typeValue(type, d.yields ? this.siteYields(type, c) : null);
            if (!isUnit) v += this.sightGain(type, c) - this.siteRisk(type, k, v);
            v *= this.goalBuildBoost(type, k);
            v -= penalty;
            if (plan && plan.type === type && plan.q === c.q && plan.r === c.r) v *= 1 + this.cfg.commitBonus;
            const orders = 1 + travel;
            const pr = v / orders;
            if (!best || pr > best.pr) best = { q: c.q, r: c.r, stage: stageKey, orders, value: v, pr };
        };
        if (!b.mobile || !b.move) {
            for (const [dq, dr] of NB) {
                const k = K(b.q + dq, b.r + dr);
                const c = this.cells.get(k);
                if (!c) continue;
                if (isUnit ? (this.occ.has(k) || !this.canStand(d, c)) : !this.siteOk(type, k)) continue;
                consider(c, here, 0, 0);
            }
            return best;
        }
        // mobile builder: any valid site within build distance, staged from a reachable neighbour
        const maxD = this.helper.getConfig().buildMaxDistance ?? 10;
        const full = this.unitReachFull(b);
        const ap = Math.max(1, b.maxAp);
        forDisk(b.q, b.r, maxD, (q, r) => {
            const k = K(q, r);
            const c = this.cells.get(k);
            if (!c) return;
            if (isUnit ? (this.occ.has(k) || !this.canStand(d, c)) : !this.siteOk(type, k)) return;
            let stage = null, sc = Infinity;
            for (const [dq, dr] of NB) {
                const sk = K(q + dq, r + dr);
                if (sk !== here && (this.occ.has(sk) || this.forbidden.has(sk))) continue;
                const cost = full.dist.get(sk);
                if (cost !== undefined && cost < sc) { sc = cost; stage = sk; }
            }
            if (!stage) return;
            // orders: walking turns (this turn's AP first; the build needs 1 AP on arrival) + the build itself
            const travel = stage === here ? 0 : (sc <= b.ap - 1 ? 1 : 1 + Math.ceil(Math.max(0, sc - b.ap) / ap));
            consider(c, stage, travel, stage === here ? 0 : this.exposure(b, stage));
        });
        return best;
    }

    async execBuild(o, saving) {
        const { b, type, site } = o;
        const P = this.player;
        const action = b.builds.get(this.buildActionName(type));
        let used = 0;
        const from = this.where(b);
        if (site.stage !== K(b.q, b.r)) {
            const path = this.pathTo(this.unitReachFull(b), site.stage);
            const moved = await this.moveUnit(b, path, `walking to build ${type} at (${site.q},${site.r}) [plan ${o.plan.chain.join('>')}, value ${o.value.toFixed(2)}]`);
            if (!moved) return 0;
            used++;
            this.mem.plans.set(b.id, { type, q: site.q, r: site.r });
            if (hexDist(b.e.q, b.e.r, site.q, site.r) !== 1 || P.orders <= 0 || (b.e.actionPoints ?? 0) < 1) return used;
        }
        const cell = this.helper.getCell(site.q, site.r);
        const chk = action.canDo(cell, null);
        if (!chk?.possible) {
            this.log(`build ${type} at (${site.q},${site.r}) by ${this.label(b)} refused: ${chk?.reason}`);
            this.failed.set(`build:${b.id}:${type}:${K(site.q, site.r)}`, chk?.reason);
            return used;
        }
        if (action.do(cell, null)) {
            used++;
            this.mem.plans.delete(b.id);
            const c = this.cells.get(K(site.q, site.r));
            if (c && !this.defs[type]?.movement) c.res = false;
            this.log(`BUILD ${type} at (${site.q},${site.r}) by ${b.name} from ${from} | value ${o.value.toFixed(2)} ratio ${o.ratio.toFixed(2)} plan [${o.plan.chain.join('>')}]${saving && saving !== o ? ` (still saving for ${saving.type})` : ''}`);
        }
        return used;
    }

    // ---------------- combat ----------------

    attackCandidates(out) {
        const targets = this.foreign.filter(f => this.canEngage(f));
        if (!targets.length) return;
        const attackers = this.mine.filter(u => u.active && u.attack && u.ap > 0);
        for (const t of targets) {
            const tv = this.targetValue(t);
            if (tv <= 0) continue;
            const plans = [];
            let team = 0;
            for (const u of attackers) {
                const plan = this.planAttack(u, t);
                if (!plan) continue;
                plan.dealt = Math.min(t.hp, plan.hits * this.hitDamage(u.def, t.def, t.hp));
                team += plan.dealt;
                plans.push([u, plan]);
            }
            // if this turn's attackers together can finish it, every hit counts toward the kill (focus fire)
            const credit = team >= t.hp ? 1 : this.cfg.partialDamageCredit;
            for (const [u, plan] of plans) {
                const kill = plan.dealt >= t.hp;
                const gain = tv * (kill ? 1 : credit * plan.dealt / Math.max(1, t.hp));
                const value = gain - this.exposure(u, plan.pos, kill ? t : null) + this.exposure(u, K(u.q, u.r));
                const orders = plan.hits + (plan.pos !== K(u.q, u.r) ? 1 : 0);
                out.push({
                    kind: 'attack', key: `attack:${u.id}:${t.id}`, value, orders,
                    exec: () => this.execAttack(u, t, orders, value, plan, team),
                });
            }
        }
    }

    /** Threat removed (over threatTurns) + for offensive stance, enemy score removed, by destroying t. */
    targetValue(t) {
        let v = t.risk * this.cfg.threatTurns;
        if (t.ownerId !== null && this.stanceOf(t.ownerId) === 'offensive') v += this.cfg.enemyScoreWeight * this.directValue(t.def);
        return v;
    }

    /** Where u attacks t from this turn and how many hits it gets: {pos, hits} or null. */
    planAttack(u, t) {
        const d = u.def;
        const rs = this.unitReach(u);
        const here = K(u.q, u.r);
        let best = null;
        const better = (hits, c) => hits > 0 && (!best || hits > best.hits || (hits === best.hits && c < best.cost));
        if (d.range) {
            const lo = d.range.minCells || 1, hi = d.range.maxCells || 1;
            for (const [k, c] of rs.dist) {
                if (k !== here && this.occ.has(k)) continue;
                const [q, r] = parseK(k);
                const dist = hexDist(q, r, t.q, t.r);
                if (dist < lo || dist > hi) continue;
                const hits = this.hitsWith(d, u.ap - c, dist, u.exh);
                if (better(hits, c)) best = { pos: k, hits, cost: c };
            }
        } else {
            const tc = this.cells.get(K(t.q, t.r));
            const unitCost = this.moveCost(d, tc);
            if (!Number.isFinite(unitCost)) return null;
            for (const [dq, dr] of NB) {
                const k = K(t.q + dq, t.r + dr);
                if (k !== here && this.occ.has(k)) continue;
                const c = rs.dist.get(k);
                if (c === undefined) continue;
                const hits = this.hitsWith(d, u.ap - c, unitCost, u.exh);
                if (better(hits, c)) best = { pos: k, hits, cost: c };
            }
        }
        if (best) best.hits = Math.min(best.hits, this.player.orders - (best.pos !== here ? 1 : 0));
        return best && best.hits > 0 ? best : null;
    }

    async execAttack(u, t, orders, value, plan, team) {
        const from = this.where(u);
        const hpBefore = t.e.health;
        const res = this.helper.attack(this.gameState, u.e, t.e, orders);
        this.log(`ATTACK ${this.label(t)} with ${u.name} from ${from} (stance ${this.stanceOf(t.ownerId)}, threat ${t.risk.toFixed(2)}, value ${value.toFixed(2)}, plan ${plan.hits} hit(s) from (${plan.pos}), team damage ${Math.round(team)}): ${res?.result?.message} [hp ${Math.round(hpBefore)} -> ${t.e.destroyed ? 0 : Math.round(t.e.health)}]`);
        return res?.ordersUsed || 0;
    }

    // ---------------- repair ----------------

    repairCandidates(out) {
        const repairers = this.mine.filter(u => u.active && u.repair && u.ap > 0);
        if (!repairers.length) return;
        for (const t of this.mine) {
            if (t.hp >= t.maxHp) continue;
            const lostYield = !!(t.def.yields && Object.keys(t.def.yields).length && t.active && !t.e.canYield());
            // heavily damaged, or under attack now (it will be heavily damaged soon if nobody repairs it)
            let threatened = false;
            for (const h of this.hostiles) if (h.zone.has(K(t.q, t.r))) { threatened = true; break; }
            const heavy = t.hp < this.cfg.repairBelow * t.maxHp || threatened;
            if (!heavy && !lostYield) continue;
            for (const rp of repairers) {
                if (rp.id === t.id) continue;
                if (!(rp.def.repairables || []).some(x => x.toLowerCase() === t.name.toLowerCase())) continue;
                const adj = hexDist(rp.q, rp.r, t.q, t.r) === 1;
                let apLeft = rp.ap, pos = K(rp.q, rp.r);
                if (!adj) {
                    if (!rp.move) continue;
                    const rs = this.unitReach(rp);
                    let bc = Infinity;
                    for (const [dq, dr] of NB) {
                        const k = K(t.q + dq, t.r + dr);
                        const c = rs.dist.get(k);
                        if (c !== undefined && !this.occ.has(k) && c < bc) { bc = c; pos = k; }
                    }
                    if (!Number.isFinite(bc) || rp.ap - bc <= 0) continue;
                    apLeft = rp.ap - bc;
                }
                const heal = Math.min(t.maxHp - t.hp, (rp.def.repairAmountPerAp || 1) * apLeft);
                // value: yields restored (share of the gap to the yield threshold closed) + survival odds
                let v = 0;
                const needed = Math.max(1, t.maxHp * this.yieldThreshold() - t.hp);
                if (lostYield) v += this.yieldValue(this.siteYieldsOf(t)) * Math.min(1, heal / needed);
                if (heavy) v += this.assetValue(t) * heal / t.maxHp;
                v -= this.exposure(rp, pos) - this.exposure(rp, K(rp.q, rp.r));
                out.push({
                    kind: 'repair', key: `repair:${rp.id}:${t.id}`, value: v, orders: adj ? 1 : 2,
                    exec: async () => {
                        const from = this.where(rp);
                        const res = this.helper.support(this.gameState, rp.e, t.e, 'Repair', adj ? 1 : 2);
                        this.log(`REPAIR ${this.label(t)} hp ${Math.round(t.hp)}/${t.maxHp} by ${rp.name} from ${from} (value ${v.toFixed(2)}${lostYield ? ', restores yields' : ''}${heavy ? (threatened ? ', under attack' : ', heavily damaged') : ''}): ${res?.result?.message}`);
                        return res?.ordersUsed || 0;
                    },
                });
            }
        }
    }

    /** The engine's canYield() threshold (Entity.canYield: yields only above 95% health). */
    yieldThreshold() { return 0.95; }

    siteYieldsOf(t) { const c = this.cells.get(K(t.q, t.r)); return c ? this.siteYields(t.name, c) : (t.def.yields || {}); }

    // ---------------- movement: explore, treasure, guard, retreat ----------------

    buildCoverage() {
        if (this.coverage) return this.coverage;
        const cov = new Map();
        for (const u of this.mine) forDisk(u.q, u.r, u.def.sightRange ?? 2, (q, r) => { const k = K(q, r); cov.set(k, (cov.get(k) || 0) + 1); });
        this.coverage = cov;
        return cov;
    }

    moveCandidates(out) {
        const movers = this.mine.filter(u => u.active && u.move && u.ap > 0);
        if (!movers.length) return;
        const cov = this.buildCoverage();
        const { X, V, Ex } = this.pillars;
        const kE = this.w.exp * X / (3 * Ex), kV = this.w.exp * X / (3 * V);
        const gArea = this.goal?.type === 'explore' ? this.goal.area : null;
        for (const u of movers) {
            const rs = this.unitReach(u);
            const here = K(u.q, u.r);
            const s = u.def.sightRange ?? 2;
            const baseHere = this.exposure(u, here) - this.guardAt(u, u.q, u.r);
            // what only u sees now (lost when it leaves)
            const uniqueHere = new Set();
            forDisk(u.q, u.r, s, (q, r) => { const k = K(q, r); if (this.allKeys.has(k) && cov.get(k) === 1) uniqueHere.add(k); });
            let best = null;
            for (const [k, cost] of rs.dist) {
                if (k === here || this.occ.has(k) || (this.forbidden.has(k) && !this.forbidden.has(here))) continue;
                const c = this.cells.get(k);
                let newE = 0, newV = 0, kept = 0, newG = 0;
                forDisk(c.q, c.r, s, (q, r) => {
                    const kk = K(q, r);
                    if (!this.allKeys.has(kk)) return;
                    if (!this.explored.has(kk)) { newE++; if (gArea?.has(kk)) newG++; }
                    const cv = cov.get(kk) || 0;
                    if (cv === 0) newV++;
                    else if (uniqueHere.has(kk)) kept++;
                });
                let v = kE * newE + kV * (newV - (uniqueHere.size - kept));
                if (c.res && c.res.kind === 'treasure') v += this.treasureValue(c.res);
                v += baseHere - this.exposure(u, k) + this.guardAt(u, c.q, c.r);
                if (this.goal) v += this.goalMoveValue(u, c, newG, kE);
                if (!best || v > best.v) best = { k, v, newE };
            }
            // nothing to reveal within reach: head for the nearest unclaimed frontier, or back to defend
            const far = [this.returnToDefend(u, baseHere)];
            if (!best || best.newE === 0) far.push(this.longRange(u, baseHere));
            for (const lr of far) if (lr && (!best || lr.v > best.v)) best = lr;
            if (!best || best.v <= 0) continue;
            const bk = best;
            out.push({
                kind: 'move', key: `move:${u.id}:${bk.k}`, value: bk.v, orders: 1,
                exec: async () => {
                    const path = bk.path || this.pathTo(rs, bk.k);
                    if (bk.long) this.longTargets.add(bk.target);
                    return this.moveUnit(u, path, bk.why || `explore/position (value ${bk.v.toFixed(2)}, reveals ~${bk.newE}${baseHere > 0 ? `, staying costs ${baseHere.toFixed(2)}` : ''})`);
                },
            });
        }
    }

    treasureValue(res) {
        const def = this.treasureDefs.get(res.name);
        if (!def || !def.rewards?.length) return 0;
        const avg = {};
        for (const rw of def.rewards) avg[rw.type] = (avg[rw.type] || 0) + rw.quantity * (res.quantity || 1) / def.rewards.length;
        return this.resourceValue(avg);
    }

    /** Path prefix of a full-map route that this turn's AP can walk. */
    walkable(u, full, target) {
        const path = this.pathTo(full, target).filter(k => full.dist.get(k) <= u.ap && !this.occ.has(k));
        return path;
    }

    longRange(u, baseHere) {
        if (this.allKeys.size <= this.explored.size) return null;
        const full = this.unitReachFull(u);
        const s = u.def.sightRange ?? 2;
        let best = null;
        for (const [k, cost] of full.dist) {
            if (cost === 0 || this.occ.has(k) || this.forbidden.has(k)) continue;
            const [q, r] = parseK(k);
            let unexp = 0;
            for (const [dq, dr] of NB) { const nk = K(q + dq, r + dr); if (this.allKeys.has(nk) && !this.explored.has(nk)) unexp++; }
            if (!unexp) continue;
            let claimed = false;
            for (const t of this.longTargets) { const [tq, tr] = parseK(t); if (hexDist(tq, tr, q, r) <= s) { claimed = true; break; } }
            if (claimed) continue;
            const turns = Math.max(1, cost / Math.max(1, u.maxAp));
            const inGoal = this.goal?.type === 'explore' && this.goal.area.has(k);
            const score = inGoal ? turns / this.cfg.goalBoost : turns;
            if (!best || score < best.score) best = { k, turns, score, inGoal };
        }
        if (!best) return null;
        const path = this.walkable(u, full, best.k);
        if (!path.length) return null;
        const dest = path[path.length - 1];
        const [dq, dr] = parseK(dest);
        // part of a sight disk of new cells once there, discounted by the turns needed
        const { X, Ex } = this.pillars;
        const area = 3 * s * (s + 1) + 1;
        const reveal = this.w.exp * X / (3 * Ex) * area * this.cfg.frontierShare / best.turns;
        const g = best.inGoal ? this.cfg.goalBoost : 1;
        const v = g * reveal + baseHere - this.exposure(u, dest) + this.guardAt(u, dq, dr);
        return { k: dest, v, newE: 0, long: true, target: best.k, path, why: `long-range explore toward frontier (${best.k}), ~${best.turns.toFixed(1)} turns${best.inGoal ? ' [explore goal]' : ''}` };
    }

    /**
     * Targets worth walking to: hostiles threatening us, plus (offensive stance only) every known unit and
     * remembered structure of that opponent ("actively seek and engage ... move into their territory").
     */
    engageTargets() {
        if (this._engage) return this._engage;
        const out = [];
        const seen = new Set();
        for (const f of this.foreign) {
            if (!this.canEngage(f) || !(this.targetValue(f) > 0)) continue;
            if (f.risk <= 0 && this.stanceOf(f.ownerId) !== 'offensive') continue;
            out.push(f); seen.add(f.id);
        }
        for (const [id, st] of this.mem.structures) {
            if (seen.has(id) || this.stanceOf(st.ownerId) !== 'offensive' || !this.defs[st.name]) continue;
            const def = this.defs[st.name];
            out.push({ id, name: st.name, q: st.q, r: st.r, ownerId: st.ownerId, def, hp: def.health || 1, risk: 0 });
        }
        this._engage = out;
        return out;
    }

    /** A combat unit too far to strike a target worth engaging walks toward it. */
    returnToDefend(u, baseHere) {
        if (!u.attack || u.builds.size) return null; // builders have better uses than fighting
        let best = null;
        for (const h of this.engageTargets()) {
            const full = this.unitReachFull(u);
            let bk = null, bc = Infinity;
            for (const [dq, dr] of NB) { const k = K(h.q + dq, h.r + dr); const c = full.dist.get(k); if (c !== undefined && c < bc) { bc = c; bk = k; } }
            if (!bk || bc <= u.ap) continue; // within reach: attack candidates handle it
            const turns = bc / Math.max(1, u.maxAp);
            const hits = this.hitsWith(u.def, u.maxAp - 1, 1);
            const frac = Math.min(1, hits * this.hitDamage(u.def, h.def, h.hp) / Math.max(1, h.hp));
            const v0 = this.targetValue(h) * frac * this.cfg.partialDamageCredit / (1 + turns);
            if (!best || v0 > best.v0) best = { v0, h, bk, full };
        }
        if (!best) return null;
        const path = this.walkable(u, best.full, best.bk);
        if (!path.length) return null;
        const dest = path[path.length - 1];
        const [dq, dr] = parseK(dest);
        let v = best.v0 + baseHere - this.exposure(u, dest) + this.guardAt(u, dq, dr);
        // offensive stance: "actively seek and engage" - closing in is worth what a reinforce goal step is
        if (this.stanceOf(best.h.ownerId) === 'offensive') v += this.cfg.goalBoost * this.orderValue * (hexDist(u.q, u.r, best.h.q, best.h.r) - hexDist(dq, dr, best.h.q, best.h.r)) / Math.max(1, u.maxAp);
        const what = best.h.risk > 0 ? `returning to defend against ${this.label(best.h)} (threat ${best.h.risk.toFixed(2)})` : `advancing on ${this.label(best.h)} (offensive stance)`;
        return { k: dest, v, newE: 0, path, why: what };
    }

    async moveUnit(u, path, why) {
        if (!path || !path.length) return 0;
        const cells = [];
        for (const k of path) { const [q, r] = parseK(k); const c = this.helper.getCell(q, r); if (c) cells.push(c); }
        const from = this.where(u);
        const used = this.helper.moveAlongPath(this.player, u.e, u.move, cells, this.gameState, 'explore', why);
        if (used) this.log(`MOVE ${u.name}#${String(u.id).split('_').pop()} ${from} -> (${u.e.q},${u.e.r}): ${why}`);
        return used;
    }

    // ---------------- deficit relief (hint 8) ----------------

    /**
     * Stuck-deficit relief (hints 4, 8, 9). When a resource has not covered its upkeep for two turns running,
     * disband the cheapest set of entities (lowest value per unit of that upkeep) that consume it, do not
     * produce it and cannot lead to a producer, so that its net income becomes non-negative and stock can
     * accumulate again for the producers. Nothing is disbanded if no such set exists (it would not unstick
     * us; unpaid entities still count for score).
     */
    planDisband() {
        this.disbandIds = new Map();
        const mem = (this.mem.short ||= new Map());
        for (const r of this.resNames) {
            const net = this.eco.net[r];
            if (!(net < 0 && this.eco.stock[r] + net < 0)) { mem.delete(r); continue; }
            mem.set(r, (mem.get(r) || 0) + 1);
            if (mem.get(r) < 2) continue;
            const pool = [];
            for (const u of this.mine) {
                const m = u.def.maintenance?.[r] || 0;
                if (!u.disband || !(m > 0) || this.disbandIds.has(u.id) || this.leadsToProducer(u.name, [r])) continue;
                pool.push({ u, m, per: this.assetValue(u) / m });
            }
            pool.sort((a, b) => a.per - b.per);
            let gain = 0;
            const pick = [];
            for (const x of pool) { if (net + gain >= 0) break; pick.push(x); gain += x.m; }
            if (net + gain < 0) continue;
            for (const x of pick) this.disbandIds.set(x.u.id, r);
        }
    }

    disbandCandidates(out) {
        if (!this.disbandIds?.size) return;
        for (const u of this.mine) {
            const r = this.disbandIds.get(u.id);
            if (!r || !u.disband || this.eco.net[r] >= 0) continue; // re-checked live: earlier actions may have fixed it
            const m = u.def.maintenance || {};
            const relief = this.yieldValue(m);
            out.push({
                kind: 'disband', key: `disband:${u.id}`, value: relief, orders: 1,
                exec: async () => {
                    const where = this.where(u);
                    const ok = u.disband.do(this.helper.getCell(u.q, u.r), null);
                    if (ok) this.log(`SELF DESTRUCT ${u.name} at ${where}: ${r} has been short of next turn's upkeep for 2+ turns (stock ${Math.round(this.eco.stock[r])}, net ${Math.round(this.eco.net[r])}); stopping its upkeep ${JSON.stringify(m)} lets ${r} accumulate for producers (its value ${this.assetValue(u).toFixed(2)})`);
                    return ok ? 1 : 0;
                },
            });
        }
    }

    /** Does this type yield, or (through builder chains) lead to a type that yields, one of the resources? */
    leadsToProducer(type, resources, depth = 0, seen = new Set()) {
        const d = this.defs[type];
        if (!d || seen.has(type)) return false;
        seen.add(type);
        if (resources.some(r => (d.yields?.[r] || 0) > 0)) return true;
        if (depth >= this.cfg.chainDepth) return false;
        return (d.buildables || []).some(c => this.leadsToProducer(c, resources, depth + 1, seen));
    }

    // ---------------- directive goals ----------------

    /**
     * Resolve directive goals to cell areas and completion; this.goal = first open goal (worked on first,
     * hybrid-ai-directive.md "works through them by priority"). Areas: a target cell -> disk of goalRadius;
     * an entity -> disk around it; a compass direction -> every cell the engine's directionTo() names
     * that direction from our start cell.
     */
    resolveGoals() {
        this.goal = null;
        for (const g of this.directive.goals) {
            g.area = this.goalArea(g);
            g.center = g.area ? this.goalCenter(g) : null;
            g.done = !g.area || this.goalDone(g);
            if (!g.done && !this.goal) this.goal = g;
        }
    }

    goalArea(g) {
        const t = g.target ?? g.direction;
        if (t && typeof t === 'object') {
            let q = t.q, r = t.r;
            if (t.entityId !== undefined) {
                const e = this.gameState.getEntityById(t.entityId);
                if (!e || e.destroyed) return null;
                q = e.q; r = e.r;
            }
            if (!Number.isFinite(q) || !Number.isFinite(r)) return null;
            const area = new Set();
            forDisk(q, r, this.cfg.goalRadius, (a, b) => { const k = K(a, b); if (this.allKeys.has(k)) area.add(k); });
            return area;
        }
        if (typeof t !== 'string') return null;
        (this.dirAreas ||= new Map());
        if (!this.dirAreas.has(t)) {
            const sc = this.player.startCoord || { q: 0, r: 0 };
            // plain coordinates: getCell() hides unexplored cells, and directionTo only needs q and r
            const from = { q: sc.q, r: sc.r };
            const area = new Set();
            for (const k of this.allKeys) {
                const [q, r] = parseK(k);
                if ((q !== sc.q || r !== sc.r) && this.helper.directionTo(from, { q, r }, true)?.fromSource === t) area.add(k);
            }
            this.dirAreas.set(t, area.size ? area : null);
        }
        return this.dirAreas.get(t);
    }

    goalCenter(g) {
        let q = 0, r = 0, n = 0;
        for (const k of g.area) { const [a, b] = parseK(k); q += a; r += b; n++; }
        return { q: q / n, r: r / n };
    }

    isMilitaryType(d) { return (d.score?.military || 0) >= (d.score?.economic || 0); }

    goalDone(g) {
        switch (g.type) {
            case 'explore':
                for (const k of g.area) if (!this.explored.has(k)) return false;
                return true;
            case 'reinforce': {
                // sufficient force: our combat power in the area covers the hostile power seen in or next to it
                let ours = 0, theirs = 0;
                for (const u of this.mine) if (u.mobile && u.attack && g.area.has(K(u.q, u.r))) ours += this.power(u.def, u.hp);
                for (const h of this.hostiles) {
                    let near = false;
                    for (const k of h.zone) if (g.area.has(k)) { near = true; break; }
                    if (near) theirs += this.power(h.def, h.hp);
                }
                return ours > 0 && ours >= theirs;
            }
            case 'buildEconomy':
            case 'buildMilitary': {
                // complete once a structure of that kind was built in the area after the goal was first seen
                const key = JSON.stringify([g.type, g.target ?? g.direction]);
                const mil = g.type === 'buildMilitary';
                const match = [];
                for (const u of this.mine) if (!u.mobile && g.area.has(K(u.q, u.r)) && this.isMilitaryType(u.def) === mil) match.push(u.id);
                const seen = (this.mem.goalSeen ||= new Map());
                if (!seen.has(key)) { seen.set(key, new Set(match)); return false; }
                if (seen.get(key).done) return true;
                return (seen.get(key).done = match.some(id => !seen.get(key).has(id)));
            }
            default:
                return true; // unknown goal types are ignored
        }
    }

    /** Build-goal multiplier: economy/military structures in the goal area (and, for buildMilitary, unit production). */
    goalBuildBoost(type, k) {
        const g = this.goal;
        if (!g || (g.type !== 'buildEconomy' && g.type !== 'buildMilitary')) return 1;
        const d = this.defs[type];
        const mil = g.type === 'buildMilitary';
        if (this.isMilitaryType(d) !== mil) return 1;
        if (d.movement) return mil ? this.cfg.goalBoost : 1;
        return g.area.has(k) ? this.cfg.goalBoost : 1;
    }

    /** Extra move value from the active goal: unexplored cells revealed in the explore area; reinforce approach. */
    goalMoveValue(u, c, newG, kE) {
        const g = this.goal;
        if (g.type === 'explore') return (this.cfg.goalBoost - 1) * kE * newG;
        if (g.type === 'reinforce' && u.attack && u.dmg > 0) {
            const d0 = hexDist(u.q, u.r, g.center.q, g.center.r), d1 = hexDist(c.q, c.r, g.center.q, g.center.r);
            return this.cfg.goalBoost * this.orderValue * (d0 - d1) / Math.max(1, u.maxAp);
        }
        return 0;
    }

    // =====================================================================
    // Diplomacy (non-LLM): canned reply, no notes
    // =====================================================================
    async generateChatReply(otherPlayer, contextPrompt = null) {
        return { content: 'We have nothing to discuss at this time.', ended: true };
    }

    async summarizeChatAndAddNote(otherPlayer) {
        // no-op: this AI does not negotiate
    }
}
