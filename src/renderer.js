import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { HexGrid } from './hexGrid.js';
import { CONFIG } from './config.js';

export let scene, camera, renderer, controls;
export let dirLight, hemiLight, sky, sunMesh;
let hexGroup;
let cellMeshMap = {}; // Maps "q,r" to Mesh object
let highlightMesh = null; // Mesh to show selection/hover highlight
let pathHighlightGroup = null; // Group of meshes showing action path preview
let pathHighlightGeometry = null;
let pathHighlightMaterial = null;
let entitySelectionMesh = null; // Selection ring around active entity
let groundBaseMesh = null;

// State tracking for time of day (0 to 24)
let currentHour = 12; // Starts at Noon

const sunDirection = new THREE.Vector3();

// Time-of-Day Keyframes: Defines lighting atmosphere and color temperatures
const TIME_KEYFRAMES = [
  { hour: 0, color: 0x112244, intensity: 0.05, hemiSky: 0x081122, hemiGround: 0x020205 }, // Midnight
  { hour: 5, color: 0x332255, intensity: 0.10, hemiSky: 0x1a0f2e, hemiGround: 0x050208 }, // Pre-dawn
  { hour: 6, color: 0xff7733, intensity: 0.60, hemiSky: 0xffaa77, hemiGround: 0x110802 }, // Sunrise
  { hour: 7, color: 0xffcc66, intensity: 1.00, hemiSky: 0xffeedd, hemiGround: 0x111108 }, // Early Morning
  { hour: 12, color: 0xfffaed, intensity: 1.50, hemiSky: 0xddeeff, hemiGround: 0x110c05 }, // Noon
  { hour: 17, color: 0xffbb55, intensity: 1.10, hemiSky: 0xffddaa, hemiGround: 0x110a05 }, // Late Afternoon
  { hour: 18, color: 0xff4422, intensity: 0.60, hemiSky: 0xff7755, hemiGround: 0x110300 }, // Sunset
  { hour: 19, color: 0x442255, intensity: 0.15, hemiSky: 0x1a092b, hemiGround: 0x050208 }, // Dusk
  { hour: 24, color: 0x112244, intensity: 0.05, hemiSky: 0x081122, hemiGround: 0x020205 }  // Midnight (Wrap)
];

// Active Effect Animations
const activeEffects = [];

// GLTF model caching and entity mesh map
const modelCache = {};
const entityMeshMap = {}; // Maps entity.id -> Three.js Group
let gltfLoader = null;

// Material caches to reuse materials for performance
const materialCache = {};
const desaturatedMaterialCache = {};

const hiddenTerrain = {
  material: new THREE.MeshStandardMaterial({ color: 0x212121, roughness: 0.4, metalness: 0.5, transparent: true, opacity: 0.7, flatShading: true }),
  height: 3
};

const cellSizeScale = {
  normal: 1,
  highlight: 0.98,
  path: 0.85,
  selectionRing: { inner: 0.8, outer: 1 },
  ownerRing: { inner: 0.6, outer: 0.8 }
}

// Animation & Update hooks
let updateCallback = null;
const clock = new THREE.Clock();

export function setUpdateCallback(cb) {
  updateCallback = cb;
}

/**
 * Initializes the 3D scene, camera, lights, skybox, orbit controls, and loaders.
 * @param {HTMLCanvasElement} canvas - Canvas element to render into
 */
export function initRenderer(canvas) {
  // 1. Setup Scene
  scene = new THREE.Scene();

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

  // 5. Setup Lighting (Single HemisphereLight + Directional Sun)
  hemiLight = new THREE.HemisphereLight(0xddeeff, 0x221100, 0.4);
  hemiLight.position.set(0, 50, 0);
  scene.add(hemiLight);

  dirLight = new THREE.DirectionalLight(0xfffaed, 1.2);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  dirLight.shadow.bias = -0.0001;
  dirLight.shadow.normalBias = 0.02;

  const d = 35;
  dirLight.shadow.camera.left = -d;
  dirLight.shadow.camera.right = d;
  dirLight.shadow.camera.top = d;
  dirLight.shadow.camera.bottom = -d;
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 150;
  scene.add(dirLight);
  scene.add(dirLight.target);

  // 6. Setup Procedural Sky & Sun Mesh
  sky = new Sky();
  sky.scale.setScalar(450000);
  scene.add(sky);

  const skyUniforms = sky.material.uniforms;
  skyUniforms['turbidity'].value = 8;
  skyUniforms['rayleigh'].value = 1.2;
  skyUniforms['mieCoefficient'].value = 0.005;
  skyUniforms['mieDirectionalG'].value = 0.8;

  const sunGeo = new THREE.SphereGeometry(2.5, 32, 32);
  const sunMat = new THREE.MeshBasicMaterial({ color: 0xfff5cc });
  sunMesh = new THREE.Mesh(sunGeo, sunMat);
  scene.add(sunMesh);

  // Set initial time of day
  setTimeOfDay(currentHour);

  // 7. Groups & Overlays
  hexGroup = new THREE.Group();
  scene.add(hexGroup);

  // Hover Highlight Mesh
  const highlightGeometry = new THREE.CylinderGeometry(CONFIG.HEX_SIZE * cellSizeScale.highlight, CONFIG.HEX_SIZE * cellSizeScale.highlight, 0.05, 6);
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
  pathHighlightGeometry = new THREE.CylinderGeometry(CONFIG.HEX_SIZE * cellSizeScale.path, CONFIG.HEX_SIZE * cellSizeScale.path, 0.04, 6);
  pathHighlightMaterial = new THREE.MeshBasicMaterial({
    color: 0xa78bfa,
    transparent: true,
    opacity: 0.4,
    side: THREE.DoubleSide
  });

  // Entity Selection Ring Mesh
  const entityRingGeom = new THREE.RingGeometry(CONFIG.HEX_SIZE * cellSizeScale.selectionRing.inner, CONFIG.HEX_SIZE * cellSizeScale.selectionRing.outer, 16);
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

  // 8. Setup Loaders
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

/**
 * Creates or updates a dark ground base beneath the hex grid to block skybox bleed
 * through semi-transparent tiles (like oceans).
 * @param {number} radius - Outer spatial radius of the hex map
 */
export function updateGroundBase(radius) {
  if (groundBaseMesh) {
    scene.remove(groundBaseMesh);
    groundBaseMesh.geometry.dispose();
    groundBaseMesh.material.dispose();
  }

  // Create a flat circular plate
  const geometry = new THREE.CylinderGeometry(radius, radius, 1, 6);
  geometry.rotateY(Math.PI / 6);

  // Dark slate/seabed material
  const material = new THREE.MeshStandardMaterial({
    color: 0x050811, // Deep ocean floor / dark slate
    roughness: 0.9,
    metalness: 0.1
  });

  groundBaseMesh = new THREE.Mesh(geometry, material);
  // Position slightly below Y=0 so hex tops/sides sit cleanly on top
  groundBaseMesh.position.set(0, -0.5, 0);
  groundBaseMesh.receiveShadow = true;

  scene.add(groundBaseMesh);
}

export function setTimeOfDay(hour) {
  currentHour = hour % 24;
  if (currentHour < 0) currentHour += 24;

  // 1. Calculate normalized direction vector towards the sun
  const angle = ((currentHour - 6) / 24) * Math.PI * 2;
  sunDirection.set(
    Math.cos(angle),
    Math.sin(angle),
    Math.cos(angle) * 0.3 // Seasonal inclination tilt
  ).normalize();

  // 2. Position Sun Mesh relative to CAMERA position to eliminate parallax offset
  if (sunMesh && camera) {
    sunMesh.position.copy(camera.position).addScaledVector(sunDirection, 400);
  }

  // 3. Position Directional Light relative to camera focus target
  const targetPos = controls ? controls.target : new THREE.Vector3(0, 0, 0);
  dirLight.position.copy(targetPos).addScaledVector(sunDirection, 80);
  dirLight.target.position.copy(targetPos);
  dirLight.target.updateMatrixWorld();

  // 4. Update Sky Shader (expects a direction vector)
  if (sky) {
    sky.material.uniforms['sunPosition'].value.copy(sunDirection);
  }

  // 5. Interpolate keyframe colors & intensities
  let prevFrame = TIME_KEYFRAMES[0];
  let nextFrame = TIME_KEYFRAMES[TIME_KEYFRAMES.length - 1];

  for (let i = 0; i < TIME_KEYFRAMES.length - 1; i++) {
    if (currentHour >= TIME_KEYFRAMES[i].hour && currentHour <= TIME_KEYFRAMES[i + 1].hour) {
      prevFrame = TIME_KEYFRAMES[i];
      nextFrame = TIME_KEYFRAMES[i + 1];
      break;
    }
  }

  const range = nextFrame.hour - prevFrame.hour;
  const factor = range > 0 ? (currentHour - prevFrame.hour) / range : 0;

  const targetColor = new THREE.Color(prevFrame.color).lerp(new THREE.Color(nextFrame.color), factor);
  dirLight.color.copy(targetColor);
  dirLight.intensity = THREE.MathUtils.lerp(prevFrame.intensity, nextFrame.intensity, factor);

  if (hemiLight) {
    const skyCol = new THREE.Color(prevFrame.hemiSky).lerp(new THREE.Color(nextFrame.hemiSky), factor);
    const groundCol = new THREE.Color(prevFrame.hemiGround).lerp(new THREE.Color(nextFrame.hemiGround), factor);
    hemiLight.color.copy(skyCol);
    hemiLight.groundColor.copy(groundCol);
  }

  dirLight.castShadow = Math.sin(angle) > -0.2;
}

/**
 * Smoothly animates the time of day from the current hour to a target hour.
 * @param {number} targetHour - Destination time of day (0 to 24)
 * @param {number} duration - Animation speed in seconds (default 1.5s)
 * @param {Function} onComplete - Optional callback when animation finishes
 */
export function animateToTimeOfDay(targetHour, duration = 1.5, onComplete = null) {
  const startHour = currentHour;
  let endHour = targetHour;

  // Handle forward progression across midnight (e.g. moving from 18 to 6 next morning)
  if (endHour <= startHour) {
    endHour += 24;
  }

  let elapsed = 0;

  activeEffects.push({
    update: (dt) => {
      elapsed += dt;
      const progress = Math.min(elapsed / duration, 1.0);
      const easeProgress = progress * progress * (3 - 2 * progress); // Smoothstep easing

      const animatedHour = THREE.MathUtils.lerp(startHour, endHour, easeProgress);
      setTimeOfDay(animatedHour);

      if (progress >= 1.0) {
        currentHour = targetHour % 24;
        if (onComplete) onComplete();
        return false;
      }
      return true;
    }
  });
}

/**
 * Visual Effects Manager Loop.
 */
function updateEffects(deltaTime) {
  for (let i = activeEffects.length - 1; i >= 0; i--) {
    const alive = activeEffects[i].update(deltaTime);
    if (!alive) {
      if (activeEffects[i].object) {
        scene.remove(activeEffects[i].object);
      }
      activeEffects.splice(i, 1);
    }
  }
}

// --- Visual Effect Triggers ---

export function playSpawnAnimation(entityMeshGroup) {
  let progress = 0;
  const duration = 0.5;
  entityMeshGroup.scale.set(0, 0, 0);

  activeEffects.push({
    object: null,
    update: (dt) => {
      progress += dt / duration;
      if (progress >= 1) {
        entityMeshGroup.scale.set(1, 1, 1);
        return false;
      }
      const scale = Math.sin(progress * Math.PI * 0.5) * (1 + 0.2 * Math.sin(progress * Math.PI));
      entityMeshGroup.scale.set(scale, scale, scale);
      return true;
    }
  });
}

export function spawnDamageText(x, y, z, amount) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ff2222';
  ctx.font = 'Bold 42px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(`-${amount}`, 64, 48);

  const texture = new THREE.CanvasTexture(canvas);
  const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.position.set(x, y + 1.2, z);
  sprite.scale.set(1.5, 0.75, 1);
  scene.add(sprite);

  let elapsed = 0;
  const duration = 1.0;

  activeEffects.push({
    object: sprite,
    update: (dt) => {
      elapsed += dt;
      sprite.position.y += dt * 1.2;
      spriteMat.opacity = 1.0 - (elapsed / duration);
      return elapsed < duration;
    }
  });
}

export function spawnParticleBurst(x, y, z, colorHex = 0xffaa00) {
  const count = 20;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const velocities = [];

  for (let i = 0; i < count; i++) {
    positions[i * 3] = x;
    positions[i * 3 + 1] = y + 0.5;
    positions[i * 3 + 2] = z;

    velocities.push(new THREE.Vector3(
      (Math.random() - 0.5) * 3,
      Math.random() * 4 + 1,
      (Math.random() - 0.5) * 3
    ));
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ color: colorHex, size: 0.15, transparent: true });
  const pSystem = new THREE.Points(geometry, material);
  scene.add(pSystem);

  let elapsed = 0;
  activeEffects.push({
    object: pSystem,
    update: (dt) => {
      elapsed += dt;
      const posArr = pSystem.geometry.attributes.position.array;
      for (let i = 0; i < count; i++) {
        posArr[i * 3] += velocities[i].x * dt;
        posArr[i * 3 + 1] += velocities[i].y * dt;
        posArr[i * 3 + 2] += velocities[i].z * dt;
        velocities[i].y -= 9.8 * dt;
      }
      pSystem.geometry.attributes.position.needsUpdate = true;
      material.opacity = 1.0 - (elapsed / 0.8);
      return elapsed < 0.8;
    }
  });
}

// --- Engine Controls & Input Loops ---

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

function animate() {
  requestAnimationFrame(animate);

  const deltaTime = clock.getDelta();

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
    if (keysPressed['KeyW'] || keysPressed['w']) moveVector.addScaledVector(forward, speed);
    if (keysPressed['KeyS'] || keysPressed['s']) moveVector.addScaledVector(forward, -speed);
    if (keysPressed['KeyD'] || keysPressed['d']) moveVector.addScaledVector(right, speed);
    if (keysPressed['KeyA'] || keysPressed['a']) moveVector.addScaledVector(right, -speed);

    if (moveVector.lengthSq() > 0) {
      camera.position.add(moveVector);
      controls.target.add(moveVector);
    }

    if (keysPressed['KeyQ'] || keysPressed['q']) {
      const offset = camera.position.clone().sub(controls.target);
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotSpeed);
      camera.position.copy(controls.target).add(offset);
    }
    if (keysPressed['KeyE'] || keysPressed['e']) {
      const offset = camera.position.clone().sub(controls.target);
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), -rotSpeed);
      camera.position.copy(controls.target).add(offset);
    }

    controls.update();

    // Keep Sun Mesh aligned with camera viewpoint (eliminates parallax)
    if (sunMesh && camera) {
      sunMesh.position.copy(camera.position).addScaledVector(sunDirection, 400);
    }

    // Keep Directional Light centered over current camera target for accurate shadows
    if (dirLight) {
      dirLight.position.copy(controls.target).addScaledVector(sunDirection, 80);
      dirLight.target.position.copy(controls.target);
      dirLight.target.updateMatrixWorld();
    }
  }

  // Update animated effects
  updateEffects(deltaTime);

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

// --- Grid & Model Utilities ---

function getTerrainMaterial(terrain) {
  if (materialCache[terrain.name]) return materialCache[terrain.name];
  const material = new THREE.MeshStandardMaterial(terrain.material);
  materialCache[terrain.name] = material;
  return material;
}

function getDesaturatedTerrainMaterial(terrain) {
  if (desaturatedMaterialCache[terrain.name]) return desaturatedMaterialCache[terrain.name];

  const baseMatProps = { ...terrain.material };
  const baseColor = new THREE.Color(baseMatProps.color || 0x888888);

  const hsl = { h: 0, s: 0, l: 0 };
  baseColor.getHSL(hsl);
  baseColor.setHSL(hsl.h, hsl.s * 0.15, hsl.l * 0.45);

  const material = new THREE.MeshStandardMaterial({ ...baseMatProps, color: baseColor });
  desaturatedMaterialCache[terrain.name] = material;
  return material;
}

export function drawGrid(cells, activePlayer = null) {
  while (hexGroup.children.length > 0) {
    hexGroup.remove(hexGroup.children[0]);
  }
  cellMeshMap = {};
  const geometryCache = {};

  let maxDistanceSq = 0;

  Object.values(cells).forEach(cell => {
    const isExplored = activePlayer ? activePlayer.isExplored(cell.q, cell.r) : true;
    const isVisible = activePlayer ? activePlayer.isVisible(cell.q, cell.r) : true;

    let height = cell.terrain.height;
    let material;

    if (!isExplored) {
      height = hiddenTerrain.height;
      material = hiddenTerrain.material;
    } else if (!isVisible) {
      height = cell.terrain.height;
      material = getDesaturatedTerrainMaterial(cell.terrain);
    } else {
      height = cell.terrain.height;
      material = getTerrainMaterial(cell.terrain);
    }

    let geometry = geometryCache[height];
    if (!geometry) {
      geometry = new THREE.CylinderGeometry(CONFIG.HEX_SIZE * cellSizeScale.normal, CONFIG.HEX_SIZE * cellSizeScale.normal, height, 6);
      geometryCache[height] = geometry;
    }

    const mesh = new THREE.Mesh(geometry, material);
    const { x, z } = HexGrid.axialToPixel(cell.q, cell.r);
    mesh.position.set(x, height / 2, z);

    const distSq = x * x + z * z;
    if (distSq > maxDistanceSq) maxDistanceSq = distSq;

    if (isExplored) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }

    mesh.userData = { q: cell.q, r: cell.r, terrain: cell.terrain, isExplored, isVisible };
    cell.mesh = mesh;

    hexGroup.add(mesh);
    cellMeshMap[`${cell.q},${cell.r}`] = mesh;
  });

  // Automatically update dark ground bed based on map extent
  const maxMapRadius = Math.sqrt(maxDistanceSq) + CONFIG.HEX_SIZE;
  updateGroundBase(maxMapRadius);
}

export async function preloadModels(entityMetadata) {
  console.log("Preloading GLTF models...");
  const promises = Object.values(entityMetadata).map(entity => {
    return new Promise((resolve) => {
      if (!entity.modelUrl) { resolve(); return; }

      gltfLoader.load(
        entity.modelUrl,
        (gltf) => {
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

export function reconcileEntities(gameState) {
  const activeIds = new Set();
  const activePlayer = gameState.activePlayer;

  gameState.entities.forEach(entity => {
    const isVisibleToActivePlayer = activePlayer ? activePlayer.isVisible(entity.q, entity.r) : true;
    const isOwnedByActivePlayer = activePlayer && entity.owner && entity.owner.id === activePlayer.id;
    const isEntityVisibleInScene = isOwnedByActivePlayer ? (activePlayer ? activePlayer.isExplored(entity.q, entity.r) : true) : isVisibleToActivePlayer;

    if (isEntityVisibleInScene) {
      activeIds.add(entity.id);

      const cell = entity.cell || gameState.cells[`${entity.q},${entity.r}`];
      const terrainHeight = cell && cell.terrain ? cell.terrain.height : 1.0;
      const { x, z } = HexGrid.axialToPixel(entity.q, entity.r);

      const facingRot = FACING_ROTATIONS[entity.facing] || 0;
      const rotOffset = THREE.MathUtils.degToRad(entity.rotationOffset) || 0;
      const totalRotationY = facingRot + rotOffset;

      if (!entityMeshMap[entity.id]) {
        spawnEntityMesh(entity, gameState, x, terrainHeight, z, totalRotationY);
      } else {
        const meshGroup = entityMeshMap[entity.id];
        meshGroup.position.set(x, terrainHeight, z);
        meshGroup.rotation.y = totalRotationY;
      }
    }
  });

  for (const id in entityMeshMap) {
    if (!activeIds.has(id)) {
      const meshGroup = entityMeshMap[id];
      if (meshGroup) scene.remove(meshGroup);
      delete entityMeshMap[id];
    }
  }
}

function spawnEntityMesh(entity, gameState, x, terrainHeight, z, rotationY) {
  const meta = gameState.manifestData ? gameState.manifestData.entities[entity.name] : null;
  const group = new THREE.Group();
  group.rotation.y = rotationY;

  if (entity.owner) {
    const colorHex = entity.owner.color || '#ffffff';
    const ringGeom = new THREE.RingGeometry(CONFIG.HEX_SIZE * cellSizeScale.ownerRing.inner, CONFIG.HEX_SIZE * cellSizeScale.ownerRing.outer, 16);
    ringGeom.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(colorHex), side: THREE.DoubleSide });
    const ringMesh = new THREE.Mesh(ringGeom, ringMat);
    ringMesh.position.y = 0.01;
    group.add(ringMesh);
  }

  const modelUrl = meta ? meta.modelUrl : null;
  const originalScene = modelUrl ? modelCache[modelUrl] : null;

  if (originalScene) {
    const modelClone = originalScene.clone();
    const box = new THREE.Box3().setFromObject(modelClone);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const targetSize = (meta && meta.size) ? meta.size : 1;
    const scale = CONFIG.HEX_SIZE * targetSize / (maxDim || 1);
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

  // Trigger pop-in scale animation when spawned
  playSpawnAnimation(group);
}

export function clearEntityMeshes() {
  for (const id in entityMeshMap) {
    if (entityMeshMap[id]) scene.remove(entityMeshMap[id]);
  }
  for (const key in entityMeshMap) {
    delete entityMeshMap[key];
  }
}

export function highlightCell(q, r, height = null) {
  if (q === null || r === null) {
    highlightMesh.visible = false;
    return;
  }
  const { x, z } = HexGrid.axialToPixel(q, r);
  highlightMesh.position.set(x, height !== null ? height + CONFIG.HEX_SIZE / 20 : CONFIG.HEX_SIZE / 10, z);
  highlightMesh.visible = true;
}

export function highlightPathCells(cells) {
  clearPathHighlight();
  if (!cells || cells.length === 0 || !pathHighlightGroup) return;

  for (const cell of cells) {
    const mesh = new THREE.Mesh(pathHighlightGeometry, pathHighlightMaterial);
    const { x, z } = HexGrid.axialToPixel(cell.q, cell.r);
    const height = cell.terrain ? cell.terrain.height : 1.0;
    mesh.position.set(x, height + CONFIG.HEX_SIZE / 25, z);
    pathHighlightGroup.add(mesh);
  }
}

export function clearPathHighlight() {
  if (!pathHighlightGroup) return;
  while (pathHighlightGroup.children.length > 0) {
    pathHighlightGroup.remove(pathHighlightGroup.children[0]);
  }
}

export function raycastHex(mouseNormalized) {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouseNormalized, camera);
  const intersects = raycaster.intersectObjects(hexGroup.children);
  if (intersects.length > 0) {
    return intersects[0].object.userData;
  }
  return null;
}

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