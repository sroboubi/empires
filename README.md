# README #

## Task: Phase 1 - Base Engine Architecture & 3D Hex Grid Visualization ##

We are building a modular, data-driven 4X strategy game using vanilla JavaScript (ESModules) and Three.js.

Please generate the following file structure and implementation:

1. index.html: Include Three.js and OrbitControls via a CDN Import Map. Set up a full-screen canvas.
2. src/gameState.js: Define the core, serializable state object. It must track an array of players and a map of cells indexed by axial coordinates (q, r).
3. src/hexMath.js: Implement axial coordinate helper functions (axial to pixel/3D space, distance calculations, and neighbor checks).
4. src/renderer.js: Initialize the Three.js scene, camera, lights, and OrbitControls. Implement a function to draw the grid using a standard Hexagonal Cylinder geometry. The height (Y-scale) of each hex must correspond to its terrain type data (e.g., Plains = 0.2, Hills = 0.8, Mountains = 2.0) with placeholder material colors. For now, use a function that provides a random terrain value for each cell.

Strict Constraints:

- Use strict ESModules (`import`/`export`).
- No build tools (no Vite, no Webpack).
- Keep the Game Manager completely agnostic to specific terrain types. Use a configuration lookup for heights and colors.
- Ensure the scene auto-resizes with the browser window.

### Task: Phase 1.1 - Terrain Provider ###

Create a terrainProvider class. It will contain the terrain config. In [gameState.js](codeContext;file:///c%3A/Users/Falcon/workspace/empires/src/gameState.js#L16-50) we will call terrainProvider get(q, r) which will provide a terrain object to use for the cell at q, r. Use simplex noise for the terrain type.

## Task: Phase 2 - Dynamic Asset and Controller Manifest Loader ##

Implement the game configuration loading system using the provided JSON architecture.

1. Each cell can have a list of entities, that can be constructs or units.
2. Entities all have a glb file that defines the geometry. This will be added to the scene.
3. Entities all have a js file that defines the controller. This can implement an info(), step(), and actions() functions for each entity.
4. Create `src/manifestLoader.js`: 
   - Implement an asynchronous `loadGameManifest(url)` function, where the URL can be provided as a query parameter to the game.
   - It must fetch the JSON payload with a schema defined by src/manifest.schema.json, parse the global resources, and cache the entity metadata.
   - It must asynchronously preload the dynamic JS controller classes using dynamic `import()`.
5. When the manifest and entities are loaded, add the resources and add the entities to the grid for each player.
6. Create `src/engine.js` that will be responsible for the game loop. It will call the step() function of each entity every frame. It will also handle the game state and the drawing of the grid and entities.

## Task: Phase 3 - Update Camera Controls and Selection ##

1. WASD keys or drag with left click to pan the camera but keep the camera elevation fixed
2. mouse wheel to zoom in and out
3. Q/E keys or right click and drag to rotate camera - right click also allows tilting up and down
4. left click to select entity, or deselect if clicking on a location that is not an entity
   - selected entity should be highlighted
5. right click to get a context menu for actions on selected entity

## Task: Phase 4 - Cleanup and refactor ##

1. don't pass entities to controllers, instead each controller instance will be an entity
2. remove references from cells to entities, instead each entity already has a refernece to the cell it stands on
   - for rendering, loop through all entities, get their cell, and draw them based on the cell's position
3. make a Player class and each player an instance of Player, that holds the player's resources
4. the player should not have a reference to entities, instead each entity should have a reference to the player that owns it
5. entities should have a function canStandOn(terrain) that determines if it can stand on a given terrain 
   - for now return true if terrain elevation is above the const defined SeaLevel
6. remove all references to terrain name from code outside of terrainProvider
   - don't spawn resources on the map
   - remove isLand() function, instead for each entity to spawn use canStandOn()
7. combine all rendering code into one file instead of havign renderer.js and engine.js

## Task: Phase 5 - Entities and actions ##

1. Read and modify baseEntity.js to make it functional. Note the comments. All entities should extend this class.
2. Each entity will have a reference to the hex grid. 
3. Each entity must control what actions it can do and how they are done. For example:
   - it can use the hex grid to determine if and how it can move to a target cell, which will be passed as an argument to the action function. It can take into account the attributes of the current and target cell, and perhaps cells in between if we allow multi-cell movement. It will then reduce its own movement points and consume the required resources from the owning player
   - in the case where an entity is asked to attack another entity, it will be passed the target entity and it can first determine if the attack is possible based on distance and attributes of the hex cells on which it and the target stand, and perhaps intermediate cells
   - if an attack is possible and is performed, it will adjust its own and the target entity properties accordingly, by consuming resources, reducing health, etc. 
   - if the entity is asked to construct another entity on a target cell, it can again determine if it's possible based on target cell properties, resources, etc, and then make the adjustments and spawn the new entity

## Task: Phase 6 - Bug fixes ##

1. Units are not being placed on the map anymore. Fix it.
2. Update baseEntity to have getActions and doAction - these apply to all entities
   - for example, Village should have a "spawn" action to create units on adjacent hexes if the terrain type allows and enough resources exist.

## Task: Phase 7 - Refactor Hex Grid ##

1. Make a class to encapsulate the hex grid and merge hexMath.js into it.
2. This class should contain all the cells, where each cell has axial co-ordinates and the terrain for that cell. Cells don't need to have an "owner".
3. Update gameState to use this class instead of a plain object. 
4. Remove isElevationAboveSeaLevel() from gameState, instead use the canStandOn() function of each entity to determine if it can stand on a given terrain. For each player, first pick a starting cell, then search outwards from that cell until you find a cell where the first starting unit can stand on it. For each subsequent unit, start from the cell of the first unit and search outwards.
5. Add functions to the hex grid class: 
   - directionTo(source, target) - this will determine direction given a source and target cell. This will return the direction that will see the target from the source (E, NE, NW, W, SW, SE) and see the source from the target.
   - movementCostTo(source, target) - this will calculate the minimum movement cost of cells between the source and target, but only considering cells that are progressively closer to the target, never moving away from the target. It will return the cost and the list of cells along the best path.
   - visiblePath(source, target) - this will determine if and along what path the source cell can see that target based on elevation, but only considering cells that are progressively closer to the target, never moving away from the target. For each path, if there is a cell that has a higher elevation than the source then the target can't be seen along that path. If no path exists, return nil, otherwise return the shortest path (list of cells) along which the target is visible.

## Task: Phase 8 - Entity refactor and game logic ##

1. Update the base entity class to have the following attributes and functions:
   - health : number
   - active : bool // set to true on each step() unless maintenace resources not met - if false then can NOT do actions or produce resources
   - receiveDamage(damage{value, type, source})
   - getActions(target{cell, entity}) : array
   - canStandOn(target{cell}) : boolean
   - getCostToMaintain() : object // returns an object e.g. {food: 2, wood: 3, ...} with the cost to maintain the entity on the map, this will be deducted from the player's resources on each step()
   - getCostToSpawn() : object // returns an object e.g. {food: 2, wood: 3, ...} with the cost to create the entity
   - step()
2. Update the unit entity to have the following attributes and functions:
   - actionPoints : number // any action points not used in the last turn are added to health in the following turn (on step)
   - maxActionPoints : number // the maximum action points a unit can have
   - attackCostScale : number // value to multiply the movement cost to target cell for an attack action
   - damage: object {value: number, type: string}
   - range : object {minCells: number, maxCells: number, arcHeight: number} // if null then can only attack adjacent cell
   - armor: object {value: number, type: string} // damage of matching type is divided by this value
   - facing : enum // one of 6 directions, set based on "face" action, previous "movement", or "attack" (E, NE, NW, W, SW, SE) - use this when rendering unit
3. All entity attributes should be defined in the manifest (e.g. health, damage, range, armor, actionPoints, maxActionPoints, etc)
4. Each entity should have a list of actions with
   - canDo(target{cell, entity}) : object // return object with bool indicating if action can be performed, and string description of effect if it can be performed, or description of why it can't be performed otherwise
   - do(target{cell, entity}) : boolean // return true if action was performed, false otherwise - first call canDo() inside of do() and return false if action not possible
   - name : string // name of the action
   - description : string // description of the action
5. getActions() simply return all available actions to the entity. The game logic can then use canDo() to display which ones are possible and their preview or reason for not being possible.
6. To perform an action, call the action.do() method. This will change the state of the entity and adjust its action points accordingly.
7. for military units add attack action. The type and value of the damage is determined by the entity damage attribute, but adjusted based on target facing - if the damage is coming from behind it does 2x damage, if coming from the side it does 1.5x damage and from the front it does normal damage. Call the target receiveDamage to apply damage. The attack should change the facing direction of the attacker towards the target.
   - if the unit does not have a range attribute then the attack is melee, and the cost is equal to the attackCostScale * the movement cost to the target cell
   - if the unit has a range attribute then the attack is ranged - call getSightAndTrajectory() for target cell. The attack is possible if the target cell is within range and is either visible OR the maxObstructionDelta is less than the range's arcHeight. The attack cost is equal to attackCostScale * distance to target.  
8. for all units add a move action that uses the movementCostTo() function to determine the cost of moving to a target cell and moving the entity to that cell if possible and updates the entity's action points and facing based on the direction of movement

## Task: Phase 9 - Cleanup ##

1. Identify and remove unused code: e.g. hexMath, entity.doAction
2. When constructing entity, use the JS spread notation to get default data defined in the class, then override with manifest data, then override with initialState - do NOT set values individually (e.g. if a new value is added to the manifest it should be included in the entity without any code change)
3. Add a rotation offset to each entity in the manifest so that their glb model rotation can be corrected
4. getActions and the action list should only be defined in baseEntity. Subclasses should just add the actions they want to the list. getActions() does not need any parameters.
5. "face" action should cost action points equal to half the movement cost of the cell the unit is on
6. entity.gridProxy is not a grid, it is GameState. Rename to entity.gameState
7. add action to worker to repair constructs. It will consume all action points and repair an adjacent construct increasing the target construct health by 2x the worker's action points, up to max health

## Task: Phase 10 - Player and visiblity ##

1. Add a step() function to the player class that will be called at the start of the players turn
2. Add player definitions to the manifest as an array with player attributes. This will define the name, color, and description. A new player should be instantiated for each player in the manifest. 
3. Each turn only one player can perform actions, determined by the order in the manifest array. When all players have taken a turn then game round ends and another begins, with the players taking turns again. 
4. Add a controller object to the player, which will be defined in the manifest. If it is null then the player is controlled by the user, otherwise it will be an AI controlled player - which will be implemented later. AI controller player units should not be selectable or actionable by the user.
5. Each player has a list of cells that are "explored" and a subset that are "visible" - fully hide unexplored cells and other player units on non-visible cells
   - when rendering, for each cell check if it is in the current player's explored list - if not then render the hidden terrain from the terrainProvider.getHiddenTerrain(). If it is in the explored list then check if it is in the visible list - if not then render the cell with a desaturated version of its terrain color and without any entities on it, otherwise render the cell normally with its entities on it   
6. Add a sight range to each entity, provided in the manifest, defining the cell distance that it can see. Add a list of visible cells to the entity and determine these cells by calling hexGrid.visibleCells() on spawn and move. On spawn, move, and destruction of an entity, update the player visible list by taking the union of all player owned entities visible cells. Any cells added to the visible list are also added to the explored list, but no cells are ever removed from the explored list.

## Task: Phase 11 - Move and add game config to manifest ##

1. Move terrain definitions to the manifest, have terrainProvider use those. Leave default terrain in the terrainProvider.js
2. For each entity definition in the manifest, add spawnConditions: {terrain: [...list of terrain types by name], minSeparation: number} -in the baseEntity build action, ensure that the cell it is spawned on has terrain listed in spawnConditions.terrain and that it is at least minSeparation cells away from any other construct entity. Only check conditions that are present, if any are missing, then they don't limit the entity spawning.
3. When placing initial units for a player, ensure units are not on the same cell. Add them further from the first unit if needed, they don't need to be adjacent.
4. Add elevationAdjustment attribute to the damage object in the entity defintion of the manifest. When a unit attacks, if this adjustment is present, then calculate attackerElevation/targetElevation. If this is greater than 1, then multiply by the adjustment, otherwise divide by the adjustment. Scale the damage by this value.

## Task: Phase 12 - Setup Page and Save/Load functionality ##

1. Move "initialization" and "players" attributes from the manifest to defaultSettings.json
2. Add a new modal panel for game setup - this should be shown when the page is first loaded
3. remove the regerate map button and replace with "NEW GAME" that will open this panel again
4. Add a start button to this panel that will create a new game with the selected settings
5. The panel should allow adjusting everything in the defaultSettings.json (which should be used to load the defaults for this panel)
   - selecting a map size
   - selecting orders per player
   - add/remove players and naming each player and selecting a color - selecting AI vs human
   - selecting starting resources and units (applied to all players)
   - auto-save interval and number to keep
6. Remove the "State Serialization" panel. Instead add a save/load button. Save/Load the game state to/from indexedDB. The structure should look like
{
  name: "Empire of Rome - Turn 12",  // Key
  timestamp: 1724000000000,
  turnNumber: 12,
  auto: true, // if this is true then the game was auto-saved
  data: gameState.serialize() // Full state JSON payload
}
7. The game should auto-save as per settings, and keep as many previous auto-saves as per settings, removing the oldest ones first. When the user selects to load a game, they should be presented with a list of saved games to choose from. When the user selects to manually save a game, they can input the save game name, and these manual saves should not count towards the auto-save limit.

## Task: Phase 13 - Fix bugs ##

1. resource types should be defined only in the manifest - remove hardcodes from main.js
2. on player turn start, focus camera on center of mass of player entities (average position of all entities)
3. on load - gameState.deserialize can not call new HexGrid() as this will try to regen the terrain and fail because there is no terrain config provided. Make terrain config manditory in the existing hexGrid constructor. Make a new constructor for load that just takes the cells and does not try to generate new ones.

## Task: Phase 14 - Conventional AI and UI ##

1. Fix and enhance the conventional AI in ai/standard/core.js
2. The action menu goes off the bottom of the screen when there are lots of actions - suggest making a radial menu instead or just fix current menu placement
3. When the user clicks on an empire in the empires panel, show a panel that to visualize the player resource profile using output from player.getResourceProfile(). Use a stacked barchart or sankey diagram, or something better if you can think of it. You can use external JS libraries, but only if needed.
4. When the user long hovers over an empire in the empires panel, show the same resource profile panel as a tooltip.

## Task: Phase 15 - Enhance AI and Utilities ##

1. Add functions to ai/utils.js
   - attack(gameState, sourceEntity, targetEntity, maxOrders): if target is in range and (directional x elevation) multiplier >= 1, perform attack; otherwise, if possible, and maxOrders is > 1, move to within range, preferring a cell that maximises the directional x elevation multiplier, then perform attack. Once an attack is performed, if the number of orders used is less than maxOrders and the target is still alive, and the source has enough action points, continue to perform attacks. Return number of orders used.
   - build(gameState, sourceEntity, targetName): find the appropriate action name in the sourceEntity, call action.canDo() with all neighboring cells perform the action on a potential cell. If none of the neighbors support the construction, and the sourceEntity can "move", then find the closest cell that supports the construction - this will be the targetCell. If possible to move to an adjacent cell to the targetCell, then move there and then build on the targetCell, otherwise do nothing. Return number of orders used.
   - repair(gameState, sourceEntity, targetEntity, maxOrders): this should work exactly like the attack util function, but no need to worry about the multiplier or picking the best if moving next to the target.
2. Update ai/standard/core.js to use these utilities to implement the standard AI. 
3. Enhance the implementation by selecting a goal for each turn:
   - if there are no enemy units and there is economic pressure, then determine the best constructs to build and use all orders on building. Also build workers and settlers as needed.
   - if there are no enemy units and no economic pressure, then expand and explore. Build more military units and settlers or towns.
   - if there are enemy units, and no economic pressure, then use all orders on attacking.
   - if there are enemy units, and economic pressure, then first try and attack units that are close to towns, then focus on required resource buildings.
   - economic pressure is high if the net yield of any resource is less than 1.5x the upkeep cost for that resource OR if the stock is less than 4x the upkeep cost for that resource.
   - otherwise economic pressure is low if the net yield of any resource is less than 3x the upkeep cost for that resource OR if the stock is less than 6x the upkeep cost for that resource.
   - otherwise there is no economic pressure
4. Add a log of what actions are taken by the AI during a turn and the rational - log these to the console.   
5. Update the resource profile panel to show a bar for each resource indicating the current stock. If the net income is negative, add a red bar over the end portion to indicate the change in the stock over the next turn. If the net income is positive, add a green bar at the end to indicate the projected gain in the stock over the next turn.

## Task: Phase 16 - AI Bug Fixes ##

1. Remove hard coded values from the AI logic as much as possible. For example:
   - Do not hardcode resource types, except for "orders" - you should exclude orders from the stock/yield calculations
   - Don't use a hardcoded amount for determining if stock is low - instead use a fraction, like 0.5, of the initial resources per player
   - Don't use entity names to determine what resource buildings to build, look at the yields
   - Don't use entity names to determine what unit to build, look at unit attributes and actions. E.g. if you need wood, then determine what entity gives you wood, then determine what entity   can build it. If that entity is not available, then determine what entity can build it. If that entity does not exist, then determine what entity can build it. Follow this chain until you find and entity that can start the process needed to eventually build what you need to yield more wood.
   - Don't use entity names to find military units. Instead look at their damage and armor relative to other entities.

## Task: Phase 17 - Visual/UX Improvements ##

1. When action panel opens it flies in from the top left of the screen. Fix this.
2. When unit selected has the "move" action, show movement path and cost as mouse hovers on other cells
3. On hover over unit, show building exclusion zone defined by entity spawnConditions.minSeparation value - it is a circle of hexes with that radius. It should be semi-transparent and use the same color as the owning player
4. For build actions, show maintenance and yield of entities to build

## Task: Phase 18 - Game setup and win conditions ##

1. Game Setup Panel:
   - Orders: Just have 2 inputs, one for max orders and another for orders per turn. Add labels to these. Use the max orders as the inital value are remove "initial" from the defaultSettings.json and from the code.
   - The up/down arrow keys on all the number input fields look bad and don't match the styling of the rest of the panel. They have the default grey style - update them to match the panel style and colors.
   - After the player selection div, add another section for "Win Condition". Here, have a inputs to allow changing the defaults from winCondition in defaultSettings. Each condition should have a checkbox, so it is only enabled if selected. Both, either one, or neither can be selected.
2. Implement the win conditions as per game settings. At the end of each turn, check if any player has met the win conditions - if so, then display a victory popup with a message including the winning player and the conditions met, and end the game.

      