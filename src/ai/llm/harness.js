import { BaseManager } from "../baseManager.js";
import { LLMClient } from "./client.js";
import responseSchema from './response.schema.json' with { type: 'json' };
import { attack, support, build, explore, onActionDone } from "../utils.js";
import { HexGrid } from '../../hexGrid.js';
import { manifestToMarkdown, serializeStateToMarkdown, summarizeTerrain } from "./markdown.js";

export class Harness extends BaseManager {
    constructor(player, gameState, controller) {
        super(player, gameState, controller);
    }

    /**
     * Processes a player's turn by summarizing the game state and interacting with the AI controller.     
     */
    async processTurn() {
        if (!this.llmClient) {
            this.llmClient = new LLMClient({
                systemPrompt: await this.buildSystemPrompt(),
                responseSchema: responseSchema,
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

        let attempts = 10; // Safeguard against infinite loops
        let lastResponseError = null;
        let lastActionResult = null;
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
                userContent += `\n\n### Last Action Failed\n${lastResponseError}` + (response ? `\nFailed response: ${JSON.stringify(response)}` : '');
            } else if (lastActionResult) {
                userContent += `\n\n### Last Action Result\n${lastActionResult}`;
            }
            if (turnResponseLog.length > 0) {
                userContent += `\n\n### Actions Taken This Turn (${turnResponseLog.length})\n` +
                    turnResponseLog.map((r, i) => `${i + 1}. ${r.command || r.type} (${r.entityId || ''})`).join('\n');
            }

            console.debug("system prompt:", this.llmClient.systemPrompt);
            console.debug("user content:", userContent);

            response = await this.llmClient.generate(userContent);
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
                    lastActionResult = null;
                    continue;
                }
                // Feed the outcome back to the LLM: completed, partial, or the failure reason
                lastActionResult = `[${actionOutcome.result.status}] ${actionOutcome.result.message}`;
                lastResponseError = null;

                // Action successfully executed: reconcile and render
                await onActionDone(this.gameState);
                lastResponseError = null;
                turnResponseLog.push(response);
            } else if (response.type === "CHAT") {
                // TODO
                lastResponseError = `CHAT not supported yet`;
                continue;
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
     * Builds a structured, hybrid system prompt combining Markdown rules 
     * and stringified JSON manifest data.
     * @returns {string} The formatted system prompt string.
     */
    async buildSystemPrompt() {
        const manifestEntities = this.gameState.manifestData?.entities || this.gameState.manifestData || [];
        const manifestMd = manifestToMarkdown(Array.isArray(manifestEntities) ? manifestEntities : Object.values(manifestEntities));
        const absScoreToWin = this.gameState.settings?.winCondition?.absoluteScore || 1000;
        const relScoreToWin = this.gameState.settings?.winCondition?.relativeScore || 2;

        const response = await fetch('./src/ai/llm/systemPrompt.md');  // TODO configure filepath
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const systemPromptMarkdown = await response.text();
        return systemPromptMarkdown
            .replace('${NAME}', this.player.name)
            .replace('${DESCRIPTION}', this.player.description ? `You are described as: ${this.player.description}` : '')
            .replace('${ABS_SCORE_TO_WIN}', absScoreToWin)
            .replace('${REL_SCORE_TO_WIN}', relScoreToWin)
            .replace('${MANIFEST}', manifestMd);
    }

    /**
     * Initiates a chat between two players.
     * @param {Player} initiator
     * @param {Player} receiver
     */
    chat(initiator, receiver) {
        // TODO
        // if one of the players is NOT AI, then create chat window
        // if both AI, then perform chat in the background
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
            // Split buildables by affordability (spawnCost vs player resources)
            const buildables = def.buildables || [];
            if (buildables.length) {
                summary.buildableNow = [];
                summary.buildableLater = [];
                for (const b of buildables) {
                    const bDef = manifestList.find(m => m.name === b);
                    const cost = bDef?.spawnCost || {};
                    const missing = Object.entries(cost)
                        .filter(([, amt]) => amt > 0)
                        .map(([res, amt]) => ({ res, need: amt - (this.player.resources?.[res] || 0) }))
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
