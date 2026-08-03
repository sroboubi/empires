import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { axialToPixel } from './hexMath.js';

export let scene, camera, renderer, controls;
let hexGroup;
let cellMeshMap = {}; // Maps "q,r" to Mesh object
let highlightMesh = null; // Mesh to show selection/hover highlight
export let hexSize = 1.0;

// Update callback and Clock for external simulation hooks
let updateCallback = null;
const clock = new THREE.Clock();

export function setUpdateCallback(cb) {
  updateCallback = cb;
}

// Material caches to reuse materials for performance
const materialCache = {};

/**
 * Initializes the 3D scene.
 * @param {HTMLCanvasElement} canvas - Canvas element to render into
 * @param {number} size - Outer radius size of the hexagons
 */
export function initRenderer(canvas, size) {
  hexSize = size;

  // 1. Create Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111216); // Sleek dark space background

  // 2. Setup Camera
  camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.position.set(0, 10, 12); // Positioned above and looking down

  // 3. Setup Renderer
  renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: true,
    alpha: false
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // 4. Setup Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.maxPolarAngle = Math.PI / 2 - 0.05; // Don't go below the ground plane
  controls.minDistance = 1;
  controls.maxDistance = 100;
  controls.screenSpacePanning = false; // Left click pan stays on horizontal XZ plane (fixed elevation)
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.PAN,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.ROTATE
  };

  // 5. Setup Lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(10, 20, 10);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  dirLight.shadow.bias = -0.001;
  const d = 15;
  dirLight.shadow.camera.left = -d;
  dirLight.shadow.camera.right = d;
  dirLight.shadow.camera.top = d;
  dirLight.shadow.camera.bottom = -d;
  dirLight.shadow.camera.near = 0.1;
  dirLight.shadow.camera.far = 40;
  scene.add(dirLight);

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.4);
  hemiLight.position.set(0, 200, 0);
  scene.add(hemiLight);

  // Group to hold all hexes
  hexGroup = new THREE.Group();
  scene.add(hexGroup);

  // Selection Hover Highlight Mesh
  const highlightGeometry = new THREE.CylinderGeometry(hexSize * 0.98, hexSize * 0.98, 0.05, 6);
  const highlightMaterial = new THREE.MeshBasicMaterial({
    color: 0xffff00,
    transparent: true,
    opacity: 0.4,
    side: THREE.DoubleSide
  });
  highlightMesh = new THREE.Mesh(highlightGeometry, highlightMaterial);
  highlightMesh.visible = false;
  scene.add(highlightMesh);

  // Entity Selection Ring Mesh (Animated cyan ring)
  const entityRingGeom = new THREE.RingGeometry(0.42, 0.54, 32);
  entityRingGeom.rotateX(-Math.PI / 2);
  const entityRingMat = new THREE.MeshBasicMaterial({
    color: 0x00ffff,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85
  });
  entitySelectionMesh = new THREE.Mesh(entityRingGeom, entityRingMat);
  entitySelectionMesh.visible = false;
  scene.add(entitySelectionMesh);

  // Window & Keyboard Listeners
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // Start animation loop
  clock.start();
  animate();
}

let entitySelectionMesh = null;
const keysPressed = {};

function onKeyDown(event) {
  // Ignore keyboard shortcuts if user is typing in an input/textarea
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  keysPressed[event.code] = true;
  keysPressed[event.key] = true;
}

function onKeyUp(event) {
  keysPressed[event.code] = false;
  keysPressed[event.key] = false;
}

/**
 * Handles window resize events.
 */
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

/**
 * Main animation and render loop.
 */
function animate() {
  requestAnimationFrame(animate);

  const deltaTime = clock.getDelta();

  // WASD (Pan) and Q/E (Rotate) Camera Movement
  if (controls) {
    const speed = 15 * deltaTime;
    const rotSpeed = 2.0 * deltaTime;

    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    const right = new THREE.Vector3();
    right.crossVectors(forward, camera.up).normalize();

    const moveVector = new THREE.Vector3();
    if (keysPressed['KeyW'] || keysPressed['w'] || keysPressed['W']) moveVector.addScaledVector(forward, speed);
    if (keysPressed['KeyS'] || keysPressed['s'] || keysPressed['S']) moveVector.addScaledVector(forward, -speed);
    if (keysPressed['KeyD'] || keysPressed['d'] || keysPressed['D']) moveVector.addScaledVector(right, speed);
    if (keysPressed['KeyA'] || keysPressed['a'] || keysPressed['A']) moveVector.addScaledVector(right, -speed);

    if (moveVector.lengthSq() > 0) {
      camera.position.add(moveVector);
      controls.target.add(moveVector);
    }

    if (keysPressed['KeyQ'] || keysPressed['q'] || keysPressed['Q']) {
      const offset = camera.position.clone().sub(controls.target);
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotSpeed);
      camera.position.copy(controls.target).add(offset);
    }
    if (keysPressed['KeyE'] || keysPressed['e'] || keysPressed['E']) {
      const offset = camera.position.clone().sub(controls.target);
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), -rotSpeed);
      camera.position.copy(controls.target).add(offset);
    }

    controls.update();
  }

  // Animate Entity Selection Ring
  if (entitySelectionMesh && entitySelectionMesh.visible) {
    entitySelectionMesh.rotation.z += deltaTime * 1.5;
    entitySelectionMesh.material.opacity = 0.6 + 0.35 * Math.sin(clock.getElapsedTime() * 5);
  }

  if (updateCallback) {
    updateCallback(deltaTime);
  }

  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

/**
 * Helper to get or create a material for a terrain type.
 * @param {Object} terrain - terrain object
 * @returns {THREE.Material} The material
 */
function getTerrainMaterial(terrain) {
  if (materialCache[terrain.name]) {
    return materialCache[terrain.name];
  }

  const material = new THREE.MeshStandardMaterial(terrain.material);
  materialCache[terrain.name] = material;
  return material;
}

/**
 * Draws the hexagonal grid from the cell data.
 * @param {Object} cells - Dictionary of cells keyed by "q,r"
 */
export function drawGrid(cells) {
  // Clear any existing hexes
  while (hexGroup.children.length > 0) {
    const child = hexGroup.children[0];
    hexGroup.remove(child);
  }
  cellMeshMap = {};

  // For geometry reuse, we can define them per height
  const geometryCache = {};

  Object.values(cells).forEach(cell => {
    const height = cell.terrain.height;

    // Check geometry cache
    let geometry = geometryCache[height];
    if (!geometry) {
      // 6 segments creates a hexagon.
      // We scale radius slightly down (0.96) to leave a sleek gap between tiles.
      geometry = new THREE.CylinderGeometry(hexSize * 0.96, hexSize * 0.96, height, 6);
      geometryCache[height] = geometry;
    }

    const material = getTerrainMaterial(cell.terrain);
    const mesh = new THREE.Mesh(geometry, material);

    // Positioning
    const { x, z } = axialToPixel(cell.q, cell.r, hexSize);
    // Align base to Y = 0 (since default cylinder centers at height / 2)
    mesh.position.set(x, height / 2, z);

    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Attach custom data to mesh for raycasting lookup
    mesh.userData = { q: cell.q, r: cell.r, terrain: cell.terrain };

    hexGroup.add(mesh);
    cellMeshMap[`${cell.q},${cell.r}`] = mesh;
  });
}

/**
 * Highlights a specific cell or clears highlight.
 * @param {number|null} q - Axial q coordinate
 * @param {number|null} r - Axial r coordinate
 * @param {number|null} height - The height of the cell, to position highlight at top
 */
export function highlightCell(q, r, height = null) {
  if (q === null || r === null) {
    highlightMesh.visible = false;
    return;
  }

  const { x, z } = axialToPixel(q, r, hexSize);
  highlightMesh.position.set(x, height !== null ? height + 0.03 : 0.1, z);
  highlightMesh.visible = true;
}

/**
 * Casts a ray from the mouse pointer to detect which hex is hovered.
 * @param {THREE.Vector2} mouseNormalized - Mouse coordinates in [-1, 1] space
 * @returns {Object|null} Cell data under cursor or null
 */
export function raycastHex(mouseNormalized) {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouseNormalized, camera);

  const intersects = raycaster.intersectObjects(hexGroup.children);
  if (intersects.length > 0) {
    const mesh = intersects[0].object;
    return mesh.userData;
  }
  return null;
}

/**
 * Highlights a selected entity in 3D using the cyan selection ring.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 */
export function setEntitySelectionHighlight(x, y, z) {
  if (x === null || y === null || z === null) {
    clearEntitySelectionHighlight();
    return;
  }
  if (entitySelectionMesh) {
    entitySelectionMesh.position.set(x, y + 0.03, z);
    entitySelectionMesh.visible = true;
  }
}

/**
 * Clears the 3D entity selection highlight.
 */
export function clearEntitySelectionHighlight() {
  if (entitySelectionMesh) {
    entitySelectionMesh.visible = false;
  }
}

