import { ConstructEntity } from './constructEntity.js';

export default class FarmController extends ConstructEntity {
  constructor(entityData, ownerPlayer, gridProxy, cell, initialState = null) {
    super(entityData, ownerPlayer, gridProxy, cell, initialState);
  }
}
