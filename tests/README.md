# Empires Tests

Three independent test approaches. None modifies `src/` — no test-only hooks in production code.

- **[Headless](headless/)** — Node.js game-logic harness. No browser, no GPU. Fast: 20 turns in ~1s. Catches logic bugs, crashes, NaNs. Also runs AI controller suites/tournaments and writes Markdown reports (`npm run test:suite` in that folder).
- **[Local](local/)** — headless Chromium smoke tests for module/CDN/asset loading and browser-only paths.
- **[Modal](modal/)** — Playwright in a Modal T4 cloud browser. Clicks the real UI. Catches integration issues (DOM, assets, browser behavior). ~$0.10–0.20 per run.

See each folder's README for usage.

## Standalone Node test files

Seven more Node test files live outside the three folders above:

- **Root `tests/*.test.js`** — `buildSiteIndex.test.js`, `leaderAttributes.test.js`. Engine-level tests (`AiHelper`, leader attribute twists) against `src/` with mocked game state. Per the convention noted in their headers, tests of game code in `src/` live in root `tests/`, not under `src/ai`.
- **`src/ai/tests/*.test.js`** — `markdown`, `chatEmote`, `adjustedView`, `menu`, `strategic`. Tests of AI-side code, living next to the code they cover.

All seven run from the repo root. Because `src/` resolves CDN (`https:`) imports and bare packages (`three`, `ajv`, `simplex-noise`) through the headless loader, install the headless dependencies once and run every file through the headless preload:

```bash
cd tests/headless && npm install && cd ../..

# Root tests
node --import=./tests/headless/preload.mjs --input-type=module -e "import('./tests/buildSiteIndex.test.js')"
node --import=./tests/headless/preload.mjs --input-type=module -e "import('./tests/leaderAttributes.test.js')"

# src/ai tests
node --import=./tests/headless/preload.mjs --input-type=module -e "import('./src/ai/tests/markdown.test.js')"
node --import=./tests/headless/preload.mjs --input-type=module -e "import('./src/ai/tests/chatEmote.test.js')"
node --import=./tests/headless/preload.mjs --input-type=module -e "import('./src/ai/tests/adjustedView.test.js')"
node --import=./tests/headless/preload.mjs --input-type=module -e "import('./src/ai/tests/menu.test.js')"
node --import=./tests/headless/preload.mjs --input-type=module -e "import('./src/ai/tests/strategic.test.js')"
```

Each script prints a pass/fail summary and exits non-zero on failure, so they are safe to chain in CI (see `.github/workflows/headless-tests.yml`).

Two pitfalls:

- **Plain `node --test tests/` does not work.** Node's default ESM loader rejects the `https:` CDN imports in `src/` with `ERR_UNSUPPORTED_ESM_URL_SCHEME`. These files are scripts, not `node:test` suites; run them with the preload commands above.
- **Some files import bare packages transitively.** Anything that pulls in `llmBase.js` (e.g. `chatEmote.test.js`, `strategic.test.js`) needs `ajv` from `tests/headless/node_modules`, which only the preload loader resolves. `markdown`, `adjustedView` and `menu` happen to run without the preload today, but the preload form works for all seven and is the one to copy.
