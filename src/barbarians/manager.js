import { reconcileEntities } from '../renderer.js';

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
 * Uses only entity.canStandOn() to evaluate traversability.
 *
 * @param {Object} fromCell - Source cell or coordinate {q, r}
 * @param {Object} helper - AiHelper instance
 * @param {BaseEntity} [entity] - Entity used for canStandOn checks
 * @returns {Object|null}
 */
export function findOppositeBorderCell(fromCell, helper, entity = null) {
  if (!helper || !fromCell) return null;

  const targetQ = -fromCell.q;
  const targetR = -fromCell.r;
  const targetCoord = { q: targetQ, r: targetR };

  const borderCells = getBorderCells(helper);
  const passableBorders = borderCells.filter(c => {
    return entity && typeof entity.canStandOn === 'function' ? entity.canStandOn(c) : false;
  });

  if (passableBorders.length > 0) {
    passableBorders.sort((a, b) => helper.distance(a, targetCoord) - helper.distance(b, targetCoord));
    return passableBorders[0];
  }

  // Fallback to any passable cell in the grid closest to opposite coordinate
  const allPassable = helper.getCellsArray().filter(c => {
    return entity && typeof entity.canStandOn === 'function' ? entity.canStandOn(c) : false;
  });

  if (allPassable.length > 0) {
    allPassable.sort((a, b) => helper.distance(a, targetCoord) - helper.distance(b, targetCoord));
    return allPassable[0];
  }

  return null;
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
            if (!dummy || typeof dummy.canStandOn !== 'function') return false;
            return dummy.canStandOn(cell) && !gameState.getEntityAt(cell.q, cell.r);
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
        console.debug(`[Barbarians] ${entity.name} at (${entity.q}, ${entity.r}) attacking ${targetEnemy.name} (Owner: ${targetEnemy.owner?.name || 'neutral'}) at (${targetEnemy.q}, ${targetEnemy.r})`);
        const res = helper.attack(gameState, entity, targetEnemy, Infinity);
        if (res && res.ordersUsed > 0) {
          attacked = true;
          await helper.onActionDone(gameState, [entity.cell, targetEnemy.cell], `${entity.name} attacked ${targetEnemy.name}`);
          break;
        }
      }
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
  }

  // ensure entities are in the right place after all moves (e.g. in case SHOW_ALL is true)
  reconcileEntities(gameState);
}
