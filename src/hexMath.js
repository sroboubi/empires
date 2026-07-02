/**
 * Hex grid math helper functions for Pointy-Topped Hexagonal Grid.
 * Coordinates are represented by axial coordinates (q, r).
 */

/**
 * Converts axial coordinates to 3D Cartesian coordinates (x, z) on the flat plane.
 * @param {number} q - Axial column coordinate
 * @param {number} r - Axial row coordinate
 * @param {number} size - Outer radius of the hexagon (distance from center to corner)
 * @returns {{x: number, z: number}} Coordinates on the flat XZ plane
 */
export function axialToPixel(q, r, size) {
  const x = size * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r);
  const z = size * (1.5 * r);
  return { x, z };
}

/**
 * Converts 3D Cartesian coordinates (x, z) to axial coordinates (q, r).
 * @param {number} x
 * @param {number} z
 * @param {number} size - Outer radius of the hexagon
 * @returns {{q: number, r: number}} Closest hex axial coordinates
 */
export function pixelToAxial(x, z, size) {
  const q = ((Math.sqrt(3) / 3) * x - (1 / 3) * z) / size;
  const r = ((2 / 3) * z) / size;
  return hexRound(q, r);
}

/**
 * Rounds fractional axial coordinates to the nearest integer axial coordinates.
 * @param {number} q
 * @param {number} r
 * @returns {{q: number, r: number}} Rounded axial coordinates
 */
export function hexRound(q, r) {
  const s = -q - r;
  let qi = Math.round(q);
  let ri = Math.round(r);
  let si = Math.round(s);

  const qDiff = Math.abs(qi - q);
  const rDiff = Math.abs(ri - r);
  const sDiff = Math.abs(si - s);

  if (qDiff > rDiff && qDiff > sDiff) {
    qi = -ri - si;
  } else if (rDiff > sDiff) {
    ri = -qi - si;
  } else {
    si = -qi - ri;
  }

  return { q: qi, r: ri };
}

/**
 * Calculates the axial distance between two hexes.
 * @param {{q: number, r: number}} a
 * @param {{q: number, r: number}} b
 * @returns {number} Distance in hex steps
 */
export function distance(a, b) {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}

/**
 * Checks if two hexes are adjacent neighbors.
 * @param {{q: number, r: number}} a
 * @param {{q: number, r: number}} b
 * @returns {boolean} True if they are neighbors, false otherwise
 */
export function isNeighbor(a, b) {
  return distance(a, b) === 1;
}

/**
 * Gets the axial coordinates of all 6 neighbors of a given hex.
 * @param {number} q
 * @param {number} r
 * @returns {Array<{q: number, r: number}>} List of neighbor axial coordinates
 */
export function getNeighbors(q, r) {
  const directions = [
    { q: 1, r: 0 },
    { q: 1, r: -1 },
    { q: 0, r: -1 },
    { q: -1, r: 0 },
    { q: -1, r: 1 },
    { q: 0, r: 1 }
  ];
  return directions.map(d => ({ q: q + d.q, r: r + d.r }));
}
