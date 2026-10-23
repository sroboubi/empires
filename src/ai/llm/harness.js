import { BaseManager } from "../baseManager.js";
import { LLMClient } from "./client.js";
import responseSchema from './response.schema.json' with { type: 'json' };
import { attack, support, build, explore, onActionDone } from "../utils.js";
import { HexGrid } from '../../hexGrid.js';
import { manifestToMarkdown, serializeStateToMarkdown, summarizeTerrain } from "./markdown.js";

export class Harness extends BaseManager {
    constructor(player, gameState, controller) {
        super(player, gameState, controller);
        this.llmClient = null;
        this.cachedCommandSystemPrompt = null;
    }

    /**
     * Retrieves or instantiates the single LLMClient for this AI player.
     * @returns {LLMClient}
     */
    getLLMClient() {
        if (!this.llmClient) {
            this.llmClient = new LLMClient({
                baseUrl: this.gameState.settings?.llm?.baseUrl,
                apiKey: this.gameState.settings?.llm?.apiKey,
                orderedModels: this.gameState.settings?.llm?.orderedModels,
                timeoutMs: 120000,
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 8000,
                    thinkingBudget: 8000
                }
            });
        }
        return this.llmClient;
    }

    /**
     * Processes a player's turn by summarizing the game state and interacting with the AI controller.     
     */
    async processTurn() {
        const client = this.getLLMClient();
        const commandSystemPrompt = await this.getCommandSystemPrompt();

        let attempts = 10; // Safeguard against infinite loops
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
                if (response) userContent += `\nFailed response: ${JSON.stringify(response)}`;
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

            if (response.type === "COMMAND") {
                if (this.player.orders <= 0) {
                    lastResponseError = `You have 0 orders remaining. You cannot execute commands. You must respond with type: "END_TURN" and provide your strategic note.`;
                    continue;
                }

                const entity = this.gameState.getEntityById(response.entityId);
                if (!entity) {
                    lastResponseError = `Actor entity not found: ${response.entityId}`;
                    continue;
                } else if (entity.owner !== this.player) {
                    lastResponseError = `Entity ${response.entityId} does not belong to you`;
                    continue;
                }

                let target = null;
                if (response.target?.entityId) {
                    target = this.gameState.getEntityById(response.target.entityId);
                    if (!target) {
                        lastResponseError = `Target entity not found: ${response.target.entityId}`;
                        continue;
                    }
                }

                const command = (response.command || '').toLowerCase();
                let ordersUsed = 0;

                let actionOutcome = null;
                if (command === "attack") {
                    actionOutcome = attack(this.gameState, entity, target, this.player.orders);
                } else if (command === "repair") {
                    actionOutcome = support(this.gameState, entity, target, "Repair", this.player.orders);
                } else if (command === "build") {
                    const targetName = response.target?.entityName;
                    if (!targetName) {
                        lastResponseError = `Build action requires target.entityName`;
                        continue;
                    }
                    actionOutcome = build(this.gameState, entity, targetName);
                } else if (command === "explore") {
                    actionOutcome = explore(this.gameState, entity, response.target?.direction, true);
                } else {
                    lastResponseError = `Command "${command}" not recognized`;
                    continue;
                }

                ordersUsed = actionOutcome.ordersUsed;
                if (ordersUsed === 0) {
                    lastResponseError = actionOutcome.result.message;
                    // Store structured command info for the enhanced failure format
                    const targetDesc = command === 'build' ? response.target?.entityName :
                        command === 'explore' ? (response.target?.direction || 'unexplored') :
                            response.target?.entityId || 'unknown';
                    lastFailedCommand = {
                        command: command.charAt(0).toUpperCase() + command.slice(1),
                        target: targetDesc,
                        entityId: response.entityId
                    };
                    lastActionResult = null;
                    continue;
                }
                lastFailedCommand = null;
                // Feed the outcome back to the LLM: completed, partial, or the failure reason
                lastActionResult = `[${actionOutcome.result.status}] ${actionOutcome.result.message}`;
                lastResponseError = null;

                // Action successfully executed: reconcile and render
                await onActionDone(this.gameState);
                lastResponseError = null;
                turnResponseLog.push(response);
            } else if (response.type === "CHAT") {
                if (this.player.orders <= 0) {
                    lastResponseError = `You have 0 orders remaining. You cannot initiate diplomacy. Call END_TURN.`;
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

                await onActionDone(this.gameState);
                lastActionResult = `[completed] Concluded diplomatic session with ${targetPlayer.name}`;
                lastResponseError = null;
                turnResponseLog.push(response);
            } else if (response.type === "END_TURN") {
                this.player.addHistoryEntry(this.gameState.currentRound, { category: 'note', details: response.note });
                return;
            } else {
                lastResponseError = `Unknown response type: ${response.type}`;
                continue;
            }
        }
    }

    /**
     * Returns the cached command system prompt or builds it dynamically if not cached.
     * @returns {Promise<string>}
     */
    async getCommandSystemPrompt() {
        if (!this.cachedCommandSystemPrompt) {
            this.cachedCommandSystemPrompt = await this.buildCommandSystemPrompt();
        }
        return this.cachedCommandSystemPrompt;
    }

    /**
     * Builds a structured, hybrid system prompt combining Markdown rules 
     * and stringified JSON manifest data.
     * @returns {Promise<string>} The formatted system prompt string.
     */
    async buildCommandSystemPrompt() {
        const manifestEntities = this.gameState.manifestData?.entities || this.gameState.manifestData || [];
        const manifestList = Array.isArray(manifestEntities) ? manifestEntities : Object.values(manifestEntities);
        const manifestMd = manifestToMarkdown(manifestList);
        const absScoreToWin = this.gameState.settings?.winCondition?.absoluteScore;
        const relScoreToWin = this.gameState.settings?.winCondition?.relativeScore;

        const response = await fetch('./src/ai/llm/systemPrompt.command.md');  // TODO configure filepath
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
    async chat(initiator, receiver, initialMessage = null) {
        console.log(`[Harness] chat() started between ${initiator.name} and ${receiver.name}`);

        // Case 1: Both players are AI -> background chat loop (invisible to human)
        if (initiator.isAI && receiver.isAI) {
            const initiatorHarness = initiator.aiManager;
            const receiverHarness = receiver.aiManager;

            let firstMsg = initialMessage;
            if (!firstMsg) {
                const opening = await initiatorHarness.generateChatReply(receiver, "Open diplomatic dialogue with an initial statement or proposal.");
                firstMsg = opening.content;
            }
            this.gameState.addChatMessage(initiator, receiver, firstMsg);

            let currentSpeaker = receiver;
            let currentHarness = receiverHarness;
            let otherPlayer = initiator;
            const maxExchanges = 20;

            for (let i = 0; i < maxExchanges; i++) {
                const reply = await currentHarness.generateChatReply(otherPlayer);
                this.gameState.addChatMessage(currentSpeaker, otherPlayer, reply.content);

                if (reply.ended) {
                    console.log(`[Harness] AI-to-AI chat terminated by ${currentSpeaker.name} at exchange ${i + 1}`);
                    break;
                }

                // Alternate speakers
                const tempP = currentSpeaker;
                currentSpeaker = otherPlayer;
                otherPlayer = tempP;
                currentHarness = (currentSpeaker === initiator) ? initiatorHarness : receiverHarness;
            }

            // Both AI players add summary note to their history
            await initiatorHarness.summarizeChatAndAddNote(receiver);
            if (receiverHarness && receiverHarness !== initiatorHarness) {
                await receiverHarness.summarizeChatAndAddNote(initiator);
            }
            return;
        }

        // Case 2: One player is human -> open chat window
        const aiPlayer = initiator.isAI ? initiator : receiver;
        const humanPlayer = initiator.isAI ? receiver : initiator;
        const aiHarness = aiPlayer.aiManager;

        if (initiator.isAI) {
            // AI opening statement
            const opening = initialMessage || (await aiHarness.generateChatReply(humanPlayer, "Open diplomatic dialogue with an initial statement or proposition to the human leader.")).content;
            this.gameState.addChatMessage(aiPlayer, humanPlayer, opening);
        }

        // Bring up chat window and await until closed/ended.
        // The summary note is added by closeChatModal() in main.js when the
        // modal closes — do not summarize here as well (would double the note
        // and the LLM call).
        if (typeof window !== 'undefined' && typeof window.openChatModal === 'function') {
            await window.openChatModal(humanPlayer, aiPlayer);
        }
    }

    /**
     * Builds diplomatic system instructions for chat with a specific opponent.
     * @param {Player} otherPlayer
     * @returns {Promise<string>}
     */
    async buildChatSystemPrompt(otherPlayer) {
        const myScore = this.player.score;
        const otherScore = otherPlayer.score;

        const response = await fetch('./src/ai/llm/systemPrompt.chat.md');  // TODO configure filepath
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const systemPromptMarkdown = await response.text();
        return systemPromptMarkdown
            .replace('{NAME}', this.player.name)
            .replace('{DESCRIPTION}', this.player.description ? `You are described as: ${this.player.description}` : '')
            .replace('{OPPONENT_NAME}', otherPlayer.name)
            .replace('{OPPONENT_DESCRIPTION}', otherPlayer.description ? ` (${otherPlayer.description})` : '')
            .replace('{ROUND}', this.gameState.currentRound)
            .replace('{MY_MIL}', myScore.military)
            .replace('{MY_ECON}', myScore.economic)
            .replace('{MY_EXP}', myScore.exploration)
            .replace('{MY_TOTAL}', myScore.total)
            .replace('{OTHER_MIL}', otherScore.military)
            .replace('{OTHER_ECON}', otherScore.economic)
            .replace('{OTHER_EXP}', otherScore.exploration)
            .replace('{OTHER_TOTAL}', otherScore.total);
    }

    /**
     * Generates a diplomatic chat reply based on conversation history using the single client.
     * @param {Player} otherPlayer
     * @param {string} [contextPrompt]
     * @returns {Promise<{ content: string, ended: boolean }>}
     */
    async generateChatReply(otherPlayer, contextPrompt = null) {
        const client = this.getLLMClient();
        const systemPrompt = await this.buildChatSystemPrompt(otherPlayer);
        const history = this.gameState.getChatHistory(this.player, otherPlayer);

        const messages = [];
        if (history && history.length > 0) {
            for (const msg of history) {
                if (msg.sender === this.player.name) {
                    messages.push({ role: 'assistant', content: msg.content });
                } else {
                    messages.push({ role: 'user', content: `${msg.sender}: ${msg.content}` });
                }
            }
        }

        if (contextPrompt) {
            messages.push({ role: 'user', content: `[Context]: ${contextPrompt}` });
        } else if (messages.length === 0) {
            messages.push({ role: 'user', content: `[Diplomatic channel opened by ${otherPlayer.name}. State your opening position or greeting.]` });
        }

        console.log(`[Harness] ${this.player.name} generating chat reply to ${otherPlayer.name}...`);
        const rawResponse = await client.generate(messages, systemPrompt, {
            temperature: 0.7,
            maxOutputTokens: 1000
        });

        if (!rawResponse) {
            return {
                content: "... (The leader deliberates silently)",
                ended: false
            };
        }

        const rawText = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
        const ended = rawText.includes('[END_CHAT]');
        const cleanContent = rawText.replace(/\[END_CHAT\]/gi, '').trim();

        return {
            content: cleanContent || "... (no further comment)",
            ended: ended
        };
    }

    /**
     * Summarizes the diplomatic conversation and saves a note to player history using the single client.
     * @param {Player} otherPlayer
     */
    async summarizeChatAndAddNote(otherPlayer) {
        const history = this.gameState.getChatHistory(this.player, otherPlayer);
        if (!history || history.length === 0) return;

        const recent = history.filter(m => m.round === this.gameState.currentRound).map(m => `${m.sender}: ${m.content}`).join('\n');
        const summaryPrompt = `You just finished a diplomatic conversation with ${otherPlayer.name}.
Transcript:
${recent}

Write a concise 1-2 sentence private strategic note to yourself:
1. Any agreements, trade, threats, or commitments made?
2. What should you remember or watch out for regarding ${otherPlayer.name}?
Respond with ONLY the brief note.`; // TODO: use an md file for this as well

        try {
            const client = this.getLLMClient();
            const noteSystemPrompt = `You are a strategic advisor for ${this.player.name}. Summarize diplomacy with ${otherPlayer.name} into concise internal notes.`;
            const summary = await client.generate(summaryPrompt, noteSystemPrompt, {
                temperature: 0.3,
                maxOutputTokens: 300
            });
            const cleanSummary = (typeof summary === 'string' ? summary : JSON.stringify(summary))     // TODO: why do we need this cleanup? The client should do it
                .replace(/<think>[\s\S]*?<\/think>/gi, '')
                .replace(/^```[a-z]*\n?/i, '')
                .replace(/\n?```$/i, '')
                .trim();

            if (cleanSummary) {
                this.player.addHistoryEntry(this.gameState.currentRound, {
                    category: 'note',
                    details: `Diplomacy with ${otherPlayer.name}: ${cleanSummary}`,
                    extra: {
                        chatWith: otherPlayer.name
                    }
                });
                console.log(`[Harness] Saved diplomatic note for ${this.player.name} regarding ${otherPlayer.name}: ${cleanSummary}`);
            }
        } catch (err) {
            console.error(`[Harness] Failed to summarize chat for ${this.player.name}:`, err);
        }
    }

    summarizeGameState() {
        const opponents = this.player.getOpponents(this.gameState);
        Object.values(opponents).forEach(opp => {
            opp.entities = (opp.entities || []).map(e => this.summarizeEntity(e));
        });

        const history = {};
        for (let roundNum = this.gameState.currentRound; roundNum > Math.max(this.gameState.currentRound - 3, 1); roundNum--) {
            const h = this.player.history.get(roundNum);
            if (h) history[roundNum] = h;
        }

        const visibleCellsList = Array.from(this.player.visibleCells || []);
        const exploredOnly = Array.from(this.player.exploredCells || []).filter(c => !this.player.visibleCells.has(c));

        return {
            turn: this.gameState.currentRound,
            orders: this.player.orders,
            maxOrders: this.player.maxOrders,
            resources: this.player.getResourceProfile(this.gameState),
            score: this.player.score,
            history: history,
            // cells: {
            //     visible: visibleCellsList.map(cellKey => this.getCellInfo(cellKey)).filter(Boolean),
            //     explored: exploredOnly.map(cellKey => this.getCellInfo(cellKey)).filter(Boolean)
            // },
            entities: this.player.getEntities(this.gameState).map(e => this.summarizeEntity(e)),
            opponents: opponents
        };
    }

    summarizeEntity(entity) {
        const summary = {
            id: entity.id,
            name: entity.name,
            fromStart: entity.cell ? {
                direction: this.gameState.hexGrid.directionTo(this.player.startCoord, entity.cell, true).fromSource,
                distance: HexGrid.distance(this.player.startCoord, entity.cell)
            } : null,
            terrain: entity.cell?.terrain?.name,
            health: entity.health,
            maxHealth: entity.maxHealth,
            actionPoints: entity.actionPoints,
            damage: entity.damage,
            armor: entity.armor
        };

        // State-dependent capabilities: what can this unit actually do right now?
        const manifestEntities = this.gameState.manifestData?.entities || this.gameState.manifestData || {};
        const manifestList = Array.isArray(manifestEntities) ? manifestEntities : Object.values(manifestEntities);
        const def = manifestList.find(m => m.name === entity.name);
        if (def) {
            // Building requires 1 AP. If the unit has less than 1 AP, it can't build anything.
            const canBuild = (entity.actionPoints ?? 0) >= 1;
            const buildables = def.buildables || [];
            if (buildables.length) {
                summary.buildableNow = [];
                summary.buildableLater = [];
                for (const b of buildables) {
                    if (!canBuild) {
                        // Unit lacks AP to build — list as unavailable with reason (rounded to 1 decimal)
                        const ap = Math.round((entity.actionPoints ?? 0) * 10) / 10;
                        summary.buildableLater.push({ name: b, missing: `insufficient AP (${ap} < 1 required)` });
                        continue;
                    }
                    const bDef = manifestList.find(m => m.name === b);
                    const cost = bDef?.spawnCost || {};
                    const missing = Object.entries(cost)
                        .filter(([, amt]) => amt > 0)
                        .map(([res, amt]) => ({ res, need: Math.round((amt - (this.player.resources?.[res] || 0)) * 10) / 10 }))
                        .filter(x => x.need > 0);
                    if (missing.length === 0) {
                        summary.buildableNow.push(b);
                    } else {
                        summary.buildableLater.push({ name: b, missing: missing.map(m => `${m.need} ${m.res}`).join(', ') });
                    }
                }
            }

            // Damaged repairables: visible entities of repairable types with health < max
            const repairables = def.repairables || [];
            if (repairables.length) {
                summary.damagedRepairables = [];
                for (const e of this.gameState.entities || []) {
                    if (e.destroyed || e.id === entity.id) continue;
                    if (!repairables.includes(e.name)) continue;
                    if (e.health === undefined || e.maxHealth === undefined || e.health >= e.maxHealth) continue;
                    if (e.q === undefined || !this.player.isVisible?.(e.q, e.r)) continue;
                    summary.damagedRepairables.push({
                        id: e.id,
                        name: e.name,
                        health: Math.round(e.health),
                        maxHealth: e.maxHealth
                    });
                }
            }
        }

        return summary;
    }

    /**
     * Human-readable action description: "Build mine with worker_1",
     * "Attack red_knight_1 with knight_1", "Explore N with scout_1".
     */
    describeAction(r) {
        const cmd = r.command || r.type || 'Unknown';
        const actor = r.entityId || 'unknown';
        const target = r.target || {};
        let targetDesc = '';
        if (target.entityName) targetDesc = target.entityName;
        else if (target.entityId) targetDesc = target.entityId;
        else if (target.direction) targetDesc = target.direction;
        return targetDesc ? `${cmd} ${targetDesc} with ${actor}` : `${cmd} with ${actor}`;
    }

    getCellInfo(cellCoordStr) {
        if (typeof cellCoordStr === 'string') {
            const [q, r] = cellCoordStr.split(',').map(Number);
            const cell = this.gameState.hexGrid.getCell(q, r);
            if (!cell) return null;
            return this.cellToString(cell);
        }
        return null;
    }

    cellToString(cell) {
        if (!cell) return '';
        const tName = cell.terrain?.name || 'Unknown';
        return `${cell.q},${cell.r}:${tName}`;
    }
}
