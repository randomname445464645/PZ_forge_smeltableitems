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
         empriseMondeVisible, planVersEcranX, planVersEcranY,
         ecranVersPlanX, ecranVersPlanY } from './vue.js';
import { mode, coteCasePlan, planVersMondeX, planVersMondeY } from './geometrie.js';

const SOURCE = 'constructions.json';
const SOURCE_SPRITES = 'constructions-sprites.json';
const RACINE_TEXTURES = 'texture';

const GRID_W = 64, GRID_H = 32, LAYER_H = 192;

const SEAU = 32;                 // cote du seau de l'index spatial, en cases
const CASE_MIN_DETAIL = 2;       // en dessous, on dessine l'emprise des seaux

// Seuil de bascule vers les sprites. Le tampon hors ecran rend le deplacement
// quasi gratuit quel que soit le zoom, le seuil n'est donc plus dicte par le
// cout d'une image mais par la lisibilite : en dessous de 4 px par case un
// sprite de mur fait deux pixels de large et n'apprend plus rien.
const CASE_MIN_SPRITES = 4;

// Garde-fou : avec tout=1 le releve peut compter des centaines de milliers de
// cases. Au-dela de cette limite on arrete de dessiner plutot que de bloquer
// l'affichage ; l'indicateur depassement permet de le signaler.
// Garde-fou contre un releve pathologique. Avec le remplissage progressif il
// ne sert plus a lisser la charge, seulement a borner le total.
const MAX_SPRITES = 2000000;

// Budget de dessin par image, en millisecondes. Remplir le tampon d'un coup
// coute 37 ms a 16 px par case, 359 ms a 8 et 618 ms a 4 : autant de gel. On
// etale donc le remplissage sur plusieurs images, le calque apparait
// progressivement et l'interface ne bloque jamais.
const BUDGET_MS = 8;
export let depassement = false;

// Marge du tampon hors ecran, en px CSS. Le tampon couvre le viewport plus
// cette marge de chaque cote : tant que le deplacement reste dedans, il n'y a
// rien a redessiner, juste une image a recopier.
const MARGE_TAMPON = 900;

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

// Tampon hors ecran. Redessiner les sprites a chaque image coute 37 ms a
// 8 px/case et 71 ms a 4, tres au-dela du budget de 16,7 ms. On les dessine
// donc une fois dans un tampon plus grand que le viewport, et le deplacement
// se reduit a une recopie d'image, soit moins d'une milliseconde.
// Deux toiles alternees : pour repartir de l'ancien contenu au lieu de
// l'effacer, il faut pouvoir lire l'une en ecrivant dans l'autre.
let tampon = null, tamponCtx = null;
let tamponB = null, tamponBCtx = null;
let tamponEtat = null;          // {zoom, mode, px0, py0, pw, ph, version, complet}
let remplissage = null;         // avancement du remplissage progressif
let version = 0;                // incremente a chaque rechargement du releve
let spritesArrives = false;     // des sprites ont fini de charger
let reprises = 0, remplissages = 0;   // compteurs de diagnostic
const raisons = {};
let passes = 0;

// Cache d'images. La valeur vaut null tant que le chargement est en cours,
// false si l'image est definitivement absente : sans ce troisieme etat on
// redemanderait en boucle un sprite manquant a chaque image.
const images = new Map();
let aRedessiner = null;

/**
 * Emprises par seau, pour le dezoom. Seules les cases CONSTRUITES comptent :
 * avec tout=1 le releve couvre toute la zone exploree, en faire un aplat dore
 * n'apprendrait rien.
 */
function construireSeaux() {
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
}

export function initConstructions(element) {
  canvas = element;
  ctx = canvas.getContext('2d');
}

export function surChargement(rappel) { aRedessiner = rappel; }

/**
 * Acces aux donnees du calque, pour l'export HD.
 * Expose la lecture seule : l'export dessine avec la meme regle, a une autre
 * echelle et dans une autre toile.
 */
export function donneesCalque() {
  if (!cases) return null;
  return { cases, noms, metas, image };
}

/**
 * Precharge les sprites demandes et attend qu'ils soient tous resolus.
 *
 * A l'ecran un sprite manquant apparait a l'image suivante, sans consequence.
 * Dans un export, il manquerait definitivement : il faut donc attendre.
 */
export function chargerSprites(listeNoms, delaiMs = 20000) {
  const attendus = [];
  for (const nom of listeNoms) {
    if (images.get(nom) === false) continue;      // absente, inutile d'attendre
    if (images.get(nom)) continue;                // deja chargee
    image(nom);                                   // declenche le chargement
    attendus.push(nom);
  }
  if (!attendus.length) return Promise.resolve(0);
  const fin = Date.now() + delaiMs;
  return new Promise(resolve => {
    const verifier = () => {
      const restants = attendus.filter(n => images.get(n) === null);
      if (!restants.length || Date.now() > fin) return resolve(attendus.length - restants.length);
      setTimeout(verifier, 60);
    };
    verifier();
  });
}

/** Diagnostic : le tampon est-il entierement dessine ? */
export function tamponComplet() { return !!tamponEtat && tamponEtat.complet; }

/** Diagnostic : etat interne du tampon. */
export function etatTampon() {
  return {
    etat: tamponEtat ? { ...tamponEtat } : null,
    toile: tampon ? [tampon.width, tampon.height] : null,
    reprises,
    remplissages,
    passes,
    raisons,
    enCours: !!remplissage,
  };
}
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

      construireSeaux();
      chargement = null;
    });
    return chargement;
  }
  return Promise.resolve();
}

/**
 * Recharge le releve depuis le disque, apres une synchronisation.
 *
 * Le jeton ?t= force le contournement du cache : les deux fichiers viennent
 * d'etre reecrits a la meme URL. Le cache d'images n'est PAS vide, un sprite
 * garde le meme contenu d'un relevé a l'autre ; seuls les sprites devenus
 * connus sont ajoutes.
 */
export async function rechargerConstructions() {
  const t = Date.now();
  const [d, m] = await Promise.all([
    fetch(`${SOURCE}?t=${t}`).then(r => (r.ok ? r.json() : null)).catch(() => null),
    fetch(`${SOURCE_SPRITES}?t=${t}`).then(r => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (!d) return false;
  cases = d.cases || [];
  noms = d.sprites || [];
  metas = m || {};
  construireSeaux();
  version++;                    // invalide le tampon
  // Un sprite marque absent faute de metadonnees peut desormais exister.
  for (const [nom, v] of [...images]) if (v === false) images.delete(nom);
  return true;
}

/** Image d'un sprite, chargee a la demande. null = en cours, false = absente. */
function image(nom) {
  if (images.has(nom)) return images.get(nom);
  const meta = metas[nom];
  if (!meta) { images.set(nom, false); return false; }
  images.set(nom, null);
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    images.set(nom, img);
    // NE PAS invalider le tampon ici. Les sprites arrivent par centaines au
    // fil du deplacement ; tout jeter a chaque arrivee faisait repartir le
    // calque de zero en permanence, ce qui se voyait comme un rechargement
    // complet des que la vue bougeait. On signale seulement qu'une passe
    // supplementaire sera utile, et elle dessinera PAR DESSUS l'existant.
    spritesArrives = true;
    if (aRedessiner) aRedessiner();
  };
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

  const cote = coteCase();
  if (mode === 'iso' && cote >= CASE_MIN_SPRITES) {
    dessinerViaTampon();
  } else {
    const { x0, y0, x1, y1 } = empriseMondeVisible(4);
    dessinerEmprise(x0, y0, x1, y1, cote);
  }
}

/**
 * Affiche les sprites via le tampon hors ecran.
 *
 * Le tampon couvre le viewport plus MARGE_TAMPON de chaque cote, en
 * coordonnees de PLAN. Tant que le viewport reste dedans et que ni le zoom ni
 * le releve ne changent, il n'y a qu'une recopie d'image a faire.
 */
function dessinerViaTampon() {
  const dpr = window.devicePixelRatio || 1;
  const e = echelle();

  // Rectangle REELLEMENT visible, en unites de plan. C'est lui qui decide si
  // le tampon suffit encore.
  const vx0 = ecranVersPlanX(0);
  const vy0 = ecranVersPlanY(0);
  const vx1 = ecranVersPlanX(vue.largeur);
  const vy1 = ecranVersPlanY(vue.hauteur);

  // Rectangle a fabriquer si le tampon doit etre refait : le visible plus une
  // marge, qui est le jeu autorise avant le prochain remplissage.
  //
  // Tester le rectangle ELARGI contre le tampon rendrait la marge inutile :
  // le moindre deplacement le deborderait et tout serait redessine a chaque
  // image. C'est exactement ce qui se passait.
  const marge = MARGE_TAMPON / e;
  const px0 = vx0 - marge, py0 = vy0 - marge;
  const px1 = vx1 + marge, py1 = vy1 + marge;

  let raison = '';
  if (!tamponEtat) raison = 'absent';
  else if (tamponEtat.zoom !== vue.zoom) raison = 'zoom';
  else if (tamponEtat.mode !== mode) raison = 'mode';
  else if (tamponEtat.version !== version) raison = 'version';
  else if (tamponEtat.dpr !== dpr) raison = 'dpr';
  else if (vx0 < tamponEtat.px0) raison = 'gauche';
  else if (vy0 < tamponEtat.py0) raison = 'haut';
  else if (vx1 > tamponEtat.px0 + tamponEtat.pw) raison = 'droite';
  else if (vy1 > tamponEtat.py0 + tamponEtat.ph) raison = 'bas';
  const perime = raison !== '';
  if (perime) raisons[raison] = (raisons[raison] || 0) + 1;

  if (perime) demarrerRemplissage(px0, py0, px1 - px0, py1 - py0, e, dpr);
  else if (tamponEtat && !tamponEtat.complet) continuerRemplissage();
  if (!tamponEtat) return;

  // Position du coin du tampon a l'ecran. Arrondi au pixel : un tampon pose a
  // cheval sur deux pixels serait reechantillonne, donc flou.
  const gx = Math.round(planVersEcranX(tamponEtat.px0));
  const gy = Math.round(planVersEcranY(tamponEtat.py0));
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tampon, 0, 0, tampon.width, tampon.height,
                gx, gy, tamponEtat.pw * e, tamponEtat.ph * e);
  ctx.imageSmoothingEnabled = true;
}

/** Prepare un tampon vide et amorce son remplissage progressif. */
function demarrerRemplissage(px0, py0, pw, ph, e, dpr) {
  const lp = Math.ceil(pw * e * dpr), hp = Math.ceil(ph * e * dpr);
  // Une texture trop grande est refusee par le navigateur : on renonce au
  // tampon plutot que d'afficher du vide.
  if (lp <= 0 || hp <= 0 || lp > 16384 || hp > 16384) {
    tamponEtat = null; remplissage = null; return;
  }
  // On bascule sur l'autre toile pour pouvoir recopier l'ancienne dedans.
  if (!tamponB) {
    tamponB = document.createElement('canvas');
    tamponBCtx = tamponB.getContext('2d');
  }
  const ancien = tampon, ancienEtat = tamponEtat;
  tampon = tamponB; tamponCtx = tamponBCtx;
  tamponB = ancien; tamponBCtx = ancien ? ancien.getContext('2d') : null;

  if (tampon.width !== lp || tampon.height !== hp) {
    tampon.width = lp; tampon.height = hp;
  }
  tamponCtx.setTransform(1, 0, 0, 1, 0, 0);
  tamponCtx.clearRect(0, 0, lp, hp);

  // REPRISE DE L'ANCIEN CONTENU. Sans elle, sortir de la marge effacait tout
  // et le calque se redessinait case par case sous les yeux. On recopie donc
  // l'ancien tampon a sa place, eventuellement remis a l'echelle apres un
  // zoom : l'image reste en place, floue une fraction de seconde, puis le
  // remplissage progressif la redessine nettement par dessus.
  remplissages++;
  if (ancien && ancienEtat && ancienEtat.mode === mode && ancienEtat.version === version) {
    reprises++;
    const ea = Math.pow(2, ancienEtat.zoom);
    const r = e / ea;                       // rapport d'echelle entre les deux
    tamponCtx.imageSmoothingEnabled = r < 1;
    tamponCtx.drawImage(ancien,
      (ancienEtat.px0 - px0) * e * dpr,
      (ancienEtat.py0 - py0) * e * dpr,
      ancienEtat.pw * e * dpr,
      ancienEtat.ph * e * dpr);
  }

  tamponCtx.setTransform(1, 0, 0, 1, 0, 0);
  tamponCtx.scale(dpr, dpr);
  tamponCtx.imageSmoothingEnabled = e < 1;

  // Bornes monde du rectangle, pour filtrer les cases. En iso le rectangle de
  // plan devient un losange en coordonnees monde : on prend la boite de ses
  // quatre coins, ce qui est conservateur.
  const xs = [], ys = [];
  for (const [a, b] of [[px0, py0], [px0 + pw, py0], [px0, py0 + ph], [px0 + pw, py0 + ph]]) {
    xs.push(planVersMondeX(a, b)); ys.push(planVersMondeY(a, b));
  }
  remplissage = {
    px0, py0, e,
    x0: Math.min(...xs) - 4, x1: Math.max(...xs) + 4,
    y0: Math.min(...ys) - 4, y1: Math.max(...ys) + 4,
    i: 0, dessines: 0,
  };
  tamponEtat = { zoom: vue.zoom, mode, px0, py0, pw, ph, version, dpr, complet: false };
  continuerRemplissage();
}

/**
 * Dessine jusqu'a epuisement du budget de temps, puis rend la main.
 *
 * Le tampon partiel est affiche tel quel : le calque apparait par morceaux au
 * lieu de figer l'interface. Tant qu'il reste du travail on redemande une
 * image, ce qui relance ce meme code au rendu suivant.
 */
function continuerRemplissage() {
  if (!remplissage || !tamponEtat) return;
  const r = remplissage;
  const e = r.e;
  const fin = performance.now() + BUDGET_MS;

  while (r.i < cases.length) {
    const c = cases[r.i++];
    const x = c[0], y = c[1];
    if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;

    const bcx = (x - y) * GRID_W;
    const bcy = (x + y + 2) * GRID_H - LAYER_H * c[2];
    const rangs = c[3];
    for (let k = 0; k < rangs.length; k++) {
      const nom = noms[rangs[k]];
      if (nom === undefined) continue;
      const img = image(nom);
      if (!img) continue;               // null = en cours, false = absente
      const meta = metas[nom];
      tamponCtx.drawImage(img,
        (bcx + meta[3] - r.px0) * e,
        (bcy + meta[4] - r.py0) * e,
        meta[1] * e, meta[2] * e);
      r.dessines++;
    }
    if (r.dessines >= MAX_SPRITES) break;
    // Le test de temps est fait par case et non par sprite : une case coute
    // quelques microsecondes, le depassement reste negligeable.
    if (performance.now() >= fin) break;
  }

  if (r.i >= cases.length || r.dessines >= MAX_SPRITES) {
    depassement = r.dessines >= MAX_SPRITES;
    if (spritesArrives && r.dessines < MAX_SPRITES) {
      // Des sprites sont arrives pendant la passe : on en refait une, par
      // dessus et sans effacer. Redessiner un sprite deja pose donne le meme
      // pixel, l'operation est donc invisible.
      spritesArrives = false;
      r.i = 0; r.dessines = 0;
      passes++;
      if (aRedessiner) aRedessiner();
      return;
    }
    tamponEtat.complet = true;
    remplissage = null;
  } else if (aRedessiner) {
    aRedessiner();                      // il reste du travail : une image de plus
  }
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
