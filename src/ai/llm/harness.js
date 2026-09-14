/**
 * Processes a player's turn by summarizing the game state and interacting with the AI controller.
 * @param {Player} player - The player whose turn is being processed.
 * @param {GameState} gameState - The current state of the game.
 */
export async function processTurn(player, gameState) {
    const systemPrompt = buildSystemPrompt(player, gameState)

    let attempts = 10; // Safeguard against infinite loops
    while (attempts > 0) {
        attempts--;
        const userContent = `Turn: ${gameState.currentRound}\nState: \`\`\`json\n${JSON.stringify(summarize(player, gameState), (key, value) => { return value === null ? undefined : value; }, 2)}\n\`\`\``;

        console.log("system prompt:", systemPrompt);
        console.log("user content:", userContent);

        // TODO: send summary to LLM and get back one of
        // - structured order (needs to be translated into game actions) - examples:
        //  - move towards cell X with entity Y (we try to move in that direction)
        //  - attack entity X with entity Y (move first if needed to be in range of entity X, then attack)
        //  - build entity name with entity Y (we try to build in any adjacent cell to entity Y, if not possible we see if we can first move and the build close by)
        //  - repair entity X with entity Y (move first if needed to be adjacent to entity X, then repair)
        // - or start chat with another player (costs 1 order)
        // - or end turn (save orders, or nothing else to do)

        // TODO: reset attempts if we get a valid order back from LLM, so we can keep processing until we run out of orders or the LLM wants to end the turn


        // TODO: add END_TURN note to player history

        return // TODO only do this if LLM wants to end the turn to save orders for next turn
    }
}

/**
 * Builds a structured, hybrid system prompt combining Markdown rules 
 * and stringified JSON manifest data.
 * 
 * @param {Player} player 
 * @param {GameState} gameState 
 * @returns {string} The formatted system prompt string.
 */
function buildSystemPrompt(player, gameState) {
    // summarizeManifest extracts entity definitions along with their embedded actions array
    const manifestJson = JSON.stringify(summarizeManifest(gameState.manifestData), (key, value) => { return value === null ? undefined : value; }, 2);
    const absScoreToWin = gameState.settings?.winConditions?.absoluteScore || 1000;
    const relScoreToWin = gameState.settings?.winConditions?.relativeScore || 2;

    return `# IDENTITY & OBJECTIVES
You are an AI player named "${player.name}" in a turn-based hex strategy game. ${player.description ? `Here is your description: ${player.description}` : ''}
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
export function chat(initiator, receiver) {
    // TODO
    // if one of the players is NOT AI, then create chat window
    // if both AI, then perform chat in the background
}

function summarize(player, gameState) {
    const opponents = player.getOpponents(gameState);
    Object.values(opponents).forEach(opp => {
        opp.entities = opp.entities.map(summarizeEntity);
    });

    const history = {};
    for (let roundNum = gameState.currentRound; roundNum > Math.max(gameState.currentRound - 3, 1); roundNum--) {
        history[roundNum] = player.history.get(roundNum);
    }

    return {
        orders: player.orders,
        resources: player.getResourceProfile(gameState),
        score: player.score,
        history: history,
        cells: {
            visible: Array.from(player.visibleCells).map(cellKey => { return getCellInfo(gameState, cellKey) }),
            explored: Array.from(player.exploredCells.difference(player.visibleCells)).map(cellKey => { return getCellInfo(gameState, cellKey) })
        },
        entities: player.getEntities(gameState).map(summarizeEntity),
        opponents: opponents
    };
}

function summarizeEntity(entity) {
    return {
        id: entity.id,
        name: entity.name,
        cell: cellToString(entity.cell),
        health: entity.health,
        maxHealth: entity.maxHealth,
        actionPoints: entity.actionPoints,
        damage: entity.damage,
        armor: entity.armor
    };
}

function summarizeManifest(manifest) {
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

function getCellInfo(gameState, cellCoordStr) {
    if (typeof cellCoordStr === 'string') {
        const [q, r] = cellCoordStr.split(',').map(Number);
        const cell = gameState.hexGrid.getCell(q, r);
        if (!cell) return null;
        return cellToString(cell);
    }
    return null;
}

function cellToString(cell) {
    return `${cell.q},${cell.r}:${cell.terrain.name}`;
}