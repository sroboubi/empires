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

    // 1. Assess economy and calculate economic pressure
    const economicPressure = evaluateEconomicPressure(player, gameState);

    // 2. Identify visible enemy entities
    const visibleOpponents = player.getOpponents ? player.getOpponents(gameState) : {};
    const enemyEntities = [];
    Object.values(visibleOpponents).forEach(opp => {
        if (opp.entities) enemyEntities.push(...opp.entities);
    });
    const hasEnemies = enemyEntities.length > 0;

    // 3. Goal Selection
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

    console.log(`%c[AI ${player.name}] Turn Start (Round ${gameState.currentRound}) | Goal: ${goal} | Economic Pressure: ${economicPressure.level} | Orders: ${player.orders}`, 'color: #3498db; font-weight: bold;');
    if (economicPressure.reasons.length > 0) {
        console.log(`%c[AI ${player.name}] Economic Analysis: ${economicPressure.reasons.join('; ')}`, 'color: #9ca3af;');
    }

    let maxLoops = 25;
    let actionExecuted = true;

    while (player.orders > 0 && maxLoops > 0 && actionExecuted) {
        maxLoops--;
        actionExecuted = false;

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
 * Evaluates economic pressure for a player.
 * - High: net yield < 1.5x upkeep OR stock < 4x upkeep for any resource.
 * - Low: net yield < 3x upkeep OR stock < 6x upkeep for any resource.
 * - None: otherwise.
 */
export function evaluateEconomicPressure(player, gameState) {
    const profile = player.getResourceProfile ? player.getResourceProfile(gameState) : { totalUpkeep: {}, totalYields: {}, netIncome: {} };
    const { totalUpkeep, totalYields, netIncome } = profile;
    const reserves = player.resources || {};

    const resourceKeys = Array.from(new Set([
        ...Object.keys(reserves),
        ...Object.keys(totalUpkeep),
        ...Object.keys(totalYields),
        'food', 'gold', 'wood', 'iron', 'gems'
    ]));

    let isHigh = false;
    let isLow = false;
    const reasons = [];
    const deficits = [];

    for (const res of resourceKeys) {
        const upkeep = totalUpkeep[res] || 0;
        const net = netIncome[res] !== undefined ? netIncome[res] : 0;
        const stock = reserves[res] !== undefined ? reserves[res] : 0;

        if (upkeep > 0) {
            if (net < 1.5 * upkeep || stock < 4 * upkeep) {
                isHigh = true;
                deficits.push(res);
                reasons.push(`${res} in deficit (net ${net} < 1.5x upkeep ${upkeep} or stock ${stock} < 4x upkeep)`);
            } else if (net < 3.0 * upkeep || stock < 6 * upkeep) {
                isLow = true;
                deficits.push(res);
                reasons.push(`${res} low margin (net ${net} < 3x upkeep ${upkeep} or stock ${stock} < 6x upkeep)`);
            }
        } else {
            if (net < 0 || stock < 25) {
                isHigh = true;
                deficits.push(res);
                reasons.push(`${res} reserves low (${stock})`);
            }
        }
    }

    const level = isHigh ? 'HIGH' : (isLow ? 'LOW' : 'NONE');
    return { level, reasons, deficits, profile };
}

/**
 * Goal 1: Build resources, workers, and settlers when under economic pressure and no enemies.
 */
async function executeBuildResourcesGoal(player, myEntities, economicPressure, gameState) {
    const workers = myEntities.filter(e => e.name === 'worker' && e.active);
    const villages = myEntities.filter(e => e.name === 'village' && e.active);
    const settlers = myEntities.filter(e => e.name === 'settler' && e.active);

    // 1. Repair any damaged structures first
    const damagedEntity = myEntities.find(e => e.health < e.maxHealth);
    if (damagedEntity) {
        for (const worker of workers) {
            const ordersUsed = repair(gameState, worker, damagedEntity, player.orders);
            if (ordersUsed > 0) {
                console.log(`[AI ${player.name}] Action: Repair ${damagedEntity.name}. Rationale: Fix damaged infrastructure. Orders used: ${ordersUsed}`);
                return true;
            }
        }
    }

    // 2. Ensure at least 1-2 workers exist
    if (workers.length < 2 && villages.length > 0) {
        for (const village of villages) {
            const ordersUsed = build(gameState, village, 'worker');
            if (ordersUsed > 0) {
                console.log(`[AI ${player.name}] Action: Train Worker at ${village.name}. Rationale: Need workers to build resource infrastructure. Orders used: ${ordersUsed}`);
                return true;
            }
        }
    }

    // 3. Workers build resource constructs matching deficits
    const constructMap = { food: 'farm', gold: 'mine', gems: 'mine', wood: 'lumberMill', iron: 'forge' };
    const priorityConstructs = [];
    economicPressure.deficits.forEach(d => {
        const c = constructMap[d];
        if (c && !priorityConstructs.includes(c)) priorityConstructs.push(c);
    });
    ['farm', 'mine', 'lumberMill', 'forge'].forEach(c => {
        if (!priorityConstructs.includes(c)) priorityConstructs.push(c);
    });

    for (const worker of workers) {
        for (const constructName of priorityConstructs) {
            const ordersUsed = build(gameState, worker, constructName);
            if (ordersUsed > 0) {
                console.log(`[AI ${player.name}] Action: Build ${camelToTitle(constructName)}. Rationale: Alleviate economic pressure for deficits (${economicPressure.deficits.join(', ')}). Orders used: ${ordersUsed}`);
                return true;
            }
        }
    }

    // 4. Settler expansion if settler available
    for (const settler of settlers) {
        const ordersUsed = build(gameState, settler, 'village');
        if (ordersUsed > 0) {
            console.log(`[AI ${player.name}] Action: Found Village with Settler. Rationale: Expand empire territory and production. Orders used: ${ordersUsed}`);
            return true;
        }
    }

    // 5. Fallback: Exploration
    return exploreFog(player, myEntities, gameState);
}

/**
 * Goal 2: Expand and explore when economy is strong and no enemies are visible.
 */
async function executeExpandAndExploreGoal(player, myEntities, gameState) {
    const villages = myEntities.filter(e => e.name === 'village' && e.active);
    const settlers = myEntities.filter(e => e.name === 'settler' && e.active);
    const military = myEntities.filter(e => ['swordsman', 'bowman', 'horseman'].includes(e.name) && e.active);

    // 1. Build Settler if wealthy and few villages
    if (villages.length < 3 && settlers.length === 0 && (player.resources.food || 0) >= 120 && (player.resources.gold || 0) >= 60) {
        for (const village of villages) {
            const ordersUsed = build(gameState, village, 'settler');
            if (ordersUsed > 0) {
                console.log(`[AI ${player.name}] Action: Train Settler at ${village.name}. Rationale: Strong economy permits territorial expansion. Orders used: ${ordersUsed}`);
                return true;
            }
        }
    }

    // 2. Found village with settler
    for (const settler of settlers) {
        const ordersUsed = build(gameState, settler, 'village');
        if (ordersUsed > 0) {
            console.log(`[AI ${player.name}] Action: Build Village. Rationale: Expand civilization with new settlement. Orders used: ${ordersUsed}`);
            return true;
        }
    }

    // 3. Train Military Units (Bowman, Swordsman, Horseman)
    if (military.length < villages.length * 3) {
        const militaryQueue = ['bowman', 'swordsman', 'horseman'];
        for (const village of villages) {
            for (const unitType of militaryQueue) {
                const ordersUsed = build(gameState, village, unitType);
                if (ordersUsed > 0) {
                    console.log(`[AI ${player.name}] Action: Train ${camelToTitle(unitType)} at ${village.name}. Rationale: Build military forces for defense and scouting. Orders used: ${ordersUsed}`);
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
    const villages = myEntities.filter(e => e.name === 'village');
    const combatUnits = myEntities.filter(e => !e.isConstruct && e.active && e.getActions().some(a => a.name === "Attack"));

    // 1. Find enemies threatening villages (distance <= 4 from any village)
    let threateningEnemies = [];
    if (villages.length > 0) {
        threateningEnemies = enemyEntities.filter(enemy => {
            return villages.some(v => HexGrid.distance(enemy, v) <= 4);
        });
    }

    const targetList = threateningEnemies.length > 0 ? threateningEnemies : enemyEntities;

    for (const unit of combatUnits) {
        const sortedEnemies = [...targetList].sort((a, b) => HexGrid.distance(unit, a) - HexGrid.distance(unit, b));
        for (const enemy of sortedEnemies) {
            const ordersUsed = attack(gameState, unit, enemy, player.orders);
            if (ordersUsed > 0) {
                console.log(`[AI ${player.name}] Action: Defend Town - Attack ${enemy.name} with ${unit.name}. Rationale: Protect vulnerable settlement. Orders used: ${ordersUsed}`);
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