import { BaseManager } from '../baseManager.js';

/**
 * EntityCentricAI - tactical AI using Shahin's entity-centric design.
 *
 * Each entity independently asks:
 *   1. What is the best thing I can do?
 *   2. How important is it? (0-10 scale)
 *
 * All candidates are ranked by importance, top N executed until orders run out.
 * Coordination emerges from ranking — no explicit threat→attacker assignment.
 *
 * Importance is modified by:
 * - Directive focus (economy/military/exploration) via multipliers
 * - Resource criticality (building producers for scarce resources)
 * - Immediate danger (fleeing, defending)
 */
export class EntityCentricAI extends BaseManager {
  constructor(player, helper) {
    super(player, helper);
    // Importance multipliers from directive focus
    this.focusMultipliers = {
      economy: { economy: 1.5, military: 0.8, exploration: 0.9 },
      military: { economy: 0.8, military: 1.5, exploration: 0.9 },
      exploration: { economy: 0.9, military: 0.8, exploration: 1.5 },
      balanced: { economy: 1.0, military: 1.0, exploration: 1.0 },
    };
  }

  getDirective() {
    const controller = this.player.controller || {};
    return controller.directive || { focus: 'balanced', stance: {}, goals: [] };
  }

  getStance(playerId) {
    const directive = this.getDirective();
    return directive.stance[playerId] || 'neutral';
  }

  async processTurn() {
    const helper = this.helper;
    const player = this.player;
    const gameState = this.gameState;

    if (!player || player.orders <= 0) return;

    const directive = this.getDirective();
    helper.aiLog(player, 'turn',
      `=== EntityCentric Turn Start (Round ${gameState.currentRound}) | Focus: ${directive.focus} | Orders: ${player.orders}/${player.maxOrders} ===`
    );

    // Main loop: generate candidates, execute best, repeat.
    // A failed candidate is skipped, not fatal: the next-best candidate is
    // tried in the same pass. Only when nothing in a full generation can
    // execute does the turn end (remaining orders convert via overflow).
    let iterations = 0;
    const maxIterations = Math.max(player.orders * 4, 40);

    while (player.orders > 0 && iterations++ < maxIterations) {
      const candidates = this.generateCandidates(directive);
      if (candidates.length === 0) break;

      // Sort by importance (descending)
      candidates.sort((a, b) => b.importance - a.importance);

      // Try candidates in order; execute the first that works, then
      // regenerate (state changed). A failed candidate is skipped —
      // one unaffordable build must not end the whole turn.
      let progressed = false;
      for (const candidate of candidates) {
        if (player.orders <= 0) break;
        const executed = await this.executeCandidate(candidate, directive);
        if (executed) {
          progressed = true;
          break;
        }
      }
      if (!progressed) break;
    }

    helper.aiLog(player, 'turn', `=== EntityCentric Turn End | Remaining Orders: ${player.orders} ===`);
  }

  /**
   * Generate candidate actions for all entities.
   * Each candidate: { entity, action, importance, description, data }
   */
  generateCandidates(directive) {
    const candidates = [];
    const myUnits = this.getMyUnits();

    for (const entity of myUnits) {
      if ((entity.actionPoints ?? 0) <= 0) continue;

      const entityCandidates = this.getEntityCandidates(entity, directive);
      candidates.push(...entityCandidates);
    }

    return candidates;
  }

  getMyUnits() {
    const gameState = this.gameState;
    const player = this.player;
    if (!gameState || !gameState.entities) return [];
    return gameState.entities.filter(e =>
      e && !e.destroyed && (e.ownerId === player.id || e.owner?.id === player.id)
    );
  }

  getEntityCandidates(entity, directive) {
    const name = (entity.name || '').toLowerCase();

    // Route by entity type
    if (this.isMilitary(entity)) {
      return this.getMilitaryCandidates(entity, directive);
    } else if (name.includes('worker')) {
      return this.getWorkerCandidates(entity, directive);
    } else if (name.includes('settler')) {
      return this.getSettlerCandidates(entity, directive);
    } else if (name.includes('scout')) {
      return this.getScoutCandidates(entity, directive);
    } else if (this.isBuilder(entity)) {
      // Villages and other builders
      return this.getBuilderCandidates(entity, directive);
    }

    return [];
  }

  isMilitary(entity) {
    return this.helper.isDedicatedMilitary(entity, this.gameState.manifestData);
  }

  isBuilder(entity) {
    return this.helper.isBuilder(entity);
  }

  getVisibleEnemies() {
    const groups = this.player.getOpponents ? this.player.getOpponents(this.gameState) : {};
    const enemies = [];
    for (const group of Object.values(groups || {})) {
      for (const e of group.entities || []) {
        if (e && !e.destroyed) enemies.push(e);
      }
    }
    return enemies;
  }

  applyFocusMultiplier(importance, category, directive) {
    const focus = directive.focus || 'balanced';
    const multipliers = this.focusMultipliers[focus] || this.focusMultipliers.balanced;
    return importance * (multipliers[category] || 1.0);
  }

  // ==================== Military candidates ====================

  getMilitaryCandidates(entity, directive) {
    const candidates = [];
    const helper = this.helper;
    const enemies = this.getVisibleEnemies();

    for (const enemy of enemies) {
      const stance = this.getStance(enemy.ownerId ?? enemy.owner?.id);
      if (stance === 'friendly' || stance === 'ally' || stance === 'caution') continue;

      const dist = helper.distance(
        { q: entity.q, r: entity.r },
        { q: enemy.q, r: enemy.r }
      );

      // Don't consider targets too far away
      if (dist > 15) continue;

      const myPower = helper.getCombatPower(entity) || 1;
      const enemyPower = helper.getCombatPower(enemy) || 1;

      // In neutral stance, only attack if favorable or very close
      if (stance === 'neutral') {
        if (dist > 8) continue;
        if (myPower < enemyPower * 1.5 && dist > 3) continue;
      }

      // Importance based on threat and odds
      let importance = 5;
      if (dist <= 3) importance = 8; // Immediate threat
      else if (myPower >= enemyPower * 2) importance = 7; // Easy kill
      else if (myPower >= enemyPower) importance = 6; // Favorable
      else importance = 4; // Risky

      // Boost if enemy is attacking our units (retaliation)
      // (Simplified: if enemy is close to our non-military units)
      const nearbyFriendly = this.getMyUnits().filter(u =>
        !this.isMilitary(u) &&
        helper.distance({ q: u.q, r: u.r }, { q: enemy.q, r: enemy.r }) <= 5
      );
      if (nearbyFriendly.length > 0) importance += 1;

      importance = this.applyFocusMultiplier(importance, 'military', directive);

      candidates.push({
        entity,
        action: 'attack',
        target: enemy,
        importance,
        description: `Attack ${enemy.name} (dist ${dist.toFixed(0)}, power ${myPower.toFixed(0)} vs ${enemyPower.toFixed(0)})`,
      });
    }

    // If no enemies, consider strategic positioning
    if (candidates.length === 0 && (entity.actionPoints ?? 0) >= 2) {
      candidates.push({
        entity,
        action: 'position',
        importance: this.applyFocusMultiplier(3, 'military', directive),
        description: `Move to strategic position`,
      });
    }

    return candidates;
  }

  // ==================== Worker candidates ====================

  getWorkerCandidates(entity, directive) {
    const candidates = [];
    const helper = this.helper;

    // Check for nearby threats — flee if in danger
    const enemies = this.getVisibleEnemies();
    const nearbyThreat = enemies.find(e => {
      const dist = helper.distance(
        { q: entity.q, r: entity.r },
        { q: e.q, r: e.r }
      );
      return dist <= 4;
    });

    if (nearbyThreat) {
      // Check if there's a friendly military nearby to protect us
      const protector = this.getMyUnits().find(u =>
        this.isMilitary(u) &&
        helper.distance({ q: u.q, r: u.r }, { q: entity.q, r: entity.r }) <= 6
      );

      if (!protector) {
        candidates.push({
          entity,
          action: 'flee',
          threat: nearbyThreat,
          importance: 9, // Saving a unit is critical
          description: `Flee from ${nearbyThreat.name}`,
        });
        return candidates; // Fleeing is top priority, don't consider other actions
      }
    }

    // Can build? Check buildables
    const buildables = this.getBuildables(entity);
    if (buildables.length > 0) {
      // Prioritize based on resource needs and directive
      for (const targetName of buildables.slice(0, 3)) { // Limit to 3 to avoid spam
        const isEcon = this.isEconomyBuilding(targetName);
        const category = isEcon ? 'economy' : 'military';

        let importance = isEcon ? 6 : 5;

        // Boost if we're critical on a resource this produces
        // (Simplified: check if any resource is low)
        const deficit = this.getCriticalResourceDeficit();
        if (deficit && isEcon) importance += 2;

        importance = this.applyFocusMultiplier(importance, category, directive);

        candidates.push({
          entity,
          action: 'build',
          targetName,
          importance,
          description: `Build ${targetName}`,
        });
      }
    }

    return candidates;
  }

  // ==================== Settler candidates ====================

  getSettlerCandidates(entity, directive) {
    const candidates = [];
    const helper = this.helper;

    // Flee from threats (same as worker)
    const enemies = this.getVisibleEnemies();
    const nearbyThreat = enemies.find(e =>
      helper.distance({ q: entity.q, r: entity.r }, { q: e.q, r: e.r }) <= 4
    );
    if (nearbyThreat) {
      candidates.push({
        entity,
        action: 'flee',
        threat: nearbyThreat,
        importance: 9,
        description: `Flee from ${nearbyThreat.name}`,
      });
      return candidates;
    }

    // Build village if we have fewer than 2
    const villageCount = this.getMyUnits().filter(e =>
      (e.name || '').toLowerCase().includes('village')
    ).length;

    if (villageCount < 2) {
      const buildables = this.getBuildables(entity);
      if (buildables.some(b => b.toLowerCase().includes('village'))) {
        candidates.push({
          entity,
          action: 'build',
          targetName: 'village',
          importance: this.applyFocusMultiplier(8, 'economy', directive),
          description: `Build village ${villageCount + 1}/2`,
        });
      }
    }

    return candidates;
  }

  // ==================== Scout candidates ====================

  getScoutCandidates(entity, directive) {
    const candidates = [];
    const helper = this.helper;

    // Flee from threats (scouts are fragile)
    const enemies = this.getVisibleEnemies();
    const nearbyThreat = enemies.find(e =>
      helper.distance({ q: entity.q, r: entity.r }, { q: e.q, r: e.r }) <= 5
    );
    if (nearbyThreat) {
      candidates.push({
        entity,
        action: 'flee',
        threat: nearbyThreat,
        importance: 8,
        description: `Retreat from ${nearbyThreat.name}`,
      });
      return candidates;
    }

    // Explore
    candidates.push({
      entity,
      action: 'explore',
      importance: this.applyFocusMultiplier(6, 'exploration', directive),
      description: `Explore`,
    });

    return candidates;
  }

  // ==================== Builder candidates (villages) ====================

  getBuilderCandidates(entity, directive) {
    const candidates = [];
    const buildables = this.getBuildables(entity);

    for (const targetName of buildables.slice(0, 4)) {
      const isEcon = this.isEconomyBuilding(targetName);
      const isWorker = this.isWorkerUnit(targetName);
      const category = isEcon || isWorker ? 'economy' : 'military';

      let importance = 5;
      if (isWorker) importance = 6; // Workers enable everything
      else if (isEcon) importance = 5;

      // Scouts drive the exploration score component (geometric mean with
      // military/economic). Value diminishes with each scout: the first two
      // are high-value, a few more still help, beyond that they're idle.
      if (targetName.toLowerCase().includes('scout')) {
        const scoutCount = this.getMyUnits().filter((e) =>
          (e.name || '').toLowerCase().includes('scout')
        ).length;
        importance = scoutCount < 2 ? 7 : scoutCount < 4 ? 5.5 : 4;
      }

      // Boost for resource deficits
      const deficit = this.getCriticalResourceDeficit();
      if (deficit && isEcon) importance += 2;

      importance = this.applyFocusMultiplier(importance, category, directive);

      candidates.push({
        entity,
        action: 'build',
        targetName,
        importance,
        description: `Build ${targetName}`,
      });
    }

    return candidates;
  }

  // ==================== Execution ====================

  async executeCandidate(candidate, directive) {
    const helper = this.helper;
    const player = this.player;
    const gameState = this.gameState;
    const { entity, action } = candidate;

    if (player.orders <= 0) return false;

    helper.aiLog(player, 'action',
      `${entity.name} → ${candidate.description} (importance ${candidate.importance.toFixed(1)})`
    );

    let result;
    switch (action) {
      case 'attack':
        result = helper.attack(gameState, entity, candidate.target, 2);
        break;
      case 'build':
        result = helper.build(gameState, entity, candidate.targetName);
        break;
      case 'explore':
        result = helper.explore(gameState, entity, null, false, null);
        break;
      case 'flee':
        result = this.executeFlee(entity, candidate.threat);
        break;
      case 'position':
        // Move toward map center
        result = helper.explore(gameState, entity, null, false, [{ q: 0, r: 0 }]);
        break;
      default:
        return false;
    }

    if (result && result.ordersUsed > 0) {
      player.orders = Math.max(0, player.orders - result.ordersUsed);
      return true;
    }
    return false;
  }

  executeFlee(entity, threat) {
    const helper = this.helper;
    const gameState = this.gameState;

    // Flee away from threat, toward nearest protector (military or village)
    const protectors = this.getMyUnits().filter(u =>
      u.id !== entity.id &&
      (this.isMilitary(u) || (u.name || '').toLowerCase().includes('village'))
    );

    let fleeTarget;
    if (protectors.length > 0) {
      // Go toward nearest protector
      protectors.sort((a, b) =>
        helper.distance({ q: a.q, r: a.r }, { q: entity.q, r: entity.r }) -
        helper.distance({ q: b.q, r: b.r }, { q: entity.q, r: entity.r })
      );
      fleeTarget = { q: protectors[0].q, r: protectors[0].r };
    } else {
      // No protector: move directly away from threat
      const dx = entity.q - threat.q;
      const dy = entity.r - threat.r;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      fleeTarget = {
        q: Math.round(entity.q + (dx / dist) * 5),
        r: Math.round(entity.r + (dy / dist) * 5),
      };
    }

    return helper.explore(gameState, entity, null, false, [fleeTarget]);
  }

  // ==================== Helpers ====================

  getBuildables(entity) {
    if (entity.buildables) return entity.buildables;
    const def = this.getEntityDef(entity.name ?? entity.type);
    return def?.buildables || [];
  }

  getEntityDef(name) {
    const manifest = this.gameState.manifestData;
    if (!manifest) return null;
    const entities = manifest.entities;
    if (!entities) return null;
    if (!Array.isArray(entities) && entities[name]) return entities[name];
    if (Array.isArray(entities)) return entities.find(d => d.name === name) || null;
    const wrapped = entities.entities || [];
    return wrapped.find(d => d.name === name) || null;
  }

  isEconomyBuilding(name) {
    const def = this.getEntityDef(name);
    if (!def) return false;
    const yields = def.yields || {};
    const hasYields = Object.keys(yields).length > 0;
    const econScore = def.score?.economic || 0;
    const milScore = def.score?.military || 0;
    return hasYields || econScore > milScore;
  }

  isWorkerUnit(name) {
    const def = this.getEntityDef(name);
    if (!def) return false;
    return (def.buildables || []).length > 0;
  }

  getCriticalResourceDeficit() {
    // Simplified: return null for now, can be enhanced later
    return null;
  }
}

export default EntityCentricAI;
