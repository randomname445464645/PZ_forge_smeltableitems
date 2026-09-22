// Calque des constructions relevees en jeu par l'agent d'export.
//
// Source : constructions.json, produit par outils/agent-monde/convertir.py a
// partir du NDJSON que l'agent ecrit pendant que tu joues. Le serveur ne
// transmet jamais ces donnees au client sous forme de fichiers : elles sont
// lues dans la memoire du jeu, donc limitees a ce que tu as explore.
//
// Le dessin passe par mondeVersEcran, qui projette correctement dans LES DEUX
// modes : une case devient un carre en vue de dessus et un losange en
// isometrique, sans code specifique.

import { vue, echelle, mondeVersEcranX, mondeVersEcranY,
         empriseMondeVisible } from './vue.js';

const SOURCE = 'constructions.json';

// Taille du seau de l'index spatial, en cases. Sans index, un dezoom sur une
// grande base parcourrait toutes les cases a chaque image.
const SEAU = 32;

// En dessous de cette taille de case apparente, dessiner chaque case une par
// une ne rend rien de lisible et coute cher : on dessine les seaux pleins.
const CASE_MIN_DETAIL = 3;

let canvas = null, ctx = null;
let cases = null;                 // null = pas encore charge
let index = null;                 // "sx,sy" -> [x, y, z, ...]
let chargement = null;
export let actif = false;

export function initConstructions(element) {
  canvas = element;
  ctx = canvas.getContext('2d');
}

export function disponible() {
  return cases !== null && cases.length > 0;
}

export function nombreCases() {
  return cases ? cases.length / 3 : 0;
}

export function basculerConstructions(valeur) {
  actif = valeur;
  if (actif && !cases && !chargement) {
    chargement = fetch(SOURCE)
      .then(r => (r.ok ? r.json() : null))
      .then(donnees => {
        cases = [];
        index = new Map();
        if (donnees) {
          for (const cle of Object.keys(donnees)) {
            const z = parseInt(cle.slice(1), 10);
            const plat = donnees[cle];
            for (let i = 0; i + 1 < plat.length; i += 2) {
              const x = plat[i], y = plat[i + 1];
              cases.push(x, y, z);
              const k = `${Math.floor(x / SEAU)},${Math.floor(y / SEAU)}`;
              let seau = index.get(k);
              if (!seau) { seau = []; index.set(k, seau); }
              seau.push(x, y, z);
            }
          }
        }
        chargement = null;
      })
      .catch(() => { cases = []; index = new Map(); chargement = null; });
    return chargement;
  }
  return Promise.resolve();
}

/** Cote apparent d'une case, en px CSS. Vaut dans les deux modes. */
function coteCase() {
  return Math.abs(mondeVersEcranX(1, 0) - mondeVersEcranX(0, 0))
       + Math.abs(mondeVersEcranY(1, 0) - mondeVersEcranY(0, 0));
}

/** Dessine le quadrilatere d'une case, projete selon le mode courant. */
function quadCase(x, y) {
  ctx.beginPath();
  ctx.moveTo(mondeVersEcranX(x, y), mondeVersEcranY(x, y));
  ctx.lineTo(mondeVersEcranX(x + 1, y), mondeVersEcranY(x + 1, y));
  ctx.lineTo(mondeVersEcranX(x + 1, y + 1), mondeVersEcranY(x + 1, y + 1));
  ctx.lineTo(mondeVersEcranX(x, y + 1), mondeVersEcranY(x, y + 1));
  ctx.closePath();
}

export function dessinerConstructions() {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const lp = Math.round(vue.largeur * dpr), hp = Math.round(vue.hauteur * dpr);
  if (canvas.width !== lp || canvas.height !== hp) {
    canvas.width = lp; canvas.height = hp;
    canvas.style.width = vue.largeur + 'px';
    canvas.style.height = vue.hauteur + 'px';
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vue.largeur, vue.hauteur);
  if (!actif || !cases || !cases.length) return;

  const { x0, y0, x1, y1 } = empriseMondeVisible(2);
  const cote = coteCase();

  ctx.fillStyle = 'rgba(216, 162, 74, 0.34)';     // accent de l'interface
  ctx.strokeStyle = 'rgba(216, 162, 74, 0.85)';
  ctx.lineWidth = Math.min(2, Math.max(0.6, cote / 12));

  const sx0 = Math.floor(x0 / SEAU), sx1 = Math.floor(x1 / SEAU);
  const sy0 = Math.floor(y0 / SEAU), sy1 = Math.floor(y1 / SEAU);

  if (cote >= CASE_MIN_DETAIL) {
    // Assez zoome : chaque case est dessinee, contour compris.
    for (let sy = sy0; sy <= sy1; sy++) {
      for (let sx = sx0; sx <= sx1; sx++) {
        const seau = index.get(`${sx},${sy}`);
        if (!seau) continue;
        for (let i = 0; i < seau.length; i += 3) {
          const x = seau[i], y = seau[i + 1];
          if (x < x0 || x > x1 || y < y0 || y > y1) continue;
          quadCase(x, y);
          ctx.fill();
          if (cote >= 6) ctx.stroke();
        }
      }
    }
  } else {
    // Trop dezoome : une case ferait moins de trois pixels. On dessine
    // l'emprise des seaux, ce qui montre ou sont les bases sans fourmiller.
    ctx.fillStyle = 'rgba(216, 162, 74, 0.55)';
    for (let sy = sy0; sy <= sy1; sy++) {
      for (let sx = sx0; sx <= sx1; sx++) {
        const seau = index.get(`${sx},${sy}`);
        if (!seau) continue;
        let ax = Infinity, ay = Infinity, bx = -Infinity, by = -Infinity;
        for (let i = 0; i < seau.length; i += 3) {
          const x = seau[i], y = seau[i + 1];
          if (x < ax) ax = x; if (x > bx) bx = x;
          if (y < ay) ay = y; if (y > by) by = y;
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
}
