/**
 * Player class representing a participant in the game.
 * Resource types are dynamic and based on manifest configuration.
 */
export class Player {
  constructor(id, name, color, startingResources = {}) {
    this.id = id;
    this.name = name;
    this.color = color;
    this.resources = { ...startingResources };
    this.startCoord = { q: 0, r: 0 };
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
   * Serializes player state.
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      color: this.color,
      resources: this.resources,
      startCoord: this.startCoord
    };
  }

  /**
   * Re-hydrates a Player instance from serialized JSON object.
   */
  static fromJSON(data) {
    const player = new Player(data.id, data.name, data.color, data.resources);
    if (data.startCoord) {
      player.startCoord = { ...data.startCoord };
    }
    return player;
  }
}
