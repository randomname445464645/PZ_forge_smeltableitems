#!/usr/bin/env python3
"""Extrait les marqueurs de loot des noms de pieces, pour TOUTES les cartes.

L'extraction d'origine est anterieure a l'ajout de cinq cartes moddees : Raven
Creek, New Hartburg, Constown, Chestown et LQZ n'avaient aucune pastille, dont
Raven Creek et ses 116 cellules, la plus grande ville moddee du serveur.

CONVENTION, relevee sur les marqueurs existants
    Une piece peut etre faite de plusieurs rectangles. Le marqueur est pose au
    centre du PLUS GRAND, et la description reprend ses dimensions :
        "gunstore · 10x5 · vanilla"

Les marqueurs ecrits a la main (or, billets, Slugger), reconnaissables a leur
description qui ne suit pas ce format, sont conserves tels quels.
"""
import json
import os
import re
import sys

RACINE = os.path.dirname(os.path.abspath(__file__))
PROJET = os.path.normpath(os.path.join(RACINE, '..', '..'))
CONF = os.path.join(PROJET, 'pzmap2dzi', 'conf')
SORTIE = os.path.join(PROJET, 'out', 'html', 'markers.json')

sys.path.insert(0, os.path.join(PROJET, 'pzmap2dzi'))

# Nom de piece -> (categorie, libelle francais). Reconstitue depuis les
# marqueurs d'origine : 36 noms couvrant 1822 des 1860 entrees.
PIECES = {
    'armystorage':     ('armes',   'Dépôt militaire'),
    'armytent':        ('armes',   'Tente militaire'),
    'bank':            ('valeur',  'Banque'),
    'bankstorage':     ('valeur',  'Réserve de banque'),
    'clinic':          ('medical', 'Clinique'),
    'cornerstore':     ('bouffe',  'Supérette'),
    'druglab':         ('valeur',  'Labo de drogue'),
    'drugshack':       ('valeur',  'Planque de drogue'),
    'firestorage':     ('armes',   'Réserve de caserne'),
    'gardenstore':     ('outils',  'Jardinerie'),
    'gas2go':          ('essence', 'Gas2Go'),
    'gasstorage':      ('essence', 'Réserve de station'),
    'gasstore':        ('essence', 'Station-service'),
    'grocery':         ('bouffe',  'Épicerie'),
    'grocerystorage':  ('bouffe',  "Réserve d'épicerie"),
    'gunstore':        ('armes',   'Armurerie'),
    'gunstorestorage': ('armes',   "Réserve d'armurerie"),
    'hospitalstorage': ('medical', "Réserve d'hôpital"),
    'jewelrystorage':  ('valeur',  'Réserve de bijouterie'),
    'jewelrystore':    ('valeur',  'Bijouterie'),
    'laboratory':      ('labo',    'Laboratoire'),
    'liquorstore':     ('bouffe',  "Magasin d'alcool"),
    'mechanic':        ('outils',  'Garage mécanique'),
    'medclinic':       ('medical', 'Clinique'),
    'medicaloffice':   ('medical', 'Cabinet médical'),
    'medicalstorage':  ('medical', 'Réserve médicale'),
    'pawnshop':        ('valeur',  'Prêteur sur gages'),
    'pawnshopoffice':  ('armes',   'Bureau de prêteur sur gages'),
    'pawnshopstorage': ('valeur',  'Réserve de prêteur'),
    'pharmacy':        ('medical', 'Pharmacie'),
    'pharmacystorage': ('medical', 'Réserve de pharmacie'),
    'policelocker':    ('armes',   'Vestiaire de police'),
    'policestorage':   ('armes',   'Réserve de police'),
    'producestorage':  ('bouffe',  'Réserve de primeurs'),
    'toolstore':       ('outils',  'Quincaillerie'),
    'warehouse':       ('outils',  'Entrepôt'),
}

# Libelle court affiche dans la description, par carte.
LIBELLES = {
    'default': 'vanilla', 'Trelai_B42': 'Trelai', 'Greenport_B42': 'Greenport',
    'Maplewood_B42': 'Maplewood', 'RavenCreek_B42': 'Raven Creek',
    'Constown_B42': 'Constown', 'NewHartburg_B42': 'New Hartburg',
    'Chestown_B42': 'Chestown', 'LQZ_B42': 'LQZ',
}

FORMAT_EXTRAIT = re.compile(r'^[a-z0-9]+ · \d+x\d+ · ')


def charger_conf():
    """Resout le chemin de chaque carte depuis les fichiers de pzmap2dzi."""
    from pzmap2dzi.i18n_util import load_yaml
    conf = load_yaml(os.path.join(CONF, 'conf-iso.yaml'))
    cartes = {}
    vanilla = load_yaml(os.path.join(CONF, 'vanilla.txt'))
    cartes['default'] = vanilla['default']['map_path'].format(**conf)
    mods = load_yaml(os.path.join(CONF, 'mod', 'pztogether.txt'))
    for nom, m in mods.items():
        cartes[nom] = m['map_path'].format(**dict(conf, **m))
    return cartes


def extraire(chemin, libelle):
    from pzmap2dzi import lotheader
    marqueurs = []
    if not os.path.isdir(chemin):
        return marqueurs, 0
    cellules = 0
    for f in sorted(os.listdir(chemin)):
        if not f.endswith('.lotheader'):
            continue
        try:
            cx, cy = (int(v) for v in f[:-10].split('_'))
        except ValueError:
            continue
        try:
            h = lotheader.load_lotheader(chemin, cx, cy)
        except Exception:
            continue
        if not h:
            continue
        cellules += 1
        for r in (h.get('rooms') or []):
            nom = r['name']
            if isinstance(nom, bytes):
                nom = nom.decode('utf8', 'replace')
            info = PIECES.get(nom)
            if not info:
                continue
            rects = r.get('rects') or []
            if not rects:
                continue
            # Le plus grand rectangle porte le marqueur, comme a l'origine.
            x, y, w, ht = max(rects, key=lambda t: t[2] * t[3])
            marqueurs.append({
                'x': cx * 256 + x + w // 2,
                'y': cy * 256 + y + ht // 2,
                'z': r.get('layer', 0),
                'cat': info[0],
                't': info[1],
                'd': '%s · %dx%d · %s' % (nom, w, ht, libelle),
            })
    return marqueurs, cellules


def main():
    anciens = []
    if os.path.isfile(SORTIE):
        with open(SORTIE, encoding='utf8') as f:
            anciens = json.load(f)
    # On ne garde que ce qui n'est PAS issu d'une extraction : or, billets,
    # Slugger, et tout ce qui a ete ajoute a la main.
    manuels = [k for k in anciens if not FORMAT_EXTRAIT.match(k.get('d') or '')]
    print('marqueurs existants : %d, dont %d ecrits a la main' % (len(anciens), len(manuels)))

    cartes = charger_conf()
    tous = []
    print()
    for nom, chemin in cartes.items():
        libelle = LIBELLES.get(nom, nom)
        m, cellules = extraire(chemin, libelle)
        tous.extend(m)
        etat = '' if cellules else '   CHEMIN INTROUVABLE'
        print('   %-18s %5d marqueurs   %4d cellules%s' % (libelle, len(m), cellules, etat))

    # Deduplication : deux cartes peuvent se recouvrir.
    vus = set()
    fusion = []
    for k in manuels + tous:
        cle = (k['x'], k['y'], k['z'], k['cat'])
        if cle in vus:
            continue
        vus.add(cle)
        fusion.append(k)
    fusion.sort(key=lambda k: (k['y'], k['x'], k['z']))

    with open(SORTIE, 'w', encoding='utf8') as f:
        json.dump(fusion, f, ensure_ascii=False, separators=(',', ':'))
    print('\ntotal : %d marqueurs (%+d)' % (len(fusion), len(fusion) - len(anciens)))
    print('ecrit : %s (%.0f Ko)' % (SORTIE, os.path.getsize(SORTIE) / 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
