// Controlli touch: croce direzionale a scorrimento (8 direzioni) e pulsanti multi-touch.

const DIRS = ['Up', 'Down', 'Left', 'Right'];

function haptic(ms = 8) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* ignora */
  }
}

export function setupControls(root, emu, opts = {}) {
  const held = new Map(); // pointerId -> Set di pulsanti
  const counts = new Map(); // pulsante -> numero di dita che lo tengono

  const down = (btn) => {
    const n = (counts.get(btn) || 0) + 1;
    counts.set(btn, n);
    if (n === 1) {
      emu.press(btn);
      if (opts.haptics !== false) haptic();
      root.querySelectorAll(`[data-btn="${btn}"], [data-dir="${btn}"]`).forEach((el) => el.classList.add('on'));
    }
  };
  const up = (btn) => {
    const n = (counts.get(btn) || 0) - 1;
    if (n <= 0) {
      counts.delete(btn);
      emu.release(btn);
      root.querySelectorAll(`[data-btn="${btn}"], [data-dir="${btn}"]`).forEach((el) => el.classList.remove('on'));
    } else counts.set(btn, n);
  };

  const setHeld = (id, next) => {
    const prev = held.get(id) || new Set();
    for (const b of prev) if (!next.has(b)) up(b);
    for (const b of next) if (!prev.has(b)) down(b);
    held.set(id, next);
  };

  // D-pad: la direzione dipende dall'angolo rispetto al centro, con zona morta.
  const dpadDirs = (el, x, y) => {
    const r = el.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    const dead = r.width * 0.12;
    const s = new Set();
    if (Math.hypot(dx, dy) < dead) return s;
    const a = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180, 0 = destra
    if (a > -67.5 && a < 67.5) s.add('Right');
    if (a > 112.5 || a < -112.5) s.add('Left');
    if (a > 22.5 && a < 157.5) s.add('Down');
    if (a < -22.5 && a > -157.5) s.add('Up');
    return s;
  };

  const targetFor = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el?.closest('[data-btn], .dpad');
  };

  const update = (e) => {
    const el = targetFor(e.clientX, e.clientY);
    let next = new Set();
    if (el?.classList.contains('dpad')) next = dpadDirs(el, e.clientX, e.clientY);
    else if (el?.dataset.btn && !DIRS.includes(el.dataset.btn)) {
      // AB: premere tra A e B li preme entrambi.
      next = new Set(el.dataset.btn.split('+'));
    }
    setHeld(e.pointerId, next);
  };

  root.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('[data-btn], .dpad')) return;
    e.preventDefault();
    root.setPointerCapture?.(e.pointerId);
    emu.resumeAudio();
    update(e);
  });
  root.addEventListener('pointermove', (e) => {
    if (held.has(e.pointerId)) update(e);
  });
  const end = (e) => {
    if (!held.has(e.pointerId)) return;
    setHeld(e.pointerId, new Set());
    held.delete(e.pointerId);
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  root.addEventListener('contextmenu', (e) => e.preventDefault());

  // Rilascia tutto se l'app va in background.
  return {
    releaseAll() {
      for (const id of [...held.keys()]) {
        setHeld(id, new Set());
        held.delete(id);
      }
    },
  };
}
