/**
 * JSON command harness: the LLM replies with structured JSON commands
 * (ATTACK/BUILD/REPAIR/EXPLORE/CHAT/END_TURN), validated against
 * response.schema.json. Select via controller URL 'llm/json/harness.js'.
 */
import { LlmBaseManager } from '../llmBase.js';
import responseSchema from './response.schema.json' with { type: 'json' };
import { attack, support, build, explore, onActionDone } from '../../utils.js';
import { manifestToMarkdown, serializeStateToMarkdown, summarizeTerrain } from '../markdown.js';
import { CONFIG } from '../../../config.js';

export class JsonHarness extends LlmBaseManager {
    constructor(player, gameState, controller) {
        super(player, gameState, controller);
        this.cachedCommandSystemPrompt = null;
        this.cachedManifestKey = null;
    }

    async processTurn() {
        const client = this.getLLMClient();
        const commandSystemPrompt = await this.getCommandSystemPrompt();

        let attempts = 4; // Safeguard against infinite loops
        let lastResponseError = null;
        let lastActionResult = null;
        let lastFailedCommand = null; // { command, targetDesc, entityId } for structured failure reporting
        let response = null;
        const turnResponseLog = [];

        while (attempts > 0) {
            if (lastResponseError) attempts--;
            const manifestEntities = this.gameState.manifestData?.entities || this.gameState.manifestData || [];
            const manifestList = Array.isArray(manifestEntities) ? manifestEntities : Object.values(manifestEntities);
            const stateMd = serializeStateToMarkdown(this.summarizeGameState(), manifestList);
            const terrainMd = summarizeTerrain(this.gameState, this.player);
            let userContent = stateMd;
            if (terrainMd) userContent += '\n\n' + terrainMd;
            if (lastResponseError) {
                if (lastFailedCommand) {
                    userContent += `\n\n### Last Action Failed\n* **Command Attempted**: ${lastFailedCommand.command} (${lastFailedCommand.target}) using ${lastFailedCommand.entityId}\n* **Failure Reason**: ${lastResponseError}`;
                } else {
                    userContent += `\n\n### Last Action Failed\n${lastResponseError}`;
                }
                // Echo only the failed command, never the model's reasoning:
                // echoing the full response re-sends thousands of tokens of
                // thoughtProcess every retry (measured ~6,600 tokens in a
                // late-game DeepSeek prompt) and grows the prompt each turn.
                if (response && typeof response === 'object') {
                    const { thoughtProcess, reasoning, ...commandOnly } = response;
                    const compact = JSON.stringify(commandOnly);
                    if (compact && compact !== '{}') userContent += `\nFailed response: ${compact.slice(0, 500)}`;
                }
            } else if (lastActionResult) {
                userContent += `\n\n### Last Action Result\n${lastActionResult}`;
            }
            if (turnResponseLog.length > 0) {
                userContent += `\n\n### Actions Taken This Turn (${turnResponseLog.length})\n` +
                    turnResponseLog.map((r, i) => `${i + 1}. ${this.describeAction(r)}`).join('\n');
            }

            console.debug("system prompt:", commandSystemPrompt);
            console.debug("user content:", userContent);

            response = await client.generate(userContent, commandSystemPrompt, { responseSchema });
            console.debug("response:", response);

            if (!response) {
                console.error(`Failed to process turn for player ${this.player.name}: No response received.`);
                return;
            }

            // Every response carries an explicit command field naming which
            // command it performs (one of ATTACK, REPAIR, BUILD, EXPLORE,
            // CHAT, END_TURN, enforced by the per-command schema). The
            // command determines which role-named fields are required —
            // there is no shared "target" whose meaning flips per command.
            const command = String(response.command || '').toUpperCase();
            let actorId = null;
            if (command === 'ATTACK') actorId = response.attackerId;
            else if (command === 'REPAIR') actorId = response.repairerId;
            else if (command === 'BUILD') actorId = response.builderId;
            else if (command === 'EXPLORE') actorId = response.explorerId;

            if (command === 'ATTACK' || command === 'REPAIR' || command === 'BUILD' || command === 'EXPLORE') {
                if (this.player.orders <= 0) {
                    lastResponseError = `You have 0 orders remaining. You cannot execute commands. End your turn with a note.`;
                    continue;
                }

                const entity = this.gameState.getEntityById(actorId);
                if (!entity) {
                    lastResponseError = `Actor entity not found: ${actorId}`;
                    continue;
                } else if (entity.owner !== this.player) {
                    lastResponseError = `Entity ${actorId} does not belong to you`;
                    continue;
                }

                let target = null;
                if (response.targetId) {
                    target = this.gameState.getEntityById(response.targetId);
                    if (!target) {
                        lastResponseError = `Target entity not found: ${response.targetId}`;
                        continue;
                    }
                }

                let ordersUsed = 0;
                let actionOutcome = null;
                if (command === "ATTACK") {
                    if (!response.targetId) {
                        lastResponseError = `Attack requires targetId (a specific visible enemy). entityName is for Build only — attacking a type name like "village" is rejected.`;
                        continue;
                    }
                    actionOutcome = attack(this.gameState, entity, target, this.player.orders);
                } else if (command === "REPAIR") {
                    if (!response.targetId) {
                        lastResponseError = `Repair requires targetId (a specific damaged entity). entityName is for Build only.`;
                        continue;
                    }
                    actionOutcome = support(this.gameState, entity, target, "Repair", this.player.orders);
                } else if (command === "BUILD") {
                    if (!response.entityName) {
                        lastResponseError = `Build requires entityName (must be in the builder's Builds list)`;
                        continue;
                    }
                    actionOutcome = build(this.gameState, entity, response.entityName);
                } else if (command === "EXPLORE") {
                    actionOutcome = explore(this.gameState, entity, response.direction, true);
                }

                ordersUsed = actionOutcome.ordersUsed;
                if (ordersUsed === 0) {
                    lastResponseError = actionOutcome.result.message;
                    // Store structured command info for the enhanced failure format
                    const targetDesc = command === 'BUILD' ? response.entityName :
                        command === 'EXPLORE' ? (response.direction || 'unexplored') :
                            response.targetId || 'unknown';
                    lastFailedCommand = {
                        command: command.charAt(0) + command.slice(1).toLowerCase(),
                        target: targetDesc,
                        entityId: actorId
                    };
                    lastActionResult = null;
                    continue;
                }
                lastFailedCommand = null;
                // Feed the outcome back to the LLM: completed, partial, or the failure reason
                lastActionResult = `[${actionOutcome.result.status}] ${actionOutcome.result.message}`;
                lastResponseError = null;

                // Action successfully executed: reconcile and render
                await onActionDone(this.gameState, null, this.describeAction(response));
                turnResponseLog.push(response);
            } else if (command === 'CHAT') {
                if (this.player.orders <= 0) {
                    lastResponseError = `You have 0 orders remaining. You cannot initiate diplomacy. End your turn with a note.`;
                    continue;
                }

                const targetPlayer = this.gameState.players.find(p =>
                    String(p.id) === String(response.targetPlayerId) ||
                    p.name.toLowerCase() === String(response.targetPlayerId || '').toLowerCase()
                );

                if (!targetPlayer) {
                    lastResponseError = `Target player not found: "${response.targetPlayerId}". Check opponent list for valid IDs or names.`;
                    continue;
                }

                if (targetPlayer.id === this.player.id) {
                    lastResponseError = `Cannot initiate diplomacy with yourself.`;
                    continue;
                }

                // Initiating chat costs 1 order
                this.player.orders -= 1;
                this.player.addHistoryEntry(this.gameState.currentRound, {
                    category: 'action',
                    details: `Initiated diplomatic chat with ${targetPlayer.name} (costs 1 order)`
                });

                console.log(`[Harness] ${this.player.name} initiated diplomatic chat with ${targetPlayer.name}`);
                await this.chat(this.player, targetPlayer, response.message || response.thoughtProcess);

                await onActionDone(this.gameState, null, `Chat with ${targetPlayer.name}`);
                lastActionResult = `[completed] Concluded diplomatic session with ${targetPlayer.name}`;
                lastResponseError = null;
                turnResponseLog.push(response);
            } else if (command === 'END_TURN') {
                this.player.addHistoryEntry(this.gameState.currentRound, { category: 'note', details: response.note });
                return;
            } else {
                lastResponseError = `Unknown command: "${response.command}". Respond with exactly one command field: ATTACK (attackerId + targetId), REPAIR (repairerId + targetId), BUILD (builderId + entityName), EXPLORE (explorerId + optional direction), CHAT (targetPlayerId + optional message), or END_TURN (note).`;
                continue;
            }
        }
    }

    /**
     * Returns the cached command system prompt or builds it dynamically if not cached.
     * The catalog inside it is filtered to relevant entity types, so the cache
     * is rebuilt when that set changes (new unit trained, new enemy sighted).
     * @returns {Promise<string>}
     */

    async getCommandSystemPrompt() {
        const key = this.relevantManifestKey();
        if (!this.cachedCommandSystemPrompt || key !== this.cachedManifestKey) {
            this.cachedCommandSystemPrompt = await this.buildCommandSystemPrompt(key);
            this.cachedManifestKey = key;
        }
        return this.cachedCommandSystemPrompt;
    }

    /**
     * Menu system prompt (cached; the menu has no manifest catalog).
     */

    relevantManifestKey() {
        try {
            const manifestEntities = this.gameState.manifestData?.entities || this.gameState.manifestData || [];
            const manifestList = Array.isArray(manifestEntities) ? manifestEntities : Object.values(manifestEntities);
            const byName = new Map(manifestList.map(m => [m.name, m]));
            const relevant = new Set();
            const addWithOutputs = (name) => {
                if (!name || relevant.has(name)) return;
                relevant.add(name);
                const def = byName.get(name);
                if (!def) return;
                for (const b of [...(def.buildables || []), ...(def.repairables || [])]) addWithOutputs(b);
            };
            for (const e of this.player.getEntities(this.gameState)) addWithOutputs(e.name);
            for (const e of this.gameState.entities || []) {
                if (this.player.isVisible?.(e.q, e.r)) relevant.add(e.name);
            }
            return [...relevant].sort().join(',');
        } catch {
            return '*';
        }
    }

    /**
     * Builds a structured, hybrid system prompt combining Markdown rules
     * and stringified JSON manifest data.
     * @param {string} [manifestKey] relevant type names from relevantManifestKey();
     *   '*' (or omitted) keeps the full manifest
     * @returns {Promise<string>} The formatted system prompt string.
     */

    async buildCommandSystemPrompt(manifestKey) {
        const manifestEntities = this.gameState.manifestData?.entities || this.gameState.manifestData || [];
        const manifestList = Array.isArray(manifestEntities) ? manifestEntities : Object.values(manifestEntities);
        const filtered = (!manifestKey || manifestKey === '*')
            ? manifestList
            : manifestList.filter(m => manifestKey.split(',').includes(m.name));
        const manifestMd = manifestToMarkdown(filtered);
        const absScoreToWin = this.gameState.settings?.winCondition?.absoluteScore;
        const relScoreToWin = this.gameState.settings?.winCondition?.relativeScore;

        const response = await fetch(CONFIG.COMMAND_PROMPT_URL);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const systemPromptMarkdown = await response.text();
        return systemPromptMarkdown
            .replace('{NAME}', this.player.name)
            .replace('{DESCRIPTION}', this.player.description ? `You are described as: ${this.player.description}` : '')
            .replace('{ABS_SCORE_TO_WIN}', absScoreToWin)
            .replace('{REL_SCORE_TO_WIN}', relScoreToWin)
            .replace('{MANIFEST}', manifestMd);
    }

    /**
     * Initiates a chat between two players.
     * Handles both AI-to-AI background chat (capped at 20 exchanges)
     * and AI-to-Human interactive chat (opens chat modal overlay).
     * @param {Player} initiator
     * @param {Player} receiver
     * @param {string} [initialMessage]
     */

    describeAction(r) {
        const cmd = String(r.command || '').toUpperCase();
        if (cmd === 'ATTACK') return `Attack ${r.targetId || 'unknown'} with ${r.attackerId || 'unknown'}`;
        if (cmd === 'REPAIR') return `Repair ${r.targetId || 'unknown'} with ${r.repairerId || 'unknown'}`;
        if (cmd === 'BUILD') return `Build ${r.entityName || 'unknown'} with ${r.builderId || 'unknown'}`;
        if (cmd === 'EXPLORE') return `Explore ${r.direction || 'unexplored'} with ${r.explorerId || 'unknown'}`;
        if (cmd === 'CHAT') return `Chat with ${r.targetPlayerId || 'unknown'}`;
        if (cmd === 'END_TURN') return `End turn`;
        return `Unknown action`;
    }

}

export default JsonHarness;
