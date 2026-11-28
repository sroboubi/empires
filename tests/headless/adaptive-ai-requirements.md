# Adaptive AI requirements (draft for #72)

Status: draft for edits in #72. Nothing here is built. It rests on Kestrel vs
Opus 2-player probes (map 48, 45 turns, 2 seeds; table in
https://github.com/sroboubi/empires/issues/72#issuecomment-7234450573) and the
plan in `resilience-plan.md`. It will change once the six-AI sweep lands.
Those probe numbers are a different game shape and are not mixed with the
six-AI results.

## What the probes show

- Nothing crashed. Kestrel completed all 24 runs with 0 failures, across
  poor/rich/military/expansion starts, orders 4/3 and 10/8, light and heavy
  barbarians, and two knob changes.
- Kestrel does not win on score at 45 turns in any case except the poor start
  (B1), which ends in 4 and 14 turns. Opus leads in base (253 vs 322.5).
- The two Kestrel knobs tested (armyWeight 0.1 to 0.6, minCharges 12 to 4)
  move her total by 5 and 13 points. Tuning those is not the lever.
- The gap does not shrink when the start changes, except when orders are
  scarce (gap 8) or barbarians are heavy (gap 8.5, both collapse).
  With 2 starting settlers it is widest (92).

So the weakness is structural, not a bad default. The AI plays the same plan
whatever the start or the rules, and a different start does not make it play
differently.

## Requirements

R1. Read the setup, do not assume it. At turn 1 the AI reads starting
resources, starting units, order limits, barbarian settings and the entity
definitions (costs, HP, terrain costs) and derives its parameters from them.
No constant that encodes a default (for example a fixed charge count or a
fixed army weight).

R2. Budget from what it has. Spending targets (army vs economy vs expansion)
are ratios of current income and stock, so a rich or poor start changes the
plan without a code change.

R3. Orders are a resource. Order cost per turn comes from the config. The AI
ranks actions by value per order and drops the lowest when orders are scarce.
(B5 is where Kestrel is closest to Opus, so scarcity is a case she already
handles better.)

R4. Opening by starting units. The opening is chosen from what it starts with
(settler only, 2 settlers, extra swordsman), not a fixed build order. B4 is the
largest gap and is the first test.

R5. Survival mode. If the start is poor or barbarians are heavy, the AI
switches to defend-and-hold until it has a stable income. B1 and the heavy
barbarian row are the tests.

R6. Costs from definitions. Unit choice uses spawn cost and HP from the loaded
definitions, so a x1.25 cost or x0.8 HP change shifts choices instead of
breaking them. Do not cache values from a hard-coded entity table.

R7. Fail soft. A missing or changed definition falls back to a safe default and
logs it. It never throws mid-game.

R8. Configurable and logged. Every derived parameter is logged once at game
start (name, value, source) so a result can be traced to a setting. Overrides
go through `controllerConfig`.

## How to test it

Same harness, same rows. Pass criteria:

- 0 failures on every group B, C, D and E row.
- Score variance across starts is lower than the current AIs on the same rows.
- Against Opus on the 2-player probes: no row worse than base, and the B4 and
  light-barbarian gaps shrink.
- With the knobs removed (no tuned constants), results are within noise of the
  tuned build.

## Open questions

- Which of the other five AIs already do R1 to R3? The six-AI sweep answers
  this. Build on the best one rather than a sixth AI if one does.
- Is score at 45 turns the right measure, or should the AI be judged on win
  rate at the full 200 turns?
- Should R5 be in scope for the first version, or a follow-up?
