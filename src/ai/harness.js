/**
 * Processes a player's turn by summarizing the game state and interacting with the AI controller.
 * @param {Player} player - The player whose turn is being processed.
 * @param {GameState} gameState - The current state of the game.
 */
export async function processTurn(player, gameState) {    
    const systemPrompt = {
        identity: `You are an AI player in a turn-based strategy game. Make strategic decisions based on the current game state and your objectives.`,
        name: player.name,
        description: player.description,
        gameRules: [
            `Your goal is to maximize your score by managing your entities, exploring the map, and interacting with opponents`,
            `Use the provided manifest to understand the capabilities of your entities and the game environment`,
            `Each entity has a score value that contributes to your overall score`,
            `Each player has a limited number of orders per turn, each action costs 1 order`,
            `Players can move their entities to explore the map and engage with opponents`,
            `Adjacent hexes differ by 1 unit in q, r, or both axial co-ordinates`,
            `Players can build new entities or repair existing ones if they have the resources`,
            `Players can initiate chat with other players, which costs 1 order`,
            `The game ends when a player achieves a score that is double the score of any other player in all attributes (military and economic)`,            
        ],
        manifest: summarizeManifest(gameState.manifestData),
        responseFormatInstructions: `Respond EXCLUSIVELY with a valid JSON object. Do not include markdown codeblock wrappers (\`\`\`json). Your response MUST follow this structure:
        {"thoughtProcess": "Short strategic reason", "type": "ACTION" | "CHAT" | "END_TURN", "entityId": "string (for ACTION)", "actionName": "string (for ACTION)", 
        "targetCell": { "q": number, "r": number }, "targetEntityId": "string (optional for ACTION)", "targetPlayerId": "string (for CHAT)"}`
    }

    let attempts = 10; // Safeguard against infinite loops
    while (player.orders > 0 && attempts > 0) {
        attempts--;
        const summary = summarize(player, gameState);

        console.log(systemPrompt, summary);

        // TODO: send summary to LLM and get back one of
        // - structured order (needs to be translated into game actions) - examples:
        //  - move towards cell X with entity Y (we try to move in that direction)
        //  - attack entity X with entity Y (move first if needed to be in range of entity X, then attack)
        //  - build entity name with entity Y (we try to build in any adjacent cell to entity Y, if not possible we see if we can first move and the build close by)
        //  - repair entity X with entity Y (move first if needed to be adjacent to entity X, then repair)
        // - or start chat with another player (costs 1 order)
        // - or end turn (save orders, or nothing else to do)

        // TODO: reset attempts if we get a valid order back from LLM, so we can keep processing until we run out of orders or the LLM wants to end the turn

        return // TODO only do this if LLM wants to end the turn to save orders for next turn
    }    
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
    return {
        orders: player.orders, 
        resources: player.resources,
        score: player.score,       
        cells: {
            visible: Array.from(player.visibleCells),
            explored: Array.from(player.exploredCells.difference(player.visibleCells))
        },
        entities: player.getEntities(gameState).map(summarizeEntity),
        opponents: opponents
    };
}

function summarizeEntity(entity) {
    return {
        id: entity.id,
        name: entity.name,
        cell: entity.cell,
        health: entity.health,
        maxHealth: entity.maxHealth,
        actionPoints: entity.actionPoints,
        damage: entity.damage,
        armor: entity.armor        
    };
}

function summarizeManifest(manifest) {
    const summary = {};
    Object.entries(manifest.entities).forEach(([name, entity]) => {
        const {spawnCost, maintenance, buildables, repairables, score, yields, actions} = entity;
        summary[name] = {spawnCost, maintenance, buildables, repairables, score, yields, actions};
    });
    return summary;
}

// FIXME - this is too hard, make it simpler for LLM