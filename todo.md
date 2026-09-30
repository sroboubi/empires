# TODO #

## Visual ##

## Audio ##

- sound effects
- music

## Game ##

- prevent movement through enemy entities, and implement zone of control
- prevent movement across tiles that units can't stand on, like water (check intermediate path)
- resources init on grid - adjust resource extractor yields next to resources
- Quest & event deck (manifest-driven). Random narrative events with 2–3 choices ("a plague strikes your farms: quarantine / pray / ignore"), authored as JSON frames in the manifest with LLM-generated prose on top.
- Hero units. Let champions (knight, assassin, barbarianChief are natural seeds) gain XP and pick from 2–3 traits.
- Wonders & ruins. One-per-game unique wonders create races and denial drama; explorable ruins give exploration a payoff beyond the exploration score.
- Asymmetric faction twists. The most praised engagement mechanic in modern 4X (Endless Legend's rule-breaking factions). 2–3 JSON-authored twists per faction
- Covert ops for the assassin. Stellaris-style espionage, lite: sabotage buildings, steal resources, incite barbarians near rivals. The assassin already exists — it just needs spy actions built on your existing action/damage machinery. Complexity: small.
- LLM advisor. The "histrategy" pattern from the research: the LLM suggests 2–3 moves with reasoning, the player picks or overrides, the engine executes. Doubles as a tutorial and makes the LLM visible even when opponents are scripted. Your harness already summarizes game state — reuse that for advice. Complexity: small-medium.
- Endgame chronicler. Phase 19 built a full per-round history log — feed it to the LLM at game end (and as chapter summaries mid-game) for a generated narrative of the campaign. Nearly free, huge emotional payoff. Complexity: small.

## Later ##

- entity controllers are dependent on game code, so they can't be dynamically provided (if they are moved our sourced from somewhere else, the imports won't work)
- players need to be able to dynamically provide their ai controller class and options
- entities add/remove themselves from gamestate?
- unit vision considers center of cell, some cells that are partly visible are hidden - fix?
- frame drop and lagging?
- smooth move and animations

## AI ##

- *** simplify system message and prompt based on thinking output from local model

## BUGS ##

