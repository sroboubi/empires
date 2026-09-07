import { HexGrid } from '../../hexGrid.js';
import { attack } from '../utils.js';
import { onActionDone } from '../utils.js';
import { reconcileEntities } from '../../renderer.js';

/**
 * Returns all border cells on the hex grid (cells with fewer than 6 neighbors).
 * @param {HexGrid} hexGrid
 * @returns {Array<Object>}
 */
export function getBorderCells(hexGrid) {
  if (!hexGrid) return [];
  return hexGrid.getCellsArray().filter(cell => {
    const neighbors = hexGrid.getNeighbors(cell.q, cell.r);
    return neighbors.length < 6;
  });
}

/**
 * Finds a target border cell on the opposite side of the map by mirroring coordinates through center (0, 0).
 * Uses only entity.canStandOn() to evaluate traversability.
 *
 * @param {Object} fromCell - Source cell or coordinate {q, r}
 * @param {HexGrid} hexGrid
 * @param {BaseEntity} [entity] - Entity used for canStandOn checks
 * @returns {Object|null}
 */
export function findOppositeBorderCell(fromCell, hexGrid, entity = null) {
  if (!hexGrid || !fromCell) return null;

  const targetQ = -fromCell.q;
  const targetR = -fromCell.r;
  const targetCoord = { q: targetQ, r: targetR };

  const borderCells = getBorderCells(hexGrid);
  const passableBorders = borderCells.filter(c => {
    return entity && typeof entity.canStandOn === 'function' ? entity.canStandOn(c) : false;
  });

  if (passableBorders.length > 0) {
    passableBorders.sort((a, b) => HexGrid.distance(a, targetCoord) - HexGrid.distance(b, targetCoord));
    return passableBorders[0];
  }

  // Fallback to any passable cell in the grid closest to opposite coordinate
  const allPassable = hexGrid.getCellsArray().filter(c => {
    return entity && typeof entity.canStandOn === 'function' ? entity.canStandOn(c) : false;
  });

  if (allPassable.length > 0) {
    allPassable.sort((a, b) => HexGrid.distance(a, targetCoord) - HexGrid.distance(b, targetCoord));
    return allPassable[0];
  }

  return null;
}

/**
 * Manages barbarian lifecycle, spawning, combat, and movement dynamically
 * based on the provided settings configuration.
 *
 * @param {GameState} gameState
 * @param {Object} [config] - Barbarian configuration settings containing horde definitions
 */
export async function manageBarbarians(gameState, config) {
  if (!gameState || !gameState.hexGrid || !config) return;

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
        const count = Math.floor(Math.random() * (max - min + 1)) + min;
        for (let i = 0; i < count; i++) {
          toSpawn.push(unitName);
        }
      }

      if (toSpawn.length > 0) {
        console.log(`[Barbarians] Round ${gameState.currentRound}: Spawning horde (${toSpawn.join(', ')})`);

        // Shuffle spawn queue
        toSpawn.sort(() => Math.random() - 0.5);

        // Get unoccupied border cells and shuffle them
        const borderCells = getBorderCells(gameState.hexGrid);
        const candidateBorderCells = borderCells.filter(c => !gameState.getEntityAt(c.q, c.r));
        candidateBorderCells.sort(() => Math.random() - 0.5);

        for (const unitName of toSpawn) {
          if (availableSlots <= 0) {
            console.log(`[Barbarians] Max barbarian population cap (${maxNumber}) reached.`);
            break;
          }

          const meta = gameState.manifestData?.entities?.[unitName];
          let dummy = null;
          if (meta?.controllerClass) {
            try {
              dummy = new meta.controllerClass(meta, null, gameState, null);
            } catch (e) {
              console.warn(`[Barbarians] Could not create dummy entity for ${unitName}:`, e);
            }
          }

          const spawnCellIndex = candidateBorderCells.findIndex(cell => {
            if (!dummy || typeof dummy.canStandOn !== 'function') return false;
            return dummy.canStandOn(cell) && !gameState.getEntityAt(cell.q, cell.r);
          });

          if (spawnCellIndex !== -1) {
            const spawnCell = candidateBorderCells.splice(spawnCellIndex, 1)[0];
            const entity = gameState.spawnEntity(unitName, spawnCell, null);
            if (entity) {
              availableSlots--;
              const target = findOppositeBorderCell(spawnCell, gameState.hexGrid, entity);
              if (target) {
                entity.targetCell = target;
                entity.state.targetCell = { q: target.q, r: target.r };
              }
              console.log(`[Barbarians] Spawned ${entity.name} at (${spawnCell.q}, ${spawnCell.r}), marching to (${target?.q}, ${target?.r})`);
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
      console.log(`[Barbarians] ${entity.name} at (${entity.q}, ${entity.r}) died of old age (age ${entity.age} > ${maxAge})`);
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
        const distDiff = HexGrid.distance(entity, a) - HexGrid.distance(entity, b);
        if (distDiff !== 0) return distDiff;
        return a.health - b.health;
      });
      const targetEnemy = visibleEnemies[0];
      console.log(`[Barbarians] ${entity.name} at (${entity.q}, ${entity.r}) attacking ${targetEnemy.name} (Owner: ${targetEnemy.owner?.name || 'neutral'}) at (${targetEnemy.q}, ${targetEnemy.r})`);
      attack(gameState, entity, targetEnemy, Infinity);
      await onActionDone(gameState, [entity.cell, targetEnemy.cell]);
    } else {
      // Restore target cell reference if needed
      if (!entity.targetCell && entity.state.targetCell) {
        entity.targetCell = gameState.hexGrid.getCell(entity.state.targetCell.q, entity.state.targetCell.r);
      }

      // If target reached (closer than 5 cells) or none assigned, pick new target on opposite side
      if (!entity.targetCell || HexGrid.distance(entity, entity.targetCell) < 5) {
        entity.targetCell = findOppositeBorderCell(entity.cell || entity, gameState.hexGrid, entity);
        if (entity.targetCell) {
          entity.state.targetCell = { q: entity.targetCell.q, r: entity.targetCell.r };
          console.log(`[Barbarians] ${entity.name} at (${entity.q}, ${entity.r}) assigned new target cell at (${entity.targetCell.q}, ${entity.targetCell.r})`);
        }
      }

      if (entity.targetCell) {
        const moveAction = entity.getActions().find(a => a.name === "Move");
        if (moveAction) {
          // Move towards target cell while action points remain
          while (entity.actionPoints > 0 && !entity.destroyed) {
            const currentDist = HexGrid.distance(entity, entity.targetCell);
            if (currentDist < 5) {
              entity.targetCell = findOppositeBorderCell(entity.cell || entity, gameState.hexGrid, entity);
              if (entity.targetCell) {
                entity.state.targetCell = { q: entity.targetCell.q, r: entity.targetCell.r };
                console.log(`[Barbarians] ${entity.name} reached proximity of target. New target assigned at (${entity.targetCell.q}, ${entity.targetCell.r})`);
              }
            }

            const neighbors = gameState.hexGrid.getNeighbors(entity.q, entity.r);
            const validCandidates = neighbors.filter(nb => {
              if (gameState.getEntityAt(nb.q, nb.r)) return false;
              const check = moveAction.canDo(nb, null);
              return check && check.possible;
            });

            if (validCandidates.length === 0) break;

            // Sort candidate neighbors by proximity to targetCell
            validCandidates.sort((a, b) => HexGrid.distance(a, entity.targetCell) - HexGrid.distance(b, entity.targetCell));
            const bestNeighbor = validCandidates[0];

            const moved = moveAction.do(bestNeighbor, null);
            if (!moved) break;
            await onActionDone(gameState, [entity.cell]);

            console.log(`[Barbarians] ${entity.name} moved to (${bestNeighbor.q}, ${bestNeighbor.r}) (Target: (${entity.targetCell.q}, ${entity.targetCell.r}), Remaining AP: ${entity.actionPoints})`);
          }
        }
      }
    }
  }

  // ensure entities are in the right place after all moves (e.g. in case SHOW_ALL is true)
  reconcileEntities(gameState);
}