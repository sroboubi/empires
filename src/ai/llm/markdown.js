/**
 * Markdown serializers for LLM prompts.
 *
 * Design principles (from prompt-engineering review):
 * - Data-driven: derive everything from the manifest / game state. No hardcoded
 *   unit names, no "village ONLY" special cases.
 * - Condensed: group related info, omit anything not applicable.
 * - The engine pre-computes; the LLM just decides. Derived insights (runout
 *   warnings, relative positions, per-unit capabilities) are inlined so the
 *   model never does relational lookups or game math.
 *
 * Dependency-free: no imports from the game engine (hexGrid.js pulls in URL
 * imports). Hex distance is inlined below.
 */

const IMPASSABLE = 1e1000;
const WATER_TERRAINS = ['ShallowWater', 'DeepWater', 'Ocean'];

/**
 * Converts the entity manifest to high-density Markdown for the system prompt.
 * @param {Array<Object>} entities - Raw entity definitions (definitions/entities.json).
 * @returns {string} Markdown catalog.
 */
export function manifestToMarkdown(entities) {
  // Units move, structures don't. Data-driven split on movement presence.
  const units = entities.filter(e => e.movement);
  const structures = entities.filter(e => !e.movement);

  const lines = [];
  if (units.length) {
    lines.push('## UNITS');
    for (const e of units) lines.push(entityToMarkdown(e));
  }
  if (structures.length) {
    lines.push('## STRUCTURES');
    for (const e of structures) lines.push(entityToMarkdown(e));
  }
  return lines.join('\n');
}

function entityToMarkdown(e) {
  const lines = [`### ${e.name.toUpperCase()}`];
  if (e.description) lines.push(`* **Role**: ${e.description}`);

  // Commands derived from capabilities, not hardcoded per unit.
  const commands = [];
  if ((e.buildables || []).length) commands.push('Build');
  if ((e.repairables || []).length) commands.push('Repair');
  if (e.movement) commands.push('Explore');
  if (e.damage) {
    const range = e.range ? `, range ${e.range.minCells}-${e.range.maxCells}` : '';
    commands.push(`Attack (${e.damage.value} ${e.damage.type}${range})`);
  }
  if (commands.length) lines.push(`* **Commands**: ${commands.join(', ')}`);

  const combat = describeCombat(e);
  if (combat) lines.push(`* **Combat**: ${combat}`);

  if ((e.buildables || []).length) lines.push(`* **Builds**: ${(e.buildables || []).join(', ')}`);
  if ((e.repairables || []).length) lines.push(`* **Repairs**: ${(e.repairables || []).join(', ')}`);

  const cost = condenseResources(e.spawnCost);
  if (cost) lines.push(`* **Cost**: ${cost}`);
  const upkeep = condenseResources(e.maintenance);
  if (upkeep) lines.push(`* **Upkeep**: ${upkeep}`);
  const yields = condenseYields(e.yields);
  if (yields) lines.push(`* **Yields**: ${yields}`);
  const score = condenseScore(e.score);
  if (score) lines.push(`* **Score**: ${score}`);

  const terrain = describeTerrainAccess(e.movement);
  if (terrain) lines.push(`* **Terrain**: ${terrain}.`);

  return lines.join('\n');
}

/** "50 food, 10 gold, 2 gems" — omit empty. */
function condenseResources(obj) {
  if (!obj) return '';
  const parts = Object.entries(obj)
    .filter(([, v]) => v)
    .map(([k, v]) => `${v} ${k}`);
  return parts.join(', ');
}

/** "+20 food, +12 gold" — omit empty. */
function condenseYields(obj) {
  if (!obj) return '';
  const parts = Object.entries(obj)
    .filter(([, v]) => v)
    .map(([k, v]) => `+${v} ${k}`);
  return parts.join(', ');
}

/** "+1 military, +2 economic" — omit zero/empty. */
function condenseScore(obj) {
  if (!obj) return '';
  const parts = Object.entries(obj)
    .filter(([, v]) => v)
    .map(([k, v]) => `+${v} ${k}`);
  return parts.join(', ');
}

/**
 * Maps an armor value to a plain-language descriptor.
 * Derived from effectiveDamage = rawValue / armor.
 * >=2 very resistant, >1 resistant, <0.5 very weak, <1 weak, else normal (omitted).
 */
function armorDescriptor(val) {
  if (val >= 2) return 'very resistant';
  if (val > 1) return 'resistant';
  if (val < 0.5) return 'very weak';
  if (val < 1) return 'weak';
  return null;
}

/**
 * Compressed combat summary: "60 slashing damage, 300 HP; resistant to slashing, weak to piercing".
 * Armor descriptors derived from the damage formula: effectiveDamage = rawValue / armor.
 */
function describeCombat(e) {
  const parts = [];
  if (e.damage) {
    const range = e.range ? `, range ${e.range.minCells}-${e.range.maxCells}` : '';
    parts.push(`${round1(e.damage.value)} ${e.damage.type} damage${range}`);
  }
  if (e.health || e.maxHealth) {
    parts.push(`${round1(e.health || e.maxHealth)} HP`);
  }
  const armor = e.armor || {};
  const notes = [];
  for (const [type, val] of Object.entries(armor)) {
    const desc = armorDescriptor(val);
    if (desc) notes.push(`${desc} to ${type}`);
  }
  if (notes.length) parts.push(notes.join(', '));
  return parts.join('; ');
}

/**
 * Maps a movement cost multiplier to a plain-language descriptor.
 * <0.7 very fast, <0.9 fast, <1.1 normal (omitted), <1.3 slow, else very slow.
 */
function movementDescriptor(mult) {
  if (mult < 0.7) return 'very fast';
  if (mult < 0.9) return 'fast';
  if (mult < 1.1) return null; // normal — omit
  if (mult < 1.3) return 'slow';
  return 'very slow';
}

/**
 * Derives a terrain-access summary from movement.terrainCostScale.
 * "Land only" iff all known water terrains are impassable — data-driven,
 * not a hardcoded unit list. Speeds use plain descriptors, not raw numbers.
 */
function describeTerrainAccess(movement) {
  if (!movement) return '';
  const scale = movement.terrainCostScale || {};
  const parts = [];
  const waterBlocked = WATER_TERRAINS.every(t => (scale[t] ?? 1) >= IMPASSABLE);
  if (waterBlocked) parts.push('Land only (cannot enter water)');

  // Non-water restrictions still apply even when water is blocked (no early return).
  const blocked = Object.keys(scale).filter(t => (scale[t] ?? 1) >= IMPASSABLE && !WATER_TERRAINS.includes(t));
  const speedNotes = [];
  for (const [terrain, mult] of Object.entries(scale)) {
    if (mult >= IMPASSABLE || WATER_TERRAINS.includes(terrain)) continue;
    const desc = movementDescriptor(mult);
    if (desc) speedNotes.push(`${desc} on ${terrain}`);
  }
  if (blocked.length) parts.push(`cannot enter ${blocked.join(', ')}`);
  if (speedNotes.length) parts.push(speedNotes.join(', '));
  return parts.join('; ');
}

/**
 * Converts a per-turn game state summary to Markdown for the user prompt.
 * @param {Object} summary - Output of Harness.summarizeGameState().
 * @param {Array<Object>} manifestEntities - Raw entity definitions, for per-unit capabilities.
 * @returns {string} Markdown snapshot.
 */
export function serializeStateToMarkdown(summary, manifestEntities = []) {
  const byName = new Map((manifestEntities || []).map(e => [e.name, e]));
  const lines = [];

  const totalOrders = summary.orders ?? 0;
  const maxOrders = summary.maxOrders;
  const ordersStr = maxOrders !== undefined && maxOrders !== null
    ? `${totalOrders} out of ${maxOrders} orders remaining`
    : `${totalOrders} order${totalOrders === 1 ? '' : 's'} remaining`;
  lines.push(`## Turn ${summary.turn} — ${ordersStr}`);
  lines.push('');

  // Resources: grouped, condensed. Runout warnings only when actually depleting.
  const res = summary.resources || {};
  const stock = res.stock || {};
  const net = res.netIncome || {};
  const turnsLeft = res.turnsRemaining || {};
  const resLines = [];
  for (const [name, amount] of Object.entries(stock)) {
    const delta = net[name] ?? 0;
    const deltaStr = delta > 0 ? ` (+${delta}/turn)` : delta < 0 ? ` (${delta}/turn)` : '';
    let warn = '';
    if (delta < 0 && turnsLeft[name] !== undefined && turnsLeft[name] !== Infinity) {
      warn = turnsLeft[name] <= 3 ? ` — CRITICAL: runs out in ${turnsLeft[name]} turns!` : ` — runs out in ${turnsLeft[name]} turns`;
    }
    resLines.push(`* **${capitalize(name)}**: ${amount}${deltaStr}${warn}`);
  }
  if (resLines.length) {
    lines.push('### Resources');
    lines.push(...resLines);
    lines.push('');
  }

  // Score with breakdown (military, economic, exploration)
  if (summary.score !== undefined && summary.score !== null) {
    const s = summary.score;
    let scoreStr = '';
    if (typeof s === 'object') {
      const parts = [];
      if (s.total !== undefined) parts.push(`Total: ${s.total}`);
      const breakdown = [];
      if (s.military) breakdown.push(`Military: ${s.military}`);
      if (s.economic) breakdown.push(`Economic: ${s.economic}`);
      if (s.exploration) breakdown.push(`Exploration: ${s.exploration}`);
      if (breakdown.length) parts.push(`(${breakdown.join(', ')})`);
      scoreStr = parts.join(' ');
    } else {
      scoreStr = String(s);
    }
    if (scoreStr) lines.push(`**Score**: ${scoreStr}\n`);
  }

  // Entities: active first, with relative position + inline capabilities.
  const entities = summary.entities || [];
  const active = entities.filter(e => (e.actionPoints ?? 0) > 0);
  const exhausted = entities.filter(e => (e.actionPoints ?? 0) <= 0);

  if (active.length) {
    lines.push(`### Active Entities (${active.length})`);
    for (const e of active) lines.push(entityStateToMarkdown(e, byName));
    lines.push('');
  }
  if (exhausted.length) {
    lines.push(`### Exhausted / Inactive (${exhausted.length})`);
    for (const e of exhausted) lines.push(entityStateToMarkdown(e, byName, true));
    lines.push('');
  }

  // Opponents with visible entity details
  const opponents = summary.opponents || {};
  const oppNames = Object.keys(opponents);
  if (oppNames.length) {
    lines.push(`### Opponents (${oppNames.length})`);
    for (const name of oppNames) {
      const opp = opponents[name];
      const oppEntities = opp.entities || [];
      // Display the owner's name, not the map key: production keys are
      // owner ids (or "null" for ownerless barbarians), which rendered as
      // "**null**" or a bare id in every opponent section of the 50-turn
      // game. Prefer opp.name; fall back to a name-like key (test data is
      // keyed by name without a .name field); ownerless maps to Barbarians.
      let displayName = (opp.name && opp.name !== 'None') ? opp.name : name;
      if (displayName === 'null') displayName = 'Barbarians';
      const scoreStr = opp.score !== undefined ? `, score ${typeof opp.score === 'object' ? opp.score.total ?? '' : opp.score}` : '';
      lines.push(`* **${displayName}** (${oppEntities.length} visible entit${oppEntities.length === 1 ? 'y' : 'ies'}${scoreStr})`);
      for (const e of oppEntities) {
        lines.push(oppEntityToMarkdown(e, byName));
      }
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

function entityStateToMarkdown(e, byName, brief = false) {
  const def = byName.get(e.name);
  const hp = (e.health !== undefined && e.maxHealth !== undefined) ? ` ${round1(e.health)}/${round1(e.maxHealth)} HP` : '';
  const ap = e.actionPoints !== undefined ? `, ${round1(e.actionPoints)} action points` : '';
  const pos = describePosition(e);
  const terrain = e.terrain ? `on ${e.terrain}` : '';

  if (brief) {
    const bits = [];
    if (pos) bits.push(`at ${pos}`);
    if (terrain) bits.push(terrain);
    if (hp) bits.push(hp.trim());
    if (ap) bits.push(ap.trim().replace(/^, /, ''));
    return `* **${e.id}** (${capitalize(e.name)})${bits.length ? ' — ' + bits.join(', ') : ''}`;
  }

  const parts = [`* **${e.id}** (${capitalize(e.name)})`];
  const details = [];
  if (pos) details.push(pos);
  if (terrain) details.push(terrain);
  if (hp) details.push(hp.trim());
  if (ap) details.push(ap.trim().replace(/^, /, ''));
  if (details.length) parts.push(`  * ${details.join(' | ')}`);

  // Inline capabilities — state-dependent when available (from summarizeEntity),
  // falling back to static manifest lists. This is what stops the settler/farm
  // hallucination: the model sees exactly what this unit can do right now.
  const caps = [];
  if (e.buildableNow !== undefined || e.buildableLater !== undefined) {
    // State-dependent: split by affordability and AP
    if ((e.buildableNow || []).length) caps.push(`Can build now: ${e.buildableNow.join(', ')}`);
    for (const b of e.buildableLater || []) {
      // Distinguish AP issues and site issues from resource issues
      if (b.missing && b.missing.includes('insufficient AP')) {
        caps.push(`Cannot build ${b.name} (${b.missing})`);
      } else if (b.missing && b.missing.includes('no valid site')) {
        caps.push(`Cannot build ${b.name} (no valid site nearby)`);
      } else {
        caps.push(`Cannot afford ${b.name} (need ${b.missing})`);
      }
    }
  } else if (def && (def.buildables || []).length) {
    caps.push(`Builds: ${(def.buildables || []).join(', ')}`);
  }
  if (e.damagedRepairables !== undefined) {
    // State-dependent: only damaged, visible repairables
    if (e.damagedRepairables.length) {
      const list = e.damagedRepairables.map(d => `${d.id} (${round1(d.health)}/${round1(d.maxHealth)} HP)`).join(', ');
      caps.push(`Can repair (damaged): ${list}`);
    }
    // If empty, omit entirely — nothing to repair right now
  } else if (def && (def.repairables || []).length) {
    caps.push(`Repairs: ${(def.repairables || []).join(', ')}`);
  }
  if (caps.length) parts.push(`  * ${caps.join('; ')}`);
  return parts.join('\n');
}

/**
 * Compact one-line summary for a visible opponent entity.
 * "  * red_knight_1 (Knight) — 18 W of start | on forest | 180/250 HP"
 */
function oppEntityToMarkdown(e, byName) {
  const bits = [];
  const pos = describePosition(e);
  if (pos) bits.push(pos);
  if (e.terrain) bits.push(`on ${e.terrain}`);
  if (e.health !== undefined && e.maxHealth !== undefined) bits.push(`${round1(e.health)}/${round1(e.maxHealth)} HP`);
  // Include combat info so the player can assess the threat
  const def = byName.get(e.name);
  if (def && def.damage) bits.push(`${round1(def.damage.value)} ${def.damage.type} dmg`);
  return `  * ${e.id} (${capitalize(e.name)})${bits.length ? ' — ' + bits.join(' | ') : ''}`;
}

/** "3 NE of start", "at start", or "" — relative, no raw coordinates. */
function describePosition(e) {
  const fs = e.fromStart;
  if (!fs) return '';
  if (!fs.distance) return 'at start';
  return `${fs.distance} ${fs.direction} of start`;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Round to 1 decimal place to avoid floating-point noise (0.7000000000000002 -> 0.7). */
function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

/** Axial hex distance (same formula as HexGrid.distance; inlined to keep this module dependency-free). */
function hexDistance(a, b) {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}

/**
 * Vague terrain/topology summary for the LLM.
 * Groups contiguous explored cells by terrain into regions and describes each
 * as direction + distance + approximate size. Deliberately low-info: a vague
 * idea of the terrain beats nothing, and beats coordinate soup.
 *
 * @param {Object} gameState
 * @param {Object} player - needs exploredCells (Set of "q,r") and startCoord.
 * @returns {string} Markdown section (empty string if nothing to report).
 */
export function summarizeTerrain(gameState, player) {
  if (!gameState?.hexGrid || !player?.exploredCells?.size) return '';

  const explored = player.exploredCells;
  const grid = gameState.hexGrid;
  const start = player.startCoord;

  // Flood-fill contiguous regions by terrain name over explored cells.
  const visited = new Set();
  const regions = [];
  for (const key of explored) {
    if (visited.has(key)) continue;
    const [q, r] = key.split(',').map(Number);
    const cell = grid.getCell(q, r);
    if (!cell) continue;
    const terrain = cell.terrain?.name || 'Unknown';

    // BFS
    const queue = [key];
    visited.add(key);
    let size = 0, sumQ = 0, sumR = 0;
    while (queue.length) {
      const k = queue.pop();
      const [cq, cr] = k.split(',').map(Number);
      size++; sumQ += cq; sumR += cr;
      for (const [dq, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]]) {
        const nk = `${cq + dq},${cr + dr}`;
        if (!explored.has(nk) || visited.has(nk)) continue;
        const nc = grid.getCell(cq + dq, cr + dr);
        if (!nc || (nc.terrain?.name || 'Unknown') !== terrain) continue;
        visited.add(nk);
        queue.push(nk);
      }
    }
    regions.push({ terrain, size, cq: sumQ / size, cr: sumR / size });
  }

  // Keep only significant regions; sort biggest first.
  const significant = regions.filter(r => r.size >= 8).sort((a, b) => b.size - a.size).slice(0, 6);
  if (!significant.length) return '';

  const lines = ['### Terrain Overview (explored)'];
  for (const region of significant) {
    let rel = '';
    if (start) {
      try {
        const center = { q: Math.round(region.cq), r: Math.round(region.cr) };
        const dir = grid.directionTo ? grid.directionTo(start, center, true).fromSource : '';
        const dist = hexDistance(start, center);
        rel = dist === 0 ? 'at your start' : `${dist} ${dir} of start`;
      } catch { /* keep rel empty */ }
    }
    const kind = region.size >= 40 ? 'expanse' : region.size >= 20 ? 'region' : 'patch';
    lines.push(`* **${region.terrain}** ${kind}${rel ? ` ${rel}` : ''}, ~${region.size} cells`);
  }
  return lines.join('\n');
}
