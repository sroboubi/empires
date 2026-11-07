# Addendum to the AI Manager Specification — notes for implementors

Companion to `spec.md`. Lessons from the review of PR #46 (Hark's review of
the adaptive AI, November 2026), discussed interactively with Shahin. Give
this to anyone — human or AI — before they write or "fix" AI logic.

## The core rule (already in spec.md, restated because it keeps getting violated)

- Do not hardcode actions, numbers, or unit names. The AI must work with
  ANY settings and manifest.
- Decide what a unit can and should do from its attributes and its
  available actions (determined dynamically), never from its role or name.
  A unit that builds today may be a strong combat unit tomorrow — any rule
  of the form "builders never X" will break when the manifest changes.
- The intended direction (backlog): a per-unit decision — "what is the best
  thing this unit can do?" — made holistically from the unit's capabilities,
  position, and the game state, not from role filters.

## Mistakes found in review (and what to do instead)

1. **Role bans (B3, B4 — both reverted).** "Builders never explore" and
   "never fall back to builders as emergency attackers" turned a strategy
   preference into a hard ban. The spec says the opposite (hint 15: even
   workers can attack — pick the best ones; hint 18: pick the best
   explorers, don't ban categories). If a choice is bad, make it score
   badly — don't forbid it. The old conditional code (builders explore only
   when nothing is urgent or threatening) was the author's choice, not a bug.
2. **Duplicating engine guarantees (B2 — reverted).** A `canAttackTarget`
   pre-check duplicated what `helper.attack` already does: close distance
   if possible, burn nothing if not. Before adding a guard, verify what the
   engine/helper already guarantees — a redundant check only removes useful
   behavior (here: units that would have closed distance).
3. **Blacklisting by failure, without a reason (B2 — reverted).** A
   per-turn `failedAttackers` set blacklisted a unit after one failure,
   regardless of why. Failure is target-specific: a unit that can't move
   toward a target on a mountain (not enough AP) may still reach a target
   on grassland. Record WHY something failed (no path, unaffordable, out of
   range), not just THAT it failed. And verify the mechanism before adding
   the guard: the set only ever recorded zero-cost failures, and a success
   returned from the function immediately — so the double-spend it claimed
   to prevent couldn't happen.
4. **Not reading the stance spec (B1 — revised).** Neutral-stance AIs were
   opportunistically attacking structures. The directive spec
   (`hybrid-ai-directive.md`) says neutral is below caution and never
   initiates ("No special targeting"). Stance is per-opponent (the
   `directive.stance` map keyed by opponent ID), not a property of the AI.
   Always check the directive spec for stance semantics before writing
   combat-gating code. Barbarians (ownerless entities) are treated as
   defensive stance.
5. **Arbitrary constants (distance cap — kept, with a note).** The 10-hex
   emergency radius has no basis in the spec; it was kept only to preserve
   the original author's intent. Don't invent magic numbers — derive
   thresholds from config, or state them as explicit tuning with a reason.
6. **Don't conflate detection with response (B9 part 1 — reverted).**
   `nearestOwn` did three jobs — threat detection, defensive engagement
   range, and target priority — and a change that was correct for range and
   priority (measure to a unit that can fight) broke detection (an enemy
   next to a farm is a threat *to the farm*). If one value serves two
   purposes, split it: one measure for "is it near our stuff?" and another
   for "can we reach it?"
7. **Diplomacy belongs to the director, not the tactical layer (B12 —
   reverted).** The tactical AI must not override a diplomatic decision
   with last-turn attack history ("they attacked us last turn, so retreat /
   attack back"). The LLM director (or whatever sits on top) runs at the
   start of the turn and decides what to do about diplomacy — including
   peace after a fight. The same applies to the pre-existing retaliation
   path: it's a question for the director design, not a tactical default.

## Checklist before submitting AI logic

- [ ] Does this change forbid a category of units from an action? If so, it
      must be a capability check (AP vs cost, has the action, in range),
      not a role/name check.
- [ ] Does the engine/helper already handle this case? Check before adding
      a guard.
- [ ] If recording a failure, is the reason recorded — and is the failure
      actually specific to this target?
- [ ] Is this a bug fix (wrong computation) or a strategy change (different
      choice)? Strategy changes are design decisions, not bug fixes —
      discuss them as such.
- [ ] Any new number: is it in config, with a reason? Or is it a magic
      constant?
- [ ] Stance-gated? Check the directive spec — stance is per-opponent.
