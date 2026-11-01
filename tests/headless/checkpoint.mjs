/**
 * Checkpoint/resume for the headless harness.
 *
 * Design (see README.md "Checkpoint / resume" for the full story):
 *
 * - The checkpoint is the production save payload: GameState.serialize()
 *   output, i.e. exactly what saveManager stores as `record.data` in the
 *   browser. The saveManager itself is IndexedDB-only, so it cannot run
 *   under Node; the harness stores the same payload as a plain file
 *   instead. No game serialization code is duplicated here.
 * - One checkpoint file per run directory: <dir>/checkpoint.json.
 *   It is overwritten at every round end (atomic tmp-file + rename, so a
 *   kill mid-write leaves the previous round's checkpoint intact).
 * - Granularity is whole rounds. A kill mid-round loses that round's
 *   partial progress; resume replays the partial round from its start.
 *   Rounds whose onRoundEnd() completed are never replayed.
 * - Checkpoint files never carry credentials: serialize() embeds
 *   settings verbatim, and settings.llm can hold an apiKey (config
 *   ${VAR} expansion), so the key is stripped on write. Resume takes
 *   credentials — and per-player controllers — from its own --config.
 * - Resume refuses: a missing/malformed checkpoint, a completed game
 *   (gameOver, or rounds already >= the config's turn total), and a
 *   player-list mismatch against the config.
 */
import { mkdirSync, renameSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs';
import path from 'path';

export const CHECKPOINT_FILE = 'checkpoint.json';

/**
 * --resume accepts a run directory or a checkpoint file directly.
 * A nonexistent path is treated as a directory (it must exist by resume
 * time; this only affects the error message, not the outcome).
 */
export function resolveCheckpointPath(resumeArg) {
  let st = null;
  try {
    st = statSync(resumeArg);
  } catch {
    // Not an existing path; fall through to directory treatment.
  }
  if (st && st.isFile()) return resumeArg;
  return path.join(resumeArg, CHECKPOINT_FILE);
}

/**
 * Atomically writes the current game state to <dir>/checkpoint.json.
 * Returns { path, bytes, round, gameOver } for logging.
 */
export function saveCheckpoint(dir, gameState) {
  mkdirSync(dir, { recursive: true });
  const data = JSON.parse(gameState.serialize());
  // Never persist credentials in checkpoint files (see header).
  if (data.settings?.llm) delete data.settings.llm.apiKey;
  const payload = JSON.stringify(data);
  const tmp = path.join(dir, `.${CHECKPOINT_FILE}.tmp-${process.pid}`);
  const final = path.join(dir, CHECKPOINT_FILE);
  writeFileSync(tmp, payload, 'utf-8');
  renameSync(tmp, final);
  return { path: final, bytes: payload.length, round: data.currentRound, gameOver: data.gameOver };
}

/**
 * Loads and shape-validates a checkpoint file. Returns { raw, data }:
 * raw is the exact file text (passed to deserialize untouched), data is
 * the parsed object (used for resume validation).
 */
export function loadCheckpoint(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`checkpoint not found: ${filePath}`);
  }
  let data;
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`checkpoint is not valid JSON: ${filePath} (${e.message})`);
  }
  if (
    !data ||
    !Array.isArray(data.players) ||
    !Array.isArray(data.entities) ||
    !data.cells ||
    typeof data.currentRound !== 'number'
  ) {
    throw new Error(`checkpoint has unexpected shape (not a game save): ${filePath}`);
  }
  return { raw, data };
}
