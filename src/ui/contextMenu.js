/**
 * Context menus (entity actions + player diplomacy).
 *
 * Pure rendering + positioning. Game actions triggered from the menu go
 * through the UI callback registry (registered by main.js) so this module
 * never imports game logic.
 */
import { getUiCallback } from './callbacks.js';
import { showToast } from '../utils.js';

let playerContextMenuTarget = null;

/**
 * Show the entity action context menu.
 * @param {number} x - Screen x
 * @param {number} y - Screen y
 * @param {Object} entity - The entity actions are for
 * @param {Array} actions - Available actions (with canDo/do)
 * @param {Object} gameState - The active GameState (for manifest + refresh)
 * @param {Object} targetCell - Target hex cell (optional)
 * @param {Object} targetEntity - Target entity (optional)
 */
export function showContextMenu(x, y, entity, actions, gameState, targetCell, targetEntity) {
  const menu = document.getElementById('entity-context-menu');
  const title = document.getElementById('context-menu-title');
  const actionsDiv = document.getElementById('context-menu-actions');

  title.textContent = `${entity.name.toUpperCase()} ACTIONS`;
  actionsDiv.innerHTML = '';
  getUiCallback('clearPathHighlight')?.();

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
            <div class="context-build-stats">
              <span><strong>Upkeep:</strong> ${upkeepStr}</span>
              <span><strong>Yield:</strong> ${yieldStr}</span>
            </div>
          `;
        }
      }

      const btn = document.createElement('button');
      btn.className = 'context-action-btn';
      if (!isPossible) {
        btn.classList.add('context-action-disabled');
      }

      btn.innerHTML = `
        <div class="context-action-inner">
          <div class="context-action-row">
            <strong class="context-action-name ${isPossible ? '' : 'context-action-name-disabled'}">${action.name}</strong>
            <span class="context-action-arrow ${isPossible ? '' : 'context-action-arrow-disabled'}">►</span>
          </div>
          <span class="context-action-preview ${isPossible ? 'context-action-preview-ok' : 'context-action-preview-bad'}">${previewText}</span>
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

        // Game logic lives in main.js, invoked via the registry.
        getUiCallback('doContextAction')?.(action, targetCell, targetEntity, gameState, check.reason);
      });
      actionsDiv.appendChild(btn);
    });

    if (pathCellsToHighlight.length > 0) {
      getUiCallback('highlightPathCells')?.(pathCellsToHighlight);
    }
  } else {
    actionsDiv.innerHTML = '<div class="context-no-actions">No actions available for target cell</div>';
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

export function hideContextMenu() {
  const menu = document.getElementById('entity-context-menu');
  if (menu) menu.style.display = 'none';
  getUiCallback('clearPathHighlight')?.();
}

/**
 * Show the player context menu (diplomacy/chat).
 * @param {number} x - Screen x
 * @param {number} y - Screen y
 * @param {Object} targetPlayer - The player to interact with
 */
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

export function getPlayerContextMenuTarget() {
  return playerContextMenuTarget;
}