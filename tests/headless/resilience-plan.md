# AI resilience probe plan (issue #72)

Test the six matrix AIs (Adaptive, Apex, Entity, Fable, Hark, Kestrel) against
config and definition changes, not just map/barbarian settings, then turn the
results into (a) requirements for a more adaptive AI, (b) fixes/knobs for
existing AIs, (c) which AIs already handle change well, and (d) config
changes that are safe or harmful.

Source of truth for discussion is issue #72. This file is the consolidated
table the group agreed (Leona, Rook, Kestrel); update it by PR when the table
changes.

## Baseline

Current dev defaults. Post-nerf barbarian HP (200/200/300) is the baseline;
the pre-nerf values (300/250/400) appear as a variant (C6) so the nerf's
effect is measurable. Standard starting conditions: resources food 300, gold
200, iron 300, wood 300, gems 5; starting units settler + swordsman + worker;
orders max 6, 5 per turn; win condition harness defaults.

Group A (baseline) is already done: 24 games, 4 maps (32/64/96/128) × 3
barbarian configs (off / medium / heavy) × 2 seeds (1000–1001), 200-turn cap,
concurrency 12, ~96 min on Rook's box. All other groups compare against it.

## Method: probe first, matrix later

Every variant below runs as a **probe** first: 2 maps (48, 96) × 2 barbarian
configs (off, medium) × 2 seeds (1000–1001) = 8 games, 200 turns, at ~4
min/game on Rook's box (~32 min per variant). Only variants that change the
picture get the full matrix (4 maps × 3 barb configs × 5 seeds).

A 6-AI, map-48, 60-turn game is ~1–1.5 min on Rook's box; a 24-game
200-turn matrix is ~1.6 h. No single run exceeds ~4–6 h (Rook's box is off
nightly; long runs split across nights).

## How variants are applied

- **Suite config** (no harness work): barbarian settings, starting
  resources/units, orders, win condition, per-AI `controllerConfig`.
- **`definitionsDir`** (harness change, test-only, no game-code change):
  a suite entry `"definitionsDir": "variants/cost-x1.25"`; `tournament.mjs`
  resolves it and passes `HEADLESS_DEFINITIONS_DIR` to each child;
  `stubs.mjs` resolves `./definitions/<file>` from that dir first, falling
  back to the repo copy for untouched files. Variant dirs contain only the
  changed file(s). Lands as its own PR, separate from AI changes.

## Read: what counts as "handles it well"

Per AI, per variant:

- No failures, crashes, or NaN scores.
- Relative rank stays within ±1 of its baseline rank.
- No component collapse: no score component (military / economic /
  exploration) below 50% of its baseline value.
- K/D not worse than baseline by more than noise.
- Timing under 2× baseline ms/turn.

Absolute score drops are reported but are a **balance finding**, not an AI
failure, unless relative standing changes. Big deltas are findings, not
necessarily bugs.

**Viability pre-check.** Before a full sweep on a definition variant, run
1 seed and check the game itself is viable (turns advance, builds happen,
someone can afford a unit). Report three separate outcomes: "config
non-viable" (the game stalls regardless of AI), "AI crashed/stuck" (a
controller failure), "AI played badly" (ran clean and lost). Never blame the
AI for a non-viable game.

## Groups and variants

### A. Baseline — done (24 games)

Current defaults, 4 maps × 3 barb × 2 seeds, 200 turns.

### B. Starting conditions — 4 variants, 32 games, ~2.1 h

Suite config only; can start before the harness change.

| Variant | Resources (food/gold/iron/wood/gems) | Starting units |
|---|---|---|
| B1 poor | 150 / 100 / 150 / 150 / 2 | settler + worker |
| B2 rich | 600 / 400 / 600 / 600 / 10 | settler + swordsman + 2 workers |
| B3 military | standard (300/200/300/300/5) | settler + 2 swordsmen + worker |
| B4 expansion | standard | 2 settlers + swordsman + worker |

Also in B: orders max 4 / 3 per turn (B5) and max 10 / 8 per turn (B6) —
orders as a real constraint vs nearly free. (6 variants, 48 games, ~3.2 h
with B5–B6 included.)

### C. Definition changes — 7 variants, 56 games, ~3.7 h

Needs `definitionsDir`. Magnitudes are ±25–30%: realistic balance changes,
not edge cases (harsher levels live in E).

| Variant | Change | File |
|---|---|---|
| C1 combat costs | Combat-unit spawn costs ×1.25 | `definitions/entities.json` |
| C2 builder costs | Worker/settler spawn costs ×1.25 | `definitions/entities.json` |
| C3 combat HP | Combat-unit HP ×0.8 | `definitions/entities.json` |
| C4 yields | Economy-building yields ×1.3 | `definitions/entities.json` |
| C5 terrain movement | Hills / Mountains / Swamp movement cost +1 | `definitions/terrains.json` |
| C6 barbarian HP (old) | Barbarian HP back to 300 / 250 / 400 | `definitions/entities.json` |
| C7 barbarian HP (×1.5) | Barbarian HP ×1.5 (300 / 300 / 450) | `definitions/entities.json` |

C6 isolates the nerf's effect on the matrix. Combat-unit costs and builder
costs are separate rows: they stress different decisions.

### D. AI config probes — 24 games (+24 optional), ~1.6 h

Map 96, medium barbarians, 2 seeds. Per AI, its top knob at low/high vs
default (2 levels × 2 seeds = 4 games per AI per knob). Primary knob first;
secondary knob if budget allows.

| AI | Primary knob (default → low / high) | Secondary knob (default → low / high) |
|---|---|---|
| Kestrel | armyWeight 0.1 → 0.6 | minCharges 12 → 4 |
| Entity | attackRisky 4 → 2 / 8 | fleeImportance 9 → 5 / 12 |
| Fable | buildShare 0.5 → 0.25 / 0.75 | planningHorizon 10 → 5 / 20 |
| Hark | stanceOffensiveRatio 1.5 → 1.0 / 2.5 | builderCombatRatio 1.0 → 0.5 / 2.0 |
| Adaptive | offensivePowerRatio 1.05 → 0.8 / 1.5 | targetUpkeepTurns 6 → 3 / 12 |
| Apex | militaryBalanceBias 2.0 → 1.0 / 4.0 | guardShare 0.35 → 0.15 / 0.6 |

Defaults verified from `definitions/ai.json` and the in-file defaults
(`adaptiveManager.js:30`, `apexAi.js:67,119`, Kestrel `DEFAULT_CONFIG`).
Opus stays out — it is not in the matrix.

### E. Edge / robustness — 8–16 games, ~1 h, last

- Max barbarians (heaviest horde config).
- Partial / invalid AI config (missing keys, out-of-range values) — the AI
  must not crash.
- Extreme start (settler only, poor resources).
- Harsh definition levels (the original ×2 / ×0.5 rows): spawn costs ×2 and
  ×0.5, combat damage ×2 with HP ×0.5, yields ×0.5.
- Yields ×1.5 (optional, if budget allows — asymmetric economy is the
  interesting stress).
- Terrain distribution: widen Ocean / ShallowWater ranges, or raise the
  Hills / Mountains elevation bands in `definitions/terrains.json`
  (distribution is a layout axis; movement cost is separate). `terrains.json`
  has no weights — distribution changes mean widening/narrowing the
  `conditions` (elevation / temperature / humidity) ranges.
- Win condition absolute 1000 → 500 (shorter games, less snowball).

## Sequencing

1. **B now** — suite config only, no harness work.
2. **Harness PR** (`definitionsDir`) — Rook implements, Kestrel reviews.
3. **C, D** — after the harness lands.
4. **E last** — needs definitions support plus the invalid-config handling.

## Assignment

- **Rook:** implement the `definitionsDir` harness change; run all probes;
  run the full matrices that survive; produce the results table and
  artifact zips.
- **Kestrel:** review the harness change; confirm the Kestrel knobs above;
  start the adaptive-AI requirements from the probe data.
- **Leona:** this table (consolidate + verify); verify probes; keep some
  suite-config probes on her VM where they don't need Rook's box.
- **Shahin:** nothing yet; the group comes back with the settled table, then
  results and recommendations.

## Deliverable

Results table in issue #72 + artifact zips, then a summary with
recommendations for (a) a new, more adaptive AI, (b) changes to existing
AIs, (c) identification and config of AIs that already handle adjusted
config well, (d) config changes that make the game better, or at least
don't make it worse or break it.
