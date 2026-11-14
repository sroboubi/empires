/**
 * Local browser smoke test for Empires.
 *
 * Loads the real game in headless Chromium (no cloud, no GPU), starts a game
 * with AI players, lets it play, and checks the production autosave for
 * corrupt state. Screenshots go to ./screenshots.
 *
 *   npm test                    # 3 rounds on a radius-16 map
 *   TURNS=10 MAP=64 npm test    # longer game, bigger map
 *
 * Two sandbox-only workarounds are handled here, because `sbx` blocks the
 * game's CDN imports and MITMs TLS:
 *   - `simplex-noise` is served from tests/headless/node_modules
 *   - `unpkg.com` requests are proxied through Node's fetch
 * Neither touches production code.
 *
 * SwiftShader draws the first frame very slowly (~15-20s), so the test waits
 * for real draw calls plus a settle period before judging the screenshot.
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

const TURNS = Number(process.env.TURNS || 3);
const MAP = process.env.MAP || '16';
const SETTLE_MS = Number(process.env.SETTLE_MS || 15000);
const PORT = Number(process.env.PORT || 8123);
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const NM = path.join(ROOT, 'tests/headless/node_modules');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg', '.ico': 'image/x-icon', '.map': 'application/json',
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, rel === '/' ? '/index.html' : rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
const listen = (p) => new Promise((res, rej) => {
  const onErr = (e) => { server.off('error', onErr); rej(e); };
  server.once('error', onErr);
  server.listen(p, '127.0.0.1', () => { server.off('error', onErr); res(); });
});
try { await listen(PORT); }
catch (e) {
  if (e.code !== 'EADDRINUSE') throw e;
  console.log(`port ${PORT} busy, using a free port`);
  await listen(0);
}
const port = server.address().port;

const log = (...a) => console.log(...a);
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('requestfailed', (r) => {
  if (!r.url().startsWith('data:')) pageErrors.push(`request failed: ${r.url()} (${r.failure()?.errorText})`);
});

// Count real GPU draw calls so we know the renderer is actually producing frames.
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
  status: 200,
  contentType: 'application/javascript',
  headers: { 'access-control-allow-origin': '*' },
  body: fs.readFileSync(path.join(NM, 'simplex-noise/dist/esm/simplex-noise.js'), 'utf8'),
}));
await page.route('**://unpkg.com/**', async (route) => {
  try {
    const res = await fetch(route.request().url());
    const body = Buffer.from(await res.arrayBuffer());
    await route.fulfill({
      status: res.status,
      body,
      headers: {
        'content-type': res.headers.get('content-type') || 'application/javascript',
        'access-control-allow-origin': '*',
      },
    });
  } catch { await route.abort(); }
});

await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForSelector('#setup-modal-overlay.active', { timeout: 120000 });
log('setup modal visible');
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(SHOTS, '00-setup.png') });

const gpu = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return 'no-webgl2';
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
log('webgl2:', gpu);

await page.fill('#setup-autosave-interval', '1');
await page.selectOption('#setup-map-size', MAP);
log(`map radius ${MAP}, autosave every round`);

// Put every player on a coded-AI controller (rows re-render on change, so re-query).
const rows = await page.locator('#setup-players-container .dynamic-row').count();
log('player rows:', rows);
for (let i = 0; i < rows; i++) {
  const sel = page.locator('#setup-players-container .controller-select').nth(i);
  const aiKeys = await sel.locator('option').evaluateAll((opts) => opts
    .map((o) => o.value)
    .filter((v) => v && v !== 'human' && !/llm|localhost/i.test(v)));
  if (aiKeys.length) await sel.selectOption(aiKeys[0]);
}
log('all players set to AI');

await page.click('#btn-start-game');
await page.waitForSelector('#setup-modal-overlay:not(.active)', { timeout: 60000 });

// Wait for the renderer to actually draw, then let SwiftShader catch up.
await page.waitForFunction(() => (window.__drawCalls || 0) > 0, null, { timeout: 120000 });
log('renderer is drawing, waiting for settle…');
await page.waitForTimeout(SETTLE_MS);
await page.screenshot({ path: path.join(SHOTS, '01-start.png') });

const getRound = () => page.evaluate(() => {
  const t = document.getElementById('players-list')?.textContent || '';
  const m = t.match(/ROUND\s+(\d+)/i);
  return m ? Number(m[1]) : null;
});

let round = await getRound();
log('round after start:', round);
for (let i = 0; i < TURNS * 4; i++) {
  await page.waitForTimeout(2000);
  const next = await getRound();
  if (next !== round) log(`round ${next}`);
  round = next;
  if (round !== null && round >= TURNS) break;
  await page.evaluate(() => {
    const b = document.getElementById('btn-next-turn');
    if (b && !b.disabled) b.click();
  });
}
await page.screenshot({ path: path.join(SHOTS, '02-turns.png') });

// Dismiss a victory modal so the board is visible
await page.evaluate(() => {
  document.getElementById('victory-modal-overlay')?.classList.remove('active');
});
await page.waitForTimeout(1000);
await page.screenshot({ path: path.join(SHOTS, '03-board.png') });

const drawCalls = await page.evaluate(() => window.__drawCalls);
const save = await page.evaluate(async () => {
  try {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('EmpiresDB', 1);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const saves = await new Promise((res, rej) => {
      const r = db.transaction('saves', 'readonly').objectStore('saves').index('timestamp').getAll();
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    db.close();
    if (!saves?.length) return { ok: false, reason: 'no autosave written' };
    saves.sort((a, b) => b.timestamp - a.timestamp);
    const d = JSON.parse(saves[0].data);
    const bad = [];
    if (!Number.isFinite(d.currentRound)) bad.push('currentRound is not a finite number');
    if (!Array.isArray(d.entities)) bad.push('entities is not an array');
    for (const e of d.entities || []) {
      if (e.health !== undefined && (!Number.isFinite(e.health) || e.health < 0)) { bad.push(`${e.id}: health ${e.health}`); break; }
    }
    for (const p of d.players || []) {
      if (p.orders !== undefined && (!Number.isFinite(p.orders) || p.orders < 0)) { bad.push(`${p.name}: orders ${p.orders}`); break; }
      for (const [k, v] of Object.entries(p.resources || {})) {
        if (typeof v === 'number' && !Number.isFinite(v)) { bad.push(`${p.name}: ${k} is NaN`); break; }
      }
    }
    // Trade state must survive serialization in the same shape the engine
    // accepts: distinct participants and non-empty, positive bundles.
    if (!Array.isArray(d.trades)) {
      bad.push('trades is not an array');
    } else {
      for (const t of d.trades) {
        if (!t || typeof t !== 'object') { bad.push('invalid trade record'); break; }
        if (String(t.player1Id) === String(t.player2Id)) { bad.push(`trade ${t.id}: same player`); break; }
        let tradeBad = false;
        for (const [side, bundle] of [['bundle1', t.bundle1], ['bundle2', t.bundle2]]) {
          if (!bundle || typeof bundle !== 'object' || Object.keys(bundle).length === 0) {
            bad.push(`trade ${t.id}: ${side} is empty`); tradeBad = true; break;
          }
          const invalid = Object.entries(bundle).find(([, v]) => !Number.isFinite(v) || v <= 0);
          if (invalid) {
            bad.push(`trade ${t.id}: ${side} has invalid amount for ${invalid[0]}`);
            tradeBad = true;
            break;
          }
        }
        if (tradeBad) break;
      }
    }
    return { ok: bad.length === 0, round: d.currentRound, entities: d.entities?.length, trades: d.trades?.length, problems: bad };
  } catch (e) { return { ok: false, reason: String(e) }; }
});

log('draw calls:', drawCalls);
log('autosave:', JSON.stringify(save));
log('page errors:', pageErrors.length, pageErrors.slice(0, 5));
log('console errors:', consoleErrors.length, consoleErrors.slice(0, 5));
log(`screenshots: ${SHOTS}`);

await browser.close();
server.close();

const failed = !save.ok || pageErrors.length > 0 || !drawCalls;
log(failed ? 'FAILED' : 'ALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
