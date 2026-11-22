# Empires Tests

Three independent test approaches. None modifies `src/` — no test-only hooks in production code.

- **[Headless](headless/)** — Node.js game-logic harness. No browser, no GPU. Fast: 20 turns in ~1s. Catches logic bugs, crashes, NaNs. Also runs AI controller suites/tournaments and writes Markdown reports (`npm run test:suite` in that folder).
- **[Local](local/)** — headless Chromium smoke tests for module/CDN/asset loading and browser-only paths.
- **[Modal](modal/)** — Playwright in a Modal T4 cloud browser. Clicks the real UI. Catches integration issues (DOM, assets, browser behavior). ~$0.10–0.20 per run.

See each folder's README for usage.
