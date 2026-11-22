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
 *   node --import ./stubs.mjs --loader ./loader.mjs ./tournament.mjs \
 *     --config suite.example.json --iterations 3 --out results/run-1
 *
 * See tests/headless/README.md "AI controller suite" for the config schema
 * and report layout.
 */
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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
  'id', 'slug', 'settings', 'label',
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

function normalizeSuite(suite, opts) {
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
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, async () => {
    while (index < tasks.length) {
      const task = tasks[index++];
      await task();
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

async function main() {
  const opts = parseArgs();
  const configPath = path.resolve(opts.config || path.join(__dirname, 'suite.example.json'));
  if (!existsSync(configPath)) {
    throw new Error(`Suite config not found: ${configPath}`);
  }
  const suite = JSON.parse(readFileSync(configPath, 'utf-8'));
  const games = normalizeSuite(suite, opts);

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

  const logPatterns = Array.isArray(suite.logPatterns)
    ? suite.logPatterns
    : (suite.report?.logPatterns || []);
  const concurrency = Math.max(1, Number(opts.concurrency ?? suite.concurrency ?? 1) || 1);
  const timeoutMs = Number(suite.timeoutMs ?? 0) || 0;
  const saveFullLogs = opts.fullLogs ?? suite.saveFullLogs ?? false;
  const perRunReports = opts.perRun ?? suite.perRunReports ?? true;
  const maxLogMatches = suite.maxLogMatches ?? 5000;

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

  const runsByGame = Object.fromEntries(games.map(game => [game.id, []]));
  let failFastTriggered = false;

  const tasks = [];
  for (const game of games) {
    for (let i = 0; i < game.iterations; i++) {
      tasks.push(async () => {
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

        console.log(`[suite] start ${game.id} iteration ${iteration}/${game.iterations} (seed ${seed ?? 'random'})`);
        const result = await runCommand({
          command: process.execPath,
          args: [
            '--import', './stubs.mjs',
            '--loader', './loader.mjs',
            './headless.mjs',
            '--config', configFile,
            '--report-json', metricsFile,
            '--run-label', `${game.id} #${iteration}`,
            '--iteration', String(iteration),
          ],
          cwd: __dirname,
          env: process.env,
          timeoutMs,
          onOutput: ({ stream, text }) => {
            if (stream === 'stderr' && text.trim()) process.stderr.write(text);
          },
        });

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
          metrics,
        };
        runsByGame[game.id].push(run);

        if (saveFullLogs) {
          writeFile(logFile, `# stdout\n${result.stdout}\n\n# stderr\n${result.stderr}\n`);
        }

        const status = metrics
          ? (result.exitCode === 0 ? 'ok' : `exit ${result.exitCode}`)
          : 'no metrics';
        console.log(`[suite] done  ${game.id} iteration ${iteration}: ${status} in ${(result.durationMs / 1000).toFixed(1)}s`);
        if (result.exitCode !== 0 && opts.failFast) failFastTriggered = true;
      });
    }
  }

  await runPool(tasks, concurrency);
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
