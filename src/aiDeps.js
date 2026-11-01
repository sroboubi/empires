/**
 * Engine-side AI dependency factory.
 *
 * This is the only place where the engine assembles the `deps` object that
 * `src/ai/` consumes. Keeping it here (rather than inside `src/ai/`) is what
 * lets the AI module stay free of engine imports.
 *
 * The shape is documented in `src/ai/deps.js` (AIDeps). Callers may pass
 * overrides to replace individual config values or hooks.
 */
import { HexGrid, DIRECTIONS_8 } from './hexGrid.js';
import { camelToTitle, sleep, calculateAttackMultiplier } from './utils.js';
import { applyResourceYieldBonus } from './resources.js';
import { reconcileEntities } from './renderer.js';
import * as mainModule from './main.js';
import Entity from './entity.js';
import { CONFIG } from './config.js';

/**
 * Builds the dependency object passed to AI managers and barbarian logic.
 *
 * `updatePlayersUI` is accessed lazily through the main.js namespace to avoid
 * touching the binding during module evaluation (main.js imports player.js,
 * which imports this module).
 *
 * @param {Object} [overrides] partial deps; `config` and `hooks` are merged one level deep
 * @returns {Object} AI deps
 */
export function createAIDeps(overrides = {}) {
    const deps = {
        HexGrid,
        DIRECTIONS_8,
        config: {
            buildMaxDistance: CONFIG.AI_BUILD_MAX_DISTANCE,
            buildDistancePenalty: CONFIG.AI_BUILD_DISTANCE_PENALTY,
            actionSleepMs: CONFIG.AI_ACTION_SLEEP,
            showAll: CONFIG.SHOW_ALL,
        },
        hooks: {
            reconcileEntities,
            updatePlayersUI: (...args) => mainModule.updatePlayersUI(...args),
            sleep,
            calculateAttackMultiplier,
            applyResourceYieldBonus,
            camelToTitle,
            createEntity: (meta, owner, gameState, cell) => new Entity(meta, owner, gameState, cell),
        },
    };

    return {
        ...deps,
        ...overrides,
        config: { ...deps.config, ...(overrides.config || {}) },
        hooks: { ...deps.hooks, ...(overrides.hooks || {}) },
    };
}
