"""
Modal GPU browser automated player test for Empires.

Drives the real game in a cloud GPU browser (Modal T4) using Playwright.
Clicks through the actual UI like a player would: starts a new game with
2 AI players (SmartManager, no LLM), advances N turns, and verifies the
game stays healthy.

What it checks:
- Game loads without console errors
- Turns advance (round number increments)
- No NaN/negative values in game state (via autosave inspection)
- Game remains responsive throughout

Usage:
    ~/workspace/modal-gpu-browser/venv/bin/modal run tests/modal-player.py --turns 3

Requirements:
- Modal token in ~/.modal.toml (mode 600)
- venv at ~/workspace/modal-gpu-browser/venv with modal[api-proxy-support]
- T4 GPU only. Start the GPU only for active tests, stop immediately after.

Cost: ~$0.10-0.20 per 20-turn game on the T4.

Screenshots are saved to tests/screenshots/turn-N.png
"""

import modal
import json
import sys
import os
import base64
import re
from datetime import datetime

app = modal.App("empires-modal-player")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "libvulkan1",
        "vulkan-tools",
        "libgl1-mesa-glx",
        "libegl1",
        "dbus",
    )
    .pip_install("playwright")
    .run_commands("playwright install --with-deps chromium")
)

GAME_URL = "https://grand-empires-dev.netlify.app/"


@app.function(image=image, gpu="T4", timeout=1800)
def run_player_test(turns: int = 3):
    from playwright.sync_api import sync_playwright

    results = {
        "turns_requested": turns,
        "turns_completed": 0,
        "console_errors": [],
        "page_errors": [],
        "state_checks": [],
        "screenshots": [],
        "webgl_renderer": None,
        "real_gpu": False,
        "game_responsive": False,
        "victory": False,
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--use-gl=angle",
                "--use-angle=vulkan",
                "--enable-unsafe-swiftshader",
                "--disable-dev-shm-usage",
                "--no-sandbox",
            ],
        )
        page = browser.new_page(viewport={"width": 1280, "height": 800})

        def on_console(msg):
            if msg.type == "error":
                results["console_errors"].append(msg.text[:500])

        def on_pageerror(err):
            results["page_errors"].append(str(err)[:500])

        page.on("console", on_console)
        page.on("pageerror", on_pageerror)

        print(f"Loading {GAME_URL}...", flush=True)
        page.goto(GAME_URL, wait_until="domcontentloaded", timeout=120000)
        page.wait_for_selector("#setup-modal-overlay.active", timeout=120000)
        print("Setup modal visible", flush=True)
        page.wait_for_timeout(3000)

        renderer = page.evaluate("""() => {
            const c = document.createElement('canvas');
            const gl = c.getContext('webgl2');
            if (!gl) return 'no-webgl2';
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
        }""")
        results["webgl_renderer"] = renderer
        results["real_gpu"] = "NVIDIA" in str(renderer)
        print(f"WebGL: {renderer} (real GPU: {results['real_gpu']})", flush=True)

        page.fill("#setup-autosave-interval", "1")
        print("Autosave interval set to 1", flush=True)
        page.select_option("#setup-map-size", "32")
        print("Map size set to 32 (smoke test)", flush=True)

        player_rows = page.query_selector_all("#setup-players-container .dynamic-row")
        print(f"Found {len(player_rows)} player rows", flush=True)
        for row in player_rows:
            checkbox = row.query_selector(".ai-checkbox")
            if checkbox and not checkbox.is_checked():
                checkbox.check()
        print("All players set to AI", flush=True)

        page.click("#btn-start-game")
        print("Clicked Start Game", flush=True)
        page.wait_for_timeout(5000)

        modal_state = page.evaluate("""() => {
            const overlay = document.getElementById('setup-modal-overlay');
            return {
                modalActive: overlay ? overlay.classList.contains('active') : null,
                btnExists: !!document.getElementById('btn-next-turn'),
                btnDisabled: document.getElementById('btn-next-turn')?.disabled,
                btnText: document.getElementById('btn-next-turn')?.textContent,
            };
        }""")
        print(f"After Start: {modal_state}", flush=True)

        try:
            debug_shot = page.screenshot()
            results["screenshots"].append({
                "turn": "debug-after-start",
                "data": base64.b64encode(debug_shot).decode("utf-8"),
            })
        except Exception as e:
            print(f"Screenshot failed (non-fatal): {e}", flush=True)

        try:
            page.wait_for_selector("#setup-modal-overlay:not(.active)", timeout=30000)
            print("Setup modal closed", flush=True)
        except Exception as e:
            print(f"Setup modal did not close: {e}", flush=True)
            raise

        print("Game started (AI auto-playing)", flush=True)

        try:
            screenshot = page.screenshot()
            results["screenshots"].append({
                "turn": 0,
                "data": base64.b64encode(screenshot).decode("utf-8"),
            })
        except Exception as e:
            print(f"Initial screenshot failed (non-fatal): {e}", flush=True)

        def get_round():
            try:
                header = page.query_selector("#players-list div")
                if header:
                    text = header.text_content()
                    m = re.search(r"ROUND (\d+)", text)
                    if m:
                        return int(m.group(1))
            except Exception:
                pass
            return None

        def is_game_over():
            try:
                modal = page.query_selector("#victory-modal-overlay.active")
                return modal is not None
            except Exception:
                return False

        def check_state():
            return page.evaluate("""async () => {
                try {
                    const db = await new Promise((resolve, reject) => {
                        const req = indexedDB.open('EmpiresDB', 1);
                        req.onsuccess = () => resolve(req.result);
                        req.onerror = () => reject(req.error);
                    });
                    const tx = db.transaction('saves', 'readonly');
                    const store = tx.objectStore('saves');
                    const index = store.index('timestamp');
                    const saves = await new Promise((resolve, reject) => {
                        const req = index.getAll();
                        req.onsuccess = () => resolve(req.result);
                        req.onerror = () => reject(req.error);
                    });
                    db.close();
                    if (!saves || saves.length === 0) {
                        return { ok: false, reason: 'No saves found' };
                    }
                    saves.sort((a, b) => b.timestamp - a.timestamp);
                    const latest = saves[0];
                    const data = JSON.parse(latest.data);
                    const checks = [];
                    if (typeof data.currentRound !== 'number' || isNaN(data.currentRound)) {
                        checks.push('currentRound is NaN or not a number');
                    }
                    if (!Array.isArray(data.entities)) {
                        checks.push('entities is not an array');
                    } else {
                        for (const e of data.entities) {
                            if (e.health !== undefined && (isNaN(e.health) || e.health < 0)) {
                                checks.push('Entity ' + e.id + ' has invalid health: ' + e.health);
                                break;
                            }
                        }
                    }
                    if (Array.isArray(data.players)) {
                        for (const pl of data.players) {
                            if (pl.orders !== undefined && (isNaN(pl.orders) || pl.orders < 0)) {
                                checks.push('Player ' + pl.name + ' has invalid orders: ' + pl.orders);
                                break;
                            }
                            if (pl.resources) {
                                for (const [res, val] of Object.entries(pl.resources)) {
                                    if (typeof val === 'number' && isNaN(val)) {
                                        checks.push('Player ' + pl.name + ' has NaN ' + res);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    return {
                        ok: checks.length === 0,
                        reason: checks.length > 0 ? checks.join('; ') : 'All checks passed',
                        round: data.currentRound,
                        entityCount: data.entities ? data.entities.length : 0,
                        playerCount: data.players ? data.players.length : 0,
                    };
                } catch (e) {
                    return { ok: false, reason: 'Error reading save: ' + e.message };
                }
            }""")

        initial_round = get_round()
        print(f"Initial round: {initial_round}", flush=True)

        if is_game_over():
            print("Game already over (victory) - test complete", flush=True)
            results["victory"] = True
            results["turns_completed"] = turns
            results["game_responsive"] = True
        else:
            print("AI auto-play in progress, monitoring rounds...", flush=True)
            last_round = initial_round or 1

            for turn in range(1, turns + 1):
                if is_game_over():
                    print(f"Game over (victory) during turn {turn}", flush=True)
                    results["victory"] = True
                    results["turns_completed"] = turns
                    break

                target_round = last_round + 1
                print(f"Waiting for round {target_round}...", flush=True)

                try:
                    page.wait_for_function(
                        """(target) => {
                            const header = document.querySelector('#players-list div');
                            if (!header) return false;
                            const m = header.textContent.match(/ROUND (\\d+)/);
                            return m && parseInt(m[1]) >= target;
                        }""",
                        arg=target_round,
                        timeout=300000,
                    )
                except Exception as e:
                    # Check if game ended instead of advancing
                    if is_game_over():
                        print(f"Game over (victory) instead of round {target_round}", flush=True)
                        results["victory"] = True
                        results["turns_completed"] = turns
                        break
                    print(f"Timeout waiting for round {target_round}: {e}", flush=True)
                    results["state_checks"].append({
                        "turn": turn,
                        "passed": False,
                        "reason": f"Timeout waiting for round {target_round}",
                    })
                    break

                current_round = get_round()
                print(f"Round {current_round} reached", flush=True)
                results["turns_completed"] = turn
                last_round = current_round or last_round

                try:
                    screenshot = page.screenshot()
                    results["screenshots"].append({
                        "turn": turn,
                        "data": base64.b64encode(screenshot).decode("utf-8"),
                    })
                except Exception as e:
                    print(f"  Screenshot failed (non-fatal): {e}", flush=True)

                state_check = check_state()
                results["state_checks"].append({
                    "turn": turn,
                    "passed": state_check.get("ok", False),
                    "reason": state_check.get("reason", "unknown"),
                    "round": state_check.get("round"),
                    "entityCount": state_check.get("entityCount"),
                    "playerCount": state_check.get("playerCount"),
                })
                print(f"  State check: {state_check.get('reason')}", flush=True)
                page.wait_for_timeout(2000)

            try:
                btn = page.query_selector("#btn-next-turn")
                results["game_responsive"] = btn is not None
            except Exception:
                results["game_responsive"] = False
            print(f"Game responsive: {results['game_responsive']}", flush=True)

        browser.close()

    return results


@app.local_entrypoint()
def main(turns: int = 3):
    print(f"Starting Modal T4 test with {turns} turns...", flush=True)
    start = datetime.now()
    results = run_player_test.remote(turns)
    duration = (datetime.now() - start).total_seconds()

    print("\n" + "=" * 60)
    print("RESULTS")
    print("=" * 60)
    print(f"Duration: {duration:.1f}s")
    print(f"Turns: {results['turns_completed']}/{results['turns_requested']}")
    print(f"Victory (game completed): {results['victory']}")
    print(f"WebGL: {results['webgl_renderer']} (real GPU: {results['real_gpu']})")
    print(f"Game responsive: {results['game_responsive']}")
    print(f"\nConsole errors: {len(results['console_errors'])}")
    for e in results["console_errors"][:10]:
        print(f"  - {e}")
    print(f"\nPage errors: {len(results['page_errors'])}")
    for e in results["page_errors"][:10]:
        print(f"  - {e}")
    print("\nState checks:")
    for c in results["state_checks"]:
        status = "PASS" if c["passed"] else "FAIL"
        print(f"  Turn {c['turn']}: {status} - {c['reason']}")

    shot_dir = os.path.expanduser("~/workspace/empires-res/tests/screenshots")
    os.makedirs(shot_dir, exist_ok=True)
    for shot in results["screenshots"]:
        path = os.path.join(shot_dir, f"turn-{shot['turn']}.png")
        with open(path, "wb") as f:
            f.write(base64.b64decode(shot["data"]))
        print(f"Screenshot: {path}")
