import { animateToTimeOfDay } from "./renderer.js";

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
      economic: 0
    };

    this.maxOrders = ordersConfig?.max ?? 0;
    this.ordersPerTurn = ordersConfig?.perTurn ?? 0;
    this.orders = ordersConfig?.initial ?? this.maxOrders;

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

    this.refillOrders();
    this.score = { military: 0, economic: 0 };
    const ownedEntities = gameState.entities.filter(e => e.owner && e.owner.id === this.id);
    for (const entity of ownedEntities) {
      this.score.military += entity.state.score.military;
      this.score.economic += entity.state.score.economic;
      try {
        entity.step({ gameState });
      } catch (err) {
        console.error(`Error stepping entity ${entity.name} during turn step:`, err);
      }
    }

    this.updateVisibility(gameState);
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

    const ownedEntities = gameState.entities.filter(e => e.owner && e.owner.id === this.id);
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
    this.setTimeOfDay(1);
    return true;
  }

  /**
   * Adds per-turn orders up to the maximum.
   */
  refillOrders() {
    if (this.maxOrders <= 0) return;
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
      startCoord: this.startCoord,
      exploredCells: Array.from(this.exploredCells),
      visibleCells: Array.from(this.visibleCells)
    };
  }

  /**
   * Re-hydrates a Player instance from serialized JSON object.
   */
  static fromJSON(data) {
    const ordersConfig = {
      max: data.maxOrders ?? 0,
      initial: data.orders ?? 0,
      perTurn: data.ordersPerTurn ?? 0
    };
    const player = new Player(data.id, data.name, data.color, data.resources, data.description, data.controller, ordersConfig);
    if (data.startCoord) {
      player.startCoord = { ...data.startCoord };
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
