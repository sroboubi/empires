/**
 * AI-owned composite actions.
 *
 * These are normal AI functions: they receive the manager's proxied player,
 * gameState, helper and entities, execute the same action.do() calls an AI
 * could write by hand, and await onActionDone() between internal steps.
 *
 * Always await the composite. The final action is left pending; the caller
 * must then await helper.onActionDone(), exactly as after a direct action.do().
 */
export class ActionApi {
    constructor(player, gameState, helper) {
        this.player = player;
        this.gameState = gameState;
        this.helper = helper;
    }

    async attack(sourceEntity, targetEntity, maxOrders = 1) {
        const fail = (message) => ({ ordersUsed: 0, result: { status: 'failed', message } });
        if (!this.gameState || !sourceEntity || !targetEntity || maxOrders <= 0) return fail('Invalid attack parameters.');
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
        const initialDist = this.helper.distance(sourceEntity.cell || sourceEntity, targetEntity.cell || targetEntity);

        const attackMultiplier = (cell) => this.helper.calculateAttackMultiplier(
            this.gameState, cell, sourceEntity.damage.elevationAdjustment, targetEntity, sourceEntity);

        this.helper.aiLog(attackerPlayer, 'combat', `Engaging Target: ${sourceEntity.name}#${sourceEntity.id?.slice(-4)} (${attackerPlayer.name}) at (${sourceEntity.q},${sourceEntity.r}) [HP:${Math.round(sourceEntity.health)}/${sourceEntity.maxHealth}, AP:${sourceEntity.actionPoints}] attacking ${targetPlayer.name}'s ${targetEntity.name}#${targetEntity.id?.slice(-4)} at (${targetEntity.q},${targetEntity.r}) [HP:${Math.round(targetEntity.health)}/${targetEntity.maxHealth}, Dist:${initialDist} hexes, MaxOrders:${availableOrders}].`);

        let lastCheckReason = 'Target unreachable or insufficient AP';

        // Wait for the previous internal step's animation before the next
        // attack/reposition. The final step is paced by the caller's
        // onActionDone after attack() returns.
        let pacingCells = null;
        const paceNextAction = async () => {
            if (!pacingCells) return;
            const cells = pacingCells;
            pacingCells = null;
            await this.helper.onActionDone(this.gameState, cells, 'Combat');
        };

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
            const costFunc = sourceEntity.getMovementCost.bind(sourceEntity);
            // Dry-run attack cost from a candidate cell (same formula as
            // entity.js Attack canDo, without moving there first).
            // Leader twist (Phase 25): the attacker's adjusted attack-cost
            // scale, from the owning player's getAttackCost, matching canDo.
            const attackCostScale = sourceEntity.owner
                ? sourceEntity.owner.getAttackCost(sourceEntity.name)
                : (sourceEntity.attackCostScale ?? 1);
            const attackCostFrom = (cell) => {
                const exh = sourceEntity.state?.battleExhaustion ?? 1;
                if (sourceEntity.range && typeof sourceEntity.range === 'object') {
                    return Math.ceil(attackCostScale * exh * this.helper.distance(cell, targetCell));
                }
                const pathRes = this.helper.movementCostTo(cell, targetCell, costFunc, { allowDetours: true });
                // A best-effort path's cost is the cost to the closest
                // reachable cell, NOT to the target — an unreachable target
                // must look unaffordable, not cheap.
                if (!pathRes || !pathRes.reached) return Infinity;
                return Math.ceil(attackCostScale * exh * pathRes.cost);
            };

            if (isCurrentPossible && currentMult > 1.0) {
                const prevHealth = targetEntity.health;
                const attackFrom = { q: sourceEntity.q, r: sourceEntity.r };
                await paceNextAction();
                const didAttack = attackAction.do(targetCell, targetEntity);
                if (didAttack) {
                    ordersUsed++;
                    pacingCells = [attackFrom, { q: sourceEntity.q, r: sourceEntity.r }, targetCell];
                    const damageDealt = Math.max(0, prevHealth - targetEntity.health);
                    totalDamage += damageDealt;
                    attacksLanded++;
                    const isDestroyed = targetEntity.destroyed || targetEntity.health <= 0;
                    const statusMsg = isDestroyed
                        ? `TARGET DESTROYED!`
                        : `Target HP remaining: ${Math.round(targetEntity.health)}/${targetEntity.maxHealth}`;
                    this.helper.aiLog(attackerPlayer, 'combat', `Attack Result [Hit]: ${sourceEntity.name}#${sourceEntity.id?.slice(-4)} attacked ${targetPlayer.name}'s ${targetEntity.name}#${targetEntity.id?.slice(-4)} for ${damageDealt.toFixed(1)} dmg (multiplier: ${currentMult.toFixed(2)}x). ${statusMsg}. Attacker AP left: ${sourceEntity.actionPoints}. Order used: ${ordersUsed}/${availableOrders}.`);
                    continue;
                } else {
                    this.helper.aiLog(attackerPlayer, 'warn', `Attack Action Failed: ${sourceEntity.name} attempted attack on ${targetEntity.name} at (${targetCell.q},${targetCell.r}) but action.do() returned false.`);
                    break;
                }
            }

            let moved = false;
            if (moveAction && sourceEntity.actionPoints > 0) {
                const pathResult = this.helper.movementCostTo(sourceEntity.cell, targetCell, costFunc, { allowDetours: true });
                // Detour mode never returns null (except invalid input) and
                // already returns a best-effort path toward the target when
                // it is unreachable, so no BFS fallback is needed here.
                let pathCells = pathResult ? pathResult.path : [];
                const candidateCells = new Set();
                for (const nb of this.helper.getNeighbors(sourceEntity.q, sourceEntity.r)) candidateCells.add(nb);
                for (const cell of pathCells) {
                    for (const nb of this.helper.getNeighbors(cell.q, cell.r)) candidateCells.add(nb);
                }
                const candidates = Array.from(candidateCells);
                let bestMoveCell = null;
                let bestMoveMult = -1;

                for (const candCell of candidates) {
                    const occupant = this.gameState.getEntityAt(candCell.q, candCell.r);
                    if (occupant) continue;
                    const checkMove = moveAction.canDo(candCell, null);
                    if (!checkMove || !checkMove.possible) continue;

                    const dist = this.helper.distance(candCell, targetCell);
                    let inRange = false;
                    if (sourceEntity.range && typeof sourceEntity.range === 'object') {
                        const minD = sourceEntity.range.minCells || 1;
                        const maxD = sourceEntity.range.maxCells || 1;
                        if (dist >= minD && dist <= maxD) {
                            const sight = this.helper.getSightAndTrajectory(candCell, targetCell);
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
                    const moveFrom = { q: sourceEntity.q, r: sourceEntity.r };
                    await paceNextAction();
                    if (moveAction.do(bestMoveCell, null)) {
                        ordersUsed++;
                        pacingCells = [moveFrom, { q: sourceEntity.q, r: sourceEntity.r }];
                        movedCloser = true;
                        this.helper.aiLog(attackerPlayer, 'combat', `Repositioning: ${sourceEntity.name} moved from ${fromCoord} to (${bestMoveCell.q},${bestMoveCell.r}) for better attack multiplier (${bestMoveMult.toFixed(2)}x vs ${currentMult.toFixed(2)}x). AP left: ${sourceEntity.actionPoints}. Order used: ${ordersUsed}/${availableOrders}.`);
                        moved = true;
                    }
                }

                if (!moved && !isCurrentPossible) {
                    let closestCell = null;
                    let closestDist = Infinity;
                    for (const candCell of candidates) {
                        const occupant = this.gameState.getEntityAt(candCell.q, candCell.r);
                        if (occupant) continue;
                        const checkMove = moveAction.canDo(candCell, null);
                        if (!checkMove || !checkMove.possible) continue;
                        const dist = this.helper.distance(candCell, targetCell);
                        if (dist < closestDist) {
                            closestDist = dist;
                            closestCell = candCell;
                        }
                    }
                    // G4: only move if the candidate is actually closer than
                    // where we stand — otherwise the unit sidesteps (or steps
                    // away) and bounces back next iteration.
                    const currentDist = this.helper.distance(sourceEntity, targetCell);
                    if (closestCell && closestDist < currentDist) {
                        const fromCoord = `(${sourceEntity.q},${sourceEntity.r})`;
                        const moveFrom = { q: sourceEntity.q, r: sourceEntity.r };
                        await paceNextAction();
                        if (moveAction.do(closestCell, null)) {
                            ordersUsed++;
                            pacingCells = [moveFrom, { q: sourceEntity.q, r: sourceEntity.r }];
                            movedCloser = true;
                            this.helper.aiLog(attackerPlayer, 'combat', `Repositioning: ${sourceEntity.name} moved from ${fromCoord} to (${closestCell.q},${closestCell.r}) to close distance on ${targetEntity.name} (dist: ${closestDist}). AP left: ${sourceEntity.actionPoints}. Order used: ${ordersUsed}/${availableOrders}.`);
                            moved = true;
                        }
                    }
                }
            }
            if (moved) continue;

            if (isCurrentPossible) {
                const prevHealth = targetEntity.health;
                const attackFrom = { q: sourceEntity.q, r: sourceEntity.r };
                await paceNextAction();
                const didAttack = attackAction.do(targetCell, targetEntity);
                if (didAttack) {
                    ordersUsed++;
                    pacingCells = [attackFrom, { q: sourceEntity.q, r: sourceEntity.r }, targetCell];
                    const damageDealt = Math.max(0, prevHealth - targetEntity.health);
                    totalDamage += damageDealt;
                    attacksLanded++;
                    const isDestroyed = targetEntity.destroyed || targetEntity.health <= 0;
                    const statusMsg = isDestroyed
                        ? `TARGET DESTROYED!`
                        : `Target HP remaining: ${Math.round(targetEntity.health)}/${targetEntity.maxHealth}`;
                    this.helper.aiLog(attackerPlayer, 'combat', `Attack Result [Hit]: ${sourceEntity.name}#${sourceEntity.id?.slice(-4)} attacked ${targetPlayer.name}'s ${targetEntity.name}#${targetEntity.id?.slice(-4)} from current position for ${damageDealt.toFixed(1)} dmg (multiplier: ${currentMult.toFixed(2)}x). ${statusMsg}. Attacker AP left: ${sourceEntity.actionPoints}. Order used: ${ordersUsed}/${availableOrders}.`);
                    continue;
                } else {
                    this.helper.aiLog(attackerPlayer, 'warn', `Attack Action Failed: ${sourceEntity.name} attempted attack on ${targetEntity.name} from current position but action.do() returned false.`);
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
            this.helper.aiLog(attackerPlayer, 'combat', `Attack Sequence Complete: ${sourceEntity.name} used ${ordersUsed} order(s) against ${targetPlayer.name}'s ${targetEntity.name}. Result: ${finalStatus}. Attacker AP left: ${sourceEntity.actionPoints}.`);
        } else {
            this.helper.aiLog(attackerPlayer, 'detail', `Attack Sequence Incomplete (0 orders used): ${sourceEntity.name} could not attack ${targetEntity.name} (${lastCheckReason}).`);
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

    /**
     * Async: when the builder has to walk to the site, onActionDone drains
     * that move before the build action lands. Move-only steps are paced by
     * the caller.
     */
    async build(sourceEntity, targetName,
        maxDistance = this.helper.getConfig().buildMaxDistance ?? 10,
        distancePenalty = this.helper.getConfig().buildDistancePenalty ?? 0.2) {
        const fail = (message) => ({ ordersUsed: 0, result: { status: 'failed', message } });
        if (!this.gameState || !sourceEntity || !targetName || !sourceEntity.active) return fail('Invalid builder or target.');
        if (!this.gameState.hexGrid) return fail('No hex grid.');

        const owner = sourceEntity.owner;
        const availableOrders = owner ? owner.orders : 1;
        if (availableOrders <= 0) return fail('No orders available.');

        const actions = sourceEntity.getActions ? sourceEntity.getActions() : [];
        const expectedActionName = `Build ${this.helper.camelToTitle(targetName)}`;
        const buildAction = actions.find(a => a.name.toLowerCase() === expectedActionName.toLowerCase() || a.name.toLowerCase() === `build ${targetName.toLowerCase()}`);
        if (!buildAction) return fail(`${sourceEntity.name} cannot build ${targetName}.`);

        const { candidates, canonicalName } = this.helper.findBuildCandidates(this.gameState, sourceEntity, targetName, maxDistance);
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

        this.helper.aiLog(owner || 'AI', 'build', `Build ${canonicalName}: ${candidates.length} candidate site(s), chose (${best.cell.q},${best.cell.r}) dist ${best.dist} expected yield ${best.yield.toFixed(1)} (penalty ${distancePenalty}).`);

        let ordersUsed = 0;
        const startCell = { q: sourceEntity.q, r: sourceEntity.r };

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
            const moved = this.moveAlongPath(sourceEntity, moveAction, best.stage.path, 'build',
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
        if (this.helper.distance(sourceEntity, best.cell) !== 1) {
            return { ordersUsed, result: { status: 'partial', message: `${sourceEntity.name} moved toward build site for ${canonicalName} but is not yet in position.` } };
        }

        const checkBuild = buildAction.canDo(best.cell, null);
        if (checkBuild && checkBuild.possible) {
            if (ordersUsed > 0) {
                // The move is a separate visible action; let its animation
                // finish before the structure appears.
                await this.helper.onActionDone(this.gameState, [startCell, sourceEntity.cell], `in position to build ${canonicalName}`);
            }
            if (buildAction.do(best.cell, null)) {
                this.helper.aiLog(owner || 'AI', 'build', `Built ${canonicalName} at (${best.cell.q},${best.cell.r}).`);
                return { ordersUsed: ordersUsed + 1, result: { status: 'completed', message: `Built ${canonicalName} at (${best.cell.q},${best.cell.r}).` } };
            }
            return { ordersUsed, result: { status: 'failed', message: `Build action failed for ${canonicalName}.` } };
        } else {
            const reason = checkBuild ? checkBuild.reason : 'unknown';
            this.helper.aiLog(owner || 'AI', 'warn', `Build ${canonicalName} at (${best.cell.q},${best.cell.r}) failed check: ${reason}`);
            return { ordersUsed, result: { status: 'failed', message: `Cannot build ${canonicalName}: ${reason}.` } };
        }
    }

    /**
     * Async: when the supporter has to walk adjacent first, onActionDone
     * drains that move before the support action lands.
     */
    async support(sourceEntity, targetEntity, actionName = null, maxOrders = 1) {
        const fail = (message) => ({ ordersUsed: 0, result: { status: 'failed', message } });
        if (!this.gameState || !sourceEntity || !targetEntity || !sourceEntity.active) return fail('Invalid entities or source not active.');
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
                this.helper.aiLog(owner || 'AI', 'warn', `${sourceEntity.name} has no "${actionName}" action to support ${targetEntity.name} with.`);
                return fail(`${sourceEntity.name} cannot perform "${actionName}".`);
            }
        }

        const moveAction = actions.find(a => a.name === "Move");
        const targetCell = targetEntity.cell;
        const startCell = { q: sourceEntity.q, r: sourceEntity.r };

        const tryAct = () => {
            if (!supportAction) return { ordersUsed: 0, result: { status: 'completed', message: `${sourceEntity.name} moved adjacent to ${targetEntity.name}.` } };
            const check = supportAction.canDo(targetCell, targetEntity);
            if (check && check.possible && supportAction.do(targetCell, targetEntity)) {
                this.helper.aiLog(owner || 'AI', 'detail', `${sourceEntity.name} used ${supportAction.name} on ${targetEntity.name}.`);
                return { ordersUsed: 1, result: { status: 'completed', message: `${sourceEntity.name} used ${supportAction.name} on ${targetEntity.name}.` } };
            }
            const reason = check && !check.possible ? ` (${check.reason})` : '';
            return fail(`Could not use ${supportAction?.name || actionName} on ${targetEntity.name}${reason}.`);
        };

        if (this.helper.distance(sourceEntity, targetEntity) === 1) {
            return tryAct();
        }

        if (moveAction && sourceEntity.actionPoints > 0) {
            const targetNeighbors = this.helper.getNeighbors(targetEntity.q, targetEntity.r);
            targetNeighbors.sort((a, b) => this.helper.distance(sourceEntity, a) - this.helper.distance(sourceEntity, b));

            for (const adjCell of targetNeighbors) {
                if (this.gameState.getEntityAt(adjCell.q, adjCell.r)) continue;
                const checkMove = moveAction.canDo(adjCell, null);
                if (checkMove && checkMove.possible) {
                    if (moveAction.do(adjCell, null)) {
                        if (supportAction && availableOrders > 1) {
                            // Arrival is a separate visible move; let it finish
                            // before the support action lands.
                            await this.helper.onActionDone(this.gameState, [startCell, sourceEntity.cell, targetCell], `in position to support ${targetEntity.name}`);
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

    moveAlongPath(unit, moveAction, path, category = 'explore', reason = '') {
        if (!path || path.length === 0 || !moveAction) return 0;
        const startCoord = `${unit.q},${unit.r}`;

        const lastCell = path[path.length - 1];
        if (!this.gameState.getEntityAt(lastCell.q, lastCell.r)) {
            const fullCheck = moveAction.canDo(lastCell, null);
            if (fullCheck && fullCheck.possible && moveAction.do(lastCell, null)) {
                this.helper.aiLog(this.player, category, `Move ${unit.name} from (${startCoord}) to (${lastCell.q},${lastCell.r}). ${reason}`);
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
            if (this.gameState.getEntityAt(stepCell.q, stepCell.r)) continue;
            const check = moveAction.canDo(stepCell, null);
            if (check && check.possible) {
                const moved = moveAction.do(stepCell, null);
                if (moved) {
                    const note = (i < path.length - 1)
                        ? `advanced ${i + 1}/${path.length} hexes towards target`
                        : `arrived at target`;
                    this.helper.aiLog(this.player, category, `Move ${unit.name}: ${note} from (${startCoord}) to (${stepCell.q},${stepCell.r}). ${reason}`);
                    return 1;
                }
            }
        }
        return 0;
    }

    explore(unit, direction = null, getTreasure = false, targetedCells = null) {
        const fail = (message) => ({ ordersUsed: 0, result: { status: 'failed', message } });
        const DIRECTIONS_8 = this.helper.getDirections8();
        if (!this.gameState || !unit || !unit.active) return fail('Unit is not active or game state missing.');
        if (!this.gameState.hexGrid) return fail('No hex grid.');
        const player = unit.owner;
        const moveAction = unit.getActions ? unit.getActions().find(a => a.name === "Move") : null;
        if (!moveAction) return fail(`${unit.name} cannot move.`);
        if (unit.actionPoints !== undefined && unit.actionPoints <= 0) return fail(`${unit.name} has no action points.`);

        const claim = (targetCell) => {
            if (targetedCells instanceof Set) targetedCells.add(`${targetCell.q},${targetCell.r}`);
            else if (Array.isArray(targetedCells)) targetedCells.push(targetCell);
        };

        const doExplore = (targetCells, reason) => {
            const res = this.helper.findPathTowardsUnexplored(unit, this.gameState, player, targetedCells, targetCells);
            if (res.fullyExplored) {
                this.helper.aiLog(player || 'AI', 'explore', `All map territory is fully explored.`);
                return fail('Map is fully explored.');
            }
            if (!res.targetCell || !res.path || res.path.length === 0) return fail('No reachable unexplored cell.');
            const used = this.moveAlongPath(unit, moveAction, res.path, 'explore', reason);
            if (used > 0) {
                claim(res.targetCell);
                this.helper.aiLog(player || 'AI', 'explore', `${unit.name} exploring ${reason} -> (${res.targetCell.q},${res.targetCell.r}).`);
                return { ordersUsed: 1, result: { status: 'completed', message: `${unit.name} explored ${reason} towards (${res.targetCell.q},${res.targetCell.r}).` } };
            }
            const apR = Math.round((unit.actionPoints ?? 0) * 10) / 10;
            return fail(`Could not move along exploration path. ${unit.name} has ${apR} AP remaining.`);
        };

        if (getTreasure && player) {
            const treasures = [];
            for (const cell of this.helper.getCellsArray()) {
                if (!cell || cell.resource?.kind !== 'treasure') continue;
                if (!player.isExplored(cell.q, cell.r)) continue;
                treasures.push(cell);
            }
            if (treasures.length > 0) {
                const treasureResult = doExplore(treasures, 'towards treasure');
                if (treasureResult.ordersUsed > 0) return treasureResult;
            }
            return this.explore(unit, null, false, targetedCells);
        }

        if (direction) {
            if (!DIRECTIONS_8.includes(direction)) {
                this.helper.aiLog(player || 'AI', 'warn', `explore: unknown direction "${direction}" (expected one of ${DIRECTIONS_8.join(', ')}).`);
                return fail(`Unknown direction "${direction}".`);
            }
            const fromCell = unit.cell || this.gameState.hexGrid.getCell(unit.q, unit.r);
            const targets = [];
            for (const cell of this.helper.getCellsArray()) {
                if (!cell) continue;
                if (player && player.isExplored(cell.q, cell.r)) continue;
                if (this.helper.directionTo(fromCell, cell).fromSource === direction) targets.push(cell);
            }
            if (targets.length === 0) {
                this.helper.aiLog(player || 'AI', 'explore', `No unexplored cells to the ${direction}.`);
                // G7: return a result object like every other path, not 0 —
                // callers read res.result.status.
                return fail(`No unexplored cells to the ${direction}.`);
            }
            return doExplore(targets, `to the ${direction}`);
        }

        return doExplore(null, 'towards unexplored territory');
    }
}
