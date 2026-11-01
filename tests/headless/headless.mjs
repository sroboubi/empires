/**
 * Headless game logic test harness.
 * Runs the real game (GameState, entities, AI) in Node.js with stubbed browser APIs.
 * No browser, no GPU, no rendering.
 *
 * Usage:
 *   npm test                          # 5 turns, default config (2 AI players)
 *   npm test -- 20                     # 20 turns, default config
 *   npm test -- --config mygame.json   # custom game setup
 *   npm test -- 20 --config mygame.json
 *
 * Checkpoint / resume (long LLM games outlive single runtime sessions):
 *   npm test -- --config mygame.json --checkpoint-dir /path/to/run-dir
 *   npm test -- --config mygame.json --resume /path/to/run-dir
 * A checkpoint is saved at every round end (plus one at setup). Resume
 * loads the latest checkpoint and plays only the remaining rounds, with
 * the same config file (players, controllers, LLM credentials). See
 * tests/headless/README.md "Checkpoint / resume" and checkpoint.mjs.
 *
 * Config file (JSON) supports everything in the game settings:
 *   turns            - number of turns to simulate
 *   mapSize          - hex map radius (default 12)
 *   players          - array of {id, name, color, controller, description}
 *                      controller: 'ai' = SmartManager, 'llm' = LLM harness,
 *                      null = human (no AI)
 *   winCondition     - {absoluteScore, relativeScore}
 *   initialization   - {orders: {max, perTurn},
 *                       startingResources: {gold, wood, iron, food, gems},
 *                       startingUnits: {settler, worker, swordsman, ...}}
 *   barbarians       - barbarian settings {horde, spawnFrequencyTurns,
 *                      maxNumber, maxAge}, or null to disable
 *   llm              - {apiKey, baseUrl, orderedModels} for LLM players
 *
 * Any field omitted falls back to definitions/defaultSettings.json.
 * See config.example.json for a template.
 */
import { GameState } from '../../src/gameState.js';
import { loadGameManifest } from '../../src/manifestLoader.js';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { saveCheckpoint, loadCheckpoint, resolveCheckpointPath, CHECKPOINT_FILE } from './checkpoint.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { turns: 5, config: null, checkpointDir: null, resume: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) opts.config = args[++i];
    else if (args[i] === '--checkpoint-dir' && args[i + 1]) opts.checkpointDir = args[++i];
    else if (args[i] === '--resume' && args[i + 1]) opts.resume = args[++i];
    else if (!isNaN(parseInt(args[i]))) opts.turns = parseInt(args[i]);
  }
  return opts;
}

function expandEnvVars(obj) {
  // Recursively expand ${VAR} / $VAR in string values from process.env.
  // Lets configs reference secrets without committing them, e.g.
  // "apiKey": "${OPENROUTER_API_KEY}".
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (_, braced, plain) => process.env[braced || plain] ?? '');
  }
  if (Array.isArray(obj)) return obj.map(expandEnvVars);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, expandEnvVars(v)]));
  }
  return obj;
}

function loadConfig(path) {
  if (!path || !existsSync(path)) return {};
  return expandEnvVars(JSON.parse(readFileSync(path, 'utf-8')));
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failures++;
  }
}
function checkNoNaN(obj, path) {
  if (typeof obj === 'number') {
    assert(!Number.isNaN(obj), `NaN at ${path}`);
    return;
  }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) checkNoNaN(v, `${path}.${k}`);
  }
}

async function main() {
  const opts = parseArgs();
  const cfg = loadConfig(opts.config);
  const TURNS = cfg.turns || opts.turns;

  console.log(`[headless] Loading manifest...`);
  const manifest = await loadGameManifest();
  console.log(`[headless] Manifest loaded: ${Object.keys(manifest.entities).length} entities`);

  const ds = manifest.defaultSettings || {};

  // Player definitions come from the config in both modes: fresh runs use
  // them for setup, resume uses them to validate the checkpoint and to
  // pick controllers/credentials (see checkpoint.mjs header).
  const players = cfg.players || ds.players || [
    { id: 1, name: 'Blue', color: '#0000ff', controller: 'ai', description: '' },
    { id: 2, name: 'Red', color: '#ff0000', controller: 'ai', description: '' },
  ];
  // Ensure every player has a controller field (null = human/no AI)
  for (const p of players) {
    if (p.controller === undefined) p.controller = 'ai';
  }

  // Checkpoint wiring: --resume <dir|file> loads the latest checkpoint;
  // --checkpoint-dir <dir> enables round-end checkpointing. Resuming
  // without an explicit dir keeps checkpointing into the resume dir, so
  // a resumed run survives a second kill the same way the first did.
  let checkpointDir = opts.checkpointDir || null;
  let resumePath = null;
  if (opts.resume) {
    if (!opts.config) {
      throw new Error('--resume requires --config (same config file as the original run: it supplies players, controllers, and LLM credentials)');
    }
    resumePath = resolveCheckpointPath(opts.resume);
    if (!checkpointDir) checkpointDir = path.dirname(resumePath);
    // Same precious-checkpoint rule as fresh runs: resuming into a
    // DIFFERENT directory that already holds a checkpoint would destroy
    // that run's resume point at the first round end. (Checkpointing
    // back into the resume dir itself is the whole point, so it is
    // exempt.)
    if (opts.checkpointDir &&
        path.resolve(checkpointDir) !== path.resolve(path.dirname(resumePath)) &&
        existsSync(path.join(checkpointDir, CHECKPOINT_FILE))) {
      throw new Error(`refusing resume: --checkpoint-dir ${checkpointDir} already holds a checkpoint from another run — resume without --checkpoint-dir to keep checkpointing into the resume dir`);
    }
  }

  let gameState;
  let roundsDone = 0; // fresh runs start at round 1; resume overwrites this
  if (resumePath) {
    const cp = loadCheckpoint(resumePath);
    if (cp.data.gameOver) {
      throw new Error(`refusing to resume a completed game (checkpoint gameOver=true): ${resumePath}`);
    }
    roundsDone = cp.data.currentRound - 1;
    if (roundsDone >= TURNS) {
      throw new Error(`refusing to resume: checkpoint already at round ${cp.data.currentRound} (${roundsDone} rounds done) >= requested ${TURNS} turns: ${resumePath}`);
    }
    const cpIds = cp.data.players.map(p => p.id);
    const cfgIds = players.map(p => p.id);
    if (JSON.stringify(cpIds) !== JSON.stringify(cfgIds)) {
      throw new Error(`refusing to resume: checkpoint players [${cpIds}] do not match config players [${cfgIds}] — resume with the same config file`);
    }
    gameState = new GameState();
    gameState.manifestData = manifest; // needed for spawnEntity during deserialize
    gameState.deserialize(cp.raw);
    // deserialize() logs failures instead of throwing, so a checkpoint
    // referencing an unknown entity or a missing cell would silently
    // drop entities. Refuse rather than continue a corrupted game.
    if (gameState.entities.length !== cp.data.entities.length) {
      throw new Error(`refusing to resume: checkpoint has ${cp.data.entities.length} entities but only ${gameState.entities.length} restored: ${resumePath}`);
    }
    // serialize() does not carry initializationSettings (used by
    // SmartManager deficit reasoning); restore it from the checkpoint's
    // own settings, exactly as initializeManifest computes it.
    gameState.initializationSettings = gameState.settings?.initialization || manifest.initialization || {};
    // Controllers and LLM credentials come from the resume-time config,
    // never from the checkpoint (which is key-stripped on write).
    if (!gameState.settings) gameState.settings = {};
    gameState.settings.llm = cfg.llm || null;
    console.log(`[headless] Resumed from ${resumePath}: round ${gameState.currentRound} (${roundsDone} rounds done), ${gameState.entities.length} entities`);
  } else {
    // Build full game settings: config file overrides defaultSettings.json
    gameState = new GameState();
    const mapSize = cfg.mapSize || ds.mapSize || 12;
    gameState.generateMap(mapSize, manifest.terrains, manifest);
    const settings = {
      players,
      initialization: cfg.initialization || ds.initialization || {},
      winCondition: cfg.winCondition || ds.winCondition || null,
      barbarians: cfg.barbarians !== undefined ? cfg.barbarians : (ds.barbarians || null),
      llm: cfg.llm || null,
      autoSave: { enabled: false }, // no autosave in headless
    };
    gameState.initializeManifest(manifest, settings);
    console.log(`[headless] Game initialized: ${gameState.players.length} players, ${gameState.entities.length} entities`);
    if (checkpointDir) {
      // A checkpoint here means a previous run's resume point. Overwriting
      // it with a fresh game would destroy that run's only way back, so
      // refuse loudly instead of silently replacing it.
      if (existsSync(path.join(checkpointDir, CHECKPOINT_FILE))) {
        throw new Error(`refusing fresh run: checkpoint already exists in ${checkpointDir} — resume it with --resume, or use a new --checkpoint-dir`);
      }
      const s = saveCheckpoint(checkpointDir, gameState);
      console.log(`[headless] Initial checkpoint: round 1 -> ${s.path} (${(s.bytes / 1024).toFixed(1)} KB)`);
    }
  }
  if (cfg.barbarians) console.log(`[headless] Barbarians enabled`);
  if (cfg.llm?.orderedModels?.length) console.log(`[headless] LLM enabled: ${cfg.llm.orderedModels.join(', ')}`);

  // AI managers are created lazily by Player.ensureAiManager() from each
  // player's controller URL (see src/ai/managers.js) — no manual swapping
  // needed here. Eagerly resolve now so a bad controller URL fails fast.
  for (const p of gameState.players) {
    if (p.controller) await p.ensureAiManager();
  }

  assert(gameState.players.length === players.length, `expected ${players.length} players`);
  assert(gameState.entities.length > 0, 'expected starting entities');

  // Run turns headlessly through the real Player.step(), with a no-op
  // continuation: the harness drives advancement itself, so step() must
  // not chain into the browser's nextTurn(). Passing a function (rather
  // than nothing) is what makes AI players act; setup intentionally
  // passed no continuation, so no background AI turn fires at setup.
  // roundsDone rounds already happened (0 on fresh runs); the loop runs
  // exactly the remaining rounds, so completed rounds are never replayed.
  let roundsRun = 0;
  for (let turn = roundsDone + 1; turn <= TURNS; turn++) {
    roundsRun++;
    console.log(`[headless] --- Turn ${turn} (round ${gameState.currentRound}) ---`);
    for (let pi = 0; pi < gameState.players.length; pi++) {
      const player = gameState.players[pi];
      gameState.activePlayerIndex = pi;

      // Real Player.step(): refill, entity steps, visibility, scores,
      // then the AI turn (awaited). Errors are logged in step() and
      // rethrown here for the failure count.
      try {
        await player.step(() => {});
      } catch (err) {
        console.error(`  ERROR in ${player.name} AI: ${err.message}`);
        failures++;
      }

      // Assertions after each player's turn
      assert(player.orders >= 0, `${player.name} orders negative: ${player.orders}`);
      checkNoNaN(player.resources, `${player.name}.resources`);
      checkNoNaN(player.score, `${player.name}.score`);

      // Round-end (barbarians etc.) when the last player has acted,
      // matching the browser's endTurn wrap.
      if (pi === gameState.players.length - 1) {
        await gameState.onRoundEnd();
      }

      // Check win conditions after each player's turn, as the browser
      // does after each endTurn — via the single shared check.
      const win = gameState.checkWinConditions();
      if (win) {
        console.log(`[headless] ${win.winner.name} WINS at round ${gameState.currentRound} (score ${win.winner.score.total})`);
        console.log(`[headless] Reasons: ${win.reasons.join('; ')}`);
        gameState.gameOver = true;
        break;
      }
    }
    // Round-end checkpoint: the pi loop either ran all players (so
    // onRoundEnd() advanced the round) or broke on a win. Either way the
    // saved state is one resume refuses to replay past (gameOver) or the
    // clean start of the next round. The write is atomic: a kill
    // mid-save leaves the previous round's checkpoint intact.
    if (checkpointDir) {
      const s = saveCheckpoint(checkpointDir, gameState);
      console.log(`[headless] Checkpoint: round ${s.round} -> ${s.path} (${(s.bytes / 1024).toFixed(1)} KB)`);
    }
    if (gameState.gameOver) {
      console.log(`[headless] Game over at turn ${turn}`);
      break;
    }

    // Global assertions
    for (const e of gameState.entities) {
      assert(e.health >= 0 || e.destroyed, `entity ${e.id} has negative health ${e.health} but not destroyed`);
      checkNoNaN({ h: e.health, q: e.q, r: e.r }, `entity.${e.id}`);
    }
    console.log(`[headless] Turn ${turn} complete: ${gameState.entities.length} entities`);
  }

  // Serialization round-trip (production save path)
  const saved = gameState.serialize();
  assert(typeof saved === 'string' && saved.length > 1000, 'serialize produced output');
  const restored = new GameState();
  restored.manifestData = manifest; // needed for spawnEntity during deserialize
  restored.deserialize(saved);
  assert(restored.entities.length === gameState.entities.length, 'deserialize entity count matches');
  console.log(`[headless] Save/load round-trip OK (${(saved.length / 1024).toFixed(1)} KB)`);

  console.log(failures === 0
    ? (resumePath
      ? `\n[headless] ALL CHECKS PASSED (resumed: ${roundsRun} rounds this run, ${TURNS} total)`
      : `\n[headless] ALL CHECKS PASSED (${TURNS} turns)`)
    : `\n[headless] ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('[headless] FATAL:', err);
  process.exit(2);
});
