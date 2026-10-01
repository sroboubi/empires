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
 * Placement: spawnCellResources(hexGrid, manifestData, hexSize) — single pass
 * over the cells in random order; each cell rolls base probability, or the
 * adjacent probability when a neighbor already holds the same resource.
 * Quantity per cell is skewed toward the minimum (rollQuantity). One
 * resource OR treasure per cell — no stacking.
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

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Rolls an item quantity skewed toward the minimum: 50% chance to stop at the
 * current count, otherwise increment and roll again (capped at max). So for
 * min=1,max=4: P(1)=50%, P(2)=25%, P(3)=12.5%, P(4)=12.5%.
 */
export function rollQuantity(min, max) {
  min = Math.max(1, Math.floor(min ?? 1));
  max = Math.max(min, Math.floor(max ?? 1));
  let q = min;
  while (q < max && Math.random() < 0.5) q++;
  return q;
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
 * Scatters `quantity` item placements clustered near the center of the hex
 * cell. Each item gets a random model, offset, Y rotation and slight scale
 * jitter — the item count makes the resource amount visually readable.
 */
export function scatterItems(group, quantity, hexSize = 1) {
  const items = [];
  const urls = group.modelUrls || [];
  if (!urls.length || quantity <= 0) return items;
  const inner = hexSize * 0.05;
  const outer = hexSize * 0.4;
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

/**
 * Places natural resources and treasures on grid cells in-place.
 * Single pass over the cells in random order — each cell is considered once.
 * For each cell whose terrain matches a definition, the roll uses the
 * adjacent probability when a neighbor already holds the same resource,
 * otherwise the base probability. One resource OR treasure per cell.
 */
export function spawnCellResources(hexGrid, manifestData, hexSize = 1) {
  const defs = getSpawnDefs(manifestData);
  if (!defs.length || !hexGrid) return;
  for (const cell of shuffled(hexGrid.getCellsArray())) {
    if (cell.resource) continue; // one resource/treasure per cell — no stacking
    const terrainName = cell.terrain ? cell.terrain.name : null;
    for (const { kind, def } of defs) {
      const group = findTerrainGroup(def, terrainName);
      if (!group) continue;
      const prob = group.probability || {};
      const p = hasAdjacentSameResource(hexGrid, cell, def.name)
        ? (prob.adjacent || 0)
        : (prob.base || 0);
      if (p > 0 && Math.random() < p) {
        const q = group.quantity || {};
        const quantity = rollQuantity(q.min ?? 1, q.max ?? 1);
        cell.resource = {
          kind,
          name: def.name,
          quantity,
          items: scatterItems(group, quantity, hexSize),
        };
        break;
      }
    }
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
