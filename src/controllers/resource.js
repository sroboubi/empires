export default class ResourceController {
  constructor(entity, cell, gameState) {
    this.entity = entity;
    this.cell = cell;
    this.gameState = gameState;
  }

  info() {
    return `Resource Deposit: ${this.entity.name}. Can be harvested by Workers.`;
  }

  step() {
    // Resources are static
  }

  actions() {
    return [];
  }
}
