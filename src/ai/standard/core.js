import { attack, build, repair } from '../utils.js';
import { HexGrid } from '../../hexGrid.js';
import { camelToTitle } from '../../utils.js';

/**
 * Conventional Goal-Driven Heuristic AI Controller
 * Interface: async function processTurn(player, gameState)
 */

// -----------------------------------------------------------------------------
// Tuning constants
// -----------------------------------------------------------------------------

const ESSENTIAL_RESOURCES = new Set(['food', 'wood', 'gold', 'iron']);
const LUXURY_WEIGHT = 0.25;          // De-prioritize luxury resources (e.g. gems)
const EARLY_GAME_ROUNDS = 15;        // Rounds considered "early game"
const EARLY_GAME_MIN_CONSTRUCTS = 2; // Or fewer constructs than this => early game
const EARLY_ESSENTIAL_BOOST = 1.5;   // Essential resources weighted higher early
const REPAIR_HEALTH_THRESHOLD = 0.6; // Only repair below 60% health
const MILITARY_SCORE_THRESHOLD = 5;  // Min manifest military score to be a combat unit
const BFS_NODE_CAP = 4000;           // Safety cap for pathfinding searches

const TURN_SLEEP = 2000;
const ACTION_SLEEP = 1000;

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

// Wraps a synchronous operation and logs a warning if it blocks the main thread too long.
function timeIt(player, label, fn) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const result = fn();
    const dt = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    if (dt > 300) {
        aiLog(player, 'warn', `PERF: ${label} blocked main thread for ${dt.toFixed(0)}ms`);
    }
    return result;
}

function aiLog(player, category, message) {
    const line = `[AI ${player.name}][${category}] ${message}`;
    console.log(`%c${line}`, LOG_STYLES[category] || '');

    // Mirror logs into the DOM so external tooling (and headless testing) can
    // inspect AI decision history even when console capture is unavailable.
    if (typeof document !== 'undefined') {
        const buf = window.__AI_LOGS || (window.__AI_LOGS = []);
        buf.push(line);
        if (buf.length > 3000) buf.shift();
        let mirror = document.getElementById('__ai-log-mirror');
        if (!mirror) {
            mirror = document.createElement('div');
            mirror.id = '__ai-log-mirror';
            mirror.style.display = 'none';
            document.documentElement.appendChild(mirror);
        }
        mirror.dataset.count = String(buf.length);
        mirror.dataset.tail = buf.slice(-120).join('\n');
    }
}

function fmtRes(obj) {
    return Object.entries(obj || {}).map(([k, v]) => `${k}:${v}`).join(', ') || '(empty)';
}

export async function processTurn(player, gameState) {
    if (!player || player.orders <= 0) return;

    const manifest = gameState.manifestData;
    if (!manifest || !manifest.entities) return;

    aiLog(player, 'turn', `=== Turn Start (Round ${gameState.currentRound}) | Orders: ${player.orders}/${player.maxOrders} | Resources: ${fmtRes(player.resources)} ===`);

    await sleep(TURN_SLEEP); // Give the engine a moment to update the UI before AI actions start

    let maxLoops = 25;
    let actionExecuted = true;

    while (player.orders > 0 && maxLoops > 0 && actionExecuted) {
        maxLoops--;
        actionExecuted = false;

        // 0. Identify visible enemy entities (re-evaluated each action so fresh vision is used)
        const visibleOpponents = player.getOpponents ? player.getOpponents(gameState) : {};
        const enemyEntities = [];
        Object.values(visibleOpponents).forEach(opp => {
            if (opp.entities) enemyEntities.push(...opp.entities);
        });
        const hasEnemies = enemyEntities.length > 0;
        if (hasEnemies) {
            aiLog(player, 'combat', `Visible enemies: ${enemyEntities.map(e => `${e.name}@(${e.q},${e.r})`).join(', ')}`);
        }

        // 1. Re-evaluate economic pressure and resource demand before each action
        const economicPressure = evaluateEconomicPressure(player, gameState);

        // 2. Dynamic Goal Selection
        let goal = "";
        if (!hasEnemies && economicPressure.level !== 'NONE') {
            goal = "BUILD_RESOURCES_AND_WORKERS"; // No enemies + economic pressure
        } else if (!hasEnemies && economicPressure.level === 'NONE') {
            goal = "EXPAND_AND_EXPLORE"; // No enemies + no economic pressure
        } else if (hasEnemies && economicPressure.level === 'NONE') {
            goal = "ALL_OUT_ATTACK"; // Enemies visible + no economic pressure
        } else {
            goal = "DEFEND_TOWNS_THEN_RESOURCES"; // Enemies visible + economic pressure
        }

        aiLog(player, 'turn', `Action Step | Goal: ${goal} | Economic Pressure: ${economicPressure.level} | Orders: ${player.orders} (loops left: ${maxLoops})`);
        if (economicPressure.reasons.length > 0) {
            aiLog(player, 'econ', `Demand Analysis (Ranked): ${economicPressure.deficits.join(' > ') || 'None'}`);
            economicPressure.reasons.forEach(r => aiLog(player, 'detail', `  - ${r}`));
        }

        const myEntities = player.getEntities ? player.getEntities(gameState) : [];
        if (myEntities.length === 0) break;

        // Execute turn actions based on active goal
        switch (goal) {
            case "BUILD_RESOURCES_AND_WORKERS":
                actionExecuted = await timeIt(player, `goal ${goal}`, () => executeBuildResourcesGoal(player, myEntities, economicPressure, gameState));
                break;
            case "EXPAND_AND_EXPLORE":
                actionExecuted = await timeIt(player, `goal ${goal}`, () => executeExpandAndExploreGoal(player, myEntities, gameState));
                break;
            case "ALL_OUT_ATTACK":
                actionExecuted = await timeIt(player, `goal ${goal}`, () => executeAllOutAttackGoal(player, myEntities, enemyEntities, gameState));
                break;
            case "DEFEND_TOWNS_THEN_RESOURCES":
                actionExecuted = await timeIt(player, `goal ${goal}`, () => executeDefendTownsThenResourcesGoal(player, myEntities, enemyEntities, economicPressure, gameState));
                break;
            default:
                break;
        }

        if (actionExecuted) {
            await sleep(ACTION_SLEEP); // Give the engine a moment to update the UI after each action
        }
    }

    if (maxLoops <= 0) {
        aiLog(player, 'warn', `Hit action-loop safety cap (25 actions in one turn).`);
    }
    aiLog(player, 'turn', `=== Turn Completed. Remaining orders: ${player.orders} | Resources: ${fmtRes(player.resources)} ===`);
    await sleep(TURN_SLEEP);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Evaluates economic pressure dynamically and ranks resource deficits by highest demand score.
 * Excludes 'orders' from stock and yield evaluations.
 *
 * Fixes vs. previous version:
 *  - Reads real starting-resource reference values from gameState.initializationSettings
 *    (previously always fell back to 100, which made scarce luxuries like gems register a
 *    permanent HIGH deficit and dominate build priorities).
 *  - Applies strategic weighting: essential resources (food/wood/gold/iron) are boosted in
 *    the early game; luxury resources are de-prioritized so the AI builds core economy first.
 */
export function evaluateEconomicPressure(player, gameState) {
    const profile = player.getResourceProfile ? player.getResourceProfile(gameState) : { totalUpkeep: {}, totalYields: {}, netIncome: {} };
    const { totalUpkeep, totalYields, netIncome } = profile;
    const reserves = player.resources || {};
    const startingResources = gameState?.initializationSettings?.startingResources || {};
    const currentRound = gameState?.currentRound || 1;

    const resourceKeys = Array.from(new Set([
        ...Object.keys(reserves),
        ...Object.keys(totalUpkeep),
        ...Object.keys(totalYields),
        ...Object.keys(startingResources)
    ])).filter(k => k !== 'orders');

    // Early-game detection: few rounds played or barely any infrastructure built
    const ownedConstructs = player.getEntities ? player.getEntities(gameState).filter(e => e.isConstruct && e.active).length : 0;
    const isEarlyGame = currentRound <= EARLY_GAME_ROUNDS || ownedConstructs < EARLY_GAME_MIN_CONSTRUCTS;

    let isHigh = false;
    let isLow = false;
    const reasons = [];
    const deficitsWithScores = [];
    const evalLines = [];

    for (const res of resourceKeys) {
        const upkeep = totalUpkeep[res] || 0;
        const net = netIncome[res] !== undefined ? netIncome[res] : 0;
        const stock = reserves[res] !== undefined ? reserves[res] : 0;
        const initialRes = startingResources[res] !== undefined ? startingResources[res] : 100;
        const lowStockThreshold = 0.5 * initialRes;
        const medStockThreshold = 1.0 * initialRes;

        let resScore = 0;
        let hasDeficit = false;
        let verdict = 'ok';

        if (upkeep > 0) {
            if (net < 1.5 * upkeep || stock < 4 * upkeep) {
                isHigh = true;
                hasDeficit = true;
                verdict = 'HIGH deficit';
                resScore = (1.5 * upkeep - net) * 2 + Math.max(0, 4 * upkeep - stock);
                reasons.push(`${res} in deficit (net ${net} < 1.5x upkeep ${upkeep} or stock ${stock} < 4x upkeep)`);
            } else if (net < 3.0 * upkeep || stock < 6 * upkeep) {
                isLow = true;
                hasDeficit = true;
                verdict = 'LOW margin';
                resScore = (3.0 * upkeep - net) + Math.max(0, 6 * upkeep - stock) * 0.5;
                reasons.push(`${res} low margin (net ${net} < 3x upkeep ${upkeep} or stock ${stock} < 6x upkeep)`);
            }
        } else {
            if (net < 0 || stock < lowStockThreshold) {
                isHigh = true;
                hasDeficit = true;
                verdict = 'HIGH reserves low';
                resScore = Math.max(0, lowStockThreshold - stock) * 2 + (net < 0 ? Math.abs(net) * 3 : 0);
                reasons.push(`${res} reserves low (${stock} < 0.5x starting ${initialRes})`);
            } else if (stock < medStockThreshold) {
                isLow = true;
                hasDeficit = true;
                verdict = 'LOW reserves moderate';
                resScore = Math.max(0, medStockThreshold - stock);
                reasons.push(`${res} reserves moderate (${stock} < starting ${initialRes})`);
            }
        }

        // Strategic weighting applied BEFORE ranking so scores reflect true priority.
        let weight = 1.0;
        if (!ESSENTIAL_RESOURCES.has(res)) {
            weight = LUXURY_WEIGHT;
        } else if (isEarlyGame) {
            weight = EARLY_ESSENTIAL_BOOST;
        }
        const weightedScore = resScore * weight;

        evalLines.push(`${res}: stock=${stock}, upkeep=${upkeep}, net=${net}, ref=${initialRes} -> ${hasDeficit ? `${verdict}, score=${weightedScore.toFixed(1)} (raw ${resScore.toFixed(1)} x${weight})` : verdict}`);
        if (hasDeficit) {
            deficitsWithScores.push({ res, score: weightedScore });
        }
    }

    // Detailed per-resource evaluation log
    aiLog(player, 'econ', `Resource evaluation (round ${currentRound}${isEarlyGame ? ', EARLY GAME: essentials x' + EARLY_ESSENTIAL_BOOST + ', luxuries x' + LUXURY_WEIGHT : ''}):`);
    evalLines.forEach(l => aiLog(player, 'detail', `  ${l}`));

    // Sort deficits by highest demand score first
    deficitsWithScores.sort((a, b) => b.score - a.score);
    const deficits = deficitsWithScores.map(d => d.res);

    const level = isHigh ? 'HIGH' : (isLow ? 'LOW' : 'NONE');
    return { level, reasons, deficits, profile };
}

// -----------------------------------------------------------------------------
// Dynamic Entity Analysis & Dependency Helpers
// -----------------------------------------------------------------------------

function getManifestEntities(gameState) {
    return gameState.manifestData?.entities || {};
}

/**
 * Finds all entity definitions that yield the given resource key.
 * Prioritizes entities that can build other entities (e.g. settlements/villages),
 * followed by highest resource yield amount.
 */
function findEntitiesYieldingResource(manifestEntities, resKey) {
    const results = [];
    for (const [name, meta] of Object.entries(manifestEntities)) {
        if (meta.yields && (meta.yields[resKey] || 0) > 0) {
            const isProducerOfEntities = Array.isArray(meta.buildables) && meta.buildables.length > 0;
            results.push({
                name,
                meta,
                yieldAmount: meta.yields[resKey],
                isProducerOfEntities
            });
        }
    }

    // Prioritize entities that can produce other entities, then by yield amount
    results.sort((a, b) => {
        if (a.isProducerOfEntities !== b.isProducerOfEntities) {
            return a.isProducerOfEntities ? -1 : 1;
        }
        return b.yieldAmount - a.yieldAmount;
    });

    return results;
}

/**
 * Finds entity types in manifest that have `targetName` in their `buildables` list.
 */
function findBuildersForEntity(manifestEntities, targetName) {
    const builders = [];
    const targetLower = targetName.toLowerCase();
    for (const [bName, bMeta] of Object.entries(manifestEntities)) {
        if (Array.isArray(bMeta.buildables)) {
            if (bMeta.buildables.some(item => item.toLowerCase() === targetLower)) {
                builders.push(bName);
            }
        }
    }
    return builders;
}

/**
 * Recursively resolves a production dependency chain to find an owned entity that
 * can build the next required unit/structure in order to eventually produce `targetName`.
 *
 * @param {Player} player
 * @param {GameState} gameState
 * @param {string} targetName
 * @param {Set<string>} [visited]
 * @returns {{ executor: BaseEntity, actionTarget: string } | null}
 */
function resolveProductionPath(player, gameState, targetName, visited = new Set()) {
    if (visited.has(targetName)) return null;
    visited.add(targetName);

    const manifestEntities = getManifestEntities(gameState);
    const myEntities = player.getEntities(gameState).filter(e => e.active);
    const builderTypeNames = findBuildersForEntity(manifestEntities, targetName);

    // 1. Check if we currently own an active builder of this type
    for (const bTypeName of builderTypeNames) {
        const ownedBuilder = myEntities.find(e => e.name.toLowerCase() === bTypeName.toLowerCase());
        if (ownedBuilder) {
            return { executor: ownedBuilder, actionTarget: targetName };
        }
    }

    // 2. If no direct builder owned, recursively check how to build each builder type
    for (const bTypeName of builderTypeNames) {
        const step = resolveProductionPath(player, gameState, bTypeName, visited);
        if (step) {
            return step;
        }
    }

    return null;
}

/**
 * Calculates a combat rating for an entity based on damage, health, range, and armor.
 */
function getMilitaryRating(meta) {
    if (!meta) return 0;
    const baseDamage = meta.damage?.value || 0;
    const rangeMult = meta.range ? (meta.range.maxCells || 1) : 1;
    const armorTotal = meta.armor ? (Object.values(meta.armor).reduce((a, b) => a + b, 0)) : 0;
    const health = meta.health || 0;
    const scoreMil = meta.score?.military || 0;
    return (scoreMil * 15) + (baseDamage * rangeMult * 3) + (armorTotal * 10) + (health * 0.1);
}

/**
 * Returns entities ranked by military effectiveness.
 */
function getRankedMilitaryTypes(manifestEntities) {
    const units = [];
    for (const [name, meta] of Object.entries(manifestEntities)) {
        // Military units are mobile entities with significant damage/military score
        const hasDamage = (meta.damage?.value || 0) > 15 || (meta.score?.military || 0) >= 5;
        const isMobile = !meta.spawnConditions && (meta.actionPoints || 0) > 0;
        if (hasDamage && isMobile) {
            units.push({ name, meta, rating: getMilitaryRating(meta) });
        }
    }
    units.sort((a, b) => b.rating - a.rating);
    return units;
}

/**
 * Returns entity types capable of founding settlements.
 * FIX: only entities with destroyOnBuild qualify (previously workers were misclassified
 * as settlers because they can build constructs that happen to have minSeparation >= 3).
 */
function getSettlerTypes(manifestEntities) {
    return Object.entries(manifestEntities)
        .filter(([_, meta]) => meta.destroyOnBuild)
        .map(([name]) => name);
}

/**
 * Returns entity types that represent settlement centers (villages/cities with high economic score and minSeparation).
 */
function getSettlementCenterTypes(manifestEntities) {
    return Object.entries(manifestEntities)
        .filter(([_, meta]) => (meta.spawnConditions?.minSeparation >= 3) && (meta.yields?.orders || meta.score?.economic >= 10))
        .map(([name]) => name);
}

/**
 * Returns entity types that are mobile construct builders / repairers (workers).
 */
function getWorkerTypes(manifestEntities) {
    return Object.entries(manifestEntities)
        .filter(([_, meta]) => !meta.spawnConditions && (meta.actionPoints || 0) > 0 && Array.isArray(meta.buildables) && meta.buildables.length > 0 && !meta.destroyOnBuild)
        .map(([name]) => name);
}

/**
 * FIX: Selects only genuine military units for combat duty.
 * Previously any mobile entity with an Attack action qualified — including workers and
 * settlers (they have token damage values), causing civilians to be sent into battle.
 * Civilian units are explicitly excluded and reported via logs.
 */
function selectCombatUnits(player, myEntities, manifestEntities) {
    const combatUnits = [];
    const excludedCivilians = [];

    for (const e of myEntities) {
        if (!e.active || e.isConstruct) continue;
        const hasAttack = e.getActions().some(a => a.name === "Attack");
        if (!hasAttack) continue;

        const meta = manifestEntities[e.name];
        const milScore = meta?.score?.military || 0;
        if (milScore >= MILITARY_SCORE_THRESHOLD) {
            combatUnits.push(e);
        } else {
            excludedCivilians.push(`${e.name}#${(e.id || '').toString().slice(-4)} (mil score ${milScore})`);
        }
    }

    // Strongest units act first
    combatUnits.sort((a, b) =>
        getMilitaryRating(manifestEntities[b.name]) - getMilitaryRating(manifestEntities[a.name]));

    if (excludedCivilians.length > 0) {
        aiLog(player, 'combat', `Combat selection: ${combatUnits.length} military unit(s) eligible [${combatUnits.map(u => u.name).join(', ') || 'none'}]; keeping civilians out of combat: ${excludedCivilians.join(', ')}`);
    } else {
        aiLog(player, 'combat', `Combat selection: ${combatUnits.length} military unit(s) eligible [${combatUnits.map(u => u.name).join(', ') || 'none'}]`);
    }

    return combatUnits;
}

// -----------------------------------------------------------------------------
// Pathfinding helpers (BFS over walkable terrain)
// -----------------------------------------------------------------------------

/**
 * BFS from a unit across terrain the unit can stand on, recording paths.
 * Water/impassable terrain is never traversed, so returned targets are genuinely
 * reachable on foot. Occupied cells may be traversed but not selected as destinations.
 *
 * @returns {Map<string, {cell: Object, path: Array<Object>}>} visited cells with paths
 */
function bfsWalkable(unit, gameState, maxNodes = BFS_NODE_CAP) {
    const grid = gameState.hexGrid;
    const start = { q: unit.q, r: unit.r };

    // Build an occupancy lookup once (getEntityAt is a linear scan per call)
    const occupied = new Set();
    for (const e of gameState.entities) {
        if (e.q !== undefined && e.r !== undefined) occupied.add(`${e.q},${e.r}`);
    }

    const visited = new Map();
    visited.set(`${start.q},${start.r}`, { cell: grid.getCell(start.q, start.r), path: [] });
    const queue = [{ q: start.q, r: start.r, path: [] }];
    let nodes = 0;

    while (queue.length > 0 && nodes < maxNodes) {
        const cur = queue.shift();
        nodes++;
        for (const nb of grid.getNeighbors(cur.q, cur.r)) {
            const key = `${nb.q},${nb.r}`;
            if (visited.has(key)) continue;
            if (!unit.canStandOn(nb)) continue; // impassable terrain (water etc.) — do not traverse

            const path = [...cur.path, nb];
            visited.set(key, { cell: nb, path });

            if (occupied.has(key)) continue; // can pass through but not stop here; don't expand from occupied cells

            queue.push({ q: nb.q, r: nb.r, path });
        }
    }
    return visited;
}

/**
 * Moves a unit as far along a BFS path as its action points allow.
 * Tries the farthest reachable cell first to maximize progress per order.
 *
 * @returns {number} orders used (0 if move failed)
 */
function moveAlongPath(player, unit, moveAction, path, gameState, logCategory, reason) {
    if (!path || path.length === 0) return 0;

    // Fast path: try the full route first (single canDo/pathfind call)
    const lastCell = path[path.length - 1];
    if (!gameState.getEntityAt(lastCell.q, lastCell.r)) {
        const fullCheck = moveAction.canDo(lastCell, null);
        if (fullCheck && fullCheck.possible && moveAction.do(lastCell, null)) {
            aiLog(player, logCategory, `Move ${unit.name} (${path.length}-cell route): advanced to (${lastCell.q},${lastCell.r}) [arrived]. Rationale: ${reason}`);
            return 1;
        }
    }

    // Fallback: estimate the farthest affordable cell from the AP budget using terrain
    // costs along the BFS path, then verify with as few canDo calls as possible
    // (each canDo triggers a full grid pathfind, so calls must stay bounded).
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
        if (gameState.getEntityAt(stepCell.q, stepCell.r)) continue; // destination must be free

        const check = moveAction.canDo(stepCell, null);
        if (check && check.possible) {
            const moved = moveAction.do(stepCell, null);
            if (moved) {
                aiLog(player, logCategory, `Move ${unit.name} (${path.length}-cell route): advanced to (${stepCell.q},${stepCell.r})` +
                    (i < path.length - 1 ? ` [partial: ${i + 1}/${path.length} cells, more next turn]` : ` [arrived]`) +
                    `. Rationale: ${reason}`);
                return 1;
            }
        }
    }
    return 0;
}

// -----------------------------------------------------------------------------
// Goal Executions
// -----------------------------------------------------------------------------

/**
 * Goal 1: Build resources, workers, and infrastructure when under economic pressure.
 */
async function executeBuildResourcesGoal(player, myEntities, economicPressure, gameState) {
    const manifestEntities = getManifestEntities(gameState);
    const workerTypeNames = getWorkerTypes(manifestEntities);
    const settlerTypeNames = getSettlerTypes(manifestEntities);

    const workers = myEntities.filter(e => workerTypeNames.includes(e.name) && e.active);
    const settlers = myEntities.filter(e => settlerTypeNames.includes(e.name) && e.active);

    // 1. Repair seriously damaged structures first (below health threshold only)
    const damagedEntity = myEntities.find(e => e.health < e.maxHealth * REPAIR_HEALTH_THRESHOLD);
    if (damagedEntity) {
        aiLog(player, 'build', `Damaged structure detected: ${damagedEntity.name} at ${(100 * damagedEntity.health / damagedEntity.maxHealth).toFixed(0)}% health (threshold ${REPAIR_HEALTH_THRESHOLD * 100}%). Attempting repair.`);
        const repairers = myEntities.filter(e => e.getActions().some(a => a.name === "Repair"));
        for (const repairer of repairers) {
            const ordersUsed = repair(gameState, repairer, damagedEntity, player.orders);
            if (ordersUsed > 0) {
                aiLog(player, 'build', `Action: Repair ${damagedEntity.name} with ${repairer.name}. Rationale: Fix badly damaged infrastructure. Orders used: ${ordersUsed}`);
                return true;
            }
        }
        aiLog(player, 'warn', `Repair of ${damagedEntity.name} failed (no reachable repairer). Falling through to construction.`);
    }

    // 2. Build resource constructs matching highest-priority deficits via dynamic production chains
    for (const deficitRes of economicPressure.deficits) {
        const candidateYielders = findEntitiesYieldingResource(manifestEntities, deficitRes);
        aiLog(player, 'build', `Deficit '${deficitRes}': candidate producers = [${candidateYielders.map(c => `${c.name}(+${c.yieldAmount})`).join(', ') || 'none'}]`);

        for (const yielder of candidateYielders) {
            const step = resolveProductionPath(player, gameState, yielder.name);
            if (step && step.executor) {
                aiLog(player, 'detail', `Production chain for ${yielder.name}: build via ${step.executor.name}`);
                const ordersUsed = timeIt(player, `build ${yielder.name}`, () => build(gameState, step.executor, step.actionTarget));
                if (ordersUsed > 0) {
                    aiLog(player, 'build', `Action: Build ${camelToTitle(step.actionTarget)} with ${step.executor.name}. Rationale: Satisfy highest demand (${deficitRes}). Orders used: ${ordersUsed}`);
                    return true;
                }
                aiLog(player, 'warn', `Build ${yielder.name} with ${step.executor.name} failed (resources/terrain/orders). Trying next candidate.`);
            } else {
                aiLog(player, 'detail', `No production path available for ${yielder.name} (missing builder in chain).`);
            }
        }
    }

    // 3. If workers are scarce, produce workers
    if (workers.length < 2) {
        aiLog(player, 'build', `Worker count low (${workers.length}/2). Attempting to train a worker.`);
        for (const workerName of workerTypeNames) {
            const step = resolveProductionPath(player, gameState, workerName);
            if (step && step.executor) {
                const ordersUsed = timeIt(player, `train ${workerName}`, () => build(gameState, step.executor, step.actionTarget));
                if (ordersUsed > 0) {
                    aiLog(player, 'build', `Action: Train ${camelToTitle(step.actionTarget)} at ${step.executor.name}. Rationale: Need builders for economy. Orders used: ${ordersUsed}`);
                    return true;
                }
                aiLog(player, 'warn', `Training ${workerName} failed (insufficient resources?).`);
            }
        }
    }

    // 4. Settler expansion if settler available
    const settlementCenterNames = getSettlementCenterTypes(manifestEntities);
    for (const settler of settlers) {
        for (const centerName of settlementCenterNames) {
            const ordersUsed = build(gameState, settler, centerName);
            if (ordersUsed > 0) {
                aiLog(player, 'build', `Action: Found ${camelToTitle(centerName)} with Settler. Rationale: Expand empire territory and production. Orders used: ${ordersUsed}`);
                return true;
            }
        }
    }

    // 5. Fallback: Exploration
    aiLog(player, 'detail', `No construction/training action available; falling back to exploration.`);
    return exploreFog(player, myEntities, gameState);
}

/**
 * Goal 2: Expand and explore when economy is strong and no enemies are visible.
 */
async function executeExpandAndExploreGoal(player, myEntities, gameState) {
    const manifestEntities = getManifestEntities(gameState);
    const settlementCenterNames = getSettlementCenterTypes(manifestEntities);
    const settlerTypeNames = getSettlerTypes(manifestEntities);
    const militaryRanked = getRankedMilitaryTypes(manifestEntities);

    const centers = myEntities.filter(e => settlementCenterNames.includes(e.name) && e.active);
    const settlers = myEntities.filter(e => settlerTypeNames.includes(e.name) && e.active);
    const military = myEntities.filter(e => militaryRanked.some(m => m.name === e.name) && e.active);

    // 1. Build Settler if wealthy and few settlement centers
    if (centers.length < 3 && settlers.length === 0) {
        aiLog(player, 'build', `Expansion check: ${centers.length}/3 settlement centers, ${settlers.length} settlers. Attempting to train a settler.`);
        for (const settlerTypeName of settlerTypeNames) {
            const step = resolveProductionPath(player, gameState, settlerTypeName);
            if (step && step.executor) {
                const ordersUsed = build(gameState, step.executor, step.actionTarget);
                if (ordersUsed > 0) {
                    aiLog(player, 'build', `Action: Train ${camelToTitle(step.actionTarget)} at ${step.executor.name}. Rationale: Strong economy permits territorial expansion. Orders used: ${ordersUsed}`);
                    return true;
                }
                aiLog(player, 'warn', `Training ${settlerTypeName} failed (insufficient resources?).`);
            }
        }
    }

    // 2. Found settlement center with settler
    for (const settler of settlers) {
        for (const centerName of settlementCenterNames) {
            const ordersUsed = build(gameState, settler, centerName);
            if (ordersUsed > 0) {
                aiLog(player, 'build', `Action: Build ${camelToTitle(centerName)}. Rationale: Expand civilization with new settlement. Orders used: ${ordersUsed}`);
                return true;
            }
        }
    }

    // 3. Train Military Units based on attribute combat ratings
    if (military.length < centers.length * 3 && militaryRanked.length > 0) {
        for (const milChoice of militaryRanked) {
            const step = resolveProductionPath(player, gameState, milChoice.name);
            if (step && step.executor) {
                const ordersUsed = build(gameState, step.executor, step.actionTarget);
                if (ordersUsed > 0) {
                    aiLog(player, 'build', `Action: Train ${camelToTitle(step.actionTarget)} at ${step.executor.name}. Rationale: Build military forces (Rating: ${milChoice.rating.toFixed(0)}). Orders used: ${ordersUsed}`);
                    return true;
                }
            }
        }
        aiLog(player, 'warn', `Military training attempted but all options failed (likely resource shortage).`);
    }

    // 4. Explore Fog of War
    return exploreFog(player, myEntities, gameState);
}

/**
 * Goal 3: All-out attack when enemies are visible and economy is strong.
 */
async function executeAllOutAttackGoal(player, myEntities, enemyEntities, gameState) {
    const manifestEntities = getManifestEntities(gameState);
    const combatUnits = selectCombatUnits(player, myEntities, manifestEntities);
    if (combatUnits.length === 0) {
        aiLog(player, 'combat', `No military units available for attack; switching to expansion/exploration mode.`);
        return executeExpandAndExploreGoal(player, myEntities, gameState);
    }

    for (const unit of combatUnits) {
        // Sort enemies by closest distance
        const sortedEnemies = [...enemyEntities].sort((a, b) => HexGrid.distance(unit, a) - HexGrid.distance(unit, b));
        aiLog(player, 'combat', `${unit.name}@(${unit.q},${unit.r}) AP:${unit.actionPoints} engaging nearest enemy ${sortedEnemies[0].name} (dist ${HexGrid.distance(unit, sortedEnemies[0])})`);
        for (const enemy of sortedEnemies) {
            const ordersUsed = timeIt(player, `attack ${unit.name}->${enemy.name}`, () => attack(gameState, unit, enemy, player.orders));
            if (ordersUsed > 0) {
                aiLog(player, 'combat', `Action: Attack ${enemy.name} with ${unit.name}. Rationale: Eliminate visible hostile threat. Orders used: ${ordersUsed}`);
                return true;
            }
        }
        aiLog(player, 'detail', `${unit.name} could not attack any enemy directly (out of range/AP); will advance instead.`);
    }

    // If cannot attack directly, advance military units towards enemy positions
    return advanceMilitaryTowardsEnemies(player, combatUnits, enemyEntities, gameState);
}

/**
 * Goal 4: Defend towns close to enemies first, then build resource infrastructure.
 */
async function executeDefendTownsThenResourcesGoal(player, myEntities, enemyEntities, economicPressure, gameState) {
    const manifestEntities = getManifestEntities(gameState);
    const settlementCenterNames = getSettlementCenterTypes(manifestEntities);
    const towns = myEntities.filter(e => settlementCenterNames.includes(e.name));
    const combatUnits = selectCombatUnits(player, myEntities, manifestEntities);

    // 1. Find enemies threatening towns (distance <= 4 from any town)
    let threateningEnemies = [];
    if (towns.length > 0) {
        threateningEnemies = enemyEntities.filter(enemy => {
            return towns.some(t => HexGrid.distance(enemy, t) <= 4);
        });
    }

    if (threateningEnemies.length > 0) {
        aiLog(player, 'combat', `THREAT DETECTED near settlements: ${threateningEnemies.map(e => `${e.name}@(${e.q},${e.r}, dist-to-town ${Math.min(...towns.map(t => HexGrid.distance(e, t)))})`).join('; ')}`);
    } else {
        aiLog(player, 'combat', `Enemies visible but none within threat radius (4) of settlements.`);
    }

    const targetList = threateningEnemies.length > 0 ? threateningEnemies : enemyEntities;

    for (const unit of combatUnits) {
        const sortedEnemies = [...targetList].sort((a, b) => HexGrid.distance(unit, a) - HexGrid.distance(unit, b));
        for (const enemy of sortedEnemies) {
            const ordersUsed = timeIt(player, `defend-attack ${unit.name}->${enemy.name}`, () => attack(gameState, unit, enemy, player.orders));
            if (ordersUsed > 0) {
                aiLog(player, 'combat', `Action: Defend Settlement - Attack ${enemy.name} with ${unit.name}. Rationale: Protect vulnerable settlement. Orders used: ${ordersUsed}`);
                return true;
            }
        }
    }

    // 2. Advance military toward threatening enemies
    if (combatUnits.length > 0 && threateningEnemies.length > 0) {
        const advanced = advanceMilitaryTowardsEnemies(player, combatUnits, threateningEnemies, gameState);
        if (advanced) return true;
        aiLog(player, 'warn', `Military could not advance toward threats (blocked or out of AP); continuing economy.`);
    }

    // 3. Build required resource infrastructure
    return executeBuildResourcesGoal(player, myEntities, economicPressure, gameState);
}

/**
 * Moves mobile combat units towards enemy entities.
 * FIX: now uses BFS pathfinding over walkable terrain instead of greedy neighbor stepping,
 * so units route around water/mountains instead of oscillating against obstacles.
 */
function advanceMilitaryTowardsEnemies(player, combatUnits, enemyEntities, gameState) {
    if (enemyEntities.length === 0) return false;

    for (const unit of combatUnits) {
        if (unit.actionPoints !== undefined && unit.actionPoints <= 0) continue;
        const moveAction = unit.getActions().find(a => a.name === "Move");
        if (!moveAction) continue;

        const sortedEnemies = [...enemyEntities].sort((a, b) => HexGrid.distance(unit, a) - HexGrid.distance(unit, b));
        const targetEnemy = sortedEnemies[0];

        // BFS over walkable terrain; pick the reachable cell closest to the enemy
        const reachable = timeIt(player, `bfs advance ${unit.name}`, () => bfsWalkable(unit, gameState));
        let best = null;
        let bestDist = Infinity;
        for (const { cell, path } of reachable.values()) {
            if (path.length === 0) continue; // skip starting cell
            const d = HexGrid.distance(cell, targetEnemy);
            if (d < bestDist || (d === bestDist && best && path.length < best.path.length)) {
                bestDist = d;
                best = { cell, path };
            }
        }

        if (best) {
            aiLog(player, 'combat', `Advance plan: ${unit.name} -> (${best.cell.q},${best.cell.r}) via ${best.path.length}-cell route (hex dist to ${targetEnemy.name}: ${bestDist}).`);
            const ordersUsed = moveAlongPath(player, unit, moveAction, best.path, gameState, 'combat', `Close distance to engage ${targetEnemy.name}`);
            if (ordersUsed > 0) return true;
        } else {
            aiLog(player, 'warn', `${unit.name}: no walkable route found toward ${targetEnemy.name}; unit holds position.`);
        }
    }
    return false;
}

/**
 * Moves idle units toward unexplored Fog of War cells.
 * FIX: previously this only compared immediate neighbors, so units oscillated back and
 * forth across already-explored cells and got stuck facing unexplored areas separated by
 * water. Now each explorer runs a BFS over walkable terrain to find the NEAREST REACHABLE
 * unexplored cell and follows that route, guaranteeing steady exploration progress.
 * Settlers never explore (they are too valuable); scouts are prioritized by sight range.
 */
function exploreFog(player, myEntities, gameState) {
    const explorers = myEntities.filter(e => {
        if (e.isConstruct || !e.active) return false;
        if (!e.getActions().some(a => a.name === "Move")) return false;
        if (e.actionPoints !== undefined && e.actionPoints <= 0) return false;
        return true;
    });

    // Priority: settlers excluded entirely; workers lowest; then by sight range (better scouts)
    explorers.sort((a, b) => explorerPriority(b) - explorerPriority(a));

    if (explorers.length === 0) {
        aiLog(player, 'explore', `No mobile units available to explore.`);
        return false;
    }

    for (const unit of explorers) {
        const moveAction = unit.getActions().find(a => a.name === "Move");
        if (!moveAction) continue;

        const reachable = timeIt(player, `bfs explore ${unit.name}`, () => bfsWalkable(unit, gameState));

        // Find nearest reachable unexplored cell (BFS gives us paths ordered by hop count)
        let target = null;
        for (const { cell, path } of reachable.values()) {
            if (path.length === 0) continue; // starting cell
            if (!player.isExplored(cell.q, cell.r)) {
                target = { cell, path };
                break;
            }
        }

        if (!target) {
            aiLog(player, 'explore', `${unit.name}@(${unit.q},${unit.r}): no reachable unexplored cells (searched ${reachable.size} walkable cells). Unit holds position.`);
            continue;
        }

        aiLog(player, 'explore', `Exploration target for ${unit.name}: unexplored cell (${target.cell.q},${target.cell.r}), ${target.path.length} cells away (walkable route confirmed).`);
        const ordersUsed = moveAlongPath(player, unit, moveAction, target.path, gameState, 'explore', 'Reveal fog of war');
        if (ordersUsed > 0) return true;
    }
    return false;
}

function explorerPriority(unit) {
    const name = (unit.name || '').toLowerCase();
    if (name.includes('settler')) return -100;   // never voluntarily explore with settlers
    if (name.includes('worker')) return -10;     // workers only as last resort
    return (unit.sightRange || 1) * 10;          // prefer dedicated scouts / military
}
