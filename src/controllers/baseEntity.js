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

    // Dynamic runtime state (health, active, facing, etc.)
    this.state = initialState ? { ...initialState } : {
      health: this.data.health || this.data.maxHealth || 100,
      maxHealth: this.data.maxHealth || 100,
      active: true,
      facing: 'E'
    };

    if (this.state.active === undefined) this.state.active = true;
    if (this.state.facing === undefined) this.state.facing = 'E';
    if (this.state.health === undefined) this.state.health = this.data.health || this.data.maxHealth || 100;
    if (this.state.maxHealth === undefined) this.state.maxHealth = this.data.maxHealth || 100;
  }

  get health() {
    return this.state.health;
  }

  set health(val) {
    this.state.health = val;
  }

  get maxHealth() {
    return this.state.maxHealth;
  }

  get active() {
    return this.state.active !== false;
  }

  set active(val) {
    this.state.active = !!val;
  }

  get facing() {
    return this.state.facing || 'E';
  }

  set facing(val) {
    this.state.facing = val;
  }

  /**
   * Returns object e.g. {food: 2, wood: 3} with maintenance cost deducted on each step().
   * @returns {Object}
   */
  getCostToMaintain() {
    return { ...(this.data.maintenance || {}) };
  }

  /**
   * Returns object e.g. {food: 20, gold: 10} with cost to create the entity.
   * @returns {Object}
   */
  getCostToSpawn() {
    return { ...(this.data.spawnCost || {}) };
  }

  /**
   * Determines if entity can stand on a given terrain or cell.
   * Standard condition: terrain elevation is above SeaLevel.
   * @param {Object} target - Cell object or Terrain object
   * @returns {boolean}
   */
  canStandOn(target) {
    if (!target) return false;
    const terrain = target.terrain ? target.terrain : target;
    if (!terrain) return false;
    return terrain.elevation > SeaLevel;
  }

  /**
   * Lifecycle Hook called at turn start / game loop step.
   * Deducts maintenance costs. Set active to false if maintenance resources not met.
   * @param {Object} globalContext
   */
  step(globalContext) {
    const cost = this.getCostToMaintain();
    const hasCost = Object.keys(cost).length > 0;

    if (hasCost && this.owner) {
      if (this.owner.hasResources(cost)) {
        this.owner.consumeResources(cost);
        this.active = true;
      } else {
        this.active = false;
      }
    } else {
      this.active = true;
    }
  }

  /**
   * Processes incoming damage to this entity.
   * @param {Object|number} damage - Damage payload { value, type, source } or raw amount
   * @param {BaseEntity} [attacker] - Attacking entity reference if damage is number
   * @returns {Object} { damageDealt, destroyed }
   */
  receiveDamage(damage, attacker = null) {
    let rawValue = 0;
    let damageType = 'blunt';

    if (typeof damage === 'number') {
      rawValue = damage;
    } else if (damage && typeof damage === 'object') {
      rawValue = damage.value || 0;
      damageType = damage.type || 'blunt';
    }

    let effectiveDamage = rawValue;
    const armor = this.state.armor || this.data.armor;

    if (armor && typeof armor === 'object') {
      if (armor.type === damageType && armor.value > 0) {
        effectiveDamage = rawValue / armor.value;
      } else {
        effectiveDamage = rawValue;
      }
    } else if (typeof armor === 'number') {
      effectiveDamage = Math.max(1, rawValue - armor);
    }

    // Round to 1 decimal place for clean stats
    effectiveDamage = Math.round(effectiveDamage * 10) / 10;

    this.state.health -= effectiveDamage;
    const destroyed = this.state.health <= 0;

    if (destroyed && this.grid) {
      this.grid.removeEntity(this.id);
    }

    return { damageDealt: effectiveDamage, destroyed };
  }

  /**
   * Evaluates and returns possible actions for a given target cell and/or target entity.
   * Each action object contains: { name, description, canDo(targetCell, targetEntity), do(targetCell, targetEntity) }
   * @param {Object} [targetCell] - Target cell clicked by user
   * @param {BaseEntity} [targetEntity] - Target entity standing on target cell
   * @returns {Array<Object>} List of candidate action objects
   */
  getActions(targetCell, targetEntity) {
    return [];
  }

  /**
   * Compatibility wrapper to execute action by name.
   * @param {string} actionName
   * @param {Object} [targetCell]
   * @param {BaseEntity} [targetEntity]
   * @returns {Object} { success: boolean, message: string }
   */
  doAction(actionName, targetCell, targetEntity) {
    const actions = this.getActions(targetCell, targetEntity);
    const action = actions.find(a => a.name === actionName);
    if (!action) {
      return { success: false, message: `Action "${actionName}" not available.` };
    }

    const check = action.canDo(targetCell, targetEntity);
    if (!check.possible) {
      return { success: false, message: check.reason || 'Action cannot be performed.' };
    }

    const result = action.do(targetCell, targetEntity);
    return {
      success: result,
      message: result ? `Executed ${action.name}.` : `Failed to execute ${action.name}.`
    };
  }

  /**
   * Descriptive summary for inspect panel UI.
   */
  info() {
    const ownerName = this.owner ? this.owner.name : 'Neutral';
    const activeStr = this.active ? 'ACTIVE' : 'INACTIVE (No Maintenance)';
    return `${this.name.toUpperCase()} (${this.category}). Owner: ${ownerName}. HP: ${Math.max(0, Math.round(this.state.health))}/${this.state.maxHealth}. Status: ${activeStr}. Facing: ${this.facing}`;
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