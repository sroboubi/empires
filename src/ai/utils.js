import { HexGrid } from '../hexGrid.js';
import { camelToTitle } from '../utils.js';
import { SeaLevel } from '../terrainProvider.js';
import { sleep, calculateAttackMultiplier } from '../utils.js';
import { reconcileEntities } from '../renderer.js';
import { updatePlayersUI } from '../main.js';
import { CONFIG } from '../config.js';

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
        if (moveAction && sourceEntity.actionPoints > 0) {
            // Find path to target and collect neighbors of path cells + current neighbors
            const pathResult = gameState.hexGrid.movementCostTo(sourceEntity.cell, targetCell);
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
                const moved = moveAction.do(bestMoveCell, null);
                if (moved) {
                    ordersUsed++;
                    aiLog(attackerPlayer, 'combat', `Repositioning: ${sourceEntity.name} moved from ${fromCoord} to (${bestMoveCell.q},${bestMoveCell.r}) for better attack multiplier (${bestMoveMult.toFixed(2)}x vs ${currentMult.toFixed(2)}x). AP left: ${sourceEntity.actionPoints}. Order used: ${ordersUsed}/${availableOrders}.`);
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
                const fromCoord = `(${sourceEntity.q},${sourceEntity.r})`;
                const moved = moveAction.do(closestCell, null);
                if (moved) {
                    ordersUsed++;
                    aiLog(attackerPlayer, 'combat', `Repositioning: ${sourceEntity.name} moved from ${fromCoord} to (${closestCell.q},${closestCell.r}) to close distance on ${targetEntity.name} (dist: ${closestDist}). AP left: ${sourceEntity.actionPoints}. Order used: ${ordersUsed}/${availableOrders}.`);
                    continue; // Continue loop, will try to attack from new position
                }
            }
        }

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
export async function onActionDone(gameState, involvedCells = null) {
    if (Array.isArray(involvedCells)) {
        const humanVisibleCells = gameState.humanVisibleCells();
        if (!involvedCells.some(cell => humanVisibleCells.has(cell))) {
            updatePlayersUI();
            return;
        }
    }
    console.log("AI action done");
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
    console.log(`%c[AI ${pName}][${category}] ${message}`, LOG_STYLES[category] || '');
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
        acc += path[i].terrain?.movementCost || 1;
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
 * Finds a path from an explorer towards the nearest unexplored cell on the map.
 * 
 * Behavior:
 * 1. Checks all unexplored cells on the map. If none exist, reports map fully explored.
 * 2. Uses BFS from the explorer across walkable terrain (explorer.canStandOn).
 * 3. Identifies reachable unexplored cells or reachable walkable cells that border unexplored cells.
 * 4. If all reachable cells and their borders are already explored, finds the closest unexplored
 *    cell on the map (by hex distance) and pathfinds to the reachable cell closest to that target
 *    (e.g., shoreline/frontier facing the target), so the unit moves TOWARDS it.
 * 5. Returns { targetCell, path, fullyExplored, arrivedAtBestReachable }.
 * 
 * Note: A unit does not need to reach the unexplored cell in the same turn; as it moves along
 * the path across turns, its sight range dynamically reveals unexplored cells.
 * 
 * @param {BaseEntity} explorer 
 * @param {GameState} gameState 
 * @param {Player} player 
 * @param {Set<string>} [targetedCells]
 * @returns {{targetCell: Object|null, path: Array<Object>, fullyExplored: boolean, arrivedAtBestReachable: boolean}}
 */
export function findPathTowardsUnexplored(explorer, gameState, player, targetedCells = new Set()) {
    const grid = gameState.hexGrid;
    if (!grid || !explorer || !player) {
        return { targetCell: null, path: [], fullyExplored: false, arrivedAtBestReachable: true };
    }

    const startCell = explorer.cell || grid.getCell(explorer.q, explorer.r);
    if (!startCell) {
        return { targetCell: null, path: [], fullyExplored: false, arrivedAtBestReachable: true };
    }

    const allCells = grid.getCellsArray ? grid.getCellsArray() : Object.values(grid.cells || {});
    const unexploredCells = allCells.filter(c => c && !player.isExplored(c.q, c.r));

    if (unexploredCells.length === 0) {
        return { targetCell: null, path: [], fullyExplored: true, arrivedAtBestReachable: true };
    }

    // BFS across walkable terrain from explorer
    const reachable = new Map(); // key -> { cell, path }
    const startKey = `${explorer.q},${explorer.r}`;
    reachable.set(startKey, { cell: startCell, path: [] });

    const queue = [{ q: explorer.q, r: explorer.r, path: [] }];
    const directUnexplored = [];
    const borderUnexplored = [];

    while (queue.length > 0) {
        const cur = queue.shift();
        const neighbors = grid.getNeighbors(cur.q, cur.r);

        for (const nb of neighbors) {
            const nbKey = `${nb.q},${nb.r}`;

            // Check if neighbor itself is unexplored
            const nbExplored = player.isExplored(nb.q, nb.r);
            if (!nbExplored) {
                // If explorer can stand on it, it's a direct walkable unexplored cell
                if (explorer.canStandOn(nb) && !reachable.has(nbKey)) {
                    const pathToNb = [...cur.path, nb];
                    directUnexplored.push({ targetCell: nb, path: pathToNb, dist: pathToNb.length });
                } else {
                    // nb is impassable (water/mountain) or already visited; reaching cur borders it
                    borderUnexplored.push({ targetCell: nb, path: cur.path, dist: cur.path.length, borderCell: cur });
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

    // Priority 1: Reachable unexplored cells that can be directly walked on
    if (directUnexplored.length > 0) {
        // Sort by distance; prefer cells not already targeted by other explorers
        directUnexplored.sort((a, b) => {
            const aTargeted = targetedCells.has(`${a.targetCell.q},${a.targetCell.r}`) ? 1 : 0;
            const bTargeted = targetedCells.has(`${b.targetCell.q},${b.targetCell.r}`) ? 1 : 0;
            if (aTargeted !== bTargeted) return aTargeted - bTargeted;
            return a.dist - b.dist;
        });

        const best = directUnexplored[0];
        return { targetCell: best.targetCell, path: best.path, fullyExplored: false, arrivedAtBestReachable: false };
    }

    // Priority 2: Reachable walkable cells that border unexplored hexes (e.g. coastal waters or cliffs)
    const validBorderTargets = borderUnexplored.filter(b => b.path.length > 0);
    if (validBorderTargets.length > 0) {
        validBorderTargets.sort((a, b) => {
            const aTargeted = targetedCells.has(`${a.targetCell.q},${a.targetCell.r}`) ? 1 : 0;
            const bTargeted = targetedCells.has(`${b.targetCell.q},${b.targetCell.r}`) ? 1 : 0;
            if (aTargeted !== bTargeted) return aTargeted - bTargeted;
            return a.dist - b.dist;
        });

        const best = validBorderTargets[0];
        return { targetCell: best.targetCell, path: best.path, fullyExplored: false, arrivedAtBestReachable: false };
    }

    // Priority 3: All reachable terrain on this landmass is fully explored.
    // Pick the closest unexplored cell anywhere on the map, and move to the reachable cell
    // that brings the explorer closest to that unexplored target (e.g. the frontier/coast facing it).
    const sortedUnexplored = [...unexploredCells].sort((a, b) => {
        const aTargeted = targetedCells.has(`${a.q},${a.r}`) ? 1 : 0;
        const bTargeted = targetedCells.has(`${b.q},${b.r}`) ? 1 : 0;
        if (aTargeted !== bTargeted) return aTargeted - bTargeted;
        return HexGrid.distance(explorer, a) - HexGrid.distance(explorer, b);
    });

    const chosenTarget = sortedUnexplored[0];
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

