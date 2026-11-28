/**
 * Headless AI suite / tournament runner.
 *
 * Reads a suite JSON defining one or more game settings and an iteration
 * count per setting, runs every iteration as an isolated `headless.mjs`
 * child process (real game logic, no browser), collects the metrics JSON,
 * and renders Markdown reports.
 *
 * Usage:
 *   npm run test:suite
 *   npm run test:suite -- --config my-suite.json
 *   node --import ./preload.mjs ./tournament.mjs \
 *     --config suite.example.json --iterations 3 --out results/run-1
 *
 * See tests/headless/README.md "AI controller suite" for the config schema
 * and report layout.
 */
import { spawn } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  renderSummary,
  renderGameReport,
  renderRunReport,
  renderLogReport,
} from './report.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUITE_ONLY_KEYS = new Set([
  'name', 'description', 'outputDir', 'iterations', 'seedStrategy', 'seedStep',
  'seed', 'concurrency', 'timeoutMs', 'logPatterns', 'report', 'games', 'matrix',
  'failFast', 'saveFullLogs', 'maxLogMatches', 'perRunReports', 'defaults',
  'progressEveryTurns', 'progressMode', 'id', 'slug', 'settings', 'label',
  'definitionsDir',
]);

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    config: null,
    out: null,
    iterations: null,
    turns: null,
    seed: null,
    concurrency: null,
    games: [],
    definitionsDir: null,
    failFast: false,
    fullLogs: null,
    perRun: null,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument "${arg}". Use named options, e.g. --turns N.`);
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const takeValue = () => {
      if (inline !== null) {
        if (inline === '') throw new Error(`${name} requires a value`);
        return inline;
      }
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        throw new Error(`${name} requires a value`);
      }
      return args[++i];
    };
    switch (name) {
      case '--config': opts.config = takeValue(); break;
      case '--out': opts.out = takeValue(); break;
      case '--iterations': opts.iterations = Number(takeValue()); break;
      case '--turns': opts.turns = Number(takeValue()); break;
      case '--seed': opts.seed = takeValue(); break;
      case '--concurrency': opts.concurrency = Number(takeValue()); break;
      case '--game': opts.games.push(takeValue()); break;
      case '--definitions-dir': opts.definitionsDir = takeValue(); break;
      case '--fail-fast':
        if (inline !== null) throw new Error('--fail-fast does not take a value');
        opts.failFast = true;
        break;
      case '--full-logs':
        if (inline !== null) throw new Error('--full-logs does not take a value');
        opts.fullLogs = true;
        break;
      case '--no-full-logs':
        if (inline !== null) throw new Error('--no-full-logs does not take a value');
        opts.fullLogs = false;
        break;
      case '--no-per-run':
        if (inline !== null) throw new Error('--no-per-run does not take a value');
        opts.perRun = false;
        break;
      default:
        throw new Error(`Unknown option "${name}"`);
    }
  }
  return opts;
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepClone(v)]));
  }
  return value;
}

function deepMerge(base, override) {
  if (override === undefined) return deepClone(base);
  if (override === null) return null;
  if (base === undefined || base === null) return deepClone(override);
  if (Array.isArray(base) || Array.isArray(override)) return deepClone(override);
  if (typeof base !== 'object' || typeof override !== 'object') return deepClone(override);
  const out = { ...deepClone(base) };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in out ? deepMerge(out[key], value) : deepClone(value);
  }
  return out;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pathParts(path) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error('Matrix paths must be non-empty dotted strings, e.g. "mapSize" or "initialization.orders.max"');
  }
  const parts = path.split('.').map(part => part.trim());
  if (parts.some(part => part === '')) {
    throw new Error(`Invalid matrix path "${path}"`);
  }
  return parts;
}

function isArrayIndex(part) {
  return /^\d+$/.test(part);
}

/** Set a value at a dot path, creating intermediate objects/arrays. */
function setAtPath(target, path, value) {
  const parts = pathParts(path);
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const nextIsIndex = isArrayIndex(parts[i + 1]);
    if (Array.isArray(cursor)) {
      if (!isArrayIndex(part)) throw new Error(`Matrix path "${path}" expected an array index at "${part}"`);
      const index = Number(part);
      if (cursor[index] === undefined || cursor[index] === null) {
        cursor[index] = nextIsIndex ? [] : {};
      }
      cursor = cursor[index];
    } else {
      if (!isPlainObject(cursor)) {
        throw new Error(`Matrix path "${path}" cannot descend through "${parts.slice(0, i).join('.')}"`);
      }
      if (cursor[part] === undefined || cursor[part] === null) {
        cursor[part] = nextIsIndex ? [] : {};
      }
      cursor = cursor[part];
    }
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(cursor)) {
    if (!isArrayIndex(last)) throw new Error(`Matrix path "${path}" expected an array index at "${last}"`);
    cursor[Number(last)] = deepClone(value);
  } else {
    if (!isPlainObject(cursor)) {
      throw new Error(`Matrix path "${path}" cannot assign through "${parts.slice(0, -1).join('.')}"`);
    }
    cursor[last] = deepClone(value);
  }
}

function matrixOptionLabel(value, index) {
  if (value === null) return 'none';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') return String(index);
  return String(value);
}

/**
 * Expand a suite-level matrix into concrete game definitions.
 *
 * `matrix` maps a dotted game-setting path to an array of options. The
 * Cartesian product of all arrays becomes the generated games. Each option
 * replaces the value at that path (it is not deep-merged), so an object
 * option such as a barbarian config is used exactly as written.
 */
function expandMatrix(suite, baseSettings) {
  if (!isPlainObject(suite.matrix)) {
    throw new Error('"matrix" must be an object mapping dotted setting paths to arrays of options');
  }
  if (Array.isArray(suite.games) && suite.games.length > 0) {
    throw new Error('Use either "matrix" or "games", not both');
  }
  const entries = Object.entries(suite.matrix);
  if (entries.length === 0) throw new Error('"matrix" must define at least one path');
  for (const [path, options] of entries) {
    pathParts(path);
    if (!Array.isArray(options) || options.length === 0) {
      throw new Error(`Matrix path "${path}" must be a non-empty array of options`);
    }
  }

  let combinations = [[]];
  for (const [path, options] of entries) {
    const next = [];
    for (const combination of combinations) {
      for (let index = 0; index < options.length; index++) {
        next.push([...combination, { path, value: options[index], index }]);
      }
    }
    combinations = next;
  }

  return combinations.map(combination => {
    const settings = deepClone(baseSettings);
    const matrixValues = {};
    const matrixSelection = [];
    const idParts = [];
    for (const item of combination) {
      setAtPath(settings, item.path, item.value);
      matrixValues[item.path] = deepClone(item.value);
      const label = matrixOptionLabel(item.value, item.index);
      matrixSelection.push({
        path: item.path,
        label,
        index: item.index,
        value: deepClone(item.value),
      });
      idParts.push(`${slugify(item.path)}-${slugify(label)}`);
    }
    return {
      id: idParts.join('__'),
      description: `Matrix: ${matrixSelection.map(item => `${item.path}=${item.label}`).join(', ')}`,
      settings,
      matrixValues,
      matrixSelection,
    };
  });
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'game';
}

function timestampSlug(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function settingsFrom(source) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (SUITE_ONLY_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function computeSeed(baseSeed, strategy, index, step) {
  if (baseSeed === null || baseSeed === undefined) return null;
  if (strategy === 'random') return Math.floor(Math.random() * 1_000_000_000);
  if (strategy === 'same') return baseSeed;
  const numeric = Number(baseSeed);
  if (Number.isFinite(numeric)) return numeric + index * step;
  return index === 0 ? baseSeed : `${baseSeed}-${index}`;
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (/apiKey|token|secret/i.test(key)) out[key] = '***redacted***';
    else out[key] = redactSecrets(child);
  }
  return out;
}

function normalizeSuite(suite, opts, suiteDir = __dirname) {
  const suiteDefaults = deepMerge(settingsFrom(suite), suite.defaults || {});
  const hasMatrix = suite.matrix !== undefined && suite.matrix !== null;
  const gameDefs = hasMatrix
    ? expandMatrix(suite, suiteDefaults)
    : (Array.isArray(suite.games) && suite.games.length > 0
      ? suite.games.map(game => ({ game }))
      : [{ game: { id: suite.id || 'default' } }]);

  const usedSlugs = new Set();
  const games = gameDefs.map((entry, index) => {
    const game = entry.game || {};
    const id = entry.id || game.id || `game-${index + 1}`;
    let slug = slugify(id);
    let suffix = 2;
    while (usedSlugs.has(slug)) slug = `${slugify(id)}-${suffix++}`;
    usedSlugs.add(slug);

    let settings;
    if (entry.settings) {
      settings = deepClone(entry.settings);
    } else {
      const gameDefaults = deepMerge(deepMerge(settingsFrom(game), game.defaults || {}), game.settings || {});
      settings = deepMerge(suiteDefaults, gameDefaults);
    }

    const iterations = opts.iterations ?? game.iterations ?? suite.iterations ?? 1;
    // settings.turns comes before suite.turns so a matrix can vary turns.
    const turns = opts.turns ?? game.turns ?? settings.turns ?? suite.turns ?? 5;
    const baseSeed = opts.seed !== null && opts.seed !== undefined
      ? opts.seed
      : (game.seed ?? suite.seed ?? null);
    const seedStrategy = game.seedStrategy ?? suite.seedStrategy ?? 'increment';
    const seedStep = Number(game.seedStep ?? suite.seedStep ?? 1);

    settings.turns = turns;
    if (settings.seed === undefined) settings.seed = baseSeed;

    // Optional test-only definitions overlay. Resolved relative to the suite
    // file (not the cwd), validated here so a typo cannot silently run with
    // the repo definitions.
    const rawDefinitionsDir = opts.definitionsDir ?? game.definitionsDir ?? suite.definitionsDir ?? null;
    let definitionsDir = null;
    let definitionsFiles = null;
    if (rawDefinitionsDir) {
      definitionsDir = path.isAbsolute(rawDefinitionsDir)
        ? rawDefinitionsDir
        : path.resolve(suiteDir, rawDefinitionsDir);
      let stat = null;
      try { stat = statSync(definitionsDir); } catch (err) { stat = null; }
      if (!stat || !stat.isDirectory()) {
        throw new Error(`definitionsDir for game "${id}" is not a directory: ${rawDefinitionsDir} (resolved ${definitionsDir})`);
      }
      definitionsFiles = readdirSync(definitionsDir).filter(file => file.endsWith('.json')).sort();
      if (definitionsFiles.length === 0) {
        throw new Error(`definitionsDir for game "${id}" contains no .json files: ${definitionsDir}`);
      }
    }

    return {
      id,
      slug,
      description: entry.description || game.description || null,
      iterations: Math.max(1, Number(iterations) || 1),
      turns,
      seed: baseSeed,
      seedStrategy,
      seedStep,
      logPatterns: game.logPatterns ?? suite.logPatterns ?? suite.report?.logPatterns ?? [],
      settings,
      definitionsDir,
      definitionsFiles,
      matrixValues: entry.matrixValues || null,
      matrixSelection: entry.matrixSelection || null,
      suite,
    };
  });

  const filtered = opts.games.length > 0
    ? games.filter(game => opts.games.includes(game.id) || opts.games.includes(game.slug))
    : games;
  if (filtered.length === 0) {
    throw new Error(`No games matched --game filter: ${opts.games.join(', ')}. Available: ${games.map(game => game.id).join(', ')}`);
  }
  return filtered;
}

function runCommand({ command, args, cwd, env, timeoutMs, onOutput, maxCaptureBytes = 2_000_000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer = null;

    // Keep the tail of very chatty runs (LLM prompts can be huge). The
    // structured, regex-matched lines live in the metrics JSON, so dropping
    // older stdout does not lose the report data.
    const append = (current, text) => {
      const next = current + text;
      return next.length > maxCaptureBytes ? next.slice(-maxCaptureBytes) : next;
    };

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout = append(stdout, text);
      onOutput?.({ stream: 'stdout', text });
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr = append(stderr, text);
      onOutput?.({ stream: 'stderr', text });
    });

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: -1, signal: null, timedOut, durationMs: Date.now() - started,
        stdout, stderr, error: err.message,
      });
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: code ?? -1, signal: signal || null, timedOut,
        durationMs: Date.now() - started, stdout, stderr, error: null,
      });
    });
  });
}

async function runPool(tasks, concurrency) {
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, async (_, slot) => {
    while (index < tasks.length) {
      const task = tasks[index++];
      await task(slot);
    }
  });
  await Promise.all(workers);
}

function readMetrics(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.warn(`[suite] could not parse metrics file ${filePath}: ${err.message}`);
    return null;
  }
}

function writeFile(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function metricsPlayerLabel(metrics, id) {
  const player = (metrics.players || []).find(p => String(p.id) === String(id));
  if (!player) return null;
  const controller = player.controllerLabel || player.controller;
  return controller && controller !== player.name
    ? `${player.name} (${controller})`
    : player.name;
}

function progressOutcome(metrics) {
  const outcome = metrics.outcome || {};
  const rounds = outcome.roundsPlayed ?? '?';
  let text;
  if (outcome.winner) {
    const label = metricsPlayerLabel(metrics, outcome.winner.id) || outcome.winner.name;
    text = `${label} wins at turn ${rounds}`;
  } else if (outcome.leader) {
    const label = metricsPlayerLabel(metrics, outcome.leader.id) || outcome.leader.name;
    const score = outcome.leader.score?.total ?? '?';
    text = `cap at turn ${rounds}; leader ${label}, score ${score}`;
  } else {
    text = `finished at turn ${rounds}`;
  }
  const aiMs = (metrics.players || []).reduce((sum, player) => sum + (player.timing?.aiMsTotal || 0), 0);
  return aiMs > 0 ? `${text} [AI ${(aiMs / 1000).toFixed(1)}s]` : text;
}

function progressDots(turns, max = Infinity) {
  const count = Math.max(0, Number(turns) || 0);
  const shown = Number.isFinite(max) ? Math.min(count, max) : count;
  return `${'.'.repeat(shown)}${count > shown ? '…' : ''}`;
}

function createProgressRenderer({ mode, concurrency, everyTurns }) {
  const dashboard = mode === 'dashboard' || (mode === 'auto' && process.stdout.isTTY === true);
  if (mode === 'quiet') {
    return {
      start() {},
      turn() {},
      finish() {},
      error(text) { if (text.trim()) process.stderr.write(text); },
      stop() {},
    };
  }
  if (!dashboard) {
    const states = Array.from({ length: concurrency }, () => null);
    return {
      start(slot, { prefix, seed }) {
        states[slot] = { prefix };
        console.log(`${prefix} seed ${seed ?? 'random'}`);
      },
      turn(slot, { turns, totalTurns }) {
        const prefix = states[slot]?.prefix;
        if (!prefix) return;
        if (everyTurns > 0 && turns % everyTurns === 0 && turns < totalTurns) {
          console.log(`${prefix} ${progressDots(turns)} ${turns}/${totalTurns}`);
        }
      },
      finish(slot, { turns, text }) {
        const prefix = states[slot]?.prefix || 'unknown';
        states[slot] = null;
        console.log(`${prefix} ${progressDots(turns)} ${text}`);
      },
      error(text) {
        if (text.trim()) process.stderr.write(text);
      },
      stop() {},
    };
  }

  const slots = Array.from({ length: concurrency }, () => null);
  let rendered = false;
  const width = Math.max(12, Math.min(32, (process.stdout.columns || 100) - 42));

  const row = (slot) => {
    if (!slot) return '  · idle ·';
    const total = Math.max(1, slot.totalTurns || 1);
    const fraction = Math.min(1, Math.max(0, (slot.turns || 0) / total));
    const filled = Math.round(fraction * width);
    const bar = `${'•'.repeat(filled)}${'·'.repeat(Math.max(0, width - filled))}`;
    return `${slot.prefix} ${bar} ${slot.turns || 0}/${slot.totalTurns}`;
  };

  const writeRows = () => {
    for (let i = 0; i < slots.length; i++) {
      process.stdout.write(`\x1b[2K${row(slots[i])}\n`);
    }
  };

  const render = () => {
    if (!rendered) {
      rendered = true;
      writeRows();
      return;
    }
    process.stdout.write(`\x1b[${slots.length}A`);
    writeRows();
  };

  const printAbove = (line) => {
    if (!rendered) {
      console.log(line);
      return;
    }
    process.stdout.write(`\x1b[${slots.length}A`);
    process.stdout.write(`\x1b[2K${line}\n`);
    // Re-draw the dashboard below the new line. The extra line scrolls the
    // terminal by one row, leaving the final/error line in scrollback.
    writeRows();
  };

  return {
    start(slot, { prefix, totalTurns }) {
      slots[slot] = { prefix, totalTurns, turns: 0 };
      render();
    },
    turn(slot, { turns }) {
      if (!slots[slot]) return;
      slots[slot].turns = turns;
      render();
    },
    finish(slot, { turns, text }) {
      const state = slots[slot] || { prefix: 'unknown' };
      // The final line sits above the fixed-row dashboard. Cap its dots to
      // the terminal width so a 500-turn run cannot wrap and corrupt the
      // cursor math; line mode below prints every dot.
      const maxDots = Math.max(4, Math.min(60,
        (process.stdout.columns || 100) - String(state.prefix).length - String(text).length - 2
      ));
      const finalLine = `${state.prefix} ${progressDots(turns, maxDots)} ${text}`;
      slots[slot] = null;
      if (!rendered) {
        console.log(finalLine);
        return;
      }
      printAbove(finalLine);
    },
    error(text) {
      for (const line of String(text).split('\n')) {
        if (line.trim()) printAbove(line);
      }
    },
    stop() {
      if (!rendered) return;
      rendered = false;
      process.stdout.write(`\x1b[${slots.length}A`);
      for (let i = 0; i < slots.length; i++) {
        process.stdout.write('\x1b[2K');
        if (i < slots.length - 1) process.stdout.write('\n');
      }
      if (slots.length > 1) process.stdout.write(`\x1b[${slots.length - 1}A`);
    },
  };
}

async function main() {
  const opts = parseArgs();
  const configPath = path.resolve(opts.config || path.join(__dirname, 'suite.example.json'));
  if (!existsSync(configPath)) {
    throw new Error(`Suite config not found: ${configPath}`);
  }
  const suite = JSON.parse(readFileSync(configPath, 'utf-8'));
  const games = normalizeSuite(suite, opts, path.dirname(configPath));

  const startedAt = new Date();
  const suiteName = suite.name || path.basename(configPath, '.json');
  const outDir = opts.out
    ? path.resolve(opts.out)
    : path.resolve(
      path.dirname(configPath),
      suite.outputDir || 'results',
      `${slugify(suiteName)}-${timestampSlug(startedAt)}`
    );
  mkdirSync(outDir, { recursive: true });
  mkdirSync(path.join(outDir, 'runs'), { recursive: true });
  mkdirSync(path.join(outDir, 'games'), { recursive: true });
  mkdirSync(path.join(outDir, 'logs'), { recursive: true });
  // Keep the definition variant with the results so a run is auditable even
  // if the generated variant directory is not committed.
  for (const game of games) {
    if (!game.definitionsDir) continue;
    const dest = path.join(outDir, 'definitions', game.slug);
    mkdirSync(dest, { recursive: true });
    for (const file of game.definitionsFiles) {
      copyFileSync(path.join(game.definitionsDir, file), path.join(dest, file));
    }
  }

  const logPatterns = Array.isArray(suite.logPatterns)
    ? suite.logPatterns
    : (suite.report?.logPatterns || []);
  const concurrency = Math.max(1, Number(opts.concurrency ?? suite.concurrency ?? 1) || 1);
  const timeoutMs = Number(suite.timeoutMs ?? 0) || 0;
  const saveFullLogs = opts.fullLogs ?? suite.saveFullLogs ?? false;
  const perRunReports = opts.perRun ?? suite.perRunReports ?? true;
  const maxLogMatches = suite.maxLogMatches ?? 5000;
  const progressEveryTurns = Math.max(0, Number(suite.progressEveryTurns ?? 10) || 0);
  const progressMode = suite.progressMode || 'auto';
  const progress = createProgressRenderer({
    mode: progressMode,
    concurrency,
    everyTurns: progressEveryTurns,
  });

  // Reproducibility copy (secrets redacted).
  writeFile(path.join(outDir, 'suite.resolved.json'), JSON.stringify(redactSecrets({
    configPath,
    name: suite.name || null,
    description: suite.description || null,
    logPatterns,
    concurrency,
    games: games.map(game => ({
      id: game.id, iterations: game.iterations, turns: game.turns,
      seed: game.seed, seedStrategy: game.seedStrategy, seedStep: game.seedStep,
      logPatterns: game.logPatterns,
      matrixValues: game.matrixValues,
      matrixSelection: game.matrixSelection,
      definitionsDir: game.definitionsDir,
      definitionsFiles: game.definitionsFiles,
      settings: game.settings,
    })),
  }), null, 2) + '\n');

  console.log(`[suite] ${suiteName}`);
  console.log(`[suite] config: ${configPath}`);
  console.log(`[suite] output: ${outDir}`);
  console.log(`[suite] games: ${games.length} (${games.reduce((sum, game) => sum + game.iterations, 0)} runs)`);
  if (games.length <= 20) {
    console.log(`[suite] ids: ${games.map(g => `${g.id} x${g.iterations}`).join(', ')}`);
  }
  console.log(`[suite] concurrency: ${concurrency}${logPatterns.length ? `; log patterns: ${logPatterns.join(', ')}` : ''}`);
  for (const game of games) {
    if (game.definitionsDir) {
      console.log(`[suite] definitions ${game.id}: ${game.definitionsDir} (${game.definitionsFiles.join(', ')})`);
    }
  }

  const runsByGame = Object.fromEntries(games.map(game => [game.id, []]));
  let failFastTriggered = false;

  const tasks = [];
  for (const game of games) {
    for (let i = 0; i < game.iterations; i++) {
      tasks.push(async (slot) => {
        if (failFastTriggered && opts.failFast) return;
        const iteration = i + 1;
        const seed = computeSeed(game.seed, game.seedStrategy, i, game.seedStep);
        const runDir = path.join(outDir, 'runs', game.slug);
        const base = `iteration-${iteration}`;
        const configFile = path.join(runDir, `${base}.config.json`);
        const metricsFile = path.join(runDir, `${base}.metrics.json`);
        const logFile = path.join(runDir, `${base}.log`);

        const gameLogPatterns = game.logPatterns?.length ? game.logPatterns : logPatterns;
        const childConfig = deepMerge(game.settings, {
          turns: game.turns,
          seed,
          report: {
            jsonPath: metricsFile,
            logPatterns: gameLogPatterns,
            maxLogMatches,
            runLabel: `${game.id} #${iteration}`,
            iteration,
          },
        });
        mkdirSync(runDir, { recursive: true });
        writeFileSync(configFile, JSON.stringify(childConfig, null, 2) + '\n', { mode: 0o600 });

        const progressPrefix = `${game.id} ${iteration}/${game.iterations}`;
        let turnsSeen = 0;
        let stdoutBuffer = '';
        const handleHeadlessLine = (line) => {
          const match = line.match(/^\[headless\] Turn (\d+) complete/);
          if (!match) return;
          const turn = Number(match[1]);
          if (!Number.isFinite(turn) || turn <= turnsSeen) return;
          turnsSeen = turn;
          progress.turn(slot, { turns: turn, totalTurns: game.turns });
        };

        progress.start(slot, {
          prefix: progressPrefix,
          totalTurns: game.turns,
          seed,
        });
        const childEnv = { ...process.env };
        if (game.definitionsDir) childEnv.HEADLESS_DEFINITIONS_DIR = game.definitionsDir;
        else delete childEnv.HEADLESS_DEFINITIONS_DIR;
        const result = await runCommand({
          command: process.execPath,
          args: [
            '--import', './preload.mjs',
            './headless.mjs',
            '--config', configFile,
            '--report-json', metricsFile,
            '--run-label', `${game.id} #${iteration}`,
            '--iteration', String(iteration),
          ],
          cwd: __dirname,
          env: childEnv,
          timeoutMs,
          onOutput: ({ stream, text }) => {
            if (stream === 'stderr') {
              if (text.trim()) progress.error(text);
              return;
            }
            stdoutBuffer += text;
            const lines = stdoutBuffer.split('\n');
            stdoutBuffer = lines.pop();
            for (const line of lines) handleHeadlessLine(line);
          },
        });
        if (stdoutBuffer) handleHeadlessLine(stdoutBuffer);

        const metrics = readMetrics(metricsFile);
        const keepFullOutput = saveFullLogs || result.exitCode !== 0;
        const run = {
          gameId: game.id,
          iteration,
          seed,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          error: result.error,
          stdout: keepFullOutput ? result.stdout : '',
          stderr: result.stderr,
          configPath: configFile,
          metricsPath: metricsFile,
          definitionsDir: game.definitionsDir,
          definitionsFiles: game.definitionsFiles,
          metrics,
        };
        runsByGame[game.id].push(run);

        if (saveFullLogs) {
          writeFile(logFile, `# stdout\n${result.stdout}\n\n# stderr\n${result.stderr}\n`);
        }

        const finalTurns = metrics?.outcome?.roundsPlayed ?? turnsSeen;
        const finalStatus = metrics ? progressOutcome(metrics) : 'no metrics';
        const suffix = [
          finalStatus,
          result.timedOut ? '[timeout]' : null,
          result.exitCode !== 0 ? `[exit ${result.exitCode}]` : null,
        ].filter(Boolean).join(' ');
        progress.finish(slot, { turns: finalTurns, text: suffix });
        if (result.exitCode !== 0 && opts.failFast) failFastTriggered = true;
      });
    }
  }

  await runPool(tasks, concurrency);
  progress.stop();
  const finishedAt = new Date().toISOString();

  for (const game of games) {
    const runs = runsByGame[game.id].sort((a, b) => a.iteration - b.iteration);
    writeFile(
      path.join(outDir, 'games', `${game.slug}.md`),
      renderGameReport({
        game,
        runs,
        logFile: `../logs/${game.slug}.md`,
      }) + '\n'
    );
    writeFile(
      path.join(outDir, 'logs', `${game.slug}.md`),
      renderLogReport({ game, runs }) + '\n'
    );
    if (perRunReports) {
      for (const run of runs) {
        writeFile(
          path.join(outDir, 'runs', game.slug, `iteration-${run.iteration}.md`),
          renderRunReport({ game, run }) + '\n'
        );
      }
    }
  }

  writeFile(
    path.join(outDir, 'summary.md'),
    renderSummary({
      suite,
      games,
      runsByGame,
      outputDir: outDir,
      startedAt: startedAt.toISOString(),
      finishedAt,
    }) + '\n'
  );

  const allRuns = games.flatMap(game => runsByGame[game.id]);
  const failed = allRuns.filter(run => run.exitCode !== 0 || !run.metrics);
  console.log(`[suite] report: ${path.join(outDir, 'summary.md')}`);
  console.log(`[suite] ${allRuns.length} run(s), ${failed.length} failure(s)`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error('[suite] FATAL:', err);
  process.exit(2);
});
