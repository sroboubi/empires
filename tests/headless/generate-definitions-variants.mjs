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
 * `definitions/entities.json` uses `1e1000` for impassable water costs. JSON
 * parses that as Infinity and `JSON.stringify` would turn it into null, so
 * writes go through a replacer and every variant is diffed against the base:
 * only the paths the variant intends to change may differ.
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

const clone = (value) => structuredClone(value);
const round2 = (value) => Math.round(value * 100) / 100;

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf-8'));
}
function entities() {
  return clone(readJson(ENTITIES_PATH));
}
function terrains() {
  return clone(readJson(TERRAINS_PATH));
}
const isCombat = (entity) => !!entity.movement && (entity.damage?.value || 0) > 0 && !(entity.buildables?.length);
const isBuilder = (entity) => !!entity.movement && (entity.buildables?.length || 0) > 0;
const keyOf = (index, field) => `[${index}].${field}`;

/**
 * Write JSON while preserving Infinity as the numeric literal `1e1000`
 * (the format the base definitions use). JSON.stringify maps Infinity to
 * null, which would silently change water costs.
 */
const INF_SENTINEL = '__HEADLESS_INFINITY__';
function stringify(data) {
  const text = JSON.stringify(data, (key, value) => {
    if (value === Infinity) return INF_SENTINEL;
    if (value === -Infinity) return `-${INF_SENTINEL}`;
    return value;
  }, 2);
  return `${text.split(`"${INF_SENTINEL}"`).join('1e1000').split(`"-${INF_SENTINEL}"`).join('-1e1000')}\n`;
}

/** Paths whose values differ between two JSON values. */
function diffPaths(before, after, prefix = '') {
  if (Object.is(before, after)) return [];
  const isObj = (v) => v !== null && typeof v === 'object';
  if (!isObj(before) || !isObj(after)) return [prefix];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = [];
  for (const key of keys) {
    const childPrefix = Array.isArray(before) && Array.isArray(after)
      ? `${prefix}[${key}]`
      : (prefix ? `${prefix}.${key}` : key);
    if (!(key in before) || !(key in after)) {
      out.push(childPrefix);
      continue;
    }
    out.push(...diffPaths(before[key], after[key], childPrefix));
  }
  return out;
}

function scaleSpawnCost(entity, factor, touched, index) {
  for (const key of Object.keys(entity.spawnCost || {})) {
    entity.spawnCost[key] = round2(entity.spawnCost[key] * factor);
    touched.add(keyOf(index, `spawnCost.${key}`));
  }
}

const VARIANTS = {
  'c1-combat-cost-x1.25': {
    description: 'Combat-unit spawn costs x1.25',
    build() {
      const data = entities();
      const touched = new Set();
      data.forEach((entity, index) => { if (isCombat(entity)) scaleSpawnCost(entity, 1.25, touched, index); });
      return { files: { entities: data }, touched };
    },
  },
  'c2-builder-cost-x1.25': {
    description: 'Worker/settler spawn costs x1.25',
    build() {
      const data = entities();
      const touched = new Set();
      data.forEach((entity, index) => { if (isBuilder(entity)) scaleSpawnCost(entity, 1.25, touched, index); });
      return { files: { entities: data }, touched };
    },
  },
  'c3-combat-hp-x0.8': {
    description: 'Combat-unit HP x0.8',
    build() {
      const data = entities();
      const touched = new Set();
      data.forEach((entity, index) => {
        if (!isCombat(entity)) return;
        entity.health = Math.round(entity.health * 0.8);
        entity.maxHealth = Math.round(entity.maxHealth * 0.8);
        touched.add(keyOf(index, 'health'));
        touched.add(keyOf(index, 'maxHealth'));
      });
      return { files: { entities: data }, touched };
    },
  },
  'c4-yields-x1.3': {
    description: 'Economy-building yields x1.3',
    build() {
      const data = entities();
      const touched = new Set();
      data.forEach((entity, index) => {
        for (const key of Object.keys(entity.yields || {})) {
          entity.yields[key] = round2(entity.yields[key] * 1.3);
          touched.add(keyOf(index, `yields.${key}`));
        }
      });
      return { files: { entities: data }, touched };
    },
  },
  'c5-terrain-move-plus1': {
    description: 'Hills / Mountains / Swamp movement cost +1',
    build() {
      const data = terrains();
      const touched = new Set();
      const target = new Set(['Hills', 'Mountains', 'Swamp']);
      data.forEach((terrain, index) => {
        if (!target.has(terrain.name)) return;
        terrain.movementCost = round2((terrain.movementCost || 1) + 1);
        touched.add(keyOf(index, 'movementCost'));
      });
      return { files: { terrains: data }, touched };
    },
  },
  'c6-barbarian-hp-old': {
    description: 'Barbarian HP restored to the pre-nerf values (300/250/400)',
    build() {
      const data = entities();
      const touched = new Set();
      const old = { barbarian: 300, barbarianPrincess: 250, barbarianChief: 400 };
      data.forEach((entity, index) => {
        if (!(entity.name in old)) return;
        entity.health = old[entity.name];
        entity.maxHealth = old[entity.name];
        touched.add(keyOf(index, 'health'));
        touched.add(keyOf(index, 'maxHealth'));
      });
      return { files: { entities: data }, touched };
    },
  },
  'c7-barbarian-hp-x1.5': {
    description: 'Barbarian HP x1.5',
    build() {
      const data = entities();
      const touched = new Set();
      const barbarians = new Set(['barbarian', 'barbarianPrincess', 'barbarianChief']);
      data.forEach((entity, index) => {
        if (!barbarians.has(entity.name)) return;
        entity.health = Math.round(entity.health * 1.5);
        entity.maxHealth = Math.round(entity.maxHealth * 1.5);
        touched.add(keyOf(index, 'health'));
        touched.add(keyOf(index, 'maxHealth'));
      });
      return { files: { entities: data }, touched };
    },
  },
};

const BASE = {
  entities: () => readJson(ENTITIES_PATH),
  terrains: () => readJson(TERRAINS_PATH),
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
  return matches.length === 1 ? matches[0] : null;
});
for (const id of selected) {
  if (!id) {
    console.error('Unknown or ambiguous variant. Use --list to see the names.');
    process.exit(1);
  }
  const variant = VARIANTS[id];
  const dir = path.join(OUT_ROOT, id);
  mkdirSync(dir, { recursive: true });
  const { files, touched } = variant.build();
  for (const [name, data] of Object.entries(files)) {
    const unexpected = diffPaths(BASE[name](), data).filter((p) => !touched.has(p));
    if (unexpected.length) {
      console.error(`${id}: refusing to write ${name}.json; unintended differences: ${unexpected.slice(0, 5).join(', ')}${unexpected.length > 5 ? '…' : ''}`);
      process.exit(1);
    }
    writeFileSync(path.join(dir, `${name}.json`), stringify(data));
  }
  console.log(`${id}: ${variant.description} -> ${path.relative(REPO_ROOT, dir)}`);
}
