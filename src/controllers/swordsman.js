import { UnitEntity } from './unitEntity.js';

export default class SwordsmanController extends UnitEntity {
  constructor(entityData, ownerPlayer, gridProxy, cell, initialState = null) {
    super(entityData, ownerPlayer, gridProxy, cell, initialState);

    if (!initialState) {
      this.state.maxMovementPoints = 2;
      this.state.movementPoints = 2;
      this.state.attackPower = 15;
      this.state.range = 1;
      this.state.armor = 2;
      this.state.maxHealth = 120;
      this.state.health = 120;
    }
  }
}
