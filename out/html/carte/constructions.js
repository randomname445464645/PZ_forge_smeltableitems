// Calque des constructions relevees en jeu par l'agent d'export.
//
// Deux rendus selon le mode et le zoom :
//
//   TUILES REELLES, en isometrique et assez zoome. Les vrais sprites du jeu
//   sont dessines par dessus la carte, avec les textures extraites par
//   "main.py unpack". C'est le meme dessin que pzmap2dzi, refait cote
//   navigateur pour etre vivant : pas de re-rendu a chaque partie.
//
//   EMPRISE, sinon. Des quadrilateres dores qui montrent ou sont les
//   constructions. En vue de dessus, dessiner des sprites isometriques n'aurait
//   aucun sens ; trop dezoome, ils seraient illisibles.
//
// REGLE DE DESSIN, reprise de render_impl/base.py et de pzdzi.IsoDZI :
//
//   bas_centre_x = (x - y) * GRID_W                       GRID_W = 64
//   bas_centre_y = (x + y + 2) * GRID_H - LAYER_H * z     GRID_H = 32
//   sprite dessine en (bas_centre + ox, bas_centre + oy)  LAYER_H = 192
//
// base.py fait "oy += dzi.sqr_height >> 1" pour passer du centre au bas du
// losange, d'ou le +2 au lieu de +1. Les decalages ox/oy sont propres a chaque
// sprite et viennent des metadonnees PNG, relayees par constructions-sprites.json.

import { vue, echelle, mondeVersEcranX, mondeVersEcranY,
         empriseMondeVisible, planVersEcranX, planVersEcranY } from './vue.js';
import { mode } from './geometrie.js';

const SOURCE = 'constructions.json';
const SOURCE_SPRITES = 'constructions-sprites.json';
const RACINE_TEXTURES = 'texture';

const GRID_W = 64, GRID_H = 32, LAYER_H = 192;

const SEAU = 32;                 // cote du seau de l'index spatial, en cases
const CASE_MIN_DETAIL = 3;       // en dessous, on dessine l'emprise des seaux
const CASE_MIN_SPRITES = 6;      // en dessous, les sprites sont illisibles

let canvas = null, ctx = null;
let cases = null;                // [x, y, z, [rang, ...]]
let noms = null;                 // rang -> nom de sprite
let metas = null;                // nom -> [dossier, w, h, ox, oy]
let index = null;                // "sx,sy" -> [indices dans cases]
let chargement = null;
export let actif = false;

// Cache d'images. La valeur vaut null tant que le chargement est en cours,
// false si l'image est definitivement absente : sans ce troisieme etat on
// redemanderait en boucle un sprite manquant a chaque image.
const images = new Map();
let aRedessiner = null;

export function initConstructions(element) {
  canvas = element;
  ctx = canvas.getContext('2d');
}

export function surChargement(rappel) { aRedessiner = rappel; }
export function disponible() { return cases !== null && cases.length > 0; }
export function nombreCases() { return cases ? cases.length : 0; }

export function basculerConstructions(valeur) {
  actif = valeur;
  if (actif && !cases && !chargement) {
    chargement = Promise.all([
      fetch(SOURCE).then(r => (r.ok ? r.json() : null)).catch(() => null),
      fetch(SOURCE_SPRITES).then(r => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([d, m]) => {
      cases = [];
      noms = (d && d.sprites) || [];
      metas = m || {};
      index = new Map();
      if (d && d.cases) {
        for (const c of d.cases) {
          const i = cases.length;
          cases.push(c);
          const k = `${Math.floor(c[0] / SEAU)},${Math.floor(c[1] / SEAU)}`;
          let seau = index.get(k);
          if (!seau) { seau = []; index.set(k, seau); }
          seau.push(i);
        }
      }
      chargement = null;
    });
    return chargement;
  }
  return Promise.resolve();
}

/** Image d'un sprite, chargee a la demande. null = en cours, false = absente. */
function image(nom) {
  if (images.has(nom)) return images.get(nom);
  const meta = metas[nom];
  if (!meta) { images.set(nom, false); return false; }
  images.set(nom, null);
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => { images.set(nom, img); if (aRedessiner) aRedessiner(); };
  img.onerror = () => { images.set(nom, false); };
  img.src = `${RACINE_TEXTURES}/${meta[0]}/${encodeURIComponent(nom)}.png`;
  return null;
}

/** Cote apparent d'une case, en px CSS. Vaut dans les deux modes. */
function coteCase() {
  return Math.abs(mondeVersEcranX(1, 0) - mondeVersEcranX(0, 0))
       + Math.abs(mondeVersEcranY(1, 0) - mondeVersEcranY(0, 0));
}

function quadCase(x, y) {
  ctx.beginPath();
  ctx.moveTo(mondeVersEcranX(x, y), mondeVersEcranY(x, y));
  ctx.lineTo(mondeVersEcranX(x + 1, y), mondeVersEcranY(x + 1, y));
  ctx.lineTo(mondeVersEcranX(x + 1, y + 1), mondeVersEcranY(x + 1, y + 1));
  ctx.lineTo(mondeVersEcranX(x, y + 1), mondeVersEcranY(x, y + 1));
  ctx.closePath();
}

function preparerCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const lp = Math.round(vue.largeur * dpr), hp = Math.round(vue.hauteur * dpr);
  if (canvas.width !== lp || canvas.height !== hp) {
    canvas.width = lp; canvas.height = hp;
    canvas.style.width = vue.largeur + 'px';
    canvas.style.height = vue.hauteur + 'px';
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vue.largeur, vue.hauteur);
}

/** Indices des cases visibles, via l'index spatial. */
function visibles(x0, y0, x1, y1) {
  const out = [];
  const sx0 = Math.floor(x0 / SEAU), sx1 = Math.floor(x1 / SEAU);
  const sy0 = Math.floor(y0 / SEAU), sy1 = Math.floor(y1 / SEAU);
  for (let sy = sy0; sy <= sy1; sy++) {
    for (let sx = sx0; sx <= sx1; sx++) {
      const seau = index.get(`${sx},${sy}`);
      if (!seau) continue;
      for (const i of seau) {
        const c = cases[i];
        if (c[0] < x0 || c[0] > x1 || c[1] < y0 || c[1] > y1) continue;
        out.push(i);
      }
    }
  }
  return out;
}

export function dessinerConstructions() {
  if (!canvas) return;
  preparerCanvas();
  if (!actif || !cases || !cases.length) return;

  const { x0, y0, x1, y1 } = empriseMondeVisible(4);
  const cote = coteCase();
  const e = echelle();

  if (mode === 'iso' && cote >= CASE_MIN_SPRITES) {
    dessinerSprites(visibles(x0, y0, x1, y1), e);
  } else {
    dessinerEmprise(x0, y0, x1, y1, cote);
  }
}

/**
 * Dessin des vrais sprites, ordre du peintre : etage croissant, puis
 * profondeur isometrique croissante (x + y). Sans ce tri, un mur du fond
 * recouvrirait un mur du premier plan.
 */
function dessinerSprites(indices, e) {
  indices.sort((a, b) => {
    const ca = cases[a], cb = cases[b];
    return (ca[2] - cb[2]) || ((ca[0] + ca[1]) - (cb[0] + cb[1])) || (ca[0] - cb[0]);
  });

  // En agrandissement, du plus proche voisin : les sprites sont du pixel art,
  // un lissage les rendrait pateux. Meme regle que pour les tuiles.
  ctx.imageSmoothingEnabled = e < 1;

  for (const i of indices) {
    const c = cases[i];
    const bcx = (c[0] - c[1]) * GRID_W;
    const bcy = (c[0] + c[1] + 2) * GRID_H - LAYER_H * c[2];
    for (const rang of c[3]) {
      const nom = noms[rang];
      if (nom === undefined) continue;
      const img = image(nom);
      if (!img) continue;                 // null = en cours, false = absente
      const meta = metas[nom];
      ctx.drawImage(img,
        planVersEcranX(bcx + meta[3]),
        planVersEcranY(bcy + meta[4]),
        meta[1] * e, meta[2] * e);
    }
  }
  ctx.imageSmoothingEnabled = true;
}

/** Repli : emprise doree, quand les sprites n'ont pas de sens ou sont illisibles. */
function dessinerEmprise(x0, y0, x1, y1, cote) {
  ctx.fillStyle = 'rgba(216, 162, 74, 0.34)';
  ctx.strokeStyle = 'rgba(216, 162, 74, 0.85)';
  ctx.lineWidth = Math.min(2, Math.max(0.6, cote / 12));

  if (cote >= CASE_MIN_DETAIL) {
    for (const i of visibles(x0, y0, x1, y1)) {
      const c = cases[i];
      quadCase(c[0], c[1]);
      ctx.fill();
      if (cote >= 6) ctx.stroke();
    }
    return;
  }

  ctx.fillStyle = 'rgba(216, 162, 74, 0.55)';
  const sx0 = Math.floor(x0 / SEAU), sx1 = Math.floor(x1 / SEAU);
  const sy0 = Math.floor(y0 / SEAU), sy1 = Math.floor(y1 / SEAU);
  for (let sy = sy0; sy <= sy1; sy++) {
    for (let sx = sx0; sx <= sx1; sx++) {
      const seau = index.get(`${sx},${sy}`);
      if (!seau) continue;
      let ax = Infinity, ay = Infinity, bx = -Infinity, by = -Infinity;
      for (const i of seau) {
        const c = cases[i];
        if (c[0] < ax) ax = c[0]; if (c[0] > bx) bx = c[0];
        if (c[1] < ay) ay = c[1]; if (c[1] > by) by = c[1];
      }
      ctx.beginPath();
      ctx.moveTo(mondeVersEcranX(ax, ay), mondeVersEcranY(ax, ay));
      ctx.lineTo(mondeVersEcranX(bx + 1, ay), mondeVersEcranY(bx + 1, ay));
      ctx.lineTo(mondeVersEcranX(bx + 1, by + 1), mondeVersEcranY(bx + 1, by + 1));
      ctx.lineTo(mondeVersEcranX(ax, by + 1), mondeVersEcranY(ax, by + 1));
      ctx.closePath();
      ctx.fill();
    }
  }
}
