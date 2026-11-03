# Adaptive AI Manager — Manual Test Plan

This plan is for a human tester. It exercises `src/ai/tactical/adaptiveManager.js`
through the browser game. Do not run it as an automated suite; observe the
console output and the visible game state.

## Prerequisites

1. Serve the repo with the normal local web server used for the game and open
   the game in a Chromium-based browser.
2. Open DevTools → Console and enable **Verbose** output. The AI uses
   `console.debug` with `[AI <player>][<category>]` prefixes.
3. In the setup modal, the **Controller** dropdown is generated from
   `definitions/ai.json`. After this change it must include **adaptive**.
4. Give the AI player a leader from `definitions/leaders.json` (Anselm or Yrsa),
   because the setup UI requires a leader for AI players.
5. Keep barbarians disabled for the first smoke test.

Optional directive override for tests 4–8: temporarily edit the `adaptive`
entry in `definitions/ai.json`, for example:

```json
"adaptive": {
  "url": "./ai/tactical/adaptiveManager.js",
  "config": {
    "directive": {
      "focus": "military",
      "stance": { "3": "offensive" },
      "goals": [ { "type": "explore", "direction": "NE" } ]
    }
  }
}
```

Player IDs come from the setup modal. In the default settings, player 1 is the
human and players 2/3 are AI. Stance keys are the **opponent** player IDs.
Reload the page after editing `ai.json`.

---

## Test 1 — Balanced smoke test

**Setup**

- Map size: 16 (smaller is faster).
- Player 1: Human.
- Player 2: Anselm, controller **adaptive**.
- Barbarians: off.
- Win conditions: off (or very high absolute score).
- Starting resources/units: defaults.

**Observe**

- Console contains `[turn] Adaptive turn start ... Focus: balanced ...`.
- The AI spends orders and takes actions; the turn ends with
  `[turn] Adaptive turn ended | Remaining orders: ...`.
- Builds, moves, and exploration are logged with `#id`, owning player, and
  source/target coordinates.
- No uncaught exception or repeated turn loop.

**Pass criteria**

- The AI reaches the end of its turn without console errors.
- It does not idle while it has orders and affordable/valid actions.
- It builds at least one economy/expansion entity and explores at least one
  unexplored area over several rounds.

---

## Test 2 — Production dependency chain (no worker)

**Setup**

- Player 2: adaptive.
- Starting units: **settler only** (remove worker and swordsman in the setup
  modal, if exposed; otherwise temporarily edit
  `definitions/defaultSettings.json`).
- Starting resources: defaults.
- Barbarians: off.

**Observe**

- The AI should first build a **village** with the settler (the settler is
  consumed because its `buildCharges` is 1).
- Then the village should produce a **worker**.
- Then the worker should build an economic producer (farm/camp/mine/lumberMill/
  forge) based on resource needs.
- Relevant logs:
  - `[build] Build decision ... Target: Village ...`
  - `[build] Build decision ... Target: Worker ... Reason: resolve ...`
  - `[build] Build decision ... Target: Farm/Camp/...`

**Pass criteria**

- The AI does not claim it is stuck while a valid chain exists.
- It builds exactly one step per action and re-evaluates after each spawn.
- It does not build both competing producers for the same deficit; it commits
  to the best available step and then reassesses.

---

## Test 3 — Critical food deficit recovery

**Setup**

- Player 2: adaptive.
- Starting units: worker 1, settler 1, swordsman 1.
- Starting resources: food **40**, gold 200, wood 300, iron 300, gems 5.
- Barbarians: off.

**Observe**

- The AI detects food pressure, e.g.
  `[econ] Resource pressure | Critical: [food(...)]`.
- It chooses a food producer (farm or camp) using a worker, or builds the
  needed prerequisite chain if no worker exists.
- Log includes `Reason: resolve food critical ...`.
- The next round should show food net income recovering.

**Pass criteria**

- The AI addresses food before spending orders on optional exploration.
- It does not build every food producer at once.
- If the remedy is unaffordable, the log reports
  `Cannot yet afford the remedy for food. Reserving {...}` and subsequent
  proactive growth does not spend those reserved amounts.

---

## Test 4 — Defend and retaliate

**Setup**

- Player 2: adaptive.
- Player 3: any aggressive AI (e.g. `standard`) or enable barbarians with a high
  spawn frequency.
- If using a directed test, set the adaptive directive stance for the opponent
  to `"offensive"` (see the optional directive override above).

**Observe**

- When an enemy is adjacent or has damaged the AI, the console shows
  `[combat] Emergency defence | Target: ... | Threat: attacked us ...` or
  `within striking distance`.
- Non-combat units that are threatened retreat with `[warn] Retreat | ...`.
- General engagements log `Engagement decision ... Reason: retaliation`,
  `threat in territory`, or `offensive stance`, followed by
  `Engagement result ... Orders used: ...`.

**Pass criteria**

- The AI prioritizes an adjacent/attacking enemy before optional builds.
- It uses dedicated military units before workers/builders when available.
- It attacks with the closest capable unit first.
- It does not attack `friendly`/`ally` opponents unless they attacked first.

---

## Test 5 — Stance behavior

Run three short games with the adaptive directive stance for the opponent set to
`defensive`, `caution`, and `friendly` respectively.

**Observe**

- `defensive`: engages enemies that enter the threat radius, but does not march
  across the map to seek them.
- `caution`: vulnerable units retreat; the AI does not attack the caution
  opponent unless that opponent has damaged the AI.
- `friendly`: the AI never targets that opponent, moves freely near them, and
  may repair their damaged units.

**Pass criteria**

- No attack is ever initiated against a `friendly`/`ally` opponent by the
  general combat path.
- `caution` does not trigger opportunistic attacks.

---

## Test 6 — Exploration spreading and goals

**Setup**

- Player 2: adaptive with directive
  `{ "type": "explore", "direction": "NE" }` (add more goals if desired).

**Observe**

- `[explore] Explore decision | <unit> ... toward NE`.
- Different explorers are sent in different directions over a few rounds
  (`usedExploreDirections` spreads them). They do not all stack on the same
  target cell.
- The goal is reported complete once no unexplored cells remain in that
  direction: `[explore] Goal complete | Explore NE.`
- When the whole map is explored: `All map territory is fully explored.`

**Pass criteria**

- The AI does not oscillate between the same two explored cells.
- It excludes builders from exploration while urgent deficits exist.
- It keeps at least some military at home when threats are visible.

---

## Test 7 — Repairs: heavy damage and disabled producers

**Setup**

- Let an AI-owned unit fall below 50% HP (enemy attacks or barbarians).
- Separately, let an AI-owned resource producer (farm/mine/village/etc.) fall
  to 90–95% HP.

**Observe**

- `[build] Repair decision | Repairer: ... | Target: ... | HP: ...`
- A non-producer above 50% HP is not repaired.
- A producer below 95% HP *is* repaired, because the engine stops all yields
  while health is at or below 95%.

**Pass criteria**

- Heavy damage (<50%) is repaired for any repairable target.
- A resource producer at 90–95% HP is repaired to restore income.
- A producer at full health is never repaired.
- The repairer is a unit whose `repairables` list includes the target's type.
- Repair consumes an order and restores HP (visible in the inspect panel).

---

## Test 8 — Focus directives

Run short games with `focus: "economy"`, `focus: "military"`, and
`focus: "exploration"`.

**Observe**

- `economy`: more economic producers/score entities; military only when
  threatened.
- `military`: more military units/structures; economy maintained enough to
  sustain them.
- `exploration`: more mobile/high-sight units and earlier exploration, while
  still addressing critical deficits.
- `balanced` (default): builds toward the lowest of the three score pillars.

**Pass criteria**

- Critical deficits and immediate defence still take precedence over focus.
- The AI does not spend reserved deficit resources on focus-driven builds.

---

## Test 9 — Long-run stability and score growth

**Setup**

- Map size: 32.
- Two adaptive AI players plus one human (or spectate with all AI).
- Barbarians: on.
- Run at least 20 rounds.

**Observe**

- Each AI turn ends; no infinite loop or repeated identical log lines.
- Total score increases over time and all three pillars are non-zero.
- No “No active entities remain” warning during normal play.
- If a deadlock is genuinely unavoidable, the log shows the blocked dependency
  chain or the no-producer warning instead of silently idling.

**Pass criteria**

- No unhandled exceptions.
- Orders are mostly consumed each turn.
- The AI reacts to barbarian threats and repairs/rebuilds its economy.
- Performance remains acceptable (no full-map scan on every single action
  causing multi-second stalls; the exploration direction scan is per action,
  not per cell action).

---

## Test 10 — Scrapping TODO verification (code review, not gameplay)

Scrapping is intentionally not implemented. Confirm the code contains a single
clear TODO in `attemptCriticalDeficits()` describing where an entity would be
removed if an unavoidable maintenance deadlock occurs. No scrapping action
should be performed by the AI.

---

## Logging checklist

Every meaningful decision should identify:

- the acting entity (`name#id`) and owning player,
- the source and target coordinates,
- the reason/priority (deficit, emergency defence, stance, goal, ROI),
- the outcome and orders used.

Report any decision that lacks this context as a defect.
