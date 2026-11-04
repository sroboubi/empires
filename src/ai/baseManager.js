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
 *
 * NOTE: BaseManager does NOT apply the AI interface proxy itself. The game
 * constructs managers via createAiManager() (src/aiInterfaceProxy.js), which
 * wraps player/gameState in read-only proxies before handing them here.
 * AI code in src/ai/ must never import the proxy module.
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
        throw new Error('processTurn() must be implemented by subclass');
    }

    /**
     * Generates a diplomatic chat reply to another player.
     * Every AI must implement this — even non-LLM AIs, which can return
     * a canned reply with ended: true. This keeps chat universal: any
     * player can talk to any other player without knowing its AI type.
     * @param {Player} otherPlayer
     * @param {string} [contextPrompt]
     * @returns {Promise<{ content: string, ended: boolean }>}
     */
    async generateChatReply(otherPlayer, contextPrompt = null) {
        throw new Error('generateChatReply() must be implemented by subclass.');
    }

    /**
     * Summarizes a diplomatic conversation and saves a note to player history.
     * Must be implemented by subclasses.
     * @param {Player} otherPlayer
     */
    async summarizeChatAndAddNote(otherPlayer) {
        throw new Error('summarizeChatAndAddNote() must be implemented by subclass.');
    }
}
