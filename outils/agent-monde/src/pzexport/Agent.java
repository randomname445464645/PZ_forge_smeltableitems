package pzexport;

import java.io.BufferedWriter;
import java.io.FileWriter;
import java.lang.instrument.Instrumentation;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.Map;

import zombie.iso.IsoCell;
import zombie.iso.IsoGridSquare;
import zombie.iso.IsoObject;
import zombie.iso.IsoWorld;
import zombie.iso.objects.IsoThumpable;
import zombie.util.list.PZArrayList;

/**
 * Exporte la zone de monde chargee en memoire vers un fichier NDJSON.
 *
 * Pourquoi un agent plutot qu'un debogueur distant : JDWP fait passer chaque
 * lecture de champ par un aller-retour reseau et exige un thread suspendu pour
 * invoquer une methode. Balayer la zone chargee y demanderait des millions
 * d'allers-retours, jeu fige. Un agent tourne DANS le processus, sans aucun
 * aller-retour.
 *
 * Pourquoi pas un mod Lua : meme resultat, mais rien a deposer dans le dossier
 * des mods ni a declarer au jeu. C'est un choix, pas une superiorite technique.
 *
 * Installation : ajouter aux vmArgs de ProjectZomboid64.json
 *     -javaagent:/chemin/agent-monde.jar=periode=5,sortie=/chemin/monde.ndjson
 *
 * Options (separees par des virgules) :
 *     periode=<secondes>   intervalle entre deux balayages, defaut 5
 *     sortie=<chemin>      fichier de sortie, defaut ~/Zomboid/pz-export/monde.ndjson
 *     tout=1               exporte TOUS les objets ; par defaut, seules les
 *                          constructions de joueur (IsoThumpable) et les cases
 *                          qui en contiennent
 */
public final class Agent {

    private static final String DEFAUT_SORTIE =
            System.getProperty("user.home") + "/Zomboid/pz-export/monde.ndjson";

    private static long periodeMs = 5000L;
    private static String sortie = DEFAUT_SORTIE;
    private static boolean tout = false;

    // Signature de la derniere version vue de chaque case, pour n'ecrire que
    // ce qui a change. Cle = (x, y, z) empaquetes, valeur = hachage du contenu.
    private static final Map<Long, Integer> vues = new HashMap<>();

    // Au-dela de cette taille on repart de zero : sans borne, une longue
    // exploration ferait enfler la table indefiniment.
    private static final int MAX_VUES = 3_000_000;

    public static void premain(String args, Instrumentation inst) { demarrer(args); }
    public static void agentmain(String args, Instrumentation inst) { demarrer(args); }

    private static void demarrer(String args) {
        lireOptions(args);
        Thread t = new Thread(Agent::boucle, "pz-export");
        t.setDaemon(true);                 // ne retient jamais l'arret du jeu
        t.setPriority(Thread.MIN_PRIORITY);
        t.start();
        System.out.println("[pz-export] agent actif, sortie=" + sortie
                + " periode=" + (periodeMs / 1000) + "s tout=" + tout);
    }

    private static void lireOptions(String args) {
        if (args == null || args.isEmpty()) return;
        for (String p : args.split(",")) {
            int i = p.indexOf('=');
            if (i < 0) continue;
            String cle = p.substring(0, i).trim();
            String val = p.substring(i + 1).trim();
            switch (cle) {
                case "periode" -> {
                    try { periodeMs = Math.max(1000L, Long.parseLong(val) * 1000L); }
                    catch (NumberFormatException ignore) { }
                }
                case "sortie" -> sortie = val;
                case "tout"   -> tout = "1".equals(val) || "true".equalsIgnoreCase(val);
            }
        }
    }

    private static void boucle() {
        BufferedWriter w = null;
        try {
            Path p = Paths.get(sortie);
            if (p.getParent() != null) Files.createDirectories(p.getParent());
            w = new BufferedWriter(new FileWriter(sortie, true), 1 << 16);
        } catch (Throwable e) {
            System.out.println("[pz-export] sortie impossible : " + e);
            return;
        }

        while (true) {
            try {
                Thread.sleep(periodeMs);
                int n = balayer(w);
                if (n > 0) {
                    w.flush();
                    System.out.println("[pz-export] " + n + " cases ecrites");
                }
            } catch (InterruptedException e) {
                return;
            } catch (Throwable e) {
                // Un agent d'export ne doit JAMAIS faire tomber le jeu.
                System.out.println("[pz-export] erreur ignoree : " + e);
            }
        }
    }

    private static int balayer(BufferedWriter w) throws Exception {
        IsoWorld monde = IsoWorld.instance;
        if (monde == null) return 0;
        IsoCell cell = monde.getCell();
        if (cell == null) return 0;

        // Bornes REELLES de la zone chargee : c'est tout ce que le client a en
        // memoire, le serveur n'envoie rien de plus.
        final int x0 = cell.getMinX(), x1 = cell.getMaxX();
        final int y0 = cell.getMinY(), y1 = cell.getMaxY();
        final int z0 = cell.getMinZ(), z1 = cell.getMaxZ();
        if (x1 <= x0 || y1 <= y0) return 0;

        if (vues.size() > MAX_VUES) vues.clear();

        StringBuilder ligne = new StringBuilder(256);
        int ecrites = 0;

        for (int z = z0; z <= z1; z++) {
            for (int y = y0; y < y1; y++) {
                for (int x = x0; x < x1; x++) {
                    IsoGridSquare sq;
                    try {
                        sq = cell.getGridSquare(x, y, z);
                    } catch (Throwable e) {
                        continue;   // le jeu modifie le monde pendant qu'on lit
                    }
                    if (sq == null) continue;

                    PZArrayList<IsoObject> objets;
                    try {
                        objets = sq.getObjects();
                    } catch (Throwable e) {
                        continue;
                    }
                    if (objets == null || objets.size() == 0) continue;

                    ligne.setLength(0);
                    boolean aConstruction = false;
                    int nb = 0;
                    ligne.append("{\"x\":").append(x)
                         .append(",\"y\":").append(y)
                         .append(",\"z\":").append(z)
                         .append(",\"s\":[");

                    for (int i = 0; i < objets.size(); i++) {
                        IsoObject o;
                        String nom;
                        boolean construit;
                        try {
                            o = objets.get(i);
                            if (o == null) continue;
                            nom = o.getSpriteName();
                            if (nom == null || nom.isEmpty()) continue;
                            construit = (o instanceof IsoThumpable);
                        } catch (Throwable e) {
                            continue;
                        }
                        if (construit) aConstruction = true;
                        if (nb > 0) ligne.append(',');
                        ligne.append('"').append(echapper(nom)).append('"');
                        nb++;
                    }
                    ligne.append("]}");

                    if (nb == 0) continue;
                    if (!tout && !aConstruction) continue;

                    // N'ecrire que si la case a change depuis le dernier passage.
                    long cle = (((long) (x & 0x1FFFFF)) << 26)
                             | (((long) (y & 0x1FFFFF)) << 5)
                             | ((long) (z & 0x1F));
                    int h = ligne.toString().hashCode();
                    Integer ancien = vues.get(cle);
                    if (ancien != null && ancien == h) continue;
                    vues.put(cle, h);

                    w.write(ligne.toString());
                    w.write('\n');
                    ecrites++;
                }
            }
        }
        return ecrites;
    }

    /** Echappement JSON minimal : les noms de sprites sont alphanumeriques. */
    private static String echapper(String s) {
        if (s.indexOf('"') < 0 && s.indexOf('\\') < 0) return s;
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
