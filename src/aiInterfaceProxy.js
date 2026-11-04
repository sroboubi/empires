/**
 * AI Interface Proxy
 *
 * Enforces the AI interface spec via JS Proxy wrappers.
 * Located outside src/ai/ so AI implementations have zero dependency on or
 * knowledge of the proxy infrastructure.
 *
 * Rules enforced:
 * - WRITE: Any direct mutation (set/delete) throws. Legal mutations go
 *   through entity action.do(), player history writes, and chat.
 * - READ (visibility & fog-of-war):
 *   - Other players expose only name, score, description, id, color, isAI.
 *     Private fields (resources, orders, history, etc.) return undefined.
 *   - gameState.entities, getEntityAt(), and getEntityById() only return visible entities.
 *   - hexGrid.getCell() on unexplored cells returns undefined; unexplored cell terrain/resources return undefined.
 *   - Third-party chat history is hidden.
 * - ACTION LEGALITY:
 *   - AI cannot call action.do() or helper commands on entities owned by another player.
 *
 * ANTI-CHEAT: The UNWRAP symbol is module-local and never exported.
 */

// Hidden symbol for unwrapping proxies to real objects.
// Module-local and never exported to prevent AI bypass.
const UNWRAP = Symbol('aiInterfaceUnwrap');

const HIDDEN_PLAYER_PROPS = new Set([
  'resources', 'history', 'orders', 'maxOrders', 'ordersPerTurn',
  'exploredCells', 'visibleCells', 'startCoord', '_chatCooldownOrders'
]);

/**
 * Unwrap a value if it's one of our proxies, else return as-is.
 */
function unwrap(value) {
  if (value !== null && typeof value === 'object' && UNWRAP in value) {
    return value[UNWRAP];
  }
  return value;
}

function isVisibleToPlayer(player, q, r) {
  if (!player) return false;
  if (typeof player.isVisible === 'function') return player.isVisible(q, r);
  return player.visibleCells ? player.visibleCells.has(`${q},${r}`) : false;
}

function isExploredByPlayer(player, q, r) {
  if (!player) return false;
  if (typeof player.isExplored === 'function') return player.isExplored(q, r);
  return player.exploredCells ? player.exploredCells.has(`${q},${r}`) : false;
}

/**
 * Wrap a function so that:
 * - Arguments from the AI are unwrapped to real objects before the call.
 * - Return values are wrapped before going back to the AI.
 */
function wrapFunction(fn, target, aiName, seen, ownPlayer = null) {
  const bound = fn.bind(target);
  return new Proxy(bound, {
    apply(fnTarget, thisArg, args) {
      const realArgs = args.map(unwrap);
      const result = Reflect.apply(fnTarget, thisArg, realArgs);
      return deepWrap(result, aiName, seen, ownPlayer);
    },
    has(target, prop) {
      if (prop === UNWRAP) return true;
      return Reflect.has(target, prop);
    },
  });
}

/**
 * Deep read-only wrapper. Lazily wraps nested objects on read.
 * Functions are wrapped to unwrap args / wrap return values.
 */
function deepWrap(obj, aiName, seen = new WeakMap(), ownPlayer = null) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (seen.has(obj)) return seen.get(obj);

  // Don't double-wrap our own proxies
  if (obj[UNWRAP] !== undefined && seen.has(obj[UNWRAP])) {
    return seen.get(obj[UNWRAP]);
  }

  const isCell = typeof obj.q === 'number' && typeof obj.r === 'number' && (obj.terrain !== undefined || obj.key);

  const proxy = new Proxy(obj, {
    get(target, prop, receiver) {
      if (prop === UNWRAP) return target;

      // Gap 1: Fog-of-war on cell terrain and resources
      if (isCell && ownPlayer && (prop === 'terrain' || prop === 'resources')) {
        if (!isExploredByPlayer(ownPlayer, target.q, target.r)) {
          return undefined;
        }
      }

      // Gap 4: Enforce action ownership when getActions() is called
      if (prop === 'getActions' && typeof target.getActions === 'function') {
        const isOwned = !ownPlayer || (target.ownerId ?? target.owner?.id) === ownPlayer.id;
        return () => {
          const actions = target.getActions();
          return actions.map(action => {
            const wrappedAction = deepWrap(action, aiName, seen, ownPlayer);
            if (!isOwned) {
              return new Proxy(wrappedAction, {
                get(actTarget, actProp) {
                  if (actProp === 'do') {
                    return () => {
                      throw new Error(
                        `[AI Interface] Illegal action: AI '${aiName}' attempted to execute action '${action.name}' on entity '${target.name}' owned by another player.`
                      );
                    };
                  }
                  return Reflect.get(actTarget, actProp);
                }
              });
            }
            return wrappedAction;
          });
        };
      }

      // Reflect.get with receiver can throw for built-in accessors (e.g. Set.prototype.size
      // when target is a Set): the getter runs with `this` = proxy, which lacks the internal slots.
      // Fall back to target-bound lookup in that case.
      let value;
      try {
        value = Reflect.get(target, prop, receiver);
      } catch (e) {
        value = Reflect.get(target, prop);
      }
      if (typeof value === 'function') {
        return wrapFunction(value, target, aiName, seen, ownPlayer);
      }
      if (value !== null && typeof value === 'object') {
        return deepWrap(value, aiName, seen, ownPlayer);
      }
      return value;
    },
    set(target, prop) {
      throw new Error(
        `[AI Interface] Illegal write: AI '${aiName}' attempted to set '${String(prop)}'. Use action.do(), history, or chat.`
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
    has(target, prop) {
      if (prop === UNWRAP) return true;
      return Reflect.has(target, prop);
    },
  });

  seen.set(obj, proxy);
  return proxy;
}

/**
 * Create a read-only proxy for an opponent player.
 * Gap 5: Returns undefined on hidden properties instead of throwing error.
 */
function createOtherPlayerProxy(player, aiName) {
  return new Proxy(player, {
    get(target, prop, receiver) {
      if (prop === UNWRAP) return target;
      if (prop === 'name' || prop === 'score' || prop === 'description' ||
        prop === 'id' || prop === 'color' || prop === 'isAI') {
        return Reflect.get(target, prop, receiver);
      }
      if (HIDDEN_PLAYER_PROPS.has(prop)) {
        return undefined;
      }
      // Reflect.get with receiver can throw for built-in accessors (e.g. Set.prototype.size
      // when target is a Set): the getter runs with `this` = proxy, which lacks the internal slots.
      // Fall back to target-bound lookup in that case.
      let value;
      try {
        value = Reflect.get(target, prop, receiver);
      } catch (e) {
        value = Reflect.get(target, prop);
      }
      if (typeof value === 'function') {
        return () => undefined;
      }
      return undefined;
    },
    set(target, prop) {
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
    has(target, prop) {
      if (prop === UNWRAP) return true;
      return Reflect.has(target, prop);
    },
  });
}

/**
 * Proxy for HexGrid enforcing Gap 1 (unexplored cell masking).
 */
function createHexGridProxy(hexGrid, ownPlayer, aiName, seen) {
  return new Proxy(hexGrid, {
    get(target, prop, receiver) {
      if (prop === UNWRAP) return target;

      if (prop === 'getCell') {
        return (q, r) => {
          if (!isExploredByPlayer(ownPlayer, q, r)) return undefined;
          const cell = target.getCell(q, r);
          return cell ? deepWrap(cell, aiName, seen, ownPlayer) : null;
        };
      }

      if (prop === 'getNeighbors') {
        return (q, r) => {
          const neighbors = target.getNeighbors(q, r);
          return (neighbors || []).map(c => deepWrap(c, aiName, seen, ownPlayer));
        };
      }

      if (prop === 'getCellsArray') {
        return () => {
          const cells = target.getCellsArray ? target.getCellsArray() : [];
          return cells
            .filter(c => isExploredByPlayer(ownPlayer, c.q, c.r))
            .map(c => deepWrap(c, aiName, seen, ownPlayer));
        };
      }

      // Reflect.get with receiver can throw for built-in accessors (e.g. Set.prototype.size
      // when target is a Set): the getter runs with `this` = proxy, which lacks the internal slots.
      // Fall back to target-bound lookup in that case.
      let value;
      try {
        value = Reflect.get(target, prop, receiver);
      } catch (e) {
        value = Reflect.get(target, prop);
      }
      if (typeof value === 'function') {
        return wrapFunction(value, target, aiName, seen, ownPlayer);
      }
      if (value !== null && typeof value === 'object') {
        return deepWrap(value, aiName, seen, ownPlayer);
      }
      return value;
    },
    set(target, prop) {
      throw new Error(
        `[AI Interface] Illegal write: AI '${aiName}' attempted to set '${String(prop)}' on hexGrid.`
      );
    },
    deleteProperty(target, prop) {
      throw new Error(
        `[AI Interface] Illegal delete: AI '${aiName}' attempted to delete '${String(prop)}' on hexGrid.`
      );
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter(k => k !== UNWRAP);
    },
    has(target, prop) {
      if (prop === UNWRAP) return true;
      return Reflect.has(target, prop);
    },
  });
}

/**
 * Create the gameState proxy for an AI.
 * Enforces entity visibility, getEntityAt/getEntityById masking, and chat privacy.
 */
export function createGameStateProxy(gameState, ownPlayer, aiName, seen = new WeakMap()) {
  const ownPlayerId = ownPlayer.id;
  const playerCache = new Map();

  function wrapPlayer(p) {
    if (!p) return p;
    if (playerCache.has(p.id)) return playerCache.get(p.id);
    const wrapped = p.id === ownPlayerId
      ? deepWrap(p, aiName, seen, ownPlayer)
      : createOtherPlayerProxy(p, aiName);
    playerCache.set(p.id, wrapped);
    return wrapped;
  }

  return new Proxy(gameState, {
    get(target, prop, receiver) {
      if (prop === UNWRAP) return target;

      if (prop === 'hexGrid') {
        return createHexGridProxy(target.hexGrid, ownPlayer, aiName, seen);
      }

      if (prop === 'players') {
        const players = Reflect.get(target, prop, receiver);
        if (Array.isArray(players)) return players.map(wrapPlayer);
        return players;
      }

      if (prop === 'entities') {
        const entities = Reflect.get(target, prop, receiver);
        if (Array.isArray(entities)) {
          const filtered = entities.filter(e => {
            if (!e || e.destroyed) return false;
            const ownerId = e.ownerId ?? e.owner?.id;
            if (ownerId === ownPlayerId) return true;
            return isVisibleToPlayer(ownPlayer, e.q, e.r);
          });
          return deepWrap(filtered, aiName, seen, ownPlayer);
        }
        return deepWrap(entities, aiName, seen, ownPlayer);
      }

      // Gap 2: Mask getEntityAt for non-visible cells
      if (prop === 'getEntityAt') {
        return (q, r) => {
          if (!isVisibleToPlayer(ownPlayer, q, r)) return null;
          const entity = target.getEntityAt(q, r);
          return entity ? deepWrap(entity, aiName, seen, ownPlayer) : null;
        };
      }

      // Gap 2: Mask getEntityById for non-visible foreign entities
      if (prop === 'getEntityById') {
        return (id) => {
          const entity = target.getEntityById ? target.getEntityById(id) : target.entities?.find(e => e.id === id);
          if (!entity) return null;
          const ownerId = entity.ownerId ?? entity.owner?.id;
          if (ownerId !== ownPlayerId && !isVisibleToPlayer(ownPlayer, entity.q, entity.r)) {
            return null;
          }
          return deepWrap(entity, aiName, seen, ownPlayer);
        };
      }

      // Gap 3: Chat history privacy
      if (prop === 'getChatHistory') {
        return (p1, p2) => {
          const u1 = unwrap(p1);
          const u2 = unwrap(p2);
          if (u1?.id !== ownPlayerId && u2?.id !== ownPlayerId) {
            return [];
          }
          const hist = target.getChatHistory(u1, u2) || [];
          return deepWrap(hist, aiName, seen, ownPlayer);
        };
      }

      if (prop === 'chatHistory') {
        // chatHistory is an object keyed by "id1:id2" (sorted), not an array.
        // Keep only chats involving the AI's player.
        const hist = target.chatHistory || {};
        const filtered = {};
        for (const [key, msgs] of Object.entries(hist)) {
          if (key.split(':').includes(String(ownPlayerId))) {
            filtered[key] = msgs;
          }
        }
        return deepWrap(filtered, aiName, seen, ownPlayer);
      }

      // Reflect.get with receiver can throw for built-in accessors (e.g. Set.prototype.size
      // when target is a Set): the getter runs with `this` = proxy, which lacks the internal slots.
      // Fall back to target-bound lookup in that case.
      let value;
      try {
        value = Reflect.get(target, prop, receiver);
      } catch (e) {
        value = Reflect.get(target, prop);
      }
      if (typeof value === 'function') {
        return wrapFunction(value, target, aiName, seen, ownPlayer);
      }
      if (value !== null && typeof value === 'object') {
        return deepWrap(value, aiName, seen, ownPlayer);
      }
      return value;
    },
    set(target, prop) {
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
    has(target, prop) {
      if (prop === UNWRAP) return true;
      return Reflect.has(target, prop);
    },
  });
}

/**
 * Create the player proxy for the AI's own player.
 * Full read access, blocks direct writes.
 */
export function createPlayerProxy(player, aiName, seen = new WeakMap()) {
  return deepWrap(player, aiName, seen, player);
}

/**
 * Creates helper proxy to prevent commanding entities of other players (Gap 4).
 */
function createHelperProxy(helper, ownPlayer, aiName) {
  return new Proxy(helper, {
    get(target, prop, receiver) {
      if (prop === UNWRAP) return target;

      const val = Reflect.get(target, prop, receiver);
      if (typeof val === 'function') {
        return function (...args) {
          if (['attack', 'build', 'support', 'explore'].includes(prop)) {
            const sourceEntity = unwrap(args[1]);
            if (sourceEntity && sourceEntity.owner && sourceEntity.owner.id !== ownPlayer.id) {
              throw new Error(
                `[AI Interface] Illegal action: AI '${aiName}' cannot command entity '${sourceEntity.name}' owned by another player.`
              );
            }
          }
          if (prop === 'moveAlongPath') {
            const player = unwrap(args[0]);
            const unit = unwrap(args[1]);
            if ((player && player.id !== ownPlayer.id) || (unit && unit.owner && unit.owner.id !== ownPlayer.id)) {
              throw new Error(
                `[AI Interface] Illegal action: AI '${aiName}' cannot move entity owned by another player.`
              );
            }
          }
          const realArgs = args.map(unwrap);
          return val.apply(target, realArgs);
        };
      }
      return val;
    },
    set(target, prop) {
      throw new Error(
        `[AI Interface] Illegal write: AI '${aiName}' attempted to set '${String(prop)}' on helper.`
      );
    },
    deleteProperty(target, prop) {
      throw new Error(
        `[AI Interface] Illegal delete: AI '${aiName}' attempted to delete '${String(prop)}' on helper.`
      );
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter(k => k !== UNWRAP);
    },
    has(target, prop) {
      if (prop === UNWRAP) return true;
      return Reflect.has(target, prop);
    },
  });
}

/**
 * Construct an AI manager with proxied player/gameState/helper.
 *
 * This is the ONLY entry point the game engine uses to create AI controllers.
 * It wraps player, gameState, and helper before handing them to the manager.
 * AI code in src/ai/ must never import this module.
 *
 * @param {Function} ManagerClass - The AI controller class (extends BaseManager)
 * @param {Object} player - The real player object
 * @param {Object} helper - The AiHelper instance
 * @returns {Object} The constructed manager with proxied player/gameState
 */
export function createAiManager(ManagerClass, player, helper) {
  const aiName = player.name || `player-${player.id}`;
  // Shared seen-cache across the whole proxy tree: the same real object always
  // maps to the same proxy. This makes identity comparison (===) work
  // transparently — e.g. unit.owner === this.player is true when they wrap
  // the same underlying player.
  const seen = new WeakMap();
  const proxiedPlayer = createPlayerProxy(player, aiName, seen);
  const proxiedGameState = createGameStateProxy(helper.getGameState(), player, aiName, seen);
  const proxiedHelper = createHelperProxy(helper, player, aiName);

  const manager = new ManagerClass(proxiedPlayer, proxiedHelper);
  manager.gameState = proxiedGameState;
  return manager;
}