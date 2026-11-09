/**
 * Seeded random numbers for reproducible maps.
 *
 * createSeededRandom(seed) returns a Math.random-style function (floats in
 * [0, 1)) whose sequence depends only on `seed`. A number or a string seed
 * is accepted. Mulberry32: fast, 32-bit state, good enough for map noise
 * and resource placement (not for anything security-related).
 *
 * This module has no imports so it can be unit-tested in plain Node.
 */
export function createSeededRandom(seed) {
  let state = hashSeed(seed);
  return function random() {
    state = (state + 0x6D2B79F5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the seed's string form, so 1 and "1" give the same map. */
function hashSeed(seed) {
  const text = String(seed);
  let h = 0x811C9DC5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
