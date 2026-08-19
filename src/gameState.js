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
   * @param {Array|Object} [terrainConfig=null] - Optional terrain definitions
   */
  generateMap(radius, terrainConfig = null) {
    const config = terrainConfig || this.manifestData?.terrains || null;
    this.hexGrid = new HexGrid(radius, config);
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
   * Initializes player starting resources, instantiates players defined in settings/manifest,
   * and spawns starting units on valid terrain.
   * @param {Object} manifestData - Loaded game manifest metadata
   * @param {Object} [settings=null] - Loaded or configured game settings
   */
  initializeManifest(manifestData, settings = null) {
    if (!manifestData) return;
    this.manifestData = manifestData;

    // 1. Setup starting resources dynamically from settings or manifest initialization
    const init = settings?.initialization || manifestData.initialization || {};
    const startingResources = { ...(init.startingResources || {}) };
    const ordersConfig = init.orders || null;

    // 2. Instantiate players from settings or manifest definitions array
    const playersList = settings?.players || manifestData.players;
    if (playersList && Array.isArray(playersList) && playersList.length > 0) {
      this.players = playersList.map((pDef, idx) => new Player(
        pDef.id || (idx + 1),
        pDef.name,
        pDef.color,
        startingResources,
        pDef.description || '',
        pDef.controller,
        ordersConfig
      ));
    } else {
      this.players = [
        new Player(1, 'Red Empire', '#ff4d4d', startingResources, '', null, ordersConfig),
        new Player(2, 'Blue Alliance', '#3399ff', startingResources, '', null, ordersConfig)
      ];
    }

    this.activePlayerIndex = 0;
    this.currentRound = 1;

    // 3. Determine starting coordinates based on grid radius and player count
    const radius = this.hexGrid.radius;
    const numPlayers = this.players.length;
    const targetRadius = Math.round(radius * 0.5);

    // 4. Spawn starting units for each player
    this.entities = [];
    const startingUnits = init.startingUnits || {};
    const startingUnitNames = Object.keys(startingUnits);

    if (startingUnitNames.length > 0) {
      const occupiedCoords = new Set();

      this.players.forEach((player, playerIdx) => {
        const angle = (2 * Math.PI * playerIdx) / numPlayers - Math.PI / 2;
        const targetQ = Math.round(targetRadius * Math.cos(angle));
        const targetR = Math.round(targetRadius * Math.sin(angle));

        const getUnitCanStandOnFn = (unitName) => {
          const uMeta = manifestData.entities[unitName];
          if (uMeta && uMeta.controllerClass) {
            try {
              const tempEntity = new uMeta.controllerClass(uMeta, player, this, null);
              return (cellOrTerrain) => {
                const terrain = cellOrTerrain.terrain || cellOrTerrain;
                if (!tempEntity.canStandOn(terrain)) return false;
                if (uMeta.spawnConditions && Array.isArray(uMeta.spawnConditions.terrain) && uMeta.spawnConditions.terrain.length > 0) {
                  return uMeta.spawnConditions.terrain.some(t => t.toLowerCase() === terrain.name?.toLowerCase());
                }
                return true;
              };
            } catch (e) {
              console.warn('Could not create temp entity for canStandOn check:', e);
            }
          }
          return (cellOrTerrain) => {
            const terrain = cellOrTerrain.terrain || cellOrTerrain;
            return terrain && terrain.elevation > -0.3;
          };
        };

        const firstUnitName = startingUnitNames[0];
        const firstUnitCanStandOn = getUnitCanStandOnFn(firstUnitName);

        // Find the starting cell for this player using BFS
        const startCell = this.hexGrid.findStartingCell(targetQ, targetR, (terrain) => {
          return firstUnitCanStandOn(terrain);
        });

        if (!startCell) {
          console.warn(`No valid starting cell found for player ${player.name}`);
          return;
        }

        player.startCoord = { q: startCell.q, r: startCell.r };

        // Helper to find next nearest available cell searching outwards from startCoord
        const findNextAvailableCell = (canStandOnFn) => {
          const visited = new Set();
          const queue = [{ q: startCell.q, r: startCell.r }];
          visited.add(`${startCell.q},${startCell.r}`);

          while (queue.length > 0) {
            const current = queue.shift();
            const key = `${current.q},${current.r}`;
            const cell = this.hexGrid.getCell(current.q, current.r);

            if (cell && !occupiedCoords.has(key) && canStandOnFn(cell)) {
              return cell;
            }

            const neighbors = HexGrid.getNeighborCoords(current.q, current.r);
            for (const nb of neighbors) {
              const nbKey = `${nb.q},${nb.r}`;
              if (!visited.has(nbKey) && this.hexGrid.getCell(nb.q, nb.r)) {
                visited.add(nbKey);
                queue.push(nb);
              }
            }
          }
          return null;
        };

        for (const [unitName, quantity] of Object.entries(startingUnits)) {
          const unitCanStandOn = getUnitCanStandOnFn(unitName);
          for (let i = 0; i < quantity; i++) {
            const cell = findNextAvailableCell(unitCanStandOn);
            if (cell) {
              const key = `${cell.q},${cell.r}`;
              occupiedCoords.add(key);
              this.spawnEntity(unitName, cell, player);
            } else {
              console.warn(`Could not find valid unoccupied cell to spawn ${unitName} for ${player.name}`);
            }
          }
        }
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
