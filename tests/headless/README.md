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

# Reproducible game: the same seed gives the same map and the same game
npm test -- 20 --seed 42
```

## AI controller suite (tournaments)

`tournament.mjs` runs one or more game settings repeatedly and writes
Markdown reports you can inspect. Each iteration is a separate
`headless.mjs` process, so runs cannot leak state into each other. The real
game and the real AI managers run — nothing in `src/` changes.

```bash
cd tests/headless
npm run test:suite:quick   # 2 games x 1 iteration x 5 turns, for a smoke check
npm run test:suite         # suite.example.json: 2 games x 2 iterations
npm run test:suite -- --config my-suite.json
npm run test:suite -- --config my-suite.json --iterations 10 --turns 60

# Exact output directory (otherwise a timestamped folder is created):
npm run test:suite -- --out results/my-run

# Run only one configured game, or use more CPU:
npm run test:suite -- --game standard-vs-apex --concurrency 4
```

The suite config is a superset of the single-game config. Top-level fields
are defaults; each entry in `games` overrides them:

```json
{
  "name": "AI controller comparison",
  "outputDir": "results",
  "iterations": 2,
  "turns": 30,
  "mapSize": 16,
  "seed": 1000,
  "seedStrategy": "increment",
  "seedStep": 1,
  "concurrency": 1,
  "logPatterns": ["\\[AiHelper\\]", "\\[Barbarians\\]"],
  "defaults": {
    "winCondition": { "absoluteScore": 1000, "relativeScore": 2 },
    "initialization": { "orders": { "max": 6, "perTurn": 5 } },
    "barbarians": null
  },
  "players": [
    { "id": 1, "name": "Blue", "color": "#0000ff", "controller": "standard" },
    { "id": 2, "name": "Red", "color": "#ff0000", "controller": "apex" }
  ],
  "games": [
    {
      "id": "standard-vs-apex",
      "iterations": 5,
      "players": [
        { "id": 1, "name": "Blue", "color": "#0000ff", "controller": "standard" },
        { "id": 2, "name": "Red", "color": "#ff0000", "controller": "apex" }
      ]
    },
    {
      "id": "hark-vs-entity-barbarians",
      "players": [
        { "id": 1, "name": "Blue", "color": "#0000ff", "controller": "hark" },
        { "id": 2, "name": "Red", "color": "#ff0000", "controller": "entity" }
      ],
      "barbarians": {
        "horde": { "barbarian": { "min": 2, "max": 4 } },
        "spawnFrequencyTurns": 5,
        "maxNumber": 20,
        "maxAge": 25,
        "aggression": 1
      }
    }
  ]
}
```

**Controllers.** `controller` may be:

- a key from `definitions/ai.json` (`standard`, `adaptive`, `bigPickle`,
  `apex`, `hark`, `entity`, `fable`, `opus`, `llm-json-gemma-4`,
  `llm-menu-deepseek-4.1`, …) — the same URL/config/provider/leader
  overlay the browser setup uses;
- a `{ "key": "apex", "config": { ... } }` object;
- a raw `{ "url": "./ai/tactical/apexAi.js", "config": {} }` object;
- legacy `"ai"` (SmartManager) or `"llm"` (menu harness).

Optional per-player `label` controls the report label; `controllerConfig`
is merged over the registry config. Optional `strategicController` works
the same way (`"dummy"` or a key from `strategicControllers`).

**Iterations and seeds.** `iterations` is per game setting. With
`seedStrategy: "increment"` (the default), iteration `i` uses
`seed + i * seedStep`, so each iteration is a different map/game. Use
`"same"` to replay one seed, or `"random"` to ignore the base seed per
iteration. LLM players are not deterministic even with the same seed.

**Log capture.** Every console line is tested against `logPatterns`
(JavaScript regex strings; a game entry can override the suite list).
Matching lines are stored with their round number and rendered in the
reports. Raw logs are not kept unless
`saveFullLogs` is true (or `--full-logs`); the per-iteration stdout is still
available to the runner and is included on failure. To capture AI helper
chat lines, for example:

```json
"logPatterns": ["\\[AiHelper\\]", "\\[AI [^\\]]+\\]\\[(?:warn|combat)\\]"]
```

Strings are JavaScript regular expressions, so escape literal brackets. For a
plain-text match use an object instead:

```json
"logPatterns": [{ "pattern": "[AiHelper]", "literal": true }]
```

**Output layout.** By default a timestamped folder is created:

```text
results/<suite>-<timestamp>/
  summary.md                     # all settings: winners, win rates, averages
  games/<game>.md                # one setting: averages and over-time tables
  runs/<game>/iteration-N.md     # one iteration: full detail
  runs/<game>/iteration-N.metrics.json  # raw metrics (machine-readable)
  runs/<game>/iteration-N.config.json   # exact config used (mode 0600)
  logs/<game>.md                 # all regex-matched log lines
  suite.resolved.json            # suite copy with secrets redacted
```

The Markdown reports include, per run and aggregated across iterations:

- final scores (military/economic/exploration/total), winner and leader;
- which controller/model won, win rate, and lead count;
- final entities of each type, built/lost/killed counts;
- damage dealt/taken;
- chats initiated/participated/messages, trades proposed/accepted/
  countered/rejected/active;
- barbarian spawns, encounters, targeted/ignored decisions, attacks,
  player units killed, barbarians killed;
- score over time (every round, all score categories in per-run detail);
- gross resource produced/consumed per round and per resource, plus final
  stock (production includes yields, treasure, trade receipts and
  orders-overflow conversions; consumption includes upkeep, build/spawn
  costs and trade sends);
- every log line matching `logPatterns`.

Exit code is non-zero if any iteration failed (assertions, crash, timeout).
The reports are still written. `timeoutMs` (suite or game level) kills a
stuck iteration; `concurrency` runs that many child processes at once.

### LM Studio / local OpenAI-compatible servers

LM Studio on the host listens on port 1234 by default. Inside the sandbox
`localhost` means the sandbox, so point the config at
`http://host.docker.internal:1234/v1` instead. Enable LM Studio's
"Serve on Local Network" option if the sandbox cannot reach a loopback-only
server.

Get the exact model id on the host or from the sandbox after network
approval:

```bash
curl -s http://host.docker.internal:1234/v1/models
```

Copy `suite.lmstudio.example.json`, replace `<MODEL_ID_*>` and
`<MODEL_NAME_*>` with the ids/names from that response, then:

```bash
npm run test:suite -- --config suite.lmstudio.json --iterations 1 --turns 5
```

The example overrides `baseUrl` and `model` per player via
`controllerConfig`, so `definitions/ai.json` does not need to change. The
`[LLM Request Error]`, `[LLM Timeout]` and `[Harness]` log patterns surface
request errors and turn output (avoid capturing every `[LLMClient]` debug
line unless you want the full model responses in the report).
The first request to a new host is blocked by the sandbox network policy;
approve the pending request on the host:

```bash
sbx policy approval ls
sbx policy approval inspect <approval-id>
sbx policy approval respond <approval-id> --option <option-id>
```

## Game setup

Game configuration comes from an optional JSON config file (see `config.example.json`):

| Field | Description |
|-------|-------------|
| `turns` | Number of turns to simulate |
| `mapSize` | Hex map size (default 12; Small is 32) |
| `seed` | Game seed (number or string); `--seed N` on the command line overrides it. The same seed and `mapSize` give the same map, and the in-game randomness (barbarian hordes, treasure rewards, the overflow-resource pick) is seeded too, so a game between AI players replays exactly. Omitted = random, as before. LLM players are not deterministic. |
| `players` | Array of `{id, name, color, controller, strategicController?}` — `controller` is `'ai'` (SmartManager), `'llm'` (LLM harness), or an object `{url, config}` used as-is. `strategicController` is optional (Phase 26): `'dummy'` (coded strategic AI with a fixed directive) or an object `{url, config}` used as-is |
| `barbarians` | Barbarian settings object, or null to disable |
| `llm` | `{apiKey, baseUrl, orderedModels}` — required for `'llm'` players |

Without a config file, defaults to 2 SmartManager AI players on a radius-12 map.

`strategic-dummy.json` exercises Phase 26: Blue has the coded strategic AI, which
sets its directive once per turn; the run asserts the directive is set and still
matches after the save/load round-trip.

## Checkpoint / resume

Long LLM games outlive single runtime sessions, so the harness can
checkpoint at every round end and resume after a kill:

```bash
# Fresh run with checkpointing (one checkpoint file per run directory)
node --import ./stubs.mjs --loader ./loader.mjs ./headless.mjs \
  --config mygame.json --checkpoint-dir ~/workspace/llm-play/checkpoints/my-run

# After a kill: resume with the SAME config file, playing only the
# remaining rounds. Checkpointing continues into the same directory,
# so a resumed run survives a second kill the same way.
node --import ./stubs.mjs --loader ./loader.mjs ./headless.mjs \
  --config mygame.json --resume ~/workspace/llm-play/checkpoints/my-run
# (--resume also accepts the checkpoint file itself, and --checkpoint-dir
# can override where the resumed run writes.)
```

**What a checkpoint is.** The production save payload —
`GameState.serialize()` output, exactly what the browser's saveManager
stores — written as `<dir>/checkpoint.json`. The saveManager itself is
IndexedDB-only and cannot run under Node, so the harness stores the same
payload as a plain file instead of duplicating serialization code.
Writes are atomic (tmp file + rename): a kill mid-write leaves the
previous round's checkpoint intact. One checkpoint is also saved at
setup, so even a kill during round 1 is resumable (and preserves the
generated map, which a fresh run would not reproduce).

**What resume restores.** Map cells, entities (full state + age),
players (resources, orders, scores, explored/visible cells, history),
chat history, round number, and settings. Two things serialize() does
not carry are restored in the harness: `initializationSettings`
(SmartManager deficit reasoning) from the checkpoint's own settings,
and AI managers, which are re-created from the resume-time config —
Harness/SmartManager hold no cross-turn state worth preserving
(Harness keeps only a lazy client and a prompt cache). Controllers and
LLM credentials always come from the resume-time config, never from the
checkpoint.

**Granularity and refusal rules.** Checkpoints are whole rounds: a kill
mid-round loses that round's partial progress, and resume replays the
partial round from its start (for LLM runs, that round's LLM calls are
re-spent — bounded at one round). Rounds whose `onRoundEnd()` completed
are never replayed. Resume refuses, loudly: a missing/malformed
checkpoint, a completed game (`gameOver`, or rounds already >= the
config's turn total), and a player-list mismatch against the config.
A fresh run likewise refuses to start in a directory that already holds
a checkpoint, so a typo cannot destroy a killed run's only way back.
The same applies to resume with an explicit `--checkpoint-dir` pointing
at a different run's directory; checkpointing back into the resume dir
(the default) is always allowed.

**Secrets.** Checkpoint files live outside the repo (never committed)
and never carry credentials: `settings.llm.apiKey` is stripped on write,
since config `${VAR}` expansion can put a real key into settings.
Base URL and model list are kept (harmless, useful provenance).

**Not preserved / not deterministic.** The in-game RNG state is not
saved (a resumed game draws from Math.random), so it continues correctly
but is not a bit-identical replay of the killed process's future. Map
generation randomness does not matter: the generated cells are saved.

## How it works

| File | Purpose |
|------|---------|
| `headless.mjs` | Test driver: creates GameState, 2 AI players, drives turns, asserts, optional metrics JSON |
| `tournament.mjs` | AI suite runner: reads a suite config, runs iterations in child processes, writes Markdown reports |
| `metrics.mjs` | Out-of-tree instrumentation: resource flows, kills/losses, chats/trades, barbarian stats, log capture |
| `report.mjs` | Markdown renderers for suite summary, game reports, per-run detail, and logs |
| `checkpoint.mjs` | Checkpoint/resume: round-end save payloads to disk, resume validation (see above) |
| `repl.mjs` | Interactive REPL: step turns, inspect state, spawn entities, run AI manually |
| `stubs.mjs` | Browser API stubs: window, document, AudioContext, fetch (local files), IndexedDB, localStorage |
| `loader.mjs` | Node module loader: replaces `renderer.js`/`audio.js`/`main.js` with no-ops, redirects esm.sh CDN to node_modules |
| `renderer-stub.mjs` | Auto-generated no-op exports matching `src/renderer.js` (regenerate if exports change) |
| `package.json` | npm deps for the harness only (three, simplex-noise, ajv) — the game itself uses CDN imports and needs no npm |
| `config.example.json` | Template for game setup (players, map, win conditions, etc.) |
| `suite.example.json` | Tournament template: multiple AI matchups, iterations, log patterns |
| `suite.quick.json` | Fast smoke suite used by `npm run test:suite:quick` |
| `suite.llm.example.json` | LLM-vs-coded template (needs provider credentials/local model) |
| `suite.lmstudio.example.json` | LM Studio on the host: model-vs-model and LLM-vs-coded templates |

**Key design decision:** turn flow is shared, not duplicated. The harness drives turns through the real `Player.step()` with a no-op continuation (`player.step(() => {})`); the browser passes its `nextTurn` as the continuation. Setup passes no continuation, so no background AI turn fires at game creation. Rendering, sound, and UI remain stubbed — those need the Modal browser runs.

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
No game logic is reimplemented in the harness.

**What is stubbed.** The loader (`loader.mjs`) replaces `renderer.js`, `audio.js`,
and `main.js` with no-ops, and `stubs.mjs` fakes the browser APIs (window,
document, navigator, rAF, AudioContext, fetch served from disk, IndexedDB,
localStorage). Bare imports (`three`, `ajv`, `simplex-noise`) resolve to
`tests/headless/node_modules`; the `esm.sh` simplex-noise import is redirected
there too. Rendering, sound, and UI never execute headless — those need the
Modal browser runs. Note `main.js` is stubbed only for its UI functions
(e.g. `updatePlayersUI`, imported by `src/ai/utils.js`): turn flow and the
win check no longer depend on it (see below).

**Inputs.** A `--config` JSON file (`turns`, `mapSize`, `players` with per-player
`controller`, `winCondition`, `barbarians`, `llm` with `apiKey`/`baseUrl`/
`orderedModels`, `initialization`) plus an optional CLI turn count.

**Turn loop — the exact points game logic is invoked, per player per turn:**
1. `player.step(() => {})` — the real `Player.step()`: refill, entity steps,
   visibility, scores, then the AI turn (awaited). The no-op continuation
   means step() does not chain into the browser's `nextTurn()`; the harness
   drives advancement itself. Setup passes no continuation, so no background
   AI turn fires at game creation.
2. Per-player assertions (orders ≥ 0, no NaN in resources/scores).
3. After the last player: `gameState.onRoundEnd()` (barbarians etc. when enabled).
4. `gameState.checkWinConditions()` after each player's turn, exactly as the
   browser checks after each `endTurn()`; only from round 5 (`MIN_GAME_ROUNDS`).
5. Global entity assertions; at the end, a save/load round-trip check.

**Outputs.** Stdout log (turn headers, `[AI ...]` action lines, scores,
game-over line), process exit code, and the save/load result.

**Where headless can still drift from the game (check these first on any divergence):**
1. **Map generation arguments:** headless must pass `manifest.terrains`
   explicitly to `generateMap()`. Passing null once produced an all-Default
   world where nothing was buildable (the real game passes
   `manifestData.terrains`).
2. **Per-player controller override** swaps `aiManager` in the harness only;
   the game itself picks LLM vs SmartManager globally via `settings.llm`.
3. **autoSave is disabled** in headless; save/load is only asserted at the end.
4. **Turn-advance structure:** the browser advances via the
   `nextTurn` → `endTurn` → `startTurn` → `step` chain after each player's
   turn, while headless sets `activePlayerIndex` directly and calls
   `onRoundEnd` after the last player. The per-player actions and the
   round-end effects are the same; only the driver differs.

**Retired seams (fixed by the step/win-check refactor):**
- Turn driving used to replay `Player.step()`'s synchronous parts manually
  because `step()` hardcoded a `nextTurn()` import from `main.js`. `step()`
  now takes the continuation as a parameter, so headless calls the real thing.
- The win check used to duplicate `main.js` `checkWinConditions`
  (absolute + relative with the `nextHighest > 0` guard). It is now the
  single pure `GameState.checkWinConditions()` used by both drivers.
  Only the top scorer can win; a tie for top means no winner; a
  second-highest of 0 no longer blocks a relative win.
