/**
 * Game setup modal.
 *
 * All setup form rendering and state. Game logic (startNewGame,
 * handleStartGameClicked) stays in main.js and calls collectSetupSettings()
 * + buildController() from this module.
 */
import { CONFIG } from '../config.js';
import { showToast } from '../utils.js';

export function openSetupModal(canClose = true) {
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

  overlay.classList.add('active');
}

export function closeSetupModal() {
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
          `<option value="${l.name}"${p.name === l.name ? ' selected' : ''}>${l.name}</option>`).join('');
      nameField = `<select name="leader" class="form-input leader-select" style="flex: 1;" title="${leaderTitle(p.name)}">${leaderOpts}</select>`;
    } else {
      nameField = `<input name="player-name" type="text" class="form-input" value="${p.name}" placeholder="Player Name" style="flex: 1;">`;
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

export async function loadAiDefinitions() {
  if (!aiJson) {
    const [aiRes, leadersRes] = await Promise.all([
      fetch('./definitions/ai.json'),
      fetch('./definitions/leaders.json')
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
export function buildController(key, playerName) {
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
    if (setupProviderKeys[cfg.provider]) cfg.apiKey = setupProviderKeys[cfg.provider];
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


/**
 * Read the setup form and return a settings object for startNewGame().
 * Returns null if validation fails (e.g. no players).
 * @param {Object} defaultSettings - Default settings for fallbacks
 */
export function collectSetupSettings(defaultSettings) {
  if (setupPlayers.length < 1) {
    showToast('Add at least 1 player!', true);
    return null;
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

  const settings = {
    mapSize: parseInt(document.getElementById('setup-map-size').value, 10),
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
          spawnFrequencyTurns: parseInt(document.getElementById('setup-barbarian-spawn-frequency').value, 10) || 5,
          maxNumber: parseInt(document.getElementById('setup-barbarian-max-number').value, 10) || 20,
          maxAge: parseInt(document.getElementById('setup-barbarian-max-age').value, 10) || 30
        };
      })()
      : null,
    winCondition: Object.keys(winCondition).length > 0 ? winCondition : null
  };

  return settings;
}