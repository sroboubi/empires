/**
 * Diplomatic chat modal.
 *
 * Takes gameState as a parameter. AI interaction goes through the player
 * objects directly (getAiManager). UI refresh via playersList module.
 * No imports from main.js.
 */
import { updatePlayersUI } from './playersList.js';

let currentChatSession = {
  humanPlayer: null,
  aiPlayer: null,
  resolvePromise: null,
  isWaitingForAi: false
};

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function renderChatMessages(gameState) {
  const container = document.getElementById('chat-messages-container');
  if (!container || !currentChatSession.humanPlayer || !currentChatSession.aiPlayer) return;

  const history = gameState.getChatHistory(currentChatSession.humanPlayer, currentChatSession.aiPlayer);
  if (!history || history.length === 0) {
    container.innerHTML = `
      <div class="chat-empty">
        No diplomatic correspondence on record. Send a message to open negotiations with ${currentChatSession.aiPlayer.name}.
      </div>
    `;
    return;
  }

  container.innerHTML = history.map(msg => {
    const isHuman = msg.sender === currentChatSession.humanPlayer.name;
    const authorColor = isHuman ? 'var(--accent-color)' : currentChatSession.aiPlayer.color;
    const timeStr = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '';
    const bubbleClass = isHuman ? 'chat-msg chat-msg-sent' : 'chat-msg chat-msg-received';

    return `
      <div class="${bubbleClass}"${isHuman ? '' : ` style="border-left: 3px solid ${currentChatSession.aiPlayer.color};"`}>
        <div class="chat-msg-header">
          <div class="flex-row" style="gap: 6px;">
            <span class="player-color-dot" style="background-color: ${authorColor}; width: 8px; height: 8px;"></span>
            <span class="chat-msg-author" style="color: ${authorColor};">${escapeHTML(msg.sender)}</span>
          </div>
          <span class="chat-msg-time">${timeStr}</span>
        </div>
        <div class="chat-msg-body">${escapeHTML(msg.content)}</div>
      </div>
    `;
  }).join('');

  container.scrollTop = container.scrollHeight;
}

export function openChatModal(gameState, humanPlayer, aiPlayer, options = {}) {
  if (!gameState || !humanPlayer || !aiPlayer) return Promise.resolve();

  const overlay = document.getElementById('chat-modal-overlay');
  const colorDot = document.getElementById('chat-modal-color');
  const title = document.getElementById('chat-modal-title');
  const input = document.getElementById('chat-message-input');
  const sendBtn = document.getElementById('btn-send-chat');
  const statusIndicator = document.getElementById('chat-status-indicator');

  colorDot.style.backgroundColor = aiPlayer.color;
  title.textContent = `DIPLOMACY: ${aiPlayer.name.toUpperCase()}`;
  statusIndicator.innerHTML = '';
  input.value = '';
  input.disabled = false;
  sendBtn.disabled = false;

  return new Promise((resolve) => {
    currentChatSession = {
      humanPlayer,
      aiPlayer,
      resolvePromise: resolve,
      isWaitingForAi: false
    };

    renderChatMessages(gameState);
    overlay.classList.add('active');
    setTimeout(() => input.focus(), 100);
  });
}

export async function closeChatModal(gameState) {
  const overlay = document.getElementById('chat-modal-overlay');
  if (!overlay || !overlay.classList.contains('active')) return;

  overlay.classList.remove('active');

  const { humanPlayer, aiPlayer, resolvePromise } = currentChatSession;
  if (aiPlayer && humanPlayer) {
    const mgr = await aiPlayer.getAiManager();
    if (mgr) await mgr.summarizeChatAndAddNote(humanPlayer);
  }

  updatePlayersUI(gameState);

  if (resolvePromise) {
    resolvePromise();
  }
  currentChatSession = {
    humanPlayer: null,
    aiPlayer: null,
    resolvePromise: null,
    isWaitingForAi: false
  };
}

export async function sendChatMessage(gameState) {
  if (currentChatSession.isWaitingForAi) return;

  const input = document.getElementById('chat-message-input');
  const sendBtn = document.getElementById('btn-send-chat');
  const statusIndicator = document.getElementById('chat-status-indicator');
  const text = input.value.trim();
  if (!text) return;

  const { humanPlayer, aiPlayer } = currentChatSession;
  if (!humanPlayer || !aiPlayer) return;

  gameState.addChatMessage(humanPlayer, aiPlayer, text);
  input.value = '';
  renderChatMessages(gameState);

  currentChatSession.isWaitingForAi = true;
  input.disabled = true;
  sendBtn.disabled = true;
  statusIndicator.innerHTML = `
    <span class="chat-thinking">⏳</span>
    <span>${aiPlayer.name} is formulating a response...</span>
  `;

  try {
    const mgr = await aiPlayer.getAiManager();
    if (mgr) {
      const reply = await mgr.generateChatReply(humanPlayer);

      gameState.addChatMessage(aiPlayer, humanPlayer, reply.content);
      renderChatMessages(gameState);

      if (reply.ended) {
        statusIndicator.innerHTML = `<span class="chat-concluded">[ ${aiPlayer.name} has concluded the negotiations. ]</span>`;
        updatePlayersUI(gameState);
      } else {
        statusIndicator.innerHTML = '';
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
      }
    }
  } catch (err) {
    console.error('Error generating AI chat reply:', err);
    statusIndicator.innerHTML = `<span class="chat-error">Failed to get response from ${aiPlayer.name}.</span>`;
    input.disabled = false;
    sendBtn.disabled = false;
  } finally {
    currentChatSession.isWaitingForAi = false;
  }
}

export function getCurrentChatSession() {
  return currentChatSession;
}

// Expose on window for harness access
if (typeof window !== 'undefined') {
  window.openChatModal = (gs, h, a, o) => openChatModal(gs, h, a, o);
  window.closeChatModal = (gs) => closeChatModal(gs);
}