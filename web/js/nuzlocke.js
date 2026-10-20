// Logica del tracker Nuzlocke: dati del gioco, run, clausole e statistiche.
import { kv } from './storage.js';

export const METHOD_LABEL = {
  land: 'Erba / grotta',
  surf: 'Surf',
  old: 'Amo Vecchio',
  good: 'Amo Buono',
  super: 'Super Amo',
  rock: 'Spaccaroccia',
  gift: 'Regalo / statico / scelta',
};

export const DEFAULT_RULES = {
  nuzlocke: true, // false = partita libera, senza tracker
  dupes: true, // clausola duplicati (per famiglia evolutiva)
  shiny: true, // gli shiny si possono catturare sempre
  giftsFree: false, // i regali non consumano la zona
  // Applicazione: 'allow' | 'warn' (consentito ma contato) | 'block'
  loadState: 'warn',
  rewind: 'block',
};

let data = null;

export async function loadData() {
  if (data) return data;
  const res = await fetch('data/imperium.json');
  data = await res.json();
  data.areaById = Object.fromEntries(data.areas.map((a, i) => [a.id, { ...a, index: i }]));
  return data;
}

export const sp = (id) => data.species[id];
export const spName = (id) => data.species[id]?.n ?? `#${id}`;
export const family = (id) => data.species[id]?.f ?? id;

// ---------- run ----------

const RUNS_KEY = 'runs';
const runKey = (id) => `run:${id}`;

export async function listRuns() {
  return (await kv.get(RUNS_KEY)) || [];
}

export async function getRun(id) {
  return kv.get(runKey(id));
}

export async function saveRun(run) {
  run.updated = Date.now();
  await kv.set(runKey(run.id), run);
  const runs = await listRuns();
  const meta = { id: run.id, name: run.name, created: run.created, updated: run.updated, nuzlocke: run.rules.nuzlocke };
  const i = runs.findIndex((r) => r.id === run.id);
  if (i >= 0) runs[i] = meta;
  else runs.unshift(meta);
  await kv.set(RUNS_KEY, runs);
}

export async function deleteRun(id) {
  await kv.del(runKey(id));
  await kv.set(RUNS_KEY, (await listRuns()).filter((r) => r.id !== id));
}

export function newRun(name, rules = {}) {
  return {
    id: Math.random().toString(36).slice(2, 10),
    name: name || 'Nuova run',
    created: Date.now(),
    updated: Date.now(),
    rules: { ...DEFAULT_RULES, ...rules },
    areas: {}, // areaId -> { status: 'caught'|'failed'|'skipped', mon?: uid, sid?, t }
    mons: [], // { uid, sid, nick, area, alive, cause?, diedAt?, caughtAt, shiny? }
    capIndex: 0,
    variant: { rival: '', starter: '' }, // vuoto = mostra tutte le varianti
    counters: { loads: 0, rewinds: 0 },
    log: [],
  };
}

function log(run, text) {
  run.log.unshift({ t: Date.now(), text });
  run.log.length = Math.min(run.log.length, 200);
}

// ---------- clausole ----------

/** Famiglie già "usate" per la clausola duplicati (catture, anche se morte). */
export function usedFamilies(run) {
  const s = new Set();
  for (const m of run.mons) s.add(family(m.sid));
  return s;
}

export function isDupe(run, sid) {
  return run.rules.dupes && usedFamilies(run).has(family(sid));
}

/** Specie incontrabili nella zona, con l'indicazione dei duplicati. */
export function areaEncounters(run, area) {
  const used = run.rules.dupes ? usedFamilies(run) : new Set();
  return area.enc.map((g) => ({
    method: g.m,
    label: METHOD_LABEL[g.m] || g.m,
    mons: g.p.map(([sid, lv]) => ({ sid, lv, dupe: used.has(family(sid)) })),
  }));
}

/** Una zona ha ancora un incontro valido se c'è almeno una specie non duplicata. */
export function areaHasFreshEncounter(run, area) {
  if (!run.rules.dupes) return true;
  const used = usedFamilies(run);
  return area.enc.some((g) => g.p.some(([sid]) => !used.has(family(sid))));
}

export function areaStatus(run, areaId) {
  return run.areas[areaId]?.status || null;
}

export function recordCatch(run, areaId, sid, { nick = '', shiny = false, gift = false } = {}) {
  const uid = Math.random().toString(36).slice(2, 10);
  run.mons.push({ uid, sid, nick: nick.trim(), area: areaId, alive: true, caughtAt: Date.now(), shiny });
  const consumes = !(shiny && run.rules.shiny) && !(gift && run.rules.giftsFree);
  if (consumes || !run.areas[areaId]) {
    run.areas[areaId] = { status: 'caught', mon: uid, sid, t: Date.now(), extra: !consumes };
  }
  log(run, `Catturato ${nick.trim() || spName(sid)} (${data.areaById[areaId]?.name})`);
  return uid;
}

export function recordFail(run, areaId, sid = null) {
  run.areas[areaId] = { status: 'failed', sid, t: Date.now() };
  log(run, `Incontro perso a ${data.areaById[areaId]?.name}${sid ? ` (${spName(sid)})` : ''}`);
}

export function recordSkip(run, areaId) {
  run.areas[areaId] = { status: 'skipped', t: Date.now() };
  log(run, `Zona saltata: ${data.areaById[areaId]?.name}`);
}

export function resetArea(run, areaId) {
  const a = run.areas[areaId];
  if (a?.mon) run.mons = run.mons.filter((m) => m.uid !== a.mon);
  delete run.areas[areaId];
}

export function killMon(run, uid, cause = '') {
  const m = run.mons.find((x) => x.uid === uid);
  if (!m) return;
  m.alive = false;
  m.cause = cause.trim();
  m.diedAt = Date.now();
  m.capAtDeath = run.capIndex;
  log(run, `${m.nick || spName(m.sid)} è caduto${m.cause ? ` (${m.cause})` : ''}`);
}

export function reviveMon(run, uid) {
  const m = run.mons.find((x) => x.uid === uid);
  if (m) {
    m.alive = true;
    delete m.cause;
    delete m.diedAt;
  }
}

export function setEvolution(run, uid, sid) {
  const m = run.mons.find((x) => x.uid === uid);
  if (m) m.sid = sid;
}

// ---------- level cap e boss ----------

export const caps = () => data.caps;
export const currentCap = (run) => data.caps[Math.min(run.capIndex, data.caps.length - 1)];

export function advanceCap(run) {
  if (run.capIndex < data.caps.length) {
    log(run, `Superato: ${data.caps[run.capIndex].label}`);
    run.capIndex++;
  }
}

/** Squadre del boss filtrate in base al rivale e allo starter scelti nella run. */
export function bossTeams(run, cap) {
  const teams = cap.teams;
  const rivalTeams = teams.filter((t) => /Rival (Brendan|May)/.test(t.name));
  if (!rivalTeams.length) return teams;
  const { rival = '', starter = '' } = run.variant || {};
  const pick = rivalTeams.filter((t) => t.name.includes(rival) && t.name.includes(starter));
  return pick.length ? pick : rivalTeams;
}

export function stats(run) {
  const alive = run.mons.filter((m) => m.alive).length;
  const dead = run.mons.length - alive;
  const visited = Object.keys(run.areas).length;
  return { alive, dead, caught: run.mons.length, visited, total: data.areas.length };
}

/** Prossima zona non ancora registrata, nell'ordine di progressione. */
export function nextOpenArea(run) {
  return data.areas.find((a) => !run.areas[a.id] && a.enc.length);
}

// ---------- backup ----------

export function exportRun(run) {
  return JSON.stringify({ kind: 'imperium-nuzlocke-run', v: 1, run });
}

export function importRun(text) {
  const obj = JSON.parse(text);
  if (obj.kind !== 'imperium-nuzlocke-run' || !obj.run?.id) throw new Error('File di run non valido.');
  return obj.run;
}
