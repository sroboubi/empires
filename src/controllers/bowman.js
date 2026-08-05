import { UnitEntity } from './unitEntity.js';

export default class BowmanController extends UnitEntity {
  constructor(entityData, ownerPlayer, gridProxy, cell, initialState = null) {
    super(entityData, ownerPlayer, gridProxy, cell, initialState);

    if (!initialState) {
      this.state.maxMovementPoints = 2;
      this.state.movementPoints = 2;
      this.state.attackPower = 12;
      this.state.range = 2;
      this.state.armor = 0;
      this.state.maxHealth = 80;
      this.state.health = 80;
    }
  }
}
