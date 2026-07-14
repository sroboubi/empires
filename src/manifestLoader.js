/**
 * Loader for the game configuration manifest.
 * Preloads dynamic classes for entity controllers.
 */

export const entityMetadata = {};
export const globalResources = [];
export let initializationSettings = null;

/**
 * Loads the game manifest from a JSON URL, preloading controller classes.
 * @param {string} manifestUrl - URL to the manifest JSON file
 * @returns {Promise<Object>} The parsed manifest data structure
 */
export async function loadGameManifest(manifestUrl) {
  console.log(`Loading game manifest from: ${manifestUrl}`);

  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error(`Failed to load manifest from ${manifestUrl}: ${response.statusText}`);
  }

  const manifest = await response.json();

  // Clear previous caches
  globalResources.length = 0;
  for (const key in entityMetadata) {
    delete entityMetadata[key];
  }

  // Cache global resources
  if (manifest.resources) {
    globalResources.push(...manifest.resources);
  }

  // Cache initialization settings
  if (manifest.initialization) {
    initializationSettings = manifest.initialization;
  }

  // Asynchronously preload entity metadata and dynamic JS controller classes
  if (manifest.entities) {
    const baseUri = new URL(manifestUrl, window.location.href);

    for (const entity of manifest.entities) {
      // Resolve path relative to the manifest location
      const absoluteControllerUrl = new URL(entity.controllerUrl, baseUri).href;
      const absoluteModelUrl = new URL(entity.modelUrl, baseUri).href;

      console.log(`Preloading controller class for "${entity.name}" from ${absoluteControllerUrl}`);

      let controllerClass = null;
      try {
        const module = await import(absoluteControllerUrl);
        controllerClass = module.default || module.Controller;
      } catch (err) {
        console.error(`Failed to dynamically import controller for "${entity.name}":`, err);
      }

      entityMetadata[entity.name] = { ...entity, modelUrl: absoluteModelUrl, controllerUrl: absoluteControllerUrl, controllerClass: controllerClass };
    }
  }

  return {
    resources: globalResources,
    entities: entityMetadata,
    initialization: initializationSettings
  };
}
