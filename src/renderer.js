import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { HexGrid } from './hexGrid.js';

export let scene, camera, renderer, controls;
let hexGroup;
let cellMeshMap = {}; // Maps "q,r" to Mesh object
let highlightMesh = null; // Mesh to show selection/hover highlight
let pathHighlightGroup = null; // Group of meshes showing action path preview
let pathHighlightGeometry = null;
let pathHighlightMaterial = null;
let entitySelectionMesh = null; // Selection ring around active entity
export let hexSize = 1.0;

// GLTF model caching and entity mesh map
const modelCache = {};
const entityMeshMap = {}; // Maps entity.id -> Three.js Group
let gltfLoader = null;

// Material caches to reuse materials for performance
const materialCache = {};
const desaturatedMaterialCache = {};

const hiddenTerrain = {
  material: new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5, metalness: 0.1, transparent: true, opacity: 0.5, flatShading: true }),
  height: 3
};

// Animation & Update hooks
let updateCallback = null;
const clock = new THREE.Clock();

export function setUpdateCallback(cb) {
  updateCallback = cb;
}

/**
 * Initializes the 3D scene, camera, lights, orbit controls, and loaders.
 * @param {HTMLCanvasElement} canvas - Canvas element to render into
 * @param {number} size - Outer radius size of the hexagons
 */
export function initRenderer(canvas, size) {
  hexSize = size;

  // 1. Setup Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111216); // Dark space background

  // 2. Setup Camera
  camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.position.set(0, 10, 12);

  // 3. Setup WebGL Renderer
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
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.minDistance = 1;
  controls.maxDistance = 100;
  controls.screenSpacePanning = false;
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

  // Group to hold hex tiles
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

  pathHighlightGroup = new THREE.Group();
  scene.add(pathHighlightGroup);
  pathHighlightGeometry = new THREE.CylinderGeometry(hexSize * 0.85, hexSize * 0.85, 0.04, 6);
  pathHighlightMaterial = new THREE.MeshBasicMaterial({
    color: 0xa78bfa,
    transparent: true,
    opacity: 0.4,    
    side: THREE.DoubleSide
  });

  // Entity Selection Ring Mesh (Animated cyan ring)
  const entityRingGeom = new THREE.RingGeometry(hexSize * 0.8, hexSize * 1, 16);
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

  // 6. Setup DRACO & GLTF Loaders
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath('https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/gltf/');

  gltfLoader = new GLTFLoader();
  gltfLoader.setDRACOLoader(dracoLoader);

  // Listeners
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // Start Animation Loop
  clock.start();
  animate();
}

const keysPressed = {};

function onKeyDown(event) {
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  keysPressed[event.code] = true;
  keysPressed[event.key] = true;
}

function onKeyUp(event) {
  keysPressed[event.code] = false;
  keysPressed[event.key] = false;
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

/**
 * Main animation loop.
 */
function animate() {
  requestAnimationFrame(animate);

  const deltaTime = clock.getDelta();

  // WASD Pan & Q/E Rotate
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

  // Animate selection ring
  if (entitySelectionMesh && entitySelectionMesh.visible) {
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
 * Helper to get or create material for normal terrain.
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
 * Helper to get or create a desaturated material for explored, non-visible terrain.
 */
function getDesaturatedTerrainMaterial(terrain) {
  if (desaturatedMaterialCache[terrain.name]) {
    return desaturatedMaterialCache[terrain.name];
  }

  const baseMatProps = { ...terrain.material };
  const baseColor = new THREE.Color(baseMatProps.color || 0x888888);

  const hsl = { h: 0, s: 0, l: 0 };
  baseColor.getHSL(hsl);
  baseColor.setHSL(hsl.h, hsl.s * 0.15, hsl.l * 0.45);

  const material = new THREE.MeshStandardMaterial({
    ...baseMatProps,
    color: baseColor
  });

  desaturatedMaterialCache[terrain.name] = material;
  return material;
}

/**
 * Draws the 3D hexagonal grid from cell data, accounting for active player's Fog of War visibility.
 * @param {Object} cells - Map of cells keyed by "q,r"
 * @param {Player|null} activePlayer - Currently active viewing player
 */
export function drawGrid(cells, activePlayer = null) {
  while (hexGroup.children.length > 0) {
    const child = hexGroup.children[0];
    hexGroup.remove(child);
  }
  cellMeshMap = {};

  const geometryCache = {};

  Object.values(cells).forEach(cell => {
    const isExplored = activePlayer ? activePlayer.isExplored(cell.q, cell.r) : true;
    const isVisible = activePlayer ? activePlayer.isVisible(cell.q, cell.r) : true;

    let height = cell.terrain.height;
    let material;

    if (!isExplored) {
      // Fully hidden unexplored tile
      height = hiddenTerrain.height;
      material = hiddenTerrain.material;
    } else if (!isVisible) {
      // Explored but non-visible tile (fog of war desaturated)
      height = cell.terrain.height;
      material = getDesaturatedTerrainMaterial(cell.terrain);
    } else {
      // Explored and currently visible tile
      height = cell.terrain.height;
      material = getTerrainMaterial(cell.terrain);
    }

    let geometry = geometryCache[height];
    if (!geometry) {
      geometry = new THREE.CylinderGeometry(hexSize * 0.96, hexSize * 0.96, height, 6);
      geometryCache[height] = geometry;
    }

    const mesh = new THREE.Mesh(geometry, material);

    const { x, z } = HexGrid.axialToPixel(cell.q, cell.r, hexSize);
    mesh.position.set(x, height / 2, z);

    mesh.castShadow = true;
    mesh.receiveShadow = true;

    mesh.userData = {
      q: cell.q,
      r: cell.r,
      terrain: cell.terrain,
      isExplored: isExplored,
      isVisible: isVisible
    };

    cell.mesh = mesh;

    hexGroup.add(mesh);
    cellMeshMap[`${cell.q},${cell.r}`] = mesh;
  });
}

/**
 * Preloads all GLTF models defined in entity metadata in parallel.
 * @param {Object} entityMetadata - Preloaded entity metadata map
 */
export async function preloadModels(entityMetadata) {
  console.log("Preloading GLTF models...");
  const promises = Object.values(entityMetadata).map(entity => {
    return new Promise((resolve) => {
      if (!entity.modelUrl) {
        resolve();
        return;
      }

      gltfLoader.load(
        entity.modelUrl,
        (gltf) => {
          console.log(`Preloaded 3D model for: ${entity.name}`);
          modelCache[entity.modelUrl] = gltf.scene;
          resolve();
        },
        undefined,
        (err) => {
          console.error(`Failed to load GLTF model for "${entity.name}" from ${entity.modelUrl}:`, err);
          resolve();
        }
      );
    });
  });

  await Promise.all(promises);
  console.log("GLTF model preloading complete.");
}

const FACING_ROTATIONS = {
  E: 0,
  NE: Math.PI / 3,
  NW: (2 * Math.PI) / 3,
  W: Math.PI,
  SW: -(2 * Math.PI) / 3,
  SE: -Math.PI / 3
};

/**
 * Reconciles 3D meshes for entities in GameState.
 * Only renders entities that are visible to the active player.
 * Applies entity.rotationOffset to GLB mesh rotation.
 * @param {GameState} gameState
 */
export function reconcileEntities(gameState) {
  const activeIds = new Set();
  const activePlayer = gameState.activePlayer;

  gameState.entities.forEach(entity => {
    // Fog of war check: is entity visible to active player?
    const isVisibleToActivePlayer = activePlayer ? activePlayer.isVisible(entity.q, entity.r) : true;
    const isOwnedByActivePlayer = activePlayer && entity.owner && entity.owner.id === activePlayer.id;

    // Show owned entities on explored cells, and other entities ONLY on visible cells
    const isEntityVisibleInScene = isOwnedByActivePlayer ? (activePlayer ? activePlayer.isExplored(entity.q, entity.r) : true) : isVisibleToActivePlayer;

    if (isEntityVisibleInScene) {
      activeIds.add(entity.id);

      const cell = entity.cell || gameState.cells[`${entity.q},${entity.r}`];
      const terrainHeight = cell && cell.terrain ? cell.terrain.height : 1.0;
      const { x, z } = HexGrid.axialToPixel(entity.q, entity.r, hexSize);

      const facingRot = FACING_ROTATIONS[entity.facing] || 0;
      const rotOffset = THREE.MathUtils.degToRad(entity.rotationOffset) || 0;
      const totalRotationY = facingRot + rotOffset;

      if (!entityMeshMap[entity.id]) {
        // Spawn new 3D mesh
        spawnEntityMesh(entity, gameState, x, terrainHeight, z, totalRotationY);
      } else {
        // Update position and rotation of existing mesh
        const meshGroup = entityMeshMap[entity.id];
        meshGroup.position.set(x, terrainHeight, z);
        meshGroup.rotation.y = totalRotationY;
      }
    }
  });

  // Remove meshes of entities that no longer exist or are hidden by Fog of War
  for (const id in entityMeshMap) {
    if (!activeIds.has(id)) {
      const meshGroup = entityMeshMap[id];
      if (meshGroup) {
        scene.remove(meshGroup);
      }
      delete entityMeshMap[id];
    }
  }
}

/**
 * Helper to spawn 3D visual group for an entity.
 */
function spawnEntityMesh(entity, gameState, x, terrainHeight, z, rotationY) {
  const meta = gameState.manifestData ? gameState.manifestData.entities[entity.name] : null;

  const group = new THREE.Group();
  group.rotation.y = rotationY;

  // 1. Draw Player-Colored Base Ring
  if (entity.owner) {
    const colorHex = entity.owner.color || '#ffffff';
    const ringGeom = new THREE.RingGeometry(hexSize * 0.6, hexSize * 0.8, 16);
    ringGeom.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(colorHex),
      side: THREE.DoubleSide
    });
    const ringMesh = new THREE.Mesh(ringGeom, ringMat);
    ringMesh.position.y = 0.01;
    group.add(ringMesh);
  }

  // 2. Add GLTF model geometry or fallback box
  const modelUrl = meta ? meta.modelUrl : null;
  const originalScene = modelUrl ? modelCache[modelUrl] : null;

  if (originalScene) {
    const modelClone = originalScene.clone();

    const box = new THREE.Box3().setFromObject(modelClone);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const targetSize = (meta && meta.size) ? meta.size : 1;
    const scale = hexSize * targetSize / (maxDim || 1);
    modelClone.scale.set(scale, scale, scale);

    const localBox = new THREE.Box3().setFromObject(modelClone);
    modelClone.position.y = -localBox.min.y;

    modelClone.traverse(node => {
      if (node.isMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });

    group.add(modelClone);
  } else {
    // Fallback block
    const geom = new THREE.BoxGeometry(0.3, 0.3, 0.3);
    const color = entity.owner ? entity.owner.color : '#cccccc';
    const mat = new THREE.MeshStandardMaterial({ color: color });
    const fallbackMesh = new THREE.Mesh(geom, mat);
    fallbackMesh.position.y = 0.15;
    group.add(fallbackMesh);
  }

  group.position.set(x, terrainHeight, z);
  entityMeshMap[entity.id] = group;
  scene.add(group);
}

/**
 * Clears all entity meshes from Three.js scene.
 */
export function clearEntityMeshes() {
  for (const id in entityMeshMap) {
    const meshGroup = entityMeshMap[id];
    if (meshGroup) {
      scene.remove(meshGroup);
    }
  }
  for (const key in entityMeshMap) {
    delete entityMeshMap[key];
  }
}

/**
 * Highlights a specific cell under cursor.
 */
export function highlightCell(q, r, height = null) {
  if (q === null || r === null) {
    highlightMesh.visible = false;
    return;
  }

  const { x, z } = HexGrid.axialToPixel(q, r, hexSize);
  highlightMesh.position.set(x, height !== null ? height + hexSize/20 : hexSize/10, z);
  highlightMesh.visible = true;
}

/**
 * Highlights hex cells along an action path (e.g. move preview).
 */
export function highlightPathCells(cells) {
  clearPathHighlight();
  if (!cells || cells.length === 0 || !pathHighlightGroup) return;

  for (const cell of cells) {
    const mesh = new THREE.Mesh(pathHighlightGeometry, pathHighlightMaterial);
    const { x, z } = HexGrid.axialToPixel(cell.q, cell.r, hexSize);
    const height = cell.terrain ? cell.terrain.height : 1.0;
    mesh.position.set(x, height + hexSize/25, z);
    pathHighlightGroup.add(mesh);
  }
}

export function clearPathHighlight() {
  if (!pathHighlightGroup) return;

  while (pathHighlightGroup.children.length > 0) {
    pathHighlightGroup.remove(pathHighlightGroup.children[0]);
  }
}

/**
 * Raycasts from camera to cursor position.
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
 * Sets animated entity selection highlight ring.
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

export function clearEntitySelectionHighlight() {
  if (entitySelectionMesh) {
    entitySelectionMesh.visible = false;
  }
}
