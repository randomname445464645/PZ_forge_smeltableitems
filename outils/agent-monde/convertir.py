#!/usr/bin/env python3
"""Convertit le NDJSON de l'agent en calque pour le viewer.

L'agent ecrit en continu, en ajoutant une ligne par case nouvelle ou modifiee.
Une meme case peut donc apparaitre plusieurs fois : on garde la DERNIERE, qui
est la plus recente. Il peut aussi y avoir des doublons francs si la table de
deduplication de l'agent a ete videe (au-dela de 3 millions de cases).

Sortie compacte, groupee par etage, coordonnees a plat :
    {"z0": [x, y, x, y, ...], "z1": [...], ...}
Deux entiers par case au lieu d'un objet JSON, ce qui divise la taille par cinq
sur les gros volumes.
"""
import json
import os
import sys

SOURCE = os.path.expanduser("~/Zomboid/pz-export/monde.ndjson")
CIBLE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "..", "..", "out", "html", "constructions.json")


def main():
    source = sys.argv[1] if len(sys.argv) > 1 else SOURCE
    cible = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else CIBLE)

    if not os.path.isfile(source):
        print("Source introuvable : %s" % source, file=sys.stderr)
        print("L'agent a-t-il tourne ? Voir outils/agent-monde/LISEZMOI.md", file=sys.stderr)
        return 1

    cases = {}          # (x, y, z) -> liste de sprites
    lignes = illisibles = 0
    with open(source, encoding="utf-8") as f:
        for ligne in f:
            ligne = ligne.strip()
            if not ligne:
                continue
            lignes += 1
            try:
                d = json.loads(ligne)
                cases[(d["x"], d["y"], d["z"])] = d["s"]
            except Exception:
                illisibles += 1      # ligne tronquee par un arret brutal du jeu

    par_etage = {}
    for (x, y, z) in cases:
        par_etage.setdefault(z, []).append((x, y))

    sortie = {}
    for z in sorted(par_etage):
        plat = []
        for x, y in sorted(par_etage[z]):
            plat.append(x)
            plat.append(y)
        sortie["z%d" % z] = plat

    os.makedirs(os.path.dirname(cible), exist_ok=True)
    with open(cible, "w", encoding="utf-8") as f:
        json.dump(sortie, f, separators=(",", ":"))

    xs = [x for (x, _, _) in cases]
    ys = [y for (_, y, _) in cases]
    print("lignes lues      : %d" % lignes)
    if illisibles:
        print("lignes illisibles: %d (ignorees)" % illisibles)
    print("cases uniques    : %d" % len(cases))
    print("etages           : %s" % ", ".join(str(z) for z in sorted(par_etage)))
    if xs:
        print("emprise          : x %d a %d, y %d a %d" % (min(xs), max(xs), min(ys), max(ys)))
    print("ecrit            : %s (%.1f Ko)" % (cible, os.path.getsize(cible) / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
