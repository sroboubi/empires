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
| `mapRadius` | Hex map radius (default 12) |
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
override happens in the harness). Free tier options (Oct 2026): Google Gemini
Flash (~1,500 req/day, no card), Groq (~30 RPM) — both were flaky when last tested.
