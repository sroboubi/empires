import { TerrainProvider } from "./terrainProvider.js";
import { getNeighbors } from "./hexMath.js";

/**
 * GameState tracks players and the hex grid cells.
 * It is fully serializable to and from JSON.
 */
export class GameState {
  constructor() {
    this.players = [];
    this.cells = {}; // Key: "q,r", Value: { q, r, terrain, owner, entities }
  }

  /**
   * Generates a hexagonal map of a given radius filled with randomized terrain types.
   * Also spawns neutral resource nodes on the map.
   * @param {number} radius - Grid radius (number of hex rings from the center)
   */
  generateMap(radius) {
    this.cells = {};

    const terrainProvider = new TerrainProvider(radius);

    // Clear and add default placeholder players
    this.players = [
      { id: 1, name: 'Red Empire', color: '#ff4d4d' },
      { id: 2, name: 'Blue Alliance', color: '#3399ff' }
    ];

    for (let q = -radius; q <= radius; q++) {
      const rMin = Math.max(-radius, -q - radius);
      const rMax = Math.min(radius, -q + radius);

      for (let r = rMin; r <= rMax; r++) {
        const terrain = terrainProvider.get(q, r);

        // Randomly spawn neutral resource deposits depending on terrain type
        const entities = [];
        let spawnResource = null;
        if (terrain.name === 'Mountains' || terrain.name === 'Hills') {
          if (Math.random() < 0.08) spawnResource = 'iron';
        } else if (terrain.name === 'Grasslands' || terrain.name === 'Tundra') {
          if (Math.random() < 0.05) spawnResource = 'deer';
          else if (Math.random() < 0.03) spawnResource = 'bison';
        } else if (terrain.name === 'ShallowWater' || terrain.name === 'Swamp') {
          if (Math.random() < 0.06) spawnResource = 'crab';
        }

        if (spawnResource) {
          entities.push({
            id: `${spawnResource}_${Math.random().toString(36).substr(2, 9)}`,
            name: spawnResource,
            category: 'resource',
            ownerId: null, // Neutral
            q,
            r
          });
        }

        // Key is the string "q,r" for easy indexing and serialization
        this.cells[`${q},${r}`] = {
          q,
          r,
          terrain,
          owner: null,
          entities
        };
      }
    }
  }

  /**
   * Initializes player starting resources and spawns starting units on land.
   * @param {Object} manifestData - The loaded game manifest
   */
  initializeManifest(manifestData) {
    if (!manifestData) return;

    // 1. Setup starting resources for each player
    const startingResources = {};
    if (manifestData.initialization && manifestData.initialization.startingResources) {
      manifestData.initialization.startingResources.forEach(res => {
        startingResources[res.name] = res.quantity;
      });
    }

    this.players = [
      { id: 1, name: 'Red Empire', color: '#ff4d4d', resources: { ...startingResources } },
      { id: 2, name: 'Blue Alliance', color: '#3399ff', resources: { ...startingResources } }
    ];

    // 2. Determine starting coordinates based on cell map size
    let maxQ = 0;
    for (const key in this.cells) {
      maxQ = Math.max(maxQ, Math.abs(this.cells[key].q));
    }
    const radius = maxQ;

    // Place players on land cells on opposite sides
    const p1Start = this.findStartingLandCell(-Math.round(radius / 4), Math.round(radius / 4));
    const p2Start = this.findStartingLandCell(Math.round(radius / 4), -Math.round(radius / 4));

    this.players[0].startCoord = p1Start ? { q: p1Start.q, r: p1Start.r } : { q: 0, r: 0 };
    this.players[1].startCoord = p2Start ? { q: p2Start.q, r: p2Start.r } : { q: 0, r: 0 };

    // 3. Spawn starting units for each player near starting position
    if (manifestData.initialization && manifestData.initialization.startingUnits) {
      this.players.forEach((player, playerIdx) => {
        const startCoord = player.startCoord;
        
        // Find land cells surrounding the starting coordinates
        const openCoords = [startCoord];
        const neighbors = getNeighbors(startCoord.q, startCoord.r);
        neighbors.forEach(nb => {
          const cell = this.cells[`${nb.q},${nb.r}`];
          if (cell && this.isLand(cell.terrain)) {
            openCoords.push(nb);
          }
        });

        let coordIdx = 0;
        manifestData.initialization.startingUnits.forEach(unit => {
          for (let i = 0; i < unit.quantity; i++) {
            const coord = openCoords[coordIdx % openCoords.length];
            const cell = this.cells[`${coord.q},${coord.r}`];
            if (cell) {
              cell.entities = cell.entities || [];
              cell.entities.push({
                id: `${unit.name}_${player.id}_${Math.random().toString(36).substr(2, 9)}`,
                name: unit.name,
                category: 'unit',
                ownerId: player.id,
                q: coord.q,
                r: coord.r
              });
            }
            coordIdx++;
          }
        });
      });
    }
  }

  /**
   * Helper to check if a terrain is land (non-water).
   */
  isLand(terrain) {
    return terrain.name !== 'ShallowWater' && terrain.name !== 'DeepWater' && terrain.name !== 'Default';
  }

  /**
   * Finds the closest land cell near a target coordinate.
   */
  findStartingLandCell(qTarget, rTarget) {
    const targetCell = this.cells[`${qTarget},${rTarget}`];
    if (targetCell && this.isLand(targetCell.terrain)) {
      return targetCell;
    }
    let bestCell = null;
    let minDistance = Infinity;
    for (const key in this.cells) {
      const cell = this.cells[key];
      if (this.isLand(cell.terrain)) {
        const dist = Math.abs(cell.q - qTarget) + Math.abs(cell.r - rTarget);
        if (dist < minDistance) {
          minDistance = dist;
          bestCell = cell;
        }
      }
    }
    return bestCell;
  }

  /**
   * Serializes the game state to a JSON string.
   * @returns {string} Serialized game state
   */
  serialize() {
    return JSON.stringify({
      players: this.players,
      cells: this.cells
    });
  }

  /**
   * Deserializes a JSON string to populate the game state.
   * @param {string} jsonString - Serialized state
   * @returns {GameState} Returns this instance for chaining
   */
  deserialize(jsonString) {
    try {
      const data = JSON.parse(jsonString);
      this.players = data.players || [];
      this.cells = data.cells || {};
    } catch (e) {
      console.error('Failed to deserialize GameState:', e);
    }
    return this;
  }
}
