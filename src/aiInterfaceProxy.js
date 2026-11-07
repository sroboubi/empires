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
 * Shared proxy guards (P1). Every proxy handler gets:
 * - getOwnPropertyDescriptor: re-wraps the value exactly as `get` would, so
 *   Object.getOwnPropertyDescriptor(proxy, 'x').value can't reach the raw object.
 * - defineProperty / setPrototypeOf / preventExtensions: throw.
 * Call with a getter for the proxy itself (assigned after construction).
 */
function addProxyGuards(handler, getProxy, aiName, label) {
  handler.getOwnPropertyDescriptor = function (target, prop) {
    if (prop === UNWRAP) return undefined;
    const desc = Reflect.getOwnPropertyDescriptor(target, prop);
    if (!desc || !('value' in desc)) return desc;
    return { ...desc, value: handler.get(target, prop, getProxy()) };
  };
  handler.defineProperty = function (target, prop) {
    throw new Error(
      `[AI Interface] Illegal defineProperty: AI '${aiName}' attempted to define '${String(prop)}' on ${label}.`
    );
  };
  handler.setPrototypeOf = function () {
    throw new Error(
      `[AI Interface] Illegal setPrototypeOf: AI '${aiName}' attempted to change the prototype of ${label}.`
    );
  };
  handler.preventExtensions = function () {
    throw new Error(
      `[AI Interface] Illegal preventExtensions: AI '${aiName}' attempted to freeze ${label}.`
    );
  };
  return handler;
}

/**
 * P2 — method allowlist. A blanket forward let ANY engine method run with
 * raw `this` (player.addResources, gs.spawnEntity, gs.serialize,
 * entity.destroy...). Only these methods may be called through a proxy;
 * everything else reads as `undefined`.
 * Types are duck-typed (no imports — player.js imports this module).
 */
const PLAYER_METHODS = new Set([
  'getEntities', 'getOpponents', 'isExplored', 'isVisible', 'hasResources',
  'hasOrders', 'getResourceProfile', 'getHistory', 'getHistoryRange',
  'addHistoryEntry',
]);
const GAMESTATE_METHODS = new Set([
  'getEntityAt', 'getEntityById', 'getChatHistory', 'getChatKey',
]);
const ENTITY_METHODS = new Set([
  'getActions', 'canStandOn', 'getMovementCost', 'getCostToMaintain',
  'getCostToSpawn', 'getOrdersRequired', 'info', 'canYield',
]);
const MAP_READ_METHODS = new Set(['get', 'has', 'keys', 'values', 'entries', 'forEach']);
const SET_READ_METHODS = new Set(['has', 'keys', 'values', 'entries', 'forEach']);
const HELPER_METHODS = new Set([
  'distance', 'getNeighbors', 'getCellsArray', 'getCell', 'getCellCount',
  'directionTo', 'movementCostTo', 'getSightAndTrajectory', 'getConfig',
  'calculateAttackMultiplier', 'camelToTitle', 'aiLog', 'findReachableCells',
  'findBuildCandidates', 'isBuilder', 'isRepairer', 'isCombatCapable',
  'isMobile', 'getCombatPower', 'combatEffectiveness', 'isDedicatedMilitary',
  'isMilitary', 'getEntitiesByCapability', 'getEntitiesSortedByPower',
  'getEntitiesSortedByEffectiveness', 'findClosestEntity',
  'findPathTowardsUnexplored', 'findWalkablePath', 'selectCandidateCombatUnits',
  'attack', 'build', 'support', 'explore', 'moveAlongPath', 'chat',
  'onActionDone',
]);

function isEntityObject(obj) {
  return obj !== null && typeof obj === 'object' &&
    typeof obj.getActions === 'function' &&
    typeof obj.health === 'number' && 'cell' in obj;
}

function isGameStateObject(obj) {
  return obj !== null && typeof obj === 'object' &&
    Array.isArray(obj.entities) && Array.isArray(obj.players) &&
    obj.hexGrid !== undefined && typeof obj.getEntityAt === 'function';
}

function isHelperObject(obj) {
  return obj !== null && typeof obj === 'object' &&
    typeof obj.attack === 'function' && typeof obj.build === 'function' &&
    'gameState' in obj;
}

/**
 * Returns true if `prop` may be called as a method on `obj` through a proxy.
 * Plain data objects (manifest entries, config, cells) allow all methods;
 * engine objects (Player, GameState, Entity, AiHelper, Map, Set) are allowlisted.
 */
function isAllowedMethod(obj, prop) {
  if (obj instanceof Map) return MAP_READ_METHODS.has(prop);
  if (obj instanceof Set) return SET_READ_METHODS.has(prop);
  if (isPlayerObject(obj)) return PLAYER_METHODS.has(prop);
  if (isGameStateObject(obj)) return GAMESTATE_METHODS.has(prop);
  if (isEntityObject(obj)) return ENTITY_METHODS.has(prop);
  if (isHelperObject(obj)) return HELPER_METHODS.has(prop);
  return true;
}

/**
 * Duck-type check for Player objects. We can't import Player here
 * (player.js imports this module — would be a cycle), so we check for
 * the distinctive combination of player-only properties.
 */
function isPlayerObject(obj) {
  return obj !== null && typeof obj === 'object' &&
    typeof obj.id === 'number' &&
    obj.resources !== undefined && typeof obj.resources === 'object' &&
    obj.orders !== undefined &&
    typeof obj.getEntities === 'function';
}

/**
 * Wrap an entity's actions with the ownership guard: calling .do() on an
 * action of a foreign-owned entity throws. Shared by the getActions() and
 * .actions property interceptions.
 */
function wrapActionsWithOwnership(actions, entityTarget, entityName, aiName, seen, ownPlayer) {
  const isOwned = !ownPlayer || (entityTarget.ownerId ?? entityTarget.owner?.id) === ownPlayer.id;
  return actions.map(action => {
    const wrappedAction = deepWrap(action, aiName, seen, ownPlayer);
    if (!isOwned) {
      return new Proxy(wrappedAction, {
        get(actTarget, actProp) {
          if (actProp === 'do') {
            return () => {
              throw new Error(
                `[AI Interface] Illegal action: AI '${aiName}' attempted to execute action '${action.name}' on entity '${entityName}' owned by another player.`
              );
            };
          }
          return Reflect.get(actTarget, actProp);
        }
      });
    }
    return wrappedAction;
  });
}

/**
 * Wrap a function so that:
 * - Arguments from the AI are unwrapped to real objects before the call.
 * - Return values are wrapped before going back to the AI.
 * Returns undefined for methods not on the allowlist (P2).
 */
function wrapFunction(fn, target, aiName, seen, ownPlayer = null, propName = null) {
  if (propName && !isAllowedMethod(target, propName)) {
    return undefined;
  }
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

  const handler = addProxyGuards({
    get(target, prop, receiver) {
      if (prop === UNWRAP) return target;

      // P4: back-references must return the filtered proxies, never a plain
      // deepWrap of the raw gameState/helper.
      if (prop === 'gameState' && ownPlayer) {
        const gs = target.gameState;
        if (gs && seen.has(gs)) return seen.get(gs);
      }
      if (prop === 'aiHelper' && ownPlayer) {
        const h = target.aiHelper;
        if (h && seen.has(h)) return seen.get(h);
      }

      // Gap 1: Fog-of-war on cell terrain and resources
      if (isCell && ownPlayer && (prop === 'terrain' || prop === 'resource' || prop === 'resources')) {
        if (!isExploredByPlayer(ownPlayer, target.q, target.r)) {
          return undefined;
        }
      }

      // Gap 4: Enforce action ownership when getActions() is called
      if (prop === 'getActions' && typeof target.getActions === 'function') {
        return () => {
          const actions = target.getActions();
          return wrapActionsWithOwnership(actions, target, target.name, aiName, seen, ownPlayer);
        };
      }

      // Gap 4 (continued): entity.actions is the same array getActions() returns,
      // so intercept the property too — otherwise enemyUnit.actions[0].do() bypasses the guard.
      if (prop === 'actions' && Array.isArray(target.actions)) {
        return wrapActionsWithOwnership(target.actions, target, target.name, aiName, seen, ownPlayer);
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
        // P3: array methods must not hand callbacks raw elements. Read-only
        // iteration runs with `this` = the proxy (elements come through the
        // get trap, already wrapped). Mutating methods (sort/splice/...) run
        // on a copy of wrapped elements — the AI works with a view, so its
        // sort must not reorder the real array, and callbacks still get
        // wrapped elements.
        if (Array.isArray(target)) {
          const READ_ONLY = new Set(['forEach', 'map', 'filter', 'find', 'findIndex',
            'findLast', 'findLastIndex', 'some', 'every', 'reduce', 'reduceRight',
            'includes', 'indexOf', 'lastIndexOf', 'slice', 'concat', 'join',
            'keys', 'values', 'entries', 'at', 'toString', 'toLocaleString',
            'flat', 'flatMap']);
          if (READ_ONLY.has(prop)) {
            return function (...args) {
              const realArgs = args.map(unwrap);
              const result = Reflect.apply(value, receiver, realArgs);
              return deepWrap(result, aiName, seen, ownPlayer);
            };
          }
          return function (...args) {
            const realArgs = args.map(unwrap);
            const copy = [];
            for (let i = 0; i < target.length; i++) {
              copy.push(deepWrap(target[i], aiName, seen, ownPlayer));
            }
            const result = Reflect.apply(value, copy, realArgs);
            return deepWrap(result, aiName, seen, ownPlayer);
          };
        }
        return wrapFunction(value, target, aiName, seen, ownPlayer, prop);
      }
      if (value !== null && typeof value === 'object') {
        // Opponent players reached via any path (e.g. entity.owner) get the
        // restricted proxy, not full read access.
        if (ownPlayer && isPlayerObject(value) && value.id !== ownPlayer.id) {
          return createOtherPlayerProxy(value, aiName, seen);
        }
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
  }, () => proxy, aiName, 'object');

  const proxy = new Proxy(obj, handler);

  seen.set(obj, proxy);
  return proxy;
}

/**
 * Create a read-only proxy for an opponent player.
 * Gap 5: Returns undefined on hidden properties instead of throwing error.
 */
function createOtherPlayerProxy(player, aiName, seen = new WeakMap()) {
  if (seen.has(player)) return seen.get(player);
  let proxy;
  const handler = addProxyGuards({
    get(target, prop, receiver) {
      return otherPlayerGet(target, prop, receiver, aiName, seen);
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
  }, () => proxy, aiName, 'other player');
  proxy = new Proxy(player, handler);
  seen.set(player, proxy);
  return proxy;
}

// Shared get logic for the other-player proxy, used by both the get trap
// and the getOwnPropertyDescriptor trap so they can't disagree.
function otherPlayerGet(target, prop, receiver, aiName, seen) {
  if (prop === UNWRAP) return target;
  if (prop === 'name' || prop === 'description' ||
    prop === 'id' || prop === 'color' || prop === 'isAI') {
    return Reflect.get(target, prop, receiver);
  }
  if (prop === 'score') {
    const score = Reflect.get(target, prop, receiver);
    return score ? deepWrap(score, aiName, seen, null) : score;
  }
  if (HIDDEN_PLAYER_PROPS.has(prop)) {
    return undefined;
  }
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
}

/**
 * Proxy for HexGrid enforcing Gap 1 (unexplored cell masking).
 */
function createHexGridProxy(hexGrid, ownPlayer, aiName, seen) {
  // P9: build the proxy once and cache it in `seen` — a fresh proxy on
  // every access broke `gs.hexGrid === gs.hexGrid`.
  if (seen.has(hexGrid)) return seen.get(hexGrid);
  let proxy;
  const handler = addProxyGuards({
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
          // Consistent with helper.getNeighbors (Shahin, 2026-11-06): return
          // ALL neighbours, each deepWrapped — the cell mask hides
          // terrain/resource on unexplored cells, coordinates stay visible.
          // Filtering to explored-only contradicted the helper path. The
          // engine algorithms running on the filtered gameState (P8) only
          // read n.resource here, which the mask hides on unexplored cells.
          return (neighbors || []).map(c => deepWrap(c, aiName, seen, ownPlayer));
        };
      }

      if (prop === 'getCellsArray') {
        return () => {
          const cells = target.getCellsArray ? target.getCellsArray() : [];
          // Consistent with helper.getCellsArray (Shahin, 2026-11-06): ALL
          // cells, masked — filtering to explored-only contradicted the
          // helper path and hid coordinates the spec leaves visible (the
          // map shape is known from config). No engine consumer calls the
          // proxied grid's getCellsArray (helpers use the raw grid).
          return cells.map(c => deepWrap(c, aiName, seen, ownPlayer));
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
        return wrapFunction(value, target, aiName, seen, ownPlayer, prop);
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
  }, () => proxy, aiName, 'hexGrid');
  proxy = new Proxy(hexGrid, handler);
  seen.set(hexGrid, proxy);
  return proxy;
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
      : createOtherPlayerProxy(p, aiName, seen);
    playerCache.set(p.id, wrapped);
    return wrapped;
  }

  let proxy;
  const handler = addProxyGuards({
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
        return wrapFunction(value, target, aiName, seen, ownPlayer, prop);
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
  }, () => proxy, aiName, 'gameState');
  proxy = new Proxy(gameState, handler);
  return proxy;
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
 * helper.gameState / helper.getGameState() return the filtered gameState proxy
 * (not the raw game state, not a plain deepWrap which would skip visibility filtering).
 * All other return values are deep-wrapped.
 */
function createHelperProxy(helper, ownPlayer, aiName, seen = new WeakMap(), proxiedGameState = null) {
  let proxy;
  const handler = addProxyGuards({
    get(target, prop, receiver) {
      if (prop === UNWRAP) return target;

      // Never leak the raw gameState — hand back the filtered proxy instead.
      if ((prop === 'gameState' || prop === 'getGameState') && proxiedGameState) {
        if (prop === 'gameState') return proxiedGameState;
        return () => proxiedGameState;
      }

      // P7: helper cell methods read the raw grid. getCell routes through
      // the filtered hexGrid proxy (undefined for unexplored, per spec).
      // getCellsArray/getNeighbors return ALL cells, each deepWrapped — the
      // cell mask hides terrain/resource on unexplored cells, but the
      // coordinates stay visible (the map shape is known from config, and
      // adaptiveManager needs unexplored coordinates for exploration).
      // Filtering them out entirely broke exploration (it could no longer
      // tell whether unexplored cells exist).
      if (prop === 'getCell' && proxiedGameState) {
        const hg = proxiedGameState.hexGrid;
        if (hg && typeof hg.getCell === 'function') return hg.getCell.bind(hg);
      }

      const val = Reflect.get(target, prop, receiver);
      if (typeof val === 'function') {
        // P2: only allowlisted helper methods are callable. createEntity
        // and applyResourceYieldBonus are engine-internal.
        if (!HELPER_METHODS.has(prop)) return undefined;
        return function (...args) {
          if (['attack', 'build', 'support', 'explore'].includes(prop)) {
            const sourceEntity = unwrap(args[1]);
            // P6: a missing owner counts as not-owned (barbarians are
            // ownerless) — the old check passed them through.
            const ownerId = sourceEntity ? (sourceEntity.owner?.id ?? sourceEntity.ownerId) : undefined;
            if (sourceEntity && ownerId !== ownPlayer.id) {
              throw new Error(
                `[AI Interface] Illegal action: AI '${aiName}' cannot command entity '${sourceEntity.name}' owned by another player.`
              );
            }
          }
          if (prop === 'moveAlongPath') {
            const player = unwrap(args[0]);
            const unit = unwrap(args[1]);
            const unitOwnerId = unit ? (unit.owner?.id ?? unit.ownerId) : undefined;
            if ((player && player.id !== ownPlayer.id) || (unit && unitOwnerId !== ownPlayer.id)) {
              throw new Error(
                `[AI Interface] Illegal action: AI '${aiName}' cannot move entity owned by another player.`
              );
            }
          }
          // P5: chat must be initiated as yourself — an AI can't spend
          // another player's orders or speak as them.
          if (prop === 'chat') {
            const initiator = unwrap(args[0]);
            if (initiator && initiator.id !== ownPlayer.id) {
              throw new Error(
                `[AI Interface] Illegal chat: AI '${aiName}' cannot chat as another player.`
              );
            }
          }
          // P8: hand the helper the caller's FILTERED gameState, not the raw
          // one, so its algorithms (build candidates, paths, reachability)
          // only see what the AI can see. The helper methods only use
          // getEntityAt/entities/manifestData/hexGrid on this argument, all
          // of which the gameState proxy filters.
          const realArgs = args.map(a => {
            const u = unwrap(a);
            if (u === target.gameState && proxiedGameState) return proxiedGameState;
            return u;
          });
          return deepWrap(val.apply(target, realArgs), aiName, seen, ownPlayer);
        };
      }
      if (val !== null && typeof val === 'object') {
        return deepWrap(val, aiName, seen, ownPlayer);
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
  }, () => proxy, aiName, 'helper');
  proxy = new Proxy(helper, handler);
  return proxy;
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
  const rawGameState = helper.getGameState();
  const proxiedGameState = createGameStateProxy(rawGameState, player, aiName, seen);
  const proxiedHelper = createHelperProxy(helper, player, aiName, seen, proxiedGameState);
  // P4: register the filtered gameState/helper proxies in `seen` so any
  // back-reference (player.gameState, entity.gameState, gs.aiHelper)
  // resolves to the filtered proxy instead of a plain deepWrap of the raw object.
  seen.set(rawGameState, proxiedGameState);
  seen.set(helper, proxiedHelper);

  const manager = new ManagerClass(proxiedPlayer, proxiedHelper);
  manager.gameState = proxiedGameState;
  return manager;
}