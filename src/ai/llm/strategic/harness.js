/**
 * LlmStrategicManager — LLM-harness strategic AI (Phase 26).
 *
 * Runs once per turn, before the tactical AI, in two phases:
 *   A. Chats — asks the LLM, one player at a time, who (if anyone) to chat
 *      with, looping while it names a player and orders remain. Each chat
 *      costs 1 order (AiHelper.chat deducts); the prompt states the cost
 *      plainly, and there is no per-turn chat cap — the order budget is the
 *      bound. Stops on null target, orders out, or a chat failure.
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
 * The chat-target reply is a single field; the schema pins it to an integer
 * so the model cannot ramble, while the code below still accepts null
 * (the "no more chats" answer). If a provider enforces the integer strictly
 * and the model wants to stop, generation fails instead — which the loop
 * treats as "stop chatting", the same safe outcome.
 */
const CHAT_TARGET_SCHEMA = {
    type: 'object',
    properties: {
        targetPlayerId: { type: 'integer' }
    },
    required: ['targetPlayerId']
};

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
     * Phase A — chat loop. One LLM call per round of asking: "who, if
     * anyone, do you want to chat with?" Each chat goes through the
     * existing AiHelper.chat (1 order deducted, AI–AI loop / modal as today).
     * @returns {Promise<void>}
     */
    async runChatPhase() {
        while ((this.player.orders ?? 0) >= 1) {
            const targetId = await this.chooseChatTarget();
            if (targetId == null) return;
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
        }
    }

    /**
     * One LLM call: who (if anyone) to chat with next. Returns the target
     * player id, or null for "no more chats" / unparseable / failed call.
     * @returns {Promise<number|null>}
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
            + `{"targetPlayerId": <player id>} or {"targetPlayerId": null} when you want no more chats.`;
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
        return (typeof id === 'number' || /^\d+$/.test(String(id))) ? Number(id) : null;
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
     * The strategic turn: trade housekeeping, then chats, then the directive.
     * A failure in any phase is logged and swallowed — the tactical turn
     * still runs (design §8; Player.step() also guards the call).
     * @returns {Promise<Object|null>} the validated directive, or null
     */
    async runStrategicTurn() {
        if (typeof this.helper?.reviewTrades === 'function') {
            try {
                await this.helper.reviewTrades(this.player);
            } catch (err) {
                console.error(`[Strategic] Trade review failed for player ${this.player.name}:`, err);
            }
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
