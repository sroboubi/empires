import { SeaLevel } from '../terrainProvider.js';

/**
 * BaseEntity - Standard Base Class for all dynamic entity instances in the game.
 * Controller instances ARE the entity objects.
 */
export class BaseEntity {
  /**
   * @param {Object} entityData - Static metadata from manifest
   * @param {Player|null} ownerPlayer - Owning Player instance
   * @param {GameState} gridProxy - GameState / Grid reference
   * @param {Object} [cell] - The hex cell object this entity stands on
   * @param {Object} [initialState] - Optional state override (e.g. deserialization)
   */
  constructor(entityData, ownerPlayer, gridProxy, cell = null, initialState = null) {
    this.data = entityData || {};
    this.owner = ownerPlayer || null;
    this.grid = gridProxy;
    this.cell = cell;
    this.q = cell ? cell.q : (initialState ? initialState.q : 0);
    this.r = cell ? cell.r : (initialState ? initialState.r : 0);

    this.id = (initialState && initialState.id) || `${this.data.name || 'entity'}_${this.owner ? this.owner.id : 'neutral'}_${Math.random().toString(36).substr(2, 9)}`;
    this.name = this.data.name || 'entity';
    this.category = this.data.category || 'unit';

    // Dynamic runtime state (health, etc.)
    this.state = initialState ? { ...initialState } : {
      health: this.data.maxHealth || 100,
      maxHealth: this.data.maxHealth || 100
    };
  }

  /**
   * Determines if entity can stand on a given terrain.
   * Standard condition: terrain elevation is above SeaLevel.
   * @param {Object} terrain - Cell terrain object
   * @returns {boolean}
   */
  canStandOn(terrain) {
    if (!terrain) return false;
    return terrain.elevation > SeaLevel;
  }

  /**
   * Lifecycle Hook called at turn start / game loop step.
   * @param {Object} globalContext
   */
  step(globalContext) {
    // Overridden by subclasses
  }

  /**
   * Processes incoming damage to this entity.
   * @param {number} amount - Raw damage
   * @param {BaseEntity} attacker - Attacking entity reference
   * @returns {Object} { damageDealt, destroyed }
   */
  receiveDamage(amount, attacker) {
    const armor = this.state.armor || 0;
    const effectiveDamage = Math.max(1, amount - armor);
    this.state.health -= effectiveDamage;
    const destroyed = this.state.health <= 0;

    if (destroyed && this.grid) {
      this.grid.removeEntity(this.id);
    }

    return { damageDealt: effectiveDamage, destroyed };
  }

  /**
   * Evaluates and returns possible actions for a given target cell and/or target entity.
   * Applies to all entities. Subclasses extend or override.
   * @param {Object} [targetCell] - Target cell clicked by user
   * @param {BaseEntity} [targetEntity] - Target entity standing on target cell
   * @returns {Array<Object>} List of candidate action objects: { name, description, preview }
   */
  getActions(targetCell, targetEntity) {
    return [];
  }

  /**
   * Executes a named action on target cell/entity after validation.
   * Applies to all entities. Subclasses extend or override.
   * @param {string} actionName - Name of the action to execute
   * @param {Object} [targetCell] - Target cell
   * @param {BaseEntity} [targetEntity] - Target entity
   * @returns {Object} { success: boolean, message: string }
   */
  doAction(actionName, targetCell, targetEntity) {
    return { success: false, message: `Action "${actionName}" not supported by this entity.` };
  }

  /**
   * Descriptive summary for inspect panel UI.
   */
  info() {
    const ownerName = this.owner ? this.owner.name : 'Neutral';
    return `${this.name.toUpperCase()} (${this.category}). Owner: ${ownerName}. HP: ${this.state.health}/${this.state.maxHealth}`;
  }

  /**
   * Serializes entity to JSON-friendly data object.
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      category: this.category,
      ownerId: this.owner ? this.owner.id : null,
      q: this.q,
      r: this.r,
      state: this.state
    };
  }
}