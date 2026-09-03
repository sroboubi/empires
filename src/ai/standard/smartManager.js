import {
    attack,
    build,
    repair,
    onActionDone,
    aiLog,
    isBuilder,
    isRepairer,
    isCombatCapable,
    isMobile,
    getCombatPower,
    isDedicatedMilitary,
    getEntitiesByCapability,
    getEntitiesSortedByPower,
    moveAlongPath,
    findPathTowardsUnexplored
} from '../utils.js';
import { HexGrid } from '../../hexGrid.js';
import { camelToTitle } from '../../utils.js';

/**
 * Smart AI Manager
 * Fully dynamic, configuration-driven AI controller for Empires.
 * 
 * Key Principles (from src/ai/spec.md):
 * 1. Zero hardcoded entity names or magic elevation numbers (derives all types dynamically).
 * 2. Continuous resource deficit prevention with dynamic recursive dependency chain resolution.
 * 3. Resource reservation: Deficits that cannot be immediately afforded reserve their required
 *    resources to prevent proactive growth from exhausting scarce stockpiles.
 * 4. Robust combat and threat response with detailed diagnostic logging for detection, selection,
 *    and engagement outcomes.
 * 5. Full pathfinding exploration: Non-builder mobile units step towards the nearest unexplored
 *    cell, moving as many hexes as possible in a single order across multiple turns.
 * 6. Heavy damage repairs (<50% HP).
 * 7. Proactive economic and military expansion.
 */

/**
 * Evaluates current player resource stocks, incomes, upkeeps, and target thresholds.
 * Hardcodes ONLY "orders" resource filtering per guideline 20.
 * @param {Player} player 
 * @param {GameState} gameState 
 * @returns {Object}
 */
function evaluateResources(player, gameState) {
    const profile = player.getResourceProfile ? player.getResourceProfile(gameState) : { totalUpkeep: {}, totalYields: {}, netIncome: {} };
    const { totalUpkeep = {}, totalYields = {}, netIncome = {} } = profile;
    const reserves = player.resources || {};
    const startingResources = gameState?.initializationSettings?.startingResources || {};

    const resourceKeys = Array.from(new Set([
        ...Object.keys(reserves),
        ...Object.keys(totalUpkeep),
        ...Object.keys(totalYields),
        ...Object.keys(startingResources)
    ])).filter(k => k !== 'orders');

    const targets = {};
    const deficits = [];
    const lowStock = [];
    const surpluses = [];
    const logDetails = [];

    for (const res of resourceKeys) {
        const net = netIncome[res] !== undefined ? netIncome[res] : 0;
        const upkeep = totalUpkeep[res] || 0;
        const yieldAmt = totalYields[res] || 0;
        const stock = reserves[res] !== undefined ? reserves[res] : 0;
        const start = startingResources[res] !== undefined ? startingResources[res] : 30;

        // Target stock dynamically ensures a 10-turn upkeep buffer or starting reserve
        const target = Math.max(start, upkeep * 10, 25);
        targets[res] = target;

        let status = 'balanced';
        if (net < 0) {
            status = 'deficit';
            const urgency = (-net * 15) + Math.max(0, target - stock);
            deficits.push({ res, net, stock, upkeep, yieldAmt, target, urgency });
        } else if (stock < upkeep * 3 || (net === 0 && stock < target * 0.5)) {
            status = 'low_stock';
            lowStock.push({ res, net, stock, upkeep, yieldAmt, target, urgency: (target - stock) });
        } else if (net > 0 && stock >= target) {
            status = 'surplus';
            surpluses.push({ res, net, stock, upkeep, yieldAmt, target });
        }

        logDetails.push(`  ${res}: stock=${stock}, net=${net} (+${yieldAmt}/-${upkeep}), target=${target} [${status}]`);
    }

    deficits.sort((a, b) => b.urgency - a.urgency);
    lowStock.sort((a, b) => b.urgency - a.urgency);

    return {
        profile,
        targets,
        deficits,
        lowStock,
        surpluses,
        logDetails
    };
}

/**
 * Resolves a recursive dependency chain to find an immediate executable build action
 * for a desired target entity.
 * 
 * @param {Player} player 
 * @param {GameState} gameState 
 * @param {string} targetName 
 * @param {Object} manifest 
 * @param {Set<string>} [visited]
 * @returns {{builderEntity: Object, targetName: string, directTarget: string}|null}
 */
function resolveProductionPath(player, gameState, targetName, manifest, visited = new Set()) {
    const targetLower = targetName.toLowerCase();
    if (visited.has(targetLower)) return null;
    visited.add(targetLower);

    const manifestEntities = manifest?.entities || {};
    const myActiveEntities = player.getEntities ? player.getEntities(gameState).filter(e => e.active) : [];

    // Find all manifest entity types that list targetName in their buildables
    const potentialBuilderNames = [];
    for (const [bName, bMeta] of Object.entries(manifestEntities)) {
        if (Array.isArray(bMeta?.buildables)) {
            if (bMeta.buildables.some(item => item.toLowerCase() === targetLower)) {
                potentialBuilderNames.push(bName);
            }
        }
    }

    // 1. Direct match: Check if we currently own an active builder of one of these types
    for (const bName of potentialBuilderNames) {
        const owned = myActiveEntities.find(e => e.name.toLowerCase() === bName.toLowerCase() && isBuilder(e));
        if (owned) {
            return {
                builderEntity: owned,
                targetName: targetName,
                directTarget: targetName
            };
        }
    }

    // 2. Recursive match: We don't have the builder, recursively resolve how to produce the builder
    for (const bName of potentialBuilderNames) {
        const subStep = resolveProductionPath(player, gameState, bName, manifest, visited);
        if (subStep) {
            return {
                builderEntity: subStep.builderEntity,
                targetName: subStep.targetName,
                directTarget: targetName
            };
        }
    }

    return null;
}

/**
 * Finds all construct definitions yielding a given resource, ranked by yield efficiency.
 * @param {Object} manifest 
 * @param {string} resKey 
 * @returns {Array<{name: string, meta: Object, yieldAmt: number, efficiency: number}>}
 */
function findProducersForResource(manifest, resKey) {
    const producers = [];
    for (const [name, meta] of Object.entries(manifest?.entities || {})) {
        if (!meta || !meta.yields) continue;
        const yieldAmt = meta.yields[resKey] || 0;
        if (yieldAmt <= 0) continue;

        const costSum = meta.spawnCost ? Object.values(meta.spawnCost).reduce((sum, v) => sum + v, 0) : 1;
        const efficiency = yieldAmt / (costSum || 1);
        producers.push({ name, meta, yieldAmt, efficiency });
    }
    producers.sort((a, b) => b.efficiency - a.efficiency);
    return producers;
}

/**
 * 1. CRITICAL DEFICIT STABILIZATION:
 * Fixes negative income or depleted resources. If resources are insufficient for the needed
 * build step, registers the needed amounts into reservedResources so proactive growth doesn't spend them.
 */
async function handleCriticalDeficits(player, gameState, manifest, myEntities, evalRes, reservedResources) {
    const urgentNeeds = [...evalRes.deficits, ...evalRes.lowStock];
    if (urgentNeeds.length === 0) return false;

    for (const need of urgentNeeds) {
        const producers = findProducersForResource(manifest, need.res);
        if (producers.length === 0) continue;

        aiLog(player, 'econ', `Addressing ${need.res} deficit (net: ${need.net}, stock: ${need.stock}/${need.target}). Candidate producers: [${producers.map(p => `${p.name}(+${p.yieldAmt})`).join(', ')}]`);

        for (const prod of producers) {
            const step = resolveProductionPath(player, gameState, prod.name, manifest, new Set());
            if (!step) continue;

            const builder = step.builderEntity;
            const target = step.targetName;
            const targetMeta = manifest.entities[target];
            const spawnCost = targetMeta?.spawnCost || {};

            // If we lack the spawn resources for this immediate step, record needed resources into reservedResources
            if (player.hasResources && !player.hasResources(spawnCost)) {
                for (const [resKey, amount] of Object.entries(spawnCost)) {
                    reservedResources[resKey] = Math.max(reservedResources[resKey] || 0, amount);
                }
                aiLog(player, 'econ', `Deficit resolution step ${target} via ${builder.name} at (${builder.q},${builder.r}) requires ${JSON.stringify(spawnCost)}. Reserving these resources from proactive spending.`);
                continue;
            }

            aiLog(player, 'build', `STABILIZE: Using ${builder.name} at (${builder.q},${builder.r}) to build ${camelToTitle(target)}${step.directTarget !== target ? ` (prerequisite for ${camelToTitle(step.directTarget)})` : ''} to resolve ${need.res} shortage.`);
            const ordersUsed = build(gameState, builder, target);
            if (ordersUsed > 0) {
                return true;
            }
        }
    }

    // TODO: Implement entity scrapping here if resource deficits cannot be stabilized via building
    // and inactive units are draining maintenance or blocking critical recovery.

    return false;
}

/**
 * 2. COMBAT & THREAT RESPONSE:
 * Detects visible opponents strictly via player.getOpponents(gameState) and attackers in entity.attackHistory.
 * Engages with dedicated military units with extensive diagnostic logging.
 */
async function handleCombatAndThreats(player, gameState, manifest, myEntities) {
    // A. Detect visible opponent entities strictly via player.getOpponents(gameState) (Guideline 19)
    const opponents = player.getOpponents ? player.getOpponents(gameState) : {};
    const visibleOpponents = [];
    for (const opp of Object.values(opponents || {})) {
        if (Array.isArray(opp.entities)) {
            for (const enemy of opp.entities) {
                if (enemy && !enemy.destroyed && enemy.health > 0) {
                    visibleOpponents.push(enemy);
                }
            }
        }
    }

    // B. Gather revenge targets from attack history of all our entities, filtered to currently visible opponents
    const revengeMap = new Map(); // attackerId -> { score, attackerName }
    const allOurEntities = player.getEntities ? player.getEntities(gameState) : myEntities;
    for (const e of allOurEntities) {
        if (!e.attackHistory) continue;
        for (const record of e.attackHistory) {
            if (!record || !record.attackerId) continue;
            const existing = revengeMap.get(record.attackerId) || { score: 0, attackerName: record.attackerName };
            existing.score += (record.damage || 0);
            revengeMap.set(record.attackerId, existing);
        }
    }

    const revengeTargets = [];
    for (const [attackerId, info] of revengeMap) {
        const liveEnemy = visibleOpponents.find(en => en.id === attackerId);
        if (liveEnemy) {
            revengeTargets.push({ entity: liveEnemy, damageDealt: info.score });
        }
    }
    revengeTargets.sort((a, b) => b.damageDealt - a.damageDealt);

    if (visibleOpponents.length === 0 && revengeTargets.length === 0) {
        return false;
    }

    aiLog(player, 'combat', `Threat Evaluation: ${visibleOpponents.length} visible opponent unit(s) detected via getOpponents(), ${revengeTargets.length} active revenge target(s). Opponents: [${visibleOpponents.map(h => `${h.name}#${h.id.slice(-4)} (${h.owner?.name || 'Enemy'}, HP:${Math.round(h.health)}/${h.maxHealth} at (${h.q},${h.r}))`).join('; ')}]`);

    // C. Identify all military-capable friendly units
    const combatCapable = getEntitiesByCapability(myEntities, 'combat');
    const dedicatedMilitary = getEntitiesSortedByPower(getEntitiesByCapability(combatCapable, 'military', manifest), manifest);

    aiLog(player, 'detail', `Combat Readiness: ${dedicatedMilitary.length} dedicated military unit(s) [${dedicatedMilitary.map(m => `${m.name}#${m.id.slice(-4)} (HP:${Math.round(m.health)}, AP:${m.actionPoints}/${m.maxActionPoints} at (${m.q},${m.r}))`).join(', ') || 'None'}], ${combatCapable.length} total combat-capable.`);

    // D. Priority 1: Retaliate against visible revenge targets
    if (revengeTargets.length > 0) {
        const topRevenge = revengeTargets[0];
        const warriors = dedicatedMilitary.length > 0 ? dedicatedMilitary : combatCapable.filter(e => !isBuilder(e));

        for (const warrior of warriors) {
            if (warrior.actionPoints !== undefined && warrior.actionPoints <= 0) {
                aiLog(player, 'detail', `Retaliation skipped for ${warrior.name} at (${warrior.q},${warrior.r}): 0 AP remaining.`);
                continue;
            }

            aiLog(player, 'combat', `Retaliating: ${warrior.name} at (${warrior.q},${warrior.r}) engaging ${topRevenge.entity.name} at (${topRevenge.entity.q},${topRevenge.entity.r}) (Target dealt ${topRevenge.damageDealt.toFixed(0)} damage to us).`);
            const ordersUsed = attack(gameState, warrior, topRevenge.entity, player.orders);
            if (ordersUsed > 0) {
                aiLog(player, 'combat', `Retaliation attack executed by ${warrior.name}. Orders used: ${ordersUsed}.`);
                return true;
            } else {
                aiLog(player, 'detail', `Retaliation attack by ${warrior.name} against ${topRevenge.entity.name} used 0 orders (target out of reach or impassable terrain).`);
            }
        }
    }

    // E. Priority 2: Engage visible enemy threats
    if (visibleOpponents.length > 0) {
        const enemyMilitary = visibleOpponents.filter(e => isDedicatedMilitary(e, manifest));
        const targetPool = enemyMilitary.length > 0 ? enemyMilitary : visibleOpponents;

        if (dedicatedMilitary.length > 0) {
            for (const warrior of dedicatedMilitary) {
                if (warrior.actionPoints !== undefined && warrior.actionPoints <= 0) {
                    aiLog(player, 'detail', `Combat skipped for ${warrior.name} at (${warrior.q},${warrior.r}): 0 AP remaining.`);
                    continue;
                }

                // Pick closest enemy to this warrior
                const sortedTargets = [...targetPool].sort((a, b) => HexGrid.distance(warrior, a) - HexGrid.distance(warrior, b));
                for (const target of sortedTargets) {
                    const dist = HexGrid.distance(warrior, target);
                    aiLog(player, 'combat', `Tactical Strike: ${warrior.name} at (${warrior.q},${warrior.r}) targeting ${target.owner?.name || 'Enemy'}'s ${target.name} at (${target.q},${target.r}) (distance: ${dist}).`);
                    const ordersUsed = attack(gameState, warrior, target, player.orders);
                    if (ordersUsed > 0) {
                        aiLog(player, 'combat', `Tactical strike executed by ${warrior.name}. Orders used: ${ordersUsed}.`);
                        return true;
                    } else {
                        aiLog(player, 'detail', `Tactical strike by ${warrior.name} against ${target.name} used 0 orders (cannot reach or blocked). Trying next target.`);
                    }
                }
            }
        } else {
            // We have NO dedicated military units but visible threats exist!
            // Dynamically resolve production of military defender
            const militaryMetaRanked = Object.entries(manifest.entities)
                .filter(([_, meta]) => !meta.spawnConditions && (meta.score?.military >= 5 || meta.damage?.value >= 20))
                .sort((a, b) => getCombatPower(null, b[1]) - getCombatPower(null, a[1]));

            for (const [milName] of militaryMetaRanked) {
                const step = resolveProductionPath(player, gameState, milName, manifest, new Set());
                if (step) {
                    const builder = step.builderEntity;
                    const target = step.targetName;
                    const cost = manifest.entities[target]?.spawnCost || {};
                    if (player.hasResources && player.hasResources(cost)) {
                        aiLog(player, 'combat', `Threat Defense: Lack military to engage threats! Spawning military defender ${camelToTitle(target)} via ${builder.name} at (${builder.q},${builder.r}).`);
                        const ordersUsed = build(gameState, builder, target);
                        if (ordersUsed > 0) return true;
                    }
                }
            }

            // Emergency close-quarters defense if enemy is directly adjacent (distance <= 1)
            const adjacentThreats = visibleOpponents.filter(h => myEntities.some(my => HexGrid.distance(my, h) <= 1));
            if (adjacentThreats.length > 0) {
                const emergencyFighters = combatCapable.filter(e => e.actionPoints === undefined || e.actionPoints > 0);
                for (const fighter of emergencyFighters) {
                    const adj = adjacentThreats.find(h => HexGrid.distance(fighter, h) <= 1);
                    if (adj) {
                        aiLog(player, 'warn', `Emergency Defense: Adjacent enemy ${adj.name} at (${adj.q},${adj.r})! Fighting back with ${fighter.name} at (${fighter.q},${fighter.r}).`);
                        const ordersUsed = attack(gameState, fighter, adj, player.orders);
                        if (ordersUsed > 0) return true;
                    }
                }
            }
        }
    }

    return false;
}

/**
 * 3. MAINTENANCE & REPAIR:
 * Repairs heavily damaged friendly structures/units (<50% HP).
 */
async function handleHeavyRepairs(player, gameState, myEntities) {
    const heavilyDamaged = myEntities.filter(e => e.active && e.health < (e.maxHealth * 0.5));
    if (heavilyDamaged.length === 0) return false;

    const repairers = myEntities.filter(e => e.active && isRepairer(e) && (e.actionPoints === undefined || e.actionPoints > 0));
    if (repairers.length === 0) return false;

    heavilyDamaged.sort((a, b) => (a.health / a.maxHealth) - (b.health / b.maxHealth));

    for (const repairer of repairers) {
        for (const target of heavilyDamaged) {
            aiLog(player, 'build', `Repairing critical damage: ${repairer.name} at (${repairer.q},${repairer.r}) restoring ${target.name} at (${target.q},${target.r}) (HP: ${Math.round(target.health)}/${target.maxHealth})`);
            const ordersUsed = repair(gameState, repairer, target, player.orders);
            if (ordersUsed > 0) return true;
        }
    }

    return false;
}

/**
 * 4. PROACTIVE GROWTH & SCORE EXPANSION:
 * Uses surplus resources to build new constructs, mobile units, settlements, and economy.
 * Respects reservedResources to prevent starving pending deficit remedies.
 */
async function handleProactiveGrowth(player, gameState, manifest, myEntities, evalRes, reservedResources) {
    const stock = player.resources || {};
    const profile = evalRes.profile;

    const buildCandidates = [];
    for (const builder of myEntities) {
        if (!builder.active || !isBuilder(builder)) continue;
        const buildables = builder.state?.buildables || builder.data?.buildables || [];
        for (const targetName of buildables) {
            buildCandidates.push({ builder, targetName });
        }
    }

    if (buildCandidates.length === 0) return false;

    let bestCandidate = null;
    let bestScore = -1;

    for (const cand of buildCandidates) {
        const meta = manifest.entities[cand.targetName];
        if (!meta) continue;

        const spawnCost = meta.spawnCost || {};
        if (player.hasResources && !player.hasResources(spawnCost)) continue;

        // Check if building this candidate would spend resources reserved for pending deficit resolution
        let violatesReservation = false;
        for (const [resKey, reservedAmt] of Object.entries(reservedResources)) {
            const currentStock = stock[resKey] || 0;
            const costAmt = spawnCost[resKey] || 0;
            if (currentStock - costAmt < reservedAmt) {
                violatesReservation = true;
                break;
            }
        }
        if (violatesReservation) {
            aiLog(player, 'detail', `Skipping proactive build of ${cand.targetName}: would spend reserved ${JSON.stringify(reservedResources)} needed for deficit recovery.`);
            continue;
        }

        // Check maintenance sustainability (ensure building this will not cause an unrecoverable deficit)
        let canMaintain = true;
        for (const [res, amt] of Object.entries(meta.maintenance || {})) {
            const projectedNet = (profile.netIncome[res] || 0) - amt;
            const currentStock = stock[res] || 0;
            if (projectedNet < 0 && currentStock < Math.abs(projectedNet) * 5) {
                canMaintain = false;
                break;
            }
        }
        if (!canMaintain) continue;

        // Calculate score value & utility
        const milScore = meta.score?.military || 0;
        const ecoScore = meta.score?.economic || 0;
        const isSettlement = meta.spawnConditions?.minSeparation >= 3 || (meta.yields?.orders || 0) > 0;
        const yieldsOrders = (meta.yields?.orders || 0) > 0;
        const combatVal = meta.damage?.value || 0;

        let resourceUtility = 0;
        for (const [res, yieldAmt] of Object.entries(meta.yields || {})) {
            if (res === 'orders') continue;
            const net = profile.netIncome[res] || 0;
            const currentStock = stock[res] || 0;
            const target = evalRes.targets[res] || 30;

            if (net < 5 || currentStock < target) {
                resourceUtility += yieldAmt * 4.0;
            } else if (currentStock < target * 3) {
                resourceUtility += yieldAmt * 1.5;
            } else {
                resourceUtility += yieldAmt * 0.2;
            }
        }

        const costSum = Object.values(spawnCost).reduce((sum, v) => sum + v, 0) || 1;
        let totalWeight = (milScore * 8) + (ecoScore * 6) + (resourceUtility * 5) + (combatVal * 0.5);
        if (isSettlement) totalWeight += 35;
        if (yieldsOrders) totalWeight += 40;

        const roi = totalWeight / costSum;
        if (roi > bestScore) {
            bestScore = roi;
            bestCandidate = { ...cand, meta, roi };
        }
    }

    if (bestCandidate) {
        const { builder, targetName, roi } = bestCandidate;
        aiLog(player, 'build', `Proactive Expansion: ${builder.name} at (${builder.q},${builder.r}) building ${camelToTitle(targetName)} (ROI: ${roi.toFixed(2)}).`);
        const ordersUsed = build(gameState, builder, targetName);
        if (ordersUsed > 0) return true;
    }

    return false;
}

/**
 * 5. FOG-OF-WAR EXPLORATION:
 * Finds closest unexplored cell on the map and moves towards it using as many actions
 * as possible in a single order. Does NOT require reaching the cell in the same turn.
 * Strictly excludes any builder units.
 */
async function handleExploration(player, gameState, manifest, myEntities, targetedCells) {
    // Strictly filter out builder units, constructs, inactive units, or units with 0 AP
    const explorers = myEntities.filter(e => {
        if (!e.active || !isMobile(e)) return false;
        if (isBuilder(e)) return false;
        if (e.actionPoints !== undefined && e.actionPoints <= 0) return false;
        return true;
    });

    if (explorers.length === 0) return false;

    // Prioritize units with high action points and sight range
    explorers.sort((a, b) => {
        const scoreA = (a.actionPoints || 0) * 10 + (a.sightRange || 2) * 5;
        const scoreB = (b.actionPoints || 0) * 10 + (b.sightRange || 2) * 5;
        return scoreB - scoreA;
    });

    for (const explorer of explorers) {
        const moveAction = explorer.getActions().find(a => a.name === "Move");
        if (!moveAction) continue;

        const pathResult = findPathTowardsUnexplored(explorer, gameState, player, targetedCells);
        if (!pathResult || pathResult.fullyExplored) {
            aiLog(player, 'explore', `All map territory is fully explored.`);
            return false;
        }

        const { targetCell, path, arrivedAtBestReachable } = pathResult;

        if (arrivedAtBestReachable || !path || path.length === 0) {
            aiLog(player, 'detail', `Explorer ${explorer.name} at (${explorer.q},${explorer.r}): Positioned at frontier overlooking unexplored regions.`);
            continue;
        }

        const destKey = `${targetCell.q},${targetCell.r}`;
        const ordersUsed = moveAlongPath(
            player,
            explorer,
            moveAction,
            path,
            gameState,
            'explore',
            `towards unexplored cell (${targetCell.q},${targetCell.r})`
        );

        if (ordersUsed > 0) {
            targetedCells.add(destKey);
            return true;
        }
    }

    return false;
}

/**
 * Main turn processing entrypoint.
 * Executes orders sequentially until exhausted or no valid actions remain.
 * 
 * @param {Player} player 
 * @param {GameState} gameState 
 */
export async function processTurn(player, gameState) {
    if (!player || player.orders <= 0) return;

    const manifest = gameState?.manifestData;
    if (!manifest || !manifest.entities) return;

    aiLog(player, 'turn', `=== Turn Start (Round ${gameState.currentRound || 1}) | Orders: ${player.orders}/${player.maxOrders} | Military: ${player.score?.military || 0}, Econ: ${player.score?.economic || 0}, Expl: ${player.score?.exploration || 0} ===`);

    const targetedExplorationCells = new Set();
    const reservedResources = {}; // Tracks resources needed by pending critical deficit remedies
    let maxIterations = Math.max(player.orders * 2, 20);
    let actionExecuted = true;

    while (player.orders > 0 && maxIterations-- > 0 && actionExecuted) {
        actionExecuted = false;

        const myEntities = player.getEntities ? player.getEntities(gameState).filter(e => e.active) : [];
        if (myEntities.length === 0) {
            aiLog(player, 'warn', `No active entities available to perform actions.`);
            break;
        }

        const evalRes = evaluateResources(player, gameState);

        // 1. Critical Deficit Recovery (Stabilize negative burn before units starve, reserving scarce resources)
        if (await handleCriticalDeficits(player, gameState, manifest, myEntities, evalRes, reservedResources)) {
            actionExecuted = true;
            await onActionDone(gameState);
            continue;
        }

        // 2. Combat & Defense (Retaliate against attackers and eliminate immediate threats)
        if (await handleCombatAndThreats(player, gameState, manifest, myEntities)) {
            actionExecuted = true;
            await onActionDone(gameState);
            continue;
        }

        // 3. Heavy Repairs (Restore heavily damaged constructs/units < 50% HP)
        if (await handleHeavyRepairs(player, gameState, myEntities)) {
            actionExecuted = true;
            await onActionDone(gameState);
            continue;
        }

        // 4. Proactive Growth (Expand economy, settlements, units using surplus resources; respects reservedResources)
        if (await handleProactiveGrowth(player, gameState, manifest, myEntities, evalRes, reservedResources)) {
            actionExecuted = true;
            await onActionDone(gameState);
            continue;
        }

        // 5. Exploration (Scout closest unexplored hexes using BFS and multi-step moves; strictly excludes builders)
        if (await handleExploration(player, gameState, manifest, myEntities, targetedExplorationCells)) {
            actionExecuted = true;
            await onActionDone(gameState);
            continue;
        }
    }

    aiLog(player, 'turn', `=== Turn Ended | Remaining Orders: ${player.orders} ===`);
}
