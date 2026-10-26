import Entity from './entity.js';
import { reconcileEntities, reconcileCellResources, buildCellResources, getTimeOfDay, setTimeOfDay } from './renderer.js';

/**
 * ReplayRecorder — Records lightweight per-action dynamic state snapshots
 * during an active game session without duplicating static hex terrain meshes.
 */
export class ReplayRecorder {
  constructor() {
    this.active = false;
    this.replayData = null;
    // Resource keys already recorded as removed (so each snapshot only stores new removals)
    this.removedResourceKeys = new Set();
  }

  /**
   * Initializes a new replay session from the initial game state.
   * @param {GameState} gameState
   * @param {Object} settings
   */
  start(gameState, settings) {
    const timestamp = Date.now();
    const id = `replay_${timestamp}`;
    const dateStr = new Date(timestamp).toLocaleString();
    const name = `Replay - ${dateStr}`;

    // Strip sensitive data from settings before storing
    const safeSettings = JSON.parse(JSON.stringify(settings || {}));
    if (safeSettings.llm && safeSettings.llm.apiKey) {
      safeSettings.llm.apiKey = '';
    }

    // Capture all cell resources once in initialState (resources are only removed, never added)
    const initialCellResources = {};
    if (gameState.hexGrid && gameState.hexGrid.cells) {
      for (const cell of gameState.hexGrid.cells.values()) {
        if (cell.resource) {
          initialCellResources[`${cell.q},${cell.r}`] = {
            name: cell.resource.name,
            kind: cell.resource.kind,
            quantity: cell.resource.quantity,
            items: cell.resource.items ? [...cell.resource.items] : []
          };
        }
      }
    }

    // Capture fog of war for each player
    const initialPlayerFog = gameState.players.map(p => ({
      id: p.id,
      exploredCells: Array.from(p.exploredCells),
      visibleCells: Array.from(p.visibleCells)
    }));

    this.replayData = {
      id,
      name,
      timestamp,
      settings: safeSettings,
      initialState: {
        cells: gameState.hexGrid ? structuredClone(gameState.hexGrid.getCellsObject()) : {},
        mapSize: settings?.mapSize || 15,
        players: gameState.players.map(p => structuredClone(p.toJSON())),
        entities: gameState.entities.map(e => structuredClone(e.toJSON())),
        activePlayerIndex: gameState.activePlayerIndex,
        currentRound: gameState.currentRound,
        timeOfDay: getTimeOfDay(),
        cellResources: initialCellResources,
        playerFog: initialPlayerFog
      },
      snapshots: []
    };

    this.active = true;
    this.removedResourceKeys = new Set();
    this.recordSnapshot(gameState, 'Game initialized');
  }

  /**
   * Returns true if recording is currently active.
   * @returns {boolean}
   */
  isRecording() {
    return this.active && this.replayData !== null;
  }

  /**
   * Captures a lean dynamic state snapshot.
   * @param {GameState} gameState
   * @param {string} [label='']
   */
  recordSnapshot(gameState, label = '') {
    if (!this.isRecording()) return;

    // Track which resource cells were removed since the previous snapshot.
    // Resources are only ever removed (never added), so we compare against the
    // initial resource set and only record keys not already reported.
    const prevSnapshot = this.replayData.snapshots[this.replayData.snapshots.length - 1];
    const initialResourceKeys = new Set(Object.keys(this.replayData.initialState.cellResources || {}));
    const currentResourceKeys = new Set();
    if (gameState.hexGrid && gameState.hexGrid.cells) {
      for (const cell of gameState.hexGrid.cells.values()) {
        if (cell.resource) {
          currentResourceKeys.add(`${cell.q},${cell.r}`);
        }
      }
    }
    // Only record resources removed since the last snapshot
    const removedResources = {};
    for (const key of initialResourceKeys) {
      if (!currentResourceKeys.has(key) && !this.removedResourceKeys.has(key)) {
        removedResources[key] = true;
        this.removedResourceKeys.add(key);
      }
    }

    // Capture fog of war for each player
    const playerFog = gameState.players.map(p => ({
      id: p.id,
      exploredCells: Array.from(p.exploredCells),
      visibleCells: Array.from(p.visibleCells)
    }));

    // Track destroyed entities (entities in previous snapshot but not in current)
    const prevEntityIds = prevSnapshot ? new Set(prevSnapshot.entities.map(e => e.id)) : new Set();
    const currentEntityIds = new Set(gameState.entities.map(e => e.id));
    const destroyedEntityIds = [];
    for (const id of prevEntityIds) {
      if (!currentEntityIds.has(id)) {
        destroyedEntityIds.push(id);
      }
    }

    const snapshot = {
      index: this.replayData.snapshots.length,
      timestamp: Date.now(),
      label: label || 'Action',
      currentRound: gameState.currentRound,
      activePlayerIndex: gameState.activePlayerIndex,
      timeOfDay: getTimeOfDay(),
      players: gameState.players.map(p => ({
        id: p.id,
        name: p.name,
        color: p.color,
        resources: { ...(p.resources || {}) },
        orders: p.orders,
        maxOrders: p.maxOrders,
        ordersPerTurn: p.ordersPerTurn,
        ordersConfig: p.ordersConfig,
        score: { ...(p.score || {}) }
      })),
      entities: gameState.entities.map(e => ({
        id: e.id,
        name: e.name,
        ownerId: e.owner ? e.owner.id : null,
        q: e.q,
        r: e.r,
        // Capture full entity state
        state: structuredClone(e.state),
        facing: e.facing || 'E',
        active: e.active !== false,
        destroyed: !!e.destroyed
      })),
      removedResources,
      destroyedEntityIds,
      playerFog
    };

    this.replayData.snapshots.push(snapshot);
    this.replayData.name = `Replay - Round ${gameState.currentRound} (${this.replayData.snapshots.length} actions)`;
  }

  /**
   * Returns true if there are recorded snapshots.
   * @returns {boolean}
   */
  hasData() {
    return !!(this.replayData && this.replayData.snapshots.length > 0);
  }

  /**
   * Gets the complete replay data object.
   * @returns {Object|null}
   */
  getReplayData() {
    return this.replayData;
  }

}

/**
 * ReplayPlayer — Controls playback, stepping, and scrubbing of a replay session.
 */
export class ReplayPlayer {
  /**
   * @param {Object} replayData - Full replay data object
   * @param {GameState} gameState - GameState instance attached to the renderer
   * @param {Function} onUpdateUI - Callback receiving state info on every step
   */
  constructor(replayData, gameState, onUpdateUI) {
    this.replayData = replayData;
    this.gameState = gameState;
    this.onUpdateUI = onUpdateUI || (() => {});

    this.currentIndex = 0;
    this.isPlaying = false;
    this.speed = 1.0;
    this.timer = null;
    this.lastCellResourcesKey = '';
  }

  get totalSnapshots() {
    return this.replayData?.snapshots?.length || 0;
  }

  get currentSnapshot() {
    return this.replayData?.snapshots?.[this.currentIndex] || null;
  }

  /**
   * Starts playback from the current snapshot forward.
   */
  play() {
    if (this.isPlaying) return;
    if (this.currentIndex >= this.totalSnapshots - 1) {
      this.goTo(0);
    }
    this.isPlaying = true;
    this._startTimer();
    this._notifyUI();
  }

  /**
   * Pauses playback.
   */
  pause() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this._clearTimer();
    this._notifyUI();
  }

  /**
   * Toggles between play and pause.
   */
  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  /**
   * Sets the playback speed multiplier.
   * @param {number} speed - e.g. 0.5, 1, 2, 4
   */
  setSpeed(speed) {
    this.speed = speed;
    if (this.isPlaying) {
      this._clearTimer();
      this._startTimer();
    }
  }

  /**
   * Steps forward by one action snapshot.
   */
  stepForward() {
    if (this.currentIndex < this.totalSnapshots - 1) {
      this.goTo(this.currentIndex + 1);
    } else {
      this.pause();
    }
  }

  /**
   * Steps backward by one action snapshot.
   */
  stepBackward() {
    if (this.currentIndex > 0) {
      this.goTo(this.currentIndex - 1);
    }
  }

  /**
   * Jumps to the first snapshot (start of game).
   */
  first() {
    this.goTo(0);
  }

  /**
   * Jumps to the last snapshot.
   */
  last() {
    this.goTo(this.totalSnapshots - 1);
  }

  /**
   * Jumps directly to a given snapshot index and applies its state.
   * @param {number} index
   */
  goTo(index) {
    if (this.totalSnapshots === 0) return;
    const target = Math.max(0, Math.min(index, this.totalSnapshots - 1));
    this.currentIndex = target;
    this.applySnapshot(this.currentIndex);
    this._notifyUI();
  }

  /**
   * Applies the game state for the snapshot at index.
   * @param {number} index
   */
  applySnapshot(index) {
    const snapshot = this.replayData.snapshots[index];
    if (!snapshot || !this.gameState) return;

    // Validate snapshot has entities array
    if (!Array.isArray(snapshot.entities)) {
      console.error('[ReplayPlayer] Snapshot missing entities array:', snapshot);
      return;
    }

    this.gameState.currentRound = snapshot.currentRound;
    this.gameState.activePlayerIndex = snapshot.activePlayerIndex;

    // Restore time of day
    if (snapshot.timeOfDay !== undefined) {
      setTimeOfDay(snapshot.timeOfDay);
    }

    // 1. Restore Player stats (resources, orders, score, ordersPerTurn, ordersConfig)
    if (snapshot.players && Array.isArray(snapshot.players)) {
      for (const pData of snapshot.players) {
        const player = this.gameState.players.find(p => p.id === pData.id);
        if (player) {
          player.resources = { ...(pData.resources || {}) };
          player.orders = pData.orders;
          if (pData.maxOrders !== undefined) player.maxOrders = pData.maxOrders;
          if (pData.ordersPerTurn !== undefined) player.ordersPerTurn = pData.ordersPerTurn;
          if (pData.ordersConfig) player.ordersConfig = { ...pData.ordersConfig };
          if (pData.score) player.score = { ...(pData.score || {}) };
        }
      }
    }

    // 2. Restore Entities (with full state)
    const snapshotEntityIds = new Set(snapshot.entities.map(e => e.id));
    // Remove entities not present in snapshot
    this.gameState.entities = this.gameState.entities.filter(e => snapshotEntityIds.has(e.id));

    for (const eData of snapshot.entities) {
      let entity = this.gameState.getEntityById(eData.id);
      const cell = this.gameState.hexGrid ? this.gameState.hexGrid.getCell(eData.q, eData.r) : null;
      const owner = this.gameState.players.find(p => p.id === eData.ownerId) || null;

      if (entity) {
        entity.q = eData.q;
        entity.r = eData.r;
        entity.cell = cell;
        entity.owner = owner;
        // Restore full entity state
        if (eData.state) {
          entity.state = structuredClone(eData.state);
        }
        entity.facing = eData.facing || 'E';
        entity.active = eData.active !== false;
        entity.destroyed = eData.destroyed || false;
      } else {
        const meta = this.gameState.manifestData?.entities?.[eData.name];
        if (meta && cell) {
          // Pass full state for new entity creation
          entity = new Entity(meta, owner, this.gameState, cell, {
            id: eData.id,
            ...(eData.state || {}),
            health: eData.state?.health ?? eData.health,
            actionPoints: eData.state?.actionPoints ?? eData.actionPoints,
            facing: eData.facing || 'E',
            active: eData.active !== false,
            destroyed: eData.destroyed || false
          });
          this.gameState.entities.push(entity);
        }
      }
    }

    // 3. Restore Cell Resources - start from initialState and apply removals up to this snapshot
    if (this.gameState.hexGrid && this.gameState.hexGrid.cells && this.replayData.initialState?.cellResources) {
      // First, restore all initial resources
      for (const cell of this.gameState.hexGrid.cells.values()) {
        const key = `${cell.q},${cell.r}`;
        if (this.replayData.initialState.cellResources[key]) {
          cell.resource = structuredClone(this.replayData.initialState.cellResources[key]);
        } else if (cell.resource) {
          delete cell.resource;
        }
      }
      // Then apply removals from all snapshots up to current index
      for (let i = 0; i <= index; i++) {
        const snap = this.replayData.snapshots[i];
        if (snap.removedResources) {
          for (const key of Object.keys(snap.removedResources)) {
            const cell = this.gameState.hexGrid.getCell(...key.split(',').map(Number));
            if (cell && cell.resource) {
              delete cell.resource;
            }
          }
        }
      }
    }

    // 4. Restore Fog of War
    if (snapshot.playerFog && Array.isArray(snapshot.playerFog)) {
      for (const fogData of snapshot.playerFog) {
        const player = this.gameState.players.find(p => p.id === fogData.id);
        if (player) {
          player.exploredCells = new Set(fogData.exploredCells || []);
          player.visibleCells = new Set(fogData.visibleCells || []);
        }
      }
    }

    // 5. Update 3D Visuals
    buildCellResources(this.gameState);
    reconcileEntities(this.gameState);
    reconcileCellResources(this.gameState);
  }

  /**
   * Destroys the player and clears timers.
   */
  destroy() {
    this.pause();
    this.replayData = null;
    this.gameState = null;
    this.onUpdateUI = null;
  }

  _startTimer() {
    this._clearTimer();
    const delay = Math.max(50, Math.round(600 / this.speed));
    this.timer = setInterval(() => {
      if (this.currentIndex >= this.totalSnapshots - 1) {
        this.pause();
      } else {
        try {
          this.stepForward();
        } catch (err) {
          console.error('[ReplayPlayer] Error during stepForward:', err);
          this.pause();
        }
      }
    }, delay);
  }

  _clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  _notifyUI() {
    if (typeof this.onUpdateUI === 'function') {
      this.onUpdateUI({
        index: this.currentIndex,
        total: this.totalSnapshots,
        snapshot: this.currentSnapshot,
        isPlaying: this.isPlaying,
        speed: this.speed
      });
    }
  }
}

/**
 * Triggers a browser file download of the replay as a formatted JSON file.
 * @param {Object} replayData
 */
export function exportReplayToJSON(replayData) {
  if (!replayData) return;
  const jsonStr = JSON.stringify(replayData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date(replayData.timestamp || Date.now()).toISOString().replace(/[:.]/g, '-');
  a.href = url;
  a.download = `empires-replay-${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Delay revoking the URL to ensure the download starts
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Reads and parses a replay JSON file selected by the user.
 * @param {File} file
 * @returns {Promise<Object>}
 */
export function readReplayFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('No file provided.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data.initialState || !Array.isArray(data.snapshots)) {
          reject(new Error('Invalid replay JSON format: missing initialState or snapshots.'));
          return;
        }
        resolve(data);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
