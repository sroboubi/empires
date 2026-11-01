import { CONFIG } from './config.js';

/**
 * Update the players UI list.
 * Moved from main.js to break up the file.
 * @param {Object} gameState - The active GameState
 */
export function updatePlayersUI(gameState) {
  const container = document.getElementById('players-list');
  container.innerHTML = '';

  const activePlayer = gameState.activePlayer;

  const header = document.createElement('div');
  header.style.marginBottom = '10px';
  header.style.fontSize = '12px';
  header.style.fontWeight = 'bold';
  header.style.color = 'var(--accent-color)';
  header.textContent = `ROUND ${gameState.currentRound} — TURN: ${activePlayer ? activePlayer.name.toUpperCase() : ''}${activePlayer && activePlayer.isAI ? ' (AI)' : ''}`;
  container.appendChild(header);

  // Find highest and second highest scores for relative score calculation
  const sortedScores = [...gameState.players].sort((a, b) => b.score.total - a.score.total);
  const highestScore = sortedScores[0]?.score.total || 0;
  const secondHighestScore = sortedScores[1]?.score.total || 0;

  const winCondition = gameState.settings?.winCondition || {};

  gameState.players.forEach(player => {
    const isActive = activePlayer && activePlayer.id === player.id;
    const li = document.createElement('li');
    li.className = 'player-list-item';
    li.style.display = 'flex';
    li.style.flexDirection = 'column';
    li.style.alignItems = 'flex-start';
    li.style.gap = '2px';
    li.style.marginBottom = '8px';
    li.style.padding = '8px';
    li.style.borderRadius = '6px';
    li.style.background = isActive ? 'rgba(167, 139, 250, 0.15)' : 'rgba(255, 255, 255, 0.02)';
    li.style.border = isActive ? '1px solid var(--accent-color)' : '1px solid rgba(255, 255, 255, 0.08)';

    const ordersStr = player.maxOrders > 0
      ? `orders: ${player.orders}/${player.maxOrders}`
      : '';

    const scoreStr = `total score: ${player.score.total} (${player.score.military} military, ${player.score.economic} economic, ${player.score.exploration} exploration)`;

    // Calculate score to win
    let scoreToWinParts = [];
    const minRoundsReached = gameState.currentRound >= CONFIG.MIN_GAME_ROUNDS;
    if (winCondition.absoluteScore) {
      scoreToWinParts.push(`Absolute: ${winCondition.absoluteScore}`);
    }
    if (winCondition.relativeScore) {
      // Use highest score if this player is not the highest, otherwise use second highest
      const targetScore = (player.score.total >= highestScore && sortedScores[0]?.id === player.id)
        ? secondHighestScore
        : highestScore;
      const relativeTarget = Math.ceil(winCondition.relativeScore * targetScore);
      scoreToWinParts.push(`Relative: ${relativeTarget} (${winCondition.relativeScore}×${targetScore})`);
    }
    const scoreToWinStr = scoreToWinParts.length > 0
      ? `score to win: ${scoreToWinParts.join(' | ')}`
      : '';
    const scoreToWinColor = minRoundsReached ? '#f1c40f' : '#666666';
    const scoreToWinText = minRoundsReached ? scoreToWinStr : `score to win: available after round ${CONFIG.MIN_GAME_ROUNDS}`;

    li.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="player-color-dot" style="background-color: ${player.color};"></span>
          <strong style="font-size: 14px; color: ${isActive ? '#ffffff' : 'var(--text-muted)'};">${player.name} ${isActive ? '◀ ACTIVE' : ''}</strong>
        </div>
        <span style="font-size: 10px; color: var(--accent-color); opacity: 0.8;">📊 Profile</span>
      </div>
      ${ordersStr ? `<div style="font-size: 11px; color: var(--accent-color); margin-left: 18px;">${ordersStr}</div>` : ''}
      ${scoreStr ? `<div style="font-size: 11px; color: var(--accent-color); margin-left: 18px;">${scoreStr}</div>` : ''}
      ${scoreToWinText ? `<div style="font-size: 11px; color: ${scoreToWinColor}; margin-left: 18px;">${scoreToWinText}</div>` : ''}
    `;

    // Long Hover (Tooltip) setup
    li.addEventListener('mouseenter', (ev) => {
      clearTimeout(playerHoverTimer);
      playerHoverTimer = setTimeout(() => {
        showResourceTooltip(player, ev.clientX, ev.clientY);
      }, 400);
    });

    li.addEventListener('mousemove', (ev) => {
      const tooltip = document.getElementById('resource-profile-tooltip');
      if (tooltip.classList.contains('active')) {
        positionResourceTooltip(ev.clientX, ev.clientY);
      }
    });

    li.addEventListener('mouseleave', () => {
      clearTimeout(playerHoverTimer);
      hideResourceTooltip();
    });

    // Click -> Open Detailed Resource Profile Modal
    li.addEventListener('click', () => {
      clearTimeout(playerHoverTimer);
      hideResourceTooltip();
      openProfileModal(player);
    });

    // Right-Click -> Player Context Menu with "Chat" option
    li.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      clearTimeout(playerHoverTimer);
      hideResourceTooltip();

      const activeP = gameState.activePlayer;
      // Requirement 2: Context menu when right-clicking an AI player
      if (!player.isAI) return;
      if (activeP && activeP.id === player.id) return;

      showPlayerContextMenu(ev.clientX, ev.clientY, player);
    });

    container.appendChild(li);
  });
}
