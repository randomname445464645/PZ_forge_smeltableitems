"""Verification d'une piece contre la carte et contre les tables de loot.

Partage par extraire-marqueurs.py, qui ne pose une pastille que sur une piece
verifiee, et par verifier-marqueurs.py, qui audite un markers.json existant.

Ecrit apres un faux positif signale en jeu : la "Reserve de banque" de
Maplewood (bankstorage, 8248,8590) n'a aucun meuble. C'est un palier
d'escalator que le cartographe a nomme bankstorage. La verification d'avant
ne regardait que les TABLES de loot, jamais les meubles reellement poses.

Une piece est verifiee en deux temps :
  1. ses meubles de rangement, lus case par case dans les .lotpack et
     reconnus par la propriete "container" des definitions de tuiles du jeu
     et des mods (tuiles_conteneurs.py). Une piece peut etre declaree dans une
     cellule et deborder sur la voisine : chaque case est lue dans SA cellule.
  2. ce que ces meubles peuvent contenir : la table du type de meuble dans la
     piece, ou a defaut celle de 'all', comme le fait le jeu. Pour l'argent et
     l'or on suit aussi les conteneurs (mallette, sac de billets, portefeuille).

Les tables sont celles du jeu plus celles des mods installes, chargees comme
le jeu les charge : les mods ajoutent leurs tables procedurales dans des
fonctions branchees sur Events.OnPreDistributionMerge, et leurs pieces par
table.insert(Distributions, ...). On execute les deux.
"""
import collections
import glob
import json
import os
import re
import sys

RACINE = os.path.dirname(os.path.abspath(__file__))
PROJET = os.path.normpath(os.path.join(RACINE, '..', '..'))
MARQUEURS = os.path.join(PROJET, 'out', 'html', 'markers.json')
sys.path.insert(0, os.path.join(PROJET, 'pzmap2dzi'))
sys.path.insert(0, RACINE)

WORKSHOP = os.path.expanduser('~/.local/share/Steam/steamapps/workshop/content/108600')

# Fichiers Lua de loot des mods installes, releves a la main dans le workshop.
LUA_MODS = [
    '3747595202/mods/Greenport B42/common/media/lua/server/items/GP_ProceduralDistributions.lua',
    '3747595202/mods/Greenport B42/common/media/lua/server/items/GP_Distributions.lua',
    '3768876083/mods/Trelai_B42/42/media/lua/server/Items/trelaiProceduralDistributions.lua',
    '3768876083/mods/Trelai_B42/common/media/lua/server/Items/trelailootzonesdistro.lua',
    '3628736763/mods/CommunityTilePack/common/media/lua/server/items/CTP_Definitions.lua',
]

VANILLA_LUA = [
    'Distribution_BagsAndContainers.lua', 'Distribution_BinJunk.lua',
    'Distribution_ClosetJunk.lua', 'Distribution_CounterJunk.lua',
    'Distribution_DeskJunk.lua', 'Distribution_ShelfJunk.lua',
    'Distribution_SideTableJunk.lua',
    'ProceduralDistributions.lua', 'Distributions.lua',
]

BILLETS = {'Money', 'MoneyBundle'}


def est_or(objet):
    o = objet.split('.')[-1]
    return 'Gold' in o and not o.startswith('Goldfish')


# ---------------------------------------------------------------------------

def charger_tables(pz_root):
    import lupa
    from pzmap2dzi import lua_util
    env = lupa.LuaRuntime(unpack_returned_tuples=True)
    env.execute('''
        require = function() end
        __crochets = {}
        Events = setmetatable({}, {__index = function(t, k)
            local e = {Add = function(f) table.insert(__crochets, f) end,
                       Remove = function() end}
            rawset(t, k, e)
            return e
        end})
        function __lancer_crochets()
            for _, f in ipairs(__crochets) do pcall(f) end
        end
    ''')
    dossier = os.path.join(pz_root, 'media', 'lua', 'server', 'Items')
    for f in VANILLA_LUA:
        lua_util.run_lua_file(os.path.join(dossier, f), env=env)
    charges = []
    for rel in LUA_MODS:
        chemin = os.path.join(WORKSHOP, rel)
        if not os.path.isfile(chemin):
            continue
        try:
            lua_util.run_lua_file(chemin, env=env)
            charges.append(os.path.basename(chemin))
        except Exception as e:
            print('  mod illisible %s : %s' % (os.path.basename(chemin), str(e).split('\n')[0]))
    env.execute('__lancer_crochets()')
    g = env.globals()
    proc = lua_util.unpack_lua_table(g['ProceduralDistributions'])['list']
    listes = lua_util.unpack_lua_table(g['Distributions'])
    # Fusion comme le jeu : les tables suivantes completent la premiere,
    # piece par piece et meuble par meuble.
    dist = {}
    for bloc in listes:
        if not isinstance(bloc, dict):
            continue
        for piece, meubles in bloc.items():
            if isinstance(meubles, dict):
                cible = dist.setdefault(piece, {})
                cible.update(meubles)
    return proc, dist, charges


def objets(table):
    cumul = collections.Counter()
    liste = table.get('items') if isinstance(table, dict) else None
    if isinstance(liste, list):
        i = 0
        while i < len(liste) - 1:
            if isinstance(liste[i], str) and isinstance(liste[i + 1], (int, float)):
                cumul[liste[i].split('.')[-1]] += float(liste[i + 1])
                i += 2
            else:
                i += 1
    return cumul


class Tables:
    def __init__(self, proc, dist):
        self.proc = proc
        self.dist = dist
        self.contenants = {k: v for k, v in dist.items()
                           if isinstance(v, dict) and 'items' in v and 'procList' not in v}
        self.cache = {}
        # Ce qu'est un bijou, d'apres le jeu lui-meme : tout objet des tables
        # Jewelry* (Gems, Gold, Silver, Wrist, WeddingRings, NavelRings,
        # Others, StorageAll), 80 objets, moins la loupe qui est un outil.
        self.bijoux = set()
        for nom, t in proc.items():
            if nom.startswith('Jewelry') and isinstance(t, dict):
                self.bijoux.update(objets(t))
        self.bijoux.discard('Loupe')

    def parts(self, nom, prof=0, vus=frozenset()):
        """(billets, or, valeur) : part par tirage dans une table, conteneurs
        suivis. 'valeur' = billets, or ou bijou, chaque objet compte une fois."""
        if nom in vus or prof > 3:
            return 0.0, 0.0, 0.0
        cle = nom
        if cle in self.cache:
            return self.cache[cle]
        t = self.proc.get(nom) or self.contenants.get(nom)
        if not isinstance(t, dict):
            return 0.0, 0.0, 0.0
        o = objets(t)
        total = sum(o.values()) or 1
        b = g = v = 0.0
        for objet, p in o.items():
            f = p / total
            est_b, est_g = objet in BILLETS, est_or(objet)
            if est_b:
                b += f
            if est_g:
                g += f
            if est_b or est_g or objet in self.bijoux:
                v += f
            if objet in self.contenants:
                sb, sg, sv = self.parts(objet, prof + 1, vus | {nom})
                b += f * sb
                g += f * sg
                v += f * sv
        self.cache[cle] = (b, g, v)
        return b, g, v

    def meuble(self, piece, type_meuble):
        """Specification d'un type de meuble dans une piece, repli sur 'all'."""
        p = self.dist.get(piece)
        if isinstance(p, dict) and isinstance(p.get(type_meuble), dict):
            return p[type_meuble], piece
        a = self.dist.get('all', {})
        if isinstance(a.get(type_meuble), dict):
            return a[type_meuble], 'all'
        return None, None

    def esperance_meuble(self, piece, type_meuble):
        """(billets, or) attendus dans UN meuble de ce type, par remplissage.

        tirages de la table x part de l'objet x chance que la table soit
        choisie, sur la meilleure table du meuble. Une part par tirage ne
        suffit pas : la table vaultgoldstack de Trelai n'a que 0,35 % de
        lingots par tirage, mais elle tire 50 fois par coffre.
        """
        spec, source = self.meuble(piece, type_meuble)
        if not spec:
            return 0.0, 0.0, 0.0
        b = g = v = 0.0
        for e in (spec.get('procList') or []):
            t = self.proc.get(e.get('name'))
            if not isinstance(t, dict):
                continue
            k = float(t.get('rolls', 1) or 1) * float(e.get('weightChance', 100)) / 100
            sb, sg, sv = self.parts(e.get('name'))
            b, g, v = max(b, sb * k), max(g, sg * k), max(v, sv * k)
        if spec.get('items'):
            tmp = '__%s/%s' % (piece, type_meuble)
            self.contenants[tmp] = spec
            k = float(spec.get('rolls', 1) or 1)
            sb, sg, sv = self.parts(tmp)
            b, g, v = max(b, sb * k), max(g, sg * k), max(v, sv * k)
        return b, g, v

    def valeur_meuble(self, piece, type_meuble):
        spec, source = self.meuble(piece, type_meuble)
        if not spec:
            return 0.0, 0.0, None
        b = g = 0.0
        for e in (spec.get('procList') or []):
            f = float(e.get('weightChance', 100)) / 100
            sb, sg, _ = self.parts(e.get('name'))
            b = max(b, sb * f)
            g = max(g, sg * f)
        if spec.get('items'):
            tmp = '__%s/%s' % (piece, type_meuble)
            self.contenants[tmp] = spec
            sb, sg, _ = self.parts(tmp)
            b = max(b, sb)
            g = max(g, sg)
        return b, g, source




class Verificateur:
    """Meubles et contenu d'une piece donnee, avec caches par cellule."""

    def __init__(self, cartes, pz_root):
        from pzmap2dzi import lotheader, cell
        import tuiles_conteneurs
        self._lotheader, self._cell = lotheader, cell
        self.cartes = cartes
        proc, dist, self.mods = charger_tables(pz_root)
        self.tables = Tables(proc, dist)
        self.meubles = tuiles_conteneurs.charger(pz_root, [WORKSHOP])
        self._cellules = {}

    def cellule(self, nom, cx, cy):
        k = (nom, cx, cy)
        if k not in self._cellules:
            try:
                self._cellules[k] = self._cell.load_cell(self.cartes[nom], cx, cy)
            except Exception:
                self._cellules[k] = None
        return self._cellules[k]

    def entete(self, nom, cx, cy):
        k = ('h', nom, cx, cy)
        if k not in self._cellules:
            try:
                self._cellules[k] = self._lotheader.load_lotheader(self.cartes[nom], cx, cy)
            except Exception:
                self._cellules[k] = None
        return self._cellules[k]

    def piece_a(self, x, y, z, voulu=None, cartes=None):
        """Piece qui contient la case (x, y, z) : (carte, cx, cy, room, nom).

        Une piece est declaree dans UNE cellule mais ses rectangles peuvent
        deborder sur la voisine : la bijouterie en 13572,1275 est declaree
        dans la cellule 52,4 avec un rectangle a (253,246) de 15x11. On
        cherche donc dans les neuf cellules autour.
        """
        cx, cy = x // 256, y // 256
        meilleur = None
        for nom in (cartes or self.cartes):
            for hx in (cx, cx - 1, cx + 1):
                for hy in (cy, cy - 1, cy + 1):
                    h = self.entete(nom, hx, hy)
                    if not h:
                        continue
                    for r in h.get('rooms') or []:
                        if r.get('layer', 0) != z:
                            continue
                        for (rx, ry, w, hh) in r['rects']:
                            if (hx * 256 + rx <= x < hx * 256 + rx + w
                                    and hy * 256 + ry <= y < hy * 256 + ry + hh):
                                n = r['name']
                                n = n.decode('utf8', 'replace') if isinstance(n, bytes) else n
                                cand = (nom, hx, hy, r, n)
                                if voulu and n == voulu:
                                    return cand
                                meilleur = meilleur or cand
        return meilleur

    def oublier(self, nom=None):
        """Libere la memoire des cellules deja lues (une carte a la fois)."""
        if nom is None:
            self._cellules.clear()
        else:
            for k in [k for k in self._cellules if k[0] == nom]:
                del self._cellules[k]

    def types_meubles(self, nom, cx, cy, room):
        """Compte des types de meubles de rangement dans une piece."""
        types = collections.Counter()
        z = room.get('layer', 0)
        for (rx, ry, w, hh) in room['rects']:
            for wx in range(cx * 256 + rx, cx * 256 + rx + w):
                for wy in range(cy * 256 + ry, cy * 256 + ry + hh):
                    c = self.cellule(nom, wx // 256, wy // 256)
                    if not c:
                        continue
                    for t in (c.get_square(wx % 256, wy % 256, z) or []):
                        m = self.meubles.get(t)
                        if m:
                            types[m] += 1
        return types

    def contenu(self, piece, types):
        """(part billets, part or) par tirage, sur le meilleur meuble present."""
        b = g = 0.0
        for t in types:
            sb, sg, _ = self.tables.valeur_meuble(piece, t)
            b, g = max(b, sb), max(g, sg)
        return b, g

    def esperance(self, piece, types):
        """{'billets', 'or', 'valeur'} attendus en vidant la piece une fois.

        Chaque tuile de rangement est un conteneur a part dans le jeu : un
        comptoir sur deux cases, ce sont deux conteneurs.
        """
        r = {'billets': 0.0, 'or': 0.0, 'valeur': 0.0}
        for t, n in types.items():
            eb, eg, ev = self.tables.esperance_meuble(piece, t)
            r['billets'] += n * eb
            r['or'] += n * eg
            r['valeur'] += n * ev
        return r

    def a_du_loot(self, piece, types):
        """Au moins un meuble present a une table, dans la piece ou dans 'all'."""
        return any(self.tables.meuble(piece, t)[0] for t in types)
