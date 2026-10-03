/**
 * Loader for the game configuration definitions.
 * Loads definition files (entities, naturalResources, treasures, terrains, audio, defaultSettings)
 * and initializes statically loaded Entity class metadata.
 */
import Entity from './entity.js';
import { CONFIG } from './config.js';

/**
 * Loads the game definitions and default settings by reading individual definition files.
 * Supports URL overrides via argument or CONFIG.
 *
 * @param {Object} [overrides={}] - Optional custom definition URL overrides
 * @returns {Promise<Object>} The composite manifest data structure including defaultSettings
 */
export async function loadGameManifest(overrides = {}) {
  const urls = overrides || {};

  const entitiesUrl = urls.entitiesUrl || urls.ENTITIES_URL || CONFIG.ENTITIES_URL || './definitions/entities.json';
  const naturalResourcesUrl = urls.naturalResourcesUrl || urls.NATURAL_RESOURCES_URL || CONFIG.NATURAL_RESOURCES_URL || './definitions/naturalResources.json';
  const treasuresUrl = urls.treasuresUrl || urls.TREASURES_URL || CONFIG.TREASURES_URL || './definitions/treasures.json';
  const terrainsUrl = urls.terrainsUrl || urls.TERRAINS_URL || CONFIG.TERRAINS_URL || './definitions/terrains.json';
  const audioUrl = urls.audioUrl || urls.AUDIO_URL || CONFIG.AUDIO_URL || './definitions/audio.json';
  const defaultSettingsUrl = urls.defaultSettingsUrl || urls.DEFAULT_SETTINGS_URL || CONFIG.DEFAULT_SETTINGS_URL || './definitions/defaultSettings.json';

  console.log(`Loading game definitions from:
  - Entities: ${entitiesUrl}
  - Natural Resources: ${naturalResourcesUrl}
  - Treasures: ${treasuresUrl}
  - Terrains: ${terrainsUrl}
  - Audio: ${audioUrl}
  - Default Settings: ${defaultSettingsUrl}`);

  const [entitiesRes, naturalResourcesRes, treasuresRes, terrainsRes, audioRes, defaultSettingsRes] = await Promise.all([
    fetch(entitiesUrl).then(r => {
      if (!r.ok) throw new Error(`Failed to load entities from ${entitiesUrl}: ${r.statusText}`);
      return r.json();
    }),
    fetch(naturalResourcesUrl).then(r => {
      if (!r.ok) throw new Error(`Failed to load natural resources from ${naturalResourcesUrl}: ${r.statusText}`);
      return r.json();
    }),
    fetch(treasuresUrl).then(r => {
      if (!r.ok) throw new Error(`Failed to load treasures from ${treasuresUrl}: ${r.statusText}`);
      return r.json();
    }),
    fetch(terrainsUrl).then(r => {
      if (!r.ok) throw new Error(`Failed to load terrains from ${terrainsUrl}: ${r.statusText}`);
      return r.json();
    }),
    fetch(audioUrl).then(r => {
      if (!r.ok) throw new Error(`Failed to load audio from ${audioUrl}: ${r.statusText}`);
      return r.json();
    }),
    fetch(defaultSettingsUrl).then(r => {
      if (!r.ok) throw new Error(`Failed to load default settings from ${defaultSettingsUrl}: ${r.statusText}`);
      return r.json();
    })
  ]);

  return processManifestPayload({
    entities: entitiesRes,
    naturalResources: naturalResourcesRes,
    treasures: treasuresRes,
    terrains: terrainsRes,
    audio: audioRes,
    defaultSettings: defaultSettingsRes
  });
}

/**
 * Normalizes definition data structures and preloads Entity metadata.
 * @param {Object} rawData
 * @returns {Object}
 */
function processManifestPayload(rawData) {
  const rawEntities = Array.isArray(rawData.entities) ? rawData.entities : (rawData.entities?.entities || []);
  const rawNaturalResources = Array.isArray(rawData.naturalResources) ? rawData.naturalResources : (rawData.naturalResources?.naturalResources || []);
  const rawTreasures = Array.isArray(rawData.treasures) ? rawData.treasures : (rawData.treasures?.treasures || []);
  const rawTerrains = Array.isArray(rawData.terrains) ? rawData.terrains : (rawData.terrains?.terrains || []);
  const rawAudio = rawData.audio?.audio || rawData.audio || {};
  const defaultSettings = rawData.defaultSettings || {};

  const entityMetadata = {};

  for (const entity of rawEntities) {
    const absoluteModelUrl = new URL(entity.modelUrl, window.location.href).href;
    const tempInstance = new Entity(entity, null, null, null, null);
    const actions = tempInstance.getActions().map(({ name, description }) => ({ name, description })) || [];

    entityMetadata[entity.name] = {
      ...entity,
      modelUrl: absoluteModelUrl,
      controllerClass: Entity,
      actions: actions
    };
  }

  return {
    entities: entityMetadata,
    naturalResources: rawNaturalResources,
    treasures: rawTreasures,
    terrains: rawTerrains,
    audio: rawAudio,
    defaultSettings: defaultSettings
  };
}
