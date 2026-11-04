/**
 * Victory modal.
 * Pure UI: takes gameState as a parameter, no imports from main.js.
 */

/**
 * Show the victory modal for the winning player.
 * @param {Object} gameState - The active GameState
 * @param {Object} player - The winning player
 * @param {string[]} reasons - Victory reason strings
 */
export function showVictoryModal(gameState, player, reasons) {
  const overlay = document.getElementById('victory-modal-overlay');
  const messageDiv = document.getElementById('victory-message');

  messageDiv.innerHTML = `
    <div class="victory-title" style="color: ${player.color};">${player.name.toUpperCase()} WINS!</div>
    <div class="victory-round">Round ${gameState.currentRound}</div>
    <div class="victory-reasons">
      ${reasons.map(r => `<div class="victory-reason">${r}</div>`).join('')}
    </div>
  `;

  overlay.classList.add('active');
  gameState.gameOver = true;

  if (gameState?.replayRecorder?.isRecording()) {
    gameState.replayRecorder.recordSnapshot(gameState, `Game Over: ${player.name} won!`);
  }
}

/**
 * Closes the victory modal.
 */
export function closeVictoryModal() {
  const overlay = document.getElementById('victory-modal-overlay');
  overlay.classList.remove('active');
}