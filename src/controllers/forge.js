export default class ForgeController {
  constructor(entity, cell, gameState) {
    this.entity = entity;
    this.cell = cell;
    this.gameState = gameState;
  }

  info() {
    return `Forge: Refines iron into weapons. Owner ID: ${this.entity.ownerId || 'None'}.`;
  }

  step() {
    // No-op for now
  }

  actions() {
    return [];
  }
}
