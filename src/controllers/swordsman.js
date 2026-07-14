export default class SwordsmanController {
  constructor(entity, cell, gameState) {
    this.entity = entity;
    this.cell = cell;
    this.gameState = gameState;
  }

  info() {
    return `Swordsman: Combat unit. Owner ID: ${this.entity.ownerId || 'None'}.`;
  }

  step() {
    // No-op for now
  }

  actions() {
    return ["Move", "Attack"];
  }
}
