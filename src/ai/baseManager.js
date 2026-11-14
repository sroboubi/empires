/**
 * BaseManager
 * Abstract base class for AI turn controllers (e.g. SmartManager, Harness).
 * Provides unified interface and access to player and gameState references.
 *
 * The `helper` is the engine's `AiHelper` instance: the AI module's
 * only channel to engine features (hex distance, config, renderer callbacks,
 * etc.). It is required — the constructor throws without it. (An earlier
 * docstring called it optional; the code has always required both arguments.)
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

    /**
     * Handles a diplomatic trade proposal from another player.
     * Default implementation politely rejects the offer (used by standard and tactical AIs).
     * @param {Player} proposer
     * @param {Object} offer - { type: 'one_time'|'per_turn', proposerGives: Object, proposerAsks: Object }
     * @returns {Promise<{ action: 'accept'|'counter'|'reject', message: string, counterOffer?: Object }>}
     */
    async handleTradeOffer(proposer, offer) {
        return {
            action: 'reject',
            message: `${this.player.name} declines the trade offer.`
        };
    }

    /**
     * Reviews the AI's active per-turn trade agreements and cancels the ones
     * it can no longer honour. Runs at the start of the AI's turn, before
     * processTurn(), so a cancellation takes effect before the round-end
     * exchange.
     *
     * The default policy is objective: keep a deal while the outgoing bundle
     * is affordable, cancel it otherwise (a permanently unaffordable deal
     * would otherwise be skipped every round forever). Subclasses may
     * override this for a richer diplomatic policy.
     * @returns {Promise<void>}
     */
    async reviewTrades() {
        const gs = this.gameState;
        if (!gs || typeof gs.getActiveTradesForPlayer !== 'function') return;

        const trades = gs.getActiveTradesForPlayer(this.player) || [];
        let canceled = 0;
        for (const trade of trades) {
            if (trade.type !== 'per_turn') continue;
            // Give an agreement at least one round-end exchange before the
            // affordability check can cancel it — it may have just been signed.
            if (trade.createdRound >= gs.currentRound) continue;

            const isP1 = String(trade.player1Id) === String(this.player.id);
            const outgoing = isP1 ? trade.bundle1 : trade.bundle2;
            if (this.player.hasResources(outgoing)) continue;

            if (gs.cancelTrade(trade.id)) {
                canceled++;
                this.helper.aiLog?.(
                    this.player,
                    'trade',
                    `Canceled per-turn agreement ${trade.id}: cannot afford to send ${this.helper.formatResourceBundle(outgoing)}.`
                );
            }
        }

        if (canceled > 0) {
            // Refresh the human UI and record a replay snapshot, matching the
            // normal AI-action path. No-op in headless runs.
            await this.helper.onActionDone?.(gs, null, 'AI canceled a per-turn trade agreement');
        }
    }
}
