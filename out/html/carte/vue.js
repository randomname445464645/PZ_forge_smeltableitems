// Etat de la vue et moteur de tuiles.
//
// Principe de nettete (objectif numero un) :
//  - l'echelle est TOUJOURS une puissance de deux exacte : echelle = 2^zoom.
//    Un cran de molette double ou divise par deux, jamais 1,25 ou 0,8.
//  - le niveau de pyramide est choisi pour qu'un pixel de tuile tombe sur un
//    pixel PHYSIQUE d'ecran (devicePixelRatio pris en compte).
//  - le rendu source est a 2 px par case (top_view_square_size: 2), donc la
//    pleine resolution est deja un agrandissement x2 : c'est le niveau ou
//    1 px d'image vaut 1 case qui sert de reference, pas le niveau max.
//  - aucune transformation CSS sur le conteneur : chaque tuile est positionnee
//    et dimensionnee directement en pixels CSS. Un transform: scale() sur le
//    calque force une rasterisation intermediaire qui refloute tout.
//  - image-rendering choisi a chaque rendu : pixelated seulement quand on
//    agrandit au-dela du 1:1, filtrage lisse sinon. Jamais de plus proche
//    voisin en reduction, c'est ce qui faisait fourmiller la carte.

import {
  EMPRISE, pyramidesActives,
  niveauPour, facteurNiveau, tailleNiveau, urlTuile, tuileExiste,
} from './geometrie.js';

export const ZOOM_MIN = -6;   // echelle 1/64 : la carte entiere tient en 312 px
export const ZOOM_MAX = 3;    // echelle 8    : 8 px par case

export const vue = {
  zoom: -2,       // echelle = 2^zoom, en px CSS par case monde
  panX: 0,        // position ecran (px CSS) de la case monde x = 0
  panY: 0,
  largeur: 0,     // taille du viewport en px CSS
  hauteur: 0,
};

/** Echelle courante : px CSS par case monde. Toujours une puissance de deux. */
export function echelle() {
  return 2 ** vue.zoom;
}

/**
 * Ecran HiDPI : on monte de ceil(log2(dpr)) crans dans la pyramide pour
 * afficher a la resolution native. dpr = 2 -> une tuile dessinee a 0,5 px CSS
 * par pixel de tuile, soit exactement 1 px physique.
 */
export function boostDpr() {
  return Math.max(0, Math.ceil(Math.log2(window.devicePixelRatio || 1)));
}

// --- conversions -----------------------------------------------------------

export const mondeVersEcranX = x => vue.panX + x * echelle();
export const mondeVersEcranY = y => vue.panY + y * echelle();
export const ecranVersMondeX = sx => (sx - vue.panX) / echelle();
export const ecranVersMondeY = sy => (sy - vue.panY) / echelle();

/** Centre de la vue, en coordonnees monde. */
export function centreMonde() {
  return {
    x: ecranVersMondeX(vue.largeur / 2),
    y: ecranVersMondeY(vue.hauteur / 2),
  };
}

// --- deplacements ----------------------------------------------------------

/**
 * Le pan est garde en entiers de px CSS : c'est ce qui garantit que les bords
 * de tuiles tombent sur des frontieres de pixels et qu'aucune tuile n'est
 * reechantillonnee lors d'un simple deplacement.
 */
function normaliserPan() {
  vue.panX = Math.round(vue.panX);
  vue.panY = Math.round(vue.panY);
  const e = echelle();
  // On garde toujours un bout de carte a l'ecran, sans interdire le
  // debordement de Raven Creek sous la carte vanilla.
  const marge = 200;
  const minX = -EMPRISE.x1 * e + marge, maxX = -EMPRISE.x0 * e + vue.largeur - marge;
  const minY = -EMPRISE.y1 * e + marge, maxY = -EMPRISE.y0 * e + vue.hauteur - marge;
  if (minX < maxX) vue.panX = Math.min(maxX, Math.max(minX, vue.panX));
  if (minY < maxY) vue.panY = Math.min(maxY, Math.max(minY, vue.panY));
}

export function deplacer(dxEcran, dyEcran) {
  vue.panX += dxEcran;
  vue.panY += dyEcran;
  normaliserPan();
}

/** Zoom d'un cran (+1 ou -1) en gardant fixe le point ecran (sx, sy). */
export function zoomer(delta, sx, sy) {
  const nouveau = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, vue.zoom + delta));
  if (nouveau === vue.zoom) return false;
  const wx = ecranVersMondeX(sx), wy = ecranVersMondeY(sy);
  vue.zoom = nouveau;
  const e = echelle();
  vue.panX = sx - wx * e;
  vue.panY = sy - wy * e;
  normaliserPan();
  return true;
}

/** Centre la vue sur une coordonnee monde, avec un zoom optionnel. */
export function centrerSur(x, y, zoom) {
  if (zoom !== undefined) vue.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(zoom)));
  const e = echelle();
  vue.panX = vue.largeur / 2 - x * e;
  vue.panY = vue.hauteur / 2 - y * e;
  normaliserPan();
}

/** Plus grand palier de zoom dans lequel le rectangle monde tient entierement. */
export function cadrerSur(x0, y0, x1, y1, marge = 80) {
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const voulu = Math.min(
    (vue.largeur - 2 * marge) / w,
    (vue.hauteur - 2 * marge) / h,
  );
  const z = Math.floor(Math.log2(Math.max(1e-6, voulu)));
  centrerSur((x0 + x1) / 2, (y0 + y1) / 2, z);
}

// --- moteur de tuiles ------------------------------------------------------

const tuiles = new Map();   // cle -> HTMLImageElement
let conteneur = null;

export function initTuiles(element) {
  conteneur = element;
}

/**
 * Redessine toutes les tuiles visibles. Retourne le facteur de rendu courant
 * (pixels physiques d'ecran par pixel de tuile) pour information.
 */
export function dessinerTuiles() {
  const e = echelle();
  const boost = boostDpr();
  const dpr = window.devicePixelRatio || 1;
  const gardees = new Set();
  const actives = pyramidesActives();

  // Pixels physiques d'ecran par pixel de tuile. Vaut 1 quand le niveau n'est
  // pas sature et que dpr est une puissance de deux. Calcule une fois sur la
  // pyramide de base : toutes partagent le meme sqr, donc le meme comportement,
  // et cette valeur reste juste meme si la vanilla n'est pas a l'ecran.
  const reference = actives[0];
  const facteurRendu = reference
    ? facteurNiveau(reference, niveauPour(reference, vue.zoom, boost)) * e * dpr
    : 1;

  for (const p of actives) {
    const niveau = niveauPour(p, vue.zoom, boost);
    const f = facteurNiveau(p, niveau);          // cases monde par px d'image
    const taille = tailleNiveau(p, niveau);
    const spanMonde = p.tailleTuile * f;         // cases monde par tuile

    // Fenetre visible, en coordonnees monde, ramenee dans la pyramide.
    const vx0 = Math.max(p.mondeX, ecranVersMondeX(0));
    const vy0 = Math.max(p.mondeY, ecranVersMondeY(0));
    const vx1 = Math.min(p.mondeX1, ecranVersMondeX(vue.largeur));
    const vy1 = Math.min(p.mondeY1, ecranVersMondeY(vue.hauteur));
    if (vx1 <= vx0 || vy1 <= vy0) continue;

    const tx0 = Math.floor((vx0 - p.mondeX) / spanMonde);
    const ty0 = Math.floor((vy0 - p.mondeY) / spanMonde);
    const tx1 = Math.floor((vx1 - 1e-6 - p.mondeX) / spanMonde);
    const ty1 = Math.floor((vy1 - 1e-6 - p.mondeY) / spanMonde);

    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (tx < 0 || ty < 0) continue;
        if (tx * p.tailleTuile >= taille.w || ty * p.tailleTuile >= taille.h) continue;
        if (!tuileExiste(p, niveau, tx, ty)) continue;

        const cle = `${p.nom}|${niveau}|${tx}|${ty}`;
        gardees.add(cle);

        // Le dernier rang de tuiles d'un niveau est rogne : sa taille reelle
        // en pixels d'image est inferieure a p.tailleTuile, ne pas l'etirer.
        const largeurImg = Math.min(p.tailleTuile, taille.w - tx * p.tailleTuile);
        const hauteurImg = Math.min(p.tailleTuile, taille.h - ty * p.tailleTuile);
        const gauche = vue.panX + (p.mondeX + tx * spanMonde) * e;
        const haut = vue.panY + (p.mondeY + ty * spanMonde) * e;

        let img = tuiles.get(cle);
        if (!img) {
          img = new Image();
          img.draggable = false;          // sinon le navigateur lance son
          img.className = 'tuile';        // glisser-deposer natif et le pan
          img.alt = '';                   // se bloque
          img.decoding = 'async';
          img.style.zIndex = p.mod ? 2 : 1;
          img.src = urlTuile(p, niveau, tx, ty);
          img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
          tuiles.set(cle, img);
          conteneur.appendChild(img);
        }
        img.style.left = gauche + 'px';
        img.style.top = haut + 'px';
        img.style.width = (largeurImg * f * e) + 'px';
        img.style.height = (hauteurImg * f * e) + 'px';
      }
    }
  }

  for (const [cle, img] of tuiles) {
    if (!gardees.has(cle)) { img.remove(); tuiles.delete(cle); }
  }

  // pixelated uniquement en agrandissement : en reduction le plus proche
  // voisin jette des pixels et produit le fourmillement.
  conteneur.classList.toggle('net', facteurRendu > 1.001);
  return facteurRendu;
}

/** Diagnostic : etat du rendu, utilise par le bandeau d'information. */
export function infoRendu() {
  const boost = boostDpr();
  const dpr = window.devicePixelRatio || 1;
  const base = pyramidesActives()[0];
  if (!base) return null;
  const niveau = niveauPour(base, vue.zoom, boost);
  const f = facteurNiveau(base, niveau);
  return {
    zoom: vue.zoom,
    echelle: echelle(),
    niveau,
    niveauMax: base.niveauMax,
    sqr: base.sqr,
    dpr,
    facteurRendu: f * echelle() * dpr,
    tuiles: tuiles.size,
  };
}
