/** DEPRECATED **/

import { aiLog, onActionDone, attack, build, repair } from '../utils.js';
import { HexGrid } from '../../hexGrid.js';

// --- Capability Helpers ---
function isBuilder(entity) {
    return entity.getActions && entity.getActions().some(a => a.name === "Build");
}

function isMilitary(entity, manifest) {
    const def = manifest.entities[entity.name] || entity.data;
    return (def?.score?.military > 0) || (def?.damage?.value >= 15);
}

/**
 * Standard AI Manager: Maximizes geometric score through intelligent resource
 * management, threat response, and proactive growth.
 * 
 * @param {Player} player 
 * @param {GameState} gameState 
 */
export async function processTurn(player, gameState) {
    if (!player || player.orders <= 0) return;

    const manifest = gameState.manifestData;
    if (!manifest || !manifest.entities) return;

    aiLog(player, 'turn', `=== Turn Start | Orders: ${player.orders}/${player.maxOrders} ===`);

    let maxIters = player.orders * 3 + 10;
    let actionTaken = true;

    // Track exploration targets this turn to force units to spread out
    const targetedExplorationCells = new Set();

    while (player.orders > 0 && maxIters-- > 0 && actionTaken) {
        actionTaken = await useOrders(player, gameState, manifest, targetedExplorationCells);
        if (actionTaken) {
            await onActionDone(gameState);
        }
    }
}

async function useOrders(player, gameState, manifest, targetedExplorationCells) {
    const myEntities = gameState.entities.filter(e => e.owner?.id === player.id);
    if (myEntities.length === 0) return false;

    const profile = player.getResourceProfile(gameState) || { totalUpkeep: {}, totalYields: {}, netIncome: {} };
    const stock = player.resources || {};

    // Immediate action required if ANY net income is negative (don't wait until stock is empty!)
    const deficits = Object.keys(profile.netIncome).filter(r => profile.netIncome[r] < 0);

    const opponents = player.getOpponents(gameState);
    const visibleEnemies = Object.values(opponents).flatMap(opp => opp.entities).filter(e => e.health > 0);

    const revengeTargetIds = new Set();
    for (const e of myEntities) {
        if (e.attackHistory) {
            for (const atk of e.attackHistory) {
                revengeTargetIds.add(atk.attackerId);
            }
        }
    }

    // 1. SURVIVAL: Fix resource deficits aggressively
    if (await handleDeficits(player, gameState, deficits, manifest, myEntities, profile, stock)) {
        return true;
    }

    // 2. DEFENSE: Eliminate visible threats
    if (await handleDefense(player, gameState, manifest, myEntities, visibleEnemies, revengeTargetIds)) {
        return true;
    }

    // 3. MAINTENANCE: Repair heavily damaged entities
    if (await handleRepairs(player, gameState, myEntities)) {
        return true;
    }

    // 4. GROWTH: Proactively build the economy or push for score
    if (await handleGrowth(player, gameState, profile, stock, manifest, myEntities)) {
        return true;
    }

    // 5. EXPLORATION: Expand map vision while keeping defenders home
    if (await handleExploration(player, gameState, manifest, myEntities, targetedExplorationCells)) {
        return true;
    }

    return false;
}

async function handleDeficits(player, gameState, deficits, manifest, myEntities, profile, stock) {
    if (deficits.length === 0) return false;

    // Prioritize the worst deficits first
    deficits.sort((a, b) => profile.netIncome[a] - profile.netIncome[b]);

    for (const defRes of deficits) {
        const producers = Object.entries(manifest.entities)
            .filter(([_, def]) => def.yields && def.yields[defRes] > 0)
            .map(([name, def]) => {
                const costSum = def.spawnCost ? Object.values(def.spawnCost).reduce((sum, val) => sum + val, 0) : 1;
                return { name, def, efficiency: def.yields[defRes] / (costSum || 1) };
            })
            .sort((a, b) => b.efficiency - a.efficiency);

        for (const prod of producers) {
            const buildStep = resolveBuildPath([prod.name], myEntities, manifest, new Set());
            if (buildStep) {
                aiLog(player, 'econ', `Emergency deficit! ${defRes} is bleeding (${profile.netIncome[defRes]}/turn). Using ${buildStep.builderEntity.name} at (${buildStep.builderEntity.q}, ${buildStep.builderEntity.r}) to build ${buildStep.targetName}.`);
                const ordersUsed = build(gameState, buildStep.builderEntity, buildStep.targetName);
                if (ordersUsed > 0) return true;
            }
        }
    }
    return false;
}

function resolveBuildPath(targetNames, myEntities, manifest, visited) {
    for (const target of targetNames) {
        const targetLower = target.toLowerCase();
        if (visited.has(targetLower)) continue;
        visited.add(targetLower);

        const potentialBuilders = [];
        for (const [name, def] of Object.entries(manifest.entities)) {
            if (def.buildables && def.buildables.map(b => b.toLowerCase()).includes(targetLower)) {
                potentialBuilders.push(name);
            }
        }

        for (const bName of potentialBuilders) {
            const availableBuilder = myEntities.find(e =>
                e.name.toLowerCase() === bName.toLowerCase() &&
                e.active &&
                isBuilder(e)
            );

            if (availableBuilder) {
                return { builderEntity: availableBuilder, targetName: target };
            }
        }

        const recursiveStep = resolveBuildPath(potentialBuilders, myEntities, manifest, visited);
        if (recursiveStep) return recursiveStep;
    }
    return null;
}

async function handleDefense(player, gameState, manifest, myEntities, visibleEnemies, revengeTargetIds) {
    if (visibleEnemies.length === 0) return false;

    const combatCapable = myEntities.filter(e => e.active && e.getActions && e.getActions().some(a => a.name === "Attack"));
    const dedicatedMilitary = combatCapable.filter(e => isMilitary(e, manifest));

    const highThreatEnemies = visibleEnemies.filter(e =>
        revengeTargetIds.has(e.id) || isMilitary(e, manifest)
    );

    if (dedicatedMilitary.length > 0) {
        dedicatedMilitary.sort((a, b) => (b.damage?.value || 0) - (a.damage?.value || 0));
        const targets = highThreatEnemies.length > 0 ? highThreatEnemies : visibleEnemies;

        for (const unit of dedicatedMilitary) {
            for (const enemy of targets) {
                const ordersUsed = attack(gameState, unit, enemy, player.orders);
                if (ordersUsed > 0) {
                    aiLog(player, 'combat', `Tactical Strike: Dedicated military ${unit.name} at (${unit.q}, ${unit.r}) attacked ${enemy.owner.name}'s ${enemy.name} at (${enemy.q}, ${enemy.r})`);
                    return true;
                }
            }
        }
    }

    if (dedicatedMilitary.length === 0 && highThreatEnemies.length > 0) {
        const milProducers = Object.entries(manifest.entities)
            .filter(([_, def]) => def.score?.military > 0 || def.damage?.value >= 15)
            .sort((a, b) => (b[1].score?.military || 0) - (a[1].score?.military || 0))
            .map(([name, _]) => name);

        const buildStep = resolveBuildPath(milProducers, myEntities, manifest, new Set());
        if (buildStep) {
            aiLog(player, 'combat', `Threat Response: High threat detected from ${highThreatEnemies[0].owner.name}'s ${highThreatEnemies[0].name}, but we lack military! Using ${buildStep.builderEntity.name} to build ${buildStep.targetName}.`);
            const ordersUsed = build(gameState, buildStep.builderEntity, buildStep.targetName);
            if (ordersUsed > 0) return true;
        }
    }

    if (highThreatEnemies.length > 0) {
        let desperationUnits = combatCapable.filter(e => !isBuilder(e));
        if (desperationUnits.length === 0) desperationUnits = combatCapable;

        for (const unit of desperationUnits) {
            for (const enemy of highThreatEnemies) {
                const ordersUsed = attack(gameState, unit, enemy, player.orders);
                if (ordersUsed > 0) {
                    aiLog(player, 'warn', `Desperation Defense! Civilian ${unit.name} at (${unit.q}, ${unit.r}) forced to attack high threat ${enemy.owner.name}'s ${enemy.name} at (${enemy.q}, ${enemy.r})`);
                    return true;
                }
            }
        }
    }

    return false;
}

async function handleRepairs(player, gameState, myEntities) {
    const severelyDamaged = myEntities.filter(e => e.health < (e.maxHealth * 0.5));
    if (severelyDamaged.length === 0) return false;

    const repairers = myEntities.filter(e => e.active && e.getActions && e.getActions().some(a => a.name === "Repair"));

    for (const repairer of repairers) {
        for (const target of severelyDamaged) {
            const ordersUsed = repair(gameState, repairer, target, player.orders);
            if (ordersUsed > 0) {
                aiLog(player, 'build', `Maintenance: ${repairer.name} is repairing heavily damaged ${target.name} at (${target.q}, ${target.r})`);
                return true;
            }
        }
    }
    return false;
}

async function handleGrowth(player, gameState, profile, stock, manifest, myEntities) {
    let currentMil = Math.max(1, player.score?.military || 1);
    let currentEco = Math.max(1, player.score?.economic || 1);

    // Ensure we track relevant active resources, defaulting to stockpile keys
    const trackedResources = Object.keys(profile.netIncome).length > 0 ? Object.keys(profile.netIncome) : Object.keys(stock);
    let isBooming = true;
    for (const r of trackedResources) {
        if (r === 'orders') continue;
        if ((profile.netIncome[r] || 0) < 2 || (stock[r] || 0) < 15) {
            isBooming = false;
            break;
        }
    }

    const buildOptions = [];
    for (const ent of myEntities) {
        if (!ent.active) continue;
        const buildables = ent.state?.buildables || ent.data?.buildables || [];
        if (isBuilder(ent) && buildables.length > 0) {
            for (const b of buildables) {
                buildOptions.push({ builder: ent, target: b });
            }
        }
    }

    let bestOption = null;
    let bestROI = -1;

    for (const opt of buildOptions) {
        const def = manifest.entities[opt.target] || Object.values(manifest.entities).find(e => e.name.toLowerCase() === opt.target.toLowerCase());
        if (!def) continue;

        let affordableMaintenance = true;
        for (const [r, amt] of Object.entries(def.maintenance || {})) {
            const futureNet = (profile.netIncome[r] || 0) - amt;
            // Allow going into a deficit ONLY if we have a robust stockpile to survive the construction phase 
            // (Crucial for building initial constructs like Villages)
            if (futureNet < 0 && (stock[r] || 0) < Math.abs(futureNet) * 5) {
                affordableMaintenance = false;
                break;
            }
        }
        if (!affordableMaintenance) continue;

        const spawnCost = def.spawnCost || {};
        if (player.hasResources && !player.hasResources(spawnCost)) continue;

        let resourceValue = 0;
        for (const [r, yieldAmt] of Object.entries(def.yields || {})) {
            if (yieldAmt <= 0) continue;
            const net = profile.netIncome[r] || 0;
            if (net < 5) resourceValue += yieldAmt * 3.0;
            else if (net < 15) resourceValue += yieldAmt * 1.5;
            else resourceValue += yieldAmt * 0.5;
        }

        const milScore = def.score?.military || 0;
        const ecoScore = def.score?.economic || 0;
        const isMilUnit = milScore > 0 || (def.damage?.value >= 15);

        let scoreValue = (milScore / currentMil) * 100 + (ecoScore / currentEco) * 100;
        let totalValue = 0;

        if (isBooming) {
            totalValue = scoreValue * 2 + resourceValue + (isMilUnit ? 50 : 0);
        } else {
            totalValue = resourceValue * 4 + scoreValue;
        }

        const totalCost = Object.values(spawnCost).reduce((sum, val) => sum + val, 0) || 1;
        const roi = totalValue / totalCost;

        if (roi > bestROI && totalValue > 0) {
            bestROI = roi;
            bestOption = opt;
        }
    }

    if (bestOption) {
        aiLog(player, 'build', `Growth (${isBooming ? 'Booming' : 'Developing'}): ${bestOption.builder.name} building ${bestOption.target} (ROI: ${bestROI.toFixed(2)})`);
        const ordersUsed = build(gameState, bestOption.builder, bestOption.target);
        if (ordersUsed > 0) return true;
    }

    return false;
}

async function handleExploration(player, gameState, manifest, myEntities, targetedExplorationCells) {
    const constructs = myEntities.filter(e => e.isConstruct);
    const combatUnits = myEntities.filter(e => isMilitary(e, manifest));

    const defenders = new Set();
    for (const c of constructs) {
        let bestDef = null;
        let bestDist = Infinity;
        for (const unit of combatUnits) {
            if (defenders.has(unit.id)) continue;
            const d = HexGrid.distance(c, unit); // Utilizing the required HexGrid.distance method
            if (d < bestDist) {
                bestDist = d;
                bestDef = unit;
            }
        }
        if (bestDef) defenders.add(bestDef.id);
    }

    const explorers = myEntities.filter(e =>
        e.active &&
        e.actionPoints > 0 &&
        !e.isConstruct &&
        e.getActions &&
        e.getActions().some(a => a.name === "Move") &&
        !defenders.has(e.id)
    );

    explorers.sort((a, b) => {
        const scoreA = (isBuilder(a) ? -100 : 0) + (a.actionPoints || 0);
        const scoreB = (isBuilder(b) ? -100 : 0) + (b.actionPoints || 0);
        return scoreB - scoreA;
    });

    for (const explorer of explorers) {
        const moveAction = explorer.getActions().find(a => a.name === "Move");
        if (!moveAction) continue;

        const neighbors = gameState.hexGrid.getNeighbors(explorer.q, explorer.r);

        neighbors.sort((a, b) => {
            const keyA = `${a.q},${a.r}`;
            const keyB = `${b.q},${b.r}`;

            const isExploredA = player.isExplored ? player.isExplored(a.q, a.r) : true;
            const isExploredB = player.isExplored ? player.isExplored(b.q, b.r) : true;

            const scoreA = (isExploredA ? 0 : 1000) - (targetedExplorationCells.has(keyA) ? 500 : 0) + (Math.random() * 10);
            const scoreB = (isExploredB ? 0 : 1000) - (targetedExplorationCells.has(keyB) ? 500 : 0) + (Math.random() * 10);

            return scoreB - scoreA;
        });

        for (const n of neighbors) {
            const check = moveAction.canDo(n, null);
            if (check && check.possible) {
                const executed = moveAction.do(n, null);
                if (executed) {
                    const key = `${n.q},${n.r}`;
                    targetedExplorationCells.add(key);
                    aiLog(player, 'explore', `Scouting: ${explorer.name} at (${explorer.q}, ${explorer.r}) fanning out to (${n.q}, ${n.r})`);
                    return true;
                }
            }
        }
    }
    return false;
}