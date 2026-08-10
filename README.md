# README #

Task: Phase 1 - Base Engine Architecture & 3D Hex Grid Visualization

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

Task: Phase 1.1 - Terrain Provider

Create a terrainProvider class. It will contain the terrain config. In [gameState.js](codeContext;file:///c%3A/Users/Falcon/workspace/empires/src/gameState.js#L16-50) we will call terrainProvider get(q, r) which will provide a terrain object to use for the cell at q, r. Use simplex noise for the terrain type.

Task: Phase 2 - Dynamic Asset and Controller Manifest Loader

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

Task: Phase 3 - Update Camera Controls and Selection

1. WASD keys or drag with left click to pan the camera but keep the camera elevation fixed
2. mouse wheel to zoom in and out
3. Q/E keys or right click and drag to rotate camera - right click also allows tilting up and down
4. left click to select entity, or deselect if clicking on a location that is not an entity
   - selected entity should be highlighted
5. right click to get a context menu for actions on selected entity

Task: Phase 4 - Cleanup and refactor

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

Task: Phase 5 - Entities and actions

1. Read and modify baseEntity.js to make it functional. Note the comments. All entities should extend this class.
2. Each entity will have a reference to the hex grid. 
3. Each entity must control what actions it can do and how they are done. For example:
   - it can use the hex grid to determine if and how it can move to a target cell, which will be passed as an argument to the action function. It can take into account the attributes of the current and target cell, and perhaps cells in between if we allow multi-cell movement. It will then reduce its own movement points and consume the required resources from the owning player
   - in the case where an entity is asked to attack another entity, it will be passed the target entity and it can first determine if the attack is possible based on distance and attributes of the hex cells on which it and the target stand, and perhaps intermediate cells
   - if an attack is possible and is performed, it will adjust its own and the target entity properties accordingly, by consuming resources, reducing health, etc. 
   - if the entity is asked to construct another entity on a target cell, it can again determine if it's possible based on target cell properties, resources, etc, and then make the adjustments and spawn the new entity

Task: Phase 6 - Bug fixes

1. Units are not being placed on the map anymore. Fix it.
2. Update baseEntity to have getActions and doAction - these apply to all entities
   - for example, Village should have a "spawn" action to create units on adjacent hexes if the terrain type allows and enough resources exist.

Task: Phase 7 - Refactor Hex Grid

1. Make a class to encapsulate the hex grid and merge hexMath.js into it.
2. This class should contain all the cells, where each cell has axial co-ordinates and the terrain for that cell. Cells don't need to have an "owner".
3. Update gameState to use this class instead of a plain object. 
4. Remove isElevationAboveSeaLevel() from gameState, instead use the canStandOn() function of each entity to determine if it can stand on a given terrain. For each player, first pick a starting cell, then search outwards from that cell until you find a cell where the first starting unit can stand on it. For each subsequent unit, start from the cell of the first unit and search outwards.
5. Add functions to the hex grid class: 
   - directionTo(source, target) - this will determine direction given a source and target cell. This will return the direction that will see the target from the source (E, NE, NW, W, SW, SE) and see the source from the target.
   - movementCostTo(source, target) - this will calculate the minimum movement cost of cells between the source and target, but only considering cells that are progressively closer to the target, never moving away from the target. It will return the cost and the list of cells along the best path.
   - visiblePath(source, target) - this will determine if and along what path the source cell can see that target based on elevation, but only considering cells that are progressively closer to the target, never moving away from the target. For each path, if there is a cell that has a higher elevation than the source then the target can't be seen along that path. If no path exists, return nil, otherwise return the shortest path (list of cells) along which the target is visible.

Task: Phase 8 - Entity refactor and game logic

1. Update the base entity class to have the following attributes and functions:
+ health : number
+ active : bool // set to true on each step() unless maintenace resources not met - if false then can NOT do actions or produce resources
+ receiveDamage(damage{value, type, source})
+ getActions(target{cell, entity}) : array
+ canStandOn(target{cell}) : boolean
+ getCostToMaintain() : object // returns an object e.g. {food: 2, wood: 3, ...} with the cost to maintain the entity on the map, this will be deducted from the player's resources on each step()
+ getCostToSpawn() : object // returns an object e.g. {food: 2, wood: 3, ...} with the cost to create the entity
+ step()
2. Update the unit entity to have the following attributes and functions:
+ actionPoints : number // any action points not used in the last turn are added to health in the following turn (on step)
+ maxActionPoints : number // the maximum action points a unit can have
+ attackCostScale : number // value to multiply the movement cost to target cell for an attack action
+ damage: object {value: number, type: string}
+ range : object {minCells: number, maxCells: number, arcHeight: number} // if null then can only attack adjacent cell
+ armor: object {value: number, type: string} // damage of matching type is divided by this value
+ facing : enum // one of 6 directions, set based on "face" action, previous "movement", or "attack" (E, NE, NW, W, SW, SE) - use this when rendering unit
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

Task: Phase 9 - Cleanup

1. Identify and remove unused code: e.g. hexMath, entity.doAction
2. When constructing entity, use the JS spread notation to get default data defined in the class, then override with manifest data, then override with initialState - do NOT set values individually (e.g. if a new value is added to the manifest it should be included in the entity without any code change)
3. Add a rotation offset to each entity in the manifest so that their glb model rotation can be corrected
4. getActions and the action list should only be defined in baseEntity. Subclasses should just add the actions they want to the list. getActions() does not need any parameters.
5. "face" action should cost action points equal to half the movement cost of the cell the unit is on
6. entity.gridProxy is not a grid, it is GameState. Rename to entity.gameState
7. add action to worker to repair constructs. It will consume all action points and repair an adjacent construct increasing the target construct health by 2x the worker's action points, up to max health

Task: Phase 10 - Player and visiblity

1. Add a step() function to the player class that will be called at the start of the players turn
2. Add player definitions to the manifest as an array with player attributes. This will define the name, color, and description. A new player should be instantiated for each player in the manifest. 
3. Each turn only one player can perform actions, determined by the order in the manifest array. When all players have taken a turn then game round ends and another begins, with the players taking turns again. 
4. Add a controller object to the player, which will be defined in the manifest. If it is null then the player is controlled by the user, otherwise it will be an AI controlled player - which will be implemented later. AI controller player units should not be selectable or actionable by the user.
5. Each player has a list of cells that are "explored" and a subset that are "visible" - fully hide unexplored cells and other player units on non-visible cells
   - when rendering, for each cell check if it is in the current player's explored list - if not then render the hidden terrain from the terrainProvider.getHiddenTerrain(). If it is in the explored list then check if it is in the visible list - if not then render the cell with a desaturated version of its terrain color and without any entities on it, otherwise render the cell normally with its entities on it   
6. Add a sight range to each entity, provided in the manifest, defining the cell distance that it can see. Add a list of visible cells to the entity and determine these cells by calling hexGrid.visibleCells() on spawn and move. On spawn, move, and destruction of an entity, update the player visible list by taking the union of all player owned entities visible cells. Any cells added to the visible list are also added to the explored list, but no cells are ever removed from the explored list.   
