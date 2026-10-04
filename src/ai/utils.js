import { HexGrid, DIRECTIONS_8 } from '../hexGrid.js';
import { camelToTitle } from '../utils.js';
import { SeaLevel } from '../terrainProvider.js';
import { sleep, calculateAttackMultiplier } from '../utils.js';
import { applyResourceYieldBonus } from '../resources.js';
import { reconcileEntities } from '../renderer.js';
import { updatePlayersUI } from '../main.js';
import { CONFIG } from '../config.js';

/**
 * Attacks targetEntity with sourceEntity using the specified algorithm:
 * while (ordersUsed < maxOrders)
 *   - if attackMultiplier > 1 then try to attack
 *   - otherwise try to move
 *      - choose a reachable cell that you can attack from that provides the best attackMultiplier
 *      - if no better cell exists and you cannot attack from here, move as close to the target as possible
 *   - if already in range (or you can NOT move at all) but can do an attack from current cell then do the attack
 *   - if all else fails, then break loop and return
 *
 * @param {GameState} gameState
 * @param {BaseEntity} sourceEntity
 * @param {BaseEntity} targetEntity
 * @param {number} maxOrders
 * @returns {number} Number of orders used
 */
export function attack(gameState, sourceEntity, targetEntity, maxOrders = 1) {
    if (!gameState || !sourceEntity || !targetEntity || maxOrders <= 0) return 0;
    if (!sourceEntity.active) return 0;

    const availableOrders = Math.min(maxOrders, sourceEntity.owner ? sourceEntity.owner.orders : maxOrders);
    if (availableOrders <= 0) return 0;

    const actions = sourceEntity.getActions ? sourceEntity.getActions() : [];
    const attackAction = actions.find(a => a.name === "Attack");
    if (!attackAction) return 0;

    const moveAction = actions.find(a => a.name === "Move");

    const targetCell = targetEntity.cell;
    let ordersUsed = 0;

    const attackerPlayer = sourceEntity.owner || { name: 'Barbarian' };
    const targetPlayer = targetEntity.owner || { name: 'Neutral' };
    const initialDist = HexGrid.distance(sourceEntity.cell || sourceEntity, targetEntity.cell || targetEntity);

    aiLog(attackerPlayer, 'combat', `Engaging Target: ${sourceEntity.name}#${sourceEntity.id?.slice(-4)} (${attackerPlayer.name}) at (${sourceEntity.q},${sourceEntity.r}) [HP:${Math.round(sourceEntity.health)}/${sourceEntity.maxHealth}, AP:${sourceEntity.actionPoints}] attacking ${targetPlayer.name}'s ${targetEntity.name}#${targetEntity.id?.slice(-4)} at (${targetEntity.q},${targetEntity.r}) [HP:${Math.round(targetEntity.health)}/${targetEntity.maxHealth}, Dist:${initialDist} hexes, MaxOrders:${availableOrders}].`);

    let lastCheckReason = 'Target unreachable or insufficient AP';

    while (ordersUsed < availableOrders && sourceEntity.active && !targetEntity.destroyed && targetEntity.health > 0) {
        // Check if we can attack from current position and get the multiplier
        const currentAttackCheck = attackAction.canDo(targetCell, targetEntity);
        const isCurrentPossible = currentAttackCheck && currentAttackCheck.possible;
        if (currentAttackCheck && !currentAttackCheck.possible) {
            lastCheckReason = currentAttackCheck.reason;
        }
        const currentMult = isCurrentPossible ? calculateAttackMultiplier(gameState, sourceEntity.cell, sourceEntity.damage.elevationAdjustment, targetEntity).total : 0;

        // If attackMultiplier > 1, try to attack
        if (isCurrentPossible && currentMult > 1.0) {
            const prevHealth = targetEntity.health;
            const didAttack = attackAction.do(targetCell, targetEntity);
            if (didAttack) {
                ordersUsed++;
                const damageDealt = Math.max(0, prevHealth - targetEntity.health);
                const isDestroyed = targetEntity.destroyed || targetEntity.health <= 0;
                const statusMsg = isDestroyed
                    ? `TARGET DESTROYED!`
                    : `Target HP remaining: ${Math.round(targetEntity.health)}/${targetEntity.maxHealth}`;
                aiLog(attackerPlayer, 'combat', `Attack Result [Hit]: ${sourceEntity.name}#${sourceEntity.id?.slice(-4)} attacked ${targetPlayer.name}'s ${targetEntity.name}#${targetEntity.id?.slice(-4)} for ${damageDealt.toFixed(1)} dmg (multiplier: ${currentMult.toFixed(2)}x). ${statusMsg}. Attacker AP left: ${sourceEntity.actionPoints}. Order used: ${ordersUsed}/${availableOrders}.`);
                continue; // Continue loop to potentially attack again
            } else {
                aiLog(attackerPlayer, 'warn', `Attack Action Failed: ${sourceEntity.name} attempted attack on ${targetEntity.name} at (${targetCell.q},${targetCell.r}) but action.do() returned false.`);
                break; // Attack failed, exit loop
            }
        }

        // Otherwise try to move to a better position
        let moved = false;
        if (moveAction && sourceEntity.actionPoints > 0) {
            // Find path to target and collect neighbors of path cells + current neighbors
            const costFunc = typeof sourceEntity.getMovementCost === 'function'
                ? sourceEntity.getMovementCost.bind(sourceEntity)
                : (terrain) => terrain.movementCost || 1;
            const pathResult = gameState.hexGrid.movementCostTo(sourceEntity.cell, targetCell, costFunc);
            let pathCells = pathResult ? pathResult.path : [];
            if (pathCells.length === 0) {
                const altPath = findWalkablePath(gameState, sourceEntity, targetCell);
                if (altPath) pathCells = altPath;
            }
            const candidateCells = new Set();
            // Add current neighbors
            for (const nb of gameState.hexGrid.getNeighbors(sourceEntity.q, sourceEntity.r)) {
                candidateCells.add(nb);
            }
            // Add neighbors of all cells in path to target
            for (const cell of pathCells) {
                for (const nb of gameState.hexGrid.getNeighbors(cell.q, cell.r)) {
                    candidateCells.add(nb);
                }
            }
            const candidates = Array.from(candidateCells);
            let bestMoveCell = null;
            let bestMoveMult = -1;

            for (const candCell of candidates) {
                const occupant = gameState.getEntityAt(candCell.q, candCell.r);
                if (occupant) continue;

                const checkMove = moveAction.canDo(candCell, null);
                if (!checkMove || !checkMove.possible) continue;

                // Check if attack is possible from candCell
                const dist = HexGrid.distance(candCell, targetCell);
                let inRange = false;
                if (sourceEntity.range && typeof sourceEntity.range === 'object') {
                    const minD = sourceEntity.range.minCells || 1;
                    const maxD = sourceEntity.range.maxCells || 1;
                    if (dist >= minD && dist <= maxD) {
                        const sight = gameState.hexGrid.getSightAndTrajectory(candCell, targetCell);
                        inRange = sight.visible || (sight.maxObstructionDelta < (sourceEntity.range.arcHeight || 0));
                    }
                } else {
                    inRange = (dist === 1);
                }

                if (inRange) {
                    const mult = calculateAttackMultiplier(gameState, candCell, sourceEntity.damage.elevationAdjustment, targetEntity).total;
                    if (mult > bestMoveMult) {
                        bestMoveMult = mult;
                        bestMoveCell = candCell;
                    }
                }
            }

            // If found a cell with better multiplier, move there
            if (bestMoveCell && bestMoveMult > currentMult) {
                const fromCoord = `(${sourceEntity.q},${sourceEntity.r})`;
                if (moveAction.do(bestMoveCell, null)) {
                    ordersUsed++;
                    aiLog(attackerPlayer, 'combat', `Repositioning: ${sourceEntity.name} moved from ${fromCoord} to (${bestMoveCell.q},${bestMoveCell.r}) for better attack multiplier (${bestMoveMult.toFixed(2)}x vs ${currentMult.toFixed(2)}x). AP left: ${sourceEntity.actionPoints}. Order used: ${ordersUsed}/${availableOrders}.`);
                    moved = true;
                }
            }

            // Only close the distance when we cannot attack from here at all.
            // If already in range with no better cell, attacking from the
            // current cell (below) beats wasting an order shuffling around.
            if (!moved && !isCurrentPossible) {
                let closestCell = null;
                let closestDist = Infinity;

                for (const candCell of candidates) {
                    const occupant = gameState.getEntityAt(candCell.q, candCell.r);
                    if (occupant) continue;

                    const checkMove = moveAction.canDo(candCell, null);
                    if (!checkMove || !checkMove.possible) continue;

                    const dist = HexGrid.distance(candCell, targetCell);
                    if (dist < closestDist) {
                        closestDist = dist;
                        closestCell = candCell;
                    }
                }

                if (closestCell) {
                    const fromCoord = `(${sourceEntity.q},${sourceEntity.r})`;
                    if (moveAction.do(closestCell, null)) {
                        ordersUsed++;
                        aiLog(attackerPlayer, 'combat', `Repositioning: ${sourceEntity.name} moved from ${fromCoord} to (${closestCell.q},${closestCell.r}) to close distance on ${targetEntity.name} (dist: ${closestDist}). AP left: ${sourceEntity.actionPoints}. Order used: ${ordersUsed}/${availableOrders}.`);
                        moved = true;
                    }
                }
            }
        }
        if (moved) continue; // Re-evaluate the attack from the new position

        // If we can NOT move at all but can do an attack from current cell then do the attack
        if (isCurrentPossible) {
            const prevHealth = targetEntity.health;
            const didAttack = attackAction.do(targetCell, targetEntity);
            if (didAttack) {
                ordersUsed++;
                const damageDealt = Math.max(0, prevHealth - targetEntity.health);
                const isDestroyed = targetEntity.destroyed || targetEntity.health <= 0;
                const statusMsg = isDestroyed
                    ? `TARGET DESTROYED!`
                    : `Target HP remaining: ${Math.round(targetEntity.health)}/${targetEntity.maxHealth}`;
                aiLog(attackerPlayer, 'combat', `Attack Result [Hit]: ${sourceEntity.name}#${sourceEntity.id?.slice(-4)} attacked ${targetPlayer.name}'s ${targetEntity.name}#${targetEntity.id?.slice(-4)} from current position for ${damageDealt.toFixed(1)} dmg (multiplier: ${currentMult.toFixed(2)}x). ${statusMsg}. Attacker AP left: ${sourceEntity.actionPoints}. Order used: ${ordersUsed}/${availableOrders}.`);
                continue;
            } else {
                aiLog(attackerPlayer, 'warn', `Attack Action Failed: ${sourceEntity.name} attempted attack on ${targetEntity.name} from current position but action.do() returned false.`);
                break;
            }
        }

        // If all else fails, break loop and return
        break;
    }

    if (ordersUsed > 0) {
        const finalStatus = (targetEntity.destroyed || targetEntity.health <= 0)
            ? 'TARGET DESTROYED'
            : `Target survived (HP: ${Math.round(targetEntity.health)}/${targetEntity.maxHealth})`;
        aiLog(attackerPlayer, 'combat', `Attack Sequence Complete: ${sourceEntity.name} used ${ordersUsed} order(s) against ${targetPlayer.name}'s ${targetEntity.name}. Result: ${finalStatus}. Attacker AP left: ${sourceEntity.actionPoints}.`);
    } else {
        aiLog(attackerPlayer, 'detail', `Attack Sequence Incomplete (0 orders used): ${sourceEntity.name} could not attack ${targetEntity.name} (${lastCheckReason}).`);
    }

    return ordersUsed;
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
 * cell. Delegates to applyResourceYieldBonus (resources.js) with a minimal
 * stand-in entity so the bonus formula lives in exactly one place.
 * Entities without yields score a constant 1, which makes the closest
 * candidate win the distance/penalty comparison below.
 */
function expectedYieldAt(gameState, cell, canonicalName, baseYields) {
    if (!baseYields || Object.keys(baseYields).length === 0) return 1;
    const adjusted = applyResourceYieldBonus(
        { name: canonicalName, q: cell.q, r: cell.r },
        { ...baseYields },
        gameState
    );
    return Object.values(adjusted).reduce((sum, v) => sum + (typeof v === 'number' ? v : 0), 0);
}

/**
 * Builds targetName construct or unit with sourceEntity.
 *
 * All cells (adjacent or not) compete uniformly: candidates must be explored
 * by the owner, within maxDistance, on valid terrain, unoccupied, resourceless,
 * and have a reachable, unoccupied neighboring cell to build from. Each
 * candidate is scored by its expected yield (base yields adjusted for adjacent
 * natural resources via applyResourceYieldBonus). The closest candidate wins
 * unless a farther, richer site justifies the trip:
 *   distancePenalty * deltaDistance < richerYield / bestYield - 1
 * i.e. each extra hex of travel must buy at least distancePenalty of relative yield.
 * Non-mobile builders (no Move action) can only consider adjacent cells.
 *
 * Once the best site is chosen the builder moves toward it and builds. If
 * orders run out, it returns without re-targeting; the same build command
 * next turn re-selects the same site deterministically and continues.
 *
 * @param {GameState} gameState
 * @param {BaseEntity} sourceEntity
 * @param {string} targetName
 * @param {number} [maxDistance] furthest cell from the builder to consider
 * @param {number} [distancePenalty] weighting of extra travel vs. yield gain
 * @returns {number} Number of orders used
 */
export function build(gameState, sourceEntity, targetName,
    maxDistance = CONFIG.AI_BUILD_MAX_DISTANCE ?? 10,
    distancePenalty = CONFIG.AI_BUILD_DISTANCE_PENALTY ?? 0.2) {
    if (!gameState || !sourceEntity || !targetName || !sourceEntity.active) return 0;

    const grid = gameState.hexGrid;
    if (!grid) return 0;

    const owner = sourceEntity.owner;
    const availableOrders = owner ? owner.orders : 1;
    if (availableOrders <= 0) return 0;

    const actions = sourceEntity.getActions ? sourceEntity.getActions() : [];
    const expectedActionName = `Build ${camelToTitle(targetName)}`;
    const buildAction = actions.find(a => a.name.toLowerCase() === expectedActionName.toLowerCase() || a.name.toLowerCase() === `build ${targetName.toLowerCase()}`);
    if (!buildAction) return 0;

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
        if (!cell || !cell.terrain || cell.terrain.elevation <= SeaLevel) continue;
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

    if (candidates.length === 0) return 0;

    // Closest first; a farther site wins only if its relative yield gain
    // justifies the extra travel: each extra hex must buy at least
    // `distancePenalty` of relative yield (0.2 = 20% richer per hex).
    candidates.sort((a, b) => a.dist - b.dist || b.yield - a.yield);
    let best = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
        const c = candidates[i];
        if (c.yield > best.yield) {
            const gain = best.yield > 0 ? c.yield / best.yield - 1 : Infinity;
            if (distancePenalty * (c.dist - best.dist) < gain) best = c;
        }
    }

    aiLog(owner || 'AI', 'build', `Build ${canonicalName}: ${candidates.length} candidate site(s), chose (${best.cell.q},${best.cell.r}) dist ${best.dist} expected yield ${best.yield.toFixed(1)} (penalty ${distancePenalty}).`);

    let ordersUsed = 0;

    // Move into staging position (adjacent to the build site).
    if (best.stage.path.length > 0) {
        if (!moveAction || !(sourceEntity.actionPoints > 0)) return 0;
        const moved = moveAlongPath(owner, sourceEntity, moveAction, best.stage.path, gameState, 'build',
            `moving to build ${canonicalName} at (${best.cell.q},${best.cell.r})`);
        if (!moved) return 0;
        ordersUsed = 1;
    }

    // Out of orders: stop here without re-targeting; the same build command
    // next turn will re-select this site and continue.
    if (ordersUsed >= availableOrders) return ordersUsed;
    if (HexGrid.distance(sourceEntity, best.cell) !== 1) return ordersUsed;

    const checkBuild = buildAction.canDo(best.cell, null);
    if (checkBuild && checkBuild.possible) {
        if (buildAction.do(best.cell, null)) {
            aiLog(owner || 'AI', 'build', `Built ${canonicalName} at (${best.cell.q},${best.cell.r}).`);
            return ordersUsed + 1;
        }
    } else {
        aiLog(owner || 'AI', 'warn', `Build ${canonicalName} at (${best.cell.q},${best.cell.r}) failed check: ${checkBuild ? checkBuild.reason : 'unknown'}`);
    }
    return ordersUsed;
}


/**
 * Supports targetEntity with sourceEntity: moves adjacent to it and performs
 * the named action (e.g. "Repair"; future actions like buff/defend work the
 * same way). With no actionName, the unit simply moves up to the target unit,
 * which lets an LLM move units as a group (move one, then have others support
 * it so they follow along).
 * If already adjacent, performs the action directly (or nothing, when just
 * moving along). If orders run out after moving, returns without acting; the
 * same call next turn continues.
 *
 * @param {GameState} gameState
 * @param {BaseEntity} sourceEntity
 * @param {BaseEntity} targetEntity
 * @param {string|null} [actionName] action to perform once adjacent (case-insensitive); null = just move up
 * @param {number} [maxOrders] max orders to spend
 * @returns {number} Number of orders used
 */
export function support(gameState, sourceEntity, targetEntity, actionName = null, maxOrders = 1) {
    if (!gameState || !sourceEntity || !targetEntity || !sourceEntity.active) return 0;
    if (targetEntity.destroyed) return 0;
    if (maxOrders <= 0) return 0;

    const owner = sourceEntity.owner;
    const availableOrders = Math.min(maxOrders, owner ? owner.orders : maxOrders);
    if (availableOrders <= 0) return 0;

    const actions = sourceEntity.getActions ? sourceEntity.getActions() : [];
    let supportAction = null;
    if (actionName) {
        supportAction = actions.find(a => a.name && a.name.toLowerCase() === String(actionName).toLowerCase());
        if (!supportAction) {
            aiLog(owner || 'AI', 'warn', `${sourceEntity.name} has no "${actionName}" action to support ${targetEntity.name} with.`);
            return 0;
        }
    }

    const moveAction = actions.find(a => a.name === "Move");
    const targetCell = targetEntity.cell;

    const tryAct = () => {
        if (!supportAction) return 0;
        const check = supportAction.canDo(targetCell, targetEntity);
        if (check && check.possible && supportAction.do(targetCell, targetEntity)) {
            aiLog(owner || 'AI', 'detail', `${sourceEntity.name} used ${supportAction.name} on ${targetEntity.name}.`);
            return 1;
        }
        return 0;
    };

    // 1. If adjacent, act directly (nothing to do when merely moving along)
    if (HexGrid.distance(sourceEntity, targetEntity) === 1) {
        return tryAct();
    }

    // 2. Move adjacent, then act if orders remain
    if (moveAction && sourceEntity.actionPoints > 0) {
        const targetNeighbors = gameState.hexGrid.getNeighbors(targetEntity.q, targetEntity.r);
        targetNeighbors.sort((a, b) => HexGrid.distance(sourceEntity, a) - HexGrid.distance(sourceEntity, b));

        for (const adjCell of targetNeighbors) {
            if (gameState.getEntityAt(adjCell.q, adjCell.r)) continue;

            const checkMove = moveAction.canDo(adjCell, null);
            if (checkMove && checkMove.possible) {
                if (moveAction.do(adjCell, null)) {
                    let ordersUsed = 1;
                    if (supportAction && availableOrders > 1) {
                        ordersUsed += tryAct();
                    }
                    return ordersUsed;
                }
            }
        }
    }

    return 0;
}

/**
 * Update UI and render after an action is done.
 * @param {GameState} gameState 
 */
export async function onActionDone(gameState, involvedCells = null) {
    if (!CONFIG.SHOW_ALL && Array.isArray(involvedCells) && involvedCells.length > 0) {
        if (!involvedCells.some(cell => gameState.isVisibleToHuman(cell))) {
            console.debug("AI action done (no visible cells)");
            return;
        }
    }
    console.debug("AI action done (visible)");
    reconcileEntities(gameState);
    updatePlayersUI();
    await sleep(CONFIG.AI_ACTION_SLEEP);
}

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
    if (!fromCoord || !Array.isArray(entities) || entities.length === 0) return null;
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
    if (!Array.isArray(myEntities) || !targetEntity) return [];

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
 * Move a unit along a path as far as action points allow within a single order.
 * Walks backward from the furthest reachable step along the path and executes the move.
 * 
 * @param {Player} player 
 * @param {BaseEntity} unit 
 * @param {Object} moveAction 
 * @param {Array<Object>} path 
 * @param {GameState} gameState 
 * @param {string} category 
 * @param {string} reason 
 * @returns {number} Orders used (1 if moved, 0 otherwise)
 */
export function moveAlongPath(player, unit, moveAction, path, gameState, category = 'explore', reason = '') {
    if (!path || path.length === 0 || !moveAction) return 0;

    const startCoord = `${unit.q},${unit.r}`;

    // Try destination first if directly affordable
    const lastCell = path[path.length - 1];
    if (!gameState.getEntityAt(lastCell.q, lastCell.r)) {
        const fullCheck = moveAction.canDo(lastCell, null);
        if (fullCheck && fullCheck.possible && moveAction.do(lastCell, null)) {
            aiLog(player, category, `Move ${unit.name} from (${startCoord}) to (${lastCell.q},${lastCell.r}). ${reason}`);
            return 1;
        }
    }

    // Step back to farthest affordable step within unit AP budget
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
                aiLog(player, category, `Move ${unit.name}: ${note} from (${startCoord}) to (${stepCell.q},${stepCell.r}). ${reason}`);
                return 1;
            }
        }
    }
    return 0;
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
    const grid = gameState.hexGrid;
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

/**
 * Moves a unit to explore, using at most 1 order. The caller repeats the call
 * to keep exploring across orders/turns.
 *
 * - direction (optional): one of DIRECTIONS_8; only unexplored cells lying in
 *   that compass direction from the unit are considered.
 * - getTreasure (optional): move onto (or towards) the closest treasure on an
 *   explored cell. Overrides direction. Falls back to normal exploration when
 *   no treasure is reachable.
 * - targetedCells (optional): "q,r" keys or cells to ignore (already claimed
 *   by other explorers); the chosen target is added on success.
 *
 * Unit choice (mobile, non-builder, etc.) is the caller's job.
 *
 * @param {GameState} gameState
 * @param {BaseEntity} unit
 * @param {string|null} [direction]
 * @param {boolean} [getTreasure]
 * @param {Set<string>|Array|null} [targetedCells]
 * @returns {number} 1 if the unit moved, 0 otherwise
 */
export function explore(gameState, unit, direction = null, getTreasure = false, targetedCells = null) {
    if (!gameState || !unit || !unit.active) return 0;
    const grid = gameState.hexGrid;
    if (!grid) return 0;
    const player = unit.owner;
    const moveAction = unit.getActions ? unit.getActions().find(a => a.name === "Move") : null;
    if (!moveAction) return 0;
    if (unit.actionPoints !== undefined && unit.actionPoints <= 0) return 0;

    const claim = (targetCell) => {
        if (targetedCells instanceof Set) targetedCells.add(`${targetCell.q},${targetCell.r}`);
        else if (Array.isArray(targetedCells)) targetedCells.push(targetCell);
    };

    const doExplore = (targetCells, reason) => {
        const res = findPathTowardsUnexplored(unit, gameState, player, targetedCells, targetCells);
        if (res.fullyExplored) {
            aiLog(player || 'AI', 'explore', `All map territory is fully explored.`);
            return 0;
        }
        if (!res.targetCell || !res.path || res.path.length === 0) return 0;
        const used = moveAlongPath(player, unit, moveAction, res.path, gameState, 'explore', reason);
        if (used > 0) {
            claim(res.targetCell);
            aiLog(player || 'AI', 'explore', `${unit.name} exploring ${reason} -> (${res.targetCell.q},${res.targetCell.r}).`);
            return 1;
        }
        return 0;
    };

    // Treasure mode overrides direction: closest treasure on an explored cell.
    // The unit must move ONTO the cell to pick the treasure up.
    if (getTreasure && player) {
        const treasures = [];
        for (const cell of grid.getCellsArray()) {
            if (!cell || cell.resource?.kind !== 'treasure') continue;
            if (!player.isExplored(cell.q, cell.r)) continue;
            treasures.push(cell);
        }
        if (treasures.length > 0 && doExplore(treasures, 'towards treasure')) return 1;
        // Fall back to normal exploration (direction stays overridden).
        return explore(gameState, unit, null, false, targetedCells);
    }

    if (direction) {
        if (!DIRECTIONS_8.includes(direction)) {
            aiLog(player || 'AI', 'warn', `explore: unknown direction "${direction}" (expected one of ${DIRECTIONS_8.join(', ')}).`);
            return 0;
        }
        const fromCell = unit.cell || grid.getCell(unit.q, unit.r);
        const targets = [];
        for (const cell of grid.getCellsArray()) {
            if (!cell) continue;
            if (player && player.isExplored(cell.q, cell.r)) continue;
            if (grid.directionTo(fromCell, cell).fromSource === direction) targets.push(cell);
        }
        if (targets.length === 0) {
            aiLog(player || 'AI', 'explore', `No unexplored cells to the ${direction}.`);
            return 0;
        }
        return doExplore(targets, `to the ${direction}`);
    }

    return doExplore(null, 'towards unexplored territory');
}

