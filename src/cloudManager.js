/**
 * Stylized animated cloud layer.
 *
 * A fixed pool of low-poly sphere clusters drifts across the hex map on a
 * prevailing wind. Clouds live in their own scene group (never in hexGroup),
 * sit above the tallest terrain, fade in/out around the map edge, and are
 * recycled back to the upwind side instead of being destroyed.
 *
 * Usage:
 *   const clouds = new CloudManager(scene, camera);
 *   clouds.init(maxMapRadius, mapCellCount); // after the map is generated
 *   clouds.update(deltaTime);                // every frame
 *   clouds.dispose();                        // when the map/scene goes away
 */
import * as THREE from 'three';
import { CONFIG } from './config.js';

// Wind blows toward the east/northeast: +X, -Z (north is -Z in this game).
const WIND_DIRECTION = new THREE.Vector3(0.8, 0, -0.6).normalize();
// Fade the cloud out when the camera gets this close, so close-up tactical
// views are never blocked by a cloud sitting between the camera and the map.
const CAMERA_FADE_NEAR = 4;
const CAMERA_FADE_FAR = 14;
// Transparent terrain (water) is in the same render pass as the clouds. Force
// shadows first and clouds after it; otherwise camera-dependent transparent
// sorting can put a water bucket after a cloud and paint over it.
const CLOUD_SHADOW_RENDER_ORDER = 1;
const CLOUD_RENDER_ORDER = 2;
// Soft, ground-projected cloud shadows. A radial alpha texture is stretched
// along the sun direction; opacity follows the cloud's own opacity.
const CLOUD_SHADOW_TEXTURE_SIZE = 64;
// Shadow blob radius as a multiple of each cloud sphere's world radius.
const CLOUD_SHADOW_SCALE = 1.35;
// Y of the flat shadow overlay. With depth testing off this only affects
// screen placement; it is not an occlusion height.
const CLOUD_SHADOW_PLANE_Y = 1.0;
// Fade shadows out smoothly over this many hex rings past the map edge.
const CLOUD_SHADOW_EDGE_FADE_RINGS = 2;
// Hide shadows when the sun is too close to the horizon to read cleanly.
const CLOUD_SHADOW_MIN_SUN_Y = 0.15;

// Scratch objects for the per-frame shadow projection (one manager at a time).
const _sunWorld = new THREE.Vector3();
const _sunTargetWorld = new THREE.Vector3();
const _shadowWorld = new THREE.Vector3();
const _shadowPos = new THREE.Vector3();
const _shadowScale = new THREE.Vector3();
const _shadowQuat = new THREE.Quaternion();
const _shadowEuler = new THREE.Euler();
const _shadowMatrix = new THREE.Matrix4();

export class CloudManager {
  /**
   * @param {THREE.Scene} scene - Scene to add the cloud layer to.
   * @param {THREE.Camera} camera - Camera used for the proximity fade.
   */
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.enabled = (CONFIG.CLOUDS_ENABLED !== false);
    this.castShadows = (CONFIG.CLOUD_CAST_SHADOWS === true);
    this.baseWindSpeed = CONFIG.CLOUD_WIND_SPEED;
    this.density = Math.max(0, CONFIG.CLOUD_DENSITY);
    this.sizeMin = Math.max(0.01, CONFIG.CLOUD_SIZE_MIN);
    this.sizeMax = Math.max(this.sizeMin, CONFIG.CLOUD_SIZE_MAX);
    this.altitudeMin = CONFIG.CLOUD_ALTITUDE_MIN;
    this.altitudeMax = Math.max(this.altitudeMin, CONFIG.CLOUD_ALTITUDE_MAX);
    this.shadowStrength = Math.max(0, CONFIG.CLOUD_SHADOW_STRENGTH);
    this.shadowSoftness = Math.max(0.01, CONFIG.CLOUD_SHADOW_SOFTNESS);
    this.hexSize = CONFIG.HEX_SIZE;

    this.group = null;
    this.geometry = null;
    this.shadowLayer = null;
    this.shadowGeometry = null;
    this.shadowTexture = null;
    this.sunLight = null;
    this.clouds = [];
    this.time = 0;

    this._shadowLightDir = new THREE.Vector3();
    this._shadowEnabled = false;
    this._shadowStretch = 1;
    this._shadowRotationY = 0;
    // Shared shader uniforms for clipping shadow fragments to the hex map.
    this._shadowEdgeUniforms = {
      uCloudShadowMapRings: { value: 0 },
      uCloudShadowHexSize: { value: this.hexSize },
      uCloudShadowEdgeFadeRings: { value: CLOUD_SHADOW_EDGE_FADE_RINGS },
    };

    this.maxMapRadius = 0;
    this.mapRings = 0;
    this.innerRadius = 0;
    this.outerRadius = 0;

    // Lateral component of the wind, used for the gentle drift oscillation.
    this._perpX = -WIND_DIRECTION.z;
    this._perpZ = WIND_DIRECTION.x;
  }

  /**
   * Rebuilds the cloud layer for a map of the given outer radius. Safe to call
   * for every new game / load: the previous layer is disposed first.
   *
   * @param {number} maxMapRadius - Map radius in world units (from drawGrid).
   * @param {number} [mapCellCount] - Number of hex cells in the map. When
   *   omitted, it is estimated from maxMapRadius.
   */
  init(maxMapRadius, mapCellCount = null) {
    this.dispose();

    if (!this.enabled || !this.scene || !this.camera) return;
    if (!Number.isFinite(maxMapRadius) || maxMapRadius <= 0) return;

    this.maxMapRadius = maxMapRadius;
    // Keep clouds at full opacity across the whole playable map; the fade
    // happens in the buffer outside the map edge. (0.85 * radius made the
    // outer ring of cells noticeably bare.)
    this.innerRadius = maxMapRadius;
    this.outerRadius = maxMapRadius + 6 * this.hexSize;
    // Ring count of the hex map, used by the shadow edge fade.
    this.mapRings = Math.max(0, (maxMapRadius - this.hexSize) / (Math.sqrt(3) * this.hexSize));
    this._shadowEdgeUniforms.uCloudShadowMapRings.value = this.mapRings;
    this.sunLight = this.scene.children.find(child => child.isDirectionalLight) || null;

    this.geometry = new THREE.IcosahedronGeometry(1, 1);
    this.group = new THREE.Group();
    this.group.name = 'cloudLayer';
    this.group.userData.isCloudLayer = true;
    this.scene.add(this.group);

    if (this.castShadows) {
      this.shadowGeometry = new THREE.PlaneGeometry(2, 2);
      this.shadowGeometry.rotateX(-Math.PI / 2);
      this.shadowTexture = this._createShadowTexture();
      this.shadowLayer = new THREE.Group();
      this.shadowLayer.name = 'cloudShadowLayer';
      this.scene.add(this.shadowLayer);
    }

    this.time = 0;
    // Density is expressed as clouds per 100 map cells.
    const cellCount = Number.isFinite(mapCellCount) && mapCellCount > 0
      ? mapCellCount
      : this._estimateCellCount(maxMapRadius);
    const count = Math.round(cellCount * this.density / 100);
    console.log(`[clouds] density ${this.density} -> ${count} clouds (${Math.round(cellCount)} cells)`);
    console.log(`[clouds] shadows: ${this.castShadows ? 'smooth projected blobs' : 'off'}`);
    if (count > 2000) {
      console.warn(`[clouds] ${count} clouds is very high and will likely hurt performance.`);
    }
    for (let i = 0; i < count; i++) {
      const cloud = this._createCloud();
      this._seedCloud(cloud, true);
      this.clouds.push(cloud);
    }
  }

  /**
   * Fallback cell count when the caller does not pass the real map size.
   * A hex map of R rings has 3R(R+1)+1 cells and its world radius is
   * R * sqrt(3) * HEX_SIZE.
   */
  _estimateCellCount(maxMapRadius) {
    const rings = Math.max(0, (maxMapRadius - this.hexSize) / (Math.sqrt(3) * this.hexSize));
    return 3 * rings * (rings + 1) + 1;
  }

  /**
   * Advances wind travel, secondary motion, opacity and recycling.
   * @param {number} deltaTime - Seconds since the previous frame.
   */
  update(deltaTime) {
    if (!this.group || !this.enabled || this.clouds.length === 0) return;
    if (!Number.isFinite(deltaTime) || deltaTime <= 0) return;

    // Cap the step so a backgrounded tab doesn't teleport every cloud across
    // the map on the first frame after it regains focus.
    const dt = Math.min(deltaTime, 0.1);
    this.time += dt;
    this._updateSunDirection();

    for (const cloud of this.clouds) {
      const speed = this.baseWindSpeed * cloud.speedMultiplier;
      cloud.baseX += WIND_DIRECTION.x * speed * dt;
      cloud.baseZ += WIND_DIRECTION.z * speed * dt;

      // Recycle once the cloud has crossed the downwind edge of the fade zone.
      const downwind = cloud.baseX * WIND_DIRECTION.x + cloud.baseZ * WIND_DIRECTION.z;
      if (downwind > this.outerRadius) {
        this._seedCloud(cloud, false);
      }

      this._positionCloud(cloud);
      this._updateOpacity(cloud);
      this._updateShadows(cloud);
    }
  }

  /**
   * Removes the cloud layer and frees every GPU resource it owns.
   */
  dispose() {
    for (const cloud of this.clouds) {
      if (cloud.material) cloud.material.dispose();
      if (cloud.shadowMaterial) cloud.shadowMaterial.dispose();
      if (cloud.shadowMesh) cloud.shadowMesh.dispose();
      cloud.meshes.length = 0;
    }
    this.clouds.length = 0;

    if (this.group && this.scene) this.scene.remove(this.group);
    this.group = null;

    if (this.shadowLayer && this.scene) this.scene.remove(this.shadowLayer);
    this.shadowLayer = null;

    if (this.shadowGeometry) {
      this.shadowGeometry.dispose();
      this.shadowGeometry = null;
    }

    if (this.shadowTexture) {
      this.shadowTexture.dispose();
      this.shadowTexture = null;
    }

    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }

    this.sunLight = null;
    this.maxMapRadius = 0;
    this.mapRings = 0;
    this.innerRadius = 0;
    this.outerRadius = 0;
  }

  // -------------------------------------------------------------------------
  // Internal cloud construction
  // -------------------------------------------------------------------------

  /**
   * Soft radial alpha mask used by every cloud shadow blob. RGB stays black
   * so the material darkens the ground; alpha fades smoothly to zero.
   */
  _createShadowTexture() {
    const size = CLOUD_SHADOW_TEXTURE_SIZE;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = ((x + 0.5) / size) * 2 - 1;
        const ny = ((y + 0.5) / size) * 2 - 1;
        const edge = Math.max(0, 1 - Math.sqrt(nx * nx + ny * ny));
        const falloff = edge * edge * (3 - 2 * edge);
        const alpha = Math.round(255 * Math.pow(falloff, this.shadowSoftness));
        const i = (y * size + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = alpha;
      }
    }

    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }

  /**
   * Patches a shadow material so fragments fade out past the map boundary.
   * The fade is computed per fragment in world XZ using the same axial
   * distance formula as the hex grid, so the void never receives shadows.
   */
  _configureShadowMaterial(material) {
    const uniforms = this._shadowEdgeUniforms;

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uCloudShadowMapRings = uniforms.uCloudShadowMapRings;
      shader.uniforms.uCloudShadowHexSize = uniforms.uCloudShadowHexSize;
      shader.uniforms.uCloudShadowEdgeFadeRings = uniforms.uCloudShadowEdgeFadeRings;

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          varying vec2 vCloudShadowXZ;
        `)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vCloudShadowXZ = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xz;
          #else
            vCloudShadowXZ = (modelMatrix * vec4(transformed, 1.0)).xz;
          #endif
        `);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec2 vCloudShadowXZ;
          uniform float uCloudShadowMapRings;
          uniform float uCloudShadowHexSize;
          uniform float uCloudShadowEdgeFadeRings;
        `)
        .replace('#include <map_fragment>', `#include <map_fragment>
          float cloudShadowQ = ((sqrt(3.0) / 3.0) * vCloudShadowXZ.x - (1.0 / 3.0) * vCloudShadowXZ.y) / uCloudShadowHexSize;
          float cloudShadowR = ((2.0 / 3.0) * vCloudShadowXZ.y) / uCloudShadowHexSize;
          float cloudShadowDistance = (abs(cloudShadowQ) + abs(cloudShadowR) + abs(cloudShadowQ + cloudShadowR)) * 0.5;
          diffuseColor.a *= 1.0 - smoothstep(
            uCloudShadowMapRings,
            uCloudShadowMapRings + uCloudShadowEdgeFadeRings,
            cloudShadowDistance
          );
        `);
    };
    material.customProgramCacheKey = () => 'cloudShadowBlob';
  }

  /**
   * Creates one pooled cloud: a group with 8 reusable sphere meshes and a
   * private material (so opacity/color can change per cloud).
   */
  _createCloud() {
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      flatShading: true,
    });
    let shadowMaterial = null;
    let shadowMesh = null;
    if (this.castShadows) {
      shadowMaterial = new THREE.MeshBasicMaterial({
        map: this.shadowTexture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        // A depth-tested plane at a fixed height gets cut out by trees and
        // towers that rise above it. Draw the soft blob as an overlay instead.
        depthTest: false,
        side: THREE.DoubleSide,
      });
      this._configureShadowMaterial(shadowMaterial);
      shadowMesh = new THREE.InstancedMesh(this.shadowGeometry, shadowMaterial, 8);
      shadowMesh.count = 0;
      shadowMesh.visible = false;
      shadowMesh.frustumCulled = false;
      shadowMesh.renderOrder = CLOUD_SHADOW_RENDER_ORDER;
      shadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      shadowMesh.raycast = () => { };
      this.shadowLayer.add(shadowMesh);
    }

    const group = new THREE.Group();
    group.name = 'cloud';
    const meshes = [];
    // A cloud uses 3-6 of these; extra meshes stay hidden and are reused on
    // recycle, so no geometry is created after init().
    for (let i = 0; i < 8; i++) {
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.userData.isCloud = true;
      // Explicitly keep clouds out of any future raycasting. Picking is
      // currently math-based (pickHexCell), but this makes the rule local.
      mesh.raycast = () => { };
      // Cloud shadows are separate ground-projected blobs, not shadow-map
      // casters, so keep the real shadow pass out of this.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = CLOUD_RENDER_ORDER;
      mesh.visible = false;
      group.add(mesh);
      meshes.push(mesh);
    }
    this.group.add(group);

    return {
      group,
      material,
      meshes,
      shadowMaterial,
      shadowMesh,
      baseX: 0,
      baseZ: 0,
      altitude: this.altitudeMin,
      speedMultiplier: 1,
      peakOpacity: 0.55,
      bobAmplitude: 0.2,
      bobSpeed: 0.5,
      bobPhase: 0,
      driftAmplitude: 0.35,
      driftSpeed: 0.3,
      driftPhase: 0,
    };
  }

  /**
   * Resets a cloud's layout, altitude, speed and motion. New clouds are seeded
   * uniformly across the map disc; recycled clouds re-enter along the full
   * upwind edge.
   */
  _seedCloud(cloud, initial) {
    if (initial) {
      // Pre-populate the whole map disc, uniformly by area, so the sky is
      // covered on turn 1 instead of showing a narrow wind-aligned band.
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(Math.random()) * this.maxMapRadius;
      cloud.baseX = Math.cos(angle) * radius;
      cloud.baseZ = Math.sin(angle) * radius;
    } else {
      // Respawn along the full upwind edge, not a narrow arc. Lateral offset
      // spans the whole map width, so every strip of the map eventually gets
      // clouds regardless of its position relative to the wind vector.
      const lateral = (Math.random() * 2 - 1) * this.maxMapRadius;
      const distance = this.outerRadius * (1.01 + Math.random() * 0.08);
      cloud.baseX = -WIND_DIRECTION.x * distance + this._perpX * lateral;
      cloud.baseZ = -WIND_DIRECTION.z * distance + this._perpZ * lateral;
    }

    cloud.altitude = THREE.MathUtils.lerp(this.altitudeMin, this.altitudeMax, Math.random());
    cloud.speedMultiplier = THREE.MathUtils.lerp(0.75, 1.25, Math.random());
    cloud.peakOpacity = THREE.MathUtils.lerp(0.45, 0.65, Math.random());

    // Slow bobbing and lateral drift keep the clouds from looking rigid.
    cloud.bobAmplitude = THREE.MathUtils.lerp(0.08, 0.3, Math.random());
    cloud.bobSpeed = THREE.MathUtils.lerp(0.25, 0.7, Math.random());
    cloud.bobPhase = Math.random() * Math.PI * 2;
    cloud.driftAmplitude = THREE.MathUtils.lerp(0.15, 0.55, Math.random());
    cloud.driftSpeed = THREE.MathUtils.lerp(0.15, 0.45, Math.random());
    cloud.driftPhase = Math.random() * Math.PI * 2;

    const scale = THREE.MathUtils.lerp(this.sizeMin, this.sizeMax, Math.random());
    cloud.group.scale.setScalar(scale);
    cloud.group.rotation.y = Math.random() * Math.PI * 2;

    this._buildCluster(cloud);
    this._positionCloud(cloud);
    this._updateOpacity(cloud);
  }

  /**
   * Lays out 3-6 non-uniformly scaled spheres: a few large masses near the
   * middle, plus smaller puffs around the outer rim. The local X axis is the
   * long axis, so the finished cluster stays wider than it is tall.
   */
  _buildCluster(cloud) {
    const count = 3 + Math.floor(Math.random() * 4); // 3..6
    const coreCount = Math.min(2, Math.floor(count * 0.4)); // 1..2
    const rimCount = count - coreCount;
    const span = THREE.MathUtils.lerp(1.1, 1.3, Math.random());

    for (const mesh of cloud.meshes) mesh.visible = false;

    // Large core masses, tightly grouped near the center.
    for (let i = 0; i < coreCount; i++) {
      const mesh = cloud.meshes[i];
      const angle = Math.random() * Math.PI * 2;
      const offset = Math.random() * span * 0.28;
      const radius = THREE.MathUtils.lerp(0.72, 1.02, Math.random());
      mesh.visible = true;
      mesh.position.set(
        Math.cos(angle) * offset,
        (Math.random() - 0.5) * 0.28,
        Math.sin(angle) * offset * 0.6
      );
      mesh.scale.set(
        radius * (1.05 + Math.random() * 0.25),
        radius * (0.4 + Math.random() * 0.1),
        radius * (0.9 + Math.random() * 0.2)
      );
    }

    // Smaller puffs around the rim, spread into an ellipse so the silhouette
    // stays elongated horizontally.
    for (let j = 0; j < rimCount; j++) {
      const mesh = cloud.meshes[coreCount + j];
      const angle = (j / rimCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.7;
      const radius = THREE.MathUtils.lerp(0.3, 0.52, Math.random());
      const rx = span * THREE.MathUtils.lerp(0.85, 1.15, Math.random());
      const rz = span * THREE.MathUtils.lerp(0.4, 0.65, Math.random());
      mesh.visible = true;
      mesh.position.set(
        Math.cos(angle) * rx,
        (Math.random() - 0.5) * 0.3,
        Math.sin(angle) * rz
      );
      mesh.scale.set(
        radius * (1.1 + Math.random() * 0.3),
        radius * (0.5 + Math.random() * 0.2),
        radius * (0.9 + Math.random() * 0.3)
      );
    }

    // Soft white to light grey (#ffffff -> #e2e8f0).
    const shade = Math.random();
    cloud.material.color.setRGB(
      1 - 0.114 * shade,
      1 - 0.09 * shade,
      1 - 0.059 * shade
    );
  }

  /** Applies travel position plus bobbing and lateral drift to the group. */
  _positionCloud(cloud) {
    const drift = cloud.driftAmplitude * Math.sin(this.time * cloud.driftSpeed + cloud.driftPhase);
    const bob = cloud.bobAmplitude * Math.sin(this.time * cloud.bobSpeed + cloud.bobPhase);
    cloud.group.position.set(
      cloud.baseX + this._perpX * drift,
      cloud.altitude + bob,
      cloud.baseZ + this._perpZ * drift
    );
  }

  /**
   * Refreshes the sun direction used to project shadows. Shadows hide at
   * night or when the sun is too close to the horizon to read cleanly.
   */
  _updateSunDirection() {
    if (!this.castShadows || !this.sunLight) {
      this._shadowEnabled = false;
      return;
    }

    this.sunLight.getWorldPosition(_sunWorld);
    this.sunLight.target.getWorldPosition(_sunTargetWorld);
    this._shadowLightDir.subVectors(_sunWorld, _sunTargetWorld).normalize();
    this._shadowEnabled = this._shadowLightDir.y > CLOUD_SHADOW_MIN_SUN_Y;
    if (this._shadowEnabled) {
      this._shadowStretch = Math.min(2.5, 1 / Math.max(this._shadowLightDir.y, 0.35));
      this._shadowRotationY = Math.atan2(-this._shadowLightDir.z, this._shadowLightDir.x);
    }
  }

  /**
   * Projects the visible spheres of a cloud onto a flat shadow plane along
   * the sun direction. The shader fades fragments out past the map edge.
   */
  _updateShadows(cloud) {
    if (!cloud.shadowMesh) return;

    if (!this._shadowEnabled || cloud.material.opacity <= 0.005) {
      cloud.shadowMesh.visible = false;
      cloud.shadowMesh.count = 0;
      return;
    }

    cloud.group.updateMatrixWorld(true);
    const groupScale = cloud.group.scale.x;
    const light = this._shadowLightDir;
    const stretch = this._shadowStretch;
    cloud.shadowMaterial.opacity = cloud.material.opacity * this.shadowStrength;

    // Project the whole cluster using one plane. Per-sphere terrain heights
    // made the blobs pop as clouds drifted over stepped hex tiles, and using
    // the bobbing group height made the shadow wobble. Use the base altitude.
    const t = cloud.altitude / light.y;
    const shadowY = CLOUD_SHADOW_PLANE_Y;

    let count = 0;
    for (const source of cloud.meshes) {
      if (!source.visible) continue;

      source.getWorldPosition(_shadowWorld);
      const sx = _shadowWorld.x - light.x * t;
      const sz = _shadowWorld.z - light.z * t;
      const radius = Math.max(source.scale.x, source.scale.z) * groupScale;
      const scale = radius * CLOUD_SHADOW_SCALE;

      _shadowPos.set(sx, shadowY, sz);
      _shadowScale.set(scale * stretch, 1, scale);
      _shadowEuler.set(0, this._shadowRotationY, 0);
      _shadowQuat.setFromEuler(_shadowEuler);
      _shadowMatrix.compose(_shadowPos, _shadowQuat, _shadowScale);
      cloud.shadowMesh.setMatrixAt(count, _shadowMatrix);
      count++;
    }

    cloud.shadowMesh.count = count;
    cloud.shadowMesh.instanceMatrix.needsUpdate = true;
    cloud.shadowMesh.visible = count > 0;
  }

  /**
   * Opacity is the product of:
   * - radial fade: full to the map edge, smoothstep to 0 at the outer
   *   spawn/despawn radius;
   * - camera proximity fade: 0 when the camera is inside the cloud, back to
   *   full past CAMERA_FADE_FAR.
   */
  _updateOpacity(cloud) {
    const radius = Math.hypot(cloud.baseX, cloud.baseZ);
    let radial = 0;
    if (radius <= this.innerRadius) {
      radial = 1;
    } else if (radius < this.outerRadius && this.outerRadius > this.innerRadius) {
      radial = 1 - THREE.MathUtils.smoothstep(radius, this.innerRadius, this.outerRadius);
    }

    const cameraFade = this._cameraFade(cloud);
    const opacity = cloud.peakOpacity * radial * cameraFade;
    cloud.material.opacity = opacity;
    cloud.group.visible = opacity > 0.005;
  }

  /** Smooth fade for clouds near the camera (close-up inspection). */
  _cameraFade(cloud) {
    const p = cloud.group.position;
    const c = this.camera.position;
    const distance = Math.sqrt(
      (p.x - c.x) * (p.x - c.x) +
      (p.y - c.y) * (p.y - c.y) +
      (p.z - c.z) * (p.z - c.z)
    );
    return THREE.MathUtils.smoothstep(distance, CAMERA_FADE_NEAR, CAMERA_FADE_FAR);
  }
}
