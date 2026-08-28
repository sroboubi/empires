import { attack, build, repair, onActionDone } from '../utils.js';
import { HexGrid } from '../../hexGrid.js';
import { camelToTitle } from '../../utils.js';

/**
 * Conventional Goal-Driven Heuristic AI Controller
 * Interface: async function processTurn(player, gameState)
 *
 * Per-order decision model:
 *  - Each iteration inspects the current world and picks the highest priority
 *    action that can succeed. There are two priority bands: HIGH (urgent:
 *    avenging attacks, resource stabilization) and MEDIUM (attacks with
 *    stronger forces, surplus economy, expansion that increases mobile
 *    production or orders, and exploration).
 *  - For every order, we alternate through the high-priority goals first
 *    (round-robin), then fall back to medium-priority goals in round-robin.
 *    This keeps the AI from getting fixated on a single track (e.g. building
 *    mines forever while under military attack).
 *
 * Resource model:
 *  - No hard-coded resource set. Starting levels come from
 *    gameState.initializationSettings.startingResources. Target stock for each
 *    resource is derived from the max of (its starting level, 10x the current
 *    upkeep for that resource, or the maintenance burn of existing units),
 *    so the AI naturally maintains starting levels.
 *  - A resource is considered "in deficit" only if its net income is negative
 *    (yields < upkeep). The AI never builds producers for resources that are
 *    already producing a surplus.
 *  - The only hard-coded resource key is "orders" (filtered out everywhere).
 *
 * Settlement / builder detection:
 *  - Settlers: any entity flagged `destroyOnBuild: true` in its manifest.
 *  - Settlement centers: any construct with a `spawnConditions.minSeparation`
 *    of 3+ (villages/cities); derived from manifest, not magic-numbered.
 *  - Workers / builders: any mobile unit whose `buildables` includes at least
 *    one construct, excluding `destroyOnBuild` entities.
 *  - Military units: any mobile unit with a non-zero `damage.value` AND
 *    `score.military > 0` (workers and settlers have score.military = 1
 *    so we use damage to separate).
 */

// -----------------------------------------------------------------------------
// Logging helpers
// -----------------------------------------------------------------------------

const LOG_STYLES = {
    turn:    'color: #3498db; font-weight: bold;',
    econ:    'color: #f39c12;',
    build:   'color: #2ecc71;',
    explore: 'color: #1abc9c;',
    combat:  'color: #e74c3c; font-weight: bold;',
    warn:    'color: #e67e22; font-weight: bold;',
    detail:  'color: #95a5a6;'
};

const TURN_SLEEP = 2000;       // ms between actions, keeps UI responsive
const ACTION_SLEEP = 1000;     // ms after each action to allow the renderer to paint

function aiLog(player, category, message) {
    const line = `[AI ${player.name}][${category}] ${message}`;
    console.log(`%c${line}`, LOG_STYLES[category] || '');

    if (typeof document !== 'undefined') {
        const buf = window.__AI_LOGS || (window.__AI_LOGS = []);
        buf.push(line);
        if (buf.length > 4000) buf.shift();
        let mirror = document.getElementById('__ai-log-mirror');
        if (!mirror) {
            mirror = document.createElement('div');
            mirror.id = '__ai-log-mirror';
            mirror.style.display = 'none';
            document.documentElement.appendChild(mirror);
        }
        mirror.dataset.count = String(buf.length);
        mirror.dataset.tail = buf.slice(-160).join('\n');
    }
}

function fmtRes(obj) {
    return Object.entries(obj || {}).map(([k, v]) => `${k}:${v}`).join(', ') || '(empty)';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------------
// Manifest classification helpers (no magic numbers for type detection)
// -----------------------------------------------------------------------------

/** All entity types whose manifest entry has `destroyOnBuild: true` (settlers). */
function getSettlerTypes(manifestEntities) {
    return Object.entries(manifestEntities)
        .filter(([_, meta]) => meta && meta.destroyOnBuild)
        .map(([name]) => name);
}

/**
 * Settlement centers are constructs that require non-trivial separation and
 * produce orders or significant economic yield. We derive this from manifest
 * `spawnConditions.minSeparation` rather than hardcoding a number.
 */
function getSettlementCenterTypes(manifestEntities) {
    return Object.entries(manifestEntities)
        .filter(([_, meta]) => {
            if (!meta || !meta.spawnConditions) return false;
            const sep = meta.spawnConditions.minSeparation;
            return typeof sep === 'number' && sep >= 3
                && (meta.yields?.orders || (meta.score?.economic || 0) >= 10);
        })
        .map(([name]) => name);
}

/**
 * Workers (construct builders / repairers) are mobile units that can build
 * constructs but are NOT destroyed on build. They are detected from the
 * manifest via `buildables` and `actionPoints`, not via name strings.
 */
function getWorkerTypes(manifestEntities) {
    return Object.entries(manifestEntities)
        .filter(([_, meta]) => {
            if (!meta) return false;
            if (meta.spawnConditions) return false;     // constructs aren't workers
            if (meta.destroyOnBuild) return false;      // settlers aren't workers
            if (!Array.isArray(meta.buildables) || meta.buildables.length === 0) return false;
            if ((meta.actionPoints || 0) <= 0) return false;
            return true;
        })
        .map(([name]) => name);
}

/**
 * Mobile producers (entities that can be trained to produce more mobile units
 * or to grow the orders economy). Used by the medium-priority expansion
 * branch. A village qualifies because it yields +orders and can build units.
 */
function getMobileProducerTypes(manifestEntities) {
    return Object.entries(manifestEntities)
        .filter(([_, meta]) => {
            if (!meta) return false;
            if (!Array.isArray(meta.buildables) || meta.buildables.length === 0) return false;
            // Construct that produces units OR yields orders
            if (meta.yields?.orders) return true;
            // Or construct that can spawn mobile units (buildables that are mobile)
            if (meta.spawnConditions) {
                return meta.buildables.some(b => {
                    const sub = manifestEntities[b];
                    return sub && !sub.spawnConditions;
                });
            }
            return false;
        })
        .map(([name]) => name);
}

/**
 * Military units are mobile entities that can actually deal meaningful
 * damage. Workers and settlers have damage.value = 10 but are not military;
 * we additionally require manifest.score.military > 0 AND damage.value >= 20
 * (a heuristic derived from manifest values: swordsman=50, bowman=25,
 * horseman=60; civilians = 10). This avoids both magic-number name lists
 * and accidentally enlisting villagers.
 */
function getMilitaryTypes(manifestEntities) {
    return Object.entries(manifestEntities)
        .filter(([_, meta]) => {
            if (!meta) return false;
            if (meta.spawnConditions) return false;       // not constructs
            if (meta.destroyOnBuild) return false;        // not settlers
            const dmg = meta.damage?.value || 0;
            const mil = meta.score?.military || 0;
            return dmg >= 20 && mil > 0;
        })
        .map(([name]) => name);
}

/** Score an entity's military effectiveness for tie-breaking. */
function getMilitaryRating(meta) {
    if (!meta) return 0;
    const dmg = meta.damage?.value || 0;
    const rangeMult = meta.range?.maxCells || 1;
    const armor = meta.armor ? Object.values(meta.armor).reduce((a, b) => a + b, 0) : 0;
    const health = meta.health || 0;
    const scoreMil = meta.score?.military || 0;
    return (scoreMil * 10) + (dmg * rangeMult) + (armor * 5) + (health * 0.05);
}

// -----------------------------------------------------------------------------
// Resource evaluation (no ESSENTIAL_RESOURCES, no hard-coded resource list)
// -----------------------------------------------------------------------------

/**
 * Returns the dynamic "target stock" the AI tries to maintain for each
 * resource. The target is the maximum of:
 *   - the resource's starting level (from initialization settings), so the
 *     AI naturally tries to maintain starting levels,
 *   - 10x the resource's current per-turn upkeep, so the AI has a buffer to
 *     survive consumption spikes,
 *   - 1.5x the resource's current yields * 10, so producers aren't
 *     drained by their own creation cost.
 * Resources not present in starting settings get a baseline of 50.
 */
function computeResourceTargets(startingResources, profile) {
    const { totalUpkeep, totalYields } = profile;
    const targets = {};
    const allRes = new Set([
        ...Object.keys(startingResources),
        ...Object.keys(totalUpkeep || {}),
        ...Object.keys(totalYields || {})
    ]);
    for (const res of allRes) {
        if (res === 'orders') continue;
        const start = startingResources[res] !== undefined ? startingResources[res] : 50;
        const upkeep = totalUpkeep?.[res] || 0;
        const yieldAmt = totalYields?.[res] || 0;
        const targetByUpkeep = upkeep * 10;
        const targetByYield = yieldAmt * 15;
        targets[res] = Math.max(start, targetByUpkeep, targetByYield, 50);
    }
    return targets;
}

/**
 * Resource evaluation:
 *  - 'deficit' = net income < 0 (yields < upkeep). Only these need a
 *    producer right now.
 *  - 'surplus' = net income > 0 AND stock below target. Build more if we
 *    have idle resources.
 *  - 'ok' = neither. The AI does nothing for this resource.
 * Each iteration logs the per-resource verdict and overall ordering.
 */
export function evaluateResources(player, gameState) {
    const profile = player.getResourceProfile ? player.getResourceProfile(gameState)
        : { totalUpkeep: {}, totalYields: {}, netIncome: {} };
    const { totalUpkeep, totalYields, netIncome } = profile;
    const reserves = player.resources || {};
    const startingResources = (gameState?.initializationSettings?.startingResources) || {};
    const targets = computeResourceTargets(startingResources, profile);

    const resourceKeys = Array.from(new Set([
        ...Object.keys(reserves),
        ...Object.keys(totalUpkeep || {}),
        ...Object.keys(totalYields || {}),
        ...Object.keys(startingResources)
    ])).filter(k => k !== 'orders');

    const deficit = [];   // resources where we MUST build a producer (net < 0)
    const surplus = [];   // resources that are net-positive but stock < target

    const lines = [];
    for (const res of resourceKeys) {
        const net = netIncome?.[res] !== undefined ? netIncome[res] : 0;
        const upkeep = totalUpkeep?.[res] || 0;
        const yieldAmt = totalYields?.[res] || 0;
        const stock = reserves[res] !== undefined ? reserves[res] : 0;
        const target = targets[res];
        const start = startingResources[res] !== undefined ? startingResources[res] : 50;

        let verdict = 'ok';
        let priority = 0;
        if (net < 0) {
            verdict = 'deficit';
            // More negative = more urgent
            priority = -net * 10 + Math.max(0, start - stock);
            deficit.push({ res, priority });
        } else if (net > 0 && stock < target) {
            verdict = 'surplus_but_low';
            // Deeper deficit relative to target = more urgent
            priority = (target - stock) / Math.max(1, target);
            surplus.push({ res, priority });
        }

        lines.push(`  ${res}: stock=${stock}, yield=${yieldAmt}, upkeep=${upkeep}, net=${net}, target=${target}, start=${start} -> ${verdict}${priority ? ` (priority ${priority.toFixed(1)})` : ''}`);
    }

    deficit.sort((a, b) => b.priority - a.priority);
    surplus.sort((a, b) => b.priority - a.priority);

    return { deficit, surplus, detailLines: lines, targets, startingResources };
}

// -----------------------------------------------------------------------------
// Production path resolution
// -----------------------------------------------------------------------------

function getManifestEntities(gameState) {
    return gameState.manifestData?.entities || {};
}

function findBuildersForEntity(manifestEntities, targetName) {
    const builders = [];
    const targetLower = targetName.toLowerCase();
    for (const [bName, bMeta] of Object.entries(manifestEntities)) {
        if (Array.isArray(bMeta?.buildables)) {
            if (bMeta.buildables.some(item => item.toLowerCase() === targetLower)) {
                builders.push(bName);
            }
        }
    }
    return builders;
}

/**
 * Resolves a chain of production. We may need to build a worker before a
 * worker can build a mine, or a settler before a settler can build a village.
 * Returns the first step we can take immediately, or null if the chain
 * requires an entity we cannot yet produce.
 */
function resolveProductionPath(player, gameState, targetName, visited = new Set()) {
    if (visited.has(targetName)) return null;
    visited.add(targetName);

    const manifestEntities = getManifestEntities(gameState);
    const myEntities = player.getEntities(gameState).filter(e => e.active);
    const builderTypeNames = findBuildersForEntity(manifestEntities, targetName);

    // 1. We already own an active builder of the right kind.
    for (const bTypeName of builderTypeNames) {
        const owned = myEntities.find(e => e.name.toLowerCase() === bTypeName.toLowerCase());
        if (owned) return { executor: owned, actionTarget: targetName };
    }

    // 2. We don't; recursively figure out how to build the builder.
    for (const bTypeName of builderTypeNames) {
        const step = resolveProductionPath(player, gameState, bTypeName, visited);
        if (step) return step;
    }
    return null;
}

/** All construct manifests that yield the given resource. */
function findConstructsYieldingResource(manifestEntities, resKey) {
    const results = [];
    for (const [name, meta] of Object.entries(manifestEntities)) {
        if (!meta || !meta.spawnConditions) continue;  // only constructs
        if (meta.yields && (meta.yields[resKey] || 0) > 0) {
            results.push({ name, meta, yieldAmount: meta.yields[resKey] || 0 });
        }
    }
    results.sort((a, b) => b.yieldAmount - a.yieldAmount);
    return results;
}

// -----------------------------------------------------------------------------
// Pathfinding (BFS over walkable terrain)
// -----------------------------------------------------------------------------

/**
 * BFS from a unit across terrain the unit can stand on. Returns a map of
 * "q,r" -> { cell, path } where path is the ordered list of cells from the
 * start (excluding the start cell) to that cell.
 */
function bfsWalkable(unit, gameState, maxNodes = 6000) {
    const grid = gameState.hexGrid;
    const startQ = unit.q, startR = unit.r;

    const occupied = new Set();
    for (const e of gameState.entities) {
        if (e.q !== undefined && e.r !== undefined) occupied.add(`${e.q},${e.r}`);
    }

    const visited = new Map();
    visited.set(`${startQ},${startR}`, { cell: grid.getCell(startQ, startR), path: [] });
    const queue = [{ q: startQ, r: startR, path: [] }];
    let nodes = 0;

    while (queue.length > 0 && nodes < maxNodes) {
        const cur = queue.shift();
        nodes++;
        const nbrs = grid.getNeighbors(cur.q, cur.r);
        for (const nb of nbrs) {
            const key = `${nb.q},${nb.r}`;
            if (visited.has(key)) continue;
            if (!unit.canStandOn(nb)) continue; // water/impassable: skip
            const path = [...cur.path, nb];
            visited.set(key, { cell: nb, path });
            // We can pass through occupied cells, but don't expand from them
            // (avoids squashing into a stack of units).
            if (occupied.has(key)) continue;
            queue.push({ q: nb.q, r: nb.r, path });
        }
    }
    return visited;
}

/**
 * Move a unit along a BFS path as far as action points allow. Each move is a
 * separate order; we move as far as the unit can in a single action.
 */
function moveAlongPath(player, unit, moveAction, path, gameState, category, reason) {
    if (!path || path.length === 0) return 0;

    // Try the full route first.
    const lastCell = path[path.length - 1];
    if (!gameState.getEntityAt(lastCell.q, lastCell.r)) {
        const fullCheck = moveAction.canDo(lastCell, null);
        if (fullCheck && fullCheck.possible && moveAction.do(lastCell, null)) {
            aiLog(player, category, `Move ${unit.name}: advanced to (${lastCell.q},${lastCell.r}) [arrived]. Reason: ${reason}`);            
            return 1;
        }
    }

    // Otherwise step back to the farthest affordable cell within AP budget.
    const apBudget = unit.actionPoints !== undefined ? unit.actionPoints : Infinity;
    let acc = 0;
    let furthest = -1;
    for (let i = 0; i < path.length; i++) {
        acc += path[i].terrain?.movementCost || 1;
        if (acc > apBudget) break;
        furthest = i;
    }
    for (let i = furthest; i >= 0; i--) {
        const stepCell = path[i];
        if (gameState.getEntityAt(stepCell.q, stepCell.r)) continue;
        const check = moveAction.canDo(stepCell, null);
        if (check && check.possible) {
            const moved = moveAction.do(stepCell, null);
            if (moved) {
                const note = i < path.length - 1
                    ? ` [partial: ${i + 1}/${path.length} cells, more next turn]`
                    : ` [arrived]`;
                aiLog(player, category, `Move ${unit.name}: advanced to (${stepCell.q},${stepCell.r})${note}. Reason: ${reason}`);                
                return 1;
            }
        }
    }
    return 0;
}

// -----------------------------------------------------------------------------
// High-priority goals (executed round-robin each order)
// -----------------------------------------------------------------------------

/** HIGH MIL: any military unit in our attackHistory on any of our entities
 *  must be hunted down and killed. */
function goalHighMilitaryRevenge(player, myEntities, gameState) {
    const manifestEntities = getManifestEntities(gameState);
    const militaryTypes = getMilitaryTypes(manifestEntities);

    // Find any attacker IDs from our entities' attack history.
    const revengeTargets = new Map(); // id -> { attacker, score }
    for (const e of myEntities) {
        if (!e.attackHistory) continue;
        for (const entry of e.attackHistory) {
            if (!entry || !entry.attackerId) continue;
            const prior = revengeTargets.get(entry.attackerId) || { score: 0, lastEntry: entry };
            prior.score += (entry.damage || 0);
            prior.lastEntry = entry;
            prior.attacker = entry;
            revengeTargets.set(entry.attackerId, prior);
        }
    }
    if (revengeTargets.size === 0) return false;

    // Resolve the live enemy entity for each attacker ID.
    const targetList = [];
    for (const [, info] of revengeTargets) {
        const live = gameState.entities.find(en => en.id === info.lastEntry.attackerId);
        if (live && !live.destroyed) targetList.push({ entity: live, score: info.score });
    }
    if (targetList.length === 0) return false;
    targetList.sort((a, b) => b.score - a.score);

    aiLog(player, 'combat', `REVENGE list (${targetList.length}): ${targetList.map(t => `${t.entity.name}#${t.entity.id.slice(-4)} (total ${t.score.toFixed(0)} dmg on us)`).join('; ')}`);

    const combatUnits = myEntities.filter(e => militaryTypes.includes(e.name) && e.active);
    if (combatUnits.length === 0) {
        aiLog(player, 'warn', `REVENGE: no military unit available to retaliate.`);
        return false;
    }

    for (const { entity: target, score } of targetList) {
        for (const unit of combatUnits) {
            if (unit.actionPoints !== undefined && unit.actionPoints <= 0) continue;
            const ordersUsed = attack(gameState, unit, target, player.orders);
            if (ordersUsed > 0) {
                aiLog(player, 'combat', `REVENGE: ${unit.name} attacks ${target.name} (they dealt ${score.toFixed(0)} dmg to us). Orders used: ${ordersUsed}`);                
                return true;
            }
            // If we couldn't reach, try to move closer.
            const advanced = advanceUnitTowards(player, unit, target, gameState, 'combat', `closing on revenge target ${target.name}`);
            if (advanced) {
                aiLog(player, 'combat', `REVENGE: ${unit.name} couldn't reach ${target.name} to attack; moved closer instead.`);
                return true;
            }
        }
    }
    return false;
}

/** HIGH ECON: stabilize any resource whose net income is negative by building
 *  the cheapest construct that yields it. */
function goalHighEconomyStabilize(player, myEntities, gameState) {
    const manifestEntities = getManifestEntities(gameState);
    const evalRes = evaluateResources(player, gameState);
    if (evalRes.deficit.length === 0) return false;

    // Try each deficit in priority order until we successfully build something.
    for (const def of evalRes.deficit) {
        const candidates = findConstructsYieldingResource(manifestEntities, def.res);
        aiLog(player, 'econ', `Stabilize: ${def.res} net < 0. Candidates: [${candidates.map(c => `${c.name}(+${c.yieldAmount})`).join(', ') || 'none'}]`);

        for (const cand of candidates) {
            const step = resolveProductionPath(player, gameState, cand.name);
            if (!step) {
                aiLog(player, 'detail', `No production path for ${cand.name} (no builder).`);
                continue;
            }
            const ordersUsed = build(gameState, step.executor, step.actionTarget);
            if (ordersUsed > 0) {
                aiLog(player, 'build', `STABILIZE: Build ${camelToTitle(step.actionTarget)} via ${step.executor.name} (resolves ${def.res} deficit). Orders used: ${ordersUsed}`);                
                return true;
            } else {
                aiLog(player, 'detail', `Build ${cand.name} via ${step.executor.name} failed (resources/terrain/orders). Trying next candidate.`);
            }
        }
    }
    return false;
}

// -----------------------------------------------------------------------------
// Medium-priority goals (round-robin after HIGH goals)
// -----------------------------------------------------------------------------

/** MED MIL: attack only when our forces outnumber the visible enemy military. */
function goalMediumMilitaryAttack(player, myEntities, enemyEntities, gameState) {
    const manifestEntities = getManifestEntities(gameState);
    const militaryTypes = getMilitaryTypes(manifestEntities);
    const myMilitary = myEntities.filter(e => militaryTypes.includes(e.name) && e.active);

    // Compute visible enemy military strength.
    const enemyMilitary = enemyEntities.filter(e => militaryTypes.includes(e.name));
    if (enemyMilitary.length === 0) return false;
    if (myMilitary.length === 0) return false;

    const myStrength = myMilitary.reduce((s, e) => s + (manifestEntities[e.name]?.score?.military || 0), 0);
    const theirStrength = enemyMilitary.reduce((s, e) => s + (manifestEntities[e.name]?.score?.military || 0), 0);
    if (myStrength <= theirStrength) {
        aiLog(player, 'detail', `MED MIL: not attacking — our military strength ${myStrength} <= enemy ${theirStrength}.`);
        return false;
    }

    // Pick the weakest visible enemy target and attack with the closest unit.
    const weakest = [...enemyMilitary].sort((a, b) =>
        (manifestEntities[a.name]?.score?.military || 0) - (manifestEntities[b.name]?.score?.military || 0))[0];

    for (const unit of myMilitary) {
        if (unit.actionPoints !== undefined && unit.actionPoints <= 0) continue;
        const ordersUsed = attack(gameState, unit, weakest, player.orders);
        if (ordersUsed > 0) {
            aiLog(player, 'combat', `MED MIL: ${unit.name} attacks ${weakest.name} (superiority: ${myStrength} vs ${theirStrength}). Orders used: ${ordersUsed}`);            
            return true;
        }
        // Couldn't reach: move closer so we can attack next turn.
        const advanced = advanceUnitTowards(player, unit, weakest, gameState, 'combat', `advancing on ${weakest.name}`);
        if (advanced) {
            aiLog(player, 'combat', `MED MIL: ${unit.name} out of range of ${weakest.name}; advanced closer.`);
            return true;
        }
    }
    return false;
}

/** MED ECON: when resources are above target stock, train more producers
 *  (mobile units) to convert surplus into military score. */
function goalMediumEconomySurplus(player, myEntities, gameState) {
    const manifestEntities = getManifestEntities(gameState);
    const evalRes = evaluateResources(player, gameState);
    if (evalRes.surplus.length === 0) return false;

    // We have surplus: train a military unit (best score first) to convert it
    // into score and defense.
    const militaryRanked = getMilitaryTypes(manifestEntities)
        .map(name => ({ name, meta: manifestEntities[name] }))
        .sort((a, b) => getMilitaryRating(b.meta) - getMilitaryRating(a.meta));

    for (const mil of militaryRanked) {
        // Check we can actually afford it.
        const cost = mil.meta.spawnCost || {};
        if (player.hasResources && !player.hasResources(cost)) continue;
        const step = resolveProductionPath(player, gameState, mil.name);
        if (step) {
            const ordersUsed = build(gameState, step.executor, step.actionTarget);
            if (ordersUsed > 0) {
                aiLog(player, 'build', `MED ECON: surplus detected (top: ${evalRes.surplus[0].res}); training ${camelToTitle(step.actionTarget)} via ${step.executor.name}. Orders used: ${ordersUsed}`);                
                return true;
            }
        }
    }
    return false;
}

/** MED EXPANSION: build constructs that increase mobile production OR
 *  increase orders. This is the path to economic growth. */
function goalMediumExpansionInfrastructure(player, myEntities, gameState) {
    const manifestEntities = getManifestEntities(gameState);
    const settlementCenterNames = getSettlementCenterTypes(manifestEntities);
    const mobileProducerTypes = getMobileProducerTypes(manifestEntities);

    // 1. If we have a settler and no current settlement center of a given
    //    type, found one.
    const settlerTypes = getSettlerTypes(manifestEntities);
    const settlers = myEntities.filter(e => settlerTypes.includes(e.name) && e.active);
    const ownedSettlementCenters = myEntities.filter(e => settlementCenterNames.includes(e.name) && e.active);

    for (const settler of settlers) {
        for (const centerName of settlementCenterNames) {
            const ordersUsed = build(gameState, settler, centerName);
            if (ordersUsed > 0) {
                aiLog(player, 'build', `MED EXPANSION: settler founds ${camelToTitle(centerName)}. Orders used: ${ordersUsed}`);                
                return true;
            }
        }
    }

    // 2. Build additional mobile producers (villages, forges, etc.).
    for (const prodName of mobileProducerTypes) {
        // Skip if we already own one of this type (don't spam duplicates).
        if (ownedSettlementCenters.some(e => e.name === prodName)) continue;
        const step = resolveProductionPath(player, gameState, prodName);
        if (step) {
            const ordersUsed = build(gameState, step.executor, step.actionTarget);
            if (ordersUsed > 0) {
                aiLog(player, 'build', `MED EXPANSION: build ${camelToTitle(step.actionTarget)} via ${step.executor.name} (expands production). Orders used: ${ordersUsed}`);                
                return true;
            }
        }
    }

    // 3. Train a settler if we have none and few settlement centers.
    if (settlers.length === 0 && ownedSettlementCenters.length < 3) {
        for (const settlerName of settlerTypes) {
            const step = resolveProductionPath(player, gameState, settlerName);
            if (step) {
                const ordersUsed = build(gameState, step.executor, step.actionTarget);
                if (ordersUsed > 0) {
                    aiLog(player, 'build', `MED EXPANSION: train ${camelToTitle(step.actionTarget)} via ${step.executor.name} to enable new settlements. Orders used: ${ordersUsed}`);                    
                    return true;
                }
            }
        }
    }

    return false;
}

/** MED EXPANSION: explore. Every idle mobile unit tries to reveal fog. */
function goalMediumExploration(player, myEntities, gameState) {
    return exploreFog(player, myEntities, gameState);
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Move a unit closer to a target cell/entity using BFS pathfinding. If a path
 * exists, takes a single step (or as many as the AP budget allows). Returns
 * true if at least one move action was executed.
 */
function advanceUnitTowards(player, unit, target, gameState, category, reason) {
    if (unit.actionPoints !== undefined && unit.actionPoints <= 0) return false;
    const moveAction = unit.getActions().find(a => a.name === "Move");
    if (!moveAction) return false;

    const reachable = bfsWalkable(unit, gameState);
    let best = null;
    let bestDist = Infinity;
    for (const { cell, path } of reachable.values()) {
        if (path.length === 0) continue;
        const d = HexGrid.distance(cell, target);
        if (d < bestDist || (d === bestDist && best && path.length < best.path.length)) {
            bestDist = d;
            best = { cell, path };
        }
    }
    if (!best) {
        aiLog(player, 'warn', `Advance: ${unit.name} has no walkable route to ${target.name}@(${target.q},${target.r}).`);
        return false;
    }
    return moveAlongPath(player, unit, moveAction, best.path, gameState, category, reason) > 0;
}

/**
 * Find the nearest reachable unexplored cell and move there. This is now
 * path-driven and never bails out with "too far" unless the explorer is
 * actually surrounded by occupied/unreachable cells.
 */
function exploreFog(player, myEntities, gameState) {
    const manifestEntities = getManifestEntities(gameState);
    const settlerTypes = getSettlerTypes(manifestEntities);
    const workerTypes = getWorkerTypes(manifestEntities);

    const explorers = myEntities.filter(e => {
        if (e.isConstruct || !e.active) return false;
        if (!e.getActions().some(a => a.name === "Move")) return false;
        if (e.actionPoints !== undefined && e.actionPoints <= 0) return false;
        return true;
    });

    // Priority: military > workers > settlers. Settlers almost never explore
    // voluntarily because they're valuable.
    explorers.sort((a, b) => explorerPriority(b, settlerTypes, workerTypes) - explorerPriority(a, settlerTypes, workerTypes));
    if (explorers.length === 0) {
        aiLog(player, 'explore', `No mobile units available to explore.`);
        return false;
    }

    for (const unit of explorers) {
        const moveAction = unit.getActions().find(a => a.name === "Move");
        if (!moveAction) continue;
        const reachable = bfsWalkable(unit, gameState);

        // Pick the closest reachable unexplored cell.
        let target = null;
        for (const { cell, path } of reachable.values()) {
            if (path.length === 0) continue;
            if (!player.isExplored(cell.q, cell.r)) {
                target = { cell, path };
                break;
            }
        }
        if (!target) {
            aiLog(player, 'detail', `Explore: ${unit.name}@(${unit.q},${unit.r}) searched ${reachable.size} walkable cells, none unexplored.`);
            continue;
        }
        aiLog(player, 'explore', `Explore: target for ${unit.name} is (${target.cell.q},${target.cell.r}), ${target.path.length} cells away.`);
        const ordersUsed = moveAlongPath(player, unit, moveAction, target.path, gameState, 'explore', 'Reveal fog of war');
        if (ordersUsed > 0) return true;
    }
    return false;
}

function explorerPriority(unit, settlerTypes, workerTypes) {
    const name = (unit.name || '').toLowerCase();
    if (settlerTypes.includes(unit.name)) return -100; // settlers last
    if (workerTypes.includes(unit.name)) return -10;   // workers before settlers
    return (unit.sightRange || 1) * 10;                 // military/scouts first
}

// -----------------------------------------------------------------------------
// Main turn loop
// -----------------------------------------------------------------------------

/**
 * Goal ordering each order:
 *   HIGH (urgent, in round-robin order):
 *     1. revenge attackers
 *     2. stabilize negative net-income resources
 *   MEDIUM (opportunistic, in round-robin order):
 *     3. attack only when outnumbering enemy military
 *     4. build military from surplus resources
 *     5. expand infrastructure (producers, settlements, settlers)
 *     6. explore
 *
 * We rotate which HIGH and which MEDIUM goal we attempt first based on the
 * remaining order count so the AI doesn't hammer on the same track every turn.
 */
export async function processTurn(player, gameState) {
    if (!player || player.orders <= 0) return;

    const manifest = gameState.manifestData;
    if (!manifest || !manifest.entities) return;

    aiLog(player, 'turn', `=== Turn Start (Round ${gameState.currentRound}) | Orders: ${player.orders}/${player.maxOrders} | Resources: ${fmtRes(player.resources)} ===`);

    const myEntities = player.getEntities ? player.getEntities(gameState) : [];
    if (myEntities.length === 0) {
        aiLog(player, 'warn', `No entities to act with; ending turn.`);
        return;
    }

    // Per-turn resource summary for visibility.
    const evalRes = evaluateResources(player, gameState);
    aiLog(player, 'econ', `Resource targets (start-level-maintained): ${Object.entries(evalRes.targets).map(([k, v]) => `${k}>=${v}`).join(', ')}`);
    evalRes.detailLines.forEach(l => aiLog(player, 'detail', l));

    let maxLoops = Math.min(player.orders, 60); // up to one action per order
    let lastGoalBand = null;
    let lastGoalIndex = -1;

    while (player.orders > 0 && maxLoops > 0) {
        maxLoops--;
        const actionStartOrders = player.orders;

        // Refresh enemy/own lists every order.
        const visibleOpponents = player.getOpponents ? player.getOpponents(gameState) : {};
        const enemyEntities = [];
        for (const opp of Object.values(visibleOpponents || {})) {
            if (opp.entities) enemyEntities.push(...opp.entities);
        }
        const allMyEntities = player.getEntities(gameState).filter(e => e.active);

        // Build the goal sequence: HIGH first, then MEDIUM.
        const highGoals = [
            { name: 'HIGH_REVENGE',      fn: () => goalHighMilitaryRevenge(player, allMyEntities, gameState) },
            { name: 'HIGH_STABILIZE',    fn: () => goalHighEconomyStabilize(player, allMyEntities, gameState) }
        ];
        const medGoals = [
            { name: 'MED_ATTACK',        fn: () => goalMediumMilitaryAttack(player, allMyEntities, enemyEntities, gameState) },
            { name: 'MED_SURPLUS',       fn: () => goalMediumEconomySurplus(player, allMyEntities, gameState) },
            { name: 'MED_EXPANSION',     fn: () => goalMediumExpansionInfrastructure(player, allMyEntities, gameState) },
            { name: 'MED_EXPLORE',       fn: () => goalMediumExploration(player, allMyEntities, gameState) }
        ];

        // Try every goal in turn; the first one that both succeeds AND consumes an
        // order is the one we use. We rotate the starting goal each iteration so
        // the AI doesn't get fixated on a single track.
        const goals = [
            ...highGoals,
            ...medGoals
        ];
        const startIdx = (lastGoalIndex + 1) % goals.length;

        let executed = false;
        let chosenGoal = null;
        for (let i = 0; i < goals.length; i++) {
            const goalIdx = (startIdx + i) % goals.length;
            const goal = goals[goalIdx];
            const ordersBefore = player.orders;
            let ok = false;
            try {
                ok = await goal.fn();
            } catch (e) {
                aiLog(player, 'warn', `Goal ${goal.name} threw: ${e.message}`);
                ok = false;
            }
            const ordersAfter = player.orders;
            if (ok && ordersAfter < ordersBefore) {
                executed = true;
                chosenGoal = { name: goal.name, band: goalIdx < highGoals.length ? 'HIGH' : 'MED' };
                lastGoalBand = chosenGoal.band;
                lastGoalIndex = goalIdx;
                break;
            } else if (ok && ordersAfter >= ordersBefore) {
                aiLog(player, 'warn', `Goal ${goal.name} returned true but consumed no order; skipping.`);
            }
        }

        if (!executed) {
            aiLog(player, 'warn', `No goal could consume an order with the remaining state. Ending turn early. Orders left: ${player.orders}`);
            break;
        }

        aiLog(player, 'turn', `Order used (${chosenGoal.name}). Orders left: ${player.orders} (was ${actionStartOrders})`);
        onActionDone(gameState);
        await sleep(ACTION_SLEEP);
    }

    aiLog(player, 'turn', `=== Turn Completed. Remaining orders: ${player.orders} | Resources: ${fmtRes(player.resources)} ===`);
    await sleep(TURN_SLEEP);
}
