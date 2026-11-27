# TODO #

## Visual ##

## Audio ##

- music

## Game ##

- Balance entities and starting locations
- Quest & event deck (manifest-driven). Random narrative events with 2–3 choices ("a plague strikes your farms: quarantine / pray / ignore"), authored as JSON frames in the manifest with LLM-generated prose on top.
- Hero units. Let champions (knight, assassin, barbarianChief are natural seeds) gain XP and pick from 2–3 traits.

## Later ##

- Covert ops for the assassin. Stellaris-style espionage, lite: sabotage buildings, steal resources, incite barbarians near rivals. The assassin already exists — it just needs spy actions built on your existing action/damage machinery. Complexity: small.
- LLM advisor. The "histrategy" pattern from the research: the LLM suggests 2–3 moves with reasoning, the player picks or overrides, the engine executes. Doubles as a tutorial and makes the LLM visible even when opponents are scripted. Your harness already summarizes game state — reuse that for advice. Complexity: small-medium.
- Endgame chronicler. Phase 19 built a full per-round history log — feed it to the LLM at game end (and as chapter summaries mid-game) for a generated narrative of the campaign. Nearly free, huge emotional payoff. Complexity: small.

- Optimize Opus AI (targeted-A*)
- create mock ai proxy to avoid wrapping objects and reduce GC for test suites only (not to be used in a real game)

## AI ##

- test frontier models as players (just as a benchmark)

## BUGS ##

- to investigate: click/right-click doesn't always register
