import { BaseEntity } from './baseEntity.js';
import { HexGrid } from '../hexGrid.js';

const DIRECTIONS_LIST = ['E', 'NE', 'NW', 'W', 'SW', 'SE'];

/**
 * UnitEntity - Base Class for all mobile, combat-capable units.
 * Extends BaseEntity with action points, range, attack, facing, and armor attributes.
 */
export class UnitEntity extends BaseEntity {
  constructor(entityData, ownerPlayer, gridProxy, cell, initialState = null) {
    super(entityData, ownerPlayer, gridProxy, cell, initialState);

    // Initialize unit attributes in state
    if (!initialState) {
      this.state.maxActionPoints = this.data.maxActionPoints || this.data.maxMovementPoints || 2;
      this.state.actionPoints = this.data.actionPoints || this.state.maxActionPoints;
      this.state.attackCostScale = this.data.attackCostScale !== undefined ? this.data.attackCostScale : 1.0;
      this.state.damage = this.data.damage || { value: this.data.attackPower || 10, type: 'slashing' };
      this.state.range = this.data.range !== undefined ? this.data.range : null;
      this.state.armor = this.data.armor || { value: 0, type: 'none' };
      this.state.facing = this.data.facing || 'E';
    }

    if (this.state.actionPoints === undefined) this.state.actionPoints = this.state.maxActionPoints || 2;
    if (this.state.maxActionPoints === undefined) this.state.maxActionPoints = 2;
    if (this.state.attackCostScale === undefined) this.state.attackCostScale = 1.0;
    if (this.state.facing === undefined) this.state.facing = 'E';
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

  get armor() {
    return this.state.armor || { value: 0, type: 'none' };
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
   * Returns list of action objects: { name, description, canDo, do }
   */
  getActions(targetCell, targetEntity) {
    const actions = [];

    // 1. Move Action
    actions.push({
      name: "Move",
      description: "Move unit to target hex cell.",
      canDo: (cell, entity) => {
        if (!this.active) return { possible: false, reason: "Unit is inactive (maintenance unpaid)." };
        if (!cell) return { possible: false, reason: "No target cell selected." };
        if (entity && entity !== this) return { possible: false, reason: "Target cell is occupied." };
        if (!this.canStandOn(cell)) return { possible: false, reason: "Cannot stand on water terrain." };

        const pathRes = this.grid && this.grid.hexGrid ? this.grid.hexGrid.movementCostTo(this, cell) : null;
        if (!pathRes) return { possible: false, reason: "No valid path to target cell." };

        const cost = pathRes.cost;
        if (this.actionPoints < cost) {
          return { possible: false, reason: `Insufficient Action Points (${this.actionPoints}/${cost} AP required).` };
        }

        return {
          possible: true,
          reason: `Move to (${cell.q}, ${cell.r}) for ${cost} AP.`,
          cost: cost,
          path: pathRes.path
        };
      },
      do: (cell, entity) => {
        const check = actions[0].canDo(cell, entity);
        if (!check.possible) return false;

        if (this.grid && this.grid.hexGrid) {
          const dirInfo = this.grid.hexGrid.directionTo(this, cell);
          this.facing = dirInfo.fromSource;
        }

        this.actionPoints -= check.cost;
        this.cell = cell;
        this.q = cell.q;
        this.r = cell.r;

        return true;
      }
    });

    // 2. Attack Action (if unit has positive damage value)
    if (this.damage && this.damage.value > 0) {
      actions.push({
        name: "Attack",
        description: "Attack target enemy entity.",
        canDo: (cell, entity) => {
          if (!this.active) return { possible: false, reason: "Unit is inactive (maintenance unpaid)." };
          if (!entity) return { possible: false, reason: "No target entity specified." };
          if (entity.owner && this.owner && entity.owner.id === this.owner.id) {
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

            if (this.grid && this.grid.hexGrid) {
              const sight = this.grid.hexGrid.getSightAndTrajectory(this, cell || entity);
              const isTrajectoryValid = sight.visible || (sight.maxObstructionDelta < (this.range.arcHeight || 0));
              if (!isTrajectoryValid) {
                return { possible: false, reason: "Ranged trajectory blocked by terrain height." };
              }
            }
            cost = Math.ceil(this.attackCostScale * dist);
          } else {
            // Melee attack
            const pathRes = this.grid && this.grid.hexGrid ? this.grid.hexGrid.movementCostTo(this, cell || entity) : null;
            if (!pathRes) {
              return { possible: false, reason: "No valid path to target for melee attack." };
            }
            cost = Math.ceil(this.attackCostScale * pathRes.cost);
          }

          if (this.actionPoints < cost) {
            return { possible: false, reason: `Insufficient Action Points to attack (${this.actionPoints}/${cost} AP required).` };
          }

          // Directional damage multiplier
          let multiplier = 1.0;
          if (this.grid && this.grid.hexGrid && entity.facing) {
            const dirFromTargetToAttacker = this.grid.hexGrid.directionTo(entity, this).fromSource;
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

          const rawDamage = Math.round(this.damage.value * multiplier);

          return {
            possible: true,
            reason: `Attack ${entity.name.toUpperCase()} for ~${rawDamage} dmg (${multiplier}x directional) costing ${cost} AP.`,
            cost: cost,
            multiplier: multiplier,
            rawDamage: rawDamage
          };
        },
        do: (cell, entity) => {
          const actionObj = actions.find(a => a.name === "Attack");
          const check = actionObj.canDo(cell, entity);
          if (!check.possible) return false;

          // Update attacker facing towards target
          if (this.grid && this.grid.hexGrid) {
            const dirToTarget = this.grid.hexGrid.directionTo(this, cell || entity);
            this.facing = dirToTarget.fromSource;
          }

          this.actionPoints -= check.cost;
          entity.receiveDamage({ value: check.rawDamage, type: this.damage.type, source: this });

          return true;
        }
      });
    }

    // 3. Face Action
    actions.push({
      name: "Face Direction",
      description: "Rotate unit facing direction towards selected hex.",
      canDo: (cell, entity) => {
        if (!this.active) return { possible: false, reason: "Unit is inactive." };
        if (!cell) return { possible: false, reason: "No target cell selected." };

        const dirToTarget = this.grid && this.grid.hexGrid ? this.grid.hexGrid.directionTo(this, cell).fromSource : 'E';
        return {
          possible: true,
          reason: `Face direction ${dirToTarget}`,
          facingDir: dirToTarget
        };
      },
      do: (cell, entity) => {
        const actionObj = actions.find(a => a.name === "Face Direction");
        const check = actionObj.canDo(cell, entity);
        if (!check.possible) return false;

        this.facing = check.facingDir;
        return true;
      }
    });

    return actions;
  }

  info() {
    const ownerName = this.owner ? this.owner.name : 'Neutral';
    const activeStr = this.active ? 'ACTIVE' : 'INACTIVE';
    const rangeStr = this.range ? `Rng:${this.range.minCells}-${this.range.maxCells}` : 'Melee';
    return `${this.name.toUpperCase()} (Unit). Owner: ${ownerName}. HP: ${Math.max(0, Math.round(this.health))}/${this.maxHealth}. AP: ${this.actionPoints}/${this.maxActionPoints}. Atk: ${this.damage.value} (${this.damage.type}, ${rangeStr}). Status: ${activeStr}. Facing: ${this.facing}`;
  }
}

