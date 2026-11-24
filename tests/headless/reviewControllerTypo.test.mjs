/**
 * Regression test for the resolveController half of the 2026-11-23 daily
 * review findings: an unknown object-form controller key must fail fast
 * instead of silently running an idle player.
 *
 * Spawns the tournament against suite.review-typo.json (first player has
 * {"key": "typo-controller-xyz"}) and expects a non-zero exit with
 * "Unknown controller" in the output.
 *
 * Run from tests/headless:
 *   node --import ./preload.mjs ./reviewControllerTypo.test.mjs
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  ['--import', './preload.mjs', './tournament.mjs', '--config', 'suite.review-typo.json'],
  { encoding: 'utf8', timeout: 60000 },
);
const output = `${result.stdout || ''}\n${result.stderr || ''}`;
const failedFast = result.status !== 0 && output.includes('Unknown controller');
if (failedFast) {
  console.log('reviewControllerTypo: PASS');
  process.exit(0);
}
console.error(`reviewControllerTypo: FAIL (exit=${result.status}, stdout/stderr did not show a fail-fast "Unknown controller" error)`);
console.error(output.slice(-2000));
process.exit(1);
