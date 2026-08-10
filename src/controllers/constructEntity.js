import { BaseEntity } from './baseEntity.js';

/**
 * ConstructEntity - Base Class for stationary constructs and buildings.
 * Extends BaseEntity with passive resource production hooks on turn step.
 */
export class ConstructEntity extends BaseEntity {
  constructor(entityData, ownerPlayer, gameState, cell, initialState = null) {
    super(entityData, ownerPlayer, gameState, cell, initialState);

    this.category = 'construct';
  }

  getDefaults() {
    return {
      ...super.getDefaults(),
      category: 'construct',
      yields: {}
    };
  }

  /**
   * Turn step hook: adds resource yields to owner's pool if active.
   */
  step(globalContext) {
    super.step(globalContext);

    const yields = this.state.yields || this.data.yields;
    if (this.active && this.owner && yields) {
      this.owner.addResources(yields);
    }
  }

  info() {
    const ownerName = this.owner ? this.owner.name : 'Neutral';
    const yields = this.state.yields || this.data.yields;
    let yieldStr = '';
    if (yields) {
      yieldStr = Object.entries(yields)
        .map(([k, v]) => `+${v} ${k}`)
        .join(', ');
    }
    return `${this.name.toUpperCase()} (Construct). Owner: ${ownerName}. HP: ${Math.round(this.state.health)}/${this.maxHealth}.${yieldStr ? ` Income/turn: ${yieldStr}` : ''}`;
  }
}
