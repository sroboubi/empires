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
7. **Own trade agreements**: `gameState.getActiveTradesForPlayer(player)` and `gameState.trades`, filtered to agreements involving the AI's player.

## NOT VISIBLE (Returns `undefined` or empty collection)

- Other players' resources, history, orders.  
- Entities on non-visible cells.  
- Terrain/resource info on unexplored cells.  
- Chat history for chats the AI's player was not involved in.

## WRITE (allowed mutations)

1. **`action.Do()` on any owned entity.** The action methods enforce all legality (resource costs, order costs, action points, terrain validity, range, etc.).  
2. **Write to own player history.** (`player.addHistoryEntry()`) (e.g. logging decisions, diplomacy notes)  
3. **Chat.** Send chat messages via `aiHelper.chat()` (manages order deduction and game chat rules).
4. **Cancel own per-turn trade agreements.** `gameState.cancelTrade(tradeId)` cancels an active agreement only when the AI's player is a participant; the canceler is always the AI's player. `BaseManager.reviewTrades()` (called at the start of the AI's turn) applies the default policy: cancel a per-turn deal the AI can no longer afford.
5. **Initiate a trade (trade-capable AIs only).** `helper.initiateTrade(this.player, target, offer)` validates the offer (distinct participants, non-empty positive bundles, one-time affordability), then either asks another AI's manager to evaluate it or opens the human trade UI and waits for the decision. Only the LLM managers (`LlmBaseManager` / `maybeInitiateTrade`) initiate; standard and tactical AIs do not implement the initiator hook and only respond to offers.

## NOT ALLOWED (proxy throws Error on attempt)

- Direct mutation of any game state (entity health/position, player resources, orders, etc.) outside the WRITE paths above.  
- Calling `action.Do()` on entities not owned by the AI's player.

## Implementation details

- JS Proxy wraps underlying objects dynamically (`src/aiInterfaceProxy.js`, outside `src/ai/` so AI code has zero dependency on it).
- Wrapping is lazy on property access.
- Module-local `Symbol('aiInterfaceUnwrap')` (never exported) allows the proxy to unwrap arguments before calling real engine methods. AI code cannot reference or forge it.
- The game constructs AI managers via `createAiManager(ManagerClass, player, helper)` (called from `player.js`), which wraps player/gameState before handing them to the manager. `BaseManager` itself never imports the proxy.
- `AiHelper.chat()` manages diplomatic conversations, order deduction, and player history logging. AI private cooldown tracking (e.g. `_chatCooldownOrders`) is maintained on the harness instance rather than mutating `player`.
- `AiHelper.formatResourceBundle(bundle)` formats resource-bundle maps for prompts/logs. **AI code in `src/ai/` must never import engine modules** (`gameState.js`, `utils.js`, etc.); everything it needs is reached through the injected `player`, `gameState`, and `helper` proxies.
- Trade initiation is an LLM-manager capability. `Player.step()` calls `maybeInitiateTrade()` only when the manager defines it, so standard (`SmartManager`) and tactical managers never initiate; they inherit `BaseManager.handleTradeOffer()`, which rejects offers. Human-initiated offers to a standard/tactical AI are rejected the same way.

## Proxy identity semantics (for AI implementors)

- The proxy uses a shared identity cache: the **same underlying object always maps to the same proxy instance** within an AI's turn. This means `===` / `!==` work as expected — e.g. `unit.owner === this.player` is true when they wrap the same player.
- However, **prefer comparing IDs** (`unit.owner?.id === player.id`) over object identity. It's more robust and clearer about intent. ID comparison always works regardless of proxy internals.
- Never store a proxy reference and expect it to `===` a proxy obtained from a different AI's turn — each `createAiManager` call gets a fresh cache.

## Array methods on proxied arrays (for AI implementors)

Arrays you get from the proxy (e.g. `player.getEntities().filter(...)`) are views over engine state, not the engine arrays themselves. Read-only methods work exactly as in plain JS. Mutating methods do **not** work in place:

- `sort`, `reverse`, `fill`, `copyWithin` run on a copy and return the modified copy — the array you hold is unchanged. You **MUST** capture the return value: `arr = arr.sort(cmp)`. A bare `arr.sort(cmp)` statement is a silent no-op.
- `push`, `pop`, `shift`, `unshift`, `splice` likewise run on a copy, but they return something else (a length, the removed element), so they are effectively unusable in place on a proxied array. Do not use them to mutate; build a new array instead (e.g. `[...arr, x]`).
- `filter`, `map`, `slice`, `find`, `forEach`, `reduce`, etc. return new values and work normally.
- `includes`, `indexOf`, `lastIndexOf` compare by proxy identity (the same entity is always the same proxy within your turn), so they **do** match wrapped elements — `arr.includes(arr[0])` is true.