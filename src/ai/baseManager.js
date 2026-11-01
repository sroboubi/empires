/**
 * BaseManager
 * Abstract base class for AI turn controllers (e.g. SmartManager, Harness).
 * Provides unified interface and access to player and gameState references.
 *
 * The optional `helper` is the engine's `AiHelper` instance: the AI module's
 * only channel to engine features (hex distance, config, renderer callbacks,
 * etc.). A user-provided manager may ignore it, but the built-in managers rely
 * on it. It is optional so a custom manager can still be constructed with the
 * original three arguments.
 */
export class BaseManager {
    /**
     * @param {Player} player    
     * @param {import('../aiHelper.js').AiHelper} [helper]
     */
    constructor(player, helper) {
        if (!player || !helper) {
            throw new Error('BaseManager requires both player and helper references.');
        }
        this.player = player;
        this.helper = helper;
        this.gameState = helper.getGameState();
        this.controller = player.controller;        
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
