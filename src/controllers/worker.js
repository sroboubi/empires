import { UnitEntity } from './unitEntity.js';
import { HexGrid } from '../hexGrid.js';

export default class WorkerController extends UnitEntity {
  constructor(entityData, ownerPlayer, gameState, cell, initialState = null) {
    super(entityData, ownerPlayer, gameState, cell, initialState);

    // Dynamic construct build definitions with default cost maps
    this.buildables = {
      "Build Farm": { construct: "farm" },
      "Build Mine": { construct: "mine" },
      "Build Lumber Mill": { construct: "lumberMill" },
      "Build Forge": { construct: "forge" }
    };

    this.setupWorkerActions();
  }

  setupWorkerActions() {
    // 1. Repair Construct Action
    this.actions.push({
      name: "Repair Construct",
      description: "Repair an adjacent construct, consuming all AP to restore HP.",
      canDo: (cell, entity) => {
        if (!this.active) return { possible: false, reason: "Worker is inactive." };
        if (this.actionPoints <= 0) return { possible: false, reason: "Worker has no Action Points left." };

        const target = entity || (this.gameState ? this.gameState.getEntityAt(cell?.q, cell?.r) : null);
        if (!target) return { possible: false, reason: "No target construct to repair." };
        if (target.category !== 'construct') return { possible: false, reason: "Target entity is not a construct." };
        if (target.health >= target.maxHealth) return { possible: false, reason: "Target construct is already at full health." };

        const dist = HexGrid.distance(this, cell || target);
        if (dist !== 1) return { possible: false, reason: "Target construct must be adjacent (1 cell away)." };

        const healAmount = 2 * this.actionPoints;
        return {
          possible: true,
          reason: `Repair ${target.name.toUpperCase()} for +${healAmount} HP consuming all ${this.actionPoints} AP.`,
          cost: this.actionPoints,
          healAmount: healAmount,
          targetConstruct: target
        };
      },
      do: (cell, entity) => {
        const actionObj = this.actions.find(a => a.name === "Repair Construct");
        const check = actionObj.canDo(cell, entity);
        if (!check.possible) return false;

        const ap = this.actionPoints;
        this.actionPoints = 0;
        const target = check.targetConstruct;
        target.health = Math.min(target.maxHealth, target.health + 2 * ap);

        return true;
      }
    });

    // 2. Buildable Constructs Actions
    for (const [actionName, config] of Object.entries(this.buildables)) {
      this.actions.push({
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

          const meta = this.gameState && this.gameState.manifestData ? this.gameState.manifestData.entities[config.construct] : null;
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
          const actionObj = this.actions.find(a => a.name === actionName);
          const check = actionObj.canDo(cell, entity);
          if (!check.possible) return false;

          if (this.owner) {
            this.owner.consumeResources(check.cost);
          }

          this.actionPoints -= 1;

          if (this.gameState) {
            this.gameState.spawnEntity(config.construct, cell, this.owner);
          }

          return true;
        }
      });
    }
  }
}
