# Hybrid AI Directive Spec

## Overview

The hybrid AI splits responsibilities:

- **Tactical AI** (e.g. `tacticalAI.js`): executes orders every turn — moves units, builds structures, engages in combat. Runs standalone; playable without any LLM.  
- **LLM Director** (optional): sets high-level directives once per turn (or less often). Handles diplomacy (chat). If no directives are set, the tactical AI plays with defaults.

The tactical AI reads directives at the start of each turn via `AiHelper`. Directives are advisory — the tactical AI interprets them but always respects game rules (orders, AP, validity).

## Directive Object

Set on the player object (e.g. `player.controller.directive`) or passed via `AiHelper`. The tactical AI reads it each turn. All fields optional; missing fields use defaults.

```js
{
  focus: "balanced",           // see Focus
  stance: {                    // see Stance, keyed by player ID
    2: "defensive",
    3: "neutral"
  },
  goals: [                     // see Goals, ordered by priority
    { type: "reinforce", target: { q: 10, r: -5 } },
    { type: "explore", direction: "NE" }
  ]
}
```

## Focus

Controls resource allocation priority across the three score pillars. The tactical AI biases its build/move choices accordingly.

| Value | Meaning |
| :---- | :---- |
| `economy` | Prioritize economic score (e.g. workers, mines, lumberMills, farms). Build military only for defense. |
| `military` | Prioritize military score (e.g. swordsmen, bowmen, towers). Maintain minimal economy to sustain production. |
| `exploration` | Prioritize exploration score and build units as needed (e.g. scouts), moving units into unexplored territory. |
| `balanced` | **(default)** Even split across all three. |

## Stance

Per-opponent behavior. Keyed by player ID. Default for any opponent not listed: `"neutral"`.

If no directives are set at all, all opponents default to `"neutral"` — the AI treats everyone as a potential threat but doesn't seek conflict — unless the tactical AI chooses its own stances (see Defaults).

| Value | Meaning |
| :---- | :---- |
| `offensive` | Actively seek and engage this opponent's units and structures. Move into their territory. Prioritize attacks on them over other targets. |
| `defensive` | Engage if their units come within threat range, but do not enter their territory. Fortify borders. |
| `caution` | Actively avoid their units. Retreat if approached. Defend only if attacked. |
| `neutral` | **(default)** Don't move or build too close to their structures, but move freely around their units. No special targeting. |
| `friendly` | Move and build anywhere near their units and structures. Never target them. |
| `ally` | Actively defend their units and structures. Position units to intercept threats to them. Never target them. |

### Stance vs Diplomacy

The LLM handles diplomacy (chat). When the LLM negotiates a stance change (e.g. agrees to a non-aggression pact), it sets `stance[playerId]` accordingly. The tactical AI obeys the stance — it will not attack a `friendly` or `ally` opponent even if tactically advantageous.

If the LLM and tactical AI disagree (LLM says `friendly`, but the opponent attacks), the tactical AI defends itself but does not escalate beyond `defensive` behavior until the LLM updates the stance. The LLM is the source of truth for intent; the tactical AI handles execution.

## Goals

Ordered list of objectives. The tactical AI works through them by priority, allocating orders to each in turn. A goal is "complete" when its condition is met, then the AI moves to the next.

```js
{ type: "reinforce", target: { q: 10, r: -5 } | { entityId: "swordsman_1_abc" } }
```

Move combat units toward the target area or entity. If an entity ID is given, escort/defend that entity. Complete when sufficient force is in position (tactical AI decides what "sufficient" means based on threat assessment).

```js
{ type: "explore", direction: "NE" | { q: 10, r: -5 } }
```

Send scouts/fast units in the given direction (compass direction from the player's start position) or toward the target area. Complete when the area is explored or no unexplored cells remain in that direction.

```js
{ type: "buildEconomy", direction: "NE" | { q: 10, r: -5 } }
```

Favor building economy structures (mine, lumberMill, farm, etc.) in the target area or in the given direction from the player's start. The tactical AI still respects build validity and resource constraints.

```js
{ type: "buildMilitary", direction: "NE" | { q: 10, r: -5 } }
```

Same as above, but for military structures (tower, forge, etc.) and unit production.

## Defaults (No LLM)

When no directive is set:

```js
{
  focus: "balanced",
  stance: {},  // all opponents "neutral"
  goals: []    // no goals; AI plays reactively
}
```

The AI expands economically, defends its territory, explores opportunistically, and treats all opponents as neutral (doesn't seek fights, doesn't avoid them either).

**Internal stance/focus.** Only when no directive is provided, a tactical AI may choose its own per-opponent stances and focus each turn from the game state (e.g. relative strength, who attacked it, proximity). When a directive is provided, the tactical AI must obey it and never substitute its own stances or focus.

## Implementation Notes

- The tactical AI is constructed as `new TacticalAI(player, aiHelper)` (or other classname) and is a subclass of baseManager. It reads `player.controller.directive` (or equivalent) at the start of each `processTurn()`.  
- The `AiHelper` provides all game interactions: `helper.build(...)`, `helper.attack(...)`, `helper.move(...)`, `helper.findBuildCandidates(...)`, etc. The tactical AI never imports game code directly.
- Directives are read fresh each turn — the LLM can update them mid-game.  
- The tactical AI must always respect hard constraints: orders available, AP, build validity, movement rules. Directives influence *choices*, never *legality*.  
- Suggested file: `src/ai/tactical/<className>.js` - e.g. leonaAi.js, deepseekAi.js
