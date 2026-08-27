# TODO #

## Visual ##

- only zoom to human player units

## Audio ##

- sound effects
- music

## Game ##

- fix AI building wrong resource entities
- prevent movement through enemy entities, and implement zone of control
- prevent movement across tiles that units can't stand on, like water (check intermediate path)
- barbarians and other non-aligned hostiles
- resources init on grid - adjust resource extractor yields next to resources
- win condition: total score is 2X the next largest score

## Later ##

- entities add/remove themselves from gamestate?
- unit vision considers center of cell, some cells that are partly visible are hidden - fix?
- frame drop and lagging?
- smooth move

----
convention AI:

why do you keep thinking you need gems?
exploration - why do you do it? and you keep hitting water and going back and forth?
attacking with settler?

Analyze and fix the AI implementation in @/src/ai/standard/core.js, which controls a player in this strategy game. The code contains logic bugs that cause poor decision-making. Known issues include:

1. **Resource prioritization**: At the start of the game, the AI over-prioritizes gems when other resources (e.g., food, wood) should come first for early-game progression.
2. **Exploration pathing**: Units assigned to explore oscillate back and forth without making progress — likely because the nearest unexplored cell is across water, and the unit lacks awareness of how to route around impassable terrain.
3. **Combat unit selection**: When an enemy approaches, the AI sends villagers and settlers to attack instead of selecting stronger military units.

Your task:

- Add detailed log output throughout the AI's decision-making code (resource evaluation, exploration target selection, pathfinding decisions, threat response, unit selection) to make behavior observable.
- Navigate to http://localhost:3000 where the game is running. Create a game with 2 AI players and observe their actions via the logs.
- Evaluate whether each AI acts reasonably: sensible resource gathering order, steady exploration progress, appropriate military responses to threats.
- Verify critically that neither AI gets stuck or stalls due to resource shortages or pathfinding failures.
- Fix the identified bugs and any additional issues you discover, then re-test by starting new games and inspecting logs.
- Iterate on fixes and testing until both AIs progress smoothly through the game without getting stuck.

If anything about the game mechanics, resource system, map generation, or expected AI behavior is unclear, ask me before proceeding.

+++

- when AI is doing actions I don't see units moving or getting built until after the turn is over - fix this
- do NOT use ESSENTIAL_RESOURCES constants - determine appropriate resource levels based on some multiple of the starting levels in the manifest and based on consumption of existing units. Try to maintain starting levels of each resource.
- the ONLY hardcoded resource should be "orders" as it is not a normal resource, and you can filter out of other resources.
- do NOT use magic number logic to determine what is a settlement or a builder - for example based on minSeparation or destroyOnBuild. 
- for EVERY order, pick a goal: 
    - high priority military: if a military unit has attacked