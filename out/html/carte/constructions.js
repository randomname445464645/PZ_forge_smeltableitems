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
import { mode, coteCasePlan } from './geometrie.js';

const SOURCE = 'constructions.json';
const SOURCE_SPRITES = 'constructions-sprites.json';
const RACINE_TEXTURES = 'texture';

const GRID_W = 64, GRID_H = 32, LAYER_H = 192;

const SEAU = 32;                 // cote du seau de l'index spatial, en cases
const CASE_MIN_DETAIL = 2;       // en dessous, on dessine l'emprise des seaux

// Seuil de bascule vers les sprites. Fixe par la MESURE, pas par la lisibilite :
// sur un releve de 120 000 cases, une image coute 13 ms a 16 px/case, 37 ms a
// 8 px/case et 71 ms a 4 px/case. Le budget d'une image a 60 Hz est de 16,7 ms.
// En dessous de 16 px/case on repasse donc a l'emprise, qui coute 2 ms.
const CASE_MIN_SPRITES = 16;

// Garde-fou : avec tout=1 le releve peut compter des centaines de milliers de
// cases. Au-dela de cette limite on arrete de dessiner plutot que de bloquer
// l'affichage ; l'indicateur depassement permet de le signaler.
const MAX_SPRITES = 60000;
export let depassement = false;

let canvas = null, ctx = null;
// [x, y, z, [rang, ...], construite?] deja trie dans l'ordre du peintre par
// le convertisseur : etage croissant, puis profondeur isometrique croissante.
// Trier ici couterait un tri de plusieurs centaines de milliers d'entrees a
// chaque image.
let cases = null;
let noms = null;                 // rang -> nom de sprite
let metas = null;                // nom -> [dossier, w, h, ox, oy]
let seaux = null;                // emprises pre-calculees, pour le dezoom
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
      cases = (d && d.cases) || [];
      noms = (d && d.sprites) || [];
      metas = m || {};

      // Emprises par seau, calculees une fois : au dezoom on ne dessine que
      // ces rectangles, et seulement pour les cases CONSTRUITES. Avec tout=1
      // l'ensemble releve couvre toute la zone exploree, en faire un aplat
      // dore n'apprendrait rien.
      const acc = new Map();
      for (const c of cases) {
        if (!c[4]) continue;
        const k = `${Math.floor(c[0] / SEAU)},${Math.floor(c[1] / SEAU)}`;
        let b = acc.get(k);
        if (!b) { b = [c[0], c[1], c[0], c[1]]; acc.set(k, b); }
        else {
          if (c[0] < b[0]) b[0] = c[0]; if (c[1] < b[1]) b[1] = c[1];
          if (c[0] > b[2]) b[2] = c[0]; if (c[1] > b[3]) b[3] = c[1];
        }
      }
      seaux = [...acc.values()];
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

/**
 * Cote apparent d'une case, en px CSS. C'est EXACTEMENT la grandeur affichee
 * par le bandeau : les seuils ci-dessus se lisent donc directement a l'ecran.
 * Une mesure differente ici donnerait des bascules a des zooms inattendus.
 */
function coteCase() {
  return coteCasePlan() * echelle();
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

export function dessinerConstructions() {
  if (!canvas) return;
  preparerCanvas();
  if (!actif || !cases || !cases.length) return;

  const { x0, y0, x1, y1 } = empriseMondeVisible(4);
  const cote = coteCase();

  if (mode === 'iso' && cote >= CASE_MIN_SPRITES) {
    dessinerSprites(x0, y0, x1, y1, echelle());
  } else {
    dessinerEmprise(x0, y0, x1, y1, cote);
  }
}

/**
 * Dessin des vrais sprites.
 *
 * Balayage LINEAIRE du tableau, qui est deja trie dans l'ordre du peintre par
 * le convertisseur : etage croissant, puis profondeur isometrique croissante.
 * Un index spatial obligerait a retrier les cases visibles a chaque image, ce
 * qui coute bien plus cher que de parcourir le tableau en testant une boite.
 *
 * Sans ce tri, un mur du fond recouvrirait un mur du premier plan. Et c'est lui
 * qui permet l'opacite : les sols des cases relevees recouvrent la tuile de
 * base, donc un arbre abattu disparait au lieu de rester affiche.
 */
function dessinerSprites(x0, y0, x1, y1, e) {
  // En agrandissement, plus proche voisin : les sprites sont du pixel art,
  // un lissage les rendrait pateux. Meme regle que pour les tuiles.
  ctx.imageSmoothingEnabled = e < 1;

  let dessines = 0;
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const x = c[0], y = c[1];
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;

    const bcx = (x - y) * GRID_W;
    const bcy = (x + y + 2) * GRID_H - LAYER_H * c[2];
    const rangs = c[3];
    for (let k = 0; k < rangs.length; k++) {
      const nom = noms[rangs[k]];
      if (nom === undefined) continue;
      const img = image(nom);
      if (!img) continue;               // null = en cours, false = absente
      const meta = metas[nom];
      ctx.drawImage(img,
        planVersEcranX(bcx + meta[3]),
        planVersEcranY(bcy + meta[4]),
        meta[1] * e, meta[2] * e);
      if (++dessines >= MAX_SPRITES) break;
    }
    if (dessines >= MAX_SPRITES) break;
  }

  ctx.imageSmoothingEnabled = true;
  depassement = dessines >= MAX_SPRITES;
}

/**
 * Repli : emprise doree, quand les sprites n'ont pas de sens (vue de dessus)
 * ou seraient illisibles (trop dezoome).
 *
 * Seules les cases CONSTRUITES sont surlignees. Avec tout=1 le releve couvre
 * toute la zone exploree : en faire un aplat dore n'apprendrait rien.
 */
function dessinerEmprise(x0, y0, x1, y1, cote) {
  ctx.fillStyle = 'rgba(216, 162, 74, 0.34)';
  ctx.strokeStyle = 'rgba(216, 162, 74, 0.85)';
  ctx.lineWidth = Math.min(2, Math.max(0.6, cote / 12));

  if (cote >= CASE_MIN_DETAIL) {
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      if (!c[4]) continue;
      if (c[0] < x0 || c[0] > x1 || c[1] < y0 || c[1] > y1) continue;
      quadCase(c[0], c[1]);
      ctx.fill();
      if (cote >= 6) ctx.stroke();
    }
    return;
  }

  // Trop dezoome : emprises pre-calculees au chargement, une par seau.
  ctx.fillStyle = 'rgba(216, 162, 74, 0.55)';
  for (const b of seaux) {
    if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue;
    ctx.beginPath();
    ctx.moveTo(mondeVersEcranX(b[0], b[1]), mondeVersEcranY(b[0], b[1]));
    ctx.lineTo(mondeVersEcranX(b[2] + 1, b[1]), mondeVersEcranY(b[2] + 1, b[1]));
    ctx.lineTo(mondeVersEcranX(b[2] + 1, b[3] + 1), mondeVersEcranY(b[2] + 1, b[3] + 1));
    ctx.lineTo(mondeVersEcranX(b[0], b[3] + 1), mondeVersEcranY(b[0], b[3] + 1));
    ctx.closePath();
    ctx.fill();
  }
}
