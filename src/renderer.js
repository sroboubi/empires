import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import Stats from 'three/addons/libs/stats.module.js';
import { HexGrid } from './hexGrid.js';
import { CONFIG } from './config.js';
import { findSpawnDef, findTerrainGroup } from './resources.js';

export let scene, camera, renderer, controls;
export let dirLight, hemiLight, sky, sunMesh;
export let stats = null;
let panClampRings = Infinity; // camera-target pan limit in hex rings; set per map by setMapCameraLimits()
let shadowStaticBound = 600; // pop-free max shadow half-extent; set per map by setMapCameraLimits()
let shadowFitHalfExtent = -1; // last dynamically fitted half-extent (-1 = not yet fitted)
let shadowFitSkyHit = false; // last fit fell back to static bound (some view ray hit the sky)
let shadowDebugHelper = null;
let shadowDebugOverlay = null;
const _shadowDbgVec = new THREE.Vector3(); // scratch for the shadow debug overlay
const _fitNdc = new THREE.Vector3();
const _fitWorld = new THREE.Vector3();
const _fitDir = new THREE.Vector3();
const _fitLight = new THREE.Vector3();
const _limitOffset = new THREE.Vector3(); // scratch for camera-limit math
let hexGroup;
// Instanced hex rendering: one InstancedMesh per (terrain, fogState) bucket,
// so the whole map draws in ~dozens of draw calls instead of one per hex.
let hexBucketMeshes = new Map(); // bucketKey -> THREE.InstancedMesh
let hexUnitGeometry = null; // shared unit-height hex cylinder
let highlightMesh = null; // Mesh to show selection/hover highlight
let pathHighlightGroup = null; // Group of meshes showing action path preview
let pathHighlightGeometry = null;
let pathHighlightMaterial = null;
let entitySelectionMesh = null; // Selection ring around active entity
let groundBaseMesh = null;
let exclusionZoneGroup = null; // Group of meshes showing entity minSeparation exclusion zone
let exclusionZoneGeometry = null;

// Module-level reference to track the running time-of-day animation
let activeTimeEffect = null;

// State tracking for time of day (0 to 24)
let currentHour = 0; // Starts at Midnight

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
  // Shadow type from CONFIG.SHADOW_TYPE ('none'|'basic'|'pcf'|'pcfsoft', ?shadowtype= override)
  const _st = CONFIG.SHADOW_TYPE;
  if (_st === 'none') {
    renderer.shadowMap.enabled = false;
  } else {
    renderer.shadowMap.type = _st === 'basic' ? THREE.BasicShadowMap
      : _st === 'pcf' ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  }
  console.log(`[shadow] type: ${_st}`);

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
  // All shadow config lives in config.js and is query-param overridable through the
  // common mechanism (e.g. ?shadowmapsize=4096, ?shadowtype=none).
  dirLight.shadow.mapSize.width = CONFIG.SHADOW_MAP_SIZE;
  dirLight.shadow.mapSize.height = CONFIG.SHADOW_MAP_SIZE;
  if (CONFIG.SHADOW_TYPE === 'none') {
    renderer.shadowMap.enabled = false;
    dirLight.castShadow = false;
    console.log('[shadow] disabled via SHADOW_TYPE=none');
  } else {
    console.log(`[shadow] map size: ${CONFIG.SHADOW_MAP_SIZE}`);
  }
  if (CONFIG.SHADOW_DEBUG) {
    shadowDebugHelper = new THREE.CameraHelper(dirLight.shadow.camera);
    scene.add(shadowDebugHelper);
    shadowDebugOverlay = document.createElement('div');
    shadowDebugOverlay.style.cssText = 'position:fixed;top:8px;left:8px;z-index:9999;' +
      'background:rgba(0,0,0,0.65);color:#ffd75e;font:12px monospace;padding:6px 8px;' +
      'border-radius:4px;pointer-events:none;white-space:pre;';
    document.body.appendChild(shadowDebugOverlay);
  }
  dirLight.shadow.bias = -0.0001;
  dirLight.shadow.normalBias = 0.02;

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

  // Exclusion Zone Mesh Group
  exclusionZoneGroup = new THREE.Group();
  scene.add(exclusionZoneGroup);
  exclusionZoneGeometry = new THREE.CylinderGeometry(CONFIG.HEX_SIZE * cellSizeScale.normal * 0.96, CONFIG.HEX_SIZE * cellSizeScale.normal * 0.96, 0.05, 6);

  // 8. Setup Loaders
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath('https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/gltf/');

  gltfLoader = new GLTFLoader();
  gltfLoader.setDRACOLoader(dracoLoader);

  // Listeners
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // Optional Performance Monitor (Stats.js)
  if (CONFIG.SHOW_FPS) {
    stats = new Stats();
    stats.showPanel(0); // 0: fps, 1: ms, 2: mb, 3+: custom
    stats.dom.style.position = 'fixed';
    stats.dom.style.top = '10px';
    stats.dom.style.right = '10px';
    stats.dom.style.left = 'auto';
    stats.dom.style.zIndex = '9999';
    document.body.appendChild(stats.dom);
  }

  // Start Animation Loop
  clock.start();
  animate();
}

/**
 * Creates or updates a dark ground base beneath the hex grid to block skybox bleed
 * through semi-transparent tiles (like oceans).
 * @param {number} radius - Outer spatial radius of the hex map
 */
/**
 * Applies per-map camera and shadow limits. Call after map generation / load.
 *
 * - Clamps the OrbitControls target to the hex map bounds (+ CAMERA_PAN_MARGIN_RINGS)
 *   so the view can't pan off into the void (enforced every frame in animate()).
 * - Scales max zoom-out with map size so a small map isn't a tiny island in the void.
 * - Sizes the shadow camera to cover the whole map from any allowed target position.
 *   The directional light follows controls.target (see animate()), and the worst
 *   map-point-to-target distance (panClampRadius + worldRadius) is always within
 *   (panClampRadius + maxDistance) * SHADOW_CAMERA_SCALE, so every map point stays
 *   inside the shadow frustum: shadows can't pop.
 *
 * @param {number} mapRings - Map radius in hex rings (settings.mapSize / hexGrid.radius)
 */
export function setMapCameraLimits(mapRings) {
  // Ring count -> world units: pointy-top axial layout, max |x| = sqrt(3) * HEX_SIZE * rings.
  const worldRadius = mapRings * Math.sqrt(3) * CONFIG.HEX_SIZE;
  panClampRings = mapRings + CONFIG.CAMERA_PAN_MARGIN_RINGS;
  const maxDistance = Math.max(CONFIG.CAMERA_ZOOM_MIN, worldRadius * CONFIG.CAMERA_ZOOM_SCALE);
  if (controls) {
    controls.maxDistance = maxDistance;
    // Pull the camera in if it's currently parked beyond the new limit.
    _limitOffset.copy(camera.position).sub(controls.target);
    if (_limitOffset.length() > maxDistance) {
      _limitOffset.setLength(maxDistance);
      camera.position.copy(controls.target).add(_limitOffset);
    }
    clampCameraTarget();
  }
  if (dirLight) {
    // Worst map-point-to-target distance: the target roams a hex region of panClampRings
    // rings and map corners sit at mapRings rings (corner-direction ring spacing).
    const worstCase = (panClampRings + mapRings) * Math.sqrt(3) * CONFIG.HEX_SIZE;
    const d = Math.max(60, worstCase * CONFIG.SHADOW_CAMERA_SCALE);
    shadowStaticBound = d;
    dirLight.shadow.camera.left = -d;
    dirLight.shadow.camera.right = d;
    dirLight.shadow.camera.top = d;
    dirLight.shadow.camera.bottom = -d;
    // Negative near: at low sun the light sits mostly sideways from the map (fixed
    // 80-unit offset), so a positive near plane would clip everything sun-ward of the
    // light into shadowlessness (sharp pop line). Far is static (not fitted) so low
    // sun depth range is always covered.
    dirLight.shadow.camera.near = -shadowStaticBound;
    dirLight.shadow.camera.far = shadowStaticBound * 4;
    dirLight.shadow.camera.updateProjectionMatrix();
  }
}

/**
 * Clamps the orbit target to the map bounds, shifting the camera by the same delta
 * so the view doesn't jump. No-op until setMapCameraLimits() has run.
 */
function clampCameraTarget() {
  if (!controls || !isFinite(panClampRings)) return;
  // World -> cube coords (pointy-top axial, same layout math as hexGrid.js).
  const size = CONFIG.HEX_SIZE;
  const t = controls.target;
  const q = ((Math.sqrt(3) / 3) * t.x - (1 / 3) * t.z) / size;
  const r = ((2 / 3) * t.z) / size;
  const dist = (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
  if (dist > panClampRings) {
    // Hex region is convex and centered: scale toward the center to land on the boundary.
    const k = panClampRings / dist;
    const q2 = q * k, r2 = r * k;
    const nx = size * (Math.sqrt(3) * q2 + (Math.sqrt(3) / 2) * r2);
    const nz = size * (3 / 2) * r2;
    const dx = nx - t.x, dz = nz - t.z;
    t.x = nx;
    t.z = nz;
    camera.position.x += dx;
    camera.position.z += dz;
  }
}

/**
 * Limits how low the camera can tilt based on its height above ground (the target
 * stays at y~=0, so camera.position.y is the height). The lower the camera gets,
 * the less it may tilt toward the horizon. This is self-correcting: the ceiling
 * lowers as the camera descends, so the dirt-skimming horizon stare is unreachable
 * at any zoom level. It also keeps the dynamic shadow fit in its crisp regime
 * instead of falling back to the blurry static bound.
 */
function updateTiltLimit() {
  if (!controls) return;
  const h = camera.position.y;
  const t = THREE.MathUtils.clamp(
    (h - CONFIG.CAMERA_TILT_H_CLOSE) / (CONFIG.CAMERA_TILT_H_FAR - CONFIG.CAMERA_TILT_H_CLOSE), 0, 1);
  controls.maxPolarAngle = THREE.MathUtils.lerp(CONFIG.CAMERA_TILT_CLOSE, CONFIG.CAMERA_TILT_FAR, t);
}

/**
 * Dynamically fits the shadow camera to the current view for crisp shadows.
 *
 * The shadow camera follows controls.target (see animate()). Each frame we cast
 * rays through a grid over the view frustum, intersect them with the ground plane,
 * and size the shadow ortho box (in light space, so sun angle is handled exactly)
 * to cover the hits. Zoom and tilt are handled uniformly: looking straight down
 * while zoomed in yields a small box (crisp shadows); zooming out enlarges it.
 *
 * If any ray hits the sky (grazing tilt toward the horizon), the visible ground
 * is unbounded, so we fall back to the static pop-free bound from
 * setMapCameraLimits() — softer shadows there, but that region is sub-pixel anyway.
 * The fitted size is quantized to 16-unit steps to avoid shimmer.
 */
function fitShadowCameraToView() {
  if (!dirLight || !dirLight.castShadow || !camera || !controls) return;
  const shadowCam = dirLight.shadow.camera;

  camera.updateMatrixWorld();
  dirLight.updateMatrixWorld();
  dirLight.target.updateMatrixWorld();
  // Refresh the shadow camera matrices from the light (exactly what the shadow pass
  // does at render time); this keeps our fitted ortho bounds intact.
  dirLight.shadow.updateMatrices(dirLight);

  const tx = controls.target.x;
  const tz = controls.target.z;
  let maxAbs = 0;
  let skyHit = false;
  for (let ix = -1; ix <= 1; ix += 0.5) {
    for (let iy = -1; iy <= 1; iy += 0.5) {
      _fitNdc.set(ix, iy, 1).unproject(camera); // world point on the far plane
      _fitDir.copy(_fitNdc).sub(camera.position);
      const len = _fitDir.length();
      if (len < 1e-6 || _fitDir.y >= -1e-4 * len) { skyHit = true; continue; } // sky
      _fitDir.divideScalar(len);
      const t = -camera.position.y / _fitDir.y; // ground plane y=0; t>0 guaranteed
      // Clamp the hit to the static bound around the target so a horizon stare
      // can't blow up the box (those texels are sub-pixel anyway).
      let hx = camera.position.x + _fitDir.x * t - tx;
      let hz = camera.position.z + _fitDir.z * t - tz;
      const hr = Math.hypot(hx, hz);
      if (hr > shadowStaticBound) { const s = shadowStaticBound / hr; hx *= s; hz *= s; }
      _fitLight.set(tx + hx, 0, tz + hz).applyMatrix4(shadowCam.matrixWorldInverse);
      const ax = Math.abs(_fitLight.x), ay = Math.abs(_fitLight.y);
      if (ax > maxAbs) maxAbs = ax;
      if (ay > maxAbs) maxAbs = ay;
    }
  }
  // The view target itself is always covered.
  _fitLight.set(tx, 0, tz).applyMatrix4(shadowCam.matrixWorldInverse);
  if (Math.abs(_fitLight.x) > maxAbs) maxAbs = Math.abs(_fitLight.x);
  if (Math.abs(_fitLight.y) > maxAbs) maxAbs = Math.abs(_fitLight.y);

  shadowFitSkyHit = skyHit;
  const need = skyHit ? shadowStaticBound : maxAbs;
  const d = Math.min(shadowStaticBound, Math.max(48, Math.ceil((need * 1.15) / 16) * 16));
  if (d !== shadowFitHalfExtent) {
    shadowFitHalfExtent = d;
    shadowCam.left = -d;
    shadowCam.right = d;
    shadowCam.top = d;
    shadowCam.bottom = -d;
    shadowCam.updateProjectionMatrix();
  }
}

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

function setTimeOfDay(hour) {
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
 * Cancels any existing in-flight time animation to prevent stacking/jitter.
 * @param {number} targetHour - Destination time of day (0 to 24)
 * @param {number} duration - Animation speed in seconds (default 1.5s)
 * @param {Function} onComplete - Optional callback when animation finishes
 */
export function animateToTimeOfDay(targetHour, duration = 1.5, onComplete = null) {
  // 1. If a time animation is already running, cancel and remove it immediately
  if (activeTimeEffect) {
    const index = activeEffects.indexOf(activeTimeEffect);
    if (index !== -1) {
      activeEffects.splice(index, 1);
    }
    activeTimeEffect = null;
  }

  // 2. Start from current hour (where the sun currently is mid-animation)
  const startHour = currentHour;
  let endHour = targetHour;

  console.debug("Animating time of day from " + startHour + " to " + endHour);

  // Handle forward progression across midnight (e.g., moving from 23 to 2)
  if (endHour <= startHour) {
    endHour += 24;
  }

  let elapsed = 0;

  // 3. Define and register the new animation effect
  const timeEffect = {
    update: (dt) => {
      elapsed += dt;
      const progress = Math.min(elapsed / duration, 1.0);
      const easeProgress = progress * progress * (3 - 2 * progress); // Smoothstep easing

      const animatedHour = THREE.MathUtils.lerp(startHour, endHour, easeProgress);
      setTimeOfDay(animatedHour);

      if (progress >= 1.0) {
        currentHour = targetHour % 24;
        activeTimeEffect = null; // Clear reference upon completion
        if (onComplete) onComplete();
        return false; // Remove from activeEffects array
      }
      return true;
    }
  };

  activeTimeEffect = timeEffect;
  activeEffects.push(timeEffect);
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

// Scratch vectors for the animation loop (allocated once, not per frame)
const _animForward = new THREE.Vector3();
const _animRight = new THREE.Vector3();
const _animMove = new THREE.Vector3();
const _animOffset = new THREE.Vector3();
const _animUpY = new THREE.Vector3(0, 1, 0);

function animate() {
  requestAnimationFrame(animate);

  if (stats) stats.begin();
  const deltaTime = clock.getDelta();

  if (controls) {
    const speed = 15 * deltaTime;
    const rotSpeed = 2.0 * deltaTime;

    const forward = _animForward;
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    const right = _animRight;
    right.crossVectors(forward, camera.up).normalize();

    const moveVector = _animMove;
    moveVector.set(0, 0, 0);
    if (keysPressed['KeyW'] || keysPressed['w']) moveVector.addScaledVector(forward, speed);
    if (keysPressed['KeyS'] || keysPressed['s']) moveVector.addScaledVector(forward, -speed);
    if (keysPressed['KeyD'] || keysPressed['d']) moveVector.addScaledVector(right, speed);
    if (keysPressed['KeyA'] || keysPressed['a']) moveVector.addScaledVector(right, -speed);

    if (moveVector.lengthSq() > 0) {
      camera.position.add(moveVector);
      controls.target.add(moveVector);
    }

    if (keysPressed['KeyQ'] || keysPressed['q']) {
      const offset = _animOffset.copy(camera.position).sub(controls.target);
      offset.applyAxisAngle(_animUpY, rotSpeed);
      camera.position.copy(controls.target).add(offset);
    }
    if (keysPressed['KeyE'] || keysPressed['e']) {
      const offset = _animOffset.copy(camera.position).sub(controls.target);
      offset.applyAxisAngle(_animUpY, -rotSpeed);
      camera.position.copy(controls.target).add(offset);
    }

    // Height-dependent tilt limit (set before update so OrbitControls enforces it)
    updateTiltLimit();

    controls.update();

    // Keep the camera target on the map (pan clamp from setMapCameraLimits)
    clampCameraTarget();

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

    // Fit the shadow camera to the current view (zoom + tilt aware) for crisp shadows
    fitShadowCameraToView();
    if (shadowDebugHelper) {
      shadowDebugHelper.update();
      const _sd = _shadowDbgVec.copy(camera.position).sub(controls.target);
      const _pol = Math.acos(THREE.MathUtils.clamp(_sd.y / _sd.length(), -1, 1)) * 180 / Math.PI;
      shadowDebugOverlay.textContent =
        `shadow fit d=${shadowFitHalfExtent} static=${Math.round(shadowStaticBound)} skyFallback=${shadowFitSkyHit}\n` +
        `cam dist=${_sd.length().toFixed(1)} polar=${_pol.toFixed(1)}deg mapSize=${CONFIG.SHADOW_MAP_SIZE}`;
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

  if (stats) stats.end();
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

export function drawGrid(gameState) {
  const maxDistanceSq = rebuildHexInstances(gameState);

  // Automatically update dark ground bed based on map extent
  const maxMapRadius = Math.sqrt(maxDistanceSq) + CONFIG.HEX_SIZE;
  updateGroundBase(maxMapRadius);
}

/**
 * Recomputes hex appearance after fog-of-war changes (exploration, turn end,
 * actions). Buckets cells by (terrain, fogState) and rewrites instance
 * matrices; GPU buffers are only reallocated when a bucket's cell count
 * changes. This replaces the old full destroy/recreate of every hex mesh.
 */
export function updateHexFog(gameState) {
  rebuildHexInstances(gameState);
}

// Scratch objects for instance matrix composition (no per-frame allocation)
const _hexMatrix = new THREE.Matrix4();
const _hexPos = new THREE.Vector3();
const _hexScale = new THREE.Vector3();
const _hexIdentityQuat = new THREE.Quaternion();

function hexFogState(gameState, cell) {
  if (!gameState.isExploredByHuman(cell) && !CONFIG.SHOW_ALL) return 'hidden';
  if (!gameState.isVisibleToHuman(cell) && !CONFIG.SHOW_ALL) return 'dim';
  return 'normal';
}

function rebuildHexInstances(gameState) {
  if (!hexUnitGeometry) {
    hexUnitGeometry = new THREE.CylinderGeometry(CONFIG.HEX_SIZE * cellSizeScale.normal, CONFIG.HEX_SIZE * cellSizeScale.normal, 1, 6);
  }

  // Bucket cells by (terrain, fogState); each bucket shares one material.
  const buckets = new Map();
  let maxDistanceSq = 0;
  for (const cell of gameState.hexGrid.cells.values()) {
    const fog = hexFogState(gameState, cell);
    // Hidden cells all share one material/height regardless of terrain.
    const key = fog === 'hidden' ? 'hidden' : cell.terrain.name + '|' + fog;
    let b = buckets.get(key);
    if (!b) {
      let material, shadows;
      if (fog === 'hidden') {
        material = hiddenTerrain.material;
        shadows = false;
      } else if (fog === 'dim') {
        material = getDesaturatedTerrainMaterial(cell.terrain);
        shadows = true;
      } else {
        material = getTerrainMaterial(cell.terrain);
        shadows = true;
      }
      b = { cells: [], material, shadows, fog };
      buckets.set(key, b);
    }
    b.cells.push(cell);

    const { x, z } = HexGrid.axialToPixel(cell.q, cell.r);
    const distSq = x * x + z * z;
    if (distSq > maxDistanceSq) maxDistanceSq = distSq;
  }

  const seen = new Set();
  for (const [key, b] of buckets) {
    seen.add(key);
    let im = hexBucketMeshes.get(key);
    if (!im || im.count !== b.cells.length) {
      // Bucket size changed (or new bucket): reallocate the instance buffer.
      // Geometry and material are shared/cached, so this only uploads matrices.
      if (im) {
        hexGroup.remove(im);
        im.dispose();
      }
      im = new THREE.InstancedMesh(hexUnitGeometry, b.material, b.cells.length);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Compute tight bounds from instances so frustum culling works
      // (without this, all instances render into the shadow map every frame)
      im.castShadow = b.shadows;
      im.receiveShadow = b.shadows;
      hexGroup.add(im);
      hexBucketMeshes.set(key, im);
    }
    for (let i = 0; i < b.cells.length; i++) {
      const cell = b.cells[i];
      const h = b.fog === 'hidden' ? hiddenTerrain.height : cell.terrain.height;
      const { x, z } = HexGrid.axialToPixel(cell.q, cell.r);
      _hexPos.set(x, h / 2, z);
      _hexScale.set(1, h, 1);
      _hexMatrix.compose(_hexPos, _hexIdentityQuat, _hexScale);
      im.setMatrixAt(i, _hexMatrix);
    }
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
  }

  // Remove buckets that no longer have any cells
  for (const [key, im] of hexBucketMeshes) {
    if (!seen.has(key)) {
      hexGroup.remove(im);
      im.dispose();
      hexBucketMeshes.delete(key);
    }
  }

  return maxDistanceSq;
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

  gameState.entities.forEach(entity => {
    const isEntityVisibleInScene = gameState.isVisibleToHuman(entity.cell);

    if (isEntityVisibleInScene || CONFIG.SHOW_ALL) {
      activeIds.add(entity.id);

      const cell = entity.cell || gameState.hexGrid.cells.get(`${entity.q},${entity.r}`);
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

  // remove meshes for entities that are not visible
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

/**
 * Highlights the building exclusion zone around an entity defined by minSeparation.
 * Renders semi-transparent hexes in the owning player's color.
 * @param {number} q - Center axial q
 * @param {number} r - Center axial r
 * @param {number} minSeparation - Radius (distance < minSeparation is excluded)
 * @param {string} color - Player hex color
 * @param {GameState} [gameState] - Game state for terrain heights
 */
export function showExclusionZone(q, r, minSeparation, color = '#3498db', gameState = null) {
  clearExclusionZone();
  if (q === null || r === null || !minSeparation || minSeparation <= 1 || !exclusionZoneGroup) return;

  const hexColor = new THREE.Color(color);
  const mat = new THREE.MeshBasicMaterial({
    color: hexColor,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide
  });

  const radius = minSeparation - 1;
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
      const targetQ = q + dq;
      const targetR = r + dr;
      const { x, z } = HexGrid.axialToPixel(targetQ, targetR);
      const cell = gameState?.hexGrid ? gameState.hexGrid.cells.get(`${targetQ},${targetR}`) : null;
      const height = cell?.terrain ? cell.terrain.height : 1.0;
      const mesh = new THREE.Mesh(exclusionZoneGeometry, mat);
      mesh.position.set(x, height + CONFIG.HEX_SIZE / 30, z);
      exclusionZoneGroup.add(mesh);
    }
  }
}

export function clearExclusionZone() {
  if (!exclusionZoneGroup) return;
  while (exclusionZoneGroup.children.length > 0) {
    const child = exclusionZoneGroup.children[0];
    if (child.material) child.material.dispose();
    exclusionZoneGroup.remove(child);
  }
}

const _pickRaycaster = new THREE.Raycaster();
const _pickPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _pickPoint = new THREE.Vector3();

/**
 * Math-based hex picking: intersect the mouse ray with the terrain plane and
 * convert to axial coordinates. O(1) — replaces raycasting against every hex
 * mesh (12k+ intersection tests per mousemove on large maps).
 * Returns the same shape the old raycastHex returned: {q, r, terrain, isExplored, isVisible}.
 */
export function pickHexCell(mouseNormalized, gameState) {
  if (!gameState || !gameState.hexGrid || !camera) return null;
  _pickRaycaster.setFromCamera(mouseNormalized, camera);
  let cell = null;
  // Two passes: intersect at y=0, then refine at the hovered cell's terrain height.
  for (let pass = 0; pass < 2; pass++) {
    const h = cell && cell.terrain ? cell.terrain.height : 0;
    _pickPlane.constant = -h;
    if (!_pickRaycaster.ray.intersectPlane(_pickPlane, _pickPoint)) return null;
    const { q, r } = HexGrid.pixelToAxial(_pickPoint.x, _pickPoint.z);
    cell = gameState.hexGrid.cells.get(`${q},${r}`);
    if (!cell) return null;
  }
  return {
    q: cell.q,
    r: cell.r,
    terrain: cell.terrain,
    isExplored: gameState.isExploredByHuman(cell),
    isVisible: gameState.isVisibleToHuman(cell),
  };
}

/**
 * Focuses the camera on the center of mass of a list of entities.
 * Pans the camera (moves both position and target) while keeping camera elevation constant.
 * @param {Array} entities - Array of entity objects with q, r coordinates
 */
export function focusCameraOnEntities(entities) {
  if (!entities || entities.length === 0 || !controls || !camera) return;

  let sumX = 0;
  let sumZ = 0;
  let count = 0;

  for (const entity of entities) {
    const { x, z } = HexGrid.axialToPixel(entity.q, entity.r);
    sumX += x;
    sumZ += z;
    count++;
  }

  if (count === 0) return;

  const centerX = sumX / count;
  const centerZ = sumZ / count;

  // Smoothly animate camera position and target to the center of mass
  // Keep camera Y (elevation) constant by moving both position and target by the same delta
  const target = controls.target;
  const duration = 0.5; // seconds
  const startTargetX = target.x;
  const startTargetZ = target.z;
  const startCameraX = camera.position.x;
  const startCameraZ = camera.position.z;
  const startTime = performance.now() / 1000;

  function animateFocus() {
    const elapsed = performance.now() / 1000 - startTime;
    const progress = Math.min(elapsed / duration, 1.0);
    const easeProgress = progress * progress * (3 - 2 * progress); // Smoothstep easing

    const newTargetX = THREE.MathUtils.lerp(startTargetX, centerX, easeProgress);
    const newTargetZ = THREE.MathUtils.lerp(startTargetZ, centerZ, easeProgress);
    const newCameraX = THREE.MathUtils.lerp(startCameraX, startCameraX + (centerX - startTargetX), easeProgress);
    const newCameraZ = THREE.MathUtils.lerp(startCameraZ, startCameraZ + (centerZ - startTargetZ), easeProgress);

    target.x = newTargetX;
    target.z = newTargetZ;
    camera.position.x = newCameraX;
    camera.position.z = newCameraZ;

    if (progress < 1.0) {
      requestAnimationFrame(animateFocus);
    }
  }

  animateFocus();
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
// ---------------------------------------------------------------------------
// Cell resources & treasures — InstancedMesh decorations
// ---------------------------------------------------------------------------
// Each distinct (modelUrl, size) bucket gets one THREE.InstancedMesh per mesh
// part of the GLB, so thousands of trees/ruins render as a handful of draw
// calls. Per-instance matrices encode the scattered placement; instances on
// unexplored cells (or consumed treasures) are hidden via a zero-scale matrix.

const resourceModelPartsCache = {}; // "modelUrl|size" -> [{ geometry, material }]
const resourceInstancedMeshes = []; // THREE.InstancedMesh[]
const resourceFadedMaterials = []; // cloned transparent materials (disposed on clear)
const cellResourceSlots = {};       // "q,r" -> [{ mesh, fadedMesh, index, fadedIndex, matrix }]
const _zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
const _tmpMatrix = new THREE.Matrix4();
const _tmpPos = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _tmpEuler = new THREE.Euler();
const _tmpScale = new THREE.Vector3();

/**
 * Expands a position attribute to Float32, de-interleaving if needed.
 * Baking a node matrix into normalized int16 positions clamps every
 * transformed vertex back into [-1,1], collapsing the model — the tree GLBs
 * store normalized int16 positions, so float expansion must come first.
 */
function expandPositionsToFloat(geom) {
  const pos = geom.attributes.position;
  if (!pos) return;
  if (pos.array instanceof Float32Array && !pos.isInterleavedBufferAttribute) return;
  const count = pos.count;
  const arr = new Float32Array(count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(pos, i);
    arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z;
  }
  geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
}

/**
 * Extracts renderable mesh parts from a cached GLTF scene, normalized so the
 * model's largest dimension equals HEX_SIZE * targetSize with its base at y=0.
 * Geometry is cloned — the cached template is never mutated.
 */
function getResourceModelParts(modelUrl, targetSize) {
  const key = `${modelUrl}|${targetSize}`;
  if (resourceModelPartsCache[key]) return resourceModelPartsCache[key];
  const parts = [];
  const template = modelCache[modelUrl];
  if (template) {
    template.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(template);
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const scale = (CONFIG.HEX_SIZE * targetSize) / maxDim;
    template.traverse(node => {
      if (node.isMesh && node.geometry) {
        const geom = node.geometry.clone();
        expandPositionsToFloat(geom);
        geom.applyMatrix4(node.matrixWorld);
        geom.scale(scale, scale, scale);
        // Recenter horizontally on the model's bbox center (some Sketchfab
        // exports offset the mesh from the scene origin) and put its base
        // at y=0.
        geom.translate(-center.x * scale, -bbox.min.y * scale, -center.z * scale);
        const material = Array.isArray(node.material) ? node.material[0] : node.material;
        parts.push({ geometry: geom, material });
      }
    });
  } else {
    console.warn(`Resource model not preloaded: ${modelUrl}`);
  }
  resourceModelPartsCache[key] = parts;
  return parts;
}

function setResourceInstanceMatrix(im, index, x, y, z, rotY, scale) {
  _tmpEuler.set(0, rotY, 0);
  _tmpQuat.setFromEuler(_tmpEuler);
  _tmpPos.set(x, y, z);
  _tmpScale.set(scale, scale, scale);
  _tmpMatrix.compose(_tmpPos, _tmpQuat, _tmpScale);
  im.setMatrixAt(index, _tmpMatrix);
  return _tmpMatrix.clone();
}

/**
 * (Re)builds all resource/treasure decoration meshes from gameState cells.
 * Call after drawGrid on new game / load. Models must be preloaded first.
 */
export function buildCellResources(gameState) {
  clearCellResources();
  const manifestData = gameState.manifestData;
  if (!manifestData) return;

  // Bucket items by (modelUrl, size) — one InstancedMesh per bucket per GLB part.
  const buckets = new Map();
  for (const cell of gameState.hexGrid.cells.values()) {
    if (!cell.resource) continue;
    const def = findSpawnDef(manifestData, cell.resource.kind, cell.resource.name);
    const group = findTerrainGroup(def, cell.terrain ? cell.terrain.name : null);
    const size = group && typeof group.size === 'number' ? group.size : 1;
    const { x, z } = HexGrid.axialToPixel(cell.q, cell.r);
    const y = cell.terrain && typeof cell.terrain.height === 'number' ? cell.terrain.height : 1;
    for (const item of cell.resource.items || []) {
      const key = `${item.modelUrl}|${size}`;
      if (!buckets.has(key)) buckets.set(key, { url: item.modelUrl, size, items: [] });
      buckets.get(key).items.push({
        cell, x: x + item.dx, y, z: z + item.dz, rotY: item.rotY, scale: item.scale,
      });
    }
  }

  for (const { url, size, items } of buckets.values()) {
    const parts = getResourceModelParts(url, size);
    for (const part of parts) {
      const im = new THREE.InstancedMesh(part.geometry, part.material, items.length);
      im.castShadow = true;
      im.receiveShadow = true;
      // Faded overlay: same instances, semi-transparent. Used for resource
      // cells a unit is standing on so the unit stays clearly visible.
      const fadedMaterial = part.material.clone();
      fadedMaterial.transparent = true;
      fadedMaterial.opacity = 0.35;
      resourceFadedMaterials.push(fadedMaterial);
      const fim = new THREE.InstancedMesh(part.geometry, fadedMaterial, items.length);
      fim.castShadow = false;
      fim.receiveShadow = false;
      fim.frustumCulled = false; // instances are added/removed dynamically as units move; static bounds would be wrong
      fim.count = 0;
      fim.userData.fadedSlots = [];
      items.forEach((it, idx) => {
        const matrix = setResourceInstanceMatrix(im, idx, it.x, it.y, it.z, it.rotY, it.scale);
        const key = `${it.cell.q},${it.cell.r}`;
        if (!cellResourceSlots[key]) cellResourceSlots[key] = [];
        cellResourceSlots[key].push({ mesh: im, fadedMesh: fim, index: idx, fadedIndex: -1, matrix });
      });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      fim.computeBoundingSphere();
      scene.add(im);
      scene.add(fim);
      resourceInstancedMeshes.push(im, fim);
    }
  }

  reconcileCellResources(gameState);
}

/**
 * Moves a resource instance into its faded (semi-transparent) overlay mesh.
 * No-op when already faded.
 */
function fadeResourceSlot(slot) {
  if (slot.fadedIndex >= 0) return;
  slot.mesh.setMatrixAt(slot.index, _zeroMatrix);
  slot.mesh.instanceMatrix.needsUpdate = true;
  const fim = slot.fadedMesh;
  const list = fim.userData.fadedSlots;
  slot.fadedIndex = list.length;
  list.push(slot);
  fim.count = list.length;
  fim.setMatrixAt(slot.fadedIndex, slot.matrix);
  fim.instanceMatrix.needsUpdate = true;
}

/**
 * Restores a faded resource instance to its main (opaque) mesh.
 * No-op when not faded.
 */
function unfadeResourceSlot(slot) {
  if (slot.fadedIndex < 0) return;
  slot.mesh.setMatrixAt(slot.index, slot.matrix);
  slot.mesh.instanceMatrix.needsUpdate = true;
  const fim = slot.fadedMesh;
  const list = fim.userData.fadedSlots;
  const lastSlot = list.pop();
  if (lastSlot !== slot) {
    list[slot.fadedIndex] = lastSlot;
    lastSlot.fadedIndex = slot.fadedIndex;
    fim.setMatrixAt(lastSlot.fadedIndex, lastSlot.matrix);
  }
  fim.count = list.length;
  fim.instanceMatrix.needsUpdate = true;
  slot.fadedIndex = -1;
}

/**
 * Lightweight per-frame-safe update: hides instances on unexplored cells,
 * fades instances on cells a unit is standing on (so the unit stays clearly
 * visible), and drops slots for consumed treasures. Call after actions that
 * move units or change visibility.
 */
export function reconcileCellResources(gameState) {
  const occupied = new Set();
  for (const e of gameState.entities || []) occupied.add(`${e.q},${e.r}`);
  for (const key of Object.keys(cellResourceSlots)) {
    const cell = gameState.hexGrid.cells.get(key);
    const slots = cellResourceSlots[key];
    const hasResource = !!(cell && cell.resource);
    const visible = hasResource && (CONFIG.SHOW_ALL || gameState.isExploredByHuman(cell));
    const faded = visible && occupied.has(key);
    for (const slot of slots) {
      if (!visible) {
        // Hidden by fog of war: collapse the instance, but remember it so the
        // real matrix is restored when the cell gets explored later.
        if (slot.fadedIndex >= 0) unfadeResourceSlot(slot);
        if (!slot.hidden) {
          slot.mesh.setMatrixAt(slot.index, _zeroMatrix);
          slot.mesh.instanceMatrix.needsUpdate = true;
          slot.hidden = true;
        }
      } else if (faded) {
        slot.hidden = false;
        fadeResourceSlot(slot);
      } else {
        if (slot.fadedIndex >= 0) unfadeResourceSlot(slot);
        if (slot.hidden) {
          slot.mesh.setMatrixAt(slot.index, slot.matrix);
          slot.mesh.instanceMatrix.needsUpdate = true;
          slot.hidden = false;
        }
      }
    }
    if (!hasResource) delete cellResourceSlots[key];
  }
}

/**
 * Removes all resource/treasure meshes and frees their GPU buffers.
 * (Materials are shared with the model cache and are not disposed.)
 */
export function clearCellResources() {
  for (const im of resourceInstancedMeshes) {
    scene.remove(im);
    im.dispose();
  }
  resourceInstancedMeshes.length = 0;
  for (const m of resourceFadedMaterials) m.dispose();
  resourceFadedMaterials.length = 0;
  for (const key of Object.keys(resourceModelPartsCache)) {
    for (const part of resourceModelPartsCache[key]) part.geometry.dispose();
    delete resourceModelPartsCache[key];
  }
  for (const key of Object.keys(cellResourceSlots)) delete cellResourceSlots[key];
}