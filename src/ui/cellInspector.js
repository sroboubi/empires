/**
 * Cell inspector (hover panel).
 *
 * Renders the hover inspection panel. Takes gameState and UI state as
 * parameters — no imports from main.js. Renderer functions are imported
 * directly.
 */
import { CONFIG } from '../config.js';
import {
  highlightCell,
  clearPathHighlight,
  clearExclusionZone,
  pickHexCell,
} from '../renderer.js';

/**
 * Handle mouse move for cell hover inspection.
 * @param {MouseEvent} event
 * @param {Object} gameState - The active GameState (null if no game started)
 * @param {Object} mouse - Normalized mouse coords {x, y} (updated in place)
 * @param {Object|null} selectedEntity - Currently selected entity (for panel visibility)
 */
export function onMouseMove(event, gameState, mouse, selectedEntity) {
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

/**
 * "smallRuins" -> "Small Ruins", "tree" -> "Tree".
 */
export function prettifyName(name) {
  if (!name) return '';
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}