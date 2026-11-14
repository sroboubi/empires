# Local Browser Tests

Runs the real game in **headless Chromium on this machine** — no Modal, no cloud, no GPU.

This is the cheap middle ground between `tests/headless` (game logic only, no DOM) and `tests/modal`
(real GPU in the cloud). It catches integration problems locally: module load failures, CDN/asset
problems, rendering that never draws a frame, and broken autosave state.

**What it tests:** the page loads without errors, the setup modal works, a game starts, turns advance,
WebGL draws real frames, and the production IndexedDB autosave has no NaN/negative values.

**What it does NOT test:** real GPU output (SwiftShader is a software rasterizer), LLM players,
and pixel-perfect visuals.

## Setup

```bash
sudo apt-get install -y chromium     # already installed in the sbx sandbox
cd tests/local
npm install                          # playwright-core only, no browser download
```

## Usage

```bash
npm test                     # 3 rounds, radius-16 map
TURNS=10 MAP=64 npm test     # longer game, bigger map
CHROME=/path/to/chrome npm test
```

Screenshots land in `tests/local/screenshots/` (gitignored). `03-board.png` is the map after
the settle period.

**Expect ~30s before the first screenshot.** SwiftShader needs ~15–20s to render the first frame
(the game builds a 4096² shadow map). The harness waits for real draw calls plus `SETTLE_MS`
(default 15000) rather than guessing.

## Sandbox notes

The `sbx` proxy blocks the game's CDN imports and MITMs TLS, so the harness (not the game) works
around it:

- `https://esm.sh/simplex-noise@4.0.3` is served from `tests/headless/node_modules/simplex-noise`
- `unpkg.com` requests are proxied through Node's `fetch`
- Chromium is launched with `--ignore-certificate-errors`

None of this touches production code, and none of it is needed on a normal machine.
