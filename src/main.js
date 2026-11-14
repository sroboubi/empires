import { GameState } from './gameState.js';
import { CONFIG } from './config.js';
import { showToast, displayNum, formatResourceBundle } from './utils.js';
import {
  initRenderer,
  drawGrid,
  updateHexFog,
  setMapCameraLimits,
  highlightCell,
  highlightPathCells,
  clearPathHighlight,
  showExclusionZone,
  clearExclusionZone,
  showZoneOfControl,
  clearZoneOfControl,
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
import { saveGame, loadGame, listSaves, deleteSave, pruneAutoSaves } from './saveManager.js';
import { Player } from './player.js';
import { ReplayRecorder, ReplayPlayer, exportReplayToJSON, readReplayFile } from './replayManager.js';

let gameState;
let manifestData;
let defaultSettings;
let currentGameSettings = null;
let replayRecorder = new ReplayRecorder();
let replayPlayer = null;
let isReplayMode = false;
let turnAdvanceInProgress = false; // H2: guards the turn ADVANCE (endTurn), not the turn itself — endTurn returns as soon as the AI turn is kicked off (startTurn is fire-and-forget), so this is only true for the brief advance window: advancing the player, round-end, win check, kickoff. A second call in that window (double click, stale continuation) does nothing. The long AI turn itself is guarded by the Next Turn button being disabled.
const HISTORY_ROUNDS_PER_PAGE = 5; // L9: history pagination page size

const mouse = { x: 0, y: 0 };
let selectedEntity = null;
let pointerDownPos = { x: 0, y: 0 };
let pointerDownTime = 0;

// Local setup state before starting game
let setupPlayers = [];
let setupStartingUnits = {};

/**
 * Called after an AI action completes. Handles replay recording, visibility
 * filtering, entity reconciliation, and UI refresh. Registered on gameState
 * Registered on gameState via the constructor; aiHelper delegates to it
 * via gameState.onActionDone().
 */
async function onActionDone(involvedCells = null, actionDesc = '') {
  if (!gameState) return;
  if (gameState?.replayRecorder?.isRecording()) {
    gameState.replayRecorder.recordSnapshot(gameState, actionDesc || 'AI action');
  }
  if (!CONFIG.SHOW_ALL && Array.isArray(involvedCells) && involvedCells.length > 0) {
    if (!involvedCells.some(cell => gameState.isVisibleToHuman(cell))) {
      console.debug("AI action done (no visible cells)");
      return;
    }
  }
  console.debug("AI action done (visible)");
  reconcileEntities(gameState);
  updatePlayersUI(gameState, { onContextMenu: showPlayerContextMenu });
  // L9: refresh fog after an AI action — the old code never called
  // updateHexFog here, so newly revealed cells stayed dark until the
  // next turn.
  updateHexFog(gameState);
  await new Promise(r => setTimeout(r, CONFIG.AI_ACTION_SLEEP ?? 0));
}

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
    window.addEventListener('mousemove', onMouseMove);

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

        // L9: replay mode offers Chat, and clicking it deducts an order
        // from the replay state. No actions in replay mode.
        if (isReplayMode) {
          showToast('Chat is not available in replay mode.', true);
          return;
        }

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

        updatePlayersUI(gameState, { onContextMenu: showPlayerContextMenu });
        openChatModal(activeP, targetAi, { isNewInitiation: true });
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

    const btnEndChat = document.getElementById('btn-end-chat');
    if (btnEndChat) {
      btnEndChat.addEventListener('click', () => handleEndChat());
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

    const btnToggleTrade = document.getElementById('btn-toggle-trade');
    if (btnToggleTrade) {
      btnToggleTrade.addEventListener('click', () => toggleTradeDrawer());
    }

    const btnCloseTradeDrawer = document.getElementById('btn-close-trade-drawer');
    if (btnCloseTradeDrawer) {
      btnCloseTradeDrawer.addEventListener('click', () => toggleTradeDrawer(false));
    }

    const btnTradeOneTime = document.getElementById('trade-tab-onetime');
    if (btnTradeOneTime) {
      btnTradeOneTime.addEventListener('click', () => {
        currentChatSession.tradeType = 'one_time';
        renderTradeDrawer();
      });
    }

    const btnTradePerTurn = document.getElementById('trade-tab-perturn');
    if (btnTradePerTurn) {
      btnTradePerTurn.addEventListener('click', () => {
        currentChatSession.tradeType = 'per_turn';
        renderTradeDrawer();
      });
    }

    const btnProposeTrade = document.getElementById('btn-propose-trade');
    if (btnProposeTrade) {
      btnProposeTrade.addEventListener('click', () => handleProposeTradeClicked());
    }

    // Barbarian setup UI bindings
    setupBarbarianUI();

    // AI setup UI bindings (Phase 23): load definitions, then build
    // provider keys + controller/leader selectors.
    // L8: disable START until the definitions load — clicking it early
    // silently turned AI players into humans (aiJson.controllers empty).
    const startBtn = document.getElementById('btn-start-game');
    if (startBtn) startBtn.disabled = true;
    loadAiDefinitions().then(() => {
      setupAiConfigUI();
      renderSetupPlayers();
      if (startBtn) startBtn.disabled = false;
    }).catch(e => {
      console.warn('Failed to load AI definitions:', e);
      if (startBtn) startBtn.disabled = false;
    });

    // Open Setup Modal automatically on initial load, or the replay file
    // selector when REPLAY_MODE is enabled.
    // First load is NOT closable: the flow is start a new game, then load
    // what you want from inside the game (Shahin, 2026-11-07).
    // TODO: consider adding a Load button to the setup modal itself, so a
    // save can be loaded on first load without starting a throwaway game.
    // Not implementing now (L4 revert, 2026-11-07).
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

function openSetupModal(canClose = true) {
  const overlay = document.getElementById('setup-modal-overlay');
  const closeBtn = document.getElementById('btn-close-setup');
  closeBtn.style.display = canClose ? 'block' : 'none';

  // Map size — L1: no hardcoded fallback; the value comes from
  // defaultSettings.json (mistakes.md rule 3). A missing field is a
  // config error, not something to paper over.
  if (!defaultSettings.mapSize) throw new Error('defaultSettings.json is missing mapSize');
  document.getElementById('setup-map-size').value = defaultSettings.mapSize;

  // Orders — L1: no hardcoded fallback; the value comes from
  // defaultSettings.json (mistakes.md rule 3). A missing field is a
  // config error, not something to paper over.
  const orders = defaultSettings.initialization?.orders;
  if (!orders) throw new Error('defaultSettings.json is missing initialization.orders');
  document.getElementById('setup-orders-max').value = orders.max;
  document.getElementById('setup-orders-perturn').value = orders.perTurn;

  // Players — L1: same, no hardcoded default players.
  if (!defaultSettings.players) throw new Error('defaultSettings.json is missing players');
  setupPlayers = JSON.parse(JSON.stringify(defaultSettings.players));
  renderSetupPlayers();

  // Resources
  renderSetupResources();

  // Units
  setupStartingUnits = { ...(defaultSettings.initialization?.startingUnits || {}) };
  populateUnitSelectOptions();
  renderSetupUnits();

  // Auto-Save — L1: no hardcoded fallback (see Orders above).
  const autoSave = defaultSettings.autoSave;
  if (!autoSave) throw new Error('defaultSettings.json is missing autoSave');
  document.getElementById('setup-autosave-enabled').checked = autoSave.enabled;
  document.getElementById('setup-autosave-interval').value = autoSave.intervalTurns;
  document.getElementById('setup-autosave-max').value = autoSave.maxAutoSaves;

  // Barbarian Settings — dynamically render horde sliders from defaultSettings.barbarians.horde
  const barbarians = defaultSettings.barbarians || null;
  const enabledCheckbox = document.getElementById('setup-barbarians-enabled');
  const collapsible = document.getElementById('setup-barbarian-collapsible');
  enabledCheckbox.checked = barbarians !== null && barbarians !== undefined;
  collapsible.classList.toggle('expanded', enabledCheckbox.checked);

  // Render one range-slider widget per horde unit key found in settings
  renderBarbarianHordeSliders(barbarians?.horde || {});
  updateAllRangeFills();
  // L1: barbarian numbers come from the config, not hardcoded fallbacks.
  document.getElementById('setup-barbarian-spawn-frequency').value = barbarians?.spawnFrequencyTurns ?? '';
  document.getElementById('setup-barbarian-max-number').value = barbarians?.maxNumber ?? '';
  document.getElementById('setup-barbarian-max-age').value = barbarians?.maxAge ?? '';

  // Win Conditions — L1: no hardcoded fallback (see Orders above).
  const winCondition = defaultSettings.winCondition;
  if (!winCondition) throw new Error('defaultSettings.json is missing winCondition');
  const absoluteEnabled = winCondition.absoluteScore !== undefined && winCondition.absoluteScore !== null;
  const relativeEnabled = winCondition.relativeScore !== undefined && winCondition.relativeScore !== null;
  document.getElementById('setup-win-absolute-enabled').checked = absoluteEnabled;
  document.getElementById('setup-win-absolute-value').value = winCondition.absoluteScore ?? '';
  document.getElementById('setup-win-absolute-value').disabled = !absoluteEnabled;
  document.getElementById('setup-win-relative-enabled').checked = relativeEnabled;
  document.getElementById('setup-win-relative-value').value = winCondition.relativeScore ?? '';
  document.getElementById('setup-win-relative-value').disabled = !relativeEnabled;

  // Add event listeners for win condition checkboxes
  document.getElementById('setup-win-absolute-enabled').addEventListener('change', (e) => {
    document.getElementById('setup-win-absolute-value').disabled = !e.target.checked;
  });
  document.getElementById('setup-win-relative-enabled').addEventListener('change', (e) => {
    document.getElementById('setup-win-relative-value').disabled = !e.target.checked;
  });

  // Initialize custom spinner buttons
  initNumberInputSpinners();

  overlay.classList.add('active');
}

function closeSetupModal() {
  document.getElementById('setup-modal-overlay').classList.remove('active');
}

function renderSetupPlayers() {
  const container = document.getElementById('setup-players-container');
  container.innerHTML = '';

  setupPlayers.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'dynamic-row';

    // Phase 23.2: controller dropdown (human or a controller from ai.json).
    // The picked key is stored explicitly on the player.
    const ctrlKey = p.controllerKey || 'human';
    const isAI = ctrlKey !== 'human';
    const ctrlOpts = `<option value="human"${!isAI ? ' selected' : ''}>Human</option>` +
      Object.keys(aiJson?.controllers || {}).map(k =>
        `<option value="${k}"${ctrlKey === k ? ' selected' : ''}>${k}</option>`).join('');

    // Phase 23.3: name is a text input for humans, a leader picker for AI.
    let nameField;
    if (isAI) {
      const leaderOpts = `<option value="" disabled${!leadersJson.some(l => l.name === p.name) ? ' selected' : ''}>Select leader…</option>` +
        leadersJson.map(l =>
          `<option value="${escapeHTML(l.name)}"${p.name === l.name ? ' selected' : ''}>${escapeHTML(l.name)}</option>`).join('');
      nameField = `<select name="leader" class="form-input leader-select" style="flex: 1;" title="${escapeHTML(leaderTitle(p.name))}">${leaderOpts}</select>`;
    } else {
      // L7: escape the name — a quote in it breaks the value attribute.
      nameField = `<input name="player-name" type="text" class="form-input" value="${escapeHTML(p.name)}" placeholder="Player Name" style="flex: 1;">`;
    }

    row.innerHTML = `
      <input name="player-color" type="color" value="${p.color}" title="Choose color">
      ${nameField}
      <select name="controller" class="form-input controller-select" style="max-width: 320px;" title="Controller">${ctrlOpts}</select>
      <button type="button" class="btn btn-danger btn-small" ${setupPlayers.length <= 1 ? 'disabled style="opacity:0.3;cursor:not-allowed;"' : ''}>✕</button>
    `;

    // Event listeners for fields
    const colorInput = row.querySelector('input[type="color"]');
    const nameInput = row.querySelector('input[type="text"]');
    const leaderSelect = row.querySelector('.leader-select');
    const ctrlSelect = row.querySelector('.controller-select');
    const removeBtn = row.querySelector('.btn-danger');

    colorInput.addEventListener('change', (e) => { p.color = e.target.value; });
    if (nameInput) {
      nameInput.addEventListener('input', (e) => { p.name = e.target.value; });
    }
    if (leaderSelect) {
      leaderSelect.addEventListener('change', (e) => {
        const leader = leadersJson.find(l => l.name === e.target.value);
        if (leader) {
          p.name = leader.name;
          leaderSelect.title = leaderTitle(leader.name);
        }
      });
    }
    ctrlSelect.addEventListener('change', (e) => {
      const key = e.target.value;
      p.controllerKey = key;
      if (key !== 'human') {
        // Default to first leader if current name isn't a leader
        const leader = leadersJson.find(l => l.name === p.name) || leadersJson[0];
        if (leader) p.name = leader.name;
      }
      renderSetupPlayers();
    });

    removeBtn.addEventListener('click', () => {
      if (setupPlayers.length > 1) {
        setupPlayers.splice(idx, 1);
        renderSetupPlayers();
      }
    });

    container.appendChild(row);
  });
}

function addSetupPlayerRow() {
  const palette = ['#ff4d4d', '#3399ff', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#e84393'];
  const newId = setupPlayers.length > 0 ? Math.max(...setupPlayers.map(p => p.id)) + 1 : 1;
  const color = palette[(newId - 1) % palette.length];
  setupPlayers.push({
    id: newId,
    name: `Player ${newId}`,
    color: color,
    controllerKey: 'human'
  });
  renderSetupPlayers();
}

function renderSetupResources() {
  const container = document.getElementById('setup-resources-container');
  container.innerHTML = '';
  for (const [res, val] of Object.entries(defaultSettings?.initialization?.startingResources || {})) {
    const box = document.createElement('div');
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '2px';

    box.innerHTML = `
      <span style="font-size: 11px; color: var(--text-muted); text-transform: uppercase;">${res}</span>
      <div class="number-input-wrapper" style="width: 100%;">
        <input type="number" id="res-val-${res}" class="form-input" value="${val}" min="0" style="padding: 4px 8px;">
        <div class="spinner-buttons">
          <button type="button" class="spinner-btn up" data-target="res-val-${res}">▲</button>
          <button type="button" class="spinner-btn down" data-target="res-val-${res}">▼</button>
        </div>
      </div>
    `;
    container.appendChild(box);
  };
  // Re-initialize spinners for dynamically added inputs
  initNumberInputSpinners();
}

function populateUnitSelectOptions() {
  const select = document.getElementById('setup-add-unit-select');
  select.innerHTML = '';
  if (!manifestData || !manifestData.entities) return;

  Object.keys(manifestData.entities).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name.toUpperCase();
    select.appendChild(opt);
  });
}

function renderSetupUnits() {
  const container = document.getElementById('setup-units-container');
  container.innerHTML = '';

  Object.entries(setupStartingUnits).forEach(([unitName, qty]) => {
    const row = document.createElement('div');
    row.className = 'dynamic-row';

    const inputId = `setup-unit-count-${unitName}`;
    row.innerHTML = `
      <strong style="font-size: 13px; text-transform: uppercase; flex: 1;">${unitName}</strong>
      <span style="font-size: 11px; color: var(--text-muted);">Count:</span>
      <div class="number-input-wrapper" style="width: 80px;">
        <input type="number" id="${inputId}" class="form-input" value="${qty}" min="1" style="padding: 4px 8px;">
        <div class="spinner-buttons">
          <button type="button" class="spinner-btn up" data-target="${inputId}">▲</button>
          <button type="button" class="spinner-btn down" data-target="${inputId}">▼</button>
        </div>
      </div>
      <button type="button" class="btn btn-danger btn-small">✕</button>
    `;

    const countInput = row.querySelector('input[type="number"]');
    const removeBtn = row.querySelector('.btn-danger');

    countInput.addEventListener('change', (e) => {
      const val = parseInt(e.target.value, 10);
      if (val > 0) {
        setupStartingUnits[unitName] = val;
      }
    });

    removeBtn.addEventListener('click', () => {
      delete setupStartingUnits[unitName];
      renderSetupUnits();
    });

    container.appendChild(row);
  });
  // Re-initialize spinners for dynamically added inputs
  initNumberInputSpinners();
}

function addSetupUnitRow() {
  const select = document.getElementById('setup-add-unit-select');
  const unitName = select.value;
  if (unitName && setupStartingUnits[unitName] === undefined) {
    setupStartingUnits[unitName] = 1;
    renderSetupUnits();
  }
}

/* --------------------------------------------------------------------------
   BARBARIAN SETUP UI: enable toggle, dynamic horde sliders, collapsible section
   --------------------------------------------------------------------------
   All horde unit sliders are generated dynamically from whatever keys exist
   in defaultSettings.barbarians.horde — no unit names are hardcoded here.
   -------------------------------------------------------------------------- */

/**
 * Derive a human-readable label from a camelCase unit name.
 * e.g. "barbarianChief" -> "Barbarian Chief", "barbarianPrincess" -> "Barbarian Princess"
 */
function hordeUnitLabel(unitName) {
  return unitName
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, s => s.toUpperCase())
    .trim();
}

/**
 * Returns the DOM id prefix used for a given horde unit key.
 * e.g. "barbarianChief" -> "setup-barbarian-barbarianChief"
 */
function hordeUnitIdPrefix(unitName) {
  return `setup-barbarian-${unitName}`;
}

/**
 * Renders one range-slider widget per horde unit in the horde container.
 * Called each time the setup modal is opened so sliders always reflect the
 * current defaultSettings. Event listeners are attached inline.
 * @param {Object} horde - e.g. { barbarian: {min,max}, barbarianChief: {min,max}, ... }
 */
function renderBarbarianHordeSliders(horde) {
  const container = document.getElementById('setup-barbarian-horde-container');
  if (!container) return;
  container.innerHTML = '';

  Object.entries(horde).forEach(([unitName, { min: defaultMin, max: defaultMax }]) => {
    const prefix = hordeUnitIdPrefix(unitName);
    const minId = `${prefix}-min`;
    const maxId = `${prefix}-max`;
    const fillId = `${prefix}-range-fill`;
    const minValId = `${minId}-val`;
    const maxValId = `${maxId}-val`;

    // Infer a sensible slider upper bound from the default max (at least 10)
    const sliderMax = Math.max(defaultMax * 3, 10);

    const group = document.createElement('div');
    group.className = 'form-group';
    group.innerHTML = `
      <label class="form-label">${hordeUnitLabel(unitName)} Horde (Min — Max)</label>
      <div class="range-slider" data-range-id="${unitName}">
        <div class="rs-track"></div>
        <div class="rs-range" id="${fillId}"></div>
        <input type="range" id="${minId}" min="0" max="${sliderMax}" value="${defaultMin}" step="1">
        <input type="range" id="${maxId}" min="0" max="${sliderMax}" value="${defaultMax}" step="1">
        <div class="rs-labels">
          <span>Min: <strong id="${minValId}">${defaultMin}</strong></span>
          <span>Max: <strong id="${maxValId}">${defaultMax}</strong></span>
        </div>
      </div>
    `;
    container.appendChild(group);

    // Attach live update handlers
    const minEl = document.getElementById(minId);
    const maxEl = document.getElementById(maxId);
    const cfg = { minId, maxId, fillId };
    const handler = (e) => {
      let lo = parseInt(minEl.value, 10);
      let hi = parseInt(maxEl.value, 10);
      if (lo > hi) {
        if (e.target === minEl) { minEl.value = hi; lo = hi; }
        else { maxEl.value = lo; hi = lo; }
      }
      document.getElementById(minValId).textContent = lo;
      document.getElementById(maxValId).textContent = hi;
      updateRangeFill(cfg);
    };
    minEl.addEventListener('input', handler);
    maxEl.addEventListener('input', handler);
  });
}

function setupBarbarianUI() {
  const enabledCheckbox = document.getElementById('setup-barbarians-enabled');
  const collapsible = document.getElementById('setup-barbarian-collapsible');
  if (!enabledCheckbox || !collapsible) return;

  enabledCheckbox.addEventListener('change', () => {
    collapsible.classList.toggle('expanded', enabledCheckbox.checked);
  });
  // Individual slider listeners are attached in renderBarbarianHordeSliders()
}

function updateRangeFill(cfg) {
  const minEl = document.getElementById(cfg.minId);
  const maxEl = document.getElementById(cfg.maxId);
  const fill = document.getElementById(cfg.fillId);
  if (!minEl || !maxEl || !fill) return;
  const min = parseInt(minEl.min, 10);
  const max = parseInt(minEl.max, 10);
  const range = max - min;
  const lo = parseInt(minEl.value, 10);
  const hi = parseInt(maxEl.value, 10);
  fill.style.left = `${((lo - min) / range) * 100}%`;
  fill.style.width = `${((hi - lo) / range) * 100}%`;
}

function updateAllRangeFills() {
  // Enumerate all range-slider widgets currently in the DOM
  document.querySelectorAll('.range-slider[data-range-id]').forEach(slider => {
    const unitName = slider.dataset.rangeId;
    const prefix = hordeUnitIdPrefix(unitName);
    updateRangeFill({
      minId: `${prefix}-min`,
      maxId: `${prefix}-max`,
      fillId: `${prefix}-range-fill`
    });
  });
}

/* --------------------------------------------------------------------------
   AI SETUP UI (Phase 23): provider keys, controller + leader selection.
   Definitions: definitions/ai.json (providers, controllers),
   definitions/leaders.json (leader personas).
   -------------------------------------------------------------------------- */

let aiJson = null;          // { providers, controllers, baseConfig }
let leadersJson = [];       // [{ name, description, focus[] }]
let setupProviderKeys = {}; // { providerName: apiKey }

async function loadAiDefinitions() {
  if (!aiJson) {
    const [aiRes, leadersRes] = await Promise.all([
      fetch(CONFIG.AI_URL || './definitions/ai.json'),
      fetch(CONFIG.LEADERS_URL || './definitions/leaders.json')
    ]);
    if (!aiRes.ok) throw new Error(`ai.json: HTTP ${aiRes.status}`);
    if (!leadersRes.ok) throw new Error(`leaders.json: HTTP ${leadersRes.status}`);
    aiJson = await aiRes.json();
    leadersJson = await leadersRes.json();
  }
  return { aiJson, leadersJson };
}

/** Controller key for a setup player's controller object (matched by URL). */
/** Hover/selected-leader tooltip text (Phase 23.4). */
function leaderTitle(name) {
  const l = leadersJson.find(x => x.name === name);
  return l ? `${l.description} Focus: ${l.focus.join(', ')}.` : '';
}

/** Phase 23.1: one key input per provider from ai.json. */
function setupAiConfigUI() {
  const container = document.getElementById('setup-provider-keys');
  if (!container || !aiJson) return;
  container.innerHTML = '';
  try {
    const saved = sessionStorage.getItem('empires_provider_keys');
    if (saved) setupProviderKeys = JSON.parse(saved) || {};
  } catch (e) { /* ignore */ }
  for (const [name, prov] of Object.entries(aiJson.providers || {})) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const label = document.createElement('label');
    label.style.cssText = 'font-size:12px;min-width:90px;text-transform:capitalize;color:var(--text-muted);font-weight:600;';
    label.textContent = name;
    const input = document.createElement('input');
    input.type = 'password';
    input.name = `provider-key-${name}`;
    input.className = 'form-input';
    input.placeholder = `API key for ${name} (optional)`;
    input.value = setupProviderKeys[name] || '';
    input.style.flex = '1';
    input.addEventListener('input', (e) => {
      setupProviderKeys[name] = e.target.value.trim();
      try { sessionStorage.setItem('empires_provider_keys', JSON.stringify(setupProviderKeys)); }
      catch (err) { /* ignore */ }
    });
    row.appendChild(label);
    row.appendChild(input);
    container.appendChild(row);
  }
}

/**
 * Build a runtime controller from a controller key and player name.
 * Looks up the controller definition in ai.json, resolves the provider
 * URL, adds the API key from session storage if present, and overlays
 * the leader's description/focus based on the player name.
 * Returns null for 'human'.
 */
function buildController(key, playerName) {
  if (!key || key === 'human' || !aiJson) return null;
  const def = aiJson.controllers?.[key];
  if (!def) return null;
  const controller = {
    url: def.url,
    config: JSON.parse(JSON.stringify(def.config || {})),
  };
  // Overlay leader description/focus if player name matches a leader
  const leader = leadersJson.find(l => l.name === playerName);
  if (leader) {
    controller.description = leader.description;
    controller.focus = [...leader.focus];
  } else if (def.description) {
    controller.description = def.description;
    controller.focus = def.focus ? [...def.focus] : undefined;
  }
  // Resolve provider: config.provider is a provider name in ai.json
  const cfg = controller.config;
  const provDef = aiJson.providers?.[cfg.provider];
  if (provDef) {
    cfg.baseUrl = provDef.url;
    // H1: the API key is NOT copied into the config — it would be
    // serialized into IndexedDB saves and replay exports. The LLM client
    // resolves it from sessionStorage at construction instead.
  }
  return controller;
}


/**
 * Initialize custom spinner buttons for number inputs in the setup modal
 */
function initNumberInputSpinners() {
  const modal = document.getElementById('setup-modal-overlay');
  if (!modal) return;

  const spinners = modal.querySelectorAll('.number-input-wrapper');
  spinners.forEach(wrapper => {
    // M6: guard against double-binding — initNumberInputSpinners runs on
    // every render/open, and each call added another set of listeners.
    if (wrapper.dataset.spinnersBound) return;
    wrapper.dataset.spinnersBound = '1';
    const input = wrapper.querySelector('input[type="number"]');
    const upBtn = wrapper.querySelector('.spinner-btn.up');
    const downBtn = wrapper.querySelector('.spinner-btn.down');

    if (!input || !upBtn || !downBtn) return;

    const min = parseFloat(input.min) || 0;
    const max = parseFloat(input.max) || Infinity;
    const step = parseFloat(input.step) || 1;

    const updateValue = (delta) => {
      let value = parseFloat(input.value) || 0;
      value = Math.max(min, Math.min(max, value + delta * step));
      // Handle step precision for decimals
      if (step < 1) {
        value = Math.round(value / step) * step;
      }
      input.value = value;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    // M6: no separate 'click' handler — mousedown already fires
    // updateValue, so a click handler doubled every press. Long-press
    // (mousedown + timer) is the only path.
    // Also support long-press for rapid increment/decrement
    let pressTimer = null;
    const startPress = (delta) => {
      updateValue(delta);
      pressTimer = setTimeout(() => {
        pressTimer = setInterval(() => updateValue(delta), 100);
      }, 400);
    };
    const stopPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        clearInterval(pressTimer);
        pressTimer = null;
      }
    };

    upBtn.addEventListener('mousedown', (e) => { e.preventDefault(); startPress(1); });
    upBtn.addEventListener('mouseup', stopPress);
    upBtn.addEventListener('mouseleave', stopPress);
    downBtn.addEventListener('mousedown', (e) => { e.preventDefault(); startPress(-1); });
    downBtn.addEventListener('mouseup', stopPress);
    downBtn.addEventListener('mouseleave', stopPress);

    // Touch support
    upBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startPress(1); });
    upBtn.addEventListener('touchend', stopPress);
    downBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startPress(-1); });
    downBtn.addEventListener('touchend', stopPress);
  });
}

function handleStartGameClicked() {
  if (setupPlayers.length < 1) {
    showToast('Add at least 1 player!', true);
    return;
  }

  const startingResources = {};
  for (const [res, val] of Object.entries(defaultSettings?.initialization?.startingResources || {})) {
    const el = document.getElementById(`res-val-${res}`);
    startingResources[res] = el ? parseInt(el.value, 10) || 0 : val;
  };

  // Win conditions — rule 3: an empty/invalid input falls back to the
  // config value, never a hardcoded number (the old || 500 / || 2
  // duplicates went stale against defaultSettings.json).
  const winCondition = {};
  if (document.getElementById('setup-win-absolute-enabled').checked) {
    winCondition.absoluteScore = parseInt(document.getElementById('setup-win-absolute-value').value, 10) || defaultSettings.winCondition.absoluteScore;
  }
  if (document.getElementById('setup-win-relative-enabled').checked) {
    winCondition.relativeScore = parseFloat(document.getElementById('setup-win-relative-value').value) || defaultSettings.winCondition.relativeScore;
  }

  // Phase 23.5: provider keys were captured live into setupProviderKeys.

  const settings = {
    // L9: parseInt of an empty/invalid select value is NaN — fall back to
    // the config map size instead of starting a NaN-sized map. Rule 3:
    // the config value only, no hardcoded number.
    mapSize: parseInt(document.getElementById('setup-map-size').value, 10) || defaultSettings.mapSize,
    players: setupPlayers.map((p, i) => {
      return {
        id: i + 1,
        name: p.name.trim() || `Player ${i + 1}`,
        color: p.color,
        controller: buildController(p.controllerKey, p.name)
      };
    }),
    initialization: {
      orders: {
        // Rule 3: empty/invalid input falls back to the config value
        // (the old || 8 / || 6 had already drifted from it).
        max: parseInt(document.getElementById('setup-orders-max').value, 10) || defaultSettings.initialization.orders.max,
        // No `initial` here — Player defaults to max - perTurn (L4), so
        // turn 1 doesn't overflow free resources. Setting it to max (as
        // before) defeated the L4 fix (issue #48).
        perTurn: parseInt(document.getElementById('setup-orders-perturn').value, 10) || defaultSettings.initialization.orders.perTurn
      },
      startingResources: startingResources,
      startingUnits: { ...setupStartingUnits }
    },
    autoSave: {
      enabled: document.getElementById('setup-autosave-enabled').checked,
      // Rule 3: empty/invalid input falls back to the config value.
      intervalTurns: parseInt(document.getElementById('setup-autosave-interval').value, 10) || defaultSettings.autoSave.intervalTurns,
      maxAutoSaves: parseInt(document.getElementById('setup-autosave-max').value, 10) || defaultSettings.autoSave.maxAutoSaves
    },
    barbarians: document.getElementById('setup-barbarians-enabled').checked
      ? (() => {
        // Collect horde values dynamically — one entry per slider widget rendered
        const horde = {};
        document.querySelectorAll('#setup-barbarian-horde-container .range-slider[data-range-id]').forEach(slider => {
          const unitName = slider.dataset.rangeId;
          const prefix = hordeUnitIdPrefix(unitName);
          horde[unitName] = {
            min: parseInt(document.getElementById(`${prefix}-min`).value, 10) || 0,
            max: parseInt(document.getElementById(`${prefix}-max`).value, 10) || 0
          };
        });
        return {
          horde,
          // Rule 3: empty/invalid input falls back to the config value
          // (the old || 30 for maxAge had already drifted from the
          // config's 25).
          spawnFrequencyTurns: parseInt(document.getElementById('setup-barbarian-spawn-frequency').value, 10) || defaultSettings.barbarians.spawnFrequencyTurns,
          maxNumber: parseInt(document.getElementById('setup-barbarian-max-number').value, 10) || defaultSettings.barbarians.maxNumber,
          maxAge: parseInt(document.getElementById('setup-barbarian-max-age').value, 10) || defaultSettings.barbarians.maxAge
        };
      })()
      : null,
    winCondition: Object.keys(winCondition).length > 0 ? winCondition : null
  };


  startNewGame({ ...defaultSettings, ...settings });
  closeSetupModal();
}

function startNewGame(settings) {
  currentGameSettings = settings;
  deselectEntity();
  hideContextMenu();
  clearEntityMeshes();

  gameState = new GameState({
    onActionDone,
    // Every onOpenChatModal call is a fresh initiation (AiHelper.chat deducts
    // the order and generates an opening), so it must bypass the "concluded"
    // lock even if a previous conversation with this leader had ended.
    onOpenChatModal: (humanPlayer, aiPlayer) => openChatModal(humanPlayer, aiPlayer, { isNewInitiation: true }),
    onOpenTradeModal: (humanPlayer, aiPlayer, offer) => openIncomingTradeModal(humanPlayer, aiPlayer, offer),
    onCloseChatModal: () => closeChatModal(),
    // M5: autosave at the clean turn boundary, not after the next AI starts.
    onCleanBoundary: () => checkAutoSave(),
  });
  gameState.generateMap(settings.mapSize, manifestData.terrains, manifestData);

  // The browser drives turns: setup starts no turn (see initializeManifest),
  // so kick off the initial player's turn here, chained into nextTurn.
  gameState.initializeManifest(manifestData, settings);

  // H2/H3: set the turn buttons from the active player AFTER init — the
  // old code enabled Next Turn unconditionally, so during a player-0 AI
  // turn the user could click it and double-advance.
  setTurnButtons();

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

  // Start the initial player's turn now that recording is set up, chained
  // into nextTurn so AI turns keep advancing.
  gameState.startTurn(() => nextTurn());

  setMapCameraLimits(settings.mapSize);
  drawGrid(gameState);
  reconcileEntities(gameState);
  buildCellResources(gameState);
  updatePlayersUI(gameState, { onContextMenu: showPlayerContextMenu });

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

async function openSaveLoadModal(mode = 'save') {
  if (!gameState && mode === 'save') {
    showToast('Start a game first before saving!', true);
    return;
  }

  const overlay = document.getElementById('saveload-modal-overlay');
  const manualInput = document.getElementById('manual-save-name');

  if (gameState) {
    const activeP = gameState.activePlayer ? gameState.activePlayer.name : 'Game';
    manualInput.value = `${activeP} - Turn ${gameState.currentRound}`;
  } else {
    manualInput.value = '';
  }

  overlay.classList.add('active');
  await renderSavesList();
}

function closeSaveLoadModal() {
  document.getElementById('saveload-modal-overlay').classList.remove('active');
}

async function renderSavesList() {
  const container = document.getElementById('saves-list-container');
  container.innerHTML = '<div style="font-size:12px; color:var(--text-muted);">Loading saves...</div>';

  try {
    const saves = await listSaves();
    container.innerHTML = '';

    if (saves.length === 0) {
      container.innerHTML = '<div style="font-size:12px; color:var(--text-muted); padding:12px; text-align:center;">No saved games found.</div>';
      return;
    }

    saves.forEach(save => {
      const item = document.createElement('div');
      item.className = 'save-item';

      const dateStr = new Date(save.timestamp).toLocaleString();
      const badgeClass = save.auto ? 'auto' : 'manual';
      const badgeText = save.auto ? 'Auto-Save' : 'Manual';

      item.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <strong style="font-size: 14px;">${escapeHTML(save.name)}</strong>
            <span class="save-badge ${badgeClass}">${badgeText}</span>
          </div>
          <div style="font-size: 11px; color: var(--text-muted);">
            Round ${save.turnNumber || 1} • Saved on ${escapeHTML(dateStr)}
          </div>
        </div>
        <div style="display: flex; gap: 6px;">
          <button type="button" class="btn btn-small btn-load-entry" style="width: 70px;">Load</button>
          <button type="button" class="btn btn-danger btn-small btn-del-entry">✕</button>
        </div>
      `;

      item.querySelector('.btn-load-entry').addEventListener('click', () => doLoadGame(save.name));
      item.querySelector('.btn-del-entry').addEventListener('click', async () => {
        await deleteSave(save.name);
        renderSavesList();
        showToast(`Deleted save "${save.name}"`);
      });

      container.appendChild(item);
    });
  } catch (err) {
    console.error('Failed to list saves:', err);
    container.innerHTML = '<div style="font-size:12px; color:#e74c3c;">Failed to load saved games.</div>';
  }
}

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
      // Q1: autosaves only ever fire from onCleanBoundary (checkAutoSave),
      // so isAuto is exactly "taken at the clean boundary" — the state
      // before the next player's turn-start bookkeeping ran.
      cleanBoundary: isAuto,
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

    gameState = new GameState({
    onActionDone,
    // Every onOpenChatModal call is a fresh initiation (AiHelper.chat deducts
    // the order and generates an opening), so it must bypass the "concluded"
    // lock even if a previous conversation with this leader had ended.
    onOpenChatModal: (humanPlayer, aiPlayer) => openChatModal(humanPlayer, aiPlayer, { isNewInitiation: true }),
    onOpenTradeModal: (humanPlayer, aiPlayer, offer) => openIncomingTradeModal(humanPlayer, aiPlayer, offer),
    onCloseChatModal: () => closeChatModal(),
    // M5: autosave at the clean turn boundary, not after the next AI starts.
    onCleanBoundary: () => checkAutoSave(),
  });
    gameState.manifestData = manifestData;
    gameState.deserialize(record.data);

    // H4: restore the settings the save was made with — the old code never
    // set currentGameSettings, so auto-save and other setting-dependent
    // behaviour used stale (or null) settings after a load.
    currentGameSettings = gameState.settings || null;

    // H4: a save taken during round-end has activePlayerIndex -1 (barbarian
    // phase) — loading it left no active player. Advance to player 0.
    // NOTE: unreachable for saves taken after the H3 change — manual saves
    // only happen during human turns (index >= 0) and autosaves fire at the
    // clean boundary, after the index is restored to 0. Kept for pre-fix
    // saves that captured -1.
    if (gameState.activePlayerIndex < 0) {
      gameState.activePlayerIndex = 0;
    }

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

    // H4: resume the active player — the old code never restarted an AI's
    // turn after a load, so the game soft-locked (AI never moves) or
    // skipped the AI entirely. Set the turn buttons from the active player too.
    // Q1: a clean-boundary save (autosave) captures the state BEFORE the
    // active player's turn-start bookkeeping ran, so load must start the
    // turn — for an AI that runs its turn, for a human step() just runs
    // the bookkeeping (refill, yields, upkeep) and the human plays.
    // A mid-turn manual save already had its bookkeeping, so it resumes
    // as-is. Pre-flag saves have no cleanBoundary field and keep the old
    // behaviour (startTurn only for an AI).
    setTurnButtons();
    if (!gameState.gameOver && (record.cleanBoundary || (gameState.activePlayer && gameState.activePlayer.isAI))) {
      gameState.startTurn(() => nextTurn());
    }

    // Render the player panel AFTER startTurn: for a clean-boundary save
    // the turn-start bookkeeping (order refill) runs inside startTurn, so
    // rendering before it showed the saved pre-refill orders (0) until the
    // first action refreshed the panel.
    updatePlayersUI(gameState, { onContextMenu: showPlayerContextMenu });

    // The sun is renderer-local and not saved with the game state — re-derive
    // it from the active player's orders, instantly. Without this an autosave
    // load sweeps the sun through the night (the refill animates 5pm -> 7am)
    // and a mid-turn manual load leaves the sun wherever it was.
    if (gameState.activePlayer) gameState.activePlayer.resetTimeOfDay();

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
  gameState = new GameState({
    onActionDone,
    // Every onOpenChatModal call is a fresh initiation (AiHelper.chat deducts
    // the order and generates an opening), so it must bypass the "concluded"
    // lock even if a previous conversation with this leader had ended.
    onOpenChatModal: (humanPlayer, aiPlayer) => openChatModal(humanPlayer, aiPlayer, { isNewInitiation: true }),
    onOpenTradeModal: (humanPlayer, aiPlayer, offer) => openIncomingTradeModal(humanPlayer, aiPlayer, offer),
    onCloseChatModal: () => closeChatModal(),
    // M5: autosave at the clean turn boundary, not after the next AI starts.
    onCleanBoundary: () => checkAutoSave(),
  });
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

  updatePlayersUI(gameState, { onContextMenu: showPlayerContextMenu });
}

// exitReplayMode removed - users refresh the page to exit replay mode

/* ==========================================================================
   TURN LIFECYCLE & AUTO-SAVE CHECK
   ========================================================================== */

/**
 * Next Turn: triggers endTurn on gameState, cycling to next player turn and updating Fog of War.
 */
// H3: Save/Load are enabled exactly when Next Turn is — during a human
// turn (or when the game is over, when nothing is running). A load during
// an AI turn would replace gameState while the old AI's continuation is
// pending, and a save would capture a partial AI turn. This replaces the
// old gs === gameState continuation check: with no load possible mid-turn,
// there is nothing for it to guard.
function setTurnButtons() {
  const aiTurn = !!(gameState && !gameState.gameOver && gameState.activePlayer && gameState.activePlayer.isAI);
  const nextBtn = document.getElementById('btn-next-turn');
  if (nextBtn) {
    nextBtn.disabled = aiTurn;
    nextBtn.textContent = aiTurn ? 'Running AI...' : 'Next Turn';
  }
  const saveBtn = document.getElementById('btn-save-game');
  if (saveBtn) saveBtn.disabled = aiTurn;
  const loadBtn = document.getElementById('btn-load-game');
  if (loadBtn) loadBtn.disabled = aiTurn;
}

export async function nextTurn() {
  if (isReplayMode) return;
  if (gameState.gameOver) {
    showToast('Game is over. Start a new game.', true);
    return;
  }

  // H2: guard against double advance — a second call while endTurn is
  // still processing does nothing.
  if (turnAdvanceInProgress) return;
  turnAdvanceInProgress = true;

  // H3: capture this turn's gameState. No gs === gameState check — Save/Load
  // are disabled during AI turns (setTurnButtons), so no load can replace
  // gameState while a continuation is pending.
  const gs = gameState;
  const continuation = () => {
    if (!gameState.gameOver) nextTurn();
  };

  // H3: disable Save/Load with Next Turn — no save/load during the advance
  // or the AI turn that follows. (The active player is still the human who
  // clicked, so setTurnButtons() can't be used here — it reads the active
  // player, which hasn't advanced yet.)
  for (const id of ['btn-next-turn', 'btn-save-game', 'btn-load-game']) {
    const b = document.getElementById(id);
    if (b) b.disabled = true;
  }
  document.getElementById('btn-next-turn').textContent = 'Running AI...';

  deselectEntity();
  hideContextMenu();

  // this updates the gameState.activePlayer and increments the round if needed.
  // The browser drives turn advancement: nextTurn is the continuation
  // that runs when an AI player's turn settles (see Player.step).
  // Issue #48: try/finally — if endTurn throws, the flag and the buttons
  // must still recover, or Next Turn is permanently dead.
  try {
    await gs.endTurn(continuation);
  } finally {
    turnAdvanceInProgress = false;

    // Re-enable the turn buttons if the next player is human (setTurnButtons
    // reads the new active player; an AI turn keeps them disabled).
    setTurnButtons();

    updateHexFog(gs);
  }
  reconcileEntities(gs);
  reconcileCellResources(gs);
  updatePlayersUI(gs, { onContextMenu: showPlayerContextMenu });

  // Focus camera on center of mass of active player's entities
  if (gs.activePlayer && gs.entities.length > 0 &&
    ((gs.activePlayer.isAI && CONFIG.PAN_CAMERA_ON_AI_TURN) ||
      (!gs.activePlayer.isAI && CONFIG.PAN_CAMERA_ON_HUMAN_TURN))) {
    const playerEntities = gs.activePlayer.getEntities(gs);
    if (playerEntities.length > 0) {
      focusCameraOnEntities(playerEntities);
    }
  }

  showToast(`Turn passed to ${gs.activePlayer ? gs.activePlayer.name : ''} (Round ${gs.currentRound})`);

  // Chime when the turn comes back to a human player.
  if (gs.activePlayer && !gs.activePlayer.isAI) {
    audio.playUi('turn');
  }

  // M5: autosave now fires from the onCleanBoundary hook inside endTurn
  // (round-end done, next turn not started) — not here, where the next AI
  // has already begun acting.

  // Check win conditions (pure check on GameState; render the modal here)
  const win = gs.checkWinConditions();
  if (win) {
    showVictoryModal(win.winner, win.reasons);
    // L9: the button reset lives in setTurnButtons(), already called above
    // in this function — there is no `button` in scope here.
  }
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


/**
 * Shows the victory modal with the winning player and reasons.
 */
function showVictoryModal(player, reasons) {
  const overlay = document.getElementById('victory-modal-overlay');
  const messageDiv = document.getElementById('victory-message');

  messageDiv.innerHTML = `
    <div style="font-size: 24px; font-weight: 700; color: ${player.color}; margin-bottom: 12px;">${escapeHTML(player.name.toUpperCase())} WINS!</div>
    <div style="font-size: 14px; color: var(--text-muted); margin-bottom: 16px;">Round ${gameState.currentRound}</div>
    <div style="text-align: left; font-size: 13px; color: var(--text-main);">
      ${reasons.map(r => `<div style="margin: 8px 0; padding: 8px; background: rgba(52, 152, 219, 0.1); border-radius: 4px;">${escapeHTML(r)}</div>`).join('')}
    </div>
  `;

  overlay.classList.add('active');
  gameState.gameOver = true;

  if (gameState?.replayRecorder?.isRecording()) {
    gameState.replayRecorder.recordSnapshot(gameState, `Game Over: ${player.name} won!`);
  }
}

/**
 * Closes the victory modal.
 */
function closeVictoryModal() {
  const overlay = document.getElementById('victory-modal-overlay');
  overlay.classList.remove('active');
}

/* ==========================================================================
   DIPLOMATIC CHAT SYSTEM (MODAL & MESSAGING)
   ========================================================================== */

let currentChatSession = {
  humanPlayer: null,
  aiPlayer: null,
  resolvePromise: null,
  isWaitingForAi: false,
  isChatEnded: false,
  isTradeDrawerOpen: false,
  tradeType: 'one_time',
  pendingOffer: null,
  draftGives: {},
  draftAsks: {}
};

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getAvailableTradeResources() {
  const resSet = new Map();
  // 1. From manifestData.resources
  const manifestResources = gameState?.manifestData?.resources || [];
  for (const r of manifestResources) {
    if (r.name) resSet.set(r.name.toLowerCase(), { name: r.name, color: r.color || 'var(--accent-color)' });
  }
  // 2. From initializationSettings.startingResources
  const initRes = gameState?.initializationSettings?.startingResources || {};
  for (const k of Object.keys(initRes)) {
    if (!resSet.has(k.toLowerCase())) resSet.set(k.toLowerCase(), { name: k, color: 'var(--accent-color)' });
  }
  // 3. From active players' resources
  if (gameState?.players) {
    for (const p of gameState.players) {
      for (const k of Object.keys(p.resources || {})) {
        if (!resSet.has(k.toLowerCase())) resSet.set(k.toLowerCase(), { name: k, color: 'var(--accent-color)' });
      }
    }
  }
  return Array.from(resSet.values());
}

function toggleTradeDrawer(forceState = null) {
  const modalCard = document.getElementById('chat-modal-card');
  const tradeDrawer = document.getElementById('chat-trade-drawer');
  const toggleBtn = document.getElementById('btn-toggle-trade');
  if (!tradeDrawer || !modalCard) return;

  const newState = forceState !== null ? forceState : !currentChatSession.isTradeDrawerOpen;
  currentChatSession.isTradeDrawerOpen = newState;

  if (newState) {
    modalCard.classList.add('chat-card-expanded');
    tradeDrawer.classList.add('active');
    if (toggleBtn) {
      toggleBtn.style.background = '#10b981';
      toggleBtn.style.color = '#fff';
    }
    renderTradeDrawer();
  } else {
    modalCard.classList.remove('chat-card-expanded');
    tradeDrawer.classList.remove('active');
    if (toggleBtn) {
      toggleBtn.style.background = 'rgba(16, 185, 129, 0.2)';
      toggleBtn.style.color = '#10b981';
    }
  }
}

function renderTradeDrawer() {
  const drawer = document.getElementById('chat-trade-drawer');
  if (!drawer || !currentChatSession.humanPlayer || !currentChatSession.aiPlayer) return;

  const { humanPlayer, aiPlayer, tradeType, pendingOffer, incomingOffer } = currentChatSession;
  const isChatEnded = !!currentChatSession.isChatEnded;

  // Banner for concluded negotiations
  const concludedBanner = document.getElementById('trade-concluded-banner');
  if (concludedBanner) {
    concludedBanner.style.display = isChatEnded ? 'block' : 'none';
  }

  // 1. Update trade type pills
  const btnOneTime = document.getElementById('trade-tab-onetime');
  const btnPerTurn = document.getElementById('trade-tab-perturn');
  if (btnOneTime) btnOneTime.classList.toggle('active', tradeType === 'one_time');
  if (btnPerTurn) btnPerTurn.classList.toggle('active', tradeType === 'per_turn');

  const modeLabel = document.getElementById('trade-offer-mode-label');
  if (modeLabel) {
    modeLabel.textContent = tradeType === 'one_time' ? '(Your Stock)' : '(Per-Turn Outflow)';
    modeLabel.style.color = tradeType === 'one_time' ? '#10b981' : '#38bdf8';
  }

  // 2. Status Box
  const statusBox = document.getElementById('trade-offer-status-box');
  if (statusBox) {
    if (incomingOffer) {
      // AI-initiated proposal: the human decides. The AI's turn is waiting on
      // this decision (see openIncomingTradeModal).
      statusBox.style.display = 'flex';
      statusBox.innerHTML = `
        <div class="trade-offer-box trade-offer-incoming">
          <div style="color: #38bdf8; font-weight: 700; font-size: 11px;">
            📜 Incoming Offer from ${escapeHTML(aiPlayer.name)}
          </div>
          <div style="font-size: 11px;"><strong>They offer you:</strong> <span style="color: #10b981;">${escapeHTML(formatResourceBundle(incomingOffer.proposerGives))}</span></div>
          <div style="font-size: 11px;"><strong>They request from you:</strong> <span style="color: #f87171;">${escapeHTML(formatResourceBundle(incomingOffer.proposerAsks))}</span></div>
          <div style="display: flex; gap: 6px; margin-top: 6px;">
            <button id="btn-accept-incoming" class="btn btn-small" style="background: #10b981; color: #fff; flex: 1; padding: 5px 0; font-size: 11px; cursor: pointer;">Accept</button>
            <button id="btn-adjust-incoming" class="btn btn-small" style="background: #38bdf8; color: #fff; flex: 1; padding: 5px 0; font-size: 11px; cursor: pointer;">Counter</button>
            <button id="btn-reject-incoming" class="btn btn-small" style="background: #ef4444; color: #fff; flex: 1; padding: 5px 0; font-size: 11px; cursor: pointer;">Reject</button>
          </div>
        </div>
      `;
      const acceptBtn = document.getElementById('btn-accept-incoming');
      if (acceptBtn) {
        acceptBtn.onclick = () => handleAcceptIncomingOffer();
        if (isChatEnded) {
          acceptBtn.disabled = true;
          acceptBtn.style.opacity = '0.4';
          acceptBtn.style.cursor = 'not-allowed';
        }
      }
      const adjustBtn = document.getElementById('btn-adjust-incoming');
      if (adjustBtn) {
        adjustBtn.onclick = () => handleAdjustIncomingOffer();
        if (isChatEnded) {
          adjustBtn.disabled = true;
          adjustBtn.style.opacity = '0.4';
          adjustBtn.style.cursor = 'not-allowed';
        }
      }
      const rejectBtn = document.getElementById('btn-reject-incoming');
      if (rejectBtn) rejectBtn.onclick = () => handleRejectIncomingOffer();
    } else if (pendingOffer) {
      statusBox.style.display = 'flex';
      if (pendingOffer.status === 'waiting') {
        statusBox.innerHTML = `
          <div class="trade-offer-box">
            <div style="display: flex; align-items: center; gap: 6px; color: #10b981; font-weight: 700;">
              <span style="display: inline-block; animation: pulse 1.5s infinite;">⏳</span>
              <span>Proposal Pending</span>
            </div>
            <div style="font-size: 11px;"><strong>You Offer:</strong> ${escapeHTML(formatResourceBundle(pendingOffer.proposerGives))}</div>
            <div style="font-size: 11px;"><strong>You Request:</strong> ${escapeHTML(formatResourceBundle(pendingOffer.proposerAsks))}</div>
            <div class="text-muted-tiny" style="color: #94a3b8; font-size: 10px;">${escapeHTML(aiPlayer.name)} is evaluating...</div>
          </div>
        `;
      } else if (pendingOffer.status === 'countered') {
        statusBox.innerHTML = `
          <div class="trade-offer-box trade-offer-counter">
            <div style="color: #f59e0b; font-weight: 700; font-size: 11px;">
              ⚖ Counter-Offer from ${escapeHTML(aiPlayer.name)}
            </div>
            <div style="font-size: 11px;"><strong>They request you send:</strong> <span style="color: #f87171;">${escapeHTML(formatResourceBundle(pendingOffer.proposerGives))}</span></div>
            <div style="font-size: 11px;"><strong>They offer to send you:</strong> <span style="color: #10b981;">${escapeHTML(formatResourceBundle(pendingOffer.proposerAsks))}</span></div>
            <div style="display: flex; gap: 6px; margin-top: 6px;">
              <button id="btn-accept-counter" class="btn btn-small" style="background: #10b981; color: #fff; flex: 1; padding: 5px 0; font-size: 11px; cursor: pointer;">Accept Deal</button>
              <button id="btn-adjust-counter" class="btn btn-small" style="background: #38bdf8; color: #fff; flex: 1; padding: 5px 0; font-size: 11px; cursor: pointer;">Adjust</button>
              <button id="btn-reject-offer" class="btn btn-small" style="background: #ef4444; color: #fff; flex: 1; padding: 5px 0; font-size: 11px; cursor: pointer;">Reject</button>
            </div>
          </div>
        `;
        const acceptBtn = document.getElementById('btn-accept-counter');
        if (acceptBtn) {
          acceptBtn.onclick = () => handleAcceptCounterOffer();
          if (isChatEnded) {
            acceptBtn.disabled = true;
            acceptBtn.style.opacity = '0.4';
            acceptBtn.style.cursor = 'not-allowed';
          }
        }
        const adjustBtn = document.getElementById('btn-adjust-counter');
        if (adjustBtn) {
          adjustBtn.onclick = () => handleAdjustCounterOffer();
          if (isChatEnded) {
            adjustBtn.disabled = true;
            adjustBtn.style.opacity = '0.4';
            adjustBtn.style.cursor = 'not-allowed';
          }
        }
        const rejectBtn = document.getElementById('btn-reject-offer');
        if (rejectBtn) rejectBtn.onclick = () => handleRejectTradeOffer();
      }
    } else {
      statusBox.style.display = 'none';
      statusBox.innerHTML = '';
    }
  }

  // 3. Propose button state
  const proposeBtn = document.getElementById('btn-propose-trade');
  if (proposeBtn) {
    const isPending = pendingOffer && pendingOffer.status === 'waiting';
    proposeBtn.disabled = isChatEnded || isPending || !!incomingOffer;
    if (isChatEnded) {
      proposeBtn.title = 'Trade is not allowed because negotiations have concluded.';
      proposeBtn.style.opacity = '0.4';
      proposeBtn.style.cursor = 'not-allowed';
    } else if (incomingOffer) {
      proposeBtn.title = 'Respond to the incoming offer first.';
      proposeBtn.style.opacity = '';
      proposeBtn.style.cursor = '';
    } else if (isPending) {
      proposeBtn.title = 'A trade proposal is pending.';
      proposeBtn.style.opacity = '';
      proposeBtn.style.cursor = '';
    } else {
      proposeBtn.title = '';
      proposeBtn.style.opacity = '';
      proposeBtn.style.cursor = '';
    }
    proposeBtn.textContent = tradeType === 'one_time' ? 'Propose One-Time Trade' : 'Propose Agreement';
  }

  // 4. Render Resource Inputs
  const availableResources = getAvailableTradeResources();
  const offerContainer = document.getElementById('trade-offer-resources-container');
  const requestContainer = document.getElementById('trade-request-resources-container');

  if (offerContainer) {
    offerContainer.innerHTML = availableResources.map(r => {
      const stock = humanPlayer.resources[r.name] || 0;
      const currentVal = currentChatSession.draftGives[r.name] || 0;
      return `
        <div class="trade-resource-row">
          <div class="trade-resource-name">
            <span class="player-color-dot" style="background-color: ${r.color}; width: 8px; height: 8px;"></span>
            <span style="font-weight: 600; text-transform: capitalize;">${escapeHTML(r.name)}</span>
          </div>
          <span class="text-muted-tiny" style="color: #94a3b8; font-size: 10px;">Stock: ${stock}</span>
          <div class="trade-qty-control">
            <button class="trade-qty-btn btn-trade-dec" data-side="gives" data-res="${escapeHTML(r.name)}">-</button>
            <input type="number" class="trade-qty-input inp-trade-qty" data-side="gives" data-res="${escapeHTML(r.name)}" value="${currentVal}" min="0" ${tradeType === 'one_time' ? `max="${stock}"` : ''} />
            <button class="trade-qty-btn btn-trade-inc" data-side="gives" data-res="${escapeHTML(r.name)}">+</button>
          </div>
        </div>
      `;
    }).join('');
  }

  if (requestContainer) {
    requestContainer.innerHTML = availableResources.map(r => {
      const currentVal = currentChatSession.draftAsks[r.name] || 0;
      return `
        <div class="trade-resource-row">
          <div class="trade-resource-name">
            <span class="player-color-dot" style="background-color: ${r.color}; width: 8px; height: 8px;"></span>
            <span style="font-weight: 600; text-transform: capitalize;">${escapeHTML(r.name)}</span>
          </div>
          <div></div>
          <div class="trade-qty-control">
            <button class="trade-qty-btn btn-trade-dec" data-side="asks" data-res="${escapeHTML(r.name)}">-</button>
            <input type="number" class="trade-qty-input inp-trade-qty" data-side="asks" data-res="${escapeHTML(r.name)}" value="${currentVal}" min="0" />
            <button class="trade-qty-btn btn-trade-inc" data-side="asks" data-res="${escapeHTML(r.name)}">+</button>
          </div>
        </div>
      `;
    }).join('');
  }

  // Attach input & button listeners for resource amounts
  drawer.querySelectorAll('.btn-trade-inc').forEach(btn => {
    btn.onclick = (e) => {
      const side = e.currentTarget.getAttribute('data-side');
      const resName = e.currentTarget.getAttribute('data-res');
      const targetObj = side === 'gives' ? currentChatSession.draftGives : currentChatSession.draftAsks;
      const step = e.shiftKey ? 1 : 5;
      const cur = targetObj[resName] || 0;
      let next = cur + step;
      if (side === 'gives' && tradeType === 'one_time') {
        const stock = humanPlayer.resources[resName] || 0;
        next = Math.min(stock, next);
      }
      targetObj[resName] = next;
      const inp = drawer.querySelector(`.inp-trade-qty[data-side="${side}"][data-res="${resName}"]`);
      if (inp) inp.value = next;
    };
  });

  drawer.querySelectorAll('.btn-trade-dec').forEach(btn => {
    btn.onclick = (e) => {
      const side = e.currentTarget.getAttribute('data-side');
      const resName = e.currentTarget.getAttribute('data-res');
      const targetObj = side === 'gives' ? currentChatSession.draftGives : currentChatSession.draftAsks;
      const step = e.shiftKey ? 1 : 5;
      const cur = targetObj[resName] || 0;
      const next = Math.max(0, cur - step);
      targetObj[resName] = next;
      const inp = drawer.querySelector(`.inp-trade-qty[data-side="${side}"][data-res="${resName}"]`);
      if (inp) inp.value = next;
    };
  });

  drawer.querySelectorAll('.inp-trade-qty').forEach(inp => {
    inp.onchange = (e) => {
      const side = e.currentTarget.getAttribute('data-side');
      const resName = e.currentTarget.getAttribute('data-res');
      const targetObj = side === 'gives' ? currentChatSession.draftGives : currentChatSession.draftAsks;
      let val = Math.max(0, parseInt(e.currentTarget.value || '0', 10));
      if (isNaN(val)) val = 0;
      if (side === 'gives' && tradeType === 'one_time') {
        const stock = humanPlayer.resources[resName] || 0;
        val = Math.min(stock, val);
      }
      e.currentTarget.value = val;
      targetObj[resName] = val;
    };
  });

  if (isChatEnded) {
    drawer.querySelectorAll('.btn-trade-inc, .btn-trade-dec, .inp-trade-qty').forEach(el => {
      el.disabled = true;
    });
  }

  // 5. Active Per-Turn Agreements with this Leader
  const activeList = document.getElementById('trade-active-agreements-list');
  if (activeList) {
    const activeWithPartner = (gameState.trades || []).filter(t =>
      t.active && t.type === 'per_turn' &&
      ((String(t.player1Id) === String(humanPlayer.id) && String(t.player2Id) === String(aiPlayer.id)) ||
       (String(t.player1Id) === String(aiPlayer.id) && String(t.player2Id) === String(humanPlayer.id)))
    );

    if (activeWithPartner.length === 0) {
      activeList.innerHTML = `<div class="text-muted-tiny" style="color: var(--text-muted); font-size: 11px;">None active with this leader.</div>`;
    } else {
      activeList.innerHTML = activeWithPartner.map(t => {
        const isP1 = String(t.player1Id) === String(humanPlayer.id);
        const givesBundle = isP1 ? t.bundle1 : t.bundle2;
        const asksBundle = isP1 ? t.bundle2 : t.bundle1;
        return `
          <div class="trade-ongoing-item">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="font-weight: 600; color: #10b981; font-size: 10px;">Round ${t.createdRound} Agreement</span>
              <button class="btn btn-small btn-cancel-drawer-trade" data-trade-id="${t.id}" style="background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.5); color: #f87171; padding: 2px 6px; font-size: 10px; cursor: pointer;">
                Cancel
              </button>
            </div>
            <div style="font-size: 10px; color: var(--text-muted);">
              <div><span style="color: #f87171;">Send:</span> ${escapeHTML(formatResourceBundle(givesBundle))}/turn</div>
              <div><span style="color: #10b981;">Receive:</span> ${escapeHTML(formatResourceBundle(asksBundle))}/turn</div>
            </div>
          </div>
        `;
      }).join('');

      activeList.querySelectorAll('.btn-cancel-drawer-trade').forEach(btn => {
        btn.onclick = (e) => {
          const tradeId = e.currentTarget.getAttribute('data-trade-id');
          handleCancelTradeFromDrawer(tradeId);
        };
      });
    }
  }
}

async function handleProposeTradeClicked() {
  if (currentChatSession.isChatEnded) {
    showToast('Trade is not allowed because negotiations have concluded.', true);
    return;
  }
  const { humanPlayer, aiPlayer, tradeType, draftGives, draftAsks } = currentChatSession;
  if (!humanPlayer || !aiPlayer) return;

  // Capture this session: the modal can close (or a new chat can open) while
  // the AI is evaluating, and a late decision must not write into the new
  // session's pending offer or draft bundles.
  const session = currentChatSession;
  const isLiveSession = () => currentChatSession === session;

  const givesCount = Object.values(draftGives).reduce((sum, v) => sum + (v || 0), 0);
  const asksCount = Object.values(draftAsks).reduce((sum, v) => sum + (v || 0), 0);
  if (givesCount === 0 || asksCount === 0) {
    showToast('A trade needs at least one resource on each side.', true);
    return;
  }

  if (tradeType === 'one_time' && !humanPlayer.hasResources(draftGives)) {
    showToast('You do not possess the offered resources in stock.', true);
    return;
  }

  const offer = {
    type: tradeType,
    proposerGives: { ...draftGives },
    proposerAsks: { ...draftAsks }
  };
  session.pendingOffer = { ...offer, status: 'waiting' };

  const typeLabel = tradeType === 'per_turn' ? 'ongoing per-turn' : 'one-time';
  gameState.addChatMessage(
    humanPlayer,
    aiPlayer,
    `*[Trade Proposal: Proposing ${typeLabel} exchange — Offering ${formatResourceBundle(offer.proposerGives)} for ${formatResourceBundle(offer.proposerAsks)}]*`
  );
  renderChatMessages();
  renderTradeDrawer();

  try {
    const mgr = await aiPlayer.getAiManager();
    if (!mgr) {
      showToast(`${aiPlayer.name} cannot negotiate trade right now.`, true);
      if (isLiveSession()) {
        session.pendingOffer = null;
        renderTradeDrawer();
      }
      return;
    }

    const decision = await mgr.handleTradeOffer(humanPlayer, offer);

    if (decision.message) {
      // The reply belongs in the history even if the modal closed while the
      // AI was evaluating, but only the live session may repaint the UI.
      gameState.addChatMessage(aiPlayer, humanPlayer, decision.message);
      if (isLiveSession()) renderChatMessages();
    }

    if (decision.action === 'accept') {
      if (tradeType === 'one_time') {
        const res = gameState.executeOneTimeTrade(humanPlayer, aiPlayer, offer.proposerGives, offer.proposerAsks);
        if (res.success) {
          showToast(`Trade accepted by ${aiPlayer.name}!`);
        } else {
          showToast(`Trade failed: ${res.reason}`, true);
        }
      } else {
        const trade = gameState.createPerTurnTrade(humanPlayer, aiPlayer, offer.proposerGives, offer.proposerAsks);
        if (trade) {
          showToast(`Ongoing trade agreement established with ${aiPlayer.name}!`);
        } else {
          showToast('Trade failed: the per-turn agreement is invalid.', true);
        }
      }
      if (isLiveSession()) {
        session.pendingOffer = null;
        session.draftGives = {};
        session.draftAsks = {};
        updatePlayersUI(gameState, { onContextMenu: showPlayerContextMenu });
        renderTradeDrawer();
      }
    } else if (decision.action === 'counter') {
      showToast(`${aiPlayer.name} made a counter-offer.`);
      if (isLiveSession()) {
        session.pendingOffer = {
          type: tradeType,
          proposerGives: decision.counterOffer?.proposerGives || offer.proposerGives,
          proposerAsks: decision.counterOffer?.proposerAsks || offer.proposerAsks,
          status: 'countered'
        };
        renderTradeDrawer();
      }
    } else {
      showToast(`${aiPlayer.name} declined the trade offer.`);
      if (isLiveSession()) {
        session.pendingOffer = null;
        renderTradeDrawer();
      }
    }
  } catch (err) {
    console.error('Error during trade proposal:', err);
    showToast('Failed to negotiate trade proposal.', true);
    if (isLiveSession()) {
      session.pendingOffer = null;
      renderTradeDrawer();
    }
  }
}

function handleAcceptCounterOffer() {
  if (currentChatSession.isChatEnded) {
    showToast('Trade is not allowed because negotiations have concluded.', true);
    return;
  }
  const { humanPlayer, aiPlayer, pendingOffer } = currentChatSession;
  if (!humanPlayer || !aiPlayer || !pendingOffer) return;

  if (pendingOffer.type === 'one_time') {
    const res = gameState.executeOneTimeTrade(humanPlayer, aiPlayer, pendingOffer.proposerGives, pendingOffer.proposerAsks);
    if (!res.success) {
      showToast(`Cannot complete trade: ${res.reason}`, true);
      return;
    }
    showToast(`Trade finalized with ${aiPlayer.name}!`);
    gameState.addChatMessage(humanPlayer, aiPlayer, `*[Agreed to counter-offer: Exchanged ${formatResourceBundle(pendingOffer.proposerGives)} for ${formatResourceBundle(pendingOffer.proposerAsks)}]*`);
  } else {
    const trade = gameState.createPerTurnTrade(humanPlayer, aiPlayer, pendingOffer.proposerGives, pendingOffer.proposerAsks);
    if (!trade) {
      showToast('Cannot complete trade: the per-turn agreement is invalid.', true);
      return;
    }
    showToast(`Per-turn trade agreement established with ${aiPlayer.name}!`);
    gameState.addChatMessage(humanPlayer, aiPlayer, `*[Agreed to counter-offer: Established ongoing per-turn agreement]*`);
  }

  currentChatSession.pendingOffer = null;
  currentChatSession.draftGives = {};
  currentChatSession.draftAsks = {};
  updatePlayersUI(gameState, { onContextMenu: showPlayerContextMenu });
  renderChatMessages();
  renderTradeDrawer();
}

function handleAdjustCounterOffer() {
  const { pendingOffer } = currentChatSession;
  if (!pendingOffer) return;
  currentChatSession.draftGives = { ...(pendingOffer.proposerGives || {}) };
  currentChatSession.draftAsks = { ...(pendingOffer.proposerAsks || {}) };
  currentChatSession.pendingOffer = null;
  renderTradeDrawer();
}

function handleRejectTradeOffer() {
  const { humanPlayer, aiPlayer } = currentChatSession;
  currentChatSession.pendingOffer = null;
  if (humanPlayer && aiPlayer) {
    gameState.addChatMessage(humanPlayer, aiPlayer, `*[Declined trade proposal]*`);
    renderChatMessages();
  }
  showToast('Trade negotiation ended.');
  renderTradeDrawer();
}

function handleCancelTradeFromDrawer(tradeId) {
  const { humanPlayer, aiPlayer } = currentChatSession;
  if (!tradeId) return;
  gameState.cancelTrade(tradeId, humanPlayer);
  if (humanPlayer && aiPlayer) {
    gameState.addChatMessage(humanPlayer, aiPlayer, `*[Canceled per-turn trade agreement]*`);
    renderChatMessages();
  }
  updatePlayersUI(gameState, { onContextMenu: showPlayerContextMenu });
  renderTradeDrawer();
  showToast('Trade agreement canceled.');
}

function handleAcceptIncomingOffer() {
  const { humanPlayer, aiPlayer, incomingOffer } = currentChatSession;
  if (!incomingOffer || !humanPlayer || !aiPlayer) return;

  if (incomingOffer.type === 'one_time') {
    // The AI is the proposer: it sends proposerGives and receives proposerAsks.
    const res = gameState.executeOneTimeTrade(
      aiPlayer, humanPlayer, incomingOffer.proposerGives, incomingOffer.proposerAsks
    );
    if (!res.success) {
      showToast(`Cannot complete trade: ${res.reason}`, true);
      return;
    }
    gameState.addChatMessage(
      humanPlayer,
      aiPlayer,
      `*[Accepted trade: Exchanged ${formatResourceBundle(incomingOffer.proposerAsks)} for ${formatResourceBundle(incomingOffer.proposerGives)}]*`
    );
    showToast(`Trade finalized with ${aiPlayer.name}!`);
  } else {
    const trade = gameState.createPerTurnTrade(
      aiPlayer, humanPlayer, incomingOffer.proposerGives, incomingOffer.proposerAsks
    );
    if (!trade) {
      showToast('Cannot create the per-turn agreement: invalid offer.', true);
      return;
    }
    gameState.addChatMessage(
      humanPlayer,
      aiPlayer,
      `*[Accepted per-turn agreement: Sending ${formatResourceBundle(incomingOffer.proposerAsks)}/turn, receiving ${formatResourceBundle(incomingOffer.proposerGives)}/turn]*`
    );
    showToast(`Per-turn trade agreement established with ${aiPlayer.name}!`);
  }

  const resolve = currentChatSession.resolveTradeDecision;
  currentChatSession.incomingOffer = null;
  currentChatSession.resolveTradeDecision = null;
  if (resolve) resolve({ action: 'accept', applied: true });
  renderChatMessages();
  updatePlayersUI(gameState, { onContextMenu: showPlayerContextMenu });
  renderTradeDrawer();
}

function handleAdjustIncomingOffer() {
  const { incomingOffer, resolveTradeDecision } = currentChatSession;
  if (!incomingOffer) return;

  // The human becomes the proposer: give what the AI requested, ask for what
  // the AI offered. The next "Propose" sends this counter back to the AI.
  currentChatSession.draftGives = { ...(incomingOffer.proposerAsks || {}) };
  currentChatSession.draftAsks = { ...(incomingOffer.proposerGives || {}) };
  currentChatSession.tradeType = incomingOffer.type;
  currentChatSession.incomingOffer = null;
  currentChatSession.resolveTradeDecision = null;
  if (resolveTradeDecision) resolveTradeDecision({ action: 'counter' });
  showToast('Adjust the bundles, then propose your counter-offer.');
  renderTradeDrawer();
}

function handleRejectIncomingOffer() {
  const { humanPlayer, aiPlayer, incomingOffer, resolveTradeDecision } = currentChatSession;
  if (!incomingOffer) return;
  currentChatSession.incomingOffer = null;
  currentChatSession.resolveTradeDecision = null;
  if (resolveTradeDecision) resolveTradeDecision({ action: 'reject' });
  if (humanPlayer && aiPlayer) {
    gameState.addChatMessage(humanPlayer, aiPlayer, '*[Declined trade proposal]*');
    renderChatMessages();
  }
  showToast('Trade negotiation declined.');
  renderTradeDrawer();
}

function handleEndChat() {
  if (currentChatSession.isWaitingForAi || currentChatSession.isChatEnded) return;
  const { humanPlayer, aiPlayer } = currentChatSession;
  if (!humanPlayer || !aiPlayer) return;

  currentChatSession.isChatEnded = true;
  currentChatSession.pendingOffer = null;
  currentChatSession.incomingOffer = null;
  const resolveDecision = currentChatSession.resolveTradeDecision;
  currentChatSession.resolveTradeDecision = null;
  if (resolveDecision) resolveDecision({ action: 'reject', reason: 'ended' });

  gameState.addChatMessage(humanPlayer, aiPlayer, '[Concluded diplomatic negotiations]', true);

  const statusIndicator = document.getElementById('chat-status-indicator');
  if (statusIndicator) {
    statusIndicator.innerHTML = `<span style="color: #f1c40f;">[ You have concluded the negotiations. ]</span>`;
  }

  const input = document.getElementById('chat-message-input');
  const sendBtn = document.getElementById('btn-send-chat');
  const endBtn = document.getElementById('btn-end-chat');
  if (input) input.disabled = true;
  if (sendBtn) sendBtn.disabled = true;
  if (endBtn) endBtn.disabled = true;

  renderChatMessages();
  renderTradeDrawer();
  updatePlayersUI(gameState, { onContextMenu: showPlayerContextMenu });
}

function renderChatMessages() {
  const container = document.getElementById('chat-messages-container');
  if (!container || !currentChatSession.humanPlayer || !currentChatSession.aiPlayer) return;

  const history = gameState.getChatHistory(currentChatSession.humanPlayer, currentChatSession.aiPlayer);
  if (!history || history.length === 0) {
    container.innerHTML = `
      <div style="color: var(--text-muted); font-size: 13px; text-align: center; margin: auto; padding: 20px;">
        No diplomatic correspondence on record. Send a message to open negotiations with ${escapeHTML(currentChatSession.aiPlayer.name)}.
      </div>
    `;
    return;
  }

  container.innerHTML = history.map(msg => {
    // L6: identify the human by player id, not name — a human who types a
    // leader's name used to see every message rendered as their own.
    // (senderId is absent in pre-fix saves; fall back to the name there.)
    const isHuman = msg.senderId != null
      ? msg.senderId === currentChatSession.humanPlayer.id
      : msg.sender === currentChatSession.humanPlayer.name;
    const authorColor = isHuman ? 'var(--accent-color)' : currentChatSession.aiPlayer.color;
    const timeStr = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '';
    const bubbleClass = isHuman ? 'chat-msg chat-msg-sent' : 'chat-msg chat-msg-received';
    const borderStyle = isHuman ? '' : `border-left: 3px solid ${currentChatSession.aiPlayer.color};`;

    return `
      <div class="${bubbleClass}" style="${borderStyle}">
        <div class="chat-msg-header">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="player-color-dot" style="background-color: ${authorColor}; width: 8px; height: 8px;"></span>
            <span class="chat-msg-author" style="color: ${authorColor};">${escapeHTML(msg.sender)}</span>
          </div>
          <span class="chat-msg-time">${timeStr}</span>
        </div>
        <div class="chat-msg-body">${escapeHTML(msg.content)}</div>
      </div>
    `;
  }).join('');

  container.scrollTop = container.scrollHeight;
}

function openChatModal(humanPlayer, aiPlayer, options = {}) {
  if (!gameState || !humanPlayer || !aiPlayer) return Promise.resolve();

  const overlay = document.getElementById('chat-modal-overlay');
  const colorDot = document.getElementById('chat-modal-color');
  const title = document.getElementById('chat-modal-title');
  const input = document.getElementById('chat-message-input');
  const sendBtn = document.getElementById('btn-send-chat');
  const endBtn = document.getElementById('btn-end-chat');
  const statusIndicator = document.getElementById('chat-status-indicator');

  colorDot.style.backgroundColor = aiPlayer.color;
  title.textContent = `DIPLOMACY: ${aiPlayer.name.toUpperCase()}`;
  input.value = '';

  const history = gameState.getChatHistory(humanPlayer, aiPlayer);
  const lastMsg = history && history.length > 0 ? history[history.length - 1] : null;
  const isConcluded = !options.isNewInitiation && !!(lastMsg && (lastMsg.ended === true || /\[END_CHAT\]/i.test(lastMsg.content) || (typeof lastMsg.content === 'string' && lastMsg.content.includes('[Concluded'))));

  if (isConcluded) {
    statusIndicator.innerHTML = `<span style="color: #f1c40f;">[ Negotiations have concluded. ]</span>`;
    input.disabled = true;
    sendBtn.disabled = true;
    if (endBtn) endBtn.disabled = true;
  } else {
    statusIndicator.innerHTML = '';
    input.disabled = false;
    sendBtn.disabled = false;
    if (endBtn) endBtn.disabled = false;
  }

  const modalCard = document.getElementById('chat-modal-card');
  if (modalCard) modalCard.classList.remove('chat-card-expanded');
  const tradeDrawer = document.getElementById('chat-trade-drawer');
  if (tradeDrawer) tradeDrawer.classList.remove('active');
  const toggleBtn = document.getElementById('btn-toggle-trade');
  if (toggleBtn) {
    toggleBtn.style.background = 'rgba(16, 185, 129, 0.2)';
    toggleBtn.style.color = '#10b981';
  }

  return new Promise((resolve) => {
    currentChatSession = {
      humanPlayer,
      aiPlayer,
      resolvePromise: resolve,
      isWaitingForAi: false,
      isChatEnded: isConcluded,
      isTradeDrawerOpen: false,
      tradeType: 'one_time',
      pendingOffer: null,
      incomingOffer: options.incomingOffer || null,
      resolveTradeDecision: options.resolveTradeDecision || null,
      draftGives: {},
      draftAsks: {}
    };

    renderChatMessages();
    renderTradeDrawer();
    overlay.classList.add('active');
    if (currentChatSession.incomingOffer) {
      // AI-initiated proposal: surface it immediately rather than making the
      // human hunt for the trade drawer.
      toggleTradeDrawer(true);
    } else if (!isConcluded) {
      setTimeout(() => input.focus(), 100);
    }
  });
}

/**
 * Opens the chat modal for an AI-initiated trade and resolves with the human's
 * decision. The AI's turn waits until the modal closes, matching AI-initiated
 * chat and preventing a second AI from replacing the open offer.
 * @param {Player} humanPlayer
 * @param {Player} aiPlayer
 * @param {{type: string, proposerGives: Object, proposerAsks: Object}} offer
 * @returns {Promise<{action: 'accept'|'counter'|'reject', applied?: boolean, reason?: string}>}
 */
function openIncomingTradeModal(humanPlayer, aiPlayer, offer) {
  if (!gameState || !humanPlayer || !aiPlayer) {
    return Promise.resolve({ action: 'reject', reason: 'unavailable' });
  }

  let decision = null;
  let resolveDecision;
  const decisionPromise = new Promise((resolve) => { resolveDecision = resolve; });

  const closed = openChatModal(humanPlayer, aiPlayer, {
    isNewInitiation: true,
    incomingOffer: offer,
    resolveTradeDecision: (d) => {
      if (!decision) {
        decision = d;
        resolveDecision(d);
      }
    }
  });

  return Promise.all([closed, decisionPromise])
    .then(() => decision || { action: 'reject', reason: 'closed' });
}

async function closeChatModal() {
  const overlay = document.getElementById('chat-modal-overlay');
  if (!overlay || !overlay.classList.contains('active')) return;

  overlay.classList.remove('active');

  const modalCard = document.getElementById('chat-modal-card');
  if (modalCard) modalCard.classList.remove('chat-card-expanded');
  const tradeDrawer = document.getElementById('chat-trade-drawer');
  if (tradeDrawer) tradeDrawer.classList.remove('active');
  const toggleBtn = document.getElementById('btn-toggle-trade');
  if (toggleBtn) {
    toggleBtn.style.background = 'rgba(16, 185, 129, 0.2)';
    toggleBtn.style.color = '#10b981';
  }

  const { humanPlayer, aiPlayer, resolvePromise, resolveTradeDecision } = currentChatSession;
  // L6: try/finally — a throwing summarize used to hang the AI turn
  // forever (the promise never resolved). The session always resets.
  try {
    if (aiPlayer && humanPlayer) {
      // Requirement 7: When human exits chat, allow the AI player to add a note to summarize the chat
      const mgr = await aiPlayer.getAiManager();
      if (mgr) await mgr.summarizeChatAndAddNote(humanPlayer);
    }
  } catch (e) {
    console.warn('Chat summary failed (non-fatal):', e);
  } finally {
    updatePlayersUI(gameState, { onContextMenu: showPlayerContextMenu });

    // An AI-initiated offer waits on this decision. Closing without an answer
    // means "reject", so the AI's turn is never left hanging.
    if (resolveTradeDecision) resolveTradeDecision({ action: 'reject', reason: 'closed' });

    if (resolvePromise) {
      resolvePromise();
    }
    const endBtn = document.getElementById('btn-end-chat');
    if (endBtn) endBtn.disabled = false;
    currentChatSession = {
      humanPlayer: null,
      aiPlayer: null,
      resolvePromise: null,
      isWaitingForAi: false,
      isChatEnded: false,
      isTradeDrawerOpen: false,
      tradeType: 'one_time',
      pendingOffer: null,
      incomingOffer: null,
      resolveTradeDecision: null,
      draftGives: {},
      draftAsks: {}
    };
  }
}

async function sendChatMessage() {
  if (currentChatSession.isWaitingForAi || currentChatSession.isChatEnded) return;

  const input = document.getElementById('chat-message-input');
  const sendBtn = document.getElementById('btn-send-chat');
  const endBtn = document.getElementById('btn-end-chat');
  const statusIndicator = document.getElementById('chat-status-indicator');
  const text = input.value.trim();
  if (!text) return;

  const { humanPlayer, aiPlayer } = currentChatSession;
  if (!humanPlayer || !aiPlayer) return;

  const humanEnded = /\[END_CHAT\]/i.test(text);

  // L6: capture this session — the modal may be closed while the reply is
  // pending, and the reply must not touch the (possibly new) session's
  // waiting flag or UI state.
  const session = currentChatSession;

  // Add human message to gameState
  gameState.addChatMessage(humanPlayer, aiPlayer, text, humanEnded);
  input.value = '';
  renderChatMessages();

  if (humanEnded) {
    currentChatSession.isChatEnded = true;
    currentChatSession.pendingOffer = null;
    currentChatSession.incomingOffer = null;
    const resolveDecision = currentChatSession.resolveTradeDecision;
    currentChatSession.resolveTradeDecision = null;
    if (resolveDecision) resolveDecision({ action: 'reject', reason: 'ended' });
    statusIndicator.innerHTML = `<span style="color: #f1c40f;">[ You have concluded the negotiations. ]</span>`;
    input.disabled = true;
    sendBtn.disabled = true;
    if (endBtn) endBtn.disabled = true;
    renderTradeDrawer();
    updatePlayersUI(gameState, { onContextMenu: showPlayerContextMenu });
    return;
  }

  // Show thinking indicator & disable input
  currentChatSession.isWaitingForAi = true;
  input.disabled = true;
  sendBtn.disabled = true;
  if (endBtn) endBtn.disabled = true;
  statusIndicator.innerHTML = `
    <span style="display: inline-block; animation: pulse 1.5s infinite;">⏳</span>
    <span>${escapeHTML(aiPlayer.name)} is formulating a response...</span>
  `;

  try {
    const mgr = await aiPlayer.getAiManager();
    if (mgr) {
      const reply = await mgr.generateChatReply(humanPlayer);

      // Add AI message to gameState
      gameState.addChatMessage(aiPlayer, humanPlayer, reply.content, reply.ended);
      // L6: the reply belongs in the history even if the modal closed
      // while it was pending — but nothing below may touch the UI or the
      // session if this is no longer the live one.
      if (currentChatSession !== session) return;
      renderChatMessages();

      if (reply.ended) {
        // Summary note is added by closeChatModal() when the human closes the
        // modal — summarizing here too would double the note and the LLM call.
        currentChatSession.isChatEnded = true;
        currentChatSession.pendingOffer = null;
        currentChatSession.incomingOffer = null;
        const resolveDecision = currentChatSession.resolveTradeDecision;
        currentChatSession.resolveTradeDecision = null;
        if (resolveDecision) resolveDecision({ action: 'reject', reason: 'ended' });
        statusIndicator.innerHTML = `<span style="color: #f1c40f;">[ ${escapeHTML(aiPlayer.name)} has concluded the negotiations. ]</span>`;
        input.disabled = true;
        sendBtn.disabled = true;
        if (endBtn) endBtn.disabled = true;
        renderTradeDrawer();
        updatePlayersUI(gameState, { onContextMenu: showPlayerContextMenu });
      } else {
        statusIndicator.innerHTML = '';
        input.disabled = false;
        sendBtn.disabled = false;
        if (endBtn) endBtn.disabled = false;
        input.focus();
      }
    }
  } catch (err) {
    console.error('Error generating AI chat reply:', err);
    if (currentChatSession !== session) return;
    statusIndicator.innerHTML = `<span style="color: #e74c3c;">Failed to get response from ${escapeHTML(aiPlayer.name)}.</span>`;
    input.disabled = false;
    sendBtn.disabled = false;
    if (endBtn) endBtn.disabled = false;
  } finally {
    // L6: only clear the flag on the session that actually waited — a stale
    // reply used to clear a NEW session's flag (and re-enable its input)
    // while its own reply was still pending.
    if (currentChatSession === session) currentChatSession.isWaitingForAi = false;
  }
}


/* ==========================================================================
   PLAYERS UI LIST & RESOURCE PROFILES
   (merged from src/ui.js — no longer needed as a separate module)
   ========================================================================== */


let playerHoverTimer = null;

/**
 * Update the players UI list.
 * Moved from main.js to break up the file.
 * @param {Object} gameState - The active GameState
 * @param {Object} [callbacks] - Optional callbacks: { onContextMenu(x, y, player) }
 *   Context menu lives in main.js (entangled with chat/game state), so it's
 *   injected rather than imported to keep ui.js isolated.
 */
function updatePlayersUI(gameState, callbacks = {}) {
  const container = document.getElementById('players-list');
  container.innerHTML = '';

  const activePlayer = gameState.activePlayer;

  const header = document.createElement('div');
  header.style.marginBottom = '10px';
  header.style.fontSize = '12px';
  header.style.fontWeight = 'bold';
  header.style.color = 'var(--accent-color)';
  header.textContent = `ROUND ${gameState.currentRound} — TURN: ${activePlayer ? activePlayer.name.toUpperCase() : ''}${activePlayer && activePlayer.isAI ? ' (AI)' : ''}`;
  container.appendChild(header);

  // Find highest and second highest scores for relative score calculation
  const sortedScores = [...gameState.players].sort((a, b) => b.score.total - a.score.total);
  const highestScore = sortedScores[0]?.score.total || 0;
  const secondHighestScore = sortedScores[1]?.score.total || 0;

  const winCondition = gameState.settings?.winCondition || {};

  gameState.players.forEach(player => {
    const isActive = activePlayer && activePlayer.id === player.id;
    const li = document.createElement('li');
    li.className = 'player-list-item';
    li.style.display = 'flex';
    li.style.flexDirection = 'column';
    li.style.alignItems = 'flex-start';
    li.style.gap = '2px';
    li.style.marginBottom = '8px';
    li.style.padding = '8px';
    li.style.borderRadius = '6px';
    li.style.background = isActive ? 'rgba(167, 139, 250, 0.15)' : 'rgba(255, 255, 255, 0.02)';
    li.style.border = isActive ? '1px solid var(--accent-color)' : '1px solid rgba(255, 255, 255, 0.08)';

    const ordersStr = player.maxOrders > 0
      ? `orders: ${player.orders}/${player.maxOrders}`
      : '';

    const scoreStr = `total score: ${player.score.total} (${player.score.military} military, ${player.score.economic} economic, ${player.score.exploration} exploration)`;

    // Calculate score to win
    let scoreToWinParts = [];
    const minRoundsReached = gameState.currentRound >= CONFIG.MIN_GAME_ROUNDS;
    if (winCondition.absoluteScore) {
      scoreToWinParts.push(`Absolute: ${winCondition.absoluteScore}`);
    }
    if (winCondition.relativeScore) {
      // Use highest score if this player is not the highest, otherwise use second highest
      const targetScore = (player.score.total >= highestScore && sortedScores[0]?.id === player.id)
        ? secondHighestScore
        : highestScore;
      const relativeTarget = Math.ceil(winCondition.relativeScore * targetScore);
      scoreToWinParts.push(`Relative: ${relativeTarget} (${winCondition.relativeScore}×${targetScore})`);
    }
    const scoreToWinStr = scoreToWinParts.length > 0
      ? `score to win: ${scoreToWinParts.join(' | ')}`
      : '';
    const scoreToWinColor = minRoundsReached ? '#f1c40f' : '#666666';
    const scoreToWinText = minRoundsReached ? scoreToWinStr : `score to win: available after round ${CONFIG.MIN_GAME_ROUNDS}`;

    li.innerHTML = `
      <div class="flex-row-between">
        <div class="flex-row">
          <span class="player-color-dot" style="background-color: ${player.color};"></span>
          <strong style="font-size: 14px; color: ${isActive ? '#ffffff' : 'var(--text-muted)'};">${escapeHTML(player.name)} ${isActive ? '◀ ACTIVE' : ''}</strong>
        </div>
        <span class="profile-link">📊 Profile</span>
      </div>
      ${ordersStr ? `<div class="player-sub-line">${ordersStr}</div>` : ''}
      ${scoreStr ? `<div class="player-sub-line">${scoreStr}</div>` : ''}
      ${scoreToWinText ? `<div style="font-size: 11px; color: ${scoreToWinColor}; margin-left: 18px;">${scoreToWinText}</div>` : ''}
    `;

    // Long Hover (Tooltip) setup
    li.addEventListener('mouseenter', (ev) => {
      clearTimeout(playerHoverTimer);
      playerHoverTimer = setTimeout(() => {
        showResourceTooltip(gameState, player, ev.clientX, ev.clientY);
      }, 400);
    });

    li.addEventListener('mousemove', (ev) => {
      const tooltip = document.getElementById('resource-profile-tooltip');
      if (tooltip.classList.contains('active')) {
        positionResourceTooltip(ev.clientX, ev.clientY);
      }
    });

    li.addEventListener('mouseleave', () => {
      clearTimeout(playerHoverTimer);
      hideResourceTooltip();
    });

    // Click -> Open Detailed Resource Profile Modal
    li.addEventListener('click', () => {
      clearTimeout(playerHoverTimer);
      hideResourceTooltip();
      openProfileModal(player, gameState);
    });

    // Right-Click -> Player Context Menu with "Chat" option
    li.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      clearTimeout(playerHoverTimer);
      hideResourceTooltip();

      const activeP = gameState.activePlayer;
      // Requirement 2: Context menu when right-clicking an AI player
      if (!player.isAI) return;
      if (activeP && activeP.id === player.id) return;

      if (callbacks.onContextMenu) {
        callbacks.onContextMenu(ev.clientX, ev.clientY, player);
      }
    });

    container.appendChild(li);
  });
}

function showResourceTooltip(gameState, player, x, y) {
  if (!player || !gameState) return;
  const tooltip = document.getElementById('resource-profile-tooltip');
  const content = document.getElementById('profile-tooltip-content');

  content.innerHTML = renderResourceProfileHTML(player, gameState, true);
  tooltip.classList.add('active');
  positionResourceTooltip(x, y);
}

function hideResourceTooltip() {
  const tooltip = document.getElementById('resource-profile-tooltip');
  if (tooltip) tooltip.classList.remove('active');
}

function positionResourceTooltip(x, y) {
  const tooltip = document.getElementById('resource-profile-tooltip');
  if (!tooltip) return;
  const rect = tooltip.getBoundingClientRect();
  let posX = x + 15;
  let posY = y - 20;

  if (posX + rect.width > window.innerWidth - 10) {
    posX = x - rect.width - 15;
  }
  if (posY + rect.height > window.innerHeight - 10) {
    posY = window.innerHeight - rect.height - 10;
  }
  tooltip.style.left = `${Math.max(10, posX)}px`;
  tooltip.style.top = `${Math.max(10, posY)}px`;
}

function renderResourceProfileHTML(player, gameState, isCompact = false) {
  // Visibility: an AI player's resource info (stocks, yields, upkeep,
  // owned entities) and history are hidden from the human unless SHOW_ALL
  // is on. Scores stay public — they are already in the player list.
  const hidePrivate = player.isAI && !CONFIG.SHOW_ALL;
  const { totalUpkeep, totalYields, netIncome, netTrade, activeTrades } = player.getResourceProfile(gameState);
  const myEntities = player.getEntities(gameState);

  const resourceKeys = Array.from(new Set([
    ...Object.keys(player.resources || {}),
    ...Object.keys(totalYields || {}),
    ...Object.keys(totalUpkeep || {})
  ])).sort();

  const summaryHTML = isCompact ? '' : `
    <div class="profile-summary-grid">
      <div class="profile-stat-box">
        <span class="profile-stat-label">Military Score</span>
        <span class="profile-stat-val stat-military">${player.score.military}</span>
      </div>
      <div class="profile-stat-box">
        <span class="profile-stat-label">Economic Score</span>
        <span class="profile-stat-val stat-economic">${player.score.economic}</span>
      </div>
      <div class="profile-stat-box">
        <span class="profile-stat-label">Exploration Score</span>
        <span class="profile-stat-val stat-exploration">${player.score.exploration}</span>
      </div>
      <div class="profile-stat-box">
        <span class="profile-stat-label">Orders</span>
        <span class="profile-stat-val stat-orders">${player.orders}/${player.maxOrders}</span>
      </div>
    </div>
  `;

  // Resource display colors come from definitions/resources.json (via manifestData),
  // with a hardcoded fallback so the profile still renders if the manifest is absent.
  const manifestResources = gameState.manifestData?.resources || [];
  const resourceColor = (name) => {
    const entry = manifestResources.find(r => r.name?.toLowerCase() === name.toLowerCase());
    return entry?.color || 'var(--accent-color)';
  };

  let chartsHTML = '';
  if (!hidePrivate) resourceKeys.forEach(res => {
    const stock = player.resources[res] || 0;
    const yields = totalYields[res] || 0;
    const upkeep = totalUpkeep[res] || 0;
    const net = netIncome[res] || 0;
    const tradeDelta = (netTrade && netTrade[res]) || 0;
    const projectedStock = Math.max(0, stock + net);

    const netClass = net > 0 ? 'positive' : (net < 0 ? 'negative' : 'neutral');
    const netStr = net > 0 ? `+${displayNum(net)}/turn` : (net < 0 ? `${displayNum(net)}/turn` : `0/turn`);

    // Stock Bar Scale & Segments
    const maxStockScale = Math.max(stock, projectedStock, stock + Math.abs(net), 60);
    let stockBarHTML = '';

    if (net >= 0) {
      const baseStockPct = Math.min(100, Math.round((stock / maxStockScale) * 100));
      const gainPct = Math.min(100 - baseStockPct, Math.round((net / maxStockScale) * 100));
      stockBarHTML = `
        <div class="stock-bar-container" title="Current Stock: ${displayNum(stock)} | Projected Gain: ${displayNum(net)} | Projected Next Turn: ${displayNum(projectedStock)}">
          <div class="stock-bar-current" style="width: ${baseStockPct}%;"></div>
          <div class="stock-bar-gain" style="width: ${gainPct}%;"></div>
        </div>
      `;
    } else {
      const deficitAmount = Math.min(stock, Math.abs(net));
      const safeStock = Math.max(0, stock - deficitAmount);
      const safeStockPct = Math.min(100, Math.round((safeStock / maxStockScale) * 100));
      const lossPct = Math.min(100 - safeStockPct, Math.round((deficitAmount / maxStockScale) * 100));
      stockBarHTML = `
        <div class="stock-bar-container" title="Current Stock: ${displayNum(stock)} | Projected Loss: ${displayNum(net)} | Projected Next Turn: ${displayNum(projectedStock)}">
          <div class="stock-bar-current" style="width: ${safeStockPct}%;"></div>
          <div class="stock-bar-loss" style="width: ${lossPct}%;"></div>
        </div>
      `;
    }

    // Yield vs Upkeep Sub-bar
    const maxFlowScale = Math.max(yields + upkeep, 15);
    const yieldPct = Math.min(100, Math.round((yields / maxFlowScale) * 100));
    const upkeepPct = Math.min(100, Math.round((upkeep / maxFlowScale) * 100));

    const color = resourceColor(res);
    const projectionText = net >= 0 ? `<span class="text-positive">(+${displayNum(net)} ➔ ${displayNum(projectedStock)})</span>` : `<span class="text-negative">(${displayNum(net)} ➔ ${displayNum(projectedStock)})</span>`;

    chartsHTML += `
      <div class="resource-chart-row">
        <div class="resource-chart-header">
          <span class="resource-chart-name" style="color: ${color};">
            ● ${res}
          </span>
          <div class="flex-row">
            <span class="text-muted-small">Stock: <strong>${displayNum(stock)}</strong> ${projectionText}</span>
            <span class="resource-chart-net ${netClass}">${netStr}</span>
          </div>
        </div>

        ${stockBarHTML}

        <div class="stacked-bar-container stacked-bar-spaced">
          <div class="stacked-bar-yield" style="width: ${yieldPct}%;" title="Yields: +${displayNum(yields)}/turn"></div>
          <div class="stacked-bar-upkeep" style="width: ${upkeepPct}%;" title="Upkeep: -${displayNum(upkeep)}/turn"></div>
        </div>

        <div class="resource-details-line">
          <span class="text-positive">▲ Yield: +${displayNum(yields)}/turn</span>
          <span class="text-negative">▼ Upkeep: -${displayNum(upkeep)}/turn</span>
          ${tradeDelta !== 0 ? `<span style="color: ${tradeDelta > 0 ? '#10b981' : '#f87171'};">⇄ Trade: ${tradeDelta > 0 ? '+' : ''}${displayNum(tradeDelta)}/turn</span>` : ''}
        </div>
      </div>
    `;
  });

  // Active trade agreements section for full modal view
  let tradesHTML = '';
  if (!isCompact && !hidePrivate) {
    const trades = activeTrades || [];
    let tradesContent = '';
    if (trades.length > 0) {
      tradesContent = trades.map(trade => {
        const isP1 = String(trade.player1Id) === String(player.id);
        const partnerId = isP1 ? trade.player2Id : trade.player1Id;
        const partner = gameState.players.find(p => String(p.id) === String(partnerId));
        const partnerName = partner ? partner.name : 'Unknown Empire';
        const partnerColor = partner ? partner.color : '#fff';
        const sentBundle = isP1 ? trade.bundle1 : trade.bundle2;
        const recBundle = isP1 ? trade.bundle2 : trade.bundle1;
        const isHumanInvolved = !player.isAI || (gameState.activePlayer && !gameState.activePlayer.isAI && (String(trade.player1Id) === String(gameState.activePlayer.id) || String(trade.player2Id) === String(gameState.activePlayer.id)));

        return `
          <div class="trade-ongoing-item" style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; margin-bottom: 6px;">
            <div style="display: flex; flex-direction: column; gap: 3px;">
              <div style="display: flex; align-items: center; gap: 6px;">
                <span class="player-color-dot" style="background-color: ${partnerColor}; width: 8px; height: 8px;"></span>
                <strong style="color: #fff; font-size: 12px;">With ${escapeHTML(partnerName)}</strong>
                <span class="text-muted-tiny" style="font-size: 10px; color: var(--text-muted);">(Since Round ${trade.createdRound})</span>
              </div>
              <div style="font-size: 11px;">
                <span style="color: #f87171;">Sending: -${escapeHTML(formatResourceBundle(sentBundle))}/turn</span> &nbsp;|&nbsp;
                <span style="color: #10b981;">Receiving: +${escapeHTML(formatResourceBundle(recBundle))}/turn</span>
              </div>
            </div>
            ${isHumanInvolved ? `
              <button class="btn btn-small btn-cancel-profile-trade" data-trade-id="${trade.id}" style="background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.5); color: #f87171; padding: 4px 10px; font-size: 11px; cursor: pointer;">
                Cancel Agreement
              </button>
            ` : ''}
          </div>
        `;
      }).join('');
    } else {
      tradesContent = `<div class="text-muted-small" style="padding: 6px 0;">No active ongoing per-turn trade agreements.</div>`;
    }

    tradesHTML = `
      <div class="divider divider-spaced"></div>
      <div class="section-title section-title-row">
        <span>Active Trade Agreements</span>
        <span class="text-muted-small">${trades.length} active</span>
      </div>
      <div style="margin-top: 6px;">
        ${tradesContent}
      </div>
    `;
  }

  // Entity breakdown section for full modal view
  let entityBreakdownHTML = '';
  if (!isCompact && !hidePrivate && myEntities.length > 0) {
    const entityCounts = {};
    myEntities.forEach(e => {
      entityCounts[e.name] = (entityCounts[e.name] || 0) + 1;
    });

    const chips = Object.entries(entityCounts)
      .map(([name, count]) => `<span class="entity-chip"><strong>${name}</strong> x${count}</span>`)
      .join(' ');

    entityBreakdownHTML = `
      <div class="divider divider-spaced"></div>
      <div class="section-title">Owned Entities Breakdown</div>
      <div class="flex-wrap-gap">
        ${chips}
      </div>
    `;
  }

  // History panel section for full modal view
  let historyHTML = '';
  if (!isCompact && !hidePrivate) {
    // Get all rounds that have history (newest first)
    const allRounds = Array.from(player.history.keys()).sort((a, b) => b - a);

    // Pagination settings — L9: was a magic 5 buried in the function.
    const roundsPerPage = HISTORY_ROUNDS_PER_PAGE;
    const currentPage = parseInt(sessionStorage.getItem('historyCurrentPage') || '0', 10);
    const totalPages = Math.ceil(allRounds.length / roundsPerPage);
    const validPage = Math.max(0, Math.min(currentPage, totalPages - 1));

    const startIdx = validPage * roundsPerPage;
    const endIdx = Math.min(startIdx + roundsPerPage, allRounds.length);
    const pageRounds = allRounds.slice(startIdx, endIdx);

    let historyEntriesHTML = '';
    if (pageRounds.length > 0) {
      for (const round of pageRounds) {
        const entries = player.history.get(round) || [];
        if (entries.length === 0) continue;

        historyEntriesHTML += `
          <div class="history-round-group">
            <div class="history-round-header">
              Round ${round} (${entries.length} events)
            </div>
            <div class="history-entries">
        `;

        for (const entry of entries) {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          const categoryColors = {
            'action': '#a78bfa',
            'damage': '#e74c3c',
            'spawn': '#2ecc71',
            'destroy': '#e67e22',
            'orders': '#f1c40f',
            'trade': '#10b981',
            'note': '#38bdf8'
          };
          const categoryColor = categoryColors[entry.category] || 'var(--text-main)';

          historyEntriesHTML += `
            <div class="history-entry" style="font-size: 11px; padding: 6px 8px; background: rgba(255,255,255,0.03); border-radius: 4px; border-left: 3px solid ${categoryColor};">
              <div class="flex-row-between">
                <span style="color: ${categoryColor}; font-weight: 600; text-transform: uppercase; font-size: 10px;">${escapeHTML(entry.category)}</span>
                <span class="text-muted-tiny">${escapeHTML(time)}</span>
              </div>
              <div class="history-entry-text">
                ${escapeHTML(entry.details)}
              </div>
            </div>
          `;
        }

        historyEntriesHTML += `
            </div>
          </div>
        `;
      }
    } else {
      historyEntriesHTML = '<div class="history-empty">No history entries yet.</div>';
    }

    // Simple pagination controls (fixed 5 rounds per page)
    const paginationHTML = totalPages > 1 ? `
      <div class="history-pagination">
        <button id="history-prev-page" class="btn btn-small btn-auto" ${validPage === 0 ? 'disabled' : ''}>← Prev</button>
        <span class="pagination-label">Page ${validPage + 1} of ${totalPages} (5 rounds/page)</span>
        <button id="history-next-page" class="btn btn-small btn-auto" ${validPage >= totalPages - 1 ? 'disabled' : ''}>Next →</button>
      </div>
    ` : '';

    historyHTML = `
      <div class="divider divider-spaced"></div>
      <div class="section-title section-title-row">
        <span>History</span>
        <span class="text-muted-small">${allRounds.length} rounds recorded</span>
      </div>
      <div id="history-panel-content" class="history-scroll">
        ${historyEntriesHTML}
      </div>
      ${paginationHTML}
    `;
  }

  const titleHeader = isCompact ? `
    <div class="flex-row flex-row-spaced">
      <span class="player-color-dot" style="background-color: ${player.color};"></span>
      <strong class="profile-title">${escapeHTML(player.name)} Resource Profile</strong>
    </div>
  ` : '';

  return `
    ${titleHeader}
    ${summaryHTML}
    ${hidePrivate
      ? `<div class="text-muted-small" style="margin-top: 8px;">Resource info and history are hidden for AI players unless SHOW_ALL is enabled.</div>`
      : `<div class="section-title section-title-spaced">Resource Flow & Balance</div>
    ${chartsHTML}
    ${tradesHTML}
    ${entityBreakdownHTML}
    ${historyHTML}`}
  `;
}

/* ==========================================================================
   RESOURCE PROFILE VISUALIZER (MODAL & TOOLTIP)
   ========================================================================== */

function openProfileModal(player, gameState) {
  if (!player || !gameState) return;
  const overlay = document.getElementById('profile-modal-overlay');
  const colorDot = document.getElementById('profile-modal-color');
  const nameSpan = document.getElementById('profile-modal-player-name');
  const content = document.getElementById('profile-modal-content');

  colorDot.style.backgroundColor = player.color;
  nameSpan.textContent = `${player.name.toUpperCase()} — RESOURCE PROFILE`;

  function updateModalContent() {
    content.innerHTML = renderResourceProfileHTML(player, gameState, false);

    const prevBtn = document.getElementById('history-prev-page');
    const nextBtn = document.getElementById('history-next-page');

    if (prevBtn) {
      prevBtn.onclick = () => {
        const currentPage = parseInt(sessionStorage.getItem('historyCurrentPage') || '0', 10);
        sessionStorage.setItem('historyCurrentPage', String(currentPage - 1));
        updateModalContent();
      };
    }

    if (nextBtn) {
      nextBtn.onclick = () => {
        const currentPage = parseInt(sessionStorage.getItem('historyCurrentPage') || '0', 10);
        sessionStorage.setItem('historyCurrentPage', String(currentPage + 1));
        updateModalContent();
      };
    }

    const cancelBtns = content.querySelectorAll('.btn-cancel-profile-trade');
    cancelBtns.forEach(btn => {
      btn.onclick = (e) => {
        const tradeId = e.currentTarget.getAttribute('data-trade-id');
        if (!tradeId) return;
        // cancelTrade now requires an actual participant. The viewed player is
        // used when it is human; for an AI profile, use the human participant.
        const trade = (gameState.trades || []).find(t => String(t.id) === String(tradeId));
        const human = !player.isAI
          ? player
          : gameState.players.find(p => !p.isAI && trade &&
            (String(trade.player1Id) === String(p.id) || String(trade.player2Id) === String(p.id)));
        if (human) {
          gameState.cancelTrade(tradeId, human);
          updatePlayersUI(gameState, { onContextMenu: showPlayerContextMenu });
          updateModalContent();
        }
      };
    });
  }

  updateModalContent();
  overlay.classList.add('active');
}
/* ==========================================================================
   INTERACTION & SELECTION HANDLERS
   ========================================================================== */

function handleLeftClick(event) {
  // M4: no actions after the game is over.
  if (gameState.gameOver) return;
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
  // M2: only pass the target entity if the cell is visible to a human —
  // the old code passed any entity (including hidden enemies) to
  // action.canDo, whose reason text leaked the enemy's presence, type
  // and HP, and allowed attacking unseen units.
  const targetEntity = gameState.isVisibleToHuman(hovered)
    ? gameState.getEntityAt(hovered.q, hovered.r)
    : null;

  const candidateActions = selectedEntity.getActions();
  showContextMenu(event.clientX, event.clientY, selectedEntity, candidateActions, targetCell, targetEntity);
}

function selectEntity(entity, quiet = false) {
  selectedEntity = entity;
  // L9: quiet re-selects (after an action) skip the SFX/toast so they
  // don't overwrite the action result.
  if (!quiet) {
    audio.playEntitySfx(entity, 'select');
    showToast(`Selected ${entity.name.toUpperCase()}`);
  }
  const cell = entity.cell || gameState.hexGrid.cells.get(`${entity.q},${entity.r}`);

  if (cell) {
    const { x, z } = HexGrid.axialToPixel(cell.q, cell.r);
    setEntitySelectionHighlight(x, cell.terrain ? cell.terrain.height : 1.0, z);
  }
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

function showContextMenu(x, y, entity, actions, targetCell, targetEntity) {
  const menu = document.getElementById('entity-context-menu');
  const title = document.getElementById('context-menu-title');
  const actionsDiv = document.getElementById('context-menu-actions');

  title.textContent = `${entity.name.toUpperCase()} ACTIONS`;
  actionsDiv.innerHTML = '';
  clearPathHighlight();

  const pathCellKeys = new Set();
  const pathCellsToHighlight = [];

  if (actions && actions.length > 0) {
    actions.forEach(action => {
      const check = action.canDo ? action.canDo(targetCell, targetEntity) : { possible: true, reason: action.description || '' };
      const isPossible = check.possible !== false;
      const previewText = check.reason || action.description || '';

      if (check.path && check.path.length > 0) {
        for (const cell of check.path) {
          const key = `${cell.q},${cell.r}`;
          if (!pathCellKeys.has(key)) {
            pathCellKeys.add(key);
            pathCellsToHighlight.push(cell);
          }
        }
      }

      // Extract build stats if this is a build action
      let buildStatsHTML = '';
      if (action.name && action.name.toLowerCase().startsWith('build ')) {
        const buildTarget = action.name.substring(6).trim();
        const manifestEntities = gameState?.manifestData?.entities || {};
        let meta = manifestEntities[buildTarget];
        if (!meta) {
          const entry = Object.entries(manifestEntities).find(([k]) => k.toLowerCase() === buildTarget.toLowerCase());
          if (entry) meta = entry[1];
        }
        if (meta) {
          const upkeepParts = Object.entries(meta.maintenance || {}).map(([r, a]) => `${a} ${r}`);
          const upkeepStr = upkeepParts.length > 0 ? upkeepParts.join(', ') : 'None';
          const yieldParts = Object.entries(meta.yields || {}).map(([r, a]) => `+${a} ${r}`);
          const yieldStr = yieldParts.length > 0 ? yieldParts.join(', ') : 'None';
          buildStatsHTML = `
            <div style="font-size: 10px; color: #38bdf8; margin-top: 3px; display: flex; gap: 8px; flex-wrap: wrap;">
              <span><strong>Upkeep:</strong> ${upkeepStr}</span>
              <span><strong>Yield:</strong> ${yieldStr}</span>
            </div>
          `;
        }
      }

      const btn = document.createElement('button');
      btn.className = 'context-action-btn';
      if (!isPossible) {
        btn.style.opacity = '0.5';
        btn.style.cursor = 'not-allowed';
      }

      btn.innerHTML = `
        <div style="display: flex; flex-direction: column; width: 100%;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <strong style="font-size: 12px; color: ${isPossible ? '#ffffff' : '#999999'};">${action.name}</strong>
            <span style="font-size: 10px; color: ${isPossible ? 'var(--accent-color)' : '#666666'};">►</span>
          </div>
          <span style="font-size: 10px; color: ${isPossible ? '#a78bfa' : '#ff6b6b'}; margin-top: 1px;">${previewText}</span>
          ${buildStatsHTML}
        </div>
      `;

      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        hideContextMenu();

        // M4: no actions after the game is over.
        if (gameState.gameOver) {
          showToast('Game is over. Start a new game.', true);
          return;
        }

        if (!isPossible) {
          showToast(check.reason || 'Action cannot be performed.', true);
          return;
        }

        const success = action.do ? action.do(targetCell, targetEntity) : false;

        if (success) {
          audio.playEntitySfx(selectedEntity, 'action', action.name);
          showToast(check.reason || `Executed ${action.name}`);
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
        updatePlayersUI(gameState, { onContextMenu: showPlayerContextMenu });

        if (selectedEntity && !gameState.entities.includes(selectedEntity)) {
          deselectEntity();
        } else if (selectedEntity) {
          // L9: re-select quietly — the full selectEntity plays the select
          // SFX and shows a "Selected X" toast, overwriting the action
          // result toast shown just above.
          selectEntity(selectedEntity, true);
        }
      });
      actionsDiv.appendChild(btn);
    });

    if (pathCellsToHighlight.length > 0) {
      highlightPathCells(pathCellsToHighlight);
    }
  } else {
    actionsDiv.innerHTML = '<div style="font-size: 11px; color: var(--text-muted); padding: 4px;">No actions available for target cell</div>';
  }

  // Position and display menu directly without frame-delay to prevent top-left fly-in
  menu.style.display = 'flex';
  menu.style.visibility = 'hidden';
  const menuWidth = menu.offsetWidth || 280;
  const menuHeight = menu.offsetHeight || 220;

  const posX = Math.max(10, Math.min(x, window.innerWidth - menuWidth - 10));
  const posY = Math.max(10, Math.min(y, window.innerHeight - menuHeight - 10));

  menu.style.left = `${posX}px`;
  menu.style.top = `${posY}px`;
  menu.style.visibility = 'visible';
}

function hideContextMenu() {
  const menu = document.getElementById('entity-context-menu');
  if (menu) menu.style.display = 'none';
  clearPathHighlight();
}

let playerContextMenuTarget = null;

export function showPlayerContextMenu(x, y, targetPlayer) {
  hideContextMenu();
  const menu = document.getElementById('player-context-menu');
  if (!menu) return;

  playerContextMenuTarget = targetPlayer;

  menu.style.display = 'flex';
  menu.style.visibility = 'hidden';
  const menuWidth = menu.offsetWidth || 170;
  const menuHeight = menu.offsetHeight || 50;

  const posX = Math.max(10, Math.min(x, window.innerWidth - menuWidth - 10));
  const posY = Math.max(10, Math.min(y, window.innerHeight - menuHeight - 10));

  menu.style.left = `${posX}px`;
  menu.style.top = `${posY}px`;
  menu.style.visibility = 'visible';
}

export function hidePlayerContextMenu() {
  const menu = document.getElementById('player-context-menu');
  if (menu) menu.style.display = 'none';
  playerContextMenuTarget = null;
}


/* ==========================================================================
   DIPLOMATIC CHAT SYSTEM (MODAL & MESSAGING)
   ========================================================================== */


function closeProfileModal() {
  const overlay = document.getElementById('profile-modal-overlay');
  if (overlay) overlay.classList.remove('active');
}

function onMouseMove(event) {
  if (!gameState) return;  // no game started yet

  // Do not update hover inspection or path preview when context menu is open
  const contextMenu = document.getElementById('entity-context-menu');
  if (contextMenu && contextMenu.style.display !== 'none') {
    return;
  }

  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  const hovered = pickHexCell(mouse, gameState);
  const infoPanel = document.getElementById('inspect-panel');
  const activePlayer = gameState.activePlayer;

  if (hovered) {
    // M1: use the renderer's POV (gameState.isVisibleToHuman /
    // isExploredByHuman) — the old code fell back to `true` when there was
    // no active player (round-end, activePlayerIndex -1), leaking full
    // entity info for seconds each round.
    const isExplored = CONFIG.SHOW_ALL || gameState.isExploredByHuman(hovered);
    const isVisible = CONFIG.SHOW_ALL || gameState.isVisibleToHuman(hovered);

    highlightCell(hovered.q, hovered.r, isExplored ? hovered.terrain.height : 3.0);

    document.getElementById('inspect-coords').textContent = `(${hovered.q}, ${hovered.r})`;

    if (!isExplored) {
      document.getElementById('inspect-terrain').textContent = 'Unexplored (Fog of War)';
      document.getElementById('inspect-height').textContent = '?';
      document.getElementById('inspect-elevation').textContent = '?';
      document.getElementById('inspect-temperature').textContent = '?';
      document.getElementById('inspect-humidity').textContent = '?';
    } else {
      document.getElementById('inspect-terrain').textContent = `${hovered.terrain.name}${!isVisible ? ' (Fog of War)' : ''}`;
      document.getElementById('inspect-height').textContent = hovered.terrain.height.toFixed(2);
      document.getElementById('inspect-elevation').textContent = hovered.terrain.elevation.toFixed(2);
      document.getElementById('inspect-temperature').textContent = hovered.terrain.temperature.toFixed(2);
      document.getElementById('inspect-humidity').textContent = hovered.terrain.humidity.toFixed(2);
    }

    // Natural resource / treasure on the hovered cell (hidden under fog of war)
    const resourceRow = document.getElementById('inspect-resource-row');
    const resourceValue = document.getElementById('inspect-resource');
    const hoveredCell = gameState.hexGrid.cells.get(`${hovered.q},${hovered.r}`);
    if (isExplored && hoveredCell && hoveredCell.resource) {
      const res = hoveredCell.resource;
      const kindLabel = res.kind === 'treasure' ? 'Treasure' : 'Resource';
      resourceValue.textContent = `${kindLabel}: ${prettifyName(res.name)} ×${res.quantity}`;
      resourceRow.style.display = 'flex';
    } else if (resourceRow) {
      resourceRow.style.display = 'none';
    }

    const entity = gameState.getEntityAt(hovered.q, hovered.r);
    const entitiesDiv = document.getElementById('inspect-entities');
    entitiesDiv.innerHTML = '';

    const showEntityInInspect = entity && (
      (entity.owner && activePlayer && entity.owner.id === activePlayer.id && isExplored) ||
      isVisible
    );

    // 1. Exclusion Zone Preview on Unit/Construct Hover
    if (entity && showEntityInInspect) {
      const manifestEntities = gameState?.manifestData?.entities || {};
      const meta = manifestEntities[entity.name] || manifestEntities[entity.name.toLowerCase()];
      if (meta && meta.spawnConditions && typeof meta.spawnConditions.minSeparation === 'number' && meta.spawnConditions.minSeparation > 1) {
        showExclusionZone(entity.q, entity.r, meta.spawnConditions.minSeparation, entity.owner ? entity.owner.color : '#3498db', gameState);
      } else {
        clearExclusionZone();
      }
    } else {
      clearExclusionZone();
    }

    // 1b. Zone of Control Preview on non-own Entity Hover (Phase 24)
    const isNonOwnEntity = entity && showEntityInInspect && entity.owner && activePlayer && entity.owner.id !== activePlayer.id;
    const zocRadius = entity ? (entity.zoneOfControlRadius ?? 0) : 0;
    if (isNonOwnEntity && zocRadius > 0) {
      showZoneOfControl(entity.q, entity.r, zocRadius, entity.owner.color || '#e74c3c', gameState);
    } else {
      clearZoneOfControl();
    }

    // 2. Movement Path and Cost Preview when a unit with "Move" is selected (only when movement is possible)
    const moveRow = document.getElementById('inspect-movement-row');
    const moveValue = document.getElementById('inspect-movement');
    const moveAction = selectedEntity && selectedEntity.owner && activePlayer && selectedEntity.owner.id === activePlayer.id && !activePlayer.isAI
      ? selectedEntity.getActions().find(a => a.name === "Move")
      : null;

    if (moveAction && isExplored) {
      if (hovered.q === selectedEntity.q && hovered.r === selectedEntity.r) {
        clearPathHighlight();
        if (moveRow) moveRow.style.display = 'none';
      } else {
        const targetOccupant = gameState.getEntityAt(hovered.q, hovered.r);
        const check = moveAction.canDo(hovered, targetOccupant);
        if (check && check.possible && check.path && check.path.length > 1) {
          highlightPathCells(check.path);
          const ap = selectedEntity.actionPoints !== undefined ? selectedEntity.actionPoints : 0;
          const cost = check.cost;
          if (moveRow && moveValue) {
            moveRow.style.display = 'flex';
            moveValue.innerHTML = `<span style="color: #2ecc71; font-weight: 600;">${displayNum(cost)} AP</span> (${check.path.length - 1} steps, ${displayNum(ap)} AP avail)`;
          }
        } else {
          clearPathHighlight();
          if (moveRow && moveValue) {
            moveRow.style.display = 'flex';
            moveValue.innerHTML = `<span style="color: #e74c3c; font-weight: 600;">${check ? check.reason : 'Cannot move'}</span>`;
          }
        }
      }
    } else {
      if (moveRow) moveRow.style.display = 'none';
      clearPathHighlight();
    }

    if (showEntityInInspect) {
      const isSelected = selectedEntity && selectedEntity.id === entity.id;

      const entityRow = document.createElement('div');
      entityRow.style.marginBottom = '6px';
      if (isSelected) {
        entityRow.style.background = 'rgba(0, 255, 255, 0.1)';
        entityRow.style.border = '1px solid rgba(0, 255, 255, 0.4)';
        entityRow.style.borderRadius = '4px';
        entityRow.style.padding = '4px';
      }

      const playerColor = entity.owner ? entity.owner.color : '#cccccc';
      entityRow.innerHTML = `
        <div style="font-weight: 600; color: ${isSelected ? '#00ffff' : 'var(--text-main)'}; display: flex; align-items: center;">
          <span class="player-color-dot" style="background-color: ${playerColor}; margin-right: 6px;"></span>
          ${entity.name.toUpperCase()} ${isSelected ? ' ★ SELECTED' : ''}
        </div>
        <div style="font-size: 11px; color: var(--text-muted); margin-left: 16px; margin-top: 2px;">
          ${entity.info()}
        </div>
      `;
      entitiesDiv.appendChild(entityRow);
    } else {
      entitiesDiv.textContent = isExplored ? 'None' : 'Unknown';
    }

    infoPanel.classList.add('active');
  } else {
    highlightCell(null, null);
    clearExclusionZone();
    clearZoneOfControl();
    const moveRow = document.getElementById('inspect-movement-row');
    if (moveRow) moveRow.style.display = 'none';
    const resourceRow = document.getElementById('inspect-resource-row');
    if (resourceRow) resourceRow.style.display = 'none';
    const contextMenu = document.getElementById('entity-context-menu');
    if (!contextMenu || contextMenu.style.display === 'none') {
      clearPathHighlight();
    }
    if (!selectedEntity) {
      infoPanel.classList.remove('active');
    }
  }
}

/**
 * "smallRuins" -> "Small Ruins", "tree" -> "Tree".
 */
function prettifyName(name) {
  if (!name) return '';
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}

window.addEventListener('DOMContentLoaded', init);