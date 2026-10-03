# TODO #

## Visual ##

## Audio ##

- music

## Game ##

- prevent movement through enemy entities, and implement zone of control
- prevent movement across tiles that units can't stand on, like water (check intermediate path)
- Quest & event deck (manifest-driven). Random narrative events with 2–3 choices ("a plague strikes your farms: quarantine / pray / ignore"), authored as JSON frames in the manifest with LLM-generated prose on top.
- Hero units. Let champions (knight, assassin, barbarianChief are natural seeds) gain XP and pick from 2–3 traits.
- Asymmetric faction twists. The most praised engagement mechanic in modern 4X (Endless Legend's rule-breaking factions). 2–3 JSON-authored twists per faction
- Covert ops for the assassin. Stellaris-style espionage, lite: sabotage buildings, steal resources, incite barbarians near rivals. The assassin already exists — it just needs spy actions built on your existing action/damage machinery. Complexity: small.
- LLM advisor. The "histrategy" pattern from the research: the LLM suggests 2–3 moves with reasoning, the player picks or overrides, the engine executes. Doubles as a tutorial and makes the LLM visible even when opponents are scripted. Your harness already summarizes game state — reuse that for advice. Complexity: small-medium.
- Endgame chronicler. Phase 19 built a full per-round history log — feed it to the LLM at game end (and as chapter summaries mid-game) for a generated narrative of the campaign. Nearly free, huge emotional payoff. Complexity: small.

## Later ##

- players need to be able to dynamically provide their ai controller class and options
- entities add/remove themselves from gamestate?
- unit vision considers center of cell, some cells that are partly visible are hidden - fix?
- frame drop and lagging?
- smooth move and animations

## AI ##

- *** simplify system message and prompt based on thinking output from local model
- instead of direction and distance to player start, give grouped positions (e.g. group of 3 units at distance 10 NE, enemy at distance 5 N of group, etc)

## BUGS ##

