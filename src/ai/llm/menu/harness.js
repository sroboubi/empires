/**
 * Menu harness: the engine pre-computes every legal action as a numbered
 * option and the LLM picks one per response ({thoughtProcess, option, note}).
 * Select via controller URL 'llm/menu/harness.js'.
 */
import { LlmBaseManager } from '../llmBase.js';
import menuResponseSchema from './menu.response.schema.json' with { type: 'json' };
import { buildMenu, executeMenuAction, renderMenuPrompt, parseMenuResponse } from './menu.js';
import { serializeStateToMarkdown, summarizeTerrain } from '../markdown.js';
import { onActionDone } from '../../utils.js';
import { CONFIG } from '../../../config.js';

export class MenuHarness extends LlmBaseManager {
    constructor(player, gameState, controller) {
        super(player, gameState, controller);
        this.cachedMenuSystemPrompt = null;
        // Harness-only chat cooldowns: WeakMap<gameState, Map<pairKey, lastChatRound>>.
        // Shared across harness instances of the same game (both directions of a
        // pair share one entry). Lives entirely in the harness layer — game core
        // (gameState/player) is never modified.
        if (!MenuHarness.sharedChatCooldowns) {
            MenuHarness.sharedChatCooldowns = new WeakMap();
        }
    }

    cooldownMap() {
        let m = MenuHarness.sharedChatCooldowns.get(this.gameState);
        if (!m) {
            m = new Map();
            MenuHarness.sharedChatCooldowns.set(this.gameState, m);
        }
        return m;
    }

    chatPairKey(otherPlayer) {
        return [String(this.player.id), String(otherPlayer.id)].sort().join(':');
    }

    /** Rounds since this player last chatted with otherPlayer (Infinity if never). */
    roundsSinceChat(otherPlayer) {
        const last = this.cooldownMap().get(this.chatPairKey(otherPlayer));
        if (last == null) return Infinity;
        return this.gameState.currentRound - last;
    }

    recordChat(otherPlayer) {
        this.cooldownMap().set(this.chatPairKey(otherPlayer), this.gameState.currentRound);
    }

    async getMenuSystemPrompt() {
        if (this.cachedMenuSystemPrompt) return this.cachedMenuSystemPrompt;
        const absScoreToWin = this.gameState.settings?.winCondition?.absoluteScore;
        const relScoreToWin = this.gameState.settings?.winCondition?.relativeScore;
        const response = await fetch(CONFIG.MENU_PROMPT_URL);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const md = await response.text();
        this.cachedMenuSystemPrompt = md
            .replace('{NAME}', this.player.name)
            .replace('{DESCRIPTION}', this.personaBlock())
            .replace('{ABS_SCORE_TO_WIN}', absScoreToWin)
            .replace('{REL_SCORE_TO_WIN}', relScoreToWin);
        return this.cachedMenuSystemPrompt;
    }

    /**
     * Menu-interface turn: the engine pre-computes every legal action as a
     * numbered option and the LLM picks one per response. Mirrors the
     * structure of processTurn() (attempts, failure retry, action log) but
     * dispatches through menu.js instead of the JSON command schema.
     */

    async processTurn() {
        const client = this.getLLMClient();
        const menuSystemPrompt = await this.getMenuSystemPrompt();
        const menuCfg = this.player.controller?.config || {};

        let attempts = 4; // Safeguard against infinite loops
        let lastResponseError = null;
        let lastActionResult = null;
        let lastFailedLabel = null;
        const turnResponseLog = [];

        while (attempts > 0) {
            if (lastResponseError) attempts--;
            const manifestEntities = this.gameState.manifestData?.entities || this.gameState.manifestData || [];
            const manifestList = Array.isArray(manifestEntities) ? manifestEntities : Object.values(manifestEntities);
            const stateMd = serializeStateToMarkdown(this.summarizeGameState(), manifestList);
            // Rebuild the menu every iteration: actions execute and the state changes.
            let { options } = buildMenu(this.gameState, this.player, menuCfg);
            // Harness-only chat cooldown: drop "Chat with X" options still cooling down,
            // then renumber so option numbers stay dense.
            const cooldownTurns = menuCfg.chatCooldownTurns ?? 2;
            if (cooldownTurns > 0) {
                options = options.filter(opt => {
                    if (opt.action?.verb !== 'chat') return true;
                    const target = (this.gameState.players || []).find(p =>
                        p.name.toLowerCase() === String(opt.action.playerName || '').toLowerCase());
                    if (!target) return true;
                    return this.roundsSinceChat(target) >= cooldownTurns;
                });
                options.forEach((opt, i) => { opt.n = i + 1; });
            }
            const terrainMd = summarizeTerrain(this.gameState, this.player);
            let userContent = renderMenuPrompt(stateMd, options);
            if (terrainMd) userContent += '\n\n' + terrainMd;
            // Orders emphasis (probe v2): the 0-orders rule must be unmissable.
            userContent += `\n\n# ORDERS #\nYou have ${this.player.orders} of ${this.player.maxOrders} orders remaining.`;
            if ((this.player.orders ?? 0) <= 0) {
                userContent += `\nYou have 0 orders remaining. You cannot take any action this turn — no command is legal. You MUST end your turn.`;
            }
            if (lastResponseError) {
                userContent += `\n\n### Last Action Failed\n` +
                    (lastFailedLabel ? `* **Action Attempted**: ${lastFailedLabel}\n` : '') +
                    `* **Failure Reason**: ${lastResponseError}`;
            } else if (lastActionResult) {
                userContent += `\n\n### Last Action Result\n${lastActionResult}`;
            }
            if (turnResponseLog.length > 0) {
                userContent += `\n\n### Actions Taken This Turn (${turnResponseLog.length})\n` +
                    turnResponseLog.map((l, i) => `${i + 1}. ${l}`).join('\n');
            }

            const rawResponse = await client.generate(userContent, menuSystemPrompt, { responseSchema: menuResponseSchema });
            if (!rawResponse) {
                console.error(`Failed to process menu turn for player ${this.player.name}: No response received.`);
                return;
            }
            const parsed = parseMenuResponse(
                typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse), options);
            if (parsed.error) {
                lastResponseError = `${parsed.error} Reply with a JSON object {"thoughtProcess","option","note"}.`;
                lastFailedLabel = null;
                continue;
            }
            const { action, label, thoughtProcess, note } = parsed;

            if (action.verb === 'end') {
                this.player.addHistoryEntry(this.gameState.currentRound, { category: 'note', details: note });
                return;
            }
            if ((this.player.orders ?? 0) <= 0) {
                lastResponseError = `You have 0 orders remaining. Pick "End turn".`;
                lastFailedLabel = label;
                continue;
            }
            if (action.verb === 'chat') {
                const targetPlayer = (this.gameState.players || []).find(p =>
                    p.name.toLowerCase() === String(action.playerName || '').toLowerCase());
                if (!targetPlayer || targetPlayer.id === this.player.id) {
                    lastResponseError = `Chat target not found: "${action.playerName}".`;
                    lastFailedLabel = label;
                    continue;
                }
                // Initiating chat costs 1 order (parity with the JSON path).
                this.player.orders -= 1;
                this.player.addHistoryEntry(this.gameState.currentRound, {
                    category: 'action',
                    details: `Initiated diplomatic chat with ${targetPlayer.name} (costs 1 order)`
                });
                console.log(`[Harness] ${this.player.name} initiated diplomatic chat with ${targetPlayer.name}`);
                this.recordChat(targetPlayer);
                await this.chat(this.player, targetPlayer, thoughtProcess || null);
                await onActionDone(this.gameState, null, `Chat with ${targetPlayer.name}`);
                lastActionResult = `[completed] Concluded diplomatic session with ${targetPlayer.name}`;
                lastResponseError = null;
                lastFailedLabel = null;
                turnResponseLog.push(label);
                continue;
            }

            const outcome = executeMenuAction(this.gameState, this.player, action);
            if (outcome.ordersUsed === 0) {
                lastResponseError = outcome.result.message;
                lastFailedLabel = label;
                continue;
            }
            lastFailedLabel = null;
            lastActionResult = `[${outcome.result.status}] ${outcome.result.message}`;
            lastResponseError = null;
            await onActionDone(this.gameState, null, label);
            turnResponseLog.push(label);
        }
    }

    /**
     * Entity types worth describing in the system prompt catalog: what the
     * player owns, what those can build or repair (transitively, so units
     * trained later in the game are covered), and what is currently visible.
     * Everything else is omitted to keep the per-call prompt small; visible
     * enemies still get full details inline in the state markdown.
     * Falls back to the full manifest on any error (safe default).
     * @returns {string} sorted relevant type names, joined for cache comparison
     */

}

export default MenuHarness;
