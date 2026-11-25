/**
 * AiHelper - Engine bridge and utility helper.
 *
 * The engine creates one instance per game and passes it to AI managers. It is
 * the AI module's only channel to engine features: instead of importing
 * HexGrid, CONFIG, renderer, etc., AI code calls methods on this class.
 *
 * It also owns the read-only/pathfinding utilities (formerly in
 * `src/ai/aiUtils.js`) and the engine-level chat/trade helpers. Action
 * composites (attack/build/support/explore/moveAlongPath) live in
 * `src/ai/actions.js` because they are AI code and must use the AI proxy's
 * action.do() pacing.
 */
import { HexGrid, DIRECTIONS_8 } from './hexGrid.js';
import { camelToTitle, sleep, calculateAttackMultiplier, formatResourceBundle } from './utils.js';
import { applyResourceYieldBonus } from './resources.js';
import Entity from './entity.js';
import { CONFIG } from './config.js';

/** Minimum rounds between AI-initiated trade proposals by the same player. */
const TRADE_PROPOSAL_COOLDOWN_ROUNDS = 4;

const LOG_STYLES = {
    turn: 'color: #3498db; font-weight: bold;',
    econ: 'color: #f39c12;',
    build: 'color: #2ecc71;',
    explore: 'color: #1abc9c;',
    combat: 'color: #e74c3c; font-weight: bold;',
    warn: 'color: #e67e22; font-weight: bold;',
    detail: 'color: #95a5a6;'
};

export class AiHelper {
    /**
     * @param {Object} gameState - The active GameState (used for hexGrid access)
     */
    constructor(gameState) {
        this.gameState = gameState;
        // Phase 26: round of the last AI-initiated trade proposal, per
        // player id (see maybeInitiateTrade). Lives on the helper because
        // the policy does — one helper serves every manager in the game.
        this._tradeProposalRoundByPlayer = new Map();
        // Build-site caches (issue #72), keyed by hex grid so a loaded or
        // replayed game (new grid object) never sees stale entries:
        // - _buildPotentialByGrid: grid -> Map<typeName, Map<cellKey,
        //   {potential, fingerprint}>> — static per-(type, cell) expected
        //   yield, validated against adjacent natural resources.
        // - _cellOrderByGrid: grid -> Map<cellKey, index> — getCellsArray()
        //   order, used to keep candidate ordering identical to the old
        //   full-map scan (callers' tie-breaking depends on it).
        this._buildPotentialByGrid = new WeakMap();
        this._cellOrderByGrid = new WeakMap();
    }

    // ==================== Engine bridge: hex grid ====================

    /** @returns {Object} */
    getGameState() {
        return this.gameState;
    }

    /**
     * Hex distance between two coordinates or entities.
     * @param {{q:number,r:number}|{cell:{q:number,r:number}}} a
     * @param {{q:number,r:number}|{cell:{q:number,r:number}}} b
     * @returns {number}
     */
    distance(a, b) {
        const ac = a.cell || a;
        const bc = b.cell || b;
        return HexGrid.distance(ac, bc);
    }

    /** @returns {Array<Object>} neighboring cells */
    getNeighbors(q, r) {
        return this.gameState.hexGrid.getNeighbors(q, r);
    }

    /** @returns {Array<Object>} all cells */
    getCellsArray() {
        return this.gameState.hexGrid.getCellsArray();
    }

    /** @returns {Object} cell */
    getCell(q, r) {
        return this.gameState.hexGrid.getCell(q, r);
    }

    /** @returns {number} number of cells on the map */
    getCellCount() {
        return this.gameState.hexGrid?.cells?.size ?? 0;
    }

    /** @returns {Object|string} direction from one cell to another */
    directionTo(fromCell, toCell, asName = false) {
        return this.gameState.hexGrid.directionTo(fromCell, toCell, asName);
    }

    /**
     * Count the cells this player has not explored yet, by their axial
     * direction as seen from `originCell` (E, NE, NW, W, SW, SE).
     *
     * Explorer heuristics need a per-direction histogram, which used to be one
     * proxied directionTo() per cell — on a 128 map with ~49k unexplored cells
     * that is ~49k proxied calls per explorer per turn, each allocating. This
     * runs the whole scan engine-side over the raw grid, so it is one call and
     * no cell array ever crosses the proxy.
     *
     * @param {{q:number,r:number}} originCell
     * @param {number|string} ownPlayerId
     * @returns {{E:number,NE:number,NW:number,W:number,SW:number,SE:number}}
     */
    countUnexploredByDirection(originCell, ownPlayerId) {
        const counts = { E: 0, NE: 0, NW: 0, W: 0, SW: 0, SE: 0 };
        const grid = this.gameState?.hexGrid;
        const player = this.gameState?.players?.find(p => String(p.id) === String(ownPlayerId));
        if (!grid || !originCell || !player) return counts;
        for (const cell of grid.cells.values()) {
            if (!cell || player.isExplored(cell.q, cell.r)) continue;
            const name = HexGrid.directionName(originCell, cell);
            if (name in counts) counts[name] += 1;
        }
        return counts;
    }

    /** @returns {Object|null} movement cost path between two cells */
    movementCostTo(fromCell, toCell, costFunc, options) {
        return this.gameState.hexGrid.movementCostTo(fromCell, toCell, costFunc, options);
    }

    /** @returns {Object} sight/trajectory info between two cells */
    getSightAndTrajectory(fromCell, toCell) {
        return this.gameState.hexGrid.getSightAndTrajectory(fromCell, toCell);
    }

    // ==================== Engine bridge: config & constants ====================

    /** @returns {Object} AI config values */
    getConfig() {
        return {
            buildMaxDistance: CONFIG.AI_BUILD_MAX_DISTANCE ?? 10,
            buildDistancePenalty: CONFIG.AI_BUILD_DISTANCE_PENALTY ?? 0.2,
            actionSleepMs: CONFIG.AI_ACTION_SLEEP ?? 500,
            showAll: CONFIG.SHOW_ALL ?? false,
        };
    }

    /** @returns {string[]} the 8 compass direction names */
    getDirections8() {
        return DIRECTIONS_8;
    }

    // ==================== Engine bridge: callbacks ====================

    /** Sleep for the given milliseconds. */
    async sleep(ms) {
        await sleep(ms);
    }

    /** Calculate the attack multiplier for a combat action. */
    calculateAttackMultiplier(gameState, sourceCell, elevationAdjustment, targetEntity, attackerEntity) {
        return calculateAttackMultiplier(gameState, sourceCell, elevationAdjustment, targetEntity, attackerEntity);
    }

    /** Apply the resource yield bonus for a construct on a cell. */
    applyResourceYieldBonus(entity, baseYields, gameState) {
        return applyResourceYieldBonus(entity, baseYields, gameState);
    }

    /** Convert camelCase to Title Case. */
    camelToTitle(text) {
        return camelToTitle(text);
    }

    /** Format a resource bundle map (e.g. { gold: 5 }) for prompts/logs. */
    formatResourceBundle(bundle) {
        return formatResourceBundle(bundle);
    }

    /** Create a new entity instance. */
    createEntity(meta, owner, gameState, cell, initialState = null) {
        return new Entity(meta, owner, gameState, cell, initialState);
    }

    /** Styled AI logging. */
    aiLog(player, category, message) {
        const pName = (typeof player === 'string' ? player : player?.name) || 'AI';
        console.debug(`%c[AI ${pName}][${category}] ${message}`, LOG_STYLES[category] || '');
    }

    // ==================== AI logic: reachability & build sites ====================

    /**
     * BFS from the unit's cell across traversable hexes.
     *
     * The returned entries carry `dist` (hop count from the start) so callers
     * can derive sub-ranges (e.g. a strike set) from one BFS instead of
     * re-running the walk.
     * @returns {Map<string, {cell: Object, dist: number, path: Array<Object>}>}
     */
    findReachableCells(gameState, unit, maxDistance = Infinity) {
        const reachable = new Map();
        if (!this.gameState?.hexGrid || !unit) return reachable;
        const startCell = unit.cell || this.gameState.hexGrid.getCell(unit.q, unit.r);
        if (!startCell) return reachable;
        const maxAP = unit.maxActionPoints ?? unit.actionPoints ?? Infinity;
        const startKey = `${unit.q},${unit.r}`;

        // Hoisted out of the neighbour loop (Shahin, 2026-11-23): through the
        // AI proxy every property read and call is a wrapper lookup, so
        // `unit.terrainCostScale` and `unit.getMovementCost` were paying that
        // per neighbour. `getMovementCost(cell)` returns Infinity only when the
        // unit is a construct, the terrain scale is null (impassable), or the
        // owner cannot currently see the cell — the numeric result was already
        // being discarded, so for OUR OWN units evaluate that predicate
        // directly.
        //
        // Foreign units are different: the proxy hides their `owner`, and
        // `getMovementCost` evaluates visibility against the engine-side owner
        // (the enemy's own sight), not ours. Keep the proxied call for those so
        // the threat model is bit-identical to the engine.
        const tcs = unit.terrainCostScale;
        const owner = unit.owner;
        const canSee = owner && typeof owner.isVisible === 'function' ? owner.isVisible.bind(owner) : null;
        const isConstruct = !!unit.isConstruct;

        // Parent pointers + an index queue instead of queue.shift() and
        // copying the whole path for every neighbor. Paths are built lazily
        // only for entries a caller actually reads.
        const nodes = new Map();
        nodes.set(startKey, { cell: startCell, parentKey: null, dist: 0 });
        const queue = [startKey];
        let head = 0;
        while (head < queue.length) {
            const curKey = queue[head++];
            const cur = nodes.get(curKey);
            if (!cur || cur.dist >= maxDistance) continue;
            const curCell = cur.cell;
            for (const nb of this.getNeighbors(curCell.q, curCell.r)) {
                const key = `${nb.q},${nb.r}`;
                if (nodes.has(key)) continue;
                if (isConstruct) continue;
                const terrain = nb.terrain;
                const terrainName = terrain?.name;
                const scaled = tcs && (terrainName in tcs);
                if (scaled && tcs[terrainName] === null) continue;
                if (canSee) {
                    if (!canSee(nb.q, nb.r)) continue;
                } else if (!Number.isFinite(unit.getMovementCost(nb))) {
                    continue;
                }
                const baseMc = terrain?.movementCost ?? 1;
                const tScale = scaled ? tcs[terrainName] : 1;
                if ((baseMc * tScale) > maxAP) continue;
                const occupant = gameState.getEntityAt(nb.q, nb.r);
                // Compare by id (see canStageFrom): through the proxy the
                // occupant is a wrapped proxy and `unit` is raw, so `===`
                // never matches.
                if (occupant && occupant.id !== unit.id) continue;
                nodes.set(key, { cell: nb, parentKey: curKey, dist: cur.dist + 1 });
                queue.push(key);
            }
        }

        const buildPath = (key) => {
            const path = [];
            let node = nodes.get(key);
            while (node && node.parentKey !== null) {
                path.push(node.cell);
                node = nodes.get(node.parentKey);
            }
            return path.reverse();
        };

        for (const [key, node] of nodes) {
            let cachedPath = null;
            reachable.set(key, {
                cell: node.cell,
                dist: node.dist,
                get path() {
                    if (cachedPath === null) cachedPath = buildPath(key);
                    return cachedPath;
                },
            });
        }
        return reachable;
    }

    /**
     * Wraps an edge-cost function in a per-call memo, keyed by argument
     * identity. `hexGrid.movementCostTo` prices the same cell once per edge
     * relaxation (up to six times per cell), and through the AI proxy each of
     * those is a full wrapper call. The cost function is a pure function of
     * its argument for the duration of one path search (the unit and the
     * visibility set are fixed), so caching by identity is safe.
     *
     * Identity, not terrain name: `movementCostTo` also samples the cost
     * function with a representative terrain object to build its A* heuristic,
     * and `getMovementCost(terrain)` skips the visibility check while
     * `getMovementCost(cell)` does not — a name-keyed memo would leak a
     * terrain-only cost onto an unseen cell.
     */
    costMemo(costFunc) {
        const memo = new Map();
        return (arg) => {
            if (memo.has(arg)) return memo.get(arg);
            const value = costFunc(arg);
            memo.set(arg, value);
            return value;
        };
    }

    /** Expected total yield for a build site. */
    _expectedYieldAt(gameState, cell, canonicalName, baseYields) {
        if (!baseYields || Object.keys(baseYields).length === 0) return 1;
        const adjusted = this.applyResourceYieldBonus(
            { name: canonicalName, q: cell.q, r: cell.r },
            { ...baseYields },
            gameState
        );
        return Object.values(adjusted).reduce((sum, v) => sum + (typeof v === 'number' ? v : 0), 0);
    }

    /**
     * Fingerprint of the natural resources adjacent to a cell — the only
     * mutable input to a build site's expected yield. Resource quantities
     * never change after map generation, but a resource can be destroyed
     * (building on its cell deletes it), which changes the fingerprint of
     * its six neighbors and so invalidates exactly their cached potentials.
     */
    _resourceFingerprint(grid, cell) {
        let fp = '';
        for (const c of HexGrid.getNeighborCoords(cell.q, cell.r)) {
            const res = grid.getCell(c.q, c.r)?.resource;
            if (res && res.kind === 'natural') fp += `${res.name}:${res.quantity};`;
        }
        return fp;
    }

    /**
     * Expected yield for a build site, served from the per-(type, cell)
     * potential index when the adjacent-resource fingerprint still matches.
     * The potential itself is static per game (manifest + adjacent natural
     * resources), so after warm-up this is a fingerprint check instead of a
     * full applyResourceYieldBonus computation per candidate.
     */
    _buildPotentialAt(gameState, cell, canonicalName, baseYields) {
        if (!baseYields || Object.keys(baseYields).length === 0) return 1;
        const grid = gameState.hexGrid;
        let byType = this._buildPotentialByGrid.get(grid);
        if (!byType) {
            byType = new Map();
            this._buildPotentialByGrid.set(grid, byType);
        }
        let byCell = byType.get(canonicalName);
        if (!byCell) {
            byCell = new Map();
            byType.set(canonicalName, byCell);
        }
        const key = `${cell.q},${cell.r}`;
        const fingerprint = this._resourceFingerprint(grid, cell);
        const hit = byCell.get(key);
        if (hit && hit.fingerprint === fingerprint) return hit.potential;
        const potential = this._expectedYieldAt(gameState, cell, canonicalName, baseYields);
        byCell.set(key, { potential, fingerprint });
        return potential;
    }

    /**
     * All cells within hex distance `maxDistance` of the source entity,
     * enumerated by neighbor expansion instead of scanning the whole map.
     * Coordinates expand through off-map cells so irregular maps still
     * enumerate completely; only existing cells are returned.
     */
    _diskCells(grid, sourceEntity, maxDistance) {
        // An unbounded radius is the whole map; the expansion below would
        // never terminate because off-map coordinates keep generating
        // frontier forever. Fall back to the full cell list.
        if (!Number.isFinite(maxDistance)) return grid.getCellsArray();
        const cells = [];
        const seen = new Set([`${sourceEntity.q},${sourceEntity.r}`]);
        const startCell = grid.getCell(sourceEntity.q, sourceEntity.r);
        if (startCell) cells.push(startCell);
        let frontier = [{ q: sourceEntity.q, r: sourceEntity.r }];
        for (let d = 1; d <= maxDistance && frontier.length > 0; d++) {
            const next = [];
            for (const c of frontier) {
                for (const nc of HexGrid.getNeighborCoords(c.q, c.r)) {
                    const key = `${nc.q},${nc.r}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    next.push(nc);
                    const cell = grid.getCell(nc.q, nc.r);
                    if (cell) cells.push(cell);
                }
            }
            frontier = next;
        }
        return cells;
    }

    /** getCellsArray() index per cell key, built once per grid. */
    _cellOrder(grid) {
        let order = this._cellOrderByGrid.get(grid);
        if (!order) {
            order = new Map();
            grid.getCellsArray().forEach((c, i) => order.set(`${c.q},${c.r}`, i));
            this._cellOrderByGrid.set(grid, order);
        }
        return order;
    }

    /**
     * Finds all valid build sites for a builder and target type.
     * @returns {{ candidates: Array, canonicalName: string }}
     */
    findBuildCandidates(gameState, sourceEntity, targetName,
        maxDistance = this.getConfig().buildMaxDistance ?? 10) {
        const grid = gameState?.hexGrid;
        if (!grid || !sourceEntity || !targetName) return { candidates: [], canonicalName: targetName };
        const owner = sourceEntity.owner;
        const actions = sourceEntity.getActions ? sourceEntity.getActions() : [];
        const moveAction = actions.find(a => a.name === "Move");

        const manifestEntities = gameState.manifestData?.entities || {};
        const canonicalName = Object.keys(manifestEntities).find(k => k.toLowerCase() === String(targetName).toLowerCase()) || targetName;
        const meta = manifestEntities[canonicalName];
        const spawnConditions = meta?.spawnConditions;
        const baseYields = meta?.yields;

        const startCell = sourceEntity.cell || grid.getCell(sourceEntity.q, sourceEntity.r);
        const reachable = moveAction
            ? this.findReachableCells(gameState, sourceEntity, maxDistance)
            : new Map([[`${sourceEntity.q},${sourceEntity.r}`, { cell: startCell, path: [] }]]);
        const canStageFrom = (cell) => {
            if (!reachable.has(`${cell.q},${cell.r}`)) return false;
            const occupant = gameState.getEntityAt(cell.q, cell.r);
            // Compare by id, not identity: when called through the proxy
            // (P8), gameState is filtered so getEntityAt returns a wrapped
            // proxy, while sourceEntity is the raw object — `===` is then
            // always false and a builder can never stage from its own cell.
            return !occupant || occupant.id === sourceEntity.id;
        };

        const isExplored = owner && typeof owner.isExplored === 'function'
            ? (q, r) => owner.isExplored(q, r)
            : () => true;

        // minSeparation: only entities that themselves carry a
        // minSeparation can reject a site — precompute that (usually short)
        // list once per query instead of scanning every entity per cell.
        const reqSep = (spawnConditions && typeof spawnConditions.minSeparation === 'number')
            ? spawnConditions.minSeparation : null;
        const sepEntities = [];
        if (reqSep !== null) {
            for (const e of gameState.entities || []) {
                const eSep = manifestEntities[e.name]?.spawnConditions?.minSeparation;
                if (typeof eSep === 'number') sepEntities.push({ e, eSep });
            }
        }

        const candidates = [];
        // Enumerate only the disk within maxDistance (issue #72) instead of
        // scanning every cell on the map; the disk contains exactly the
        // cells the old distance filter kept.
        for (const cell of this._diskCells(grid, sourceEntity, maxDistance)) {
            if (!cell || !cell.terrain) continue;
            if (!isExplored(cell.q, cell.r)) continue;
            if (gameState.getEntityAt(cell.q, cell.r)) continue;

            if (spawnConditions) {
                if (Array.isArray(spawnConditions.terrain) && spawnConditions.terrain.length > 0) {
                    const tName = cell.terrain.name || '';
                    if (!spawnConditions.terrain.some(t => t.toLowerCase() === tName.toLowerCase())) continue;
                }
                if (reqSep !== null) {
                    let ok = true;
                    for (const { e, eSep } of sepEntities) {
                        if (this.distance(cell, e) < Math.max(reqSep, eSep)) {
                            ok = false;
                            break;
                        }
                    }
                    if (!ok) continue;
                }
            }

            // No movement-cost check on the build cell (Shahin, 2026-11-05):
            // only spawnConditions gates building. The builder stages from
            // a reachable adjacent cell below — it need not stand on the
            // build cell itself (stationary builders, future ships).
            let stage = null;
            for (const nb of this.getNeighbors(cell.q, cell.r)) {
                if (!canStageFrom(nb)) continue;
                const entry = reachable.get(`${nb.q},${nb.r}`);
                if (!stage || entry.path.length < stage.path.length) stage = entry;
            }
            if (!stage) continue;

            candidates.push({
                cell,
                stage,
                dist: this.distance(sourceEntity, cell),
                yield: this._buildPotentialAt(gameState, cell, canonicalName, baseYields),
            });
        }

        // Restore getCellsArray() ordering — the disk enumeration order
        // differs, and callers' tie-breaking depends on candidate order.
        const order = this._cellOrder(grid);
        candidates.sort((a, b) =>
            (order.get(`${a.cell.q},${a.cell.r}`) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(`${b.cell.q},${b.cell.r}`) ?? Number.MAX_SAFE_INTEGER));

        return { candidates, canonicalName };
    }

    // ==================== AI logic: capability helpers ====================

    isBuilder(entity) {
        if (!entity || !entity.getActions) return false;
        return entity.getActions().some(a => a.name && (a.name.startsWith("Build") || a.name === "Build"));
    }

    isRepairer(entity) {
        if (!entity || !entity.getActions) return false;
        return entity.getActions().some(a => a.name === "Repair");
    }

    isCombatCapable(entity) {
        if (!entity || !entity.getActions) return false;
        return entity.getActions().some(a => a.name === "Attack");
    }

    isMobile(entity) {
        if (!entity || entity.isConstruct) return false;
        if (!entity.getActions) return false;
        return entity.getActions().some(a => a.name === "Move");
    }

    getCombatPower(entity, meta) {
        // Leader twists (Phase 25): the owner's Player functions value the
        // entity at what it actually hits and absorbs for. Visible entity
        // properties are public, so this applies for other players' visible
        // entities too. damageVs and terrain need a target and a terrain, so
        // they stay out of this context-free estimate (getAttackValue with
        // no conditions). Falls back to the entity's own damage/armor when
        // it has no owner or the manifest has no entry for it.
        const owner = entity?.owner;
        const rawDmg = entity?.damage?.value || meta?.damage?.value || 0;
        const dmg = owner ? (owner.getAttackValue(entity.name).value || rawDmg) : rawDmg;
        const hp = entity?.health || meta?.health || 1;
        const rangeMult = (entity?.range?.maxCells || meta?.range?.maxCells) ? 1.5 : 1.0;
        const baseArmor = entity?.armor || meta?.armor || {};
        const armorMap = owner ? owner.getArmorValue(entity.name) : {};
        const armorSum = Object.keys(baseArmor).reduce((s, t) => s + (armorMap[t] ?? baseArmor[t] ?? 1), 0);
        return (dmg * hp * rangeMult) + (armorSum * 10);
    }

    combatEffectiveness(entity, meta) {
        const hp = entity?.health || meta?.health || 0;
        const dmg = entity?.damage?.value || meta?.damage?.value || 0;
        return hp * dmg;
    }

    isDedicatedMilitary(entity, manifest) {
        if (!entity || !this.isCombatCapable(entity)) return false;
        const meta = manifest?.entities?.[entity.name] || entity.data || {};
        const dmg = entity.damage?.value || meta.damage?.value || 0;
        const milScore = meta.score?.military || entity.state?.score?.military || 0;
        if (dmg <= 10 && this.isBuilder(entity)) return false;
        return dmg >= 20 || (milScore >= 5 && dmg > 10);
    }

    isMilitary(entity, manifest) {
        if (manifest) return this.isDedicatedMilitary(entity, manifest);
        return this.isCombatCapable(entity) && !this.isBuilder(entity) && (entity?.damage?.value || 0) > 10;
    }

    getEntitiesByCapability(entities, capability, manifest = null) {
        if (!Array.isArray(entities)) return [];
        if (typeof capability === 'function') return entities.filter(capability);
        switch (capability) {
            case 'builder': return entities.filter(e => this.isBuilder(e));
            case 'repairer': return entities.filter(e => this.isRepairer(e));
            case 'combat': return entities.filter(e => this.isCombatCapable(e));
            case 'mobile': return entities.filter(e => this.isMobile(e));
            case 'military': return entities.filter(e => this.isDedicatedMilitary(e, manifest));
            default: return entities;
        }
    }

    getEntitiesSortedByPower(entities, manifest = null, ascending = false) {
        if (!Array.isArray(entities)) return [];
        const manifestEntities = manifest?.entities || {};
        return [...entities].sort((a, b) => {
            const powerA = this.getCombatPower(a, manifestEntities[a.name]);
            const powerB = this.getCombatPower(b, manifestEntities[b.name]);
            return ascending ? powerA - powerB : powerB - powerA;
        });
    }

    getEntitiesSortedByEffectiveness(entities, manifest = null, ascending = false) {
        if (!Array.isArray(entities)) return [];
        const manifestEntities = manifest?.entities || {};
        return [...entities].sort((a, b) => {
            const effA = this.combatEffectiveness(a, manifestEntities[a.name]);
            const effB = this.combatEffectiveness(b, manifestEntities[b.name]);
            return ascending ? effA - effB : effB - effA;
        });
    }

    findClosestEntity(fromCoord, entities) {
        if (!fromCoord || !Array.isArray(entities) || entities.length === 0) return null;
        let closest = null;
        let minDist = Infinity;
        for (const e of entities) {
            const d = this.distance(fromCoord, e);
            if (d < minDist) {
                minDist = d;
                closest = e;
            }
        }
        return closest;
    }

    selectCandidateCombatUnits(myEntities, targetEntity, manifest = null) {
        if (!Array.isArray(myEntities) || !targetEntity) return [];
        const activeCombatCapable = myEntities.filter(e => e && e.active && !e.destroyed && this.isCombatCapable(e));
        if (activeCombatCapable.length === 0) return [];

        const dedicatedMilitary = activeCombatCapable.filter(e => this.isDedicatedMilitary(e, manifest));
        const nonBuilderCombat = activeCombatCapable.filter(e => !this.isBuilder(e));

        let candidates = [];
        if (dedicatedMilitary.length > 0) candidates = dedicatedMilitary;
        else if (nonBuilderCombat.length > 0) candidates = nonBuilderCombat;
        else candidates = activeCombatCapable;

        const manifestEntities = manifest?.entities || {};
        return [...candidates].sort((a, b) => {
            const distA = this.distance(a.cell || a, targetEntity.cell || targetEntity);
            const distB = this.distance(b.cell || b, targetEntity.cell || targetEntity);
            if (distA !== distB) return distA - distB;
            const powerA = this.getCombatPower(a, manifestEntities[a.name]);
            const powerB = this.getCombatPower(b, manifestEntities[b.name]);
            return powerB - powerA;
        });
    }

    // ==================== AI logic: pathfinding ====================

    // (G1: findWalkablePath — the naive BFS with a 5000-node cap — is
    // deleted. Point-to-point pathing is movementCostTo with
    // allowDetours: true; it is A*, has no cap, and returns a
    // best-effort path when the target is unreachable.)

    findPathTowardsUnexplored(explorer, gameState, player, targetedCells = new Set(), targetCells = null, options = {}) {
        const grid = this.gameState?.hexGrid;
        const empty = { targetCell: null, path: [], fullyExplored: false, arrivedAtBestReachable: true, directionEmpty: false };
        if (!grid || !explorer || !player) return empty;

        const startCell = explorer.cell || grid.getCell(explorer.q, explorer.r);
        if (!startCell) return empty;

        const ignore = new Set();
        if (targetedCells) {
            for (const t of targetedCells) {
                if (typeof t === 'string') ignore.add(t);
                else if (t && typeof t.q === 'number') ignore.add(`${t.q},${t.r}`);
            }
        }

        // One pass over the candidate pool (was: a full-map reduce for the
        // unexplored count, then a full-map filter, then a map() for the key
        // set). On a 128 map that is ~49k cells per call, per explorer, per
        // turn — issue #72.
        //
        // options.direction builds the pool engine-side for one compass
        // direction, so callers that explore "to the NE" no longer pull the
        // whole map through the proxy just to filter it. The explored set is
        // read from the raw player object, not the proxy.
        const direction = options.direction || null;
        const hasExplicitTargets = !!targetCells || !!direction;
        const rawPlayer = direction
            ? (this.gameState?.players?.find(p => String(p.id) === String(player.id)) || player)
            : player;
        let pool;
        if (targetCells) {
            pool = targetCells.filter(c => c && !ignore.has(`${c.q},${c.r}`));
        } else if (direction) {
            pool = [];
            for (const cell of grid.cells.values()) {
                if (!cell || rawPlayer.isExplored(cell.q, cell.r)) continue;
                if (ignore.has(`${cell.q},${cell.r}`)) continue;
                if (HexGrid.directionName(startCell, cell) !== direction) continue;
                pool.push(cell);
            }
            if (pool.length === 0) {
                return { targetCell: null, path: [], fullyExplored: false, arrivedAtBestReachable: true, directionEmpty: true };
            }
        } else {
            const allCells = this.getCellsArray();
            let unexploredCount = 0;
            pool = [];
            for (const c of allCells) {
                if (!c || rawPlayer.isExplored(c.q, c.r)) continue;
                unexploredCount++;
                if (!ignore.has(`${c.q},${c.r}`)) pool.push(c);
            }
            if (unexploredCount === 0) {
                return { targetCell: null, path: [], fullyExplored: true, arrivedAtBestReachable: true, directionEmpty: false };
            }
        }
        if (pool.length === 0) return empty;

        const poolKeys = new Set();
        for (const c of pool) poolKeys.add(`${c.q},${c.r}`);

        // BFS with an index queue and parent pointers: the old version called
        // queue.shift() (O(n)) and copied the whole path for every visited
        // node, which is what put 44% of the profile in the GC on map 128.
        const nodes = new Map();
        const startKey = `${explorer.q},${explorer.r}`;
        nodes.set(startKey, { cell: startCell, parentKey: null, dist: 0 });

        const queue = [{ key: startKey, cell: startCell }];
        let head = 0;
        const borderTargets = [];

        const pathTo = (key) => {
            const path = [];
            let node = nodes.get(key);
            while (node && node.parentKey !== null) {
                path.push(node.cell);
                node = nodes.get(node.parentKey);
            }
            return path.reverse();
        };

        while (head < queue.length) {
            const cur = queue[head++];
            const curNode = nodes.get(cur.key);
            for (const nb of this.getNeighbors(cur.cell.q, cur.cell.r)) {
                const nbKey = `${nb.q},${nb.r}`;
                if (poolKeys.has(nbKey)) {
                    if (Number.isFinite(explorer.getMovementCost(nb)) && !nodes.has(nbKey)) {
                        // BFS discovers in distance order, so the first direct
                        // target is the shortest one (ties: earliest discovered,
                        // same as the old stable sort). Return immediately
                        // instead of collecting the whole set and sorting it.
                        return {
                            targetCell: nb,
                            path: [...pathTo(cur.key), nb],
                            fullyExplored: false,
                            arrivedAtBestReachable: false,
                            directionEmpty: false,
                        };
                    } else if (!hasExplicitTargets) {
                        borderTargets.push({
                            targetCell: nb,
                            key: cur.key,
                            dist: curNode.dist,
                        });
                    }
                }
                if (nodes.has(nbKey)) continue;
                if (!Number.isFinite(explorer.getMovementCost(nb))) continue;
                nodes.set(nbKey, { cell: nb, parentKey: cur.key, dist: curNode.dist + 1 });
                const occupant = gameState.getEntityAt(nb.q, nb.r);
                // Compare by id (see canStageFrom): through the proxy the
                // occupant is a wrapped proxy and `explorer` is raw, so
                // `===` never matches.
                if (occupant && occupant.id !== explorer.id) continue;
                queue.push({ key: nbKey, cell: nb });
            }
        }

        if (!hasExplicitTargets) {
            const validBorderTargets = borderTargets.filter(b => b.dist > 0);
            if (validBorderTargets.length > 0) {
                validBorderTargets.sort((a, b) => a.dist - b.dist);
                const best = validBorderTargets[0];
                return { targetCell: best.targetCell, path: pathTo(best.key), fullyExplored: false, arrivedAtBestReachable: false, directionEmpty: false };
            }
        }

        // First minimal-distance cell in BFS insertion order (was a full sort
        // of the pool, O(n log n) comparisons over the whole map).
        let chosenTarget = null;
        let minStartDist = Infinity;
        for (const cell of pool) {
            const d = this.distance(explorer, cell);
            if (d < minStartDist) {
                minStartDist = d;
                chosenTarget = cell;
            }
        }
        let bestReachable = null;
        let minTargetDist = Infinity;

        for (const [key, node] of nodes) {
            const d = this.distance(node.cell, chosenTarget);
            if (d < minTargetDist) {
                minTargetDist = d;
                bestReachable = { key };
            }
        }

        if (bestReachable && nodes.get(bestReachable.key).dist > 0) {
            const path = pathTo(bestReachable.key);
            if (path.length > 0) {
                return { targetCell: chosenTarget, path, fullyExplored: false, arrivedAtBestReachable: false, directionEmpty: false };
            }
        }

        return { targetCell: chosenTarget, path: [], fullyExplored: false, arrivedAtBestReachable: true, directionEmpty: false };
    }

    /**
     * Initiate diplomatic chat between two players.
     * Deducts 1 order from the initiator via consumeOrders().
     * @param {Object} initiator - Player initiating chat
     * @param {Object} receiver - Player receiving chat
     * @param {string|null} initialMessage - Opening message (or null to generate)
     * @param {number|null} maxExchanges - Max back-and-forth (or null for default)
     * @returns {boolean} true if chat was initiated, false if initiator had no orders
     */
    async chat(initiator, receiver, initialMessage = null, maxExchanges = null) {
        // L6: resolve the harnesses BEFORE deducting the order — the old
        // code consumed 1 order first, then discovered the other side
        // couldn't reply (no harness, no modal) and the order was gone.
        // Phase 26: resolve the CHAT manager (strategic when present, else
        // tactical) — the strategic AI is the chat partner when it exists.
        const initiatorHarness = await initiator.getChatManager();
        const receiverHarness = await receiver.getChatManager();
        const canProceed = initiatorHarness || receiverHarness
            || typeof this.gameState?.onOpenChatModal === 'function';
        if (!canProceed) return false;

        // Initiating chat costs 1 order
        if (!initiator.consumeOrders(1)) {
            return false;
        }

        console.log(`[AiHelper] chat() started between ${initiator.name} and ${receiver.name}`);

        // Max back-and-forth exchanges per chat (default 6). The chat manager's
        // own config wins when it has one (Phase 26: diplomacy belongs to the
        // strategic AI, so maxChatExchanges set there is honoured); the
        // tactical controller's config remains the fallback.
        const maxEx = maxExchanges
            ?? initiatorHarness?.controller?.config?.maxChatExchanges
            ?? initiator.controller?.config?.maxChatExchanges
            ?? 6;

        // P5: each harness must see the other player through its OWN filtered
        // gameState — passing the raw Player handed the opponent's resources,
        // orders, history and (for LLM players) API key to the other AI.
        const viewOf = (harness, player) => {
            const gs = harness?.gameState;
            if (gs && Array.isArray(gs.players)) {
                return gs.players.find(p => p.id === player.id) || player;
            }
            return player;
        };

        // Case 1: Both players are AI -> background chat loop (invisible to human)
        if (initiatorHarness && receiverHarness) {
            let firstMsg = initialMessage;
            let firstEmote = null;
            if (!firstMsg) {
                const opening = await initiatorHarness.generateChatReply(viewOf(initiatorHarness, receiver), "Open diplomatic dialogue with an initial statement or proposal.");
                firstMsg = opening.content;
                firstEmote = opening.emote;
            }
            this.gameState.addChatMessage(initiator, receiver, firstMsg, false, firstEmote);

            let currentSpeaker = receiver;
            let currentHarness = receiverHarness;
            let otherPlayer = initiator;

            for (let i = 0; i < maxEx; i++) {
                const reply = await currentHarness.generateChatReply(viewOf(currentHarness, otherPlayer));
                this.gameState.addChatMessage(currentSpeaker, otherPlayer, reply.content, reply.ended, reply.emote);

                if (reply.ended) {
                    console.log(`[AiHelper] AI-to-AI chat terminated by ${currentSpeaker.name} at exchange ${i + 1}`);
                    break;
                }

                // Alternate speakers
                const tempP = currentSpeaker;
                currentSpeaker = otherPlayer;
                otherPlayer = tempP;
                currentHarness = (currentSpeaker === initiator) ? initiatorHarness : receiverHarness;
            }

            // Both AI players add summary note to their history
            await initiatorHarness.summarizeChatAndAddNote(viewOf(initiatorHarness, receiver));
            if (receiverHarness && receiverHarness !== initiatorHarness) {
                await receiverHarness.summarizeChatAndAddNote(viewOf(receiverHarness, initiator));
            }
            return true;
        }

        // Case 2: One player is human -> open chat window
        const aiPlayer = initiatorHarness ? initiator : receiver;
        const humanPlayer = initiatorHarness ? receiver : initiator;
        const aiHarness = initiatorHarness || receiverHarness;

        if (initiator.isAI) {
            // AI opening statement — keep its emote and ended flag so the
            // first message renders with the chosen portrait.
            const opening = initialMessage
                ? { content: initialMessage, emote: null, ended: false }
                : await aiHarness.generateChatReply(humanPlayer, "Open diplomatic dialogue with an initial statement or proposition to the human leader.");
            this.gameState.addChatMessage(aiPlayer, humanPlayer, opening.content, !!opening.ended, opening.emote);
        }

        // Bring up chat window and await until closed/ended.
        // The summary note is added by closeChatModal() in main.js when the
        // modal closes — do not summarize here as well (would double the note
        // Open the chat modal via gameState callback (registered by main.js).
        // No-op in headless mode where no callback is registered.
        await this.gameState?.onOpenChatModal?.(humanPlayer, aiPlayer);
        return true;
    }

    /**
     * Resolve a player reference (Player, proxy, id, name-less object) to the
     * engine's real Player instance.
     * @param {Player|string|number} player
     * @returns {Player|null}
     */
    _resolveTradePlayer(player) {
        if (!player) return null;
        const id = (typeof player === 'object') ? player.id : player;
        return this.gameState?.getPlayerById?.(id) || null;
    }

    /**
     * P5: each manager must see the other party through its own filtered
     * gameState, never the raw Player (which would leak resources/history).
     */
    _viewOfPlayer(harness, player) {
        const gs = harness?.gameState;
        if (gs && Array.isArray(gs.players)) {
            return gs.players.find(p => String(p.id) === String(player.id)) || player;
        }
        return player;
    }

    /**
     * Applies an accepted trade offer to the game state.
     * @param {Player} proposer
     * @param {Player} receiver
     * @param {Object} offer
     * @returns {{ok: boolean, reason?: string, trade?: Object}}
     */
    _applyAcceptedTrade(proposer, receiver, offer) {
        if (offer.type === 'one_time') {
            const result = this.gameState.executeOneTimeTrade(
                proposer, receiver, offer.proposerGives, offer.proposerAsks
            );
            return result.success ? { ok: true } : { ok: false, reason: result.reason };
        }
        const trade = this.gameState.createPerTurnTrade(
            proposer, receiver, offer.proposerGives, offer.proposerAsks
        );
        return trade
            ? { ok: true, trade }
            : { ok: false, reason: 'Invalid per-turn agreement.' };
    }

    /**
     * Reviews a player's active per-turn trade agreements and cancels the
     * ones it can no longer honour. (Phase 26: moved here from
     * BaseManager — trade mechanics live on the helper now, so any AI,
     * tactical or strategic, coded or LLM, may call them. The engine no
     * longer calls this; the strategic AI owns it, and a tactical AI only
     * calls it when no directive is set — convention, not enforcement.)
     *
     * The default policy is objective: keep a deal while the outgoing bundle
     * is affordable, cancel it otherwise (a permanently unaffordable deal
     * would otherwise be skipped every round forever).
     * @param {Player} player
     * @returns {Promise<void>}
     */
    // Trade and diplomacy belong to the strategic AI — a tactical AI should
    // not handle them. If a tactical AI does handle trade, it must call
    // reviewTrades (or write its own equivalent) so unaffordable per-turn
    // deals get cancelled instead of silently draining its resources.
    async reviewTrades(player) {
        const gs = this.gameState;
        if (!gs || typeof gs.getActiveTradesForPlayer !== 'function') return;

        const trades = gs.getActiveTradesForPlayer(player) || [];
        let canceled = 0;
        for (const trade of trades) {
            if (trade.type !== 'per_turn') continue;
            // Give an agreement at least one round-end exchange before the
            // affordability check can cancel it — it may have just been signed.
            if (trade.createdRound >= gs.currentRound) continue;

            const isP1 = String(trade.player1Id) === String(player.id);
            const outgoing = isP1 ? trade.bundle1 : trade.bundle2;
            if (player.hasResources(outgoing)) continue;

            if (gs.cancelTrade(trade.id)) {
                canceled++;
                this.aiLog?.(
                    player,
                    'trade',
                    `Canceled per-turn agreement ${trade.id}: cannot afford to send ${this.formatResourceBundle(outgoing)}.`
                );
            }
        }

        if (canceled > 0) {
            // Refresh the human UI and record a replay snapshot, matching the
            // normal AI-action path. No-op in headless runs.
            await this.onActionDone?.(gs, null, 'AI canceled a per-turn trade agreement');
        }
    }

    /**
     * Opportunistically proposes a trade to a known opponent when the empire
     * is short of a resource but has a surplus of another.
     *
     * (Phase 26: moved here from LlmBaseManager. The policy is deterministic
     * and cheap — no LLM call inside it — so it belongs with the other trade
     * mechanics on the helper, callable by any AI. The old "LLM-manager
     * capability only" framing mistook history for a rule: only the LLM
     * harness happened to implement it. The axis is tactical vs strategic,
     * not LLM vs JS: the strategic AI owns trade; a tactical AI only calls
     * this when no directive is set — convention, not enforcement.
     * Subclasses/managers may still override this with a model-driven
     * policy by calling initiateTrade() directly.)
     *
     * Default policy:
     * - only when a resource is projected to run out within 10 rounds;
     * - give a resource with positive net income (or a large stock);
     * - acute shortages (<= 3 rounds) become per-turn imports, otherwise a
     *   one-time lump-sum exchange;
     * - at most one proposal every few rounds, and never to an opponent that
     *   already has an active per-turn agreement with us.
     *
     * The actual negotiation is delegated to `initiateTrade()`, which
     * handles AI evaluation or the human trade UI.
     * @param {Player} player
     * @returns {Promise<void>}
     */
    async maybeInitiateTrade(player) {
        const gs = this.gameState;
        if (!gs || !player) return;
        const lastRound = this._tradeProposalRoundByPlayer.get(String(player.id)) ?? -Infinity;
        if (gs.currentRound - lastRound < TRADE_PROPOSAL_COOLDOWN_ROUNDS) return;

        const profile = player.getResourceProfile();
        const deficit = profile.criticalResource;
        if (!deficit) return;

        const turnsLeft = profile.turnsRemaining?.[deficit] ?? Infinity;
        if (!Number.isFinite(turnsLeft) || turnsLeft > 10) return;
        // Asking for a resource we already break even on makes no sense.
        if ((profile.netIncome?.[deficit] ?? 0) >= 0) return;

        const giveKey = Object.keys(profile.netIncome || {})
            .filter(res => res !== deficit)
            .map(res => ({
                res,
                net: profile.netIncome[res] || 0,
                stock: profile.stock?.[res] || 0
            }))
            .filter(x => x.net > 0 || x.stock >= 30)
            .sort((a, b) => (b.net - a.net) || (b.stock - a.stock))[0]?.res;
        if (!giveKey) return;

        const giveStock = profile.stock?.[giveKey] || 0;
        const perTurn = turnsLeft <= 3;
        let amount;
        if (perTurn) {
            const net = profile.netIncome?.[giveKey] || 0;
            amount = Math.max(1, Math.min(3, Math.floor((net > 0 ? net : giveStock / 10) / 2)));
        } else {
            amount = Math.max(1, Math.min(10, Math.floor(giveStock / 4)));
        }
        amount = Math.min(amount, Math.floor(giveStock));
        if (amount < 1) return;

        // First visible opponent without an active per-turn deal with us.
        const active = gs.getActiveTradesForPlayer(player) || [];
        const busy = new Set(active.map(t =>
            String(t.player1Id) === String(player.id)
                ? String(t.player2Id)
                : String(t.player1Id)
        ));
        const opponents = player.getOpponents?.() || {};
        const targetId = Object.keys(opponents)
            .filter(id => /^\d+$/.test(id) && !busy.has(id))
            .sort((a, b) => Number(a) - Number(b))[0];
        if (!targetId) return;

        const offer = {
            type: perTurn ? 'per_turn' : 'one_time',
            proposerGives: { [giveKey]: amount },
            proposerAsks: { [deficit]: amount }
        };

        this._tradeProposalRoundByPlayer.set(String(player.id), gs.currentRound);
        const result = await this.initiateTrade(player, Number(targetId), offer);
        this.aiLog?.(
            player,
            'trade',
            `Proposed ${offer.type} to ${targetId}: ${this.formatResourceBundle(offer.proposerGives)} for ${this.formatResourceBundle(offer.proposerAsks)} -> ${result.status}${result.reason ? ` (${result.reason})` : ''}`
        );
    }

    /**
     * Initiates a trade proposal from `initiator` to `receiver`.
     *
     * - AI receiver: its manager evaluates the offer (accept / counter / reject)
     *   and the accepted exchange is applied immediately. Counter-offers get
     *   one bounded round of evaluation by the original proposer.
     * - Human receiver: opens the trade UI through `gameState.onOpenTradeModal`
     *   and waits for the human's decision (the modal close also ends the wait).
     *
     * @param {Player|string|number} initiator
     * @param {Player|string|number} receiver
     * @param {Object} offer - { type: 'one_time'|'per_turn', proposerGives, proposerAsks }
     * @param {string|null} [emote=null] - the proposer's portrait emote for
     *   the proposal entry (e.g. the emote of the chat reply that carried
     *   the proposal); null renders the neutral portrait.
     * @returns {Promise<{status: 'accepted'|'countered'|'rejected'|'invalid'|'failed', reason?: string, trade?: Object}>}
     */
    async initiateTrade(initiator, receiver, offer, emote = null) {
        const proposer = this._resolveTradePlayer(initiator);
        const target = this._resolveTradePlayer(receiver);
        const check = this.gameState?.validateTradeOffer?.(proposer, target, offer, {
            requireAffordable: offer?.type === 'one_time'
        });
        if (!check?.ok) {
            return { status: 'invalid', reason: check?.reason || 'Invalid trade offer.' };
        }

        const typeLabel = offer.type === 'per_turn' ? 'per-turn agreement' : 'one-time trade';
        this.gameState.addChatMessage(
            proposer,
            target,
            `*[Trade Proposal: Proposing ${typeLabel} — Offering ${formatResourceBundle(offer.proposerGives)} for ${formatResourceBundle(offer.proposerAsks)}]*`,
            false,
            emote
        );

        // Human receiver: hand the offer to the UI and wait for the decision.
        if (!target.isAI) {
            if (typeof this.gameState.onOpenTradeModal !== 'function') {
                return { status: 'failed', reason: 'Trade UI is unavailable.' };
            }
            const decision = await this.gameState.onOpenTradeModal(target, proposer, offer);
            if (decision?.action === 'accept') {
                if (!decision.applied) {
                    const applied = this._applyAcceptedTrade(proposer, target, offer);
                    if (!applied.ok) return { status: 'failed', reason: applied.reason };
                }
                await this.onActionDone(this.gameState, null, 'Trade agreement accepted');
                return { status: 'accepted' };
            }
            if (decision?.action === 'counter') return { status: 'countered' };
            return { status: 'rejected', reason: decision?.reason };
        }

        // Phase 26: the CHAT manager answers (strategic when present — it
        // handled the chat — tactical falls back).
        const receiverHarness = await target.getChatManager();
        if (!receiverHarness) {
            return { status: 'failed', reason: `${target.name} cannot negotiate trade right now.` };
        }

        const decision = await receiverHarness.handleTradeOffer(
            this._viewOfPlayer(receiverHarness, proposer), offer
        );
        if (decision?.message) this.gameState.addChatMessage(target, proposer, decision.message, false, decision.emote);

        if (decision?.action === 'accept') {
            const applied = this._applyAcceptedTrade(proposer, target, offer);
            if (!applied.ok) {
                this.gameState.addChatMessage(target, proposer, `*[Trade failed: ${applied.reason}]*`);
                return { status: 'failed', reason: applied.reason };
            }
            this.gameState.addChatMessage(
                target, proposer,
                `*[Trade accepted: ${formatResourceBundle(offer.proposerGives)} for ${formatResourceBundle(offer.proposerAsks)}]*`
            );
            await this.onActionDone(this.gameState, null, 'Trade agreement accepted');
            return { status: 'accepted', trade: applied.trade };
        }

        if (decision?.action === 'counter') {
            // Bounded counter-exchange: the original proposer evaluates once.
            const counterOffer = {
                type: offer.type,
                proposerGives: decision.counterOffer?.proposerGives,
                proposerAsks: decision.counterOffer?.proposerAsks
            };
            const counterCheck = this.gameState.validateTradeOffer(proposer, target, counterOffer, {
                requireAffordable: offer.type === 'one_time'
            });
            if (!counterCheck.ok) {
                return { status: 'rejected', reason: `Invalid counter-offer: ${counterCheck.reason}` };
            }

            const initiatorHarness = await proposer.getChatManager();
            if (!initiatorHarness) {
                return { status: 'rejected', reason: 'Counter-offer cannot be evaluated.' };
            }
            // The counterOffer is in the ORIGINAL proposer's frame (proposerGives
            // = what the proposer sends, proposerAsks = what the target sends),
            // but the proposer's handleTradeOffer reads it in the OFFERING
            // player's frame (proposer = the target). Swap the bundles for the
            // evaluation so the proposer judges the deal the right way round.
            // Execution below still uses the original counterOffer (proposer frame).
            const offerForProposer = {
                type: counterOffer.type,
                proposerGives: counterOffer.proposerAsks,
                proposerAsks: counterOffer.proposerGives
            };
            const reply = await initiatorHarness.handleTradeOffer(
                this._viewOfPlayer(initiatorHarness, target), offerForProposer
            );
            if (reply?.message) this.gameState.addChatMessage(proposer, target, reply.message, false, reply.emote);
            if (reply?.action === 'accept') {
                const applied = this._applyAcceptedTrade(proposer, target, counterOffer);
                if (!applied.ok) return { status: 'failed', reason: applied.reason };
                this.gameState.addChatMessage(
                    proposer, target,
                    `*[Counter-offer accepted: ${formatResourceBundle(counterOffer.proposerGives)} for ${formatResourceBundle(counterOffer.proposerAsks)}]*`
                );
                await this.onActionDone(this.gameState, null, 'Trade agreement accepted');
                return { status: 'accepted', trade: applied.trade };
            }
            return { status: 'rejected', reason: 'Counter-offer declined.' };
        }

        return { status: 'rejected' };
    }

    /**
     * Called after an AI action completes. Delegates to the onActionDone
     * callback registered by main.js on gameState (which handles UI refresh).
     * No-op if no callback is registered (e.g. headless mode).
     */
    async onActionDone(gameState, involvedCells = null, actionDesc = '') {
        if (typeof this.gameState?.onActionDone === 'function') {
            return this.gameState.onActionDone(involvedCells, actionDesc);
        }
    }

}

export default AiHelper;
