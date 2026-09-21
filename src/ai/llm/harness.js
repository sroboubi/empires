import { BaseManager } from "../baseManager.js";
import { LLMClient } from "./client.js";
import responseSchema from './response.schema.json' with { type: 'json' };
import { attack, repair, build, onActionDone } from "../utils.js";

export class Harness extends BaseManager {
    constructor(player, gameState, controller) {
        super(player, gameState, controller);
        this.llmClient = new LLMClient({
            systemPrompt: this.buildSystemPrompt(),
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

    /**
     * Processes a player's turn by summarizing the game state and interacting with the AI controller.     
     */
    async processTurn() {
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
                    ordersUsed = repair(this.gameState, entity, target, this.player.orders);
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
    buildSystemPrompt() {
        const manifestJson = JSON.stringify(this.summarizeManifest(this.gameState.manifestData || {}), (key, value) => { return value === null ? undefined : value; }, 2);
        const absScoreToWin = this.gameState.settings?.winCondition?.absoluteScore || 1000;
        const relScoreToWin = this.gameState.settings?.winCondition?.relativeScore || 2;

        return `# IDENTITY & OBJECTIVES
        You are an AI player named "${this.player.name}" in a turn-based hex strategy game. ${this.player.description ? `Here is your description: ${this.player.description}` : ''}
        Your goal is to maximize your overall score through strategic management of entities, resource economy, map exploration, and tactical positioning.

        # GAME RULES & MECHANICS
        * On each turn, you will receive a JSON payload representing your current visible game state snapshot, available resources, and active entities.
        * Analyze the provided game state snapshot, cross-reference entity capabilities in the manifest, and return your chosen actions formatted according to the response schema.
        * Each action costs 1 Order and 1 or more action points. You have a limited number of orders per turn. 
        * Each entity has a limited number of action points that are refilled each round. Do not attempt to perform actions with entities that have less than 1 action point available.
        * "Build" action requires an entityName target (new entity) to build. The builder will attempt to build in an adjacent cell if possible, otherwise will move to build as close as possible.
        * "Repair" and "Attack" actions require an entityId target. The repairer/attacker will attempt to repair/attack the target, and will move to closer if needed.
        * "Move" action requires a cell target.
        * Hex coordinates use axial positioning (q, r). Adjacent hexes differ by 1 unit in q, r, or both.
        * Each entity provides economic or military score value to your overall empire score. Each visible and explored cell adds to your exploration score. 
        * Your total score is the geometric mean of your military, economic, and exploration scores. To win, your total score must reach or exceed ${absScoreToWin} or ${relScoreToWin} times the next highest score.
        * Entities consume maintenance resources each turn. Inactive entities (unpaid upkeep) cannot act or generate yields.
        * Initiating a diplomatic chat with another player costs 1 Order.

        # GLOBAL MANIFEST & ENTITY DEFINITIONS
        Use this manifest to inspect resource yields, entity costs, upkeep, terrain properties, and available actions for each entity type:
        \`\`\`json
        ${manifestJson}
        \`\`\`

        # RESPONSE FORMAT INSTRUCTIONS
        Respond EXCLUSIVELY with a raw JSON object (no markdown code block wrappers).

        1. COMMAND:
        {
        "thoughtProcess": "Brief strategic reasoning",
        "type": "COMMAND",
        "entityId": "<YOUR_ENTITY_ID>",
        "actionName": "<ACTION_NAME>",
        "target": { "cell": { "q": 0, "r": 2 } } // OR { "entityId": "<ID>" } OR { "entityName": "<NAME>" }
        }

        2. CHAT (Costs 1 order):
        {
        "thoughtProcess": "Brief strategic reasoning",
        "type": "CHAT",
        "targetPlayerId": "<OPPONENT_PLAYER_ID>"
        }

        3. END_TURN (Always use when out of orders or finished):
        {
        "thoughtProcess": "Brief strategic reasoning",
        "type": "END_TURN",
        "note": "Reminder to myself for next turn"
        }`;
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
            cells: {
                visible: visibleCellsList.map(cellKey => this.getCellInfo(cellKey)).filter(Boolean),
                explored: exploredOnly.map(cellKey => this.getCellInfo(cellKey)).filter(Boolean)
            },
            entities: this.player.getEntities(this.gameState).map(e => this.summarizeEntity(e)),
            opponents: opponents
        };
    }

    summarizeEntity(entity) {
        return {
            id: entity.id,
            name: entity.name,
            cell: this.cellToString(entity.cell || entity),
            health: entity.health,
            maxHealth: entity.maxHealth,
            actionPoints: entity.actionPoints,
            damage: entity.damage,
            armor: entity.armor
        };
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
