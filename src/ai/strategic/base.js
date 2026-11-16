/**
 * StrategicBaseManager (Phase 26)
 * Abstract base class for strategic AI controllers — the "king" to the
 * tactical AI's "general". A strategic manager runs once per turn, before
 * the tactical manager, and owns empire direction + diplomacy: it chats,
 * trades, and produces the directive the tactical AI obeys.
 *
 * Unlike the tactical side, a strategic manager is never asked to run
 * processTurn() — Player.step() calls runStrategicTurn() instead, and the
 * returned directive (or null) is stored on player.controller.directive by
 * the engine. The manager returns the directive rather than writing it:
 * the AI proxy is read-only, so a manager cannot write to the player.
 *
 * this.controller points at the STRATEGIC controller (player.strategicController),
 * not the tactical one — BaseManager points it at player.controller, which
 * is the tactical controller. That way config/key reads (LLM client settings,
 * the setBy stamp) use the strategic entry.
 */
import { BaseManager } from '../baseManager.js';

export class StrategicBaseManager extends BaseManager {
    constructor(player, helper) {
        super(player, helper);
        // The strategic controller is this manager's own controller.
        this.controller = player.strategicController || player.controller;
    }

    /**
     * Runs the strategic turn: chats, then the directive.
     * Must be implemented by subclasses.
     * @returns {Promise<Object|null>} the validated directive (stamped with
     *   setAtTurn/setBy), or null when there is none / it is invalid. The
     *   engine stores a non-null return on player.controller.directive; a
     *   null return keeps the last valid directive in place.
     */
    async runStrategicTurn() {
        throw new Error('runStrategicTurn() must be implemented by subclass');
    }
}

export default StrategicBaseManager;
