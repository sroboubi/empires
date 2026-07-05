import { createNoise2D } from 'https://esm.sh/simplex-noise@4.0.3';

const terrain = {
    shallowWater: {
        name: 'ShallowWater',
        height: 1.0,
        material: {
            color: 0x3498db,
            roughness: 0.1,
            metalness: 0.8,
            transparent: true,
            opacity: 0.5,
            flatShading: true
        },
        conditions: {
            elevation: { min: -0.7, max: -0.3 }
        }
    },
    deepWater: {
        name: 'DeepWater',
        height: 1.0,
        material: {
            color: 0x1d396e,
            roughness: 0.1,
            metalness: 0.6,
            transparent: true,
            opacity: 0.8,
            flatShading: true
        },
        conditions: {
            elevation: { min: -1, max: -0.7 }
        }
    },
    tundra: {
        name: 'Tundra',
        height: 1.2,
        material: {
            color: 0xe0d3bf,
            roughness: 0.5,
            metalness: 0.3,
            flatShading: true
        },
        conditions: {
            elevation: { min: -0.3, max: 0.3 },
            temperature: { min: -1, max: -0.5 }
        }
    },
    swamp: {
        name: 'Swamp',
        height: 1.1,
        material: {
            color: 0x163b12,
            roughness: 0.8,
            metalness: 0.2,
            flatShading: true
        },
        conditions: {
            elevation: { min: -0.3, max: 0.3 },
            temperature: { min: 0.5, max: 1 },
            humidity: { min: 0, max: 1 }
        }
    },
    grasslands: {
        name: 'Grasslands',
        height: 1.2,
        material: {
            color: 0x13bd32,
            roughness: 0.8,
            metalness: 0.1,
            flatShading: true
        },
        conditions: {
            elevation: { min: -0.3, max: 0.3 },
            temperature: { min: -0.5, max: 0.5 }
        }
    },
    desert: {
        name: 'Desert',
        height: 1.1,
        material: {
            color: 0xb5b333,
            roughness: 0.8,
            metalness: 0.3,
            flatShading: true
        },
        conditions: {
            elevation: { min: -0.3, max: 0.3 },
            temperature: { min: 0.5, max: 1 },
            humidity: { min: -1, max: 0 }
        }
    },
    footHills: {
        name: 'FootHills',
        height: 1.4,
        material: {
            color: 0x768749,
            roughness: 0.8,
            metalness: 0.1,
            flatShading: true
        },
        conditions: {
            elevation: { min: 0.3, max: 0.5 },
            temperature: { min: -0.5, max: 1 }
        }
    },
    hills: {
        name: 'Hills',
        height: 1.6,
        material: {
            color: 0xab771d,
            roughness: 0.8,
            metalness: 0.1,
            flatShading: true
        },
        conditions: {
            elevation: { min: 0.5, max: 0.75 },
            temperature: { min: -0.5, max: 1 }
        }
    },
    mountains: {
        name: 'Mountains',
        height: 2.0,
        material: {
            color: 0x797d6f,
            roughness: 0.7,
            metalness: 0.2,
            flatShading: true
        },
        conditions: {
            elevation: { min: 0.75, max: 1 },
            temperature: { min: -0.5, max: 1 }
        }
    },
    snowyHills: {
        name: 'Snowy Hills',
        height: 1.5,
        material: {
            color: 0xffffff,
            roughness: 0.8,
            metalness: 0.1,
            flatShading: true
        },
        conditions: {
            elevation: { min: 0.3, max: 0.5 },
            temperature: { min: -1, max: -0.5 }
        }
    },
    snowyMountains: {
        name: 'Snowy Mountains',
        height: 2.0,
        material: {
            color: 0xffffff,
            roughness: 0.7,
            metalness: 0.2,
            flatShading: true
        },
        conditions: {
            elevation: { min: 0.5, max: 1 },
            temperature: { min: -1, max: -0.5 }
        }
    },
    default: {
        name: 'Default',
        height: 2.0,
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
            humidity: { min: -2, max: -2 },
        }
    }

};

export class TerrainProvider {
    constructor(radius) {
        this.elevationNoise = createNoise2D();
        this.temperatureNoise = createNoise2D();
        this.humidityNoise = createNoise2D();
        this.radius = radius;
    }

    get(q, r) {
        const elevation = this.elevationNoise(3 * q / this.radius, 3 * r / this.radius)
        const temperature = this.temperatureNoise(q / this.radius, r / this.radius)
        const humidity = this.humidityNoise(5 * q / this.radius, 5 * r / this.radius)

        for (const key in terrain) {
            if (this.meetsCondition(terrain[key].conditions.elevation, elevation) &&
                this.meetsCondition(terrain[key].conditions.temperature, temperature) &&
                this.meetsCondition(terrain[key].conditions.humidity, humidity)) {
                return terrain[key]
            }
        }

        console.warn("no terrain found for", elevation, temperature, humidity);
        return terrain.default;
    }

    meetsCondition(condition, value) {
        return !condition || (value >= condition.min && value < condition.max)
    }
}