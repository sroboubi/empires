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
  SHADOW_CAMERA_SCALE: 1.2,  // static pop-free shadow bound = (panRange + maxZoom) * this (query-param overridable)
  SHADOW_MAP_SIZE: 2048,      // shadow map texture resolution (query-param overridable via ?shadowmapsize=)
  SHADOW_TYPE: 'pcfsoft',    // 'none' | 'basic' | 'pcf' | 'pcfsoft' (query-param overridable via ?shadowtype=)
  CAMERA_PAN_MARGIN_RINGS: 6, // hex rings past the map edge the camera target may pan (query-param overridable)
  CAMERA_TILT_CLOSE: 1.05,    // max polar angle (~60 deg) at low camera height, radians (query-param overridable)
  CAMERA_TILT_FAR: 1.31,      // max polar angle (~75 deg) at high camera height, radians (query-param overridable)
  CAMERA_TILT_H_CLOSE: 25,    // below this camera height the close tilt limit applies (query-param overridable)
  CAMERA_TILT_H_FAR: 150,     // above this camera height the far tilt limit applies (query-param overridable)
  CAMERA_ZOOM_SCALE: 1.1,     // max zoom-out distance = map world radius * this (query-param overridable)
  CAMERA_ZOOM_MIN: 60,        // ...but never below this (query-param overridable)
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