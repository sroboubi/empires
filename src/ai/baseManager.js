import { initAI } from './deps.js';

/**
 * BaseManager
 * Abstract base class for AI turn controllers (e.g. SmartManager, Harness).
 * Provides unified interface and access to player and gameState references.
 *
 * The optional `deps` object is the AI module's only channel to the engine.
 * It is documented in `src/ai/deps.js` (AIDeps). A user-provided manager may
 * ignore it, but the built-in managers rely on it for HexGrid, config values,
 * and engine callbacks. `deps` is optional so a custom manager can still be
 * constructed with the original three arguments.
 */
export class BaseManager {
    /**
     * @param {Player} player
     * @param {GameState} gameState
     * @param {Object} [controller]
     * @param {import('./deps.js').AIDeps} [deps]
     */
    constructor(player, gameState, controller, deps = {}) {
        if (!player || !gameState) {
            throw new Error('BaseManager requires both player and gameState references.');
        }
        this.player = player;
        this.gameState = gameState;
        this.controller = controller;
        this.deps = deps || {};
        // Make the same dependencies available to standalone AI helpers.
        initAI(this.deps);
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
