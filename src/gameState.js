import { HexGrid } from './hexGrid.js';
import { Player } from './player.js';
import { manageBarbarians } from './ai/barbarians/manager.js';
import { spawnCellResources } from './resources.js';
import { CONFIG } from './config.js';
import Entity from './entity.js';

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
    this.settings = null;
    this.gameOver = false;
    this.chatHistory = {};
    this.replayRecorder = null;
    this.fogPovPlayer = null; // Replay only: fog POV override (snapshot's active player); null = human-player union
  }

  /**
   * Helper to compute sorted pair key for chat history between two players.
   * Keyed by player ID (unique by construction) so two players who share a
   * display name still get separate histories. Accepts Player objects or raw
   * IDs. The message objects themselves keep the sender's name for display.
   * @param {Player|string|number} player1
   * @param {Player|string|number} player2
   * @returns {string}
   */
  getChatKey(player1, player2) {
    const id1 = (player1 && typeof player1 === 'object') ? player1.id : player1;
    const id2 = (player2 && typeof player2 === 'object') ? player2.id : player2;
    return [String(id1), String(id2)].sort().join(':');
  }

  /**
   * Returns chat history array between two players.
   * @param {Player|string} player1
   * @param {Player|string} player2
   * @returns {Array<Object>}
   */
  getChatHistory(player1, player2) {
    if (!this.chatHistory) this.chatHistory = {};
    const key = this.getChatKey(player1, player2);
    if (!this.chatHistory[key]) {
      this.chatHistory[key] = [];
    }
    return this.chatHistory[key];
  }

  /**
   * Appends a chat message to history between sender and receiver.
   * @param {Player|string} sender
   * @param {Player|string} receiver
   * @param {string} content
   * @returns {Object} Added message object
   */
  addChatMessage(sender, receiver, content) {
    if (!this.chatHistory) this.chatHistory = {};
    const senderName = typeof sender === 'string' ? sender : sender.name;
    const key = this.getChatKey(sender, receiver);
    if (!this.chatHistory[key]) {
      this.chatHistory[key] = [];
    }
    const message = {
      sender: senderName,
      content: content,
      round: this.currentRound,
      timestamp: new Date().toISOString()
    };
    this.chatHistory[key].push(message);
    return message;
  }

  /**
   * Returns the currently active Player instance.
   * @returns {Player|null}
   */
  get activePlayer() {
    if (!this.players || this.players.length === 0 || this.activePlayerIndex < 0) return null;
    return this.players[this.activePlayerIndex];
  }

  /**
   * Generates a hexagonal map of a given radius filled with terrain.
   * @param {number} radius - Grid radius (number of hex rings from the center)
   * @param {Array|Object} [terrainConfig=null] - Optional terrain definitions
   * @param {Object} [manifestData=null] - Optional manifest (spawns natural resources & treasures)
   */
  generateMap(radius, terrainConfig = null, manifestData = null) {
    const config = terrainConfig || this.manifestData?.terrains || null;
    this.hexGrid = new HexGrid(radius, config);
    if (manifestData) {
      spawnCellResources(this.hexGrid, manifestData, CONFIG.HEX_SIZE);
    }
    this.entities = [];
    this.activePlayerIndex = 0;
    this.currentRound = 1;
    this.chatHistory = {};

    // Default placeholder players if manifest not initialized yet
    this.players = [];
  }

  /**
   * Initializes player starting resources, instantiates players defined in settings/manifest,
   * and spawns starting units on valid terrain.
   * @param {Object} manifestData - Loaded game manifest metadata
   * @param {Object} [settings=null] - Loaded or configured game settings
   */
  initializeManifest(manifestData, settings = null, onTurnEnd) {
    if (!manifestData) return;
    this.manifestData = manifestData;
    this.settings = settings || {};

    // 1. Setup starting resources dynamically from settings or manifest initialization
    const init = settings?.initialization || manifestData.initialization || {};

    // Expose initialization settings on the game state so AI controllers can
    // reason about starting stock levels (resource deficit thresholds, etc.)
    this.initializationSettings = init;
    const startingResources = { ...(init.startingResources || {}) };
    const ordersConfig = init.orders || null;

    // 2. Instantiate players from settings or manifest definitions array
    const playersList = settings?.players || manifestData.players;
    if (playersList && Array.isArray(playersList) && playersList.length > 0) {
      this.players = playersList.map((pDef, idx) => new Player(
        pDef.id || (idx + 1),
        pDef.name,
        this,
        pDef.color,
        startingResources,
        pDef.description || '',
        pDef.controller,
        ordersConfig
      ));
    } else {
      this.players = [];
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
          const dummy = new Entity(uMeta, player, this, null);
          return dummy.canStandOn.bind(dummy);
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

    // Start turn for the initial player. The driver supplies onTurnEnd
    // when it wants AI turns to run and chain (the browser passes its
    // nextTurn); without one, only the synchronous bookkeeping runs.
    this.startTurn(onTurnEnd);
  }

  /**
   * Starts turn for the active player.
   * @param {Function} [onTurnEnd] - Continuation called when an AI
   *   player's turn settles; AI turns run only when it is provided.
   *   AI errors are already logged in Player.step() and swallowed here
   *   so they don't surface as unhandled rejections in the browser.
   */
  startTurn(onTurnEnd) {
    if (this.activePlayer) {
      // step() is async and always returns a promise; AI errors are
      // already logged in Player.step(), so swallow here to keep them
      // from surfacing as unhandled rejections in the browser.
      this.activePlayer.step(onTurnEnd).catch(() => {});
    }
  }

  /**
   * Advances game turn to the next player.
   * If all players have taken a turn, increments currentRound.
   */
  async endTurn(onTurnEnd) {
    if (this.players.length === 0 || this.gameOver) return;
    this.activePlayerIndex = (this.activePlayerIndex + 1) % this.players.length;
    if (this.activePlayerIndex === 0) {
      // Temporarily set to -1 so there is no active player, so event handlers don't try to execute actions
      this.activePlayerIndex = -1;
      await this.onRoundEnd();
      this.activePlayerIndex = 0;
    }
    this.startTurn(onTurnEnd);
    if (this.replayRecorder?.isRecording()) {
      const activePlayerName = this.activePlayer ? this.activePlayer.name : 'Unknown';
      this.replayRecorder.recordSnapshot(this, `Turn started: ${activePlayerName}`);
    }
  }

  /**
   * Checks if any player has met the win conditions.
   * Pure: returns { winner, reasons } or null, and never touches the
   * UI — the browser renders the victory modal from the result, and
   * headless harnesses log it and set gameOver from it. This is the
   * single win check for both drivers; it used to live in main.js
   * (modal-bound) with a duplicated copy in the headless harness.
   */
  checkWinConditions() {
    if (!this.settings?.winCondition) return null;

    // Don't check win conditions before MIN_GAME_ROUNDS
    if (this.currentRound < CONFIG.MIN_GAME_ROUNDS) return null;

    const winCondition = this.settings.winCondition;

    for (const player of this.players) {
      const reasons = [];

      // Check absolute score
      if (winCondition.absoluteScore && player.score.total >= winCondition.absoluteScore) {
        reasons.push(`Absolute Score: ${player.score.total} >= ${winCondition.absoluteScore}`);
      }

      // Check relative score
      if (winCondition.relativeScore) {
        // Find the next highest score among other players
        let nextHighest = 0;
        for (const other of this.players) {
          if (other.id !== player.id && other.score.total > nextHighest) {
            nextHighest = other.score.total;
          }
        }
        const threshold = winCondition.relativeScore * nextHighest;
        if (nextHighest > 0 && player.score.total >= threshold) {
          reasons.push(`Relative Score: ${player.score.total} >= ${winCondition.relativeScore} × ${nextHighest} (next highest)`);
        }
      }

      if (reasons.length > 0) {
        return { winner: player, reasons };
      }
    }

    return null;
  }

  /**
   * 
   */
  async onRoundEnd() {
    if (this.settings?.barbarians) await manageBarbarians(this, this.settings.barbarians);
    this.currentRound++;
    if (this.replayRecorder?.isRecording()) {
      this.replayRecorder.recordSnapshot(this, `Round ${this.currentRound} began`);
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

    const entity = new Entity(meta, owner, this, cell, initialState);
    this.entities.push(entity);

    // Add history entry for entity creation
    if (owner) {
      owner.addHistoryEntry(this.currentRound, {
        category: 'spawn',
        details: `Created ${entity.name} at (${cell.q}, ${cell.r})`,
        extra: {
          entityName: entity.name,
          entityId: entity.id,
          cell: { q: cell.q, r: cell.r }
        }
      });
    }

    return entity;
  }

  /**
   * Removes an entity by ID.
   * @param {string} entityId
   */
  removeEntity(entityId) {
    const entity = this.entities.find(e => e.id === entityId);
    if (entity && entity.owner) {
      entity.owner.addHistoryEntry(this.currentRound, {
        category: 'destroy',
        details: `${entity.name} at (${entity.q}, ${entity.r}) was destroyed`,
        extra: {
          entityName: entity.name,
          entityId: entity.id,
        }
      });
    }
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
   * Returns the entity with the given ID.
   * @param {string} id
   * @returns {BaseEntity|null}
   */
  getEntityById(id) {
    return this.entities.find(e => e.id === id) || null;
  }

  /**
   * Returns true if a human can see this cell
   */
  isVisibleToHuman(cell) {
    // Replay fog POV: when set, only the snapshot's active player's fog counts.
    if (this.fogPovPlayer) return this.fogPovPlayer.isVisible(cell.q, cell.r);
    for (const p of this.players.filter(p => !p.isAI)) {
      if (p.isVisible(cell.q, cell.r)) return true;
    }
    return false;
  }

  /**
   * Returns true if a human has explored this cell
   */
  isExploredByHuman(cell) {
    // Replay fog POV: when set, only the snapshot's active player's fog counts.
    if (this.fogPovPlayer) return this.fogPovPlayer.isExplored(cell.q, cell.r);
    for (const p of this.players.filter(p => !p.isAI)) {
      if (p.isExplored(cell.q, cell.r)) return true;
    }
    return false;
  }

  /**
   * Serializes the game state to JSON string.
   */
  serialize() {
    return JSON.stringify({
      activePlayerIndex: this.activePlayerIndex,
      currentRound: this.currentRound,
      gameOver: this.gameOver,
      players: this.players.map(p => p.toJSON()),
      entities: this.entities.map(e => e.toJSON()),
      cells: this.hexGrid ? this.hexGrid.getCellsObject() : {},
      settings: this.settings,
      chatHistory: this.chatHistory || {}
    });
  }

  /**
   * Deserializes a JSON string to populate the game state.
   * @param {string} jsonString
   */
  deserialize(jsonString) {
    try {
      const data = JSON.parse(jsonString);

      if (data.settings) {
        this.settings = data.settings;
      }

      this.chatHistory = data.chatHistory || {};

      if (data.activePlayerIndex !== undefined) {
        this.activePlayerIndex = data.activePlayerIndex;
      }
      if (data.currentRound !== undefined) {
        this.currentRound = data.currentRound;
      }
      if (data.gameOver !== undefined) {
        this.gameOver = data.gameOver;
      }

      // Re-hydrate Players
      if (data.players) {
        this.players = data.players.map(p => Player.fromJSON(p, this));
      }

      // Re-hydrate Cells into the HexGrid
      if (data.cells) {
        this.hexGrid = HexGrid.fromCells(data.cells);
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
