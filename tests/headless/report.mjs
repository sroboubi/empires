/**
 * Markdown report rendering for headless AI suite runs.
 *
 * Inputs are the normalized suite definition from tournament.mjs and the
 * per-iteration metrics JSON produced by headless.mjs / metrics.mjs. All
 * rendering is pure: no game modules are imported here.
 */

function cell(value) {
  if (value === null || value === undefined) return '—';
  return String(value)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

function code(value) {
  return `\`${String(value ?? '').replace(/`/g, "'")}\``;
}

function fmt(value, digits = 0) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (digits === 0) return String(Math.round(n));
  return n.toFixed(digits).replace(/\.?0+$/, '');
}

function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

function avg(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  return nums.length ? sum(nums) / nums.length : null;
}

function pct(part, total) {
  if (!total) return '—';
  return `${((part / total) * 100).toFixed(0)}%`;
}

function table(headers, rows) {
  const head = `| ${headers.map(cell).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map(row => `| ${row.map(cell).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

function playerTitle(pm) {
  if (!pm) return '—';
  const ctrl = pm.controllerLabel || pm.controller || 'human';
  const model = pm.model && pm.model !== ctrl ? ` / ${pm.model}` : '';
  const leader = pm.leader && pm.leader !== pm.name ? `; leader ${pm.leader}` : '';
  return `${pm.name} (${ctrl}${model}${leader})`;
}

function winnerTitle(metrics) {
  const winner = metrics?.outcome?.winner;
  if (!winner) return '—';
  const pm = (metrics.players || []).find(p => String(p.id) === String(winner.id));
  return playerTitle(pm);
}

function leaderTitle(metrics) {
  const leader = metrics?.outcome?.leader;
  if (!leader) return '—';
  const pm = (metrics.players || []).find(p => String(p.id) === String(leader.id));
  return playerTitle(pm);
}

function metricsRuns(runs) {
  // Failed iterations remain visible in the run tables, but are excluded
  // from averages so a crashed/assertion-failed game cannot skew them.
  return runs.filter(run => run.metrics && run.exitCode === 0).map(run => run.metrics);
}

function playerIds(metricsList) {
  const ids = [];
  const seen = new Set();
  for (const metrics of metricsList) {
    for (const player of metrics.players || []) {
      const id = String(player.id);
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function playerMap(metrics) {
  return Object.fromEntries((metrics.players || []).map(p => [String(p.id), p]));
}

function collectTypes(metricsList, field, includeBuilt = false) {
  const types = new Set();
  for (const metrics of metricsList) {
    for (const player of metrics.players || []) {
      for (const type of Object.keys(player[field] || {})) types.add(type);
      if (includeBuilt) {
        for (const type of Object.keys(player.entitiesBuiltByType || {})) types.add(type);
      }
    }
  }
  return [...types].sort();
}

function collectResources(metricsList) {
  const resources = new Set();
  for (const metrics of metricsList) {
    for (const player of metrics.players || []) {
      for (const resource of Object.keys(player.resourcesProduced || {})) resources.add(resource);
      for (const resource of Object.keys(player.resourcesConsumed || {})) resources.add(resource);
      for (const resource of Object.keys(player.resources || {})) resources.add(resource);
    }
  }
  return [...resources].sort();
}

function configuredPlayerTitle(p) {
  const c = p.controller;
  const key = typeof c === 'string' ? c : (c?.key || (c?.url ? c.url.split('/').pop().replace(/\.js$/, '') : 'human'));
  const rawModel = c?.config?.model ?? p.controllerConfig?.model;
  const model = Array.isArray(rawModel) ? rawModel.join(', ') : rawModel;
  const display = p.label || model || key;
  const extra = p.label && model && p.label !== model ? ` / ${model}` : '';
  const leader = p.leader && p.leader !== p.name ? `; leader ${p.leader}` : '';
  return `${p.name} (${display}${extra}${leader})`;
}

function configTable(game) {
  const s = game.settings || {};
  const playerList = (game.settings.players || []).map(configuredPlayerTitle).join(', ');
  const barbarians = s.barbarians
    ? `enabled (max ${s.barbarians.maxNumber ?? '—'}, aggression ${s.barbarians.aggression ?? '—'})`
    : 'disabled';
  return table(['Setting', 'Value'], [
    ['Game ID', game.id],
    ['Iterations', game.iterations],
    ['Turns', s.turns ?? '—'],
    ['Map size', s.mapSize ?? '—'],
    ['Seed', game.seed ?? '—'],
    ['Seed strategy', game.seedStrategy || 'increment'],
    ['Players', playerList || '—'],
    ['Barbarians', barbarians],
    ['Win condition', s.winCondition ? `absolute ${s.winCondition.absoluteScore ?? '—'}, relative ${s.winCondition.relativeScore ?? '—'}` : 'none'],
  ]);
}

function matrixSummary(game) {
  if (!game.matrixSelection || game.matrixSelection.length === 0) return '—';
  return game.matrixSelection.map(item => `${item.path}=${item.label}`).join('; ');
}

function matrixTable(game) {
  if (!game.matrixSelection || game.matrixSelection.length === 0) return null;
  return table(
    ['Path', 'Option', 'Resolved value'],
    game.matrixSelection.map(item => [
      item.path,
      item.label,
      code(JSON.stringify(item.value)),
    ])
  );
}

function outcomeRows(runs) {
  return runs.map(run => {
    const metrics = run.metrics;
    return [
      run.iteration,
      run.seed ?? '—',
      metrics ? winnerTitle(metrics) : '—',
      metrics ? (metrics.outcome.roundsPlayed ?? '—') : '—',
      metrics ? (metrics.outcome.leader?.score?.total ?? '—') : '—',
      run.exitCode,
      run.timedOut ? 'timeout' : (run.exitCode === 0 ? 'ok' : 'failed'),
    ];
  });
}

function aggregatePlayerRows(game, runs, metricsList, extended = true) {
  const ids = playerIds(metricsList);
  const rows = [];
  for (const id of ids) {
    const samples = metricsList
      .map(metrics => ({ metrics, player: playerMap(metrics)[id] }))
      .filter(sample => sample.player);
    if (samples.length === 0) continue;
    const first = samples[0].player;
    const wins = samples.filter(sample => String(sample.metrics.outcome.winner?.id) === id).length;
    const leads = samples.filter(sample => String(sample.metrics.outcome.leader?.id) === id).length;
    const row = [
      playerTitle(first),
      wins,
      leads,
      samples.length,
      pct(wins, samples.length),
      fmt(avg(samples.map(s => s.player.finalScore?.total)), 1),
      fmt(avg(samples.map(s => s.player.finalScore?.military)), 1),
      fmt(avg(samples.map(s => s.player.finalScore?.economic)), 1),
      fmt(avg(samples.map(s => s.player.finalScore?.exploration)), 1),
      fmt(avg(samples.map(s => s.player.entitiesKilled)), 1),
      fmt(avg(samples.map(s => s.player.entitiesLost)), 1),
      fmt(avg(samples.map(s => s.player.chatsInitiated)), 1),
      fmt(avg(samples.map(s => s.player.tradesAccepted)), 1),
    ];
    rows.push(extended ? row : row.slice(0, 9));
  }
  return rows;
}

function timingRows(metricsList) {
  const ids = playerIds(metricsList);
  const rows = [];
  for (const id of ids) {
    const samples = metricsList.map(metrics => playerMap(metrics)[id]).filter(Boolean);
    const timed = samples.filter(player => player.timing);
    if (timed.length === 0) continue;
    const turns = sum(timed.map(player => player.timing.turns || 0));
    const stepMs = sum(timed.map(player => player.timing.stepMsTotal || 0));
    const aiMs = sum(timed.map(player => player.timing.aiMsTotal || 0));
    const strategicMs = sum(timed.map(player => player.timing.strategicMsTotal || 0));
    const engineMs = sum(timed.map(player => player.timing.engineMsTotal || 0));
    rows.push([
      playerTitle(samples[0]),
      timed.length,
      turns,
      turns ? fmt(aiMs / turns, 1) : '—',
      turns ? fmt(stepMs / turns, 1) : '—',
      turns ? fmt(strategicMs / turns, 1) : '—',
      turns ? fmt(engineMs / turns, 1) : '—',
      fmt(aiMs / 1000, 2),
      fmt(aiMs / timed.length / 1000, 2),
      fmt(stepMs / timed.length / 1000, 2),
      pct(aiMs, stepMs),
    ]);
  }
  return rows;
}

function timingHeaders() {
  return [
    'Player (controller)', 'Runs', 'Turns',
    'Avg AI ms/turn', 'Avg step ms/turn', 'Avg strategic ms/turn',
    'Avg engine ms/turn', 'Total AI sec', 'Avg AI sec/run', 'Avg step sec/run', 'AI share',
  ];
}

function averageTimelineRows(metricsList, ids, field) {
  const rounds = [...new Set(metricsList.flatMap(metrics =>
    (metrics.timeline || []).map(entry => entry.round)
  ))].sort((a, b) => a - b);
  return rounds.map(round => {
    const row = [round];
    for (const id of ids) {
      const samples = metricsList
        .map(metrics => (metrics.timeline || []).find(entry => entry.round === round))
        .filter(Boolean)
        .map(entry => entry.players?.[id])
        .filter(Boolean);
      if (field === 'score') {
        row.push(fmt(avg(samples.map(p => p.score?.total)), 1));
      } else if (field === 'produced') {
        row.push(fmt(avg(samples.map(p => sum(Object.values(p.produced || {})))), 1));
      } else if (field === 'consumed') {
        row.push(fmt(avg(samples.map(p => sum(Object.values(p.consumed || {})))), 1));
      }
    }
    return row;
  });
}

function logsSummary(metricsList) {
  const totals = {};
  for (const metrics of metricsList) {
    for (const [pattern, count] of Object.entries(metrics.logs?.counts || {})) {
      totals[pattern] = (totals[pattern] || 0) + count;
    }
  }
  return totals;
}

export function renderSummary({ suite, games, runsByGame, outputDir, startedAt, finishedAt }) {
  const allRuns = games.flatMap(game => runsByGame[game.id] || []);
  const allMetrics = metricsRuns(allRuns);
  const withMetrics = allRuns.filter(run => run.metrics).length;
  const failures = allRuns.filter(run => !run.metrics || run.exitCode !== 0);

  const lines = [];
  lines.push(`# ${suite.name || 'AI headless suite'} — summary`);
  lines.push('');
  if (suite.description) lines.push(suite.description, '');
  lines.push(`Generated: ${finishedAt}`);
  lines.push('');
  lines.push(`- Output directory: \`${outputDir}\``);
  lines.push(`- Games (settings): ${games.length}`);
  lines.push(`- Iterations: ${allRuns.length}`);
  lines.push(`- With metrics: ${withMetrics}`);
  lines.push(`- Failures: ${failures.length}`);
  lines.push(`- Suite started: ${startedAt}`);
  const wallMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  lines.push(`- Suite wall time: ${(wallMs / 1000).toFixed(1)} s`);
  lines.push('');
  lines.push('Failed iterations are listed below and in each game report, but are excluded from averages.');
  lines.push('');

  lines.push('## Game settings');
  lines.push('');
  const hasMatrix = games.some(game => game.matrixSelection?.length);
  const settingsHeaders = ['Game', 'Iterations', 'Turns', 'Map', 'Seed'];
  if (hasMatrix) settingsHeaders.push('Matrix');
  settingsHeaders.push('Players');
  lines.push(table(
    settingsHeaders,
    games.map(game => {
      const s = game.settings || {};
      const players = (s.players || []).map(configuredPlayerTitle).join(', ');
      const row = [game.id, game.iterations, s.turns ?? '—', s.mapSize ?? '—', game.seed ?? '—'];
      if (hasMatrix) row.push(matrixSummary(game));
      row.push(players || '—');
      return row;
    })
  ));
  lines.push('');

  lines.push('## Run outcomes');
  lines.push('');
  lines.push(table(
    ['Game', 'Run', 'Seed', 'Winner', 'Rounds', 'Leader score', 'Exit', 'Status'],
    allRuns.map(run => {
      const metrics = run.metrics;
      return [
        run.gameId,
        run.iteration,
        run.seed ?? '—',
        metrics ? winnerTitle(metrics) : '—',
        metrics ? (metrics.outcome.roundsPlayed ?? '—') : '—',
        metrics ? (metrics.outcome.leader?.score?.total ?? '—') : '—',
        run.exitCode,
        run.timedOut ? 'timeout' : (run.exitCode === 0 ? 'ok' : 'failed'),
      ];
    })
  ));
  lines.push('');

  lines.push('## Win rates and averages by controller');
  lines.push('');
  const aggregateRows = [];
  for (const game of games) {
    const runs = runsByGame[game.id] || [];
    const metricsList = metricsRuns(runs);
    for (const row of aggregatePlayerRows(game, runs, metricsList)) {
      aggregateRows.push([game.id, ...row]);
    }
  }
  lines.push(table(
    ['Game', 'Player (controller)', 'Wins', 'Leads', 'Runs', 'Win rate', 'Avg total', 'Avg mil.', 'Avg econ.', 'Avg expl.', 'Avg killed', 'Avg lost', 'Avg chats', 'Avg trades'],
    aggregateRows
  ));
  lines.push('');

  lines.push('## Setting averages');
  lines.push('');
  lines.push(table(
    ['Game', 'Runs', 'Finished OK', 'Won early', 'Avg rounds', 'Avg leader score', 'Avg built/player', 'Avg killed/player', 'Avg lost/player', 'Avg chats/player', 'Avg trades/player', 'Avg barb. encounters'],
    games.map(game => {
      const runs = runsByGame[game.id] || [];
      const metricsList = metricsRuns(runs);
      const players = metricsList.flatMap(metrics => metrics.players || []);
      return [
        game.id,
        runs.length,
        runs.filter(run => run.metrics && run.exitCode === 0 && run.metrics.outcome.failures === 0).length,
        metricsList.filter(metrics => metrics.outcome.gameOver && metrics.outcome.winner).length,
        fmt(avg(metricsList.map(metrics => metrics.outcome.roundsPlayed)), 1),
        fmt(avg(metricsList.map(metrics => metrics.outcome.leader?.score?.total)), 1),
        fmt(avg(players.map(p => p.entitiesBuilt)), 1),
        fmt(avg(players.map(p => p.entitiesKilled)), 1),
        fmt(avg(players.map(p => p.entitiesLost)), 1),
        fmt(avg(players.map(p => p.chatsInitiated)), 1),
        fmt(avg(players.map(p => p.tradesAccepted)), 1),
        fmt(avg(metricsList.map(metrics => metrics.totals?.barbarians?.encounters)), 1),
      ];
    })
  ));
  lines.push('');

  lines.push('## Average AI timing by game/player');
  lines.push('');
  lines.push('`AI` is the controller\'s `processTurn()` time; `step` also includes engine work. `AI share` is AI time / step time.');
  lines.push('');
  const timingAggregateRows = [];
  for (const game of games) {
    const runs = runsByGame[game.id] || [];
    const metricsList = metricsRuns(runs);
    for (const row of timingRows(metricsList)) {
      timingAggregateRows.push([game.id, ...row]);
    }
  }
  lines.push(table(['Game', ...timingHeaders()], timingAggregateRows));
  lines.push('');

  lines.push('## Captured log patterns');
  lines.push('');
  const logTotals = logsSummary(allMetrics);
  lines.push(table(
    ['Pattern', 'Matches'],
    Object.entries(logTotals).length ? Object.entries(logTotals).map(([pattern, count]) => [code(pattern), count]) : [['(none)', 0]]
  ));
  lines.push('');

  lines.push('## Game reports');
  lines.push('');
  for (const game of games) {
    lines.push(`- [${game.id}](games/${game.slug}.md) — ${(runsByGame[game.id] || []).length} iteration(s)`);
  }
  lines.push('');

  if (failures.length > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const run of failures) {
      lines.push(`### ${run.gameId} — iteration ${run.iteration}`);
      lines.push('');
      lines.push(`- Exit code: ${run.exitCode}${run.timedOut ? ' (timeout)' : ''}`);
      if (run.seed !== null && run.seed !== undefined) lines.push(`- Seed: ${run.seed}`);
      if (run.metrics?.outcome?.failures) {
        lines.push(`- Assertion failures: ${run.metrics.outcome.failures}`);
        for (const message of run.metrics.outcome.failureMessages || []) {
          lines.push(`  - ${message}`);
        }
      }
      if (run.error) lines.push(`- Runner error: ${run.error}`);
      const stderr = (run.stderr || '').trim();
      if (stderr) {
        lines.push('');
        lines.push('```text');
        lines.push(stderr.split('\n').slice(-40).join('\n'));
        lines.push('```');
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function renderGameReport({ game, runs, logFile }) {
  const metricsList = metricsRuns(runs);
  const ids = playerIds(metricsList);
  const lines = [];

  lines.push(`# ${game.id} — AI game settings report`);
  lines.push('');
  if (game.description) lines.push(game.description, '');
  lines.push(configTable(game));
  lines.push('');
  const matrix = matrixTable(game);
  if (matrix) {
    lines.push('## Matrix values');
    lines.push('');
    lines.push(matrix);
    lines.push('');
  }

  lines.push('## Iterations');
  lines.push('');
  lines.push(table(['Run', 'Seed', 'Winner', 'Rounds', 'Leader score', 'Exit', 'Status'], outcomeRows(runs)));
  lines.push('');

  lines.push('## Average final scores by player');
  lines.push('');
  lines.push(table(
    ['Player (controller)', 'Wins', 'Leads', 'Runs', 'Win rate', 'Avg total', 'Avg military', 'Avg economic', 'Avg exploration'],
    aggregatePlayerRows(game, runs, metricsList, false)
  ));
  lines.push('');

  // Entity types (average final count per player).
  lines.push('## Average final entities by type');
  lines.push('');
  const types = collectTypes(metricsList, 'entities');
  const entityRows = [];
  for (const id of ids) {
    const samples = metricsList.map(metrics => playerMap(metrics)[id]).filter(Boolean);
    if (samples.length === 0) continue;
    const row = [playerTitle(samples[0])];
    for (const type of types) {
      row.push(fmt(avg(samples.map(p => p.entities?.[type] || 0)), 1));
    }
    row.push(fmt(avg(samples.map(p => p.entityCount)), 1));
    entityRows.push(row);
  }
  lines.push(table(['Player', ...types, 'Total'], entityRows.length ? entityRows : [['—']]));
  lines.push('');

  lines.push('## Average combat, losses and economy');
  lines.push('');
  lines.push(table(
    ['Player', 'Avg built', 'Avg lost', 'Avg killed', 'Avg damage dealt', 'Avg damage taken', 'Avg peak entities'],
    ids.map(id => {
      const samples = metricsList.map(metrics => playerMap(metrics)[id]).filter(Boolean);
      const first = samples[0];
      if (!first) return [id, '—', '—', '—', '—', '—', '—'];
      return [
        playerTitle(first),
        fmt(avg(samples.map(p => p.entitiesBuilt)), 1),
        fmt(avg(samples.map(p => p.entitiesLost)), 1),
        fmt(avg(samples.map(p => p.entitiesKilled)), 1),
        fmt(avg(samples.map(p => p.damageDealt)), 1),
        fmt(avg(samples.map(p => p.damageTaken)), 1),
        fmt(avg(samples.map(p => p.peakEntityCount)), 1),
      ];
    })
  ));
  lines.push('');

  lines.push('## Average AI timing by player');
  lines.push('');
  lines.push('`AI` is the controller\'s `processTurn()` time; `step` also includes engine work.');
  lines.push('');
  const gameTimingRows = timingRows(metricsList);
  lines.push(gameTimingRows.length
    ? table(timingHeaders(), gameTimingRows)
    : 'No timing data recorded.');
  lines.push('');

  const lostTypes = collectTypes(metricsList, 'entitiesLostByType');
  lines.push('## Average losses by entity type');
  lines.push('');
  if (lostTypes.length === 0) {
    lines.push('No entity losses recorded.');
  } else {
    lines.push(table(
      ['Player', ...lostTypes, 'Total'],
      ids.map(id => {
        const samples = metricsList.map(metrics => playerMap(metrics)[id]).filter(Boolean);
        const first = samples[0];
        if (!first) return [id, ...lostTypes.map(() => '—'), '—'];
        return [
          playerTitle(first),
          ...lostTypes.map(type => fmt(avg(samples.map(p => p.entitiesLostByType?.[type] || 0)), 1)),
          fmt(avg(samples.map(p => p.entitiesLost)), 1),
        ];
      })
    ));
  }
  lines.push('');

  const killedTypes = collectTypes(metricsList, 'entitiesKilledByType');
  lines.push('## Average kills by victim type');
  lines.push('');
  if (killedTypes.length === 0) {
    lines.push('No kills recorded.');
  } else {
    lines.push(table(
      ['Player', ...killedTypes, 'Total'],
      ids.map(id => {
        const samples = metricsList.map(metrics => playerMap(metrics)[id]).filter(Boolean);
        const first = samples[0];
        if (!first) return [id, ...killedTypes.map(() => '—'), '—'];
        return [
          playerTitle(first),
          ...killedTypes.map(type => fmt(avg(samples.map(p => p.entitiesKilledByType?.[type] || 0)), 1)),
          fmt(avg(samples.map(p => p.entitiesKilled)), 1),
        ];
      })
    ));
  }
  lines.push('');

  lines.push('## Average diplomacy and trade');
  lines.push('');
  lines.push(table(
    ['Player', 'Chats initiated', 'Chats participated', 'Messages sent', 'Trades proposed', 'Trades received', 'Accepted', 'Countered', 'Rejected', 'Active'],
    ids.map(id => {
      const samples = metricsList.map(metrics => playerMap(metrics)[id]).filter(Boolean);
      const first = samples[0];
      if (!first) return [id, '—', '—', '—', '—', '—', '—', '—', '—', '—'];
      return [
        playerTitle(first),
        fmt(avg(samples.map(p => p.chatsInitiated)), 1),
        fmt(avg(samples.map(p => p.chatsParticipated)), 1),
        fmt(avg(samples.map(p => p.chatMessagesSent)), 1),
        fmt(avg(samples.map(p => p.tradesProposed)), 1),
        fmt(avg(samples.map(p => p.tradesReceived)), 1),
        fmt(avg(samples.map(p => p.tradesAccepted)), 1),
        fmt(avg(samples.map(p => p.tradesCountered)), 1),
        fmt(avg(samples.map(p => p.tradesRejected)), 1),
        fmt(avg(samples.map(p => p.tradesActive)), 1),
      ];
    })
  ));
  lines.push('');

  lines.push('## Barbarians');
  lines.push('');
  lines.push(table(
    ['Run', 'Spawned', 'Encounters', 'Targeted', 'Ignored', 'Attacks', 'Player units killed', 'Barbarians killed', 'Died of old age'],
    metricsList.map(metrics => {
      const b = metrics.totals?.barbarians || {};
      return [
        metrics.run.iteration,
        b.spawned ?? 0,
        b.encounters ?? 0,
        b.targeted ?? 0,
        b.ignored ?? 0,
        b.attacks ?? 0,
        b.playerUnitsKilled ?? 0,
        b.barbariansKilled ?? 0,
        b.diedOfOldAge ?? 0,
      ];
    })
  ));
  lines.push('');
  lines.push('### Average barbarian interactions by player');
  lines.push('');
  lines.push(table(
    ['Player', 'Avg barbarian engagements', 'Avg attacks received', 'Avg barbarians killed', 'Avg units lost to barbarians'],
    ids.map(id => {
      const samples = metricsList.map(metrics => playerMap(metrics)[id]).filter(Boolean);
      const first = samples[0];
      if (!first) return [id, '—', '—', '—', '—'];
      return [
        playerTitle(first),
        fmt(avg(samples.map(p => p.barbarianEngagements)), 1),
        fmt(avg(samples.map(p => p.barbarianAttacksReceived)), 1),
        fmt(avg(samples.map(p => p.barbarianKills)), 1),
        fmt(avg(samples.map(p => p.unitsLostToBarbarians)), 1),
      ];
    })
  ));
  lines.push('');

  lines.push('## Average score over time');
  lines.push('');
  lines.push('Averages are over runs that reached the round.');
  lines.push('');
  lines.push(table(
    ['Round', ...ids.map(id => {
      const sample = metricsList.map(metrics => playerMap(metrics)[id]).find(Boolean);
      return sample ? playerTitle(sample) : id;
    })],
    averageTimelineRows(metricsList, ids, 'score')
  ));
  lines.push('');

  lines.push('## Average resource production / consumption over time');
  lines.push('');
  lines.push('All resources summed. Gross flows include yields, treasure, trade receipts and orders-overflow conversions; consumption includes upkeep, build/spawn costs and trade sends. Averages are over runs that reached the round.');
  lines.push('');
  const resourceHeaders = ['Round'];
  for (const id of ids) {
    const sample = metricsList.map(metrics => playerMap(metrics)[id]).find(Boolean);
    const title = sample ? sample.name : id;
    resourceHeaders.push(`${title} produced`, `${title} consumed`);
  }
  const producedRows = averageTimelineRows(metricsList, ids, 'produced');
  const consumedRows = averageTimelineRows(metricsList, ids, 'consumed');
  const byRound = new Map();
  for (const row of producedRows) byRound.set(row[0], { produced: row.slice(1) });
  for (const row of consumedRows) {
    const existing = byRound.get(row[0]) || { produced: ids.map(() => '—') };
    existing.consumed = row.slice(1);
    byRound.set(row[0], existing);
  }
  lines.push(table(
    resourceHeaders,
    [...byRound.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([round, data]) => {
        const row = [round];
        for (let i = 0; i < ids.length; i++) {
          row.push(data.produced?.[i] ?? '—', data.consumed?.[i] ?? '—');
        }
        return row;
      })
  ));
  lines.push('');

  lines.push('## Average resource totals by resource');
  lines.push('');
  const resources = collectResources(metricsList);
  const resourceRows = [];
  for (const id of ids) {
    const samples = metricsList.map(metrics => playerMap(metrics)[id]).filter(Boolean);
    if (samples.length === 0) continue;
    for (const resource of resources) {
      resourceRows.push([
        playerTitle(samples[0]),
        resource,
        fmt(avg(samples.map(p => p.resourcesProduced?.[resource] || 0)), 1),
        fmt(avg(samples.map(p => p.resourcesConsumed?.[resource] || 0)), 1),
        fmt(avg(samples.map(p => (p.resourcesProduced?.[resource] || 0) - (p.resourcesConsumed?.[resource] || 0))), 1),
        fmt(avg(samples.map(p => p.resources?.[resource] || 0)), 1),
      ]);
    }
  }
  lines.push(table(['Player', 'Resource', 'Avg produced', 'Avg consumed', 'Avg net', 'Avg final stock'], resourceRows));
  lines.push('');

  lines.push('## Logs');
  lines.push('');
  const logTotals = logsSummary(metricsList);
  lines.push(table(
    ['Pattern', 'Matches'],
    Object.entries(logTotals).length ? Object.entries(logTotals).map(([pattern, count]) => [code(pattern), count]) : [['(none)', 0]]
  ));
  if (logFile) {
    lines.push('');
    lines.push(`Matched lines: [${logFile}](${logFile})`);
  }
  lines.push('');

  lines.push('## Per-run detail');
  lines.push('');
  for (const run of runs) {
    lines.push(`- [Iteration ${run.iteration}](../runs/${game.slug}/iteration-${run.iteration}.md) — ${run.metrics ? (run.exitCode === 0 ? 'ok' : 'failed') : 'no metrics'}`);
  }
  lines.push('');

  return lines.join('\n');
}

export function renderRunReport({ game, run }) {
  const metrics = run.metrics;
  const lines = [];
  lines.push(`# ${game.id} — iteration ${run.iteration}`);
  lines.push('');
  if (!metrics) {
    lines.push('No metrics were produced. Exit code: ' + run.exitCode);
    if (run.error) lines.push('', run.error);
    if (run.stderr) {
      lines.push('', '```text', run.stderr.split('\n').slice(-80).join('\n'), '```');
    }
    return lines.join('\n');
  }

  const ids = playerIds([metrics]);
  const players = playerMap(metrics);
  const outcome = metrics.outcome || {};

  lines.push(table(['Field', 'Value'], [
    ['Run label', metrics.run.label ?? '—'],
    ['Seed', run.seed ?? metrics.run.seed ?? '—'],
    ['Turns requested', metrics.run.turns ?? '—'],
    ['Rounds played', outcome.roundsPlayed ?? '—'],
    ['Map size', metrics.run.mapSize ?? '—'],
    ['Started', metrics.run.startedAt],
    ['Finished', metrics.run.finishedAt],
    ['Duration', `${fmt(metrics.run.durationMs / 1000, 2)} s`],
    ['Exit code', run.exitCode],
    ['Completed all turns', outcome.completedAllTurns ? 'yes' : 'no'],
    ['Game over (win)', outcome.gameOver ? 'yes' : 'no'],
    ['Winner', winnerTitle(metrics)],
    ['Win reasons', (outcome.winner?.reasons || []).join('; ') || '—'],
    ['Leader', leaderTitle(metrics)],
    ['Assertion failures', outcome.failures ?? 0],
  ]));
  lines.push('');

  if ((outcome.failureMessages || []).length > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const message of outcome.failureMessages) lines.push(`- ${message}`);
    lines.push('');
  }
  if ((outcome.metricsErrors || []).length > 0) {
    lines.push('## Metrics instrumentation errors');
    lines.push('');
    for (const message of outcome.metricsErrors) lines.push(`- ${message}`);
    lines.push('');
  }

  lines.push('## Final scores');
  lines.push('');
  lines.push(table(
    ['Player (controller)', 'Military', 'Economic', 'Exploration', 'Total', 'Entities'],
    ids.map(id => {
      const p = players[id];
      return [
        playerTitle(p),
        fmt(p.finalScore?.military, 1),
        fmt(p.finalScore?.economic, 1),
        fmt(p.finalScore?.exploration, 1),
        fmt(p.finalScore?.total, 1),
        fmt(p.entityCount),
      ];
    })
  ));
  lines.push('');

  const turnTimings = metrics.timings || [];
  if (turnTimings.length) {
    lines.push('## Timing by player');
    lines.push('');
    lines.push('`AI` is the controller\'s `processTurn()` time; `step` also includes engine work.');
    lines.push('');
    lines.push(table(
      ['Player', 'Turns', 'AI total s', 'Step total s', 'Avg AI ms', 'Avg step ms', 'Max AI ms', 'AI share'],
      ids.map(id => {
        const p = players[id];
        const t = p.timing;
        if (!t) return [playerTitle(p), '—', '—', '—', '—', '—', '—', '—'];
        return [
          playerTitle(p),
          t.turns,
          fmt(t.aiMsTotal / 1000, 2),
          fmt(t.stepMsTotal / 1000, 2),
          fmt(t.aiAvgMs, 1),
          fmt(t.stepAvgMs, 1),
          fmt(t.aiMaxMs, 1),
          pct(t.aiMsTotal, t.stepMsTotal),
        ];
      })
    ));
    lines.push('');

    const byRound = new Map();
    for (const timing of turnTimings) {
      if (!byRound.has(timing.round)) byRound.set(timing.round, {});
      byRound.get(timing.round)[String(timing.playerId)] = timing;
    }
    const rounds = [...byRound.keys()].sort((a, b) => a - b);
    lines.push('## Per-turn timing (AI ms / step ms)');
    lines.push('');
    lines.push(table(
      ['Round', ...ids.map(id => `${players[id].name} AI/step`), 'Total AI ms'],
      rounds.map(round => {
        const row = [round];
        let totalAi = 0;
        for (const id of ids) {
          const timing = byRound.get(round)[id];
          if (!timing) {
            row.push('—');
          } else {
            totalAi += timing.aiMs;
            row.push(`${fmt(timing.aiMs, 1)} / ${fmt(timing.stepMs, 1)}`);
          }
        }
        row.push(fmt(totalAi, 1));
        return row;
      })
    ));
    lines.push('');
  }

  lines.push('## Entities owned');
  lines.push('');
  const ownTypes = collectTypes([metrics], 'entities', true);
  lines.push(table(
    ['Player', ...ownTypes, 'Total'],
    ids.map(id => {
      const p = players[id];
      return [
        playerTitle(p),
        ...ownTypes.map(type => {
          const final = p.entities?.[type] || 0;
          const built = p.entitiesBuiltByType?.[type] || 0;
          const lost = p.entitiesLostByType?.[type] || 0;
          return `final ${final} / built ${built} / lost ${lost}`;
        }),
        `final ${p.entityCount} / built ${p.entitiesBuilt} / lost ${p.entitiesLost}`,
      ];
    })
  ));
  lines.push('');

  lines.push('## Kills and combat');
  lines.push('');
  const killTypes = collectTypes([metrics], 'entitiesKilledByType');
  lines.push(table(
    ['Player', 'Killed', ...killTypes.map(type => `Killed ${type}`), 'Damage dealt', 'Damage taken'],
    ids.map(id => {
      const p = players[id];
      return [
        playerTitle(p),
        p.entitiesKilled,
        ...killTypes.map(type => p.entitiesKilledByType?.[type] || 0),
        fmt(p.damageDealt, 1),
        fmt(p.damageTaken, 1),
      ];
    })
  ));
  lines.push('');

  lines.push('## Diplomacy and trade');
  lines.push('');
  lines.push(table(
    ['Player', 'Chats initiated', 'Chats participated', 'Messages sent', 'Trades proposed', 'Trades received', 'Accepted', 'Countered', 'Rejected', 'Active'],
    ids.map(id => {
      const p = players[id];
      return [
        playerTitle(p),
        p.chatsInitiated,
        p.chatsParticipated,
        p.chatMessagesSent,
        p.tradesProposed,
        p.tradesReceived,
        p.tradesAccepted,
        p.tradesCountered,
        p.tradesRejected,
        p.tradesActive,
      ];
    })
  ));
  lines.push('');
  const t = metrics.totals || {};
  lines.push(`Chat sessions: ${t.chatSessions ?? 0}; chat messages: ${t.chatMessages ?? 0}; trade proposals: ${t.tradesProposed ?? 0}; accepted: ${t.tradesAccepted ?? 0}; active agreements at end: ${t.tradesActive ?? 0}.`);
  lines.push('');

  lines.push('## Barbarians');
  lines.push('');
  const b = t.barbarians || {};
  lines.push(table(['Metric', 'Value'], [
    ['Spawned', b.spawned ?? 0],
    ['Encounters (first target decision)', b.encounters ?? 0],
    ['Targeted', b.targeted ?? 0],
    ['Ignored', b.ignored ?? 0],
    ['Attacks', b.attacks ?? 0],
    ['Combat engagements', b.engagements ?? 0],
    ['Attacks on player units', b.attacksOnPlayers ?? 0],
    ['Attacked by player units', b.attackedByPlayers ?? 0],
    ['Player units killed', b.playerUnitsKilled ?? 0],
    ['Barbarians killed', b.barbariansKilled ?? 0],
    ['Barbarians lost (all causes)', b.barbariansLost ?? 0],
    ['Died of old age', b.diedOfOldAge ?? 0],
  ]));
  lines.push('');
  lines.push('### By player');
  lines.push('');
  lines.push(table(
    ['Player', 'Barbarian engagements', 'Attacks received', 'Barbarians killed', 'Units lost to barbarians'],
    ids.map(id => {
      const p = players[id];
      return [
        playerTitle(p),
        p.barbarianEngagements || 0,
        p.barbarianAttacksReceived || 0,
        p.barbarianKills || 0,
        p.unitsLostToBarbarians || 0,
      ];
    })
  ));
  lines.push('');

  for (const id of ids) {
    const p = players[id];
    lines.push(`## ${playerTitle(p)} — score over time`);
    lines.push('');
    lines.push(table(
      ['Round', 'Military', 'Economic', 'Exploration', 'Total', 'Resources'],
      (metrics.timeline || [])
        .filter(entry => entry.players?.[id])
        .map(entry => {
          const snapshot = entry.players[id];
          return [
            entry.round,
            fmt(snapshot.score?.military, 1),
            fmt(snapshot.score?.economic, 1),
            fmt(snapshot.score?.exploration, 1),
            fmt(snapshot.score?.total, 1),
            Object.entries(snapshot.resources || {}).map(([r, v]) => `${r} ${fmt(v)}`).join(', ') || '—',
          ];
        })
    ));
    lines.push('');

    lines.push(`## ${playerTitle(p)} — resources per round`);
    lines.push('');
    // Resource flows live in the timeline (one snapshot per round), so they
    // are not duplicated on each player in the raw metrics JSON.
    const resourceTimeline = (metrics.timeline || [])
      .filter(entry => entry.players?.[id])
      .map(entry => ({
        round: entry.round,
        produced: entry.players[id].produced || {},
        consumed: entry.players[id].consumed || {},
      }));
    lines.push(table(
      ['Round', 'Produced', 'Consumed', 'Net', 'Breakdown (produced / consumed)'],
      resourceTimeline.map(({ round, produced, consumed }) => {
        const producedTotal = sum(Object.values(produced));
        const consumedTotal = sum(Object.values(consumed));
        const breakdown = [
          ...Object.entries(produced).map(([r, v]) => `+${fmt(v)} ${r}`),
          ...Object.entries(consumed).map(([r, v]) => `-${fmt(v)} ${r}`),
        ].join(', ');
        return [round, fmt(producedTotal, 1), fmt(consumedTotal, 1), fmt(producedTotal - consumedTotal, 1), breakdown || '—'];
      })
    ));
    lines.push('');

    lines.push(`## ${playerTitle(p)} — resource totals`);
    lines.push('');
    const ownResources = [...new Set([
      ...Object.keys(p.resourcesProduced || {}),
      ...Object.keys(p.resourcesConsumed || {}),
      ...Object.keys(p.resources || {}),
    ])].sort();
    lines.push(table(
      ['Resource', 'Produced', 'Consumed', 'Net', 'Final stock'],
      ownResources.map(resource => {
        const produced = p.resourcesProduced?.[resource] || 0;
        const consumed = p.resourcesConsumed?.[resource] || 0;
        return [resource, fmt(produced, 1), fmt(consumed, 1), fmt(produced - consumed, 1), fmt(p.resources?.[resource] || 0, 1)];
      })
    ));
    lines.push('');
  }

  if (metrics.proxyProfile) {
    const p = metrics.proxyProfile;
    lines.push('## Proxy profile');
    lines.push('');
    lines.push(table(['Counter', 'Value'], [
      ['Duration', `${fmt(p.durationMs / 1000, 2)} s`],
      ['wrapFunction calls', p.wrapFunctionCalls],
      ['wrapFunction cache hits', p.wrapFunctionCacheHits ?? '—'],
      ['function wrapper creations', p.functionWrapperCreations ?? '—'],
      ['function proxy applies', p.functionProxyApplies],
      ['deepWrap calls', p.deepWrapCalls],
      ['deepWrap cache hits', p.deepWrapCacheHits],
      ['entity filter calls', p.entitiesFilterCalls],
      ['entity filter cache hits', p.entitiesFilterCacheHits ?? '—'],
      ['entities raw total', p.entitiesRawTotal],
      ['entities filtered total', p.entitiesFilteredTotal],
      ['getCellsArray calls', p.getCellsArrayCalls],
      ['getCellsArray cache hits', p.getCellsArrayCacheHits ?? '—'],
      ['getCellsArray cells total', p.getCellsArrayTotal],
      ['getNeighbors calls', p.getNeighborsCalls],
      ['getNeighbors cache hits', p.getNeighborsCacheHits ?? '—'],
      ['fog checks', p.fogChecks],
      ['arg arrays', p.argArrays],
      ['args total', p.argsTotal],
      ['helper calls', p.helperCalls],
      ['helper arg arrays', p.helperArgArrays],
    ]));
    lines.push('');
    lines.push('### deepWrap by kind');
    lines.push('');
    lines.push(table(
      ['Kind', 'Count'],
      Object.entries(p.deepWrapKinds || {}).map(([kind, count]) => [kind, count])
    ));
    lines.push('');
    if (Array.isArray(p.methodAccess) && p.methodAccess.length > 0) {
      lines.push('### Proxy method accesses');
      lines.push('');
      lines.push(table(['Method', 'Count'], p.methodAccess.map(item => [item.name, item.count])));
      lines.push('');
    }
  }

  lines.push('## Captured logs');
  lines.push('');
  const matches = metrics.logs?.matches || [];
  lines.push(`${matches.length} matched line(s)${metrics.logs?.truncated ? ' (truncated)' : ''}. Patterns: ${(metrics.logs?.patterns || []).map(code).join(', ') || '(none)'}`);
  lines.push('');
  if (matches.length) {
    lines.push(table(
      ['Round', 'Level', 'Pattern', 'Message'],
      matches.slice(0, 300).map(match => [match.round, match.level, code(match.pattern), code(match.text)])
    ));
    if (matches.length > 300) {
      lines.push('');
      lines.push(`Only the first 300 matches are shown here; see the logs file for all ${matches.length}.`);
    }
  } else {
    lines.push('No log lines matched.');
  }
  lines.push('');

  return lines.join('\n');
}

export function renderLogReport({ game, runs }) {
  const lines = [];
  lines.push(`# ${game.id} — captured logs`);
  lines.push('');
  const total = runs.reduce((count, run) => count + (run.metrics?.logs?.matches?.length || 0), 0);
  lines.push(`Total matched lines: ${total}`);
  lines.push('');
  for (const run of runs) {
    const matches = run.metrics?.logs?.matches || [];
    lines.push(`## Iteration ${run.iteration}${run.seed !== null && run.seed !== undefined ? ` (seed ${run.seed})` : ''}`);
    lines.push('');
    if (!matches.length) {
      lines.push('No matches.');
      lines.push('');
      continue;
    }
    lines.push(table(
      ['Round', 'Level', 'Pattern', 'Message'],
      matches.map(match => [match.round, match.level, code(match.pattern), code(match.text)])
    ));
    lines.push('');
  }
  return lines.join('\n');
}
