/**
 * src/audio.js — Tiny Web Audio SFX manager for Empires.
 *
 * No dependencies, no build step: plain Web Audio API.
 *
 * Everything is config-driven:
 *  - File names come from manifest.json:
 *      * per-entity:  entities[].sfx = { select, action, build, damage, destroy }
 *      * global UI:   sfx.ui = { click, turn }, sfx.basePath = "assets/audio/"
 *  - Master switch + volume come from CONFIG (src/config.js):
 *      * AUDIO_ENABLED (bool, default true)
 *      * AUDIO_VOLUME  (0..1,  default 0.8)
 *    Both are query-param overridable like every other CONFIG key.
 *
 * The AudioContext is created lazily and only unlocked on the first user
 * gesture (browser autoplay policy). play*() calls made before unlock, while
 * muted, or while disabled are silent no-ops — never throw.
 */

import { CONFIG } from './config.js';

const MAX_VOICES = 10;          // hard cap on overlapping sounds (AI turns get busy)
const RETRIGGER_MS = 70;        // min gap before the same file may play again

class AudioManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buffers = new Map();   // filename -> AudioBuffer
    this.failed = new Set();    // filenames that failed to load (warn once)
    this.lastPlay = new Map();  // filename -> timestamp of last play
    this.activeVoices = 0;
    this.basePath = 'assets/audio/';
    this.uiSounds = {};
    this._muted = false;
    this._unlocked = false;
    this._initDone = false;
  }

  /** Idempotent. Safe to call at startup; actual unlock happens on first gesture. */
  init() {
    if (this._initDone) return;
    this._initDone = true;
    const unlock = () => this._ensureContext();
    window.addEventListener('pointerdown', unlock, { once: false });
    window.addEventListener('keydown', unlock, { once: false });
    // Try right away too — if the context is already allowed it just works.
    this._ensureContext();
  }

  /** Hand the manager the loaded manifest so it can resolve file names. */
  setManifest(manifest) {
    if (!manifest) return;
    const sfx = manifest.sfx || {};
    if (typeof sfx.basePath === 'string' && sfx.basePath) this.basePath = sfx.basePath;
    if (sfx.ui && typeof sfx.ui === 'object') this.uiSounds = sfx.ui;
  }

  get muted() {
    return this._muted;
  }

  setMuted(m) {
    this._muted = !!m;
  }

  toggleMute() {
    this.setMuted(!this._muted);
    return this._muted;
  }

  _ensureContext() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this._volume();
      this.master.connect(this.ctx.destination);
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      } else {
        this._unlocked = true;
      }
      this.ctx.onstatechange = () => {
        this._unlocked = this.ctx.state === 'running';
      };
    } catch (e) {
      console.warn('[audio] AudioContext unavailable:', e);
      this.ctx = null;
    }
  }

  _volume() {
    const v = Number(CONFIG.AUDIO_VOLUME);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
  }

  _enabled() {
    return CONFIG.AUDIO_ENABLED !== false && !this._muted;
  }

  async _loadBuffer(filename) {
    if (this.buffers.has(filename)) return this.buffers.get(filename);
    if (this.failed.has(filename)) return null;
    this._ensureContext();
    if (!this.ctx) return null;
    try {
      const res = await fetch(this.basePath + filename);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(data);
      this.buffers.set(filename, buf);
      return buf;
    } catch (e) {
      this.failed.add(filename);
      console.warn(`[audio] Could not load "${this.basePath + filename}":`, e.message || e);
      return null;
    }
  }

  /** Play a raw file name (relative to basePath). Fire-and-forget. */
  playFile(filename, { volume = 1 } = {}) {
    if (!filename || !this._enabled()) return;
    const now = performance.now();
    if (now - (this.lastPlay.get(filename) || 0) < RETRIGGER_MS) return;
    if (this.activeVoices >= MAX_VOICES) return;
    this.lastPlay.set(filename, now);
    this._ensureContext();
    if (!this.ctx || this.ctx.state !== 'running') return;
    this._loadBuffer(filename).then((buf) => {
      if (!buf || !this._enabled() || this.ctx.state !== 'running') return;
      if (this.activeVoices >= MAX_VOICES) return;
      try {
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        const gain = this.ctx.createGain();
        gain.gain.value = Math.min(1, Math.max(0, volume));
        src.connect(gain);
        gain.connect(this.master);
        this.activeVoices++;
        src.onended = () => { this.activeVoices = Math.max(0, this.activeVoices - 1); };
        src.start();
      } catch (e) {
        console.warn('[audio] playback failed:', e);
      }
    });
  }

  /**
   * Play an entity's configured sound for an event.
   * eventName: 'select' | 'action' | 'build' | 'damage' | 'destroy'
   * The manifest value may be a plain file name, or — for 'action' — an
   * object keyed by action name ({ move, attack, default }) so different
   * actions can have different sounds. Pass the action name as subName.
   */
  playEntitySfx(entity, eventName, subName) {
    const sfx = entity && (entity.data?.sfx || entity.sfx);
    let entry = sfx && sfx[eventName];
    if (entry && typeof entry === 'object' && subName) {
      entry = entry[String(subName).toLowerCase()] || entry.default;
    }
    if (typeof entry === 'string') this.playFile(entry);
  }

  /** Play a global UI sound from manifest sfx.ui (e.g. 'click', 'turn'). */
  playUi(name, opts) {
    const filename = this.uiSounds[name];
    if (filename) this.playFile(filename, opts);
  }

  /** Preload a list of file names so first plays have no fetch lag. */
  preload(filenames) {
    for (const f of filenames || []) this._loadBuffer(f);
  }
}

export const audio = new AudioManager();
