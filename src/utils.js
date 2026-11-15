export const DIRECTIONS_LIST = ['E', 'NE', 'NW', 'W', 'SW', 'SE'];

/**
 * Rounds a number to 1 decimal place for display purposes.
 * Does NOT modify the underlying value — use only in UI-facing strings.
 * @param {number} n
 * @returns {string}
 */
export const displayNum = (n) => {
    if (typeof n !== 'number' || !isFinite(n)) return String(n);
    return (Math.round(n * 10) / 10).toString();
};

export const camelToTitle = (text) => {
    return text.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase()).trim();
};

/**
 * Formats a resource bundle map (e.g. { iron: 50, gold: 10 }) to a
 * human-readable string. Pure helper: safe for both engine and AI use.
 * @param {Object} bundle
 * @returns {string}
 */
export function formatResourceBundle(bundle) {
    if (!bundle) return 'nothing';
    const parts = [];
    for (const [res, amt] of Object.entries(bundle)) {
        if (amt > 0) {
            parts.push(`${amt} ${res}`);
        }
    }
    return parts.length > 0 ? parts.join(', ') : 'nothing';
}

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function showToast(message, isError = false, timeout = 2500) {
    const container = document.getElementById('toast-container');
    if (!container) {
        if (isError) console.error(`Toast: ${message}`);
        else console.log(`Toast: ${message}`);
        return;
    }

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toast.style.background = isError ? '#e74c3c' : '#2ecc71';
    container.appendChild(toast);

    // Trigger reflow so the transition plays from the initial state
    toast.getBoundingClientRect();
    toast.classList.add('show');

    setTimeout(() => {
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    }, timeout);
}

/**
 * Calculates the directional and elevation damage multiplier from an attacker against a target entity.
 */
/**
 * Attack multiplier for a combat action: positional (direction, elevation)
 * times the attacker's leader-twist factor (damage type, damageVs against
 * the target, terrain the attacker stands on). The twist factor comes from
 * the attacking player's getAttackValue, so the engine and the AI see the
 * same multiplier — this is the single place the two agree.
 * @param {Object} gameState
 * @param {Object} sourceCell - the attacker's cell
 * @param {number} elevationAdjustment - the attacker's damage elevationAdjustment
 * @param {Object} targetEntity - the entity being attacked
 * @param {Object} [attackerEntity] - the attacking entity (has the damage
 *   and the owner whose twists apply). Optional for backward compatibility:
 *   when omitted the factor is 1 and the result is positional only.
 * @returns {{direction: number, elevation: number, total: number}}
 */
export function calculateAttackMultiplier(gameState, sourceCell, elevationAdjustment, targetEntity, attackerEntity) {
    const multiplier = { direction: 1.0, elevation: 1.0, total: 1.0 };

    // Directional damage only applies to things that can move (units).
    // Constructs have a facing but no movement — no front/side/back.
    if (gameState && gameState.hexGrid && targetEntity.facing && !targetEntity.isConstruct) {
        const dirFromTargetToAttacker = gameState.hexGrid.directionTo(targetEntity.cell, sourceCell).fromSource;
        const idxTarget = DIRECTIONS_LIST.indexOf(targetEntity.facing);
        const idxAttacker = DIRECTIONS_LIST.indexOf(dirFromTargetToAttacker);

        if (idxTarget !== -1 && idxAttacker !== -1) {
            let diff = Math.abs(idxTarget - idxAttacker);
            if (diff > 3) diff = 6 - diff;
            if (diff === 0) multiplier.direction = 1.0;        // Front
            else if (diff === 1 || diff === 2) multiplier.direction = 1.5;  // Side
            else if (diff === 3) multiplier.direction = 2.0;    // Behind
        }
    }

    if (typeof elevationAdjustment === 'number' && elevationAdjustment > 0) {
        const getElev = (c) => (c && c.terrain && (c.terrain.height ?? c.terrain.elevation)) ?? 1.0;
        const attackerElevation = Math.max(0.1, getElev(sourceCell));
        const targetElevation = Math.max(0.1, getElev(targetEntity.cell));
        const ratio = attackerElevation / targetElevation;
        if (ratio > 1.01) {
            multiplier.elevation = ratio * elevationAdjustment;
        } else if (ratio < 0.99) {
            multiplier.elevation = ratio / elevationAdjustment;
        }
    }

    // Leader twists (Phase 25): the attacker's damage-type, damageVs and
    // terrain multipliers, via the attacking player's getAttackValue — the
    // same number the AI gets when it asks. The factor is the adjusted
    // value over the raw damage value (exact, since getAttackValue is
    // defined as base x factor).
    let playerFactor = 1;
    if (attackerEntity?.owner?.getAttackValue && attackerEntity.damage?.value) {
        const adjusted = attackerEntity.owner.getAttackValue(attackerEntity.name, {
            targetType: targetEntity?.name,
            terrainType: attackerEntity.cell?.terrain?.name,
        });
        playerFactor = adjusted.value / attackerEntity.damage.value;
    }

    multiplier.total = multiplier.direction * multiplier.elevation * playerFactor;
    return multiplier;
}