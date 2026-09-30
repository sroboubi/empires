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
import { audio } from './audio.js';
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
let setupLlmApiKey = '';
let setupLlmModels = []; // Array<{ id: string, name: string, enabled: boolean }>

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

    // Audio: hand the manifest to the SFX manager (file names are config-driven)
    // and initialize the Web Audio context (unlocked on first user gesture).
    audio.setManifest(manifestData);
    audio.init();

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

    // UI click sound for every button press (config-driven file, manifest sfx.ui.click).
    window.addEventListener('click', (e) => {
      if (e.target.closest('button')) {
        audio.playUi('click');
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        hideContextMenu();
        deselectEntity();
        closeSaveLoadModal();
        closeProfileModal();
        closeVictoryModal();
        if (gameState) {
          closeSetupModal();
        }
      }
    });

    // Control buttons
    document.getElementById('btn-save-game').addEventListener('click', () => openSaveLoadModal('save'));
    document.getElementById('btn-load-game').addEventListener('click', () => openSaveLoadModal('load'));

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

    // Barbarian setup UI bindings
    setupBarbarianUI();

    // LLM setup UI bindings
    setupLlmUI();

    // Open Setup Modal automatically on initial load
    openSetupModal(false);

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

  // Map size
  document.getElementById('setup-map-size').value = defaultSettings.mapSize || 64;

  // Orders
  const orders = defaultSettings.initialization?.orders || { max: 8, perTurn: 6 };
  document.getElementById('setup-orders-max').value = orders.max;
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

  // Barbarian Settings — dynamically render horde sliders from defaultSettings.barbarians.horde
  const barbarians = defaultSettings.barbarians || null;
  const enabledCheckbox = document.getElementById('setup-barbarians-enabled');
  const collapsible = document.getElementById('setup-barbarian-collapsible');
  enabledCheckbox.checked = barbarians !== null && barbarians !== undefined;
  collapsible.classList.toggle('expanded', enabledCheckbox.checked);

  // Render one range-slider widget per horde unit key found in settings
  renderBarbarianHordeSliders(barbarians?.horde || {});
  updateAllRangeFills();
  document.getElementById('setup-barbarian-spawn-frequency').value = barbarians?.spawnFrequencyTurns || 5;
  document.getElementById('setup-barbarian-max-number').value = barbarians?.maxNumber || 20;
  document.getElementById('setup-barbarian-max-age').value = barbarians?.maxAge || 30;

  // Win Conditions
  const winCondition = defaultSettings.winCondition || { absoluteScore: 1000, relativeScore: 2 };
  const absoluteEnabled = winCondition.absoluteScore !== undefined && winCondition.absoluteScore !== null;
  const relativeEnabled = winCondition.relativeScore !== undefined && winCondition.relativeScore !== null;
  document.getElementById('setup-win-absolute-enabled').checked = absoluteEnabled;
  document.getElementById('setup-win-absolute-value').value = winCondition.absoluteScore || 1000;
  document.getElementById('setup-win-absolute-value').disabled = !absoluteEnabled;
  document.getElementById('setup-win-relative-enabled').checked = relativeEnabled;
  document.getElementById('setup-win-relative-value').value = winCondition.relativeScore || 2;
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

  // Restore LLM configuration from session storage if available
  try {
    const savedLlm = sessionStorage.getItem('empires_openrouter_config') || sessionStorage.getItem('empires_llm_config');
    if (savedLlm) {
      const parsed = JSON.parse(savedLlm);
      if (parsed.apiKey) {
        setupLlmApiKey = parsed.apiKey;
        const keyInput = document.getElementById('setup-llm-api-key');
        if (keyInput) keyInput.value = setupLlmApiKey;
      }
      if (Array.isArray(parsed.models)) {
        setupLlmModels = parsed.models;
      } else if (Array.isArray(parsed.orderedModels)) {
        setupLlmModels = parsed.orderedModels.map(id => ({ id, name: id, enabled: true }));
      }
    }
  } catch (e) {
    console.warn('Failed to load LLM config from session storage:', e);
  }
  renderLlmModelList();

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
    controller: {} // Default to AI controller
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
    const minId  = `${prefix}-min`;
    const maxId  = `${prefix}-max`;
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
  const fill  = document.getElementById(cfg.fillId);
  if (!minEl || !maxEl || !fill) return;
  const min   = parseInt(minEl.min, 10);
  const max   = parseInt(minEl.max, 10);
  const range = max - min;
  const lo    = parseInt(minEl.value, 10);
  const hi    = parseInt(maxEl.value, 10);
  fill.style.left  = `${((lo - min) / range) * 100}%`;
  fill.style.width = `${((hi - lo) / range) * 100}%`;
}

function updateAllRangeFills() {
  // Enumerate all range-slider widgets currently in the DOM
  document.querySelectorAll('.range-slider[data-range-id]').forEach(slider => {
    const unitName = slider.dataset.rangeId;
    const prefix   = hordeUnitIdPrefix(unitName);
    updateRangeFill({
      minId:  `${prefix}-min`,
      maxId:  `${prefix}-max`,
      fillId: `${prefix}-range-fill`
    });
  });
}

/* --------------------------------------------------------------------------
   LLM SETUP UI: OpenRouter API Key, fetch models, priority selection & drag-and-drop
   -------------------------------------------------------------------------- */

const LLM_MAX_SELECTED = 3;
let draggedModelIndex = null;
let llmSearchQuery = '';

function setupLlmUI() {
  const keyInput = document.getElementById('setup-llm-api-key');
  const toggleBtn = document.getElementById('btn-toggle-llm-key');
  const fetchBtn = document.getElementById('btn-fetch-llm-models');
  const statusEl = document.getElementById('setup-llm-status');
  const searchInput = document.getElementById('setup-llm-search');

  if (!keyInput || !fetchBtn) return;

  // Toggle API key visibility
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
      toggleBtn.textContent = keyInput.type === 'password' ? '👁' : '🔒';
    });
  }

  // Update key on input
  keyInput.addEventListener('input', (e) => {
    setupLlmApiKey = e.target.value.trim();
  });

  // Search input — filter the rendered list on the frontend
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      llmSearchQuery = e.target.value.trim().toLowerCase();
      renderLlmModelList();
    });
  }

  // Fetch models sorted by intelligence (conditionally free-only)
  fetchBtn.addEventListener('click', async () => {
    setupLlmApiKey = keyInput.value.trim();
    const freeOnly = document.getElementById('setup-llm-free-only')?.checked ?? true;

    statusEl.style.color = 'var(--text-muted)';
    statusEl.textContent = freeOnly
      ? 'Fetching free models from OpenRouter...'
      : 'Fetching models from OpenRouter...';
    fetchBtn.disabled = true;

    try {
      const headers = {
        'HTTP-Referer': window.location.origin || 'http://localhost:3000',
        'X-Title': '4X Strategy Game'
      };
      if (setupLlmApiKey) {
        headers['Authorization'] = `Bearer ${setupLlmApiKey}`;
      }

      let url = 'https://openrouter.ai/api/v1/models?sort=intelligence-high-to-low';
      if (freeOnly) {
        url += '&max_price=0&min_price=0';
      }

      const response = await fetch(url, { headers });

      if (!response.ok) {
        throw new Error(`OpenRouter HTTP ${response.status}`);
      }

      const json = await response.json();
      const rawModels = Array.isArray(json.data) ? json.data : [];

      if (rawModels.length === 0) {
        statusEl.style.color = '#f1c40f';
        statusEl.textContent = freeOnly
          ? 'No free models returned by OpenRouter.'
          : 'No models returned by OpenRouter.';
      } else {
        // Preserve prior enabled flags and selection order when re-fetching
        const existingEnabled = new Map(setupLlmModels.map(m => [m.id, m.enabled]));
        setupLlmModels = rawModels.map(m => ({
          id: m.id,
          name: m.name || m.id,
          enabled: existingEnabled.has(m.id) ? existingEnabled.get(m.id) : false
        }));

        statusEl.style.color = '#2ecc71';
        const label = freeOnly ? 'free models' : 'models';
        statusEl.textContent = `Successfully fetched ${setupLlmModels.length} ${label} (sorted by intelligence).`;

        const picker = document.getElementById('setup-llm-model-picker');
        if (picker) picker.style.display = 'flex';

        // Clear search
        llmSearchQuery = '';
        if (searchInput) searchInput.value = '';

        renderLlmModelList();
      }
    } catch (err) {
      console.error('Failed to fetch OpenRouter models:', err);
      statusEl.style.color = '#ff4d4d';
      statusEl.textContent = `Fetch error: ${err.message || err}`;
    } finally {
      fetchBtn.disabled = false;
    }
  });
}

/**
 * Returns a sorted view of setupLlmModels with selected (enabled) models first,
 * preserving relative order within each group. Maps each entry to its original
 * index in setupLlmModels so mutations target the canonical array.
 */
function getSortedModelView() {
  const indexed = setupLlmModels.map((m, i) => ({ model: m, originalIndex: i }));
  const selected = indexed.filter(e => e.model.enabled);
  const unselected = indexed.filter(e => !e.model.enabled);
  return [...selected, ...unselected];
}

function renderLlmModelList() {
  const container = document.getElementById('setup-llm-priority-list');
  const picker = document.getElementById('setup-llm-model-picker');
  const countEl = document.getElementById('setup-llm-selection-count');
  if (!container) return;

  if (setupLlmModels.length > 0 && picker) {
    picker.style.display = 'flex';
  }

  container.innerHTML = '';

  // Update selection counter
  const selectedCount = setupLlmModels.filter(m => m.enabled).length;
  if (countEl) {
    countEl.textContent = `${selectedCount} / ${LLM_MAX_SELECTED} selected`;
    countEl.style.color = selectedCount >= LLM_MAX_SELECTED ? '#2ecc71' : 'var(--accent-color)';
  }

  if (setupLlmModels.length === 0) {
    container.innerHTML = `<div style="font-size: 12px; color: var(--text-muted); padding: 4px 0;">No models fetched yet. Click "Fetch Models" above.</div>`;
    return;
  }

  // Get sorted view: selected first, then unselected
  const sortedView = getSortedModelView();

  // Apply search filter
  const filteredView = llmSearchQuery
    ? sortedView.filter(entry => {
        const q = llmSearchQuery;
        return entry.model.name.toLowerCase().includes(q) || entry.model.id.toLowerCase().includes(q);
      })
    : sortedView;

  if (filteredView.length === 0) {
    container.innerHTML = `<div style="font-size: 12px; color: var(--text-muted); padding: 4px 0;">No models match your search.</div>`;
    return;
  }

  // Track selected items for priority badge numbering
  let selectedRank = 0;

  filteredView.forEach((entry, displayIdx) => {
    const { model, originalIndex } = entry;
    const isEnabled = !!model.enabled;

    if (isEnabled) selectedRank++;

    const row = document.createElement('div');
    row.className = 'dynamic-row draggable-row';
    row.dataset.originalIndex = String(originalIndex);
    row.style.alignItems = 'center';
    row.style.padding = '6px 10px';
    row.style.gap = '8px';

    // Only selected models are draggable
    if (isEnabled) {
      row.draggable = true;
      row.style.cursor = 'grab';
    } else {
      row.draggable = false;
      row.style.cursor = 'default';
      row.style.opacity = '0.7';
    }

    // Priority badge only for selected models
    const badgeHtml = isEnabled
      ? `<span class="priority-badge" style="background: rgba(52, 152, 219, 0.2); color: #3498db; border: 1px solid rgba(52, 152, 219, 0.4); padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 700; min-width: 24px; text-align: center;">#${selectedRank}</span>`
      : `<span style="min-width: 24px;"></span>`;

    // Drag handle only for selected models
    const dragHandleHtml = isEnabled
      ? `<span class="drag-handle" title="Drag to reorder">⋮⋮</span>`
      : `<span style="width: 18px;"></span>`;

    // Up/Down buttons only for selected models — operate within the selected group
    const selectedOriginalIndices = setupLlmModels
      .map((m, i) => m.enabled ? i : -1)
      .filter(i => i >= 0);
    const posInSelected = selectedOriginalIndices.indexOf(originalIndex);
    const isFirstSelected = posInSelected === 0;
    const isLastSelected = posInSelected === selectedOriginalIndices.length - 1;

    const upDownHtml = isEnabled
      ? `<div style="display: flex; gap: 4px;">
          <button type="button" class="btn btn-secondary btn-small btn-model-up" style="width: 24px; padding: 2px 0;" ${isFirstSelected ? 'disabled style="opacity:0.3;cursor:not-allowed;"' : ''} title="Move up">▲</button>
          <button type="button" class="btn btn-secondary btn-small btn-model-down" style="width: 24px; padding: 2px 0;" ${isLastSelected ? 'disabled style="opacity:0.3;cursor:not-allowed;"' : ''} title="Move down">▼</button>
        </div>`
      : '';

    row.innerHTML = `
      ${dragHandleHtml}
      ${badgeHtml}
      <input type="checkbox" class="llm-model-check" style="cursor: pointer;" ${isEnabled ? 'checked' : ''} title="${isEnabled ? 'Deselect model' : (selectedCount >= LLM_MAX_SELECTED ? 'Max ' + LLM_MAX_SELECTED + ' models selected' : 'Select model')}">
      <div style="flex: 1; min-width: 0; display: flex; flex-direction: column;">
        <span style="font-size: 12px; font-weight: 600; color: ${isEnabled ? '#fff' : 'var(--text-muted)'}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${model.name}</span>
        <span style="font-size: 10px; font-family: monospace; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${model.id}</span>
      </div>
      ${upDownHtml}
    `;

    // Checkbox toggle with max-3 enforcement
    const checkbox = row.querySelector('.llm-model-check');
    if (checkbox) {
      checkbox.addEventListener('change', (e) => {
        if (e.target.checked) {
          // Enforce max selection: auto-evict the lowest priority selected model
          const currentlySelected = setupLlmModels.filter(m => m.enabled);
          if (currentlySelected.length >= LLM_MAX_SELECTED) {
            // The last enabled model in the array is the lowest priority
            const selectedInOrder = setupLlmModels.filter(m => m.enabled);
            const evictTarget = selectedInOrder[selectedInOrder.length - 1];
            evictTarget.enabled = false;
          }
          model.enabled = true;
        } else {
          model.enabled = false;
        }
        renderLlmModelList();
      });
    }

    // Up / Down buttons — swap within the canonical setupLlmModels array
    if (isEnabled) {
      const upBtn = row.querySelector('.btn-model-up');
      const downBtn = row.querySelector('.btn-model-down');

      if (upBtn && !isFirstSelected) {
        upBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const prevOrigIdx = selectedOriginalIndices[posInSelected - 1];
          // Swap in the canonical array
          const temp = setupLlmModels[prevOrigIdx];
          setupLlmModels[prevOrigIdx] = setupLlmModels[originalIndex];
          setupLlmModels[originalIndex] = temp;
          renderLlmModelList();
        });
      }

      if (downBtn && !isLastSelected) {
        downBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const nextOrigIdx = selectedOriginalIndices[posInSelected + 1];
          // Swap in the canonical array
          const temp = setupLlmModels[nextOrigIdx];
          setupLlmModels[nextOrigIdx] = setupLlmModels[originalIndex];
          setupLlmModels[originalIndex] = temp;
          renderLlmModelList();
        });
      }

      // Drag and drop — only among selected models
      row.addEventListener('dragstart', (e) => {
        draggedModelIndex = originalIndex;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(originalIndex));
      });

      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
      });

      row.addEventListener('dragleave', () => {
        row.classList.remove('drag-over');
      });

      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        if (draggedModelIndex !== null && draggedModelIndex !== originalIndex) {
          // Only allow dropping onto other selected models
          if (model.enabled) {
            const [movedItem] = setupLlmModels.splice(draggedModelIndex, 1);
            // Recalculate target index since splice shifted indices
            const targetIdx = setupLlmModels.indexOf(model);
            setupLlmModels.splice(targetIdx >= 0 ? targetIdx : originalIndex, 0, movedItem);
            draggedModelIndex = null;
            renderLlmModelList();
          }
        }
      });

      row.addEventListener('dragend', () => {
        draggedModelIndex = null;
        container.querySelectorAll('.draggable-row').forEach(r => {
          r.classList.remove('dragging');
          r.classList.remove('drag-over');
        });
      });
    }

    container.appendChild(row);
  });
}


/**
 * Initialize custom spinner buttons for number inputs in the setup modal
 */
function initNumberInputSpinners() {
  const modal = document.getElementById('setup-modal-overlay');
  if (!modal) return;

  const spinners = modal.querySelectorAll('.number-input-wrapper');
  spinners.forEach(wrapper => {
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

    upBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      updateValue(1);
    });

    downBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      updateValue(-1);
    });

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

  // Win conditions
  const winCondition = {};
  if (document.getElementById('setup-win-absolute-enabled').checked) {
    winCondition.absoluteScore = parseInt(document.getElementById('setup-win-absolute-value').value, 10) || 1000;
  }
  if (document.getElementById('setup-win-relative-enabled').checked) {
    winCondition.relativeScore = parseFloat(document.getElementById('setup-win-relative-value').value) || 2;
  }

  // LLM settings & session storage persistence
  const keyInput = document.getElementById('setup-llm-api-key');
  if (keyInput) {
    setupLlmApiKey = keyInput.value.trim();
  }
  const orderedModels = setupLlmModels.filter(m => m.enabled).map(m => m.id);

  try {
    sessionStorage.setItem('empires_openrouter_config', JSON.stringify({
      apiKey: setupLlmApiKey,
      models: setupLlmModels
    }));
  } catch (e) {
    console.warn('Failed to save LLM config to session storage:', e);
  }

  const settings = {
    mapSize: parseInt(document.getElementById('setup-map-size').value, 10),
    players: setupPlayers.map((p, i) => {
      let controller = p.controller;
      return {
        id: i + 1,
        name: p.name.trim() || `Player ${i + 1}`,
        color: p.color,
        controller: controller
      };
    }),
    initialization: {
      orders: {
        max: parseInt(document.getElementById('setup-orders-max').value, 10) || 8,
        initial: parseInt(document.getElementById('setup-orders-max').value, 10) || 8,
        perTurn: parseInt(document.getElementById('setup-orders-perturn').value, 10) || 6
      },
      startingResources: startingResources,
      startingUnits: { ...setupStartingUnits }
    },
    autoSave: {
      enabled: document.getElementById('setup-autosave-enabled').checked,
      intervalTurns: parseInt(document.getElementById('setup-autosave-interval').value, 10) || 5,
      maxAutoSaves: parseInt(document.getElementById('setup-autosave-max').value, 10) || 10
    },
    barbarians: document.getElementById('setup-barbarians-enabled').checked
      ? (() => {
        // Collect horde values dynamically — one entry per slider widget rendered
        const horde = {};
        document.querySelectorAll('#setup-barbarian-horde-container .range-slider[data-range-id]').forEach(slider => {
          const unitName = slider.dataset.rangeId;
          const prefix   = hordeUnitIdPrefix(unitName);
          horde[unitName] = {
            min: parseInt(document.getElementById(`${prefix}-min`).value, 10) || 0,
            max: parseInt(document.getElementById(`${prefix}-max`).value, 10) || 0
          };
        });
        return {
          horde,
          spawnFrequencyTurns: parseInt(document.getElementById('setup-barbarian-spawn-frequency').value, 10) || 5,
          maxNumber: parseInt(document.getElementById('setup-barbarian-max-number').value, 10) || 20,
          maxAge: parseInt(document.getElementById('setup-barbarian-max-age').value, 10) || 30
        };
      })()
      : null,
    winCondition: Object.keys(winCondition).length > 0 ? winCondition : null,
    llm: {
      apiKey: setupLlmApiKey,
      orderedModels: orderedModels
    }
  };


  startNewGame({ ...defaultSettings, ...settings });
  closeSetupModal();
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
  gameState.generateMap(settings.mapSize, manifestData.terrains);
  gameState.initializeManifest(manifestData, settings);

  drawGrid(gameState);
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

    drawGrid(gameState);
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
export async function nextTurn() {
  if (gameState.gameOver) {
    showToast('Game is over. Start a new game.', true);
    return;
  }

  const button = document.getElementById('btn-next-turn');
  button.disabled = true;
  button.textContent = 'Running AI...';

  deselectEntity();
  hideContextMenu();

  // this updates the gameState.activePlayer and increments the round if needed
  await gameState.endTurn();

  // enable the button again if the next player is human
  if (gameState.activePlayer && !gameState.activePlayer.isAI) {
    button.disabled = false;
    button.textContent = 'Next Turn';
  }

  drawGrid(gameState);
  reconcileEntities(gameState);
  updatePlayersUI();

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

  // Check win conditions
  checkWinConditions();
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
 * Checks if any player has met the win conditions.
 * Called at the end of each turn.
 */
function checkWinConditions() {
  if (!gameState || !gameState.settings?.winCondition) return false;

  // Don't check win conditions before MIN_GAME_ROUNDS
  if (gameState.currentRound < CONFIG.MIN_GAME_ROUNDS) return false;

  const winCondition = gameState.settings.winCondition;
  const players = gameState.players;

  for (const player of players) {
    const reasons = [];

    // Check absolute score
    if (winCondition.absoluteScore && player.score.total >= winCondition.absoluteScore) {
      reasons.push(`Absolute Score: ${player.score.total} >= ${winCondition.absoluteScore}`);
    }

    // Check relative score
    if (winCondition.relativeScore) {
      // Find the next highest score among other players
      let nextHighest = 0;
      for (const other of players) {
        if (other.id !== player.id && other.score.total > nextHighest) {
          nextHighest = other.score.total;
        }
      }
      const threshold = winCondition.relativeScore * nextHighest;
      if (player.score.total >= threshold) {
        reasons.push(`Relative Score: ${player.score.total} >= ${winCondition.relativeScore} × ${nextHighest} (next highest)`);
      }
    }

    if (reasons.length > 0) {
      showVictoryModal(player, reasons);
      return true;
    }
  }

  return false;
}

/**
 * Shows the victory modal with the winning player and reasons.
 */
function showVictoryModal(player, reasons) {
  const overlay = document.getElementById('victory-modal-overlay');
  const messageDiv = document.getElementById('victory-message');

  messageDiv.innerHTML = `
    <div style="font-size: 24px; font-weight: 700; color: ${player.color}; margin-bottom: 12px;">${player.name.toUpperCase()} WINS!</div>
    <div style="font-size: 14px; color: var(--text-muted); margin-bottom: 16px;">Round ${gameState.currentRound}</div>
    <div style="text-align: left; font-size: 13px; color: var(--text-main);">
      ${reasons.map(r => `<div style="margin: 8px 0; padding: 8px; background: rgba(52, 152, 219, 0.1); border-radius: 4px;">${r}</div>`).join('')}
    </div>
  `;

  overlay.classList.add('active');
  gameState.gameOver = true;
}

/**
 * Closes the victory modal.
 */
function closeVictoryModal() {
  const overlay = document.getElementById('victory-modal-overlay');
  overlay.classList.remove('active');
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
  audio.playEntitySfx(entity, 'select');
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
          audio.playEntitySfx(selectedEntity, 'action', action.name);
          showToast(check.reason || `Executed ${action.name}`);
        } else {
          showToast(`Failed to execute ${action.name}`, true);
        }

        drawGrid(gameState);
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
      <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="player-color-dot" style="background-color: ${player.color};"></span>
          <strong style="font-size: 14px; color: ${isActive ? '#ffffff' : 'var(--text-muted)'};">${player.name} ${isActive ? '◀ ACTIVE' : ''}</strong>
        </div>
        <span style="font-size: 10px; color: var(--accent-color); opacity: 0.8;">📊 Profile</span>
      </div>
      ${ordersStr ? `<div style="font-size: 11px; color: var(--accent-color); margin-left: 18px;">${ordersStr}</div>` : ''}
      ${scoreStr ? `<div style="font-size: 11px; color: var(--accent-color); margin-left: 18px;">${scoreStr}</div>` : ''}
      ${scoreToWinText ? `<div style="font-size: 11px; color: ${scoreToWinColor}; margin-left: 18px;">${scoreToWinText}</div>` : ''}
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
  }

  updateModalContent();
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

  // TODO define this, and resource icons, in manifestData for better flexibility
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

  // History panel section for full modal view
  let historyHTML = '';
  if (!isCompact) {
    // Get all rounds that have history (newest first)
    const allRounds = Array.from(player.history.keys()).sort((a, b) => b - a);

    // Pagination settings - fixed 5 rounds per page
    const roundsPerPage = 5;
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
          <div class="history-round-group" style="margin-bottom: 12px;">
            <div class="history-round-header" style="font-weight: 600; color: var(--accent-color); margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid var(--border-color);">
              Round ${round} (${entries.length} events)
            </div>
            <div class="history-entries" style="display: flex; flex-direction: column; gap: 4px;">
        `;

        for (const entry of entries) {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          const categoryColors = {
            'action': '#a78bfa',
            'damage': '#e74c3c',
            'spawn': '#2ecc71',
            'destroy': '#e67e22',
            'orders': '#f1c40f'
          };
          const categoryColor = categoryColors[entry.category] || 'var(--text-main)';

          historyEntriesHTML += `
            <div class="history-entry" style="font-size: 11px; padding: 6px 8px; background: rgba(255,255,255,0.03); border-radius: 4px; border-left: 3px solid ${categoryColor};">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="color: ${categoryColor}; font-weight: 600; text-transform: uppercase; font-size: 10px;">${entry.category}</span>
                <span style="color: var(--text-muted); font-size: 10px;">${time}</span>
              </div>
              <div style="margin-top: 2px; color: var(--text-main);">
                ${entry.details}
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
      historyEntriesHTML = '<div style="color: var(--text-muted); font-size: 12px; text-align: center; padding: 20px;">No history entries yet.</div>';
    }

    // Simple pagination controls (fixed 5 rounds per page)
    const paginationHTML = totalPages > 1 ? `
      <div class="history-pagination" style="display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--border-color);">
        <button id="history-prev-page" class="btn btn-small" ${validPage === 0 ? 'disabled' : ''} style="width: auto;">← Prev</button>
        <span style="font-size: 12px; color: var(--text-muted);">Page ${validPage + 1} of ${totalPages} (5 rounds/page)</span>
        <button id="history-next-page" class="btn btn-small" ${validPage >= totalPages - 1 ? 'disabled' : ''} style="width: auto;">Next →</button>
      </div>
    ` : '';

    historyHTML = `
      <div class="divider" style="margin: 16px 0 12px 0;"></div>
      <div class="section-title" style="display: flex; justify-content: space-between; align-items: center;">
        <span>History</span>
        <span style="font-size: 11px; color: var(--text-muted);">${allRounds.length} rounds recorded</span>
      </div>
      <div id="history-panel-content" style="max-height: 300px; overflow-y: auto;">
        ${historyEntriesHTML}
      </div>
      ${paginationHTML}
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
    ${historyHTML}
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
    const isExplored = CONFIG.SHOW_ALL || (activePlayer ? !activePlayer.isAI && activePlayer.isExplored(hovered.q, hovered.r) : true);
    const isVisible = CONFIG.SHOW_ALL || (activePlayer ? !activePlayer.isAI && activePlayer.isVisible(hovered.q, hovered.r) : true);

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
