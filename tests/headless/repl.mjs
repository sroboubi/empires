/**
 * Interactive headless game REPL.
 * Start a game and poke at it from the command line: step turns,
 * inspect state, spawn entities, run AI, etc.
 *
 * Usage:
 *   node --import ./stubs.mjs --loader ./loader.mjs ./repl.mjs [--config game.json]
 *
 * Commands:
 *   step [n]          - advance n turns (default 1)
 *   players           - list players and scores
 *   entities [name]   - list entities (optionally filter by name)
 *   player <id>       - show player details (resources, orders, score)
 *   entity <id>       - show entity details
 *   spawn <name> <q> <r> <playerId> - spawn entity at hex
 *   ai <playerId>      - run one AI turn for player
 *   save <file>       - serialize game to file
 *   load <file>       - deserialize game from file
 *   eval <js>         - evaluate JS with gameState, players, entities in scope
 *   help              - this list
 *   quit              - exit
 */
import { GameState } from '../../src/gameState.js';
import { loadGameManifest } from '../../src/manifestLoader.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import readline from 'readline';

let gameState, manifest, settings;

async function setup(configPath) {
  const cfg = configPath && existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {};
  manifest = await loadGameManifest();
  const ds = manifest.defaultSettings || {};
  gameState = new GameState();
  gameState.generateMap(cfg.mapSize || ds.mapSize || 12, null, manifest);
  const players = cfg.players || ds.players || [
    { id: 1, name: 'Blue', color: '#0000ff', controller: 'ai' },
    { id: 2, name: 'Red', color: '#ff0000', controller: 'ai' },
  ];
  settings = {
    players,
    initialization: cfg.initialization || ds.initialization || {},
    winCondition: cfg.winCondition || ds.winCondition || null,
    barbarians: cfg.barbarians !== undefined ? cfg.barbarians : (ds.barbarians || null),
    llm: cfg.llm || null,
    autoSave: { enabled: false },
  };
  gameState.initializeManifest(manifest, settings);
  console.log(`Game ready: ${gameState.players.length} players, ${gameState.entities.length} entities, round ${gameState.currentRound}`);
}

async function stepTurns(n) {
  for (let t = 0; t < n; t++) {
    if (gameState.gameOver) { console.log('Game over.'); break; }
    for (let pi = 0; pi < gameState.players.length; pi++) {
      const p = gameState.players[pi];
      gameState.activePlayerIndex = pi;
      p.refillOrders();
      for (const e of p.getEntities()) e.step();
      p.updateVisibility();
      if (p.aiManager) {
        try { await p.aiManager.processTurn(); }
        catch (e) { console.log(`AI error (${p.name}): ${e.message}`); }
      }
    }
    await gameState.onRoundEnd();
    console.log(`Round ${gameState.currentRound} complete (${gameState.entities.length} entities)`);
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'empires> ' });

async function handle(line) {
  const [cmd, ...args] = line.trim().split(/\s+/);
  switch (cmd) {
    case 'step': await stepTurns(parseInt(args[0] || '1')); break;
    case 'players':
      for (const p of gameState.players)
        console.log(`  #${p.id} ${p.name}: score=${p.score.total} (m:${p.score.military} e:${p.score.economic} x:${p.score.exploration}) orders=${p.orders} ai=${!!p.aiManager}`);
      break;
    case 'entities': {
      const list = args[0]
        ? gameState.entities.filter(e => e.name.includes(args[0]))
        : gameState.entities;
      for (const e of list.slice(0, 30))
        console.log(`  ${e.id} ${e.name} (${e.q},${e.r}) hp=${Math.round(e.health)}/${e.maxHealth} ap=${e.actionPoints} owner=${e.owner?.name}`);
      if (list.length > 30) console.log(`  ... and ${list.length - 30} more`);
      break;
    }
    case 'player': {
      const p = gameState.players.find(x => x.id == args[0]);
      if (!p) { console.log('No such player'); break; }
      console.log(JSON.stringify({ resources: p.resources, orders: p.orders, score: p.score }, null, 1));
      break;
    }
    case 'entity': {
      const e = gameState.entities.find(x => x.id === args[0]);
      if (!e) { console.log('No such entity'); break; }
      console.log(JSON.stringify({ name: e.name, q: e.q, r: e.r, health: e.health, maxHealth: e.maxHealth, ap: e.actionPoints, owner: e.owner?.name }, null, 1));
      break;
    }
    case 'spawn': {
      const [name, q, r, pid] = args;
      const cell = gameState.hexGrid.getCell(parseInt(q), parseInt(r));
      const owner = gameState.players.find(x => x.id == pid) || null;
      const e = gameState.spawnEntity(name, cell, owner);
      console.log(e ? `Spawned ${e.id}` : 'Spawn failed');
      break;
    }
    case 'ai': {
      const p = gameState.players.find(x => x.id == args[0]);
      if (!p?.aiManager) { console.log('No AI for that player'); break; }
      await p.aiManager.processTurn();
      console.log('AI turn done');
      break;
    }
    case 'save':
      gameState.manifestData = gameState.manifestData || manifest;
      writeFileSync(args[0], gameState.serialize());
      console.log('Saved');
      break;
    case 'load': {
      const data = readFileSync(args[0], 'utf-8');
      const gs = new GameState();
      gs.manifestData = manifest;
      gs.deserialize(data);
      gameState = gs;
      console.log(`Loaded: ${gameState.entities.length} entities, round ${gameState.currentRound}`);
      break;
    }
    case 'eval': {
      try {
        const fn = new Function('gameState', 'players', 'entities', `return (${args.join(' ')})`);
        console.log(fn(gameState, gameState.players, gameState.entities));
      } catch (e) { console.log('Error: ' + e.message); }
      break;
    }
    case 'help':
      console.log('step [n] | players | entities [name] | player <id> | entity <id> | spawn <name> <q> <r> <pid> | ai <pid> | save <f> | load <f> | eval <js> | quit');
      break;
    case 'quit': case 'exit': process.exit(0);
    case '': break;
    default: console.log(`Unknown: ${cmd} (try 'help')`);
  }
}

const configPath = process.argv.find((a, i) => process.argv[i - 1] === '--config');
await setup(configPath);
rl.prompt();
rl.on('line', async (line) => { await handle(line); rl.prompt(); });
