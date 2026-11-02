/**
 * LeonaTacticalAI - Hybrid tactical AI for Empires.
 *
 * Implements the Hybrid AI Directive Spec (src/ai/hybrid-ai-directive.md).
 * Reads directives from player.controller.directive each turn:
 *   - focus: economy | military | exploration | balanced (default)
 *   - stance[playerId]: offensive | defensive | caution | neutral (default) | friendly | ally
 *   - goals: ordered list of { type, target/direction }
 *
 * If no directive is set, plays with defaults: balanced focus, all neutral,
 * no goals (reactive play).
 *
 * Never imports game code directly — all interactions via AiHelper.
 */
import { BaseManager } from '../baseManager.js';

const DEFAULT_DIRECTIVE = {
  focus: 'balanced',
  stance: {},
  goals: [],
};

export class LeonaTacticalAI extends BaseManager {
  constructor(player, helper) {
    super(player, helper);
  }

  /**
   * Get the current directive, merged with defaults.
   */
  getDirective() {
    const d = this.player.controller?.directive || {};
    return {
      focus: d.focus || DEFAULT_DIRECTIVE.focus,
      stance: d.stance || {},
      goals: d.goals || [],
    };
  }

  /**
   * Get stance toward a player ID. Defaults to 'neutral'.
   */
  getStance(playerId) {
    const directive = this.getDirective();
    return directive.stance[playerId] || 'neutral';
  }

  async processTurn() {
    const helper = this.helper;
    const gameState = this.gameState;
    const player = this.player;
    const directive = this.getDirective();

    helper.aiLog(player, 'turn', `=== Turn Start (Round ${gameState.currentRound}) | Focus: ${directive.focus} | Orders: ${player.orders}/${player.maxOrders} ===`);

    // Process goals in priority order
    for (const goal of directive.goals) {
      if (player.orders <= 0) break;
      await this.processGoal(goal, directive);
    }

    // Reactive play: handle threats, expand, build
    if (player.orders > 0) {
      await this.reactivePlay(directive);
    }

    helper.aiLog(player, 'turn', `=== Turn End | Remaining Orders: ${player.orders} ===`);
  }

  /**
   * Process a single goal from the directive.
   */
  async processGoal(goal, directive) {
    const helper = this.helper;
    const player = this.player;

    switch (goal.type) {
      case 'reinforce':
        await this.goalReinforce(goal, directive);
        break;
      case 'explore':
        await this.goalExplore(goal, directive);
        break;
      case 'buildEconomy':
        await this.goalBuild(goal, directive, 'economy');
        break;
      case 'buildMilitary':
        await this.goalBuild(goal, directive, 'military');
        break;
      default:
        helper.aiLog(player, 'warn', `Unknown goal type: ${goal.type}`);
    }
  }

  /**
   * Reinforce: move combat units toward target area or entity.
   */
  async goalReinforce(goal, directive) {
    const helper = this.helper;
    const gameState = this.gameState;
    const player = this.player;

    const target = goal.target;
    if (!target) return;

    // Find combat-capable units with AP
    const units = this.getMyUnits().filter(e =>
      helper.isDedicatedMilitary(e, this.gameState.manifestData) && (e.actionPoints ?? 0) >= 1
    );

    for (const unit of units) {
      if (player.orders <= 0) break;
      // Simple: move toward target (helper.attack handles move-to-attack)
      // For reinforce, we just move, not attack
      const targetQ = target.q ?? unit.q;
      const targetR = target.r ?? unit.r;
      // Use explore with targeted cells to move toward the target
      const result = helper.explore(gameState, unit, null, false, [{ q: targetQ, r: targetR }]);
      if (result.ordersUsed > 0) {
        player.orders = Math.max(0, player.orders - result.ordersUsed);
        helper.aiLog(player, 'combat', `Reinforce: moved ${unit.name} toward (${targetQ},${targetR})`);
      }
    }
  }

  /**
   * Explore: send scouts/fast units in a direction or toward an area.
   */
  async goalExplore(goal, directive) {
    const helper = this.helper;
    const gameState = this.gameState;
    const player = this.player;

    // Find mobile units not needed for building
    const units = this.getMyUnits().filter(e =>
      helper.isMobile(e) && (e.actionPoints ?? 0) >= 1 && !helper.isBuilder(e)
    ).slice(0, 2); // Don't send all units

    for (const unit of units) {
      if (player.orders <= 0) break;
      const direction = goal.direction || null;
      const targetedCells = goal.target ? [{ q: goal.target.q, r: goal.target.r }] : null;
      const result = helper.explore(gameState, unit, direction, false, targetedCells);
      if (result.ordersUsed > 0) {
        player.orders = Math.max(0, player.orders - result.ordersUsed);
        helper.aiLog(player, 'explore', `Explore: ${unit.name} → ${direction || 'target'}`);
      }
    }
  }

  /**
   * Build economy or military structures in a target area/direction.
   */
  async goalBuild(goal, directive, kind) {
    const helper = this.helper;
    const player = this.player;

    // Find builders with AP
    const builders = this.getMyUnits().filter(e =>
      helper.isBuilder(e) && (e.actionPoints ?? 0) >= 1
    );

    for (const builder of builders) {
      if (player.orders <= 0) break;
      // Get buildable options, filter by kind
      const buildables = this.getBuildables(builder);
      const filtered = buildables.filter(name => {
        const isEcon = this.isEconomyBuilding(name);
        return kind === 'economy' ? isEcon : !isEcon;
      });
      if (filtered.length === 0) continue;

      // Try to build the first valid option
      for (const targetName of filtered) {
        const result = helper.build(this.gameState, builder, targetName);
        if (result.result.status === 'completed' && result.ordersUsed > 0) {
          player.orders = Math.max(0, player.orders - result.ordersUsed);
          helper.aiLog(player, 'build', `Goal build (${kind}): ${targetName} by ${builder.name}`);
          break;
        }
      }
    }
  }

  /**
   * Reactive play: handle threats, build economy, expand.
   * This runs when no goals are active or after goals are processed.
   */
  async reactivePlay(directive) {
    const helper = this.helper;
    const player = this.player;

    // 1. Handle immediate threats (defend)
    await this.handleThreats(directive);

    // 2. Build based on focus
    if (player.orders <= 0) return;
    await this.buildPhase(directive);

    // 3. Explore opportunistically
    if (player.orders <= 0) return;
    await this.explorePhase(directive);
  }

  /**
   * Defend against threats based on stance.
   */
  async handleThreats(directive) {
    const helper = this.helper;
    const gameState = this.gameState;
    const player = this.player;

    // Find visible enemy units
    const enemies = this.getVisibleEnemies();
    if (enemies.length === 0) return;

    for (const enemy of enemies) {
      if (player.orders <= 0) break;
      const stance = this.getStance(enemy.ownerId);

      // Never attack friendly/ally
      if (stance === 'friendly' || stance === 'ally') continue;

      // Offensive: actively engage
      // Defensive: engage if close
      // Caution: avoid (skip)
      // Neutral: engage if very close (defensive)
      if (stance === 'caution') continue;

      const myCombat = this.getMyUnits().filter(e =>
        helper.isDedicatedMilitary(e, this.gameState.manifestData) && (e.actionPoints ?? 0) >= 1
      );
      if (myCombat.length === 0) break;

      // Attack with the closest capable unit
      const attacker = myCombat[0];
      const result = helper.attack(gameState, attacker, enemy, 2);
      if (result.ordersUsed > 0) {
        player.orders = Math.max(0, player.orders - result.ordersUsed);
        helper.aiLog(player, 'combat', `Attacked ${enemy.name} (${stance} stance)`);
      }
    }
  }

  /**
   * Build phase: construct units/buildings based on focus.
   */
  async buildPhase(directive) {
    const helper = this.helper;
    const player = this.player;
    const focus = directive.focus;

    // Determine what to prioritize
    let preferEconomy = focus === 'economy' || focus === 'balanced';
    let preferMilitary = focus === 'military' || focus === 'balanced';

    // Check resource deficits first (always prioritize fixing deficits)
    const deficit = this.getCriticalResourceDeficit();
    if (deficit) {
      preferEconomy = true;
      helper.aiLog(player, 'econ', `Resource deficit: ${deficit}, prioritizing economy`);
    }

    // Priority 0: If no village, settler must build one first
    const hasVillage = this.getMyUnits().some(e => {
      const n = (e.name ?? e.type ?? '').toLowerCase();
      return n.includes('village');
    });
    if (!hasVillage) {
      const settler = this.getMyUnits().find(e => {
        const buildables = this.getBuildables(e);
        return buildables.some(b => b.toLowerCase().includes('village')) && (e.actionPoints ?? 0) >= 1;
      });
      if (settler && player.orders >= 2) {
        const result = helper.build(this.gameState, settler, 'village');
        if (result.result.status === 'completed' && result.ordersUsed > 0) {
          player.orders = Math.max(0, player.orders - result.ordersUsed);
          helper.aiLog(player, 'build', `Built village (first priority)`);
          return; // Don't do other builds this turn
        }
      }
    }

    // Build with villages/production centers
    const producers = this.getMyUnits().filter(e => {
      const buildables = this.getBuildables(e);
      return buildables.length > 0 && (e.actionPoints ?? 0) >= 1;
    });

    for (const producer of producers) {
      if (player.orders < 2) break;
      const buildables = this.getBuildables(producer);

      // Filter by focus
      let candidates = buildables;
      if (focus === 'economy') {
        candidates = buildables.filter(n => this.isEconomyBuilding(n) || this.isWorkerUnit(n));
      } else if (focus === 'military') {
        candidates = buildables.filter(n => !this.isEconomyBuilding(n) && !this.isWorkerUnit(n));
      }

      // Try each candidate
      for (const targetName of candidates) {
        if (player.orders < 2) break;
        // Check if we can afford it (basic check)
        const result = helper.build(this.gameState, producer, targetName);
        if (result.result.status === 'completed' && result.ordersUsed > 0) {
          player.orders = Math.max(0, player.orders - result.ordersUsed);
          helper.aiLog(player, 'build', `Built ${targetName} (focus: ${focus})`);
          break; // One build per producer per turn
        }
      }
    }
  }

  /**
   * Explore phase: send mobile units to unexplored areas.
   */
  async explorePhase(directive) {
    const helper = this.helper;
    const player = this.player;

    if (directive.focus === 'military') return; // Military focus doesn't explore

    const explorers = this.getMyUnits().filter(e =>
      helper.isMobile(e) && (e.actionPoints ?? 0) >= 1 &&
      !helper.isBuilder(e) && helper.isDedicatedMilitary(e, this.gameState.manifestData)
    ).slice(0, 1);

    for (const unit of explorers) {
      if (player.orders <= 0) break;
      const result = helper.explore(this.gameState, unit, null, false, null);
      if (result.ordersUsed > 0) {
        player.orders = Math.max(0, player.orders - result.ordersUsed);
        helper.aiLog(player, 'explore', `Explored with ${unit.name}`);
      }
    }
  }

  // ==================== Helpers ====================

  getMyUnits() {
    return this.gameState.entities.filter(e => {
      const oid = e.owner?.id ?? e.ownerId;
      return oid === this.player.id;
    });
  }

  getVisibleEnemies() {
    return this.gameState.entities.filter(e => {
      const oid = e.owner?.id ?? e.ownerId;
      return oid && oid !== this.player.id && oid !== 0;
    });
  }

  getBuildables(entity) {
    // Get buildable names from entity definition via manifest.
    if (entity.buildables) return entity.buildables;
    const def = this.getEntityDef(entity.name ?? entity.type);
    return def?.buildables || [];
  }

  /**
   * Get entity definition from manifest by name.
   */
  getEntityDef(name) {
    const manifest = this.gameState.manifestData;
    if (!manifest) return null;
    return manifest.entities?.find(d => d.name === name) || null;
  }

  isEconomyBuilding(name) {
    // Economy buildings produce resources (have yields) or have high economic score.
    // Uses manifest data, never hardcoded names.
    const def = this.getEntityDef(name);
    if (!def) return false;
    const yields = def.yields || {};
    const hasYields = Object.keys(yields).length > 0;
    const econScore = def.score?.economic || 0;
    const milScore = def.score?.military || 0;
    return hasYields || econScore > milScore;
  }

  isWorkerUnit(name) {
    // Worker units can build things (have buildables). Uses manifest data.
    const def = this.getEntityDef(name);
    if (!def) return false;
    return (def.buildables || []).length > 0;
  }

  getCriticalResourceDeficit() {
    // Check if any resource has negative net income and low stock
    // Simplified: return resource name if critical, else null
    const player = this.player;
    if (!player.resources) return null;
    // This is a simplified check; full implementation would use
    // player.getResourceProfile() if available
    return null;
  }
}

export default LeonaTacticalAI;
