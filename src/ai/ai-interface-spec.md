# AI Interface Spec

## Overview

Defines what a game AI can read and write. Enforced via JS Proxy wrappers around the underlying game objects. AIs interact with the wrapped interface; the game engine keeps the real objects.

AIs MAY use `aiHelper` for convenience (filtered info, multi-step actions), but are not required to. All legality enforcement lives in the entities' `action.Do()` methods, which validate costs, orders, action points, terrain, etc.

## Definitions

- **Visible entities**: entities on visible cells = union of `player.getOpponents()` and `player.getEntities()`.  
- **Explored cells**: returned by `player.exploredCells`.  
- **Own player**: the player object the AI is acting for.

## READ-ONLY

1. **All players**: names, scores, description.  
2. **Own player object**: FULL info, including resources, history, orders, score.  
3. **Visible entities**: FULL info on any entity returned by the visible-entity union above (own + opponents' visible entities).  
4. **Explored cells**: terrain and resource info for explored cells.  
5. **Config and game settings**: FULL config (entities, resources, terrains, game settings, etc.).  
6. **Chat history**: FULL history for any chat the AI's player was involved in.

## NOT VISIBLE (Returns `undefined` or empty collection)

- Other players' resources, history, orders.  
- Entities on non-visible cells.  
- Terrain/resource info on unexplored cells.  
- Chat history for chats the AI's player was not involved in.

## WRITE (allowed mutations)

1. **`action.Do()` on any owned entity.** The action methods enforce all legality (resource costs, order costs, action points, terrain validity, range, etc.).  
2. **Write to own player history.** (`player.addHistoryEntry()`) (e.g. logging decisions, diplomacy notes)  
3. **Chat.** Send chat messages via `aiHelper.chat()` (manages order deduction and game chat rules).

## NOT ALLOWED (proxy throws Error on attempt)

- Direct mutation of any game state (entity health/position, player resources, orders, etc.) outside the WRITE paths above.  
- Calling `action.Do()` on entities not owned by the AI's player.

## Implementation details

- JS Proxy wraps underlying objects dynamically (`src/ai/interfaceProxy.js`).
- Wrapping is lazy on property access.
- `Symbol.for('aiInterfaceUnwrap')` allows engine code and `AiHelper` to unwrap proxy arguments cleanly without changing `Entity` action code.
- `BaseManager` wraps `gameState`, `player`, and `helper` in its constructor before handing them to AI subclasses (`SmartManager`, `AdaptiveManager`, `JsonHarness`, `MenuHarness`).
- `AiHelper.chat()` manages diplomatic conversations, order deduction, and player history logging. AI private cooldown tracking (e.g. `_chatCooldownOrders`) is maintained on the harness instance rather than mutating `player`.
