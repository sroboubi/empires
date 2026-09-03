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


