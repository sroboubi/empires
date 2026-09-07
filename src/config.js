/**
 * Game configuration module.
 * Centralizes all engine properties, grid layout parameters.
 */
export var CONFIG = {
  HEX_SIZE: 1.0,
  FRIENDLY_FIRE: false,
  SHOW_ALL: false,
  AI_ACTION_SLEEP: 500,  // ms
  PAN_CAMERA_ON_HUMAN_TURN: true,
  PAN_CAMERA_ON_AI_TURN: false,
};

// Parse the current URL parameters
const urlParams = new URLSearchParams(window.location.search);

// Loop through the URL parameters and update the CONFIG properties
urlParams.forEach((value, key) => {
  // 1. Only update if the property already exists on your target object
  if (key in CONFIG) {
    const targetType = typeof CONFIG[key];

    // 2. Cast the string value dynamically based on the target type
    if (targetType === "number") {
      CONFIG[key] = Number(value);
    }
    else if (targetType === "boolean") {
      // URL string "true" becomes true, anything else becomes false
      CONFIG[key] = value.toLowerCase() === "true";
    }
    else {
      // Default fallback for strings
      CONFIG[key] = value;
    }
  }
});

console.log("Effective CONFIG:", CONFIG);
