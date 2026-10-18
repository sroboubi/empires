/**
 * 3D compass overlay for the bottom-right of the view.
 *
 * A semi-transparent sphere with a north-pointing arrow (cone). The compass
 * stays fixed in screen space (billboarded to face the camera); the arrow
 * lies in the screen plane and rotates to indicate world north as the
 * camera orbits.
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
        this.size = options.size ?? 0.4;
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

        // Thin ring around the face for style (lies in XY plane, facing camera)
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

        // North arrow: red cone pointing +Y (up on screen). Base sits at the
        // center so it connects with the tail.
        const arrowLen = this.size * 0.9;
        const coneGeo = new THREE.ConeGeometry(this.size * 0.25, arrowLen, 16);
        const coneMat = new THREE.MeshBasicMaterial({
            color: 0xe74c3c, // red = north
            transparent: true,
            opacity: 0.95,
            depthTest: false,
        });
        this.arrow = new THREE.Mesh(coneGeo, coneMat);
        // Cone geometry is centered; shift up by half length so base is at origin
        this.arrow.position.y = arrowLen / 2;
        this.arrow.renderOrder = 1001;
        // Wrap in a pivot so we can rotate the arrow around Z without moving its base
        this.arrowPivot = new THREE.Group();
        this.arrowPivot.add(this.arrow);
        this.group.add(this.arrowPivot);

        // South tail: smaller dimmer cone pointing -Y, base at center
        const tailLen = arrowLen * 0.6;
        const tailGeo = new THREE.ConeGeometry(this.size * 0.18, tailLen, 16);
        const tailMat = new THREE.MeshBasicMaterial({
            color: 0xbbbbbb,
            transparent: true,
            opacity: 0.6,
            depthTest: false,
        });
        this.tail = new THREE.Mesh(tailGeo, tailMat);
        this.tail.rotation.z = Math.PI; // flip to point -Y
        this.tail.position.y = -tailLen / 2; // base at origin
        this.tail.renderOrder = 1001;
        this.tailPivot = new THREE.Group();
        this.tailPivot.add(this.tail);
        this.group.add(this.tailPivot);

        // Never culled, always on top
        this.group.traverse(o => { if (o.isMesh) o.frustumCulled = false; });

        scene.add(this.group);

        // Scratch (avoid per-frame allocation)
        this._ndc = new THREE.Vector3();
        this._north = new THREE.Vector3();
        this._camPos = new THREE.Vector3();
        this._invQuat = new THREE.Quaternion();
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

        // Place the compass at NDC (0.85, -0.8) — bottom-right of the view.
        // Unproject from NDC to world space at a fixed depth in front of camera.
        const dist = 12;
        this._ndc.set(0.85, -0.8, 0.5); // NDC: x, y, z (0.5 = midway between near/far)
        this._ndc.unproject(cam);
        // Move it to exactly `dist` units from the camera along the view ray
        const dir = this._ndc.sub(cam.position).normalize();
        this.group.position.copy(cam.position).addScaledVector(dir, dist);

        // Billboard: face the camera so the sphere reads as a circle.
        this._camPos.copy(cam.position);
        this.group.lookAt(this._camPos);

        // Project world north onto the screen plane (group local XY after lookAt).
        this._north.set(0, 0, -1); // world north
        this._invQuat.copy(this.group.quaternion).invert();
        this._north.applyQuaternion(this._invQuat);
        // We only care about the direction within the screen plane:
        const angle = Math.atan2(this._north.y, this._north.x);
        // Arrow points +Y (angle PI/2). Rotate pivots around Z to aim at north.
        const roll = angle - Math.PI / 2;
        this.arrowPivot.rotation.z = roll;
        this.tailPivot.rotation.z = roll;
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
