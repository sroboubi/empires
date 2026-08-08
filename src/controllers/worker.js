import { UnitEntity } from './unitEntity.js';
import { HexGrid } from '../hexGrid.js';

export default class WorkerController extends UnitEntity {
  constructor(entityData, ownerPlayer, gridProxy, cell, initialState = null) {
    super(entityData, ownerPlayer, gridProxy, cell, initialState);

    // Dynamic construct build definitions with default cost maps
    this.buildables = {
      "Build Farm": { construct: "farm" },
      "Build Mine": { construct: "mine" },
      "Build Lumber Mill": { construct: "lumber_mill" },
      "Build Forge": { construct: "forge" }
    };
  }

  getActions(targetCell, targetEntity) {
    const actions = super.getActions(targetCell, targetEntity);

    for (const [actionName, config] of Object.entries(this.buildables)) {
      actions.push({
        name: actionName,
        description: `Construct ${config.construct.toUpperCase()} on target cell.`,
        canDo: (cell, entity) => {
          if (!this.active) return { possible: false, reason: "Worker is inactive." };
          if (!cell) return { possible: false, reason: "No target cell selected." };
          if (entity && entity !== this) return { possible: false, reason: "Target cell is occupied." };
          if (!this.canStandOn(cell)) return { possible: false, reason: "Cannot build construct on water." };

          const dist = HexGrid.distance(this, cell);
          if (dist !== 1) return { possible: false, reason: "Construct target must be adjacent (1 cell away)." };
          if (this.actionPoints < 1) return { possible: false, reason: "Insufficient Action Points (1 AP required)." };

          const meta = this.grid && this.grid.manifestData ? this.grid.manifestData.entities[config.construct] : null;
          const cost = (meta && meta.spawnCost) || { wood: 20 };

          if (this.owner && !this.owner.hasResources(cost)) {
            const costStr = Object.entries(cost).map(([k, v]) => `${v} ${k}`).join(', ');
            return { possible: false, reason: `Insufficient resources to build ${config.construct} (${costStr} required).` };
          }

          const costStr = Object.entries(cost).map(([k, v]) => `${v} ${k}`).join(', ');
          return {
            possible: true,
            reason: `Build ${config.construct.toUpperCase()} on (${cell.q}, ${cell.r}) costing ${costStr} and 1 AP.`,
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

          this.actionPoints -= 1;

          if (this.grid) {
            this.grid.spawnEntity(config.construct, cell, this.owner);
          }

          return true;
        }
      });
    }

    return actions;
  }
}

