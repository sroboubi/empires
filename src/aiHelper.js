/**
 * AiHelper - Engine bridge and AI logic helper.
 *
 * The engine creates one instance per game and passes it to AI managers. It is
 * the AI module's only channel to engine features: instead of importing
 * HexGrid, CONFIG, renderer, etc., AI code calls methods on this class.
 *
 * It also owns the AI action/pathfinding logic (formerly in
 * `src/ai/aiUtils.js` and `src/ai/actions.js`) so AI managers can call
 * `helper.attack(...)`, `helper.findReachableCells(...)`, etc. directly.
 */
import { HexGrid, DIRECTIONS_8 } from './hexGrid.js';
import { camelToTitle, sleep, calculateAttackMultiplier } from './utils.js';
import { applyResourceYieldBonus } from './resources.js';
import Entity from './entity.js';
import { CONFIG } from './config.js';

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

    /** @returns {Object|null} movement cost path between two cells */
    movementCostTo(fromCell, toCell, costFunc) {
        return this.gameState.hexGrid.movementCostTo(fromCell, toCell, costFunc);
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
    calculateAttackMultiplier(gameState, sourceCell, elevationAdjustment, targetEntity) {
        return calculateAttackMultiplier(gameState, sourceCell, elevationAdjustment, targetEntity);
    }

    /** Apply the resource yield bonus for a construct on a cell. */
    applyResourceYieldBonus(entity, baseYields, gameState) {
        return applyResourceYieldBonus(entity, baseYields, gameState);
    }

    /** Convert camelCase to Title Case. */
    camelToTitle(text) {
        return camelToTitle(text);
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
     * @returns {Map<string, {cell: Object, path: Array<Object>}>}
     */
    findReachableCells(gameState, unit, maxDistance = Infinity) {
        const reachable = new Map();
        if (!this.gameState?.hexGrid || !unit) return reachable;
        const startCell = unit.cell || this.gameState.hexGrid.getCell(unit.q, unit.r);
        if (!startCell) return reachable;
        const maxAP = unit.maxActionPoints ?? unit.actionPoints ?? Infinity;
        const startKey = `${unit.q},${unit.r}`;
        reachable.set(startKey, { cell: startCell, path: [] });
        const queue = [{ q: unit.q, r: unit.r, path: [], dist: 0 }];
        while (queue.length > 0) {
            const cur = queue.shift();
            if (cur.dist >= maxDistance) continue;
            for (const nb of this.getNeighbors(cur.q, cur.r)) {
                const key = `${nb.q},${nb.r}`;
                if (reachable.has(key)) continue;
                if (typeof unit.canStandOn === 'function' && !unit.canStandOn(nb)) continue;
                const baseMc = nb.terrain?.movementCost ?? 1;
                const tcs = unit.terrainCostScale;
                const tScale = (tcs && nb.terrain?.name in tcs) ? tcs[nb.terrain.name] : 1;
                if ((baseMc * tScale) > maxAP) continue;
                const occupant = gameState.getEntityAt(nb.q, nb.r);
                if (occupant && occupant !== unit) continue;
                const path = [...cur.path, nb];
                reachable.set(key, { cell: nb, path });
                queue.push({ q: nb.q, r: nb.r, path, dist: cur.dist + 1 });
            }
        }
        return reachable;
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
            return !occupant || occupant === sourceEntity;
        };

        const isExplored = owner && typeof owner.isExplored === 'function'
            ? (q, r) => owner.isExplored(q, r)
            : () => true;

        const candidates = [];
        for (const cell of this.getCellsArray()) {
            if (!cell || !cell.terrain) continue;
            if (this.distance(sourceEntity, cell) > maxDistance) continue;
            if (!isExplored(cell.q, cell.r)) continue;
            if (gameState.getEntityAt(cell.q, cell.r)) continue;

            if (spawnConditions) {
                if (Array.isArray(spawnConditions.terrain) && spawnConditions.terrain.length > 0) {
                    const tName = cell.terrain.name || '';
                    if (!spawnConditions.terrain.some(t => t.toLowerCase() === tName.toLowerCase())) continue;
                }
                if (typeof spawnConditions.minSeparation === 'number') {
                    const reqSep = spawnConditions.minSeparation;
                    let ok = true;
                    for (const e of gameState.entities || []) {
                        const eSep = manifestEntities[e.name]?.spawnConditions?.minSeparation;
                        if (typeof eSep === 'number' && this.distance(cell, e) < Math.max(reqSep, eSep)) {
                            ok = false;
                            break;
                        }
                    }
                    if (!ok) continue;
                }
            }

            // No canStandOn check on the build cell (Shahin, 2026-11-05):
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
                yield: this._expectedYieldAt(gameState, cell, canonicalName, baseYields),
            });
        }

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
        const dmg = entity?.damage?.value || meta?.damage?.value || 0;
        const hp = entity?.health || meta?.health || 1;
        const rangeMult = (entity?.range?.maxCells || meta?.range?.maxCells) ? 1.5 : 1.0;
        const armorSum = Object.values(entity?.armor || meta?.armor || {}).reduce((s, v) => s + v, 0);
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

    findWalkablePath(gameState, unit, targetCoord, maxNodes = 5000) {
        if (!this.gameState?.hexGrid || !unit || !targetCoord) return null;
        const startCell = unit.cell || this.gameState.hexGrid.getCell(unit.q, unit.r);
        if (!startCell) return null;
        if (unit.q === targetCoord.q && unit.r === targetCoord.r) return [];

        const targetKey = `${targetCoord.q},${targetCoord.r}`;
        const visited = new Set();
        visited.add(`${unit.q},${unit.r}`);

        const queue = [{ q: unit.q, r: unit.r, path: [] }];
        let nodes = 0;

        while (queue.length > 0 && nodes++ < maxNodes) {
            const cur = queue.shift();
            for (const nb of this.getNeighbors(cur.q, cur.r)) {
                const key = `${nb.q},${nb.r}`;
                if (visited.has(key)) continue;
                const isTarget = (key === targetKey);
                if (!unit.canStandOn(nb)) continue;
                const nextPath = [...cur.path, nb];
                if (isTarget) return nextPath;
                visited.add(key);
                const occupant = gameState.getEntityAt(nb.q, nb.r);
                if (occupant && occupant !== unit) continue;
                queue.push({ q: nb.q, r: nb.r, path: nextPath });
            }
        }
        return null;
    }

    findPathTowardsUnexplored(explorer, gameState, player, targetedCells = new Set(), targetCells = null) {
        const grid = this.gameState?.hexGrid;
        const empty = { targetCell: null, path: [], fullyExplored: false, arrivedAtBestReachable: true };
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

        const allCells = this.getCellsArray();
        const unexploredCount = allCells.reduce((n, c) => n + (c && !player.isExplored(c.q, c.r) ? 1 : 0), 0);
        if (!targetCells && unexploredCount === 0) {
            return { targetCell: null, path: [], fullyExplored: true, arrivedAtBestReachable: true };
        }

        const pool = targetCells
            ? targetCells.filter(c => c && !ignore.has(`${c.q},${c.r}`))
            : allCells.filter(c => c && !player.isExplored(c.q, c.r) && !ignore.has(`${c.q},${c.r}`));
        if (pool.length === 0) return empty;
        const poolKeys = new Set(pool.map(c => `${c.q},${c.r}`));

        const reachable = new Map();
        const startKey = `${explorer.q},${explorer.r}`;
        reachable.set(startKey, { cell: startCell, path: [] });

        const queue = [{ q: explorer.q, r: explorer.r, path: [] }];
        const directTargets = [];
        const borderTargets = [];

        while (queue.length > 0) {
            const cur = queue.shift();
            for (const nb of this.getNeighbors(cur.q, cur.r)) {
                const nbKey = `${nb.q},${nb.r}`;
                if (poolKeys.has(nbKey)) {
                    if (explorer.canStandOn(nb) && !reachable.has(nbKey)) {
                        const pathToNb = [...cur.path, nb];
                        directTargets.push({ targetCell: nb, path: pathToNb, dist: pathToNb.length });
                    } else if (!targetCells) {
                        borderTargets.push({ targetCell: nb, path: cur.path, dist: cur.path.length });
                    }
                }
                if (reachable.has(nbKey)) continue;
                if (!explorer.canStandOn(nb)) continue;
                const nextPath = [...cur.path, nb];
                reachable.set(nbKey, { cell: nb, path: nextPath });
                const occupant = gameState.getEntityAt(nb.q, nb.r);
                if (occupant && occupant !== explorer) continue;
                queue.push({ q: nb.q, r: nb.r, path: nextPath });
            }
        }

        if (directTargets.length > 0) {
            directTargets.sort((a, b) => a.dist - b.dist);
            const best = directTargets[0];
            return { targetCell: best.targetCell, path: best.path, fullyExplored: false, arrivedAtBestReachable: false };
        }

        if (!targetCells) {
            const validBorderTargets = borderTargets.filter(b => b.path.length > 0);
            if (validBorderTargets.length > 0) {
                validBorderTargets.sort((a, b) => a.dist - b.dist);
                const best = validBorderTargets[0];
                return { targetCell: best.targetCell, path: best.path, fullyExplored: false, arrivedAtBestReachable: false };
            }
        }

        const sortedPool = [...pool].sort((a, b) => this.distance(explorer, a) - this.distance(explorer, b));
        const chosenTarget = sortedPool[0];
        let bestReachable = null;
        let minTargetDist = Infinity;

        for (const { cell, path } of reachable.values()) {
            const d = this.distance(cell, chosenTarget);
            if (d < minTargetDist) {
                minTargetDist = d;
                bestReachable = { cell, path };
            }
        }

        if (bestReachable && bestReachable.path.length > 0) {
            return { targetCell: chosenTarget, path: bestReachable.path, fullyExplored: false, arrivedAtBestReachable: false };
        }

        return { targetCell: chosenTarget, path: [], fullyExplored: false, arrivedAtBestReachable: true };
    }

    // ==================== AI logic: actions ====================

    attack(gameState, sourceEntity, targetEntity, maxOrders = 1) {
        const fail = (message) => ({ ordersUsed: 0, result: { status: 'failed', message } });
        if (!gameState || !sourceEntity || !targetEntity || maxOrders <= 0) return fail('Invalid attack parameters.');
        if (!sourceEntity.active) return fail(`${sourceEntity.name} is not active.`);

        const availableOrders = Math.min(maxOrders, sourceEntity.owner ? sourceEntity.owner.orders : maxOrders);
        if (availableOrders <= 0) return fail('No orders available.');

        const actions = sourceEntity.getActions ? sourceEntity.getActions() : [];
        const attackAction = actions.find(a => a.name === "Attack");
        if (!attackAction) return fail(`${sourceEntity.name} cannot attack.`);

        const moveAction = actions.find(a => a.name === "Move");
        const targetCell = targetEntity.cell;
        let ordersUsed = 0;
        let totalDamage = 0;
        let attacksLanded = 0;
        let movedCloser = false;

        const attackerPlayer = sourceEntity.owner || { name: 'Barbarian' };
        const targetPlayer = targetEntity.owner || { name: 'Neutral' };
        const initialDist = this.distance(sourceEntity.cell || sourceEntity, targetEntity.cell || targetEntity);

        const attackMultiplier = (cell) => this.calculateAttackMultiplier(
            gameState, cell, sourceEntity.damage.elevationAdjustment, targetEntity);

        this.aiLog(attackerPlayer, 'combat', `Engaging Target: ${sourceEntity.name}#${sourceEntity.id?.slice(-4)} (${attackerPlayer.name}) at (${sourceEntity.q},${sourceEntity.r}) [HP:${Math.round(sourceEntity.health)}/${sourceEntity.maxHealth}, AP:${sourceEntity.actionPoints}] attacking ${targetPlayer.name}'s ${targetEntity.name}#${targetEntity.id?.slice(-4)} at (${targetEntity.q},${targetEntity.r}) [HP:${Math.round(targetEntity.health)}/${targetEntity.maxHealth}, Dist:${initialDist} hexes, MaxOrders:${availableOrders}].`);

        let lastCheckReason = 'Target unreachable or insufficient AP';

        while (ordersUsed < availableOrders && sourceEntity.active && !targetEntity.destroyed && targetEntity.health > 0) {
            const currentAttackCheck = attackAction.canDo(targetCell, targetEntity);
            const isCurrentPossible = currentAttackCheck && currentAttackCheck.possible;
            if (currentAttackCheck && !currentAttackCheck.possible) {
                lastCheckReason = currentAttackCheck.reason;
            }
            // G3: the multiplier at the current cell, whether or not the attack
            // is affordable right now. Treating "unaffordable" as 0 made any
            // in-range cell look better, so the unit repositioned after every
            // hit and ping-ponged instead of attacking.
            const currentMult = attackMultiplier(sourceEntity.cell).total;
            const costFunc = typeof sourceEntity.getMovementCost === 'function'
                ? sourceEntity.getMovementCost.bind(sourceEntity)
                : (terrain) => terrain.movementCost || 1;
            // Dry-run attack cost from a candidate cell (same formula as
            // entity.js Attack canDo, without moving there first).
            const attackCostFrom = (cell) => {
                const scale = sourceEntity.attackCostScale ?? 1;
                const exh = sourceEntity.state?.battleExhaustion ?? 1;
                if (sourceEntity.range && typeof sourceEntity.range === 'object') {
                    return Math.ceil(scale * exh * this.distance(cell, targetCell));
                }
                const pathRes = this.movementCostTo(cell, targetCell, costFunc);
                if (!pathRes) return Infinity;
                return Math.ceil(scale * exh * pathRes.cost);
            };

            if (isCurrentPossible && currentMult > 1.0) {
                const prevHealth = targetEntity.health;
                const didAttack = attackAction.do(targetCell, targetEntity);
                if (didAttack) {
                    ordersUsed++;
                    const damageDealt = Math.max(0, prevHealth - targetEntity.health);
                    totalDamage += damageDealt;
                    attacksLanded++;
                    const isDestroyed = targetEntity.destroyed || targetEntity.health <= 0;
                    const statusMsg = isDestroyed
                        ? `TARGET DESTROYED!`
                        : `Target HP remaining: ${Math.round(targetEntity.health)}/${targetEntity.maxHealth}`;
                    this.aiLog(attackerPlayer, 'combat', `Attack Result [Hit]: ${sourceEntity.name}#${sourceEntity.id?.slice(-4)} attacked ${targetPlayer.name}'s ${targetEntity.name}#${targetEntity.id?.slice(-4)} for ${damageDealt.toFixed(1)} dmg (multiplier: ${currentMult.toFixed(2)}x). ${statusMsg}. Attacker AP left: ${sourceEntity.actionPoints}. Order used: ${ordersUsed}/${availableOrders}.`);
                    continue;
                } else {
                    this.aiLog(attackerPlayer, 'warn', `Attack Action Failed: ${sourceEntity.name} attempted attack on ${targetEntity.name} at (${targetCell.q},${targetCell.r}) but action.do() returned false.`);
                    break;
                }
            }

            let moved = false;
            if (moveAction && sourceEntity.actionPoints > 0) {
                const pathResult = this.movementCostTo(sourceEntity.cell, targetCell, costFunc);
                let pathCells = pathResult ? pathResult.path : [];
                if (pathCells.length === 0) {
                    const altPath = this.findWalkablePath(gameState, sourceEntity, targetCell);
                    if (altPath) pathCells = altPath;
                }
                const candidateCells = new Set();
                for (const nb of this.getNeighbors(sourceEntity.q, sourceEntity.r)) candidateCells.add(nb);
                for (const cell of pathCells) {
                    for (const nb of this.getNeighbors(cell.q, cell.r)) candidateCells.add(nb);
                }
                const candidates = Array.from(candidateCells);
                let bestMoveCell = null;
                let bestMoveMult = -1;

                for (const candCell of candidates) {
                    const occupant = gameState.getEntityAt(candCell.q, candCell.r);
                    if (occupant) continue;
                    const checkMove = moveAction.canDo(candCell, null);
                    if (!checkMove || !checkMove.possible) continue;

                    const dist = this.distance(candCell, targetCell);
                    let inRange = false;
                    if (sourceEntity.range && typeof sourceEntity.range === 'object') {
                        const minD = sourceEntity.range.minCells || 1;
                        const maxD = sourceEntity.range.maxCells || 1;
                        if (dist >= minD && dist <= maxD) {
                            const sight = this.getSightAndTrajectory(candCell, targetCell);
                            inRange = sight.visible || (sight.maxObstructionDelta < (sourceEntity.range.arcHeight || 0));
                        }
                    } else {
                        inRange = (dist === 1);
                    }

                    if (inRange) {
                        // G3: only reposition if the attack is still affordable
                        // AFTER the move — otherwise the unit burns an order
                        // moving to a cell it can't attack from.
                        const apAfterMove = sourceEntity.actionPoints - checkMove.cost;
                        if (apAfterMove < attackCostFrom(candCell)) continue;
                        const mult = attackMultiplier(candCell).total;
                        if (mult > bestMoveMult) {
                            bestMoveMult = mult;
                            bestMoveCell = candCell;
                        }
                    }
                }

                if (bestMoveCell && bestMoveMult > currentMult) {
                    const fromCoord = `(${sourceEntity.q},${sourceEntity.r})`;
                    if (moveAction.do(bestMoveCell, null)) {
                        ordersUsed++;
                        movedCloser = true;
                        this.aiLog(attackerPlayer, 'combat', `Repositioning: ${sourceEntity.name} moved from ${fromCoord} to (${bestMoveCell.q},${bestMoveCell.r}) for better attack multiplier (${bestMoveMult.toFixed(2)}x vs ${currentMult.toFixed(2)}x). AP left: ${sourceEntity.actionPoints}. Order used: ${ordersUsed}/${availableOrders}.`);
                        moved = true;
                    }
                }

                if (!moved && !isCurrentPossible) {
                    let closestCell = null;
                    let closestDist = Infinity;
                    for (const candCell of candidates) {
                        const occupant = gameState.getEntityAt(candCell.q, candCell.r);
                        if (occupant) continue;
                        const checkMove = moveAction.canDo(candCell, null);
                        if (!checkMove || !checkMove.possible) continue;
                        const dist = this.distance(candCell, targetCell);
                        if (dist < closestDist) {
                            closestDist = dist;
                            closestCell = candCell;
                        }
                    }
                    // G4: only move if the candidate is actually closer than
                    // where we stand — otherwise the unit sidesteps (or steps
                    // away) and bounces back next iteration.
                    const currentDist = this.distance(sourceEntity, targetCell);
                    if (closestCell && closestDist < currentDist) {
                        const fromCoord = `(${sourceEntity.q},${sourceEntity.r})`;
                        if (moveAction.do(closestCell, null)) {
                            ordersUsed++;
                            movedCloser = true;
                            this.aiLog(attackerPlayer, 'combat', `Repositioning: ${sourceEntity.name} moved from ${fromCoord} to (${closestCell.q},${closestCell.r}) to close distance on ${targetEntity.name} (dist: ${closestDist}). AP left: ${sourceEntity.actionPoints}. Order used: ${ordersUsed}/${availableOrders}.`);
                            moved = true;
                        }
                    }
                }
            }
            if (moved) continue;

            if (isCurrentPossible) {
                const prevHealth = targetEntity.health;
                const didAttack = attackAction.do(targetCell, targetEntity);
                if (didAttack) {
                    ordersUsed++;
                    const damageDealt = Math.max(0, prevHealth - targetEntity.health);
                    totalDamage += damageDealt;
                    attacksLanded++;
                    const isDestroyed = targetEntity.destroyed || targetEntity.health <= 0;
                    const statusMsg = isDestroyed
                        ? `TARGET DESTROYED!`
                        : `Target HP remaining: ${Math.round(targetEntity.health)}/${targetEntity.maxHealth}`;
                    this.aiLog(attackerPlayer, 'combat', `Attack Result [Hit]: ${sourceEntity.name}#${sourceEntity.id?.slice(-4)} attacked ${targetPlayer.name}'s ${targetEntity.name}#${targetEntity.id?.slice(-4)} from current position for ${damageDealt.toFixed(1)} dmg (multiplier: ${currentMult.toFixed(2)}x). ${statusMsg}. Attacker AP left: ${sourceEntity.actionPoints}. Order used: ${ordersUsed}/${availableOrders}.`);
                    continue;
                } else {
                    this.aiLog(attackerPlayer, 'warn', `Attack Action Failed: ${sourceEntity.name} attempted attack on ${targetEntity.name} from current position but action.do() returned false.`);
                    break;
                }
            }
            break;
        }

        const targetDead = targetEntity.destroyed || targetEntity.health <= 0;
        if (ordersUsed > 0) {
            const finalStatus = targetDead
                ? 'TARGET DESTROYED'
                : `Target survived (HP: ${Math.round(targetEntity.health)}/${targetEntity.maxHealth})`;
            this.aiLog(attackerPlayer, 'combat', `Attack Sequence Complete: ${sourceEntity.name} used ${ordersUsed} order(s) against ${targetPlayer.name}'s ${targetEntity.name}. Result: ${finalStatus}. Attacker AP left: ${sourceEntity.actionPoints}.`);
        } else {
            this.aiLog(attackerPlayer, 'detail', `Attack Sequence Incomplete (0 orders used): ${sourceEntity.name} could not attack ${targetEntity.name} (${lastCheckReason}).`);
        }

        let result;
        const targetLabel = `${targetPlayer.name}'s ${targetEntity.name}`;
        if (attacksLanded > 0 && targetDead) {
            result = { status: 'completed', message: `Destroyed ${targetLabel} (${attacksLanded} attack(s), ${totalDamage.toFixed(0)} total damage).` };
        } else if (attacksLanded > 0) {
            result = { status: 'completed', message: `Attacked ${targetLabel} ${attacksLanded} time(s) for ${totalDamage.toFixed(0)} total damage; target at ${Math.round(targetEntity.health)}/${targetEntity.maxHealth} HP.` };
        } else if (movedCloser) {
            result = { status: 'partial', message: `Moved closer to ${targetLabel} but could not attack (${lastCheckReason}).` };
        } else {
            const apRounded = sourceEntity.actionPoints !== undefined ? Math.round(sourceEntity.actionPoints * 10) / 10 : null;
            const apInfo = apRounded !== null ? ` ${sourceEntity.name} has ${apRounded} AP remaining.` : '';
            result = { status: 'failed', message: `Could not attack ${targetLabel} (${lastCheckReason}).${apInfo}` };
        }
        return { ordersUsed, result };
    }

    build(gameState, sourceEntity, targetName,
        maxDistance = this.getConfig().buildMaxDistance ?? 10,
        distancePenalty = this.getConfig().buildDistancePenalty ?? 0.2) {
        const fail = (message) => ({ ordersUsed: 0, result: { status: 'failed', message } });
        if (!gameState || !sourceEntity || !targetName || !sourceEntity.active) return fail('Invalid builder or target.');
        if (!gameState.hexGrid) return fail('No hex grid.');

        const owner = sourceEntity.owner;
        const availableOrders = owner ? owner.orders : 1;
        if (availableOrders <= 0) return fail('No orders available.');

        const actions = sourceEntity.getActions ? sourceEntity.getActions() : [];
        const expectedActionName = `Build ${this.camelToTitle(targetName)}`;
        const buildAction = actions.find(a => a.name.toLowerCase() === expectedActionName.toLowerCase() || a.name.toLowerCase() === `build ${targetName.toLowerCase()}`);
        if (!buildAction) return fail(`${sourceEntity.name} cannot build ${targetName}.`);

        const { candidates, canonicalName } = this.findBuildCandidates(gameState, sourceEntity, targetName, maxDistance);
        if (candidates.length === 0) return fail(`No valid site to build ${canonicalName}.`);
        const moveAction = (sourceEntity.getActions ? sourceEntity.getActions() : []).find(a => a.name === "Move");

        candidates.sort((a, b) => a.dist - b.dist || b.yield - a.yield);
        let best = candidates[0];
        for (let i = 1; i < candidates.length; i++) {
            const c = candidates[i];
            if (c.yield > best.yield) {
                const gain = best.yield > 0 ? c.yield / best.yield - 1 : Infinity;
                if (distancePenalty * (c.dist - best.dist) < gain) best = c;
            }
        }

        this.aiLog(owner || 'AI', 'build', `Build ${canonicalName}: ${candidates.length} candidate site(s), chose (${best.cell.q},${best.cell.r}) dist ${best.dist} expected yield ${best.yield.toFixed(1)} (penalty ${distancePenalty}).`);

        let ordersUsed = 0;

        if (best.stage.path.length > 0) {
            const availableAP = sourceEntity.actionPoints ?? 0;
            if (!moveAction || !(availableAP > 0)) {
                const apRounded = Math.round(availableAP * 10) / 10;
                return fail(`Insufficient AP for movement. ${sourceEntity.name} has ${apRounded} AP but needs to move to build ${canonicalName}.`);
            }
            const pathCost = best.stage.path.reduce((sum, cell) => {
                const baseMc = cell.terrain?.movementCost || 1;
                const tcs = sourceEntity.terrainCostScale;
                const tScale = (tcs && cell.terrain?.name in tcs) ? tcs[cell.terrain.name] : 1;
                return sum + (baseMc * tScale);
            }, 0);
            const terrainTypes = [...new Set(best.stage.path.map(c => c.terrain?.name).filter(Boolean))].join(', ');
            const moved = this.moveAlongPath(owner, sourceEntity, moveAction, best.stage.path, gameState, 'build',
                `moving to build ${canonicalName} at (${best.cell.q},${best.cell.r})`);
            if (!moved) {
                const apRounded = Math.round(availableAP * 10) / 10;
                return fail(`Could not move toward ${canonicalName} site. Full path requires ${pathCost.toFixed(1)} AP${terrainTypes ? ` (Terrain: ${terrainTypes})` : ''}, but ${sourceEntity.name} only has ${apRounded} AP remaining.`);
            }
            ordersUsed = 1;
        }

        if (ordersUsed >= availableOrders) {
            return { ordersUsed, result: { status: 'partial', message: `${sourceEntity.name} moved toward build site for ${canonicalName} but ran out of orders.` } };
        }
        if (this.distance(sourceEntity, best.cell) !== 1) {
            return { ordersUsed, result: { status: 'partial', message: `${sourceEntity.name} moved toward build site for ${canonicalName} but is not yet in position.` } };
        }

        const checkBuild = buildAction.canDo(best.cell, null);
        if (checkBuild && checkBuild.possible) {
            if (buildAction.do(best.cell, null)) {
                this.aiLog(owner || 'AI', 'build', `Built ${canonicalName} at (${best.cell.q},${best.cell.r}).`);
                return { ordersUsed: ordersUsed + 1, result: { status: 'completed', message: `Built ${canonicalName} at (${best.cell.q},${best.cell.r}).` } };
            }
            return { ordersUsed, result: { status: 'failed', message: `Build action failed for ${canonicalName}.` } };
        } else {
            const reason = checkBuild ? checkBuild.reason : 'unknown';
            this.aiLog(owner || 'AI', 'warn', `Build ${canonicalName} at (${best.cell.q},${best.cell.r}) failed check: ${reason}`);
            return { ordersUsed, result: { status: 'failed', message: `Cannot build ${canonicalName}: ${reason}.` } };
        }
    }

    support(gameState, sourceEntity, targetEntity, actionName = null, maxOrders = 1) {
        const fail = (message) => ({ ordersUsed: 0, result: { status: 'failed', message } });
        if (!gameState || !sourceEntity || !targetEntity || !sourceEntity.active) return fail('Invalid entities or source not active.');
        if (targetEntity.destroyed) return fail('Target is destroyed.');
        if (maxOrders <= 0) return fail('No orders available.');

        const owner = sourceEntity.owner;
        const availableOrders = Math.min(maxOrders, owner ? owner.orders : maxOrders);
        if (availableOrders <= 0) return fail('No orders available.');

        const actions = sourceEntity.getActions ? sourceEntity.getActions() : [];
        let supportAction = null;
        if (actionName) {
            supportAction = actions.find(a => a.name && a.name.toLowerCase() === String(actionName).toLowerCase());
            if (!supportAction) {
                this.aiLog(owner || 'AI', 'warn', `${sourceEntity.name} has no "${actionName}" action to support ${targetEntity.name} with.`);
                return fail(`${sourceEntity.name} cannot perform "${actionName}".`);
            }
        }

        const moveAction = actions.find(a => a.name === "Move");
        const targetCell = targetEntity.cell;

        const tryAct = () => {
            if (!supportAction) return { ordersUsed: 0, result: { status: 'completed', message: `${sourceEntity.name} moved adjacent to ${targetEntity.name}.` } };
            const check = supportAction.canDo(targetCell, targetEntity);
            if (check && check.possible && supportAction.do(targetCell, targetEntity)) {
                this.aiLog(owner || 'AI', 'detail', `${sourceEntity.name} used ${supportAction.name} on ${targetEntity.name}.`);
                return { ordersUsed: 1, result: { status: 'completed', message: `${sourceEntity.name} used ${supportAction.name} on ${targetEntity.name}.` } };
            }
            const reason = check && !check.possible ? ` (${check.reason})` : '';
            return fail(`Could not use ${supportAction?.name || actionName} on ${targetEntity.name}${reason}.`);
        };

        if (this.distance(sourceEntity, targetEntity) === 1) {
            return tryAct();
        }

        if (moveAction && sourceEntity.actionPoints > 0) {
            const targetNeighbors = this.getNeighbors(targetEntity.q, targetEntity.r);
            targetNeighbors.sort((a, b) => this.distance(sourceEntity, a) - this.distance(sourceEntity, b));

            for (const adjCell of targetNeighbors) {
                if (gameState.getEntityAt(adjCell.q, adjCell.r)) continue;
                const checkMove = moveAction.canDo(adjCell, null);
                if (checkMove && checkMove.possible) {
                    if (moveAction.do(adjCell, null)) {
                        if (supportAction && availableOrders > 1) {
                            const actResult = tryAct();
                            const totalOrders = 1 + actResult.ordersUsed;
                            if (actResult.result.status === 'completed') {
                                return { ordersUsed: totalOrders, result: { status: 'completed', message: `${sourceEntity.name} moved adjacent to ${targetEntity.name} and used ${supportAction.name}.` } };
                            }
                            return { ordersUsed: totalOrders, result: { status: 'partial', message: `${sourceEntity.name} moved adjacent to ${targetEntity.name} but could not use ${supportAction.name}: ${actResult.result.message}` } };
                        }
                        return { ordersUsed: 1, result: { status: 'partial', message: `${sourceEntity.name} moved adjacent to ${targetEntity.name} but ran out of orders.` } };
                    }
                }
            }
            const apRounded = Math.round((sourceEntity.actionPoints ?? 0) * 10) / 10;
            return fail(`Could not move adjacent to ${targetEntity.name}. ${sourceEntity.name} has ${apRounded} AP remaining.`);
        }

        const apR = Math.round((sourceEntity.actionPoints ?? 0) * 10) / 10;
        return fail(`Could not reach ${targetEntity.name}. ${sourceEntity.name} has ${apR} AP remaining.`);
    }

    moveAlongPath(player, unit, moveAction, path, gameState, category = 'explore', reason = '') {
        if (!path || path.length === 0 || !moveAction) return 0;
        const startCoord = `${unit.q},${unit.r}`;

        const lastCell = path[path.length - 1];
        if (!gameState.getEntityAt(lastCell.q, lastCell.r)) {
            const fullCheck = moveAction.canDo(lastCell, null);
            if (fullCheck && fullCheck.possible && moveAction.do(lastCell, null)) {
                this.aiLog(player, category, `Move ${unit.name} from (${startCoord}) to (${lastCell.q},${lastCell.r}). ${reason}`);
                return 1;
            }
        }

        const apBudget = unit.actionPoints !== undefined ? unit.actionPoints : Infinity;
        let acc = 0;
        let furthest = -1;
        for (let i = 0; i < path.length; i++) {
            const baseMc = path[i].terrain?.movementCost || 1;
            const tcs = unit.terrainCostScale;
            const tScale = (tcs && path[i].terrain?.name in tcs) ? tcs[path[i].terrain.name] : 1;
            acc += baseMc * tScale;
            if (acc > apBudget) break;
            furthest = i;
        }

        for (let i = furthest; i >= 0; i--) {
            const stepCell = path[i];
            if (gameState.getEntityAt(stepCell.q, stepCell.r)) continue;
            const check = moveAction.canDo(stepCell, null);
            if (check && check.possible) {
                const moved = moveAction.do(stepCell, null);
                if (moved) {
                    const note = (i < path.length - 1)
                        ? `advanced ${i + 1}/${path.length} hexes towards target`
                        : `arrived at target`;
                    this.aiLog(player, category, `Move ${unit.name}: ${note} from (${startCoord}) to (${stepCell.q},${stepCell.r}). ${reason}`);
                    return 1;
                }
            }
        }
        return 0;
    }

    explore(gameState, unit, direction = null, getTreasure = false, targetedCells = null) {
        const fail = (message) => ({ ordersUsed: 0, result: { status: 'failed', message } });
        const DIRECTIONS_8 = this.getDirections8();
        if (!gameState || !unit || !unit.active) return fail('Unit is not active or game state missing.');
        if (!gameState.hexGrid) return fail('No hex grid.');
        const player = unit.owner;
        const moveAction = unit.getActions ? unit.getActions().find(a => a.name === "Move") : null;
        if (!moveAction) return fail(`${unit.name} cannot move.`);
        if (unit.actionPoints !== undefined && unit.actionPoints <= 0) return fail(`${unit.name} has no action points.`);

        const claim = (targetCell) => {
            if (targetedCells instanceof Set) targetedCells.add(`${targetCell.q},${targetCell.r}`);
            else if (Array.isArray(targetedCells)) targetedCells.push(targetCell);
        };

        const doExplore = (targetCells, reason) => {
            const res = this.findPathTowardsUnexplored(unit, gameState, player, targetedCells, targetCells);
            if (res.fullyExplored) {
                this.aiLog(player || 'AI', 'explore', `All map territory is fully explored.`);
                return fail('Map is fully explored.');
            }
            if (!res.targetCell || !res.path || res.path.length === 0) return fail('No reachable unexplored cell.');
            const used = this.moveAlongPath(player, unit, moveAction, res.path, gameState, 'explore', reason);
            if (used > 0) {
                claim(res.targetCell);
                this.aiLog(player || 'AI', 'explore', `${unit.name} exploring ${reason} -> (${res.targetCell.q},${res.targetCell.r}).`);
                return { ordersUsed: 1, result: { status: 'completed', message: `${unit.name} explored ${reason} towards (${res.targetCell.q},${res.targetCell.r}).` } };
            }
            const apR = Math.round((unit.actionPoints ?? 0) * 10) / 10;
            return fail(`Could not move along exploration path. ${unit.name} has ${apR} AP remaining.`);
        };

        if (getTreasure && player) {
            const treasures = [];
            for (const cell of this.getCellsArray()) {
                if (!cell || cell.resource?.kind !== 'treasure') continue;
                if (!player.isExplored(cell.q, cell.r)) continue;
                treasures.push(cell);
            }
            if (treasures.length > 0) {
                const treasureResult = doExplore(treasures, 'towards treasure');
                if (treasureResult.ordersUsed > 0) return treasureResult;
            }
            return this.explore(gameState, unit, null, false, targetedCells);
        }

        if (direction) {
            if (!DIRECTIONS_8.includes(direction)) {
                this.aiLog(player || 'AI', 'warn', `explore: unknown direction "${direction}" (expected one of ${DIRECTIONS_8.join(', ')}).`);
                return fail(`Unknown direction "${direction}".`);
            }
            const fromCell = unit.cell || this.gameState.hexGrid.getCell(unit.q, unit.r);
            const targets = [];
            for (const cell of this.getCellsArray()) {
                if (!cell) continue;
                if (player && player.isExplored(cell.q, cell.r)) continue;
                if (this.directionTo(fromCell, cell).fromSource === direction) targets.push(cell);
            }
            if (targets.length === 0) {
                this.aiLog(player || 'AI', 'explore', `No unexplored cells to the ${direction}.`);
                // G7: return a result object like every other path, not 0 —
                // callers read res.result.status.
                return fail(`No unexplored cells to the ${direction}.`);
            }
            return doExplore(targets, `to the ${direction}`);
        }

        return doExplore(null, 'towards unexplored territory');
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
        const initiatorHarness = await initiator.getAiManager();
        const receiverHarness = await receiver.getAiManager();
        const canProceed = initiatorHarness || receiverHarness
            || typeof this.gameState?.onOpenChatModal === 'function';
        if (!canProceed) return false;

        // Initiating chat costs 1 order
        if (!initiator.consumeOrders(1)) {
            return false;
        }

        console.log(`[AiHelper] chat() started between ${initiator.name} and ${receiver.name}`);

        // Max back-and-forth exchanges per chat, from controller config (default 6).
        const maxEx = maxExchanges ?? initiator.controller?.config?.maxChatExchanges ?? 6;

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
            if (!firstMsg) {
                const opening = await initiatorHarness.generateChatReply(viewOf(initiatorHarness, receiver), "Open diplomatic dialogue with an initial statement or proposal.");
                firstMsg = opening.content;
            }
            this.gameState.addChatMessage(initiator, receiver, firstMsg);

            let currentSpeaker = receiver;
            let currentHarness = receiverHarness;
            let otherPlayer = initiator;

            for (let i = 0; i < maxEx; i++) {
                const reply = await currentHarness.generateChatReply(viewOf(currentHarness, otherPlayer));
                this.gameState.addChatMessage(currentSpeaker, otherPlayer, reply.content);

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
            // AI opening statement
            const opening = initialMessage || (await aiHarness.generateChatReply(humanPlayer, "Open diplomatic dialogue with an initial statement or proposition to the human leader.")).content;
            this.gameState.addChatMessage(aiPlayer, humanPlayer, opening);
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