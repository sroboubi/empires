/**
 * Shared base for LLM turn managers (JSON commands, menu, future variants).
 * Holds everything that is not interface-specific: the LLM client, game-state
 * summarization, and the diplomatic chat flow. Concrete harnesses extend this
 * and implement processTurn().
 */
import { BaseManager } from '../baseManager.js';
import { LLMClient } from './client.js';
import { HexGrid } from '../../hexGrid.js';
import { manifestToMarkdown } from './markdown.js';
import { findBuildCandidates, isCombatCapable } from '../utils.js';
import { CONFIG } from '../../config.js';

export class LlmBaseManager extends BaseManager {
    constructor(player, gameState, controller) {
        super(player, gameState, controller);
        this.llmClient = null;
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
                timeoutMs: this.gameState.settings?.llm?.timeoutMs ?? 30000,
                callDelayMs: this.gameState.settings?.llm?.callDelayMs,
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 8000,
                    thinkingBudget: 1000
                }
            });
        }
        return this.llmClient;
    }

    /**
     * Processes a player's turn by summarizing the game state and interacting with the AI controller.     
     */

    async chat(initiator, receiver, initialMessage = null) {
        console.log(`[Harness] chat() started between ${initiator.name} and ${receiver.name}`);

        // Case 1: Both players are AI -> background chat loop (invisible to human)
        if (initiator.isAI && receiver.isAI) {
            const initiatorHarness = await initiator.ensureAiManager();
            const receiverHarness = await receiver.ensureAiManager();

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
        const summarizeUnitCounts = (list) => {
            const m = new Map();
            for (const e of list || []) m.set(e.name, (m.get(e.name) || 0) + 1);
            return [...m.entries()].map(([n, c]) => `${c} ${n}`).join(', ') || 'none';
        };

        const response = await fetch(CONFIG.CHAT_PROMPT_URL);
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
            .replace('{OTHER_TOTAL}', otherScore.total)
            .replace('{MY_RESOURCES}', Object.entries(this.player.resources || {}).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ') || 'none')
            .replace('{MY_UNITS}', summarizeUnitCounts(this.player.getEntities(this.gameState)))
            .replace('{OTHER_UNITS}', summarizeUnitCounts((this.gameState.entities || []).filter(e => e.owner === otherPlayer && this.player.isVisible?.(e.q, e.r))));
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

        // Best-effort note: a failed summary must never break the turn flow
        // (closeChatModal awaits this before resolving the chat promise).
        try {
            const recent = history.filter(m => m.round === this.gameState.currentRound).map(m => `${m.sender}: ${m.content}`).join('\n');
            const response = await fetch(CONFIG.CHAT_SUMMATION_PROMPT_URL);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            let summaryPrompt = await response.text();
            summaryPrompt = summaryPrompt.replace("{OPPONENT_NAME}", otherPlayer.name).replace("{RECENT_CHAT}", recent);
            const noteSystemPrompt = `You are a strategic advisor for ${this.player.name}. Summarize diplomacy with ${otherPlayer.name} into concise internal notes.`;
            const summary = await this.getLLMClient().generate(summaryPrompt, noteSystemPrompt, {
                temperature: 0.3,
                maxOutputTokens: 1000
            });

            if (summary) {
                this.player.addHistoryEntry(this.gameState.currentRound, {
                    category: 'note',
                    details: `Diplomacy with ${otherPlayer.name}: ${summary}`,
                    extra: {
                        chatWith: otherPlayer.name
                    }
                });
                console.log(`[Harness] Saved diplomatic note for ${this.player.name} regarding ${otherPlayer.name}: ${summary}`);
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

        const resourceProfile = this.player.getResourceProfile(this.gameState);
        const ownSummaries = this.player.getEntities(this.gameState).map(e => this.summarizeEntity(e));
        const history = {};
        for (let roundNum = this.gameState.currentRound; roundNum > Math.max(this.gameState.currentRound - 3, 1); roundNum--) {
            const h = this.player.history.get(roundNum);
            if (h) history[roundNum] = h;
        }

        // Threats: visible enemies adjacent to any own unit (melee range; ranged
        // enemies threaten from farther, but adjacency is the certain threat).
        const ownUnits = this.player.getEntities(this.gameState);
        const threats = [];
        for (const e of this.gameState.entities || []) {
            if (e.destroyed || !e.cell) continue;
            if (e.owner && e.owner.id === this.player.id) continue;
            if (!this.player.isVisible?.(e.q, e.r)) continue;
            const neighbor = ownUnits.find(o => o.cell && HexGrid.distance(o.cell, e.cell) === 1);
            if (neighbor) threats.push({ id: e.id, name: e.name, adjacentTo: neighbor.id });
        }
        // Deficit remedies: for each depleting resource, the best-yield producer
        // buildable now by an owned unit (producers already in buildableNow).
        const manifestEntities = this.gameState.manifestData?.entities || this.gameState.manifestData || {};
        const manifestList = Array.isArray(manifestEntities) ? manifestEntities : Object.values(manifestEntities);
        const byName = new Map(manifestList.map(m => [m.name, m]));
        const remedies = [];
        for (const [res, net] of Object.entries(resourceProfile.netIncome || {})) {
            if (!(net < 0)) continue;
            let best = null;
            for (const sm of ownSummaries) {
                for (const b of sm.buildableNow || []) {
                    const y = byName.get(b)?.yields?.[res];
                    if (y > 0 && (!best || y > best.yield)) best = { producer: b, builderId: sm.id, yield: y };
                }
            }
            if (best) remedies.push({ resource: res, net, ...best });
        }

        return {
            turn: this.gameState.currentRound,
            orders: this.player.orders,
            maxOrders: this.player.maxOrders,
            resources: resourceProfile,
            score: this.player.score,
            history: history,
            entities: ownSummaries,
            opponents: opponents,
            knownPlayers: (this.gameState.players || []).filter(p => p !== this.player).map(p => ({ name: p.name, score: p.score })),
            mapSize: this.gameState.settings?.mapSize,
            exploredPercent: this.gameState.hexGrid?.cells?.size ? Math.round((this.player.exploredCells?.size || 0) / this.gameState.hexGrid.cells.size * 100) : null,
            threats: threats,
            deficitRemedies: remedies
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
            active: entity.active,
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
                        // Affordable is not placeable: only list as buildable
                        // now when the engine finds at least one valid site.
                        // Otherwise the model burns orders discovering this
                        // through failed Build commands.
                        const { candidates } = findBuildCandidates(this.gameState, entity, b);
                        if (candidates.length > 0) {
                            summary.buildableNow.push(b);
                        } else {
                            summary.buildableLater.push({ name: b, missing: 'no valid site nearby' });
                        }
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
                    const entry = {
                        id: e.id,
                        name: e.name,
                        health: Math.round(e.health),
                        maxHealth: e.maxHealth
                    };
                    // Position + reachability from this repairer's point of view (own units only).
                    if (entity.owner?.id === this.player.id && entity.cell && e.cell) {
                        entry.distance = HexGrid.distance(entity.cell, e.cell);
                        entry.direction = this.gameState.hexGrid.directionTo(entity.cell, e.cell, true).fromSource;
                        // Reachable this turn: cheapest adjacent staging cell within AP, reserving 1 AP for the repair itself.
                        const ap = entity.actionPoints ?? 0;
                        let minCost = null;
                        for (const nb of this.gameState.hexGrid.getNeighbors(e.q, e.r)) {
                            const costFunc = typeof entity.getMovementCost === 'function'
                                ? entity.getMovementCost.bind(entity)
                                : (terrain) => terrain.movementCost || 1;
                            const res = this.gameState.hexGrid.movementCostTo(entity.cell, nb, costFunc);
                            if (res && (minCost === null || res.cost < minCost)) minCost = res.cost;
                        }
                        entry.reachable = minCost !== null && minCost + 1 <= ap;
                    }
                    summary.damagedRepairables.push(entry);
                }
            }
        }

        // Spatial awareness for own units: nearest visible enemy/ally + what can be struck now.
        // Pairwise hex distances only — no map scans. Ranged bands honored (bowman 1-3, tower 2-4);
        // sight/obstruction is not modeled here, so a flagged target can still fail on obstruction.
        if (entity.owner?.id === this.player.id && entity.cell) {
            let nearestEnemy = null, nearestAlly = null;
            for (const e of this.gameState.entities || []) {
                if (e.destroyed || e.id === entity.id || !e.cell) continue;
                const d = HexGrid.distance(entity.cell, e.cell);
                const dir = this.gameState.hexGrid.directionTo(entity.cell, e.cell, true).fromSource;
                if (e.owner && e.owner.id === this.player.id) {
                    if (!nearestAlly || d < nearestAlly.distance) nearestAlly = { id: e.id, distance: d, direction: dir };
                } else if (this.player.isVisible?.(e.q, e.r)) {
                    if (!nearestEnemy || d < nearestEnemy.distance) nearestEnemy = { id: e.id, distance: d, direction: dir };
                }
            }
            if (nearestEnemy) summary.nearestEnemy = nearestEnemy;
            if (nearestAlly) summary.nearestAlly = nearestAlly;
            if (entity.active && (entity.actionPoints ?? 0) >= 1 && isCombatCapable(entity)) {
                const range = entity.range && typeof entity.range === 'object'
                    ? { min: entity.range.minCells ?? 1, max: entity.range.maxCells ?? 1 }
                    : { min: 1, max: 1 };
                const targets = [];
                for (const e of this.gameState.entities || []) {
                    if (e.destroyed || !e.cell) continue;
                    if (e.owner && e.owner.id === this.player.id) continue;
                    if (!this.player.isVisible?.(e.q, e.r)) continue;
                    const d = HexGrid.distance(entity.cell, e.cell);
                    if (d >= range.min && d <= range.max) targets.push(e.id);
                }
                if (targets.length) summary.canAttackNow = targets;
            }
        }

        return summary;
    }

    /**
     * Human-readable action description: "Build mine with worker_1",
     * "Attack red_knight_1 with knight_1", "Explore N with scout_1".
     * Each response carries an explicit command field (see response.schema.json).
     */

}

export default LlmBaseManager;
