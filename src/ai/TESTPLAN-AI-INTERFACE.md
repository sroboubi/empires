# Manual Test Plan: AI Interface Specification Enforcement

This test plan provides comprehensive verification procedures for human manual testing of the AI Interface Proxy implementation (`src/aiInterfaceProxy.js`, `src/player.js`, `src/aiHelper.js`).

---

## 1. Objectives

Verify that:
1. **Architectural Separation**: AI controllers and base classes in `src/ai/` have zero dependencies on or imports of `aiInterfaceProxy.js`. The proxy wrapper is instantiated cleanly via `createAiManager` in `src/player.js`.
2. **Direct State Mutations are Blocked (WRITE Protection)**: Any attempt by AI controllers to mutate game state (player resources, orders, entity HP/AP, cell properties, game round) throws an explicit `Error`.
3. **Action Legality is Enforced**: An AI can only call `action.do()` on entities it owns; attempting to command enemy/neutral entities directly or via `helper.attack()` throws an `Error`.
4. **Fog of War & Privacy are Maintained (READ Visibility)**:
   - Entities outside visible cells do not appear in `gameState.entities`, `getEntityAt()`, or `getEntityById()`.
   - Terrain and resources of unexplored cells return `undefined`.
   - Other players' resources, history, and orders return `undefined` (does NOT throw).
   - Chat history of third-party players returns an empty list.
5. **Allowed Writes Succeed**:
   - Calling `action.do()` on owned entities modifies engine state legally.
   - Calling `player.addHistoryEntry()` records entries in player history.
   - Calling `helper.chat()` deducts 1 order via `player.consumeOrders(1)` and runs chat.
6. **Existing AI Managers Function Cleanly**:
   - `SmartManager` (`src/ai/standard/smartManager.js`)
   - `AdaptiveManager` (`src/ai/tactical/adaptiveManager.js`)
   - `JsonHarness` (`src/ai/llm/json/harness.js`)
   - `MenuHarness` (`src/ai/llm/menu/harness.js`)

---

## 2. Test Scenarios

### Scenario A: Direct State Mutation Traps (WRITE Protection)

Open developer console in the browser while running a game:

```javascript
const p1 = gameState.players.find(p => p.isAI);
const ai = await p1.getAiManager();
```

1. **Player Orders Mutation**:
   - **Action**: Run `ai.player.orders = 99;` in console.
   - **Expected**: Throws `Error: [AI Interface] Illegal write: AI '<name>' attempted to set 'orders'. Use action.do(), history, or chat.`
   - **Verification**: `p1.orders` remains unchanged.

2. **Player Resources Mutation**:
   - **Action**: Run `ai.player.resources.gold = 9999;`
   - **Expected**: Throws `Error: [AI Interface] Illegal write: ... attempted to set 'gold'.`
   - **Verification**: `p1.resources.gold` remains unchanged.

3. **Entity Health & Coordinates Mutation**:
   - **Action**: Run `const unit = ai.player.getEntities()[0]; unit.health = 500;`
   - **Expected**: Throws `Error: [AI Interface] Illegal write: ... attempted to set 'health'.`
   - **Action**: Run `unit.q = 0; unit.r = 0;`
   - **Expected**: Throws Error.
   - **Action**: Run `unit.actionPoints = 100;`
   - **Expected**: Throws Error.

4. **GameState Direct Mutation**:
   - **Action**: Run `ai.gameState.currentRound = 99;`
   - **Expected**: Throws `Error: [AI Interface] Illegal write: ... attempted to set 'currentRound' on gameState.`

5. **Grid Cell Mutation**:
   - **Action**: Run `const cell = ai.gameState.hexGrid.getCell(unit.q, unit.r); cell.terrain = null;`
   - **Expected**: Throws `Error: [AI Interface] Illegal write: ... attempted to set 'terrain'.`

---

### Scenario B: Action Legality & Ownership Enforcement

1. **Owned Entity Action Execution**:
   - **Action**: Run:
     ```javascript
     const unit = ai.player.getEntities().find(e => e.active && e.getActions().some(a => a.name === "Move"));
     const moveAction = unit.getActions().find(a => a.name === "Move");
     const neighbor = ai.helper.getNeighbors(unit.q, unit.r)[0];
     moveAction.do(neighbor, null);
     ```
   - **Expected**: Action executes legally, deducting unit AP and player orders via normal game rules.

2. **Enemy Entity Action Execution Block (Gap 4)**:
   - **Action**: Find an enemy entity and attempt to execute its action:
     ```javascript
     const enemy = Object.values(ai.player.getOpponents())[0]?.entities[0];
     if (enemy) {
         const enemyMove = enemy.getActions().find(a => a.name === "Move");
         enemyMove.do(neighbor, null);
     }
     ```
   - **Expected**: Throws `Error: [AI Interface] Illegal action: AI '<name>' attempted to execute action "Move" on entity "<enemyName>" owned by another player.`

3. **Helper Action Ownership Check (Gap 4)**:
   - **Action**: Run `ai.helper.attack(ai.gameState, enemy, unit);`
   - **Expected**: Throws `Error: [AI Interface] Illegal action: AI '<name>' cannot command entity "<enemyName>" owned by another player.`

---

### Scenario C: Read Visibility & Fog of War

1. **Opponent Private Data Hidden (Gap 5)**:
   - **Action**: Run:
     ```javascript
     const otherPlayer = ai.gameState.players.find(p => p.id !== ai.player.id);
     console.log('Name:', otherPlayer.name);
     console.log('Score:', otherPlayer.score);
     console.log('Resources:', otherPlayer.resources);
     console.log('Orders:', otherPlayer.orders);
     console.log('History:', otherPlayer.history);
     ```
   - **Expected**: `name` and `score` return valid public data; `resources`, `orders`, and `history` return `undefined` without throwing.

2. **Unexplored Hex Cells Hidden (Gap 1)**:
   - Find a coordinate `(q, r)` not in `p1.exploredCells`:
     ```javascript
     const cell = ai.gameState.hexGrid.getCell(unexploredQ, unexploredR);
     console.log('Unexplored cell:', cell);
     ```
   - **Expected**: Returns `undefined`.
   - Accessing `cell.terrain` or `cell.resources` on an unexplored cell returns `undefined`.

3. **Entities in Fog of War Hidden (Gap 2)**:
   - Locate an entity positioned on a cell where `!p1.isVisible(entity.q, entity.r)`:
     ```javascript
     const inList = ai.gameState.entities.find(e => e.id === hiddenEntityId);
     const atPos = ai.gameState.getEntityAt(hiddenQ, hiddenR);
     const byId = ai.gameState.getEntityById(hiddenEntityId);
     ```
   - **Expected**: `inList` is undefined, `atPos` is `null`, and `byId` is `null`.

4. **Third-Party Chat Privacy (Gap 3)**:
   - **Action**: Have Player 2 and Player 3 chat with each other. From Player 1's AI:
     ```javascript
     const chats = ai.gameState.getChatHistory(player2, player3);
     console.log('Chats between P2 and P3:', chats);
     ```
   - **Expected**: Returns `[]` (empty list).

---

### Scenario D: Allowed Writes

1. **Player History Logging**:
   - **Action**: Run `ai.player.addHistoryEntry(1, { category: 'note', details: 'Test diplomacy note' });`
   - **Expected**: Executes cleanly. Inspecting `p1.getHistory(1)` shows the newly added note entry.

2. **AiHelper Chat Order Deduction**:
   - **Action**: Run `await ai.helper.chat(ai.player, otherPlayer, 'Hello there');`
   - **Expected**:
     - Initiating chat reduces `ai.player.orders` by exactly 1 (via `consumeOrders(1)`).
     - Dialogue proceeds normally.

---

### Scenario E: End-to-End Manager Gameplay Verification

1. **Standard AI (`SmartManager`)**:
   - Start a game with Player 2 set to "Standard AI".
   - Step through turns 1 to 5.
   - **Expected**: AI completes turns cleanly without proxy errors.

2. **Tactical AI (`AdaptiveManager`)**:
   - Start a game with Player 2 set to "Adaptive Tactical AI".
   - Step through turns 1 to 5.
   - **Expected**: AI completes turns cleanly without proxy errors.

3. **LLM Harnesses (`JsonHarness` & `MenuHarness`)**:
   - Start a game with Player 2 configured for LLM JSON or LLM Menu.
   - When the LLM decides to CHAT:
     - Verify `orders` decreases by 1 inside `aiHelper.chat()`.
     - In Menu harness, verify `chatCooldownRemaining()` properly decrements over subsequent turns using `this._chatCooldownOrders`.
     - No direct state mutation errors are logged.
