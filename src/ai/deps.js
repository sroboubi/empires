/**
 * AI dependency registry.
 *
 * `src/ai/` must not import engine modules directly. Instead, the engine
 * builds a `deps` object (see `src/aiDeps.js`) and passes it to the AI
 * manager constructor. `BaseManager` calls `initAI(deps)` so standalone
 * helper functions (which are not class methods) can read the same
 * dependencies from this module-level registry.
 *
 * Contract (all fields optional; AI code degrades gracefully when absent):
 *
 * @typedef {Object} AIDeps
 * @property {Function} [HexGrid] - HexGrid class (static helpers: distance, etc.)
 * @property {string[]} [DIRECTIONS_8] - Compass direction names
 * @property {Object} [config]
 * @property {number} [config.buildMaxDistance]
 * @property {number} [config.buildDistancePenalty]
 * @property {number} [config.actionSleepMs]
 * @property {boolean} [config.showAll]
 * @property {Object} [config.promptUrls]
 * @property {string} [config.promptUrls.command]
 * @property {string} [config.promptUrls.menu]
 * @property {string} [config.promptUrls.chat]
 * @property {string} [config.promptUrls.chatSummation]
 * @property {Object} [hooks]
 * @property {function(Object, Array<Object>=): void} [hooks.reconcileEntities]
 * @property {function(): void} [hooks.updatePlayersUI]
 * @property {function(number): Promise<void>} [hooks.sleep]
 * @property {function(Object, Object, number, Object): Object} [hooks.calculateAttackMultiplier]
 * @property {function(Object, Object, Object): Object} [hooks.applyResourceYieldBonus]
 * @property {function(string): string} [hooks.camelToTitle]
 * @property {function(Object, Object, Object, Object): Object} [hooks.createEntity]
 */

const EMPTY_DEPS = {
    HexGrid: null,
    DIRECTIONS_8: [],
    config: {},
    hooks: {},
};

let _deps = { ...EMPTY_DEPS };

/**
 * Registers engine dependencies for the AI module. Safe to call repeatedly;
 * later calls merge into the existing registry (config and hooks are merged
 * one level deep so partial overrides do not wipe earlier values).
 *
 * @param {AIDeps} [deps]
 * @returns {AIDeps} the merged registry
 */
export function initAI(deps = {}) {
    _deps = {
        ..._deps,
        ...deps,
        config: { ...(_deps.config || {}), ...(deps.config || {}) },
        hooks: { ...(_deps.hooks || {}), ...(deps.hooks || {}) },
    };
    return _deps;
}

/** @returns {AIDeps} the current dependency registry */
export function getAIDeps() {
    return _deps;
}

/** @returns {Function|null} the injected HexGrid class */
export function getHexGrid() {
    return _deps.HexGrid || null;
}

/** @returns {string[]} the injected compass directions */
export function getDirections8() {
    return _deps.DIRECTIONS_8 || [];
}

/** @returns {Object} the injected AI config */
export function getAIConfig() {
    return _deps.config || {};
}

/** @returns {Object} the injected engine hooks */
export function getAIHooks() {
    return _deps.hooks || {};
}
