import { UnitEntity } from './unitEntity.js';

export default class HorsemanController extends UnitEntity {
  constructor(entityData, ownerPlayer, gridProxy, cell, initialState = null) {
    super(entityData, ownerPlayer, gridProxy, cell, initialState);

    if (!initialState) {
      this.state.maxMovementPoints = 3;
      this.state.movementPoints = 3;
      this.state.attackPower = 14;
      this.state.range = 1;
      this.state.armor = 1;
      this.state.maxHealth = 100;
      this.state.health = 100;
    }
  }
}
