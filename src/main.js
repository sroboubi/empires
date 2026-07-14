import { GameState } from './gameState.js';
import { CONFIG } from './config.js';
import { initRenderer, drawGrid, highlightCell, raycastHex, setUpdateCallback } from './renderer.js';
import { loadGameManifest } from './manifestLoader.js';
import { GameEngine } from './engine.js';
import * as THREE from 'three';

let gameState;
let gameEngine;
let manifestData;
const mouse = new THREE.Vector2();

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
    document.getElementById('inspect-height').textContent = hovered.terrain.height;

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

        const entityRow = document.createElement('div');
        entityRow.style.marginBottom = '6px';
        entityRow.innerHTML = `
          <div style="font-weight: 600; color: var(--text-main); display: flex; align-items: center;">
            ${colorDot}${entity.name.toUpperCase()} (${entity.category})
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
    infoPanel.classList.remove('active');
  }
}

/**
 * Generates a new random hex map.
 */
function regenerateMap() {
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
