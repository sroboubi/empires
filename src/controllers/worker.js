import { UnitEntity } from './unitEntity.js';
import { distance } from '../hexMath.js';

export default class WorkerController extends UnitEntity {
  constructor(entityData, ownerPlayer, gridProxy, cell, initialState = null) {
    super(entityData, ownerPlayer, gridProxy, cell, initialState);

    if (!initialState) {
      this.state.maxMovementPoints = 2;
      this.state.movementPoints = 2;
      this.state.attackPower = 4;
      this.state.range = 1;
      this.state.armor = 0;
      this.state.maxHealth = 60;
      this.state.health = 60;
    }

    // Dynamic construct build definitions with cost maps
    this.buildables = {
      "Build Farm": { construct: "farm", cost: { wood: 20 } },
      "Build Mine": { construct: "mine", cost: { wood: 30, gold: 20 } },
      "Build Lumber Mill": { construct: "lumber_mill", cost: { gold: 20 } },
      "Build Forge": { construct: "forge", cost: { wood: 40, iron: 10 } }
    };
  }

  getActions(targetCell, targetEntity) {
    const actions = super.getActions(targetCell, targetEntity);
    if (!targetCell) return actions;

    const dist = distance(this, targetCell);

    // If target cell is adjacent, empty of entities, and land, worker can build constructs
    if (dist === 1 && (!targetEntity || targetEntity === this) && this.canStandOn(targetCell.terrain) && this.state.movementPoints >= 1) {
      for (const [actionName, config] of Object.entries(this.buildables)) {
        const canAfford = this.owner ? this.owner.hasResources(config.cost) : false;
        const costStr = Object.entries(config.cost).map(([k, v]) => `${v} ${k}`).join(', ');

        actions.push({
          name: actionName,
          description: `Construct ${config.construct.toUpperCase()} on cell (${targetCell.q}, ${targetCell.r})`,
          preview: `Cost: ${costStr} ${canAfford ? '(Affordable)' : '(Insufficient Funds)'}`
        });
      }
    }

    return actions;
  }

  doAction(actionName, targetCell, targetEntity) {
    if (this.buildables[actionName]) {
      const config = this.buildables[actionName];
      if (!targetCell) return { success: false, message: "No target cell selected." };
      const dist = distance(this, targetCell);
      if (dist !== 1) return { success: false, message: "Construct target must be adjacent." };
      if (!this.canStandOn(targetCell.terrain)) return { success: false, message: "Cannot build on water." };
      if (this.state.movementPoints < 1) return { success: false, message: "No movement points remaining." };

      if (this.owner && !this.owner.hasResources(config.cost)) {
        return { success: false, message: "Insufficient player resources to build construct." };
      }

      // Consume resources & deduct MP
      if (this.owner) {
        this.owner.consumeResources(config.cost);
      }
      this.state.movementPoints -= 1;

      // Spawn construct entity on target cell
      if (this.grid) {
        this.grid.spawnEntity(config.construct, targetCell, this.owner);
      }

      return { success: true, message: `Successfully built ${config.construct.toUpperCase()}!` };
    }

    return super.doAction(actionName, targetCell, targetEntity);
  }
}
