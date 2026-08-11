import { UnitEntity } from './unitEntity.js';

export default class WorkerController extends UnitEntity {
  constructor(entityData, ownerPlayer, gameState, cell, initialState = null) {
    super(entityData, ownerPlayer, gameState, cell, initialState);
  }
}
