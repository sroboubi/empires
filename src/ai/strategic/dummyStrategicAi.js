/**
 * DummyStrategicAi (Phase 26) — coded strategic AI for testing the interface.
 *
 * Returns a fixed directive from its controller config (config.directive),
 * validated with the same rule the LLM harness uses, and chats with nobody.
 * Exists to exercise: setting the directive, trade housekeeping, orders
 * accounting, and the strategic-failure fallback — without any LLM.
 *
 * Trade housekeeping: like the LLM strategic harness, it reviews per-turn
 * deals at the start of its turn (the strategic AI owns trade now).
 */
import { StrategicBaseManager } from './base.js';
import { validateDirective } from './directive.js';

export class DummyStrategicAi extends StrategicBaseManager {
    async runStrategicTurn() {
        // Trade housekeeping is the strategic AI's job (Phase 26): review
        // per-turn deals before anything else. Guarded — a missing helper
        // method (e.g. a minimal test double) must not fail the turn.
        if (typeof this.helper?.reviewTrades === 'function') {
            try {
                await this.helper.reviewTrades(this.player);
            } catch (err) {
                console.error(`[DummyStrategic] Trade review failed for player ${this.player.name}:`, err);
            }
        }

        // Fixed directive from config; chats with nobody.
        const cfg = this.controller?.config || {};
        const validated = validateDirective(cfg.directive, this.gameState, this.player.id);
        if (!validated) return null;
        validated.setAtTurn = this.gameState.currentRound;
        validated.setBy = this.controller?.key ?? null;
        return validated;
    }

    /**
     * Canned reply: the dummy never negotiates. Another player chatting
     * with it gets a polite close, so the chat loop terminates.
     */
    async generateChatReply(otherPlayer, contextPrompt = null) {
        return {
            content: `${this.player.name} has nothing to discuss at this time.`,
            ended: true
        };
    }

    async summarizeChatAndAddNote(otherPlayer) {
        // The dummy keeps no diplomatic notes.
    }
}

export default DummyStrategicAi;
