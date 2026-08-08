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