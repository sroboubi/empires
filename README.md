# README #

## Prompt ##

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

TODO:
- unit lighting and shahows
- resources init on grid?
- frame drop?
- civ resource pool
- camera controls and set target to selected cell, smooth move
- move units
