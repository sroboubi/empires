/**
 * Optional browser test: real local LLM + AI-initiated trade.
 *
 * Loads the REAL LlmBaseManager (Ajv via esm.sh) and a local OpenAI-compatible
 * model, then:
 *   1. has the AI initiate a one-time offer, which the human accepts;
 *   2. has the AI initiate again, which the human counters;
 *   3. lets the real LLM decide the counter via the production handleTradeOffer.
 *
 * Skips cleanly (exit 0) when the local endpoint/model or Chromium is missing,
 * so it is safe to keep in the suite without a local model running.
 *
 *   npm run test:llm
 *   LOCAL_MODEL=qwen3-8b npm run test:llm
 *   LOCAL_BASE_URL=http://localhost:1234/v1 npm run test:llm
 *   LOCAL_TIMEOUT_MS=300000 CHROME=/path/to/chrome npm run test:llm
 *
 * Env:
 *   LOCAL_BASE_URL   default: auto-detect (localhost, then host.docker.internal)
 *   LOCAL_MODEL      default: google/gemma-4-e4b
 *   LOCAL_TIMEOUT_MS default: 240000 (first call may load the model)
 *   LOCAL_API_KEY    optional; sent only when set
 *   CHROME           default: /usr/bin/chromium
 *   MAP / SETTLE_MS  same as smoke.mjs
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SHOTS = path.join(HERE, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const MAP = process.env.MAP || '16';
const SETTLE_MS = Number(process.env.SETTLE_MS || 12000);
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const NM = path.join(ROOT, 'tests/headless/node_modules');
const LOCAL_MODEL = process.env.LOCAL_MODEL || 'google/gemma-4-e4b';
const LOCAL_API_KEY = process.env.LOCAL_API_KEY || '';
const LOCAL_TIMEOUT_MS = Number(process.env.LOCAL_TIMEOUT_MS || 240000);
const DECISION_WAIT_MS = LOCAL_TIMEOUT_MS + 60000;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg', '.ico': 'image/x-icon',
};

let pass = 0, fail = 0, skipped = false;
let browser = null;
let server = null;
const pageErrors = [];
const consoleErrors = [];

function log(...args) { console.log(...args); }
function check(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg); }
}

/** Probe candidate OpenAI-compatible endpoints and return one that serves /models. */
async function probeLocalModel() {
  const candidates = (process.env.LOCAL_BASE_URL
    ? [process.env.LOCAL_BASE_URL]
    : [
      'http://localhost:1234/v1',
      'http://127.0.0.1:1234/v1',
      'http://host.docker.internal:1234/v1',
    ]
  ).map(b => b.replace(/\/+$/, ''));

  const headers = LOCAL_API_KEY ? { Authorization: `Bearer ${LOCAL_API_KEY}` } : {};
  for (const base of candidates) {
    try {
      const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        log(`  probe ${base}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const ids = (data.data || []).map(m => m.id).filter(Boolean);
      return { base, ids };
    } catch (e) {
      log(`  probe ${base}: ${e.message}`);
    }
  }
  return null;
}

const SCRIPTED_LLM_HARNESS = `
import { LlmBaseManager } from '../llmBase.js';
// Real base class: getLLMClient() and handleTradeOffer() are inherited unchanged.
// Only WHEN the AI proposes is forced, so the test can run in a fresh game.
export default class E2ELlmHarness extends LlmBaseManager {
  constructor(player, helper) {
    super(player, helper);
    this._lastProposedRound = null;
  }
  async processTurn() {}
  async summarizeChatAndAddNote() {}
  async maybeInitiateTrade() {
    if (this.player.id !== 2) return;
    if (this.gameState.currentRound > 2) return;
    if (this._lastProposedRound === this.gameState.currentRound) return;
    this._lastProposedRound = this.gameState.currentRound;
    await this.helper.initiateTrade(this.player, 1, {
      type: 'one_time',
      proposerGives: { wood: 5 },
      proposerAsks: { gold: 5 }
    });
  }
}
`;

async function main() {
  const probe = await probeLocalModel();
  if (!probe) {
    skipped = true;
    log('SKIP: no local OpenAI-compatible endpoint found (set LOCAL_BASE_URL).');
    return;
  }
  if (!probe.ids.includes(LOCAL_MODEL)) {
    skipped = true;
    log(`SKIP: model '${LOCAL_MODEL}' not served by ${probe.base}.`);
    log(`      available: ${probe.ids.join(', ') || '(none)'}`);
    return;
  }
  if (!fs.existsSync(CHROME)) {
    skipped = true;
    log(`SKIP: Chromium not found at ${CHROME} (set CHROME=/path/to/chrome).`);
    return;
  }

  log(`using endpoint: ${probe.base}`);
  log(`using model:    ${LOCAL_MODEL}\n`);

  // Test-only override: point the real local provider at the probe result and
  // give the first (cold) call a long timeout. Production files are untouched.
  const aiJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'definitions/ai.json'), 'utf8'));
  aiJson.providers.local.url = probe.base;
  const llmKey = Object.keys(aiJson.controllers).find((key) => {
    const c = aiJson.controllers[key];
    return c.url?.endsWith('/json/harness.js') && c.config?.provider === 'local';
  }) || 'llm-json-gemma-4';
  aiJson.controllers[llmKey].config.model = LOCAL_MODEL;
  aiJson.controllers[llmKey].config.timeoutMs = LOCAL_TIMEOUT_MS;
  if (LOCAL_API_KEY) aiJson.controllers[llmKey].config.apiKey = LOCAL_API_KEY;

  // --- local HTTP server -------------------------------------------------
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, rel === '/' ? '/index.html' : rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  const listen = (p) => new Promise((resolve, reject) => {
    const onError = (e) => { server.off('error', onError); reject(e); };
    server.once('error', onError);
    server.listen(p, '127.0.0.1', () => { server.off('error', onError); resolve(); });
  });
  const preferredPort = Number(process.env.PORT || 8128);
  try { await listen(preferredPort); }
  catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    await listen(0);
  }
  const port = server.address().port;

  // --- browser -----------------------------------------------------------
  browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.addInitScript(() => {
    window.__drawCalls = 0;
    for (const proto of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype]) {
      if (!proto) continue;
      for (const fn of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
        const orig = proto[fn];
        if (!orig) continue;
        proto[fn] = function (...args) { window.__drawCalls++; return orig.apply(this, args); };
      }
    }
  });

  await page.route('**://esm.sh/simplex-noise@4.0.3', (route) => route.fulfill({
    status: 200, contentType: 'application/javascript',
    headers: { 'access-control-allow-origin': '*' },
    body: fs.readFileSync(path.join(NM, 'simplex-noise/dist/esm/simplex-noise.js'), 'utf8'),
  }));
  await page.route('**://unpkg.com/**', async (route) => {
    try {
      const res = await fetch(route.request().url());
      await route.fulfill({
        status: res.status,
        body: Buffer.from(await res.arrayBuffer()),
        headers: {
          'content-type': res.headers.get('content-type') || 'application/javascript',
          'access-control-allow-origin': '*',
        },
      });
    } catch { await route.abort(); }
  });
  await page.route('**/definitions/ai.json', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(aiJson),
  }));
  await page.route('**/src/ai/llm/json/harness.js', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: SCRIPTED_LLM_HARNESS,
  }));

  // --- game setup --------------------------------------------------------
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#setup-modal-overlay.active', { timeout: 120000 });
  await page.selectOption('#setup-map-size', MAP);

  const rows = await page.locator('#setup-players-container .dynamic-row').count();
  for (let i = 0; i < rows; i++) {
    const sel = page.locator('#setup-players-container .controller-select').nth(i);
    if (i === 0) {
      await sel.selectOption('human');
    } else if (i === 1) {
      await sel.selectOption(llmKey);
    } else {
      const aiKeys = await sel.locator('option').evaluateAll((opts) => opts
        .map((o) => o.value)
        .filter((v) => v && v !== 'human' && !/llm|localhost/i.test(v)));
      if (aiKeys.length) await sel.selectOption(aiKeys[0]);
    }
  }
  await page.click('#btn-start-game');
  await page.waitForSelector('#setup-modal-overlay:not(.active)', { timeout: 60000 });
  await page.waitForFunction(() => (window.__drawCalls || 0) > 0, null, { timeout: 120000 });
  await page.waitForTimeout(SETTLE_MS);

  const roundOf = () => page.evaluate(() => {
    const m = (document.getElementById('players-list')?.innerText || '').match(/ROUND\s+(\d+)/i);
    return m ? Number(m[1]) : null;
  });

  // --- round 1: AI initiates, human accepts ------------------------------
  await page.evaluate(() => {
    const b = document.getElementById('btn-next-turn');
    if (b && !b.disabled) b.click();
  });
  await page.waitForSelector('#chat-modal-overlay.active', { timeout: 60000 });
  await page.waitForSelector('#btn-accept-incoming', { timeout: 30000 });
  check(true, 'real LlmBaseManager harness initiated an offer');

  const offerText = await page.locator('#trade-offer-status-box').innerText();
  check(/Incoming Offer from/i.test(offerText), 'incoming offer names the AI');
  await page.click('#btn-accept-incoming');
  await page.waitForFunction(
    () => /Accepted trade/i.test(document.getElementById('chat-messages-container')?.innerText || ''),
    null, { timeout: 10000 }
  );
  check(true, 'human accepted the first offer');

  await page.click('#btn-close-chat');
  await page.waitForSelector('#chat-modal-overlay:not(.active)', { timeout: 10000 });
  await page.waitForFunction(() => {
    const m = (document.getElementById('players-list')?.innerText || '').match(/ROUND\s+(\d+)/i);
    return m && Number(m[1]) >= 2;
  }, null, { timeout: 60000 });
  check(true, 'game advanced to round 2');

  // --- round 2: AI initiates again, human counters, real LLM decides ------
  await page.evaluate(() => {
    const b = document.getElementById('btn-next-turn');
    if (b && !b.disabled) b.click();
  });
  await page.waitForSelector('#chat-modal-overlay.active', { timeout: 60000 });
  await page.waitForSelector('#btn-adjust-incoming', { timeout: 30000 });
  await page.click('#btn-adjust-incoming');
  await page.waitForFunction(() => {
    const b = document.getElementById('btn-propose-trade');
    return b && !b.disabled;
  }, null, { timeout: 10000 });
  check(true, 'human counter bundle prefilled');

  const chatBefore = await page.locator('#chat-messages-container').innerText();
  await page.click('#btn-propose-trade');
  // The pending box clears on accept/reject; a counter shows its action box.
  await page.waitForFunction(() => {
    const box = document.getElementById('trade-offer-status-box');
    return document.getElementById('btn-accept-counter')
      || (box && getComputedStyle(box).display === 'none');
  }, null, { timeout: DECISION_WAIT_MS });

  const hasCounter = (await page.locator('#btn-accept-counter').count()) > 0;
  const chatAfter = await page.locator('#chat-messages-container').innerText();
  check(chatAfter.length > chatBefore.length, 'real LLM returned a trade decision message');
  if (hasCounter) {
    const counterText = await page.locator('#trade-offer-status-box').innerText();
    check(/Counter-Offer from/i.test(counterText), 'real LLM countered the human offer');
    await page.click('#btn-accept-counter');
    await page.waitForFunction(
      () => /Agreed to counter-offer/i.test(document.getElementById('chat-messages-container')?.innerText || ''),
      null, { timeout: 10000 }
    );
    check(true, 'human accepted the real-LLM counter-offer');
  } else {
    check(true, 'real LLM accepted or rejected the human offer (pending cleared)');
  }
  const lastAiMessage = await page.locator('.chat-msg-received .chat-msg-body').last().innerText().catch(() => '');
  log(`  LLM decision message: ${lastAiMessage.replace(/\s+/g, ' ').slice(0, 240)}`);

  await page.screenshot({ path: path.join(SHOTS, 'llm-trade-decision.png') });
  await page.click('#btn-close-chat');
  await page.waitForSelector('#chat-modal-overlay:not(.active)', { timeout: 10000 });

  // --- history -----------------------------------------------------------
  await page.waitForFunction(() => {
    const m = (document.getElementById('players-list')?.innerText || '').match(/ROUND\s+(\d+)/i);
    return m && Number(m[1]) >= 3;
  }, null, { timeout: 60000 });
  await page.locator('#players-list li.player-list-item').nth(0).click();
  await page.waitForSelector('#profile-modal-overlay.active', { timeout: 10000 });
  const profileText = await page.locator('#profile-modal-overlay').innerText();
  check(/Completed one-time trade/i.test(profileText), 'at least one exchange recorded in history');
  await page.evaluate(() => document.getElementById('profile-modal-overlay')?.classList.remove('active'));

  log('page errors:', pageErrors.length, pageErrors.slice(0, 5));
  log('console errors:', consoleErrors.length, consoleErrors.slice(0, 5));
  check(pageErrors.length === 0, 'no page errors');
  check(consoleErrors.length === 0, 'no console errors');
}

try {
  await main();
} catch (e) {
  fail++;
  console.error(`  ✗ ${e.stack || e.message}`);
  console.error('page errors:', pageErrors.slice(0, 5));
  console.error('console errors:', consoleErrors.slice(0, 5));
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { server?.close(); } catch { /* ignore */ }
}

if (skipped) {
  console.log('\nSKIPPED (local LLM endpoint/model/browser unavailable)');
} else {
  console.log(`\n${pass} passed, ${fail} failed`);
}
process.exitCode = fail ? 1 : 0;
