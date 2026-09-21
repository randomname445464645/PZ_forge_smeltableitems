#!/usr/bin/env python3
"""Serveur statique pour la carte PZ together.

La carte est 100 % statique : aucun acces aux sauvegardes du jeu, aucune
ecriture, aucune synchronisation. On n'a donc besoin ni de flask ni de
waitress, juste de la bibliotheque standard.

server.py (le serveur de pzmap2dzi, avec ses routes de trimming) reste en
place et intact ; il n'est simplement plus necessaire pour la carte.
"""

import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = 8880
RACINE = os.path.dirname(os.path.realpath(__file__))

# Les tuiles et les icones ne changent jamais : cache long.
# Le code de la carte change a chaque retouche : jamais de cache.
CACHE_LONG = ('.webp', '.png', '.jpg')
SANS_CACHE = ('.html', '.js', '.css', '.json', '.dzi')


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=RACINE, **kwargs)

    def end_headers(self):
        chemin = self.path.split('?', 1)[0].lower()
        if chemin.endswith(CACHE_LONG):
            self.send_header('Cache-Control', 'public, max-age=604800')
        elif chemin.endswith(SANS_CACHE):
            self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):
        # On ne veut voir que les erreurs, pas les 5000 tuiles servies.
        code = args[1] if len(args) > 1 else ''
        if str(code).startswith(('4', '5')):
            sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))


Handler.extensions_map.setdefault('.webp', 'image/webp')
Handler.extensions_map.setdefault('.dzi', 'application/xml')

if __name__ == '__main__':
    serveur = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print('Carte servie sur http://127.0.0.1:%d/carte.html' % PORT)
    try:
        serveur.serve_forever()
    except KeyboardInterrupt:
        pass
