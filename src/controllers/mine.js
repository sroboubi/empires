import { ConstructEntity } from './constructEntity.js';

export default class MineController extends ConstructEntity {
  constructor(entityData, ownerPlayer, gridProxy, cell, initialState = null) {
    super(entityData, ownerPlayer, gridProxy, cell, initialState);

    if (!initialState) {
      this.state.maxHealth = 150;
      this.state.health = 150;
      this.state.yields = { iron: 10, gold: 5 };
    }
  }
}
