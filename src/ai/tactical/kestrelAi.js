import { adjustedView, adjustedEntityView } from '../adjustedView.js';
import { BaseManager } from '../baseManager.js';

/**
 * KestrelAI - an economy-first tactical AI that actually uses its army.
 *
 * Why it exists: the scripted AIs build units for the score and then leave
 * them where they were built. Kestrel treats the army as a tool:
 *
 *  1. Economy. Every build is valued in one currency: the change in our own
 *     score points (T = cbrt(M * E * X), so a point on the weakest pillar is
 *     worth the most). Resources are priced by scarcity (stock plus horizon
 *     income), so deficits fix themselves. Builders that do not exist yet are
 *     reached through enabler chains. Nothing is keyed on entity names:
 *     capabilities come from getActions() and manifest attributes.
 *  2. Leader hunting. Rivals are ranked by score. The highest-score rival is
 *     the target even if it has no army near us: killing its structures and
 *     units lowers its score and, with a relative-score win condition, is how
 *     the game is actually won. Barbarians and anyone who attacks us are
 *     engaged when the local force balance allows.
 *  3. Army use. Combat units march as a group toward the best known target,
 *     focus fire, and fall back to rally cells when the odds are bad. When
 *     there is no target they hold rally cells at the border facing the
 *     nearest known enemy instead of idling in the production spot.
 *
 * Hard rules followed (spec.md, mistakes.md): no hardcoded unit, building,
 * terrain or resource names (only the "orders" pseudo-resource, hint 20);
 * visible enemies come from player.getOpponents(); positions are captured
 * before an action mutates them (mistake 12); every decision is logged with
 * reason, location and owner (hint 11); no imports of engine modules.
 */

const DEFAULT_CONFIG = {
    horizon: 15,            // turns over which yields, upkeep and extra orders are valued
    yieldDiscount: 0.55,    // share of the horizon a new yield is actually collected
    safetyRunway: 6,        // a build may not leave any resource with fewer turns of stock at its new net rate
    saveTurns: 5,           // reserve resources for the best unaffordable build if income pays for it within this many turns
    growth: 1.0,            // expected relative score growth per horizon; sets what a resource budget is worth
    chainDepth: 3,          // max depth of builder chains (hint 10)
    chainDiscount: 0.6,     // value kept per enabler step
    repairBelow: 0.55,      // heavily damaged fraction (hint 16)
    armyWeight: 0.1,        // value of closing the gap to the desired army power
    armyPerRound: 0.12,     // desired army power grows with the round (fraction of a mid unit per round)
    rivalPowerFactor: 1.3,  // desired army power relative to the strongest visible rival army
    leaderWeight: 1.0,      // value of one score point removed from the leading rival, relative to one of ours
    otherWeight: 0.5,       // ... removed from any other rival
    threatWeight: 1.5,      // value multiplier for hostiles that are near our structures
    marchRatio: 1.3,        // own army power must be this many times the estimated defence before marching on a target
    engageRatio: 0.9,       // local power ratio needed to take a fight
    guardValue: 0.015,      // value (fraction of T) of positioning a unit on its rally cell
    marchDrive: 0.35,       // value of a march step as a share of the target's value
    reserveOrders: 0,       // orders kept back (never spent)
    minCharges: 12,         // below this many build charges left across builders, another builder is valued (8-seed map-48 bench: 252 -> 265)
    capacityBoost: 1,
    exploreScale: 1,
    noDirectiveStance: 'offensive', // stance toward rivals when no director/config directive exists
    marchMinUnits: 4,       // army size before it marches out
    gatherRadius: 5,        // units further than this from the army centroid wait to regroup
    armyMapPower: 2.5,      // army weight scales with (48 / map radius)^power
    armyMapMax: 6,
    orderValue: 1,          // multiplier on the value of extra orders per turn
    walkPenalty: 0.9,       // site score divisor per extra builder turn of walking
    explorerWeight: 1,      // multiplier on the value of building another explorer
    builderRunway: 2,       // turns of stock a new builder (worker, settler) must leave, instead of safetyRunway
    armyRamp: 0,            // rounds over which the army bonus ramps up from zero (economy-first opening)
    verbose: 0,
    maxIterations: 70,
    exploreFraction: 0.6,   // share of the T-value one frontier explored is worth, tuned by score pillar
};

const NB = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const K = (q, r) => q + ',' + r;
const hexDist = (aq, ar, bq, br) => (Math.abs(aq - bq) + Math.abs(ar - br) + Math.abs(aq + ar - bq - br)) / 2;
const sid = (id) => String(id).split('_').pop();

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

export default class KestrelAI extends BaseManager {
    constructor(player, helper) {
        super(player, helper);
        const raw = player.controller?.config || {};
        this.cfg = { ...DEFAULT_CONFIG };
        for (const k of Object.keys(DEFAULT_CONFIG)) {
            const dv = DEFAULT_CONFIG[k];
            if (typeof raw[k] === typeof dv && (typeof dv !== 'number' || Number.isFinite(raw[k]))) this.cfg[k] = raw[k];
        }
        this.defs = null;
        this.mem = {
            seen: new Map(),        // foreign entity id -> {q, r, ownerId, name, round, mobile}
            attackedBy: new Map(),  // owner id (null = ownerless) -> last round it damaged us
            hazard: new Map(),      // cell key -> decaying count of hostile presence near our structures
            claimed: new Set(),     // exploration targets claimed this turn
            plans: new Map(),       // builder id -> {type, round}: a builder walking to a site keeps its job
        };
    }

    // ------------------------------------------------------------------ logging
    log(msg) {
        this.helper.aiLog(this.player, 'detail', `[Kestrel ${this.player.name} R${this.gameState.currentRound}] ${msg}`);
    }
    ownerName(id) {
        if (id === null || id === undefined) return 'ownerless';
        const p = (this.gameState.players || []).find(pl => pl.id === id);
        return p ? p.name : `player ${id}`;
    }
    label(u) { return `${u.name}#${sid(u.id)}@(${u.q},${u.r})[${this.ownerName(u.ownerId)}]`; }

    // ------------------------------------------------------------------ static data
    loadStatic() {
        const m = this.gameState.manifestData || {};
        this.rawDefs = plainCopy(m.entities || {});
        // Leader twists: the acting player's catalog comes through the Player value functions
        this.defs = {};
        for (const [n, d] of Object.entries(this.rawDefs)) {
            const a = adjustedView(this.player, d, n);
            this.defs[n] = a ? plainCopy(a) : d;
        }
        const names = new Set();
        for (const d of Object.values(this.defs)) {
            for (const f of ['spawnCost', 'maintenance', 'yields']) for (const r of Object.keys(d[f] || {})) names.add(r);
        }
        for (const r of Object.keys(plainCopy(this.player.resources || {}))) names.add(r);
        names.delete('orders'); // hint 20
        this.resNames = [...names];
        this.titles = new Map();
        // who can build what (static, from the manifest)
        this.builtBy = new Map();
        for (const [bn, d] of Object.entries(this.defs)) {
            for (const t of d.buildables || []) {
                if (!this.builtBy.has(t)) this.builtBy.set(t, []);
                this.builtBy.get(t).push(bn);
            }
        }
    }

    buildActionName(type) {
        if (!this.titles.has(type)) this.titles.set(type, `build ${this.helper.camelToTitle(type)}`.toLowerCase());
        return this.titles.get(type);
    }

    // ------------------------------------------------------------------ views
    view(e, own) {
        const base = this.rawDefs[e.name] || plainCopy(e.data || {});
        // visible entity instances, including rivals', expose their real-owner adjusted numbers
        let def = base;
        try { def = adjustedEntityView(e, base) || base; } catch (err) { def = base; }
        const v = {
            e, own, def, id: e.id, name: e.name, q: e.q, r: e.r,
            hp: e.health, maxHp: e.maxHealth, active: e.active,
            ap: e.actionPoints ?? 0, maxAp: e.maxActionPoints ?? 0,
            ownerId: e.owner ? e.owner.id : null,
            mobile: !!def.movement,
            dmg: def.damage?.value || 0,
            range: def.range ? (def.range.maxCells || 1) : 1,
        };
        if (own) {
            v.builds = new Map();
            for (const a of e.getActions()) {
                const n = a.name;
                if (n === 'Move') v.move = a;
                else if (n === 'Attack') v.attack = a;
                else if (n === 'Repair') v.repair = a;
                else if (n.startsWith('Build ')) v.builds.set(n.toLowerCase(), a);
            }
        }
        return v;
    }

    power(def, hp) {
        const d = def.damage?.value || 0;
        const armor = def.armor ? Object.values(def.armor).reduce((s, x) => s + x, 0) / Math.max(1, Object.keys(def.armor).length) : 1;
        return d * (hp ?? def.health ?? 1) * (1 + 0.25 * (armor - 1)) * (def.range ? 1.15 : 1);
    }


    // ------------------------------------------------------------------ per-turn refresh
    /** Timer for the verbose timing log; costs nothing when verbose is off. */
    now() { return this.cfg.verbose ? performance.now() : 0; }

    refresh() {
        const P = this.player, gs = this.gameState, round = gs.currentRound;
        this.mine = [];
        for (const e of P.getEntities()) if (!e.destroyed) this.mine.push(this.view(e, true));
        this.foreign = [];
        const opp = P.getOpponents() || {};
        for (const o of Object.values(opp)) for (const e of o.entities || []) if (!e.destroyed && e.health > 0) this.foreign.push(this.view(e, false));
        this.occ = new Map();
        for (const u of this.mine) this.occ.set(K(u.q, u.r), u);
        for (const f of this.foreign) this.occ.set(K(f.q, f.r), f);
        const visible = P.visibleCells;
        for (const f of this.foreign) {
            this.mem.seen.set(f.id, { q: f.q, r: f.r, ownerId: f.ownerId, name: f.name, round, mobile: f.mobile, def: f.def, hp: f.hp });
        }
        for (const [id, s] of this.mem.seen) {
            const k = K(s.q, s.r);
            const here = this.occ.get(k);
            if (visible.has(k) && (!here || here.id !== id)) this.mem.seen.delete(id);
            else if (s.mobile && round - s.round > 6) this.mem.seen.delete(id);
        }
        this.army = this.mine.filter(u => u.mobile && u.attack && this.isFighter(u.def) && !u.builds.size);
        this.armyIds = new Set(this.army.map(u => u.id));
        this.structs = this.mine.filter(u => !u.mobile);
        this.computeEconomy();
        this.rankRivals();
    }

    /** A mobile, non-building unit that is meant to fight: strong hit, or a military score near the top (keeps assassins in, scouts out). */
    isFighter(d) {
        if (!d || !d.movement || d.buildables?.length || !(d.damage?.value > 0)) return false;
        if (d.damage.value >= this.minArmyDamage()) return true;
        if (this._maxMil === undefined) {
            let mx = 0;
            for (const x of Object.values(this.defs)) if (x.movement && !(x.buildables?.length) && x.damage?.value > 0) mx = Math.max(mx, x.score?.military || 0);
            this._maxMil = mx;
        }
        return this._maxMil > 0 && (d.score?.military || 0) >= 0.5 * this._maxMil;
    }

    minArmyDamage() {
        if (this._minDmg === undefined) {
            let mx = 0;
            for (const d of Object.values(this.defs)) if (d.movement && d.damage?.value > mx && !(d.buildables?.length)) mx = d.damage.value;
            this._minDmg = Math.max(15, mx * 0.3);
        }
        return this._minDmg;
    }

    computeEconomy() {
        const P = this.player;
        const prof = P.getResourceProfile();
        const H = this.cfg.horizon;
        this.eco = { stock: {}, net: {}, S: {}, runway: {} };
        for (const r of this.resNames) {
            const st = prof.stock[r] || 0;
            const net = prof.netIncome[r] || 0;
            this.eco.stock[r] = st;
            this.eco.net[r] = net;
            this.eco.S[r] = Math.max(25, st + H * net);
        }
        const sc = P.score || {};
        this.M = Math.max(1, sc.military || 0);
        this.E = Math.max(1, sc.economic || 0);
        this.X = Math.max(1, sc.exploration || 0);
        this.T = Math.max(1, Math.cbrt(this.M * this.E * this.X));
        this.nRes = Math.max(1, this.resNames.length);
        this.budgetPts = this.cfg.growth * this.T / this.nRes; // points one full horizon budget of one resource is worth
        this.opt = Math.max(1, P.ordersPerTurn || 5);
    }

    rankRivals() {
        const me = this.player.id;
        const rivals = [];
        for (const p of this.gameState.players || []) {
            if (p.id === me) continue;
            const t = p.score?.total ?? 0;
            rivals.push({ id: p.id, score: t });
        }
        rivals.sort((a, b) => b.score - a.score);
        this.rivals = rivals;
        this.leaderId = rivals.length ? rivals[0].id : null;
        // target: the highest-score rival we know something about (else the highest)
        this.targetId = null;
        const eligible = rivals.filter(r => this.mayInitiate(r.id));
        for (const r of eligible) {
            for (const s of this.mem.seen.values()) if (s.ownerId === r.id) { this.targetId = r.id; break; }
            if (this.targetId !== null) break;
        }
        if (this.targetId === null && eligible.length) this.targetId = eligible[0].id;
    }

    // ------------------------------------------------------------------ valuation helpers
    scorePts(sm, se) { return (this.T / 3) * ((sm || 0) / this.M + (se || 0) / this.E); }

    resFrac(bundle) {
        let f = 0;
        for (const [r, v] of Object.entries(bundle || {})) if (this.eco.S[r] !== undefined) f += v / this.eco.S[r];
        return f;
    }

    // ------------------------------------------------------------------ turn
    async processTurn() {
        const P = this.player;
        if (!P || P.orders <= 0) return;
        if (!this.defs) this.loadStatic();
        this.failed = new Set();
        this.mem.claimed = new Set();
        this._dbgDone = false;
        this.pathCache = new Map();
        this.walkCache = new Map();
        this.siteCache = new Map();
        this._siteDirty = false;
        const round = this.gameState.currentRound;
        this.observeAttacks(round);
        const start = P.orders;
        this.tm = { refresh: 0, defendCands: 0, attackCands: 0, buildCands: 0, marchCands: 0, guardCands: 0, exploreCands: 0, repairCands: 0, exec: 0 };
        let iter = 0;
        while (P.orders > this.cfg.reserveOrders && iter++ < this.cfg.maxIterations) {
            const T0 = this.now();
            this.refresh();
            this.tm.refresh += this.now() - T0;
            if (this._siteDirty) { this.siteCache = new Map(); this._siteDirty = false; } // site search only changes when something was built
            const cands = [];
            { const t = this.now(); this.defendCands(cands); this.tm.defendCands += this.now() - t; }
            { const t = this.now(); this.attackCands(cands); this.tm.attackCands += this.now() - t; }
            { const t = this.now(); this.buildCands(cands); this.tm.buildCands += this.now() - t; }
            { const t = this.now(); this.marchCands(cands); this.tm.marchCands += this.now() - t; }
            { const t = this.now(); this.guardCands(cands); this.tm.guardCands += this.now() - t; }
            { const t = this.now(); this.exploreCands(cands); this.tm.exploreCands += this.now() - t; }
            { const t = this.now(); this.repairCands(cands); this.tm.repairCands += this.now() - t; }
            let best = null;
            for (const c of cands) {
                if (!(c.value > 0) || this.failed.has(c.key)) continue;
                c.priority = c.value / Math.max(1, c.orders);
                if (!best || c.priority > best.priority) best = c;
            }
            if (!best) break;
            const before = P.orders;
            const tx = this.now();
            try {
                await best.exec();
            } catch (err) {
                this.log(`ERROR executing ${best.key}: ${err?.message || err}`);
            }
            this.tm.exec += this.now() - tx;
            this.tm['x_' + best.kind] = (this.tm['x_' + best.kind] || 0) + this.now() - tx;
            if (!(P.orders < before)) { this.failed.add(best.key); if (best.kind === 'build') this._siteDirty = true; }
            else if (best.kind !== 'explore' && best.kind !== 'repair') this._siteDirty = true; // builds, moves and fights change occupancy and what sites exist
            if (P.orders < before) await this.helper.onActionDone(this.gameState, null, best.key);
        }
        const sc = P.score || {};
        if (this.cfg.verbose && round % this.cfg.verbose === 0) this.log(`timing ms (${iter} iters, army scale ${this.mapArmyScale().toFixed(2)}): ` + Object.entries(this.tm).map(([k, v]) => `${k} ${Math.round(v)}`).join(' | '));
        this.log(`turn end: used ${start - P.orders} of ${start} orders | army ${this.army ? this.army.length : 0} | target ${this.ownerName(this.targetId)} | score M${sc.military} E${sc.economic} X${sc.exploration} T${sc.total}`);
    }

    observeAttacks(round) {
        const P = this.player, gs = this.gameState;
        this.recentAttackers = new Set();
        for (const h of P.getHistoryRange(Math.max(1, round - 1), round) || []) {
            if (h.category !== 'damaged' || !h.extra?.attackerId) continue;
            this.recentAttackers.add(h.extra.attackerId);
            const att = gs.getEntityById(h.extra.attackerId);
            if (att) this.mem.attackedBy.set(att.owner ? att.owner.id : null, round);
        }
    }

    // ------------------------------------------------------------------ economy: builds
    /** Description of one build option: value in score points. */
    typeGain(type, extra = {}) {
        const d = this.defs[type];
        if (!d) return null;
        const H = this.cfg.horizon, disc = this.cfg.yieldDiscount;
        const gain = this.scorePts(d.score?.military, d.score?.economic);
        let yieldPts = 0, upkeepPts = 0;
        for (const [r, v] of Object.entries(extra.yields || d.yields || {})) {
            if (this.eco.S[r] === undefined) continue;
            // scarcer resources are worth more; a surplus resource is worth little
            const scarcity = Math.min(4, Math.max(0.3, 300 / Math.max(60, this.eco.stock[r] + 5 * Math.max(0, this.eco.net[r])))) * (this.boost?.[r] || 1);
            yieldPts += this.budgetPts * H * disc * v / this.eco.S[r] * scarcity;
        }
        for (const [r, v] of Object.entries(d.maintenance || {})) {
            if (this.eco.S[r] === undefined) continue;
            upkeepPts += this.budgetPts * H * v / this.eco.S[r];
        }
        const ordersPts = (d.ordersPerTurn || 0) * this.cfg.growth * this.T / this.opt * 0.8 * this.cfg.orderValue;
        let mil = 0;
        if (this.isFighter(d)) mil = this.armyBonus(type);
        else if (d.movement && !(d.buildables?.length) && !d.repairables && !this.isFighter(d)) mil = this.explorerBonus(d);
        const cost = this.budgetPts * this.resFrac(d.spawnCost) + this.cfg.growth * this.T / (this.cfg.horizon * this.opt);
        return { value: gain + yieldPts - upkeepPts + ordersPts + mil - cost, gain, yieldPts, upkeepPts, ordersPts, mil, cost };
    }

    /** Armies meet sooner on small maps, so a bigger army pays off there; on big maps it only costs economy. 1 at radius 48. */
    mapArmyScale() {
        if (this._mas === undefined) {
            const radius = Number(this.gameState.hexGrid?.radius) || 0;
            this._mas = radius > 0 ? Math.min(this.cfg.armyMapMax, Math.max(0.5, Math.pow(48 / radius, this.cfg.armyMapPower))) : 1;
        }
        return this._mas;
    }

    /** Unexplored share of the map (0..1). */
    unexploredFrac() {
        if (this._ufRound !== this.gameState.currentRound) {
            const total = Math.max(1, this.helper.getCellCount());
            this._uf = Math.max(0, 1 - this.player.exploredCells.size / total);
            this._ufRound = this.gameState.currentRound;
        }
        return this._uf;
    }

    /** Value of one exploration move, in score points. */
    exploreMovePts(maxAp, sight) {
        // X = cbrt(visible * explored): a move that reveals n new cells raises X by about (2/3) X n / explored
        const expl = Math.max(80, this.player.exploredCells.size);
        const fresh = 3.5 * (sight || 5) * (0.3 + this.unexploredFrac()) * Math.min(1.5, (maxAp || 5) / 6);
        return this.cfg.exploreScale * (this.T / 3) * (2 / 3) * fresh / expl;
    }

    /** Extra value of a mobile non-fighting, non-building unit that can explore. */
    explorerBonus(d) {
        let n = 0;
        for (const u of this.mine) if (u.mobile && !u.builds.size && !u.repair && !this.isFighter(u.def)) n++;
        return this.exploreMovePts(d.maxActionPoints, d.sightRange) * this.cfg.horizon * 0.4 * this.cfg.explorerWeight / (1 + n);
    }

    /** How much we want one more unit of this type in the army (0 when the army is big enough). */
    armyBonus(type) {
        const d = this.defs[type];
        const want = this.desiredArmyPower();
        let have = 0;
        for (const u of this.army) have += this.power(u.def, u.hp);
        const shortfall = Math.max(0, 1 - have / Math.max(1, want));
        if (shortfall <= 0) return 0;
        const share = Math.min(1, this.power(d, d.health) / Math.max(1, want));
        const ramp = this.cfg.armyRamp > 0 ? Math.min(1, (this.gameState.currentRound || 0) / this.cfg.armyRamp) : 1;
        return ramp * this.cfg.armyWeight * this.mapArmyScale() * shortfall * this.T * (0.1 + share);
    }

    desiredArmyPower() {
        if (this._want && this._wantRound === this.gameState.currentRound) return this._want;
        let ref = 0;
        for (const d of Object.values(this.defs)) if (this.isFighter(d)) ref = Math.max(ref, this.power(d, d.health));
        let enemy = 0;
        for (const f of this.foreign) if (f.mobile && this.isFighter(f.def)) enemy += this.power(f.def, f.hp);
        const round = this.gameState.currentRound;
        this._want = Math.max(ref * 1.5, this.cfg.rivalPowerFactor * enemy, ref * this.cfg.armyPerRound * round);
        this._wantRound = round;
        return this._want;
    }

    availableBuilders(type) {
        const out = [];
        const an = this.buildActionName(type);
        for (const u of this.mine) {
            if (!u.active || !u.builds.has(an)) continue;
            if (u.e.state?.buildCharges !== undefined && u.e.state.buildCharges <= 0) continue;
            out.push(u);
        }
        return out;
    }

    buildCands(out) {
        const P = this.player;
        const types = Object.keys(this.defs).filter(t => this.defs[t].spawnCost && !this.defs[t].spawnConditions?.noBuild);
        // option table
        let opts = new Map();
        const buildOpts = () => {
            const m = new Map();
            for (const t of types) {
                const g = this.typeGain(t);
                if (!g) continue;
                m.set(t, { type: t, g, builders: this.availableBuilders(t) });
            }
            return m;
        };
        this.boost = {};
        opts = buildOpts();
        // resources that block valuable builds are worth more: price them by the value of what they hold up
        {
            const blocked = {};
            let tot = 0;
            for (const [t, o] of opts) {
                if (!(o.g.value > 0) || !o.builders.length) continue;
                tot += o.g.value;
                for (const [r, v] of Object.entries(this.defs[t].spawnCost || {})) if ((this.eco.stock[r] || 0) < v) blocked[r] = (blocked[r] || 0) + o.g.value;
            }
            for (const [r, b] of Object.entries(blocked)) this.boost[r] = 1 + 2.5 * b / Math.max(1, tot);
            if (Object.keys(blocked).length) opts = buildOpts();
        }
        // enabler chains: types nobody can build now pass a share of their value to the types that lead to them
        const enabled = new Map();
        const enabledList = new Map();
        for (const [t, o] of opts) {
            if (o.builders.length || !(o.g.value > 0)) continue;
            const walk = (type, depth, val, seen) => {
                if (depth > this.cfg.chainDepth) return;
                for (const bn of this.builtBy.get(type) || []) {
                    if (seen.has(bn)) continue;
                    const bo = opts.get(bn);
                    if (!bo) continue;
                    const v2 = val * this.cfg.chainDiscount;
                    if (bo.builders.length) { if (!enabledList.has(bn)) enabledList.set(bn, []); enabledList.get(bn).push(v2); }
                    else walk(bn, depth + 1, v2, new Set([...seen, bn]));
                }
            };
            walk(t, 1, o.g.value, new Set([t]));
        }
        // a builder with limited charges is worth the sum of the best jobs it will do
        for (const [bn, list] of enabledList) {
            list.sort((a, b) => b - a);
            const charges = this.defs[bn]?.buildCharges;
            const k = Number.isFinite(charges) && charges > 0 ? charges : list.length;
            let sum = 0;
            for (let i = 0; i < Math.min(k, list.length); i++) sum += list[i];
            enabled.set(bn, sum);
        }
        // reserve: the best unaffordable build we can pay for soon
        const stock = this.eco.stock;
        const afford = (cost) => { for (const [r, v] of Object.entries(cost || {})) if ((stock[r] || 0) < v) return false; return true; };
        let saving = null;
        for (const [t, o] of opts) {
            const val = Math.max(o.g.value, enabled.get(t) || 0);
            if (!o.builders.length || !(val > 0) || afford(this.defs[t].spawnCost)) continue;
            let turns = 0, ok = true;
            for (const [r, v] of Object.entries(this.defs[t].spawnCost)) {
                const miss = v - (stock[r] || 0);
                if (miss <= 0) continue;
                const net = this.eco.net[r] || 0;
                if (net <= 0) { ok = false; break; }
                turns = Math.max(turns, miss / net);
            }
            if (ok && turns <= this.cfg.saveTurns && (!saving || val > saving.val)) saving = { type: t, val };
        }
        this.saving = saving;
        // critical resource: build a producer of it first
        const crit = this.criticalResources();

        const dbg = [];
        for (const [t, o] of opts) {
            if (!o.builders.length) { if (this.cfg.verbose) dbg.push(`${t}:nobuilder(${o.g.value.toFixed(0)}${enabled.get(t) ? '/ench' : ''})`); continue; }
            const d = this.defs[t];
            let val = Math.max(o.g.value, enabled.get(t) || 0);
            if (this.cfg.verbose) dbg.push(`${t}:${val.toFixed(1)}${afford(d.spawnCost) ? '' : '/poor'}${this.runwayOk(d, crit) ? '' : '/runway'}`);
            if (crit.size) {
                let helps = false;
                for (const r of Object.keys(d.yields || {})) if (crit.has(r)) helps = true;
                if (helps) val *= 3; else if (o.g.upkeepPts > 0) val *= 0.2;
            }
            // builder capacity: low on build charges means orders go idle; make more of the builder types
            if (d.movement && d.buildables?.length && this.chargesLeft() < this.cfg.minCharges) val = Math.max(val, 0) * this.cfg.capacityBoost + this.T * 0.05;
            if (!(val > 0)) continue;
            if (!afford(d.spawnCost)) continue;
            if (!this.runwayOk(d, crit)) continue;
            if (saving && saving.type !== t) {
                // do not eat what the saved-for build needs unless this one produces it
                const need = this.defs[saving.type].spawnCost;
                let conflict = false;
                for (const [r, v] of Object.entries(d.spawnCost)) if (need[r] && (stock[r] || 0) - v < need[r] && !(d.yields && d.yields[r])) conflict = true;
                if (conflict && val < saving.val * 1.5) continue;
            }
            const b = this.pickBuilder(o.builders, d, t);
            if (!b) continue;
            const site = this.siteFor(b, t);
            if (!site) continue;
            if (this.mem.plans.get(b.id)?.type === t && this.gameState.currentRound - this.mem.plans.get(b.id).round <= 3) val *= 1.4;
            // site quality (adjacent natural resources) scales the yield part; walking costs time
            val += o.g.yieldPts * (site.factor - 1) * Math.sign(val);
            val /= (1 + 0.5 * site.turns);
            if (!(val > 0)) continue;
            const orders = site.stage.path.length ? 2 : 1;
            if (this.cfg.verbose) dbg.push(`>${t}@${site.cell.q},${site.cell.r}=${val.toFixed(1)}`);
            out.push({
                kind: 'build', key: `build:${t}`, value: val, orders,
                exec: () => this.execBuild(b, t, val, site),
            });
        }
        if (this.cfg.verbose && this.gameState.currentRound % this.cfg.verbose === 0 && !this._dbgDone) { this._dbgDone = true; this.log(`options: ${dbg.join(' ')} | stock ${this.resNames.map(r => r + ' ' + Math.round(this.eco.stock[r]) + '/' + Math.round(this.eco.net[r])).join(' ')}`); }
    }

    /** Total build charges left across our mobile builders. */
    chargesLeft() {
        let n = 0;
        for (const u of this.mine) {
            if (!u.mobile || !u.builds.size) continue;
            const c = u.e.state?.buildCharges;
            n += Number.isFinite(c) ? c : 3;
        }
        return n;
    }

    criticalResources() {
        const out = new Set();
        for (const r of this.resNames) {
            const net = this.eco.net[r];
            if (net < 0 && this.eco.stock[r] + 6 * net < 0) out.add(r);
            else if (this.eco.stock[r] < 15 && net <= 0) out.add(r);
        }
        return out;
    }

    runwayOk(d, crit) {
        for (const r of this.resNames) {
            // only resources this build touches matter; an unrelated shortage must not freeze the build (it is how the shortage gets fixed)
            if (!(d.spawnCost?.[r] || d.yields?.[r] || d.maintenance?.[r])) continue;
            const after = (this.eco.net[r] || 0) + (d.yields?.[r] || 0) - (d.maintenance?.[r] || 0);
            if (after >= 0) continue;
            const left = (this.eco.stock[r] || 0) - (d.spawnCost?.[r] || 0);
            // a builder is how a shortage gets fixed (farms, mines), so it only has to stay afloat a couple of turns
            const runway = d.movement && d.buildables?.length ? this.cfg.builderRunway : this.cfg.safetyRunway;
            if (left + runway * after < 0) return false;
        }
        return true;
    }

    pickBuilder(builders, d, type) {
        let best = null, bs = -Infinity;
        for (const b of builders) {
            if (b.mobile && b.ap < Math.max(1.5, b.maxAp * 0.3)) continue;
            const plan = this.mem.plans.get(b.id);
            const fresh = plan && this.gameState.currentRound - plan.round <= 3;
            if (fresh && plan.type !== type) continue; // committed to walking to another site
            // committed builder first, then the one with the most AP; structures cost nothing to move
            let s = b.mobile ? b.ap : 3;
            if (fresh) s += 20;
            if (this.armyIds.has(b.id)) s -= 5;
            if (s > bs) { bs = s; best = b; }
        }
        return best;
    }

    stepCost(u, cell) {
        const tcs = u.e.terrainCostScale;
        const base = cell.terrain?.movementCost ?? 1;
        const sc = tcs && cell.terrain?.name in tcs ? tcs[cell.terrain.name] : 1;
        return base * sc;
    }

    /** Best site for builder b to build `type`: {cell, stage, turns, pathCost, factor} or null. Cached per refresh. */
    siteFor(b, type) {
        const key = `${b.id}:${type}:${b.q},${b.r}`;
        if (this.siteCache.has(key)) return this.siteCache.get(key);
        let best = null;
        const d = this.defs[type];
        const baseYield = Object.values(d.yields || {}).reduce((x, y) => x + y, 0) || 1;
        const maxDist = b.mobile ? Math.min(12, Math.ceil(b.maxAp * 2.2)) : 1;
        const res = this.helper.findBuildCandidates(this.gameState, b.e, type, maxDist);
        const cands = res.candidates;
        if (cands && cands.length) {
            let maxY = 0;
            for (const c of cands) if (c.yield > maxY) maxY = c.yield;
            const taken = new Set();
            for (const [id, pl] of this.mem.plans) if (id !== b.id && pl.q !== undefined && this.gameState.currentRound - pl.round <= 3) taken.add(K(pl.q, pl.r));
            for (const c of cands) {
                const ck = K(c.cell.q, c.cell.r);
                if (taken.has(ck)) continue;
                // keep away from foreign structures (their zone of control and towers)
                let near = false;
                for (const s of this.mem.seen.values()) if (s.ownerId !== this.player.id && hexDist(s.q, s.r, c.cell.q, c.cell.r) <= 3) { near = true; break; }
                if (near) continue;
                let pathCost = 0;
                const path = c.stage.path;
                for (let i = 0; i < path.length; i++) pathCost += this.stepCost(b, path[i]);
                const buildAp = b.mobile ? 1 : 0;
                const extra = b.mobile ? Math.max(0, pathCost + buildAp - b.ap) : 0;
                const turns = b.mobile ? Math.ceil(extra / Math.max(1, b.maxAp)) : 0;
                const factor = (c.yield || 1) / baseYield;
                let near2 = 0;
                for (const st of this.structs) { const dd = hexDist(st.q, st.r, c.cell.q, c.cell.r); if (dd < 12) near2 += 1; }
                const sc = (0.5 + 0.5 * (maxY > 0 ? (c.yield || 0) / maxY : 1)) / (1 + this.cfg.walkPenalty * turns) * (1 + Math.min(near2, 6) * 0.03);
                if (!best || sc > best.sc) best = { cell: c.cell, stage: c.stage, turns, pathCost, factor, sc };
            }
        }
        this.siteCache.set(key, best);
        return best;
    }

    async execBuild(b, type, value, site) {
        const P = this.player;
        const from = `(${b.q},${b.r})`;
        const cell = site.cell;
        const startCell = { q: b.e.q, r: b.e.r };
        let used = 0;
        const action = b.builds.get(this.buildActionName(type));
        const path = site.stage.path;
        if (path.length) {
            used += this.actions.moveAlongPath(b.e, b.move, path, 'build', `to build ${type} at (${cell.q},${cell.r})`);
            if (!used) { this.log(`BUILD ${type} by ${b.name}#${sid(b.id)} from ${from}: could not move toward (${cell.q},${cell.r})`); return 0; }
            if (this.helper.distance(b.e, cell) !== 1 || P.orders <= 0 || (b.e.actionPoints ?? 0) < 1) {
                this.mem.plans.set(b.id, { type, round: this.gameState.currentRound, q: cell.q, r: cell.r });
                this.log(`BUILD ${type} by ${b.name}#${sid(b.id)}: walking ${from} -> (${b.e.q},${b.e.r}) toward site (${cell.q},${cell.r}), ${site.turns} more turn(s) | value ${value.toFixed(1)}`);
                return used;
            }
            await this.helper.onActionDone(this.gameState, [startCell, b.e.cell], `in position to build ${type}`);
        }
        const chk = action.canDo(cell, null);
        if (chk?.possible && action.do(cell, null)) {
            used++;
            this.mem.plans.delete(b.id);
            this.log(`BUILD ${type} at (${cell.q},${cell.r}) by ${b.name}#${sid(b.id)} from ${from} | value ${value.toFixed(1)}${this.saving && this.saving.type !== type ? ` (saving for ${this.saving.type})` : ''}`);
        } else {
            this.log(`BUILD ${type} at (${cell.q},${cell.r}) by ${b.name}#${sid(b.id)} refused: ${chk?.reason}`);
        }
        return used;
    }

    // ------------------------------------------------------------------ combat
    /** Directive set by a director or the config (same lookup as the other tactical AIs), or null. */
    getDirective() {
        const controller = this.player.controller || {};
        const config = controller.config || {};
        return controller.directive || config.directive || config.aiDirective || null;
    }

    /** Stance toward a player: friendly/ally, neutral, caution, defensive, offensive. Ownerless = barbarians. */
    stanceOf(ownerId) {
        if (ownerId === null || ownerId === undefined) return 'defensive';
        const dir = this.getDirective();
        if (!dir) return this.cfg.noDirectiveStance; // no director: the configured default (aggressive by design)
        const map = dir.stance || {};
        return map[ownerId] || map[String(ownerId)] || 'neutral';
    }

    peaceful(ownerId) {
        const st = this.stanceOf(ownerId);
        return st === 'friendly' || st === 'ally';
    }

    /** May we start a fight with this owner? Only with an offensive stance; neutral is defence only. */
    mayInitiate(ownerId) {
        return ownerId !== null && this.stanceOf(ownerId) === 'offensive';
    }

    isHostile(f) {
        if (f.ownerId === null) return true; // barbarians and other ownerless units
        if (this.peaceful(f.ownerId)) return false; // a negotiated peace is never broken
        if (this.mayInitiate(f.ownerId) && (f.ownerId === this.targetId || f.ownerId === this.leaderId)) return true;
        const last = this.mem.attackedBy.get(f.ownerId);
        if (last !== undefined && this.gameState.currentRound - last <= 6) return true;
        return false;
    }

    targetPts(f) {
        const sc = this.scorePts(f.def.score?.military, f.def.score?.economic);
        let w = f.ownerId === null ? 0.3 : (f.ownerId === this.leaderId ? this.cfg.leaderWeight : this.cfg.otherWeight);
        let v = sc * w;
        // threat removal: a unit that can hurt us is worth killing even if its score is small
        if (f.mobile && f.dmg > 0) v += this.cfg.threatWeight * this.threatNear(f) * this.T * 0.02 * (f.dmg * f.hp / 6000);
        if (!f.mobile && f.def.ordersPerTurn) v += f.def.ordersPerTurn * this.cfg.growth * this.T / this.opt * 0.5;
        if (!f.mobile && f.def.yields) v += this.budgetPts * 4 * 0.2;
        return v;
    }

    /** Hostile unit near any of our structures or units counts for more. */
    threatNear(f) {
        let best = Infinity;
        for (const s of this.structs) { const d = hexDist(f.q, f.r, s.q, s.r); if (d < best) best = d; }
        if (best === Infinity) return 1;
        const reach = (f.def.movement ? f.maxAp : 0) / 1 + (f.def.range ? f.def.range.maxCells : 1);
        return best <= reach + 1 ? 2 : best <= reach * 2 ? 1 : 0.3;
    }

    localPower(q, r, rad, ownerSide) {
        let p = 0;
        const list = ownerSide === 'mine' ? this.mine : this.foreign;
        for (const u of list) {
            if (!u.dmg) continue;
            if (ownerSide === 'mine' && !this.armyIds.has(u.id)) continue;
            if (hexDist(u.q, u.r, q, r) <= rad) p += this.power(u.def, u.hp);
        }
        return p;
    }

    hitDamage(u, t) {
        const dmg = u.def.damage || {};
        const armor = (t.def.armor || {})[dmg.type] || 1;
        return ((dmg.value || 0) + (dmg.lifeFraction || 0) * t.hp) / armor;
    }

    /** Can this unit walk to (q,r) at all (any number of turns)? Cached per turn. Water or mountain barriers make a rival unreachable for land units. */
    walkable(u, q, r) {
        const key = `${u.name}:${u.q},${u.r}>${q},${r}`;
        if (!this.walkCache) this.walkCache = new Map();
        if (this.walkCache.has(key)) return this.walkCache.get(key);
        let ok = false;
        try {
            const cell = this.helper.getCell(q, r);
            const res = cell && this.helper.movementCostTo(u.e.cell, cell, u.e.getMovementCost.bind(u.e), { allowDetours: true });
            const last = res && res.path && res.path[res.path.length - 1];
            ok = !!last && last.q === q && last.r === r;
        } catch (err) { ok = false; }
        this.walkCache.set(key, ok);
        return ok;
    }

    /** Estimated AP cost to attack `t` (move adjacent/in range + first hit). null if clearly out of reach this turn. */
    reachInfo(u, t) {
        const ck = `${u.id}:${t.id}:${u.q},${u.r}:${u.ap}:${Math.round(t.hp)}`;
        if (this.pathCache.has(ck)) return this.pathCache.get(ck);
        let info = null;
        const dist = hexDist(u.q, u.r, t.q, t.r);
        const lo = u.def.range ? (u.def.range.minCells || 1) : 1;
        const hi = u.range;
        const scale = u.def.attackCostScale ?? 1;
        const maxSteps = (u.def.movement ? u.ap : 0) + hi;
        // the (expensive) walkability pathfind runs only for targets already within a turn's reach
        if (dist <= maxSteps + 1 && !u.def.range && dist > 1 && !this.walkable(u, t.q, t.r)) { this.pathCache.set(ck, null); return null; }
        if (dist <= maxSteps + 1) {
            if (dist >= lo && dist <= hi) {
                const cost = Math.ceil(scale * dist);
                if (cost <= u.ap) info = { cost, move: 0, hits: Math.max(1, this.hitsAt(u, dist, u.ap)) };
            } else if (u.def.movement) {
                // optimistic: hex steps at average terrain cost 1.2 per cell to get in range
                const steps = Math.max(0, dist - hi);
                const est = steps * 1.2;
                const left = u.ap - est;
                const hitCost = Math.ceil(scale * (u.def.range ? Math.min(hi, dist - steps) : 1));
                if (left >= hitCost) info = { cost: est + hitCost, move: 1, hits: Math.max(1, this.hitsAt(u, u.def.range ? hi : 1, left)) };
            }
        }
        this.pathCache.set(ck, info);
        return info;
    }

    hitsAt(u, d, ap) {
        const scale = u.def.attackCostScale ?? 1;
        let n = 0, spent = 0;
        const ex = u.e.state?.battleExhaustion ?? 1;
        for (let k = ex; n < 6; k++) {
            const c = Math.ceil(scale * k * Math.max(1, d));
            if (spent + c > ap) break;
            spent += c; n++;
        }
        return n;
    }

    attackCands(out) {
        const targets = this.foreign.filter(f => this.isHostile(f));
        if (!targets.length || !this.army.length) return;
        const attackers = this.army.filter(u => u.active && u.ap > 0);
        const P = this.player;
        for (const t of targets) {
            const tv = this.targetPts(t);
            if (!(tv > 0)) continue;
            // local balance around the target: our nearby army vs their units close to it
            const mineNear = this.localPower(t.q, t.r, 6, 'mine');
            let theirs = 0;
            for (const f of this.foreign) {
                if (f.dmg > 0 && hexDist(f.q, f.r, t.q, t.r) <= 5) theirs += this.power(f.def, f.hp);
            }
            if (theirs > 0 && mineNear < this.cfg.engageRatio * theirs && !this.defending(t)) continue;
            const plans = [];
            let team = 0;
            for (const u of attackers) {
                const info = this.reachInfo(u, t);
                if (!info) continue;
                const dmg = this.hitDamage(u, t) * info.hits;
                team += dmg;
                plans.push({ u, info, dmg });
            }
            const kill = team >= t.hp;
            for (const p of plans) {
                const share = kill ? Math.min(1, p.dmg / Math.max(1, t.hp)) * 1 + 0.15 : 0.5 * p.dmg / Math.max(1, t.hp);
                const value = tv * share + (kill ? tv * 0.25 : 0);
                const orders = Math.min(p.info.hits + p.info.move, P.orders);
                out.push({
                    kind: 'attack', key: `attack:${p.u.id}:${t.id}`, value, orders: Math.max(1, orders),
                    exec: () => this.execAttack(p.u, t, Math.max(1, orders), value, team),
                });
            }
        }
    }

    defending(t) {
        // a hostile that is hurting us or sits next to our structures gets attacked even at poor odds
        if (this.recentAttackers && this.recentAttackers.has(t.id)) return true;
        for (const s of this.structs) if (hexDist(s.q, s.r, t.q, t.r) <= 2) return true;
        return false;
    }

    async execAttack(u, t, orders, value, team) {
        const from = `(${u.q},${u.r})`;
        const hpBefore = t.e.health;
        let dbg = '';
        if (this.cfg.verbose) {
            const pr = this.helper.movementCostTo(u.e.cell, t.e.cell, u.e.getMovementCost.bind(u.e), { allowDetours: true });
            dbg = ` [path ${pr && pr.path ? pr.path.length + ' cells cost ' + Math.round(pr.cost ?? pr.totalCost ?? -1) : 'none'}, target terrain ${t.e.cell?.terrain?.name}]`;
        }
        const res = await this.actions.attack(u.e, t.e, orders);
        this.log(`ATTACK ${this.label(t)} with ${u.name}#${sid(u.id)} from ${from} (value ${value.toFixed(1)}, team est. ${Math.round(team)} vs ${Math.round(hpBefore)} hp): ${res?.result?.message} [hp ${Math.round(hpBefore)} -> ${t.e.destroyed ? 0 : Math.round(t.e.health)}]${dbg}`);
        return res?.ordersUsed || 0;
    }

    /** Own units attacked this turn: pull a damaged unit back to repair. Placeholder hook for future retreat logic. */
    defendCands(out) { /* covered by attackCands (defending bonus) and guardCands */ }

    // ------------------------------------------------------------------ marching on the target
    knownTargets() {
        const out = [];
        for (const s of this.mem.seen.values()) {
            if (s.ownerId === null || s.ownerId !== this.targetId) continue;
            out.push(s);
        }
        return out;
    }

    centroid(list) {
        let q = 0, r = 0;
        for (const u of list) { q += u.q; r += u.r; }
        return list.length ? { q: Math.round(q / list.length), r: Math.round(r / list.length) } : null;
    }

    marchCands(out) {
        if (this.army.length < this.cfg.marchMinUnits) return; // lone units trickling in die piecemeal
        const probe = this.army.find(u => u.move);
        const known = this.knownTargets().filter(k => !probe || probe.def.range || this.walkable(probe, k.q, k.r));
        if (!known.length) return;
        const c = this.centroid(this.army);
        // choose the target site by value per distance
        let best = null;
        const rate = (s) => {
            const def = s.def || this.defs[s.name] || {};
            const val = this.targetPts({ def, ownerId: s.ownerId, mobile: !!def.movement, dmg: def.damage?.value || 0, hp: s.hp ?? def.health ?? 1, q: s.q, r: s.r, maxAp: def.maxActionPoints || 0 });
            const dist = hexDist(c.q, c.r, s.q, s.r);
            return { s, val, dist, sc: val / (3 + dist) };
        };
        for (const s of known) {
            const r = rate(s);
            if (!best || r.sc > best.sc) best = r;
        }
        if (!best) return;
        // commitment: keep the site chosen last time while the push is on, so the group does not dither between targets
        const round = this.gameState.currentRound;
        const pushing = this.mem.march && round - this.mem.march.round <= 6;
        if (pushing) {
            const keep = known.find(k => k.q === this.mem.march.q && k.r === this.mem.march.r);
            if (keep) best = rate(keep); // re-score the kept site so value and priority describe the site we actually march on
        }
        // estimated defence at the target
        let defence = 0;
        for (const s of known) {
            if (hexDist(s.q, s.r, best.s.q, best.s.r) > 6) continue;
            const def = s.def || this.defs[s.name] || {};
            if (def.damage?.value) defence += this.power(def, s.hp ?? def.health);
        }
        let have = 0;
        for (const u of this.army) have += this.power(u.def, u.hp);
        this.marchTarget = best.s;
        if (best.dist <= 1) return;
        if (have < (pushing ? 0.8 : 1) * this.cfg.marchRatio * defence) return;
        // healthy units only
        const ready = this.army.filter(u => u.active && u.move && u.ap >= u.maxAp * 0.6 && u.hp >= u.maxHp * 0.5 && hexDist(u.q, u.r, best.s.q, best.s.r) > 1 && hexDist(u.q, u.r, c.q, c.r) <= this.cfg.gatherRadius);
        if (ready.length < Math.max(2, Math.ceil(this.army.length * (pushing ? 0.4 : 0.6)))) return;
        const slow = Math.min(...ready.map(u => u.maxAp));
        const value = this.cfg.marchDrive * best.val * Math.min(1, best.dist / 6 + 0.3);
        // one candidate per unit: the whole group moves, value spread over its units
        const per = value / ready.length * 1.4;
        for (const u of ready) {
            out.push({
                kind: 'march', key: `march:${u.id}`, value: per, orders: 1,
                exec: () => this.execMarch(u, best.s, c, slow, per),
            });
        }
    }

    async execMarch(u, goal, centroid, slow, value) {
        const from = `(${u.q},${u.r})`;
        const goalCell = this.helper.getCell(goal.q, goal.r);
        if (!goalCell) return 0;
        const res = this.helper.movementCostTo(u.e.cell, goalCell, u.e.getMovementCost.bind(u.e), { allowDetours: true });
        if (!res || !res.path || res.path.length < 2) return 0;
        // do not outrun the group: stop within `slow` AP of the group centroid
        const path = [];
        for (let i = 1; i < res.path.length; i++) {
            const cell = res.path[i];
            if (cell.q === goal.q && cell.r === goal.r) break;
            const d = hexDist(cell.q, cell.r, centroid.q, centroid.r);
            if (d > slow + 1 && path.length) break;
            path.push(cell);
        }
        if (!path.length) return 0;
        const used = this.actions.moveAlongPath(u.e, u.move, path, 'combat', `marching on ${this.ownerName(goal.ownerId)} ${goal.name} at (${goal.q},${goal.r})`);
        if (used) this.mem.march = { round: this.gameState.currentRound, q: goal.q, r: goal.r };
        if (used) this.log(`MARCH ${u.name}#${sid(u.id)} ${from} -> (${u.e.q},${u.e.r}) toward ${this.ownerName(goal.ownerId)} ${goal.name}@(${goal.q},${goal.r}) value ${value.toFixed(2)}`);
        return used;
    }

    // ------------------------------------------------------------------ guarding: rally cells at the border
    rallyCells() {
        if (this._rallyRound === this.gameState.currentRound && this._rally) return this._rally;
        const cells = [];
        const home = this.structs.filter(s => s.def.score && (s.def.score.economic || s.def.ordersPerTurn));
        if (!home.length) { this._rally = cells; this._rallyRound = this.gameState.currentRound; return cells; }
        // anchor: where enemies come from (known enemy sites / recent hostiles), else map-wide away from home centroid
        const hc = this.centroid(home);
        let ax = null, ay = null, n = 0;
        for (const s of this.mem.seen.values()) {
            if (s.ownerId !== null && s.ownerId !== this.targetId && !this.mem.attackedBy.has(s.ownerId)) continue;
            ax = (ax ?? 0) + s.q; ay = (ay ?? 0) + s.r; n++;
        }
        const anchor = n ? { q: ax / n, r: ay / n } : null;
        const seen = new Set();
        for (const s of home) {
            for (let dq = -3; dq <= 3; dq++) {
                for (let dr = Math.max(-3, -dq - 3); dr <= Math.min(3, -dq + 3); dr++) {
                    const q = s.q + dq, r = s.r + dr, k = K(q, r);
                    if (seen.has(k) || this.occ.has(k)) continue;
                    seen.add(k);
                    if (!this.player.isExplored(q, r)) continue;
                    const cell = this.helper.getCell(q, r);
                    if (!cell || !cell.terrain) continue;
                    let sc = 0;
                    const dh = hexDist(q, r, s.q, s.r);
                    sc -= Math.abs(dh - 2) * 0.5;
                    if (anchor) sc -= hexDist(q, r, anchor.q, anchor.r) * 0.35;
                    else sc += hexDist(q, r, hc.q, hc.r) * 0.1;
                    sc += (cell.terrain.height ?? 0) * 0.3;
                    cells.push({ q, r, k, sc, cell });
                }
            }
        }
        cells.sort((a, b) => b.sc - a.sc);
        this._rally = cells.slice(0, 40);
        this._rallyRound = this.gameState.currentRound;
        return this._rally;
    }

    guardCands(out) {
        if (!this.army.length) return;
        const rally = this.rallyCells();
        if (!rally.length) return;
        const taken = new Set();
        // units already standing on a rally cell keep it
        const idle = [];
        for (const u of this.army) {
            if (!u.active || !u.move || u.ap < 1) continue;
            if (this.mem.march && this.gameState.currentRound - this.mem.march.round <= 2 && u.hp >= u.maxHp * 0.5) continue; // on a push
            const here = K(u.q, u.r);
            if (rally.some(c => c.k === here)) { taken.add(here); continue; }
            idle.push(u);
        }
        const pts = this.cfg.guardValue * this.T;
        for (const u of idle) {
            // the best free rally cell that is not too far
            let pick = null;
            for (const c of rally) {
                if (taken.has(c.k) || this.occ.has(c.k)) continue;
                const d = hexDist(u.q, u.r, c.q, c.r);
                const s = c.sc - d * 0.15;
                if (!pick || s > pick.s) pick = { c, s };
            }
            if (!pick) continue;
            taken.add(pick.c.k);
            const dist = hexDist(u.q, u.r, pick.c.q, pick.c.r);
            const val = pts * (this.mem.attackedBy.size ? 1.5 : 1) * Math.min(1.5, 0.5 + dist / 4);
            out.push({
                kind: 'guard', key: `guard:${u.id}`, value: val, orders: 1,
                exec: () => this.execGuard(u, pick.c, val),
            });
        }
    }

    async execGuard(u, c, value) {
        const from = `(${u.q},${u.r})`;
        const res = this.helper.movementCostTo(u.e.cell, c.cell, u.e.getMovementCost.bind(u.e), { allowDetours: true });
        if (!res || !res.path || res.path.length < 2) return 0;
        const used = this.actions.moveAlongPath(u.e, u.move, res.path.slice(1), 'combat', `taking up guard position at (${c.q},${c.r})`);
        if (used) this.log(`GUARD ${u.name}#${sid(u.id)} ${from} -> (${u.e.q},${u.e.r}) rally (${c.q},${c.r}) value ${value.toFixed(2)}`);
        return used;
    }

    // ------------------------------------------------------------------ exploration
    exploreCands(out) {
        const explorers = this.mine.filter(u => u.active && u.mobile && u.move && u.ap >= 2 && !u.builds.size && !this.armyIds.has(u.id));
        // fast, lightly armed units explore; army units explore only when no enemy is known and nothing else wants them
                for (const u of explorers) {
            out.push({
                kind: 'explore', key: `explore:${u.id}`, value: this.exploreMovePts(u.maxAp, u.def.sightRange), orders: 1,
                exec: () => this.execExplore(u),
            });
        }
        if (!this.knownTargets().length) {
            for (const u of this.army) {
                if (!u.active || !u.move || u.ap < 3) continue;
                out.push({
                    kind: 'explore', key: `explore:${u.id}`, value: this.exploreMovePts(u.maxAp, u.def.sightRange) * 0.7, orders: 1,
                    exec: () => this.execExplore(u),
                });
            }
        }
    }

    async execExplore(u) {
        const from = `(${u.q},${u.r})`;
        // the treasure mode scans every map cell through the proxy; do it once per turn, not per explorer
        const scanTreasure = this._treasureRound !== this.gameState.currentRound;
        this._treasureRound = this.gameState.currentRound;
        const res = this.actions.explore(u.e, null, scanTreasure, this.mem.claimed);
        this.log(`EXPLORE ${u.name}#${sid(u.id)} from ${from}: ${res?.result?.message}`);
        return res?.ordersUsed || 0;
    }

    // ------------------------------------------------------------------ repair
    repairCands(out) {
        const healers = this.mine.filter(u => u.active && u.repair && u.ap > 0);
        if (!healers.length) return;
        const damaged = this.mine.filter(u => u.hp < u.maxHp * this.cfg.repairBelow || (!u.mobile && u.hp < u.maxHp * 0.95 && u.def.yields));
        for (const t of damaged) {
            const val = this.scorePts(t.def.score?.military, t.def.score?.economic) * 0.6 + this.cfg.guardValue * this.T;
            for (const h of healers) {
                if (h.id === t.id) continue;
                const repairables = h.def.repairables || [];
                if (!repairables.some(n => n.toLowerCase() === t.name.toLowerCase())) continue;
                if (hexDist(h.q, h.r, t.q, t.r) > h.ap + 1) continue;
                out.push({
                    kind: 'repair', key: `repair:${h.id}:${t.id}`, value: val, orders: 2,
                    exec: async () => {
                        const from = `(${h.q},${h.r})`;
                        const res = await this.actions.support(h.e, t.e, 'Repair', 2);
                        this.log(`REPAIR ${t.name}#${sid(t.id)}@(${t.q},${t.r}) by ${h.name}#${sid(h.id)} from ${from}: ${res?.result?.message}`);
                        return res?.ordersUsed || 0;
                    },
                });
            }
        }
    }

    // ------------------------------------------------------------------ chat / trade (universal interface)
    async generateChatReply(otherPlayer, contextPrompt = null) {
        return { content: `${this.player.name} has nothing to discuss right now.`, ended: true };
    }
    async summarizeChatAndAddNote(otherPlayer) { }
}
