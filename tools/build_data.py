#!/usr/bin/env python3
"""Genera web/data/imperium.json a partire dalle fonti pubbliche di Emerald Imperium.

Fonti (vedi tools/README.md per come scaricarle):
  - raw_*.json      estratti dal Pokédex ufficiale con tools/extract_dex.js
  - raw_sets.json   squadre degli allenatori dal calcolatore danni di hzla (dati 1.3)
  - enc.xlsx        "Emerald Imperium 1.3 Encounter Tracker" (ordine delle zone, regali, statici)

Uso: python3 tools/build_data.py <cartella-raw> <enc.xlsx> <output.json>
"""
import json
import re
import sys
from collections import defaultdict

import openpyxl

RAW, ENC_XLSX, OUT = sys.argv[1:4]
load = lambda n: json.load(open(f"{RAW}/{n}", encoding="utf8"))

species = load("raw_species.json")
abilities = load("raw_abilities.json")
const = load("raw_species_const.json")
wild = load("raw_wild.json")
sets = load("raw_sets.json")
moves = load("raw_moves.json")

TYPES = ["???", "Normale", "Lotta", "Volante", "Veleno", "Terra", "Roccia", "Coleottero", "Spettro",
         "Acciaio", "???", "Fuoco", "Acqua", "Erba", "Elettro", "Psico", "Ghiaccio", "Drago", "Buio",
         "Folletto", "Astrale"]

FORM_WORDS = {"ALOLA": "Alola", "GALAR": "Galar", "HISUI": "Hisui", "PALDEA": "Paldea", "MEGA": "Mega"}


def norm(name):
    s = name.upper().replace("♀", "_F").replace("♂", "_M").replace("’", "").replace("'", "")
    s = s.replace("É", "E").replace(".", "").replace(":", "")
    return re.sub(r"[^A-Z0-9]+", "_", s).strip("_")


# ---------- specie ----------
by_id = {int(k): v for k, v in species.items()}
const_by_id = defaultdict(list)
for k, v in const.items():
    if v is not None:
        const_by_id[v].append(k)


def display_name(sid):
    sp = by_id[sid]
    base = sp["speciesName"]
    best = None
    for k in const_by_id.get(sid, []):
        suffix = k[len("SPECIES_"):]
        b = norm(base)
        if suffix == b:
            return base
        if suffix.startswith(b + "_"):
            best = suffix[len(b) + 1:]
    if best:
        words = [FORM_WORDS.get(w, w.capitalize()) for w in best.split("_")]
        return f"{base} ({' '.join(words)})"
    return base


# famiglie evolutive: componenti connesse sul grafo delle evoluzioni (per dexId)
parent = {}


def find(x):
    parent.setdefault(x, x)
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x


def union(a, b):
    ra, rb = find(a), find(b)
    if ra != rb:
        parent[max(ra, rb)] = min(ra, rb)


for sid, sp in by_id.items():
    find(sp["dexId"])
    for evo in sp.get("evolutions") or []:
        tgt = by_id.get(evo[1])
        if tgt:
            union(sp["dexId"], tgt["dexId"])

out_species = {}
for sid, sp in by_id.items():
    if sp["speciesName"] in ("??????????", "") or sp["dexId"] == 0:
        continue
    out_species[sid] = {
        "n": display_name(sid),
        "t": [TYPES[t] for t in sp["types"] if 0 < t < len(TYPES)],
        "s": sp["stats"],
        "a": [abilities.get(str(a), {}).get("name", "") for a in sp["abilities"] if a],
        "d": sp["dexId"],
        "f": find(sp["dexId"]),
        "e": [[e[1], e[2]] for e in (sp.get("evolutions") or []) if e[1] in by_id],
        "m": [[mv, lvl] for mv, lvl in (sp.get("levelUpMoves") or []) if str(mv) in moves],
    }

name_index = {}
for sid in sorted(out_species, key=lambda s: (by_id[s].get("formId") or 0, s)):
    for k in const_by_id.get(sid, []):
        name_index.setdefault(k[len("SPECIES_"):], sid)

SHEET_SUFFIX = {"A": "ALOLA", "G": "GALAR", "H": "HISUI", "P": "PALDEA", "F": "F", "M": "M"}
missing = set()


def resolve(name):
    """Nome dal foglio o dal calcolatore (es. 'Meowth-A', 'Raichu-Alola') -> id specie."""
    n = name.strip()
    cands = [norm(n)]
    m = re.match(r"^(.*?)-([A-Za-z]+)$", n)
    if m:
        base, suf = m.groups()
        cands.append(norm(base) + "_" + SHEET_SUFFIX.get(suf.upper(), norm(suf)))
        cands.append(norm(base))
    for c in cands:
        if c in name_index:
            return name_index[c]
    missing.add(n)
    return None


# ---------- zone e incontri ----------
wb = openpyxl.load_workbook(ENC_XLSX, data_only=True)
ws = wb["Encounters"]
rows = list(ws.iter_rows(values_only=True))
hi = next(i for i, r in enumerate(rows) if any(str(c).strip() == "Littleroot Town" for c in r if c))
hdr, sub = rows[hi], rows[hi + 1]
area_cols = [(ci, str(v).strip()) for ci, v in enumerate(hdr) if v and str(v).strip()]
CATS = {"Land": "land", "Old Rod": "old", "Good Rod": "good", "Super Rod": "super", "Surf": "surf",
        "Rock Smash": "rock", "Other": "gift", "Fill in": None}

sheet_areas = []
for ai, (ci, name) in enumerate(area_cols):
    nxt = area_cols[ai + 1][0] if ai + 1 < len(area_cols) else len(hdr)
    pcols = [j for j in range(ci, nxt) if sub[j] == "Pokemon"]
    cat, mons = None, []
    for r in rows[hi + 2:]:
        c0 = next((str(c).strip() for c in r[:3] if isinstance(c, str) and str(c).strip() in CATS), None)
        if c0:
            cat = CATS[c0]
            if cat is None:
                break
        for pc in pcols:
            p = r[pc]
            if isinstance(p, str) and p.strip() and len(p) < 30 and not p.startswith("No Encounter"):
                mons.append((cat or "land", p.strip()))
    sheet_areas.append((name, mons))

wild_by_map = defaultdict(list)
for e in wild[0]["encounters"]:
    wild_by_map[e["map"]].append(e)

MAP_FIX = {"Shoal Cave Entrace": "SHOAL_CAVE_LOW_TIDE_ENTRANCE_ROOM", "Shoal Cave Ice": "SHOAL_CAVE_LOW_TIDE_ICE_ROOM",
           "Shoal Cave Inner": "SHOAL_CAVE_LOW_TIDE_INNER_ROOM", "Shoal Cave Lower": "SHOAL_CAVE_LOW_TIDE_LOWER_ROOM",
           "Shoal Cave Stairs": "SHOAL_CAVE_LOW_TIDE_STAIRS_ROOM", "Mt. Chimney": "MT_CHIMNEY",
           "Abandoned Ship": "ABANDONED_SHIP_ROOMS_B1F", "Cave Of Origin": "CAVE_OF_ORIGIN_1F",
           "New Mauville": "NEW_MAUVILLE_INSIDE", "Meteor Falls Steven's Cave": "METEOR_FALLS_STEVENS_CAVE",
           "Granite Cave Stevens Room": "GRANITE_CAVE_STEVENS_ROOM", "Seafloor Cavern Entrance": "SEAFLOOR_CAVERN_ENTRANCE",
           "Trick House 1": "ROUTE110_TRICK_HOUSE_PUZZLE1", "Trick House 2": "ROUTE110_TRICK_HOUSE_PUZZLE2",
           "Trick House 3": "ROUTE110_TRICK_HOUSE_PUZZLE3", "Team Aqua Hideout": "AQUA_HIDEOUT_1F",
           "Hot House": "HOT_HOUSE"}


def map_id(area):
    if area in MAP_FIX:
        return "MAP_" + MAP_FIX[area]
    n = norm(area).replace("MT_", "MT_")
    n = re.sub(r"ROUTE_(\d+)", r"ROUTE\1", n)
    n = re.sub(r"ROOM_(\d)", r"ROOM\1", n)
    return "MAP_" + n


WILD_KEYS = [("land_mons", "land"), ("water_mons", "surf"), ("rock_smash_mons", "rock")]
ROD = {"old_rod": "old", "good_rod": "good", "super_rod": "super"}
FISH_GROUPS = wild[0]["fields"][3]["groups"]


def lv(mn, mx):
    return str(mn) if mn == mx else f"{mn}-{mx}"


RATES = {f["type"]: f["encounter_rates"] for f in wild[0]["fields"]}


def add(enc, meth, sid, mn, mx, rate):
    """Somma le probabilità degli slot della stessa specie e allarga l'intervallo di livello."""
    cur = enc[meth].get(sid)
    if cur:
        cur[0] = min(cur[0], mn)
        cur[1] = max(cur[1], mx)
        cur[2] += rate
    else:
        enc[meth][sid] = [mn, mx, rate]


areas = []
for idx, (name, sheet_mons) in enumerate(sheet_areas):
    mid = map_id(name)
    enc = defaultdict(dict)  # metodo -> {sid: livelli}
    if mid in wild_by_map:
        for e in wild_by_map[mid][:1]:  # Altering Cave ha varianti: si usa la prima
            for key, meth in WILD_KEYS:
                for i, m in enumerate((e.get(key) or {}).get("mons", [])):
                    sid = const.get(m["species"])
                    if sid in out_species:
                        add(enc, meth, sid, m["min_level"], m["max_level"], RATES[key][i])
            fish = (e.get("fishing_mons") or {}).get("mons", [])
            for rod, slots in FISH_GROUPS.items():
                for slot in slots:
                    if slot < len(fish):
                        sid = const.get(fish[slot]["species"])
                        if sid in out_species:
                            add(enc, ROD[rod], sid, fish[slot]["min_level"], fish[slot]["max_level"], RATES["fishing_mons"][slot])
        # regali e incontri speciali vengono solo dal foglio
        for meth, nm in sheet_mons:
            if meth == "gift":
                sid = resolve(nm)
                if sid:
                    enc["gift"].setdefault(sid, None)
    else:
        for meth, nm in sheet_mons:
            sid = resolve(nm)
            if sid:
                # zone senza incontri selvatici: le voci del foglio sono regali, uova o scelte
                enc["gift"].setdefault(sid, None)
    order = ["land", "surf", "old", "good", "super", "rock", "gift"]
    areas.append({
        "id": norm(name).lower(),
        "name": name.replace("Entrace", "Entrance"),
        "map": mid if mid in wild_by_map else None,
        "mk": mid,  # costante MAP_* della zona, usata per riconoscere dove si trova il giocatore
        # p: [id specie, livelli, probabilità %] ordinati dalla più comune
        "enc": [{"m": m, "p": sorted(
            ([sid, lv(v[0], v[1]), v[2]] if v else [sid, "", None] for sid, v in enc[m].items()),
            key=lambda x: -(x[2] or 0))} for m in order if enc.get(m)],
    })

# ---------- boss e level cap ----------
trainers = {}
for sp_name, ts in sets.items():
    for label, st in ts.items():
        tid = st["tr_id"]
        t = trainers.setdefault(tid, {"name": re.sub(r"^Lvl -?\d+ ", "", label).strip(), "mons": []})
        t["mons"].append({
            "sp": sp_name, "sid": resolve(sp_name), "i": st.get("sub_index", 0), "lv": st.get("level"),
            "item": st.get("item"), "ab": st.get("ability"), "nat": st.get("nature"),
            "mv": st.get("moves", []), "bt": st.get("battle_type"),
        })

for t in trainers.values():
    mons = sorted(t["mons"], key=lambda m: m["i"])
    names = {m["sp"] for m in mons}
    keep = []
    for m in mons:
        base = re.sub(r"-Mega(-[A-Z])?$|-Primal$", "", m["sp"])
        if base != m["sp"] and base in names:
            for k in keep:
                if k["sp"] == base:
                    k["mega"] = m["sp"]
            continue
        keep.append(m)
    t["mons"] = keep
    t["double"] = any(m["bt"] == "Doubles" for m in keep)


def team(tid, label=None):
    t = trainers[tid]
    return {"name": label or t["name"], "id": tid, "double": t["double"], "mons": [
        {k: v for k, v in m.items() if k not in ("i", "bt") and v not in (None, [], "")} for m in t["mons"]]}


def rivals(prefix_ids):
    return [team(t) for t in prefix_ids if t in trainers]


CAPS = [
    ("Roxanne", 15, [team(265, "Capopalestra Roxanne")]),
    ("Rivale a Rustboro City", 20, rivals([592, 593, 599, 768, 600, 769])),
    ("Brawly", 25, [team(266, "Capopalestra Brawly")]),
    ("Team Aqua all'Oceanic Museum", 30, rivals([20, 21])),
    ("Rivale sulla Route 110", 32, rivals([521, 524, 527, 530, 533, 536])),
    ("Wattson", 34, [team(267, "Capopalestra Wattson")]),
    ("Team Magma a Mt. Chimney", 44, rivals([597, 602])),
    ("Flannery", 47, [team(268, "Capopalestra Flannery")]),
    ("Trick House", 56, []),
    ("Norman", 59, [team(269, "Capopalestra Norman")]),
    ("Rivale sulla Route 119", 64, rivals([522, 525, 528, 531, 534, 537])),
    ("Winona", 68, [team(270, "Capopalestra Winona")]),
    ("Dawn a Lilycove City", 71, rivals([858])),
    ("Archie all'Aqua Hideout", 74, rivals([30])),
    ("Tate & Liza", 76, rivals([568, 569])),
    ("Seafloor Cavern", 80, rivals([7, 33, 34])),
    ("Juan", 82, [team(272, "Capopalestra Juan")]),
    ("Wally a Victory Road", 84, rivals([519, 657])),
    ("Lega Pokémon", 85, rivals([261, 262, 263, 264, 589, 590])),
]
caps = [{"label": l, "level": lv_, "teams": ts} for l, lv_, ts in CAPS]

out_moves = {int(k): [m["name"], TYPES[m["type"]] if 0 < m["type"] < len(TYPES) else "???", m["cat"],
                      m["power"], m["acc"], m["pp"], m["description"]] for k, m in moves.items()}

data = {
    "game": "Pokémon Emerald Imperium",
    "dataVersion": "1.3.1-dex / 1.3 boss",
    "types": TYPES,
    "species": out_species,
    # mosse: id -> [nome, tipo, categoria 0 fisica/1 speciale/2 stato, potenza, precisione, PP, descrizione]
    "moves": out_moves,
    "areas": areas,
    "caps": caps,
}
json.dump(data, open(OUT, "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))
n_enc = sum(len(e["p"]) for a in areas for e in a["enc"])
print(f"specie {len(out_species)}, zone {len(areas)}, incontri {n_enc}, cap {len(caps)}")
print("zone senza dati selvatici:", [a["name"] for a in areas if not a["map"]])
print("nomi non risolti:", sorted(missing))
