# Headless Game Logic Tests

Runs the real game logic in Node.js with stubbed browser APIs. No browser, no GPU, no rendering. Turns run in milliseconds.

**What it tests:** Game logic — AI decisions, turn advancement, resource calculations, combat, save/load round-trip. Catches crashes, NaNs, and logic bugs. (This is what found the `involvedCells` bug in `handleHeavyRepairs`.)

**What it does NOT test:** Rendering, visual output, real user input, LLM responses.

## Usage

```bash
cd tests/headless
npm install  # one time

# Run 5 turns (default)
npm test

# Run 20 turns
npm test -- 20

# Custom game setup via config file
npm test -- --config config.example.json
npm test -- 20 --config mygame.json
```

## Game setup

Game configuration comes from an optional JSON config file (see `config.example.json`):

| Field | Description |
|-------|-------------|
| `turns` | Number of turns to simulate |
| `mapSize` | Hex map size (default 12; Small is 32) |
| `players` | Array of `{id, name, color, controller}` — `controller` is `'ai'` (SmartManager) or `'llm'` (LLM harness) |
| `barbarians` | Barbarian settings object, or null to disable |
| `llm` | `{apiKey, baseUrl, orderedModels}` — required for `'llm'` players |

Without a config file, defaults to 2 SmartManager AI players on a radius-12 map.

## How it works

| File | Purpose |
|------|---------|
| `headless.mjs` | Test driver: creates GameState, 2 AI players, drives turns, asserts |
| `repl.mjs` | Interactive REPL: step turns, inspect state, spawn entities, run AI manually |
| `stubs.mjs` | Browser API stubs: window, document, AudioContext, fetch (local files), IndexedDB, localStorage |
| `loader.mjs` | Node module loader: replaces `renderer.js`/`audio.js`/`main.js` with no-ops, redirects esm.sh CDN to node_modules |
| `renderer-stub.mjs` | Auto-generated no-op exports matching `src/renderer.js` (regenerate if exports change) |
| `package.json` | npm deps for the harness only (three, simplex-noise, ajv) — the game itself uses CDN imports and needs no npm |
| `config.example.json` | Template for game setup (players, map, win conditions, etc.) |

**Key design decision:** We bypass `Player.step()`'s `nextTurn()` chain (DOM-bound via `main.js`) and drive the AI managers directly. The synchronous parts of `Player.step()` (order refill, entity stepping, visibility) are called manually.

## Assertions

- Player orders never negative or NaN
- No NaN in resources or scores
- Entities never have negative health (unless destroyed)
- Save/load round-trip preserves entity count

## Interactive REPL

For poking at the game manually — debugging, balance checks, exploring state:

```bash
node --import ./stubs.mjs --loader ./loader.mjs ./repl.mjs [--config game.json]
```

```
empires> players
empires> step 5
empires> entity worker_1
empires> spawn swordsman 3 -2 1
empires> eval players[0].resources.gold
empires> quit
```

Type `help` for all commands.

## Adding LLM testing

Set a player's `controller` to `'llm'` in your config and add an `llm` section:

```json
{
  "players": [
    { "id": 1, "name": "Blue", "color": "#0000ff", "controller": "llm" },
    { "id": 2, "name": "Red", "color": "#ff0000", "controller": "ai" }
  ],
  "llm": {
    "apiKey": "sk-...",
    "baseUrl": "https://openrouter.ai/api/v1",
    "orderedModels": ["deepseek/deepseek-chat"]
  }
}
```

The harness swaps that player's `aiManager` to the LLM `Harness` after init (the game
itself picks LLM vs SmartManager globally via `settings.llm`, so the per-player
override happens in the harness). Free tier options (measured Oct 2026, per model):
Google Gemini 3.5-flash-lite (~500 req/day), newer Gemini flash models (~20 req/day),
Groq chat models (8K tokens/min, 200K tokens/day — not one full game/day at current
prompt sizes). Quotas are per model and per key; the game accepts a list of models
with fallback (`orderedModels`).

## How headless invokes game logic (and where it can drift)

**What runs is the real game.** `headless.mjs` imports the actual modules:
`GameState`, entities, `src/ai/utils.js` (`attack`/`support`/`build`/`explore`),
both AI managers (`SmartManager`, LLM `Harness`), and the LLM Markdown serializers.
No game logic is reimplemented in the harness — except the two seams listed below.

**What is stubbed.** The loader (`loader.mjs`) replaces `renderer.js`, `audio.js`,
and `main.js` with no-ops, and `stubs.mjs` fakes the browser APIs (window,
document, navigator, rAF, AudioContext, fetch served from disk, IndexedDB,
localStorage). Bare imports (`three`, `ajv`, `simplex-noise`) resolve to
`tests/headless/node_modules`; the `esm.sh` simplex-noise import is redirected
there too. Rendering, sound, and UI never execute headless — those need the
Modal browser runs.

**Inputs.** A `--config` JSON file (`turns`, `mapSize`, `players` with per-player
`controller`, `winCondition`, `barbarians`, `llm` with `apiKey`/`baseUrl`/
`orderedModels`, `initialization`) plus an optional CLI turn count.

**Turn loop — the exact points game logic is invoked, per player per turn:**
1. `player.refillOrders()`, `entity.step()` for each owned entity,
   `player.updateVisibility()`, `player.recalculateScore()` — the synchronous
   parts of `Player.step()`, replayed manually (see drift point 1).
2. `player.aiManager.processTurn()` — SmartManager or LLM Harness, driven directly.
3. Per-player assertions (orders ≥ 0, no NaN in resources/scores).
4. After all players: `gameState.onRoundEnd()` (barbarians etc. when enabled).
5. Win check (see drift point 2), only from round 5.
6. Global entity assertions; at the end, a save/load round-trip check.

**Outputs.** Stdout log (turn headers, `[AI ...]` action lines, scores,
game-over line), process exit code, and the save/load result.

**Where headless can drift from the game (check these first on any divergence):**
1. **Turn driving bypasses `Player.step()`'s `nextTurn()` chain** (DOM-bound via
   `main.js`). Headless replays only its synchronous parts. If `Player.step()`
   gains new synchronous behavior, headless must mirror it — this is how scores
   froze at turn 1 until `recalculateScore()` was extracted and called here.
2. **The win check duplicates `main.js` `checkWinConditions`** (absolute +
   relative with the `nextHighest > 0` guard). It must mirror `main.js` changes;
   the ai-chat branch once silently dropped that guard.
3. **Map generation arguments:** headless must pass `manifest.terrains`
   explicitly to `generateMap()`. Passing null once produced an all-Default
   world where nothing was buildable (the real game passes
   `manifestData.terrains`).
4. **Per-player controller override** swaps `aiManager` in the harness only;
   the game itself picks LLM vs SmartManager globally via `settings.llm`.
5. **autoSave is disabled** in headless; save/load is only asserted at the end.
