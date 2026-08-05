import { ConstructEntity } from './constructEntity.js';
import { distance } from '../hexMath.js';

export default class VillageController extends ConstructEntity {
  constructor(entityData, ownerPlayer, gridProxy, cell, initialState = null) {
    super(entityData, ownerPlayer, gridProxy, cell, initialState);

    if (!initialState) {
      this.state.maxHealth = 200;
      this.state.health = 200;
      this.state.yields = { gold: 10, food: 5 };
    }

    // Units trainable at a Village with resource costs
    this.spawnables = {
      "Spawn Worker": { unit: "worker", cost: { food: 20, gold: 10 } },
      "Spawn Swordsman": { unit: "swordsman", cost: { food: 40, gold: 30, iron: 10 } },
      "Spawn Bowman": { unit: "bowman", cost: { food: 30, gold: 20, wood: 10 } },
      "Spawn Horseman": { unit: "horseman", cost: { food: 50, gold: 40 } },
      "Spawn Settler": { unit: "settler", cost: { food: 60, gold: 50 } }
    };
  }

  getActions(targetCell, targetEntity) {
    const actions = super.getActions(targetCell, targetEntity);
    if (!targetCell) return actions;

    const dist = distance(this, targetCell);

    // If target cell is adjacent, empty of entities, and valid land, offer unit spawning
    if (dist === 1 && (!targetEntity || targetEntity === this) && this.canStandOn(targetCell.terrain)) {
      for (const [actionName, config] of Object.entries(this.spawnables)) {
        const canAfford = this.owner ? this.owner.hasResources(config.cost) : false;
        const costStr = Object.entries(config.cost).map(([k, v]) => `${v} ${k}`).join(', ');

        actions.push({
          name: actionName,
          description: `Spawn ${config.unit.toUpperCase()} on (${targetCell.q}, ${targetCell.r})`,
          preview: `Cost: ${costStr} ${canAfford ? '(Affordable)' : '(Insufficient Funds)'}`
        });
      }
    }

    return actions;
  }

  doAction(actionName, targetCell, targetEntity) {
    if (this.spawnables[actionName]) {
      const config = this.spawnables[actionName];
      if (!targetCell) return { success: false, message: "No target cell selected." };
      const dist = distance(this, targetCell);
      if (dist !== 1) return { success: false, message: "Unit must be spawned on an adjacent cell." };
      if (!this.canStandOn(targetCell.terrain)) return { success: false, message: "Cannot spawn unit on water terrain." };
      if (targetEntity && targetEntity !== this) return { success: false, message: "Target cell already occupied by another entity." };

      if (this.owner && !this.owner.hasResources(config.cost)) {
        return { success: false, message: "Insufficient resources to train unit." };
      }

      // Consume resources
      if (this.owner) {
        this.owner.consumeResources(config.cost);
      }

      // Spawn unit
      if (this.grid) {
        this.grid.spawnEntity(config.unit, targetCell, this.owner);
      }

      return { success: true, message: `Successfully spawned ${config.unit.toUpperCase()} at (${targetCell.q}, ${targetCell.r})!` };
    }

    return super.doAction(actionName, targetCell, targetEntity);
  }
}
