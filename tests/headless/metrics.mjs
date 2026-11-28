/**
 * Headless game metrics collector.
 *
 * The suite runner (`tournament.mjs`) drives one game per child process via
 * `headless.mjs`. This module instruments the real engine from the outside —
 * no test-only hooks in `src/`:
 *
 *  - wraps `Player.addResources` / `consumeResources` / `refillOrders` to
 *    account gross resource production and consumption per round;
 *  - wraps `Entity.receiveDamage` / `destroy` to credit kills and losses;
 *  - wraps `AiHelper.chat` / `initiateTrade` to count diplomacy and trades;
 *  - intercepts `console.*` to capture arbitrary regex-matched log lines and
 *    to derive structured barbarian encounter stats.
 *
 * Attach it after the game is initialized (or resumed) and drive rounds with
 * `beginRound()` / `endRound()`. `finalize()` returns a plain JSON object.
 */
import { format } from 'node:util';
import Entity from '../../src/entity.js';
import { AiHelper } from '../../src/aiHelper.js';

const liveCollectors = new Set();
let instrumentationInstalled = false;

function copyMap(map) {
  return map ? { ...map } : {};
}

function addToMap(target, key, amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value === 0) return;
  target[key] = (target[key] || 0) + value;
}

function sumMap(map) {
  return Object.values(map || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function countBy(items, keyFn) {
  const out = {};
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key) continue;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function maxMapDelta(before, after) {
  const out = {};
  for (const [key, value] of Object.entries(after || {})) {
    const delta = (Number(value) || 0) - (Number(before?.[key]) || 0);
    if (delta > 0) out[key] = delta;
  }
  return out;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePatterns(input) {
  const list = Array.isArray(input) ? input : (input ? [input] : []);
  return list.map((entry, index) => {
    if (typeof entry === 'string') {
      return { label: entry, regex: new RegExp(entry) };
    }
    if (entry && typeof entry === 'object' && typeof entry.pattern === 'string') {
      const source = entry.literal ? escapeRegExp(entry.pattern) : entry.pattern;
      return {
        label: entry.label || entry.pattern,
        regex: new RegExp(source, entry.flags || ''),
      };
    }
    throw new Error(`Invalid log pattern at index ${index}: expected a regex string or {pattern, flags, literal}`);
  });
}

function normalizePlayerMeta(meta) {
  if (!meta) return {};
  if (Array.isArray(meta)) {
    return Object.fromEntries(meta.map(p => [String(p.id), p]));
  }
  return Object.fromEntries(Object.entries(meta).map(([id, p]) => [String(id), p]));
}

function dispatch(fn) {
  for (const collector of liveCollectors) {
    if (!collector.attached) continue;
    try {
      fn(collector);
    } catch (err) {
      collector._errors.push(String(err?.stack || err));
    }
  }
}

/**
 * Install engine instrumentation once per process. Multiple collectors are
 * supported, but a headless run normally uses exactly one.
 */
export function installMetricsInstrumentation() {
  if (instrumentationInstalled) return;
  instrumentationInstalled = true;

  const originalReceiveDamage = Entity.prototype.receiveDamage;
  Entity.prototype.receiveDamage = function receiveDamage(damage, attacker) {
    const beforeHealth = this.health;
    const result = originalReceiveDamage.call(this, damage, attacker);
    dispatch(collector => collector._onDamage(this, attacker, result, beforeHealth));
    return result;
  };

  const originalDestroy = Entity.prototype.destroy;
  Entity.prototype.destroy = function destroy(...args) {
    const wasDestroyed = this.destroyed;
    const result = originalDestroy.apply(this, args);
    if (!wasDestroyed) dispatch(collector => collector._onDestroy(this));
    return result;
  };

  const originalChat = AiHelper.prototype.chat;
  AiHelper.prototype.chat = async function chat(initiator, receiver, ...args) {
    const result = await originalChat.call(this, initiator, receiver, ...args);
    dispatch(collector => collector._onChat(initiator, receiver, result));
    return result;
  };

  const originalInitiateTrade = AiHelper.prototype.initiateTrade;
  AiHelper.prototype.initiateTrade = async function initiateTrade(initiator, receiver, offer, ...args) {
    const result = await originalInitiateTrade.call(this, initiator, receiver, offer, ...args);
    dispatch(collector => collector._onTrade(initiator, receiver, offer, result));
    return result;
  };
}

export class GameMetricsCollector {
  /**
   * @param {Object} [options]
   * @param {Array<string|{pattern:string,flags?:string,label?:string}>} [options.logPatterns]
   * @param {Object|Array} [options.players] - per-player metadata keyed/id'd
   * @param {Object} [options.runMeta] - suite label, iteration, config path, ...
   * @param {number} [options.maxLogMatches=5000]
   */
  constructor(options = {}) {
    installMetricsInstrumentation();
    this.runMeta = options.runMeta || {};
    this.playerMeta = normalizePlayerMeta(options.players);
    this.logPatterns = normalizePatterns(options.logPatterns);
    this.maxLogMatches = options.maxLogMatches ?? 5000;
    this.logMatches = [];
    this.logCounts = Object.fromEntries(this.logPatterns.map(p => [p.label, 0]));
    this.logTruncated = false;
    this.logLinesSeen = 0;
    this.totalLogMatches = 0;

    this.gameState = null;
    this.attached = false;
    this.finalized = false;
    this.playerMap = new Map();
    this._errors = [];

    this.startedAt = new Date().toISOString();
    this.startedMs = Date.now();
    this.currentRound = 1;
    this._roundStartUnowned = {};
    this.timeline = [];
    this._timelineRounds = new Map();
    this.lastRecordedRound = null;
    // One entry per player-turn: engine+AI wall time and the AI manager's
    // own processTurn() time (plus strategic, when configured).
    this.turnTimings = [];

    this.totals = {
      chatSessions: 0,
      chatMessages: 0,
      tradesProposed: 0,
      tradesAccepted: 0,
      tradesCountered: 0,
      tradesRejected: 0,
      tradesInvalid: 0,
      tradesFailed: 0,
      tradesActive: 0,
      tradesCreated: 0,
    };

    this._barb = {
      encounters: 0,
      targeted: 0,
      ignored: 0,
      attacks: 0,
      hordesSpawned: 0,
      spawned: 0,
      diedOfOldAge: 0,
      engagements: 0,
      attacksOnPlayers: 0,
      attackedByPlayers: 0,
      playerUnitsKilled: 0,
      playerUnitsKilledByType: {},
      barbariansKilled: 0,
      barbariansKilledByType: {},
      barbariansLost: 0,
    };

    this._installLogCapture();
    liveCollectors.add(this);
  }

  // ------------------------------------------------------------------
  // Log capture
  // ------------------------------------------------------------------

  _installLogCapture() {
    const levels = ['log', 'info', 'warn', 'error', 'debug'];
    this._originalConsole = {};
    for (const level of levels) {
      this._originalConsole[level] = console[level].bind(console);
      console[level] = (...args) => {
        let text;
        try {
          text = format(...args);
        } catch {
          text = args.map(arg => String(arg)).join(' ');
        }
        this._captureLog(level, text);
        return this._originalConsole[level](...args);
      };
    }
  }

  _captureLog(level, text) {
    this.logLinesSeen++;
    this._scanBarbarianLog(text);

    if (this.logPatterns.length === 0) return;
    for (const pattern of this.logPatterns) {
      pattern.regex.lastIndex = 0;
      if (!pattern.regex.test(text)) continue;
      this.logCounts[pattern.label] = (this.logCounts[pattern.label] || 0) + 1;
      this.totalLogMatches++;
      if (this.logMatches.length < this.maxLogMatches) {
        this.logMatches.push({
          round: this.currentRound,
          level,
          pattern: pattern.label,
          text,
        });
      } else {
        this.logTruncated = true;
      }
    }
  }

  _scanBarbarianLog(text) {
    if (!text.includes('[Barbarians]')) return;
    const b = this._barb;
    const encounter = /\[Barbarians\][^\n]*\bencounters\b[^\n]*->\s*(target|ignore)/i.exec(text);
    if (encounter) {
      b.encounters++;
      if (encounter[1].toLowerCase() === 'target') b.targeted++;
      else b.ignored++;
    }
    if (/\[Barbarians\][^\n]*\battacking\b/i.test(text)) b.attacks++;
    if (/\[Barbarians\][^\n]*Spawning horde/i.test(text)) b.hordesSpawned++;
    if (/\[Barbarians\][^\n]*\bSpawned\s+/i.test(text)) b.spawned++;
    if (/\[Barbarians\][^\n]*died of old age/i.test(text)) b.diedOfOldAge++;
  }

  // ------------------------------------------------------------------
  // Attach / player setup
  // ------------------------------------------------------------------

  attach(gameState, playerMeta = null) {
    if (!gameState) throw new Error('GameMetricsCollector.attach requires a GameState');
    this.gameState = gameState;
    if (playerMeta) this.playerMeta = normalizePlayerMeta(playerMeta);
    this.currentRound = gameState.currentRound || 1;

    this.playerMap.clear();
    for (const player of gameState.players || []) {
      const id = String(player.id);
      const meta = this.playerMeta[id] || this.playerMeta[player.id] || {};
      const pm = {
        id,
        name: player.name,
        controller: meta.controller || meta.controllerLabel || null,
        controllerLabel: meta.controllerLabel || meta.controller || 'human',
        model: meta.model || null,
        leader: meta.leader || null,
        color: player.color || null,
        score: { ...(player.score || {}) },
        resources: { ...(player.resources || {}) },
        resourcesProduced: {},
        resourcesConsumed: {},
        producedByRound: {},
        consumedByRound: {},
        entities: {},
        entityCount: 0,
        peakEntityCount: 0,
        entitiesBuilt: 0,
        entitiesBuiltByType: {},
        entitiesLost: 0,
        entitiesLostByType: {},
        entitiesKilled: 0,
        entitiesKilledByType: {},
        damageDealt: 0,
        damageTaken: 0,
        barbarianEngagements: 0,
        barbarianAttacksReceived: 0,
        barbarianKills: 0,
        unitsLostToBarbarians: 0,
        chatsInitiated: 0,
        chatsParticipated: 0,
        chatMessagesSent: 0,
        tradesProposed: 0,
        tradesReceived: 0,
        tradesAccepted: 0,
        tradesCountered: 0,
        tradesRejected: 0,
        tradesInvalid: 0,
        tradesFailed: 0,
        tradesActive: 0,
        killsByRound: {},
        lossesByRound: {},
      };
      this.playerMap.set(id, pm);
      this._wrapPlayer(player, pm);

      const entities = player.getEntities ? player.getEntities() : [];
      pm.entities = countBy(entities, e => e.name);
      pm.entityCount = entities.length;
      pm.peakEntityCount = entities.length;
      // Spawn history already contains the starting units at this point.
      pm._spawnHistoryBaseline = (player.getHistory ? player.getHistory() : [])
        .filter(entry => entry.category === 'spawn').length;
    }

    this.attached = true;
    this._roundStartUnowned = countBy(
      (gameState.entities || []).filter(e => !e.owner),
      e => e.name
    );
  }

  _wrapPlayer(player, pm) {
    const originalAdd = player.addResources.bind(player);
    player.addResources = (amountMap) => {
      const result = originalAdd(amountMap);
      this._recordFlow(pm, 'produced', amountMap);
      return result;
    };

    const originalConsume = player.consumeResources.bind(player);
    player.consumeResources = (costMap) => {
      const ok = originalConsume(costMap);
      if (ok) this._recordFlow(pm, 'consumed', costMap);
      return ok;
    };

    // refillOrders() assigns the overflow conversion directly instead of
    // calling addResources(), so snapshot the stock before/after to account
    // for it. A future refill that uses addResources() would be double
    // counted; keep the direct-assignment note in player.js in sync.
    const originalRefill = player.refillOrders.bind(player);
    player.refillOrders = () => {
      const before = { ...(player.resources || {}) };
      const result = originalRefill();
      const after = { ...(player.resources || {}) };
      const produced = maxMapDelta(before, after);
      if (Object.keys(produced).length > 0) this._recordFlow(pm, 'produced', produced);
      return result;
    };
  }

  _recordFlow(pm, kind, bundle) {
    if (!bundle) return;
    const round = String(this.currentRound);
    if (!pm[`${kind}ByRound`][round]) pm[`${kind}ByRound`][round] = {};
    for (const [resource, amount] of Object.entries(bundle)) {
      const value = Number(amount);
      if (!Number.isFinite(value) || value === 0) continue;
      addToMap(pm[`resources${kind === 'produced' ? 'Produced' : 'Consumed'}`], resource, value);
      addToMap(pm[`${kind}ByRound`][round], resource, value);
    }
  }

  // ------------------------------------------------------------------
  // Round snapshots
  // ------------------------------------------------------------------

  beginRound(round) {
    this.currentRound = round ?? this.gameState?.currentRound ?? this.currentRound;
    this._roundStartUnowned = countBy(
      (this.gameState?.entities || []).filter(e => !e.owner),
      e => e.name
    );
  }

  /**
   * Record one player-turn's timing.
   * @param {Object} player
   * @param {{round:number, stepMs:number, aiMs?:number, strategicMs?:number}} timing
   */
  recordTurnTiming(player, { round, stepMs, aiMs = 0, strategicMs = 0 }) {
    const pm = this._pmForPlayer(player);
    if (!pm) return;
    const safe = (value) => Math.max(0, Number(value) || 0);
    const step = safe(stepMs);
    const ai = safe(aiMs);
    const strategic = safe(strategicMs);
    this.turnTimings.push({
      round: round ?? this.currentRound,
      playerId: pm.id,
      name: pm.name,
      stepMs: step,
      aiMs: ai,
      strategicMs: strategic,
      engineMs: Math.max(0, step - ai - strategic),
    });
  }

  endRound(round = null) {
    if (!this.gameState) return null;
    const roundNumber = round ?? this.gameState.currentRound;
    const entry = {
      round: roundNumber,
      timestamp: new Date().toISOString(),
      players: {},
      unowned: {},
      barbariansSpawned: {},
    };

    for (const player of this.gameState.players || []) {
      const id = String(player.id);
      const pm = this.playerMap.get(id);
      if (!pm) continue;
      const entities = player.getEntities ? player.getEntities() : [];
      const byType = countBy(entities, e => e.name);
      pm.entities = byType;
      pm.entityCount = entities.length;
      pm.peakEntityCount = Math.max(pm.peakEntityCount || 0, entities.length);
      pm.score = { ...(player.score || {}) };
      pm.resources = { ...(player.resources || {}) };
      entry.players[id] = {
        name: player.name,
        controllerLabel: pm.controllerLabel,
        model: pm.model,
        score: { ...(player.score || {}) },
        resources: { ...(player.resources || {}) },
        entityCount: entities.length,
        entitiesByType: byType,
        produced: copyMap(pm.producedByRound[String(roundNumber)]),
        consumed: copyMap(pm.consumedByRound[String(roundNumber)]),
      };
    }

    const unowned = (this.gameState.entities || []).filter(e => !e.owner);
    entry.unowned = countBy(unowned, e => e.name);
    entry.barbariansSpawned = maxMapDelta(this._roundStartUnowned, entry.unowned);

    // Replacing a partial snapshot for the same round (e.g. a win before the
    // round-end hook) keeps the timeline and totals consistent.
    const existingIndex = this._timelineRounds.get(roundNumber);
    if (existingIndex !== undefined) {
      this.timeline[existingIndex] = entry;
    } else {
      this._timelineRounds.set(roundNumber, this.timeline.length);
      this.timeline.push(entry);
    }
    this.lastRecordedRound = roundNumber;
    return entry;
  }

  // ------------------------------------------------------------------
  // Engine event callbacks
  // ------------------------------------------------------------------

  _pmForPlayer(player) {
    if (!player || player.id === undefined || player.id === null) return null;
    return this.playerMap.get(String(player.id)) || null;
  }

  _onDamage(defender, attacker, result, beforeHealth) {
    if (!this.gameState || !defender || defender.gameState !== this.gameState) return;
    const defenderPm = this._pmForPlayer(defender.owner);
    const attackerPm = this._pmForPlayer(attacker?.owner);
    const damage = Math.max(0, (Number(beforeHealth) || 0) - (Number(defender.health) || 0));

    if (attackerPm) attackerPm.damageDealt += damage;
    if (defenderPm) defenderPm.damageTaken += damage;

    const b = this._barb;
    const attackerIsBarbarian = !attacker?.owner;
    const defenderIsBarbarian = !defender.owner;
    if (attackerIsBarbarian || defenderIsBarbarian) {
      b.engagements++;
      if (defenderPm) defenderPm.barbarianEngagements++;
      if (attackerPm) attackerPm.barbarianEngagements++;
      if (attackerIsBarbarian && !defenderIsBarbarian) {
        b.attacksOnPlayers++;
        if (defenderPm) defenderPm.barbarianAttacksReceived++;
      }
      if (!attackerIsBarbarian && defenderIsBarbarian) {
        b.attackedByPlayers++;
      }
    }

    if (!result?.destroyed) return;
    if (attackerPm) {
      attackerPm.entitiesKilled++;
      addToMap(attackerPm.entitiesKilledByType, defender.name, 1);
      addToMap(attackerPm.killsByRound, String(this.currentRound), 1);
      if (defenderIsBarbarian) attackerPm.barbarianKills++;
    }
    if (defenderIsBarbarian) {
      b.barbariansKilled++;
      addToMap(b.barbariansKilledByType, defender.name, 1);
    }
    if (attackerIsBarbarian && defenderPm) {
      b.playerUnitsKilled++;
      addToMap(b.playerUnitsKilledByType, defender.name, 1);
      defenderPm.unitsLostToBarbarians++;
    }
  }

  _onDestroy(entity) {
    if (!this.gameState || !entity || entity.gameState !== this.gameState) return;
    if (entity.owner) {
      const pm = this._pmForPlayer(entity.owner);
      if (!pm) return;
      pm.entitiesLost++;
      addToMap(pm.entitiesLostByType, entity.name, 1);
      addToMap(pm.lossesByRound, String(this.currentRound), 1);
    } else {
      this._barb.barbariansLost++;
    }
  }

  _onChat(initiator, receiver, result) {
    if (!this.gameState || !result) return;
    const initiatorPm = this._pmForPlayer(initiator);
    const receiverPm = this._pmForPlayer(receiver);
    if (!initiatorPm || !receiverPm) return;
    initiatorPm.chatsInitiated++;
    initiatorPm.chatsParticipated++;
    receiverPm.chatsParticipated++;
    this.totals.chatSessions++;
  }

  _onTrade(initiator, receiver, offer, result) {
    if (!this.gameState) return;
    const proposerPm = this._pmForPlayer(initiator);
    const receiverPm = this._pmForPlayer(receiver);
    if (!proposerPm && !receiverPm) return;
    const status = result?.status || 'failed';
    if (proposerPm) {
      proposerPm.tradesProposed++;
      const key = {
        accepted: 'tradesAccepted',
        countered: 'tradesCountered',
        rejected: 'tradesRejected',
        invalid: 'tradesInvalid',
        failed: 'tradesFailed',
      }[status];
      if (key) proposerPm[key]++;
    }
    if (receiverPm) receiverPm.tradesReceived++;
    this.totals.tradesProposed++;
    const totalKey = {
      accepted: 'tradesAccepted',
      countered: 'tradesCountered',
      rejected: 'tradesRejected',
      invalid: 'tradesInvalid',
      failed: 'tradesFailed',
    }[status];
    if (totalKey) this.totals[totalKey]++;
    this._tradeTypes = this._tradeTypes || {};
    addToMap(this._tradeTypes, offer?.type || 'unknown', 1);
  }

  // ------------------------------------------------------------------
  // Finalize
  // ------------------------------------------------------------------

  finalize(context = {}) {
    if (!this.gameState) throw new Error('GameMetricsCollector.finalize called before attach');
    if (this.finalized) return this.result;
    this.finalized = true;

    const gs = this.gameState;
    const leader = [...(gs.players || [])].sort((a, b) => (b.score?.total || 0) - (a.score?.total || 0))[0] || null;

    // Chat history is the authoritative record of messages (it also contains
    // trade-proposal/system lines); attribute each message to its sender.
    this.totals.chatMessages = 0;
    for (const messages of Object.values(gs.chatHistory || {})) {
      for (const message of messages || []) {
        this.totals.chatMessages++;
        const senderId = message.senderId !== undefined && message.senderId !== null
          ? String(message.senderId)
          : null;
        let pm = senderId ? this.playerMap.get(senderId) : null;
        if (!pm && message.sender) {
          pm = [...this.playerMap.values()].find(p => p.name === message.sender) || null;
        }
        if (pm) pm.chatMessagesSent++;
      }
    }

    const activeTrades = (gs.trades || []).filter(t => t.active);
    this.totals.tradesActive = activeTrades.length;
    this.totals.tradesCreated = (gs.trades || []).length;
    for (const trade of activeTrades) {
      for (const id of [trade.player1Id, trade.player2Id]) {
        const pm = this.playerMap.get(String(id));
        if (pm) pm.tradesActive++;
      }
    }

    // Spawn history minus the baseline captured at attach gives entities
    // built during the run (starting units are in the baseline).
    for (const player of gs.players || []) {
      const pm = this.playerMap.get(String(player.id));
      if (!pm) continue;
      const spawns = (player.getHistory ? player.getHistory() : [])
        .filter(entry => entry.category === 'spawn');
      pm.entitiesBuilt = Math.max(0, spawns.length - (pm._spawnHistoryBaseline || 0));
      pm.entitiesBuiltByType = countBy(
        spawns.slice(0, Math.max(0, spawns.length - (pm._spawnHistoryBaseline || 0))),
        entry => entry.entityName || entry.extra?.entityName || 'unknown'
      );
      delete pm._spawnHistoryBaseline;
    }

    // Final entity snapshot.
    for (const player of gs.players || []) {
      const pm = this.playerMap.get(String(player.id));
      if (!pm) continue;
      const entities = player.getEntities ? player.getEntities() : [];
      pm.entities = countBy(entities, e => e.name);
      pm.entityCount = entities.length;
      pm.peakEntityCount = Math.max(pm.peakEntityCount || 0, entities.length);
      pm.score = { ...(player.score || {}) };
      pm.resources = { ...(player.resources || {}) };
      pm.finalScore = { ...(player.score || {}) };
    }

    // Barbarian spawns are derived from the round timeline (current - start
    // of each round), so partial snapshots do not double count.
    const barbariansSpawnedByType = {};
    for (const entry of this.timeline) {
      for (const [type, count] of Object.entries(entry.barbariansSpawned || {})) {
        addToMap(barbariansSpawnedByType, type, count);
      }
    }
    const barbarians = {
      ...this._barb,
      spawned: sumMap(barbariansSpawnedByType),
      spawnedByType: barbariansSpawnedByType,
      combats: this._barb.engagements,
    };

    const players = [...this.playerMap.values()].map(pm => {
      const timings = this.turnTimings.filter(t => t.playerId === pm.id);
      const stepMsTotal = timings.reduce((sum, t) => sum + t.stepMs, 0);
      const aiMsTotal = timings.reduce((sum, t) => sum + t.aiMs, 0);
      const strategicMsTotal = timings.reduce((sum, t) => sum + t.strategicMs, 0);
      const engineMsTotal = timings.reduce((sum, t) => sum + t.engineMs, 0);
      const turns = timings.length;
      return {
      id: pm.id,
      name: pm.name,
      controller: pm.controller,
      controllerLabel: pm.controllerLabel,
      model: pm.model,
      leader: pm.leader,
      color: pm.color,
      finalScore: pm.finalScore || pm.score || {},
      score: pm.score || {},
      resources: pm.resources || {},
      resourcesProduced: pm.resourcesProduced || {},
      resourcesConsumed: pm.resourcesConsumed || {},
      entities: pm.entities || {},
      entityCount: pm.entityCount || 0,
      peakEntityCount: pm.peakEntityCount || 0,
      entitiesBuilt: pm.entitiesBuilt || 0,
      entitiesBuiltByType: pm.entitiesBuiltByType || {},
      entitiesLost: pm.entitiesLost || 0,
      entitiesLostByType: pm.entitiesLostByType || {},
      entitiesKilled: pm.entitiesKilled || 0,
      entitiesKilledByType: pm.entitiesKilledByType || {},
      killsByRound: pm.killsByRound || {},
      lossesByRound: pm.lossesByRound || {},
      damageDealt: pm.damageDealt || 0,
      damageTaken: pm.damageTaken || 0,
      barbarianEngagements: pm.barbarianEngagements || 0,
      barbarianAttacksReceived: pm.barbarianAttacksReceived || 0,
      barbarianKills: pm.barbarianKills || 0,
      unitsLostToBarbarians: pm.unitsLostToBarbarians || 0,
      chatsInitiated: pm.chatsInitiated || 0,
      chatsParticipated: pm.chatsParticipated || 0,
      chatMessagesSent: pm.chatMessagesSent || 0,
      tradesProposed: pm.tradesProposed || 0,
      tradesReceived: pm.tradesReceived || 0,
      tradesAccepted: pm.tradesAccepted || 0,
      tradesCountered: pm.tradesCountered || 0,
      tradesRejected: pm.tradesRejected || 0,
      tradesInvalid: pm.tradesInvalid || 0,
      tradesFailed: pm.tradesFailed || 0,
      tradesActive: pm.tradesActive || 0,
      timing: {
        turns,
        stepMsTotal,
        aiMsTotal,
        strategicMsTotal,
        engineMsTotal,
        stepAvgMs: turns ? stepMsTotal / turns : 0,
        aiAvgMs: turns ? aiMsTotal / turns : 0,
        strategicAvgMs: turns ? strategicMsTotal / turns : 0,
        engineAvgMs: turns ? engineMsTotal / turns : 0,
        stepMaxMs: timings.length ? Math.max(...timings.map(t => t.stepMs)) : 0,
        aiMaxMs: timings.length ? Math.max(...timings.map(t => t.aiMs)) : 0,
      },
      };
    });

    const winner = context.winner
      ? {
        id: String(context.winner.id),
        name: context.winner.name,
        score: { ...(context.winner.score || {}) },
        reasons: [...(context.winner.reasons || [])],
      }
      : null;

    this.result = {
      schemaVersion: 1,
      run: {
        label: this.runMeta.label || null,
        iteration: this.runMeta.iteration ?? null,
        configPath: this.runMeta.configPath || null,
        seed: this.runMeta.seed ?? null,
        turns: context.totalTurns ?? this.runMeta.turns ?? null,
        mapSize: this.runMeta.mapSize ?? null,
        definitionsDir: this.runMeta.definitionsDir ?? null,
        definitionsFiles: this.runMeta.definitionsFiles ?? null,
        resumed: !!context.resumed,
        startedAt: this.startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - this.startedMs,
      },
      outcome: {
        completedAllTurns: !!context.completedAllTurns,
        gameOver: !!context.gameOver,
        roundsPlayed: context.roundsPlayed ?? this.lastRecordedRound ?? 0,
        winner,
        leader: leader
          ? { id: String(leader.id), name: leader.name, score: { ...(leader.score || {}) } }
          : null,
        failures: context.failures || 0,
        failureMessages: [...(context.failureMessages || [])],
        metricsErrors: [...this._errors],
      },
      players,
      timeline: this.timeline,
      timings: this.turnTimings,
      proxyProfile: context.proxyProfile || null,
      totals: {
        ...this.totals,
        tradeTypes: this._tradeTypes || {},
        barbarians,
      },
      logs: {
        patterns: this.logPatterns.map(p => p.label),
        counts: { ...this.logCounts },
        totalMatches: this.totalLogMatches,
        linesSeen: this.logLinesSeen,
        truncated: this.logTruncated,
        matches: this.logMatches,
      },
    };

    return this.result;
  }

  dispose() {
    liveCollectors.delete(this);
    if (this._originalConsole) {
      for (const [level, original] of Object.entries(this._originalConsole)) {
        console[level] = original;
      }
    }
  }
}
