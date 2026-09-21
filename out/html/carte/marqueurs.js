// Chargement, filtrage, affichage et liste des marqueurs.
//
// markers.json contient 1860 entrees {x, y, z, cat, t, d}, en coordonnees
// MONDE (celles que le jeu affiche). Verifie contre rooms/marks.json de
// pzmap2dzi : les rectangles de pieces tombent exactement sur les batiments,
// et les marqueurs tombent dans les bonnes pieces.
//
// Placement : la pastille est centree EXACTEMENT sur la case. L'ancien viewer
// utilisait translate(-50%, -100%) sur un bloc dont la hauteur variait avec
// l'etiquette, ce qui remontait l'icone d'une demi-pastille plus la hauteur du
// texte, et la faisait sauter quand les etiquettes apparaissaient.

import { vue, echelle, mondeVersEcranX, mondeVersEcranY, centreMonde } from './vue.js';

const VERSION_ICONES = 4;   // le cache des icones est tenace, on le contourne

// Ordre d'affichage dans le panneau et libelles francais.
export const CATEGORIES = [
  { cle: 'top',     nom: 'loot exceptionnel',  couleur: '#ff4d3d' },
  { cle: 'or',      nom: 'or',                 couleur: '#d8a24a' },
  { cle: 'billets', nom: 'billets',            couleur: '#5fbf72' },
  { cle: 'valeur',  nom: 'banques, bijoux',    couleur: '#c98bdc' },
  { cle: 'armes',   nom: 'armes, militaire',   couleur: '#d05a4a' },
  { cle: 'medical', nom: 'medical',            couleur: '#e86f9e' },
  { cle: 'outils',  nom: 'outils, quincaille', couleur: '#e0a33c' },
  { cle: 'bouffe',  nom: 'nourriture',         couleur: '#8fd14f' },
  { cle: 'essence', nom: 'essence',            couleur: '#4fc3d9' },
  { cle: 'labo',    nom: 'laboratoires',       couleur: '#9fe0c0' },
];

// Categories cochees a la premiere ouverture : les rares, sinon l'ecran est
// noir de pastilles.
const FILTRES_DEFAUT = ['top', 'or', 'billets', 'valeur', 'armes'];

const PLAFOND_AFFICHES = 900;   // au-dela ca rame et c'est illisible
// Les etiquettes se chevauchent vite dans les zones denses : on ne les affiche
// en masse qu'a partir de 4 px par case. Les categories rares (38 marqueurs en
// tout) restent nommees bien plus tot, c'est le cas ou on veut lire le nom.
const ZOOM_ETIQUETTES = 2;
const ZOOM_ETIQUETTES_RARES = -1;
const CATEGORIES_RARES = new Set(['top', 'or', 'billets']);

export const etat = {
  tous: [],           // tous les marqueurs, dans l'ordre du fichier
  filtres: {},        // cle de categorie -> booleen
  selection: -1,      // index du marqueur selectionne, -1 si aucun
  compteurs: {},      // cle -> nombre total
  visibles: 0,        // nombre effectivement dessine au dernier rendu
};

let conteneur = null;
const elements = new Map();     // index de marqueur -> element DOM
let auClic = () => {};

export function initMarqueurs(element, rappelClic) {
  conteneur = element;
  auClic = rappelClic || (() => {});
}

export async function chargerMarqueurs(url = 'markers.json') {
  const reponse = await fetch(url);
  if (!reponse.ok) throw new Error('markers.json introuvable (' + reponse.status + ')');
  etat.tous = await reponse.json();

  for (const c of CATEGORIES) etat.compteurs[c.cle] = 0;
  for (const m of etat.tous) {
    etat.compteurs[m.cat] = (etat.compteurs[m.cat] || 0) + 1;
  }

  const sauvegarde = lireFiltres();
  for (const c of CATEGORIES) {
    etat.filtres[c.cle] = sauvegarde
      ? !!sauvegarde[c.cle]
      : FILTRES_DEFAUT.includes(c.cle);
  }
  return etat.tous;
}

function lireFiltres() {
  try {
    const brut = localStorage.getItem('pzcarte.filtres');
    return brut ? JSON.parse(brut) : null;
  } catch (e) { return null; }
}

export function enregistrerFiltres() {
  try {
    localStorage.setItem('pzcarte.filtres', JSON.stringify(etat.filtres));
  } catch (e) { /* mode navigation privee, on ignore */ }
}

export function nombreActifs() {
  let n = 0;
  for (const c of CATEGORIES) if (etat.filtres[c.cle]) n += etat.compteurs[c.cle] || 0;
  return n;
}

/** Bornes monde des marqueurs actuellement filtres, ou null. */
export function empriseActifs() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const m of etat.tous) {
    if (!etat.filtres[m.cat]) continue;
    if (m.x < x0) x0 = m.x;
    if (m.x > x1) x1 = m.x;
    if (m.y < y0) y0 = m.y;
    if (m.y > y1) y1 = m.y;
  }
  return x1 < x0 ? null : { x0, y0, x1, y1 };
}

function creerElement(index, m) {
  const el = document.createElement('div');
  el.className = 'mq mq-' + m.cat;
  el.dataset.index = index;
  el.title = `${m.t}\n${m.d || ''}\nx=${m.x}  y=${m.y}  z=${m.z}`;
  const pastille = document.createElement('i');
  pastille.style.backgroundImage = `url(icons/${m.cat}.png?v=${VERSION_ICONES})`;
  el.appendChild(pastille);
  const nom = document.createElement('span');
  nom.textContent = m.t;
  el.appendChild(nom);
  el.addEventListener('mousedown', e => e.stopPropagation());
  el.addEventListener('click', e => {
    e.stopPropagation();
    auClic(index);
  });
  return el;
}

/** Culling : on ne cree que les marqueurs reellement dans la fenetre. */
export function dessinerMarqueurs() {
  const e = echelle();
  const marge = 40 / e;                       // en cases monde
  const x0 = (0 - vue.panX) / e - marge;
  const y0 = (0 - vue.panY) / e - marge;
  const x1 = (vue.largeur - vue.panX) / e + marge;
  const y1 = (vue.hauteur - vue.panY) / e + marge;

  let candidats = [];
  for (let i = 0; i < etat.tous.length; i++) {
    const m = etat.tous[i];
    if (!etat.filtres[m.cat]) continue;
    if (m.x < x0 || m.x > x1 || m.y < y0 || m.y > y1) continue;
    candidats.push(i);
  }

  // Trop de monde a l'ecran : on garde les plus proches du centre.
  if (candidats.length > PLAFOND_AFFICHES) {
    const c = centreMonde();
    candidats.sort((a, b) => {
      const ma = etat.tous[a], mb = etat.tous[b];
      return (ma.x - c.x) ** 2 + (ma.y - c.y) ** 2
           - (mb.x - c.x) ** 2 - (mb.y - c.y) ** 2;
    });
    candidats = candidats.slice(0, PLAFOND_AFFICHES);
  }

  const gardes = new Set(candidats);
  for (const [index, el] of elements) {
    if (!gardes.has(index)) { el.remove(); elements.delete(index); }
  }

  const etiquettes = vue.zoom >= ZOOM_ETIQUETTES;
  const etiquettesRares = vue.zoom >= ZOOM_ETIQUETTES_RARES;
  for (const index of candidats) {
    const m = etat.tous[index];
    const nomme = index === etat.selection || etiquettes
      || (etiquettesRares && CATEGORIES_RARES.has(m.cat));
    let el = elements.get(index);
    if (!el) {
      el = creerElement(index, m);
      elements.set(index, el);
      conteneur.appendChild(el);
    }
    // Arrondi au pixel : une pastille a cheval sur deux pixels est floue.
    el.style.left = Math.round(mondeVersEcranX(m.x)) + 'px';
    el.style.top = Math.round(mondeVersEcranY(m.y)) + 'px';
    el.classList.toggle('avec-nom', nomme);
    el.classList.toggle('selection', index === etat.selection);
  }

  etat.visibles = candidats.length;
  return candidats.length;
}

/** Vide le cache DOM (apres un changement de filtres, pour forcer la relecture). */
export function reinitialiserAffichage() {
  for (const [, el] of elements) el.remove();
  elements.clear();
}

/**
 * Liste laterale : les marqueurs actifs les plus proches du centre de la vue,
 * tries par distance et plafonnes pour rester lisibles.
 */
export function listerProches(limite = 200) {
  const c = centreMonde();
  const resultat = [];
  for (let i = 0; i < etat.tous.length; i++) {
    const m = etat.tous[i];
    if (!etat.filtres[m.cat]) continue;
    resultat.push({ index: i, m, d2: (m.x - c.x) ** 2 + (m.y - c.y) ** 2 });
  }
  resultat.sort((a, b) => a.d2 - b.d2);
  return resultat.slice(0, limite);
}
