# Mistakes Log

This file documents mistakes made during development, reasons why they occurred, and guidelines to avoid them in the future.

---

### Mistake 1: Hardcoding entity names instead of deriving them dynamically from configuration
- **Description**: In `src/ai/barbarians.js`, a helper `isBarbarian()` was written with hardcoded string checks for `'barbarian'` and `'barbarianChief'`.
- **Why it was made**: Assumed only the predefined barbarian units in manifest would ever be used.
- **What to avoid in the future**: Never hardcode entity names or types when they are configurable. Always derive the list of relevant entity names directly from the configuration (e.g. `Object.keys(settings.horde)`).

---

### Mistake 2: Using magic numbers / raw elevation checks instead of `canStandOn()`
- **Description**: In `findOppositeBorderCell` and spawn candidate filtering, `cell.terrain.elevation > -0.3` was used as a fallback check for traversability.
- **Why it was made**: Attempted an inline fallback without referencing `canStandOn()`.
- **What to avoid in the future**: Never check terrain attributes with arbitrary magic numbers. Always delegate traversability checks to `canStandOn()` on the entity or controller class. If no `canStandOn()` check is available, do not guess traversability.

---

### Mistake 3: Adding hardcoded configuration fallbacks when settings are missing
- **Description**: Hardcoded fallback values for `horde` (`{ barbarian: { min: 3, max: 5 }, barbarianChief: { min: 1, max: 2 } }`) were added in `manageBarbarians()`.
- **Why it was made**: Attempted to provide default behavior when settings were absent.
- **What to avoid in the future**: If settings/config are missing, respect that the feature is unconfigured or disabled rather than injecting arbitrary hardcoded defaults. If there is no config/horde, do nothing.

---

### Mistake 4: Missing descriptive runtime logging for AI behaviors
- **Description**: Barbarians performed spawn, march, attack, and despawn actions silently without `console.log` feedback.
- **Why it was made**: Focused on functionality without providing operational visibility.
- **What to avoid in the future**: Always add informative logging for AI actions (spawning, targeting, attacking, moving, dying of old age) so that their decisions and lifecycle are easy to trace in the console.

---

### Mistake 5: Spending scarce resources on proactive growth while critical deficits are pending
- **Description**: In `smartManager.js`, when a deficit build step could not be afforded immediately, `handleProactiveGrowth()` spent remaining resources on other non-essential entities.
- **Why it was made**: Did not track or reserve the resources needed for the pending deficit resolution step.
- **What to avoid in the future**: Keep track of scarce resources needed to resolve deficits and prevent proactive growth from spending those required resources.

---

### Mistake 6: Flawed exploration targeting adjacent cells instead of pathfinding to nearest unexplored hex
- **Description**: In `handleExploration()`, the AI picked adjacent neighbor cells (already explored) resulting in 1-hex oscillation, and used `destroyOnBuild` checks.
- **Why it was made**: Did not use BFS/pathfinding across traversable terrain to the nearest unexplored hex and did not consume available AP along the route.
- **What to avoid in the future**: Exclude all builder units from exploration, find the closest reachable unexplored cell using BFS, and move the unit as far along the path as possible in a single order.

---

### Mistake 7: Querying gameState.entities directly instead of using player.getOpponents() for visible enemies
- **Description**: In `handleCombatAndThreats()`, visible enemies were retrieved from `gameState.entities` with a custom filter instead of calling `player.getOpponents(gameState)`.
- **Why it was made**: Attempted to catch arbitrary entities without respecting the designated `player.getOpponents(gameState)` API.
- **What to avoid in the future**: Always use `player.getOpponents(gameState)` to retrieve visible opponent entities, strictly following Guideline 19.

---

### Mistake 8: Hardcoding barbarian horde unit names in the setup UI
- **Description**: In `index.html`, range-slider widgets were hardcoded for `barbarian` and `barbarianChief` units. In `src/main.js`, `RANGE_SLIDER_IDS`, the `setRange` calls in `openSetupModal`, and the `horde` object construction in `handleStartGameClicked` all referenced those two names explicitly. Adding a new unit (e.g. `barbarianPrincess`) to `defaultSettings.json` had no effect on the UI.
- **Why it was made**: The initial implementation assumed only the two predefined horde unit types would ever exist.
- **What to avoid in the future**: Never hardcode entity/unit names when the authoritative source is a config file. Always iterate over `Object.keys(config)` / `Object.entries(config)` to generate UI widgets dynamically, so the UI automatically reflects any additions or removals in the config.

---

### Mistake 9: Coupling prompt configuration to LLM client construction instead of invocation
- **Description**: In `src/ai/llm/client.js` and `src/ai/llm/harness.js`, `systemPrompt` and `responseSchema` were strictly bound to the `LLMClient` constructor. This led to creating ad-hoc `_chatHarness` objects and proliferating `LLMClient` instances per opponent/pair to handle different prompt modes (structured turn commands vs. roleplay dialogue vs. internal summary notes).
- **Why it was made**: Assumed that an `LLMClient` should be statically configured per persona and task rather than being a single versatile invocation client that accepts dynamic prompts and options per `generate()` call.
- **What to avoid in the future**: Keep client wrappers stateless with respect to dynamic prompts and task schemas. Pass `systemPrompt` and task-specific schema/config options into the execution function (`generate(content, systemPrompt, options)`). Maintain a single AI harness and client instance per player stored in the Player class (`player.aiManager`).

---

### Mistake 10: Capturing initial game state in ReplayRecorder before map generation and entity initialization
- **Description**: In `src/main.js`, `replayRecorder.start(gameState, settings)` was invoked right after `gameState = new GameState();` but before `gameState.generateMap(...)` and `gameState.initializeManifest(...)`. Because `hexGrid`, `players`, and `entities` were not yet generated, `initialState.cells` was recorded as an empty object `{}`. Loading a replay resulted in `HexGrid.fromCells({})` creating an empty grid with zero hex cells, causing the renderer to display only the single dark ground cylinder ("one black hex").
- **Why it was made**: Placed the recorder initialization at the top of `startNewGame()` assuming it needed to precede any game events, without verifying that `generateMap` and `initializeManifest` had populated `gameState.hexGrid`, `gameState.players`, and `gameState.entities`.
- **What to avoid in the future**: Always initialize and start state-capturing recorders *after* all prerequisite state (e.g. map grid, players, starting units) has been completely constructed. Additionally, implement defensive backfills and loading fallbacks so unpopulated initial states do not produce a blank or broken scene.

---

### Mistake 11: Moving ReplayRecorder.start() before initializeManifest() to "capture the initial AI turn"
- **Description**: In `src/main.js`, `replayRecorder.start(gameState, settings)` was moved before `gameState.initializeManifest(...)` to avoid missing the first AI turn. This regressed Mistake 10: `initialState.players` and `initialState.entities` were recorded as empty arrays. On playback, `gameState.players` was empty, so `applySnapshot()` could not resolve `ownerId` to a Player, and `spawnEntityMesh()` skipped the owner color ring for every entity.
- **Why it was made**: Assumed the recorder had to be active before `initializeManifest()` to capture the initial AI turn, without accounting for the fact that `initializeManifest()` is what creates players and starting units. The AI turn is asynchronous, so starting the recorder immediately after `initializeManifest()` returns still captures the initial state before the first AI action.
- **What to avoid in the future**: Never start a state-capturing recorder before the state it captures has been constructed. If an async process (AI turn) must be captured, start the recorder synchronously after the state is built but before the async work resumes; do not move the recorder earlier than the state construction.

