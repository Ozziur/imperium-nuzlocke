#!/usr/bin/env python3
"""Genera web/data/items.json: MT, Megapietre e strumenti premio, assegnati alla parte della guida
in cui diventano disponibili.

Fonte: foglio "Item (TMs, Mega Stones, etc) and Useful NPC Locations" della documentazione di Imperium
(esportato come xlsx). Le descrizioni vengono ridotte a luogo + condizione in italiano.
Uso: python3 tools/build_items.py items.xlsx web/data/imperium.json web/data/walkthrough.json web/data/items.json [item_names.json]
"""
import json
import re
import sys

import openpyxl

XLSX, DATA, WALK, OUT = sys.argv[1:5]
data = json.load(open(DATA, encoding="utf8"))
walk = json.load(open(WALK, encoding="utf8"))
wb = openpyxl.load_workbook(XLSX, data_only=True)


def pairs(ws, kind, skip):
    out = []
    for r in ws.iter_rows(values_only=True):
        cells = [str(c).strip() for c in r if c not in (None, "") and str(c).strip()]
        for i in range(0, len(cells) - 1, 2):
            a, b = cells[i], cells[i + 1]
            if a not in skip and b not in skip:
                out.append((kind, a, b))
    return out


raw = (pairs(wb["TM & HM Locations"], "tm", {"TM ## - NAME", "LOCATION", "Location"})
       + pairs(wb["Mega Stones"], "mega", {"Mega Stone", "Location"})
       + pairs(wb["Battle Item Rewards"], "battle", {"Item", "Battle"}))

# ---------- luoghi ----------
EXTRA_PLACES = {"Trick House": "Route 110", "Southern Island": None, "Navel Rock": None, "Jagged Pass": "Jagged Pass",
                "Weather Institute": "Route 119", "Mt. Pyre": "Mt Pyre 1F", "Mt Pyre": "Mt Pyre 1F", "Shoal Cave": "Shoal Cave Entrance",
                "Seafloor Cavern": "Seafloor Cavern Entrance", "Safari Zone": "Safari Zone South", "Sky Pillar": "Sky Pillar 1F",
                "Rustboro gym": "Rustboro City", "Granite Cave": "Granite Cave 1F", "Meteor Falls": "Meteor Falls 1F 1R",
                "Victory Road": "Victory Road 1F", "Magma Hideout": "Magma Hideout 1F", "Aqua Hideout": "Team Aqua Hideout",
                "Abandoned Ship": "Abandoned Ship", "Cycling Road": "Route 110", "New Mauville": "New Mauville",
                "Mt. Chimney": "Mt. Chimney", "Fiery Path": "Fiery Path", "Battle Frontier": None, "Lilycove": "Lilycove City",
                "Mossdeep": "Mossdeep City", "Sootopolis": "Sootopolis City", "Evergrande": "Ever Grande City",
                "Ever Grande": "Ever Grande City", "Hot House": "Hot House"}
area_names = [a["name"] for a in data["areas"]]
area_order = {a["name"]: i for i, a in enumerate(data["areas"])}


def find_place(text):
    best = None
    for name in sorted(set(area_names) | set(EXTRA_PLACES), key=len, reverse=True):
        i = text.lower().find(name.lower())
        if i >= 0 and (best is None or i < best[0]):
            best = (i, name)
    if not best:
        return None, None
    name = best[1]
    area = EXTRA_PLACES.get(name, name) if name in EXTRA_PLACES else name
    shown = name if name in ("Trick House", "Southern Island", "Navel Rock", "Weather Institute", "Battle Frontier") else (area or name)
    return shown, area


# parte della guida in cui un luogo compare per la prima volta
splits = walk["splits"]
first_split = {}
for si, sp in enumerate(splits):
    for st in sp["steps"]:
        first_split.setdefault(st["p"].lower(), si)
        for name in area_names + list(EXTRA_PLACES):
            if name.lower() in st["t"].lower():
                first_split.setdefault(name.lower(), si)

# per i luoghi assenti dalla guida: la parte del luogo della guida più vicino nell'ordine di gioco
order_split = []
for si, sp in enumerate(splits):
    for st in sp["steps"]:
        for a in area_names:
            if a.lower().startswith(st["p"].lower()):
                order_split.append((area_order[a], si))


def split_for_area(area):
    if area is None:
        return None
    if area.lower() in first_split:
        return first_split[area.lower()]
    base = re.sub(r" (\d+F|B\d+F|Room \d+|Entrance|Exterior|Summit|\d+R)( \d+R)?$", "", area).lower()
    if base in first_split:
        return first_split[base]
    idx = area_order.get(area)
    if idx is None:
        return None
    best = None
    for oi, si in sorted(order_split):
        if oi <= idx:
            best = si
    return best


BOSS = {"roxanne": 0, "brawly": 1, "wattson": 2, "flannery": 3, "norman": 4, "winona": 5, "tate": 6, "liza": 6, "juan": 7}
HM_MIN = {"cut": 1, "flash": 1, "rock smash": 2, "bike": 2, "strength": 3, "surf": 4, "dive": 7, "waterfall": 8}
PEOPLE = ["Gardenia", "Candice", "Roark", "Fantina", "Maylene", "Wake", "Byron", "Volkner", "Dawn", "Wally", "Steven", "Rival",
          "Maxie", "Archie", "Tabitha", "Courtney", "Shelly", "Matt"]


def person_split(text):
    """Parte della guida in cui si affronta un personaggio citato nella descrizione."""
    for name in PEOPLE:
        if re.search(r"\b" + name + r"\b", text):
            for si, sp in enumerate(splits):
                for st in sp["steps"]:
                    if name.lower() in st["t"].lower():
                        return si
    return None


NOUNS = {"man": "un signore", "woman": "una signora", "old man": "un anziano", "old woman": "un'anziana", "girl": "una ragazza",
         "boy": "un ragazzo", "kid": "un bambino", "little boy": "un bambino", "little girl": "una bambina", "rival": "il rivale",
         "former move tutor": "l'ex Insegnamosse", "fisherman": "un pescatore", "hiker": "un Montanaro", "gentleman": "un gentiluomo",
         "lady": "una signora", "sailor": "un marinaio", "scientist": "uno scienziato", "guy": "un ragazzo"}


def who_it(w):
    w = w.strip()
    return NOUNS.get(w.lower(), w)


def condition(text):
    t = text
    parts = []
    m = re.search(r"\bfrom (?:the |a |an )?(.+?)(?: after| in | on | at | near | next| below| above| behind| close| hidden| who| by |,|$)", t)
    beat = re.search(r"after (?:defeating|you beat|beating) ([A-Z][\w&' ]+?)(?:$|,| in | on )", t)
    if re.search(r"Game Corner", t):
        parts.append("Casinò")
    elif re.search(r"Mart", t):
        parts.append("venditore")
    if re.search(r"^Defeat ", t):
        who = re.sub(r"^Defeat (the )?", "", t)
        who = re.split(r" (?:on|in|at) ", who)[0]
        parts.append(f"completando la {who}" if who in ("Trick House",) else f"battendo {who_it(who)}")
    elif m and not re.search(r"Game Corner|Mart", t):
        who = who_it(m.group(1))
        if re.search(r"after defeating (?:her|him|them)", t):
            parts.append(f"battendo {who}")
        else:
            parts.append(f"da {who}")
    if beat and not re.search(r"^Defeat |after defeating (?:her|him|them)", t):
        parts.append(f"dopo aver battuto {beat.group(1).strip()}")
    for hm in ("Surf", "Cut", "Strength", "Rock Smash", "Dive", "Waterfall", "Flash", "Mach Bike", "Acro Bike"):
        if re.search(r"requires? " + hm, t, re.I) or re.search(r"\(" + hm + r"\)", t):
            parts.append(f"serve {hm}")
    if re.search(r"on the ground", t, re.I):
        parts.append("a terra")
    if re.search(r"hidden", t, re.I):
        parts.append("nascosto")
    m = re.search(r"(first|second|third) puzzle", t)
    if m:
        parts.append(f"premio dell'enigma {({'first': 1, 'second': 2, 'third': 3})[m.group(1)]}")
    m = re.search(r"(\d) badges?", t, re.I)
    if m:
        parts.append(f"con {m.group(1)} medaglie")
    if re.search(r"post ?game", t, re.I):
        parts.append("dopo la Lega")
    return ", ".join(dict.fromkeys(parts)).replace("da l'", "dall'").replace("da un ", "da un ")


items = []
unplaced = []
for kind, name, desc in raw:
    if kind == "tm":
        m = re.match(r"(TM|HM)\s*0*(\d+)\s*-\s*(.+)", name)
        if not m:
            continue
        name = f"{'MT' if m.group(1) == 'TM' else 'MN'}{int(m.group(2)):03d} {m.group(3).strip()}"
        if m.group(1) == "HM":
            continue  # le MN sono già nei passi principali della guida
    shown, area = find_place(desc)
    s = split_for_area(area)
    low = desc.lower()
    for boss, bi in BOSS.items():
        if re.search(r"(?:after (?:defeating|you beat|beating)|from) " + boss, low) or re.search(r"defeat " + boss, low):
            s = max(s or 0, bi)
    ps = person_split(desc)
    if ps is not None:
        s = max(s or 0, ps)
    for hm, mn in HM_MIN.items():
        if re.search(r"requires? (?:the )?" + hm, low):
            s = max(s or 0, mn)
    if re.search(r"puzzle|trick house", low):
        s = max(s or 0, 4)  # gli enigmi della Trick House si fanno verso Norman
    if re.search(r"post ?game", low):
        s = len(splits)
    if s is None:
        unplaced.append((name, desc))
        s = len(splits)
    items.append({"k": kind, "n": name, "p": shown or "", "c": condition(desc), "s": s})

# id degli oggetti nel gioco (lista del lettore di salvataggi del calcolatore), per spuntarli quando li possiedi
names = json.load(open(sys.argv[5], encoding="utf8")) if len(sys.argv) > 5 else []
by_norm = {re.sub(r"[^A-Z0-9]", "", n.upper()): i for i, n in enumerate(names)}
for it in items:
    if it["k"] == "tm":
        m = re.match(r"MT0*(\d+)", it["n"])
        key = "TM" + (m.group(1).zfill(2) if m else "")
    else:
        key = re.sub(r"[^A-Z0-9]", "", it["n"].upper())
        key = {"LUXITE": "LUXRITE", "BEEDRILITE": "BEEDRILLITE", "LEAFSTONES": "LEAFSTONE"}.get(key, key)
    if key in by_norm:
        it["id"] = by_norm[key]
pretty = [n.replace("_", " ").title().replace("Tm", "MT").replace("Hm", "MN") for n in names]

json.dump({"source": "Item (TMs, Mega Stones, etc) and Useful NPC Locations", "items": items, "names": pretty},
          open(OUT, "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))
from collections import Counter
print(len(items), "voci;", Counter(i["k"] for i in items), "per parte:", sorted(Counter(i["s"] for i in items).items()))
print("senza parte (messe dopo la Lega):", unplaced[:12])
