import { Emulator } from './emulator.js';
import { setupControls } from './controls.js';
import { kv, requestPersistence } from './storage.js';
import * as P from './patcher.js';
import * as N from './nuzlocke.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isAndroid = () => !!window.AndroidBridge;

const app = {
  emu: null,
  run: null,
  data: null,
  controls: null,
  settings: { volume: 1, haptics: true, speed: 2 },
};

// ---------------------------------------------------------------- avvio

async function boot() {
  try {
    setBoot('Carico i dati di Imperium…');
    app.data = await N.loadData();
    app.settings = { ...app.settings, ...((await kv.get('settings')) || {}) };
    requestPersistence();

    setBoot('Avvio l’emulatore…');
    app.emu = new Emulator($('#screen'));
    await app.emu.init();

    if (!(await app.emu.hasRom())) return showSetup();
    await enterGame();
  } catch (e) {
    console.error(e);
    setBoot(`Errore all’avvio: ${e.message}`);
  }
}

function setBoot(msg) {
  $('#boot').hidden = false;
  $('#boot-msg').textContent = msg;
}

const hideBoot = () => ($('#boot').hidden = true);

// ---------------------------------------------------------------- configurazione

function showSetup() {
  hideBoot();
  $('#game').hidden = true;
  $('#setup').hidden = false;
  $('#rom-input').onchange = (e) => e.target.files[0] && runSetup(e.target.files[0], null);
  $('#patch-input').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    app.manualPatch = P.patchFromFile(f.name, new Uint8Array(await f.arrayBuffer()));
    setStep('patch', 'done', `Patch ${app.manualPatch.version} pronta (manuale)`);
  };
}

function setStep(step, state, text) {
  const li = $(`.steps [data-step="${step}"]`);
  li.className = state;
  if (text) li.querySelector('small').textContent = text;
}

function setProgress(frac) {
  const p = $('.progress');
  p.hidden = frac == null;
  if (frac != null) $('.progress .bar').style.width = `${Math.round(frac * 100)}%`;
}

async function runSetup(romFile) {
  const err = $('#setup-error');
  err.hidden = true;
  $('#pick-rom').classList.add('disabled');
  try {
    setStep('rom', 'active', 'Verifico…');
    const rom = new Uint8Array(await romFile.arrayBuffer());
    const crc = P.crc32(rom);
    if (crc !== P.EMERALD_US_CRC32) {
      setStep('rom', 'fail', `CRC ${P.hex(crc)}: non è Emerald (USA) pulita`);
      throw new Error('Serve la ROM originale e non modificata di Pokémon Emerald (USA), CRC32 1F1C08FB.');
    }
    setStep('rom', 'done', 'Pokémon Emerald (USA) verificata');

    let patch = app.manualPatch;
    if (!patch) {
      setStep('patch', 'active', 'Scarico la patch ufficiale…');
      patch = await P.downloadLatestPatch((f) => setProgress(f));
    }
    setStep('patch', 'done', `Versione ${patch.version}`);

    setStep('apply', 'active', 'Applico la patch…');
    setProgress(0);
    await new Promise((r) => setTimeout(r, 30));
    const out = P.applyBps(rom, patch.bytes, setProgress);
    await app.emu.writeRom(out);
    await kv.set('rom-original', rom);
    await kv.set('install', { version: patch.version, crc: P.hex(P.crc32(out)), at: Date.now() });
    setStep('apply', 'done', 'Emerald Imperium installato');
    setProgress(null);
    await enterGame(true);
  } catch (e) {
    console.error(e);
    setProgress(null);
    err.textContent = e.message;
    err.hidden = false;
    if (!$('.steps .fail')) setStep(['rom', 'patch', 'apply'].find((s) => $(`.steps [data-step="${s}"]`).className === 'active') || 'apply', 'fail');
  } finally {
    $('#pick-rom').classList.remove('disabled');
    $('#rom-input').value = '';
  }
}

// ---------------------------------------------------------------- gioco

window.__enterGame = (...a) => enterGame(...a);
async function enterGame(firstTime = false) {
  $('#setup').hidden = true;
  $('#game').hidden = false;
  hideBoot();
  app.controls ??= setupControls($('#pad'), app.emu, { haptics: app.settings.haptics });
  bindTopbar();

  let runId = await kv.get('active-run');
  let run = runId && (await N.getRun(runId));
  if (!run) {
    const runs = await N.listRuns();
    run = runs[0] && (await N.getRun(runs[0].id));
  }
  if (!run) {
    // Prima volta: la run va creata prima di giocare.
    openSheet('Nuova partita', () => newRunView({ first: true }));
    return;
  }
  await startRun(run);
  if (firstTime) toast('Imperium installato. Buona run!');
}

async function startRun(run) {
  if (app.emu.running) return switchRun(run.id);
  app.run = run;
  await kv.set('active-run', run.id);
  await app.emu.start(run.id, { rewind: run.rules.nuzlocke ? run.rules.rewind !== 'block' : true, volume: app.settings.volume });
  app.emu.setSpeed(1);
  updateSpeedBadge();
  updateCapChip();
}

/** Il core carica un solo gioco per sessione: per cambiare run salva tutto e ricarica la pagina. */
async function switchRun(runId, { flush = true } = {}) {
  setBoot('Cambio partita…');
  if (flush) await app.emu.flush();
  await kv.set('active-run', runId);
  app.emu.running = false;
  location.reload();
}

async function persistRun() {
  if (app.run) await N.saveRun(app.run);
  updateCapChip();
}

function updateCapChip() {
  const chip = $('#cap-chip');
  const run = app.run;
  if (!run) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  const cap = N.currentCap(run);
  chip.textContent = run.capIndex >= app.data.caps.length ? 'Lega superata' : `Cap ${cap.level}`;
}

function updateSpeedBadge() {
  const s = app.emu.speed;
  $('#speed-badge').hidden = s === 1;
  $('#speed-badge').textContent = `${s}×`;
}

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function bindTopbar() {
  if (bindTopbar.done) return;
  bindTopbar.done = true;
  $('.topbar').addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]')?.dataset.action;
    if (!a) return;
    app.emu.resumeAudio();
    if (a === 'menu') openSheet('Menu', menuView);
    if (a === 'tracker') openTracker('zone');
    if (a === 'boss') openTracker('boss');
    if (a === 'states') openSheet('Salvataggi rapidi', statesView);
    if (a === 'speed') {
      const next = app.emu.speed === 1 ? app.settings.speed : 1;
      app.emu.setSpeed(next);
      updateSpeedBadge();
      toast(next === 1 ? 'Velocità normale' : `Avanti veloce ${next}×`, 1000);
    }
  });
}

// ---------------------------------------------------------------- pannelli

const sheet = { stack: [], tabs: null, tab: null };

function openSheet(title, view, tabs = null, tab = null) {
  app.emu?.pause();
  app.controls?.releaseAll();
  sheet.stack = [{ title, view }];
  sheet.shown = null;
  sheet.scrolledToNext = false;
  sheet.tabs = tabs;
  sheet.tab = tab;
  $('#sheet').hidden = false;
  render();
}

function pushView(title, view) {
  sheet.stack.push({ title, view });
  render();
}

function popView() {
  if (sheet.stack.length > 1) {
    sheet.stack.pop();
    render();
    return true;
  }
  return false;
}

function closeSheet() {
  if (!app.run) return; // senza run non si può giocare
  $('#sheet').hidden = true;
  sheet.stack = [];
  app.emu.resume();
}

function render() {
  const top = sheet.stack[sheet.stack.length - 1];
  if (!top) return;
  $('#sheet-title').textContent = top.title;
  const tabsEl = $('#sheet-tabs');
  const showTabs = sheet.tabs && sheet.stack.length === 1;
  tabsEl.hidden = !showTabs;
  if (showTabs) {
    tabsEl.innerHTML = sheet.tabs.map(([id, label]) => `<button data-tab="${id}" class="${id === sheet.tab ? 'on' : ''}">${label}</button>`).join('');
  }
  const body = $('#sheet-body');
  if (sheet.shown) sheet.shown.scroll = body.scrollTop; // ricorda dove era la vista precedente
  body.innerHTML = '';
  top.view(body);
  body.scrollTop = top.scroll || 0;
  sheet.shown = top;
}

$('#sheet').addEventListener('click', (e) => {
  if (e.target.id === 'sheet') return closeSheet();
  if (e.target.closest('[data-action="close"]')) return popView() || closeSheet();
  const t = e.target.closest('[data-tab]');
  if (t) {
    sheet.tab = t.dataset.tab;
    sheet.tabs = trackerTabs();
    sheet.stack = [{ title: 'Strumenti', view: trackerView }];
    render();
  }
});

window.onAndroidBack = () => {
  if (!$('#sheet').hidden) {
    if (!popView()) closeSheet();
    return true;
  }
  if (app.run) {
    openSheet('Menu', menuView);
    return true;
  }
  return false;
};
window.onAndroidPause = () => {
  app.controls?.releaseAll();
  app.emu?.pause();
  app.emu?.flush();
};
window.onAndroidResume = () => {
  if ($('#sheet').hidden) app.emu?.resume();
};
document.addEventListener('visibilitychange', () => (document.hidden ? window.onAndroidPause() : window.onAndroidResume()));

// piccolo aiuto per collegare i pulsanti dentro una vista
function on(root, sel, ev, fn) {
  root.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, (e) => fn(e, el)));
}

const typesHtml = (sid) => {
  const s = N.sp(sid);
  return s ? `<span class="types">${s.t.map((t) => `<span class="type t-${t}">${t}</span>`).join('')}</span>` : '';
};

// ---------------------------------------------------------------- tracker

// Gli strumenti funzionano in ogni partita; le regole Nuzlocke aggiungono solo vincoli e cimitero.
function trackerTabs() {
  const nz = app.run?.rules.nuzlocke;
  return [
    ['zone', 'Zone'],
    ['team', nz ? 'Squadra' : 'Catturati'],
    ...(nz ? [['grave', 'Cimitero']] : []),
    ['boss', 'Boss'],
    ['rules', 'Partita'],
  ];
}

function openTracker(tab) {
  if (!app.run) return;
  openSheet('Strumenti', trackerView, trackerTabs(), tab);
}

function trackerView(body) {
  ({ zone: zonesView, team: teamView, grave: graveView, boss: bossView, rules: rulesView })[sheet.tab](body);
}

function zonesView(body) {
  const run = app.run;
  const nz = run.rules.nuzlocke;
  const st = N.stats(run);
  const next = N.nextOpenArea(run);
  const byArea = {};
  for (const m of run.mons) byArea[m.area] = (byArea[m.area] || 0) + 1;
  body.innerHTML = `
    <div class="stats">${
      nz
        ? `<div class="stat"><b>${st.alive}</b><small>Vivi</small></div>
      <div class="stat"><b>${st.dead}</b><small>Caduti</small></div>
      <div class="stat"><b>${st.visited}/${st.total}</b><small>Zone</small></div>`
        : `<div class="stat"><b>${st.caught}</b><small>Catturati</small></div>
      <div class="stat"><b>${Object.keys(byArea).length}</b><small>Zone</small></div>
      <div class="stat"><b>${run.capIndex}/${app.data.caps.length}</b><small>Boss</small></div>`
    }</div>
    <input type="search" id="zone-search" placeholder="Cerca zona o Pokémon…">
    <div class="section-title">Zone in ordine di progressione</div>
    <div class="list" id="zone-list"></div>`;
  const list = $('#zone-list', body);
  const draw = (q = '') => {
    const ql = q.trim().toLowerCase();
    list.innerHTML = app.data.areas
      .filter((a) => {
        if (!ql) return true;
        if (a.name.toLowerCase().includes(ql)) return true;
        return a.enc.some((g) => g.p.some(([sid]) => N.spName(sid).toLowerCase().includes(ql)));
      })
      .map((a) => {
        const rec = run.areas[a.id];
        const fresh = N.areaHasFreshEncounter(run, a);
        let status = '';
        let sub = `${a.enc.reduce((n, g) => n + g.p.length, 0)} specie`;
        if (!nz) {
          const n = byArea[a.id];
          if (n) status = `<span class="status caught">${n} ${n === 1 ? 'catturato' : 'catturati'}</span>`;
          return `<div class="item" data-area="${a.id}"><div class="main"><b>${esc(a.name)}</b><small>${sub}</small></div>${status}</div>`;
        }
        if (rec?.status === 'caught') {
          const m = run.mons.find((x) => x.uid === rec.mon);
          status = `<span class="status ${m && !m.alive ? 'dead' : 'caught'}">${m && !m.alive ? 'Caduto' : 'Catturato'}</span>`;
          sub = esc(m ? m.nick || N.spName(m.sid) : N.spName(rec.sid));
        } else if (rec?.status === 'failed') {
          status = '<span class="status failed">Perso</span>';
        } else if (rec?.status === 'skipped') {
          status = '<span class="status skipped">Saltata</span>';
        } else if (a === next) {
          status = '<span class="status current">Prossima</span>';
        } else if (!fresh) {
          sub = 'Solo duplicati';
        }
        const dim = (rec && rec.status !== 'caught') || (!rec && !fresh);
        return `<div class="item ${dim ? 'dim' : ''}" data-area="${a.id}"><div class="main"><b>${esc(a.name)}</b><small>${sub}</small></div>${status}</div>`;
      })
      .join('') || '<p class="empty">Nessuna zona trovata.</p>';
  };
  draw();
  $('#zone-search', body).addEventListener('input', (e) => draw(e.target.value));
  list.addEventListener('click', (e) => {
    const id = e.target.closest('[data-area]')?.dataset.area;
    if (id) pushView(app.data.areaById[id].name, (b) => areaView(b, id));
  });
  if (next && !sheet.scrolledToNext) {
    sheet.scrolledToNext = true;
    requestAnimationFrame(() => list.querySelector(`[data-area="${next.id}"]`)?.scrollIntoView({ block: 'center' }));
  }
}

function areaView(body, areaId) {
  const run = app.run;
  const nz = run.rules.nuzlocke;
  const area = app.data.areaById[areaId];
  const rec = nz ? run.areas[areaId] : null;
  const groups = N.areaEncounters(run, area);
  let selected = null;

  const recHtml = () => {
    if (!rec) return '';
    const m = rec.mon && run.mons.find((x) => x.uid === rec.mon);
    const what = rec.status === 'caught' ? `Catturato: <b>${esc(m ? m.nick || N.spName(m.sid) : N.spName(rec.sid))}</b>` : rec.status === 'failed' ? 'Incontro perso' : 'Zona saltata';
    return `<div class="card row"><div class="grow">${what}</div><button class="btn small danger" id="area-reset">Annulla</button></div>`;
  };

  body.innerHTML = `
    ${recHtml()}
    <p class="hint">${!nz ? 'Specie che puoi trovare qui. Tocca un Pokémon per segnarlo tra i catturati.' : rec ? 'La zona è già registrata. Puoi comunque aggiungere uno shiny o un regalo, se le regole lo consentono.' : 'Tocca il Pokémon che hai incontrato per primo.'}</p>
    ${groups
      .map(
        (g) => `<div class="enc-group"><h4>${esc(g.label)}</h4><div class="mon-grid">${g.mons
          .map(
            (m) => `<div class="mon ${m.dupe ? 'dupe' : ''}" data-sid="${m.sid}" data-method="${g.method}">
              <b>${esc(N.spName(m.sid))}</b>${typesHtml(m.sid)}
              <span class="lv">${m.lv ? `Lv. ${m.lv}` : ''}${m.dupe ? ' <span class="tag">duplicato</span>' : ''}</span></div>`,
          )
          .join('')}</div></div>`,
      )
      .join('')}
    <div class="card" id="catch-form" hidden>
      <div class="field"><label>Soprannome (facoltativo)</label><input type="text" id="nick" maxlength="12" autocomplete="off"></div>
      <div class="toggle" id="shiny-t"><div class="main"><b>È shiny</b><small>${!nz ? 'Viene segnato con ✦' : run.rules.shiny ? 'Non consuma la zona' : 'Clausola shiny disattivata'}</small></div><div class="switch"></div></div>
      <div class="dialog-actions">
        ${nz ? '<button class="btn" id="btn-fail">Perso</button>' : ''}
        <button class="btn primary" id="btn-catch">${nz ? 'Catturato' : 'Aggiungi ai catturati'}</button>
      </div>
    </div>
    ${rec || !nz ? '' : '<button class="btn block" id="btn-skip" style="margin-top:8px">Salta zona (nessun incontro valido)</button>'}`;

  const form = $('#catch-form', body);
  on(body, '.mon', 'click', (e, el) => {
    body.querySelectorAll('.mon.sel').forEach((x) => x.classList.remove('sel'));
    el.classList.add('sel');
    selected = { sid: Number(el.dataset.sid), method: el.dataset.method, dupe: el.classList.contains('dupe') };
    form.hidden = false;
    if ($('#btn-fail', body)) $('#btn-fail', body).hidden = !!rec;
    form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (selected.dupe) toast('Duplicato: di solito si ignora e si aspetta un altro incontro');
  });
  $('#shiny-t', body).addEventListener('click', (e) => e.currentTarget.classList.toggle('on'));
  $('#btn-catch', body).addEventListener('click', async () => {
    if (!selected) return;
    const shiny = $('#shiny-t', body).classList.contains('on');
    const gift = selected.method === 'gift';
    if (rec && !(shiny && run.rules.shiny) && !(gift && run.rules.giftsFree)) {
      toast('La zona è già usata');
      return;
    }
    N.recordCatch(run, areaId, selected.sid, { nick: $('#nick', body).value, shiny, gift });
    await persistRun();
    popView();
    if (!nz) toast(`${N.spName(selected.sid)} aggiunto ai catturati`);
  });
  $('#btn-fail', body)?.addEventListener('click', async () => {
    N.recordFail(run, areaId, selected?.sid);
    await persistRun();
    popView();
  });
  $('#btn-skip', body)?.addEventListener('click', async () => {
    N.recordSkip(run, areaId);
    await persistRun();
    popView();
  });
  $('#area-reset', body)?.addEventListener('click', async () => {
    if (!confirm('Annullare la registrazione di questa zona? Il Pokémon collegato verrà rimosso.')) return;
    N.resetArea(run, areaId);
    await persistRun();
    popView();
  });
}

function monRow(m) {
  const area = app.data.areaById[m.area];
  const name = m.nick ? `${esc(m.nick)} <small>(${esc(N.spName(m.sid))})</small>` : esc(N.spName(m.sid));
  return `<div class="item" data-uid="${m.uid}"><div class="main"><b>${name}${m.shiny ? ' ✦' : ''}</b>
    <small>${m.alive ? esc(area?.name || '') : `Caduto${m.cause ? ': ' + esc(m.cause) : ''}`}</small></div>${typesHtml(m.sid)}</div>`;
}

function teamView(body) {
  const nz = app.run.rules.nuzlocke;
  const alive = app.run.mons.filter((m) => m.alive);
  body.innerHTML = alive.length
    ? `<p class="hint">${nz ? "Tutti i Pokémon vivi della run. Tocca per segnare una caduta o un'evoluzione." : "I Pokémon che hai segnato. Tocca per vedere statistiche ed evoluzioni."}</p><div class="list">${alive.map(monRow).join('')}</div>`
    : '<p class="empty">Nessun Pokémon segnato. Aggiungili dalla scheda Zone.</p>';
  on(body, '[data-uid]', 'click', (e, el) => {
    const m = app.run.mons.find((x) => x.uid === el.dataset.uid);
    pushView(m.nick || N.spName(m.sid), (b) => monView(b, m.uid));
  });
}

function monView(body, uid) {
  const run = app.run;
  const m = run.mons.find((x) => x.uid === uid);
  const s = N.sp(m.sid);
  const evos = (s?.e || []).filter(([id]) => N.sp(id));
  const cap = N.currentCap(run);
  const stats = s ? ['PS', 'Att', 'Dif', 'AttSp', 'DifSp', 'Vel'].map((l, i) => `<span>${l} <b>${s.s[i]}</b></span>`).join(' · ') : '';
  body.innerHTML = `
    <div class="card"><div class="row"><b class="grow">${esc(N.spName(m.sid))}</b>${typesHtml(m.sid)}</div>
      <small>${stats}</small><br><small>Abilità: ${esc((s?.a || []).filter(Boolean).join(', '))}</small><br>
      <small>Catturato a ${esc(app.data.areaById[m.area]?.name || '?')}</small></div>
    <div class="field"><label>Soprannome</label><input type="text" id="nick" maxlength="12" value="${esc(m.nick)}"></div>
    ${evos.length ? `<div class="section-title">Evoluzione</div><div class="row wrap">${evos.map(([id]) => `<button class="btn small" data-evo="${id}">→ ${esc(N.spName(id))}</button>`).join('')}</div>` : ''}
    ${!run.rules.nuzlocke ? '<button class="btn block danger" id="btn-remove">Rimuovi dalla lista</button>' : m.alive ? `
      <div class="section-title">Caduta</div>
      <div class="field"><label>Causa (facoltativa)</label><input type="text" id="cause" placeholder="${esc(cap?.label || 'Allenatore o Pokémon selvatico')}"></div>
      <button class="btn block danger" id="btn-dead">È caduto</button>` : `<button class="btn block" id="btn-revive">Riporta in vita (correzione)</button>`}
    <div class="dialog-actions"><button class="btn primary" id="btn-save">Salva</button></div>`;
  on(body, '[data-evo]', 'click', async (e, el) => {
    N.setEvolution(run, uid, Number(el.dataset.evo));
    await persistRun();
    render();
  });
  $('#btn-save', body).addEventListener('click', async () => {
    m.nick = $('#nick', body).value.trim();
    await persistRun();
    popView();
  });
  $('#btn-dead', body)?.addEventListener('click', async () => {
    N.killMon(run, uid, $('#cause', body).value);
    await persistRun();
    popView();
    toast('Riposa in pace.');
  });
  $('#btn-remove', body)?.addEventListener('click', async () => {
    N.removeMon(run, uid);
    await persistRun();
    popView();
  });
  $('#btn-revive', body)?.addEventListener('click', async () => {
    N.reviveMon(run, uid);
    await persistRun();
    popView();
  });
}

function graveView(body) {
  const dead = app.run.mons.filter((m) => !m.alive).sort((a, b) => b.diedAt - a.diedAt);
  body.innerHTML = dead.length ? `<div class="list">${dead.map(monRow).join('')}</div>` : '<p class="empty">Il cimitero è vuoto. Che resti così.</p>';
  on(body, '[data-uid]', 'click', (e, el) => {
    const m = app.run.mons.find((x) => x.uid === el.dataset.uid);
    pushView(m.nick || N.spName(m.sid), (b) => monView(b, m.uid));
  });
}

function bossView(body, index = null) {
  const run = app.run;
  const caps = app.data.caps;
  const i = index ?? Math.min(run.capIndex, caps.length - 1);
  const cap = caps[i];
  const done = run.capIndex >= caps.length;
  const teams = N.bossTeams(run, cap);
  body.innerHTML = `
    <div class="card">
      <div class="row"><div class="grow"><small>${i < run.capIndex ? 'Superato' : i === run.capIndex ? 'Prossimo boss' : 'Più avanti'}</small><br><b style="font-size:18px">${esc(cap.label)}</b></div>
      <span class="chip">Level cap ${cap.level}</span></div>
      ${i === run.capIndex && !done ? '<button class="btn primary block" id="btn-beat" style="margin-top:10px">Boss superato: passa al prossimo</button>' : ''}
    </div>
    ${teams.length ? '' : '<p class="hint">Nessuna squadra registrata per questo punto: vale solo il level cap.</p>'}
    ${teams.map(teamHtml).join('')}
    <div class="section-title">Tutti i level cap</div>
    <div class="list">${caps
      .map(
        (c, k) => `<div class="item ${k < run.capIndex ? 'dim' : ''}" data-cap="${k}"><div class="main"><b>${esc(c.label)}</b></div>
        <span class="status ${k === run.capIndex ? 'current' : k < run.capIndex ? 'caught' : ''}">Lv. ${c.level}</span></div>`,
      )
      .join('')}</div>
    <p class="hint">Fonte: foglio "Boss Battles" e calcolatore di hzla (dati 1.3). I livelli negativi indicano Pokémon che si adattano al tuo livello.</p>`;
  $('#btn-beat', body)?.addEventListener('click', async () => {
    N.advanceCap(run);
    await persistRun();
    render();
    toast(run.capIndex >= caps.length ? 'Campione!' : `Nuovo level cap: ${N.currentCap(run).level}`);
  });
  on(body, '[data-cap]', 'click', (e, el) => pushView(caps[el.dataset.cap].label, (b) => bossView(b, Number(el.dataset.cap))));
}

function teamHtml(t) {
  const lvl = (lv) => (lv == null ? '' : lv > 0 ? `Lv. ${lv}` : 'Lv. dinamico');
  return `<div class="section-title">${esc(t.name)}${t.double ? ' · doppia' : ''}</div>
    ${t.mons
      .map(
        (m) => `<div class="boss-mon"><div class="top"><b>${esc(m.sp)}</b>${m.sid ? typesHtml(m.sid) : ''}<span class="grow"></span><small>${lvl(m.lv)}</small></div>
        ${m.mega ? `<div class="mega">Megaevolve: ${esc(m.mega)}</div>` : ''}
        <div class="meta">${[m.item && `@ ${esc(m.item)}`, m.ab && esc(m.ab), m.nat && esc(m.nat)].filter(Boolean).join(' · ')}</div>
        ${m.mv?.length ? `<div class="moves">${m.mv.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}</div>`,
      )
      .join('')}`;
}

function segHtml(id, value, options) {
  return `<div class="seg" data-seg="${id}">${options.map(([v, l]) => `<button data-v="${v}" class="${v === value ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}

function toggleHtml(id, on, title, sub) {
  return `<div class="toggle ${on ? 'on' : ''}" data-toggle="${id}"><div class="main"><b>${title}</b><small>${sub}</small></div><div class="switch"></div></div>`;
}

function rulesView(body) {
  const run = app.run;
  const r = run.rules;
  const ENF = [['allow', 'Libero'], ['warn', 'Conta'], ['block', 'Bloccato']];
  body.innerHTML = `
    <div class="field"><label>Nome della partita</label><input type="text" id="run-name" value="${esc(run.name)}"></div>
    ${toggleHtml('nuzlocke', r.nuzlocke, 'Regole Nuzlocke', 'Una cattura per zona, clausole e cimitero')}
    <p class="hint">Zone, boss, level cap e catturati funzionano in ogni caso: le regole aggiungono solo i vincoli.</p>
    ${r.nuzlocke ? `<div class="section-title">Clausole</div>
    ${toggleHtml('dupes', r.dupes, 'Clausola duplicati', 'Le famiglie già catturate vengono segnalate')}
    ${toggleHtml('shiny', r.shiny, 'Clausola shiny', 'Uno shiny si può sempre catturare')}
    ${toggleHtml('giftsFree', r.giftsFree, 'Regali liberi', 'Regali e statici non consumano la zona')}
    <div class="section-title">Caricamento stati</div>
    ${segHtml('loadState', r.loadState, ENF)}
    <p class="hint">"Conta" lo consente ma registra ogni ricaricamento (finora: ${run.counters.loads}).</p>
    <div class="section-title">Riavvolgimento</div>
    ${segHtml('rewind', r.rewind, ENF)}
    <p class="hint">Riavvolgimenti registrati: ${run.counters.rewinds}.</p>` : ''}
    <div class="section-title">Variante dei rivali</div>
    <div class="row">
      <select id="v-rival"><option value="">Rivale: tutti</option><option>Brendan</option><option>May</option></select>
      <select id="v-starter"><option value="">Variante: tutte</option><option>Treecko</option><option>Torchic</option><option>Mudkip</option></select>
    </div>
    <p class="hint">Filtra le squadre del rivale nella scheda Boss. Se non sai quale variante ti tocca, lascia "tutte" e confronta col primo scontro.</p>`;
  $('#v-rival', body).value = run.variant?.rival || '';
  $('#v-starter', body).value = run.variant?.starter || '';
  const save = async () => {
    const before = app.emu.rewindEnabled;
    await persistRun();
    if (r.nuzlocke && (r.rewind !== 'block') !== before) toast('Il riavvolgimento cambia al prossimo avvio');
  };
  $('#run-name', body).addEventListener('change', async (e) => {
    run.name = e.target.value.trim() || run.name;
    await save();
  });
  on(body, '[data-toggle]', 'click', async (e, el) => {
    const key = el.dataset.toggle;
    r[key] = !r[key];
    el.classList.toggle('on', r[key]);
    await save();
    if (key === 'nuzlocke') {
      sheet.tabs = trackerTabs(); // compare o sparisce il cimitero
      render();
    }
  });
  on(body, '[data-seg] button', 'click', async (e, el) => {
    const key = el.parentElement.dataset.seg;
    r[key] = el.dataset.v;
    el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el));
    await save();
  });
  on(body, 'select', 'change', async () => {
    run.variant = { rival: $('#v-rival', body).value, starter: $('#v-starter', body).value };
    await save();
  });
}

// ---------------------------------------------------------------- salvataggi rapidi

async function statesView(body) {
  const run = app.run;
  const r = run.rules;
  const nz = r.nuzlocke;
  const loadMode = nz ? r.loadState : 'allow';
  const rewMode = nz ? r.rewind : 'allow';
  const slots = [1, 2, 3, 4];
  const infos = await Promise.all(slots.map((s) => app.emu.stateInfo(s)));
  const when = (t) => new Date(t).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  body.innerHTML = `
    <p class="hint">${loadMode === 'block' ? 'Regola Nuzlocke: il caricamento degli stati è bloccato. Puoi salvare per sicurezza, ma per tornare indietro usa il salvataggio del gioco.' : loadMode === 'warn' ? 'Ogni caricamento viene registrato nella run.' : 'Salvataggi rapidi liberi.'}</p>
    ${slots
      .map((s) => {
        const info = infos[s - 1];
        const has = !!info;
        return `<div class="slot"><div class="main"><b>Slot ${s}</b><br><small>${has ? when(info.t) : 'Vuoto'}</small></div>
        <button class="btn small" data-save="${s}">Salva</button>
        <button class="btn small ${!has || loadMode === 'block' ? 'disabled' : ''}" data-load="${s}">Carica</button></div>`;
      })
      .join('')}
    ${rewMode === 'block' ? '' : '<div class="section-title">Riavvolgimento</div><button class="btn block" id="rewind">Tieni premuto per riavvolgere</button>'}
    <div class="section-title">Velocità avanti veloce</div>
    ${segHtml('ff', String(app.settings.speed), [['2', '2×'], ['3', '3×'], ['4', '4×'], ['8', '8×']])}`;

  on(body, '[data-save]', 'click', async (e, el) => {
    const ok = await app.emu.saveState(Number(el.dataset.save));
    toast(ok ? `Stato salvato nello slot ${el.dataset.save}` : 'Salvataggio non riuscito');
    render();
  });
  on(body, '[data-load]', 'click', async (e, el) => {
    if (loadMode === 'block') return;
    if (loadMode === 'warn' && !confirm('Caricare lo stato? Il ricaricamento verrà registrato nella run.')) return;
    if (await app.emu.loadState(Number(el.dataset.load))) {
      if (loadMode === 'warn') {
        run.counters.loads++;
        await persistRun();
      }
      closeSheet();
      toast(`Caricato slot ${el.dataset.load}`);
    } else toast('Caricamento non riuscito');
  });
  const rw = $('#rewind', body);
  if (rw) {
    const start = (e) => {
      e.preventDefault();
      app.emu.resume();
      app.emu.rewind(true);
    };
    const stop = async () => {
      app.emu.rewind(false);
      app.emu.pause();
      if (rewMode === 'warn') {
        run.counters.rewinds++;
        await persistRun();
      }
    };
    rw.addEventListener('pointerdown', start);
    rw.addEventListener('pointerup', stop);
    rw.addEventListener('pointercancel', stop);
  }
  on(body, '[data-seg="ff"] button', 'click', async (e, el) => {
    app.settings.speed = Number(el.dataset.v);
    await kv.set('settings', app.settings);
    if (app.emu.speed !== 1) app.emu.setSpeed(app.settings.speed);
    render();
  });
}

// ---------------------------------------------------------------- menu

async function menuView(body) {
  const runs = await N.listRuns();
  const install = (await kv.get('install')) || {};
  body.innerHTML = `
    <div class="section-title">Partite</div>
    <div class="list">${runs
      .map(
        (r) => `<div class="item" data-run="${r.id}"><div class="main"><b>${esc(r.name)}</b><small>${r.nuzlocke ? 'Nuzlocke' : 'Partita normale'} · ${new Date(r.updated).toLocaleDateString('it-IT')}</small></div>
        ${app.run?.id === r.id ? '<span class="status current">In corso</span>' : ''}</div>`,
      )
      .join('')}</div>
    <button class="btn block" id="btn-new" style="margin-top:8px">Nuova partita</button>

    <div class="section-title">Salvataggio di gioco</div>
    <div class="row"><button class="btn grow" id="btn-export">Esporta .sav</button><label class="btn grow">Importa .sav<input type="file" id="sav-input" hidden></label></div>
    <div class="row" style="margin-top:6px"><button class="btn grow" id="btn-export-run">Backup tracker</button><label class="btn grow">Ripristina tracker<input type="file" id="run-input" hidden></label></div>

    <div class="section-title">Impostazioni</div>
    ${toggleHtml('haptics', app.settings.haptics, 'Vibrazione dei tasti', 'Feedback leggero alla pressione')}
    <div class="field"><label>Volume</label><input type="range" id="vol" min="0" max="1.5" step="0.1" value="${app.settings.volume}"></div>

    <div class="section-title">Gioco installato</div>
    <div class="card"><small>Emerald Imperium ${esc(install.version || '?')} · CRC ${esc(install.crc || '?')}</small></div>
    <button class="btn block" id="btn-update">Cerca aggiornamenti della patch</button>
    <p class="hint">Dati del tracker: Pokédex ufficiale, Encounter Tracker e Boss Battles della community di Imperium.</p>`;

  on(body, '[data-run]', 'click', (e, el) => pushView('Partita', (b) => runView(b, el.dataset.run)));
  $('#btn-new', body).addEventListener('click', () => pushView('Nuova partita', (b) => newRunView({}, b)));
  $('#btn-export', body).addEventListener('click', () => {
    const sav = app.emu.getSave();
    if (!sav) return toast('Nessun salvataggio di gioco ancora');
    downloadBytes(`${slug(app.run.name)}.sav`, sav);
  });
  $('#sav-input', body).addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (!confirm(`Sostituire il salvataggio di "${app.run.name}" con ${f.name}? Il gioco ripartirà.`)) return;
    await app.emu.importSave(app.run.id, new Uint8Array(await f.arrayBuffer()));
    await switchRun(app.run.id, { flush: false });
  });
  $('#btn-export-run', body).addEventListener('click', () => downloadText(`${slug(app.run.name)}-tracker.json`, N.exportRun(app.run)));
  $('#run-input', body).addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const run = N.importRun(await f.text());
      if (!confirm(`Ripristinare il tracker "${run.name}"?`)) return;
      await N.saveRun(run);
      toast('Tracker ripristinato');
      render();
    } catch (err) {
      toast(err.message);
    }
  });
  on(body, '[data-toggle="haptics"]', 'click', async (e, el) => {
    app.settings.haptics = !app.settings.haptics;
    el.classList.toggle('on', app.settings.haptics);
    await kv.set('settings', app.settings);
    toast('Vale dal prossimo avvio');
  });
  $('#vol', body).addEventListener('change', async (e) => {
    app.settings.volume = Number(e.target.value);
    app.emu.setVolume(app.settings.volume);
    await kv.set('settings', app.settings);
  });
  $('#btn-update', body).addEventListener('click', () => pushView('Aggiornamento', updateView));
}

async function runView(body, id) {
  const meta = await N.getRun(id);
  const st = N.stats(meta);
  const active = app.run?.id === id;
  body.innerHTML = `
    <div class="card"><b style="font-size:18px">${esc(meta.name)}</b><br>
      <small>${meta.rules.nuzlocke ? `Nuzlocke · ${st.alive} vivi, ${st.dead} caduti` : `Partita normale · ${st.caught} catturati`} · boss ${meta.capIndex}/${app.data.caps.length}</small></div>
    ${active ? '<p class="hint">Questa è la partita in corso.</p>' : '<button class="btn primary block" id="btn-play">Gioca questa partita</button>'}
    <button class="btn block danger" id="btn-del" style="margin-top:8px">Elimina partita</button>
    <p class="hint">Eliminando la partita si cancellano anche il suo salvataggio di gioco e gli stati rapidi.</p>`;
  $('#btn-play', body)?.addEventListener('click', async () => {
    await switchRun(meta.id);
  });
  $('#btn-del', body).addEventListener('click', async () => {
    if (!confirm(`Eliminare "${meta.name}" e il suo salvataggio? Non si può annullare.`)) return;
    await app.emu.deleteRunFiles(id);
    await N.deleteRun(id);
    if (active) {
      const runs = await N.listRuns();
      await kv.set('active-run', runs[0]?.id || null);
      setBoot('Partita eliminata…');
      app.emu.running = false; // niente salvataggi automatici della run eliminata
      location.reload(); // senza salvare: la run non esiste più
      return;
    }
    popView();
  });
}

function newRunView(opts = {}, body) {
  // utilizzabile sia come vista iniziale (body passato da render) sia in pila
  const draw = (b) => {
    const rules = { ...N.DEFAULT_RULES };
    b.innerHTML = `
      ${opts.first ? '<p class="hint">Crea la tua prima partita. Ogni partita ha il suo salvataggio e i suoi dati, così puoi averne più di una in parallelo.</p>' : ''}
      <div class="field"><label>Nome</label><input type="text" id="nr-name" value="Nuzlocke ${new Date().toLocaleDateString('it-IT')}" data-auto="1"></div>
      ${toggleHtml('nuzlocke', true, 'Regole Nuzlocke', 'Una cattura per zona, clausole e cimitero')}
      <div id="strict-wrap">${toggleHtml('strict', false, 'Regole rigide', 'Blocca caricamento stati e riavvolgimento')}</div>
      <p class="hint">Zone, boss, level cap e catturati sono sempre disponibili dall'icona verde in alto. Tutto si può cambiare dopo, dalla scheda Partita.</p>
      <button class="btn primary block" id="nr-go">Inizia</button>`;
    $('#nr-name', b).addEventListener('input', (e) => delete e.target.dataset.auto);
    on(b, '[data-toggle]', 'click', (e, el) => {
      el.classList.toggle('on');
      if (el.dataset.toggle === 'nuzlocke') {
        const on = el.classList.contains('on');
        $('#strict-wrap', b).hidden = !on;
        const name = $('#nr-name', b);
        if (name.dataset.auto) name.value = `${on ? 'Nuzlocke' : 'Partita'} ${new Date().toLocaleDateString('it-IT')}`;
      }
    });
    $('#nr-go', b).addEventListener('click', async () => {
      const nz = $('[data-toggle="nuzlocke"]', b).classList.contains('on');
      const strict = $('[data-toggle="strict"]', b).classList.contains('on');
      Object.assign(rules, { nuzlocke: nz, loadState: strict ? 'block' : 'warn', rewind: strict ? 'block' : 'warn' });
      if (!nz) Object.assign(rules, { loadState: 'allow', rewind: 'allow' });
      const run = N.newRun($('#nr-name', b).value, rules);
      await N.saveRun(run);
      if (app.emu.running) return switchRun(run.id);
      await startRun(run);
      $('#sheet').hidden = true;
      sheet.stack = [];
      app.emu.resume();
      toast('Partita iniziata. Gli strumenti sono sull’icona verde in alto.', 3500);
    });
  };
  if (body) draw(body);
  else draw($('#sheet-body'));
}

async function updateView(body) {
  const install = (await kv.get('install')) || {};
  body.innerHTML = `<p class="hint">Installata: ${esc(install.version || '?')}. Scarico l'elenco delle patch dal patcher ufficiale…</p><div class="progress"><div class="bar"></div></div>`;
  try {
    const patch = await P.downloadLatestPatch((f) => ($('.progress .bar', body).style.width = `${f * 100}%`));
    if (patch.version === install.version) {
      body.innerHTML = `<div class="card">Hai già l'ultima versione (${esc(patch.version)}).</div>`;
      return;
    }
    body.innerHTML = `<div class="card">Disponibile la versione <b>${esc(patch.version)}</b>.</div>
      <p class="hint">I salvataggi di gioco restano. Gli stati rapidi delle versioni precedenti potrebbero non funzionare: salva nel gioco prima di aggiornare.</p>
      <button class="btn primary block" id="do-upd">Aggiorna a ${esc(patch.version)}</button>`;
    $('#do-upd', body).addEventListener('click', async () => {
      const rom = await kv.get('rom-original');
      if (!rom) return toast('ROM originale non trovata: reinstalla dal menu');
      const out = P.applyBps(rom, patch.bytes);
      await app.emu.writeRom(out);
      await kv.set('install', { version: patch.version, crc: P.hex(P.crc32(out)), at: Date.now() });
      await switchRun(app.run.id);
    });
  } catch (e) {
    body.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

// ---------------------------------------------------------------- file

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'imperium';

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function downloadBytes(name, bytes) {
  if (isAndroid()) {
    window.onAndroidExportDone = (ok) => toast(ok ? 'File salvato' : 'Esportazione annullata');
    window.AndroidBridge.exportFile(name, bytesToBase64(bytes));
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes]));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const downloadText = (name, text) => downloadBytes(name, new TextEncoder().encode(text));

window.__app = app; // utile per il debug da DevTools
boot();
