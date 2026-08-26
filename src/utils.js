export const DIRECTIONS_LIST = ['E', 'NE', 'NW', 'W', 'SW', 'SE'];

export const camelToTitle = (text) => {
    return text.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase()).trim();
};

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