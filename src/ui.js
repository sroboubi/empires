import { CONFIG } from './config.js';
import { displayNum } from './utils.js';

let playerHoverTimer = null;

/**
 * Update the players UI list.
 * Moved from main.js to break up the file.
 * @param {Object} gameState - The active GameState
 * @param {Object} [callbacks] - Optional callbacks: { onContextMenu(x, y, player) }
 *   Context menu lives in main.js (entangled with chat/game state), so it's
 *   injected rather than imported to keep ui.js isolated.
 */
export function updatePlayersUI(gameState, callbacks = {}) {
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
      <div class="flex-row-between">
        <div class="flex-row">
          <span class="player-color-dot" style="background-color: ${player.color};"></span>
          <strong style="font-size: 14px; color: ${isActive ? '#ffffff' : 'var(--text-muted)'};">${player.name} ${isActive ? '◀ ACTIVE' : ''}</strong>
        </div>
        <span class="profile-link">📊 Profile</span>
      </div>
      ${ordersStr ? `<div class="player-sub-line">${ordersStr}</div>` : ''}
      ${scoreStr ? `<div class="player-sub-line">${scoreStr}</div>` : ''}
      ${scoreToWinText ? `<div style="font-size: 11px; color: ${scoreToWinColor}; margin-left: 18px;">${scoreToWinText}</div>` : ''}
    `;

    // Long Hover (Tooltip) setup
    li.addEventListener('mouseenter', (ev) => {
      clearTimeout(playerHoverTimer);
      playerHoverTimer = setTimeout(() => {
        showResourceTooltip(gameState, player, ev.clientX, ev.clientY);
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
      openProfileModal(player, gameState);
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

      if (callbacks.onContextMenu) {
        callbacks.onContextMenu(ev.clientX, ev.clientY, player);
      }
    });

    container.appendChild(li);
  });
}

function showResourceTooltip(gameState, player, x, y) {
  if (!player || !gameState) return;
  const tooltip = document.getElementById('resource-profile-tooltip');
  const content = document.getElementById('profile-tooltip-content');

  content.innerHTML = renderResourceProfileHTML(player, gameState, true);
  tooltip.classList.add('active');
  positionResourceTooltip(x, y);
}

function hideResourceTooltip() {
  const tooltip = document.getElementById('resource-profile-tooltip');
  if (tooltip) tooltip.classList.remove('active');
}

function positionResourceTooltip(x, y) {
  const tooltip = document.getElementById('resource-profile-tooltip');
  if (!tooltip) return;
  const rect = tooltip.getBoundingClientRect();
  let posX = x + 15;
  let posY = y - 20;

  if (posX + rect.width > window.innerWidth - 10) {
    posX = x - rect.width - 15;
  }
  if (posY + rect.height > window.innerHeight - 10) {
    posY = window.innerHeight - rect.height - 10;
  }
  tooltip.style.left = `${Math.max(10, posX)}px`;
  tooltip.style.top = `${Math.max(10, posY)}px`;
}

export function renderResourceProfileHTML(player, gameState, isCompact = false) {
  const { totalUpkeep, totalYields, netIncome } = player.getResourceProfile(gameState);
  const myEntities = player.getEntities(gameState);

  const resourceKeys = Array.from(new Set([
    ...Object.keys(player.resources || {}),
    ...Object.keys(totalYields || {}),
    ...Object.keys(totalUpkeep || {})
  ])).sort();

  const summaryHTML = isCompact ? '' : `
    <div class="profile-summary-grid">
      <div class="profile-stat-box">
        <span class="profile-stat-label">Military Score</span>
        <span class="profile-stat-val stat-military">${player.score.military}</span>
      </div>
      <div class="profile-stat-box">
        <span class="profile-stat-label">Economic Score</span>
        <span class="profile-stat-val stat-economic">${player.score.economic}</span>
      </div>
      <div class="profile-stat-box">
        <span class="profile-stat-label">Exploration Score</span>
        <span class="profile-stat-val stat-exploration">${player.score.exploration}</span>
      </div>
      <div class="profile-stat-box">
        <span class="profile-stat-label">Orders</span>
        <span class="profile-stat-val stat-orders">${player.orders}/${player.maxOrders}</span>
      </div>
    </div>
  `;

  // Resource display colors come from definitions/resources.json (via manifestData),
  // with a hardcoded fallback so the profile still renders if the manifest is absent.
  const manifestResources = gameState.manifestData?.resources || [];
  const resourceColor = (name) => {
    const entry = manifestResources.find(r => r.name?.toLowerCase() === name.toLowerCase());
    return entry?.color || 'var(--accent-color)';
  };

  let chartsHTML = '';
  resourceKeys.forEach(res => {
    const stock = player.resources[res] || 0;
    const yields = totalYields[res] || 0;
    const upkeep = totalUpkeep[res] || 0;
    const net = netIncome[res] || 0;
    const projectedStock = Math.max(0, stock + net);

    const netClass = net > 0 ? 'positive' : (net < 0 ? 'negative' : 'neutral');
    const netStr = net > 0 ? `+${displayNum(net)}/turn` : (net < 0 ? `${displayNum(net)}/turn` : `0/turn`);

    // Stock Bar Scale & Segments
    const maxStockScale = Math.max(stock, projectedStock, stock + Math.abs(net), 60);
    let stockBarHTML = '';

    if (net >= 0) {
      const baseStockPct = Math.min(100, Math.round((stock / maxStockScale) * 100));
      const gainPct = Math.min(100 - baseStockPct, Math.round((net / maxStockScale) * 100));
      stockBarHTML = `
        <div class="stock-bar-container" title="Current Stock: ${displayNum(stock)} | Projected Gain: ${displayNum(net)} | Projected Next Turn: ${displayNum(projectedStock)}">
          <div class="stock-bar-current" style="width: ${baseStockPct}%;"></div>
          <div class="stock-bar-gain" style="width: ${gainPct}%;"></div>
        </div>
      `;
    } else {
      const deficitAmount = Math.min(stock, Math.abs(net));
      const safeStock = Math.max(0, stock - deficitAmount);
      const safeStockPct = Math.min(100, Math.round((safeStock / maxStockScale) * 100));
      const lossPct = Math.min(100 - safeStockPct, Math.round((deficitAmount / maxStockScale) * 100));
      stockBarHTML = `
        <div class="stock-bar-container" title="Current Stock: ${displayNum(stock)} | Projected Loss: ${displayNum(net)} | Projected Next Turn: ${displayNum(projectedStock)}">
          <div class="stock-bar-current" style="width: ${safeStockPct}%;"></div>
          <div class="stock-bar-loss" style="width: ${lossPct}%;"></div>
        </div>
      `;
    }

    // Yield vs Upkeep Sub-bar
    const maxFlowScale = Math.max(yields + upkeep, 15);
    const yieldPct = Math.min(100, Math.round((yields / maxFlowScale) * 100));
    const upkeepPct = Math.min(100, Math.round((upkeep / maxFlowScale) * 100));

    const color = resourceColor(res);
    const projectionText = net >= 0 ? `<span class="text-positive">(+${displayNum(net)} ➔ ${displayNum(projectedStock)})</span>` : `<span class="text-negative">(${displayNum(net)} ➔ ${displayNum(projectedStock)})</span>`;

    chartsHTML += `
      <div class="resource-chart-row">
        <div class="resource-chart-header">
          <span class="resource-chart-name" style="color: ${color};">
            ● ${res}
          </span>
          <div class="flex-row">
            <span class="text-muted-small">Stock: <strong>${displayNum(stock)}</strong> ${projectionText}</span>
            <span class="resource-chart-net ${netClass}">${netStr}</span>
          </div>
        </div>

        ${stockBarHTML}

        <div class="stacked-bar-container stacked-bar-spaced">
          <div class="stacked-bar-yield" style="width: ${yieldPct}%;" title="Yields: +${displayNum(yields)}/turn"></div>
          <div class="stacked-bar-upkeep" style="width: ${upkeepPct}%;" title="Upkeep: -${displayNum(upkeep)}/turn"></div>
        </div>

        <div class="resource-details-line">
          <span class="text-positive">▲ Yield: +${displayNum(yields)}/turn</span>
          <span class="text-negative">▼ Upkeep: -${displayNum(upkeep)}/turn</span>
        </div>
      </div>
    `;
  });

  // Entity breakdown section for full modal view
  let entityBreakdownHTML = '';
  if (!isCompact && myEntities.length > 0) {
    const entityCounts = {};
    myEntities.forEach(e => {
      entityCounts[e.name] = (entityCounts[e.name] || 0) + 1;
    });

    const chips = Object.entries(entityCounts)
      .map(([name, count]) => `<span class="entity-chip"><strong>${name}</strong> x${count}</span>`)
      .join(' ');

    entityBreakdownHTML = `
      <div class="divider divider-spaced"></div>
      <div class="section-title">Owned Entities Breakdown</div>
      <div class="flex-wrap-gap">
        ${chips}
      </div>
    `;
  }

  // History panel section for full modal view
  let historyHTML = '';
  if (!isCompact) {
    // Get all rounds that have history (newest first)
    const allRounds = Array.from(player.history.keys()).sort((a, b) => b - a);

    // Pagination settings - fixed 5 rounds per page
    const roundsPerPage = 5;
    const currentPage = parseInt(sessionStorage.getItem('historyCurrentPage') || '0', 10);
    const totalPages = Math.ceil(allRounds.length / roundsPerPage);
    const validPage = Math.max(0, Math.min(currentPage, totalPages - 1));

    const startIdx = validPage * roundsPerPage;
    const endIdx = Math.min(startIdx + roundsPerPage, allRounds.length);
    const pageRounds = allRounds.slice(startIdx, endIdx);

    let historyEntriesHTML = '';
    if (pageRounds.length > 0) {
      for (const round of pageRounds) {
        const entries = player.history.get(round) || [];
        if (entries.length === 0) continue;

        historyEntriesHTML += `
          <div class="history-round-group">
            <div class="history-round-header">
              Round ${round} (${entries.length} events)
            </div>
            <div class="history-entries">
        `;

        for (const entry of entries) {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          const categoryColors = {
            'action': '#a78bfa',
            'damage': '#e74c3c',
            'spawn': '#2ecc71',
            'destroy': '#e67e22',
            'orders': '#f1c40f',
            'note': '#38bdf8'
          };
          const categoryColor = categoryColors[entry.category] || 'var(--text-main)';

          historyEntriesHTML += `
            <div class="history-entry" style="font-size: 11px; padding: 6px 8px; background: rgba(255,255,255,0.03); border-radius: 4px; border-left: 3px solid ${categoryColor};">
              <div class="flex-row-between">
                <span style="color: ${categoryColor}; font-weight: 600; text-transform: uppercase; font-size: 10px;">${entry.category}</span>
                <span class="text-muted-tiny">${time}</span>
              </div>
              <div class="history-entry-text">
                ${entry.details}
              </div>
            </div>
          `;
        }

        historyEntriesHTML += `
            </div>
          </div>
        `;
      }
    } else {
      historyEntriesHTML = '<div class="history-empty">No history entries yet.</div>';
    }

    // Simple pagination controls (fixed 5 rounds per page)
    const paginationHTML = totalPages > 1 ? `
      <div class="history-pagination">
        <button id="history-prev-page" class="btn btn-small btn-auto" ${validPage === 0 ? 'disabled' : ''}>← Prev</button>
        <span class="pagination-label">Page ${validPage + 1} of ${totalPages} (5 rounds/page)</span>
        <button id="history-next-page" class="btn btn-small btn-auto" ${validPage >= totalPages - 1 ? 'disabled' : ''}>Next →</button>
      </div>
    ` : '';

    historyHTML = `
      <div class="divider divider-spaced"></div>
      <div class="section-title section-title-row">
        <span>History</span>
        <span class="text-muted-small">${allRounds.length} rounds recorded</span>
      </div>
      <div id="history-panel-content" class="history-scroll">
        ${historyEntriesHTML}
      </div>
      ${paginationHTML}
    `;
  }

  const titleHeader = isCompact ? `
    <div class="flex-row flex-row-spaced">
      <span class="player-color-dot" style="background-color: ${player.color};"></span>
      <strong class="profile-title">${player.name} Resource Profile</strong>
    </div>
  ` : '';

  return `
    ${titleHeader}
    ${summaryHTML}
    <div class="section-title section-title-spaced">Resource Flow & Balance</div>
    ${chartsHTML}
    ${entityBreakdownHTML}
    ${historyHTML}
  `;
}

/* ==========================================================================
   RESOURCE PROFILE VISUALIZER (MODAL & TOOLTIP)
   ========================================================================== */

function openProfileModal(player, gameState) {
  if (!player || !gameState) return;
  const overlay = document.getElementById('profile-modal-overlay');
  const colorDot = document.getElementById('profile-modal-color');
  const nameSpan = document.getElementById('profile-modal-player-name');
  const content = document.getElementById('profile-modal-content');

  colorDot.style.backgroundColor = player.color;
  nameSpan.textContent = `${player.name.toUpperCase()} — RESOURCE PROFILE`;

  function updateModalContent() {
    content.innerHTML = renderResourceProfileHTML(player, gameState, false);

    const prevBtn = document.getElementById('history-prev-page');
    const nextBtn = document.getElementById('history-next-page');

    if (prevBtn) {
      prevBtn.onclick = () => {
        const currentPage = parseInt(sessionStorage.getItem('historyCurrentPage') || '0', 10);
        sessionStorage.setItem('historyCurrentPage', String(currentPage - 1));
        updateModalContent();
      };
    }

    if (nextBtn) {
      nextBtn.onclick = () => {
        const currentPage = parseInt(sessionStorage.getItem('historyCurrentPage') || '0', 10);
        sessionStorage.setItem('historyCurrentPage', String(currentPage + 1));
        updateModalContent();
      };
    }
  }

  updateModalContent();
  overlay.classList.add('active');
}