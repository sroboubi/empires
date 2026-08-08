import { UnitEntity } from './unitEntity.js';
import { HexGrid } from '../hexGrid.js';

export default class SettlerController extends UnitEntity {
  constructor(entityData, ownerPlayer, gridProxy, cell, initialState = null) {
    super(entityData, ownerPlayer, gridProxy, cell, initialState);
  }

  getActions(targetCell, targetEntity) {
    const actions = super.getActions(targetCell, targetEntity);

    actions.push({
      name: "Found Village",
      description: "Found a new Village settlement on target cell.",
      canDo: (cell, entity) => {
        if (!this.active) return { possible: false, reason: "Settler is inactive." };
        if (!cell) return { possible: false, reason: "No target cell selected." };
        if (entity && entity !== this) return { possible: false, reason: "Target cell is occupied." };
        if (!this.canStandOn(cell)) return { possible: false, reason: "Cannot build village on water." };

        const dist = HexGrid.distance(this, cell);
        if (dist > 1) return { possible: false, reason: "Village must be founded on current or adjacent cell." };
        if (this.actionPoints < 1) return { possible: false, reason: "Insufficient Action Points (1 AP required)." };

        const villageMeta = this.grid && this.grid.manifestData ? this.grid.manifestData.entities['village'] : null;
        const cost = (villageMeta && villageMeta.spawnCost) || { gold: 30, food: 20 };

        if (this.owner && !this.owner.hasResources(cost)) {
          const costStr = Object.entries(cost).map(([k, v]) => `${v} ${k}`).join(', ');
          return { possible: false, reason: `Insufficient resources to found Village (${costStr} required).` };
        }

        const costStr = Object.entries(cost).map(([k, v]) => `${v} ${k}`).join(', ');
        return {
          possible: true,
          reason: `Found Village on (${cell.q}, ${cell.r}) costing ${costStr} and 1 AP.`,
          cost: cost
        };
      },
      do: (cell, entity) => {
        const actionObj = actions.find(a => a.name === "Found Village");
        const check = actionObj.canDo(cell, entity);
        if (!check.possible) return false;

        if (this.owner) {
          this.owner.consumeResources(check.cost);
        }

        this.actionPoints -= 1;

        if (this.grid) {
          this.grid.spawnEntity("village", cell, this.owner);
          this.grid.removeEntity(this.id);
        }

        return true;
      }
    });

    return actions;
  }
}
