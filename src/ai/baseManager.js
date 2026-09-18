/**
 * BaseManager
 * Abstract base class for AI turn controllers (e.g. SmartManager, Harness).
 * Provides unified interface and access to player and gameState references.
 */
export class BaseManager {
    /**
     * @param {Player} player
     * @param {GameState} gameState
     */
    constructor(player, gameState, controller) {
        if (!player || !gameState) {
            throw new Error('BaseManager requires both player and gameState references.');
        }
        this.player = player;
        this.gameState = gameState;
        this.controller = controller;
    }

    /**
     * Executes the AI decision-making cycle for the current turn.
     * Must be implemented by subclasses.
     * @returns {Promise<void>}
     */
    async processTurn() {
        throw new Error('processTurn() must be implemented by subclass.');
    }
}
