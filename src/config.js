/**
 * Game configuration module.
 * Centralizes all engine properties, grid layout parameters, and terrain details.
 */
export const CONFIG = {
  HEX_SIZE: 1.0,
  GRID_RADIUS: 16,

  TERRAIN: {
    plains: {
      name: 'Plains',
      height: 0.2,
      material: {
        color: 0x58d68d,       // Soft green
        roughness: 0.8,
        metalness: 0.1,
        flatShading: true
      }
    },
    hills: {
      name: 'Hills',
      height: 0.8,
      material: {
        color: 0xe59866,       // Warm orange-brown
        roughness: 0.8,
        metalness: 0.1,
        flatShading: true
      }
    },
    mountains: {
      name: 'Mountains',
      height: 2.0,
      material: {
        color: 0xb2babb,       // Grey
        roughness: 0.7,
        metalness: 0.2,
        flatShading: true
      }
    },
    water: {
      name: 'Water',
      height: 0.1,
      material: {
        color: 0x3498db,       // Sky blue
        roughness: 0.1,
        metalness: 0.8,
        transparent: true,
        opacity: 0.75,
        flatShading: true
      }
    }
  }
};
