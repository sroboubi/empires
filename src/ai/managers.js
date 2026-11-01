/**
 * Resolves a player.controller value to a BaseManager instance.
 *
 * Controller contract:
 * - null/undefined -> human player (no manager; resolves null)
 * - string URL     -> dynamically imported manager class, e.g.
 *     'standard/smartManager.js', 'llm/json/harness.js', 'llm/menu/harness.js'.
 *     Relative URLs resolve against src/ai/; absolute URLs import as-is.
 *     (Future: more fields on the controller will seed the system prompt
 *     with player description, tendencies, attitude, etc.)
 * - legacy 'ai'/'llm' strings and truthy non-strings (old setup UI) map to
 *   the previous defaults.
 */
import { BaseManager } from './baseManager.js';

const LEGACY_ALIASES = {
    ai: 'standard/smartManager.js',
    llm: 'llm/json/harness.js',
};

function normalizeController(controller, gameState) {
    if (!controller) return null;
    if (typeof controller === 'string') {
        return LEGACY_ALIASES[controller] || controller;
    }
    // Legacy truthy non-string (setup UI checkbox): preserve the old auto-choice.
    const llm = gameState?.settings?.llm;
    return llm?.orderedModels?.length ? 'llm/json/harness.js' : 'standard/smartManager.js';
}

export function resolveControllerUrl(controller, gameState) {
    const url = normalizeController(controller, gameState);
    if (!url) return null;
    if (/^(https?:|data:|blob:)/.test(url) || url.startsWith('/')) return url;
    return `./${url}`;
}

export async function createAiManager(player, gameState, controller) {
    const specifier = resolveControllerUrl(controller, gameState);
    if (!specifier) return null;
    const mod = await import(specifier);
    const ManagerClass = mod.default
        || Object.values(mod).find(v => typeof v === 'function' && v.prototype instanceof BaseManager);
    if (!ManagerClass) {
        throw new Error(`Controller "${controller}" did not export a BaseManager subclass`);
    }
    return new ManagerClass(player, gameState, controller);
}
