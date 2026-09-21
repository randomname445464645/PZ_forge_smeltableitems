// Service worker de la carte PZ together.
//
// REGLE ABSOLUE : ne jamais mettre les tuiles en cache. La pyramide
// isometrique pese 359 Go et la vue de dessus 197 Go. Tout ce qui passe par
// map_data/ va directement au reseau, sans jamais toucher au Cache Storage,
// qui remplirait le disque et ferait echouer le quota du navigateur.
//
// Seule la coquille est mise en cache : la page, le code, les icones et les
// marqueurs, soit moins de 500 Ko. C'est ce qui permet a la fenetre de
// s'ouvrir instantanement et de fonctionner meme si le serveur local n'a pas
// encore demarre.

const VERSION = 'carte-pz-v3';   // v3 : nouveau logo

// Chemins de la coquille. Les parametres ?v= des balises sont conserves tels
// quels : c'est l'URL complete qui sert de cle de cache.
const COQUILLE = [
  '/carte.html',
  '/carte/style.css',
  '/carte/app.js',
  '/carte/geometrie.js',
  '/carte/vue.js',
  '/carte/marqueurs.js',
  '/carte/rues.js',
  '/carte/loot.js',
  '/markers.json',
  '/favicon.ico',
  '/manifest.webmanifest',
  '/pwa/icone-192.png',
  '/pwa/icone-512.png',
  '/pwa/icone-512-maskable.png',
  '/icons/top.png', '/icons/or.png', '/icons/billets.png', '/icons/valeur.png',
  '/icons/armes.png', '/icons/medical.png', '/icons/outils.png',
  '/icons/bouffe.png', '/icons/essence.png', '/icons/labo.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      // addAll echoue en bloc si UN seul fichier manque : on tolere les
      // absences pour ne pas casser l'installation entiere.
      .then(c => Promise.all(COQUILLE.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(noms => Promise.all(noms.filter(n => n !== VERSION).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Les tuiles et tout ce qui vient du rendu : reseau direct, jamais de cache.
  if (url.pathname.startsWith('/map_data/')) return;

  // La PAGE elle-meme passe par le reseau d'abord, avec repli sur le cache.
  // Servie depuis le cache, elle continuerait de reclamer les anciennes
  // versions de app.js et style.css apres une retouche, et il faudrait deux
  // rechargements pour voir un changement. Elle ne pese que quelques Ko, le
  // detour par le reseau ne coute rien en local.
  const estPage = e.request.mode === 'navigate'
               || url.pathname === '/' || url.pathname.endsWith('.html');
  if (estPage) {
    e.respondWith(
      fetch(e.request).then(rep => {
        if (rep && rep.ok) {
          const copie = rep.clone();
          caches.open(VERSION).then(c => c.put(e.request, copie));
        }
        return rep;
      }).catch(() => caches.match(e.request).then(r => r || caches.match('/carte.html')))
    );
    return;
  }

  // Le reste de la coquille : cache d'abord, rafraichi derriere.
  e.respondWith(
    caches.match(e.request).then(enCache => {
      const reseau = fetch(e.request).then(rep => {
        if (rep && rep.ok) {
          const copie = rep.clone();
          caches.open(VERSION).then(c => c.put(e.request, copie));
        }
        return rep;
      }).catch(() => enCache);
      return enCache || reseau;
    })
  );
});
