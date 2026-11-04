/**
 * Red-team test AI: deliberately attempts every illegal operation the
 * AI interface proxy is supposed to block. Run via the headless harness
 * to verify the proxy actually holds.
 *
 * Each probe records PASS (blocked as expected) or FAIL (hole!).
 * Exits non-zero if any probe fails.
 */
import { BaseManager } from '../../src/ai/baseManager.js';

const results = [];
function probe(name, fn, expectBlocked) {
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
    const gs = this.gameState;
    const me = this.player;
    const helper = this.helper;

    // --- 1. Opponent private reads via players array ---
    const opponent = gs.players.find(p => p.id !== me.id);
    probe('opponent.resources hidden', () => opponent.resources, 'undefined');
    probe('opponent.history hidden', () => opponent.history, 'undefined');
    probe('opponent.orders hidden', () => opponent.orders, 'undefined');
    probe('opponent.exploredCells hidden', () => opponent.exploredCells, 'undefined');
    probe('opponent name visible', () => { if (opponent.name === undefined) throw new Error('blocked'); return opponent.name; });

    // --- 2. Opponent data via entity.owner path ---
    const visibleEnemies = gs.entities.filter(e => {
      const oid = e.ownerId ?? e.owner?.id;
      return oid !== undefined && oid !== me.id;
    });
    if (visibleEnemies.length > 0) {
      const enemy = visibleEnemies[0];
      probe('enemy.owner.resources hidden', () => enemy.owner.resources, 'undefined');
      probe('enemy.owner.history hidden', () => enemy.owner.history, 'undefined');
      probe('enemy.owner.getEntities blocked', () => enemy.owner.getEntities(), 'undefined');

      // --- 3. Action ownership ---
      probe('enemy.getActions()[0].do throws', () => {
        const acts = enemy.getActions();
        if (acts.length > 0) acts[0].do();
      }, 'throw');
      probe('enemy.actions[0].do throws', () => {
        if (enemy.actions.length > 0) enemy.actions[0].do();
      }, 'throw');
    } else {
      results.push({ name: 'enemy entity probes', pass: true, detail: 'no visible enemies (skipped)' });
    }

    // --- 4. Direct writes (must throw) ---
    probe('write player.gold throws', () => { me.gold = 99999; }, 'throw');
    probe('write gameState.currentRound throws', () => { gs.currentRound = 99; }, 'throw');

    // --- 5. Helper bypass ---
    probe('helper.gameState is proxied', () => {
      // Raw gameState would expose unfiltered entities array
      const hgs = helper.gameState;
      if (hgs && hgs.constructor && hgs.constructor.name === 'GameState') {
        // Check it's not the raw object by verifying players are proxied
        const op = hgs.players.find(p => p.id !== me.id);
        if (op && op.resources !== undefined) throw new Error('raw gameState leaked via helper!');
      }
      return true;
    });
    probe('helper.getGameState() is proxied', () => {
      const hgs = helper.getGameState();
      const op = hgs.players.find(p => p.id !== me.id);
      if (op && op.resources !== undefined) throw new Error('raw gameState leaked via getGameState!');
      return true;
    });

    // --- 6. Fog of war ---
    probe('unexplored cell terrain hidden', () => {
      const cells = gs.hexGrid.getCellsArray ? gs.hexGrid.getCellsArray() : [];
      // getCellsArray is already filtered; try direct getCell on far corner
      const cell = gs.hexGrid.getCell(-999, -999);
      return cell; // should be undefined (no such cell or unexplored)
    }, 'undefined');

    // --- 7. Chat privacy ---
    probe('third-party chat hidden', () => {
      const hist = gs.chatHistory || {};
      for (const [key] of Object.entries(hist)) {
        if (!key.split(':').includes(String(me.id))) {
          throw new Error(`third-party chat visible: ${key}`);
        }
      }
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

    // Play a legal move so the game continues
    return { ordersUsed: 0, result: { status: 'completed', message: 'red-team scan done' } };
  }

  async generateChatReply() { return null; }
  async summarizeChatAndAddNote() { return null; }
}