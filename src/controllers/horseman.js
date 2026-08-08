import { UnitEntity } from './unitEntity.js';

export default class HorsemanController extends UnitEntity {
  constructor(entityData, ownerPlayer, gridProxy, cell, initialState = null) {
    super(entityData, ownerPlayer, gridProxy, cell, initialState);
  }
}

