// Geometrie des pyramides de tuiles et conversions de coordonnees.
//
// Rien n'est code en dur ici : toute la geometrie est lue au demarrage dans les
// fichiers produits par pzmap2dzi, pour que le viewer marche quel que soit le
// reglage top_view_square_size (1 ou 2 px par case).
//
//   map_info.json  ->  w, h, x0, y0, sqr, cell_rects
//   layer0.dzi     ->  TileSize et Size (source de verite pour les tuiles)
//
// Convention pzmap2dzi (voir pzmap/map.js, square2pixel) :
//   pixel_local = x0 + coordonnee_monde * sqr
// x0 integre deja le facteur sqr. L'origine monde d'une pyramide vaut donc
// (-x0 / sqr, -y0 / sqr) et son emprise monde (w / sqr, h / sqr).
// Les coordonnees "monde" sont celles que le jeu affiche, en cases.

export const CASES_PAR_CELLULE = 256;   // B42

// Identite des pyramides. L'ordre fixe l'ordre de dessin : la vanilla d'abord,
// les cartes moddees par-dessus.
export const PYRAMIDES = [
  { nom: 'base_top',        libelle: 'Knox County (vanilla)',      mod: false, racine: 'map_data/base_top' },
  { nom: 'RavenCreek_B42',  libelle: 'Raven Creek',                mod: true },
  { nom: 'Constown_B42',    libelle: 'Constown',                   mod: true },
  { nom: 'Trelai_B42',      libelle: 'Trelai',                     mod: true },
  { nom: 'NewHartburg_B42', libelle: 'New Hartburg',               mod: true },
  { nom: 'Greenport_B42',   libelle: 'Greenport',                  mod: true },
  { nom: 'Maplewood_B42',   libelle: 'Maplewood',                  mod: true },
  { nom: 'LQZ_B42',         libelle: 'Louisville Quarantine Zone', mod: true },
  { nom: 'Chestown_B42',    libelle: 'Chestown',                   mod: true },
];

for (const p of PYRAMIDES) {
  if (!p.racine) p.racine = `map_data/mod_maps/${p.nom}/base_top`;
}

// Emprise globale : union de toutes les pyramides, remplie par chargerGeometrie().
// Raven Creek descend sous le bord inferieur de la vanilla, d'ou l'union plutot
// que les seules bornes vanilla.
export const EMPRISE = { x0: 0, y0: 0, x1: 0, y1: 0 };

function lireDzi(texte) {
  const doc = new DOMParser().parseFromString(texte, 'application/xml');
  const image = doc.querySelector('Image');
  const taille = doc.querySelector('Size');
  if (!image || !taille) throw new Error('fichier .dzi illisible');
  return {
    tailleTuile: parseInt(image.getAttribute('TileSize'), 10),
    format: image.getAttribute('Format') || 'webp',
    w: parseInt(taille.getAttribute('Width'), 10),
    h: parseInt(taille.getAttribute('Height'), 10),
  };
}

/**
 * Charge la geometrie reelle de chaque pyramide. A appeler une fois avant le
 * premier rendu. Une pyramide dont les fichiers manquent est ecartee plutot que
 * de faire echouer tout le viewer.
 */
export async function chargerGeometrie() {
  const retenues = [];

  await Promise.all(PYRAMIDES.map(async p => {
    try {
      const [info, dzi] = await Promise.all([
        fetch(`${p.racine}/map_info.json`).then(r => {
          if (!r.ok) throw new Error(r.status);
          return r.json();
        }),
        fetch(`${p.racine}/layer0.dzi`).then(r => {
          if (!r.ok) throw new Error(r.status);
          return r.text();
        }).then(lireDzi),
      ]);

      p.sqr = info.sqr || 1;              // px d'image par case, 1 ou 2
      p.w = dzi.w;                        // taille en px d'image, pleine resolution
      p.h = dzi.h;
      p.tailleTuile = dzi.tailleTuile;    // 256 si sqr=1, 512 si sqr=2
      p.format = dzi.format;
      p.cellules = info.cell_rects || [];
      p.cellSize = info.cell_size || CASES_PAR_CELLULE;

      // Niveau DZI de pleine resolution.
      p.niveauMax = Math.ceil(Math.log2(Math.max(p.w, p.h)));
      // Niveau ou 1 px d'image vaut exactement 1 case monde. C'est lui qui
      // sert de reference pour le choix du niveau, pas le niveau max : avec
      // sqr = 2 la pleine resolution est deja un agrandissement x2.
      p.niveau1a1 = p.niveauMax - Math.log2(p.sqr);

      // Emprise en coordonnees monde.
      p.mondeX = -info.x0 / p.sqr;
      p.mondeY = -info.y0 / p.sqr;
      p.mondeX1 = p.mondeX + p.w / p.sqr;
      p.mondeY1 = p.mondeY + p.h / p.sqr;

      retenues.push(p);
    } catch (e) {
      console.warn(`pyramide ${p.nom} ignoree :`, e.message);
      p.absente = true;
    }
  }));

  if (!retenues.length) throw new Error('aucune pyramide de tuiles lisible');

  EMPRISE.x0 = Math.min(...retenues.map(p => p.mondeX));
  EMPRISE.y0 = Math.min(...retenues.map(p => p.mondeY));
  EMPRISE.x1 = Math.max(...retenues.map(p => p.mondeX1));
  EMPRISE.y1 = Math.max(...retenues.map(p => p.mondeY1));
  return retenues;
}

/** Les pyramides effectivement chargees, dans l'ordre de dessin. */
export function pyramidesActives() {
  return PYRAMIDES.filter(p => !p.absente && p.niveauMax !== undefined);
}

/**
 * Niveau DZI a charger pour une pyramide donnee.
 *
 * L'echelle vaut toujours 2^zoom (paliers exacts). Au niveau niveau1a1, un px
 * d'image vaut une case ; au niveau L, il vaut 2^(niveau1a1 - L) cases. Pour
 * obtenir exactement 1 px d'image par pixel PHYSIQUE d'ecran il faut
 * 2^(niveau1a1 - L) = 1 / (echelle * dpr), soit L = niveau1a1 + zoom + boostDpr.
 *
 * boostDpr = ceil(log2(devicePixelRatio)) : sur un ecran HiDPI on monte d'un
 * cran dans la pyramide, sinon tout est flou par construction.
 */
export function niveauPour(pyramide, zoom, boostDpr) {
  const voulu = pyramide.niveau1a1 + zoom + boostDpr;
  return Math.max(0, Math.min(pyramide.niveauMax, voulu));
}

/** Nombre de cases monde couvertes par un pixel d'image au niveau L. */
export function facteurNiveau(pyramide, niveau) {
  return 2 ** (pyramide.niveau1a1 - niveau);
}

/** Taille en pixels d'image du niveau L (le dernier rang de tuiles est rogne). */
export function tailleNiveau(pyramide, niveau) {
  const reduction = 2 ** (pyramide.niveauMax - niveau);
  return {
    w: Math.ceil(pyramide.w / reduction),
    h: Math.ceil(pyramide.h / reduction),
  };
}

/**
 * URL d'une tuile. layer0 = niveau du sol, le seul rendu utilise ici.
 *
 * Le jeton ?r= est indispensable : les tuiles sont servies avec un cache d'une
 * semaine, et un changement de top_view_square_size reutilise les MEMES URLs
 * avec un contenu et une taille differents (au rendu 1 px/case le niveau 15
 * porte des tuiles de 256 px, au rendu 2 px/case des tuiles de 512 px). Sans
 * jeton, le navigateur servirait les anciennes. Le jeton est derive de la
 * geometrie, il change donc tout seul a chaque changement de rendu.
 *
 * Limite connue : un nouveau rendu de meme geometrie (mise a jour d'un mod
 * sans changement d'emprise) ne bouscule pas le jeton. Vider le cache du
 * navigateur dans ce cas, ou incrementer VERSION_TUILES ci-dessous.
 */
const VERSION_TUILES = 1;

export function urlTuile(pyramide, niveau, tx, ty) {
  return `${pyramide.racine}/layer0_files/${niveau}/${tx}_${ty}.${pyramide.format}`
       + `?r=${VERSION_TUILES}.${pyramide.sqr}.${pyramide.w}x${pyramide.h}`;
}

/**
 * La tuile (tx, ty) recouvre-t-elle au moins une cellule reellement rendue ?
 * Evite de demander des tuiles absentes : l'emprise vanilla n'est pas un
 * rectangle plein (4065 cellules sur 78 x 63 possibles) et les pyramides
 * moddees comportent des cellules de remplissage sur leurs bords.
 */
export function tuileExiste(pyramide, niveau, tx, ty) {
  if (!pyramide.cellules.length) return true;
  const span = pyramide.tailleTuile * facteurNiveau(pyramide, niveau); // cases monde
  const wx0 = pyramide.mondeX + tx * span;
  const wy0 = pyramide.mondeY + ty * span;
  const cx0 = Math.floor(wx0 / pyramide.cellSize);
  const cy0 = Math.floor(wy0 / pyramide.cellSize);
  const cx1 = Math.floor((wx0 + span - 1) / pyramide.cellSize);
  const cy1 = Math.floor((wy0 + span - 1) / pyramide.cellSize);
  for (const [rx, ry, rw, rh] of pyramide.cellules) {
    if (cx1 >= rx && cx0 < rx + rw && cy1 >= ry && cy0 < ry + rh) return true;
  }
  return false;
}
