export default class VillageController {
  constructor(entity, cell, gameState) {
    this.entity = entity;
    this.cell = cell;
    this.gameState = gameState;
  }

  info() {
    return `Village: Core settlement structure. Owner ID: ${this.entity.ownerId || 'None'}.`;
  }

  step() {
    // No-op for now
  }

  actions() {
    return ["Spawn Worker", "Spawn Settler"];
  }
}
