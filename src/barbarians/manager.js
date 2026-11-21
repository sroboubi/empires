import { reconcileEntities } from '../renderer.js';

/**
 * Barbarian attack sequence (game code, intentionally separate from the AI
 * action composite). Uses raw entities/actions; internal steps are paced
 * with onActionDone between them, and the caller paces the final step by
 * awaiting helper.onActionDone() after the call. Free to diverge from the AI
 * combat logic as barbarian behaviour evolves.
 */
async function barbarianAttack(gameState, helper, sourceEntity, targetEntity, maxOrders = 1) {
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
    const initialDist = helper.distance(sourceEntity.cell || sourceEntity, targetEntity.cell || targetEntity);

    const attackMultiplier = (cell) => helper.calculateAttackMultiplier(
        gameState, cell, sourceEntity.damage.elevationAdjustment, targetEntity, sourceEntity);

    helper.aiLog(attackerPlayer, 'combat', `Engaging Target: ${sourceEntity.name}#${sourceEntity.id?.slice(-4)} (${attackerPlayer.name}) at (${sourceEntity.q},${sourceEntity.r}) [HP:${Math.round(sourceEntity.health)}/${sourceEntity.maxHealth}, AP:${sourceEntity.actionPoints}] attacking ${targetPlayer.name}'s ${targetEntity.name}#${targetEntity.id?.slice(-4)} at (${targetEntity.q},${targetEntity.r}) [HP:${Math.round(targetEntity.health)}/${targetEntity.maxHealth}, Dist:${initialDist} hexes, MaxOrders:${availableOrders}].`);

    let lastCheckReason = 'Target unreachable or insufficient AP';

    // Wait for the previous internal step's animation before the next
    // attack/reposition. The final step is paced by the caller's
    // onActionDone after barbarianAttack() returns.
    let pacingCells = null;
    const paceNextAction = async () => {
        if (!pacingCells) return;
        const cells = pacingCells;
        pacingCells = null;
        await helper.onActionDone(gameState, cells, 'Combat');
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
                return Math.ceil(attackCostScale * exh * helper.distance(cell, targetCell));
            }
            const pathRes = helper.movementCostTo(cell, targetCell, costFunc, { allowDetours: true });
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
                helper.aiLog(attackerPlayer, 'combat', `Attack Result [Hit]: ${sourceEntity.name}#${sourceEntity.id?.slice(-4)} attacked ${targetPlayer.name}'s ${targetEntity.name}#${targetEntity.id?.slice(-4)} for ${damageDealt.toFixed(1)} dmg (multiplier: ${currentMult.toFixed(2)}x). ${statusMsg}. Attacker AP left: ${sourceEntity.actionPoints}. Order used: ${ordersUsed}/${availableOrders}.`);
                continue;
            } else {
                helper.aiLog(attackerPlayer, 'warn', `Attack Action Failed: ${sourceEntity.name} attempted attack on ${targetEntity.name} at (${targetCell.q},${targetCell.r}) but action.do() returned false.`);
                break;
            }
        }

        let moved = false;
        if (moveAction && sourceEntity.actionPoints > 0) {
            const pathResult = helper.movementCostTo(sourceEntity.cell, targetCell, costFunc, { allowDetours: true });
            // Detour mode never returns null (except invalid input) and
            // already returns a best-effort path toward the target when
            // it is unreachable, so no BFS fallback is needed here.
            let pathCells = pathResult ? pathResult.path : [];
            const candidateCells = new Set();
            for (const nb of helper.getNeighbors(sourceEntity.q, sourceEntity.r)) candidateCells.add(nb);
            for (const cell of pathCells) {
                for (const nb of helper.getNeighbors(cell.q, cell.r)) candidateCells.add(nb);
            }
            const candidates = Array.from(candidateCells);
            let bestMoveCell = null;
            let bestMoveMult = -1;

            for (const candCell of candidates) {
                const occupant = gameState.getEntityAt(candCell.q, candCell.r);
                if (occupant) continue;
                const checkMove = moveAction.canDo(candCell, null);
                if (!checkMove || !checkMove.possible) continue;

                const dist = helper.distance(candCell, targetCell);
                let inRange = false;
                if (sourceEntity.range && typeof sourceEntity.range === 'object') {
                    const minD = sourceEntity.range.minCells || 1;
                    const maxD = sourceEntity.range.maxCells || 1;
                    if (dist >= minD && dist <= maxD) {
                        const sight = helper.getSightAndTrajectory(candCell, targetCell);
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
                    helper.aiLog(attackerPlayer, 'combat', `Repositioning: ${sourceEntity.name} moved from ${fromCoord} to (${bestMoveCell.q},${bestMoveCell.r}) for better attack multiplier (${bestMoveMult.toFixed(2)}x vs ${currentMult.toFixed(2)}x). AP left: ${sourceEntity.actionPoints}. Order used: ${ordersUsed}/${availableOrders}.`);
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
                    const dist = helper.distance(candCell, targetCell);
                    if (dist < closestDist) {
                        closestDist = dist;
                        closestCell = candCell;
                    }
                }
                // G4: only move if the candidate is actually closer than
                // where we stand — otherwise the unit sidesteps (or steps
                // away) and bounces back next iteration.
                const currentDist = helper.distance(sourceEntity, targetCell);
                if (closestCell && closestDist < currentDist) {
                    const fromCoord = `(${sourceEntity.q},${sourceEntity.r})`;
                    const moveFrom = { q: sourceEntity.q, r: sourceEntity.r };
                    await paceNextAction();
                    if (moveAction.do(closestCell, null)) {
                        ordersUsed++;
                        pacingCells = [moveFrom, { q: sourceEntity.q, r: sourceEntity.r }];
                        movedCloser = true;
                        helper.aiLog(attackerPlayer, 'combat', `Repositioning: ${sourceEntity.name} moved from ${fromCoord} to (${closestCell.q},${closestCell.r}) to close distance on ${targetEntity.name} (dist: ${closestDist}). AP left: ${sourceEntity.actionPoints}. Order used: ${ordersUsed}/${availableOrders}.`);
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
                helper.aiLog(attackerPlayer, 'combat', `Attack Result [Hit]: ${sourceEntity.name}#${sourceEntity.id?.slice(-4)} attacked ${targetPlayer.name}'s ${targetEntity.name}#${targetEntity.id?.slice(-4)} from current position for ${damageDealt.toFixed(1)} dmg (multiplier: ${currentMult.toFixed(2)}x). ${statusMsg}. Attacker AP left: ${sourceEntity.actionPoints}. Order used: ${ordersUsed}/${availableOrders}.`);
                continue;
            } else {
                helper.aiLog(attackerPlayer, 'warn', `Attack Action Failed: ${sourceEntity.name} attempted attack on ${targetEntity.name} from current position but action.do() returned false.`);
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
        helper.aiLog(attackerPlayer, 'combat', `Attack Sequence Complete: ${sourceEntity.name} used ${ordersUsed} order(s) against ${targetPlayer.name}'s ${targetEntity.name}. Result: ${finalStatus}. Attacker AP left: ${sourceEntity.actionPoints}.`);
    } else {
        helper.aiLog(attackerPlayer, 'detail', `Attack Sequence Incomplete (0 orders used): ${sourceEntity.name} could not attack ${targetEntity.name} (${lastCheckReason}).`);
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
 * Returns all border cells on the hex grid (cells with fewer than 6 neighbors).
 * @param {Object} helper - AiHelper instance
 * @returns {Array<Object>}
 */
export function getBorderCells(helper) {
  if (!helper) return [];
  return helper.getCellsArray().filter(cell => {
    const neighbors = helper.getNeighbors(cell.q, cell.r);
    return neighbors.length < 6;
  });
}

/**
 * Finds a target border cell on the opposite side of the map by mirroring coordinates through center (0, 0).
 * Uses only entity.getMovementCost() to evaluate traversability.
 *
 * @param {Object} fromCell - Source cell or coordinate {q, r}
 * @param {Object} helper - AiHelper instance
 * @param {BaseEntity} [entity] - Entity used for movement-cost checks
 * @returns {Object|null}
 */
export function findOppositeBorderCell(fromCell, helper, entity = null) {
  if (!helper || !fromCell) return null;

  const targetQ = -fromCell.q;
  const targetR = -fromCell.r;
  const targetCoord = { q: targetQ, r: targetR };

  const borderCells = getBorderCells(helper);
  const passableBorders = borderCells.filter(c => {
    return entity && typeof entity.getMovementCost === 'function' ? Number.isFinite(entity.getMovementCost(c)) : false;
  });

  if (passableBorders.length > 0) {
    passableBorders.sort((a, b) => helper.distance(a, targetCoord) - helper.distance(b, targetCoord));
    return passableBorders[0];
  }

  // Fallback to any passable cell in the grid closest to opposite coordinate
  const allPassable = helper.getCellsArray().filter(c => {
    return entity && typeof entity.getMovementCost === 'function' ? Number.isFinite(entity.getMovementCost(c)) : false;
  });

  if (allPassable.length > 0) {
    allPassable.sort((a, b) => helper.distance(a, targetCoord) - helper.distance(b, targetCoord));
    return allPassable[0];
  }

  return null;
}

/**
 * Target probability for a barbarian encountering an owner entity (Phase 25).
 * P = settings.barbarians.aggression * owner.barbarianAggressionMultiplier
 *     * (ownerTotalScore / maxTotalScore)^3, clamped to [0, 1].
 * Guard: when maxTotalScore is 0 (all players tied at zero), the ratio is
 * treated as 1 — every owner is a co-leader — so P = aggression * multiplier.
 * @param {Object} [config] - Barbarian settings (settings.barbarians)
 * @param {Object} gameState
 * @param {Player|null} [owner] - Owning player of the encountered entity
 * @returns {number} probability in [0, 1]
 */
export function barbarianTargetProbability(config, gameState, owner) {
  const aggression = config?.aggression ?? 1;
  const ownerMult = owner?.attributes?.barbarianAggressionMultiplier ?? 1;
  const players = gameState?.players || [];
  const maxTotalScore = players.reduce((m, p) => Math.max(m, p.score?.total ?? 0), 0);
  const ownerTotalScore = owner?.score?.total ?? 0;
  const ratio = maxTotalScore > 0 ? ownerTotalScore / maxTotalScore : 1;
  return Math.min(1, Math.max(0, aggression * ownerMult * Math.pow(ratio, 3)));
}

/**
 * Barbarian encounter mechanic (Phase 25): if a barbarian lost health since
 * the end of its last turn (state.previousHealth, recorded by
 * manageBarbarians), it was damaged — forget its target/ignore decisions so
 * it re-evaluates every encounter. Called at the start of the barbarian's
 * turn, before step() (whose regen would otherwise mask the damage).
 * @param {Object} entity - Barbarian entity
 */
export function clearDecisionsIfDamaged(entity) {
  if (entity.state.previousHealth !== undefined && entity.health < entity.state.previousHealth) {
    entity.state.barbarianDecisions = {};
  }
}

/**
 * Manages barbarian lifecycle, spawning, combat, and movement dynamically
 * based on the provided settings configuration.
 *
 * @param {Object} [config] - Barbarian configuration settings containing horde definitions
 * @param {Object} helper - AiHelper instance
 */
export async function manageBarbarians(config, helper) {
  if (!config || !helper) return;

  const gameState = helper.getGameState();
  const hordeConfig = config.horde;
  const barbarianUnitNames = new Set(Object.keys(hordeConfig));

  // Determine if an entity is a barbarian based on absence of owner and inclusion in horde config
  const isBarbarian = (entity) => {
    return entity && !entity.owner && barbarianUnitNames.has(entity.name);
  };

  const spawnFrequencyTurns = config.spawnFrequencyTurns || 1;
  const maxNumber = config.maxNumber !== undefined ? config.maxNumber : Infinity;
  const maxAge = config.maxAge !== undefined ? config.maxAge : Infinity;

  // =========================================================================
  // 1. Spawning Phase
  // =========================================================================
  if (gameState.currentRound % spawnFrequencyTurns === 0) {
    const currentBarbarians = gameState.entities.filter(isBarbarian);
    let availableSlots = maxNumber - currentBarbarians.length;

    if (availableSlots > 0) {
      // Determine number of units to spawn for each horde entry dynamically
      const toSpawn = [];
      for (const [unitName, range] of Object.entries(hordeConfig)) {
        const min = range.min !== undefined ? range.min : 1;
        const max = range.max !== undefined ? range.max : min;
        const count = Math.floor(gameState.random() * (max - min + 1)) + min;
        for (let i = 0; i < count; i++) {
          toSpawn.push(unitName);
        }
      }

      if (toSpawn.length > 0) {
        console.debug(`[Barbarians] Round ${gameState.currentRound}: Spawning horde (${toSpawn.join(', ')})`);

        // Shuffle spawn queue
        toSpawn.sort(() => gameState.random() - 0.5);

        // Get unoccupied border cells and shuffle them
        const borderCells = getBorderCells(helper);
        const candidateBorderCells = borderCells.filter(c => !gameState.getEntityAt(c.q, c.r));
        candidateBorderCells.sort(() => gameState.random() - 0.5);

        for (const unitName of toSpawn) {
          if (availableSlots <= 0) {
            console.debug(`[Barbarians] Max barbarian population cap (${maxNumber}) reached.`);
            break;
          }

          const meta = gameState.manifestData?.entities?.[unitName];
          // Probe only — must not consume an unowned-counter value.
          const dummy = helper.createEntity(meta, null, gameState, null, { id: '__probe__' });

          const spawnCellIndex = candidateBorderCells.findIndex(cell => {
            if (!dummy || typeof dummy.canSpawnOn !== 'function') return false;
            return dummy.canSpawnOn(cell) && !gameState.getEntityAt(cell.q, cell.r);
          });

          if (spawnCellIndex !== -1) {
            const spawnCell = candidateBorderCells.splice(spawnCellIndex, 1)[0];
            const entity = gameState.spawnEntity(unitName, spawnCell, null);
            if (entity) {
              availableSlots--;
              const target = findOppositeBorderCell(spawnCell, helper, entity);
              if (target) {
                entity.targetCell = target;
                entity.state.targetCell = { q: target.q, r: target.r };
              }
              console.debug(`[Barbarians] Spawned ${entity.name} at (${spawnCell.q}, ${spawnCell.r}), marching to (${target?.q}, ${target?.r})`);
            }
          } else {
            console.warn(`[Barbarians] Could not find suitable border hex to spawn ${unitName}`);
          }
        }
      }
    }
  }

  // =========================================================================
  // 2. Barbarian Management Phase (Age, AP Step, Combat, Movement)
  // =========================================================================
  const activeBarbarians = gameState.entities.filter(isBarbarian);

  for (const entity of activeBarbarians) {
    if (entity.destroyed) continue;

    // Barbarian encounter mechanic (Phase 25): if this barbarian lost health
    // since the end of its last turn, it was damaged — forget its
    // target/ignore decisions. Checked before step(), whose regen would
    // otherwise mask the damage.
    clearDecisionsIfDamaged(entity);

    // Reset AP and advance entity age
    entity.step(gameState);

    // Age removal check
    if (entity.age > maxAge) {
      console.debug(`[Barbarians] ${entity.name} at (${entity.q}, ${entity.r}) died of old age (age ${entity.age} > ${maxAge})`);
      entity.destroy();
      continue;
    }

    // Refresh visibility
    entity.updateVisibility();

    // Check for non-barbarian enemies in visual range
    const visibleEnemies = gameState.entities.filter(other => {
      if (other.destroyed || other.health <= 0 || isBarbarian(other)) return false;
      return entity.visibleCells.has(`${other.q},${other.r}`);
    });

    if (visibleEnemies.length > 0) {
      // Attack closest visible enemy, or weakest at same distance, using attack() with unlimited orders (constrained only by AP)
      visibleEnemies.sort((a, b) => {
        const distDiff = helper.distance(entity, a) - helper.distance(entity, b);
        if (distDiff !== 0) return distDiff;
        return a.health - b.health;
      });
      // G10: try each visible enemy in order — if the nearest is across
      // water, attack() spends nothing and the barbarian would otherwise
      // stand off forever. Fall through to marching if none is reachable.
      let attacked = false;
      for (const targetEnemy of visibleEnemies) {
        // Barbarian encounter mechanic (Phase 25): on first encounter with
        // an owner entity, roll whether to target or ignore it; the decision
        // is remembered on the barbarian (state.barbarianDecisions, keyed by
        // entity ID) so an ignored entity is never targeted again. Taking
        // damage clears the memory (clearDecisionsIfDamaged, at the start of
        // the barbarian's next turn).
        if (!entity.state.barbarianDecisions) entity.state.barbarianDecisions = {};
        const decision = entity.state.barbarianDecisions[targetEnemy.id];
        if (decision === 'ignore') {
          console.debug(`[Barbarians] ${entity.name} ignoring ${targetEnemy.name} (${targetEnemy.id}) — decided earlier.`);
          continue;
        }
        if (decision !== 'target') {
          const p = barbarianTargetProbability(config, gameState, targetEnemy.owner);
          const roll = gameState.random();
          const verdict = roll < p ? 'target' : 'ignore';
          entity.state.barbarianDecisions[targetEnemy.id] = verdict;
          console.debug(`[Barbarians] ${entity.name} encounters ${targetEnemy.name} (Owner: ${targetEnemy.owner?.name || 'neutral'}) at (${targetEnemy.q}, ${targetEnemy.r}): P(target)=${p.toFixed(3)}, roll=${roll.toFixed(3)} -> ${verdict}.`);
          if (verdict === 'ignore') continue;
        }
        console.debug(`[Barbarians] ${entity.name} at (${entity.q}, ${entity.r}) attacking ${targetEnemy.name} (Owner: ${targetEnemy.owner?.name || 'neutral'}) at (${targetEnemy.q}, ${targetEnemy.r})`);
        const res = await barbarianAttack(gameState, helper, entity, targetEnemy, Infinity);
        if (res && res.ordersUsed > 0) {
          attacked = true;
          await helper.onActionDone(gameState, [entity.cell, targetEnemy.cell], `${entity.name} attacked ${targetEnemy.name}`);
          break;
        }
      }
      // End of this barbarian's turn: record its health so the next turn can
      // tell whether it was damaged in the meantime.
      entity.state.previousHealth = entity.health;
      if (attacked) continue;
    }

    // No reachable enemy: march (falls through from the combat branch too).
    {
      // Restore target cell reference if needed
      if (!entity.targetCell && entity.state.targetCell) {
        entity.targetCell = helper.getCell(entity.state.targetCell.q, entity.state.targetCell.r);
      }

      // If target reached (closer than 5 cells) or none assigned, pick new target on opposite side
      if (!entity.targetCell || helper.distance(entity, entity.targetCell) < 5) {
        entity.targetCell = findOppositeBorderCell(entity.cell || entity, helper, entity);
        if (entity.targetCell) {
          entity.state.targetCell = { q: entity.targetCell.q, r: entity.targetCell.r };
          console.debug(`[Barbarians] ${entity.name} at (${entity.q}, ${entity.r}) assigned new target cell at (${entity.targetCell.q}, ${entity.targetCell.r})`);
        }
      }

      if (entity.targetCell) {
        const moveAction = entity.getActions().find(a => a.name === "Move");
        if (moveAction) {
          // G1: A* path via movementCostTo (detour mode) — the old BFS had
          // a 5000-node cap, so on 64+ maps the search usually returned
          // null and the barbarian never moved at all. Detour mode never
          // returns null: on an unreachable target it returns a
          // best-effort path to the closest reachable cell. The path
          // includes the source cell, so slice it off before walking.
          // If the path ends short of the target, retarget to the last
          // cell — the within-5 rule above then picks a new
          // opposite-border target once the barbarian arrives there.
          const res = helper.movementCostTo(entity.cell, entity.targetCell, entity.getMovementCost.bind(entity), { allowDetours: true });
          let path = res ? res.path.slice(1) : [];
          if (path.length > 0) {
            const last = path[path.length - 1];
            if (last.q !== entity.targetCell.q || last.r !== entity.targetCell.r) {
              entity.targetCell = last;
              entity.state.targetCell = { q: last.q, r: last.r };
            }
          } else if (entity.q !== entity.targetCell.q || entity.r !== entity.targetCell.r) {
            // Already standing on the closest reachable cell (e.g. a
            // 1-cell island spawn): point the target at the current cell
            // so the within-5 rule re-picks a new target next round.
            entity.targetCell = entity.cell;
            entity.state.targetCell = { q: entity.q, r: entity.r };
          }
          for (const nextCell of path) {
            if (entity.actionPoints <= 0 || entity.destroyed) break;
            const occupant = gameState.getEntityAt(nextCell.q, nextCell.r);
            if (occupant) {
              // Already standing on this path cell (stale path after a
              // detour): skip it.
              if (occupant === entity) continue;
              // Enemy on the path: stop here — combat picks it up next
              // round (an adjacent enemy is attacked, so this is only a
              // one-round stall, not a stuck barbarian).
              if (!isBarbarian(occupant)) break;
              // Fellow barbarian on the path: step around it — the best
              // unoccupied neighbour that reduces distance to the target
              // (the pre-G1 greedy step, as a fallback). No such neighbour:
              // stop here.
              const curDist = helper.distance(entity, entity.targetCell);
              const detour = helper.getNeighbors(entity.q, entity.r)
                .filter(nb => !gameState.getEntityAt(nb.q, nb.r) && helper.distance(nb, entity.targetCell) < curDist)
                .sort((a, b) => helper.distance(a, entity.targetCell) - helper.distance(b, entity.targetCell))
                .find(nb => { const c = moveAction.canDo(nb, null); return c && c.possible; });
              if (!detour) break;
              const detoured = moveAction.do(detour, null);
              if (!detoured) break;
              await helper.onActionDone(gameState, [entity.cell], `${entity.name} moved to (${detour.q}, ${detour.r})`);
              console.debug(`[Barbarians] ${entity.name} stepped around ${occupant.name} to (${detour.q}, ${detour.r}) (Target: (${entity.targetCell.q}, ${entity.targetCell.r}), Remaining AP: ${entity.actionPoints})`);
              continue;
            }
            const check = moveAction.canDo(nextCell, null);
            if (!check || !check.possible) break;
            const moved = moveAction.do(nextCell, null);
            if (!moved) break;
            await helper.onActionDone(gameState, [entity.cell], `${entity.name} moved to (${nextCell.q}, ${nextCell.r})`);
            console.debug(`[Barbarians] ${entity.name} moved to (${nextCell.q}, ${nextCell.r}) (Target: (${entity.targetCell.q}, ${entity.targetCell.r}), Remaining AP: ${entity.actionPoints})`);
          }
        }
      }
    }

    // End of this barbarian's turn: record its health so the next turn can
    // tell whether it was damaged in the meantime.
    entity.state.previousHealth = entity.health;
  }

  // ensure entities are in the right place after all moves (e.g. in case SHOW_ALL is true)
  reconcileEntities(gameState);
}
