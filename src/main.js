import { GameState } from './gameState.js';
import { CONFIG } from './config.js';
import {
  initRenderer,
  drawGrid,
  highlightCell,
  highlightPathCells,
  clearPathHighlight,
  showExclusionZone,
  clearExclusionZone,
  raycastHex,
  setEntitySelectionHighlight,
  clearEntitySelectionHighlight,
  preloadModels,
  reconcileEntities,
  clearEntityMeshes,
  focusCameraOnEntities
} from './renderer.js';
import { loadGameManifest } from './manifestLoader.js';
import { HexGrid } from './hexGrid.js';
import { saveGame, loadGame, listSaves, deleteSave, pruneAutoSaves } from './saveManager.js';

let gameState;
let manifestData;
let defaultSettings;
let currentGameSettings = null;

const mouse = { x: 0, y: 0 };
let selectedEntity = null;
let pointerDownPos = { x: 0, y: 0 };
let pointerDownTime = 0;

// Local setup state before starting game
let setupPlayers = [];
let setupStartingUnits = {};

/**
 * Initializes the application.
 */
async function init() {
  try {
    // 1. Parse manifest URL parameter & load default settings
    const urlParams = new URLSearchParams(window.location.search);
    const manifestUrl = urlParams.get('manifest') || './manifest.json';

    const [manifestResult, settingsResult] = await Promise.all([
      loadGameManifest(manifestUrl),
      fetch('./defaultSettings.json').then(r => r.json())
    ]);

    manifestData = manifestResult;
    defaultSettings = settingsResult;

    // 2. Initialize 3D Renderer and preload models
    const canvas = document.getElementById('game-canvas');
    initRenderer(canvas);
    await preloadModels(manifestData.entities);

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
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        hideContextMenu();
        deselectEntity();
        closeSaveLoadModal();
        closeProfileModal();
        if (gameState) {
          closeSetupModal();
        }
      }
    });

    // Control buttons
    document.getElementById('btn-new-game').addEventListener('click', () => openSetupModal(true));
    document.getElementById('btn-save-game').addEventListener('click', () => openSaveLoadModal('save'));
    document.getElementById('btn-load-game').addEventListener('click', () => openSaveLoadModal('load'));
    document.getElementById('btn-next-turn').addEventListener('click', nextTurn);

    // Modal UI buttons
    document.getElementById('btn-start-game').addEventListener('click', handleStartGameClicked);
    document.getElementById('btn-add-player').addEventListener('click', addSetupPlayerRow);
    document.getElementById('btn-add-starting-unit').addEventListener('click', addSetupUnitRow);
    document.getElementById('btn-close-setup').addEventListener('click', closeSetupModal);
    document.getElementById('btn-close-saveload').addEventListener('click', closeSaveLoadModal);
    document.getElementById('btn-close-profile').addEventListener('click', closeProfileModal);
    document.getElementById('btn-do-manual-save').addEventListener('click', handleManualSaveClicked);

    // Open Setup Modal automatically on initial load
    openSetupModal(false);

    console.log('Empire game initialized successfully.');
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

  // Map size
  document.getElementById('setup-map-size').value = defaultSettings.mapSize || 64;

  // Orders
  const orders = defaultSettings.initialization?.orders || { max: 8, initial: 8, perTurn: 6 };
  document.getElementById('setup-orders-max').value = orders.max;
  document.getElementById('setup-orders-initial').value = orders.initial;
  document.getElementById('setup-orders-perturn').value = orders.perTurn;

  // Players
  setupPlayers = JSON.parse(JSON.stringify(defaultSettings.players || [
    { id: 1, name: 'Red Empire', color: '#ff4d4d', controller: null },
    { id: 2, name: 'Blue Alliance', color: '#3399ff', controller: null }
  ]));
  renderSetupPlayers();

  // Resources
  renderSetupResources();

  // Units
  setupStartingUnits = { ...(defaultSettings.initialization?.startingUnits || {}) };
  populateUnitSelectOptions();
  renderSetupUnits();

  // Auto-Save
  const autoSave = defaultSettings.autoSave || { enabled: true, intervalTurns: 5, maxAutoSaves: 10 };
  document.getElementById('setup-autosave-enabled').checked = autoSave.enabled;
  document.getElementById('setup-autosave-interval').value = autoSave.intervalTurns;
  document.getElementById('setup-autosave-max').value = autoSave.maxAutoSaves;

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

    const isAI = p.controller !== null && p.controller !== undefined;

    row.innerHTML = `
      <input type="color" value="${p.color}" title="Choose color">
      <input type="text" class="form-input" value="${p.name}" placeholder="Player Name" style="flex: 1;">
      <label style="font-size: 12px; display: flex; align-items: center; gap: 4px; cursor: pointer;">
        <input type="checkbox" class="ai-checkbox" ${isAI ? 'checked' : ''}> AI
      </label>
      <button type="button" class="btn btn-danger btn-small" ${setupPlayers.length <= 1 ? 'disabled style="opacity:0.3;cursor:not-allowed;"' : ''}>✕</button>
    `;

    // Event listeners for fields
    const colorInput = row.querySelector('input[type="color"]');
    const nameInput = row.querySelector('input[type="text"]');
    const aiCheckbox = row.querySelector('.ai-checkbox');
    const removeBtn = row.querySelector('.btn-danger');

    colorInput.addEventListener('change', (e) => { p.color = e.target.value; });
    nameInput.addEventListener('input', (e) => { p.name = e.target.value; });
    aiCheckbox.addEventListener('change', (e) => {
      // If AI selected, set controller to empty object as requested by user
      p.controller = e.target.checked ? {} : null;
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
    controller: null
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
      <input type="number" id="res-val-${res}" class="form-input" value="${val}" min="0" style="padding: 4px 8px;">
    `;
    container.appendChild(box);
  };
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

    row.innerHTML = `
      <strong style="font-size: 13px; text-transform: uppercase; flex: 1;">${unitName}</strong>
      <span style="font-size: 11px; color: var(--text-muted);">Count:</span>
      <input type="number" class="form-input" value="${qty}" min="1" style="width: 70px; padding: 4px 8px;">
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
}

function addSetupUnitRow() {
  const select = document.getElementById('setup-add-unit-select');
  const unitName = select.value;
  if (unitName && setupStartingUnits[unitName] === undefined) {
    setupStartingUnits[unitName] = 1;
    renderSetupUnits();
  }
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

  const settings = {
    mapSize: parseInt(document.getElementById('setup-map-size').value, 10),
    players: setupPlayers.map((p, i) => ({
      id: i + 1,
      name: p.name.trim() || `Player ${i + 1}`,
      color: p.color,
      controller: p.controller
    })),
    initialization: {
      orders: {
        max: parseInt(document.getElementById('setup-orders-max').value, 10) || 8,
        initial: parseInt(document.getElementById('setup-orders-initial').value, 10) || 8,
        perTurn: parseInt(document.getElementById('setup-orders-perturn').value, 10) || 6
      },
      startingResources: startingResources,
      startingUnits: { ...setupStartingUnits }
    },
    autoSave: {
      enabled: document.getElementById('setup-autosave-enabled').checked,
      intervalTurns: parseInt(document.getElementById('setup-autosave-interval').value, 10) || 5,
      maxAutoSaves: parseInt(document.getElementById('setup-autosave-max').value, 10) || 10
    }
  };

  startNewGame({ ...settings, ...defaultSettings });
  closeSetupModal();
}

function startNewGame(settings) {
  currentGameSettings = settings;
  deselectEntity();
  hideContextMenu();
  clearEntityMeshes();

  gameState = new GameState();
  gameState.generateMap(settings.mapSize, manifestData.terrains);
  gameState.initializeManifest(manifestData, settings);

  drawGrid(gameState.cells, gameState.activePlayer);
  reconcileEntities(gameState);
  updatePlayersUI();

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
            <strong style="font-size: 14px;">${save.name}</strong>
            <span class="save-badge ${badgeClass}">${badgeText}</span>
          </div>
          <div style="font-size: 11px; color: var(--text-muted);">
            Round ${save.turnNumber || 1} • Saved on ${dateStr}
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

    drawGrid(gameState.cells, gameState.activePlayer);
    reconcileEntities(gameState);
    updatePlayersUI();

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
   TURN LIFECYCLE & AUTO-SAVE CHECK
   ========================================================================== */

/**
 * Next Turn: triggers endTurn on gameState, cycling to next player turn and updating Fog of War.
 */
export function nextTurn() {
  deselectEntity();
  hideContextMenu();

  gameState.endTurn();

  drawGrid(gameState.cells, gameState.activePlayer);
  reconcileEntities(gameState);
  updatePlayersUI();

  // Focus camera on center of mass of active player's entities
  if (gameState.activePlayer && gameState.entities.length > 0) {
    const playerEntities = gameState.activePlayer.getEntities(gameState);
    if (playerEntities.length > 0) {
      focusCameraOnEntities(playerEntities);
    }
  }

  showToast(`Turn passed to ${gameState.activePlayer ? gameState.activePlayer.name : ''} (Round ${gameState.currentRound})`);

  // Check auto-save condition
  checkAutoSave();
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

  const hovered = raycastHex(mouse);
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

  const hovered = raycastHex(mouse);
  if (!hovered) {
    hideContextMenu();
    return;
  }

  const targetCell = gameState.cells[`${hovered.q},${hovered.r}`];
  const targetEntity = gameState.getEntityAt(hovered.q, hovered.r);

  const candidateActions = selectedEntity.getActions();
  showContextMenu(event.clientX, event.clientY, selectedEntity, candidateActions, targetCell, targetEntity);
}

function selectEntity(entity) {
  selectedEntity = entity;
  const cell = entity.cell || gameState.cells[`${entity.q},${entity.r}`];

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

        if (!isPossible) {
          showToast(check.reason || 'Action cannot be performed.', true);
          return;
        }

        const success = action.do ? action.do(targetCell, targetEntity) : false;

        if (success) {
          showToast(check.reason || `Executed ${action.name}`);
        } else {
          showToast(`Failed to execute ${action.name}`, true);
        }

        drawGrid(gameState.cells, gameState.activePlayer);
        reconcileEntities(gameState);
        updatePlayersUI();

        if (selectedEntity && !gameState.entities.includes(selectedEntity)) {
          deselectEntity();
        } else if (selectedEntity) {
          selectEntity(selectedEntity);
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

let playerHoverTimer = null;

export function updatePlayersUI() {
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

    let resourceStr = '';
    if (player.resources) {
      resourceStr = Object.entries(player.resources)
        .map(([name, qty]) => `${name}: ${qty}`)
        .join(' | ');
    }

    const ordersStr = player.maxOrders > 0
      ? `orders: ${player.orders}/${player.maxOrders}`
      : '';

    const scoreStr = `total score: ${player.score.total} (${player.score.military} military, ${player.score.economic} economic, ${player.score.exploration} exploration)`;

    li.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="player-color-dot" style="background-color: ${player.color};"></span>
          <strong style="font-size: 14px; color: ${isActive ? '#ffffff' : 'var(--text-muted)'};">${player.name} ${isActive ? '◀ ACTIVE' : ''}</strong>
        </div>
        <span style="font-size: 10px; color: var(--accent-color); opacity: 0.8;">📊 Profile</span>
      </div>
      ${ordersStr ? `<div style="font-size: 11px; color: var(--accent-color); margin-left: 18px;">${ordersStr}</div>` : ''}
      ${scoreStr ? `<div style="font-size: 11px; color: var(--accent-color); margin-left: 18px;">${scoreStr}</div>` : ''}
      ${resourceStr ? `<div style="font-size: 11px; color: var(--text-muted); margin-left: 18px;">${resourceStr}</div>` : ''}
    `;

    // Long Hover (Tooltip) setup
    li.addEventListener('mouseenter', (ev) => {
      clearTimeout(playerHoverTimer);
      playerHoverTimer = setTimeout(() => {
        showResourceTooltip(player, ev.clientX, ev.clientY);
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
      openProfileModal(player);
    });

    container.appendChild(li);
  });
}

/* ==========================================================================
   RESOURCE PROFILE VISUALIZER (MODAL & TOOLTIP)
   ========================================================================== */

function openProfileModal(player) {
  if (!player || !gameState) return;
  const overlay = document.getElementById('profile-modal-overlay');
  const colorDot = document.getElementById('profile-modal-color');
  const nameSpan = document.getElementById('profile-modal-player-name');
  const content = document.getElementById('profile-modal-content');

  colorDot.style.backgroundColor = player.color;
  nameSpan.textContent = `${player.name.toUpperCase()} — RESOURCE PROFILE`;
  content.innerHTML = renderResourceProfileHTML(player, gameState, false);

  overlay.classList.add('active');
}

function closeProfileModal() {
  const overlay = document.getElementById('profile-modal-overlay');
  if (overlay) overlay.classList.remove('active');
}

function showResourceTooltip(player, x, y) {
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
  const { totalUpkeep, totalYields, netIncome } = player.getResourceProfile(gameState);
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
        <span class="profile-stat-val" style="color: #e74c3c;">${player.score.military}</span>
      </div>
      <div class="profile-stat-box">
        <span class="profile-stat-label">Economic Score</span>
        <span class="profile-stat-val" style="color: #f1c40f;">${player.score.economic}</span>
      </div>
      <div class="profile-stat-box">
        <span class="profile-stat-label">Exploration Score</span>
        <span class="profile-stat-val" style="color: #0f44f1ff;">${player.score.exploration}</span>
      </div>
      <div class="profile-stat-box">
        <span class="profile-stat-label">Orders</span>
        <span class="profile-stat-val" style="color: var(--accent-color);">${player.orders}/${player.maxOrders}</span>
      </div>
    </div>
  `;

  const resourceIconColors = {
    food: '#2ecc71',
    gold: '#f1c40f',
    iron: '#95a5a6',
    wood: '#e67e22',
    gems: '#9b59b6'
  };

  let chartsHTML = '';
  resourceKeys.forEach(res => {
    const stock = player.resources[res] || 0;
    const yields = totalYields[res] || 0;
    const upkeep = totalUpkeep[res] || 0;
    const net = netIncome[res] || 0;
    const projectedStock = Math.max(0, stock + net);

    const netClass = net > 0 ? 'positive' : (net < 0 ? 'negative' : 'neutral');
    const netStr = net > 0 ? `+${net}/turn` : (net < 0 ? `${net}/turn` : `0/turn`);

    // Stock Bar Scale & Segments
    const maxStockScale = Math.max(stock, projectedStock, stock + Math.abs(net), 60);
    let stockBarHTML = '';

    if (net >= 0) {
      const baseStockPct = Math.min(100, Math.round((stock / maxStockScale) * 100));
      const gainPct = Math.min(100 - baseStockPct, Math.round((net / maxStockScale) * 100));
      stockBarHTML = `
        <div class="stock-bar-container" title="Current Stock: ${stock} | Projected Gain: +${net} | Projected Next Turn: ${projectedStock}">
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
        <div class="stock-bar-container" title="Current Stock: ${stock} | Projected Loss: ${net} | Projected Next Turn: ${projectedStock}">
          <div class="stock-bar-current" style="width: ${safeStockPct}%;"></div>
          <div class="stock-bar-loss" style="width: ${lossPct}%;"></div>
        </div>
      `;
    }

    // Yield vs Upkeep Sub-bar
    const maxFlowScale = Math.max(yields + upkeep, 15);
    const yieldPct = Math.min(100, Math.round((yields / maxFlowScale) * 100));
    const upkeepPct = Math.min(100, Math.round((upkeep / maxFlowScale) * 100));

    const color = resourceIconColors[res.toLowerCase()] || 'var(--accent-color)';
    const projectionText = net >= 0 ? `<span style="color: #2ecc71;">(+${net} ➔ ${projectedStock})</span>` : `<span style="color: #e74c3c;">(${net} ➔ ${projectedStock})</span>`;

    chartsHTML += `
      <div class="resource-chart-row">
        <div class="resource-chart-header">
          <span class="resource-chart-name" style="color: ${color};">
            ● ${res}
          </span>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 11px; color: var(--text-muted);">Stock: <strong>${stock}</strong> ${projectionText}</span>
            <span class="resource-chart-net ${netClass}">${netStr}</span>
          </div>
        </div>

        ${stockBarHTML}

        <div class="stacked-bar-container" style="margin-top: 2px;">
          <div class="stacked-bar-yield" style="width: ${yieldPct}%;" title="Yields: +${yields}/turn"></div>
          <div class="stacked-bar-upkeep" style="width: ${upkeepPct}%;" title="Upkeep: -${upkeep}/turn"></div>
        </div>

        <div class="resource-details-line">
          <span style="color: #2ecc71;">▲ Yield: +${yields}/turn</span>
          <span style="color: #e74c3c;">▼ Upkeep: -${upkeep}/turn</span>
        </div>
      </div>
    `;
  });

  // Entity breakdown section for full modal view
  let entityBreakdownHTML = '';
  if (!isCompact && myEntities.length > 0) {
    const entityCounts = {};
    myEntities.forEach(e => {
      entityCounts[e.name] = (entityCounts[e.name] || 0) + 1;
    });

    const chips = Object.entries(entityCounts)
      .map(([name, count]) => `<span style="background: rgba(255,255,255,0.05); border: 1px solid var(--border-color); padding: 4px 8px; border-radius: 4px; font-size: 11px; text-transform: uppercase;"><strong>${name}</strong> x${count}</span>`)
      .join(' ');

    entityBreakdownHTML = `
      <div class="divider" style="margin: 16px 0 12px 0;"></div>
      <div class="section-title">Owned Entities Breakdown</div>
      <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px;">
        ${chips}
      </div>
    `;
  }

  const titleHeader = isCompact ? `
    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
      <span class="player-color-dot" style="background-color: ${player.color};"></span>
      <strong style="font-size: 13px; text-transform: uppercase;">${player.name} Resource Profile</strong>
    </div>
  ` : '';

  return `
    ${titleHeader}
    ${summaryHTML}
    <div class="section-title" style="margin-bottom: 8px;">Resource Flow & Balance</div>
    ${chartsHTML}
    ${entityBreakdownHTML}
  `;
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

  const hovered = raycastHex(mouse);
  const infoPanel = document.getElementById('inspect-panel');
  const activePlayer = gameState.activePlayer;

  if (hovered) {
    const isExplored = activePlayer ? activePlayer.isExplored(hovered.q, hovered.r) : true;
    const isVisible = activePlayer ? activePlayer.isVisible(hovered.q, hovered.r) : true;

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
            moveValue.innerHTML = `<span style="color: #2ecc71; font-weight: 600;">${cost.toFixed(1)} AP</span> (${check.path.length - 1} steps, ${ap} AP avail)`;
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
    const moveRow = document.getElementById('inspect-movement-row');
    if (moveRow) moveRow.style.display = 'none';
    const contextMenu = document.getElementById('entity-context-menu');
    if (!contextMenu || contextMenu.style.display === 'none') {
      clearPathHighlight();
    }
    if (!selectedEntity) {
      infoPanel.classList.remove('active');
    }
  }
}

function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.style.background = isError ? '#e74c3c' : '#2ecc71';
  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}

window.addEventListener('DOMContentLoaded', init);
