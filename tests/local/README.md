# Local Browser Tests

Runs the real game in **headless Chromium on this machine** — no Modal, no cloud, no GPU.

This is the cheap middle ground between `tests/headless` (game logic only, no DOM) and `tests/modal`
(real GPU in the cloud). It catches integration problems locally: module load failures, CDN/asset
problems, rendering that never draws a frame, and broken autosave state.

**What it tests:** the page loads without errors, the setup modal works, a game starts, turns advance,
WebGL draws real frames, and the production IndexedDB autosave has no NaN/negative values and
contains structurally valid trade agreements (distinct participants, non-empty positive bundles).

**What it does NOT test:** real GPU output (SwiftShader is a software rasterizer), LLM players
(see the optional LLM test below), and pixel-perfect visuals.

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

## Optional: real local LLM trade test

```bash
npm run test:llm
```

This loads the **real `LlmBaseManager`** (including Ajv via esm.sh) against a local
OpenAI-compatible model and exercises the AI-initiated trade flow:

1. the AI initiates a one-time offer and the human accepts;
2. the AI initiates again and the human counters;
3. the production `handleTradeOffer()` asks the real model for the decision.

It **skips cleanly (exit 0)** when no local endpoint/model or Chromium is available, so it is safe
to keep alongside the normal smoke test. Set `LOCAL_BASE_URL` to use one specific endpoint;
otherwise it auto-detects `http://localhost:1234/v1`, `http://127.0.0.1:1234/v1`, then
`http://host.docker.internal:1234/v1` (the sandbox case).

Environment:

| Variable | Default | Purpose |
|---|---|---|
| `LOCAL_BASE_URL` | auto-detect | OpenAI-compatible base URL (without `/chat/completions`) |
| `LOCAL_MODEL` | `google/gemma-4-e4b` | Model ID to use; must appear in `/v1/models` |
| `LOCAL_TIMEOUT_MS` | `240000` | Per-request timeout; the first call may load the model |
| `LOCAL_API_KEY` | unset | Sent only when set; local servers usually ignore it |
| `CHROME` | `/usr/bin/chromium` | Browser executable |
| `MAP` / `SETTLE_MS` | `16` / `12000` | Same as `smoke.mjs` |

The test rewrites the served `definitions/ai.json` (local provider URL, model, timeout) for the
browser session only; production files are untouched. A decided counter-offer, acceptance, or
rejection all pass — the assertion is that the real model produced a valid decision and the UI
applied it without errors.

## Sandbox notes

The `sbx` proxy blocks the game's CDN imports and MITMs TLS, so the harness (not the game) works
around it:

- `https://esm.sh/simplex-noise@4.0.3` is served from `tests/headless/node_modules/simplex-noise`
- `unpkg.com` requests are proxied through Node's `fetch`
- Chromium is launched with `--ignore-certificate-errors`

None of this touches production code, and none of it is needed on a normal machine.
