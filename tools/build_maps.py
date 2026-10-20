#!/usr/bin/env python3
"""Genera web/data/maps.json: per ogni gruppo di mappe, la lista delle costanti MAP_* nell'ordine del gioco.

Il gioco salva la posizione come (gruppo, numero); questa tabella la traduce nel nome della mappa.
Fonte: data/maps/map_groups.json di pokeemerald-expansion, la base di Emerald Imperium.
Uso: python3 tools/build_maps.py map_groups.json web/data/maps.json
"""
import json
import re
import sys

src, out = sys.argv[1:3]
g = json.load(open(src))


def const(folder):
    s = re.sub(r"(?<=[a-z])(?=[A-Z])", "_", folder)  # PetalburgCity_Gym -> Petalburg_City_Gym
    return "MAP_" + s.upper()


groups = [[const(m) for m in g[name]] for name in g["group_order"]]
json.dump({"groups": groups}, open(out, "w"), separators=(",", ":"))
print(len(groups), "gruppi,", sum(map(len, groups)), "mappe")
print(groups[0][:5], groups[1][:2])
