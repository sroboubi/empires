/**
 * Node preload for the headless harness.
 *
 * `--experimental-loader ./loader.mjs` is deprecated and prints an
 * ExperimentalWarning on every process. Node's replacement is
 * `module.register()`, which installs the same loader hooks without the
 * warning. Importing stubs first keeps the browser globals in place before
 * any game module is evaluated.
 */
import './stubs.mjs';
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
