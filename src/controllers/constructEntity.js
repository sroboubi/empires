import { BaseEntity } from './baseEntity.js';

/**
 * ConstructEntity - Base Class for stationary constructs and buildings.
 * Extends BaseEntity with passive resource production hooks on turn step.
 */
export class ConstructEntity extends BaseEntity {
  constructor(entityData, ownerPlayer, gridProxy, cell, initialState = null) {
    super(entityData, ownerPlayer, gridProxy, cell, initialState);

    this.category = 'construct';

    if (!initialState) {
      this.state.yields = this.data.yields || {};
    }
  }

  /**
   * Turn step hook: adds resource yields to owner's pool.
   */
  step(globalContext) {
    super.step(globalContext);

    if (this.owner && this.state.yields) {
      this.owner.addResources(this.state.yields);
    }
  }

  info() {
    const ownerName = this.owner ? this.owner.name : 'Neutral';
    let yieldStr = '';
    if (this.state.yields) {
      yieldStr = Object.entries(this.state.yields)
        .map(([k, v]) => `+${v} ${k}`)
        .join(', ');
    }
    return `${this.name.toUpperCase()} (Construct). Owner: ${ownerName}. HP: ${this.state.health}/${this.state.maxHealth}.${yieldStr ? ` Income/turn: ${yieldStr}` : ''}`;
  }
}
