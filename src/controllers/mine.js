export default class MineController {
  constructor(entity, cell, gameState) {
    this.entity = entity;
    this.cell = cell;
    this.gameState = gameState;
  }

  info() {
    return `Mine: Extracts iron and minerals. Owner ID: ${this.entity.ownerId || 'None'}.`;
  }

  step() {
    // No-op for now
  }

  actions() {
    return [];
  }
}
