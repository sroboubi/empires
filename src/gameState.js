import { HexGrid } from './hexGrid.js';
import { Player } from './player.js';

/**
 * GameState tracks players, turn cycle, the hex grid, and active entity instances.
 * It is fully serializable to and from JSON.
 */
export class GameState {
  constructor() {
    this.players = [];
    this.activePlayerIndex = 0;
    this.currentRound = 1;
    this.hexGrid = null;  // HexGrid instance
    this.entities = [];   // List of active BaseEntity instances
    this.manifestData = null;
  }

  /**
   * Returns the currently active Player instance.
   * @returns {Player|null}
   */
  get activePlayer() {
    if (!this.players || this.players.length === 0) return null;
    return this.players[this.activePlayerIndex] || this.players[0];
  }

  /**
   * Provides backwards-compatible access to cells as a plain object keyed by "q,r".
   * Used by renderer, serialization, and other code that expects the old format.
   * @returns {Object}
   */
  get cells() {
    if (!this.hexGrid) return {};
    return this.hexGrid.getCellsObject();
  }

  /**
   * Generates a hexagonal map of a given radius filled with terrain.
   * @param {number} radius - Grid radius (number of hex rings from the center)
   */
  generateMap(radius) {
    this.hexGrid = new HexGrid(radius);
    this.entities = [];
    this.activePlayerIndex = 0;
    this.currentRound = 1;

    // Default placeholder players if manifest not initialized yet
    this.players = [
      new Player(1, 'Red Empire', '#ff4d4d'),
      new Player(2, 'Blue Alliance', '#3399ff')
    ];
  }

  /**
   * Initializes player starting resources, instantiates players defined in manifest,
   * and spawns starting units on valid terrain.
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

    // 2. Instantiate players from manifest definitions array
    if (manifestData.players && Array.isArray(manifestData.players) && manifestData.players.length > 0) {
      this.players = manifestData.players.map(pDef => new Player(
        pDef.id,
        pDef.name,
        pDef.color,
        startingResources,
        pDef.description,
        pDef.controller
      ));
    } else {
      this.players = [
        new Player(1, 'Red Empire', '#ff4d4d', startingResources),
        new Player(2, 'Blue Alliance', '#3399ff', startingResources)
      ];
    }

    this.activePlayerIndex = 0;
    this.currentRound = 1;

    // 3. Determine starting coordinates based on grid radius
    const radius = this.hexGrid.radius;

    // Target coords on opposite sides of the map
    const p1TargetQ = -Math.round(radius / 4);
    const p1TargetR = Math.round(radius / 4);
    const p2TargetQ = Math.round(radius / 4);
    const p2TargetR = -Math.round(radius / 4);

    // 4. Spawn starting units for each player
    this.entities = [];
    if (manifestData.initialization && manifestData.initialization.startingUnits) {
      const startingUnits = manifestData.initialization.startingUnits;

      this.players.forEach((player, playerIdx) => {
        const targetQ = playerIdx === 0 ? p1TargetQ : p2TargetQ;
        const targetR = playerIdx === 0 ? p1TargetR : p2TargetR;

        // Create a temporary entity from the first starting unit type to get its canStandOn
        const firstUnitName = startingUnits[0].name;
        const firstUnitMeta = manifestData.entities[firstUnitName];
        let canStandOnFn = (terrain) => terrain && terrain.elevation > -0.3; // fallback

        if (firstUnitMeta && firstUnitMeta.controllerClass) {
          try {
            const tempEntity = new firstUnitMeta.controllerClass(firstUnitMeta, player, this, null);
            canStandOnFn = (terrain) => tempEntity.canStandOn(terrain);
          } catch (e) {
            console.warn('Could not create temp entity for canStandOn check, using fallback:', e);
          }
        }

        // Find the starting cell for this player using BFS
        const startCell = this.hexGrid.findStartingCell(targetQ, targetR, canStandOnFn);
        if (!startCell) {
          console.warn(`No valid starting cell found for player ${player.name}`);
          return;
        }

        player.startCoord = { q: startCell.q, r: startCell.r };

        // Collect open cells near the start: start cell + valid neighbors
        const openCoords = [startCell];
        const neighbors = this.hexGrid.getNeighbors(startCell.q, startCell.r);
        neighbors.forEach(nb => {
          if (canStandOnFn(nb.terrain)) {
            openCoords.push(nb);
          }
        });

        let coordIdx = 0;
        startingUnits.forEach(unitConfig => {
          for (let i = 0; i < unitConfig.quantity; i++) {
            const coord = openCoords[coordIdx % openCoords.length];
            const cell = this.hexGrid.getCell(coord.q, coord.r);
            if (cell) {
              this.spawnEntity(unitConfig.name, cell, player);
            }
            coordIdx++;
          }
        });
      });
    }

    // Start turn for the initial player
    this.startTurn();
  }

  /**
   * Starts turn for the active player.
   */
  startTurn() {
    if (this.activePlayer) {
      this.activePlayer.step(this);
    }
  }

  /**
   * Advances game turn to the next player.
   * If all players have taken a turn, increments currentRound.
   */
  endTurn() {
    if (this.players.length === 0) return;

    this.activePlayerIndex = (this.activePlayerIndex + 1) % this.players.length;
    if (this.activePlayerIndex === 0) {
      this.currentRound++;
    }

    this.startTurn();
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
    const targetEntity = this.entities.find(e => e.id === entityId);
    if (targetEntity && targetEntity.owner) {
      targetEntity.visibleCells.clear();
    }

    this.entities = this.entities.filter(e => e.id !== entityId);

    if (targetEntity && targetEntity.owner) {
      targetEntity.owner.updateVisibility(this);
    }
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
   * Serializes the game state to JSON string.
   */
  serialize() {
    return JSON.stringify({
      activePlayerIndex: this.activePlayerIndex,
      currentRound: this.currentRound,
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

      if (data.activePlayerIndex !== undefined) {
        this.activePlayerIndex = data.activePlayerIndex;
      }
      if (data.currentRound !== undefined) {
        this.currentRound = data.currentRound;
      }

      // Re-hydrate Players
      if (data.players) {
        this.players = data.players.map(p => Player.fromJSON(p));
      }

      // Re-hydrate Cells into the HexGrid
      if (data.cells) {
        const cellKeys = Object.keys(data.cells);
        let maxQ = 0;
        for (const key of cellKeys) {
          const cell = data.cells[key];
          maxQ = Math.max(maxQ, Math.abs(cell.q));
        }
        this.hexGrid = new HexGrid(maxQ);
        this.hexGrid.cells.clear();
        for (const key of cellKeys) {
          this.hexGrid.cells.set(key, data.cells[key]);
        }
      }

      // Re-hydrate Entities
      this.entities = [];
      if (data.entities && Array.isArray(data.entities)) {
        data.entities.forEach(eData => {
          const cell = this.hexGrid ? this.hexGrid.getCell(eData.q, eData.r) : null;
          const owner = this.players.find(p => p.id === eData.ownerId) || null;
          if (cell) {
            this.spawnEntity(eData.name, cell, owner, eData.state);
          }
        });
      }

      this.players.forEach(p => p.updateVisibility(this));
    } catch (e) {
      console.error('Failed to deserialize GameState:', e);
    }
    return this;
  }
}
