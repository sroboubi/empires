import { ConstructEntity } from './constructEntity.js';

export default class FarmController extends ConstructEntity {
  constructor(entityData, ownerPlayer, gridProxy, cell, initialState = null) {
    super(entityData, ownerPlayer, gridProxy, cell, initialState);

    if (!initialState) {
      this.state.maxHealth = 100;
      this.state.health = 100;
      this.state.yields = { food: 15 };
    }
  }
}
