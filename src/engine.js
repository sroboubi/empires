import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { scene, hexSize } from './renderer.js';
import { axialToPixel } from './hexMath.js';

export class GameEngine {
  /**
   * @param {GameState} gameState - Reference to the core game state
   * @param {Object} entityMetadata - Reference to preloaded entity metadata from manifestLoader
   */
  constructor(gameState, entityMetadata) {
    this.gameState = gameState;
    this.entityMetadata = entityMetadata;

    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath('https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/gltf/');

    this.gltfLoader = new GLTFLoader();
    this.gltfLoader.setDRACOLoader(dracoLoader);

    this.modelCache = {}; // Maps model URL to parsed GLTF scene (original)

    this.controllers = []; // Active controller instances
    this.entityMeshes = {}; // Maps entity.id -> Three.js Group
  }

  /**
   * Preloads all GLTF models defined in the metadata in parallel.
   */
  async preloadModels() {
    console.log("Preloading GLTF models...");
    const promises = Object.values(this.entityMetadata).map(entity => {
      return new Promise((resolve) => {
        if (!entity.modelUrl) {
          resolve();
          return;
        }

        this.gltfLoader.load(
          entity.modelUrl,
          (gltf) => {
            console.log(`Successfully preloaded model for: ${entity.name}`);
            this.modelCache[entity.modelUrl] = gltf.scene;
            resolve();
          },
          undefined,
          (err) => {
            console.error(`Failed to load GLTF model for "${entity.name}" from ${entity.modelUrl}:`, err);
            resolve(); // Resolve to avoid blocking startup
          }
        );
      });
    });

    await Promise.all(promises);
    console.log("GLTF model preloading complete.");
  }

  /**
   * Synchronizes the 3D meshes and controller instances with the GameState cells.
   * Compares currently rendered meshes with entities present in GameState.
   */
  reconcileEntities() {
    const activeIds = new Set();

    // 1. Traverse cells to find all entities in GameState
    Object.values(this.gameState.cells).forEach(cell => {
      if (cell.entities) {
        cell.entities.forEach(entity => {
          activeIds.add(entity.id);

          // If mesh doesn't exist, spawn it in 3D and instantiate its controller
          if (!this.entityMeshes[entity.id]) {
            this.spawnEntityMesh(entity, cell);
            this.createController(entity, cell);
          } else {
            // Update mesh position directly if it moved in state
            const mesh = this.entityMeshes[entity.id];
            const { x, z } = axialToPixel(entity.q, entity.r, hexSize);
            mesh.position.set(x, cell.terrain.height, z);
          }
        });
      }
    });

    // 2. Remove meshes and controllers of entities that no longer exist in GameState
    for (const id in this.entityMeshes) {
      if (!activeIds.has(id)) {
        console.log(`Removing mesh and controller for destroyed entity: ${id}`);
        const mesh = this.entityMeshes[id];
        if (mesh) {
          scene.remove(mesh);
        }
        delete this.entityMeshes[id];

        this.controllers = this.controllers.filter(c => c.entity.id !== id);
      }
    }
  }

  /**
   * Instantiates a controller for an entity and stores it in the active list.
   * @param {Object} entity - The entity state object
   * @param {Object} cell - The cell containing the entity
   */
  createController(entity, cell) {
    const meta = this.entityMetadata[entity.name];
    if (meta && meta.controllerClass) {
      try {
        const ControllerClass = meta.controllerClass;
        const controller = new ControllerClass(entity, cell, this.gameState);
        this.controllers.push(controller);
      } catch (err) {
        console.error(`Failed to instantiate controller for ${entity.name}:`, err);
      }
    }
  }

  /**
   * Spawns the 3D visual representation of an entity, including player-colored base ring.
   * @param {Object} entity - The entity state object
   * @param {Object} cell - The cell containing the entity
   */
  spawnEntityMesh(entity, cell) {
    const meta = this.entityMetadata[entity.name];
    if (!meta) return;

    const group = new THREE.Group();

    // 1. Draw Player-Colored Base Ring (if entity belongs to a player)
    if (entity.ownerId !== null && entity.ownerId !== undefined) {
      const player = this.gameState.players.find(p => p.id === entity.ownerId);
      const colorHex = player ? player.color : '#ffffff';

      const ringGeom = new THREE.RingGeometry(0.3, 0.4, 16);
      ringGeom.rotateX(-Math.PI / 2); // Lay flat on XZ plane
      const ringMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(colorHex),
        side: THREE.DoubleSide
      });
      const ringMesh = new THREE.Mesh(ringGeom, ringMat);
      ringMesh.position.y = 0.01; // slightly above hex surface to avoid z-fighting
      group.add(ringMesh);
    }

    // 2. Add GLTF model geometry
    const originalScene = this.modelCache[meta.modelUrl];
    if (originalScene) {
      const modelClone = originalScene.clone();

      // Compute bounding box to normalize scale across different models
      const box = new THREE.Box3().setFromObject(modelClone);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const targetSize = meta.size || 1;
      const scale = targetSize / (maxDim || 1);
      modelClone.scale.set(scale, scale, scale);

      // Align lowest point of the model to y = 0 inside the group
      const localBox = new THREE.Box3().setFromObject(modelClone);
      modelClone.position.y = -localBox.min.y;

      // Enable shadow casting & receiving on loaded geometry
      modelClone.traverse(node => {
        if (node.isMesh) {
          node.castShadow = true;
          node.receiveShadow = true;
        }
      });

      group.add(modelClone);
    } else {
      // Fallback placeholder block if GLTF model failed to load
      const geom = new THREE.BoxGeometry(0.3, 0.3, 0.3);
      const color = entity.ownerId !== null ? '#ff00ff' : '#cccccc';
      const mat = new THREE.MeshStandardMaterial({ color: color });
      const fallbackMesh = new THREE.Mesh(geom, mat);
      fallbackMesh.position.y = 0.15;
      group.add(fallbackMesh);
    }

    // Position group on top of the hex cell
    const { x, z } = axialToPixel(cell.q, cell.r, hexSize);
    group.position.set(x, cell.terrain.height, z);

    // Save and add to the Three.js scene
    this.entityMeshes[entity.id] = group;
    scene.add(group);
  }

  /**
   * Resets all entity meshes and controllers.
   */
  clear() {
    for (const id in this.entityMeshes) {
      const mesh = this.entityMeshes[id];
      if (mesh) {
        scene.remove(mesh);
      }
    }
    this.entityMeshes = {};
    this.controllers = [];
  }
}
