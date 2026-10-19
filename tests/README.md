# Empires Tests

Two independent test approaches. Neither modifies `src/` — no test-only hooks in production code.

- **[Headless](headless/)** — Node.js game-logic harness. No browser, no GPU. Fast: 20 turns in ~1s. Catches logic bugs, crashes, NaNs.
- **[Modal](modal/)** — Playwright in a Modal T4 cloud browser. Clicks the real UI. Catches integration issues (DOM, assets, browser behavior). ~$0.10–0.20 per run.

See each folder's README for usage.
