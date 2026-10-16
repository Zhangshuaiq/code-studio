package codestudio.diagnostic;

import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.*;
import java.util.function.Supplier;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;

/** Developer command only. Does not replace any JDT navigation/indexing code. */
public class PackageMetadataProbe implements IDelegateCommandHandler {
    static class Cache {
        final Map<Object, List<String>> values = new LinkedHashMap<>(16, .75f, true);
        volatile long revision;
        long hits, misses;
        int names;
        synchronized void invalidate() { values.clear(); names = 0; revision++; }
        List<String> read(Object key, Supplier<List<String>> provider) {
            long version;
            synchronized (this) {
                version = revision;
                List<String> found = values.get(key);
                if (found != null) { hits++; return found; }
                misses++;
            }
            List<String> result = List.copyOf(provider.get());
            synchronized (this) {
                if (version != revision) throw new IllegalStateException("Java model changed during metadata extraction");
                if (result.size() <= 200000) {
                    while (!values.isEmpty() && (values.size() >= 4096 || names + result.size() > 200000)) {
                        Object first = values.keySet().iterator().next(); names -= values.remove(first).size();
                    }
                    List<String> prior = values.put(key, result);
                    if (prior != null) names -= prior.size();
                    names += result.size();
                }
                return result;
            }
        }
    }
    static List<String> readNames(IPackageFragmentRoot root) {
        try {
            return normalize(root.getChildren());
        } catch (JavaModelException error) { throw new IllegalStateException(error); }
    }
    static List<String> normalize(IJavaElement[] children) {
        List<String> result = new ArrayList<>();
        for (IJavaElement child : children) result.add(child.getElementName().replace('.', '/'));
        return result;
    }
    static String key(IPackageFragmentRoot root, Map<String, String> stamps) throws Exception {
        // Sources and JRT roots deliberately stay uncached in this prototype.
        if (!root.isArchive()) return null;
        Path path = root.getPath().toFile().toPath();
        String raw = path.toString();
        if (!raw.endsWith(".jar")) return null;
        String stamp = stamps.get(raw);
        if (stamp == null) {
            if (!Files.isRegularFile(path)) { stamps.put(raw, ""); return null; }
            String physical = path.toRealPath().toString();
            BasicFileAttributes attrs = Files.readAttributes(Path.of(physical), BasicFileAttributes.class);
            stamp = physical + ":" + attrs.fileKey() + ":" + attrs.lastModifiedTime() + ":" + attrs.size();
            stamps.put(raw, stamp);
        }
        if (stamp.isEmpty()) return null;
        IJavaProject project = root.getJavaProject();
        String projectKey = "@project:" + project.getHandleIdentifier();
        String options = stamps.get(projectKey);
        if (options == null) {
            options = project.getOption(JavaCore.COMPILER_COMPLIANCE, true) + ":" + project.getOption(JavaCore.COMPILER_SOURCE, true) + ":" + project.getOption(JavaCore.COMPILER_CODEGEN_TARGET_PLATFORM, true);
            stamps.put(projectKey, options);
        }
        return root.getHandleIdentifier() + ":" + options + ":" + stamp;
    }
    public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        if (!command.equals("codestudio.diagnostic.packageMetadata")) throw new IllegalArgumentException("Unsupported command");
        if (!arguments.isEmpty() && "provenance".equals(arguments.get(0))) {
            Class<?> type = Class.forName("org.eclipse.jdt.internal.core.search.matching.JavaSearchNameEnvironment", false, JavaCore.class.getClassLoader());
            String resource = "/" + type.getName().replace('.', '/') + ".class";
            String sha;
            try (var stream = type.getResourceAsStream(resource)) {
                if (stream == null) throw new IllegalStateException("Missing runtime class resource");
                sha = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(stream.readAllBytes()));
            }
            boolean helper; String projectionStats = "absent";
            try {
                Class<?> projection = Class.forName("org.eclipse.jdt.internal.core.search.matching.PackageNameProjection", false, type.getClassLoader()); helper = true;
                var stats = projection.getDeclaredMethod("stats"); stats.setAccessible(true); projectionStats = String.valueOf(stats.invoke(null));
            }
            catch (ClassNotFoundException error) { helper = false; }
            return Map.of("source", "actual-jdt-runtime:provenance-v1", "coreLocation", String.valueOf(JavaCore.class.getProtectionDomain().getCodeSource().getLocation()), "classResource", String.valueOf(type.getResource(resource)), "classSha256", sha, "projectionHelperPresent", helper, "projectionStats", projectionStats);
        }
        boolean nativeModel = !arguments.isEmpty() && "native".equals(arguments.get(0));
        List<IPackageFragmentRoot> roots = new ArrayList<>(); int projects = 0;
        for (var resource : ResourcesPlugin.getWorkspace().getRoot().getProjects()) {
            IJavaProject project = JavaCore.create(resource);
            if (!project.exists()) continue;
            projects++;
            roots.addAll(Arrays.asList(project.getAllPackageFragmentRoots()));
        }
        if (roots.size() > 10000) throw new IllegalStateException("Diagnostic root budget exceeded");
        Cache cache = new Cache();
        IElementChangedListener changed = event -> cache.invalidate();
        JavaCore.addElementChangedListener(changed, ElementChangedEvent.POST_CHANGE | ElementChangedEvent.POST_RECONCILE);
        try {
            List<Long> baselineMs = new ArrayList<>(), cachedMs = new ArrayList<>();
            List<List<String>> expected = new ArrayList<>();
            for (IPackageFragmentRoot root : roots) expected.add(readNames(root));
            long names = expected.stream().mapToLong(List::size).sum();
            if (names > 2000000) throw new IllegalStateException("Diagnostic package budget exceeded");
            int cachedRoots = 0;
            for (int round = 0; round < 6; round++) {
                long version = cache.revision;
                List<List<String>> baseline = new ArrayList<>(), candidate = new ArrayList<>();
                long baselineNanos = 0, cachedNanos = 0;
                for (int pass = 0; pass < 2; pass++) {
                    boolean caching = (round % 2 == 0) == (pass == 1);
                    long started = System.nanoTime();
                    Map<String, String> stamps = new HashMap<>(); int eligible = 0;
                    for (IPackageFragmentRoot root : roots) {
                        if (monitor.isCanceled()) throw new IllegalStateException("Cancelled");
                        if (!caching) baseline.add(readNames(root));
                        else if (nativeModel) {
                            IJavaElement[] children = root.getChildren();
                            eligible++;
                            candidate.add(cache.read(children, () -> normalize(children)));
                        }
                        else {
                            String key = key(root, stamps);
                            if (key != null) eligible++;
                            candidate.add(key == null ? readNames(root) : cache.read(key, () -> readNames(root)));
                        }
                    }
                    if (caching) { cachedNanos = System.nanoTime() - started; cachedRoots = eligible; }
                    else baselineNanos = System.nanoTime() - started;
                }
                if (version != cache.revision) throw new IllegalStateException("Java model changed during benchmark; retry after indexing");
                if (!expected.equals(baseline) || !baseline.equals(candidate)) throw new AssertionError("Package metadata mismatch");
                baselineMs.add(baselineNanos / 1000000); cachedMs.add(cachedNanos / 1000000);
            }
            // Explicitly discard cached data and verify a new generation.
            cache.invalidate();
            Map<String, String> stamps = new HashMap<>();
            for (int i = 0; i < roots.size(); i++) {
                IPackageFragmentRoot root = roots.get(i);
                List<String> actual;
                if (nativeModel) { IJavaElement[] children = root.getChildren(); actual = cache.read(children, () -> normalize(children)); }
                else { String key = key(root, stamps); actual = key == null ? readNames(root) : cache.read(key, () -> readNames(root)); }
                if (!expected.get(i).equals(actual)) throw new AssertionError("Invalidation mismatch");
            }
            return Map.of("source", nativeModel ? "actual-jdt-model:native-v3" : "actual-jdt-model:v2", "projects", projects, "roots", roots.size(), "cacheableRoots", cachedRoots, "packageReferences", names, "baselineMs", baselineMs, "cachedMs", cachedMs, "cacheHits", cache.hits, "cacheMisses", cache.misses, "allNamesAndOrderIdentical", true);
        } finally { JavaCore.removeElementChangedListener(changed); }
    }
    public static void main(String[] args) {
        Cache cache = new Cache();
        List<String> input = new ArrayList<>(List.of("a/b"));
        List<String> first = cache.read("version-one", () -> input);
        input.clear();
        if (!first.equals(List.of("a/b"))) throw new AssertionError("mutable snapshot");
        try { first.add("bad"); throw new AssertionError("mutable result"); } catch (UnsupportedOperationException expected) {}
        cache.read("version-one", () -> { throw new AssertionError("missed cache"); });
        cache.invalidate();
        if (!cache.read("version-one", () -> List.of("new/pkg")).equals(List.of("new/pkg"))) throw new AssertionError("stale generation");
        for (int i = 0; i < 4100; i++) { final int value = i; cache.read("key" + i, () -> List.of("p" + value)); }
        if (cache.values.size() > 4096 || cache.names > 200000) throw new AssertionError("cache budget");
        cache.invalidate();
        org.eclipse.jdt.internal.core.OpenableElementInfo info = new org.eclipse.jdt.internal.core.OpenableElementInfo();
        IJavaElement a = namedElement("old.pkg"), b = namedElement("new.pkg");
        info.addChild(a); IJavaElement[] original = info.getChildren();
        List<String> oldNames = cache.read(original, () -> normalize(original));
        info.addChild(b); IJavaElement[] added = info.getChildren();
        if (original == added || !oldNames.equals(List.of("old/pkg"))) throw new AssertionError("copy-on-write add");
        if (!cache.read(added, () -> normalize(added)).equals(List.of("old/pkg", "new/pkg"))) throw new AssertionError("stale package add");
        info.removeChild(a); IJavaElement[] removed = info.getChildren();
        if (added == removed || !cache.read(removed, () -> normalize(removed)).equals(List.of("new/pkg"))) throw new AssertionError("stale package removal");
        try { cache.read("concurrent", () -> { cache.invalidate(); return List.of("stale"); }); throw new AssertionError("concurrent invalidation accepted"); }
        catch (IllegalStateException expected) {}
        System.out.println("{\"snapshotTestsPassed\":true}");
    }
    static IJavaElement namedElement(String name) {
        return (IJavaElement)java.lang.reflect.Proxy.newProxyInstance(PackageMetadataProbe.class.getClassLoader(), new Class<?>[]{IJavaElement.class}, (proxy, method, args) -> switch (method.getName()) {
            case "getElementName" -> name;
            case "equals" -> proxy == args[0];
            case "hashCode" -> System.identityHashCode(proxy);
            default -> null;
        });
    }
}
