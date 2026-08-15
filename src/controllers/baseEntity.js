import { SeaLevel } from '../terrainProvider.js';
import { camelToTitle } from '../utils.js';
import { HexGrid } from '../hexGrid.js';

/**
 * BaseEntity - Standard Base Class for all dynamic entity instances in the game.
 * Controller instances ARE the entity objects.
 */
export class BaseEntity {
  /**
   * @param {Object} entityData - Static metadata from manifest
   * @param {Player|null} ownerPlayer - Owning Player instance
   * @param {GameState} gameState - GameState reference
   * @param {Object} [cell] - The hex cell object this entity stands on
   * @param {Object} [initialState] - Optional state override (e.g. deserialization)
   */
  constructor(entityData, ownerPlayer, gameState, cell = null, initialState = null) {
    this.data = entityData || {};
    this.owner = ownerPlayer || null;
    this.gameState = gameState;
    this.cell = cell;
    this.q = cell ? cell.q : (initialState ? initialState.q : 0);
    this.r = cell ? cell.r : (initialState ? initialState.r : 0);

    this.id = (initialState && initialState.id) || `${this.data.name || 'entity'}_${this.owner ? this.owner.id : 'neutral'}_${Math.random().toString(36).substr(2, 9)}`;
    this.name = this.data.name || 'entity';

    // 1. Dynamic state via JS spread notation: defaults -> manifest data -> initialState
    this.state = {
      ...this.getDefaults(),
      ...(entityData || {}),
      ...(initialState || {})
    };

    // Actions list defined on BaseEntity instance
    this.actions = [];
    this.setupActions();

    // Visible cells set tracked by entity
    this.visibleCells = new Set();

    // Initial vision update
    if (this.gameState && this.gameState.hexGrid) {
      this.updateVisibility();
    }
  }

  /**
   * Class level default attributes overrideable by manifest and initialState via spread.
   * @returns {Object}
   */
  getDefaults() {
    return {
      health: 100,
      maxHealth: 100,
      active: true,
      facing: 'E',
      sightRange: 2,
      rotationOffset: 0,
      armor: {},
      maintenance: {},
      spawnCost: {},
      yields: {}
    };
  }

  get health() {
    return this.state.health;
  }

  set health(val) {
    this.state.health = val;
  }

  get maxHealth() {
    return this.state.maxHealth || 100;
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

  get sightRange() {
    return this.state.sightRange !== undefined ? this.state.sightRange : 2;
  }

  get rotationOffset() {
    return this.state.rotationOffset || 0;
  }

  /**
   * Returns object e.g. {food: 2, wood: 3} with maintenance cost deducted on each step().
   * @returns {Object}
   */
  getCostToMaintain() {
    return { ...(this.state.maintenance || {}) };
  }

  /**
   * Returns object e.g. {food: 20, gold: 10} with cost to create the entity.
   * @returns {Object}
   */
  getCostToSpawn() {
    return { ...(this.state.spawnCost || {}) };
  }

  /**
   * Orders consumed per action.
   * @returns {number}
   */
  getOrdersRequired() {
    return 1;
  }

  /**
   * Checks whether the entity can afford an action, including orders.
   * @param {number} [apCost=0] - Action points required; skipped when entity has no AP.
   * @returns {{possible: boolean, reason?: string, ordersRequired?: number}}
   */
  checkActionAffordability(apCost = 0) {
    if (apCost > 0 && this.state.actionPoints !== undefined) {
      const currentAP = this.state.actionPoints;
      if (currentAP < apCost) {
        return { possible: false, reason: `Insufficient Action Points (${currentAP}/${apCost} AP required).` };
      }
    }

    const ordersRequired = this.getOrdersRequired();
    if (!this.owner) {
      return { possible: false, reason: "No owner to issue orders." };
    }
    if (!this.owner.hasOrders(ordersRequired)) {
      return { possible: false, reason: `Insufficient Orders (${this.owner.orders}/${ordersRequired} required).` };
    }

    return { possible: true, ordersRequired };
  }

  /**
   * Spends action points and orders for a completed action.
   * @param {number} [apCost=0]
   * @param {number} [ordersRequired=1]
   */
  spendActionCost(apCost = 0, ordersRequired = 1) {
    if (apCost > 0 && this.state.actionPoints !== undefined) {
      this.state.actionPoints -= apCost;
    }
    if (ordersRequired > 0 && this.owner) {
      this.owner.consumeOrders(ordersRequired);
    }
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
   * Calculates visible cells from current cell and updates owner's visibility list.
   */
  updateVisibility() {
    this.visibleCells.clear();
    const currentCell = this.cell || (this.gameState && this.gameState.hexGrid ? this.gameState.hexGrid.getCell(this.q, this.r) : null);

    if (currentCell && this.gameState && this.gameState.hexGrid) {
      const visList = this.gameState.hexGrid.visibleCells(currentCell, this.sightRange);
      visList.forEach(c => this.visibleCells.add(`${c.q},${c.r}`));
    }

    if (this.owner) {
      this.owner.updateVisibility(this.gameState);
    }
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

    const yields = this.state.yields;
    if (this.active && this.owner && yields) {
      this.owner.addResources(yields);
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

    const armor = this.state.armor[damageType] || 1;
    let effectiveDamage = rawValue / armor;

    // Round to 1 decimal place for clean stats
    effectiveDamage = Math.round(effectiveDamage * 10) / 10;

    this.state.health -= effectiveDamage;
    const destroyed = this.state.health <= 0;

    if (destroyed) {
      this.visibleCells.clear();
      if (this.owner && this.gameState) {
        this.owner.updateVisibility(this.gameState);
      }
      if (this.gameState) {
        this.gameState.removeEntity(this.id);
      }
    }

    return { damageDealt: effectiveDamage, destroyed };
  }

  /**
   * Returns list of available action objects for this entity.
   * Parameterless — returns this.actions array defined on BaseEntity.
   * @returns {Array<Object>} List of candidate action objects
   */
  getActions() {
    return this.actions;
  }

  setupActions() {
    if (this.state.repairables && this.state.repairables.length > 0) {
      this.actions.push({
        name: "Repair",
        description: "Repair an adjacent entity, consuming all AP to restore HP.",
        canDo: (cell, target) => {
          if (!target) return { possible: false, reason: "No target to repair." };
          if (!this.active) return { possible: false, reason: "Entity is inactive." };
          if (this.actionPoints <= 0) return { possible: false, reason: "Entity has no Action Points left." };
          if (!this.state.repairables.includes(target.name.toLowerCase())) return { possible: false, reason: "Target is not repairable by this entity." };
          if (target.health >= target.maxHealth) return { possible: false, reason: "Target is already at full health." };
          const dist = HexGrid.distance(this, cell || target);
          if (dist !== 1) return { possible: false, reason: "Target must be adjacent (1 cell away)." };
          const cost = this.actionPoints;
          const affordability = this.checkActionAffordability(cost);
          if (!affordability.possible) return affordability;
          const healAmount = 2 * cost;
          return {
            possible: true,
            reason: `Repair ${target.name.toUpperCase()} for +${healAmount} HP consuming all ${cost} AP and 1 order.`,
            cost: cost,
            ordersRequired: affordability.ordersRequired,
            healAmount: healAmount
          };
        },
        do: (cell, target) => {
          const actionObj = this.actions.find(a => a.name === "Repair");
          const check = actionObj.canDo(cell, target);
          if (!check.possible) return false;
          this.spendActionCost(check.cost, check.ordersRequired);
          target.health = Math.min(target.maxHealth, target.health + check.healAmount);
          return true;
        }
      });
    }

    for (const buildable of this.state.buildables || []) {
      const targetName = camelToTitle(buildable);
      const actionName = `Build ${targetName}`;
      this.actions.push({
        name: actionName,
        canDo: (cell, entity) => {
          if (!this.active) return { possible: false, reason: "Worker is inactive." };
          if (!cell) return { possible: false, reason: "No target cell selected." };
          if (entity && entity !== this) return { possible: false, reason: "Target cell is occupied." };

          if (!this.canStandOn(cell)) return { possible: false, reason: "Cannot build construct on water." };  // FIXME

          const dist = HexGrid.distance(this, cell);
          if (dist !== 1) return { possible: false, reason: "target must be adjacent (1 cell away)." };

          const apCost = this.state.actionPoints !== undefined ? 1 : 0;
          const affordability = this.checkActionAffordability(apCost);
          if (!affordability.possible) return affordability;

          const meta = this.gameState && this.gameState.manifestData ? this.gameState.manifestData.entities[buildable] : null;
          const cost = (meta && meta.spawnCost) || {};
          const costStr = Object.entries(cost).map(([k, v]) => `${v} ${k}`).join(', ');
          if (this.owner && !this.owner.hasResources(cost)) {
            return { possible: false, reason: `Insufficient resources to build ${targetName} (${costStr} required).` };
          }
          const apStr = apCost > 0 ? ', 1 AP' : '';
          return {
            possible: true,
            reason: `Build ${targetName} on (${cell.q}, ${cell.r}) costing ${costStr}${apStr} and 1 order.`,
            cost: cost,
            apCost: apCost,
            ordersRequired: affordability.ordersRequired
          };
        },
        do: (cell, entity) => {
          const actionObj = this.actions.find(a => a.name === actionName);
          const check = actionObj.canDo(cell, entity);
          if (!check.possible) return false;
          if (this.owner) {
            this.owner.consumeResources(check.cost);
          }
          this.spendActionCost(check.apCost, check.ordersRequired);
          if (this.gameState) {
            this.gameState.spawnEntity(buildable, cell, this.owner);
            if (this.state.destroyOnBuild) {
              this.gameState.removeEntity(this.id);
            }
          }
          return true;
        }
      });
    }
  }

  /**
   * Descriptive summary for inspect panel UI.
   */
  info() {
    const ownerName = this.owner ? this.owner.name : 'Neutral';
    const activeStr = this.active ? 'ACTIVE' : 'INACTIVE (No Maintenance)';
    let yieldStr = '';
    if (this.state.yields) {
      yieldStr = Object.entries(this.state.yields).map(([k, v]) => `+${v} ${k}`).join(', ');
    }
    return `${camelToTitle(this.name)}. Owner: ${ownerName}. HP: ${Math.max(0, Math.round(this.state.health))}/${this.maxHealth}. Status: ${activeStr}.${yieldStr ? ` Income/turn: ${yieldStr}` : ''}`;
  }

  /**
   * Serializes entity to JSON-friendly data object.
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      ownerId: this.owner ? this.owner.id : null,
      q: this.q,
      r: this.r,
      state: this.state
    };
  }
}