// Assemblage : evenements, panneau lateral, persistance.

import { EMPRISE, chargerGeometrie, pyramidesActives } from './geometrie.js';
import {
  vue, echelle, ZOOM_MIN, ZOOM_MAX,
  initTuiles, dessinerTuiles, infoRendu,
  deplacer, zoomer, centrerSur, cadrerSur,
  ecranVersMondeX, ecranVersMondeY, centreMonde,
} from './vue.js';
import {
  CATEGORIES, etat, initMarqueurs, chargerMarqueurs, enregistrerFiltres,
  dessinerMarqueurs, reinitialiserAffichage, listerProches,
  nombreActifs, empriseActifs,
} from './marqueurs.js';
import { initRues, basculerRues, dessinerRues } from './rues.js';

const $ = id => document.getElementById(id);

const carte = $('carte');
const plan = $('plan');

// --- boucle de rendu -------------------------------------------------------

let rendementDemande = false;
let minuteurListe = 0;
let minuteurVue = 0;

/**
 * Le dessin (tuiles, rues, marqueurs, bandeau) suit le rythme de l'ecran.
 * Le tri de la liste laterale et l'ecriture dans localStorage sont differes :
 * les refaire a chaque image pendant un glisser fait saccader le deplacement.
 */
function demanderRendu(majListeAussi = false) {
  if (!rendementDemande) {
    rendementDemande = true;
    requestAnimationFrame(() => {
      rendementDemande = false;
      rendre();
    });
  }
  if (majListeAussi) {
    clearTimeout(minuteurListe);
    minuteurListe = setTimeout(majListe, 140);
  }
  clearTimeout(minuteurVue);
  minuteurVue = setTimeout(enregistrerVue, 400);
}

function rendre() {
  dessinerTuiles();
  dessinerRues();
  dessinerMarqueurs();
  majHud();
}

function mesurer() {
  vue.largeur = carte.clientWidth;
  vue.hauteur = carte.clientHeight;
}

// --- bandeau d'information -------------------------------------------------

let sourisX = null, sourisY = null;

function majHud() {
  const info = infoRendu();
  if (!info) return;
  if (sourisX !== null) {
    $('hudX').textContent = Math.floor(ecranVersMondeX(sourisX));
    $('hudY').textContent = Math.floor(ecranVersMondeY(sourisY));
  }
  const ratio = info.facteurRendu;
  const mode = ratio > 1.001 ? 'agrandi x' + Math.round(ratio)
             : ratio > 0.999 ? '1:1 pixel ecran'
             : 'reduit x' + (1 / ratio).toFixed(2);
  $('hudZoom').textContent =
    `echelle ${info.echelle >= 1 ? info.echelle : '1/' + (1 / info.echelle)} px/case`
    + ` · niveau ${info.niveau}/${info.niveauMax} · ${mode}`
    + (info.sqr > 1 ? ` · source ${info.sqr} px/case` : '')
    + (info.dpr !== 1 ? ` · dpr ${info.dpr}` : '')
    + ` · ${info.tuiles} tuiles`;
  $('hudCompte').textContent = `${etat.visibles} affiches / ${nombreActifs()} actifs`;
}

// --- panneau des filtres ---------------------------------------------------

function construireFiltres() {
  const hote = $('filtres');
  hote.innerHTML = '';
  for (const c of CATEGORIES) {
    const l = document.createElement('label');
    l.innerHTML =
      `<input type="checkbox" data-cat="${c.cle}" ${etat.filtres[c.cle] ? 'checked' : ''}>`
      + `<b class="pastille" style="background:${c.couleur};`
      + `background-image:url(icons/${c.cle}.png?v=4)"></b>`
      + `<span class="nom">${c.nom}</span>`
      + `<i class="nb">${etat.compteurs[c.cle] || 0}</i>`;
    hote.appendChild(l);
  }
  hote.querySelectorAll('[data-cat]').forEach(cb => {
    cb.addEventListener('change', () => {
      etat.filtres[cb.dataset.cat] = cb.checked;
      enregistrerFiltres();
      reinitialiserAffichage();
      demanderRendu(true);
    });
  });
}

function toutCocher(valeur) {
  for (const c of CATEGORIES) etat.filtres[c.cle] = valeur;
  document.querySelectorAll('#filtres [data-cat]').forEach(cb => { cb.checked = valeur; });
  enregistrerFiltres();
  reinitialiserAffichage();
  demanderRendu(true);
}

// --- liste laterale --------------------------------------------------------

function majListe() {
  const hote = $('liste');
  const proches = listerProches(200);
  const c = centreMonde();
  hote.innerHTML = '';
  if (!proches.length) {
    hote.innerHTML = '<p class="vide">Aucune categorie cochee.</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const { index, m, d2 } of proches) {
    const ligne = document.createElement('div');
    ligne.className = 'ligne' + (index === etat.selection ? ' active' : '');
    const distance = Math.round(Math.sqrt(d2));
    ligne.innerHTML =
      `<div class="titre"><b class="pastille" style="background-image:url(icons/${m.cat}.png?v=4)"></b>`
      + `${echapper(m.t)}</div>`
      + `<div class="meta">${m.cat} · x ${m.x} y ${m.y} z ${m.z} · ${distance} cases</div>`
      + (m.d ? `<div class="desc">${echapper(m.d)}</div>` : '');
    ligne.addEventListener('click', () => selectionner(index, true));
    frag.appendChild(ligne);
  }
  hote.appendChild(frag);
  const active = hote.querySelector('.ligne.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function echapper(s) {
  return String(s).replace(/[&<>"]/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function selectionner(index, recentrer) {
  etat.selection = index;
  const m = etat.tous[index];
  if (recentrer && m) centrerSur(m.x, m.y, Math.max(vue.zoom, 1));
  demanderRendu(true);
}

// --- navigation ------------------------------------------------------------

let glisse = null;

carte.addEventListener('dragstart', e => e.preventDefault());
plan.addEventListener('dragstart', e => e.preventDefault());

carte.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  e.preventDefault();               // coupe le glisser-deposer natif des images
  glisse = { x: e.clientX, y: e.clientY, bouge: false };
  carte.classList.add('glisse');
});

window.addEventListener('mousemove', e => {
  const r = carte.getBoundingClientRect();
  sourisX = e.clientX - r.left;
  sourisY = e.clientY - r.top;
  if (glisse) {
    const dx = e.clientX - glisse.x, dy = e.clientY - glisse.y;
    if (dx || dy) {
      glisse.bouge = true;
      glisse.x = e.clientX; glisse.y = e.clientY;
      deplacer(dx, dy);
      demanderRendu(true);
      return;
    }
  }
  majHud();
});

window.addEventListener('mouseup', () => {
  glisse = null;
  carte.classList.remove('glisse');
});

// Un cran de molette = UN palier de zoom exact, jamais plus.
// L'amplitude du deltaY est ignoree : c'est elle qui produisait les echelles
// batardes type 1,25 dans l'ancien viewer. On accumule seulement pour que les
// pavés tactiles, qui envoient des dizaines de petits deltas, ne fassent pas
// traverser toute la pyramide d'un geste.
let accumulation = 0;
let dernierPalier = 0;
const SEUIL_MOLETTE = 24;     // un cran de souris classique vaut 100
const DELAI_PALIER = 80;      // ms mini entre deux paliers

carte.addEventListener('wheel', e => {
  e.preventDefault();
  if (Math.sign(e.deltaY) !== Math.sign(accumulation)) accumulation = 0;
  accumulation += e.deltaY;
  if (Math.abs(accumulation) < SEUIL_MOLETTE) return;

  const maintenant = performance.now();
  if (maintenant - dernierPalier < DELAI_PALIER) return;
  dernierPalier = maintenant;

  const sens = accumulation > 0 ? -1 : 1;   // molette vers le bas = dezoom
  accumulation = 0;
  const r = carte.getBoundingClientRect();
  zoomer(sens, e.clientX - r.left, e.clientY - r.top);
  demanderRendu(true);
}, { passive: false });

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const pas = 120;
  if (e.key === '+' || e.key === '=') { zoomer(1, vue.largeur / 2, vue.hauteur / 2); demanderRendu(true); }
  else if (e.key === '-') { zoomer(-1, vue.largeur / 2, vue.hauteur / 2); demanderRendu(true); }
  else if (e.key === 'ArrowLeft') { deplacer(pas, 0); demanderRendu(true); }
  else if (e.key === 'ArrowRight') { deplacer(-pas, 0); demanderRendu(true); }
  else if (e.key === 'ArrowUp') { deplacer(0, pas); demanderRendu(true); }
  else if (e.key === 'ArrowDown') { deplacer(0, -pas); demanderRendu(true); }
  else return;
  e.preventDefault();
});

window.addEventListener('resize', () => {
  const c = centreMonde();
  mesurer();
  centrerSur(c.x, c.y);
  demanderRendu(true);
});

// --- boutons ---------------------------------------------------------------

$('toutCocher').addEventListener('click', () => toutCocher(true));
$('rienCocher').addEventListener('click', () => toutCocher(false));

$('voirTout').addEventListener('click', () => {
  const b = empriseActifs();
  if (!b) return;
  cadrerSur(b.x0, b.y0, b.x1, b.y1);
  demanderRendu(true);
});

$('allerCoord').addEventListener('click', allerAuxCoordonnees);
$('coordX').addEventListener('keydown', e => { if (e.key === 'Enter') allerAuxCoordonnees(); });
$('coordY').addEventListener('keydown', e => { if (e.key === 'Enter') allerAuxCoordonnees(); });

function allerAuxCoordonnees() {
  const x = parseFloat($('coordX').value), y = parseFloat($('coordY').value);
  if (!isFinite(x) || !isFinite(y)) return;
  etat.selection = -1;
  centrerSur(x, y, Math.max(vue.zoom, 1));
  demanderRendu(true);
}

// Villes moddees : centre et cadrage deduits directement de la geometrie lue
// dans map_info.json, pas de coordonnees saisies a la main.
const selecteurVilles = $('villes');

function remplirVilles() {
  for (const p of pyramidesActives()) {
    if (!p.mod) continue;
    const o = document.createElement('option');
    o.value = p.nom;
    o.textContent = p.libelle;
    selecteurVilles.appendChild(o);
  }
}

selecteurVilles.addEventListener('change', function () {
  const p = pyramidesActives().find(q => q.nom === this.value);
  this.value = '';
  if (!p) return;
  cadrerSur(p.mondeX, p.mondeY, p.mondeX1, p.mondeY1, 30);
  demanderRendu(true);
});

$('slugger').addEventListener('click', () => {
  const i = etat.tous.findIndex(m => m.cat === 'top');
  if (i >= 0) selectionner(i, true);
});

$('calqueRues').addEventListener('change', function () {
  basculerRues(this.checked).then(() => demanderRendu());
  try { localStorage.setItem('pzcarte.rues', this.checked ? '1' : '0'); } catch (e) {}
  demanderRendu();
});

$('replier').addEventListener('click', () => {
  const c = centreMonde();          // on garde le meme point au centre
  document.body.classList.toggle('replie');
  mesurer();
  centrerSur(c.x, c.y);
  demanderRendu(true);
});

// --- persistance de la vue -------------------------------------------------

function enregistrerVue() {
  try {
    const c = centreMonde();
    localStorage.setItem('pzcarte.vue', JSON.stringify({ x: c.x, y: c.y, zoom: vue.zoom }));
  } catch (e) {}
}

function restaurerVue() {
  try {
    const brut = localStorage.getItem('pzcarte.vue');
    if (brut) {
      const v = JSON.parse(brut);
      if (isFinite(v.x) && isFinite(v.y) && isFinite(v.zoom)) {
        centrerSur(v.x, v.y, Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.zoom)));
        return true;
      }
    }
  } catch (e) {}
  return false;
}

// --- demarrage -------------------------------------------------------------

async function demarrer() {
  initTuiles(plan);
  initRues($('rues'));
  initMarqueurs($('marqueurs'), i => selectionner(i, false));
  mesurer();

  // La geometrie est lue dans les fichiers de rendu : le viewer s'adapte tout
  // seul a un rendu 1 px ou 2 px par case.
  const [pyramides] = await Promise.all([chargerGeometrie(), chargerMarqueurs()]);
  console.info('pyramides chargees :', pyramides.map(
    p => `${p.nom} ${p.w}x${p.h} sqr=${p.sqr} tuile=${p.tailleTuile} niveaux 0..${p.niveauMax}`).join(' | '));
  remplirVilles();
  construireFiltres();
  enregistrerFiltres();   // fige l'etat par defaut des la premiere ouverture

  try {
    if (localStorage.getItem('pzcarte.rues') === '1') {
      $('calqueRues').checked = true;
      basculerRues(true).then(() => demanderRendu());
    }
  } catch (e) {}

  if (!restaurerVue()) {
    // Premiere ouverture : on cadre sur l'emprise complete, Raven Creek incluse.
    cadrerSur(EMPRISE.x0, EMPRISE.y0, EMPRISE.x1, EMPRISE.y1, 20);
  }
  demanderRendu(true);
}

demarrer().catch(err => {
  document.body.insertAdjacentHTML('afterbegin',
    `<pre class="erreur">Echec du demarrage : ${echapper(err.message)}</pre>`);
});
