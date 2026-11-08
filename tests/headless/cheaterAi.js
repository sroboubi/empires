/**
 * Red-team test AI: deliberately attempts every illegal operation the
 * AI interface proxy is supposed to block. Run via the headless harness
 * (`npm run test:redteam`) to verify the proxy actually holds.
 *
 * Each probe records PASS (blocked as expected) or FAIL (hole!).
 * Throws if any probe fails. Results reset every turn.
 */
import { BaseManager } from '../../src/ai/baseManager.js';

function probe(results, name, fn, expectBlocked) {
  try {
    const val = fn();
    if (expectBlocked === 'throw') {
      results.push({ name, pass: false, detail: 'did NOT throw' });
    } else if (expectBlocked === 'undefined') {
      results.push({ name, pass: val === undefined, detail: `got ${JSON.stringify(val)?.slice(0, 60)}` });
    } else if (expectBlocked === 'null') {
      results.push({ name, pass: val === null, detail: `got ${typeof val}` });
    } else {
      results.push({ name, pass: true, detail: 'ok' });
    }
  } catch (e) {
    if (expectBlocked === 'throw') {
      results.push({ name, pass: true, detail: 'threw as expected' });
    } else {
      results.push({ name, pass: false, detail: `unexpected throw: ${e.message.slice(0, 80)}` });
    }
  }
}

export default class CheaterAi extends BaseManager {
  async processTurn() {
    const results = [];
    const gs = this.gameState;
    const me = this.player;
    const helper = this.helper;

    // --- 1. Opponent private reads via players array ---
    const opponent = gs.players.find(p => p.id !== me.id);
    probe(results, 'opponent.resources hidden', () => opponent.resources, 'undefined');
    probe(results, 'opponent.history hidden', () => opponent.history, 'undefined');
    probe(results, 'opponent.orders hidden', () => opponent.orders, 'undefined');
    probe(results, 'opponent.exploredCells hidden', () => opponent.exploredCells, 'undefined');
    probe(results, 'opponent name visible', () => { if (opponent.name === undefined) throw new Error('blocked'); return opponent.name; });
    probe(results, 'opponent.score is read-only', () => {
      try { opponent.score.total = 0; } catch (e) { return; } // throw = blocked
      if (opponent.score.total === 0) throw new Error('score mutation stuck!');
    });

    // --- 2. Opponent data via entity.owner path ---
    // Fixture: a visible enemy, else any barbarian (ownerless foreign entity).
    const foreign = gs.entities.filter(e => {
      const oid = e.ownerId ?? e.owner?.id;
      return oid !== me.id;
    });
    const visibleEnemies = foreign.filter(e => {
      const oid = e.ownerId ?? e.owner?.id;
      return oid !== undefined && oid !== me.id;
    });
    const probeTarget = visibleEnemies[0] || foreign[0];
    if (probeTarget) {
      const enemy = probeTarget;
      probe(results, 'enemy.owner.resources hidden', () => enemy.owner?.resources, 'undefined');
      probe(results, 'enemy.owner.history hidden', () => enemy.owner?.history, 'undefined');
      probe(results, 'enemy.owner.getEntities blocked', () => enemy.owner?.getEntities(), 'undefined');
      if (visibleEnemies.length > 0) {
        probe(results, 'opponent identity stable (players[i] === enemy.owner)', () => {
          if (enemy.owner !== opponent) throw new Error('split proxy identity!');
        });
      }

      // --- 3. Action ownership ---
      // Prefer a target that actually HAS actions: tower/farm/mine/forge/
      // lumberMill/camp have none, so probing .do on one "passes" vacuously
      // and the old code FAILed it as "did NOT throw" — a test bug, not a
      // proxy hole (flaky: depended on which foreign entity came first).
      const actionTarget = foreign.find(e => {
        try { return e.getActions().length > 0; } catch { return false; }
      });
      if (actionTarget) {
        probe(results, 'enemy.getActions()[0].do throws', () => {
          actionTarget.getActions()[0].do();
        }, 'throw');
        probe(results, 'enemy.actions[0].do throws', () => {
          actionTarget.actions[0].do();
        }, 'throw');
      } else {
        results.push({ name: 'enemy action ownership probes', pass: true, detail: 'no foreign entity with actions visible (skipped)' });
      }
    } else {
      results.push({ name: 'enemy entity probes', pass: true, detail: 'no foreign entities visible (skipped)' });
    }

    // --- 4. Direct writes (must throw) ---
    probe(results, 'write player.gold throws', () => { me.gold = 99999; }, 'throw');
    probe(results, 'write gameState.currentRound throws', () => { gs.currentRound = 99; }, 'throw');
    probe(results, 'defineProperty bypass throws', () => {
      Object.defineProperty(me, 'orders', { value: 99 });
    }, 'throw');

    // --- 5. Helper bypass ---
    probe(results, 'helper.gameState is proxied', () => {
      const hgs = helper.gameState;
      if (hgs && hgs.constructor && hgs.constructor.name === 'GameState') {
        const op = hgs.players.find(p => p.id !== me.id);
        if (op && op.resources !== undefined) throw new Error('raw gameState leaked via helper!');
      }
      return true;
    });
    probe(results, 'helper.getGameState() is proxied', () => {
      const hgs = helper.getGameState();
      const op = hgs.players.find(p => p.id !== me.id);
      if (op && op.resources !== undefined) throw new Error('raw gameState leaked via getGameState!');
      return true;
    });

    // --- 6. Fog of war (real unexplored coordinate, not an off-map one) ---
    probe(results, 'unexplored cell terrain hidden', () => {
      const cells = helper.getCellsArray();
      const unexplored = cells.find(c => c && !me.isExplored(c.q, c.r));
      if (!unexplored) return undefined; // fully explored: nothing to hide
      return unexplored.terrain;
    }, 'undefined');
    probe(results, 'unexplored cell resource hidden', () => {
      const cells = helper.getCellsArray();
      const unexplored = cells.find(c => c && !me.isExplored(c.q, c.r));
      if (!unexplored) return undefined;
      return unexplored.resource;
    }, 'undefined');
    probe(results, 'helper.getCell unexplored is undefined', () => {
      const cells = helper.getCellsArray();
      const unexplored = cells.find(c => c && !me.isExplored(c.q, c.r));
      if (!unexplored) return undefined;
      return helper.getCell(unexplored.q, unexplored.r);
    }, 'undefined');

    // --- 7. Chat privacy ---
    probe(results, 'third-party chat hidden', () => {
      const hist = gs.chatHistory || {};
      for (const [key] of Object.entries(hist)) {
        if (!key.split(':').includes(String(me.id))) {
          throw new Error(`third-party chat visible: ${key}`);
        }
      }
      return true;
    });

    // --- 8. P1: descriptor access must not leak raw objects ---
    probe(results, 'descriptor gs.entities is filtered', () => {
      const desc = Object.getOwnPropertyDescriptor(gs, 'entities');
      if (!desc || !Array.isArray(desc.value)) throw new Error('no descriptor value');
      // Filtered array must not contain hidden entities
      for (const e of desc.value) {
        const oid = e.ownerId ?? e.owner?.id;
        if (oid !== undefined && oid !== me.id && !me.isVisible(e.q, e.r)) {
          throw new Error('raw entity leaked via descriptor');
        }
      }
      return true;
    });
    probe(results, 'descriptor opponent.resources is undefined', () => {
      const desc = Object.getOwnPropertyDescriptor(opponent, 'resources');
      return desc ? desc.value : undefined;
    }, 'undefined');

    // --- 9. P2: engine methods must not run via the proxy ---
    // Blocked methods read as undefined — check typeof, don't call them
    // (calling undefined throws TypeError, which is the block working).
    const mustBeUndefined = (label, val) => {
      if (typeof val !== 'undefined') throw new Error(`${label} is ${typeof val}, not blocked`);
      return true;
    };
    probe(results, 'player.addResources blocked', () => mustBeUndefined('addResources', me.addResources));
    probe(results, 'player.refillOrders blocked', () => mustBeUndefined('refillOrders', me.refillOrders));
    probe(results, 'gameState.spawnEntity blocked', () => mustBeUndefined('spawnEntity', gs.spawnEntity));
    probe(results, 'gameState.serialize blocked', () => mustBeUndefined('serialize', gs.serialize));
    if (probeTarget) {
      probe(results, 'foreign entity.destroy blocked', () => mustBeUndefined('destroy', probeTarget.destroy));
    }

    // --- 10. P3: array callbacks must receive wrapped elements ---
    probe(results, 'gs.entities.forEach callback is wrapped', () => {
      let sawRaw = false;
      gs.entities.forEach(e => {
        try { e.health = 1; sawRaw = true; } catch (err) { /* wrapped: set throws */ }
      });
      if (sawRaw) throw new Error('raw element in forEach callback');
      return true;
    });
    probe(results, 'gs.entities.filter callback is wrapped', () => {
      const found = gs.entities.filter(e => {
        try { e.health = 1; return false; } catch (err) { return true; }
      });
      return found.length;
    });

    // --- 11. P4: back-references must return the filtered proxy ---
    probe(results, 'player.gameState.entities is filtered', () => {
      const ents = me.gameState.entities;
      for (const e of ents) {
        const oid = e.ownerId ?? e.owner?.id;
        if (oid !== undefined && oid !== me.id && !me.isVisible(e.q, e.r)) {
          throw new Error('unfiltered entity via player.gameState');
        }
      }
      return true;
    });
    probe(results, 'entity.gameState is filtered', () => {
      const own = gs.entities.find(e => (e.ownerId ?? e.owner?.id) === me.id);
      if (!own) return true;
      const ents = own.gameState.entities;
      for (const e of ents) {
        const oid = e.ownerId ?? e.owner?.id;
        if (oid !== undefined && oid !== me.id && !me.isVisible(e.q, e.r)) {
          throw new Error('unfiltered entity via entity.gameState');
        }
      }
      return true;
    });

    // --- 12. P5/P6: helper ownership guards ---
    if (probeTarget) {
      probe(results, 'helper.attack on foreign entity throws', () => {
        helper.attack(gs, probeTarget, me.getEntities()[0], 1);
      }, 'throw');
    }
    probe(results, 'helper.chat as another player throws', () => {
      helper.chat(opponent, me, 'hello');
    }, 'throw');

    // --- 13. P7: helper cell methods respect fog ---
    probe(results, 'helper.getCellsArray hides unexplored resources', () => {
      const cells = helper.getCellsArray();
      const unexplored = cells.find(c => c && !me.isExplored(c.q, c.r));
      if (!unexplored) return undefined;
      return unexplored.resource;
    }, 'undefined');

    // --- 14. P9: hexGrid identity is stable ---
    probe(results, 'gs.hexGrid === gs.hexGrid', () => {
      if (gs.hexGrid !== gs.hexGrid) throw new Error('unstable hexGrid proxy');
      return true;
    });

    // --- 15. Grid getCellsArray matches the helper path: ALL cells, masked ---
    probe(results, 'gs.hexGrid.getCellsArray returns all cells masked', () => {
      const cells = gs.hexGrid.getCellsArray();
      const unexplored = cells.find(c => c && !me.isExplored(c.q, c.r));
      if (!unexplored) return undefined; // fully explored: nothing to hide
      if (cells.length <= 1) throw new Error('grid list filtered to explored only');
      if (unexplored.terrain !== undefined) throw new Error('unexplored terrain leaked');
      if (unexplored.resource !== undefined) throw new Error('unexplored resource leaked');
      return true;
    });

    // Report
    console.log('\n[CheaterAI] Red-team results:');
    let fails = 0;
    for (const r of results) {
      console.log(`  ${r.pass ? 'PASS' : 'FAIL'}: ${r.name}${r.pass ? '' : ` (${r.detail})`}`);
      if (!r.pass) fails++;
    }
    console.log(`[CheaterAI] ${results.length - fails}/${results.length} probes blocked\n`);
    if (fails > 0) {
      throw new Error(`[CheaterAI] ${fails} PROXY HOLES FOUND`);
    }

    // Play a legal move so the game continues — march the swordsman toward
    // the enemy's mirrored start position so the AI eventually sees foreign
    // entities (the ownership probes above only run when one is visible).
    // Random exploration never made contact in 30 turns.
    const swordsman = me.getEntities().find(e => e.name === 'swordsman' && e.active && (e.actionPoints ?? 0) > 0);
    if (swordsman) {
      // Mirror of our start — approximately the enemy's start (players spawn
      // on opposite sides of the ring). Marching there guarantees contact.
      const sc = me.startCoord || { q: 0, r: 0 };
      const target = { q: -sc.q, r: -sc.r };
      const res = helper.movementCostTo(swordsman.cell, target, swordsman.getMovementCost.bind(swordsman), { allowDetours: true });
      const path = res ? res.path.slice(1) : [];
      if (path.length > 0) {
        const moveAction = swordsman.getActions().find(a => a.name === 'Move');
        if (moveAction) {
          for (const cell of path) {
            if ((swordsman.actionPoints ?? 0) <= 0 || swordsman.destroyed) break;
            if (gs.getEntityAt(cell.q, cell.r)) break;
            const check = moveAction.canDo(cell, null);
            if (!check?.possible) break;
            if (!moveAction.do(cell, null)) break;
          }
        }
      } else {
        helper.explore(gs, swordsman);
      }
    }
    return { ordersUsed: 0, result: { status: 'completed', message: 'red-team scan done' } };
  }

  async generateChatReply() {
    return { content: 'No time for words.', ended: true };
  }
  async summarizeChatAndAddNote() { return; }
}
