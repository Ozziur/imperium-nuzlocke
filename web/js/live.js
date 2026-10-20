// Collegamento in tempo reale tra la memoria del gioco e il tracker:
// zona attuale, incontri, catture, cadute, evoluzioni, level cap e boss superati.
import { readGame } from './ram.js';
import * as N from './nuzlocke.js';

const TICK_MS = 1000;
const BOX_EVERY = 4; // i box si leggono ogni 4 tick (e a fine lotta)

/** Allenatori che chiudono un punto di level cap: l'ultimo della serie, o una qualsiasi variante del rivale. */
export function capKeyIds(cap) {
  if (!cap.teams.length) return [];
  if (cap.teams.every((t) => /Rival/.test(t.name))) return cap.teams.map((t) => t.id);
  return [cap.teams[cap.teams.length - 1].id];
}

export class Live {
  constructor({ emu, data, maps, getRun, persist, toast, onUpdate }) {
    Object.assign(this, { emu, data, maps, getRun, persist, toast, onUpdate });
    this.game = null; // ultima fotografia
    this.area = null; // zona attuale
    this.battle = null; // lotta in corso
    this.owned = new Map(); // pid -> mon (squadra + box)
    this.ticks = 0;
    this.baselined = false;
    this._buildAreaIndex();
  }

  start() {
    clearInterval(this._t);
    this._t = setInterval(() => this.tick(), TICK_MS);
  }

  // ---------- mappe -> zone ----------

  _buildAreaIndex() {
    this.byMk = {};
    for (const a of this.data.areas) this.byMk[a.mk] = a;
  }

  areaForMap(mk) {
    if (!mk) return null;
    if (this.byMk[mk]) return this.byMk[mk];
    // stanze e sotto-mappe: si risale togliendo un pezzo alla volta (MAP_OLDALE_TOWN_POKEMON_CENTER_1F -> MAP_OLDALE_TOWN)
    const parts = mk.split('_');
    for (let n = parts.length - 1; n >= 3; n--) {
      const prefix = parts.slice(0, n).join('_');
      if (this.byMk[prefix]) return this.byMk[prefix];
      const hit = this.data.areas.find((a) => a.mk.startsWith(prefix + '_'));
      if (hit) return hit;
    }
    return null;
  }

  mapName(g) {
    return this.maps[g.mapGroup]?.[g.mapNum] || null;
  }

  // ---------- ciclo ----------

  tick() {
    const run = this.getRun();
    if (!run || !this.emu.running || this.emu.paused) return;
    let g;
    try {
      const withBoxes = this.ticks % BOX_EVERY === 0 || this._forceBoxes;
      g = readGame(this.emu.getStateBytes(), { withBoxes });
      this._forceBoxes = false;
    } catch (e) {
      return;
    }
    this.ticks++;
    if (!g.ready) return;
    const prev = this.game;
    if (!g.boxes && prev?.boxes) g.boxes = prev.boxes;
    this.game = g;
    this.mk = this.mapName(g);
    this.area = this.areaForMap(this.mk);

    let changed = false;
    changed = this._battle(run, g, prev) || changed;
    if (g.boxes) changed = this._owned(run, g) || changed;
    changed = this._party(run, g) || changed;
    changed = this._beaten(run, g) || changed;
    const cs = this.capStatus(run);
    if (cs?.over.length && this._capWarned !== run.capIndex) {
      this._capWarned = run.capIndex;
      this.toast(`${N.spName(cs.over[0].species)} Lv. ${cs.over[0].level} supera il level cap ${cs.cap}`, 3500);
    }
    if (changed) this.persist();
    this.onUpdate?.(this);
  }

  // ---------- lotte ----------

  _battle(run, g, prev) {
    let changed = false;
    if (g.inBattle && !this.battle) {
      const enemy = g.enemy[0];
      this.battle = {
        trainer: g.trainerBattle,
        area: this.area,
        mk: this.mk,
        enemy: enemy && { pid: enemy.pid, sid: enemy.species, shiny: enemy.shiny, level: enemy.level },
        // gli incontri contano solo con delle Poké Ball nello zaino e fuori dalle lotte guidate
        counts: g.hasBalls && !g.scripted,
        opponent: g.opponent,
      };
      if (!g.trainerBattle && enemy && this.area && run.rules.nuzlocke) {
        const rec = run.areas[this.area.id];
        const dupe = N.isDupe(run, enemy.species);
        if (!rec && this.battle.counts) {
          this.toast(`${this.area.name}: ${N.spName(enemy.species)}${enemy.shiny ? ' ✦ shiny' : ''}${dupe ? ' (duplicato)' : ''}`);
        }
      }
    }
    if (!g.inBattle && this.battle) {
      const b = this.battle;
      this.battle = null;
      this._forceBoxes = true;
      // l'esito si valuta al tick successivo, quando squadra e box sono aggiornati
      this._pendingEnd = { ...b, at: this.ticks };
    }
    if (this._pendingEnd && this.ticks > this._pendingEnd.at + 1 && g.boxes) {
      changed = this._battleEnded(run, g, this._pendingEnd) || changed;
      this._pendingEnd = null;
    }
    return changed;
  }

  _battleEnded(run, g, b) {
    let changed = false;
    // Lotta selvatica: se il Pokémon non è stato catturato, nella Nuzlocke la zona è persa.
    if (!b.trainer && b.enemy && b.area && run.rules.nuzlocke && b.counts) {
      const caught = this.owned.has(b.enemy.pid);
      const rec = run.areas[b.area.id];
      const freeShiny = b.enemy.shiny && run.rules.shiny;
      if (!caught && !rec && !N.isDupe(run, b.enemy.sid) && !freeShiny) {
        N.recordFail(run, b.area.id, b.enemy.sid);
        this.toast(`${b.area.name}: incontro perso (${N.spName(b.enemy.sid)})`);
        changed = true;
      }
    }
    // I boss superati si riconoscono dai flag del gioco (vedi _beaten).
    return changed;
  }

  // ---------- catture e regali ----------

  _owned(run, g) {
    const now = new Map();
    for (const m of [...g.party, ...g.boxes]) if (!m.isEgg) now.set(m.pid, m);
    const known = new Set(run.knownPids || []);
    let changed = false;

    if (!this.baselined) {
      this.baselined = true;
      if (!run.knownPids) {
        // primo avvio della lettura per questa run: quello che c'è già non va registrato di nuovo
        run.knownPids = [...now.keys()];
        this._link(run, now);
        this.owned = now;
        return true;
      }
    }

    // Tanti Pokémon nuovi tutti insieme = salvataggio importato o stato caricato, non catture.
    const fresh = [...now.keys()].filter((pid) => !known.has(pid) && !run.mons.some((x) => x.pid === pid));
    if (fresh.length > 3) {
      run.knownPids = [...new Set([...known, ...now.keys()])];
      this._link(run, now);
      this.owned = now;
      return true;
    }

    for (const [pid, m] of now) {
      if (known.has(pid)) continue;
      known.add(pid);
      changed = true;
      if (run.mons.some((x) => x.pid === pid)) continue;
      const fromBattle = this._pendingEnd?.enemy?.pid === pid || this.battle?.enemy?.pid === pid || this._lastWild?.pid === pid;
      let area = this.area;
      if (!run.mons.length && this.data.areaById.littleroot_town) area = this.data.areaById.littleroot_town; // starter
      if (!area) area = this.data.areas[0];
      const uid = N.recordCatch(run, area.id, m.species, { nick: m.nick && m.nick.toLowerCase() !== this._defaultName(m.species) ? m.nick : '', shiny: m.shiny, gift: !fromBattle });
      const mon = run.mons.find((x) => x.uid === uid);
      if (mon) mon.pid = pid;
      this.toast(`${N.spName(m.species)} registrato a ${area.name}`);
    }
    run.knownPids = [...known];
    if (this.battle?.enemy) this._lastWild = this.battle.enemy;
    this._link(run, now);
    this.owned = now;
    return changed;
  }

  _defaultName(sid) {
    return (this.data.species[sid]?.n || '').split(' (')[0].slice(0, 10).toLowerCase();
  }

  /** Collega i Pokémon segnati a mano a quelli reali (stessa famiglia, ancora senza pid). */
  _link(run, now) {
    const used = new Set(run.mons.map((m) => m.pid).filter(Boolean));
    for (const m of run.mons) {
      if (m.pid) continue;
      for (const [pid, real] of now) {
        if (used.has(pid)) continue;
        if (N.family(real.species) === N.family(m.sid)) {
          m.pid = pid;
          used.add(pid);
          break;
        }
      }
    }
  }

  // ---------- allenatori battuti (dai flag del gioco) ----------

  _beaten(run, g) {
    if (!g.beaten) return false;
    const key = g.beaten.join(',');
    if (key === this._lastBeaten) return false;
    this._lastBeaten = key;
    run.gameBeaten = g.beaten;
    let changed = true;
    // il level cap segue gli allenatori davvero battuti (utile anche con salvataggi importati)
    while (run.capIndex < this.data.caps.length) {
      const cap = this.data.caps[run.capIndex];
      let ids = capKeyIds(cap);
      // punto senza squadra (Trick House): si supera quando è battuto il boss successivo
      if (!ids.length) ids = capKeyIds(this.data.caps[run.capIndex + 1] || { teams: [] });
      if (!ids.length || !ids.some((id) => g.beaten.includes(id))) break;
      N.advanceCap(run);
      if (this.baselined && this.ticks > 3) {
        const next = N.currentCap(run);
        this.toast(run.capIndex >= this.data.caps.length ? 'Lega superata!' : `${cap.label} superato. Nuovo level cap: ${next.level}`);
      }
    }
    return changed;
  }

  // ---------- squadra: evoluzioni, cadute, level cap ----------

  _party(run, g) {
    let changed = false;
    for (const real of g.party) {
      const m = run.mons.find((x) => x.pid === real.pid);
      if (!m) continue;
      if (m.sid !== real.species && !real.isEgg) {
        this.toast(`${m.nick || N.spName(m.sid)} si è evoluto in ${N.spName(real.species)}`);
        m.sid = real.species;
        changed = true;
      }
      if (run.rules.nuzlocke && m.alive && real.maxHp > 0 && real.hp === 0) {
        const cause = this.battle?.trainer ? 'lotta contro allenatore' : this.battle?.enemy ? `${N.spName(this.battle.enemy.sid)} selvatico` : '';
        N.killMon(run, m.uid, cause);
        this.toast(`${m.nick || N.spName(m.sid)} è esausto: segnato nel cimitero`);
        changed = true;
      }
    }
    return changed;
  }

  /** Livello più alto in squadra e se supera il level cap attuale. */
  capStatus(run) {
    if (!this.game?.party?.length || run.capIndex >= this.data.caps.length) return null;
    const cap = N.currentCap(run).level;
    const top = this.game.party.reduce((a, m) => (m.level > a.level ? m : a), this.game.party[0]);
    return { cap, top, over: this.game.party.filter((m) => m.level > cap) };
  }
}
