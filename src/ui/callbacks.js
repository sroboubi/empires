/**
 * UI callback registry.
 *
 * Game logic (main.js) registers callbacks here once at init. UI modules
 * read them when they need to trigger a game action (e.g. opening the
 * player context menu, starting a game from the setup form). This keeps
 * the dependency direction one-way: ui/ imports game code, never the
 * reverse — so there are no import cycles.
 *
 * Callbacks are read lazily (inside function bodies, never at module
 * top-level), so registration order only matters before the first call.
 */

let callbacks = {};

/**
 * Register UI callbacks. Called once from main.js init().
 * @param {Object} cbs - { onPlayerContextMenu, onStartGame, buildController, onSaveGame, onLoadGame, onDeleteSave, onSendChat, ... }
 */
export function setUiCallbacks(cbs) {
  callbacks = { ...callbacks, ...cbs };
}

/**
 * Get a registered callback by name. Returns undefined if not registered.
 */
export function getUiCallback(name) {
  return callbacks[name];
}