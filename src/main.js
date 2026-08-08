import { GameState } from './gameState.js';
import { CONFIG } from './config.js';
import {
  initRenderer,
  drawGrid,
  highlightCell,
  raycastHex,
  setEntitySelectionHighlight,
  clearEntitySelectionHighlight,
  preloadModels,
  reconcileEntities,
  clearEntityMeshes
} from './renderer.js';
import { loadGameManifest } from './manifestLoader.js';
import { HexGrid } from './hexGrid.js';
import * as THREE from 'three';

let gameState;
let manifestData;
const mouse = new THREE.Vector2();

let selectedEntity = null;
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

    // 5. Preload 3D models & reconcile entities in scene
    await preloadModels(manifestData.entities);
    reconcileEntities(gameState);

    // 6. Draw Hex Grid
    drawGrid(gameState.cells);

    // 7. Update UI
    updatePlayersUI();

    // 8. Event Listeners
    window.addEventListener('mousemove', onMouseMove);

    window.addEventListener('pointerdown', (e) => {
      pointerDownPos = { x: e.clientX, y: e.clientY };
      pointerDownTime = Date.now();
    });

    window.addEventListener('pointerup', (e) => {
      if (e.target.closest('.glass-panel') || e.target.closest('.btn')) return;

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
      }
    });

    // Control buttons
    document.getElementById('btn-regenerate').addEventListener('click', regenerateMap);
    document.getElementById('btn-next-turn').addEventListener('click', nextTurn);
    document.getElementById('btn-serialize').addEventListener('click', serializeState);
    document.getElementById('btn-deserialize').addEventListener('click', deserializeState);

    console.log('Empire game initialised successfully.');
  } catch (err) {
    console.error('Fatal initialization error:', err);
    alert('Failed to load game config: ' + err.message);
  }
}

/**
 * Left click: selects entity at clicked hex cell or deselects.
 */
function handleLeftClick(event) {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  const hovered = raycastHex(mouse);
  hideContextMenu();

  if (hovered) {
    const entity = gameState.getEntityAt(hovered.q, hovered.r);
    if (entity) {
      selectEntity(entity);
    } else {
      deselectEntity();
    }
  } else {
    deselectEntity();
  }
}

/**
 * Right click: if an entity is selected, queries entity.getActions(targetCell, targetEntity)
 * and displays action context menu with action names and preview info.
 */
function handleRightClick(event) {
  event.preventDefault();

  if (!selectedEntity) {
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

  const candidateActions = selectedEntity.getActions(targetCell, targetEntity);
  showContextMenu(event.clientX, event.clientY, selectedEntity, candidateActions, targetCell, targetEntity);
}

/**
 * Selects an entity and shows selection ring in 3D scene.
 */
function selectEntity(entity) {
  selectedEntity = entity;
  const cell = entity.cell || gameState.cells[`${entity.q},${entity.r}`];

  if (cell) {
    const { x, z } = HexGrid.axialToPixel(cell.q, cell.r, CONFIG.HEX_SIZE);
    setEntitySelectionHighlight(x, cell.terrain ? cell.terrain.height : 1.0, z);
  }

  showToast(`Selected ${entity.name.toUpperCase()} (${entity.category})`);
}

/**
 * Deselects entity.
 */
function deselectEntity() {
  if (selectedEntity) {
    selectedEntity = null;
    clearEntitySelectionHighlight();
  }
}

/**
 * Shows context menu popup with actions and preview text.
 */
function showContextMenu(x, y, entity, actions, targetCell, targetEntity) {
  const menu = document.getElementById('entity-context-menu');
  const title = document.getElementById('context-menu-title');
  const actionsDiv = document.getElementById('context-menu-actions');

  title.textContent = `${entity.name.toUpperCase()} ACTIONS`;
  actionsDiv.innerHTML = '';

  if (actions && actions.length > 0) {
    actions.forEach(action => {
      const btn = document.createElement('button');
      btn.className = 'context-action-btn';
      btn.innerHTML = `
        <div style="display: flex; flex-direction: column;">
          <strong style="font-size: 12px; color: #ffffff;">${action.name}</strong>
          ${action.preview ? `<span style="font-size: 10px; color: #a78bfa;">${action.preview}</span>` : ''}
        </div>
        <span style="font-size: 10px; color: var(--accent-color);">►</span>
      `;

      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        hideContextMenu();

        const result = entity.doAction(action.name, targetCell, targetEntity);
        showToast(result.message, !result.success);

        // Reconcile 3D visual scene & update UI
        reconcileEntities(gameState);
        updatePlayersUI();
        if (selectedEntity) {
          selectEntity(selectedEntity);
        }
      });
      actionsDiv.appendChild(btn);
    });
  } else {
    actionsDiv.innerHTML = '<div style="font-size: 11px; color: var(--text-muted); padding: 4px;">No actions available for target cell</div>';
  }

  const menuWidth = 240;
  const menuHeight = 180;
  const posX = Math.min(x, window.innerWidth - menuWidth - 10);
  const posY = Math.min(y, window.innerHeight - menuHeight - 10);

  menu.style.left = `${posX}px`;
  menu.style.top = `${posY}px`;
  menu.style.display = 'flex';
}

function hideContextMenu() {
  const menu = document.getElementById('entity-context-menu');
  if (menu) menu.style.display = 'none';
}

/**
 * Updates players and dynamic resources list in UI.
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
 * Next Turn: triggers stepTurn on gameState, resetting unit movement and gathering construct resources.
 */
function nextTurn() {
  gameState.stepTurn();
  reconcileEntities(gameState);
  updatePlayersUI();
  if (selectedEntity) {
    selectEntity(selectedEntity);
  }
  showToast('Advanced to next turn!');
}

/**
 * Handles mouse movement for hovering inspection.
 */
function onMouseMove(event) {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  const hovered = raycastHex(mouse);
  const infoPanel = document.getElementById('inspect-panel');

  if (hovered) {
    highlightCell(hovered.q, hovered.r, hovered.terrain.height);

    document.getElementById('inspect-coords').textContent = `(${hovered.q}, ${hovered.r})`;
    document.getElementById('inspect-terrain').textContent = hovered.terrain.name;
    document.getElementById('inspect-height').textContent = hovered.terrain.height.toFixed(2);
    document.getElementById('inspect-elevation').textContent = hovered.terrain.elevation.toFixed(2);
    document.getElementById('inspect-temperature').textContent = hovered.terrain.temperature.toFixed(2);
    document.getElementById('inspect-humidity').textContent = hovered.terrain.humidity.toFixed(2);

    const entity = gameState.getEntityAt(hovered.q, hovered.r);
    const entitiesDiv = document.getElementById('inspect-entities');
    entitiesDiv.innerHTML = '';

    if (entity) {
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
          ${entity.name.toUpperCase()} (${entity.category})${isSelected ? ' ★ SELECTED' : ''}
        </div>
        <div style="font-size: 11px; color: var(--text-muted); margin-left: 16px; margin-top: 2px;">
          ${entity.info()}
        </div>
      `;
      entitiesDiv.appendChild(entityRow);
    } else {
      entitiesDiv.textContent = 'None';
    }

    infoPanel.classList.add('active');
  } else {
    highlightCell(null, null);
    if (!selectedEntity) {
      infoPanel.classList.remove('active');
    }
  }
}

/**
 * Regenerates map.
 */
function regenerateMap() {
  deselectEntity();
  hideContextMenu();
  clearEntityMeshes();

  gameState.generateMap(CONFIG.GRID_RADIUS);
  gameState.initializeManifest(manifestData);

  reconcileEntities(gameState);
  drawGrid(gameState.cells);
  updatePlayersUI();

  document.getElementById('inspect-panel').classList.remove('active');
  showToast('New map generated successfully!');
}

/**
 * Serializes state to JSON string.
 */
function serializeState() {
  const serialized = gameState.serialize();
  const textarea = document.getElementById('state-data');
  textarea.value = serialized;
  textarea.select();
  showToast('State serialized to JSON!');
}

/**
 * Deserializes state from JSON string.
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
    clearEntityMeshes();

    gameState.deserialize(jsonString);
    gameState.manifestData = manifestData;

    reconcileEntities(gameState);
    drawGrid(gameState.cells);
    updatePlayersUI();
    showToast('State successfully deserialized!');
  } catch (err) {
    console.error(err);
    showToast('Failed to deserialize state data.', true);
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
