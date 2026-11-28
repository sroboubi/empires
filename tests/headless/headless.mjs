/**
 * Headless game logic test harness.
 * Runs the real game (GameState, entities, AI) in Node.js with stubbed browser APIs.
 * No browser, no GPU, no rendering.
 *
 * Usage:
 *   npm test                          # 5 turns, default config (2 AI players)
 *   npm test -- 20                     # 20 turns, default config
 *   npm test -- --config mygame.json   # custom game setup
 *   npm test -- 20 --config mygame.json  # CLI 20 overrides config.turns
 *   npm test -- 20 --seed 42          # reproducible game (same seed = same map and same game)
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
 *   seed             - game seed (number or string); --seed overrides it.
 *                      Seeds the map and the in-game randomness (barbarians,
 *                      treasure rewards), so a game with AI players replays
 *                      exactly. Omitted = random, as before.
 *   players          - array of {id, name, color, controller, description}
 *                      controller: a key from definitions/ai.json (e.g.
 *                      'standard', 'apex', 'llm-menu-deepseek-4.1'),
 *                      a {url, config} object, 'ai' = SmartManager,
 *                      'llm' = LLM menu harness, null = human (no AI).
 *                      Optional label/controllerConfig fields override the
 *                      report label and merge into the controller config.
 *                      Optional `leader` selects a leader from
 *                      definitions/leaders.json (description, focus, twist
 *                      attributes); when omitted, `name` is used as the
 *                      leader name, matching the browser setup.
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
 *
 * Reporting (used by tournament.mjs):
 *   --report-json <path>   write per-run metrics JSON (scores, entities,
 *                          kills/losses, chats/trades, resources, timeline)
 *   --run-label <text>     label stored in the report
 *   --iteration <n>        iteration number stored in the report
 *   --log-pattern <regex>  capture console lines matching regex (repeatable;
 *                          may also be set via config report.logPatterns)
 *   --profile-proxy        count AI proxy operations and include the profile
 *                          in metrics/reports (also config aiProxyProfiler: true)
 */
import { GameState } from '../../src/gameState.js';
import { loadGameManifest } from '../../src/manifestLoader.js';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';
import { saveCheckpoint, loadCheckpoint, resolveCheckpointPath, CHECKPOINT_FILE } from './checkpoint.mjs';
import { GameMetricsCollector } from './metrics.mjs';
import { createAiProxyProfiler } from './aiProxyProfiler.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    turns: 5, turnsSet: false, config: null, checkpointDir: null, resume: null, seed: null,
    reportJson: null, runLabel: null, iteration: null, logPatterns: [],
    profileProxy: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) opts.config = args[++i];
    else if (args[i] === '--checkpoint-dir' && args[i + 1]) opts.checkpointDir = args[++i];
    else if (args[i] === '--resume' && args[i + 1]) opts.resume = args[++i];
    else if (args[i] === '--seed' && args[i + 1]) opts.seed = args[++i];
    else if (args[i] === '--report-json' && args[i + 1]) opts.reportJson = args[++i];
    else if (args[i] === '--run-label' && args[i + 1]) opts.runLabel = args[++i];
    else if (args[i] === '--iteration' && args[i + 1]) opts.iteration = Number(args[++i]);
    else if (args[i] === '--log-pattern' && args[i + 1]) opts.logPatterns.push(args[++i]);
    else if (args[i] === '--profile-proxy') opts.profileProxy = true;
    else if (!isNaN(parseInt(args[i]))) {
      opts.turns = parseInt(args[i]);
      opts.turnsSet = true;
    }
  }
  return opts;
}

/**
 * Resolve a config controller reference to a runtime {url, config} object.
 * String shortcuts other than the legacy 'ai'/'llm' are looked up in
 * definitions/ai.json, so a suite config can say "controller": "apex" and get
 * the same URL/config (provider URL, leader overlay) as the browser setup.
 */
function resolveController(def, playerName, aiJson, leadersJson, { registry = 'controllers', legacy = false } = {}) {
  if (!def) return null;
  if (typeof def === 'string' && legacy) {
    if (def === 'ai') return { key: 'standard', url: './ai/standard/smartManager.js', config: {} };
    if (def === 'llm') return { key: 'llm', url: './ai/llm/menu/harness.js', config: {} };
  }
  let key = null;
  let source = null;
  if (typeof def === 'string') {
    key = def;
    source = def;
  } else if (typeof def === 'object') {
    if (!def.url && def.key) {
      key = def.key;
      source = aiJson?.[registry]?.[key] || null;
      if (!source) {
        throw new Error(`Unknown controller "${key}" (not found in definitions/ai.json ${registry})`);
      }
    } else {
      source = def;
    }
  }
  if (source && typeof source === 'string') {
    source = aiJson?.[registry]?.[source] || null;
    if (!source) {
      throw new Error(`Unknown controller "${key}" (not found in definitions/ai.json ${registry})`);
    }
  }
  if (!source) return null;
  const controller = {
    key: key || source.key || undefined,
    url: source.url,
    config: JSON.parse(JSON.stringify(source.config || {})),
  };
  if (def && typeof def === 'object') {
    controller.config = { ...controller.config, ...(def.config || {}) };
    if (def.description) controller.description = def.description;
    if (def.focus) controller.focus = [...def.focus];
    if (def.attributes) controller.attributes = { ...def.attributes };
  }
  // Overlay leader description/focus/attributes (Phase 23/25), exactly as
  // the browser buildController() does.
  const leader = (leadersJson || []).find(l => l.name === playerName);
  if (leader) {
    controller.leader = leader.name;
    controller.description = leader.description;
    controller.focus = [...(leader.focus || [])];
    controller.attributes = leader.attributes ? { ...leader.attributes } : {};
  } else if (source.description) {
    controller.description = source.description;
    controller.focus = source.focus ? [...source.focus] : undefined;
  }
  // Provider config -> baseUrl. The API key is never put in the config; the
  // LLM client resolves it from sessionStorage or the config's apiKey.
  const provider = aiJson?.providers?.[controller.config.provider];
  if (provider?.url) controller.config.baseUrl = provider.url;
  return controller;
}

function controllerMeta(player) {
  const c = player.controller;
  if (!c) return { controller: 'human', controllerLabel: 'human', model: null };
  const config = c.config || {};
  const model = config.model ?? config.orderedModels ?? null;
  const modelLabel = Array.isArray(model) ? model.join(', ') : (model ? String(model) : null);
  const label = player.label || c.key || modelLabel || (c.url ? path.basename(c.url, '.js') : 'ai');
  return {
    controller: c.key || c.url || label,
    controllerLabel: label,
    model: modelLabel,
    leader: c.leader || null,
  };
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
const failureMessages = [];
function assert(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failures++;
    failureMessages.push(msg);
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
  // An explicit CLI turn count wins over the config file, matching the
  // documented `npm test -- 20 --config mygame.json` behaviour.
  const TURNS = opts.turnsSet ? opts.turns : (cfg.turns || opts.turns);

  // Reporting/log capture is opt-in (`--report-json` or a `report` block in
  // the config). The suite driver uses it; ordinary `npm test` runs are
  // unchanged. Create it before the manifest loads so setup logs are seen.
  const reportCfg = cfg.report || {};
  const reportPath = opts.reportJson || reportCfg.jsonPath || null;
  const logPatterns = [
    ...(Array.isArray(reportCfg.logPatterns) ? reportCfg.logPatterns : []),
    ...(Array.isArray(cfg.logPatterns) ? cfg.logPatterns : []),
    ...opts.logPatterns,
  ];
  const definitionsDir = process.env.HEADLESS_DEFINITIONS_DIR || null;
  let definitionsFiles = null;
  if (definitionsDir) {
    try {
      definitionsFiles = readdirSync(definitionsDir).filter(file => file.endsWith('.json')).sort();
    } catch (err) {
      console.error(`[headless] definitions overlay is not readable: ${definitionsDir} (${err.message})`);
      process.exit(2);
    }
    console.log(`[headless] definitions overlay: ${definitionsDir}${definitionsFiles ? ` (${definitionsFiles.join(', ')})` : ''}`);
  }
  const proxyProfiler = (opts.profileProxy || cfg.aiProxyProfiler)
    ? createAiProxyProfiler()
    : null;
  const collector = (reportPath || logPatterns.length > 0)
    ? new GameMetricsCollector({
      logPatterns,
      runMeta: {
        label: opts.runLabel || reportCfg.runLabel || cfg.label || null,
        iteration: opts.iteration ?? reportCfg.iteration ?? null,
        configPath: opts.config,
        seed: opts.seed ?? cfg.seed ?? null,
        turns: TURNS,
        mapSize: cfg.mapSize ?? null,
        definitionsDir,
        definitionsFiles,
      },
      maxLogMatches: reportCfg.maxLogMatches ?? cfg.maxLogMatches ?? 5000,
    })
    : null;

  console.log(`[headless] Loading manifest...`);
  const manifest = await loadGameManifest();
  console.log(`[headless] Manifest loaded: ${Object.keys(manifest.entities).length} entities`);

  const ds = manifest.defaultSettings || {};

  // Controller registry (definitions/ai.json) lets configs use the same
  // controller keys as the browser setup: "controller": "apex",
  // "controller": "llm-menu-deepseek-4.1", or a {key, config} object.
  let aiJson = null;
  let leadersJson = [];
  try {
    const [aiRes, leadersRes] = await Promise.all([
      fetch('./definitions/ai.json'),
      fetch('./definitions/leaders.json'),
    ]);
    if (aiRes.ok) aiJson = await aiRes.json();
    if (leadersRes.ok) leadersJson = await leadersRes.json();
  } catch (err) {
    console.warn(`[headless] Controller registry unavailable: ${err.message}`);
  }

  // Player definitions come from the config in both modes: fresh runs use
  // them for setup, resume uses them to validate the checkpoint and to
  // pick controllers/credentials (see checkpoint.mjs header).
  // `controllerKey` (the browser setup field) is honoured only when the
  // config explicitly defines players; the built-in defaultSettings list is
  // a browser setup template, and treating its 'human'/'llm-*' keys as
  // headless controllers would make the plain `npm test` run call an LLM.
  const explicitPlayers = Array.isArray(cfg.players);
  const players = cfg.players || ds.players || [
    { id: 1, name: 'Blue', color: '#0000ff', controller: 'ai', description: '' },
    { id: 2, name: 'Red', color: '#ff0000', controller: 'ai', description: '' },
  ];
  // Ensure every player has a controller field (null = human/no AI).
  // String shortcuts ('ai', 'llm', or an ai.json controller key) and
  // {key, config} objects are resolved to the runtime {url, config} shape
  // Player.getAiManager() requires. `controllerConfig` is merged as a
  // per-player override.
  for (const p of players) {
    // Leader selection: an explicit `leader` lets a player keep a friendly
    // display name (Blue) while using a leader's description/focus/twist
    // attributes. Without it, the browser convention applies: the player
    // name IS the leader name.
    const leaderName = p.leader || p.name;
    if (p.leader && !(leadersJson || []).some(l => l.name === p.leader)) {
      throw new Error(`Unknown leader "${p.leader}" for player ${p.name} (not found in definitions/leaders.json)`);
    }

    if (p.controller === undefined) {
      p.controller = (explicitPlayers && p.controllerKey) ? p.controllerKey : 'ai';
    }
    if (p.controller === 'human' || p.controller === 'none') p.controller = null;
    if (p.controller) {
      p.controller = resolveController(p.controller, leaderName, aiJson, leadersJson, { legacy: true });
      if (p.controller && p.controllerConfig) {
        p.controller.config = { ...(p.controller.config || {}), ...p.controllerConfig };
      }
    }
    delete p.controllerConfig;

    // Phase 26: strategic controller (optional). 'dummy' is an alias for
    // the coded strategic AI; other keys resolve through
    // definitions/ai.json strategicControllers.
    if (p.strategicController === 'dummy' || p.strategicController?.key === 'dummy') {
      p.strategicController = 'strategic-dummy';
    }
    if (p.strategicController) {
      const strategicRegistry = aiJson?.strategicControllers ? 'strategicControllers' : 'controllers';
      p.strategicController = resolveController(
        p.strategicController, leaderName, aiJson, leadersJson, { registry: strategicRegistry }
      );
      if (p.strategicController && p.strategicControllerConfig) {
        p.strategicController.config = {
          ...(p.strategicController.config || {}),
          ...p.strategicControllerConfig,
        };
      }
    }
    delete p.strategicControllerConfig;
  }
  const playerMeta = Object.fromEntries(players.map(p => {
    const meta = controllerMeta(p);
    return [String(p.id), { id: p.id, name: p.name, ...meta }];
  }));

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
    const seed = opts.seed ?? cfg.seed ?? null;
    gameState.generateMap(mapSize, manifest.terrains, manifest, seed);
    if (seed !== null) console.log(`[headless] Game seed: ${seed}`);
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

  // AI managers are created lazily by Player.getAiManager() from each
  // player's controller URL — no manual swapping
  // needed here. Eagerly resolve now so a bad controller URL fails fast.
  for (const p of gameState.players) {
    const managerOptions = proxyProfiler ? { profiler: proxyProfiler } : undefined;
    if (p.controller) await p.getAiManager(managerOptions);
    // Phase 26: same for the strategic manager.
    if (p.strategicController) await p.getStrategicManager(managerOptions);
    // Timing instrumentation (reporting runs only): wrap the manager
    // instances so the harness can separate AI compute from engine work.
    if (collector) {
      p._lastAiMs = 0;
      p._lastStrategicMs = 0;
      if (p.aiManager?.processTurn) {
        const originalProcessTurn = p.aiManager.processTurn.bind(p.aiManager);
        p.aiManager.processTurn = async (...args) => {
          const start = performance.now();
          try {
            return await originalProcessTurn(...args);
          } finally {
            p._lastAiMs = performance.now() - start;
          }
        };
      }
      if (p.strategicManager?.runStrategicTurn) {
        const originalStrategicTurn = p.strategicManager.runStrategicTurn.bind(p.strategicManager);
        p.strategicManager.runStrategicTurn = async (...args) => {
          const start = performance.now();
          try {
            return await originalStrategicTurn(...args);
          } finally {
            p._lastStrategicMs = performance.now() - start;
          }
        };
      }
    }
  }

  assert(gameState.players.length === players.length, `expected ${players.length} players`);
  assert(gameState.entities.length > 0, 'expected starting entities');

  // Metrics are attached after setup and before the first turn, so the
  // baseline is the starting position and every AI action is counted.
  if (collector) collector.attach(gameState, playerMeta);

  // Run turns headlessly through the real Player.step(), with a no-op
  // continuation: the harness drives advancement itself, so step() must
  // not chain into the browser's nextTurn(). Passing a function (rather
  // than nothing) is what makes AI players act. initializeManifest starts
  // no turn at all, so the first AI turn happens here, in round 1.
  // roundsDone rounds already happened (0 on fresh runs); the loop runs
  // exactly the remaining rounds, so completed rounds are never replayed.
  let roundsRun = 0;
  let winner = null;
  for (let turn = roundsDone + 1; turn <= TURNS; turn++) {
    roundsRun++;
    console.log(`[headless] --- Turn ${turn} (round ${gameState.currentRound}) ---`);
    if (collector) collector.beginRound(gameState.currentRound);
    let roundEnded = false;
    for (let pi = 0; pi < gameState.players.length; pi++) {
      const player = gameState.players[pi];
      gameState.activePlayerIndex = pi;

      // Real Player.step(): refill, entity steps, visibility, scores,
      // then the AI turn (awaited). Errors are logged in step() and
      // rethrown here for the failure count.
      const stepStart = performance.now();
      try {
        await player.step(() => { });
      } catch (err) {
        console.error(`  ERROR in ${player.name} AI: ${err.message}`);
        failures++;
        failureMessages.push(`${player.name} AI error: ${err.message}`);
      } finally {
        if (collector) {
          collector.recordTurnTiming(player, {
            round: gameState.currentRound,
            stepMs: performance.now() - stepStart,
            aiMs: player._lastAiMs || 0,
            strategicMs: player._lastStrategicMs || 0,
          });
          player._lastAiMs = 0;
          player._lastStrategicMs = 0;
        }
      }

      // Assertions after each player's turn
      assert(player.orders >= 0, `${player.name} orders negative: ${player.orders}`);
      checkNoNaN(player.resources, `${player.name}.resources`);
      checkNoNaN(player.score, `${player.name}.score`);

      // Round-end (barbarians etc.) when the last player has acted,
      // matching the browser's endTurn wrap.
      if (pi === gameState.players.length - 1) {
        const finishedRound = gameState.currentRound;
        await gameState.onRoundEnd();
        if (collector) collector.endRound(finishedRound);
        roundEnded = true;
      }

      // Check win conditions after each player's turn, as the browser
      // does after each endTurn — via the single shared check.
      const win = gameState.checkWinConditions();
      if (win) {
        console.log(`[headless] ${win.winner.name} WINS at round ${gameState.currentRound} (score ${win.winner.score.total})`);
        console.log(`[headless] Reasons: ${win.reasons.join('; ')}`);
        winner = {
          id: win.winner.id,
          name: win.winner.name,
          score: { ...(win.winner.score || {}) },
          reasons: [...win.reasons],
        };
        gameState.gameOver = true;
        // A win before the last player acted leaves the round unfinished:
        // snapshot it so score-over-time ends on the winning position.
        if (collector && !roundEnded) collector.endRound(gameState.currentRound);
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

  if (collector) collector.runMeta.mapSize = gameState.hexGrid?.radius ?? cfg.mapSize ?? null;

  // Serialization round-trip (production save path)
  const saved = gameState.serialize();
  assert(typeof saved === 'string' && saved.length > 1000, 'serialize produced output');
  const restored = new GameState();
  restored.manifestData = manifest; // needed for spawnEntity during deserialize
  restored.deserialize(saved);
  assert(restored.entities.length === gameState.entities.length, 'deserialize entity count matches');
  console.log(`[headless] Save/load round-trip OK (${(saved.length / 1024).toFixed(1)} KB)`);

  // Phase 26: report the directive each strategic AI left on its tactical
  // controller — and that it survived the save/load round-trip above.
  for (const p of gameState.players) {
    if (!p.strategicController) continue;
    const d = p.controller?.directive;
    console.log(`[headless] ${p.name} directive: ${d ? JSON.stringify(d) : '(none set)'}`);
    assert(d && typeof d === 'object', `${p.name} has a strategic controller but no directive was set`);
    const rd = restored.players.find(r => String(r.id) === String(p.id));
    assert(JSON.stringify(rd?.controller?.directive) === JSON.stringify(d),
      `${p.name} directive did not survive save/load`);
  }

  // Optional machine-readable report (consumed by tournament.mjs, which
  // renders the Markdown report from it). Written before exit so a failing
  // assertion still leaves a complete metrics file behind.
  const proxyProfile = proxyProfiler ? proxyProfiler.toJSON() : null;
  if (proxyProfile) {
    console.log(`[headless] Proxy profile: ${JSON.stringify(proxyProfile)}`);
  }

  if (collector) {
    const totalRounds = roundsDone + roundsRun;
    const report = collector.finalize({
      winner,
      gameOver: gameState.gameOver,
      completedAllTurns: !gameState.gameOver && totalRounds >= TURNS,
      roundsPlayed: totalRounds,
      totalTurns: TURNS,
      resumed: !!resumePath,
      failures,
      failureMessages,
      proxyProfile,
    });
    if (reportPath) {
      mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
      writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
      console.log(`[headless] Metrics report: ${reportPath}`);
    }
    collector.dispose();
  }

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
