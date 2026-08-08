import { BaseEntity } from './baseEntity.js';
import { HexGrid } from '../hexGrid.js';

/**
 * UnitEntity - Base Class for all mobile, combat-capable units.
 * Extends BaseEntity with movement, range, attack, and armor attributes.
 */
export class UnitEntity extends BaseEntity {
  constructor(entityData, ownerPlayer, gridProxy, cell, initialState = null) {
    super(entityData, ownerPlayer, gridProxy, cell, initialState);

    // Initialize unit attributes in state
    if (!initialState) {
      this.state.maxMovementPoints = this.data.maxMovementPoints || 2;
      this.state.movementPoints = this.state.maxMovementPoints;
      this.state.attackPower = this.data.attackPower || 10;
      this.state.range = this.data.range || 1;
      this.state.armor = this.data.armor || 0;
    }
  }

  /**
   * Resets movement points at the start of a turn step.
   */
  step(globalContext) {
    super.step(globalContext);
    this.state.movementPoints = this.state.maxMovementPoints;
  }

  /**
   * Generates candidate actions for target cell and entity.
   */
  getActions(targetCell, targetEntity) {
    const actions = [];
    if (!targetCell) return actions;

    const dist = HexGrid.distance(this, targetCell);

    // 1. Attack action if target cell contains an enemy unit/construct
    if (targetEntity && targetEntity.owner && this.owner && targetEntity.owner.id !== this.owner.id) {
      if (dist <= (this.state.range || 1) && this.state.movementPoints > 0) {
        const estDamage = Math.max(1, (this.state.attackPower || 10) - (targetEntity.state.armor || 0));
        actions.push({
          name: "Attack",
          description: `Attack enemy ${targetEntity.name.toUpperCase()}`,
          preview: `Deals ~${estDamage} dmg (HP: ${targetEntity.state.health}/${targetEntity.state.maxHealth})`
        });
      }
    }

    // 2. Move action if target cell is adjacent, empty or friendly, and walkable
    if (!targetEntity || targetEntity === this) {
      if (dist === 1 && this.canStandOn(targetCell.terrain) && this.state.movementPoints >= 1) {
        actions.push({
          name: "Move",
          description: `Move to (${targetCell.q}, ${targetCell.r})`,
          preview: `Costs 1 MP (${this.state.movementPoints - 1}/${this.state.maxMovementPoints} remaining)`
        });
      }
    }

    return actions;
  }

  /**
   * Executes unit action.
   */
  doAction(actionName, targetCell, targetEntity) {
    if (actionName === "Move") {
      if (!targetCell) return { success: false, message: "No target cell specified." };
      const dist = HexGrid.distance(this, targetCell);
      if (dist !== 1) return { success: false, message: "Can only move to an adjacent cell." };
      if (!this.canStandOn(targetCell.terrain)) return { success: false, message: "Cannot stand on water terrain." };
      if (this.state.movementPoints < 1) return { success: false, message: "Not enough movement points." };

      // Update position
      this.cell = targetCell;
      this.q = targetCell.q;
      this.r = targetCell.r;
      this.state.movementPoints -= 1;

      return { success: true, message: `Moved to (${this.q}, ${this.r}).` };
    }

    if (actionName === "Attack") {
      if (!targetEntity) return { success: false, message: "No target entity to attack." };
      if (targetEntity.owner && this.owner && targetEntity.owner.id === this.owner.id) {
        return { success: false, message: "Cannot attack friendly entity!" };
      }
      const dist = HexGrid.distance(this, targetCell || targetEntity);
      if (dist > (this.state.range || 1)) return { success: false, message: "Target out of range." };
      if (this.state.movementPoints < 1) return { success: false, message: "No movement points left to attack." };

      this.state.movementPoints -= 1;
      const result = targetEntity.receiveDamage(this.state.attackPower || 10, this);

      return {
        success: true,
        message: result.destroyed
          ? `Attack destroyed ${targetEntity.name.toUpperCase()}!`
          : `Attacked ${targetEntity.name.toUpperCase()} for ${result.damageDealt} damage.`
      };
    }

    return super.doAction(actionName, targetCell, targetEntity);
  }

  info() {
    const ownerName = this.owner ? this.owner.name : 'Neutral';
    return `${this.name.toUpperCase()} (Unit). Owner: ${ownerName}. HP: ${this.state.health}/${this.state.maxHealth}. MP: ${this.state.movementPoints}/${this.state.maxMovementPoints}. Atk: ${this.state.attackPower}. Range: ${this.state.range}.`;
  }
}
