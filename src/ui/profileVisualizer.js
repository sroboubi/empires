import { displayNum } from '../utils.js';

export function showResourceTooltip(gameState, player, x, y) {
  if (!player || !gameState) return;
  const tooltip = document.getElementById('resource-profile-tooltip');
  const content = document.getElementById('profile-tooltip-content');

  content.innerHTML = renderResourceProfileHTML(player, gameState, true);
  tooltip.classList.add('active');
  positionResourceTooltip(x, y);
}

export function hideResourceTooltip() {
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

export function openProfileModal(player, gameState) {
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