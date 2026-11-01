/**
 * Pure AI logic helpers.
 *
 * This module contains no engine imports. Engine dependencies (HexGrid,
 * config, hooks) are read from the module-level registry in `deps.js`, which
 * `BaseManager` initializes from the `deps` object supplied by the engine.
 */
import { getHexGrid, getAIConfig, getAIHooks } from './deps.js';

const LOG_STYLES = {
    turn: 'color: #3498db; font-weight: bold;',
    econ: 'color: #f39c12;',
    build: 'color: #2ecc71;',
    explore: 'color: #1abc9c;',
    combat: 'color: #e74c3c; font-weight: bold;',
    warn: 'color: #e67e22; font-weight: bold;',
    detail: 'color: #95a5a6;'
};

export function aiLog(player, category, message) {
    const pName = (typeof player === 'string' ? player : player?.name) || 'AI';
    console.debug(`%c[AI ${pName}][${category}] ${message}`, LOG_STYLES[category] || '');
}

/**
 * BFS from the unit's cell across traversable hexes.
 * A step is traversable when the unit can stand on the cell, the single-step
 * movement cost does not exceed the unit's max AP (it could never cross
 * otherwise, e.g. deep water for a land unit), and no other entity blocks it.
 * Search depth is bounded by maxDistance.
 *
 * @returns {Map<string, {cell: Object, path: Array<Object>}>} key `${q},${r}` -> cell + path from the unit (excluding start)
 */
export function findReachableCells(gameState, unit, maxDistance = Infinity) {
    const grid = gameState.hexGrid;
    const reachable = new Map();
    if (!grid || !unit) return reachable;
    const startCell = unit.cell || grid.getCell(unit.q, unit.r);
    if (!startCell) return reachable;
    const maxAP = unit.maxActionPoints ?? unit.actionPoints ?? Infinity;
    const startKey = `${unit.q},${unit.r}`;
    reachable.set(startKey, { cell: startCell, path: [] });
    const queue = [{ q: unit.q, r: unit.r, path: [], dist: 0 }];
    while (queue.length > 0) {
        const cur = queue.shift();
        if (cur.dist >= maxDistance) continue;
        for (const nb of grid.getNeighbors(cur.q, cur.r)) {
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

/**
 * Expected total yield if an improvement named canonicalName were built on
 * cell. Delegates to the injected applyResourceYieldBonus hook with a minimal
 * stand-in entity so the bonus formula lives in exactly one place.
 * Entities without yields score a constant 1, which makes the closest
 * candidate win the distance/penalty comparison below.
 */
function expectedYieldAt(gameState, cell, canonicalName, baseYields) {
    if (!baseYields || Object.keys(baseYields).length === 0) return 1;
    const hooks = getAIHooks();
    const adjusted = typeof hooks.applyResourceYieldBonus === 'function'
        ? hooks.applyResourceYieldBonus(
            { name: canonicalName, q: cell.q, r: cell.r },
            { ...baseYields },
            gameState
        )
        : { ...baseYields };
    return Object.values(adjusted).reduce((sum, v) => sum + (typeof v === 'number' ? v : 0), 0);
}

/**
 * Finds all valid build sites for a builder and target type, using the same
 * rules as build(): land, within maxDistance, explored by the owner,
 * unoccupied, matching spawnConditions terrain/separation, with a reachable
 * unoccupied neighbor to stage from. Shared by build() and by state
 * serialization, so the LLM sees placeability computed by the engine instead
 * of discovering it through failed Build commands.
 * @param {Object} gameState
 * @param {Object} sourceEntity builder unit
 * @param {string} targetName
 * @param {number} [maxDistance]
 * @returns {{ candidates: Array, canonicalName: string }} candidates are
 *   unsorted; each has { cell, stage, dist, yield }
 */
export function findBuildCandidates(gameState, sourceEntity, targetName,
    maxDistance = getAIConfig().buildMaxDistance ?? 10) {
    const HexGrid = getHexGrid();
    const grid = gameState?.hexGrid;
    if (!grid || !sourceEntity || !targetName || !HexGrid) return { candidates: [], canonicalName: targetName };
    const owner = sourceEntity.owner;
    const actions = sourceEntity.getActions ? sourceEntity.getActions() : [];
    const moveAction = actions.find(a => a.name === "Move");

    // Canonical manifest key (case-insensitive): drives base yields and the
    // resource improvement-bonus name matching.
    const manifestEntities = gameState.manifestData?.entities || {};
    const canonicalName = Object.keys(manifestEntities).find(k => k.toLowerCase() === String(targetName).toLowerCase()) || targetName;
    const meta = manifestEntities[canonicalName];
    const spawnConditions = meta?.spawnConditions;
    const baseYields = meta?.yields;

    // Cells the builder can stage from. Non-mobile builders stay put, so only
    // adjacent cells are reachable for them.
    const startCell = sourceEntity.cell || grid.getCell(sourceEntity.q, sourceEntity.r);
    const reachable = moveAction
        ? findReachableCells(gameState, sourceEntity, maxDistance)
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
    for (const cell of grid.getCellsArray()) {
        if (!cell || !cell.terrain) continue;
        if (HexGrid.distance(sourceEntity, cell) > maxDistance) continue;
        if (!isExplored(cell.q, cell.r)) continue;
        if (gameState.getEntityAt(cell.q, cell.r)) continue;
        // Resource/treasure cells are valid build sites: building a construct
        // destroys the resource (see Build.do); units trained onto one coexist with it.

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
                    if (typeof eSep === 'number' && HexGrid.distance(cell, e) < Math.max(reqSep, eSep)) {
                        ok = false;
                        break;
                    }
                }
                if (!ok) continue;
            }
        }

        // The real Build action also requires the BUILDER to be able to
        // stand on the target cell (entity.js Build canDo): for a construct
        // builder this means the cell's terrain must be in the builder's own
        // spawnConditions.terrain list. Without this, villages claimed units
        // were buildable and then failed with "Cannot build construct on
        // target terrain" (fixed-world DeepSeek run, turn 2).
        if (typeof sourceEntity.canStandOn === 'function' && !sourceEntity.canStandOn(cell)) continue;

        // Need a reachable, unoccupied neighbor to build from; prefer the
        // shortest staging path.
        let stage = null;
        for (const nb of grid.getNeighbors(cell.q, cell.r)) {
            if (!canStageFrom(nb)) continue;
            const entry = reachable.get(`${nb.q},${nb.r}`);
            if (!stage || entry.path.length < stage.path.length) stage = entry;
        }
        if (!stage) continue;

        candidates.push({
            cell,
            stage,
            dist: HexGrid.distance(sourceEntity, cell),
            yield: expectedYieldAt(gameState, cell, canonicalName, baseYields),
        });
    }

    return { candidates, canonicalName };
}

// --- Capability Helpers ---

/**
 * Checks if an entity can perform build actions.
 * @param {Object} entity
 * @returns {boolean}
 */
export function isBuilder(entity) {
    if (!entity || !entity.getActions) return false;
    return entity.getActions().some(a => a.name && (a.name.startsWith("Build") || a.name === "Build"));
}

/**
 * Checks if an entity can perform repair actions.
 * @param {Object} entity
 * @returns {boolean}
 */
export function isRepairer(entity) {
    if (!entity || !entity.getActions) return false;
    return entity.getActions().some(a => a.name === "Repair");
}

/**
 * Checks if an entity can perform combat attacks.
 * @param {Object} entity
 * @returns {boolean}
 */
export function isCombatCapable(entity) {
    if (!entity || !entity.getActions) return false;
    return entity.getActions().some(a => a.name === "Attack");
}

/**
 * Checks if an entity is a mobile unit (non-construct).
 * @param {Object} entity
 * @returns {boolean}
 */
export function isMobile(entity) {
    if (!entity || entity.isConstruct) return false;
    if (!entity.getActions) return false;
    return entity.getActions().some(a => a.name === "Move");
}

/**
 * Computes combat power rating for an entity.
 * Takes into account damage, health, range multiplier, and armor.
 * @param {Object} entity
 * @param {Object} [meta]
 * @returns {number}
 */
export function getCombatPower(entity, meta) {
    const dmg = entity?.damage?.value || meta?.damage?.value || 0;
    const hp = entity?.health || meta?.health || 1;
    const rangeMult = (entity?.range?.maxCells || meta?.range?.maxCells) ? 1.5 : 1.0;
    const armorSum = Object.values(entity?.armor || meta?.armor || {}).reduce((s, v) => s + v, 0);
    return (dmg * hp * rangeMult) + (armorSum * 10);
}

/**
 * Computes simple combat effectiveness (health * damage).
 * Safe against null/undefined damage.
 * @param {Object} entity
 * @param {Object} [meta]
 * @returns {number}
 */
export function combatEffectiveness(entity, meta) {
    const hp = entity?.health || meta?.health || 0;
    const dmg = entity?.damage?.value || meta?.damage?.value || 0;
    return hp * dmg;
}

/**
 * Determines if an entity is primarily a dedicated military unit rather than a civilian/builder.
 * Derives this dynamically based on damage, military score, and build capabilities.
 * @param {Object} entity
 * @param {Object} manifest
 * @returns {boolean}
 */
export function isDedicatedMilitary(entity, manifest) {
    if (!entity || !isCombatCapable(entity)) return false;
    const meta = manifest?.entities?.[entity.name] || entity.data || {};
    const dmg = entity.damage?.value || meta.damage?.value || 0;
    const milScore = meta.score?.military || entity.state?.score?.military || 0;

    // Dedicated combat units deal notable damage and either have military score or are not primary builders
    if (dmg <= 10 && isBuilder(entity)) return false;
    return dmg >= 20 || (milScore >= 5 && dmg > 10);
}

/**
 * Backward compatibility alias for isDedicatedMilitary.
 * @param {Object} entity
 * @param {Object} [manifest]
 * @returns {boolean}
 */
export function isMilitary(entity, manifest) {
    if (manifest) return isDedicatedMilitary(entity, manifest);
    return isCombatCapable(entity) && !isBuilder(entity) && (entity?.damage?.value || 0) > 10;
}

// --- Entity Collection Filtering & Sorting ---

/**
 * Returns entities filtered by a specified capability or custom predicate function.
 * @param {Array<Object>} entities
 * @param {string|Function} capability - 'builder' | 'repairer' | 'combat' | 'mobile' | 'military' or predicate
 * @param {Object} [manifest]
 * @returns {Array<Object>}
 */
export function getEntitiesByCapability(entities, capability, manifest = null) {
    if (!Array.isArray(entities)) return [];
    if (typeof capability === 'function') {
        return entities.filter(capability);
    }
    switch (capability) {
        case 'builder':
            return entities.filter(isBuilder);
        case 'repairer':
            return entities.filter(isRepairer);
        case 'combat':
            return entities.filter(isCombatCapable);
        case 'mobile':
            return entities.filter(isMobile);
        case 'military':
            return entities.filter(e => isDedicatedMilitary(e, manifest));
        default:
            return entities;
    }
}

/**
 * Sorts entities by combat power in descending (default) or ascending order.
 * @param {Array<Object>} entities
 * @param {Object} [manifest]
 * @param {boolean} [ascending=false]
 * @returns {Array<Object>}
 */
export function getEntitiesSortedByPower(entities, manifest = null, ascending = false) {
    if (!Array.isArray(entities)) return [];
    const manifestEntities = manifest?.entities || {};
    const list = [...entities];
    return list.sort((a, b) => {
        const powerA = getCombatPower(a, manifestEntities[a.name]);
        const powerB = getCombatPower(b, manifestEntities[b.name]);
        return ascending ? powerA - powerB : powerB - powerA;
    });
}

/**
 * Sorts entities by combat effectiveness in descending (default) or ascending order.
 * @param {Array<Object>} entities
 * @param {Object} [manifest]
 * @param {boolean} [ascending=false]
 * @returns {Array<Object>}
 */
export function getEntitiesSortedByEffectiveness(entities, manifest = null, ascending = false) {
    if (!Array.isArray(entities)) return [];
    const manifestEntities = manifest?.entities || {};
    const list = [...entities];
    return list.sort((a, b) => {
        const effA = combatEffectiveness(a, manifestEntities[a.name]);
        const effB = combatEffectiveness(b, manifestEntities[b.name]);
        return ascending ? effA - effB : effB - effA;
    });
}

/**
 * Finds the closest entity from a list to a given coordinate.
 * @param {{q: number, r: number}} fromCoord
 * @param {Array<Object>} entities
 * @returns {Object|null}
 */
export function findClosestEntity(fromCoord, entities) {
    const HexGrid = getHexGrid();
    if (!fromCoord || !Array.isArray(entities) || entities.length === 0 || !HexGrid) return null;
    let closest = null;
    let minDist = Infinity;
    for (const e of entities) {
        const d = HexGrid.distance(fromCoord, e);
        if (d < minDist) {
            minDist = d;
            closest = e;
        }
    }
    return closest;
}

/**
 * Selects candidate combat units to engage targetEntity following Guideline 15:
 * - Prioritizes best available units (dedicated military > combat non-builders > all combat-capable).
 * - Sorts candidates primarily by proximity to targetEntity (closest first).
 * - Uses combat power as tie-breaker for units at the same distance.
 *
 * @param {Array<Object>} myEntities
 * @param {Object} targetEntity
 * @param {Object} [manifest]
 * @returns {Array<Object>} Candidate combat units sorted with closest to target first
 */
export function selectCandidateCombatUnits(myEntities, targetEntity, manifest = null) {
    const HexGrid = getHexGrid();
    if (!Array.isArray(myEntities) || !targetEntity || !HexGrid) return [];

    const activeCombatCapable = myEntities.filter(e => e && e.active && !e.destroyed && isCombatCapable(e));
    if (activeCombatCapable.length === 0) return [];

    // Tier 1: Dedicated military units
    const dedicatedMilitary = activeCombatCapable.filter(e => isDedicatedMilitary(e, manifest));

    // Tier 2: Non-builder combat units
    const nonBuilderCombat = activeCombatCapable.filter(e => !isBuilder(e));

    // Select the best available tier
    let candidates = [];
    if (dedicatedMilitary.length > 0) {
        candidates = dedicatedMilitary;
    } else if (nonBuilderCombat.length > 0) {
        candidates = nonBuilderCombat;
    } else {
        candidates = activeCombatCapable;
    }

    const manifestEntities = manifest?.entities || {};

    // Sort primarily by proximity to target (closest first), secondary by combat power (higher first)
    return [...candidates].sort((a, b) => {
        const distA = HexGrid.distance(a.cell || a, targetEntity.cell || targetEntity);
        const distB = HexGrid.distance(b.cell || b, targetEntity.cell || targetEntity);
        if (distA !== distB) {
            return distA - distB;
        }
        const powerA = getCombatPower(a, manifestEntities[a.name]);
        const powerB = getCombatPower(b, manifestEntities[b.name]);
        return powerB - powerA;
    });
}

// --- Pathfinding & Exploration Utilities ---

/**
 * BFS pathfinder across walkable terrain for a unit.
 * Respects unit.canStandOn(cell).
 * Returns array of cells [step1, step2, ... targetCell] or null if unreachable.
 *
 * @param {GameState} gameState
 * @param {BaseEntity} unit
 * @param {{q: number, r: number}} targetCoord
 * @param {number} [maxNodes=5000]
 * @returns {Array<Object>|null}
 */
export function findWalkablePath(gameState, unit, targetCoord, maxNodes = 5000) {
    const grid = gameState.hexGrid;
    if (!grid || !unit || !targetCoord) return null;
    const startCell = unit.cell || grid.getCell(unit.q, unit.r);
    if (!startCell) return null;
    if (unit.q === targetCoord.q && unit.r === targetCoord.r) return [];

    const targetKey = `${targetCoord.q},${targetCoord.r}`;
    const visited = new Set();
    visited.add(`${unit.q},${unit.r}`);

    const queue = [{ q: unit.q, r: unit.r, path: [] }];
    let nodes = 0;

    while (queue.length > 0 && nodes++ < maxNodes) {
        const cur = queue.shift();
        const neighbors = grid.getNeighbors(cur.q, cur.r);
        for (const nb of neighbors) {
            const key = `${nb.q},${nb.r}`;
            if (visited.has(key)) continue;

            const isTarget = (key === targetKey);
            // Must be able to stand on terrain unless it's the target cell and unit can interact from adjacent
            if (!unit.canStandOn(nb)) continue;

            const nextPath = [...cur.path, nb];
            if (isTarget) return nextPath;

            visited.add(key);

            // Avoid expanding through occupants other than unit
            const occupant = gameState.getEntityAt(nb.q, nb.r);
            if (occupant && occupant !== unit) continue;

            queue.push({ q: nb.q, r: nb.r, path: nextPath });
        }
    }
    return null;
}

/**
 * Finds a path from an explorer towards the nearest target cell.
 *
 * Default (targetCells null): targets are all unexplored cells on the map.
 * Pass an explicit targetCells array to restrict the search (e.g. unexplored
 * cells in one compass direction, or explored cells holding treasure).
 * Cells in targetedCells are ignored entirely (already claimed by others).
 *
 * Behavior:
 * 1. With no targets (or a fully explored map in default mode), reports
 *    fullyExplored accordingly.
 * 2. BFS from the explorer across walkable terrain (explorer.canStandOn).
 * 3. Prefers directly reachable target cells; in default mode also considers
 *    reachable walkable cells bordering target hexes (e.g. shoreline facing
 *    unexplored water).
 * 4. Otherwise moves to the reachable cell closest to the nearest target.
 * 5. Returns { targetCell, path, fullyExplored, arrivedAtBestReachable }.
 *
 * Note: A unit does not need to reach the target in the same turn; as it
 * moves along the path across turns, its sight range dynamically reveals
 * unexplored cells.
 *
 * @param {BaseEntity} explorer
 * @param {GameState} gameState
 * @param {Player} player
 * @param {Set<string>|Array} [targetedCells] "q,r" keys or cells to ignore
 * @param {Array<Object>|null} [targetCells] explicit target cells; null = all unexplored
 * @returns {{targetCell: Object|null, path: Array<Object>, fullyExplored: boolean, arrivedAtBestReachable: boolean}}
 */
export function findPathTowardsUnexplored(explorer, gameState, player, targetedCells = new Set(), targetCells = null) {
    const HexGrid = getHexGrid();
    const grid = gameState.hexGrid;
    const empty = { targetCell: null, path: [], fullyExplored: false, arrivedAtBestReachable: true };
    if (!grid || !explorer || !player || !HexGrid) return empty;

    const startCell = explorer.cell || grid.getCell(explorer.q, explorer.r);
    if (!startCell) return empty;

    const ignore = new Set();
    if (targetedCells) {
        for (const t of targetedCells) {
            if (typeof t === 'string') ignore.add(t);
            else if (t && typeof t.q === 'number') ignore.add(`${t.q},${t.r}`);
        }
    }

    const allCells = grid.getCellsArray ? grid.getCellsArray() : Object.values(grid.cells || {});
    const unexploredCount = allCells.reduce((n, c) => n + (c && !player.isExplored(c.q, c.r) ? 1 : 0), 0);
    if (!targetCells && unexploredCount === 0) {
        return { targetCell: null, path: [], fullyExplored: true, arrivedAtBestReachable: true };
    }

    const pool = targetCells
        ? targetCells.filter(c => c && !ignore.has(`${c.q},${c.r}`))
        : allCells.filter(c => c && !player.isExplored(c.q, c.r) && !ignore.has(`${c.q},${c.r}`));
    if (pool.length === 0) return empty;
    const poolKeys = new Set(pool.map(c => `${c.q},${c.r}`));

    // BFS across walkable terrain from explorer
    const reachable = new Map(); // key -> { cell, path }
    const startKey = `${explorer.q},${explorer.r}`;
    reachable.set(startKey, { cell: startCell, path: [] });

    const queue = [{ q: explorer.q, r: explorer.r, path: [] }];
    const directTargets = [];
    const borderTargets = [];

    while (queue.length > 0) {
        const cur = queue.shift();
        const neighbors = grid.getNeighbors(cur.q, cur.r);

        for (const nb of neighbors) {
            const nbKey = `${nb.q},${nb.r}`;

            if (poolKeys.has(nbKey)) {
                if (explorer.canStandOn(nb) && !reachable.has(nbKey)) {
                    const pathToNb = [...cur.path, nb];
                    directTargets.push({ targetCell: nb, path: pathToNb, dist: pathToNb.length });
                } else if (!targetCells) {
                    // Default mode only: impassable target hexes (water/mountain)
                    // can still be approached via a bordering walkable cell.
                    borderTargets.push({ targetCell: nb, path: cur.path, dist: cur.path.length });
                }
            }

            if (reachable.has(nbKey)) continue;
            if (!explorer.canStandOn(nb)) continue;

            const nextPath = [...cur.path, nb];
            reachable.set(nbKey, { cell: nb, path: nextPath });

            // Avoid routing through other units
            const occupant = gameState.getEntityAt(nb.q, nb.r);
            if (occupant && occupant !== explorer) continue;

            queue.push({ q: nb.q, r: nb.r, path: nextPath });
        }
    }

    // Priority 1: directly reachable target cells, closest first
    if (directTargets.length > 0) {
        directTargets.sort((a, b) => a.dist - b.dist);
        const best = directTargets[0];
        return { targetCell: best.targetCell, path: best.path, fullyExplored: false, arrivedAtBestReachable: false };
    }

    // Priority 2 (default mode): walkable cells bordering target hexes
    if (!targetCells) {
        const validBorderTargets = borderTargets.filter(b => b.path.length > 0);
        if (validBorderTargets.length > 0) {
            validBorderTargets.sort((a, b) => a.dist - b.dist);
            const best = validBorderTargets[0];
            return { targetCell: best.targetCell, path: best.path, fullyExplored: false, arrivedAtBestReachable: false };
        }
    }

    // Priority 3: move to the reachable cell closest to the nearest target
    // (e.g. the frontier/coast facing it).
    const sortedPool = [...pool].sort((a, b) => HexGrid.distance(explorer, a) - HexGrid.distance(explorer, b));
    const chosenTarget = sortedPool[0];
    let bestReachable = null;
    let minTargetDist = Infinity;

    for (const { cell, path } of reachable.values()) {
        const d = HexGrid.distance(cell, chosenTarget);
        if (d < minTargetDist) {
            minTargetDist = d;
            bestReachable = { cell, path };
        }
    }

    if (bestReachable && bestReachable.path.length > 0) {
        return {
            targetCell: chosenTarget,
            path: bestReachable.path,
            fullyExplored: false,
            arrivedAtBestReachable: false
        };
    }

    return {
        targetCell: chosenTarget,
        path: [],
        fullyExplored: false,
        arrivedAtBestReachable: true
    };
}
