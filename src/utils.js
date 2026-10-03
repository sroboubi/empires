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
export function calculateAttackMultiplier(gameState, sourceCell, elevationAdjustment, targetEntity) {
    const multiplier = { direction: 1.0, elevation: 1.0, total: 1.0 };

    if (gameState && gameState.hexGrid && targetEntity.facing) {
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

    multiplier.total = multiplier.direction * multiplier.elevation;
    return multiplier;
}