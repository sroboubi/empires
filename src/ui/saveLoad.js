/**
 * Save/load modal.
 *
 * Modal rendering only. Actual save/load logic (doSaveGame, doLoadGame)
 * stays in main.js and is invoked via the UI callback registry.
 */
import { getUiCallback } from './callbacks.js';
import { showToast } from '../utils.js';
import { listSaves, deleteSave } from '../saveManager.js';

export async function openSaveLoadModal(gameState, mode = 'save') {
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

export function closeSaveLoadModal() {
  document.getElementById('saveload-modal-overlay').classList.remove('active');
}

export async function renderSavesList(gameState, ) {
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

      item.querySelector('.btn-load-entry').addEventListener('click', () => getUiCallback('onLoadGame')?.(save.name));
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