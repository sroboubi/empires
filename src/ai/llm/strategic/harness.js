/**
 * LlmStrategicManager — LLM-harness strategic AI (Phase 26).
 *
 * Runs once per turn, before the tactical AI, in three phases:
 *   0. Trade review — asks the LLM which active per-turn deals (if any)
 *      to cancel; the harness cancels only ids it validates against the
 *      player's real trades. The deterministic helper.reviewTrades is
 *      NOT used here — the strategic AI asks the LLM.
 *   A. Chats — asks the LLM, one player at a time, who (if anyone) to chat
 *      with, looping while it names a player and orders remain. Each chat
 *      costs 1 order (AiHelper.chat deducts); the prompt states the cost
 *      plainly, and there is no per-turn chat cap — the order budget is the
 *      bound. Stops on null target, orders out, or a chat failure. A chat
 *      target reply may carry a trade proposal — the harness opens the
 *      chat, then calls helper.initiateTrade with it, so the trade is
 *      negotiated inside the chat thread (existing machinery).
 *   B. Directive — asks the LLM for a structured {focus, stance, goals}
 *      directive, validates it, stamps setAtTurn/setBy, and RETURNS it.
 *      The engine stores a non-null return on player.controller.directive;
 *      an empty/invalid directive returns null, keeping the last valid one.
 *      (The manager cannot write the directive itself — the AI proxy is
 *      read-only — so the return value is the channel.)
 *
 * Extends LlmBaseManager for the LLM client, chat flow, trade evaluation,
 * and summarizers. Re-points this.controller at the strategic controller
 * (BaseManager points it at the tactical one), so getLLMClient reads the
 * strategic entry's provider/model.
 */
import { LlmBaseManager } from '../llmBase.js';
import { DEFAULT_PROMPT_URLS } from '../promptUrls.js';
import {
    validateDirective,
    DIRECTIVE_FOCUS_VALUES,
    DIRECTIVE_STANCE_VALUES,
    DIRECTIVE_GOAL_TYPES
} from '../../strategic/directive.js';

/**
 * The chat-target reply: an integer id to chat with, or null to stop
 * ("no more chats"). tradeProposal is nullable — set only when the model
 * wants to open a trade in that chat. Both fields are listed as required
 * (strict providers want every property in `required`) but accept null, so
 * the stop reply is legal instead of a schema violation.
 */
const CHAT_TARGET_SCHEMA = {
    type: 'object',
    properties: {
        targetPlayerId: { type: ['integer', 'null'] },
        // Optional trade proposal for the chat target — trade is built
        // into chat: the harness opens the chat, then calls
        // helper.initiateTrade with this offer, so the negotiation happens
        // inside the chat thread.
        tradeProposal: {
            type: ['object', 'null'],
            properties: {
                type: { type: 'string', enum: ['one_time', 'per_turn'] },
                gives: { type: 'object' },
                asks: { type: 'object' }
            },
            required: ['type', 'gives', 'asks']
        }
    },
    required: ['targetPlayerId', 'tradeProposal']
};

/**
 * The trade-review reply: which active per-turn deals (if any) to cancel.
 * Ids are validated against the player's real trades before anything is
 * canceled — a bogus or foreign id is ignored, never trusted.
 */
const TRADE_REVIEW_SCHEMA = {
    type: 'object',
    properties: {
        cancelTradeIds: { type: 'array', items: { type: 'string' } }
    },
    required: ['cancelTradeIds']
};

/**
 * Validates a trade proposal from the chat-target reply and maps it into
 * initiateTrade's frame ({type, proposerGives, proposerAsks}). Returns
 * null when the proposal is malformed — a bad proposal is ignored, never
 * sent (initiateTrade would reject it anyway, but failing early keeps a
 * bad LLM reply from burning a chat).
 * @param {*} raw
 * @returns {Object|null}
 */
function normalizeTradeProposal(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.type !== 'one_time' && raw.type !== 'per_turn') return null;
    const bundle = (b) => {
        if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
        const entries = Object.entries(b);
        if (!entries.length) return null;
        const out = {};
        for (const [res, amt] of entries) {
            if (typeof amt !== 'number' || !Number.isFinite(amt) || amt <= 0) return null;
            out[String(res)] = Math.floor(amt);
        }
        return out;
    };
    const gives = bundle(raw.gives);
    const asks = bundle(raw.asks);
    if (!gives || !asks) return null;
    return { type: raw.type, proposerGives: gives, proposerAsks: asks };
}

const DIRECTIVE_SCHEMA = {
    type: 'object',
    properties: {
        focus: { type: 'string', enum: DIRECTIVE_FOCUS_VALUES },
        stance: {
            type: 'object',
            additionalProperties: { type: 'string', enum: DIRECTIVE_STANCE_VALUES }
        },
        goals: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    type: { type: 'string', enum: DIRECTIVE_GOAL_TYPES }
                },
                required: ['type']
            }
        }
    },
    required: ['focus']
};

/**
 * Extracts a JSON object from an LLM reply: a parsed object passes through,
 * a string is parsed (fenced ```json blocks stripped, surrounding prose
 * ignored). Returns null when nothing parseable is found.
 * @param {*} raw
 * @returns {Object|null}
 */
export function extractJsonObject(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    let text = String(raw).trim();
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    if (fence) text = fence[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
}

export class LlmStrategicManager extends LlmBaseManager {
    constructor(player, helper) {
        super(player, helper);
        // The strategic controller is this manager's own controller.
        this.controller = player.strategicController || player.controller;
        this.cachedStrategicPrompt = null;
    }

    async getStrategicSystemPrompt() {
        if (this.cachedStrategicPrompt) return this.cachedStrategicPrompt;
        const response = await fetch(DEFAULT_PROMPT_URLS.strategic);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const md = await response.text();
        this.cachedStrategicPrompt = md
            .replace('{NAME}', this.player.name)
            .replace('{DESCRIPTION}', this.personaBlock());
        return this.cachedStrategicPrompt;
    }

    /**
     * The empire summary (design §6): full detail on what the director
     * needs to decide, summarized elsewhere, nothing it must not see.
     * Reuses the tactical summarizers where they fit (unit counts, resource
     * profile); the per-entity dump of summarizeGameState is deliberately
     * NOT reused — the director decides direction, not unit orders.
     * @returns {Object}
     */
    buildEmpireSummary() {
        const profile = this.player.getResourceProfile() || {};
        const countByName = (list) => {
            const m = new Map();
            for (const e of list || []) m.set(e.name, (m.get(e.name) || 0) + 1);
            return Object.fromEntries(m);
        };
        const opponents = {};
        for (const [id, opp] of Object.entries(this.player.getOpponents?.() || {})) {
            opponents[id] = {
                name: opp.name,
                score: opp.score,
                units: countByName(opp.entities || [])
            };
        }
        // Recent diplomatic notes (the 1–2 sentence summaries), not full history.
        const recentNotes = [];
        try {
            for (const entry of this.player.getHistory?.() || []) {
                if (entry.category === 'note') recentNotes.push(entry.details);
                if (recentNotes.length >= 5) break;
            }
        } catch {
            // History is best-effort — a missing note must not fail the turn.
        }
        return {
            round: this.gameState.currentRound,
            orders: this.player.orders,
            maxOrders: this.player.maxOrders,
            resources: { ...(profile.stock || {}) },
            netIncome: { ...(profile.netIncome || {}) },
            turnsRemaining: { ...(profile.turnsRemaining || {}) },
            criticalResource: profile.criticalResource || null,
            score: this.player.score,
            units: countByName(this.player.getEntities?.() || []),
            opponents,
            exploredPercent: this.helper.getCellCount?.()
                ? Math.round((this.player.exploredCells?.size || 0) / this.helper.getCellCount() * 100)
                : null,
            activeTrades: (profile.activeTrades || []).map(t => ({
                id: t.id,
                type: t.type,
                withPlayerId: String(t.player1Id) === String(this.player.id) ? t.player2Id : t.player1Id,
                send: String(t.player1Id) === String(this.player.id) ? t.bundle1 : t.bundle2,
                receive: String(t.player1Id) === String(this.player.id) ? t.bundle2 : t.bundle1
            })),
            recentNotes
        };
    }

    /**
     * Phase 0 — trade review (LLM-driven). Presents the player's active
     * per-turn trades with affordability and asks the LLM which, if any,
     * to cancel. Only ids validated against the player's real trades are
     * canceled; a bogus or foreign id is ignored. Skipped entirely when
     * the player has no active trades (no LLM call spent). The
     * deterministic helper.reviewTrades() is deliberately NOT used here.
     * @returns {Promise<void>}
     */
    async runTradeReviewPhase() {
        const gs = this.gameState;
        if (!gs || typeof gs.getActiveTradesForPlayer !== 'function') return;
        // Only per-turn agreements can be canceled here: a one-time trade is
        // settled immediately and is never active. (The deterministic policy
        // skips other types too — see AiHelper.reviewTrades.)
        const trades = (gs.getActiveTradesForPlayer(this.player) || [])
            .filter(t => t.type === 'per_turn');
        if (!trades.length) return;

        const client = this.getLLMClient();
        const systemPrompt = await this.getStrategicSystemPrompt();
        const lines = trades.map(t => {
            const isP1 = String(t.player1Id) === String(this.player.id);
            const send = isP1 ? t.bundle1 : t.bundle2;
            const receive = isP1 ? t.bundle2 : t.bundle1;
            const otherId = isP1 ? t.player2Id : t.player1Id;
            const affordable = this.player.hasResources?.(send) ?? true;
            return `- id "${t.id}" (${t.type}) with player ${otherId}: you send ${JSON.stringify(send)} each round, receive ${JSON.stringify(receive)} each round. Affordable right now: ${affordable ? 'yes' : 'NO'}.`;
        });
        const userContent = `Your active per-turn trade agreements:\n${lines.join('\n')}\n\n`
            + `Which of these agreements, if any, do you want to cancel? A canceled agreement stops `
            + `exchanging resources from the next round. Reply with a JSON object `
            + `{"cancelTradeIds": ["<id>", ...]} or {"cancelTradeIds": []} to keep them all.`;
        let raw = null;
        try {
            raw = await client.generate(userContent, systemPrompt, {
                responseSchema: TRADE_REVIEW_SCHEMA,
                temperature: 0.3,
                thinkingBudget: 0,
                maxOutputTokens: 200
            });
        } catch (err) {
            console.error(`[Strategic] Trade-review call failed for ${this.player.name}:`, err);
            return;
        }
        if (!raw) return;
        const parsed = extractJsonObject(raw);
        const ids = Array.isArray(parsed?.cancelTradeIds) ? parsed.cancelTradeIds : [];
        let canceled = 0;
        for (const id of ids) {
            const trade = trades.find(t => String(t.id) === String(id));
            if (!trade) {
                console.log(`[Strategic] ${this.player.name} named an unknown trade to cancel: ${id} — ignoring.`);
                continue;
            }
            if (typeof gs.cancelTrade === 'function' && gs.cancelTrade(trade.id)) {
                canceled++;
                this.helper.aiLog?.(
                    this.player, 'trade',
                    `Canceled per-turn agreement ${trade.id} on the director's orders.`
                );
            }
        }
        if (canceled > 0) {
            await this.helper.onActionDone?.(gs, null, 'AI canceled a per-turn trade agreement');
        }
    }

    /**
     * Phase A — chat loop. One LLM call per round of asking: "who, if
     * anyone, do you want to chat with?" Each chat goes through the
     * existing AiHelper.chat (1 order deducted, AI–AI loop / modal as today).
     * When the reply carries a trade proposal, the harness opens the chat
     * first, then calls helper.initiateTrade with it — the proposal, the
     * decision, and the outcome are all recorded in the chat thread by
     * initiateTrade's own machinery.
     * @returns {Promise<void>}
     */
    async runChatPhase() {
        while ((this.player.orders ?? 0) >= 1) {
            const choice = await this.chooseChatTarget();
            if (!choice || choice.targetId == null) return;
            const targetId = choice.targetId;
            const target = (this.gameState.players || []).find(p => String(p.id) === String(targetId));
            if (!target || String(target.id) === String(this.player.id)) {
                console.error(`[Strategic] ${this.player.name} named an unknown chat target: ${targetId}`);
                return;
            }
            let ok = false;
            try {
                ok = await this.helper.chat(this.player, target);
            } catch (err) {
                console.error(`[Strategic] Chat with ${target.name} failed for ${this.player.name}:`, err);
                return;
            }
            if (!ok) return;
            if (choice.tradeProposal && typeof this.helper?.initiateTrade === 'function') {
                try {
                    // The proposal entry carries the proposer's emote from
                    // the chat that just happened (the last message they
                    // sent in this thread) — the proposal itself is a
                    // system line, so it has no emote of its own.
                    let proposalEmote = null;
                    try {
                        const history = this.gameState.getChatHistory?.(this.player, target) || [];
                        for (let i = history.length - 1; i >= 0; i--) {
                            const m = history[i];
                            if (m.senderId === this.player.id || m.sender === this.player.name) {
                                proposalEmote = m.emote || null;
                                break;
                            }
                        }
                    } catch {}
                    const result = await this.helper.initiateTrade(this.player, target, choice.tradeProposal, proposalEmote);
                    this.helper.aiLog?.(
                        this.player, 'trade',
                        `Proposed ${choice.tradeProposal.type} to ${target.name} in chat -> ${result.status}${result.reason ? ` (${result.reason})` : ''}`
                    );
                } catch (err) {
                    console.error(`[Strategic] Trade proposal to ${target.name} failed for ${this.player.name}:`, err);
                }
            }
        }
    }

    /**
     * One LLM call: who (if anyone) to chat with next, and whether to
     * propose a trade to them. Returns {targetId, tradeProposal} (proposal
     * null when absent or malformed), or null for "no more chats" /
     * unparseable / failed call.
     * @returns {Promise<{targetId: number, tradeProposal: Object|null}|null>}
     */
    async chooseChatTarget() {
        const client = this.getLLMClient();
        const systemPrompt = await this.getStrategicSystemPrompt();
        const summary = this.buildEmpireSummary();
        const players = (this.gameState.players || [])
            .filter(p => String(p.id) !== String(this.player.id))
            .map(p => ({ id: p.id, name: p.name, totalScore: p.score?.total ?? p.score }));
        const userContent = `Current empire state:\n${JSON.stringify(summary, null, 2)}\n\n`
            + `Other players: ${JSON.stringify(players)}\n\n`
            + `You have ${this.player.orders} of ${this.player.maxOrders} orders remaining. `
            + `Each chat costs 1 order, shared with your tactical general.\n\n`
            + `Who, if anyone, do you want to chat with this turn? Reply with a JSON object `
            + `{"targetPlayerId": <player id>, "tradeProposal": {"type": "one_time" | "per_turn", "gives": {"<resource>": <amount>}, "asks": {"<resource>": <amount>}} | null} `
            + `or {"targetPlayerId": null, "tradeProposal": null} when you want no more chats. Include a tradeProposal only `
            + `when you want to open a trade with that player in this chat; otherwise use null.`;
        let raw = null;
        try {
            raw = await client.generate(userContent, systemPrompt, {
                responseSchema: CHAT_TARGET_SCHEMA,
                temperature: 0.3,
                thinkingBudget: 0,
                maxOutputTokens: 200
            });
        } catch (err) {
            console.error(`[Strategic] Chat-target call failed for ${this.player.name}:`, err);
            return null;
        }
        if (!raw) return null;
        const parsed = extractJsonObject(raw);
        if (!parsed || parsed.targetPlayerId == null) return null;
        const id = parsed.targetPlayerId;
        if (typeof id !== 'number' && !/^\d+$/.test(String(id))) return null;
        return { targetId: Number(id), tradeProposal: normalizeTradeProposal(parsed.tradeProposal) };
    }

    /**
     * Phase B — directive. One LLM call returning the structured directive.
     * Invalid/empty output returns null (keep last valid); the harness
     * stamps setAtTurn/setBy on a valid one before returning it.
     * @returns {Promise<Object|null>}
     */
    async proposeDirective() {
        const client = this.getLLMClient();
        const systemPrompt = await this.getStrategicSystemPrompt();
        const summary = this.buildEmpireSummary();
        const userContent = `Current empire state:\n${JSON.stringify(summary, null, 2)}\n\n`
            + `Give your directive for this turn as a JSON object with "focus", "stance" `
            + `(keyed by player id), and "goals" (ordered by priority). Reply with ONLY the JSON object.`;
        let raw = null;
        try {
            raw = await client.generate(userContent, systemPrompt, {
                responseSchema: DIRECTIVE_SCHEMA,
                temperature: 0.3,
                thinkingBudget: 0,
                maxOutputTokens: 1000
            });
        } catch (err) {
            console.error(`[Strategic] Directive call failed for ${this.player.name}:`, err);
            return null;
        }
        if (!raw) return null;
        const parsed = extractJsonObject(raw);
        const validated = validateDirective(parsed, this.gameState, this.player.id);
        if (!validated) {
            console.log(`[Strategic] ${this.player.name} produced an invalid directive — keeping the last valid one.`);
            return null;
        }
        validated.setAtTurn = this.gameState.currentRound;
        validated.setBy = this.controller?.key ?? null;
        return validated;
    }

    /**
     * The strategic turn: LLM trade review, then chats (with trade
     * proposals), then the directive. A failure in any phase is logged and
     * swallowed — the tactical turn still runs (design §8; Player.step()
     * also guards the call).
     * @returns {Promise<Object|null>} the validated directive, or null
     */
    async runStrategicTurn() {
        try {
            await this.runTradeReviewPhase();
        } catch (err) {
            console.error(`[Strategic] Trade review failed for player ${this.player.name}:`, err);
        }
        try {
            await this.runChatPhase();
        } catch (err) {
            console.error(`[Strategic] Chat phase failed for player ${this.player.name}:`, err);
        }
        try {
            return await this.proposeDirective();
        } catch (err) {
            console.error(`[Strategic] Directive phase failed for player ${this.player.name}:`, err);
            return null;
        }
    }
}

export default LlmStrategicManager;
