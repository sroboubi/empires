import { GameState } from './gameState.js';
import { CONFIG } from './config.js';
import { showToast } from './utils.js';
import {
  initRenderer,
  drawGrid,
  updateHexFog,
  setMapCameraLimits,
  highlightPathCells,
  clearPathHighlight,
  pickHexCell,
  setEntitySelectionHighlight,
  clearEntitySelectionHighlight,
  preloadModels,
  reconcileEntities,
  clearEntityMeshes,
  buildCellResources,
  reconcileCellResources,
  focusCameraOnEntities,
  setTimeOfDay
} from './renderer.js';
import { loadGameManifest } from './manifestLoader.js';
import { HexGrid } from './hexGrid.js';
import { collectResourceModelEntries } from './resources.js';
import { audio } from './audio.js';
import { saveGame, loadGame, pruneAutoSaves } from './saveManager.js';
import { Player } from './player.js';
import { setUiCallbacks } from './ui/callbacks.js';
import { updatePlayersUI } from './ui/playersList.js';
import { showContextMenu, hideContextMenu, showPlayerContextMenu, hidePlayerContextMenu } from './ui/contextMenu.js';
import { openChatModal, closeChatModal, sendChatMessage } from './ui/chat.js';
import { onMouseMove as handleCellHover } from './ui/cellInspector.js';
import { showVictoryModal, closeVictoryModal } from './ui/victoryModal.js';
import { openSetupModal, closeSetupModal, loadAiDefinitions, collectSetupSettings } from './ui/setup.js';
import { openSaveLoadModal, closeSaveLoadModal, renderSavesList } from './ui/saveLoad.js';
import { ReplayRecorder, ReplayPlayer, exportReplayToJSON, readReplayFile } from './replayManager.js';

let gameState;
let manifestData;
let defaultSettings;
let currentGameSettings = null;
let replayRecorder = new ReplayRecorder();
let replayPlayer = null;
let isReplayMode = false;

const mouse = { x: 0, y: 0 };
let selectedEntity = null;
let pointerDownPos = { x: 0, y: 0 };
let pointerDownTime = 0;

// Local setup state before starting game

/**
 * Initializes the application.
 */
async function init() {
  try {
    // 1. Load game definitions and default settings
    manifestData = await loadGameManifest();
    defaultSettings = manifestData.defaultSettings;

    // Audio: hand the manifest to the SFX manager (file names are config-driven)
    // and initialize the Web Audio context (unlocked on first user gesture).
    audio.setManifest(manifestData);
    audio.init();

    // 2. Initialize 3D Renderer and preload models
    const canvas = document.getElementById('game-canvas');
    initRenderer(canvas);
    await preloadModels({ ...manifestData.entities, ...collectResourceModelEntries(manifestData) });

    // 3. Setup Event Listeners

    // Register UI callbacks: ui/ modules call these for game actions.
    // This keeps the dependency direction one-way (ui imports game, never reverse).
    setUiCallbacks({
      onPlayerContextMenu: (x, y, player) => showPlayerContextMenu(x, y, player),
      doContextAction: (action, targetCell, targetEntity, gs) => doContextMenuAction(action, targetCell, targetEntity, gs),
      clearPathHighlight: () => clearPathHighlight(),
      highlightPathCells: (cells) => highlightPathCells(cells),
      onLoadGame: (name) => doLoadGame(name),
      onSaveGame: (name, isAuto) => doSaveGame(name, isAuto),
    });
    window.addEventListener('mousemove', (e) => handleCellHover(e, gameState, mouse, selectedEntity));

    window.addEventListener('pointerdown', (e) => {
      pointerDownPos = { x: e.clientX, y: e.clientY };
      pointerDownTime = Date.now();
    });

    window.addEventListener('pointerup', (e) => {
      if (e.target.closest('.glass-panel') || e.target.closest('.btn') || e.target.closest('.modal-overlay')) return;

      const dx = e.clientX - pointerDownPos.x;
      const dy = e.clientY - pointerDownPos.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const duration = Date.now() - pointerDownTime;

      // Threshold < 5px and < 500ms counts as click
      if (distance < 5 && duration < 500) {
        if (e.button === 0) {
          handleLeftClick(e);
        } else if (e.button === 2) {
          handleRightClick(e);
        }
      }
    });

    window.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('click', (e) => {
      if (!e.target.closest('#entity-context-menu')) {
        hideContextMenu();
      }
      if (!e.target.closest('#player-context-menu')) {
        hidePlayerContextMenu();
      }
    });

    // UI click sound for every button press (config-driven file, manifest sfx.ui.click).
    window.addEventListener('click', (e) => {
      if (e.target.closest('button')) {
        audio.playUi('click');
      }
    });

    window.addEventListener('keydown', (e) => {
      if (isReplayMode) {
        if (e.key === ' ' || e.code === 'Space') {
          e.preventDefault();
          replayPlayer?.togglePlay();
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          replayPlayer?.stepForward();
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          replayPlayer?.stepBackward();
        } else if (e.key === 'Home') {
          e.preventDefault();
          replayPlayer?.first();
        } else if (e.key === 'End') {
          e.preventDefault();
          replayPlayer?.last();
        }
        return;
      }

      if (e.key === 'Escape') {
        hideContextMenu();
        hidePlayerContextMenu();
        deselectEntity();
        closeSaveLoadModal();
        closeProfileModal();
        closeVictoryModal();
        closeChatModal();
        if (gameState) {
          closeSetupModal();
        }
      }
    });

    // Control buttons
    document.getElementById('btn-save-game').addEventListener('click', () => openSaveLoadModal('save'));
    document.getElementById('btn-load-game').addEventListener('click', () => openSaveLoadModal('load'));
    document.getElementById('btn-export-game').addEventListener('click', () => {
      if (gameState?.replayRecorder?.hasData()) {
        exportReplayToJSON(gameState.replayRecorder.getReplayData());
        showToast('Replay exported successfully!');
      } else {
        showToast('No replay data recorded for the current game.', true);
      }
    });

    // Replay Mode file selector (only used when CONFIG.REPLAY_MODE is true)
    const replayModeFileInput = document.getElementById('replay-mode-file-input');
    const btnReplayModeSelect = document.getElementById('btn-replay-mode-select');
    if (btnReplayModeSelect && replayModeFileInput) {
      btnReplayModeSelect.addEventListener('click', () => {
        replayModeFileInput.value = '';
        replayModeFileInput.click();
      });
      replayModeFileInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          const replayData = await readReplayFile(file);
          document.getElementById('replay-mode-overlay').classList.remove('active');
          await startReplayMode(replayData);
        } catch (err) {
          console.error('Failed to load replay file:', err);
          showToast(`Failed to load replay: ${err.message}`, true);
        }
      });
    }

    // Replay Floating Bar Controls
    document.getElementById('replay-btn-first').addEventListener('click', () => replayPlayer?.first());
    document.getElementById('replay-btn-prev').addEventListener('click', () => replayPlayer?.stepBackward());
    document.getElementById('replay-btn-play').addEventListener('click', () => replayPlayer?.togglePlay());
    document.getElementById('replay-btn-next').addEventListener('click', () => replayPlayer?.stepForward());
    document.getElementById('replay-btn-last').addEventListener('click', () => replayPlayer?.last());

    document.getElementById('replay-scrubber').addEventListener('input', (e) => {
      if (replayPlayer) {
        replayPlayer.pause();
        replayPlayer.goTo(parseInt(e.target.value, 10));
      }
    });

    document.getElementById('replay-speed-select').addEventListener('change', (e) => {
      if (replayPlayer) {
        replayPlayer.setSpeed(parseFloat(e.target.value));
      }
    });

    // Replay fog toggle: on = show the world from the current snapshot's
    // active player's point of view (their restored fog); off = full map.
    document.getElementById('replay-fog-toggle').addEventListener('change', (e) => {
      CONFIG.SHOW_ALL = !e.target.checked;
      updateHexFog(gameState);
      reconcileEntities(gameState);
      reconcileCellResources(gameState);
    });

    // Audio mute toggle
    const muteBtn = document.getElementById('btn-mute');
    const renderMuteIcon = () => { muteBtn.textContent = audio.muted ? '🔇' : '🔊'; };
    muteBtn.addEventListener('click', () => {
      audio.toggleMute();
      renderMuteIcon();
      showToast(audio.muted ? 'Audio muted' : 'Audio unmuted');
    });
    renderMuteIcon();
    document.getElementById('btn-next-turn').addEventListener('click', nextTurn);

    // Modal UI buttons
    document.getElementById('btn-start-game').addEventListener('click', handleStartGameClicked);
    document.getElementById('btn-add-player').addEventListener('click', addSetupPlayerRow);
    document.getElementById('btn-add-starting-unit').addEventListener('click', addSetupUnitRow);
    document.getElementById('btn-close-setup').addEventListener('click', closeSetupModal);
    document.getElementById('btn-close-saveload').addEventListener('click', closeSaveLoadModal);
    document.getElementById('btn-close-profile').addEventListener('click', closeProfileModal);
    document.getElementById('btn-do-manual-save').addEventListener('click', handleManualSaveClicked);
    document.getElementById('btn-victory-close').addEventListener('click', closeVictoryModal);

    // Diplomatic Chat & Player Context Menu UI listeners
    const btnPlayerChat = document.getElementById('btn-player-context-chat');
    if (btnPlayerChat) {
      btnPlayerChat.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const targetAi = playerContextMenuTarget;
        hidePlayerContextMenu();

        if (!targetAi) return;

        const activeP = gameState.activePlayer;
        if (!activeP || activeP.isAI) {
          showToast('You can only initiate chat during your turn.', true);
          return;
        }

        if (activeP.orders < 1) {
          showToast('Not enough orders to initiate chat (costs 1 order).', true);
          return;
        }

        // Deduct 1 order
        activeP.orders -= 1;
        activeP.addHistoryEntry(gameState.currentRound, {
          category: 'action',
          details: `Initiated diplomatic chat with ${targetAi.name} (costs 1 order)`
        });

        updatePlayersUI(gameState);
        openChatModal(activeP, targetAi);
      });
    }

    const btnCloseChat = document.getElementById('btn-close-chat');
    if (btnCloseChat) {
      btnCloseChat.addEventListener('click', () => closeChatModal());
    }

    const btnSendChat = document.getElementById('btn-send-chat');
    if (btnSendChat) {
      btnSendChat.addEventListener('click', () => sendChatMessage());
    }

    const chatInput = document.getElementById('chat-message-input');
    if (chatInput) {
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendChatMessage();
        }
      });
    }

    // Barbarian setup UI bindings
    setupBarbarianUI();

    // AI setup UI bindings (Phase 23): load definitions, then build
    // provider keys + controller/leader selectors.
    loadAiDefinitions().then(() => {
      setupAiConfigUI();
      renderSetupPlayers();
    }).catch(e => console.warn('Failed to load AI definitions:', e));

    // Open Setup Modal automatically on initial load, or the replay file
    // selector when REPLAY_MODE is enabled.
    if (CONFIG.REPLAY_MODE) {
      document.getElementById('replay-mode-overlay').classList.add('active');
    } else {
      openSetupModal(false);
    }

    console.log('Game initialized successfully.');
  } catch (err) {
    console.error('Fatal initialization error:', err);
    alert('Failed to load game config: ' + err.message);
  }
}

/* ==========================================================================
   SETUP MODAL & GAME INITIALIZATION LOGIC
   ========================================================================== */

function handleStartGameClicked() {
  const settings = collectSetupSettings(defaultSettings);
  if (!settings) return;
  startNewGame({ ...defaultSettings, ...settings });
}

function startNewGame(settings) {
  currentGameSettings = settings;
  deselectEntity();
  hideContextMenu();
  clearEntityMeshes();

  const button = document.getElementById('btn-next-turn');
  button.disabled = false;
  button.textContent = 'Next Turn';

  gameState = new GameState();
  gameState.generateMap(settings.mapSize, manifestData.terrains, manifestData);

  // The browser drives turns: pass nextTurn as the continuation so the
  // initial AI player's turn runs and chains exactly as before.
  gameState.initializeManifest(manifestData, settings, () => nextTurn());

  // Start recording AFTER initializeManifest so initialState contains the
  // generated players and starting units (otherwise owners/entities are lost).
  // AI turns are async, so this still runs before the first AI action.
  if (CONFIG.RECORD_GAME) {
    replayRecorder = new ReplayRecorder();
    gameState.replayRecorder = replayRecorder;
    replayRecorder.start(gameState, settings);
  } else {
    gameState.replayRecorder = null;
  }

  setMapCameraLimits(settings.mapSize);
  drawGrid(gameState);
  reconcileEntities(gameState);
  buildCellResources(gameState);
  updatePlayersUI(gameState);

  // Focus camera on center of mass of active player's entities
  if (gameState.activePlayer && gameState.entities.length > 0) {
    const playerEntities = gameState.activePlayer.getEntities(gameState);
    if (playerEntities.length > 0) {
      focusCameraOnEntities(playerEntities);
    }
  }

  document.getElementById('inspect-panel').classList.remove('active');
  showToast('New game started!');
}

/* ==========================================================================
   SAVE / LOAD MODAL LOGIC
   ========================================================================== */

async function handleManualSaveClicked() {
  const input = document.getElementById('manual-save-name');
  const name = input.value.trim();

  if (!name) {
    showToast('Enter a save name!', true);
    return;
  }

  await doSaveGame(name, false);
  await renderSavesList();
  showToast(`Game saved as "${name}"`);
}

async function doSaveGame(name, isAuto = false) {
  if (!gameState) return;

  try {
    const serializedData = gameState.serialize();
    await saveGame({
      name: name,
      turnNumber: gameState.currentRound,
      auto: isAuto,
      data: serializedData
    });

    if (isAuto && currentGameSettings?.autoSave?.maxAutoSaves) {
      await pruneAutoSaves(currentGameSettings.autoSave.maxAutoSaves);
    }

  } catch (err) {
    console.error('Save failed:', err);
    showToast('Failed to save game.', true);
  }
}

async function doLoadGame(saveName) {
  try {
    const record = await loadGame(saveName);
    if (!record) {
      showToast('Save record not found!', true);
      return;
    }

    deselectEntity();
    hideContextMenu();
    clearEntityMeshes();

    gameState = new GameState();
    gameState.manifestData = manifestData;
    gameState.deserialize(record.data);

    // Restart recording after a load: deserialize() builds a fresh GameState
    // whose replayRecorder is null, so without this no further actions record.
    if (CONFIG.RECORD_GAME) {
      replayRecorder = new ReplayRecorder();
      gameState.replayRecorder = replayRecorder;
      replayRecorder.start(gameState, gameState.settings || {});
    }

    if (gameState.hexGrid?.radius) setMapCameraLimits(gameState.hexGrid.radius);
    drawGrid(gameState);
    reconcileEntities(gameState);
    buildCellResources(gameState);
    updatePlayersUI(gameState);

    // Focus camera on center of mass of active player's entities
    if (gameState.activePlayer && gameState.entities.length > 0) {
      const playerEntities = gameState.activePlayer.getEntities(gameState);
      if (playerEntities.length > 0) {
        focusCameraOnEntities(playerEntities);
      }
    }

    closeSaveLoadModal();
    showToast(`Loaded save: ${record.name}`);
  } catch (err) {
    console.error('Load failed:', err);
    showToast('Failed to load save.', true);
  }
}

/* ==========================================================================
   REPLAY MODE CONTROLLER
   ========================================================================== */

/**
 * Starts Replay mode using parsed replay data.
 * @param {Object} replayData
 */
async function startReplayMode(replayData) {
  if (!replayData || !replayData.initialState || !Array.isArray(replayData.snapshots)) {
    showToast('Invalid replay file format: missing initialState or snapshots.', true);
    return;
  }

  isReplayMode = true;
  CONFIG.SHOW_ALL = true;

  closeSetupModal();
  deselectEntity();
  hideContextMenu();
  clearEntityMeshes();

  // Hide normal gameplay controls entirely while in replay mode
  ['btn-save-game', 'btn-load-game', 'btn-export-game', 'btn-next-turn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.style.display = 'none';
  });
  document.getElementById('replay-controls-bar').style.display = 'flex';
  const fogToggle = document.getElementById('replay-fog-toggle');
  if (fogToggle) fogToggle.checked = false;

  // Instantiate GameState for replay from initial state
  gameState = new GameState();
  gameState.settings = replayData.settings || {};
  gameState.manifestData = manifestData;

  const hasCells = replayData.initialState?.cells && Object.keys(replayData.initialState.cells).length > 0;
  if (hasCells) {
    gameState.hexGrid = HexGrid.fromCells(replayData.initialState.cells);
  } else {
    console.warn('[Replay] initialState.cells is empty, generating fallback map');
    gameState.generateMap(replayData.settings?.mapSize || 15, manifestData.terrains, manifestData);
  }

  // Fallback for replays recorded before initialState captured players:
  // derive the player list from the first snapshot that has it.
  let initialPlayers = replayData.initialState?.players || [];
  if (initialPlayers.length === 0) {
    const firstWithPlayers = replayData.snapshots.find(s => Array.isArray(s.players) && s.players.length > 0);
    if (firstWithPlayers) {
      console.warn('[Replay] initialState.players is empty; using first snapshot players as fallback');
      initialPlayers = firstWithPlayers.players;
    }
  }
  gameState.players = initialPlayers.map(p => Player.fromJSON(p, gameState, true));
  gameState.entities = [];

  setMapCameraLimits(replayData.settings?.mapSize || gameState.hexGrid?.radius || 15);
  drawGrid(gameState);
  buildCellResources(gameState);
  updateHexFog(gameState);

  if (replayPlayer) {
    replayPlayer.destroy();
  }

  const scrubber = document.getElementById('replay-scrubber');
  scrubber.min = 0;
  scrubber.max = Math.max(0, replayData.snapshots.length - 1);
  scrubber.value = 0;

  replayPlayer = new ReplayPlayer(replayData, gameState, updateReplayUI);
  replayPlayer.goTo(0);

  if (gameState.entities.length > 0) {
    focusCameraOnEntities(gameState.entities);
  }

  // Set initial time of day from replay data
  if (replayData.initialState?.timeOfDay !== undefined) {
    setTimeOfDay(replayData.initialState.timeOfDay);
  }

  showToast(`Replay loaded (${replayData.snapshots.length} actions)`, false, 3500);
}

function updateReplayUI(state) {
  const scrubber = document.getElementById('replay-scrubber');
  if (scrubber) {
    scrubber.value = state.index;
    scrubber.max = Math.max(0, state.total - 1);
  }

  const stepInfo = document.getElementById('replay-step-info');
  if (stepInfo) {
    const round = state.snapshot ? state.snapshot.currentRound : 1;
    stepInfo.textContent = `Round ${round} (${state.index + 1}/${state.total})`;
  }

  const actionDesc = document.getElementById('replay-action-desc');
  if (actionDesc) {
    actionDesc.textContent = state.snapshot ? state.snapshot.label : '';
    actionDesc.title = state.snapshot ? state.snapshot.label : '';
  }

  const playBtn = document.getElementById('replay-btn-play');
  if (playBtn) {
    playBtn.textContent = state.isPlaying ? '⏸ Pause' : '▶ Play';
  }

  updatePlayersUI(gameState);
}

// exitReplayMode removed - users refresh the page to exit replay mode

/* ==========================================================================
   TURN LIFECYCLE & AUTO-SAVE CHECK
   ========================================================================== */

/**
 * Next Turn: triggers endTurn on gameState, cycling to next player turn and updating Fog of War.
 */
export async function nextTurn() {
  if (isReplayMode) return;
  if (gameState.gameOver) {
    showToast('Game is over. Start a new game.', true);
    return;
  }

  const button = document.getElementById('btn-next-turn');
  button.disabled = true;
  button.textContent = 'Running AI...';

  deselectEntity();
  hideContextMenu();

  // this updates the gameState.activePlayer and increments the round if needed.
  // The browser drives turn advancement: nextTurn is the continuation
  // that runs when an AI player's turn settles (see Player.step).
  await gameState.endTurn(() => nextTurn());

  // enable the button again if the next player is human
  if (gameState.activePlayer && !gameState.activePlayer.isAI) {
    button.disabled = false;
    button.textContent = 'Next Turn';
  }

  updateHexFog(gameState);
  reconcileEntities(gameState);
  reconcileCellResources(gameState);
  updatePlayersUI(gameState);

  // Focus camera on center of mass of active player's entities
  if (gameState.activePlayer && gameState.entities.length > 0 &&
    ((gameState.activePlayer.isAI && CONFIG.PAN_CAMERA_ON_AI_TURN) ||
      (!gameState.activePlayer.isAI && CONFIG.PAN_CAMERA_ON_HUMAN_TURN))) {
    const playerEntities = gameState.activePlayer.getEntities(gameState);
    if (playerEntities.length > 0) {
      focusCameraOnEntities(playerEntities);
    }
  }

  showToast(`Turn passed to ${gameState.activePlayer ? gameState.activePlayer.name : ''} (Round ${gameState.currentRound})`);

  // Chime when the turn comes back to a human player.
  if (gameState.activePlayer && !gameState.activePlayer.isAI) {
    audio.playUi('turn');
  }

  // Check auto-save condition
  checkAutoSave();

  // Check win conditions (pure check on GameState; render the modal here)
  const win = gameState.checkWinConditions();
  if (win) showVictoryModal(gameState, win.winner, win.reasons);
}

async function checkAutoSave() {
  const autoSaveConfig = currentGameSettings?.autoSave;
  if (!autoSaveConfig || !autoSaveConfig.enabled) return;

  const interval = autoSaveConfig.intervalTurns || 5;
  // Trigger auto-save at start of round interval for player 1
  if (gameState.currentRound > 1 && gameState.activePlayerIndex === 0 && (gameState.currentRound % interval === 0)) {
    const autoSaveName = `Auto-Save Round ${gameState.currentRound}`;
    await doSaveGame(autoSaveName, true);
    showToast(`Auto-saved (${autoSaveName})`);
  }
}

/* ==========================================================================
   INTERACTION & SELECTION HANDLERS
   ========================================================================== */

function handleLeftClick(event) {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  const hovered = pickHexCell(mouse, gameState);
  hideContextMenu();

  if (!hovered) {
    deselectEntity();
    return;
  }

  const activePlayer = gameState.activePlayer;
  if (!activePlayer || activePlayer.isAI) {
    deselectEntity();
    return;
  }

  if (!activePlayer.isVisible(hovered.q, hovered.r)) {
    deselectEntity();
    return;
  }

  const entity = gameState.getEntityAt(hovered.q, hovered.r);
  if (entity && entity.owner && entity.owner.id === activePlayer.id) {
    selectEntity(entity);
  } else {
    deselectEntity();
  }
}

function handleRightClick(event) {
  event.preventDefault();

  if (isReplayMode) {
    hideContextMenu();
    return;
  }

  if (!selectedEntity) {
    hideContextMenu();
    return;
  }

  const activePlayer = gameState.activePlayer;
  if (!activePlayer || activePlayer.isAI || !selectedEntity.owner || selectedEntity.owner.id !== activePlayer.id) {
    hideContextMenu();
    return;
  }

  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  const hovered = pickHexCell(mouse, gameState);
  if (!hovered) {
    hideContextMenu();
    return;
  }

  const targetCell = gameState.hexGrid.cells.get(`${hovered.q},${hovered.r}`);
  const targetEntity = gameState.getEntityAt(hovered.q, hovered.r);

  const candidateActions = selectedEntity.getActions();
  showContextMenu(event.clientX, event.clientY, selectedEntity, candidateActions, targetCell, targetEntity);
}

function selectEntity(entity) {
  selectedEntity = entity;
  audio.playEntitySfx(entity, 'select');
  const cell = entity.cell || gameState.hexGrid.cells.get(`${entity.q},${entity.r}`);

  if (cell) {
    const { x, z } = HexGrid.axialToPixel(cell.q, cell.r);
    setEntitySelectionHighlight(x, cell.terrain ? cell.terrain.height : 1.0, z);
  }

  showToast(`Selected ${entity.name.toUpperCase()}`);
}

function deselectEntity() {
  if (selectedEntity) {
    selectedEntity = null;
    clearEntitySelectionHighlight();
    clearPathHighlight();
    const moveRow = document.getElementById('inspect-movement-row');
    if (moveRow) moveRow.style.display = 'none';
  }
}


/**
 * Execute a context menu action (game logic).
 * Called via the UI callback registry from ui/contextMenu.js.
 */
function doContextMenuAction(action, targetCell, targetEntity, gameState, checkReason) {
  const success = action.do ? action.do(targetCell, targetEntity) : false;

  if (success) {
    audio.playEntitySfx(selectedEntity, 'action', action.name);
    showToast(checkReason || `Executed ${action.name}`);
    if (gameState?.replayRecorder?.isRecording()) {
      const loc = targetCell ? ` at (${targetCell.q}, ${targetCell.r})` : '';
      gameState.replayRecorder.recordSnapshot(gameState, `${selectedEntity.name} ${action.name}${loc}`);
    }
  } else {
    showToast(`Failed to execute ${action.name}`, true);
  }

  updateHexFog(gameState);
  reconcileEntities(gameState);
  reconcileCellResources(gameState);
  updatePlayersUI(gameState);

  if (selectedEntity && !gameState.entities.includes(selectedEntity)) {
    deselectEntity();
  } else if (selectedEntity) {
    selectEntity(selectedEntity);
  }
}

function closeProfileModal() {
  const overlay = document.getElementById('profile-modal-overlay');
  if (overlay) overlay.classList.remove('active');
}

window.addEventListener('DOMContentLoaded', init);