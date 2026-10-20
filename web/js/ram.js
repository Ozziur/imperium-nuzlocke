// Lettura della memoria di Emerald Imperium dallo stato salvato del core.
// Indirizzi da lua/emeraldimperium.lua del calcolatore di hzla (Dynamic-Calc-Decomps),
// verificati sul gioco 1.3.1.

const ADDR = {
  gMain: 0x03004218, // inBattle: bit 1 del byte a +0x439
  gSaveBlock1Ptr: 0x03006218,
  gSaveBlock2Ptr: 0x0300621c,
  gPokemonStoragePtr: 0x03006220,
  gBattleTypeFlags: 0x020002c0,
  gPlayerPartyCount: 0x020375f5,
  gEnemyPartyCount: 0x020375f6,
  gPlayerParty: 0x020375f8,
  gEnemyParty: 0x02037850,
  gTrainerBattleOpponent_A: 0x020008da,
  gBattlersCount: 0x02000344,
  gBattlerPartyIndexes: 0x02000348,
  gBattlerPositions: 0x02000350,
  gBattleMons: 0x02000360,
};

// struct BattlePokemon (0x60 byte), offset verificati su una lotta doppia in Imperium 1.3.1
const BM = { size: 0x60, species: 0x00, stats: 0x02, moves: 0x0c, stages: 0x18, ability: 0x20, types: 0x22, pp: 0x25, hp: 0x2a, level: 0x2c, maxHp: 0x2e };

const MON_SIZE = 100;
const BOX_MON_SIZE = 80;
const BOXES = 14;
const BOX_SLOTS = 30;
const BATTLE_TYPE_TRAINER = 1 << 3;
const BATTLE_TYPE_FIRST_BATTLE = 1 << 4; // la lotta di Birch sulla Route 101
const BATTLE_TYPE_WALLY_TUTORIAL = 1 << 9;
// Tasca Poké Ball dentro SaveBlock1 (verificata su un salvataggio 1.3): voci [id, quantità cifrata].
const SB1_BALL_POCKET = 0x0a50;
const BALL_IDS = [1, 27]; // ITEM_POKE_BALL .. ITEM_CHERISH_BALL
// Flag "allenatore battuto": bit (TRAINER_FLAGS_START + id) a partire da questo offset di SaveBlock1.
// Ricavato da un salvataggio con 4 medaglie (17 allenatori noti, battuti e non) e coerente con 110 vittorie.
const SB1_TRAINER_FLAGS = 0x19c4;
const TRAINER_FLAGS_START = 0x500;
const MAX_TRAINER_ID = 900;

// Ordine dei 4 blocchi cifrati in base a personality % 24 (indice logico -> posizione).
const ORDER = [
  [0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3], [0, 3, 1, 2], [0, 2, 3, 1], [0, 3, 2, 1],
  [1, 0, 2, 3], [1, 0, 3, 2], [2, 0, 1, 3], [3, 0, 1, 2], [2, 0, 3, 1], [3, 0, 2, 1],
  [1, 2, 0, 3], [1, 3, 0, 2], [2, 1, 0, 3], [3, 1, 0, 2], [2, 3, 0, 1], [3, 2, 0, 1],
  [1, 2, 3, 0], [1, 3, 2, 0], [2, 1, 3, 0], [3, 1, 2, 0], [2, 3, 1, 0], [3, 2, 1, 0],
];

// Set di caratteri della terza generazione (solo quelli usati nei nomi).
const CHARS = (() => {
  const t = {};
  t[0x00] = ' ';
  for (let i = 0; i < 10; i++) t[0xa1 + i] = String(i);
  for (let i = 0; i < 26; i++) {
    t[0xbb + i] = String.fromCharCode(65 + i);
    t[0xd5 + i] = String.fromCharCode(97 + i);
  }
  Object.assign(t, { 0xab: '!', 0xac: '?', 0xad: '.', 0xae: '-', 0xb0: '…', 0xb1: '“', 0xb2: '”', 0xb3: '‘', 0xb4: '’', 0xb5: '♂', 0xb6: '♀', 0xb8: ',', 0xba: '/' });
  return t;
})();

/** Vista sulla memoria del GBA ricavata da uno stato RetroArch ("RASTATE" + blocco "MEM "). */
export class GbaMemory {
  constructor(state) {
    this.b = state;
    this.dv = new DataView(state.buffer, state.byteOffset, state.byteLength);
    let core = 0;
    if (state[0] === 0x52 && state[1] === 0x41) {
      // RASTATE: cerca il blocco MEM
      let o = 8;
      while (o + 8 <= state.length) {
        const tag = String.fromCharCode(state[o], state[o + 1], state[o + 2], state[o + 3]);
        const size = this.dv.getUint32(o + 4, true);
        if (tag === 'MEM ') {
          core = o + 8;
          break;
        }
        o = (o + 8 + size + 7) & ~7;
      }
    }
    this.iw = core + 0x19000; // IWRAM 32 KB
    this.ew = core + 0x21000; // EWRAM 256 KB
  }

  _off(addr) {
    if (addr >= 0x02000000 && addr < 0x02040000) return this.ew + (addr - 0x02000000);
    if (addr >= 0x03000000 && addr < 0x03008000) return this.iw + (addr - 0x03000000);
    return -1;
  }

  u8(a) {
    const o = this._off(a);
    return o < 0 ? 0 : this.b[o];
  }

  u16(a) {
    const o = this._off(a);
    return o < 0 ? 0 : this.dv.getUint16(o, true);
  }

  u32(a) {
    const o = this._off(a);
    return o < 0 ? 0 : this.dv.getUint32(o, true);
  }

  text(a, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = this.u8(a + i);
      if (c === 0xff) break;
      s += CHARS[c] ?? '';
    }
    return s.trim();
  }
}

const validPtr = (p) => p >= 0x02000000 && p < 0x02040000;

/** Decodifica una BoxPokemon (anche la parte iniziale di una Pokemon in squadra). */
function decodeBoxMon(mem, addr) {
  const pid = mem.u32(addr);
  const otId = mem.u32(addr + 4);
  const flags = mem.u8(addr + 0x13);
  if (!((flags >> 1) & 1)) return null; // hasSpecies
  const key = (pid ^ otId) >>> 0;
  const order = ORDER[pid % 24];
  const block = (logical, word) => (mem.u32(addr + 0x20 + order[logical] * 12 + word * 4) ^ key) >>> 0;
  const g0 = block(0, 0);
  const species = g0 & 0x7ff;
  if (!species) return null;
  const a0 = block(1, 0);
  const a1 = block(1, 1);
  const m0 = block(3, 0);
  const shinyVal = ((otId >>> 16) ^ (otId & 0xffff) ^ (pid >>> 16) ^ (pid & 0xffff)) >>> 0;
  return {
    pid,
    otId,
    species,
    item: (g0 >>> 16) & 0x3ff,
    moves: [a0 & 0x7ff, (a0 >>> 16) & 0x7ff, a1 & 0x7ff, (a1 >>> 16) & 0x7ff].filter(Boolean),
    nick: mem.text(addr + 8, 10),
    isEgg: !!((flags >> 2) & 1),
    shiny: shinyVal < 8,
    metLocation: (m0 >>> 8) & 0xff,
    metLevel: (m0 >>> 16) & 0x7f,
    nature: pid % 25,
  };
}

function decodePartyMon(mem, addr) {
  const m = decodeBoxMon(mem, addr);
  if (!m) return null;
  m.level = mem.u8(addr + 0x54);
  m.hp = mem.u16(addr + 0x56);
  m.maxHp = mem.u16(addr + 0x58);
  return m;
}

function readParty(mem, base, count) {
  const out = [];
  for (let i = 0; i < Math.min(count, 6); i++) {
    const m = decodePartyMon(mem, base + i * MON_SIZE);
    if (m) out.push({ ...m, slot: i });
  }
  return out;
}

/** Pokémon in campo durante una lotta (lato 0 = giocatore, 1 = avversario). */
function readBattlers(mem) {
  const count = Math.min(mem.u8(ADDR.gBattlersCount), 4);
  const out = [];
  for (let b = 0; b < count; b++) {
    const a = ADDR.gBattleMons + b * BM.size;
    const species = mem.u16(a + BM.species);
    if (!species) continue;
    const pos = mem.u8(ADDR.gBattlerPositions + b);
    out.push({
      battler: b,
      side: pos & 1,
      partyIndex: mem.u16(ADDR.gBattlerPartyIndexes + b * 2),
      species,
      // atk, def, vel, attSp, difSp
      stats: [0, 1, 2, 3, 4].map((i) => mem.u16(a + BM.stats + i * 2)),
      moves: [0, 1, 2, 3].map((i) => mem.u16(a + BM.moves + i * 2)),
      pp: [0, 1, 2, 3].map((i) => mem.u8(a + BM.pp + i)),
      // stadi: PS, Att, Dif, Vel, AttSp, DifSp, Prec, Elus (6 = neutro)
      stages: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => mem.u8(a + BM.stages + i) - 6),
      ability: mem.u16(a + BM.ability),
      types: [0, 1, 2].map((i) => mem.u8(a + BM.types + i)),
      hp: mem.u16(a + BM.hp),
      level: mem.u8(a + BM.level),
      maxHp: mem.u16(a + BM.maxHp),
    });
  }
  return out;
}

/** Fotografia dello stato di gioco utile al tracker. */
export function readGame(state, { withBoxes = false } = {}) {
  const mem = new GbaMemory(state);
  const sb1 = mem.u32(ADDR.gSaveBlock1Ptr);
  const sb2 = mem.u32(ADDR.gSaveBlock2Ptr);
  if (!validPtr(sb1) || !validPtr(sb2)) return { ready: false };

  const inBattle = !!(mem.u8(ADDR.gMain + 0x439) & 0x02);
  const battleFlags = mem.u32(ADDR.gBattleTypeFlags);
  const game = {
    ready: true,
    player: mem.text(sb2, 8),
    mapGroup: mem.u8(sb1 + 4),
    mapNum: mem.u8(sb1 + 5),
    inBattle,
    trainerBattle: inBattle && !!(battleFlags & BATTLE_TYPE_TRAINER),
    opponent: inBattle && battleFlags & BATTLE_TYPE_TRAINER ? mem.u16(ADDR.gTrainerBattleOpponent_A) : null,
    scripted: inBattle && !!(battleFlags & (BATTLE_TYPE_FIRST_BATTLE | BATTLE_TYPE_WALLY_TUTORIAL)),
    beaten: (() => {
      const out = [];
      for (let id = 1; id < MAX_TRAINER_ID; id++) {
        const n = TRAINER_FLAGS_START + id;
        if ((mem.u8(sb1 + SB1_TRAINER_FLAGS + (n >> 3)) >> (n & 7)) & 1) out.push(id);
      }
      return out;
    })(),
    hasBalls: (() => {
      const id = mem.u16(sb1 + SB1_BALL_POCKET);
      return id >= BALL_IDS[0] && id <= BALL_IDS[1];
    })(),
    party: readParty(mem, ADDR.gPlayerParty, mem.u8(ADDR.gPlayerPartyCount)),
    enemy: inBattle ? readParty(mem, ADDR.gEnemyParty, mem.u8(ADDR.gEnemyPartyCount)) : [],
    battlers: inBattle ? readBattlers(mem) : [],
  };

  if (withBoxes) {
    const storage = mem.u32(ADDR.gPokemonStoragePtr);
    game.boxes = [];
    if (validPtr(storage)) {
      const base = storage + 4; // boxes[] allineato a 4 byte in questa build
      for (let b = 0; b < BOXES; b++) {
        for (let s = 0; s < BOX_SLOTS; s++) {
          const m = decodeBoxMon(mem, base + (b * BOX_SLOTS + s) * BOX_MON_SIZE);
          if (m) game.boxes.push({ ...m, box: b, slot: s });
        }
      }
    }
  }
  return game;
}
