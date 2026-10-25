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

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { turns: 5, config: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) opts.config = args[++i];
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

  // Build full game settings: config file overrides defaultSettings.json
  const gameState = new GameState();
  const mapSize = cfg.mapSize || ds.mapSize || 12;
  gameState.generateMap(mapSize, manifest.terrains, manifest);

  const players = cfg.players || ds.players || [
    { id: 1, name: 'Blue', color: '#0000ff', controller: 'ai', description: '' },
    { id: 2, name: 'Red', color: '#ff0000', controller: 'ai', description: '' },
  ];
  // Ensure every player has a controller field (null = human/no AI)
  for (const p of players) {
    if (p.controller === undefined) p.controller = 'ai';
  }
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
  if (cfg.barbarians) console.log(`[headless] Barbarians enabled`);
  if (cfg.llm?.orderedModels?.length) console.log(`[headless] LLM enabled: ${cfg.llm.orderedModels.join(', ')}`);

  // Per-player controller override: the game picks LLM vs SmartManager globally
  // based on settings.llm, so swap aiManager for players that want the other.
  // (No game code changes — this is test-harness-only.)
  const { SmartManager } = await import('../../src/ai/standard/smartManager.js');
  const { Harness } = await import('../../src/ai/llm/harness.js');
  for (const p of gameState.players) {
    const wantLLM = players.find(pd => pd.id === p.id)?.controller === 'llm';
    const hasLLM = p.aiManager instanceof Harness;
    if (wantLLM && !hasLLM && cfg.llm?.apiKey) {
      p.aiManager = new Harness(p, gameState, p.controller);
    } else if (!wantLLM && hasLLM) {
      p.aiManager = new SmartManager(p, gameState, p.controller);
    }
  }

  assert(gameState.players.length === players.length, `expected ${players.length} players`);
  assert(gameState.entities.length > 0, 'expected starting entities');

  // Run turns headlessly. We bypass Player.step()'s nextTurn() chain (DOM)
  // and drive the AI managers directly.
  for (let turn = 1; turn <= TURNS; turn++) {
    console.log(`[headless] --- Turn ${turn} (round ${gameState.currentRound}) ---`);
    for (let pi = 0; pi < gameState.players.length; pi++) {
      const player = gameState.players[pi];
      gameState.activePlayerIndex = pi;

      // Sync parts of Player.step() (refill, entity steps, visibility, scores)
      // without triggering the async AI + nextTurn() DOM chain.
      player.refillOrders();
      for (const e of player.getEntities()) e.step();
      player.updateVisibility();
      player.recalculateScore();

      // Drive the AI directly
      if (player.aiManager) {
        try {
          await player.aiManager.processTurn();
        } catch (err) {
          console.error(`  ERROR in ${player.name} AI: ${err.message}`);
          failures++;
        }
      }

      // Assertions after each player's turn
      assert(player.orders >= 0, `${player.name} orders negative: ${player.orders}`);
      checkNoNaN(player.resources, `${player.name}.resources`);
      checkNoNaN(player.score, `${player.name}.score`);
    }

    // Round-end (barbarians etc.)
    await gameState.onRoundEnd();

    // Check win conditions (mirrors main.js checkWinConditions)
    const wc = settings.winCondition;
    if (wc && gameState.currentRound >= 5) {
      for (const p of gameState.players) {
        let won = false;
        if (wc.absoluteScore && p.score.total >= wc.absoluteScore) won = true;
        if (wc.relativeScore) {
          let nextHighest = 0;
          for (const o of gameState.players) {
            if (o.id !== p.id && o.score.total > nextHighest) nextHighest = o.score.total;
          }
          if (p.score.total >= wc.relativeScore * nextHighest && nextHighest > 0) won = true;
        }
        if (won) {
          console.log(`[headless] ${p.name} WINS at round ${gameState.currentRound} (score ${p.score.total})`);
          gameState.gameOver = true;
          break;
        }
      }
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
    ? `\n[headless] ALL CHECKS PASSED (${TURNS} turns)`
    : `\n[headless] ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('[headless] FATAL:', err);
  process.exit(2);
});
