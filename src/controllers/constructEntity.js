import { BaseEntity } from './baseEntity.js';

/**
 * ConstructEntity - Base Class for stationary constructs and buildings.
 */
export class ConstructEntity extends BaseEntity {
  constructor(entityData, ownerPlayer, gameState, cell, initialState = null) {
    super(entityData, ownerPlayer, gameState, cell, initialState);
  }

  get isConstruct() {
    return true;
  }
}
