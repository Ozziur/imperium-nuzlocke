// Emulatore: core mGBA per libretro compilato in WebAssembly, senza thread.
// La build senza thread funziona anche nella WebView di Android, dove
// SharedArrayBuffer non è disponibile.
import { kv } from './storage.js';

const CORE_JS = 'vendor/libretro/mgba_libretro.js';
const CORE_WASM = 'vendor/libretro/mgba_libretro.wasm';
const SAVE_DIR = '/data/saves';

// Indici del joypad RetroArch.
const BTN = { B: 0, Select: 2, Start: 3, Up: 4, Down: 5, Left: 6, Right: 7, A: 8, L: 10, R: 11 };

const RETROARCH_CFG = (rewind) =>
  [
    'autosave_interval = 10',
    'savefile_directory = "/data/saves"',
    'savestate_directory = "/data/states"',
    'sort_savefiles_enable = false',
    'sort_savestates_enable = false',
    'sort_savefiles_by_content_enable = false',
    'sort_savestates_by_content_enable = false',
    'block_sram_overwrite = false',
    'audio_latency = 64',
    'video_vsync = true',
    'video_smooth = false',
    'video_font_enable = false',
    'menu_enable_widgets = false',
    'notification_show_autoconfig = false',
    'fastforward_ratio = 2.0',
    rewind ? 'rewind_enable = true' : 'rewind_enable = false',
    'rewind_granularity = 2',
    'rewind_buffer_size = 50',
    'input_auto_game_focus = 0',
    'input_auto_mouse_grab = false',
    'pause_nonactive = false',
  ].join('\n') + '\n';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.EJS_Runtime) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Core dell’emulatore non trovato.'));
    document.head.appendChild(s);
  });
}

export class Emulator {
  constructor(canvas) {
    this.canvas = canvas;
    this.mod = null;
    this.fn = null;
    this.running = false;
    this.paused = false;
    this.runId = null;
    this.speed = 1;
    this._timers = [];
  }

  async init() {
    if (this.mod) return;
    // Il core prova a catturare il puntatore (pointer lock): bloccherebbe i tocchi sull'interfaccia.
    this.canvas.requestPointerLock = () => {};
    await loadScript(CORE_JS);
    this.mod = await window.EJS_Runtime({
      noInitialRun: true,
      canvas: this.canvas,
      parent: this.canvas.parentElement, // il core vi aggancia gli eventi di tastiera
      arguments: [],
      preRun: [],
      postRun: [],
      callbacks: {},
      print: () => {},
      printErr: (m) => this.debug && console.log(m),
      totalDependencies: 0,
      locateFile: (f) => (f.endsWith('.wasm') ? CORE_WASM : f),
      getSavExt: () => '.srm',
    });
    const c = (name, ret, args) => this.mod.cwrap(name, ret, args);
    this.fn = {
      simulateInput: c('simulate_input', 'null', ['number', 'number', 'number']),
      toggleMainLoop: c('toggleMainLoop', 'null', ['number']),
      saveStateInfo: c('save_state_info', 'string', []),
      loadState: c('load_state', 'number', ['string', 'number']),
      saveFiles: c('cmd_savefiles', '', []),
      saveFilePath: c('save_file_path', 'string', []),
      toggleFastForward: c('toggle_fastforward', 'null', ['number']),
      setFastForwardRatio: c('set_ff_ratio', 'null', ['number']),
      toggleRewind: c('toggle_rewind', 'null', ['number']),
      restart: c('system_restart', '', []),
      setKeyboard: c('ejs_set_keyboard_enabled', 'null', ['number']),
    };
    this.mod.callbacks.setupCoreSettingFile = (path) => this._write(path, 'mgba_skip_bios = "ON"\n');
    this._mkdir('/data');
    this._mkdir(SAVE_DIR);
    this._mkdir('/data/states');
    this.fs.mount(this.fs.filesystems.IDBFS, {}, SAVE_DIR);
    await new Promise((r) => this.fs.syncfs(true, r));
  }

  get fs() {
    return this.mod.FS;
  }

  _mkdir(p) {
    try {
      this.fs.mkdir(p);
    } catch {
      /* esiste già */
    }
  }

  _write(path, data) {
    let cur = '';
    for (const part of path.split('/').slice(0, -1)) {
      if (!part) continue;
      cur += '/' + part;
      this._mkdir(cur);
    }
    this.fs.writeFile(path, data);
  }

  // ---------- ROM ----------

  async hasRom() {
    return !!(await kv.get('rom-patched'));
  }

  async writeRom(bytes) {
    await kv.set('rom-patched', bytes);
  }

  // ---------- ciclo di vita ----------

  /** Avvia una run. Il core non può cambiare gioco: per cambiare run si ricarica la pagina. */
  async start(runId, { rewind = false, volume = 1 } = {}) {
    if (this.running) throw new Error('Emulatore già avviato');
    const rom = await kv.get('rom-patched');
    if (!rom) throw new Error('Gioco non installato.');
    this.runId = runId;
    this.rewindEnabled = rewind;
    this._write('/home/web_user/.config/retroarch/retroarch.cfg', RETROARCH_CFG(rewind));
    this._write(`/run-${runId}.gba`, rom);
    this.mod.callMain([`/run-${runId}.gba`]);
    this.mod.resumeMainLoop();
    try {
      this.fn.setKeyboard(1);
    } catch {
      /* versioni senza tastiera */
    }
    this.running = true;
    this.volume = volume;

    // riprende da dove si era lasciato (stato automatico)
    const auto = await kv.get(this._autoKey());
    if (auto) setTimeout(() => this._loadStateBytes(auto), 400);

    this._timers.push(setInterval(() => this.sync(), 15000));
    this._timers.push(setInterval(() => this.saveAutoState(), 30000));
    setTimeout(() => this.setVolume(volume), 1000);
  }

  _autoKey(runId = this.runId) {
    return `auto:${runId}`;
  }

  _stateKey(slot, runId = this.runId) {
    return `state:${runId}:${slot}`;
  }

  pause() {
    if (!this.running || this.paused) return;
    this.fn.toggleMainLoop(0);
    this.paused = true;
  }

  resume() {
    if (!this.running || !this.paused) return;
    this.fn.toggleMainLoop(1);
    this.paused = false;
  }

  /** Salva tutto prima di chiudere o cambiare run. */
  async flush() {
    if (!this.running) return;
    await this.saveAutoState();
    await this.sync();
  }

  async sync() {
    if (!this.running) return;
    try {
      this.fn.saveFiles();
      await new Promise((r) => this.fs.syncfs(false, r));
    } catch (e) {
      console.warn('sync', e);
    }
  }

  // ---------- input ----------

  press(btn) {
    if (this.running && BTN[btn] != null) this.fn.simulateInput(0, BTN[btn], 1);
  }

  release(btn) {
    if (this.running && BTN[btn] != null) this.fn.simulateInput(0, BTN[btn], 0);
  }

  setSpeed(mult) {
    if (!this.running) return;
    this.speed = mult;
    if (mult > 1) {
      this.fn.setFastForwardRatio(mult);
      this.fn.toggleFastForward(1);
    } else this.fn.toggleFastForward(0);
  }

  rewind(on) {
    if (this.running && this.rewindEnabled) this.fn.toggleRewind(on ? 1 : 0);
  }

  // ---------- stati ----------

  getStateBytes() {
    const [size, ptr, ok] = this.fn.saveStateInfo().split('|');
    if (ok !== '1') throw new Error('Stato non disponibile');
    return new Uint8Array(this.mod.HEAPU8.subarray(Number(ptr), Number(ptr) + Number(size)));
  }

  _loadStateBytes(bytes) {
    try {
      this.fs.unlink('/game.state');
    } catch {
      /* non esiste */
    }
    this.fs.writeFile('/game.state', bytes);
    return this.fn.loadState('/game.state', 0) !== 0 || true;
  }

  async saveAutoState() {
    if (!this.running) return;
    try {
      await kv.set(this._autoKey(), this.getStateBytes());
    } catch (e) {
      console.warn('auto-state', e);
    }
  }

  async saveState(slot) {
    try {
      await kv.set(this._stateKey(slot), { t: Date.now(), data: this.getStateBytes() });
      return true;
    } catch {
      return false;
    }
  }

  async loadState(slot) {
    const s = await kv.get(this._stateKey(slot));
    if (!s) return false;
    return this._loadStateBytes(s.data);
  }

  async stateInfo(slot) {
    const s = await kv.get(this._stateKey(slot));
    return s ? { t: s.t } : null;
  }

  // ---------- salvataggio di gioco ----------

  savePathFor(runId) {
    return `${SAVE_DIR}/run-${runId}.srm`;
  }

  getSave() {
    if (!this.running) return null;
    this.fn.saveFiles();
    const p = this.savePathFor(this.runId);
    return this.fs.analyzePath(p).exists ? this.fs.readFile(p) : null;
  }

  async importSave(runId, bytes) {
    this.fs.writeFile(this.savePathFor(runId), bytes);
    await kv.del(this._autoKey(runId)); // altrimenti riprenderebbe dallo stato vecchio
    await new Promise((r) => this.fs.syncfs(false, r));
  }

  async deleteRunFiles(runId) {
    try {
      this.fs.unlink(this.savePathFor(runId));
    } catch {
      /* non esiste */
    }
    await new Promise((r) => this.fs.syncfs(false, r));
    await kv.del(this._autoKey(runId));
    for (const s of [1, 2, 3, 4]) await kv.del(this._stateKey(s, runId));
  }

  // ---------- audio ----------

  _audioSources() {
    const src = this.mod?.AL?.currentCtx?.sources;
    return src ? Object.values(src) : [];
  }

  setVolume(v) {
    this.volume = v;
    for (const s of this._audioSources()) if (s?.gain?.gain) s.gain.gain.value = v;
  }

  resumeAudio() {
    try {
      const ctx = this.mod?.AL?.currentCtx?.audioCtx;
      if (ctx && ctx.state !== 'running') ctx.resume();
    } catch {
      /* ignora */
    }
  }
}
