import { UnitEntity } from './unitEntity.js';
import { HexGrid } from '../hexGrid.js';

export default class SettlerController extends UnitEntity {
  constructor(entityData, ownerPlayer, gridProxy, cell, initialState = null) {
    super(entityData, ownerPlayer, gridProxy, cell, initialState);

    if (!initialState) {
      this.state.maxMovementPoints = 2;
      this.state.movementPoints = 2;
      this.state.attackPower = 0;
      this.state.range = 1;
      this.state.armor = 0;
      this.state.maxHealth = 50;
      this.state.health = 50;
    }
  }

  getActions(targetCell, targetEntity) {
    const actions = super.getActions(targetCell, targetEntity);
    if (!targetCell) return actions;

    const dist = HexGrid.distance(this, targetCell);
    const isCurrentOrAdjacent = dist <= 1;

    // Found Village action on current or adjacent empty land cell
    if (isCurrentOrAdjacent && (!targetEntity || targetEntity === this) && this.canStandOn(targetCell.terrain) && this.state.movementPoints >= 1) {
      const cost = { gold: 30, food: 20 };
      const canAfford = this.owner ? this.owner.hasResources(cost) : false;
      actions.push({
        name: "Found Village",
        description: `Found a new Village settlement on cell (${targetCell.q}, ${targetCell.r})`,
        preview: `Cost: 30 gold, 20 food ${canAfford ? '(Affordable)' : '(Insufficient Funds)'}`
      });
    }

    return actions;
  }

  doAction(actionName, targetCell, targetEntity) {
    if (actionName === "Found Village") {
      if (!targetCell) return { success: false, message: "No target cell selected." };
      const dist = HexGrid.distance(this, targetCell);
      if (dist > 1) return { success: false, message: "Village must be founded on current or adjacent cell." };
      if (!this.canStandOn(targetCell.terrain)) return { success: false, message: "Cannot build on water." };

      const cost = { gold: 30, food: 20 };
      if (this.owner && !this.owner.hasResources(cost)) {
        return { success: false, message: "Insufficient resources to found village." };
      }

      if (this.owner) {
        this.owner.consumeResources(cost);
      }

      // Spawn Village construct
      if (this.grid) {
        this.grid.spawnEntity("village", targetCell, this.owner);
        // Consume settler
        this.grid.removeEntity(this.id);
      }

      return { success: true, message: `Successfully founded Village on (${targetCell.q}, ${targetCell.r})!` };
    }

    return super.doAction(actionName, targetCell, targetEntity);
  }
}
