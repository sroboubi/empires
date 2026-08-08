import { ConstructEntity } from './constructEntity.js';
import { HexGrid } from '../hexGrid.js';

export default class VillageController extends ConstructEntity {
  constructor(entityData, ownerPlayer, gridProxy, cell, initialState = null) {
    super(entityData, ownerPlayer, gridProxy, cell, initialState);

    // Dynamic trainable units mapped to unit entity name
    this.spawnables = {
      "Spawn Worker": "worker",
      "Spawn Swordsman": "swordsman",
      "Spawn Bowman": "bowman",
      "Spawn Horseman": "horseman",
      "Spawn Settler": "settler"
    };
  }

  getActions(targetCell, targetEntity) {
    const actions = super.getActions(targetCell, targetEntity);

    for (const [actionName, unitName] of Object.entries(this.spawnables)) {
      actions.push({
        name: actionName,
        description: `Train and spawn ${unitName.toUpperCase()} on target adjacent cell.`,
        canDo: (cell, entity) => {
          if (!this.active) return { possible: false, reason: "Village is inactive." };
          if (!cell) return { possible: false, reason: "No target cell selected." };
          if (entity && entity !== this) return { possible: false, reason: "Target cell is occupied." };
          if (!this.canStandOn(cell)) return { possible: false, reason: "Cannot spawn unit on water terrain." };

          const dist = HexGrid.distance(this, cell);
          if (dist !== 1) return { possible: false, reason: "Unit must be spawned on an adjacent cell (1 cell away)." };

          const meta = this.grid && this.grid.manifestData ? this.grid.manifestData.entities[unitName] : null;
          const cost = (meta && meta.spawnCost) || { food: 20, gold: 10 };

          if (this.owner && !this.owner.hasResources(cost)) {
            const costStr = Object.entries(cost).map(([k, v]) => `${v} ${k}`).join(', ');
            return { possible: false, reason: `Insufficient resources to train ${unitName} (${costStr} required).` };
          }

          const costStr = Object.entries(cost).map(([k, v]) => `${v} ${k}`).join(', ');
          return {
            possible: true,
            reason: `Spawn ${unitName.toUpperCase()} on (${cell.q}, ${cell.r}) costing ${costStr}.`,
            cost: cost
          };
        },
        do: (cell, entity) => {
          const actionObj = actions.find(a => a.name === actionName);
          const check = actionObj.canDo(cell, entity);
          if (!check.possible) return false;

          if (this.owner) {
            this.owner.consumeResources(check.cost);
          }

          if (this.grid) {
            this.grid.spawnEntity(unitName, cell, this.owner);
          }

          return true;
        }
      });
    }

    return actions;
  }
}

