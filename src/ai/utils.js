import { HexGrid } from '../hexGrid.js';
import { camelToTitle } from '../utils.js';
import { SeaLevel } from '../terrainProvider.js';
import { calculateAttackMultiplier } from '../utils.js';
import { drawGrid, reconcileEntities } from '../renderer.js';
import { updatePlayersUI } from '../main.js';

/**
 * Attacks targetEntity with sourceEntity using the specified algorithm:
 * while (ordersUsed < maxOrders)
 *   - if attackMultiplier > 1 then try to attack
 *   - otherwise try to move
 *      - choose a cell that you can reach using 1 order that you can attack from that provides the best attackMultiplier
 *      - if no such cell, then move as close to the target as possible
 *   - if you can NOT move at all but can do an attack from current cell then do the attack
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

    while (ordersUsed < availableOrders && sourceEntity.active && !targetEntity.destroyed && targetEntity.health > 0) {
        // Check if we can attack from current position and get the multiplier
        const currentAttackCheck = attackAction.canDo(targetCell, targetEntity);
        const isCurrentPossible = currentAttackCheck && currentAttackCheck.possible;
        const currentMult = isCurrentPossible ? calculateAttackMultiplier(gameState, sourceEntity.cell, sourceEntity.damage.elevationAdjustment, targetEntity).total : 0;

        // If attackMultiplier > 1, try to attack
        if (isCurrentPossible && currentMult > 1.0) {
            const didAttack = attackAction.do(targetCell, targetEntity);
            if (didAttack) {
                ordersUsed++;
                continue; // Continue loop to potentially attack again
            } else {
                break; // Attack failed, exit loop
            }
        }

        // Otherwise try to move to a better position
        if (moveAction && sourceEntity.actionPoints > 0) {
            // Find path to target and collect neighbors of path cells + current neighbors
            const pathResult = gameState.hexGrid.movementCostTo(sourceEntity.cell, targetCell);
            const pathCells = pathResult ? pathResult.path : [];
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
                const moved = moveAction.do(bestMoveCell, null);
                if (moved) {
                    ordersUsed++;
                    continue; // Continue loop, will try to attack from new position
                }
            }

            // If no cell with better multiplier, move as close to target as possible
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
                const moved = moveAction.do(closestCell, null);
                if (moved) {
                    ordersUsed++;
                    continue; // Continue loop, will try to attack from new position
                }
            }
        }

        // If we can NOT move at all but can do an attack from current cell then do the attack
        if (isCurrentPossible) {
            const didAttack = attackAction.do(targetCell, targetEntity);
            if (didAttack) {
                ordersUsed++;
                continue;
            } else {
                break;
            }
        }

        // If all else fails, break loop and return
        break;
    }

    return ordersUsed;
}

/**
 * Builds targetName construct or unit with sourceEntity.
 * Attempts construction on neighboring cells. If none support construction and sourceEntity can move,
 * finds the closest cell in the grid supporting construction, moves adjacent to it, and builds.
 * 
 * @param {GameState} gameState
 * @param {BaseEntity} sourceEntity
 * @param {string} targetName
 * @returns {number} Number of orders used
 */
export function build(gameState, sourceEntity, targetName) {
    if (!gameState || !sourceEntity || !targetName || !sourceEntity.active) return 0;

    const availableOrders = sourceEntity.owner ? sourceEntity.owner.orders : 1;
    if (availableOrders <= 0) return 0;

    const actions = sourceEntity.getActions ? sourceEntity.getActions() : [];
    const expectedActionName = `Build ${camelToTitle(targetName)}`;
    const buildAction = actions.find(a => a.name.toLowerCase() === expectedActionName.toLowerCase() || a.name.toLowerCase() === `build ${targetName.toLowerCase()}`);
    if (!buildAction) return 0;

    const moveAction = actions.find(a => a.name === "Move");

    // 1. Try all immediate neighboring cells
    const neighbors = gameState.hexGrid ? gameState.hexGrid.getNeighbors(sourceEntity.q, sourceEntity.r) : [];
    for (const neighborCell of neighbors) {
        const targetOccupant = gameState.getEntityAt(neighborCell.q, neighborCell.r);
        const check = buildAction.canDo(neighborCell, targetOccupant);
        if (check && check.possible) {
            const built = buildAction.do(neighborCell, targetOccupant);
            if (built) return 1;
        }
    }

    // 2. If no neighbor works and entity can move, find the closest cell that supports construction
    if (availableOrders > 1 && moveAction && sourceEntity.actionPoints > 0) {
        const meta = gameState.manifestData?.entities?.[targetName] || gameState.manifestData?.entities?.[targetName.toLowerCase()];
        const spawnConditions = meta ? meta.spawnConditions : null;
        const allCells = gameState.hexGrid.getCellsArray();

        const candidateCells = allCells.filter(cell => {
            if (!cell || !cell.terrain || cell.terrain.elevation <= SeaLevel) return false;
            if (gameState.getEntityAt(cell.q, cell.r)) return false;

            if (spawnConditions) {
                if (Array.isArray(spawnConditions.terrain) && spawnConditions.terrain.length > 0) {
                    const tName = cell.terrain.name || '';
                    if (!spawnConditions.terrain.some(t => t.toLowerCase() === tName.toLowerCase())) {
                        return false;
                    }
                }
                if (typeof spawnConditions.minSeparation === 'number') {
                    const reqSep = spawnConditions.minSeparation;
                    const entities = gameState.entities || [];
                    const manifestEnts = gameState.manifestData?.entities || {};
                    for (const e of entities) {
                        const eMeta = manifestEnts[e.name];
                        const eSep = eMeta?.spawnConditions?.minSeparation;
                        if (typeof eSep === 'number') {
                            const needed = Math.max(reqSep, eSep);
                            if (HexGrid.distance(cell, e) < needed) return false;
                        }
                    }
                }
            }
            return true;
        });

        // Sort by distance to sourceEntity
        candidateCells.sort((a, b) => HexGrid.distance(sourceEntity, a) - HexGrid.distance(sourceEntity, b));

        for (const targetBuildCell of candidateCells.slice(0, 8)) {
            const adjNeighbors = gameState.hexGrid.getNeighbors(targetBuildCell.q, targetBuildCell.r);
            adjNeighbors.sort((a, b) => HexGrid.distance(sourceEntity, a) - HexGrid.distance(sourceEntity, b));

            for (const stepCell of adjNeighbors) {
                if (gameState.getEntityAt(stepCell.q, stepCell.r)) continue;

                const checkMove = moveAction.canDo(stepCell, null);
                if (checkMove && checkMove.possible) {
                    const moved = moveAction.do(stepCell, null);
                    if (moved) {
                        const checkBuild = buildAction.canDo(targetBuildCell, null);
                        if (checkBuild && checkBuild.possible) {
                            const built = buildAction.do(targetBuildCell, null);
                            return built ? 2 : 1;
                        }
                        return 1;
                    }
                }
            }
        }
    }

    return 0;
}

// TODO change this to support (could be actions like enhance - increases yield, defend - increases defense, etc.) and not just repair
/**
 * Repairs targetEntity with sourceEntity.
 * If target is adjacent, performs repair directly.
 * If not adjacent and maxOrders > 1, moves adjacent to targetEntity, then repairs.
 * 
 * @param {GameState} gameState
 * @param {BaseEntity} sourceEntity
 * @param {BaseEntity} targetEntity
 * @param {number} maxOrders
 * @returns {number} Number of orders used
 */
export function repair(gameState, sourceEntity, targetEntity, maxOrders = 1) {
    if (!gameState || !sourceEntity || !targetEntity || maxOrders <= 0) return 0;
    if (!sourceEntity.active) return 0;

    const availableOrders = Math.min(maxOrders, sourceEntity.owner ? sourceEntity.owner.orders : maxOrders);
    if (availableOrders <= 0) return 0;

    const actions = sourceEntity.getActions ? sourceEntity.getActions() : [];
    const repairAction = actions.find(a => a.name === "Repair");
    if (!repairAction) return 0;

    const moveAction = actions.find(a => a.name === "Move");
    const targetCell = targetEntity.cell;

    // 1. If adjacent, perform repair directly
    if (HexGrid.distance(sourceEntity, targetEntity) === 1) {
        const check = repairAction.canDo(targetCell, targetEntity);
        if (check && check.possible) {
            const repaired = repairAction.do(targetCell, targetEntity);
            return repaired ? 1 : 0;
        }
    }

    // 2. If not adjacent and maxOrders > 1, move adjacent and repair
    if (availableOrders > 1 && moveAction && sourceEntity.actionPoints > 0) {
        const targetNeighbors = gameState.hexGrid.getNeighbors(targetEntity.q, targetEntity.r);
        targetNeighbors.sort((a, b) => HexGrid.distance(sourceEntity, a) - HexGrid.distance(sourceEntity, b));

        for (const adjCell of targetNeighbors) {
            if (gameState.getEntityAt(adjCell.q, adjCell.r)) continue;

            const checkMove = moveAction.canDo(adjCell, null);
            if (checkMove && checkMove.possible) {
                const moved = moveAction.do(adjCell, null);
                if (moved) {
                    let ordersUsed = 1;
                    if (targetEntity.health < targetEntity.maxHealth) {
                        const checkRepair = repairAction.canDo(targetCell, targetEntity);
                        if (checkRepair && checkRepair.possible) {
                            const repaired = repairAction.do(targetCell, targetEntity);
                            if (repaired) ordersUsed++;
                        }
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
export function onActionDone(gameState) {
    drawGrid(gameState.cells, gameState.activePlayer);
    reconcileEntities(gameState);
    updatePlayersUI();
}