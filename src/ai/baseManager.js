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

    /**
     * Initiates a chat between two players.
     * @param {Player} initiator
     * @param {Player} receiver
     * @param {string} [initialMessage]
     */
    async chat(initiator, receiver, initialMessage = null) {
        throw new Error('chat() must be implemented by subclass.');
    }

    /**
     * Summarizes the diplomatic conversation and saves a note to player history.
     * @param {Player} otherPlayer
     */
    async summarizeChatAndAddNote(otherPlayer) {
        throw new Error('summarizeChatAndAddNote() must be implemented by subclass.');
    }

    /**
     * Generates a diplomatic chat reply based on conversation history using the single client.
     * @param {Player} otherPlayer
     * @param {string} [contextPrompt]
     * @returns {Promise<{ content: string, ended: boolean }>}
     */
    async generateChatReply(otherPlayer, contextPrompt = null) {
        throw new Error('generateChatReply() must be implemented by subclass.');
    }
}
