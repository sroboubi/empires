import { createNoise2D } from 'https://esm.sh/simplex-noise@4.0.3';

export const SeaLevel = -0.3;

const defaultTerrain = {
    name: 'Default',
    height: 2.0,
    movementCost: 1,
    material: {
        color: 0xFF1111,
        roughness: 0,
        metalness: 0.8,
        transparent: true,
        opacity: 0.6,
        flatShading: true
    },
    conditions: {
        elevation: { min: -2, max: -2 },
        temperature: { min: -2, max: -2 },
        humidity: { min: -2, max: -2 }
    }
};

export class TerrainProvider {
    /**
     * @param {number} radius - Radius of the hex grid
     * @param {Array|Object} [terrainConfig=null] - Optional terrain definitions loaded from manifest
     */
    constructor(radius, terrainConfig = null) {
        this.elevationNoise = createNoise2D();
        this.temperatureNoise = createNoise2D();
        this.humidityNoise = createNoise2D();
        this.radius = radius;
        this.terrains = terrainConfig
            ? (Array.isArray(terrainConfig) ? terrainConfig : Object.values(terrainConfig))
            : [];
    }

    get(q, r) {
        // values generated between -1 and 1
        const elevation = this.elevationNoise(3 * q / this.radius, 3 * r / this.radius);
        const temperature = this.temperatureNoise(q / this.radius, r / this.radius);
        const humidity = this.humidityNoise(5 * q / this.radius, 5 * r / this.radius);

        for (const t of this.terrains) {
            const cond = t.conditions || {};
            if (this.meetsCondition(cond.elevation, elevation) &&
                this.meetsCondition(cond.temperature, temperature) &&
                this.meetsCondition(cond.humidity, humidity)) {
                return { ...t, elevation, temperature, humidity };
            }
        }

        console.warn("no terrain found for", elevation, temperature, humidity);
        return { ...defaultTerrain, elevation, temperature, humidity };
    }

    meetsCondition(condition, value) {
        return !condition || (value >= condition.min && value < condition.max);
    }
}