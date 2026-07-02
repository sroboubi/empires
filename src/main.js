import { GameState } from './gameState.js';
import { CONFIG } from './config.js';
import { initRenderer, drawGrid, highlightCell, raycastHex } from './renderer.js';
import * as THREE from 'three';

let gameState;
const mouse = new THREE.Vector2();

/**
 * Initializes the application.
 */
function init() {
  // 1. Create Game State and Generate Map
  gameState = new GameState();
  gameState.generateMap(CONFIG.GRID_RADIUS);

  // 2. Initialize 3D Renderer
  const canvas = document.getElementById('game-canvas');
  initRenderer(canvas, CONFIG.TERRAIN, CONFIG.HEX_SIZE);

  // 3. Draw Grid
  drawGrid(gameState.cells);

  // 4. Populate players list in UI
  updatePlayersUI();

  // 5. Setup Event Listeners
  window.addEventListener('mousemove', onMouseMove);
  
  // Setup button handlers
  document.getElementById('btn-regenerate').addEventListener('click', regenerateMap);
  document.getElementById('btn-serialize').addEventListener('click', serializeState);
  document.getElementById('btn-deserialize').addEventListener('click', deserializeState);
  
  console.log('Empire game initialised successfully.');
}

/**
 * Updates player list in UI overlay.
 */
function updatePlayersUI() {
  const container = document.getElementById('players-list');
  container.innerHTML = '';
  gameState.players.forEach(player => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="player-color-dot" style="background-color: ${player.color};"></span> ${player.name}`;
    container.appendChild(li);
  });
}

/**
 * Handles mouse movement to update coordinate tracking & selection highlight.
 */
function onMouseMove(event) {
  // Calculate mouse position in normalized device coordinates (-1 to +1)
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  // Raycast to find hovered hex
  const hovered = raycastHex(mouse);
  const infoPanel = document.getElementById('inspect-panel');

  if (hovered) {
    const config = CONFIG.TERRAIN[hovered.terrain] || { name: 'Unknown', height: 0.1 };
    highlightCell(hovered.q, hovered.r, config.height);

    // Update inspect panel UI
    document.getElementById('inspect-coords').textContent = `(${hovered.q}, ${hovered.r})`;
    document.getElementById('inspect-terrain').textContent = config.name;
    document.getElementById('inspect-height').textContent = config.height;
    
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
