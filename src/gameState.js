import { TERRAIN_CONFIG } from './config.js';

/**
 * GameState tracks players and the hex grid cells.
 * It is fully serializable to and from JSON.
 */
export class GameState {
  constructor() {
    this.players = [];
    this.cells = {}; // Key: "q,r", Value: { q, r, terrain, owner }
  }

  /**
   * Generates a hexagonal map of a given radius filled with randomized terrain types.
   * @param {number} radius - Grid radius (number of hex rings from the center)
   */
  generateMap(radius) {
    this.cells = {};
    
    // Clear and add default placeholder players
    this.players = [
      { id: 1, name: 'Red Empire', color: '#ff4d4d' },
      { id: 2, name: 'Blue Alliance', color: '#3399ff' }
    ];

    const terrainTypes = Object.keys(TERRAIN_CONFIG);
    // Simple distribution weight: Plains (50%), Hills (20%), Mountains (15%), Water (15%)
    const terrainPool = [
      ...Array(10).fill('plains'),
      ...Array(4).fill('hills'),
      ...Array(3).fill('mountains'),
      ...Array(3).fill('water')
    ];

    for (let q = -radius; q <= radius; q++) {
      const rMin = Math.max(-radius, -q - radius);
      const rMax = Math.min(radius, -q + radius);
      
      for (let r = rMin; r <= rMax; r++) {
        // Randomly select a terrain type
        const randomIndex = Math.floor(Math.random() * terrainPool.length);
        const terrain = terrainPool[randomIndex];
        
        // Key is the string "q,r" for easy indexing and serialization
        this.cells[`${q},${r}`] = {
          q,
          r,
          terrain,
          owner: null // No owner by default in Phase 1
        };
      }
    }
  }

  /**
   * Serializes the game state to a JSON string.
   * @returns {string} Serialized game state
   */
  serialize() {
    return JSON.stringify({
      players: this.players,
      cells: this.cells
    });
  }

  /**
   * Deserializes a JSON string to populate the game state.
   * @param {string} jsonString - Serialized state
   * @returns {GameState} Returns this instance for chaining
   */
  deserialize(jsonString) {
    try {
      const data = JSON.parse(jsonString);
      this.players = data.players || [];
      this.cells = data.cells || {};
    } catch (e) {
      console.error('Failed to deserialize GameState:', e);
    }
    return this;
  }
}
