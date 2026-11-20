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
 *   clouds.init(maxMapRadius);   // after the map is generated
 *   clouds.update(deltaTime);    // every frame
 *   clouds.dispose();            // when the map or scene goes away
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
// clouds to draw after it; otherwise camera-dependent transparent sorting can
// put a water bucket after a cloud and paint over it (clouds never write depth).
const CLOUD_RENDER_ORDER = 1;
// Shared stochastic alpha mask for partial cloud shadows. The shadow pass
// reads the green channel of alphaMap, so all channels hold the same byte.
const CLOUD_SHADOW_NOISE_SIZE = 256;
const CLOUD_SHADOW_NOISE_REPEAT = 16;

export class CloudManager {
  /**
   * @param {THREE.Scene} scene - Scene to add the cloud layer to.
   * @param {THREE.Camera} camera - Camera used for the proximity fade.
   * @param {Object} [options]
   * @param {boolean} [options.enabled] - Override CONFIG.CLOUDS_ENABLED.
   * @param {boolean} [options.castShadows] - Override CONFIG.CLOUD_CAST_SHADOWS.
   * @param {number} [options.windSpeed] - Override CONFIG.CLOUD_WIND_SPEED.
   * @param {number} [options.density] - Override CONFIG.CLOUD_DENSITY.
   * @param {number} [options.sizeMin] - Override CONFIG.CLOUD_SIZE_MIN.
   * @param {number} [options.sizeMax] - Override CONFIG.CLOUD_SIZE_MAX.
   * @param {number} [options.altitudeMin] - Override CONFIG.CLOUD_ALTITUDE_MIN.
   * @param {number} [options.altitudeMax] - Override CONFIG.CLOUD_ALTITUDE_MAX.
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
    this.hexSize = CONFIG.HEX_SIZE;

    this.group = null;
    this.geometry = null;
    this.shadowNoiseTexture = null;
    this.clouds = [];
    this.time = 0;

    this.maxMapRadius = 0;
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

    this.geometry = new THREE.IcosahedronGeometry(1, 1);
    this.group = new THREE.Group();
    this.group.name = 'cloudLayer';
    this.group.userData.isCloudLayer = true;
    this.scene.add(this.group);
    this.shadowNoiseTexture = this._createShadowNoiseTexture();

    this.time = 0;
    // Density is expressed as clouds per 100 map cells.
    const cellCount = Number.isFinite(mapCellCount) && mapCellCount > 0
      ? mapCellCount
      : this._estimateCellCount(maxMapRadius);
    const count = Math.round(cellCount * this.density / 100);
    console.log(`[clouds] density ${this.density} -> ${count} clouds (${Math.round(cellCount)} cells)`);
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
    }
  }

  /**
   * Removes the cloud layer and frees every GPU resource it owns.
   */
  dispose() {
    for (const cloud of this.clouds) {
      if (cloud.material) cloud.material.dispose();
      if (cloud.depthMaterial) cloud.depthMaterial.dispose();
      cloud.meshes.length = 0;
    }
    this.clouds.length = 0;

    if (this.group && this.scene) this.scene.remove(this.group);
    this.group = null;

    if (this.shadowNoiseTexture) {
      this.shadowNoiseTexture.dispose();
      this.shadowNoiseTexture = null;
    }

    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }

    this.maxMapRadius = 0;
    this.innerRadius = 0;
    this.outerRadius = 0;
  }

  // -------------------------------------------------------------------------
  // Internal cloud construction
  // -------------------------------------------------------------------------

  /**
   * Shared random alpha mask for dithered partial shadows. One texture is
   * created per cloud-layer init and reused by every cloud's depth material.
   */
  _createShadowNoiseTexture() {
    const size = CLOUD_SHADOW_NOISE_SIZE;
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < data.length; i += 4) {
      const value = Math.floor(Math.random() * 256);
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }

    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(CLOUD_SHADOW_NOISE_REPEAT, CLOUD_SHADOW_NOISE_REPEAT);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    return texture;
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
    // The shadow pass ignores opacity, so a depth material with a noise mask
    // turns opacity into shadow density: alphaTest = 1 - opacity.
    const depthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      alphaMap: this.shadowNoiseTexture,
      alphaTest: 1,
    });
    depthMaterial.userData.alphaTest = 1;
    // r160's shadow pass overwrites alphaMap/alphaTest from the color
    // material before rendering the caster. Restore ours just before use.
    const restoreShadowAlpha = () => {
      depthMaterial.alphaMap = this.shadowNoiseTexture;
      depthMaterial.alphaTest = depthMaterial.userData.alphaTest;
    };

    const group = new THREE.Group();
    group.name = 'cloud';
    const meshes = [];
    // A cloud uses 4-8 of these; extra meshes stay hidden and are reused on
    // recycle, so no geometry is created after init().
    for (let i = 0; i < 8; i++) {
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.userData.isCloud = true;
      // Explicitly keep clouds out of any future raycasting. Picking is
      // currently math-based (pickHexCell), but this makes the rule local.
      mesh.raycast = () => { };
      mesh.castShadow = this.castShadows;
      mesh.customDepthMaterial = depthMaterial;
      mesh.onBeforeShadow = restoreShadowAlpha;
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
      depthMaterial,
      meshes,
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
   * Resets a cloud's layout, altitude, speed and motion. Initial seeding
   * spreads clouds along the wind corridor; recycled clouds come from a
   * randomized upwind arc outside the despawn radius.
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
   * Lays out 4-8 non-uniformly scaled spheres: a few large masses near the
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
    cloud.depthMaterial.alphaTest = 1 - opacity;
    cloud.depthMaterial.userData.alphaTest = 1 - opacity;
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
