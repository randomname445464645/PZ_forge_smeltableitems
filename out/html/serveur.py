#!/usr/bin/env python3
"""Serveur de la carte PZ together.

La carte est statique a une exception pres : POST /api/sync relance le
convertisseur du releve de l'agent d'export, pour rafraichir le calque des
constructions sans passer par un terminal. Aucune donnee du jeu n'est lue ni
ecrite par le serveur lui-meme, il ne fait qu'appeler un script fixe.

Rien d'autre n'a besoin de flask ni de waitress, la bibliotheque standard
suffit.

server.py (le serveur de pzmap2dzi, avec ses routes de trimming) reste en
place et intact ; il n'est simplement plus necessaire pour la carte.
"""

import json
import os
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = 8880
RACINE = os.path.dirname(os.path.realpath(__file__))

# Les tuiles et les icones ne changent jamais : cache long.
# Le code de la carte change a chaque retouche : jamais de cache.
CACHE_LONG = ('.webp', '.png', '.jpg')
SANS_CACHE = ('.html', '.js', '.css', '.json', '.dzi', '.webmanifest')


# --- synchronisation du releve de l'agent -----------------------------------
# Le convertisseur a besoin de Pillow, donc du python de l'environnement
# virtuel du projet, pas de celui du systeme.
PROJET = os.path.normpath(os.path.join(RACINE, '..', '..'))
CONVERTISSEUR = os.path.join(PROJET, 'outils', 'agent-monde', 'convertir.py')
PYTHON_VENV = os.path.join(PROJET, '.venv', 'bin', 'python')
DELAI_SYNC = 300          # secondes ; 120 000 cases se convertissent en ~20 s

# Une seule synchronisation a la fois : deux convertisseurs ecrivant le meme
# fichier produiraient un JSON tronque.
_verrou_sync = threading.Lock()


def synchroniser():
    """Relance le convertisseur. Retourne (code HTTP, dict de reponse)."""
    if not os.path.isfile(CONVERTISSEUR):
        return 500, {'ok': False, 'erreur': 'convertisseur introuvable : %s' % CONVERTISSEUR}
    python = PYTHON_VENV if os.path.isfile(PYTHON_VENV) else sys.executable

    if not _verrou_sync.acquire(blocking=False):
        return 409, {'ok': False, 'erreur': 'une synchronisation est deja en cours'}
    try:
        r = subprocess.run([python, CONVERTISSEUR],
                           capture_output=True, text=True, timeout=DELAI_SYNC)
    except subprocess.TimeoutExpired:
        return 504, {'ok': False, 'erreur': 'delai depasse (%d s)' % DELAI_SYNC}
    except Exception as e:
        return 500, {'ok': False, 'erreur': str(e)}
    finally:
        _verrou_sync.release()

    sortie = (r.stdout or '').strip()
    if r.returncode != 0:
        # Le convertisseur explique lui-meme ce qui manque (releve absent...).
        detail = (r.stderr or sortie or 'code %d' % r.returncode).strip()
        return 500, {'ok': False, 'erreur': detail.splitlines()[0] if detail else 'echec'}

    # On renvoie le resume du convertisseur, que la page affiche tel quel.
    infos = {}
    for ligne in sortie.splitlines():
        if ':' in ligne:
            cle, _, val = ligne.partition(':')
            infos[cle.strip()] = val.strip()
    return 200, {'ok': True, 'resume': sortie, 'infos': infos}


class Handler(SimpleHTTPRequestHandler):
    # HTTP/1.1 : connexions persistantes. Indispensable quand une vue charge
    # des dizaines de tuiles, et exige par certains navigateurs pour accepter
    # un service worker. La taille est toujours annoncee pour les fichiers,
    # la condition de HTTP/1.1 est donc remplie.
    protocol_version = 'HTTP/1.1'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=RACINE, **kwargs)

    def end_headers(self):
        chemin = self.path.split('?', 1)[0].lower()
        if chemin.endswith(CACHE_LONG):
            self.send_header('Cache-Control', 'public, max-age=604800')
        elif chemin.endswith(SANS_CACHE):
            self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()

    def do_POST(self):
        chemin = self.path.split('?', 1)[0]
        if chemin != '/api/sync':
            self.send_error(404)
            return
        # Un en-tete non standard ne peut pas etre pose par une page d'une
        # autre origine sans requete preliminaire, a laquelle on ne repond
        # pas. Cela suffit a empecher un site tiers de declencher la
        # synchronisation a ton insu.
        if self.headers.get('X-Carte') != 'sync':
            self.send_error(403, 'en-tete X-Carte manquant')
            return

        code, reponse = synchroniser()
        corps = json.dumps(reponse).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(corps)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(corps)

    def log_message(self, fmt, *args):
        # On ne veut voir que les erreurs, pas les 5000 tuiles servies.
        code = args[1] if len(args) > 1 else ''
        if str(code).startswith(('4', '5')):
            sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))


Handler.extensions_map.setdefault('.webp', 'image/webp')
# Sans ce type MIME, Chrome ignore le manifeste et refuse d'installer la PWA.
Handler.extensions_map.setdefault('.webmanifest', 'application/manifest+json')
Handler.extensions_map.setdefault('.dzi', 'application/xml')

if __name__ == '__main__':
    serveur = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print('Carte servie sur http://127.0.0.1:%d/carte.html' % PORT)
    try:
        serveur.serve_forever()
    except KeyboardInterrupt:
        pass
