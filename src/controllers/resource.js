import { ConstructEntity } from './constructEntity.js';

export default class ResourceController extends ConstructEntity {
  constructor(entityData, ownerPlayer, gridProxy, cell, initialState = null) {
    super(entityData, ownerPlayer, gridProxy, cell, initialState);
  }
}
