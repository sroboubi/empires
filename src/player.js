import { animateToTimeOfDay } from "./renderer.js";
import { nextTurn } from "./main.js";
import { processTurn } from "./ai/standard/smartManager.js";
import { CONFIG } from './config.js';

const turnHours = { start: 7, end: 17 }

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
  }

  /**
   * True if player is AI controlled.
   * @returns {boolean}
   */
  get isAI() {
    return this.controller !== null && this.controller !== undefined;
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

    console.debug("Player score recalc", this.score);

    if (this.controller) {
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
   */
  getResourceProfile(gameState) {
    const totalUpkeep = {};
    const totalYields = {};
    const netIncome = {};
    const resourceKeys = new Set();

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

    for (const resKey of resourceKeys) {
      if (totalUpkeep[resKey] == undefined) totalUpkeep[resKey] = 0;
      if (totalYields[resKey] == undefined) totalYields[resKey] = 0;
      netIncome[resKey] = totalYields[resKey] - totalUpkeep[resKey];
    }

    return {
      totalUpkeep,
      totalYields,
      netIncome,
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
    return (!this.isAI && CONFIG.SHOW_ALL) || this.exploredCells.has(`${q},${r}`);
  }

  /**
   * Checks if a hex coordinate (q, r) is currently visible to this player.
   * @param {number} q
   * @param {number} r
   * @returns {boolean}
   */
  isVisible(q, r) {
    return (!this.isAI && CONFIG.SHOW_ALL) || this.visibleCells.has(`${q},${r}`);
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
    this.setTimeOfDay(1);
    return true;
  }

  /**
   * Adds per-turn orders up to the maximum.
   */
  refillOrders(gameState) {
    let orderBonus = 0;
    this.getEntities(gameState).forEach(entity => {
      orderBonus += entity.state?.yields?.orders || 0;
    });
    this.maxOrders = this.ordersConfig.max + orderBonus;
    this.ordersPerTurn = this.ordersConfig.perTurn + orderBonus;
    this.orders = Math.min(this.maxOrders, this.orders + this.ordersPerTurn);
    this.setTimeOfDay(2);
  }

  /**
   * Changes the time of day based on the number of orders remaining.
   * @param {number} [duration=1] - Duration of the animation in seconds
   */
  setTimeOfDay(duration = 1) {
    const orderFraction = this.orders / this.maxOrders;
    const timeOfDay = turnHours.end - (turnHours.end - turnHours.start) * orderFraction;
    animateToTimeOfDay(timeOfDay, duration);
  }

  /**
   * Serializes player state.
   */
  toJSON() {
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
      visibleCells: Array.from(this.visibleCells)
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
    return player;
  }
}
