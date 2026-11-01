/**
 * AI action functions that need engine callbacks.
 *
 * These functions read engine dependencies from the module-level registry in
 * `deps.js` (initialized by `BaseManager` from the engine-supplied `deps`
 * object). They contain no engine imports.
 */
import { getHexGrid, getDirections8, getAIConfig, getAIHooks } from './deps.js';
import {
    aiLog,
    findWalkablePath,
    findBuildCandidates,
    findPathTowardsUnexplored,
} from './aiUtils.js';

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
 * @returns {{ordersUsed: number, result: {status: string, message: string}}} Result with orders used and outcome.
 */
export function attack(gameState, sourceEntity, targetEntity, maxOrders = 1) {
    const fail = (message) => ({ ordersUsed: 0, result: { status: 'failed', message } });
    const HexGrid = getHexGrid();
    const hooks = getAIHooks();
    if (!gameState || !sourceEntity || !targetEntity || maxOrders <= 0 || !HexGrid) return fail('Invalid attack parameters.');
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
    const initialDist = HexGrid.distance(sourceEntity.cell || sourceEntity, targetEntity.cell || targetEntity);

    const attackMultiplier = (cell) => {
        if (typeof hooks.calculateAttackMultiplier !== 'function') return { total: 1 };
        return hooks.calculateAttackMultiplier(gameState, cell, sourceEntity.damage.elevationAdjustment, targetEntity);
    };

    aiLog(attackerPlayer, 'combat', `Engaging Target: ${sourceEntity.name}#${sourceEntity.id?.slice(-4)} (${attackerPlayer.name}) at (${sourceEntity.q},${sourceEntity.r}) [HP:${Math.round(sourceEntity.health)}/${sourceEntity.maxHealth}, AP:${sourceEntity.actionPoints}] attacking ${targetPlayer.name}'s ${targetEntity.name}#${targetEntity.id?.slice(-4)} at (${targetEntity.q},${targetEntity.r}) [HP:${Math.round(targetEntity.health)}/${targetEntity.maxHealth}, Dist:${initialDist} hexes, MaxOrders:${availableOrders}].`);

    let lastCheckReason = 'Target unreachable or insufficient AP';

    while (ordersUsed < availableOrders && sourceEntity.active && !targetEntity.destroyed && targetEntity.health > 0) {
        // Check if we can attack from current position and get the multiplier
        const currentAttackCheck = attackAction.canDo(targetCell, targetEntity);
        const isCurrentPossible = currentAttackCheck && currentAttackCheck.possible;
        if (currentAttackCheck && !currentAttackCheck.possible) {
            lastCheckReason = currentAttackCheck.reason;
        }
        const currentMult = isCurrentPossible ? attackMultiplier(sourceEntity.cell).total : 0;

        // If attackMultiplier > 1, try to attack
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
                    const mult = attackMultiplier(candCell).total;
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
                    movedCloser = true;
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
                        movedCloser = true;
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
                totalDamage += damageDealt;
                attacksLanded++;
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

    const targetDead = targetEntity.destroyed || targetEntity.health <= 0;
    if (ordersUsed > 0) {
        const finalStatus = targetDead
            ? 'TARGET DESTROYED'
            : `Target survived (HP: ${Math.round(targetEntity.health)}/${targetEntity.maxHealth})`;
        aiLog(attackerPlayer, 'combat', `Attack Sequence Complete: ${sourceEntity.name} used ${ordersUsed} order(s) against ${targetPlayer.name}'s ${targetEntity.name}. Result: ${finalStatus}. Attacker AP left: ${sourceEntity.actionPoints}.`);
    } else {
        aiLog(attackerPlayer, 'detail', `Attack Sequence Incomplete (0 orders used): ${sourceEntity.name} could not attack ${targetEntity.name} (${lastCheckReason}).`);
    }

    // Build the result summary for the caller (e.g. the LLM)
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

/**
 * Builds targetName construct or unit with sourceEntity.
 *
 * All cells (adjacent or not) compete uniformly: candidates must be explored
 * by the owner, within maxDistance, on valid terrain, unoccupied, resourceless,
 * and have a reachable, unoccupied neighboring cell to build from. Each
 * candidate is scored by its expected yield (base yields adjusted for adjacent
 * natural resources via the injected applyResourceYieldBonus hook). The closest
 * candidate wins unless a farther, richer site justifies the trip:
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
 * @returns {{ordersUsed: number, result: {status: string, message: string}}} Result with orders used and outcome.
 */
export function build(gameState, sourceEntity, targetName,
    maxDistance = getAIConfig().buildMaxDistance ?? 10,
    distancePenalty = getAIConfig().buildDistancePenalty ?? 0.2) {
    const fail = (message) => ({ ordersUsed: 0, result: { status: 'failed', message } });
    const HexGrid = getHexGrid();
    const hooks = getAIHooks();
    if (!gameState || !sourceEntity || !targetName || !sourceEntity.active || !HexGrid) return fail('Invalid builder or target.');
    const grid = gameState.hexGrid;
    if (!grid) return fail('No hex grid.');

    const owner = sourceEntity.owner;
    const availableOrders = owner ? owner.orders : 1;
    if (availableOrders <= 0) return fail('No orders available.');

    const actions = sourceEntity.getActions ? sourceEntity.getActions() : [];
    const title = typeof hooks.camelToTitle === 'function' ? hooks.camelToTitle(targetName) : targetName;
    const expectedActionName = `Build ${title}`;
    const buildAction = actions.find(a => a.name.toLowerCase() === expectedActionName.toLowerCase() || a.name.toLowerCase() === `build ${targetName.toLowerCase()}`);
    if (!buildAction) return fail(`${sourceEntity.name} cannot build ${targetName}.`);

    const { candidates, canonicalName } = findBuildCandidates(gameState, sourceEntity, targetName, maxDistance);
    if (candidates.length === 0) return fail(`No valid site to build ${canonicalName}.`);
    const moveAction = (sourceEntity.getActions ? sourceEntity.getActions() : []).find(a => a.name === "Move");


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
    // moveAlongPath moves as far as AP allows; partial movement is reported
    // below, not failed here.
    if (best.stage.path.length > 0) {
        const availableAP = sourceEntity.actionPoints ?? 0;
        if (!moveAction || !(availableAP > 0)) {
            const apRounded = Math.round(availableAP * 10) / 10;
            return fail(`Insufficient AP for movement. ${sourceEntity.name} has ${apRounded} AP but needs to move to build ${canonicalName}.`);
        }
        // Calculate full path cost for the failure message (if movement fails entirely)
        const pathCost = best.stage.path.reduce((sum, cell) => {
            const baseMc = cell.terrain?.movementCost || 1;
            const tcs = sourceEntity.terrainCostScale;
            const tScale = (tcs && cell.terrain?.name in tcs) ? tcs[cell.terrain.name] : 1;
            return sum + (baseMc * tScale);
        }, 0);
        const terrainTypes = [...new Set(best.stage.path.map(c => c.terrain?.name).filter(Boolean))].join(', ');
        const moved = moveAlongPath(owner, sourceEntity, moveAction, best.stage.path, gameState, 'build',
            `moving to build ${canonicalName} at (${best.cell.q},${best.cell.r})`);
        if (!moved) {
            const apRounded = Math.round(availableAP * 10) / 10;
            return fail(`Could not move toward ${canonicalName} site. Full path requires ${pathCost.toFixed(1)} AP${terrainTypes ? ` (Terrain: ${terrainTypes})` : ''}, but ${sourceEntity.name} only has ${apRounded} AP remaining.`);
        }
        ordersUsed = 1;
    }

    // Out of orders: stop here without re-targeting; the same build command
    // next turn will re-select this site and continue.
    if (ordersUsed >= availableOrders) {
        return { ordersUsed, result: { status: 'partial', message: `${sourceEntity.name} moved toward build site for ${canonicalName} but ran out of orders.` } };
    }
    if (HexGrid.distance(sourceEntity, best.cell) !== 1) {
        return { ordersUsed, result: { status: 'partial', message: `${sourceEntity.name} moved toward build site for ${canonicalName} but is not yet in position.` } };
    }

    const checkBuild = buildAction.canDo(best.cell, null);
    if (checkBuild && checkBuild.possible) {
        if (buildAction.do(best.cell, null)) {
            aiLog(owner || 'AI', 'build', `Built ${canonicalName} at (${best.cell.q},${best.cell.r}).`);
            return { ordersUsed: ordersUsed + 1, result: { status: 'completed', message: `Built ${canonicalName} at (${best.cell.q},${best.cell.r}).` } };
        }
        return { ordersUsed, result: { status: 'failed', message: `Build action failed for ${canonicalName}.` } };
    } else {
        const reason = checkBuild ? checkBuild.reason : 'unknown';
        aiLog(owner || 'AI', 'warn', `Build ${canonicalName} at (${best.cell.q},${best.cell.r}) failed check: ${reason}`);
        return { ordersUsed, result: { status: 'failed', message: `Cannot build ${canonicalName}: ${reason}.` } };
    }
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
 * @returns {{ordersUsed: number, result: {status: string, message: string}}} Result with orders used and outcome.
 */
export function support(gameState, sourceEntity, targetEntity, actionName = null, maxOrders = 1) {
    const fail = (message) => ({ ordersUsed: 0, result: { status: 'failed', message } });
    const HexGrid = getHexGrid();
    if (!gameState || !sourceEntity || !targetEntity || !sourceEntity.active || !HexGrid) return fail('Invalid entities or source not active.');
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
            aiLog(owner || 'AI', 'warn', `${sourceEntity.name} has no "${actionName}" action to support ${targetEntity.name} with.`);
            return fail(`${sourceEntity.name} cannot perform "${actionName}".`);
        }
    }

    const moveAction = actions.find(a => a.name === "Move");
    const targetCell = targetEntity.cell;

    const tryAct = () => {
        if (!supportAction) return { ordersUsed: 0, result: { status: 'completed', message: `${sourceEntity.name} moved adjacent to ${targetEntity.name}.` } };
        const check = supportAction.canDo(targetCell, targetEntity);
        if (check && check.possible && supportAction.do(targetCell, targetEntity)) {
            aiLog(owner || 'AI', 'detail', `${sourceEntity.name} used ${supportAction.name} on ${targetEntity.name}.`);
            return { ordersUsed: 1, result: { status: 'completed', message: `${sourceEntity.name} used ${supportAction.name} on ${targetEntity.name}.` } };
        }
        const reason = check && !check.possible ? ` (${check.reason})` : '';
        return fail(`Could not use ${supportAction?.name || actionName} on ${targetEntity.name}${reason}.`);
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
 * @returns {{ordersUsed: number, result: {status: string, message: string}}} Result with orders used and outcome.
 */
export function explore(gameState, unit, direction = null, getTreasure = false, targetedCells = null) {
    const fail = (message) => ({ ordersUsed: 0, result: { status: 'failed', message } });
    const DIRECTIONS_8 = getDirections8();
    if (!gameState || !unit || !unit.active) return fail('Unit is not active or game state missing.');
    const grid = gameState.hexGrid;
    if (!grid) return fail('No hex grid.');
    const player = unit.owner;
    const moveAction = unit.getActions ? unit.getActions().find(a => a.name === "Move") : null;
    if (!moveAction) return fail(`${unit.name} cannot move.`);
    if (unit.actionPoints !== undefined && unit.actionPoints <= 0) return fail(`${unit.name} has no action points.`);

    const claim = (targetCell) => {
        if (targetedCells instanceof Set) targetedCells.add(`${targetCell.q},${targetCell.r}`);
        else if (Array.isArray(targetedCells)) targetedCells.push(targetCell);
    };

    const doExplore = (targetCells, reason) => {
        const res = findPathTowardsUnexplored(unit, gameState, player, targetedCells, targetCells);
        if (res.fullyExplored) {
            aiLog(player || 'AI', 'explore', `All map territory is fully explored.`);
            return fail('Map is fully explored.');
        }
        if (!res.targetCell || !res.path || res.path.length === 0) return fail('No reachable unexplored cell.');
        const used = moveAlongPath(player, unit, moveAction, res.path, gameState, 'explore', reason);
        if (used > 0) {
            claim(res.targetCell);
            aiLog(player || 'AI', 'explore', `${unit.name} exploring ${reason} -> (${res.targetCell.q},${res.targetCell.r}).`);
            return { ordersUsed: 1, result: { status: 'completed', message: `${unit.name} explored ${reason} towards (${res.targetCell.q},${res.targetCell.r}).` } };
        }
        const apR = Math.round((unit.actionPoints ?? 0) * 10) / 10;
        return fail(`Could not move along exploration path. ${unit.name} has ${apR} AP remaining.`);
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
        if (treasures.length > 0) {
            const treasureResult = doExplore(treasures, 'towards treasure');
            if (treasureResult.ordersUsed > 0) return treasureResult;
        }
        // Fall back to normal exploration (direction stays overridden).
        return explore(gameState, unit, null, false, targetedCells);
    }

    if (direction) {
        if (!DIRECTIONS_8.includes(direction)) {
            aiLog(player || 'AI', 'warn', `explore: unknown direction "${direction}" (expected one of ${DIRECTIONS_8.join(', ')}).`);
            return fail(`Unknown direction "${direction}".`);
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

/**
 * Update UI and render after an action is done.
 * @param {GameState} gameState
 */
export async function onActionDone(gameState, involvedCells = null, actionDesc = '') {
    const config = getAIConfig();
    const hooks = getAIHooks();
    if (gameState?.replayRecorder?.isRecording()) {
        gameState.replayRecorder.recordSnapshot(gameState, actionDesc || 'AI action');
    }
    if (!config.showAll && Array.isArray(involvedCells) && involvedCells.length > 0) {
        if (!involvedCells.some(cell => gameState.isVisibleToHuman(cell))) {
            console.debug("AI action done (no visible cells)");
            return;
        }
    }
    console.debug("AI action done (visible)");
    if (typeof hooks.reconcileEntities === 'function') hooks.reconcileEntities(gameState);
    if (typeof hooks.updatePlayersUI === 'function') hooks.updatePlayersUI();
    if (typeof hooks.sleep === 'function') await hooks.sleep(config.actionSleepMs ?? 0);
}
