# Modal Browser Tests

Drives the real game in a cloud GPU browser (Modal T4) using Playwright. Clicks through the actual UI like a player would.

**What it tests:** Full integration — the game loads, UI works, turns advance, no console errors. Catches issues headless can't (DOM problems, asset loading, real browser behavior).

**What it does NOT test (yet):** LLM AI (uses SmartManager only).

## Usage

```bash
# 3 turns (default)
~/workspace/modal-gpu-browser/venv/bin/modal run tests/modal/modal-player.py --turns 3
```

## Requirements

- Modal token in `~/.modal.toml` (mode 600) — never commit it
- T4 GPU only, Empires testing only
- **Start the GPU only for active tests, stop immediately after**

## Cost

~$0.10–0.20 per 20-turn game on the T4.

## What it does

1. Starts Modal T4 container with Playwright + Chromium (in-container, no CDP tunnel)
2. Loads the dev deploy
3. Configures a small map (32 rings — the default 64 crashes tabs during screenshots) with 2 AI players
4. Clicks Start — the AI auto-plays via the game's own `nextTurn()` chain
5. Each round: screenshot + reads the autosave from IndexedDB (production save path) to check for NaN/negative values
6. Handles the victory modal as valid completion
7. Reports: turns played, console errors, screenshots

Screenshots save to `tests/modal/screenshots/` (gitignored).

## Adding LLM testing

Enter the API key in the game's setup UI via Playwright before starting. Free tier options (Oct 2026): Google Gemini Flash, Groq.
