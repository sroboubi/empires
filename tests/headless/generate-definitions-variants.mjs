#!/usr/bin/env node
/**
 * Generate test-only definition variants for the AI resilience probes (#72).
 *
 * Reads the current `definitions/entities.json` and `definitions/terrains.json`
 * from the repo, applies one named change, and writes a complete replacement
 * file into `tests/headless/definitions-variants/<name>/`. The suite runner
 * selects it with `"definitionsDir": "definitions-variants/<name>"`; files the
 * variant does not contain fall back to the repo copy.
 *
 * Generated files are full copies so a run is auditable and reproducible from
 * the suite plus the directory. Re-run this script after changing the base
 * definitions; do not hand-edit the variants.
 *
 * Usage:
 *   node generate-definitions-variants.mjs            # write all variants
 *   node generate-definitions-variants.mjs c1 c3      # write selected ones
 *   node generate-definitions-variants.mjs --list
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_ROOT = path.join(__dirname, 'definitions-variants');
const ENTITIES_PATH = path.join(REPO_ROOT, 'definitions', 'entities.json');
const TERRAINS_PATH = path.join(REPO_ROOT, 'definitions', 'terrains.json');

const clone = (value) => JSON.parse(JSON.stringify(value));
const round2 = (value) => Math.round(value * 100) / 100;

function entities() {
  return clone(JSON.parse(readFileSync(ENTITIES_PATH, 'utf-8')));
}
function terrains() {
  return clone(JSON.parse(readFileSync(TERRAINS_PATH, 'utf-8')));
}
const isCombat = (entity) => !!entity.movement && (entity.damage?.value || 0) > 0 && !(entity.buildables?.length);
const isBuilder = (entity) => !!entity.movement && (entity.buildables?.length || 0) > 0;

function scaleSpawnCost(entity, factor) {
  for (const key of Object.keys(entity.spawnCost || {})) {
    entity.spawnCost[key] = round2(entity.spawnCost[key] * factor);
  }
}

const VARIANTS = {
  'c1-combat-cost-x1.25': {
    description: 'Combat-unit spawn costs x1.25',
    build() {
      const data = entities();
      for (const entity of data) if (isCombat(entity)) scaleSpawnCost(entity, 1.25);
      return { entities: data };
    },
  },
  'c2-builder-cost-x1.25': {
    description: 'Worker/settler spawn costs x1.25',
    build() {
      const data = entities();
      for (const entity of data) if (isBuilder(entity)) scaleSpawnCost(entity, 1.25);
      return { entities: data };
    },
  },
  'c3-combat-hp-x0.8': {
    description: 'Combat-unit HP x0.8',
    build() {
      const data = entities();
      for (const entity of data) {
        if (!isCombat(entity)) continue;
        entity.health = Math.round(entity.health * 0.8);
        entity.maxHealth = Math.round(entity.maxHealth * 0.8);
      }
      return { entities: data };
    },
  },
  'c4-yields-x1.3': {
    description: 'Economy-building yields x1.3',
    build() {
      const data = entities();
      for (const entity of data) {
        for (const key of Object.keys(entity.yields || {})) {
          entity.yields[key] = round2(entity.yields[key] * 1.3);
        }
      }
      return { entities: data };
    },
  },
  'c5-terrain-move-plus1': {
    description: 'Hills / Mountains / Swamp movement cost +1',
    build() {
      const data = terrains();
      const target = new Set(['Hills', 'Mountains', 'Swamp']);
      for (const terrain of data) {
        if (target.has(terrain.name)) terrain.movementCost = round2((terrain.movementCost || 1) + 1);
      }
      return { terrains: data };
    },
  },
  'c6-barbarian-hp-old': {
    description: 'Barbarian HP restored to the pre-nerf values (300/250/400)',
    build() {
      const data = entities();
      const old = { barbarian: 300, barbarianPrincess: 250, barbarianChief: 400 };
      for (const entity of data) {
        if (!(entity.name in old)) continue;
        entity.health = old[entity.name];
        entity.maxHealth = old[entity.name];
      }
      return { entities: data };
    },
  },
  'c7-barbarian-hp-x1.5': {
    description: 'Barbarian HP x1.5',
    build() {
      const data = entities();
      const barbarians = new Set(['barbarian', 'barbarianPrincess', 'barbarianChief']);
      for (const entity of data) {
        if (!barbarians.has(entity.name)) continue;
        entity.health = Math.round(entity.health * 1.5);
        entity.maxHealth = Math.round(entity.maxHealth * 1.5);
      }
      return { entities: data };
    },
  },
};

const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const [id, variant] of Object.entries(VARIANTS)) console.log(`${id}\t${variant.description}`);
  process.exit(0);
}
const requested = args.length ? args : Object.keys(VARIANTS);
const selected = requested.map((arg) => {
  if (VARIANTS[arg]) return arg;
  const matches = Object.keys(VARIANTS).filter((id) => id === arg || id.startsWith(arg + '-') || id.split('-')[0] === arg);
  if (matches.length === 1) return matches[0];
  return null;
});
for (const id of selected) {
  if (!id) {
    console.error('Unknown or ambiguous variant. Use --list to see the names.');
    process.exit(1);
  }
  const variant = VARIANTS[id];
  if (!variant) {
    console.error(`Unknown variant "${id}". Use --list to see the names.`);
    process.exit(1);
  }
  const dir = path.join(OUT_ROOT, id);
  mkdirSync(dir, { recursive: true });
  const files = variant.build();
  for (const [name, data] of Object.entries(files)) {
    writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data, null, 2) + '\n');
  }
  console.log(`${id}: ${variant.description} -> ${path.relative(REPO_ROOT, dir)}`);
}
