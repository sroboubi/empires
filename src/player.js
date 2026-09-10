import { animateToTimeOfDay } from "./renderer.js";
import { nextTurn } from "./main.js";
import { processTurn } from "./ai/standard/smartManager.js";
import { processTurn as llmTurn } from "./ai/llm/harness.js";
import { CONFIG } from './config.js';

const turnHours = { start: 7, end: 17 }
const orderToResourceConversionRate = 3;

/**
 * Player class representing a participant in the game.
 * Tracks resources, control type (human vs AI), explored and visible hex cells.
 */
export class Player {
  /**
   * @param {number|string} id
   * @param {string} name
   * @param {string} color
   * @param {Object} [startingResources]
   * @param {string} [description]
   * @param {Object|string|null} [controller]
   * @param {Object} [ordersConfig] - { max, initial, perTurn }
   */
  constructor(id, name, color, startingResources = {}, description = '', controller = null, ordersConfig = null) {
    this.id = id;
    this.name = name;
    this.color = color;
    this.description = description || '';
    this.controller = controller || null;
    this.resources = { ...startingResources };
    this.startCoord = { q: 0, r: 0 };
    this.score = {
      military: 0,
      economic: 0,
      exploration: 0,
      total: 0
    };

    this.ordersConfig = ordersConfig || {};
    this.orders = ordersConfig?.initial ?? ordersConfig?.max ?? 0;
    this.maxOrders = ordersConfig?.max ?? 0;
    this.ordersPerTurn = ordersConfig?.perTurn ?? 0;

    // Fog of war tracking sets (stores coordinate key strings "q,r")
    this.exploredCells = new Set();
    this.visibleCells = new Set();

    // Player history: Map<roundNumber, Array<historyEntry>>
    // Each entry: { round, timestamp, category, entityName, entityId, details }
    this.history = new Map();
  }

  /**
   * True if player is AI controlled.
   * @returns {boolean}
   */
  get isAI() {
    return this.controller !== null && this.controller !== undefined;
  }

  /**
   * Adds a history entry for a specific round.
   * Entries are inserted at the beginning for reverse chronological order (newest first).
   * @param {number} round - Round number
   * @param {Object} entry - History entry object
   * @param {string} entry.category - Category of the event (e.g., 'action', 'damage', 'spawn', 'destroy', 'orders')
   * @param {string} [entry.entityName] - Name of the entity involved
   * @param {string} [entry.entityId] - ID of the entity involved
   * @param {string} entry.details - Description of what happened
   * @param {Object} [entry.extra] - Additional structured data (e.g., attackerId, damage, actionName, etc.)
   */
  addHistoryEntry(round, entry) {
    const timestamp = new Date().toISOString();

    const historyEntry = {
      timestamp,
      category: entry.category,
      entityName: entry.entityName || null,
      entityId: entry.entityId || null,
      details: entry.details,
      extra: entry.extra || {}
    };

    if (!this.history.has(round)) {
      this.history.set(round, []);
    }

    // Insert at beginning for reverse chronological order (newest first)
    this.history.get(round).unshift(historyEntry);
  }

  /**
   * Gets history entries for a specific round.
   * @param {number} [round] - Specific round number, or undefined for all rounds
   * @returns {Array} Array of history entries in reverse chronological order (newest first)
   */
  getHistory(round = null) {
    if (round !== null) {
      return this.history.get(round) || [];
    }

    // Return all entries in reverse round order (newest round first), then reverse chronological within each round
    const allEntries = [];
    const sortedRounds = Array.from(this.history.keys()).sort((a, b) => b - a); // Descending round order
    for (const r of sortedRounds) {
      allEntries.push(...this.history.get(r));
    }
    return allEntries;
  }

  /**
   * Gets history entries for a range of rounds (for pagination).
   * @param {number} startRound - Starting round (inclusive)
   * @param {number} endRound - Ending round (inclusive)
   * @returns {Array} Array of history entries for the round range in reverse chronological order
   */
  getHistoryRange(startRound, endRound) {
    const entries = [];
    // Iterate from endRound down to startRound for reverse chronological order
    for (let r = endRound; r >= startRound; r--) {
      const roundEntries = this.history.get(r) || [];
      entries.push(...roundEntries);
    }
    return entries;
  }

  /**
   * Turn lifecycle step called at the start of this player's turn.
   * Steps all entities owned by this player.
   * @param {GameState} gameState
   */
  step(gameState) {
    if (!gameState || !gameState.entities) return;

    this.refillOrders(gameState);
    this.score = { military: 0, economic: 0 };
    const ownedEntities = this.getEntities(gameState);
    for (const entity of ownedEntities) {
      this.score.military += entity.state.score.military;
      this.score.economic += entity.state.score.economic;
      entity.step(gameState);
    }

    this.updateVisibility(gameState);
    this.score.exploration = Math.round(Math.pow(this.visibleCells.size * this.exploredCells.size, 1 / 3));
    this.score.total = Math.round(Math.pow(this.score.military * this.score.economic * this.score.exploration, 1 / 3));

    if (this.controller) {
      llmTurn(this, gameState).then(() => {
        console.log(`LLM turn processed for player ${this.name}`);
      }).catch(err => {
        console.error(`Error processing turn for LLM player ${this.name}:`, err);
      });

      processTurn(this, gameState).then(() => {
        nextTurn();
      }).catch(err => {
        console.error(`Error processing turn for AI player ${this.name}:`, err);
      });
    }
  }

  /**
   * Calculates resource profile of the player given current upkeep and yields.
   * @param {GameState} gameState
   * @returns {Object} An object with the following properties:
   *  - totalUpkeep: An object with the total upkeep for each resource.
   *  - totalYields: An object with the total yields for each resource.
   *  - netIncome: An object with the net income for each resource (yields - upkeep).
   *  - turnsRemaining: An object with the number of turns remaining for each resource before it runs out (Infinity if net income is non-negative).
   *  - criticalResource: The resource that will run out first.
   */
  getResourceProfile(gameState) {
    const totalUpkeep = {};
    const totalYields = {};
    const netIncome = {};
    const turnsRemaining = {};
    const resourceKeys = new Set(Object.keys(this.resources));

    const myEntities = this.getEntities(gameState);
    for (const entity of myEntities) {
      const maintenance = entity.getCostToMaintain ? entity.getCostToMaintain() : {};
      for (const [res, amt] of Object.entries(maintenance)) {
        resourceKeys.add(res);
        totalUpkeep[res] = (totalUpkeep[res] || 0) + amt;
      }

      if (entity.active) {
        const yields = entity.state?.yields || {};
        for (const [res, amt] of Object.entries(yields)) {
          resourceKeys.add(res);
          totalYields[res] = (totalYields[res] || 0) + amt;
        }
      }
    }

    let criticalResource = null;
    for (const resKey of resourceKeys) {
      if (totalUpkeep[resKey] == undefined) totalUpkeep[resKey] = 0;
      if (totalYields[resKey] == undefined) totalYields[resKey] = 0;
      netIncome[resKey] = totalYields[resKey] - totalUpkeep[resKey];
      turnsRemaining[resKey] = netIncome[resKey] < 0 ? Math.floor((this.resources[resKey] || 0) / -netIncome[resKey]) : Infinity;
      if (turnsRemaining[resKey] < Infinity) {
        if (!criticalResource || turnsRemaining[resKey] < turnsRemaining[criticalResource]) {
          criticalResource = resKey;
        }
      }
    }

    return {
      totalUpkeep,
      totalYields,
      netIncome,
      turnsRemaining,
      criticalResource
    }
  }

  /**
   * Returns all entities owned by this player in the given game state.
   * @param {GameState} gameState
   * @returns {Array<Entity>}
   */
  getEntities(gameState) {
    if (!gameState || !gameState.entities) return [];
    return gameState.entities.filter(e => e.owner && e.owner.id === this.id);
  }

  /**
   * Returns all visible opponents and their owned entities in the given game state. Any entity without an owner is grouped under the null owner.
   * @param {GameState} gameState
   * @returns {Object} Mapping opponent player IDs to { name, score, description, entities }
   */
  getOpponents(gameState) {
    if (!gameState || !gameState.entities) return [];
    const opponentEntities = gameState.entities.filter(e => (!e.owner || e.owner.id !== this.id) && this.visibleCells.has(`${e.q},${e.r}`));
    const opponent = {};
    for (const entity of opponentEntities) {
      const ownerId = entity.owner ? entity.owner.id : null;
      if (!opponent[ownerId]) {
        opponent[ownerId] = {
          name: entity.owner ? entity.owner.name : 'None',
          score: entity.owner ? entity.owner.score : 0,
          description: entity.owner ? entity.owner.description : '',
          entities: []
        };
      }
      opponent[ownerId].entities.push(entity);
    }
    return opponent;
  }

  /**
   * Updates player's visible and explored sets by taking the union of all
   * owned active entities' visible cells. Cells added to visibleCells are also added
   * to exploredCells (which are never removed).
   * @param {GameState} gameState
   */
  updateVisibility(gameState) {
    this.visibleCells.clear();

    if (!gameState || !gameState.entities) return;

    const ownedEntities = this.getEntities(gameState);
    ownedEntities.forEach(entity => {
      // Ensure entity has updated visible cells
      if (entity.visibleCells) {
        entity.visibleCells.forEach(coordKey => {
          this.visibleCells.add(coordKey);
          this.exploredCells.add(coordKey);
        });
      }
    });
  }

  /**
   * Checks if a hex coordinate (q, r) has been explored by this player.
   * @param {number} q
   * @param {number} r
   * @returns {boolean}
   */
  isExplored(q, r) {
    return this.exploredCells.has(`${q},${r}`);
  }

  /**
   * Checks if a hex coordinate (q, r) is currently visible to this player.
   * @param {number} q
   * @param {number} r
   * @returns {boolean}
   */
  isVisible(q, r) {
    return this.visibleCells.has(`${q},${r}`);
  }

  /**
   * Initializes player resources based on starting configuration map.
   * @param {Object} resourceDefaults - Map of resource names to quantities
   */
  setStartingResources(resourceDefaults) {
    this.resources = { ...resourceDefaults };
  }

  /**
   * Checks if player has sufficient resources for a cost map.
   * @param {Object} costMap - Object mapping resource names to required quantities
   * @returns {boolean} True if player can afford the cost
   */
  hasResources(costMap) {
    if (!costMap) return true;
    for (const [resName, qty] of Object.entries(costMap)) {
      const current = this.resources[resName] || 0;
      if (current < qty) {
        return false;
      }
    }
    return true;
  }

  /**
   * Consumes resources if affordable.
   * @param {Object} costMap - Object mapping resource names to required quantities
   * @returns {boolean} True if successfully consumed
   */
  consumeResources(costMap) {
    if (!this.hasResources(costMap)) return false;
    for (const [resName, qty] of Object.entries(costMap)) {
      this.resources[resName] = (this.resources[resName] || 0) - qty;
    }
    return true;
  }

  /**
   * Adds resources to the player's pool.
   * @param {Object} amountMap - Object mapping resource names to quantities to add
   */
  addResources(amountMap) {
    if (!amountMap) return;
    for (const [resName, qty] of Object.entries(amountMap)) {
      this.resources[resName] = (this.resources[resName] || 0) + qty;
    }
  }

  /**
   * Checks if player has enough orders for an action.
   * @param {number} [count=1]
   * @returns {boolean}
   */
  hasOrders(count = 1) {
    return this.orders >= count;
  }

  /**
   * Consumes orders if available.
   * @param {number} [count=1]
   * @returns {boolean}
   */
  consumeOrders(count = 1) {
    if (!this.hasOrders(count)) return false;
    this.orders -= count;
    this.setOrdersTimeOfDay(1);
    return true;
  }

  /**
   * Adds per-turn orders up to the maximum.
   */
  refillOrders(gameState) {
    let orderBonus = 0;
    this.getEntities(gameState).forEach(entity => {
      orderBonus += entity.state?.ordersPerTurn || 0;
    });
    this.maxOrders = this.ordersConfig.max + orderBonus;
    this.ordersPerTurn = this.ordersConfig.perTurn + orderBonus;
    const overflow = this.orders + this.ordersPerTurn - this.maxOrders;
    console.debug(`Player ${this.name} - orders before refill: ${this.orders}, ordersPerTurn: ${this.ordersPerTurn}, maxOrders: ${this.maxOrders}, overflow: ${overflow}`);
    if (overflow > 0) {
      this.orders = this.maxOrders;
      const resourceProfile = this.getResourceProfile(gameState);
      console.debug(`Player ${this.name} - overflow of ${overflow} orders, converting to resources. Resource profile:`, resourceProfile);
      let pickedResource = resourceProfile.criticalResource;
      if (!pickedResource) {  // if nothing is critical, pick a random resource to convert overflow into
        const resourceNames = Object.keys(this.resources);
        pickedResource = resourceNames[Math.floor(Math.random() * resourceNames.length)];
      }
      if (pickedResource) {
        const amount = overflow * orderToResourceConversionRate;
        this.resources[pickedResource] = (this.resources[pickedResource] || 0) + amount;
        console.debug(`Player ${this.name} - converting ${overflow} excess orders to ${amount} ${pickedResource}`);

        // Add history entry for orders conversion
        this.addHistoryEntry(gameState.currentRound, {
          category: 'orders',
          details: `Converted ${overflow} excess orders to ${amount} ${pickedResource}`,
          extra: {
            overflowOrders: overflow,
            resource: pickedResource,
            amount: amount
          }
        });
      }
    } else {
      this.orders += this.ordersPerTurn;
    }
    this.setOrdersTimeOfDay(2);
  }

  /**
   * Changes the time of day based on the number of orders remaining.
   * @param {number} [duration=1] - Duration of the animation in seconds
   */
  setOrdersTimeOfDay(duration = 1) {
    const orderFraction = this.orders / this.maxOrders;
    const timeOfDay = turnHours.end - (turnHours.end - turnHours.start) * orderFraction;
    animateToTimeOfDay(timeOfDay, duration);
  }

  /**
   * Serializes player state.
   */
  toJSON() {
    // Serialize history map to array of [round, entries] pairs
    const historyArray = Array.from(this.history.entries()).map(([round, entries]) => [round, entries]);

    return {
      id: this.id,
      name: this.name,
      color: this.color,
      description: this.description,
      controller: this.controller,
      resources: this.resources,
      orders: this.orders,
      maxOrders: this.maxOrders,
      ordersPerTurn: this.ordersPerTurn,
      ordersConfig: this.ordersConfig,
      startCoord: this.startCoord,
      score: this.score,
      exploredCells: Array.from(this.exploredCells),
      visibleCells: Array.from(this.visibleCells),
      history: historyArray
    };
  }

  /**
   * Re-hydrates a Player instance from serialized JSON object.
   */
  static fromJSON(data) {
    const player = new Player(data.id, data.name, data.color, data.resources, data.description, data.controller, data.ordersConfig);
    player.maxOrders = data.maxOrders ?? 0;
    player.ordersPerTurn = data.ordersPerTurn ?? 0;
    player.orders = data.orders ?? 0;
    if (data.startCoord) {
      player.startCoord = { ...data.startCoord };
    }
    if (data.score) {
      player.score = { ...data.score };
    }
    if (data.exploredCells && Array.isArray(data.exploredCells)) {
      player.exploredCells = new Set(data.exploredCells);
    }
    if (data.visibleCells && Array.isArray(data.visibleCells)) {
      player.visibleCells = new Set(data.visibleCells);
    }
    if (data.history && Array.isArray(data.history)) {
      player.history = new Map(data.history);
    }
    return player;
  }
}
