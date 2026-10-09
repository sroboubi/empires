/**
 * Game configuration module.
 * Centralizes all engine properties, grid layout parameters.
 */
export var CONFIG = {
  HEX_SIZE: 1.0,
  FRIENDLY_FIRE: false,
  SHOW_ALL: false,
  SHOW_FPS: false,
  AI_ACTION_SLEEP: 500,  // ms
  AI_BUILD_MAX_DISTANCE: 10,     // furthest cell from a builder considered as a build site
  AI_BUILD_DISTANCE_PENALTY: 0.2, // weighting of extra travel vs. yield gain when ranking build sites
  PAN_CAMERA_ON_HUMAN_TURN: true,
  PAN_CAMERA_ON_AI_TURN: false,
  MIN_GAME_ROUNDS: 5,
  AUDIO_ENABLED: true,   // master switch for all game audio (query-param overridable)
  AUDIO_VOLUME: 0.8,     // master volume 0..1 (query-param overridable)
  SHADOW_CAMERA_SCALE: 1.2,  // shadow camera half-extent = mapRadius * this (query-param overridable)
  SHADOW_TYPE: 'pcfsoft',    // 'none' | 'basic' | 'pcf' | 'pcfsoft' (query-param overridable via ?shadowtype=)
  ENTITIES_URL: './definitions/entities.json',
  NATURAL_RESOURCES_URL: './definitions/naturalResources.json',
  TREASURES_URL: './definitions/treasures.json',
  TERRAINS_URL: './definitions/terrains.json',
  AUDIO_URL: './definitions/audio.json',
  DEFAULT_SETTINGS_URL: './definitions/defaultSettings.json',
};

// Parse the current URL parameters
const urlParams = new URLSearchParams(window.location.search);

// Loop through the URL parameters and update the CONFIG properties
urlParams.forEach((value, key) => {
  // Find key in CONFIG directly or case-insensitively / ignoring underscores
  let targetKey = key in CONFIG ? key : null;
  if (!targetKey) {
    const normalizedKey = key.replace(/_/g, '').toLowerCase();
    targetKey = Object.keys(CONFIG).find(k => k.replace(/_/g, '').toLowerCase() === normalizedKey);
  }

  if (targetKey) {
    const targetType = typeof CONFIG[targetKey];

    // Cast the string value dynamically based on the target type
    if (targetType === "number") {
      CONFIG[targetKey] = Number(value);
    }
    else if (targetType === "boolean") {
      // URL string "true" becomes true, anything else becomes false
      CONFIG[targetKey] = value.toLowerCase() === "true";
    }
    else {
      // Default fallback for strings
      CONFIG[targetKey] = value;
    }
  }
});

console.log("Effective CONFIG:", CONFIG);
