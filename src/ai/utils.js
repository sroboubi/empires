import { HexGrid } from '../hexGrid.js';
import { camelToTitle } from '../utils.js';
import { SeaLevel } from '../terrainProvider.js';

const DIRECTIONS_LIST = ['E', 'NE', 'NW', 'W', 'SW', 'SE'];

/**
 * Calculates the combined directional and elevation damage multiplier from an attacker cell against a target entity.
 */
export function calculateAttackMultiplier(gameState, sourceEntity, fromCell, targetEntity, targetCell) {
    let multiplier = 1.0;

    if (gameState && gameState.hexGrid && targetEntity.facing) {
        const dirFromTargetToAttacker = gameState.hexGrid.directionTo(targetEntity, fromCell).fromSource;
        const idxTarget = DIRECTIONS_LIST.indexOf(targetEntity.facing);
        const idxAttacker = DIRECTIONS_LIST.indexOf(dirFromTargetToAttacker);

        if (idxTarget !== -1 && idxAttacker !== -1) {
            let diff = Math.abs(idxTarget - idxAttacker);
            if (diff > 3) diff = 6 - diff;

            if (diff === 0) multiplier = 1.0;        // Front
            else if (diff === 1 || diff === 2) multiplier = 1.5;  // Side
            else if (diff === 3) multiplier = 2.0;    // Behind
        }
    }

    let elevationFactor = 1.0;
    if (sourceEntity.damage && typeof sourceEntity.damage.elevationAdjustment === 'number' && sourceEntity.damage.elevationAdjustment > 0) {
        const getElev = (c) => (c && c.terrain && (c.terrain.height ?? c.terrain.elevation)) ?? 1.0;
        const attackerElevation = Math.max(0.1, getElev(fromCell));
        const targetElevation = Math.max(0.1, getElev(targetCell));
        const ratio = attackerElevation / targetElevation;
        if (ratio > 1.01) {
            elevationFactor = ratio * sourceEntity.damage.elevationAdjustment;
        } else if (ratio < 0.99) {
            elevationFactor = ratio / sourceEntity.damage.elevationAdjustment;
        }
    }

    return multiplier * elevationFactor;
}

/**
 * Attacks targetEntity with sourceEntity.
 * If target is in range and (directional x elevation) multiplier >= 1, performs attack directly.
 * Otherwise, if possible and maxOrders > 1, moves to a cell within range that maximizes the multiplier, then attacks.
 * Continues performing attacks if orders remain, target is alive, and source has AP.
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

    const availableOrders = Math.min(maxOrders, sourceEntity.owner ? sourceEntity.owner.orders : 1);
    if (availableOrders <= 0) return 0;

    const actions = sourceEntity.getActions ? sourceEntity.getActions() : [];
    const attackAction = actions.find(a => a.name === "Attack");
    if (!attackAction) return 0;

    const moveAction = actions.find(a => a.name === "Move");

    const currentCell = sourceEntity.cell || gameState.hexGrid?.getCell(sourceEntity.q, sourceEntity.r);
    const targetCell = targetEntity.cell || gameState.hexGrid?.getCell(targetEntity.q, targetEntity.r);
    if (!currentCell || !targetCell) return 0;

    const currentAttackCheck = attackAction.canDo(targetCell, targetEntity);
    const isCurrentPossible = currentAttackCheck && currentAttackCheck.possible;
    const currentMult = isCurrentPossible ? calculateAttackMultiplier(gameState, sourceEntity, currentCell, targetEntity, targetCell) : 0;

    // 1. If currently in range and multiplier >= 1.0, attack directly
    if (isCurrentPossible && currentMult >= 1.0) {
        let ordersUsed = 0;
        const didAttack = attackAction.do(targetCell, targetEntity);
        if (didAttack) {
            ordersUsed++;
            // Chain consecutive attacks while orders remain and target is alive
            while (ordersUsed < availableOrders && !targetEntity.destroyed && targetEntity.health > 0 && sourceEntity.active) {
                const followCheck = attackAction.canDo(targetCell, targetEntity);
                if (followCheck && followCheck.possible) {
                    const followSuccess = attackAction.do(targetCell, targetEntity);
                    if (followSuccess) ordersUsed++;
                    else break;
                } else {
                    break;
                }
            }
            return ordersUsed;
        }
    }

    // 2. If not in range or multiplier < 1.0, attempt to reposition if maxOrders > 1
    if (availableOrders > 1 && moveAction && sourceEntity.actionPoints > 0) {
        const neighbors = gameState.hexGrid.getNeighbors(sourceEntity.q, sourceEntity.r);
        let bestCell = null;
        let bestMult = currentMult;

        for (const candCell of neighbors) {
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
                const mult = calculateAttackMultiplier(gameState, sourceEntity, candCell, targetEntity, targetCell);
                if (mult > bestMult || (!isCurrentPossible && mult >= 1.0) || (!bestCell && inRange)) {
                    bestMult = mult;
                    bestCell = candCell;
                }
            }
        }

        if (bestCell) {
            const moved = moveAction.do(bestCell, null);
            if (moved) {
                let ordersUsed = 1;
                const attackCheck = attackAction.canDo(targetCell, targetEntity);
                if (attackCheck && attackCheck.possible) {
                    const attacked = attackAction.do(targetCell, targetEntity);
                    if (attacked) {
                        ordersUsed++;
                        while (ordersUsed < availableOrders && !targetEntity.destroyed && targetEntity.health > 0 && sourceEntity.active) {
                            const followCheck = attackAction.canDo(targetCell, targetEntity);
                            if (followCheck && followCheck.possible) {
                                const followSuccess = attackAction.do(targetCell, targetEntity);
                                if (followSuccess) ordersUsed++;
                                else break;
                            } else {
                                break;
                            }
                        }
                    }
                }
                return ordersUsed;
            }
        }
    }

    // 3. Fallback: If currently in range (even if mult < 1.0) and could not reposition, attack anyway
    if (isCurrentPossible && availableOrders >= 1) {
        let ordersUsed = 0;
        const didAttack = attackAction.do(targetCell, targetEntity);
        if (didAttack) {
            ordersUsed++;
            while (ordersUsed < availableOrders && !targetEntity.destroyed && targetEntity.health > 0 && sourceEntity.active) {
                const followCheck = attackAction.canDo(targetCell, targetEntity);
                if (followCheck && followCheck.possible) {
                    const followSuccess = attackAction.do(targetCell, targetEntity);
                    if (followSuccess) ordersUsed++;
                    else break;
                } else {
                    break;
                }
            }
            return ordersUsed;
        }
    }

    return 0;
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

    const availableOrders = Math.min(maxOrders, sourceEntity.owner ? sourceEntity.owner.orders : 1);
    if (availableOrders <= 0) return 0;

    const actions = sourceEntity.getActions ? sourceEntity.getActions() : [];
    const repairAction = actions.find(a => a.name === "Repair");
    if (!repairAction) return 0;

    const moveAction = actions.find(a => a.name === "Move");
    const targetCell = targetEntity.cell || gameState.hexGrid?.getCell(targetEntity.q, targetEntity.r);
    if (!targetCell) return 0;

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
