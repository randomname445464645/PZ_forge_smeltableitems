#!/usr/bin/env python3
"""Construit la table piece -> objets qui peuvent y apparaitre.

Sert l'infobulle des pastilles : au survol, on veut savoir ce qu'on va
trouver, pas seulement le nom de la piece.

SOURCE
    media/lua/server/Items/Distributions.lua dit, pour chaque nom de piece,
    quel meuble tire dans quelle table procedurale.
    media/lua/server/Items/ProceduralDistributions.lua dit ce que contient
    chaque table : une liste plate [objet, poids, objet, poids, ...].
    Les deux sont lus comme du Lua avec lupa, pas a coups d'expressions
    regulieres.

    Les noms francais viennent de Translate/FR/ItemName.json.

CHANCE AFFICHEE
    poids de l'objet / somme des poids de sa table, multiplie par le
    weightChance de la table quand il y en a un. C'est la chance qu'un tirage
    de ce meuble donne cet objet. Le nombre de tirages depend de la taille du
    conteneur et du reglage de loot du serveur, donc ce n'est PAS la
    probabilite de trouver l'objet dans la piece : c'est un ordre de grandeur,
    bon pour comparer deux objets entre eux.

    On garde le meilleur meuble pour chaque objet, et on ignore les listes
    'junk' qui sont du remplissage sans interet.

MEUBLES GENERIQUES
    Chaque table est normalisee sur elle-meme, donc une petite table gagne
    toujours : StoreCounterCleaning n'a que six objets et se retrouve dans 91
    pieces, si bien que l'armurerie annoncait "Torchon 25 %, Eponge 25 %" avant
    les fusils. On ecarte donc les tables partagees par plus de SEUIL_PARTAGE
    pieces, qui decrivent le mobilier et pas le lieu. Si une piece n'a que des
    tables generiques, on les reprend plutot que de ne rien afficher.
"""
import io
import json
import os
import sys

RACINE = os.path.dirname(os.path.abspath(__file__))
PROJET = os.path.normpath(os.path.join(RACINE, '..', '..'))
SORTIE = os.path.join(PROJET, 'out', 'html', 'carte', 'loot-pieces.json')

sys.path.insert(0, os.path.join(PROJET, 'pzmap2dzi'))

# Nombre d'objets gardes par piece. Au-dela l'infobulle devient un mur.
GARDES = 14

# Au-dela de ce nombre de pieces, une table decrit un meuble et pas un lieu.
SEUIL_PARTAGE = 8

# Ce qui n'est pas une piece. La palette de lingots est un objet de decor, son
# contenu est code en dur dans ContextMenuCode.TakeGoldBars : 30 lingots, sans
# tirage au sort, et une seule fois.
SUPPLEMENTS = {
    'goldpallet': [["30 lingots d'or, garantis, une seule fois", 100.0]],
}

# Ordre de chargement : les tables de bric-a-brac definissent des variables
# globales (ClutterTables) dont ProceduralDistributions se sert.
FICHIERS = [
    'Distribution_BagsAndContainers.lua', 'Distribution_BinJunk.lua',
    'Distribution_ClosetJunk.lua', 'Distribution_CounterJunk.lua',
    'Distribution_DeskJunk.lua', 'Distribution_ShelfJunk.lua',
    'Distribution_SideTableJunk.lua',
    'ProceduralDistributions.lua', 'Distributions.lua',
]


def charger_tables(pz_root):
    import lupa
    from pzmap2dzi import lua_util
    dossier = os.path.join(pz_root, 'media', 'lua', 'server', 'Items')
    env = lupa.LuaRuntime(unpack_returned_tuples=True)
    for f in FICHIERS:
        lua_util.run_lua_file(os.path.join(dossier, f), env=env)
    g = env.globals()
    proc = lua_util.unpack_lua_table(g['ProceduralDistributions'])['list']
    dist = lua_util.unpack_lua_table(g['Distributions'])[0]
    return proc, dist


def charger_noms(pz_root):
    chemin = os.path.join(pz_root, 'media', 'lua', 'shared', 'Translate',
                          'FR', 'ItemName.json')
    if not os.path.isfile(chemin):
        return {}
    with io.open(chemin, encoding='utf-8-sig') as f:
        return json.load(f)


def objets(table):
    """Liste plate [nom, poids, ...] -> [(nom, poids)], sans le junk."""
    sortie = []
    liste = table.get('items')
    if not isinstance(liste, list):
        return sortie
    i = 0
    while i < len(liste) - 1:
        nom, poids = liste[i], liste[i + 1]
        if isinstance(nom, str) and isinstance(poids, (int, float)):
            sortie.append((nom, float(poids)))
            i += 2
        else:
            i += 1
    return sortie


def main():
    from pzmap2dzi.i18n_util import load_yaml
    conf = load_yaml(os.path.join(PROJET, 'pzmap2dzi', 'conf', 'conf-iso.yaml'))
    pz_root = conf['pz_root']

    proc, dist = charger_tables(pz_root)
    noms = charger_noms(pz_root)

    # Chance par objet, pour chaque table procedurale.
    chances = {}
    for nom_table, t in proc.items():
        if not isinstance(t, dict):
            continue
        paires = objets(t)
        total = sum(p for _, p in paires)
        if total <= 0:
            continue
        # Un meme objet peut figurer PLUSIEURS fois dans la liste plate, avec
        # des poids differents : StripClubDressers met Money a 100, 50 et 20.
        # Le jeu tire dans la liste entiere, donc les poids s'additionnent.
        # Une comprehension de dictionnaire ne gardait que le dernier, ce qui
        # faisait tomber l'argent du strip-club de 26 % a 3 % et le sortait du
        # classement.
        cumul = {}
        for n, p in paires:
            cumul[n] = cumul.get(n, 0.0) + p
        chances[nom_table] = {n: p / total for n, p in cumul.items()}

    # Combien de pieces partagent chaque table.
    partage = {}
    for piece, meubles in dist.items():
        if not isinstance(meubles, dict):
            continue
        vues = set()
        for meuble, spec in meubles.items():
            if isinstance(spec, dict):
                for e in (spec.get('procList') or []):
                    vues.add(e.get('name'))
        for t in vues:
            partage[t] = partage.get(t, 0) + 1

    sortie = {}
    for piece, meubles in dist.items():
        if not isinstance(meubles, dict):
            continue
        meilleur = {}
        secours = {}
        for meuble, spec in meubles.items():
            if not isinstance(spec, dict):
                continue
            for e in (spec.get('procList') or []):
                nom_table = e.get('name')
                table = chances.get(nom_table)
                if not table:
                    continue
                facteur = float(e.get('weightChance', 100)) / 100.0
                cible = (secours if partage.get(nom_table, 0) > SEUIL_PARTAGE
                         else meilleur)
                for objet, part in table.items():
                    c = part * facteur
                    if c > cible.get(objet, 0):
                        cible[objet] = c
        retenu = meilleur or secours
        if not retenu:
            continue
        # Deux identifiants peuvent porter le meme nom affiche (les etuis de
        # fusil, par exemple) : on ne garde que le meilleur.
        par_nom = {}
        for objet, c in retenu.items():
            libelle = noms.get('Base.' + objet, objet)
            if c > par_nom.get(libelle, 0):
                par_nom[libelle] = c
        top = sorted(par_nom.items(), key=lambda kv: -kv[1])[:GARDES]
        sortie[piece] = [[libelle, round(c * 100, 1)] for libelle, c in top]

    sortie.update(SUPPLEMENTS)

    with io.open(SORTIE, 'w', encoding='utf8') as f:
        json.dump(sortie, f, ensure_ascii=False, separators=(',', ':'))
    print('pieces decrites : %d' % len(sortie))
    print('ecrit : %s (%.0f Ko)' % (SORTIE, os.path.getsize(SORTIE) / 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
