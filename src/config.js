/**
 * Game configuration module.
 * Defines terrain-specific properties such as color and height.
 */
export const TERRAIN_CONFIG = {
  plains: {
    name: 'Plains',
    height: 0.2,
    color: 0x58d68d, // Soft green
  },
  hills: {
    name: 'Hills',
    height: 0.8,
    color: 0xe59866, // Warm orange-brown
  },
  mountains: {
    name: 'Mountains',
    height: 2.0,
    color: 0xb2babb, // Grey
  },
  water: {
    name: 'Water',
    height: 0.1,
    color: 0x3498db, // Sky blue
  }
};
