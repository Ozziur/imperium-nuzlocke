// Tabella dei tipi (generazione 6 in poi, quella usata dal calcolatore di Imperium).
// Indici come nel gioco: 1 Normale … 19 Folletto (10 = nessuno).
const N = 1, FI = 2, FL = 3, PO = 4, GR = 5, RO = 6, BU = 7, GH = 8, ST = 9, FR = 11, WA = 12, GS = 13, EL = 14, PS = 15, IC = 16, DR = 17, DK = 18, FA = 19;

const CHART = {
  [N]: { [RO]: 0.5, [GH]: 0, [ST]: 0.5 },
  [FI]: { [N]: 2, [FL]: 0.5, [PO]: 0.5, [RO]: 2, [BU]: 0.5, [GH]: 0, [ST]: 2, [PS]: 0.5, [IC]: 2, [DK]: 2, [FA]: 0.5 },
  [FL]: { [FI]: 2, [RO]: 0.5, [BU]: 2, [ST]: 0.5, [GS]: 2, [EL]: 0.5 },
  [PO]: { [PO]: 0.5, [GR]: 0.5, [RO]: 0.5, [GH]: 0.5, [ST]: 0, [GS]: 2, [FA]: 2 },
  [GR]: { [FL]: 0, [PO]: 2, [RO]: 2, [BU]: 0.5, [ST]: 2, [FR]: 2, [GS]: 0.5, [EL]: 2 },
  [RO]: { [FI]: 0.5, [FL]: 2, [GR]: 0.5, [BU]: 2, [ST]: 0.5, [FR]: 2, [IC]: 2 },
  [BU]: { [FI]: 0.5, [FL]: 0.5, [PO]: 0.5, [GH]: 0.5, [ST]: 0.5, [FR]: 0.5, [GS]: 2, [PS]: 2, [DK]: 2, [FA]: 0.5 },
  [GH]: { [N]: 0, [GH]: 2, [PS]: 2, [DK]: 0.5 },
  [ST]: { [RO]: 2, [ST]: 0.5, [FR]: 0.5, [WA]: 0.5, [EL]: 0.5, [IC]: 2, [FA]: 2 },
  [FR]: { [RO]: 0.5, [BU]: 2, [ST]: 2, [FR]: 0.5, [WA]: 0.5, [GS]: 2, [IC]: 2, [DR]: 0.5 },
  [WA]: { [GR]: 2, [RO]: 2, [FR]: 2, [WA]: 0.5, [GS]: 0.5, [DR]: 0.5 },
  [GS]: { [FL]: 0.5, [PO]: 0.5, [GR]: 2, [RO]: 2, [BU]: 0.5, [ST]: 0.5, [FR]: 0.5, [WA]: 2, [GS]: 0.5, [DR]: 0.5 },
  [EL]: { [FL]: 2, [GR]: 0, [WA]: 2, [GS]: 0.5, [EL]: 0.5, [DR]: 0.5 },
  [PS]: { [FI]: 2, [PO]: 2, [ST]: 0.5, [PS]: 0.5, [DK]: 0 },
  [IC]: { [FL]: 2, [GR]: 2, [ST]: 0.5, [FR]: 0.5, [WA]: 0.5, [GS]: 2, [IC]: 0.5, [DR]: 2 },
  [DR]: { [ST]: 0.5, [DR]: 2, [FA]: 0 },
  [DK]: { [FI]: 0.5, [GH]: 2, [PS]: 2, [DK]: 0.5, [FA]: 0.5 },
  [FA]: { [FI]: 2, [PO]: 0.5, [ST]: 0.5, [FR]: 0.5, [DR]: 2, [DK]: 2 },
};

// Abilità che annullano un tipo (le più comuni).
const IMMUNE = {
  Levitate: GR,
  'Earth Eater': GR,
  'Flash Fire': FR,
  'Well-Baked Body': FR,
  'Water Absorb': WA,
  'Storm Drain': WA,
  'Dry Skin': WA,
  'Volt Absorb': EL,
  'Lightning Rod': EL,
  'Motor Drive': EL,
  'Sap Sipper': GS,
};

/** Moltiplicatore di un attacco di tipo `atk` contro i tipi `defTypes` (indici). */
export function effectiveness(atk, defTypes, defAbility = '') {
  if (!atk || atk === 10) return 1;
  if (IMMUNE[defAbility] === atk) return 0;
  let m = 1;
  for (const t of new Set(defTypes)) if (t && t !== 10) m *= CHART[atk]?.[t] ?? 1;
  return m;
}

/** Tipi che colpiscono superefficacemente (moltiplicatore >= 2), dal più forte. */
export function weaknesses(defTypes, defAbility = '') {
  const out = [];
  for (let t = 1; t <= 19; t++) {
    if (t === 10) continue;
    const m = effectiveness(t, defTypes, defAbility);
    if (m >= 2) out.push([t, m]);
  }
  return out.sort((a, b) => b[1] - a[1]);
}

export const multLabel = (m) => (m === 0 ? '×0' : m === 0.25 ? '×¼' : m === 0.5 ? '×½' : `×${m}`);

/** Moltiplicatore degli stadi di statistica (−6…+6). */
export const stageMult = (s) => (s >= 0 ? (2 + s) / 2 : 2 / (2 - s));
