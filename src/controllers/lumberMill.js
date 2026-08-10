import { ConstructEntity } from './constructEntity.js';

export default class LumberMillController extends ConstructEntity {
  constructor(entityData, ownerPlayer, gridProxy, cell, initialState = null) {
    super(entityData, ownerPlayer, gridProxy, cell, initialState);

    if (!initialState) {
      this.state.maxHealth = 120;
      this.state.health = 120;
      this.state.yields = { wood: 15 };
    }
  }
}
