import { ConstructEntity } from './constructEntity.js';

export default class ResourceController extends ConstructEntity {
  constructor(entityData, ownerPlayer, gridProxy, cell, initialState = null) {
    super(entityData, ownerPlayer, gridProxy, cell, initialState);

    if (!initialState) {
      this.state.maxHealth = 50;
      this.state.health = 50;
    }
  }
}
