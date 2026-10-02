import { BaseManager } from "../baseManager.js";
import { LLMClient } from "./client.js";
import responseSchema from './response.schema.json' with { type: 'json' };
import { attack, support, build, onActionDone } from "../utils.js";
import { HexGrid } from '../../hexGrid.js';

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
                apiKey: this.gameState.settings?.llm?.apiKey || '',
                orderedModels: this.gameState.settings?.llm?.orderedModels,
                timeoutMs: 40000,
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 8000,
                    thinkingBudget: 8000
                }
            });
        }

        let attempts = 10; // Safeguard against infinite loops
        let lastResponseError = null;
        let response = null;
        const turnResponseLog = [];

        while (attempts > 0) {
            if (lastResponseError) attempts--;
            const userContent = `\`\`\`json\n${JSON.stringify({
                state: this.summarizeGameState(),
                lastResponseError: lastResponseError ? {
                    message: lastResponseError,
                    failedResponse: response
                } : null,
                turnResponseLog: turnResponseLog.length > 0 ? turnResponseLog : null
            }, (key, value) => { return value === null ? undefined : value; }, 2)}\n\`\`\``;

            console.debug("system prompt:", this.llmClient.systemPrompt);
            console.debug("user content:", userContent);

            // DEBUG
            return;

            response = await this.llmClient.generate(userContent);
            console.debug("response:", response);

            if (!response) {
                console.error(`Failed to process turn for player ${this.player.name}: No response received.`);
                return;
            }

            if (response.type == "COMMAND") {
                if (this.player.orders <= 0) {
                    lastResponseError = `You have 0 orders remaining. You cannot execute commands. You must respond with type: "END_TURN" and provide your strategic note.`;
                    continue;
                }

                const entity = this.gameState.getEntityById(response.entityId);
                if (!entity) {
                    lastResponseError = `Actor entity not found: ${response.entityId}`;
                    continue;
                } else if (entity.owner != this.player) {
                    lastResponseError = `Entity ${response.entityId} does not belong to you`;
                    continue;
                }

                let target = null;
                let cell = null;
                if (response.target?.entityId) {
                    target = this.gameState.getEntityById(response.target.entityId);
                    if (!target) {
                        lastResponseError = `Target entity not found: ${response.target.entityId}`;
                        continue;
                    }
                    cell = target.cell;
                } else if (response.target?.cell) {
                    cell = this.gameState.hexGrid.getCell(response.target.cell.q, response.target.cell.r);
                    if (!cell) {
                        lastResponseError = `Target cell not found: ${response.target.cell.q},${response.target.cell.r}`;
                        continue;
                    }
                    target = this.gameState.getEntityAt(cell.q, cell.r);
                }

                const actionLower = (response.actionName || '').toLowerCase();
                let ordersUsed = 0;

                if (actionLower === "attack") {
                    ordersUsed = attack(this.gameState, entity, target, this.player.orders);
                    if (ordersUsed === 0) {
                        lastResponseError = `Could not initiate attack on target`;
                        continue;
                    }
                } else if (actionLower === "repair") {
                    ordersUsed = support(this.gameState, entity, target, "Repair", this.player.orders);
                    if (ordersUsed === 0) {
                        lastResponseError = `Could not initiate repair on target`;
                        continue;
                    }
                } else if (actionLower === "build") {
                    const targetName = response.target?.entityName;
                    if (!targetName) {
                        lastResponseError = `Build action requires target.entityName`;
                        continue;
                    }
                    ordersUsed = build(this.gameState, entity, targetName, this.player.orders);
                    if (ordersUsed === 0) {
                        lastResponseError = `Could not initiate build of ${targetName}`;
                        continue;
                    }
                } else {  // do actions directly, like move
                    const actions = entity.getActions ? entity.getActions() : [];
                    const action = actions.find(a => a.name.toLowerCase() === actionLower);
                    if (!action) {
                        lastResponseError = `Action "${response.actionName}" not found on entity ${entity.name}`;
                        continue;
                    }
                    const canAct = action.canDo(cell, target);
                    if (!canAct.possible) {
                        lastResponseError = `Action "${response.actionName}" not possible: ${canAct.reason}`;
                        continue;
                    }
                    if (!action.do(cell, target)) {
                        lastResponseError = `Failed to do action "${response.actionName}" on entity ${response.entityId}`;
                        continue;
                    }
                }

                // Action successfully executed: reconcile and render
                await onActionDone(this.gameState);
                lastResponseError = null;
                turnResponseLog.push(response);

            } else if (response.type == "CHAT") {
                // TODO
                lastResponseError = `CHAT not supported yet`;
                continue;
            } else if (response.type == "END_TURN") {
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
        const manifestJson = JSON.stringify(this.summarizeManifest(this.gameState.manifestData || {}), (key, value) => { return value === null ? undefined : value; }, 2);
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
            .replace('${MANIFEST}', manifestJson);
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
            fromStart: {
                direction: this.gameState.hexGrid.directionTo(this.player.startCoord, entity.cell, true).fromSource,
                distance: HexGrid.distance(this.player.startCoord, entity.cell)
            },
            terrain: entity.cell.terrain?.name,
            health: entity.health,
            maxHealth: entity.maxHealth,
            actionPoints: entity.actionPoints,
            damage: entity.damage,
            armor: entity.armor
        };
        return summary;
    }

    summarizeManifest(manifest) {
        const actionsToExclude = ["Face Direction"]; // these should not be directly used by LLM
        const summary = { entities: {}, terrains: {} };
        const entitiesObj = manifest.entities || {};
        Object.entries(entitiesObj).forEach(([name, entity]) => {
            const { spawnCost, maintenance, buildables, repairables, score, yields, actions = [] } = entity;
            const mergedActions = new Set();
            actions.forEach(({ name }) => {
                if (actionsToExclude.includes(name)) return;
                if (name.startsWith("Build")) name = "Build";
                mergedActions.add(name);
            });
            summary.entities[name] = { spawnCost, maintenance, buildables, repairables, score, yields, actions: Array.from(mergedActions) };
        });
        const terrainsList = Array.isArray(manifest.terrains) ? manifest.terrains : Object.values(manifest.terrains || {});
        terrainsList.forEach(terrain => {
            summary.terrains[terrain.name] = { movementCost: terrain.movementCost, height: terrain.height };
        });
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
