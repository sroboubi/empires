/**
 * 3D compass overlay for the bottom-left of the view.
 *
 * A semi-transparent sphere with a north-pointing arrow (cone). The compass
 * stays fixed in screen space; the arrow rotates to indicate world north
 * relative to the camera's current orientation.
 *
 * Usage:
 *   import { Compass } from './compass.js';
 *   const compass = new Compass(scene, camera);
 *   // in the render loop:
 *   compass.update();
 */
import * as THREE from 'three';

export class Compass {
    /**
     * @param {THREE.Scene} scene - Main scene to add the compass to.
     * @param {THREE.PerspectiveCamera} camera - Main camera (for positioning).
     * @param {Object} [options]
     * @param {number} [options.size=1.2] - Radius of the compass sphere.
     * @param {number} [options.opacity=0.35] - Sphere opacity.
     */
    constructor(scene, camera, options = {}) {
        this.scene = scene;
        this.camera = camera;
        this.size = options.size ?? 1.2;
        this.opacity = options.opacity ?? 0.35;

        this.group = new THREE.Group();

        // Semi-transparent sphere (the compass housing)
        const sphereGeo = new THREE.SphereGeometry(this.size, 32, 24);
        const sphereMat = new THREE.MeshBasicMaterial({
            color: 0x1a1a2e,
            transparent: true,
            opacity: this.opacity,
            depthTest: false,
        });
        this.sphere = new THREE.Mesh(sphereGeo, sphereMat);
        this.sphere.renderOrder = 999;
        this.group.add(this.sphere);

        // Thin ring around the equator for style
        const ringGeo = new THREE.TorusGeometry(this.size * 1.02, 0.02, 8, 48);
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0x888899,
            transparent: true,
            opacity: 0.6,
            depthTest: false,
        });
        this.ring = new THREE.Mesh(ringGeo, ringMat);
        this.ring.renderOrder = 1000;
        this.group.add(this.ring);

        // North arrow: a cone (pyramid-like) pointing +Z in compass local space.
        // We'll orient the group so local +Z aims at world north.
        const arrowLen = this.size * 1.1;
        const coneGeo = new THREE.ConeGeometry(this.size * 0.22, arrowLen, 4);
        const coneMat = new THREE.MeshBasicMaterial({
            color: 0xe74c3c, // red = north
            transparent: true,
            opacity: 0.9,
            depthTest: false,
        });
        this.arrow = new THREE.Mesh(coneGeo, coneMat);
        // Cone points +Y by default; rotate to point +Z (north in local space)
        this.arrow.rotation.x = Math.PI / 2;
        this.arrow.position.z = arrowLen * 0.35;
        this.arrow.renderOrder = 1001;
        this.group.add(this.arrow);

        // Small "N" marker: a short white cone opposite the arrow base for
        // visual balance (points south, smaller, dimmer).
        const tailGeo = new THREE.ConeGeometry(this.size * 0.14, arrowLen * 0.5, 4);
        const tailMat = new THREE.MeshBasicMaterial({
            color: 0xbbbbbb,
            transparent: true,
            opacity: 0.5,
            depthTest: false,
        });
        this.tail = new THREE.Mesh(tailGeo, tailMat);
        this.tail.rotation.x = -Math.PI / 2;
        this.tail.position.z = -arrowLen * 0.25;
        this.tail.renderOrder = 1001;
        this.group.add(this.tail);

        // Don't let the compass be occluded or occlude: render on top.
        this.group.traverse(o => { if (o.isMesh) o.frustumCulled = false; });

        scene.add(this.group);

        // Scratch vectors (avoid per-frame allocation)
        this._offset = new THREE.Vector3();
        this._camDir = new THREE.Vector3();
        this._north = new THREE.Vector3();
        this._lookTarget = new THREE.Vector3();
    }

    /**
     * Reposition the compass in the bottom-left of the view and rotate the
     * arrow to point at world north. Call every frame.
     *
     * World north is -Z in world space (matching hex grid convention where
     * north is up on the default camera view).
     */
    update() {
        const cam = this.camera;
        if (!cam) return;

        // Place the compass at a fixed offset in camera space: bottom-left,
        // slightly in front of the near plane.
        const dist = 8;
        // NDC (-0.85, -0.8) -> bottom-left
        this._offset.set(-0.85, -0.8, -1).normalize().multiplyScalar(dist);
        this._offset.applyQuaternion(cam.quaternion);
        this.group.position.copy(cam.position).add(this._offset);

        // Orient the arrow toward world north, projected onto the plane
        // facing the camera. We want the compass to behave like a real
        // compass held up to the view: the arrow swings as the camera orbits.
        //
        // Approach: make the group look at the camera (billboard), then
        // rotate around the view axis so local +Z points at world north's
        // screen-projected direction.
        this._lookTarget.copy(cam.position);
        this.group.lookAt(this._lookTarget);

        // World north (-Z). Project onto the compass's local XY plane
        // (the plane facing the camera after lookAt).
        this._north.set(0, 0, -1);
        // Transform world north into compass local space
        const inv = this.group.quaternion.clone().invert();
        this._north.applyQuaternion(inv);
        // We want local +Z (arrow direction) to point along the projected north.
        // Compute the angle in the local XY plane and roll the group.
        const angle = Math.atan2(this._north.y, this._north.x);
        // Arrow points +Z; after lookAt, +Z faces the camera. We roll around
        // local Z so that the arrow's "up" (local +Y before roll) aligns with
        // the projected north direction. Simpler: rotate the arrow mesh itself.
        this.arrow.rotation.z = 0;
        this.tail.rotation.z = 0;
        // Roll the whole group around its local Z (view axis)
        // Desired: local +Y should point toward projected north.
        // Current local +Y after lookAt points "up" on screen.
        // Projected north angle measured from +X axis; +Y is at 90°.
        const roll = angle - Math.PI / 2;
        this.group.rotateZ(roll);
    }

    /** Remove the compass from the scene and free resources. */
    dispose() {
        this.scene.remove(this.group);
        this.group.traverse(o => {
            if (o.isMesh) {
                o.geometry.dispose();
                o.material.dispose();
            }
        });
    }
}
