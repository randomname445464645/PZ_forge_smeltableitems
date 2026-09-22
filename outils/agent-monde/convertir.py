#!/usr/bin/env python3
"""Convertit le NDJSON de l'agent en calque pour le viewer.

Produit deux choses :

  constructions.json          les cases, avec pour chacune la liste de ses
                              sprites sous forme d'indices dans un tableau
                              commun (les noms se repetent enormement)
  constructions-sprites.json  pour chaque sprite : son dossier de textures,
                              sa taille, et son decalage ox/oy

Le decalage est LA donnee qui permet de redessiner fidelement. pzmap2dzi le
lit dans les metadonnees PNG ecrites par "main.py unpack" (texture.py, classe
Texture : "offset is from the bottom center of the square"). Le navigateur ne
sait pas lire un bloc tEXt de PNG, d'ou cet index.

Regle de dessin, reprise de render_impl/base.py et de pzdzi.IsoDZI :

    bas_centre_x = (x - y) * 64
    bas_centre_y = (x + y + 2) * 32 - 192 * z
    PNG dessine en (bas_centre_x + ox, bas_centre_y + oy)

64 et 32 sont GRID_WIDTH et GRID_HEIGHT, 192 est LAYER_HEIGHT.
"""
import json
import os
import sys

RACINE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.expanduser("~/Zomboid/pz-export/monde.ndjson")
SORTIE = os.path.abspath(os.path.join(RACINE, "..", "..", "out", "html"))
TEXTURES = "/mnt/data/pz-render/out-iso/texture"


def index_textures(noms, racine):
    """Retrouve chaque sprite dans les dossiers de textures et lit son offset."""
    try:
        from PIL import Image
    except ImportError:
        print("Pillow est requis : .venv/bin/python convertir.py", file=sys.stderr)
        raise

    dossiers = []
    if os.path.isdir(racine):
        # 'default' d'abord : c'est la carte vanilla, la plus probable.
        for d in sorted(os.listdir(racine), key=lambda n: (n != "default", n)):
            if os.path.isdir(os.path.join(racine, d)):
                dossiers.append(d)

    index = {}
    manquants = []
    for nom in sorted(noms):
        trouve = False
        for d in dossiers:
            chemin = os.path.join(racine, d, nom + ".png")
            if not os.path.isfile(chemin):
                continue
            try:
                with Image.open(chemin) as im:
                    w, h = im.size
                    ox = int(im.info.get("ox", 0))
                    oy = int(im.info.get("oy", 0))
            except Exception:
                continue
            index[nom] = [d, w, h, ox, oy]
            trouve = True
            break
        if not trouve:
            manquants.append(nom)
    return index, manquants, dossiers


def main():
    source = sys.argv[1] if len(sys.argv) > 1 else SOURCE
    sortie = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else SORTIE)

    if not os.path.isfile(source):
        print("Source introuvable : %s" % source, file=sys.stderr)
        print("L'agent a-t-il tourne ? Voir LISEZMOI.md", file=sys.stderr)
        return 1

    cases = {}
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
                illisibles += 1     # ligne tronquee par un arret brutal du jeu

    # Table des noms de sprites : ils se repetent enormement d'une case a
    # l'autre, les stocker une fois divise la taille par plusieurs.
    noms = sorted({s for sprites in cases.values() for s in sprites})
    rang = {n: i for i, n in enumerate(noms)}

    plat = []
    for (x, y, z) in sorted(cases, key=lambda c: (c[2], c[0] + c[1], c[0])):
        plat.append([x, y, z, [rang[s] for s in cases[(x, y, z)]]])

    index, manquants, dossiers = index_textures(noms, TEXTURES)

    os.makedirs(sortie, exist_ok=True)
    with open(os.path.join(sortie, "constructions.json"), "w", encoding="utf-8") as f:
        json.dump({"sprites": noms, "cases": plat}, f, separators=(",", ":"))
    with open(os.path.join(sortie, "constructions-sprites.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, separators=(",", ":"))

    xs = [c[0] for c in cases]
    ys = [c[1] for c in cases]
    t1 = os.path.getsize(os.path.join(sortie, "constructions.json")) / 1024
    t2 = os.path.getsize(os.path.join(sortie, "constructions-sprites.json")) / 1024
    print("lignes lues       : %d" % lignes)
    if illisibles:
        print("lignes illisibles : %d (ignorees)" % illisibles)
    print("cases uniques     : %d" % len(cases))
    print("sprites distincts : %d" % len(noms))
    print("etages            : %s" % ", ".join(str(z) for z in sorted({c[2] for c in cases})))
    if xs:
        print("emprise           : x %d a %d, y %d a %d" % (min(xs), max(xs), min(ys), max(ys)))
    print("dossiers textures : %s" % ", ".join(dossiers))
    if manquants:
        print("sprites introuvables : %d" % len(manquants))
        for n in manquants[:8]:
            print("    %s" % n)
    print("ecrit             : constructions.json %.1f Ko, constructions-sprites.json %.1f Ko"
          % (t1, t2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
