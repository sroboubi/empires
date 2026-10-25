import { saveReplay } from './saveManager.js';
import Entity from './entity.js';
import { reconcileEntities, reconcileCellResources, buildCellResources } from './renderer.js';

/**
 * ReplayRecorder — Records lightweight per-action dynamic state snapshots
 * during an active game session without duplicating static hex terrain meshes.
 */
export class ReplayRecorder {
  constructor() {
    this.active = false;
    this.replayData = null;
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

    this.replayData = {
      id,
      name,
      timestamp,
      settings: JSON.parse(JSON.stringify(settings || {})),
      initialState: {
        cells: gameState.hexGrid ? gameState.hexGrid.getCellsObject() : {},
        mapSize: settings?.mapSize || 15,
        players: gameState.players.map(p => p.toJSON()),
        entities: gameState.entities.map(e => e.toJSON()),
        activePlayerIndex: gameState.activePlayerIndex,
        currentRound: gameState.currentRound
      },
      snapshots: []
    };

    this.active = true;
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

    // Defensive backfill: ensure initialState has full cells, players, and entities
    if (this.replayData?.initialState) {
      if ((!this.replayData.initialState.cells || Object.keys(this.replayData.initialState.cells).length === 0) && gameState.hexGrid) {
        this.replayData.initialState.cells = gameState.hexGrid.getCellsObject();
      }
      if ((!this.replayData.initialState.players || this.replayData.initialState.players.length === 0) && gameState.players?.length > 0) {
        this.replayData.initialState.players = gameState.players.map(p => p.toJSON());
      }
      if ((!this.replayData.initialState.entities || this.replayData.initialState.entities.length === 0) && gameState.entities?.length > 0) {
        this.replayData.initialState.entities = gameState.entities.map(e => e.toJSON());
      }
    }

    // Capture current cell resources (only coordinates and basic resource info)
    const cellResources = {};
    if (gameState.hexGrid && gameState.hexGrid.cells) {
      for (const cell of gameState.hexGrid.cells.values()) {
        if (cell.resource) {
          cellResources[`${cell.q},${cell.r}`] = {
            name: cell.resource.name,
            kind: cell.resource.kind,
            quantity: cell.resource.quantity,
            items: cell.resource.items || []
          };
        }
      }
    }

    const snapshot = {
      index: this.replayData.snapshots.length,
      timestamp: Date.now(),
      label: label || 'Action',
      currentRound: gameState.currentRound,
      activePlayerIndex: gameState.activePlayerIndex,
      players: gameState.players.map(p => ({
        id: p.id,
        name: p.name,
        color: p.color,
        resources: { ...(p.resources || {}) },
        orders: p.orders,
        maxOrders: p.maxOrders,
        score: { ...(p.score || {}) }
      })),
      entities: gameState.entities.map(e => ({
        id: e.id,
        name: e.name,
        ownerId: e.owner ? e.owner.id : null,
        q: e.q,
        r: e.r,
        health: e.health,
        maxHealth: e.maxHealth,
        actionPoints: e.actionPoints,
        maxActionPoints: e.maxActionPoints,
        facing: e.facing || 'E',
        active: e.active !== false,
        destroyed: !!e.destroyed
      })),
      cellResources
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

  /**
   * Persists the current replay data to IndexedDB.
   * @returns {Promise<void>}
   */
  async saveToIndexedDB() {
    if (!this.hasData()) return;
    try {
      await saveReplay(this.replayData);
      console.debug(`[ReplayRecorder] Saved replay "${this.replayData.id}" (${this.replayData.snapshots.length} snapshots) to IndexedDB.`);
    } catch (err) {
      console.error('[ReplayRecorder] Failed to save replay to IndexedDB:', err);
    }
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

    this.gameState.currentRound = snapshot.currentRound;
    this.gameState.activePlayerIndex = snapshot.activePlayerIndex;

    // 1. Restore Player stats (resources, orders, score)
    if (snapshot.players && Array.isArray(snapshot.players)) {
      for (const pData of snapshot.players) {
        const player = this.gameState.players.find(p => p.id === pData.id);
        if (player) {
          player.resources = { ...(pData.resources || {}) };
          player.orders = pData.orders;
          if (pData.maxOrders !== undefined) player.maxOrders = pData.maxOrders;
          if (pData.score) player.score = { ...(pData.score || {}) };
        }
      }
    }

    // 2. Restore Entities
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
        entity.health = eData.health;
        entity.state.health = eData.health;
        entity.actionPoints = eData.actionPoints;
        entity.state.actionPoints = eData.actionPoints;
        entity.facing = eData.facing || 'E';
        entity.active = eData.active !== false;
        entity.destroyed = eData.destroyed || false;
      } else {
        const meta = this.gameState.manifestData?.entities?.[eData.name];
        if (meta && cell) {
          entity = new Entity(meta, owner, this.gameState, cell, {
            id: eData.id,
            health: eData.health,
            actionPoints: eData.actionPoints,
            facing: eData.facing || 'E',
            active: eData.active !== false,
            destroyed: eData.destroyed || false
          });
          this.gameState.entities.push(entity);
        }
      }
    }

    // 3. Restore Cell Resources (and rebuild InstancedMesh if changed)
    let resourcesChanged = false;
    if (snapshot.cellResources && this.gameState.hexGrid && this.gameState.hexGrid.cells) {
      const currentKeys = Object.keys(snapshot.cellResources).sort().join(';');
      if (currentKeys !== this.lastCellResourcesKey) {
        resourcesChanged = true;
        this.lastCellResourcesKey = currentKeys;
      }

      for (const cell of this.gameState.hexGrid.cells.values()) {
        const key = `${cell.q},${cell.r}`;
        if (snapshot.cellResources[key]) {
          cell.resource = { ...snapshot.cellResources[key] };
        } else if (cell.resource) {
          delete cell.resource;
        }
      }
    }

    // 4. Update 3D Visuals
    if (resourcesChanged) {
      buildCellResources(this.gameState);
    }
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
        this.stepForward();
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
  URL.revokeObjectURL(url);
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
