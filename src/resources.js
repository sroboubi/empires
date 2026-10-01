/**
 * Natural resources & treasures.
 *
 * Manifest sections consumed here:
 *   naturalResources: [{
 *     name, iconUrl,
 *     terrains: [{ types, modelUrls, quantity: {min,max}, probability: {base,adjacent}, size? }],
 *     improvement: { <improvementName>: { type, yieldMultiplier } }
 *   }]
 *   treasures: [{
 *     name,
 *     terrains: [{ types, modelUrls, quantity: {min,max}, probability: {base,adjacent}, size? }],
 *     rewards: [{ type, quantity }]
 *   }]
 *
 * Placement: spawnCellResources(hexGrid, manifestData, hexSize) — two passes
 * (base probability, then adjacent clustering). One resource OR treasure per
 * cell — no stacking.
 *
 * Gameplay hooks:
 *   applyResourceYieldBonus(entity, baseYields, gameState) — improvement step():
 *       yield = base * yieldMultiplier * sqrt(totalQty on adjacent cells)
 *   checkTreasurePickup(unit) — call after a unit moves onto a cell. Picks a
 *       random reward `quantity` times. A unit without an owner (barbarian)
 *       consumes the treasure without granting rewards.
 *
 * This module has no imports so it can be unit-tested in plain Node.
 */

// --- random helpers ---------------------------------------------------------

function randInt(min, max) {
  min = Math.max(0, Math.floor(min));
  max = Math.max(min, Math.floor(max));
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// --- manifest access --------------------------------------------------------

/**
 * Returns [{ kind: 'natural'|'treasure', def }] for every spawn definition.
 */
export function getSpawnDefs(manifestData) {
  const defs = [];
  for (const def of manifestData?.naturalResources || []) defs.push({ kind: 'natural', def });
  for (const def of manifestData?.treasures || []) defs.push({ kind: 'treasure', def });
  return defs;
}

/**
 * Finds the terrain group of a spawn definition that applies to a terrain name.
 */
export function findTerrainGroup(def, terrainName) {
  if (!def || !terrainName) return null;
  return (def.terrains || []).find(g => (g.types || []).includes(terrainName)) || null;
}

/**
 * Finds a spawn definition by kind and name.
 */
export function findSpawnDef(manifestData, kind, name) {
  const section = kind === 'treasure' ? manifestData?.treasures : manifestData?.naturalResources;
  return (section || []).find(d => d.name === name) || null;
}

// --- placement --------------------------------------------------------------

/**
 * Scatters `quantity` item placements in a ring inside the hex cell so the
 * center stays clear for units standing on the cell. Each item gets a random
 * model, offset, Y rotation and slight scale jitter — the item count makes the
 * resource amount visually readable.
 */
export function scatterItems(group, quantity, hexSize = 1) {
  const items = [];
  const urls = group.modelUrls || [];
  if (!urls.length || quantity <= 0) return items;
  const inner = hexSize * 0.38;
  const outer = hexSize * 0.78;
  for (let i = 0; i < quantity; i++) {
    const angle = randRange(0, Math.PI * 2);
    const dist = randRange(inner, outer);
    items.push({
      modelUrl: pickRandom(urls),
      dx: Math.cos(angle) * dist,
      dz: Math.sin(angle) * dist,
      rotY: randRange(0, Math.PI * 2),
      scale: randRange(0.9, 1.1),
    });
  }
  return items;
}

function hasAdjacentSameResource(hexGrid, cell, resourceName) {
  for (const n of hexGrid.getNeighbors(cell.q, cell.r)) {
    if (n.resource && n.resource.name === resourceName) return true;
  }
  return false;
}

function trySpawnOnCell(hexGrid, cell, defs, hexSize, useAdjacent) {
  if (cell.resource) return; // one resource/treasure per cell — no stacking
  const terrainName = cell.terrain ? cell.terrain.name : null;
  for (const { kind, def } of defs) {
    const group = findTerrainGroup(def, terrainName);
    if (!group) continue;
    const prob = group.probability || {};
    let p = 0;
    if (useAdjacent) {
      if (!hasAdjacentSameResource(hexGrid, cell, def.name)) continue;
      p = prob.adjacent || 0;
    } else {
      // A group with adjacent probability 0 never sits next to the same
      // resource: skip the base roll when a neighbor already holds it. This
      // keeps non-clustering resources (e.g. deer, ruins) from landing on
      // adjacent cells via independent base rolls.
      if ((prob.adjacent || 0) === 0 && hasAdjacentSameResource(hexGrid, cell, def.name)) continue;
      p = prob.base || 0;
    }
    if (p > 0 && Math.random() < p) {
      const q = group.quantity || {};
      const quantity = randInt(q.min ?? 1, q.max ?? 1);
      cell.resource = {
        kind,
        name: def.name,
        quantity,
        items: scatterItems(group, quantity, hexSize),
      };
      return;
    }
  }
}

/**
 * Places natural resources and treasures on grid cells in-place.
 * Pass 1 rolls the base probability; pass 2 rolls the adjacent probability for
 * still-empty cells touching the same resource type (clustering).
 */
export function spawnCellResources(hexGrid, manifestData, hexSize = 1) {
  const defs = getSpawnDefs(manifestData);
  if (!defs.length || !hexGrid) return;
  const cells = hexGrid.getCellsArray();
  for (const cell of cells) trySpawnOnCell(hexGrid, cell, defs, hexSize, false);
  for (const cell of cells) {
    if (!cell.resource) trySpawnOnCell(hexGrid, cell, defs, hexSize, true);
  }
}

// --- gameplay ---------------------------------------------------------------

/**
 * Applies the natural-resource yield bonus for an improvement.
 * For each adjacent cell holding a matching resource type:
 *   yield = base * yieldMultiplier * sqrt(total quantity on adjacent cells)
 */
export function applyResourceYieldBonus(entity, baseYields, gameState) {
  if (!baseYields || !gameState) return baseYields;
  const defs = gameState.manifestData?.naturalResources || [];
  const grid = gameState.hexGrid;
  if (!defs.length || !grid) return baseYields;
  const result = { ...baseYields };
  for (const def of defs) {
    const mapping = def.improvement || {};
    for (const [improvementName, bonus] of Object.entries(mapping)) {
      if (improvementName !== entity.name) continue;
      const { type, yieldMultiplier } = bonus;
      if (typeof result[type] !== 'number') continue;
      let totalQty = 0;
      for (const n of grid.getNeighbors(entity.q, entity.r)) {
        if (n.resource && n.resource.kind === 'natural' && n.resource.name === def.name) {
          totalQty += n.resource.quantity;
        }
      }
      if (totalQty > 0 && yieldMultiplier > 0) {
        result[type] = result[type] * yieldMultiplier * Math.sqrt(totalQty);
      }
    }
  }
  return result;
}

function formatRewards(granted) {
  return Object.entries(granted).map(([t, q]) => `${q} ${t}`).join(', ');
}

/**
 * Checks the unit's current cell for a treasure and collects it.
 * Returns null when no treasure was present, otherwise
 * { treasureName, granted, rewarded, q, r }. A unit without an owner
 * (e.g. barbarian) consumes the treasure without granting rewards.
 */
export function checkTreasurePickup(unit) {
  const gameState = unit.gameState;
  if (!gameState) return null;
  const cell = unit.cell || gameState.hexGrid?.getCell(unit.q, unit.r);
  if (!cell || !cell.resource || cell.resource.kind !== 'treasure') return null;

  const treasureName = cell.resource.name;
  const def = findSpawnDef(gameState.manifestData, 'treasure', treasureName);
  const picks = cell.resource.quantity;
  const rewards = def?.rewards || [];
  const granted = {};

  if (unit.owner && rewards.length > 0) {
    for (let i = 0; i < picks; i++) {
      const reward = pickRandom(rewards);
      granted[reward.type] = (granted[reward.type] || 0) + reward.quantity;
    }
    unit.owner.addResources(granted);
    unit.owner.addHistoryEntry(gameState.currentRound, {
      category: 'treasure',
      details: `${unit.name} discovered ${def?.name || 'a treasure'} at (${cell.q}, ${cell.r}) and gained ${formatRewards(granted)}`,
      extra: {
        entityName: unit.name,
        entityId: unit.id,
        cell: { q: cell.q, r: cell.r },
        rewards: granted,
      },
    });
  }

  // The treasure is consumed either way.
  delete cell.resource;
  return { treasureName, granted, rewarded: Object.keys(granted).length > 0, q: cell.q, r: cell.r };
}

// --- asset preloading -------------------------------------------------------

/**
 * Collects { name, modelUrl } entries for every resource/treasure model so
 * main.js can feed them to the renderer's preloadModels().
 */
export function collectResourceModelEntries(manifestData) {
  const entries = {};
  for (const { def } of getSpawnDefs(manifestData)) {
    for (const group of def.terrains || []) {
      for (const url of group.modelUrls || []) {
        entries[`${def.name}::${url}`] = { name: def.name, modelUrl: url };
      }
    }
  }
  return entries;
}
