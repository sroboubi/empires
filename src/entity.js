import { SeaLevel } from './terrainProvider.js';
import { camelToTitle, calculateAttackMultiplier, showToast, displayNum } from './utils.js';
import { HexGrid } from './hexGrid.js';
import { spawnDamageText, spawnParticleBurst } from './renderer.js';
import { audio } from './audio.js';
import { applyResourceYieldBonus, checkTreasurePickup } from './resources.js';
import { CONFIG } from './config.js';

/**
 * Entity - Single statically loaded, data-driven class for all game entities
 * (units, stationary constructs, buildings, etc.).
 *
 * Behavior is determined by data attributes:
 * - isConstruct: true if it has no movement object in its definition
 * - Move / Face Direction actions: added if movement is defined
 * - Attack action: added if positive damage is defined
 * - Repair action: added if repairables is defined
 * - Build actions: added for each entry in buildables
 */
export default class Entity {
  /**
   * @param {Object} entityData - Static metadata from definitions/entities.json
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
    this.age = 0; // turns

    // Dynamic state via JS spread notation: defaults -> entityData -> initialState
    this.state = {
      ...this.getDefaults(),
      ...(entityData || {}),
      ...(initialState || {})
    };

    // Actions list defined on Entity instance
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
      maxActionPoints: 0,
      actionPoints: 0,
      facing: 'E',
      sightRange: 2,
      rotationOffset: 0,
      armor: {},
      maintenance: {},
      spawnCost: {},
      yields: {},
      attackCostScale: 1.0,
      damage: { value: 0, type: 'blunt' },
      range: null,
      battleExhaustion: 1,
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

  get actionPoints() {
    return this.state.actionPoints;
  }

  set actionPoints(val) {
    this.state.actionPoints = val;
  }

  get maxActionPoints() {
    return this.state.maxActionPoints;
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

  get armor() {
    return this.state.armor || {};
  }

  get rotationOffset() {
    return this.state.rotationOffset || 0;
  }

  get attackCostScale() {
    return this.state.attackCostScale !== undefined ? this.state.attackCostScale : 1.0;
  }

  get damage() {
    return this.state.damage || { value: 0, type: 'blunt' };
  }

  get range() {
    return this.state.range || null;
  }

  /**
   * Data-driven construct property:
   * isConstruct if it can't move (has no movement object in the entity definition).
   * @returns {boolean}
   */
  get isConstruct() {
    return !this.state.movement;
  }

  /**
   * Returns the entity's per-terrain movement cost scale map, or null if none.
   * e.g. { Desert: 1.5, Tundra: 0.8, ShallowWater: 1e1000 }
   * @returns {Object|null}
   */
  get terrainCostScale() {
    return this.state.movement?.terrainCostScale;
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

  get baseYields() {
    return { ...(this.state.yields || {}) };
  }

  get yields() {
    return applyResourceYieldBonus(this, this.baseYields, this.gameState);
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
        return { possible: false, reason: `Insufficient Action Points (${displayNum(currentAP)}/${displayNum(apCost)} AP required).` };
      }
    }

    const ordersRequired = this.getOrdersRequired();
    if (!this.owner) {
      return { possible: true, ordersRequired: 0 };
    }
    if (!this.owner.hasOrders(ordersRequired)) {
      return { possible: false, reason: `Insufficient Orders (${displayNum(this.owner.orders)}/${displayNum(ordersRequired)} required).` };
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
    if (this.isConstruct) {
      // if no conditions defined, can be placed anywhere
      if (!this.state.spawnConditions?.terrain) return true;
      return this.state.spawnConditions.terrain.some(t => t.toLowerCase() === terrain.name?.toLowerCase());
    }
    return Number.isFinite(this.getMovementCost(target));
  }

  /**
   * Gets the movement cost for a given cell.
   * @param {Object} target - Cell object or Terrain object
   * @returns {number}
   */
  getMovementCost(target) {
    if (!target || this.isConstruct) return Infinity;
    const terrain = target.terrain ? target.terrain : target;
    const scale = (this.terrainCostScale && terrain.name in this.terrainCostScale) ? this.terrainCostScale[terrain.name] : 1;
    return (terrain.movementCost || 1) * scale;
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
   */
  step() {
    const cost = this.getCostToMaintain();
    const hasCost = Object.keys(cost).length > 0;

    if (hasCost && this.owner) {
      if (this.owner.hasResources(cost)) {
        this.owner.consumeResources(cost);
        this.active = true;
      } else {
        console.debug(this.owner.name, this.id, "Insufficient resources to maintain entity.", this.owner.resources, cost);
        this.active = false;
        this.owner.addHistoryEntry(this.gameState.currentRound, {
          category: 'inactivated',
          details: `${this.name} at (${this.q}, ${this.r}) inactivated due to lack of resources to maintain`,
          extra: {
            entityName: this.name,
            entityId: this.id,
            resources: { ...this.owner.resources },
            cost: cost
          }
        });
      }
    } else {
      this.active = true;
    }

    // only give yields if not damaged
    if (this.active && this.owner && this.baseYields && this.health > this.maxHealth * 0.95) {
      this.owner.addResources(this.yields);
    }

    this.age++;

    if (this.active) {
      const unusedAP = Math.max(0, this.state.actionPoints);
      if (unusedAP > 0 && this.state.healthRegenScale > 0) {
        this.health = Math.min(this.maxHealth, this.health + this.state.healthRegenScale * unusedAP);
      }
      this.state.actionPoints = this.maxActionPoints;
    }

    this.state.battleExhaustion = 1;
  }

  /**
   * Destroys the entity and cleans up all references.
   */
  destroy() {
    this.destroyed = true;
    audio.playEntitySfx(this, 'destroy');
    this.visibleCells.clear();
    if (this.owner && this.gameState) {
      this.owner.updateVisibility(this.gameState);
    }
    if (this.gameState) {
      this.gameState.removeEntity(this.id);
    }
  }

  /**
   * Processes incoming damage to this entity.
   * @param {Object|number} damage - Damage payload { value, type } or raw amount
   * @param {Entity} [attacker] - Attacking entity reference
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

    // if lifeFraction is set, apply additional damage as a fraction of current health
    if (damage.lifeFraction) {
      rawValue += this.health * damage.lifeFraction;
    }

    const armor = this.armor[damageType] || 1;
    let effectiveDamage = rawValue / armor;

    // Round to 1 decimal place for clean stats
    effectiveDamage = Math.round(effectiveDamage * 10) / 10;

    this.state.health -= effectiveDamage;

    const wasDestroyed = this.state.health <= 0;

    // Add history entry for damage received
    if (this.owner && this.gameState) {
      const attackerName = attacker ? attacker.name : 'Unknown';
      const attackerId = attacker ? attacker.id : null;
      this.owner.addHistoryEntry(this.gameState.currentRound, {
        category: 'damaged',
        details: `${this.name} at (${this.q}, ${this.r}) received ${effectiveDamage} ${damageType} damage from ${attackerName}${wasDestroyed ? ' (DESTROYED)' : ''}`,
        extra: {
          entityName: this.name,
          entityId: this.id,
          damage: effectiveDamage,
          damageType: damageType,
          attackerName: attackerName,
          attackerId: attackerId,
          destroyed: wasDestroyed
        }
      });
    }

    if (wasDestroyed) {
      this.destroy();
    } else if (effectiveDamage > 0) {
      audio.playEntitySfx(this, 'damage');
    }

    const { x, z } = HexGrid.axialToPixel(this.cell.q, this.cell.r);
    spawnDamageText(x, this.cell.terrain.height, z, effectiveDamage);
    spawnParticleBurst(x, this.cell.terrain.height, z, 0xff3300);

    return { damageDealt: effectiveDamage, destroyed: wasDestroyed };
  }

  /**
   * Returns list of available action objects for this entity.
   * Parameterless — returns this.actions array defined on Entity.
   * @returns {Array<Object>} List of candidate action objects
   */
  getActions() {
    return this.actions;
  }

  /**
   * Sets up data-driven actions on this entity based on its definition:
   * - Move and Face Direction actions if movement is defined
   * - Attack action if positive damage value is defined
   * - Repair action if repairables array is present
   * - Build actions if buildables array is present
   */
  setupActions() {
    const hasMovement = !!(this.state.movement || this.data.movement);
    const hasDamage = this.damage && typeof this.damage.value === 'number' && this.damage.value > 0;

    // 1. Move Action (if movement is defined)
    if (hasMovement) {
      this.actions.push({
        name: "Move",
        description: "Move unit to target hex cell.",
        canDo: (cell, entity) => {
          if (!this.active) return { possible: false, reason: "Unit is inactive (maintenance unpaid)." };
          if (!cell) return { possible: false, reason: "No target cell selected." };
          if (entity && entity !== this) return { possible: false, reason: "Target cell is occupied." };
          if (!this.canStandOn(cell)) return { possible: false, reason: "Cannot stand on target terrain." };

          const pathRes = this.gameState && this.gameState.hexGrid ? this.gameState.hexGrid.movementCostTo(this.cell, cell, this.getMovementCost.bind(this)) : null;
          if (!pathRes) return { possible: false, reason: "No valid path to target cell." };

          const cost = pathRes.cost;
          const affordability = this.checkActionAffordability(cost);
          if (!affordability.possible) {
            return affordability;
          }

          return {
            possible: true,
            reason: `Move to (${cell.q}, ${cell.r}) for ${displayNum(cost)} AP and 1 order.`,
            cost: cost,
            ordersRequired: affordability.ordersRequired,
            path: pathRes.path
          };
        },
        do: (cell, entity) => {
          const actionObj = this.actions.find(a => a.name === "Move");
          const check = actionObj.canDo(cell, entity);
          if (!check.possible) return false;

          const oldCell = this.cell;
          const oldQ = this.q;
          const oldR = this.r;

          if (this.gameState && this.gameState.hexGrid) {
            const dirInfo = this.gameState.hexGrid.directionTo(this, cell);
            this.facing = dirInfo.fromSource;
          }

          this.spendActionCost(check.cost, check.ordersRequired);
          this.cell = cell;
          this.q = cell.q;
          this.r = cell.r;

          // Update entity vision & player visibility on move
          this.updateVisibility();

          // Collect treasure if the destination cell holds one
          const pickup = checkTreasurePickup(this);
          if (pickup && pickup.rewarded && this.owner && !this.owner.isAI) {
            const rewards = Object.entries(pickup.granted || {}).map(([t, q]) => `+${q} ${t}`).join(', ');
            showToast(`${this.name} discovered ${pickup.treasureName} (${rewards})`, false, 5000);
          }

          // Add history entry for move action
          if (this.owner && this.gameState) {
            this.owner.addHistoryEntry(this.gameState.currentRound, {
              category: 'action',
              details: `${this.name} moved from (${oldQ}, ${oldR}) to (${cell.q}, ${cell.r})`,
              extra: {
                entityName: this.name,
                entityId: this.id,
                actionName: 'Move',
                fromCell: { q: oldQ, r: oldR },
                toCell: { q: cell.q, r: cell.r },
                apCost: check.cost,
                ordersCost: check.ordersRequired,
                pathLength: check.path ? check.path.length - 1 : 0
              }
            });
          }

          return true;
        }
      });

      // 2. Face Direction Action (Costs AP equal to half movement cost of current cell)
      this.actions.push({
        name: "Face Direction",
        description: "Rotate unit facing direction towards selected hex.",
        canDo: (cell, entity) => {
          if (!this.active) return { possible: false, reason: "Unit is inactive." };
          if (!cell) return { possible: false, reason: "No target cell selected." };
          const cost = Math.ceil(this.getMovementCost(this.cell) / 2);
          const affordability = this.checkActionAffordability(cost);
          if (!affordability.possible) {
            return affordability;
          }

          const dirToTarget = this.gameState && this.gameState.hexGrid ? this.gameState.hexGrid.directionTo(this, cell).fromSource : 'E';
          return {
            possible: true,
            reason: `Face direction ${dirToTarget} costing ${displayNum(cost)} AP and 1 order`,
            cost: cost,
            ordersRequired: affordability.ordersRequired,
            facingDir: dirToTarget
          };
        },
        do: (cell, entity) => {
          const actionObj = this.actions.find(a => a.name === "Face Direction");
          const check = actionObj.canDo(cell, entity);
          if (!check.possible) return false;

          const oldFacing = this.facing;
          this.spendActionCost(check.cost, check.ordersRequired);
          this.facing = check.facingDir;

          // Add history entry for face action
          if (this.owner && this.gameState) {
            this.owner.addHistoryEntry(this.gameState.currentRound, {
              category: 'action',
              details: `${this.name} at (${this.q}, ${this.r}) faced direction ${check.facingDir} (was ${oldFacing})`,
              extra: {
                entityName: this.name,
                entityId: this.id,
                actionName: 'Face Direction',
                oldFacing: oldFacing,
                newFacing: check.facingDir,
                apCost: check.cost,
                ordersCost: check.ordersRequired
              }
            });
          }

          return true;
        }
      });
    }

    // 3. Attack Action (if damage is defined and positive)
    if (hasDamage) {
      this.actions.push({
        name: "Attack",
        description: "Attack target enemy entity.",
        canDo: (cell, entity) => {
          if (!this.active) return { possible: false, reason: "Unit is inactive (maintenance unpaid)." };
          if (!entity) return { possible: false, reason: "No target entity specified." };
          if (!CONFIG.FRIENDLY_FIRE && entity.owner && this.owner && entity.owner.id === this.owner.id) {
            return { possible: false, reason: "Cannot attack friendly entities." };
          }

          const dist = HexGrid.distance(this, cell || entity);
          let cost = 0;

          // Ranged vs Melee evaluation
          if (this.range && typeof this.range === 'object') {
            const minD = this.range.minCells || 1;
            const maxD = this.range.maxCells || 1;
            if (dist < minD || dist > maxD) {
              return { possible: false, reason: `Target out of range (${dist} cells away, range ${minD}-${maxD}).` };
            }

            if (this.gameState && this.gameState.hexGrid) {
              const sight = this.gameState.hexGrid.getSightAndTrajectory(this, cell || entity);
              const isTrajectoryValid = sight.visible || (sight.maxObstructionDelta < (this.range.arcHeight || 0));
              if (!isTrajectoryValid) {
                return { possible: false, reason: "Ranged trajectory blocked by terrain height." };
              }
            }
            cost = Math.ceil(this.attackCostScale * this.state.battleExhaustion * dist);
          } else {
            // Melee attack
            const pathRes = this.gameState && this.gameState.hexGrid ? this.gameState.hexGrid.movementCostTo(this.cell, cell || entity, this.getMovementCost.bind(this)) : null;
            if (!pathRes) {
              return { possible: false, reason: "No valid path to target for melee attack." };
            } else if (pathRes.path.length > 2) {
              return { possible: false, reason: "Can only melee attack adjacent targets." };
            }
            cost = Math.ceil(this.attackCostScale * this.state.battleExhaustion * pathRes.cost);
          }

          const affordability = this.checkActionAffordability(cost);
          if (!affordability.possible) {
            return affordability;
          }

          const multiplier = calculateAttackMultiplier(this.gameState, this.cell, this.damage.elevationAdjustment, entity);
          const rawDamage = this.damage.value * multiplier.total;
          const lifeFractionStr = this.damage.lifeFraction ? ` + ${this.damage.lifeFraction} of current health` : '';

          return {
            possible: true,
            reason: `Attack ${entity.name.toUpperCase()} for ~${displayNum(rawDamage)} dmg (${displayNum(multiplier.direction)}x dir, ${displayNum(multiplier.elevation)}x elev)${lifeFractionStr} costing ${displayNum(cost)} AP and 1 order.`,
            cost: cost,
            ordersRequired: affordability.ordersRequired,
            multiplier: multiplier.direction,
            elevationFactor: multiplier.elevation,
            rawDamage: rawDamage
          };
        },
        do: (cell, entity) => {
          const actionObj = this.actions.find(a => a.name === "Attack");
          const check = actionObj.canDo(cell, entity);
          if (!check.possible) return false;

          // Update attacker facing towards target
          if (this.gameState && this.gameState.hexGrid) {
            const dirToTarget = this.gameState.hexGrid.directionTo(this, cell || entity);
            this.facing = dirToTarget.fromSource;
          }

          this.spendActionCost(check.cost, check.ordersRequired);
          const targetHealthBefore = entity.health;
          entity.receiveDamage({ value: check.rawDamage, ...this.damage }, this);
          const actualDamage = targetHealthBefore - entity.health;
          this.state.battleExhaustion++;

          // Add history entry for attack action
          if (this.owner && this.gameState) {
            this.owner.addHistoryEntry(this.gameState.currentRound, {
              category: 'action',
              details: `${this.name} at (${this.q}, ${this.r}) attacked ${entity.name} for ${actualDamage.toFixed(1)} ${this.damage.type} damage`,
              extra: {
                entityName: this.name,
                entityId: this.id,
                actionName: 'Attack',
                targetEntityName: entity.name,
                targetEntityId: entity.id,
                damageDealt: actualDamage,
                damageType: this.damage.type,
                apCost: check.cost,
                ordersCost: check.ordersRequired,
                multiplier: check.multiplier,
                elevationFactor: check.elevationFactor,
                targetDestroyed: entity.destroyed
              }
            });
          }

          return true;
        }
      });
    }

    // 4. Repair Action (if repairables is defined)
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
          const healAmount = (this.state.repairAmountPerAp || 1) * cost;
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
          const oldHealth = target.health;
          target.health = Math.min(target.maxHealth, target.health + check.healAmount);
          const actualHeal = target.health - oldHealth;

          // Add history entry for repair action
          if (this.owner && this.gameState) {
            this.owner.addHistoryEntry(this.gameState.currentRound, {
              category: 'action',
              details: `${this.name} at (${this.q}, ${this.r}) repaired ${target.name} for +${actualHeal} HP at (${target.q}, ${target.r})`,
              extra: {
                entityName: this.name,
                entityId: this.id,
                actionName: 'Repair',
                targetEntityName: target.name,
                targetEntityId: target.id,
                healAmount: actualHeal,
                apCost: check.cost,
                ordersCost: check.ordersRequired
              }
            });
          }

          return true;
        }
      });
    }

    // 5. Build Actions (for each item in buildables)
    for (const buildable of this.state.buildables || []) {
      const targetName = camelToTitle(buildable);
      const actionName = `Build ${targetName}`;
      this.actions.push({
        name: actionName,
        canDo: (cell, entity) => {
          if (!this.active) return { possible: false, reason: "Worker is inactive." };
          if (!cell) return { possible: false, reason: "No target cell selected." };
          if (entity && entity !== this) return { possible: false, reason: "Target cell is occupied." };

          if (!this.canStandOn(cell)) return { possible: false, reason: "Cannot build construct on target terrain." };

          if (cell.resource) {
            const what = cell.resource.kind === 'treasure' ? 'a treasure' : 'natural resources';
            return { possible: false, reason: `Cannot build ${targetName} on a cell with ${what}.` };
          }

          const meta = this.gameState && this.gameState.manifestData ? this.gameState.manifestData.entities[buildable] : null;
          const spawnConditions = meta ? meta.spawnConditions : null;

          if (spawnConditions) {
            // Check terrain condition if present (in addition to canStandOn)
            if (Array.isArray(spawnConditions.terrain) && spawnConditions.terrain.length > 0) {
              const terrainName = cell.terrain ? cell.terrain.name : '';
              const allowed = spawnConditions.terrain.some(t => t.toLowerCase() === terrainName.toLowerCase());
              if (!allowed) {
                return { possible: false, reason: `Cannot build ${targetName} on ${terrainName} terrain (requires ${spawnConditions.terrain.join(', ')}).` };
              }
            }
          }

          // Check minSeparation (only if BOTH the new and existing entity have minSeparation defined)
          const newMinSep = spawnConditions ? spawnConditions.minSeparation : undefined;
          if (typeof newMinSep === 'number' && this.gameState) {
            const allEntities = this.gameState.entities || [];
            const manifestEntities = this.gameState.manifestData?.entities || {};

            for (const e of allEntities) {
              const eMeta = manifestEntities[e.name];
              const existingMinSep = eMeta?.spawnConditions?.minSeparation;

              if (typeof existingMinSep === 'number') {
                const requiredSep = Math.max(newMinSep, existingMinSep);
                if (requiredSep > 0) {
                  const dist = HexGrid.distance(cell, e);
                  if (dist < requiredSep) {
                    return {
                      possible: false,
                      reason: `Too close to existing entity (${camelToTitle(e.name)} at distance ${dist}, required separation is ${requiredSep}).`
                    };
                  }
                }
              }
            }
          }

          const dist = HexGrid.distance(this, cell);
          if (dist !== 1) return { possible: false, reason: "Target must be adjacent (1 cell away)." };

          const apCost = this.state.actionPoints !== undefined ? 1 : 0;
          const affordability = this.checkActionAffordability(apCost);
          if (!affordability.possible) return affordability;

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
            const newEntity = this.gameState.spawnEntity(buildable, cell, this.owner);
            if (newEntity) {
              audio.playEntitySfx(newEntity, 'build');
            }
            const { x, z } = HexGrid.axialToPixel(cell.q, cell.r);
            spawnParticleBurst(x, cell.terrain.height, z, 0xcca055);
            if (this.state.buildCharges !== undefined) {
              this.state.buildCharges -= 1;
              if (this.state.buildCharges <= 0) {
                this.destroy();
              }
            }

            // Add history entry for build action
            if (this.owner && newEntity) {
              this.owner.addHistoryEntry(this.gameState.currentRound, {
                category: 'action',
                details: `${this.name} at (${this.q}, ${this.r}) built ${newEntity.name} at (${cell.q}, ${cell.r})`,
                extra: {
                  entityName: this.name,
                  entityId: this.id,
                  actionName: 'Build',
                  builtEntityName: newEntity.name,
                  builtEntityId: newEntity.id,
                  targetCell: { q: cell.q, r: cell.r },
                  resourceCost: check.cost,
                  apCost: check.apCost,
                  ordersCost: check.ordersRequired
                }
              });
            }
          }
          return true;
        }
      });
    }
  }

  /**
   * Descriptive summary for inspect panel UI.
   * @returns {string}
   */
  info() {
    const ownerName = this.owner ? this.owner.name : 'Neutral';
    const activeStr = this.active ? 'ACTIVE' : 'INACTIVE (No Maintenance)';
    let yieldStr = '';
    const baseYields = this.baseYields;
    const baseKeys = Object.keys(baseYields);
    if (baseKeys.length > 0) {
      const adjusted = this.yields;
      const parts = [];
      for (const [type, baseVal] of Object.entries(baseYields)) {
        const adjVal = adjusted[type];
        if (typeof baseVal === 'number' && typeof adjVal === 'number' && adjVal > baseVal) {
          parts.push(`+${displayNum(baseVal)} ${type} → <b>+${displayNum(adjVal)} ${type}</b>`);
        } else {
          parts.push(`+${baseVal} ${type}`);
        }
      }
      yieldStr = parts.join(', ');
    }
    let apStr = '';
    if (this.maxActionPoints !== undefined && this.maxActionPoints > 0) {
      apStr = `AP: ${displayNum(this.actionPoints)}/${displayNum(this.maxActionPoints)}. `;
    }

    const base = `${camelToTitle(this.name)}. Owner: ${ownerName}. HP: ${Math.max(0, Math.round(this.state.health))}/${this.maxHealth}. ${apStr}Status: ${activeStr}.${yieldStr ? ` Income/turn: ${yieldStr}` : ''}`;

    if (this.isConstruct) {
      return base;
    }

    const rangeStr = this.range ? `Rng:${this.range.minCells}-${this.range.maxCells}` : 'Melee';
    const atkStr = this.damage && this.damage.value > 0 ? ` Atk: ${displayNum(this.damage.value)} (${this.damage.type}, ${rangeStr}).` : '';
    return `${base}${atkStr} Facing: ${this.facing}`;
  }

  /**
   * Serializes entity to JSON-friendly data object.
   * @returns {Object}
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

export { Entity };
