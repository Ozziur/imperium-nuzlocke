// Consigliere di squadra: confronta i tuoi Pokémon con la squadra di un avversario
// (tipi, statistiche, mosse) e stima i danni con la formula delle generazioni recenti.
// È una stima: non tiene conto di strumenti, abilità (salvo le immunità), meteo, critici e stadi.
import { effectiveness } from './types.js';

export const NATURES = ['Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty', 'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax', 'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive', 'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash', 'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky'];
// la natura alza floor(n/5) e abbassa n%5 su [Att, Dif, Vel, AttSp, DifSp]; qui gli indici in [PS, Att, Dif, AttSp, DifSp, Vel]
const NAT_TO_STAT = [1, 2, 5, 3, 4];

/** Statistiche [PS, Att, Dif, AttSp, DifSp, Vel] da base, livello, IV, EV e natura. */
export function calcStats(base, lv, iv = [31, 31, 31, 31, 31, 31], ev = [0, 0, 0, 0, 0, 0], nature = 0) {
  const up = Math.floor(nature / 5);
  const down = nature % 5;
  return base.map((b, i) => {
    const core = Math.floor(((2 * b + iv[i] + Math.floor(ev[i] / 4)) * lv) / 100);
    if (i === 0) return core + lv + 10;
    let v = core + 5;
    if (up !== down && NAT_TO_STAT[up] === i) v = Math.floor(v * 1.1);
    if (up !== down && NAT_TO_STAT[down] === i) v = Math.floor(v * 0.9);
    return v;
  });
}

/** Danno minimo e massimo in % dei PS del bersaglio. */
function damage(att, move, def, data) {
  const [, typeName, cat, pow0] = move;
  if (cat === 2) return null;
  const pow = pow0 > 1 ? pow0 : 60; // potenza variabile: stima
  const type = data.types.indexOf(typeName);
  const eff = effectiveness(type, def.types, def.ability);
  if (eff === 0) return { min: 0, max: 0, eff };
  const A = cat === 0 ? att.stats[1] : att.stats[3];
  const D = cat === 0 ? def.stats[2] : def.stats[4];
  const base = Math.floor(Math.floor((Math.floor((2 * att.level) / 5 + 2) * pow * A) / D) / 50) + 2;
  const stab = att.types.includes(type) ? 1.5 : 1;
  const max = Math.floor(base * stab * eff);
  const min = Math.floor(Math.floor(base * 0.85) * stab * eff);
  return { min: (min / def.stats[0]) * 100, max: (max / def.stats[0]) * 100, eff };
}

const hitsToKo = (pct) => (pct <= 0 ? Infinity : Math.ceil(100 / pct));

/** Mossa migliore di `att` contro `def` (per danno massimo). */
function bestMove(att, def, data) {
  let best = null;
  for (const id of att.moves) {
    const mv = data.moves[id];
    if (!mv) continue;
    const d = damage(att, mv, def, data);
    if (d && (!best || d.max > best.max)) best = { ...d, id, name: mv[0], type: mv[1] };
  }
  return best;
}

/** Pokémon dell'avversario in forma confrontabile. */
export function foeMons(teams, data, topLevel) {
  const out = [];
  for (const t of teams) {
    for (const m of t.mons || t.m || []) {
      const sp = data.species[m.sid];
      if (!sp) continue;
      const raw = Number(m.lv) || 0; // nei dati i livelli dinamici sono relativi ("-1" = uno sotto il tuo più alto)
      const lv = raw > 0 ? raw : Math.max(1, Math.min(100, Number(topLevel) + raw));
      const nat = Math.max(0, NATURES.indexOf(m.nat));
      const moves = (m.mv || []).map((x) => (typeof x === 'number' ? x : data.moveIdByName(x))).filter(Boolean);
      out.push({
        name: m.sp,
        sid: m.sid,
        level: lv,
        dynamic: !(raw > 0),
        types: sp.t.map((n) => data.types.indexOf(n)),
        ability: m.ab || '',
        item: m.item || '',
        stats: calcStats(sp.s, lv, m.iv, m.ev, nat),
        moves,
        mega: m.mega,
        trainer: t.name || t.n,
      });
    }
  }
  return out;
}

/** I tuoi Pokémon disponibili (squadra e box, esclusi i caduti), con statistiche reali o stimate. */
export function myMons(game, run, data, capLevel) {
  const dead = new Set(run.mons.filter((m) => !m.alive && m.pid).map((m) => m.pid));
  const list = [...(game?.party || []).map((m) => ({ ...m, inParty: true })), ...(game?.boxes || [])].filter((m) => !m.isEgg && !dead.has(m.pid));
  return list.map((m) => {
    const sp = data.species[m.species];
    const tracked = run.mons.find((x) => x.pid === m.pid);
    const level = m.level || capLevel;
    return {
      pid: m.pid,
      name: tracked?.nick || (m.nick && m.nick.toLowerCase() !== sp.n.split(' (')[0].toLowerCase() ? m.nick : sp.n),
      species: sp.n,
      sid: m.species,
      level,
      estimated: !m.level,
      inParty: !!m.inParty,
      types: sp.t.map((n) => data.types.indexOf(n)),
      ability: '',
      stats: m.stats && m.stats[1] ? m.stats : calcStats(sp.s, level, undefined, undefined, m.nature || 0),
      moves: m.moves || [],
    };
  });
}

/** Debolezze comuni della squadra avversaria e tipi di attacco che usa. */
export function teamSummary(foes, data) {
  const weak = [];
  for (let t = 1; t <= 19; t++) {
    if (t === 10) continue;
    const hit = foes.filter((f) => effectiveness(t, f.types, f.ability) >= 2).length;
    const resist = foes.filter((f) => effectiveness(t, f.types, f.ability) < 1).length;
    if (hit) weak.push({ type: data.types[t], hit, resist });
  }
  weak.sort((a, b) => b.hit - a.hit || a.resist - b.resist);
  const attack = {};
  for (const f of foes)
    for (const id of f.moves) {
      const mv = data.moves[id];
      if (mv && mv[2] !== 2) attack[mv[1]] = (attack[mv[1]] || 0) + 1;
    }
  const attackTypes = Object.entries(attack).sort((a, b) => b[1] - a[1]);
  // tipi difensivi che resistono (×½ o meno) a più attacchi avversari
  const resists = [];
  for (let t = 1; t <= 19; t++) {
    if (t === 10) continue;
    let good = 0;
    let bad = 0;
    for (const [name, n] of attackTypes) {
      const e = effectiveness(data.types.indexOf(name), [t]);
      if (e < 1) good += n;
      if (e > 1) bad += n;
    }
    if (good) resists.push({ type: data.types[t], good, bad });
  }
  resists.sort((a, b) => b.good - b.bad - (a.good - a.bad));
  return { weak: weak.slice(0, 6), attackTypes, resists: resists.slice(0, 5) };
}

/** Confronto di ogni tuo Pokémon con ogni avversario, e squadra consigliata. */
export function advise(mine, foes, data) {
  const matrix = mine.map((me) =>
    foes.map((foe) => {
      const off = bestMove(me, foe, data);
      const def = bestMove(foe, me, data);
      const mySpe = me.stats[5];
      const foeSpe = foe.stats[5];
      const offPct = off ? off.max : 0;
      const defPct = def ? def.max : 0;
      // punteggio: quanto in fretta lo batti contro quanto in fretta ti batte, con la velocità
      const myTurns = hitsToKo(off ? (off.min + off.max) / 2 : 0);
      const foeTurns = hitsToKo(def ? (def.min + def.max) / 2 : 0);
      const faster = mySpe > foeSpe;
      let score = Math.min(offPct, 100) - 0.6 * Math.min(defPct, 100) + (faster ? 15 : mySpe === foeSpe ? 0 : -10);
      if (myTurns < foeTurns || (myTurns === foeTurns && faster)) score += 25;
      return { off, def, faster, mySpe, foeSpe, score, myTurns, foeTurns };
    }),
  );
  // scelta golosa di 6 Pokémon che coprano tutti gli avversari
  const chosen = [];
  const best = foes.map(() => -Infinity);
  const value = (cand) => foes.reduce((s, _, j) => s + Math.max(0, Math.max(best[j], matrix[cand][j].score) - Math.max(best[j], -50)), 0);
  for (let k = 0; k < Math.min(6, mine.length); k++) {
    let pick = -1;
    let pickV = -Infinity;
    mine.forEach((_, i) => {
      if (chosen.includes(i)) return;
      const v = value(i) + 0.01 * matrix[i].reduce((s, c) => s + c.score, 0);
      if (v > pickV) {
        pickV = v;
        pick = i;
      }
    });
    if (pick < 0) break;
    chosen.push(pick);
    matrix[pick].forEach((c, j) => (best[j] = Math.max(best[j], c.score)));
  }
  const answers = foes.map((_, j) =>
    mine
      .map((_, i) => ({ i, ...matrix[i][j] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3),
  );
  return { matrix, chosen, answers };
}

export const pctRange = (d) => (d ? `${Math.round(d.min)}–${Math.round(d.max)}%` : '—');
export const koLabel = (d) => {
  if (!d || d.max <= 0) return 'nessun danno';
  if (d.min >= 100) return 'KO sicuro';
  if (d.max >= 100) return 'può fare KO';
  const a = hitsToKo(d.max);
  const b = hitsToKo(d.min);
  return a === b ? `${a} colpi` : `${a}-${b} colpi`;
};
