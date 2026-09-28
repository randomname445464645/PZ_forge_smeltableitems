// Position du joueur en direct, et suivi automatique.
//
// Source : GET /api/position, que serveur.py lit dans
// ~/Zomboid/pz-export/position.json. Ce fichier est ecrit chaque seconde par
// l'agent Java charge dans le jeu (outils/agent-monde, thread
// pz-export-position), avec l'heure a laquelle la position a ete lue.
//
// FLUIDITE
// Une position par seconde, c'est un saut par seconde si on l'affiche telle
// quelle, et en suivi toute la carte saccade. On interpole donc entre la
// position precedente et la nouvelle sur la duree d'une periode : la pastille
// et la camera glissent, avec au plus une seconde de retard sur le jeu.
//
// ORIENTATION
// La fleche suit le DEPLACEMENT reel entre deux positions, pas l'angle que le
// jeu fournit (champ 'a'). La convention de cet angle n'a pas pu etre
// verifiee en partie ; un deplacement, lui, ne peut pas mentir. A l'arret, la
// fleche garde la derniere direction connue.

import { vue, mondeVersEcranX, mondeVersEcranY, centrerSur } from './vue.js';

const PERIODE_FRAIS = 1000;    // ms entre deux lectures quand le jeu tourne
const PERIODE_ABSENT = 5000;   // ms quand il n'y a rien : jeu ferme, menu
const PERIME = 6;              // s : au-dela, la position n'est plus "en direct"
const SEUIL_CAP = 0.3;         // cases : en dessous, on ne recalcule pas le cap

export const etat = {
  actif: true,        // interrogation en cours
  suivre: false,      // la camera suit le joueur
  pos: null,          // derniere position recue {x, y, z, v, m, t}
  age: null,          // secondes depuis la lecture dans le jeu
  erreur: '',
  cap: null,          // [dx, dy] monde, dernier deplacement significatif
};

let conteneur = null, el = null, fleche = null, etiquette = null;
let rappel = () => {}, rendre = () => {};
let minuteur = 0;
// Interpolation : de 'depart' vers 'cible', commencee a 'debut' (performance.now).
let depart = null, cible = null, debut = 0, duree = PERIODE_FRAIS;
let anime = false;

export function initJoueur(element, auChangement, demanderRendu) {
  conteneur = element;
  rappel = auChangement || (() => {});
  rendre = demanderRendu || (() => {});
  el = document.createElement('div');
  el.className = 'joueur';
  el.hidden = true;
  el.innerHTML = '<i class="halo"></i><i class="fleche"></i><b class="point"></b><span></span>';
  fleche = el.querySelector('.fleche');
  etiquette = el.querySelector('span');
  conteneur.appendChild(el);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && etat.actif) planifier(0);
  });
  planifier(0);
}

export function activer(v) {
  etat.actif = v;
  if (!v) { etat.suivre = false; clearTimeout(minuteur); }
  else planifier(0);
  rappel();
  rendre();
}

export function basculerSuivi(v) {
  etat.suivre = (v === undefined) ? !etat.suivre : v;
  if (etat.suivre) {
    if (!etat.actif) activer(true);
    const p = positionCourante();
    if (p) centrerSur(p.x, p.y);
  }
  rappel();
  rendre();
}

export function enDirect() {
  return !!etat.pos && etat.age !== null && etat.age <= PERIME;
}

function planifier(ms) {
  clearTimeout(minuteur);
  minuteur = setTimeout(interroger, ms);
}

async function interroger() {
  if (!etat.actif) return;
  if (document.hidden) return;          // repris par visibilitychange
  try {
    const r = await fetch('/api/position', {
      headers: { 'X-Carte': 'position' }, cache: 'no-store',
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      etat.erreur = d.erreur || ('erreur ' + r.status);
      etat.age = null;
    } else {
      etat.erreur = '';
      etat.age = d.age;
      nouvellePosition(d);
    }
  } catch (e) {
    etat.erreur = 'serveur de la carte injoignable';
  }
  rappel();
  rendre();
  planifier(enDirect() ? PERIODE_FRAIS : PERIODE_ABSENT);
}

function nouvellePosition(d) {
  const p = { x: d.x, y: d.y, z: d.z || 0, v: d.v, m: d.m, t: d.t };
  const avant = etat.pos;
  if (avant && avant.t === p.t) return;          // rien de neuf depuis la derniere lecture
  if (avant) {
    const dx = p.x - avant.x, dy = p.y - avant.y;
    if (Math.hypot(dx, dy) >= SEUIL_CAP) etat.cap = [dx, dy];
  }
  // Un saut de plus de 60 cases (teleportation, reapparition, premiere
  // position) ne s'anime pas : on y va directement.
  const saut = !avant || Math.hypot(p.x - avant.x, p.y - avant.y) > 60;
  depart = saut ? p : positionCourante() || avant;
  cible = p;
  debut = performance.now();
  duree = PERIODE_FRAIS;
  etat.pos = p;
  if (!anime) { anime = true; requestAnimationFrame(animer); }
}

/** Position affichee maintenant, interpolee entre deux lectures. */
function positionCourante() {
  if (!cible) return null;
  if (!depart) return cible;
  const k = Math.min(1, (performance.now() - debut) / duree);
  return { x: depart.x + (cible.x - depart.x) * k, y: depart.y + (cible.y - depart.y) * k };
}

function animer() {
  const p = positionCourante();
  if (p && etat.suivre) centrerSur(p.x, p.y);
  rendre();
  if (performance.now() - debut < duree) requestAnimationFrame(animer);
  else anime = false;
}

export function dessinerJoueur() {
  if (!el) return;
  const p = positionCourante();
  if (!etat.actif || !p) { el.hidden = true; return; }
  el.hidden = false;
  const sx = mondeVersEcranX(p.x, p.y), sy = mondeVersEcranY(p.x, p.y);
  el.style.left = Math.round(sx) + 'px';
  el.style.top = Math.round(sy) + 'px';

  // Cap : direction a l'ecran du dernier deplacement, valable en vue de dessus
  // comme en iso puisqu'on passe par la meme projection que la carte.
  if (etat.cap) {
    const bx = mondeVersEcranX(p.x + etat.cap[0], p.y + etat.cap[1]) - sx;
    const by = mondeVersEcranY(p.x + etat.cap[0], p.y + etat.cap[1]) - sy;
    fleche.style.transform = `rotate(${Math.atan2(by, bx)}rad)`;
    fleche.hidden = false;
  } else {
    fleche.hidden = true;
  }
  const live = enDirect();
  el.classList.toggle('perime', !live);
  el.classList.toggle('vehicule', !!(etat.pos && etat.pos.v));
  el.classList.toggle('mort', !!(etat.pos && etat.pos.m));
  const z = etat.pos ? Math.floor(etat.pos.z + 1e-3) : 0;
  const bouts = ['toi'];
  if (z) bouts.push(z > 0 ? 'etage ' + z : 'sous-sol ' + (-z));
  if (!live && etat.age !== null) bouts.push(dureeCourte(etat.age));
  etiquette.textContent = bouts.join(' · ');
}

/** Texte d'etat pour le panneau. */
export function texteEtat() {
  if (!etat.actif) return 'desactive';
  if (etat.erreur) return etat.erreur;
  if (!etat.pos) return 'en attente de la premiere position...';
  const p = etat.pos;
  const ou = `x ${Math.round(p.x)} y ${Math.round(p.y)} z ${Math.floor(p.z + 1e-3)}`;
  if (enDirect()) return `en direct · ${ou}${p.v ? ' · en vehicule' : ''}`;
  return `derniere position il y a ${dureeCourte(etat.age)} · ${ou} (jeu ferme ou en pause ?)`;
}

function dureeCourte(s) {
  if (s === null || s === undefined) return '?';
  if (s < 90) return Math.round(s) + ' s';
  if (s < 5400) return Math.round(s / 60) + ' min';
  if (s < 172800) return Math.round(s / 3600) + ' h';
  return Math.round(s / 86400) + ' j';
}
