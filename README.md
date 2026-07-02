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