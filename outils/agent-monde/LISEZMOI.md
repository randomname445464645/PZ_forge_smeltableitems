# Agent d'export du monde

Relève les constructions que tu as vues en jeu et les affiche sur la carte web.

## Pourquoi

Le serveur n'envoie jamais de fichiers de monde au client : en multijoueur,
`~/Zomboid/Saves/Multiplayer/<serveur>/` ne contient aucune donnée de terrain,
les dossiers `chunkdata`, `map`, `isoregiondata`, `apop`, `metagrid` et `zpop`
sont vides. Le rendu de pzmap2dzi part donc des fichiers de carte du jeu et des
mods, c'est à dire du monde tel qu'il est livré, sans aucune construction.

Mais le client **reçoit** bien la géométrie, sinon il ne pourrait pas l'afficher.
Elle est en mémoire. Cet agent va la lire là.

## Pourquoi un agent et pas autre chose

**Pas un mod Lua** : l'API `getCell():getGridSquare()` ferait la même chose en
cinquante lignes, mais il faudrait déposer un mod dans le dossier des mods.
L'agent n'y touche pas.

**Pas un débogueur distant.** `-agentlib:jdwp` fonctionne, mais chaque lecture
de champ est un aller-retour réseau et invoquer une méthode exige un thread
suspendu. Balayer la zone chargée demanderait des millions d'allers-retours,
jeu figé. Un agent tourne DANS le processus, sans aucun aller-retour.
JDWP reste excellent pour explorer l'API à la main.

**Pas de lecture brute de la mémoire.** Le jeu tourne en `-XX:+UseZGC`, un
ramasse-miettes concurrent et déplaçant à pointeurs colorés : les objets
changent d'adresse pendant la lecture et les pointeurs portent des métadonnées.
Reconstruire des objets Java depuis `/proc/<pid>/mem` reviendrait à
réimplémenter les internes de la JVM.

Les classes du jeu ne sont pas obfusquées (`zombie.iso.IsoCell`,
`IsoGridSquare`, `IsoObject`), l'agent se compile donc directement contre
`projectzomboid.jar`, sans réflexion.

## Construire

```bash
P=/home/kiri/.local/share/Steam/steamapps/common/ProjectZomboid/projectzomboid
javac -cp "$P/projectzomboid.jar" -d classes src/pzexport/Agent.java
jar --create --file agent-monde.jar --manifest META-INF/MANIFEST.MF -C classes .
```

Demande un JDK complet (`java-25-openjdk-devel`) : le JRE livré avec le jeu est
amputé, il n'a ni `javac`, ni `jmap`, ni `jcmd`.

## Installer

Ajouter aux `vmArgs` de `ProjectZomboid64.json` :

```
-javaagent:<chemin>/agent-monde.jar=periode=5
```

Options, séparées par des virgules :

| Option | Défaut | Rôle |
|---|---|---|
| `periode=<s>` | 5 | intervalle entre deux balayages |
| `sortie=<chemin>` | `~/Zomboid/pz-export/monde.ndjson` | fichier de sortie |
| `tout=1` | non | exporte tous les objets, pas seulement les cases construites |

Steam réécrit parfois `ProjectZomboid64.json` lors d'une mise à jour du jeu :
garder une copie.

## Utiliser

Jouer. L'agent écrit une ligne NDJSON par case nouvelle ou modifiée, et affiche
`[pz-export] N cases ecrites` dans la console du jeu. Puis :

```bash
python3 outils/agent-monde/convertir.py
```

qui produit `out/html/constructions.json`. Le viewer affiche alors une case
« mes constructions » dans le panneau.

## Limites

L'agent ne voit que la **zone chargée** autour de toi, bornée par
`IsoCell.getMinX()` à `getMaxZ()`. Ce n'est pas un scan global : la carte se
remplit à mesure que tu explores, et le fichier s'accumule.

Le balayage tourne sur son propre thread pendant que le jeu modifie le monde.
Des lectures incohérentes sont possibles ; chaque case est isolée dans un
`try/catch`, au pire elle est sautée et reprise au balayage suivant. L'agent
n'interrompt jamais le jeu, ce qui a été vérifié : privé des classes du jeu il
tourne en erreur en boucle sans faire tomber la JVM.

Le filtre par défaut garde les cases contenant un `IsoThumpable`. **Les portes
et fenêtres vanilla en sont aussi**, une maison d'origine intacte ressort donc.
La classe est partagée, ce n'est pas un défaut du filtre.

La table de déduplication est bornée à 3 millions de cases ; au-delà elle
repart de zéro et le fichier contient des doublons, que `convertir.py`
élimine à la lecture.

## Sur le serveur

L'agent ne lit que la mémoire locale et n'écrit qu'un fichier local. Rien n'est
envoyé au serveur ni aux autres joueurs : `System.out` part dans le système de
journalisation du jeu, donc `~/Zomboid/console.txt`, et `zombie.debug.DebugLog`
n'a aucune méthode de remontée réseau.

Beaucoup de serveurs imposent une liste blanche de mods. À voir avec
l'administrateur.
