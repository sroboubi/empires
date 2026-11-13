import { HexGrid } from './hexGrid.js';
import { Player } from './player.js';
import { manageBarbarians } from './barbarians/manager.js';
import { AiHelper } from './aiHelper.js';
import { spawnCellResources, checkTreasurePickup } from './resources.js';
import { CONFIG } from './config.js';
import { createSeededRandom } from './random.js';
import Entity from './entity.js';

/**
 * Formats a resource bundle map (e.g. { iron: 50, gold: 10 }) to a human-readable string.
 * @param {Object} bundle
 * @returns {string}
 */
export function formatResourceBundle(bundle) {
  if (!bundle) return 'nothing';
  const parts = [];
  for (const [res, amt] of Object.entries(bundle)) {
    if (amt > 0) {
      parts.push(`${amt} ${res}`);
    }
  }
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}

/**
 * GameState tracks players, turn cycle, the hex grid, and active entity instances.
 * It is fully serializable to and from JSON.
 */
export class GameState {
  /**
   * @param {Object} [callbacks={}] - UI callbacks registered by main.js:
   *   onActionDone(involvedCells, actionDesc),
   *   onOpenChatModal(humanPlayer, aiPlayer),
   *   onCloseChatModal()
   */
  constructor(callbacks = {}) {
    this.players = [];
    this.activePlayerIndex = 0;
    this.currentRound = 1;
    // Counter for ownerless entity IDs (barbarians etc.):
    // <name>_neutral_<n>. Saved/loaded with the game.
    this.unownedEntityCounter = 0;
    // In-game randomness (barbarian hordes, treasure rewards, the overflow
    // resource pick). Math.random unless generateMap() got a seed, in which
    // case the whole game replays from that one seed.
    this.random = () => Math.random();
    this.hexGrid = null;  // HexGrid instance
    this.entities = [];   // List of active BaseEntity instances
    // Zone of Control map (Phase 24): cellKey "q,r" -> { controlledBy: [entityId], occupiedBy: [entityId] }.
    // NOT saved/loaded — recreating entities on load (via spawnEntity)
    // repopulates it. NOT exposed to AIs — the AI interface proxy blocks
    // this property (a readable map would hand an AI every enemy position).
    this.zoneControlMap = new Map();
    this.manifestData = null;
    this.settings = null;
    this.gameOver = false;
    this.chatHistory = {};
    this.trades = [];
    this.replayRecorder = null;
    this.fogPovPlayer = null; // Replay only: fog POV override (snapshot's active player); null = human-player union
    // Single shared AiHelper instance (used by barbarians, players, harnesses).
    this.aiHelper = new AiHelper(this);
    // UI callbacks (main.js implements these; aiHelper delegates via gameState).
    this.onActionDone = callbacks.onActionDone || null;
    this.onOpenChatModal = callbacks.onOpenChatModal || null;
    this.onCloseChatModal = callbacks.onCloseChatModal || null;
    // M5: called at the clean turn boundary (round-end done, next turn not
    // yet started) so the driver can autosave a complete state.
    this.onCleanBoundary = callbacks.onCleanBoundary || null;
  }

  /**
   * Helper to compute sorted pair key for chat history between two players.
   * Keyed by player ID (unique by construction) so two players who share a
   * display name still get separate histories. Accepts Player objects or raw
   * IDs. The message objects themselves keep the sender's name for display.
   * @param {Player|string|number} player1
   * @param {Player|string|number} player2
   * @returns {string}
   */
  getChatKey(player1, player2) {
    const id1 = (player1 && typeof player1 === 'object') ? player1.id : player1;
    const id2 = (player2 && typeof player2 === 'object') ? player2.id : player2;
    return [String(id1), String(id2)].sort().join(':');
  }

  /**
   * Returns chat history array between two players.
   * @param {Player|string} player1
   * @param {Player|string} player2
   * @returns {Array<Object>}
   */
  getChatHistory(player1, player2) {
    if (!this.chatHistory) this.chatHistory = {};
    const key = this.getChatKey(player1, player2);
    if (!this.chatHistory[key]) {
      this.chatHistory[key] = [];
    }
    return this.chatHistory[key];
  }

  /**
   * Appends a chat message to history between sender and receiver.
   * @param {Player|string} sender
   * @param {Player|string} receiver
   * @param {string} content
   * @returns {Object} Added message object
   */
  addChatMessage(sender, receiver, content) {
    if (!this.chatHistory) this.chatHistory = {};
    const senderName = typeof sender === 'string' ? sender : sender.name;
    // L6: store the sender's id too — the name alone can't identify the
    // speaker (a human who types a leader's name collides with that
    // leader). Old saves lack senderId; readers fall back to the name.
    const senderId = (sender && typeof sender === 'object') ? sender.id : null;
    const key = this.getChatKey(sender, receiver);
    if (!this.chatHistory[key]) {
      this.chatHistory[key] = [];
    }
    const message = {
      sender: senderName,
      senderId,
      content: content,
      round: this.currentRound,
      timestamp: new Date().toISOString()
    };
    this.chatHistory[key].push(message);
    return message;
  }

  /**
   * Finds a player by ID.
   * @param {string|number} id
   * @returns {Player|null}
   */
  getPlayerById(id) {
    if (!this.players) return null;
    return this.players.find(p => String(p.id) === String(id)) || null;
  }

  /**
   * Returns active trades involving a specific player.
   * @param {Player|string|number} player
   * @returns {Array<Object>}
   */
  getActiveTradesForPlayer(player) {
    if (!this.trades) return [];
    const playerId = (player && typeof player === 'object') ? player.id : player;
    return this.trades.filter(t => t.active && (String(t.player1Id) === String(playerId) || String(t.player2Id) === String(playerId)));
  }

  /**
   * Executes an immediate one-time trade between two players.
   * @param {Player} player1 - Initiator
   * @param {Player} player2 - Counterpart
   * @param {Object} bundle1 - Resources player1 gives to player2
   * @param {Object} bundle2 - Resources player2 gives to player1
   * @returns {{ success: boolean, reason?: string }}
   */
  executeOneTimeTrade(player1, player2, bundle1, bundle2) {
    if (!player1 || !player2) return { success: false, reason: 'Invalid players' };
    if (!player1.hasResources(bundle1)) {
      return { success: false, reason: `${player1.name} has insufficient resources` };
    }
    if (!player2.hasResources(bundle2)) {
      return { success: false, reason: `${player2.name} has insufficient resources` };
    }

    player1.consumeResources(bundle1);
    player1.addResources(bundle2);
    player2.consumeResources(bundle2);
    player2.addResources(bundle1);

    const desc1 = `Completed one-time trade with ${player2.name}: sent ${formatResourceBundle(bundle1)}, received ${formatResourceBundle(bundle2)}`;
    const desc2 = `Completed one-time trade with ${player1.name}: sent ${formatResourceBundle(bundle2)}, received ${formatResourceBundle(bundle1)}`;

    player1.addHistoryEntry(this.currentRound, {
      category: 'trade',
      details: desc1,
      extra: { partnerId: player2.id, sent: bundle1, received: bundle2, type: 'one_time' }
    });
    player2.addHistoryEntry(this.currentRound, {
      category: 'trade',
      details: desc2,
      extra: { partnerId: player1.id, sent: bundle2, received: bundle1, type: 'one_time' }
    });

    console.log(`[GameState] One-time trade executed: ${player1.name} <-> ${player2.name} (${desc1})`);
    return { success: true };
  }

  /**
   * Creates an ongoing per-turn trade agreement between two players.
   * @param {Player} player1
   * @param {Player} player2
   * @param {Object} bundle1 - Resources player1 sends per turn
   * @param {Object} bundle2 - Resources player2 sends per turn
   * @returns {Object}
   */
  createPerTurnTrade(player1, player2, bundle1, bundle2) {
    if (!this.trades) this.trades = [];
    const trade = {
      id: 'trade_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      type: 'per_turn',
      player1Id: player1.id,
      player2Id: player2.id,
      bundle1: { ...bundle1 },
      bundle2: { ...bundle2 },
      createdRound: this.currentRound,
      active: true
    };
    this.trades.push(trade);

    const desc1 = `Established per-turn trade agreement with ${player2.name}: sending ${formatResourceBundle(bundle1)}/turn, receiving ${formatResourceBundle(bundle2)}/turn`;
    const desc2 = `Established per-turn trade agreement with ${player1.name}: sending ${formatResourceBundle(bundle2)}/turn, receiving ${formatResourceBundle(bundle1)}/turn`;

    player1.addHistoryEntry(this.currentRound, {
      category: 'trade',
      details: desc1,
      extra: { tradeId: trade.id, partnerId: player2.id, sent: bundle1, received: bundle2, type: 'per_turn' }
    });
    player2.addHistoryEntry(this.currentRound, {
      category: 'trade',
      details: desc2,
      extra: { tradeId: trade.id, partnerId: player1.id, sent: bundle2, received: bundle1, type: 'per_turn' }
    });

    console.log(`[GameState] Per-turn trade established (ID: ${trade.id}): ${player1.name} sends ${formatResourceBundle(bundle1)}/turn, receives ${formatResourceBundle(bundle2)}/turn from ${player2.name}`);
    return trade;
  }

  /**
   * Cancels an ongoing trade agreement.
   * @param {string} tradeId
   * @param {Player|null} cancelingPlayer
   * @returns {boolean}
   */
  cancelTrade(tradeId, cancelingPlayer = null) {
    if (!this.trades) return false;
    const trade = this.trades.find(t => t.id === tradeId && t.active);
    if (!trade) return false;
    trade.active = false;

    const p1 = this.getPlayerById(trade.player1Id);
    const p2 = this.getPlayerById(trade.player2Id);
    const cancelerName = cancelingPlayer ? cancelingPlayer.name : 'A participant';

    if (p1) {
      p1.addHistoryEntry(this.currentRound, {
        category: 'trade',
        details: `Canceled per-turn trade agreement with ${p2 ? p2.name : 'partner'} (${cancelerName} canceled)`,
        extra: { tradeId, canceledBy: cancelingPlayer?.id }
      });
    }
    if (p2) {
      p2.addHistoryEntry(this.currentRound, {
        category: 'trade',
        details: `Canceled per-turn trade agreement with ${p1 ? p1.name : 'partner'} (${cancelerName} canceled)`,
        extra: { tradeId, canceledBy: cancelingPlayer?.id }
      });
    }

    console.log(`[GameState] Trade agreement ${tradeId} canceled by ${cancelerName}`);
    return true;
  }

  /**
   * Executes all active per-turn trades at round boundary.
   */
  executePerTurnTrades() {
    if (!this.trades || this.trades.length === 0) return;
    const activeTrades = this.trades.filter(t => t.active && t.type === 'per_turn');
    for (const trade of activeTrades) {
      const p1 = this.getPlayerById(trade.player1Id);
      const p2 = this.getPlayerById(trade.player2Id);
      if (!p1 || !p2) {
        trade.active = false;
        continue;
      }

      const p1Can = p1.hasResources(trade.bundle1);
      const p2Can = p2.hasResources(trade.bundle2);

      if (p1Can && p2Can) {
        p1.consumeResources(trade.bundle1);
        p1.addResources(trade.bundle2);
        p2.consumeResources(trade.bundle2);
        p2.addResources(trade.bundle1);

        const desc1 = `Executed trade agreement with ${p2.name}: sent ${formatResourceBundle(trade.bundle1)}, received ${formatResourceBundle(trade.bundle2)}`;
        const desc2 = `Executed trade agreement with ${p1.name}: sent ${formatResourceBundle(trade.bundle2)}, received ${formatResourceBundle(trade.bundle1)}`;

        p1.addHistoryEntry(this.currentRound, {
          category: 'trade',
          details: desc1,
          extra: { tradeId: trade.id, partnerId: p2.id, sent: trade.bundle1, received: trade.bundle2 }
        });
        p2.addHistoryEntry(this.currentRound, {
          category: 'trade',
          details: desc2,
          extra: { tradeId: trade.id, partnerId: p1.id, sent: trade.bundle2, received: trade.bundle1 }
        });

        console.log(`[GameState] Per-turn trade executed for round ${this.currentRound} (ID: ${trade.id}): ${p1.name} <-> ${p2.name}`);
      } else {
        const failureReason = !p1Can && !p2Can
          ? `both ${p1.name} and ${p2.name} lacked required stock`
          : (!p1Can ? `${p1.name} lacked required stock` : `${p2.name} lacked required stock`);

        const desc1 = `Trade agreement with ${p2.name} skipped for round ${this.currentRound}: ${failureReason}`;
        const desc2 = `Trade agreement with ${p1.name} skipped for round ${this.currentRound}: ${failureReason}`;

        p1.addHistoryEntry(this.currentRound, {
          category: 'trade',
          details: desc1,
          extra: { tradeId: trade.id, partnerId: p2.id, skipped: true, reason: failureReason }
        });
        p2.addHistoryEntry(this.currentRound, {
          category: 'trade',
          details: desc2,
          extra: { tradeId: trade.id, partnerId: p1.id, skipped: true, reason: failureReason }
        });

        console.log(`[GameState] Per-turn trade SKIPPED for round ${this.currentRound} (ID: ${trade.id}): ${failureReason}`);
      }
    }
  }

  /**
   * Returns the currently active Player instance.
   * @returns {Player|null}
   */
  get activePlayer() {
    if (!this.players || this.players.length === 0 || this.activePlayerIndex < 0) return null;
    return this.players[this.activePlayerIndex];
  }

  /**
   * Generates a hexagonal map of a given radius filled with terrain.
   * @param {number} radius - Grid radius (number of hex rings from the center)
   * @param {Array|Object} [terrainConfig=null] - Optional terrain definitions
   * @param {Object} [manifestData=null] - Optional manifest (spawns natural resources & treasures)
   * @param {number|string|null} [seed=null] - Map seed. The same seed, radius and
   *   manifest give the same terrain and resources. Without one the map is random
   *   (Math.random), as before. With a seed, the in-game randomness
   *   (this.random) is also seeded, from `${seed}:game`, so a headless game
   *   replays exactly; without one it stays Math.random.
   */
  generateMap(radius, terrainConfig = null, manifestData = null, seed = null) {
    const config = terrainConfig || this.manifestData?.terrains || null;
    const seeded = seed !== null && seed !== undefined;
    const random = seeded ? createSeededRandom(seed) : Math.random;
    this.random = seeded ? createSeededRandom(`${seed}:game`) : () => Math.random();
    this.hexGrid = new HexGrid(radius, config, random);
    if (manifestData) {
      spawnCellResources(this.hexGrid, manifestData, CONFIG.HEX_SIZE, random);
    }
    this.entities = [];
    this.zoneControlMap.clear();
    this.activePlayerIndex = 0;
    this.currentRound = 1;
    this.chatHistory = {};
    this.trades = [];

    // Default placeholder players if manifest not initialized yet
    this.players = [];
  }

  /**
   * Initializes player starting resources, instantiates players defined in settings/manifest,
   * and spawns starting units on valid terrain.
   * @param {Object} manifestData - Loaded game manifest metadata
   * @param {Object} [settings=null] - Loaded or configured game settings
   */
  initializeManifest(manifestData, settings = null) {
    if (!manifestData) return;
    this.manifestData = manifestData;
    this.settings = settings || {};

    // 1. Setup starting resources dynamically from settings or manifest initialization
    const init = settings?.initialization || manifestData.initialization || {};

    // Expose initialization settings on the game state so AI controllers can
    // reason about starting stock levels (resource deficit thresholds, etc.)
    this.initializationSettings = init;
    const startingResources = { ...(init.startingResources || {}) };
    const ordersConfig = init.orders || null;

    // 2. Instantiate players from settings or manifest definitions array
    const playersList = settings?.players || manifestData.players;
    if (playersList && Array.isArray(playersList) && playersList.length > 0) {
      this.players = playersList.map((pDef, idx) => new Player(
        pDef.id || (idx + 1),
        pDef.name,
        this,
        pDef.color,
        startingResources,
        pDef.description || '',
        pDef.controller,
        ordersConfig
      ));
    } else {
      this.players = [];
    }

    this.activePlayerIndex = 0;
    this.currentRound = 1;

    // 3. Determine starting coordinates based on grid radius and player count
    const radius = this.hexGrid.radius;
    const numPlayers = this.players.length;
    const targetRadius = Math.round(radius * 0.5);

    // 4. Spawn starting units for each player
    this.entities = [];
    this.zoneControlMap.clear();
    const startingUnits = init.startingUnits || {};
    const startingUnitNames = Object.keys(startingUnits);

    if (startingUnitNames.length > 0) {
      const occupiedCoords = new Set();

      this.players.forEach((player, playerIdx) => {
        const angle = (2 * Math.PI * playerIdx) / numPlayers - Math.PI / 2;
        // M5: generate the ring in pixel space and convert to axial — feeding
        // cos/sin straight into (q, r) distorted the ring (4p neighbours 6
        // apart instead of ~8.5, and uneven centre distances). Pixel radius
        // uses the centre-to-centre hex spacing (sqrt(3) * size).
        const px = targetRadius * Math.sqrt(3) * CONFIG.HEX_SIZE * Math.cos(angle);
        const pz = targetRadius * Math.sqrt(3) * CONFIG.HEX_SIZE * Math.sin(angle);
        const { q: targetQ, r: targetR } = HexGrid.pixelToAxial(px, pz);

        const getUnitCanSpawnOnFn = (unitName) => {
          const uMeta = manifestData.entities[unitName];
          const dummy = new Entity(uMeta, player, this, null, { id: '__probe__' });
          return dummy.canSpawnOn.bind(dummy);
        };

        const firstUnitName = startingUnitNames[0];
        const firstUnitCanSpawnOn = getUnitCanSpawnOnFn(firstUnitName);

        // Find the starting cell for this player using BFS
        const startCell = this.hexGrid.findStartingCell(targetQ, targetR, (terrain) => {
          return firstUnitCanSpawnOn(terrain);
        });

        if (!startCell) {
          console.warn(`No valid starting cell found for player ${player.name}`);
          return;
        }

        player.startCoord = { q: startCell.q, r: startCell.r };

        // Helper to find next nearest available cell searching outwards from startCoord
        const findNextAvailableCell = (canSpawnOnFn) => {
          const visited = new Set();
          const queue = [{ q: startCell.q, r: startCell.r }];
          visited.add(`${startCell.q},${startCell.r}`);

          while (queue.length > 0) {
            const current = queue.shift();
            const key = `${current.q},${current.r}`;
            const cell = this.hexGrid.getCell(current.q, current.r);

            if (cell && !occupiedCoords.has(key) && canSpawnOnFn(cell)) {
              return cell;
            }

            const neighbors = HexGrid.getNeighborCoords(current.q, current.r);
            for (const nb of neighbors) {
              const nbKey = `${nb.q},${nb.r}`;
              if (!visited.has(nbKey) && this.hexGrid.getCell(nb.q, nb.r)) {
                visited.add(nbKey);
                queue.push(nb);
              }
            }
          }
          return null;
        };

        for (const [unitName, quantity] of Object.entries(startingUnits)) {
          const unitCanSpawnOn = getUnitCanSpawnOnFn(unitName);
          for (let i = 0; i < quantity; i++) {
            const cell = findNextAvailableCell(unitCanSpawnOn);
            if (cell) {
              const key = `${cell.q},${cell.r}`;
              occupiedCoords.add(key);
              const spawned = this.spawnEntity(unitName, cell, player);
              // L6: a starting unit placed on a treasure collects it.
              if (spawned) checkTreasurePickup(spawned);
            } else {
              console.warn(`Could not find valid unoccupied cell to spawn ${unitName} for ${player.name}`);
            }
          }
        }
      });
    }

    // Setup starts NO turn: the driver owns the first turn (the browser
    // calls startTurn with its nextTurn continuation; headless drives
    // turns itself). The old code fired startTurn here, un-awaited, so
    // player 1's AI turn ran at setup AND again in the driver's round 1
    // — two concurrent processTurn calls on the same player, plus a
    // second orders refill whose overflow converted to free resources.
    // (Player.step runs the AI turn regardless of onTurnEnd, so passing
    // no continuation did NOT suppress the setup turn as the old comment
    // claimed.)
  }

  /**
   * Starts turn for the active player.
   * @param {Function} [onTurnEnd] - Continuation called when an AI
   *   player's turn settles; AI turns run only when it is provided.
   *   AI errors are already logged in Player.step() and swallowed here
   *   so they don't surface as unhandled rejections in the browser.
   */
  startTurn(onTurnEnd) {
    if (this.activePlayer) {      
      this.activePlayer.step(onTurnEnd).catch(() => {});
    }
  }

  /**
   * Advances game turn to the next player.
   * If all players have taken a turn, increments currentRound.
   */
  async endTurn(onTurnEnd) {
    if (this.players.length === 0 || this.gameOver) return;
    this.activePlayerIndex = (this.activePlayerIndex + 1) % this.players.length;
    if (this.activePlayerIndex === 0) {
      // Temporarily set to -1 so there is no active player, so event handlers don't try to execute actions
      this.activePlayerIndex = -1;
      await this.onRoundEnd();
      this.activePlayerIndex = 0;
    }
    // M4: recalculate all scores and judge the win BEFORE starting the
    // next turn — the old code checked after endTurn returned, by which
    // time the next AI had already started acting on stale scores.
    for (const p of this.players) p.recalculateScore();
    const win = this.checkWinConditions();
    if (win) {
      this.gameOver = true;
      return;
    }
    // M5: clean boundary — round-end is done, scores are fresh, and the
    // next player's turn has NOT started yet. The driver may save here;
    // a save taken after startTurn would capture a partial AI turn.
    if (typeof this.onCleanBoundary === 'function') {
      this.onCleanBoundary();
    }
    this.startTurn(onTurnEnd);
    if (this.replayRecorder?.isRecording()) {
      const activePlayerName = this.activePlayer ? this.activePlayer.name : 'Unknown';
      this.replayRecorder.recordSnapshot(this, `Turn started: ${activePlayerName}`);
    }
  }

  /**
   * Checks if any player has met the win conditions.
   * Pure: returns { winner, reasons } or null, and never touches the
   * UI — the browser renders the victory modal from the result, and
   * headless harnesses log it and set gameOver from it. This is the
   * single win check for both drivers; it used to live in main.js
   * (modal-bound) with a duplicated copy in the headless harness.
   */
  checkWinConditions() {
    if (!this.settings?.winCondition) return null;

    // Don't check win conditions before MIN_GAME_ROUNDS
    if (this.currentRound < CONFIG.MIN_GAME_ROUNDS) return null;

    const winCondition = this.settings.winCondition;

    // Only the leader can win. Take the two highest totals: if they are
    // equal nobody has won (even above absoluteScore). Otherwise the leader
    // wins on absoluteScore or on relativeScore x second-highest. A
    // second-highest of 0 is fine: 0 x multiplier = 0, so a leader with
    // any score beats a zeroed opponent (cube-root totals drop to 0 when
    // any one pillar hits 0).
    const ranked = [...this.players].sort((a, b) => b.score.total - a.score.total);
    const leader = ranked[0];
    if (!leader) return null;
    const secondHighest = ranked.length > 1 ? ranked[1].score.total : null;
    if (secondHighest !== null && leader.score.total === secondHighest) return null;

    const reasons = [];
    if (winCondition.absoluteScore && leader.score.total >= winCondition.absoluteScore) {
      reasons.push(`Absolute Score: ${leader.score.total} >= ${winCondition.absoluteScore}`);
    }
    // Relative needs an opponent: a one-player game wins on absolute only.
    if (winCondition.relativeScore && secondHighest !== null
        && leader.score.total >= winCondition.relativeScore * secondHighest) {
      reasons.push(`Relative Score: ${leader.score.total} >= ${winCondition.relativeScore} × ${secondHighest} (second highest)`);
    }

    return reasons.length > 0 ? { winner: leader, reasons } : null;
  }

  /**
   * 
   */
  async onRoundEnd() {
    if (this.settings?.barbarians) await manageBarbarians(this.settings.barbarians, this.aiHelper);
    this.executePerTurnTrades();
    this.currentRound++;
    if (this.replayRecorder?.isRecording()) {
      this.replayRecorder.recordSnapshot(this, `Round ${this.currentRound} began`);
    }
  }

  /**
   * Spawns a new entity instance on a cell.
   * @param {string} entityName - Name of entity in manifest
   * @param {Object} cell - Target cell
   * @param {Player|null} owner - Owning player
   * @param {Object} [initialState] - Optional state override
   * @param {Object} [entityData] - Optional manifest entry override (Q4: a
   *   saved entity carries its own data, so it loads even if the live
   *   manifest changed or dropped the type; otherwise the manifest is used)
   * @returns {BaseEntity|null} Spawned entity instance
   */
  /**
   * Zone of Control (Phase 24) helpers.
   * The map is keyed by "q,r"; each entry is { controlledBy: [entityId], occupiedBy: [entityId] }.
   * controlledBy: entities whose zoneOfControlRadius covers the cell.
   * occupiedBy: the entity (if any) standing on the cell.
   */
  _zoneCellKey(q, r) {
    return `${q},${r}`;
  }

  // All cells within hex distance `radius` of (q, r), including the center
  // cell itself. Radius 0 returns just the center cell.
  _cellsWithinRadius(q, r, radius) {
    const out = [{ q, r }];
    if (!radius || radius <= 0) return out;
    const seen = new Set([`${q},${r}`]);
    let frontier = [{ q, r }];
    for (let d = 1; d <= radius; d++) {
      const next = [];
      for (const c of frontier) {
        for (const nb of HexGrid.getNeighborCoords(c.q, c.r)) {
          const key = `${nb.q},${nb.r}`;
          if (seen.has(key)) continue;
          seen.add(key);
          // Only include cells that exist on the grid.
          if (!this.hexGrid || !this.hexGrid.getCell(nb.q, nb.r)) continue;
          out.push({ q: nb.q, r: nb.r });
          next.push({ q: nb.q, r: nb.r });
        }
      }
      frontier = next;
    }
    return out;
  }

  // Remove an entity's ID from every map entry (both lists). Drops entries
  // left empty.
  _removeEntityFromZoneControl(entityId) {
    for (const [key, entry] of this.zoneControlMap) {
      entry.controlledBy = entry.controlledBy.filter(id => id !== entityId);
      entry.occupiedBy = entry.occupiedBy.filter(id => id !== entityId);
      if (entry.controlledBy.length === 0 && entry.occupiedBy.length === 0) {
        this.zoneControlMap.delete(key);
      }
    }
  }

  // Recompute one entity's contribution to the map: remove its old entries,
  // then add it to its current cell (occupiedBy) and every cell within its
  // zoneOfControlRadius (controlledBy). Call after spawn and after any move.
  updateZoneControl(entity) {
    if (!entity || !entity.id) return;
    this._removeEntityFromZoneControl(entity.id);
    const radius = entity.zoneOfControlRadius ?? 0;
    const cells = this._cellsWithinRadius(entity.q, entity.r, radius);
    for (const c of cells) {
      const key = this._zoneCellKey(c.q, c.r);
      let entry = this.zoneControlMap.get(key);
      if (!entry) {
        entry = { controlledBy: [], occupiedBy: [] };
        this.zoneControlMap.set(key, entry);
      }
      if (!entry.controlledBy.includes(entity.id)) entry.controlledBy.push(entity.id);
    }
    // The entity occupies its own cell.
    const ownKey = this._zoneCellKey(entity.q, entity.r);
    let ownEntry = this.zoneControlMap.get(ownKey);
    if (!ownEntry) {
      ownEntry = { controlledBy: [], occupiedBy: [] };
      this.zoneControlMap.set(ownKey, ownEntry);
    }
    if (!ownEntry.occupiedBy.includes(entity.id)) ownEntry.occupiedBy.push(entity.id);
  }

  // Drop an entity from the map entirely (destroy). Call before removing it
  // from this.entities.
  removeFromZoneControl(entityId) {
    if (!entityId) return;
    this._removeEntityFromZoneControl(entityId);
  }

  spawnEntity(entityName, cell, owner = null, initialState = null, entityData = null) {
    const meta = entityData || this.manifestData?.entities[entityName];
    if (!meta) {
      console.warn(`Cannot spawn entity "${entityName}": metadata not found in manifest or save.`);
      return null;
    }

    const entity = new Entity(meta, owner, this, cell, initialState);
    this.entities.push(entity);
    // Zone of Control (Phase 24): populate the occupancy/control map.
    // Load recreates entities through spawnEntity, so this is what
    // repopulates the map on load (the map itself is not saved).
    this.updateZoneControl(entity);

    // Add history entry for entity creation — but not on rehydration:
    // deserialize() re-spawns every existing entity, and recording those
    // as creations would pollute history on every load (and on every
    // checkpoint resume, where history is LLM-visible).
    if (owner && !initialState) {
      owner.addHistoryEntry(this.currentRound, {
        category: 'spawn',
        details: `Created ${entity.name} at (${cell.q}, ${cell.r})`,
        extra: {
          entityName: entity.name,
          entityId: entity.id,
          cell: { q: cell.q, r: cell.r }
        }
      });
    }

    return entity;
  }

  /**
   * Removes an entity by ID.
   * @param {string} entityId
   */
  removeEntity(entityId) {
    const entity = this.entities.find(e => e.id === entityId);
    if (entity && entity.owner) {
      entity.owner.addHistoryEntry(this.currentRound, {
        category: 'destroy',
        details: `${entity.name} at (${entity.q}, ${entity.r}) was destroyed`,
        extra: {
          entityName: entity.name,
          entityId: entity.id,
        }
      });
    }
    // Zone of Control (Phase 24): drop the entity from the map.
    this.removeFromZoneControl(entityId);
    this.entities = this.entities.filter(e => e.id !== entityId);
  }

  /**
   * Returns the primary entity standing on cell at (q, r), or null.
   * @param {number} q
   * @param {number} r
   * @returns {BaseEntity|null}
   */
  getEntityAt(q, r) {
    return this.entities.find(e => e.q === q && e.r === r) || null;
  }

  /**
   * Returns the entity with the given ID.
   * @param {string} id
   * @returns {BaseEntity|null}
   */
  getEntityById(id) {
    return this.entities.find(e => e.id === id) || null;
  }

  /**
   * Returns true if a human can see this cell
   */
  isVisibleToHuman(cell) {
    // Replay fog POV: when set, only the snapshot's active player's fog counts.
    if (this.fogPovPlayer) return this.fogPovPlayer.isVisible(cell.q, cell.r);
    for (const p of this.players.filter(p => !p.isAI)) {
      if (p.isVisible(cell.q, cell.r)) return true;
    }
    return false;
  }

  /**
   * Returns true if a human has explored this cell
   */
  isExploredByHuman(cell) {
    // Replay fog POV: when set, only the snapshot's active player's fog counts.
    if (this.fogPovPlayer) return this.fogPovPlayer.isExplored(cell.q, cell.r);
    for (const p of this.players.filter(p => !p.isAI)) {
      if (p.isExplored(cell.q, cell.r)) return true;
    }
    return false;
  }

  /**
   * Serializes the game state to JSON string.
   */
  serialize() {
    return JSON.stringify({
      activePlayerIndex: this.activePlayerIndex,
      currentRound: this.currentRound,
      gameOver: this.gameOver,
      players: this.players.map(p => p.toJSON()),
      entities: this.entities.map(e => e.toJSON()),
      unownedEntityCounter: this.unownedEntityCounter,
      cells: this.hexGrid ? this.hexGrid.getCellsObject() : {},
      settings: this.settings,
      chatHistory: this.chatHistory || {},
      trades: this.trades || []
    });
  }

  /**
   * Deserializes a JSON string to populate the game state.
   * @param {string} jsonString
   */
  deserialize(jsonString) {
    try {
      const data = JSON.parse(jsonString);

      if (data.settings) {
        this.settings = data.settings;
      }

      // M2: initializationSettings (starting resources etc.) was only set in
      // initializeManifest, so a loaded game left AI economics blind
      // (startingResources = {}). Re-derive it from the serialized settings.
      this.initializationSettings = this.settings?.initialization || {};

      this.chatHistory = data.chatHistory || {};
      this.trades = data.trades || [];

      if (data.activePlayerIndex !== undefined) {
        this.activePlayerIndex = data.activePlayerIndex;
      }
      if (data.currentRound !== undefined) {
        this.currentRound = data.currentRound;
      }
      if (data.gameOver !== undefined) {
        this.gameOver = data.gameOver;
      }
      if (data.unownedEntityCounter !== undefined) {
        this.unownedEntityCounter = data.unownedEntityCounter;
      }

      // Re-hydrate Players
      if (data.players) {
        this.players = data.players.map(p => Player.fromJSON(p, this));
      }

      // Re-hydrate Cells into the HexGrid
      if (data.cells) {
        this.hexGrid = HexGrid.fromCells(data.cells);
      }

      // Re-hydrate Entities
      this.entities = [];
      this.zoneControlMap.clear();
      if (data.entities && Array.isArray(data.entities)) {
        data.entities.forEach(eData => {
          const cell = this.hexGrid ? this.hexGrid.getCell(eData.q, eData.r) : null;
          const owner = this.players.find(p => p.id === eData.ownerId) || null;
          if (cell) {
            // M1: id is a top-level field in toJSON(), not in state — pass it
            // through so entity IDs survive a load (history entries, AI goals
            // and anything keyed by id depend on stable IDs).
            const entity = this.spawnEntity(eData.name, cell, owner, { ...eData.state, id: eData.id }, eData.data);
            // Age lives on the instance, not in state: restore it so a
            // loaded game does not reset every entity's age to 0.
            // Guarded: saves written before age was serialized lack it.
            if (entity && eData.age !== undefined) entity.age = eData.age;
          }
        });
      }

      // Counters may be missing or stale (pre-counter saves): advance each
      // counter past the highest numeric suffix among that owner's loaded
      // entities, so a fresh spawn can never collide with an existing ID.
      // Old random suffixes aren't numeric and are skipped.
      for (const e of this.entities) {
        const suffix = e.id.split('_').pop();
        if (!/^\d+$/.test(suffix)) continue;
        const n = parseInt(suffix, 10);
        if (e.owner) e.owner.entityCounter = Math.max(e.owner.entityCounter ?? 0, n);
        else this.unownedEntityCounter = Math.max(this.unownedEntityCounter ?? 0, n);
      }

      this.players.forEach(p => p.updateVisibility(this));
    } catch (e) {
      console.error('Failed to deserialize GameState:', e);
    }
    return this;
  }
}