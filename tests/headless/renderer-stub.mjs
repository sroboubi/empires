export function setUpdateCallback() {}
export function initRenderer() {}
export function setMapCameraLimits() {}
export function updateGroundBase() {}
export function animateToTimeOfDay() {}
export function playSpawnAnimation() {}
export function spawnDamageText() {}
export function spawnParticleBurst() {}
export function drawGrid() {}
export function updateHexFog() {}
export function reconcileEntities() {}
export function clearEntityMeshes() {}
export function highlightCell() {}
export function highlightPathCells() {}
export function clearPathHighlight() {}
export function showExclusionZone() {}
export function clearExclusionZone() {}
export function pickHexCell() {}
export function focusCameraOnEntities() {}
export function setEntitySelectionHighlight() {}
export function clearEntitySelectionHighlight() {}
export function buildCellResources() {}
export function reconcileCellResources() {}
export function clearCellResources() {}
export let scene = null;
export let camera = null;
export let renderer = null;
export let controls = null;
export let dirLight = null;
export let hemiLight = null;
export let sky = null;
export let sunMesh = null;
export let stats = null;
export class Compass { constructor() {} update() {} dispose() {} }
export default {};

// Time-of-day state (replayManager reads it for snapshots; the real renderer
// drives the sun from it). Mirrors renderer.js normalization.
let _timeOfDay = 12;
export function getTimeOfDay() { return _timeOfDay; }
export function setTimeOfDay(hour) {
  _timeOfDay = hour % 24;
  if (_timeOfDay < 0) _timeOfDay += 24;
}
