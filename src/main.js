import { GameState } from './gameState.js';
import { CONFIG } from './config.js';
import {
  initRenderer,
  drawGrid,
  highlightCell,
  highlightPathCells,
  clearPathHighlight,
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

    // 6. Draw Hex Grid with Fog of War for Active Player
    drawGrid(gameState.cells, gameState.activePlayer);

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
 * Left click: selects entity at clicked hex cell if owned by active human player, or deselects.
 */
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
    // AI players cannot be controlled by user
    deselectEntity();
    return;
  }

  // Check if target cell is visible to active player
  if (!activePlayer.isVisible(hovered.q, hovered.r)) {
    deselectEntity();
    return;
  }

  const entity = gameState.getEntityAt(hovered.q, hovered.r);
  // User can only select and control entities owned by the active human player
  if (entity && entity.owner && entity.owner.id === activePlayer.id) {
    selectEntity(entity);
  } else {
    deselectEntity();
  }
}

/**
 * Right click: if an entity is selected and belongs to active player,
 * queries entity.getActions() and displays action context menu.
 */
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

  showToast(`Selected ${entity.name.toUpperCase()}`);
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
 * Shows context menu popup with actions and preview text / validation reasons.
 */
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

      const btn = document.createElement('button');
      btn.className = 'context-action-btn';
      if (!isPossible) {
        btn.style.opacity = '0.5';
        btn.style.cursor = 'not-allowed';
      }

      btn.innerHTML = `
        <div style="display: flex; flex-direction: column;">
          <strong style="font-size: 12px; color: ${isPossible ? '#ffffff' : '#999999'};">${action.name}</strong>
          <span style="font-size: 10px; color: ${isPossible ? '#a78bfa' : '#ff6b6b'};">${previewText}</span>
        </div>
        <span style="font-size: 10px; color: ${isPossible ? 'var(--accent-color)' : '#666666'};">►</span>
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

        // Re-draw grid & reconcile 3D visual scene & update UI
        drawGrid(gameState.cells, gameState.activePlayer);
        reconcileEntities(gameState);
        updatePlayersUI();

        // Check if selected entity was destroyed
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

  const menuWidth = 260;
  const menuHeight = 220;
  const posX = Math.min(x, window.innerWidth - menuWidth - 10);
  const posY = Math.min(y, window.innerHeight - menuHeight - 10);

  menu.style.left = `${posX}px`;
  menu.style.top = `${posY}px`;
  menu.style.display = 'flex';
}

function hideContextMenu() {
  const menu = document.getElementById('entity-context-menu');
  if (menu) menu.style.display = 'none';
  clearPathHighlight();
}

/**
 * Updates players and dynamic resources list in UI, highlighting active player and turn round.
 */
function updatePlayersUI() {
  const container = document.getElementById('players-list');
  container.innerHTML = '';

  const activePlayer = gameState.activePlayer;

  // Add turn header info
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
    li.style.display = 'flex';
    li.style.flexDirection = 'column';
    li.style.alignItems = 'flex-start';
    li.style.gap = '2px';
    li.style.marginBottom = '8px';
    li.style.padding = '6px';
    li.style.borderRadius = '6px';
    li.style.background = isActive ? 'rgba(167, 139, 250, 0.15)' : 'transparent';
    li.style.border = isActive ? '1px solid var(--accent-color)' : '1px solid transparent';

    let resourceStr = '';
    if (player.resources) {
      resourceStr = Object.entries(player.resources)
        .map(([name, qty]) => `${name}: ${qty}`)
        .join(' | ');
    }

    li.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <span class="player-color-dot" style="background-color: ${player.color};"></span>
        <strong style="font-size: 14px; color: ${isActive ? '#ffffff' : 'var(--text-muted)'};">${player.name} ${isActive ? '◀ ACTIVE' : ''}</strong>
      </div>
      ${resourceStr ? `<div style="font-size: 11px; color: var(--text-muted); margin-left: 18px;">${resourceStr}</div>` : ''}
    `;
    container.appendChild(li);
  });
}

/**
 * Next Turn: triggers endTurn on gameState, cycling to next player turn and updating Fog of War.
 */
function nextTurn() {
  deselectEntity();
  hideContextMenu();

  gameState.endTurn();

  drawGrid(gameState.cells, gameState.activePlayer);
  reconcileEntities(gameState);
  updatePlayersUI();

  showToast(`Turn passed to ${gameState.activePlayer ? gameState.activePlayer.name : ''} (Round ${gameState.currentRound})`);
}

/**
 * Handles mouse movement for hovering inspection, respecting Fog of War.
 */
function onMouseMove(event) {
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

    // Show entity only if explored and visible, or if owned by active player on explored tile
    const showEntityInInspect = entity && (
      (entity.owner && activePlayer && entity.owner.id === activePlayer.id && isExplored) ||
      isVisible
    );

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

  drawGrid(gameState.cells, gameState.activePlayer);
  reconcileEntities(gameState);
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

    drawGrid(gameState.cells, gameState.activePlayer);
    reconcileEntities(gameState);
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
