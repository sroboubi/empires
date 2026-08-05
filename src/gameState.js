import { TerrainProvider, SeaLevel } from './terrainProvider.js';
import { getNeighbors } from './hexMath.js';
import { Player } from './player.js';

/**
 * GameState tracks players, hex cells, and active entity instances.
 * It is fully serializable to and from JSON.
 */
export class GameState {
  constructor() {
    this.players = [];
    this.cells = {}; // Key: "q,r", Value: { q, r, terrain, owner }
    this.entities = []; // List of active BaseEntity instances
    this.manifestData = null;
  }

  /**
   * Helper condition check for general terrain land validity (elevation > SeaLevel).
   * Used when no entity instance is available.
   * @param {Object} terrain
   * @returns {boolean}
   */
  isElevationAboveSeaLevel(terrain) {
    return terrain && terrain.elevation > SeaLevel;
  }

  /**
   * Generates a hexagonal map of a given radius filled with randomized terrain types.
   * @param {number} radius - Grid radius (number of hex rings from the center)
   */
  generateMap(radius) {
    this.cells = {};
    this.entities = [];

    const terrainProvider = new TerrainProvider(radius);

    // Default placeholder players
    this.players = [
      new Player(1, 'Red Empire', '#ff4d4d'),
      new Player(2, 'Blue Alliance', '#3399ff')
    ];

    for (let q = -radius; q <= radius; q++) {
      const rMin = Math.max(-radius, -q - radius);
      const rMax = Math.min(radius, -q + radius);

      for (let r = rMin; r <= rMax; r++) {
        const terrain = terrainProvider.get(q, r);

        // Key is string "q,r" for easy indexing
        this.cells[`${q},${r}`] = {
          q,
          r,
          terrain,
          owner: null
        };
      }
    }
  }

  /**
   * Initializes player starting resources and spawns starting units on valid terrain.
   * @param {Object} manifestData - Loaded game manifest metadata
   */
  initializeManifest(manifestData) {
    if (!manifestData) return;
    this.manifestData = manifestData;

    // 1. Setup starting resources dynamically from manifest initialization settings
    const startingResources = {};
    if (manifestData.initialization && manifestData.initialization.startingResources) {
      manifestData.initialization.startingResources.forEach(res => {
        startingResources[res.name] = res.quantity;
      });
    }

    this.players = [
      new Player(1, 'Red Empire', '#ff4d4d', startingResources),
      new Player(2, 'Blue Alliance', '#3399ff', startingResources)
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

    // 3. Spawn starting units for each player
    this.entities = [];
    if (manifestData.initialization && manifestData.initialization.startingUnits) {
      this.players.forEach(player => {
        const startCoord = player.startCoord;
        
        const openCoords = [startCoord];
        const neighbors = getNeighbors(startCoord.q, startCoord.r);
        neighbors.forEach(nb => {
          const cell = this.cells[`${nb.q},${nb.r}`];
          if (cell && this.isElevationAboveSeaLevel(cell.terrain)) {
            openCoords.push(nb);
          }
        });

        let coordIdx = 0;
        manifestData.initialization.startingUnits.forEach(unitConfig => {
          for (let i = 0; i < unitConfig.quantity; i++) {
            const coord = openCoords[coordIdx % openCoords.length];
            const cell = this.cells[`${coord.q},${coord.r}`];
            if (cell) {
              this.spawnEntity(unitConfig.name, cell, player);
            }
            coordIdx++;
          }
        });
      });
    }
  }

  /**
   * Spawns a new entity instance on a cell.
   * @param {string} entityName - Name of entity in manifest
   * @param {Object} cell - Target cell
   * @param {Player|null} owner - Owning player
   * @param {Object} [initialState] - Optional state override
   * @returns {BaseEntity|null} Spawned entity instance
   */
  spawnEntity(entityName, cell, owner = null, initialState = null) {
    if (!this.manifestData || !this.manifestData.entities[entityName]) {
      console.warn(`Cannot spawn entity "${entityName}": metadata not found in manifest.`);
      return null;
    }

    const meta = this.manifestData.entities[entityName];
    const ControllerClass = meta.controllerClass;
    if (!ControllerClass) {
      console.warn(`Controller class for "${entityName}" not loaded.`);
      return null;
    }

    try {
      const entity = new ControllerClass(meta, owner, this, cell, initialState);
      this.entities.push(entity);
      return entity;
    } catch (err) {
      console.error(`Failed to instantiate entity controller for "${entityName}":`, err);
      return null;
    }
  }

  /**
   * Removes an entity by ID.
   * @param {string} entityId
   */
  removeEntity(entityId) {
    this.entities = this.entities.filter(e => e.id !== entityId);
  }

  /**
   * Returns the primary entity standing on cell at (q, r), or null.
   * @param {number} q
   * @param {number} r
   * @returns {BaseEntity|null}
   */
  getEntityAt(q, r) {
    return this.entities.find(e => e.q === q && e.r === r) || null;
  }

  /**
   * Finds the closest land cell near target coordinate.
   */
  findStartingLandCell(qTarget, rTarget) {
    const targetCell = this.cells[`${qTarget},${rTarget}`];
    if (targetCell && this.isElevationAboveSeaLevel(targetCell.terrain)) {
      return targetCell;
    }
    let bestCell = null;
    let minDistance = Infinity;
    for (const key in this.cells) {
      const cell = this.cells[key];
      if (this.isElevationAboveSeaLevel(cell.terrain)) {
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
   * Turn progression hook: steps all active entities and updates global turn context.
   */
  stepTurn() {
    this.entities.forEach(entity => {
      try {
        entity.step({ gameState: this });
      } catch (err) {
        console.error(`Error during step on entity ${entity.name}:`, err);
      }
    });
  }

  /**
   * Serializes the game state to JSON string.
   */
  serialize() {
    return JSON.stringify({
      players: this.players.map(p => p.toJSON()),
      entities: this.entities.map(e => e.toJSON()),
      cells: this.cells
    });
  }

  /**
   * Deserializes a JSON string to populate the game state.
   * @param {string} jsonString
   */
  deserialize(jsonString) {
    try {
      const data = JSON.parse(jsonString);

      // Re-hydrate Players
      if (data.players) {
        this.players = data.players.map(p => Player.fromJSON(p));
      }

      // Re-hydrate Cells
      this.cells = data.cells || {};

      // Re-hydrate Entities
      this.entities = [];
      if (data.entities && Array.isArray(data.entities)) {
        data.entities.forEach(eData => {
          const cell = this.cells[`${eData.q},${eData.r}`];
          const owner = this.players.find(p => p.id === eData.ownerId) || null;
          if (cell) {
            this.spawnEntity(eData.name, cell, owner, eData.state);
          }
        });
      }
    } catch (e) {
      console.error('Failed to deserialize GameState:', e);
    }
    return this;
  }
}
