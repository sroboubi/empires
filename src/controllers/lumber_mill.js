export default class LumberMillController {
  constructor(entity, cell, gameState) {
    this.entity = entity;
    this.cell = cell;
    this.gameState = gameState;
  }

  info() {
    return `Lumber Mill: Harvests wood. Owner ID: ${this.entity.ownerId || 'None'}.`;
  }

  step() {
    // No-op for now
  }

  actions() {
    return [];
  }
}
