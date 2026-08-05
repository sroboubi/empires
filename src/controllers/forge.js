import { ConstructEntity } from './constructEntity.js';

export default class ForgeController extends ConstructEntity {
  constructor(entityData, ownerPlayer, gridProxy, cell, initialState = null) {
    super(entityData, ownerPlayer, gridProxy, cell, initialState);

    if (!initialState) {
      this.state.maxHealth = 180;
      this.state.health = 180;
      this.state.yields = { iron: 5, gems: 2 };
    }
  }
}
