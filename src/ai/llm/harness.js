import { GeminiClient } from "./geminiClient";
import responseSchema from './response.schema.json' with { type: 'json' };

export class Harness {
    constructor(player, gameState) {
        this.player = player;
        this.gameState = gameState;
        this.llmClient = new GeminiClient({
            systemPrompt: this.buildSystemPrompt(),
            responseSchema: responseSchema,
            apiKey: this.gameState.llm.apiKey,
            orderedModels: this.gameState.llm.orderedModels,
            maxRetries: 8,
            generationConfig: {
                temperature: 0.2,
                thinkingBudget: 0
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

            console.log("system prompt:", this.llmClient.systemPrompt);
            console.log("user content:", userContent);

            response = await this.llmClient.generate(userContent);

            console.log("response:", response);

            if (!response) {
                throw new Error(`Failed to process turn for player ${this.player.name}.`);
            }

            if (response.type == "COMMAND") {
                const entity = this.gameState.getEntityById(response.entityId);
                if (!entity) {
                    lastResponseError = `Actor entity not found: ${response.entityId}`;
                    continue;
                } else if (entity.owner != this.player) {
                    lastResponseError = `Entity ${response.entityId} does not belong to you`;
                    continue;
                }
                let target;
                let cell;
                if (response.target.entityId) {
                    target = this.gameState.getEntityById(response.target.entityId);
                    if (!target) {
                        lastResponseError = `Target entity not found: ${response.target.entityId}`;
                        continue;
                    }
                    cell = target.cell;
                } else if (response.target.cell) {
                    cell = this.gameState.hexGrid.getCell(response.target.cell.q, response.target.cell.r);
                    if (!cell) {
                        lastResponseError = `Target cell not found: ${response.target.cell.q},${response.target.cell.r}`;
                        continue;
                    }
                    target = this.gameState.getEntityAt(cell.q, cell.r);
                }

                if (response.actionName.toLowerCase() == "attack") {
                    const ordersUsed = attack(gameState, entity, target, this.player.orders);
                    if (ordersUsed === 0) {
                        lastResponseError = `Could not initiate attack`;  // TODO provide more info
                        continue;
                    }
                } else if (response.actionName.toLowerCase() == "repair") {
                    const ordersUsed = repair(gameState, entity, target, this.player.orders);
                    if (ordersUsed === 0) {
                        lastResponseError = `Could not initiate repair`;
                        continue;
                    }
                } else if (response.actionName.toLowerCase() == "build") {
                    const ordersUsed = build(gameState, entity, response.target.entityName, this.player.orders);
                    if (ordersUsed === 0) {
                        lastResponseError = `Could not initiate build`;
                        continue;
                    }
                } else {  // do actions directly, like move
                    const actions = entity.getActions ? entity.getActions() : [];
                    const action = actions.find(a => a.name.toLowerCase() === response.actionName.toLowerCase());
                    if (!action) {
                        lastResponseError = `Action ${response.actionName} not found`;
                        continue;
                    }
                    const canAct = action.canDo(cell, target);
                    if (!canAct.possible) {
                        lastResponseError = `Action ${response.actionName} not possible: ${canAct.reason}`;
                        continue;
                    }
                    if (!action.do(cell, target)) {
                        lastResponseError = `Failed to do action ${response.actionName} on entity ${response.entityId}`;
                        continue;
                    }
                }

            } else if (response.type == "CHAT") {
                // TODO
                lastResponseError = `CHAT not supported yet`;
                continue;
            } else if (response.type == "END_TURN") {
                this.player.addHistoryEntry(this.gameState.currentRound, { category: 'note', details: response.note });
                return;
            }
        }
    }

    /**
     * Builds a structured, hybrid system prompt combining Markdown rules 
     * and stringified JSON manifest data.
     * @returns {string} The formatted system prompt string.
     */
    buildSystemPrompt() {
        // summarizeManifest extracts entity definitions along with their embedded actions array
        const manifestJson = JSON.stringify(this.summarizeManifest(this.gameState.manifest), (key, value) => { return value === null ? undefined : value; }, 2);
        const absScoreToWin = this.gameState.winConditions?.absoluteScore || 1000;
        const relScoreToWin = this.gameState.winConditions?.relativeScore || 2;

        return `# IDENTITY & OBJECTIVES
        You are an AI player named "${this.player.name}" in a turn-based hex strategy game. ${this.player.description ? `Here is your description: ${this.player.description}` : ''}
        Your goal is to maximize your overall score through strategic management of entities, resource economy, map exploration, and tactical positioning.

        # GAME RULES & MECHANICS
        * On each turn, you will receive a JSON payload representing your current visible game state snapshot, available resources, and active entities.
        * Analyze the provided game state snapshot, cross-reference entity capabilities in the manifest, and return your chosen actions formatted according to the response schema.
        * Each action costs 1 Order. You have a limited number of orders per turn.
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
            opp.entities = opp.entities.map(this.summarizeEntity);
        });

        const history = {};
        for (let roundNum = this.gameState.currentRound; roundNum > Math.max(this.gameState.currentRound - 3, 1); roundNum--) {
            history[roundNum] = this.player.history.get(roundNum);
        }

        return {
            turn: this.gameState.currentRound,
            orders: this.player.orders,
            resources: this.player.getResourceProfile(this.gameState),
            score: this.player.score,
            history: history,
            cells: {
                visible: Array.from(this.player.visibleCells).map(cellKey => { return this.getCellInfo(cellKey) }),
                explored: Array.from(this.player.exploredCells.difference(this.player.visibleCells)).map(cellKey => { return this.getCellInfo(cellKey) })
            },
            entities: this.player.getEntities(this.gameState).map(this.summarizeEntity),
            opponents: opponents
        };
    }

    summarizeEntity(entity) {
        return {
            id: entity.id,
            name: entity.name,
            cell: this.cellToString(entity.cell),
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
        Object.entries(manifest.entities).forEach(([name, entity]) => {
            const { spawnCost, maintenance, buildables, repairables, score, yields, actions } = entity;
            const mergedActions = new Set();
            actions.forEach(({ name }) => {
                if (actionsToExclude.includes(name)) return;
                if (name.startsWith("Build")) name = "Build";
                mergedActions.add(name);
            });
            summary.entities[name] = { spawnCost, maintenance, buildables, repairables, score, yields, actions: Array.from(mergedActions) };
        });
        manifest.terrains.forEach(terrain => {
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
        return `${cell.q},${cell.r}:${cell.terrain.name}`;
    }
}

