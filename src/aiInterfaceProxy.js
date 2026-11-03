/**
 * AI Interface Proxy
 *
 * Enforces the AI interface spec via JS Proxy wrappers.
 * See ~/workspace/llm-play/ai-interface-spec.md for the full spec.
 *
 * The AI gets wrapped gameState and player objects. The game engine and
 * aiHelper keep the real (unwrapped) objects.
 *
 * Rules enforced:
 * - WRITE: Any direct mutation (set/delete) throws. Legal mutations go
 *   through entity action.Do(), player history writes, and chat.
 * - READ (visibility): Other players expose only name/score/description.
 *   gameState.entities is filtered to visible entities only.
 *
 * ANTI-CHEAT: The UNWRAP symbol below is module-local and never exported.
 * AI code must not reference it. Verify with:
 *   grep -r "UNWRAP\|aiInterfaceUnwrap" src/ai/tactical/ src/ai/llm/ src/ai/standard/
 * If the symbol appears in AI source, the AI can bypass the proxy.
 */

// Hidden symbol for unwrapping proxies to real objects.
// NEVER export this. AI code must not reference it.
const UNWRAP = Symbol('aiInterfaceUnwrap');

const HIDDEN_PLAYER_PROPS = new Set([
  'resources', 'history', 'orders', 'maxOrders',
]);

/**
 * Unwrap a value if it's one of our proxies, else return as-is.
 * Used internally when forwarding AI calls into game code.
 * NOT exported — AI code must never access this.
 */
function unwrap(value) {
  if (value !== null && typeof value === 'object' && UNWRAP in value) {
    return value[UNWRAP];
  }
  return value;
}

/**
 * Wrap a function so that:
 * - Arguments from the AI are unwrapped to real objects before the call.
 * - Return value is wrapped before going back to the AI.
 */
function wrapFunction(fn, target, aiName, seen) {
  const bound = fn.bind(target);
  return new Proxy(bound, {
    apply(fnTarget, thisArg, args) {
      const realArgs = args.map(unwrap);
      const result = Reflect.apply(fnTarget, thisArg, realArgs);
      return deepWrap(result, aiName, seen);
    },
  });
}

/**
 * Deep read-only wrapper. Lazily wraps nested objects on read.
 * Functions are wrapped to unwrap args / wrap return values.
 */
function deepWrap(obj, aiName, seen = new WeakMap()) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (seen.has(obj)) return seen.get(obj);

  // Don't double-wrap our own proxies
  if (obj[UNWRAP] !== undefined && seen.has(obj[UNWRAP])) {
    return seen.get(obj[UNWRAP]);
  }

  const proxy = new Proxy(obj, {
    get(target, prop, receiver) {
      // Hidden unwrap path — not enumerable, not discoverable via ownKeys
      if (prop === UNWRAP) return target;

      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return wrapFunction(value, target, aiName, seen);
      }
      if (value !== null && typeof value === 'object') {
        return deepWrap(value, aiName, seen);
      }
      return value;
    },
    set(target, prop, value) {
      throw new Error(
        `[AI Interface] Illegal write: AI '${aiName}' attempted to set '${String(prop)}'. Use action.Do(), history, or chat.`
      );
    },
    deleteProperty(target, prop) {
      throw new Error(
        `[AI Interface] Illegal delete: AI '${aiName}' attempted to delete '${String(prop)}'.`
      );
    },
    ownKeys(target) {
      // Hide the UNWRAP symbol from enumeration
      return Reflect.ownKeys(target).filter(k => k !== UNWRAP);
    },
  });

  seen.set(obj, proxy);
  return proxy;
}

/**
 * Create a read-only proxy for a player object that is NOT the AI's own.
 * Only exposes name, score, description, id, color.
 */
function createOtherPlayerProxy(player, aiName) {
  return new Proxy(player, {
    get(target, prop, receiver) {
      if (prop === UNWRAP) return target;
      if (prop === 'name' || prop === 'score' || prop === 'description' ||
          prop === 'id' || prop === 'color') {
        return Reflect.get(target, prop, receiver);
      }
      if (HIDDEN_PLAYER_PROPS.has(prop)) {
        throw new Error(
          `[AI Interface] Illegal read: AI '${aiName}' attempted to read hidden property '${String(prop)}' of another player.`
        );
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return wrapFunction(value, target, aiName, new WeakMap());
      }
      return value;
    },
    set(target, prop, value) {
      throw new Error(
        `[AI Interface] Illegal write: AI '${aiName}' attempted to set '${String(prop)}' on another player.`
      );
    },
    deleteProperty(target, prop) {
      throw new Error(
        `[AI Interface] Illegal delete: AI '${aiName}' attempted to delete '${String(prop)}'.`
      );
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter(k => k !== UNWRAP);
    },
  });
}

/**
 * Create the gameState proxy for an AI.
 */
export function createGameStateProxy(gameState, ownPlayer, aiName) {
  const ownPlayerId = ownPlayer.id;
  const playerCache = new Map();
  const seen = new WeakMap();

  function wrapPlayer(p) {
    if (!p) return p;
    if (playerCache.has(p.id)) return playerCache.get(p.id);
    const wrapped = p.id === ownPlayerId
      ? deepWrap(p, aiName, seen)
      : createOtherPlayerProxy(p, aiName);
    playerCache.set(p.id, wrapped);
    return wrapped;
  }

  return new Proxy(gameState, {
    get(target, prop, receiver) {
      if (prop === UNWRAP) return target;

      if (prop === 'players') {
        const players = Reflect.get(target, prop, receiver);
        if (Array.isArray(players)) return players.map(wrapPlayer);
        return players;
      }

      if (prop === 'entities') {
        const entities = Reflect.get(target, prop, receiver);
        if (Array.isArray(entities) && ownPlayer.visibleCells) {
          const filtered = entities.filter(e => {
            if (!e || e.destroyed) return false;
            const ownerId = e.ownerId ?? e.owner?.id;
            if (ownerId === ownPlayerId) return true;
            return ownPlayer.visibleCells.has(`${e.q},${e.r}`);
          });
          return deepWrap(filtered, aiName, seen);
        }
        return deepWrap(entities, aiName, seen);
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return wrapFunction(value, target, aiName, seen);
      }
      if (value !== null && typeof value === 'object') {
        return deepWrap(value, aiName, seen);
      }
      return value;
    },
    set(target, prop, value) {
      throw new Error(
        `[AI Interface] Illegal write: AI '${aiName}' attempted to set '${String(prop)}' on gameState.`
      );
    },
    deleteProperty(target, prop) {
      throw new Error(
        `[AI Interface] Illegal delete: AI '${aiName}' attempted to delete '${String(prop)}' on gameState.`
      );
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter(k => k !== UNWRAP);
    },
  });
}

/**
 * Create the player proxy for the AI's own player.
 * Full read access, blocks direct writes.
 */
export function createPlayerProxy(player, aiName) {
  return deepWrap(player, aiName, new WeakMap());
}

/**
 * Construct an AI manager with proxied player/gameState.
 *
 * This is the ONLY entry point the game uses to create AI controllers.
 * It wraps the real player and gameState in read-only proxies (enforcing
 * the AI interface spec) before handing them to the manager constructor.
 * The helper keeps the real objects — it's the game-side bridge.
 *
 * AI code in src/ai/ must never import this module.
 *
 * @param {Function} ManagerClass - The AI controller class (extends BaseManager)
 * @param {Object} player - The real player object
 * @param {Object} helper - The AiHelper instance (keeps real objects)
 * @returns {Object} The constructed manager with proxied player/gameState
 */
export function createAiManager(ManagerClass, player, helper) {
  const aiName = player.name || `player-${player.id}`;
  const proxiedPlayer = createPlayerProxy(player, aiName);
  const proxiedGameState = createGameStateProxy(helper.getGameState(), player, aiName);
  // Construct with the real helper (it keeps real objects for game-side ops),
  // then swap in the proxied gameState. BaseManager sets gameState from
  // helper.getGameState() in its constructor; we overwrite with the proxy.
  const manager = new ManagerClass(proxiedPlayer, helper);
  manager.gameState = proxiedGameState;
  return manager;
}