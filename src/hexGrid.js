import { TerrainProvider } from './terrainProvider.js';

/**
 * The six axial direction vectors for a pointy-topped hex grid.
 * Named by compass direction: E, NE, NW, W, SW, SE.
 */
const DIRECTIONS = {
  E: { q: 1, r: 0 },
  NE: { q: 1, r: -1 },
  NW: { q: 0, r: -1 },
  W: { q: -1, r: 0 },
  SW: { q: -1, r: 1 },
  SE: { q: 0, r: 1 }
};

/**
 * Reverse mapping — for each direction, the opposite direction name.
 */
const OPPOSITE_DIRECTION = {
  E: 'W',
  NE: 'SW',
  NW: 'SE',
  W: 'E',
  SW: 'NE',
  SE: 'NW'
};

/**
 * HexGrid — encapsulates the hex grid, all hex math, cell storage,
 * pathfinding, direction, movement cost, and line-of-sight calculations.
 *
 * Cells are stored in a Map keyed by "q,r" strings.
 * Each cell is a plain object: { q, r, terrain }.
 */
export class HexGrid {

  /**
   * Generates a hexagonal grid of the given radius using TerrainProvider.
   * @param {number} radius - Grid radius (number of hex rings from center)
   */
  constructor(radius) {
    this.radius = radius;
    this.cells = new Map();

    const terrainProvider = new TerrainProvider(radius);

    for (let q = -radius; q <= radius; q++) {
      const rMin = Math.max(-radius, -q - radius);
      const rMax = Math.min(radius, -q + radius);

      for (let r = rMin; r <= rMax; r++) {
        const terrain = terrainProvider.get(q, r);
        this.cells.set(`${q},${r}`, { q, r, terrain });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Cell accessors
  // ---------------------------------------------------------------------------

  /**
   * Returns the cell at axial coordinates (q, r), or undefined if out of bounds.
   * @param {number} q
   * @param {number} r
   * @returns {Object|undefined}
   */
  getCell(q, r) {
    return this.cells.get(`${q},${r}`);
  }

  /**
   * Returns all cells as a flat array.
   * @returns {Array<Object>}
   */
  getCellsArray() {
    return Array.from(this.cells.values());
  }

  /**
   * Returns all cells as a plain object keyed by "q,r" — backwards compatible
   * with the old gameState.cells format used by renderer and serialization.
   * @returns {Object}
   */
  getCellsObject() {
    const obj = {};
    for (const [key, cell] of this.cells) {
      obj[key] = cell;
    }
    return obj;
  }

  // ---------------------------------------------------------------------------
  // Neighbor helpers (instance — filter to cells that exist in grid)
  // ---------------------------------------------------------------------------

  /**
   * Returns the 6 raw neighbor coordinate offsets.
   * @param {number} q
   * @param {number} r
   * @returns {Array<{q: number, r: number}>}
   */
  static getNeighborCoords(q, r) {
    return Object.values(DIRECTIONS).map(d => ({ q: q + d.q, r: r + d.r }));
  }

  /**
   * Returns neighbor cells that exist in this grid.
   * @param {number} q
   * @param {number} r
   * @returns {Array<Object>} Array of cell objects
   */
  getNeighbors(q, r) {
    const coords = HexGrid.getNeighborCoords(q, r);
    const result = [];
    for (const c of coords) {
      const cell = this.cells.get(`${c.q},${c.r}`);
      if (cell) result.push(cell);
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Static hex-math functions (merged from hexMath.js)
  // ---------------------------------------------------------------------------

  /**
   * Converts axial coordinates to 3D Cartesian coordinates (x, z) on the flat plane.
   * @param {number} q - Axial column coordinate
   * @param {number} r - Axial row coordinate
   * @param {number} size - Outer radius of the hexagon
   * @returns {{x: number, z: number}}
   */
  static axialToPixel(q, r, size) {
    const x = size * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r);
    const z = size * (1.5 * r);
    return { x, z };
  }

  /**
   * Converts 3D Cartesian coordinates (x, z) to axial coordinates (q, r).
   * @param {number} x
   * @param {number} z
   * @param {number} size - Outer radius of the hexagon
   * @returns {{q: number, r: number}}
   */
  static pixelToAxial(x, z, size) {
    const q = ((Math.sqrt(3) / 3) * x - (1 / 3) * z) / size;
    const r = ((2 / 3) * z) / size;
    return HexGrid.hexRound(q, r);
  }

  /**
   * Rounds fractional axial coordinates to the nearest integer axial coordinates.
   * @param {number} q
   * @param {number} r
   * @returns {{q: number, r: number}}
   */
  static hexRound(q, r) {
    const s = -q - r;
    let qi = Math.round(q);
    let ri = Math.round(r);
    let si = Math.round(s);

    const qDiff = Math.abs(qi - q);
    const rDiff = Math.abs(ri - r);
    const sDiff = Math.abs(si - s);

    if (qDiff > rDiff && qDiff > sDiff) {
      qi = -ri - si;
    } else if (rDiff > sDiff) {
      ri = -qi - si;
    } else {
      si = -qi - ri;
    }

    return { q: qi, r: ri };
  }

  /**
   * Calculates the axial distance between two hexes.
   * @param {{q: number, r: number}} a
   * @param {{q: number, r: number}} b
   * @returns {number}
   */
  static distance(a, b) {
    return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
  }

  /**
   * Checks if two hexes are adjacent neighbors.
   * @param {{q: number, r: number}} a
   * @param {{q: number, r: number}} b
   * @returns {boolean}
   */
  static isNeighbor(a, b) {
    return HexGrid.distance(a, b) === 1;
  }

  // ---------------------------------------------------------------------------
  // Finding a starting cell (BFS with a terrain predicate function)
  // ---------------------------------------------------------------------------

  /**
   * BFS outward from target coordinate until a cell passes the given predicate.
   * The predicate is a function (terrain) => boolean — typically entity.canStandOn.
   *
   * @param {number} qTarget - Starting q coordinate for search
   * @param {number} rTarget - Starting r coordinate for search
   * @param {function} canStandOnFn - Function that takes a terrain object and returns boolean
   * @returns {Object|null} The first cell that passes the predicate, or null
   */
  findStartingCell(qTarget, rTarget, canStandOnFn) {
    // Check the target cell itself first
    const targetCell = this.getCell(qTarget, rTarget);
    if (targetCell && canStandOnFn(targetCell.terrain)) {
      return targetCell;
    }

    // BFS outward
    const visited = new Set();
    const queue = [];

    // Seed with the target coord
    const startKey = `${qTarget},${rTarget}`;
    visited.add(startKey);
    queue.push({ q: qTarget, r: rTarget });

    while (queue.length > 0) {
      const current = queue.shift();
      const neighbors = HexGrid.getNeighborCoords(current.q, current.r);

      for (const nb of neighbors) {
        const key = `${nb.q},${nb.r}`;
        if (visited.has(key)) continue;
        visited.add(key);

        const cell = this.getCell(nb.q, nb.r);
        if (!cell) continue;

        if (canStandOnFn(cell.terrain)) {
          return cell;
        }

        queue.push(nb);
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // directionTo — compass direction from source to target
  // ---------------------------------------------------------------------------

  /**
   * Determines the compass direction from source to target hex.
   * Returns an object with:
   *   - fromSource: direction name to look from source toward target (E, NE, NW, W, SW, SE)
   *   - fromTarget: direction name to look from target toward source (the opposite)
   *
   * For non-adjacent hexes, this returns the closest matching direction
   * based on the angle between the two hex centers.
   *
   * @param {{q: number, r: number}} source
   * @param {{q: number, r: number}} target
   * @returns {{fromSource: string, fromTarget: string}}
   */
  directionTo(source, target) {
    const dq = target.q - source.q;
    const dr = target.r - source.r;

    // For adjacent cells, we can do an exact match
    for (const [name, dir] of Object.entries(DIRECTIONS)) {
      if (dq === dir.q && dr === dir.r) {
        return { fromSource: name, fromTarget: OPPOSITE_DIRECTION[name] };
      }
    }

    // For non-adjacent cells, compute angle via pixel positions and find closest direction
    const sourcePixel = HexGrid.axialToPixel(source.q, source.r, 1);
    const targetPixel = HexGrid.axialToPixel(target.q, target.r, 1);

    const dx = targetPixel.x - sourcePixel.x;
    const dz = targetPixel.z - sourcePixel.z;

    // atan2 gives angle from positive x-axis; we use (dx, -dz) so that
    // "up" on screen (negative z) corresponds to a positive angle.
    const angle = Math.atan2(-dz, dx);

    // Map each direction to its angular position
    let bestName = 'E';
    let bestDiff = Infinity;

    for (const [name, dir] of Object.entries(DIRECTIONS)) {
      const dirPixel = HexGrid.axialToPixel(dir.q, dir.r, 1);
      const dirAngle = Math.atan2(-dirPixel.z, dirPixel.x);

      let diff = Math.abs(angle - dirAngle);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;

      if (diff < bestDiff) {
        bestDiff = diff;
        bestName = name;
      }
    }

    return { fromSource: bestName, fromTarget: OPPOSITE_DIRECTION[bestName] };
  }

  // ---------------------------------------------------------------------------
  // movementCostTo — minimum cost path, only through cells closer to target
  // ---------------------------------------------------------------------------

  /**
   * Calculates the minimum movement cost path from source to target,
   * only considering cells that are progressively closer to the target
   * (never moving away). Uses Dijkstra's algorithm restricted to
   * neighbors whose distance to target is strictly less than the
   * current cell's distance to target.
   *
   * Returns the total cost (sum of terrain.movementCost along the path)
   * and the ordered list of cells along the best path (including source and target).
   *
   * @param {{q: number, r: number}} source - Source cell coordinates
   * @param {{q: number, r: number}} target - Target cell coordinates
   * @returns {{cost: number, path: Array<Object>}|null} Null if no path exists
   */
  movementCostTo(source, target) {
    const sourceCell = this.getCell(source.q, source.r);
    const targetCell = this.getCell(target.q, target.r);
    if (!sourceCell || !targetCell) return null;

    const sourceKey = `${source.q},${source.r}`;
    const targetKey = `${target.q},${target.r}`;

    if (sourceKey === targetKey) {
      return { cost: 0, path: [sourceCell] };
    }

    // Dijkstra with the constraint: only move to neighbors that are
    // strictly closer to the target than the current cell.
    const dist = {};        // best cost to reach each cell
    const prev = {};        // previous cell key in best path
    dist[sourceKey] = 0;

    // Simple priority queue via sorted array (grid is bounded, perf is fine)
    const pq = [{ key: sourceKey, cost: 0 }];

    while (pq.length > 0) {
      // Extract min-cost entry
      pq.sort((a, b) => a.cost - b.cost);
      const { key: currentKey, cost: currentCost } = pq.shift();

      if (currentKey === targetKey) {
        // Reconstruct path
        const path = [];
        let k = targetKey;
        while (k !== undefined) {
          path.unshift(this.cells.get(k));
          k = prev[k];
        }
        return { cost: currentCost, path };
      }

      // Skip if we already found a better route to this node
      if (currentCost > (dist[currentKey] ?? Infinity)) continue;

      const current = this.cells.get(currentKey);
      const currentDistToTarget = HexGrid.distance(current, target);

      const neighbors = this.getNeighbors(current.q, current.r);

      for (const nb of neighbors) {
        const nbDistToTarget = HexGrid.distance(nb, target);

        // Only allow moves that get strictly closer to the target
        if (nbDistToTarget >= currentDistToTarget) continue;

        const nbKey = `${nb.q},${nb.r}`;
        const edgeCost = nb.terrain.movementCost;
        const newCost = currentCost + edgeCost;

        if (newCost < (dist[nbKey] ?? Infinity)) {
          dist[nbKey] = newCost;
          prev[nbKey] = currentKey;
          pq.push({ key: nbKey, cost: newCost });
        }
      }
    }

    return null; // No path found
  }

  // ---------------------------------------------------------------------------
  // getSightAndTrajectory — Comprehensive Raycast & Ballistics Analysis
  // ---------------------------------------------------------------------------

  /**
   * Performs 3D raycasting along the center-top surface of cells to calculate
   * line-of-sight and ballistic trajectory parameters.
   *
   * Handles edge boundary cases by taking the minimum elevation along shared edges
   * (preventing cliff wall "bleed"), and returns detailed metrics for direct and
   * indirect (curved) fire evaluation.
   *
   * @param {{q: number, r: number}} source - Source cell coordinates
   * @param {{q: number, r: number}} target - Target cell coordinates
   * @returns {{
   *   visible: boolean,
   *   distance: number,
   *   path: Array<Object>,
   *   maxObstructionHeight: number,
   *   maxObstructionDelta: number
   * }}
   */
  getSightAndTrajectory(source, target) {
    const sourceCell = this.getCell(source.q, source.r);
    const targetCell = this.getCell(target.q, target.r);

    // Handle out-of-bounds or invalid cell inputs
    if (!sourceCell || !targetCell) {
      return {
        visible: false,
        distance: Infinity,
        path: [],
        maxObstructionHeight: Infinity,
        maxObstructionDelta: Infinity
      };
    }

    // Distance in hex cell steps
    const distance = HexGrid.distance(source, target);

    // Handle source === target (same cell)
    if (distance === 0) {
      return {
        visible: true,
        distance: 0,
        path: [sourceCell],
        maxObstructionHeight: sourceCell.terrain.elevation,
        maxObstructionDelta: 0
      };
    }

    const sourceElev = sourceCell.terrain.elevation;
    const targetElev = targetCell.terrain.elevation;

    // Convert axial (q, r) to cube (q, r, s) coordinates for linear interpolation
    const aCube = { q: source.q, r: source.r, s: -source.q - source.r };
    const bCube = { q: target.q, r: target.r, s: -target.q - target.r };

    const pathSet = new Set();
    const pathList = [];

    let maxObstructionHeight = -Infinity;
    let maxObstructionDelta = 0;
    let isDirectlyVisible = true;

    // Sampling steps along the ray (over-sampled to prevent skipping hexes)
    const sampleSteps = distance * 6;

    for (let i = 0; i <= sampleSteps; i++) {
      const t = i / sampleSteps;

      // Linear interpolation in 3D cube coordinate space
      const curQ = aCube.q + (bCube.q - aCube.q) * t;
      const curR = aCube.r + (bCube.r - aCube.r) * t;
      const curS = aCube.s + (bCube.s - aCube.s) * t;

      // Determine the primary hex cell at this point on the ray
      const roundedPrimary = HexGrid.hexRound(curQ, curR);
      const primaryCell = this.getCell(roundedPrimary.q, roundedPrimary.r);

      // Collect unique cells crossed by the ray to build the visual path array
      if (primaryCell && !pathSet.has(`${primaryCell.q},${primaryCell.r}`)) {
        pathSet.add(`${primaryCell.q},${primaryCell.r}`);
        pathList.push(primaryCell);
      }

      // Evaluate terrain elevations along intermediate points (excluding start and target cells)
      if (t > 0.01 && t < 0.99) {
        // Calculate the height of the direct 3D visual ray at progress t
        const rayHeightAtStep = sourceElev + t * (targetElev - sourceElev);

        let effectiveStepElevation = primaryCell ? primaryCell.terrain.elevation : 0;

        // Check if sample point lies on or near a shared edge boundary (near half-integers)
        const qDiff = Math.abs(curQ - Math.round(curQ));
        const rDiff = Math.abs(curR - Math.round(curR));
        const sDiff = Math.abs(curS - Math.round(curS));

        if (Math.abs(qDiff - 0.5) < 0.05 || Math.abs(rDiff - 0.5) < 0.05 || Math.abs(sDiff - 0.5) < 0.05) {
          // Sample candidate cells on both sides of the shared edge
          const alt1 = HexGrid.hexRound(curQ + 0.02, curR - 0.02);
          const alt2 = HexGrid.hexRound(curQ - 0.02, curR + 0.02);

          const cell1 = this.getCell(alt1.q, alt1.r);
          const cell2 = this.getCell(alt2.q, alt2.r);

          // Take the lower elevation along the edge seam to prevent cliff walls from bleeding into clear air corridors
          if (cell1 && cell2) {
            effectiveStepElevation = Math.min(cell1.terrain.elevation, cell2.terrain.elevation);
          }
        }

        // Track the highest absolute terrain elevation along the intermediate path
        if (effectiveStepElevation > maxObstructionHeight) {
          maxObstructionHeight = effectiveStepElevation;
        }

        // Check if the terrain elevation exceeds the direct line-of-sight ray height
        const delta = effectiveStepElevation - rayHeightAtStep;
        if (delta > 0) {
          isDirectlyVisible = false;
          if (delta > maxObstructionDelta) {
            maxObstructionDelta = delta;
          }
        }
      }
    }

    return {
      visible: isDirectlyVisible,
      distance: distance,
      path: pathList,
      maxObstructionHeight: maxObstructionHeight === -Infinity ? 0 : maxObstructionHeight,
      maxObstructionDelta: maxObstructionDelta
    };
  }
}
