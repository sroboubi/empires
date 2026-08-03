import { GameState } from './gameState.js';
import { CONFIG } from './config.js';
import { initRenderer, drawGrid, highlightCell, raycastHex, setEntitySelectionHighlight, clearEntitySelectionHighlight } from './renderer.js';
import { loadGameManifest } from './manifestLoader.js';
import { GameEngine } from './engine.js';
import { axialToPixel } from './hexMath.js';
import * as THREE from 'three';

let gameState;
let gameEngine;
let manifestData;
const mouse = new THREE.Vector2();

let selectedEntity = null;
let selectedCell = null;

let pointerDownPos = { x: 0, y: 0 };
let pointerDownTime = 0;

/**
 * Initializes the application.
 */
async function init() {
  try {
    // 1. Parse manifest URL parameter
    const urlParams = new URLSearchParams(window.location.search);
    const manifestUrl = urlParams.get('manifest') || './manifest.json';

    // 2. Load manifest data and preload controllers
    manifestData = await loadGameManifest(manifestUrl);

    // 3. Create Game State and Generate Map
    gameState = new GameState();
    gameState.generateMap(CONFIG.GRID_RADIUS);
    gameState.initializeManifest(manifestData);

    // 4. Initialize 3D Renderer
    const canvas = document.getElementById('game-canvas');
    initRenderer(canvas, CONFIG.HEX_SIZE);

    // 5. Initialize Game Engine and preload 3D assets
    gameEngine = new GameEngine(gameState, manifestData.entities);
    await gameEngine.preloadModels();
    gameEngine.reconcileEntities();

    // 6. Draw Grid
    drawGrid(gameState.cells);

    // 7. Populate players list in UI
    updatePlayersUI();

    // 8. Setup Event Listeners
    window.addEventListener('mousemove', onMouseMove);

    // Pointer click vs drag tracking
    window.addEventListener('pointerdown', (e) => {
      pointerDownPos = { x: e.clientX, y: e.clientY };
      pointerDownTime = Date.now();
    });

    window.addEventListener('pointerup', (e) => {
      // Ignore click events originating inside UI panel elements
      if (e.target.closest('.glass-panel') || e.target.closest('.btn')) return;

      const dx = e.clientX - pointerDownPos.x;
      const dy = e.clientY - pointerDownPos.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const duration = Date.now() - pointerDownTime;

      // Threshold: distance < 5px and press duration < 500ms counts as a click
      if (distance < 5 && duration < 500) {
        if (e.button === 0) {
          handleLeftClick(e);
        } else if (e.button === 2) {
          handleRightClick(e);
        }
      }
    });

    // Prevent standard browser context menu on canvas
    window.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    // Dismiss context menu on click outside or ESC
    window.addEventListener('click', (e) => {
      if (!e.target.closest('#entity-context-menu')) {
        hideContextMenu();
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        hideContextMenu();
        deselectEntity();
      }
    });

    // Setup button handlers
    document.getElementById('btn-regenerate').addEventListener('click', regenerateMap);
    document.getElementById('btn-serialize').addEventListener('click', serializeState);
    document.getElementById('btn-deserialize').addEventListener('click', deserializeState);

    console.log('Empire game initialised successfully.');
  } catch (err) {
    console.error('Fatal initialization error:', err);
    alert('Failed to load game config: ' + err.message);
  }
}

/**
 * Handles left click event for selecting an entity or deselecting if empty.
 */
function handleLeftClick(event) {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  const hovered = raycastHex(mouse);
  hideContextMenu();

  if (hovered) {
    const cell = gameState.cells[`${hovered.q},${hovered.r}`];
    if (cell && cell.entities && cell.entities.length > 0) {
      // Select the primary entity on the cell
      selectEntity(cell.entities[0], cell);
    } else {
      // Clicked on a cell with no entity -> deselect
      deselectEntity();
    }
  } else {
    // Clicked off-grid -> deselect
    deselectEntity();
  }
}

/**
 * Handles right click event for displaying context menu on selected entity.
 */
function handleRightClick(event) {
  event.preventDefault();

  if (selectedEntity) {
    const controller = gameEngine.controllers.find(c => c.entity.id === selectedEntity.id);
    const actions = (controller && typeof controller.actions === 'function') ? controller.actions() : [];
    showContextMenu(event.clientX, event.clientY, selectedEntity, actions);
  } else {
    hideContextMenu();
  }
}

/**
 * Selects an entity and updates 3D highlight ring and UI.
 */
function selectEntity(entity, cell) {
  selectedEntity = entity;
  selectedCell = cell;

  const { x, z } = axialToPixel(cell.q, cell.r, CONFIG.HEX_SIZE);
  setEntitySelectionHighlight(x, cell.terrain.height, z);

  showToast(`Selected ${entity.name.toUpperCase()} (${entity.category})`);
}

/**
 * Deselects current entity and hides selection highlight.
 */
function deselectEntity() {
  if (selectedEntity) {
    selectedEntity = null;
    selectedCell = null;
    clearEntitySelectionHighlight();
  }
}

/**
 * Shows context menu popup at cursor position with entity actions.
 */
function showContextMenu(x, y, entity, actions) {
  const menu = document.getElementById('entity-context-menu');
  const title = document.getElementById('context-menu-title');
  const actionsDiv = document.getElementById('context-menu-actions');

  title.textContent = `${entity.name.toUpperCase()} ACTIONS`;
  actionsDiv.innerHTML = '';

  if (actions && actions.length > 0) {
    actions.forEach(action => {
      const btn = document.createElement('button');
      btn.className = 'context-action-btn';
      btn.innerHTML = `<span>${action}</span><span style="font-size: 10px; color: var(--accent-color);">►</span>`;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        showToast(`Action "${action}" on ${entity.name.toUpperCase()}`);
        hideContextMenu();
      });
      actionsDiv.appendChild(btn);
    });
  } else {
    actionsDiv.innerHTML = '<div style="font-size: 11px; color: var(--text-muted); padding: 4px;">No actions available</div>';
  }

  // Adjust coordinates to ensure menu stays within viewport bounds
  const menuWidth = 220;
  const menuHeight = 150;
  const posX = Math.min(x, window.innerWidth - menuWidth - 10);
  const posY = Math.min(y, window.innerHeight - menuHeight - 10);

  menu.style.left = `${posX}px`;
  menu.style.top = `${posY}px`;
  menu.style.display = 'flex';
}

/**
 * Hides context menu popup.
 */
function hideContextMenu() {
  const menu = document.getElementById('entity-context-menu');
  if (menu) menu.style.display = 'none';
}

/**
 * Updates player list and resources in UI overlay.
 */
function updatePlayersUI() {
  const container = document.getElementById('players-list');
  container.innerHTML = '';
  gameState.players.forEach(player => {
    const li = document.createElement('li');
    li.style.display = 'flex';
    li.style.flexDirection = 'column';
    li.style.alignItems = 'flex-start';
    li.style.gap = '2px';
    li.style.marginBottom = '8px';

    let resourceStr = '';
    if (player.resources) {
      resourceStr = Object.entries(player.resources)
        .map(([name, qty]) => `${name}: ${qty}`)
        .join(' | ');
    }

    li.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <span class="player-color-dot" style="background-color: ${player.color};"></span>
        <strong style="font-size: 14px;">${player.name}</strong>
      </div>
      ${resourceStr ? `<div style="font-size: 11px; color: var(--text-muted); margin-left: 18px;">${resourceStr}</div>` : ''}
    `;
    container.appendChild(li);
  });
}

/**
 * Handles mouse movement to update coordinate tracking, selection highlight & entity inspection.
 */
function onMouseMove(event) {
  // Calculate mouse position in normalized device coordinates (-1 to +1)
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  // Raycast to find hovered hex
  const hovered = raycastHex(mouse);
  const infoPanel = document.getElementById('inspect-panel');

  if (hovered) {
    highlightCell(hovered.q, hovered.r, hovered.terrain.height);

    // Update inspect panel UI
    document.getElementById('inspect-coords').textContent = `(${hovered.q}, ${hovered.r})`;
    document.getElementById('inspect-terrain').textContent = hovered.terrain.name;
    document.getElementById('inspect-height').textContent = hovered.terrain.height.toFixed(2);
    document.getElementById('inspect-elevation').textContent = hovered.terrain.elevation.toFixed(2);
    document.getElementById('inspect-temperature').textContent = hovered.terrain.temperature.toFixed(2);
    document.getElementById('inspect-humidity').textContent = hovered.terrain.humidity.toFixed(2);

    // Display entity details if cells contain entities
    const cell = gameState.cells[`${hovered.q},${hovered.r}`];
    const entitiesDiv = document.getElementById('inspect-entities');
    entitiesDiv.innerHTML = '';

    if (cell && cell.entities && cell.entities.length > 0) {
      cell.entities.forEach(entity => {
        const controller = gameEngine.controllers.find(c => c.entity.id === entity.id);
        const infoText = controller ? controller.info() : `Entity: ${entity.name}`;
        const actionsList = (controller && typeof controller.actions === 'function') ? controller.actions() : [];

        const player = gameState.players.find(p => p.id === entity.ownerId);
        const colorDot = player ? `<span class="player-color-dot" style="background-color: ${player.color}; margin-right: 4px;"></span>` : '';
        const isSelected = selectedEntity && selectedEntity.id === entity.id;

        const entityRow = document.createElement('div');
        entityRow.style.marginBottom = '6px';
        if (isSelected) {
          entityRow.style.background = 'rgba(0, 255, 255, 0.1)';
          entityRow.style.border = '1px solid rgba(0, 255, 255, 0.4)';
          entityRow.style.borderRadius = '4px';
          entityRow.style.padding = '4px';
        }
        entityRow.innerHTML = `
          <div style="font-weight: 600; color: ${isSelected ? '#00ffff' : 'var(--text-main)'}; display: flex; align-items: center;">
            ${colorDot}${entity.name.toUpperCase()} (${entity.category})${isSelected ? ' ★ SELECTED' : ''}
          </div>
          <div style="font-size: 11px; color: var(--text-muted); margin-left: 14px; margin-top: 2px;">
            ${infoText}
          </div>
          ${actionsList.length > 0 ? `
          <div style="font-size: 10px; color: var(--accent-color); margin-left: 14px; font-style: italic; margin-top: 2px;">
            Actions: ${actionsList.join(', ')}
          </div>` : ''}
        `;
        entitiesDiv.appendChild(entityRow);
      });
    } else {
      entitiesDiv.textContent = 'None';
    }

    // Add visual highlighting to inspect panel
    infoPanel.classList.add('active');
  } else {
    highlightCell(null, null);
    if (!selectedEntity) {
      infoPanel.classList.remove('active');
    }
  }
}

/**
 * Generates a new random hex map.
 */
function regenerateMap() {
  deselectEntity();
  hideContextMenu();
  gameState.generateMap(CONFIG.GRID_RADIUS);
  gameState.initializeManifest(manifestData);

  if (gameEngine) {
    gameEngine.clear();
    gameEngine.reconcileEntities();
  }

  drawGrid(gameState.cells);
  updatePlayersUI();

  // Clear inspect panel
  document.getElementById('inspect-panel').classList.remove('active');

  // Flash status message
  showToast('New map generated successfully!');
}

/**
 * Serializes the game state and displays it in the textarea.
 */
function serializeState() {
  const serialized = gameState.serialize();
  const textarea = document.getElementById('state-data');
  textarea.value = serialized;

  // Select the text area
  textarea.select();

  showToast('State serialized to JSON!');
}

/**
 * Deserializes game state from the textarea.
 */
function deserializeState() {
  const textarea = document.getElementById('state-data');
  const jsonString = textarea.value.trim();

  if (!jsonString) {
    showToast('Paste serialized state JSON first!', true);
    return;
  }

  try {
    deselectEntity();
    hideContextMenu();
    gameState.deserialize(jsonString);

    if (gameEngine) {
      gameEngine.clear();
      gameEngine.reconcileEntities();
    }

    drawGrid(gameState.cells);
    updatePlayersUI();
    showToast('State successfully deserialized!');
  } catch (err) {
    showToast('Failed to deserialize state data.', true);
  }
}

/**
 * Helper to show toast notification.
 */
function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.style.background = isError ? '#e74c3c' : '#2ecc71';
  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}

// Initialize when DOM is loaded
window.addEventListener('DOMContentLoaded', init);

