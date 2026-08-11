import { ConstructEntity } from './constructEntity.js';

export default class VillageController extends ConstructEntity {
  constructor(entityData, ownerPlayer, gameState, cell, initialState = null) {
    super(entityData, ownerPlayer, gameState, cell, initialState);
  }
}
