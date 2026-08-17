import { BaseEntity } from './baseEntity.js';
import { HexGrid } from '../hexGrid.js';
import { CONFIG } from '../config.js';

const DIRECTIONS_LIST = ['E', 'NE', 'NW', 'W', 'SW', 'SE'];

/**
 * UnitEntity - Base Class for all mobile, combat-capable units.
 * Extends BaseEntity with action points, range, attack, facing attributes.
 */
export class UnitEntity extends BaseEntity {
  constructor(entityData, ownerPlayer, gameState, cell, initialState = null) {
    super(entityData, ownerPlayer, gameState, cell, initialState);
  }

  getDefaults() {
    return {
      ...super.getDefaults(),
      maxActionPoints: 10,
      actionPoints: 10,
      attackCostScale: 1.0,
      damage: { value: 0, type: 'blunt' },
      range: null,
      facing: 'E'
    };
  }

  get actionPoints() {
    return this.state.actionPoints;
  }

  set actionPoints(val) {
    this.state.actionPoints = val;
  }

  get maxActionPoints() {
    return this.state.maxActionPoints || 2;
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
   * Resets action points at the start of a turn step.
   * Any action points not used in the previous turn are added to health.
   */
  step(globalContext) {
    super.step(globalContext);

    if (this.active) {
      const unusedAP = Math.max(0, this.state.actionPoints);
      if (unusedAP > 0) {
        this.health = Math.min(this.maxHealth, this.health + unusedAP);
      }
      this.state.actionPoints = this.maxActionPoints;
    }
  }

  /**
   * Populates move, attack, and face actions into this.actions array.
   */
  setupActions() {
    super.setupActions();
    // 1. Move Action
    this.actions.push({
      name: "Move",
      description: "Move unit to target hex cell.",
      canDo: (cell, entity) => {
        if (!this.active) return { possible: false, reason: "Unit is inactive (maintenance unpaid)." };
        if (!cell) return { possible: false, reason: "No target cell selected." };
        if (entity && entity !== this) return { possible: false, reason: "Target cell is occupied." };
        if (!this.canStandOn(cell)) return { possible: false, reason: "Cannot stand on water terrain." };

        const pathRes = this.gameState && this.gameState.hexGrid ? this.gameState.hexGrid.movementCostTo(this, cell) : null;
        if (!pathRes) return { possible: false, reason: "No valid path to target cell." };

        const cost = pathRes.cost;
        const affordability = this.checkActionAffordability(cost);
        if (!affordability.possible) {
          return affordability;
        }

        return {
          possible: true,
          reason: `Move to (${cell.q}, ${cell.r}) for ${cost} AP and 1 order.`,
          cost: cost,
          ordersRequired: affordability.ordersRequired,
          path: pathRes.path
        };
      },
      do: (cell, entity) => {
        const actionObj = this.actions.find(a => a.name === "Move");
        const check = actionObj.canDo(cell, entity);
        if (!check.possible) return false;

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

        return true;
      }
    });

    // 2. Attack Action (if unit has positive damage value)
    if (this.damage && this.damage.value > 0) {
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
            cost = Math.ceil(this.attackCostScale * dist);
          } else {
            // Melee attack
            const pathRes = this.gameState && this.gameState.hexGrid ? this.gameState.hexGrid.movementCostTo(this, cell || entity) : null;
            if (!pathRes) {
              return { possible: false, reason: "No valid path to target for melee attack." };
            }
            cost = Math.ceil(this.attackCostScale * pathRes.cost);
          }

          const affordability = this.checkActionAffordability(cost);
          if (!affordability.possible) {
            return affordability;
          }

          // Directional damage multiplier
          let multiplier = 1.0;
          if (this.gameState && this.gameState.hexGrid && entity.facing) {
            const dirFromTargetToAttacker = this.gameState.hexGrid.directionTo(entity, this).fromSource;
            const idxTarget = DIRECTIONS_LIST.indexOf(entity.facing);
            const idxAttacker = DIRECTIONS_LIST.indexOf(dirFromTargetToAttacker);

            if (idxTarget !== -1 && idxAttacker !== -1) {
              let diff = Math.abs(idxTarget - idxAttacker);
              if (diff > 3) diff = 6 - diff;

              if (diff === 0) multiplier = 1.0;       // Front
              else if (diff === 1 || diff === 2) multiplier = 1.5; // Side
              else if (diff === 3) multiplier = 2.0;   // Behind
            }
          }

          // Elevation damage adjustment
          let elevationFactor = 1.0;
          if (this.damage && typeof this.damage.elevationAdjustment === 'number' && this.damage.elevationAdjustment > 0) {
            const attackerCell = this.cell || (this.gameState && this.gameState.hexGrid ? this.gameState.hexGrid.getCell(this.q, this.r) : null);
            const targetCell = cell || (entity && entity.cell) || (this.gameState && this.gameState.hexGrid && entity ? this.gameState.hexGrid.getCell(entity.q, entity.r) : null);
            const getElev = (c) => (c && c.terrain && (c.terrain.height ?? c.terrain.elevation)) ?? 1.0;
            const attackerElevation = Math.max(0.1, getElev(attackerCell));
            const targetElevation = Math.max(0.1, getElev(targetCell));
            console.log(attackerElevation, targetElevation, this.damage.elevationAdjustment);
            const ratio = attackerElevation / targetElevation;
            if (ratio > 1.01) { elevationFactor = ratio * this.damage.elevationAdjustment }
            else if (ratio < 0.99) { elevationFactor = ratio / this.damage.elevationAdjustment }
          }

          const rawDamage = Math.round(this.damage.value * multiplier * elevationFactor);
          const elevStr = this.damage && this.damage.elevationAdjustment ? `, ${elevationFactor.toFixed(2)}x elev` : '';

          return {
            possible: true,
            reason: `Attack ${entity.name.toUpperCase()} for ~${rawDamage} dmg (${multiplier}x dir${elevStr}) costing ${cost} AP and 1 order.`,
            cost: cost,
            ordersRequired: affordability.ordersRequired,
            multiplier: multiplier,
            elevationFactor: elevationFactor,
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
          entity.receiveDamage({ value: check.rawDamage, type: this.damage.type }, this);

          return true;
        }
      });
    }

    // 3. Face Action (Costs AP equal to half the movement cost of the current cell)
    this.actions.push({
      name: "Face Direction",
      description: "Rotate unit facing direction towards selected hex.",
      canDo: (cell, entity) => {
        if (!this.active) return { possible: false, reason: "Unit is inactive." };
        if (!cell) return { possible: false, reason: "No target cell selected." };

        const currentCell = this.cell || (this.gameState && this.gameState.hexGrid ? this.gameState.hexGrid.getCell(this.q, this.r) : null);
        const cellMovementCost = currentCell && currentCell.terrain ? currentCell.terrain.movementCost : 1;
        const cost = Math.ceil(cellMovementCost / 2);

        const affordability = this.checkActionAffordability(cost);
        if (!affordability.possible) {
          return affordability;
        }

        const dirToTarget = this.gameState && this.gameState.hexGrid ? this.gameState.hexGrid.directionTo(this, cell).fromSource : 'E';
        return {
          possible: true,
          reason: `Face direction ${dirToTarget} costing ${cost} AP and 1 order`,
          cost: cost,
          ordersRequired: affordability.ordersRequired,
          facingDir: dirToTarget
        };
      },
      do: (cell, entity) => {
        const actionObj = this.actions.find(a => a.name === "Face Direction");
        const check = actionObj.canDo(cell, entity);
        if (!check.possible) return false;

        this.spendActionCost(check.cost, check.ordersRequired);
        this.facing = check.facingDir;
        return true;
      }
    });
  }

  info() {
    const rangeStr = this.range ? `Rng:${this.range.minCells}-${this.range.maxCells}` : 'Melee';
    return super.info() + ` AP: ${this.actionPoints}/${this.maxActionPoints}. Atk: ${this.damage.value} (${this.damage.type}, ${rangeStr}). Facing: ${this.facing}`;
  }
}
