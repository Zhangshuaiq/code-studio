package org.eclipse.jdt.internal.core.search.matching;

import java.util.*;
import org.eclipse.jdt.core.*;

/** Temporary JDT experiment: immutable projection of a model-owned snapshot. */
public final class PackageNameProjection {
    private static final Object LOCK = new Object();
    private static final Map<IJavaElement[], String[]> CACHE = new WeakHashMap<>();
    private static int retainedNames, retainedChars;
    private static long generation, calls, hits, misses, invalidations, evictions;
    private static volatile boolean installed;
    // Eclipse may redirect System.err to its own log; diagnostics must reach
    // the process stderr pipe without ever writing to LSP stdout.
    private static final java.io.PrintStream DIAGNOSTICS = new java.io.PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.err), true);
    public static String[] names(IPackageFragmentRoot root) throws JavaModelException {
        install();
        return project(root.getChildren());
    }
    private static synchronized void install() {
        if (installed) return;
        JavaCore.addElementChangedListener(event -> invalidate(), ElementChangedEvent.POST_CHANGE | ElementChangedEvent.POST_RECONCILE);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> DIAGNOSTICS.println("CODE_STUDIO_PACKAGE_PROJECTION_STATS " + stats()), "package-projection-diagnostic"));
        installed = true;
        DIAGNOSTICS.println("CODE_STUDIO_PACKAGE_PROJECTION_USED");
    }
    static String[] project(IJavaElement[] children) {
        long version;
        synchronized (LOCK) {
            calls++; version = generation;
            String[] found = CACHE.get(children);
            if (found != null) {
                if (++hits == 1) DIAGNOSTICS.println("CODE_STUDIO_PACKAGE_PROJECTION_HIT");
                return found;
            }
            misses++;
        }
        String[] result = new String[children.length]; long chars = 0;
        for (int i = 0; i < children.length; i++) {
            result[i] = children[i].getElementName().replace('.', '/'); chars += result[i].length();
        }
        synchronized (LOCK) {
            // A concurrent model change must not populate the next generation.
            if (version == generation && result.length <= 200000 && chars <= 2000000) {
                if (CACHE.size() >= 4096 || retainedNames + result.length > 200000 || retainedChars + chars > 2000000) {
                    CACHE.clear(); retainedNames = 0; retainedChars = 0; generation++; evictions++;
                }
                String[] prior = CACHE.put(children, result);
                if (prior != null) { retainedNames -= prior.length; for (String name : prior) retainedChars -= name.length(); }
                retainedNames += result.length; retainedChars += (int) chars;
            }
        }
        return result; // Internal consumer only reads; never exposed via LSP.
    }
    static void invalidate() {
        synchronized (LOCK) { CACHE.clear(); retainedNames = 0; retainedChars = 0; generation++; invalidations++; }
    }
    static String stats() {
        synchronized (LOCK) {
            return "{\"calls\":" + calls + ",\"hits\":" + hits + ",\"misses\":" + misses + ",\"invalidations\":" + invalidations + ",\"evictions\":" + evictions + ",\"entries\":" + CACHE.size() + ",\"retainedNamesUpperBound\":" + retainedNames + ",\"retainedCharsUpperBound\":" + retainedChars + "}";
        }
    }
}
