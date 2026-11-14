import { animateToTimeOfDay, cancelTimeOfDayAnimation, setTimeOfDay } from "./renderer.js";
import { AiHelper } from './aiHelper.js';
import { createAiManager } from './aiInterfaceProxy.js';

const turnHours = { start: 7, end: 17 }
const orderToResourceConversionRate = 3;

/**
 * Player class representing a participant in the game.
 * Tracks resources, control type (human vs AI), explored and visible hex cells.
 */
export class Player {
  /**
   * @param {number|string} id
   * @param {string} name
   * @param {string} color
   * @param {GameState} gameState
   * @param {Object} [startingResources]
   * @param {string} [description]
   * @param {Object|string|null} [controller]
   * @param {Object} [ordersConfig] - { max, initial, perTurn }
   */
  constructor(id, name, gameState, color, startingResources = {}, description = '', controller = null, ordersConfig = null, isReplay = false) {
    this.id = id;
    this.name = name;
    // Counter for entity IDs: each fresh entity this player owns takes the
    // next number (<name>_<playerId>_<n>). Saved/loaded with the player.
    this.entityCounter = 0;
    this.color = color;
    this.gameState = gameState;
    this.description = description || '';
    this.controller = controller || null;
    this.resources = { ...startingResources };
    this.startCoord = { q: 0, r: 0 };
    this.score = {
      military: 0,
      economic: 0,
      exploration: 0,
      total: 0
    };

    this.ordersConfig = ordersConfig || {};
    // L4: start at max - perTurn when no explicit initial is set. Starting
    // at max meant the first step()'s refill overflowed the whole perTurn
    // amount into free resources (+15 on turn 1 with the defaults).
    this.orders = ordersConfig?.initial ?? Math.max(0, (ordersConfig?.max ?? 0) - (ordersConfig?.perTurn ?? 0));
    this.maxOrders = ordersConfig?.max ?? 0;
    this.ordersPerTurn = ordersConfig?.perTurn ?? 0;

    // Fog of war tracking sets (stores coordinate key strings "q,r")
    this.exploredCells = new Set();
    this.visibleCells = new Set();

    // Player history: Map<roundNumber, Array<historyEntry>>
    // Each entry: { round, timestamp, category, entityName, entityId, details }
    this.history = new Map();

    // In replay mode we don't instantiate AI managers, but we still need to
    // know whether this player was AI-controlled for UI labelling.
    this.isReplayAI = isReplay;
  }

  /**
   * Returns the player's AI manager, creating it on first use by resolving
   * player.controller to a BaseManager implementation. Returns null for
   * human players and replays.
   */
  async getAiManager() {
    if (this.aiManager) return this.aiManager;
    if (!this.controller?.url || this.isReplayAI) return null;
    const module = await import(this.controller.url);
    const ManagerClass = module.default;
    if (!ManagerClass) {
      throw new Error(`Default Class not found in module ${this.controller.url}`);
    }
    this.aiManager = createAiManager(ManagerClass, this, this.gameState.aiHelper);
    return this.aiManager;
  }

  /**
   * True if player is AI controlled.
   * @returns {boolean}
   */
  get isAI() {
    return !!this.controller;
  }

  /**
   * Adds a history entry for a specific round.
   * Entries are inserted at the beginning for reverse chronological order (newest first).
   * @param {number} round - Round number
   * @param {Object} entry - History entry object
   * @param {string} entry.category - Category of the event (e.g., 'action', 'damage', 'spawn', 'destroy', 'orders')
   * @param {string} [entry.entityName] - Name of the entity involved
   * @param {string} [entry.entityId] - ID of the entity involved
   * @param {string} entry.details - Description of what happened
   * @param {Object} [entry.extra] - Additional structured data (e.g., attackerId, damage, actionName, etc.)
   */
  addHistoryEntry(round, entry) {
    const timestamp = new Date().toISOString();

    const historyEntry = {
      timestamp,
      round,
      category: entry.category,
      // L3: callers put entityName/entityId under extra, not top-level —
      // fall back to extra so the fields are actually populated.
      entityName: entry.entityName || entry.extra?.entityName || null,
      entityId: entry.entityId || entry.extra?.entityId || null,
      details: entry.details,
      extra: entry.extra || {}
    };

    if (!this.history.has(round)) {
      this.history.set(round, []);
    }

    // Insert at beginning for reverse chronological order (newest first)
    this.history.get(round).unshift(historyEntry);
  }

  /**
   * Gets history entries for a specific round.
   * @param {number} [round] - Specific round number, or undefined for all rounds
   * @returns {Array} Array of history entries in reverse chronological order (newest first)
   */
  getHistory(round = null) {
    if (round !== null) {
      return this.history.get(round) || [];
    }

    // Return all entries in reverse round order (newest round first), then reverse chronological within each round
    const allEntries = [];
    const sortedRounds = Array.from(this.history.keys()).sort((a, b) => b - a); // Descending round order
    for (const r of sortedRounds) {
      allEntries.push(...this.history.get(r));
    }
    return allEntries;
  }

  /**
   * Gets history entries for a range of rounds (for pagination).
   * @param {number} startRound - Starting round (inclusive)
   * @param {number} endRound - Ending round (inclusive)
   * @returns {Array} Array of history entries for the round range in reverse chronological order
   */
  getHistoryRange(startRound, endRound) {
    const entries = [];
    // Iterate from endRound down to startRound for reverse chronological order
    for (let r = endRound; r >= startRound; r--) {
      const roundEntries = this.history.get(r) || [];
      entries.push(...roundEntries);
    }
    return entries;
  }

  /**
   * Recomputes military/economic/exploration/total scores from current
   * state. Called by step(), which every driver (browser and headless)
   * goes through — both see the same scores.
   */
  recalculateScore() {
    this.score = { military: 0, economic: 0 };
    const ownedEntities = this.getEntities();
    for (const entity of ownedEntities) {
      this.score.military += entity.state.score.military ?? 0;
      this.score.economic += entity.state.score.economic ?? 0;
    }

    this.score.exploration = Math.round(Math.pow(this.visibleCells.size * this.exploredCells.size, 1 / 3));
    this.score.total = Math.round(Math.pow(this.score.military * this.score.economic * this.score.exploration, 1 / 3));
  }

  /**
   * Turn lifecycle step called at the start of this player's turn.
   * Steps all entities owned by this player.
   *
   * Async: the caller decides how to handle the returned promise —
   * the harness awaits it, the browser fire-and-forgets it (see
   * GameState.startTurn). The driver owns turn advancement, so step()
   * never imports nextTurn() from main.js (that import is what forced
   * headless harnesses to bypass step() entirely). The driver passes
   * its continuation as onTurnEnd: the browser passes nextTurn, and
   * harnesses that drive turns explicitly pass a no-op. AI errors are 
   * logged here and then rethrown, so the awaiting driver can count them; 
   * the turn still advances via the finally callback.
   */
  async step(onTurnEnd) {
    this.refillOrders();
    const ownedEntities = this.getEntities();
    // M3: yields first across all entities, then upkeep, then the rest.
    // A single interleaved pass starved units that spawn before the
    // buildings whose yields would cover their upkeep.
    for (const entity of ownedEntities) entity.collectYield();
    for (const entity of ownedEntities) entity.payUpkeep();
    for (const entity of ownedEntities) entity.finishStep();

    this.updateVisibility();
    this.recalculateScore();

    try {
      const aiManager = await this.getAiManager();
      if (aiManager) {
        // Let the AI re-evaluate ongoing per-turn deals before acting. A
        // trade-review failure must never block the rest of the turn.
        try {
          if (typeof aiManager.reviewTrades === 'function') await aiManager.reviewTrades();
        } catch (err) {
          console.error(`Trade review failed for player ${this.name}:`, err);
        }
        try {
          if (typeof aiManager.maybeInitiateTrade === 'function') await aiManager.maybeInitiateTrade();
        } catch (err) {
          console.error(`Trade proposal failed for player ${this.name}:`, err);
        }
        await aiManager.processTurn();
      }
    } catch (err) {
      console.error(`Error during step for player ${this.name}:`, err);
      throw err;
    } finally {
      if (typeof onTurnEnd === 'function' && this.isAI) {
        onTurnEnd();
      }
    }
  }

  /**
   * Calculates resource profile of the player given current upkeep and yields.
   * @returns {Object} An object with the following properties:
   *  - stock: An object with the stock of each resource (what player currently has).
   *  - totalUpkeep: An object with the total upkeep for each resource.
   *  - totalYields: An object with the total yields for each resource.
   *  - netIncome: An object with the net income for each resource (yields - upkeep).
   *  - turnsRemaining: An object with the number of turns remaining for each resource before it runs out (Infinity if net income is non-negative).
   *  - criticalResource: The resource that will run out first.
   */
  getResourceProfile() {
    const totalUpkeep = {};
    const totalYields = {};
    const maxTotalYields = {};
    const netIncome = {};
    const turnsRemaining = {};
    const stock = this.resources;
    const resourceKeys = new Set(Object.keys(stock));

    const myEntities = this.getEntities();
    for (const entity of myEntities) {
      const maintenance = entity.getCostToMaintain ? entity.getCostToMaintain() : {};
      for (const [res, amt] of Object.entries(maintenance)) {
        resourceKeys.add(res);
        totalUpkeep[res] = (totalUpkeep[res] || 0) + amt;
      }

      // maxTotalYields: capacity — what every entity would yield at full
      // health and active (Shahin, 2026-11-05). Lets the AI tell "I need
      // more farms" apart from "I need to repair/reactivate my farms".
      for (const [res, amt] of Object.entries(entity.yields || {})) {
        resourceKeys.add(res);
        maxTotalYields[res] = (maxTotalYields[res] || 0) + amt;
      }

      // totalYields: actual expected income — only entities that canYield()
      // (active and above 95% HP). Upkeep stays total demand on purpose:
      // the profile shows what everything wants to consume if it could pay.
      const yields = typeof entity.canYield === 'function'
        ? entity.canYield()
        : (entity.active && entity.health > entity.maxHealth * 0.95);
      if (yields) {
        for (const [res, amt] of Object.entries(entity.yields || {})) {
          resourceKeys.add(res);
          totalYields[res] = (totalYields[res] || 0) + amt;
        }
      }
    }

    let criticalResource = null;
    const tradeIncome = {};
    const tradeExpense = {};
    const netTrade = {};
    const activeTrades = (this.gameState?.trades || []).filter(t => t.active && t.type === 'per_turn' && (String(t.player1Id) === String(this.id) || String(t.player2Id) === String(this.id)));
    for (const trade of activeTrades) {
      const isP1 = String(trade.player1Id) === String(this.id);
      const mySend = isP1 ? trade.bundle1 : trade.bundle2;
      const myReceive = isP1 ? trade.bundle2 : trade.bundle1;
      for (const [res, amt] of Object.entries(mySend || {})) {
        if (amt > 0) {
          resourceKeys.add(res);
          tradeExpense[res] = (tradeExpense[res] || 0) + amt;
        }
      }
      for (const [res, amt] of Object.entries(myReceive || {})) {
        if (amt > 0) {
          resourceKeys.add(res);
          tradeIncome[res] = (tradeIncome[res] || 0) + amt;
        }
      }
    }

    for (const resKey of resourceKeys) {
      if (totalUpkeep[resKey] == undefined) totalUpkeep[resKey] = 0;
      if (totalYields[resKey] == undefined) totalYields[resKey] = 0;
      if (maxTotalYields[resKey] == undefined) maxTotalYields[resKey] = 0;
      tradeIncome[resKey] = tradeIncome[resKey] || 0;
      tradeExpense[resKey] = tradeExpense[resKey] || 0;
      netTrade[resKey] = tradeIncome[resKey] - tradeExpense[resKey];
      netIncome[resKey] = totalYields[resKey] - totalUpkeep[resKey] + netTrade[resKey];
      turnsRemaining[resKey] = netIncome[resKey] < 0 ? Math.floor((stock[resKey] || 0) / -netIncome[resKey]) : Infinity;
      if (turnsRemaining[resKey] < Infinity) {
        if (!criticalResource || turnsRemaining[resKey] < turnsRemaining[criticalResource]) {
          criticalResource = resKey;
        }
      }
    }

    return {
      stock,
      totalUpkeep,
      totalYields,
      maxTotalYields,
      tradeIncome,
      tradeExpense,
      netTrade,
      netIncome,
      turnsRemaining,
      criticalResource,
      activeTrades
    }
  }

  /**
   * Returns all entities owned by this player in the given game state.
   * @returns {Array<Entity>}
   */
  getEntities() {
    if (!this.gameState || !this.gameState.entities) return [];
    return this.gameState.entities.filter(e => e.owner && e.owner.id === this.id);
  }

  /**
   * Returns all visible opponents and their owned entities in the given game state. Any entity without an owner is grouped under the null owner.
   * @returns {Object} Mapping opponent player IDs to { name, score, description, entities }
   */
  getOpponents() {
    if (!this.gameState || !this.gameState.entities) return [];
    const opponentEntities = this.gameState.entities.filter(e => (!e.owner || e.owner.id !== this.id) && this.visibleCells.has(`${e.q},${e.r}`));
    const opponent = {};
    for (const entity of opponentEntities) {
      const ownerId = entity.owner ? entity.owner.id : null;
      if (!opponent[ownerId]) {
        opponent[ownerId] = {
          id: ownerId,
          name: entity.owner ? entity.owner.name : 'None',
          score: entity.owner ? entity.owner.score : 0,
          description: entity.owner ? entity.owner.description : '',
          entities: []
        };
      }
      opponent[ownerId].entities.push(entity);
    }
    return opponent;
  }

  /**
   * Updates player's visible and explored sets by taking the union of all
   * owned active entities' visible cells. Cells added to visibleCells are also added
   * to exploredCells (which are never removed).
   */
  updateVisibility() {
    this.visibleCells.clear();
    const ownedEntities = this.getEntities();
    ownedEntities.forEach(entity => {
      // Ensure entity has updated visible cells
      if (entity.visibleCells) {
        entity.visibleCells.forEach(coordKey => {
          this.visibleCells.add(coordKey);
          this.exploredCells.add(coordKey);
        });
      }
    });
  }

  /**
   * Checks if a hex coordinate (q, r) has been explored by this player.
   * @param {number} q
   * @param {number} r
   * @returns {boolean}
   */
  isExplored(q, r) {
    return this.exploredCells.has(`${q},${r}`);
  }

  /**
   * Checks if a hex coordinate (q, r) is currently visible to this player.
   * @param {number} q
   * @param {number} r
   * @returns {boolean}
   */
  isVisible(q, r) {
    return this.visibleCells.has(`${q},${r}`);
  }

  /**
   * Initializes player resources based on starting configuration map.
   * @param {Object} resourceDefaults - Map of resource names to quantities
   */
  setStartingResources(resourceDefaults) {
    this.resources = { ...resourceDefaults };
  }

  /**
   * Checks if player has sufficient resources for a cost map.
   * @param {Object} costMap - Object mapping resource names to required quantities
   * @returns {boolean} True if player can afford the cost
   */
  hasResources(costMap) {
    if (!costMap) return true;
    for (const [resName, qty] of Object.entries(costMap)) {
      const current = this.resources[resName] || 0;
      if (current < qty) {
        return false;
      }
    }
    return true;
  }

  /**
   * Consumes resources if affordable.
   * @param {Object} costMap - Object mapping resource names to required quantities
   * @returns {boolean} True if successfully consumed
   */
  consumeResources(costMap) {
    if (!this.hasResources(costMap)) return false;
    for (const [resName, qty] of Object.entries(costMap)) {
      this.resources[resName] = (this.resources[resName] || 0) - qty;
    }
    return true;
  }

  /**
   * Adds resources to the player's pool.
   * @param {Object} amountMap - Object mapping resource names to quantities to add
   */
  addResources(amountMap) {
    if (!amountMap) return;
    for (const [resName, qty] of Object.entries(amountMap)) {
      this.resources[resName] = (this.resources[resName] || 0) + qty;
    }
  }

  /**
   * Checks if player has enough orders for an action.
   * @param {number} [count=1]
   * @returns {boolean}
   */
  hasOrders(count = 1) {
    return this.orders >= count;
  }

  /**
   * Consumes orders if available.
   * @param {number} [count=1]
   * @returns {boolean}
   */
  consumeOrders(count = 1) {
    if (!this.hasOrders(count)) return false;
    this.orders -= count;
    this.setOrdersTimeOfDay(1);
    return true;
  }

  /**
   * Adds per-turn orders up to the maximum.
   */
  refillOrders() {
    let orderBonus = 0;
    this.getEntities().forEach(entity => {
      orderBonus += entity.state?.ordersPerTurn || 0;
    });
    this.maxOrders = this.ordersConfig.max + orderBonus;
    this.ordersPerTurn = this.ordersConfig.perTurn + orderBonus;
    const overflow = this.orders + this.ordersPerTurn - this.maxOrders;
    console.debug(`Player ${this.name} - orders before refill: ${this.orders}, ordersPerTurn: ${this.ordersPerTurn}, maxOrders: ${this.maxOrders}, overflow: ${overflow}`);
    if (overflow > 0) {
      this.orders = this.maxOrders;
      const resourceProfile = this.getResourceProfile();
      console.debug(`Player ${this.name} - overflow of ${overflow} orders, converting to resources. Resource profile:`, resourceProfile);
      let pickedResource = resourceProfile.criticalResource;
      if (!pickedResource) {  // if nothing is critical, pick a random resource to convert overflow into
        const resourceNames = Object.keys(this.resources);
        pickedResource = resourceNames[Math.floor((this.gameState?.random ?? Math.random)() * resourceNames.length)];
      }
      if (pickedResource) {
        const amount = overflow * orderToResourceConversionRate;
        this.resources[pickedResource] = (this.resources[pickedResource] || 0) + amount;
        console.debug(`Player ${this.name} - converting ${overflow} excess orders to ${amount} ${pickedResource}`);

        // Add history entry for orders conversion
        this.addHistoryEntry(this.gameState.currentRound, {
          category: 'orders',
          details: `Converted ${overflow} excess orders to ${amount} ${pickedResource}`,
          extra: {
            overflowOrders: overflow,
            resource: pickedResource,
            amount: amount
          }
        });
      }
    } else {
      this.orders += this.ordersPerTurn;
    }
    this.setOrdersTimeOfDay(2);
  }

  /**
   * Changes the time of day based on the number of orders remaining.
   * @param {number} [duration=1] - Duration of the animation in seconds
   */
  setOrdersTimeOfDay(duration = 1) {
    const orderFraction = this.orders / this.maxOrders;
    const timeOfDay = turnHours.end - (turnHours.end - turnHours.start) * orderFraction;
    animateToTimeOfDay(timeOfDay, duration);
  }

  /**
   * Sets the time of day from the number of orders remaining, instantly
   * (no animation). For game load: the sun is renderer-local and is not
   * saved with the game state, so a load must re-derive it from the active
   * player's orders — animating it would sweep through the night (the
   * refill already animates 5pm -> 7am), and a mid-turn manual load never
   * refills at all, so the sun would just stay wherever it was.
   */
  resetTimeOfDay() {
    const orderFraction = this.orders / this.maxOrders;
    const timeOfDay = turnHours.end - (turnHours.end - turnHours.start) * orderFraction;
    cancelTimeOfDayAnimation();
    setTimeOfDay(timeOfDay);
  }

  /**
   * Serializes player state.
   */
  toJSON() {
    // Serialize history map to array of [round, entries] pairs
    const historyArray = Array.from(this.history.entries()).map(([round, entries]) => [round, entries]);

    return {
      id: this.id,
      name: this.name,
      color: this.color,
      description: this.description,
      controller: this.controller,
      resources: this.resources,
      orders: this.orders,
      maxOrders: this.maxOrders,
      ordersPerTurn: this.ordersPerTurn,
      ordersConfig: this.ordersConfig,
      startCoord: this.startCoord,
      score: this.score,
      entityCounter: this.entityCounter,
      exploredCells: Array.from(this.exploredCells),
      visibleCells: Array.from(this.visibleCells),
      history: historyArray
    };
  }

  /**
   * Re-hydrates a Player instance from serialized JSON object.
   * @param {Object} data
   * @param {GameState} gameState
   * @param {boolean} [isReplay=false] - If true, skip AI manager creation
   */
  static fromJSON(data, gameState, isReplay = false) {
    // H1: strip any apiKey from a pre-fix save's controller config — the
    // key is resolved from sessionStorage at client construction now, and
    // must never be re-persisted into a new save.
    if (data.controller?.config?.apiKey) {
      delete data.controller.config.apiKey;
    }
    const player = new Player(data.id, data.name, gameState, data.color, data.resources, data.description, data.controller, data.ordersConfig, isReplay);
    player.maxOrders = data.maxOrders ?? 0;
    player.ordersPerTurn = data.ordersPerTurn ?? 0;
    player.orders = data.orders ?? 0;
    player.entityCounter = data.entityCounter ?? 0;
    if (data.startCoord) {
      player.startCoord = { ...data.startCoord };
    }
    if (data.score) {
      player.score = { ...data.score };
    }
    if (data.exploredCells && Array.isArray(data.exploredCells)) {
      player.exploredCells = new Set(data.exploredCells);
    }
    if (data.visibleCells && Array.isArray(data.visibleCells)) {
      player.visibleCells = new Set(data.visibleCells);
    }
    if (data.history && Array.isArray(data.history)) {
      player.history = new Map(data.history);
    }
    return player;
  }
}