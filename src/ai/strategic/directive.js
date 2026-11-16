/**
 * Directive validation (Phase 26) — pure functions, no imports.
 *
 * Shared by the LLM strategic harness, the dummy strategic AI, and tests,
 * so the "valid directive" rule lives in exactly one place. A directive is
 * {focus, stance, goals}; the harness stamps setAtTurn/setBy after
 * validation (see LlmStrategicManager.proposeDirective).
 *
 * Rules (design doc §4):
 * - focus, when present, must be one of the four values; absent → 'balanced'.
 * - stance keys must be real player ids (never the AI's own id); values must
 *   be in the enum. A bad key or value invalidates the whole directive.
 * - goals, when present, must be an array; each entry must be an object with
 *   a known type. A bad entry is dropped, not fatal — the rest still stands.
 * - Unknown extra top-level fields are dropped, not fatal.
 * - An empty directive ({} / null / non-object) is invalid: the caller keeps
 *   the last valid directive instead of writing nothing.
 *
 * @param {*} raw - the parsed directive candidate (usually from LLM JSON)
 * @param {Object} gameState - needs .players (for stance-key validation)
 * @param {number|string} [selfId] - the directing player's id (stance toward
 *   self is rejected when given)
 * @returns {Object|null} normalized {focus, stance, goals}, or null when invalid
 */
export const DIRECTIVE_FOCUS_VALUES = ['economy', 'military', 'exploration', 'balanced'];
export const DIRECTIVE_STANCE_VALUES = ['offensive', 'defensive', 'caution', 'neutral', 'friendly', 'ally'];
export const DIRECTIVE_GOAL_TYPES = ['reinforce', 'explore', 'buildEconomy', 'buildMilitary'];

export function validateDirective(raw, gameState, selfId = null) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    // Empty (no field at all) is not a directive — the caller keeps the last
    // valid one instead of writing an empty shell.
    if (raw.focus === undefined && raw.stance === undefined && raw.goals === undefined) return null;

    const focus = raw.focus === undefined ? 'balanced' : raw.focus;
    if (!DIRECTIVE_FOCUS_VALUES.includes(focus)) return null;

    const stance = {};
    if (raw.stance !== undefined) {
        if (!raw.stance || typeof raw.stance !== 'object' || Array.isArray(raw.stance)) return null;
        const players = gameState?.players || [];
        for (const [id, value] of Object.entries(raw.stance)) {
            if (!DIRECTIVE_STANCE_VALUES.includes(value)) return null;
            const target = players.find(p => String(p.id) === String(id));
            if (!target) return null;
            if (selfId != null && String(target.id) === String(selfId)) return null;
            stance[String(target.id)] = value;
        }
    }

    const goals = [];
    if (raw.goals !== undefined) {
        if (!Array.isArray(raw.goals)) return null;
        for (const g of raw.goals) {
            // A bad goal entry is dropped, not fatal — the remaining goals
            // (and the focus/stance) are still worth writing.
            if (!g || typeof g !== 'object' || !DIRECTIVE_GOAL_TYPES.includes(g.type)) continue;
            goals.push({ ...g });
        }
    }

    return { focus, stance, goals };
}
