import { attack, build, repair } from '../utils.js';
import { HexGrid } from '../../hexGrid.js';
import { camelToTitle } from '../../utils.js';

/**
 * Conventional Goal-Driven Heuristic AI Controller
 * Interface: async function processTurn(player, gameState)
 */
export async function processTurn(player, gameState) {
    if (!player || player.orders <= 0) return;

    const manifest = gameState.manifestData;
    if (!manifest || !manifest.entities) return;

    // Identify visible enemy entities
    const visibleOpponents = player.getOpponents ? player.getOpponents(gameState) : {};
    const enemyEntities = [];
    Object.values(visibleOpponents).forEach(opp => {
        if (opp.entities) enemyEntities.push(...opp.entities);
    });
    const hasEnemies = enemyEntities.length > 0;

    let maxLoops = 25;
    let actionExecuted = true;

    while (player.orders > 0 && maxLoops > 0 && actionExecuted) {
        maxLoops--;
        actionExecuted = false;

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

        console.log(`%c[AI ${player.name}] Action Step (Round ${gameState.currentRound}) | Goal: ${goal} | Economic Pressure: ${economicPressure.level} | Orders: ${player.orders}`, 'color: #3498db; font-weight: bold;');
        if (economicPressure.reasons.length > 0) {
            console.log(`%c[AI ${player.name}] Demand Analysis (Ranked): ${economicPressure.deficits.join(' > ') || 'None'} | ${economicPressure.reasons.join('; ')}`, 'color: #9ca3af;');
        }

        const myEntities = player.getEntities ? player.getEntities(gameState) : [];
        if (myEntities.length === 0) break;

        // Execute turn actions based on active goal
        switch (goal) {
            case "BUILD_RESOURCES_AND_WORKERS":
                actionExecuted = await executeBuildResourcesGoal(player, myEntities, economicPressure, gameState);
                break;
            case "EXPAND_AND_EXPLORE":
                actionExecuted = await executeExpandAndExploreGoal(player, myEntities, gameState);
                break;
            case "ALL_OUT_ATTACK":
                actionExecuted = await executeAllOutAttackGoal(player, myEntities, enemyEntities, gameState);
                break;
            case "DEFEND_TOWNS_THEN_RESOURCES":
                actionExecuted = await executeDefendTownsThenResourcesGoal(player, myEntities, enemyEntities, economicPressure, gameState);
                break;
            default:
                break;
        }

        if (actionExecuted) {
            await sleep(60);
        }
    }

    console.log(`%c[AI ${player.name}] Turn Completed. Remaining orders: ${player.orders}`, 'color: #2ecc71;');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Evaluates economic pressure dynamically and ranks resource deficits by highest demand score.
 * Excludes 'orders' from stock and yield evaluations.
 */
export function evaluateEconomicPressure(player, gameState) {
    const profile = player.getResourceProfile ? player.getResourceProfile(gameState) : { totalUpkeep: {}, totalYields: {}, netIncome: {} };
    const { totalUpkeep, totalYields, netIncome } = profile;
    const reserves = player.resources || {};
    const startingResources = gameState?.initializationSettings?.startingResources || {};

    const resourceKeys = Array.from(new Set([
        ...Object.keys(reserves),
        ...Object.keys(totalUpkeep),
        ...Object.keys(totalYields),
        ...Object.keys(startingResources)
    ])).filter(k => k !== 'orders');

    let isHigh = false;
    let isLow = false;
    const reasons = [];
    const deficitsWithScores = [];

    for (const res of resourceKeys) {
        const upkeep = totalUpkeep[res] || 0;
        const net = netIncome[res] !== undefined ? netIncome[res] : 0;
        const stock = reserves[res] !== undefined ? reserves[res] : 0;
        const initialRes = startingResources[res] !== undefined ? startingResources[res] : 100;
        const lowStockThreshold = 0.5 * initialRes;
        const medStockThreshold = 1.0 * initialRes;

        let resScore = 0;
        let hasDeficit = false;

        if (upkeep > 0) {
            if (net < 1.5 * upkeep || stock < 4 * upkeep) {
                isHigh = true;
                hasDeficit = true;
                resScore = (1.5 * upkeep - net) * 2 + Math.max(0, 4 * upkeep - stock);
                reasons.push(`${res} in deficit (net ${net} < 1.5x upkeep ${upkeep} or stock ${stock} < 4x upkeep)`);
            } else if (net < 3.0 * upkeep || stock < 6 * upkeep) {
                isLow = true;
                hasDeficit = true;
                resScore = (3.0 * upkeep - net) + Math.max(0, 6 * upkeep - stock) * 0.5;
                reasons.push(`${res} low margin (net ${net} < 3x upkeep ${upkeep} or stock ${stock} < 6x upkeep)`);
            }
        } else {
            if (net < 0 || stock < lowStockThreshold) {
                isHigh = true;
                hasDeficit = true;
                resScore = Math.max(0, lowStockThreshold - stock) * 2 + (net < 0 ? Math.abs(net) * 3 : 0);
                reasons.push(`${res} reserves low (${stock} < 0.5x starting ${initialRes})`);
            } else if (stock < medStockThreshold) {
                isLow = true;
                hasDeficit = true;
                resScore = Math.max(0, medStockThreshold - stock);
                reasons.push(`${res} reserves moderate (${stock} < starting ${initialRes})`);
            }
        }

        if (hasDeficit) {
            deficitsWithScores.push({ res, score: resScore });
        }
    }

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
 * Returns entity types capable of founding settlements (destroyOnBuild or builds settlement centers).
 */
function getSettlerTypes(manifestEntities) {
    return Object.entries(manifestEntities)
        .filter(([_, meta]) => meta.destroyOnBuild || (Array.isArray(meta.buildables) && meta.buildables.some(b => manifestEntities[b]?.spawnConditions?.minSeparation >= 3)))
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

    // 1. Repair any damaged structures first
    const damagedEntity = myEntities.find(e => e.health < e.maxHealth);
    if (damagedEntity) {
        const repairers = myEntities.filter(e => e.getActions().some(a => a.name === "Repair"));
        for (const repairer of repairers) {
            const ordersUsed = repair(gameState, repairer, damagedEntity, player.orders);
            if (ordersUsed > 0) {
                console.log(`[AI ${player.name}] Action: Repair ${damagedEntity.name}. Rationale: Fix damaged infrastructure. Orders used: ${ordersUsed}`);
                return true;
            }
        }
    }

    // 2. Build resource constructs matching highest-priority deficits via dynamic production chains
    for (const deficitRes of economicPressure.deficits) {
        const candidateYielders = findEntitiesYieldingResource(manifestEntities, deficitRes);
        for (const yielder of candidateYielders) {
            const step = resolveProductionPath(player, gameState, yielder.name);
            if (step && step.executor) {
                const ordersUsed = build(gameState, step.executor, step.actionTarget);
                if (ordersUsed > 0) {
                    console.log(`[AI ${player.name}] Action: Build ${camelToTitle(step.actionTarget)} with ${step.executor.name}. Rationale: Satisfy highest demand (${deficitRes}). Orders used: ${ordersUsed}`);
                    return true;
                }
            }
        }
    }

    // 3. If workers are scarce, produce workers
    if (workers.length < 2) {
        for (const workerName of workerTypeNames) {
            const step = resolveProductionPath(player, gameState, workerName);
            if (step && step.executor) {
                const ordersUsed = build(gameState, step.executor, step.actionTarget);
                if (ordersUsed > 0) {
                    console.log(`[AI ${player.name}] Action: Train ${camelToTitle(step.actionTarget)} at ${step.executor.name}. Rationale: Need builders for economy. Orders used: ${ordersUsed}`);
                    return true;
                }
            }
        }
    }

    // 4. Settler expansion if settler available
    const settlementCenterNames = getSettlementCenterTypes(manifestEntities);
    for (const settler of settlers) {
        for (const centerName of settlementCenterNames) {
            const ordersUsed = build(gameState, settler, centerName);
            if (ordersUsed > 0) {
                console.log(`[AI ${player.name}] Action: Found ${camelToTitle(centerName)} with Settler. Rationale: Expand empire territory and production. Orders used: ${ordersUsed}`);
                return true;
            }
        }
    }

    // 5. Fallback: Exploration
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
        for (const settlerTypeName of settlerTypeNames) {
            const step = resolveProductionPath(player, gameState, settlerTypeName);
            if (step && step.executor) {
                const ordersUsed = build(gameState, step.executor, step.actionTarget);
                if (ordersUsed > 0) {
                    console.log(`[AI ${player.name}] Action: Train ${camelToTitle(step.actionTarget)} at ${step.executor.name}. Rationale: Strong economy permits territorial expansion. Orders used: ${ordersUsed}`);
                    return true;
                }
            }
        }
    }

    // 2. Found settlement center with settler
    for (const settler of settlers) {
        for (const centerName of settlementCenterNames) {
            const ordersUsed = build(gameState, settler, centerName);
            if (ordersUsed > 0) {
                console.log(`[AI ${player.name}] Action: Build ${camelToTitle(centerName)}. Rationale: Expand civilization with new settlement. Orders used: ${ordersUsed}`);
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
                    console.log(`[AI ${player.name}] Action: Train ${camelToTitle(step.actionTarget)} at ${step.executor.name}. Rationale: Build military forces (Rating: ${milChoice.rating.toFixed(0)}). Orders used: ${ordersUsed}`);
                    return true;
                }
            }
        }
    }

    // 4. Explore Fog of War
    return exploreFog(player, myEntities, gameState);
}

/**
 * Goal 3: All-out attack when enemies are visible and economy is strong.
 */
async function executeAllOutAttackGoal(player, myEntities, enemyEntities, gameState) {
    const combatUnits = myEntities.filter(e => !e.isConstruct && e.active && e.getActions().some(a => a.name === "Attack"));
    if (combatUnits.length === 0) {
        return executeExpandAndExploreGoal(player, myEntities, gameState);
    }

    for (const unit of combatUnits) {
        // Sort enemies by closest distance
        const sortedEnemies = [...enemyEntities].sort((a, b) => HexGrid.distance(unit, a) - HexGrid.distance(unit, b));
        for (const enemy of sortedEnemies) {
            const ordersUsed = attack(gameState, unit, enemy, player.orders);
            if (ordersUsed > 0) {
                console.log(`[AI ${player.name}] Action: Attack ${enemy.name} with ${unit.name}. Rationale: Eliminate visible hostile threat. Orders used: ${ordersUsed}`);
                return true;
            }
        }
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
    const combatUnits = myEntities.filter(e => !e.isConstruct && e.active && e.getActions().some(a => a.name === "Attack"));

    // 1. Find enemies threatening towns (distance <= 4 from any town)
    let threateningEnemies = [];
    if (towns.length > 0) {
        threateningEnemies = enemyEntities.filter(enemy => {
            return towns.some(t => HexGrid.distance(enemy, t) <= 4);
        });
    }

    const targetList = threateningEnemies.length > 0 ? threateningEnemies : enemyEntities;

    for (const unit of combatUnits) {
        const sortedEnemies = [...targetList].sort((a, b) => HexGrid.distance(unit, a) - HexGrid.distance(unit, b));
        for (const enemy of sortedEnemies) {
            const ordersUsed = attack(gameState, unit, enemy, player.orders);
            if (ordersUsed > 0) {
                console.log(`[AI ${player.name}] Action: Defend Settlement - Attack ${enemy.name} with ${unit.name}. Rationale: Protect vulnerable settlement. Orders used: ${ordersUsed}`);
                return true;
            }
        }
    }

    // 2. Advance military toward threatening enemies
    if (combatUnits.length > 0 && threateningEnemies.length > 0) {
        const advanced = advanceMilitaryTowardsEnemies(player, combatUnits, threateningEnemies, gameState);
        if (advanced) return true;
    }

    // 3. Build required resource infrastructure
    return executeBuildResourcesGoal(player, myEntities, economicPressure, gameState);
}

/**
 * Moves mobile combat units towards enemy entities.
 */
function advanceMilitaryTowardsEnemies(player, combatUnits, enemyEntities, gameState) {
    if (enemyEntities.length === 0) return false;

    for (const unit of combatUnits) {
        if (unit.actionPoints <= 0) continue;
        const moveAction = unit.getActions().find(a => a.name === "Move");
        if (!moveAction) continue;

        const sortedEnemies = [...enemyEntities].sort((a, b) => HexGrid.distance(unit, a) - HexGrid.distance(unit, b));
        const targetEnemy = sortedEnemies[0];

        const neighbors = gameState.hexGrid.getNeighbors(unit.q, unit.r);
        neighbors.sort((a, b) => HexGrid.distance(a, targetEnemy) - HexGrid.distance(b, targetEnemy));

        for (const candCell of neighbors) {
            if (gameState.getEntityAt(candCell.q, candCell.r)) continue;

            const check = moveAction.canDo(candCell, null);
            if (check && check.possible) {
                const moved = moveAction.do(candCell, null);
                if (moved) {
                    console.log(`[AI ${player.name}] Action: Move ${unit.name} towards ${targetEnemy.name}. Rationale: Close distance to engage enemy.`);
                    return true;
                }
            }
        }
    }
    return false;
}

/**
 * Moves idle units into unexplored Fog of War cells.
 */
function exploreFog(player, myEntities, gameState) {
    for (const unit of myEntities) {
        if (unit.isConstruct || !unit.active || (unit.actionPoints !== undefined && unit.actionPoints <= 0)) continue;

        const moveAction = unit.getActions().find(a => a.name === "Move");
        if (!moveAction) continue;

        const neighbors = gameState.hexGrid.getNeighbors(unit.q, unit.r);
        neighbors.sort((a, b) => {
            const aExplored = player.isExplored ? player.isExplored(a.q, a.r) : true;
            const bExplored = player.isExplored ? player.isExplored(b.q, b.r) : true;
            if (aExplored !== bExplored) return aExplored ? 1 : -1;
            const aVis = player.isVisible ? player.isVisible(a.q, a.r) : true;
            const bVis = player.isVisible ? player.isVisible(b.q, b.r) : true;
            return aVis === bVis ? 0 : aVis ? 1 : -1;
        });

        for (const nCell of neighbors) {
            if (gameState.getEntityAt(nCell.q, nCell.r)) continue;

            const check = moveAction.canDo(nCell, null);
            if (check && check.possible) {
                const moved = moveAction.do(nCell, null);
                if (moved) {
                    console.log(`[AI ${player.name}] Action: Explore with ${unit.name}. Rationale: Reveal fog of war.`);
                    return true;
                }
            }
        }
    }
    return false;
}