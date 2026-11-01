/**
 * Menu interface for LLM players.
 *
 * The engine pre-computes every legal action as a numbered option; the LLM
 * only picks. This eliminates the free-form field failure class (empty
 * builderId/entityName, hallucinated targets) that the JSON command
 * interface suffered from, and it itemizes outputs for future decision
 * models. Probe evidence (2026-10-27..30): 18/18 validity across four local
 * models, ~1/3 the prompt tokens, working note field.
 *
 * All changes are contained to the harness layer (src/ai/llm/): movement
 * reuses existing engine primitives (findWalkablePath, moveAlongPath, the
 * unit "Move" action) — the same ones attack() already uses for staging.
 * No engine rules change.
 */
import { HexGrid, DIRECTIONS_8 } from '../../../hexGrid.js';
import {
    attack, support, build, explore,
    findWalkablePath, moveAlongPath, findReachableCells,
    isCombatCapable, isDedicatedMilitary, aiLog,
} from '../../utils.js';

function dist(a, b) {
    const ac = a.cell || a, bc = b.cell || b;
    return HexGrid.distance(ac, bc);
}

/** Short human-readable entity reference, e.g. "Red swordsman" / "your worker". */
function entLabel(e, player) {
    const own = e.owner && player && e.owner.id === player.id;
    const who = own ? 'your' : (e.owner?.name ? `${e.owner.name}'s` : 'a');
    return `${who} ${e.name}`;
}

function distLabel(d) {
    return d <= 1 ? 'adjacent' : `${d} away`;
}

/**
 * Build the numbered option list for a player's turn.
 * @returns {{ options: Array<{n:number,label:string,action:Object}> }}
 * action is machine-readable: { verb, actorId, targetId?, itemName?, direction?, playerName? }
 */
export function buildMenu(gameState, player, cfg = {}) {
    const X_ATK = cfg.attackTargets ?? 5;
    const Y_ATK = cfg.attackOrders ?? 3;
    const X_REP = cfg.repairTargets ?? 5;
    const Y_REP = cfg.repairOrders ?? 3;
    const X_MOV = cfg.moveTargets ?? 3;

    const options = [];
    const push = (label, action) => {
        options.push({ n: options.length + 1, label, action });
    };

    // 0 orders: the only legal action is ending the turn (probe v2).
    if ((player.orders ?? 0) <= 0) {
        push('End turn', { verb: 'end', actorId: null });
        return { options };
    }

    const allEntities = gameState.entities || [];
    const opponentIds = new Set(
        (typeof player.getOpponents === 'function'
            ? Object.values(player.getOpponents(gameState))
            : []).map(o => o.id)
    );
    const manifest = gameState.manifestData?.entities || gameState.manifestData || {};
    const manifestList = Array.isArray(manifest) ? manifest : Object.values(manifest);
    const myEntities = typeof player.getEntities === 'function'
        ? player.getEntities(gameState)
        : allEntities.filter(e => e.owner && e.owner.id === player.id);

    const visibleEnemies = allEntities.filter(e =>
        !e.destroyed && e.cell &&
        e.owner && opponentIds.has(e.owner.id) &&
        (typeof player.isVisible !== 'function' || player.isVisible(e.q, e.r))
    );

    const attackRangeOf = (unit) => {
        const a = unit.getActions ? unit.getActions().find(x => x.name === 'Attack') : null;
        return a?.range?.maxCells ?? 1;
    };
    // One order of movement ≈ up to maxAP hexes (moveAlongPath spends the AP
    // budget per call, one call per order). Hex distance is a lower bound on
    // movement cost, so this filter is generous by design — the engine does
    // the real staging and reports failure if unreachable.
    const withinOrders = (unit, target, range, orders) => {
        const maxAP = unit.maxActionPoints ?? unit.actionPoints ?? 1;
        return dist(unit, target) <= range + orders * maxAP;
    };

    for (const unit of myEntities) {
        if (unit.destroyed || !unit.cell) continue;
        if ((unit.actionPoints ?? 0) < 1) continue; // exhausted units get no options
        const def = manifestList.find(m => m.name === unit.name);

        // Attack: X closest visible enemies attackable within Y orders.
        if (isCombatCapable(unit)) {
            const range = attackRangeOf(unit);
            const cands = visibleEnemies
                .filter(e => withinOrders(unit, e, range, Y_ATK))
                .sort((a, b) => dist(unit, a) - dist(unit, b))
                .slice(0, X_ATK);
            for (const t of cands) {
                const d = dist(unit, t);
                push(`Attack ${entLabel(t, player)} (${distLabel(d)}) with ${entLabel(unit, player)}`,
                    { verb: 'attack', actorId: unit.id, targetId: t.id });
            }
        }

        // Build: everything buildable now (affordable + valid site), same
        // source as the prompt's "Can build now".
        const buildables = def?.buildables || [];
        for (const item of buildables) {
            const bDef = manifestList.find(m => m.name === item);
            const cost = bDef?.spawnCost || {};
            const affordable = Object.entries(cost).every(([res, amt]) =>
                !(amt > 0) || (player.resources?.[res] || 0) >= amt);
            if (!affordable) continue;
            push(`Build ${item} with ${entLabel(unit, player)}`,
                { verb: 'build', actorId: unit.id, itemName: item });
        }

        // Repair: X closest damaged repairables (own + allies', never enemies)
        // within Y orders.
        const repairables = def?.repairables || [];
        if (repairables.length) {
            const damaged = allEntities.filter(e => {
                if (e.destroyed || !e.cell || e.id === unit.id) return false;
                if (!repairables.includes(e.name)) return false;
                if (e.health === undefined || e.maxHealth === undefined || e.health >= e.maxHealth) return false;
                if (e.owner && opponentIds.has(e.owner.id)) return false;
                if (typeof player.isVisible === 'function' && !player.isVisible(e.q, e.r)) return false;
                return withinOrders(unit, e, 1, Y_REP);
            })
                .sort((a, b) => dist(unit, a) - dist(unit, b))
                .slice(0, X_REP);
            for (const t of damaged) {
                push(`Repair ${entLabel(t, player)} (${Math.round(t.health)}/${t.maxHealth} HP) with ${entLabel(unit, player)}`,
                    { verb: 'repair', actorId: unit.id, targetId: t.id });
            }
        }

        // Explore: units that can explore.
        const hasExplore = unit.getActions
            ? unit.getActions().some(a => a.name === 'Explore')
            : false;
        if (hasExplore) {
            push(`Explore with ${entLabel(unit, player)}`,
                { verb: 'explore', actorId: unit.id });
        }

        // Move towards: X closest targets (friendly or enemy) + 8 compass
        // directions. The direction move is the escape hatch for distant
        // fronts: reposition this turn, attack/repair next turn.
        if (isDedicatedMilitary(unit, manifest) || isCombatCapable(unit)) {
            const others = allEntities.filter(e =>
                !e.destroyed && e.cell && e.id !== unit.id &&
                (typeof player.isVisible !== 'function' || player.isVisible(e.q, e.r)));
            const cands = others
                .sort((a, b) => dist(unit, a) - dist(unit, b))
                .slice(0, X_MOV);
            for (const t of cands) {
                const d = dist(unit, t);
                if (d === 0) continue;
                push(`Move ${entLabel(unit, player)} towards ${entLabel(t, player)} (${distLabel(d)})`,
                    { verb: 'move', actorId: unit.id, targetId: t.id });
            }
            for (const dir of DIRECTIONS_8) {
                push(`Move ${entLabel(unit, player)} ${dir}`,
                    { verb: 'move', actorId: unit.id, direction: dir });
            }
        }
    }

    // Chat: one per known opponent.
    const knownPlayers = (gameState.players || []).filter(p => p.id !== player.id);
    for (const p of knownPlayers) {
        push(`Chat with ${p.name}`, { verb: 'chat', actorId: null, playerName: p.name });
    }

    push('End turn', { verb: 'end', actorId: null });

    // Disambiguate identical labels (two identical units) with an id suffix.
    const labelCounts = new Map();
    for (const o of options) labelCounts.set(o.label, (labelCounts.get(o.label) || 0) + 1);
    for (const o of options) {
        if ((labelCounts.get(o.label) || 0) > 1) {
            const ent = o.action.actorId ? findEntity(gameState, o.action.actorId) : null;
            const suffix = ent ? `#${String(ent.id).slice(-4)}` : '';
            o.label = `${o.label}${suffix ? ' ' + suffix : ''}`;
        }
    }

    return { options };
}

function findEntity(gameState, id) {
    return (gameState.entities || []).find(e => e.id === id)
        || gameState.getEntityById?.(id) || null;
}

/**
 * Move a unit toward a target entity/cell or a compass direction.
 * Uses existing engine movement primitives only.
 */
function moveUnitToward(gameState, player, unit, dest) {
    const fail = (message) => ({ ordersUsed: 0, result: { status: 'failed', message } });
    const actions = unit.getActions ? unit.getActions() : [];
    const moveAction = actions.find(a => a.name === 'Move');
    if (!moveAction) return fail(`${entLabel(unit, player)} cannot move.`);

    let path = null;
    if (dest.direction) {
        // Best reachable cell in the requested compass direction.
        const reachable = findReachableCells(gameState, unit);
        let best = null, bestScore = -1;
        for (const { cell, path: p } of reachable.values()) {
            if (!p || p.length === 0) continue;
            const dir = gameState.hexGrid?.directionTo?.(unit.cell, cell, true)?.fromSource
                || gameState.hexGrid?.directionTo?.(unit.cell, cell);
            const dirName = typeof dir === 'string' ? dir : dir?.name;
            if (dirName !== dest.direction) continue;
            if (p.length > bestScore) { bestScore = p.length; best = p; }
        }
        if (!best) return fail(`No reachable cell ${dest.direction} of ${entLabel(unit, player)}.`);
        path = best;
    } else {
        const target = dest.targetId ? findEntity(gameState, dest.targetId) : null;
        const coord = target?.cell || dest;
        if (coord.q === undefined) return fail('Move target has no position.');
        if (unit.q === coord.q && unit.r === coord.r) return fail(`${entLabel(unit, player)} is already there.`);
        path = findWalkablePath(gameState, unit, coord);
        if (!path || path.length === 0) return fail(`No walkable path toward target.`);
    }

    const moved = moveAlongPath(player, unit, moveAction, path, gameState, 'move',
        `menu move for ${player.name}`);
    if (!moved) return fail(`Could not move ${entLabel(unit, player)}.`);
    aiLog(player, 'move', `Menu: moved ${entLabel(unit, player)}.`);
    return { ordersUsed: 1, result: { status: 'completed', message: `Moved ${entLabel(unit, player)}.` } };
}

/**
 * Execute a menu action. Same {ordersUsed, result} shape as the utils in
 * ../utils.js. Chat and end-turn are handled by the harness (they need the
 * harness's chat flow / history wiring).
 */
export function executeMenuAction(gameState, player, action) {
    const fail = (message) => ({ ordersUsed: 0, result: { status: 'failed', message } });
    const unit = action.actorId ? findEntity(gameState, action.actorId) : null;
    if (action.verb !== 'end' && action.verb !== 'chat') {
        if (!unit) return fail(`Actor entity not found: ${action.actorId}`);
        if (unit.owner?.id !== player.id) return fail(`Entity ${action.actorId} does not belong to you`);
    }
    const maxOrders = player.orders ?? 0;
    switch (action.verb) {
        case 'attack': {
            const target = findEntity(gameState, action.targetId);
            if (!target) return fail(`Target entity not found: ${action.targetId}`);
            return attack(gameState, unit, target, maxOrders);
        }
        case 'repair': {
            const target = findEntity(gameState, action.targetId);
            if (!target) return fail(`Target entity not found: ${action.targetId}`);
            return support(gameState, unit, target, 'Repair', maxOrders);
        }
        case 'build':
            return build(gameState, unit, action.itemName);
        case 'explore':
            return explore(gameState, unit, null, true);
        case 'move':
            return moveUnitToward(gameState, player, unit, action);
        default:
            return fail(`Unknown menu verb: ${action.verb}`);
    }
}

/** Append the numbered option list to the state markdown. */
export function renderMenuPrompt(stateMarkdown, options) {
    const lines = options.map(o => `${o.n}. ${o.label}`);
    return `${stateMarkdown}\n\n### Available actions\n` +
        `Pick exactly one numbered option per response. These are the ONLY actions available — do not invent others.\n` +
        lines.join('\n');
}

/**
 * Parse a menu response. Accepts a JSON object {thoughtProcess, option, note}
 * where option is a number or the exact option label text (tolerance for
 * models that echo the label instead of the number, observed on Phi-4).
 */
export function parseMenuResponse(rawText, options) {
    let text = String(rawText ?? '').trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        return { error: `Response is not valid JSON: ${e.message}` };
    }
    const thoughtProcess = data.thoughtProcess ?? '';
    const note = data.note ?? '';
    let n = null;
    const opt = data.option;
    if (typeof opt === 'number' && Number.isInteger(opt)) {
        n = opt;
    } else if (typeof opt === 'string') {
        const t = opt.trim();
        if (/^\d+$/.test(t)) {
            n = parseInt(t, 10);
        } else {
            const idx = options.findIndex(o => o.label.toLowerCase() === t.toLowerCase());
            if (idx >= 0) n = idx + 1;
        }
    }
    if (!n || n < 1 || n > options.length) {
        return { error: `Option must be a number from 1 to ${options.length}.` };
    }
    return { thoughtProcess, note, n, action: options[n - 1].action, label: options[n - 1].label };
}
