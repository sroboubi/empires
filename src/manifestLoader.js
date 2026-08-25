/**
 * Loader for the game configuration manifest.
 * Preloads dynamic classes for entity controllers.
 */

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

  // Asynchronously preload entity metadata and dynamic JS controller classes
  if (manifest.entities) {
    const baseUri = new URL(manifestUrl, window.location.href);
    const entityMetadata = {};

    for (const entity of manifest.entities) {
      // Resolve path relative to the manifest location
      const absoluteControllerUrl = new URL(entity.controllerUrl, baseUri).href;
      const absoluteModelUrl = new URL(entity.modelUrl, baseUri).href;

      console.log(`Preloading controller class for "${entity.name}" from ${absoluteControllerUrl}`);

      try {
        const module = await import(absoluteControllerUrl);
        const controllerClass = module.default || module.Controller;
        const tempInstance = new controllerClass(entity, null, null, null, null);
        const actions = tempInstance.getActions().map(({ name, description }) => ({ name, description })) || [];
        entityMetadata[entity.name] = { ...entity, modelUrl: absoluteModelUrl, controllerUrl: absoluteControllerUrl, controllerClass: controllerClass, actions: actions };
      } catch (err) {
        console.error(`Failed to dynamically import controller for "${entity.name}":`, err);
      }
    }

    manifest.entities = entityMetadata;
  }

  return manifest;
}
