package org.eclipse.jdt.internal.core.search.matching;
import java.util.*;
import java.lang.reflect.Proxy;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.internal.core.OpenableElementInfo;

public class ProjectionCoreTest {
    static IJavaElement element(String name) {
        return (IJavaElement)Proxy.newProxyInstance(ProjectionCoreTest.class.getClassLoader(), new Class<?>[]{IJavaElement.class}, (proxy, method, args) -> switch(method.getName()) {
            case "getElementName" -> name;
            case "equals" -> proxy == args[0];
            case "hashCode" -> System.identityHashCode(proxy);
            default -> null;
        });
    }
    public static void main(String[] args) throws Exception {
        OpenableElementInfo info = new OpenableElementInfo();
        IJavaElement a = element("alpha.pkg"), b = element("beta.pkg");
        info.addChild(a); IJavaElement[] first = info.getChildren();
        String[] old = PackageNameProjection.project(first);
        if (!Arrays.equals(old, new String[]{"alpha/pkg"}) || PackageNameProjection.project(first) != old) throw new AssertionError("projection/reuse");
        info.addChild(b); String[] added = PackageNameProjection.project(info.getChildren());
        if (!Arrays.equals(added, new String[]{"alpha/pkg", "beta/pkg"}) || !Arrays.equals(old, new String[]{"alpha/pkg"})) throw new AssertionError("add changed prior snapshot");
        info.removeChild(a);
        if (!Arrays.equals(PackageNameProjection.project(info.getChildren()), new String[]{"beta/pkg"})) throw new AssertionError("remove stale");
        PackageNameProjection.invalidate();
        if (PackageNameProjection.project(first) == old) throw new AssertionError("invalidation");
        // An invalidation while a miss is being computed must not repopulate
        // the next generation with the previous model snapshot.
        IJavaElement changing = (IJavaElement)Proxy.newProxyInstance(ProjectionCoreTest.class.getClassLoader(), new Class<?>[]{IJavaElement.class}, (proxy, method, values) -> {
            if (method.getName().equals("getElementName")) { PackageNameProjection.invalidate(); return "changed.pkg"; }
            return null;
        });
        IJavaElement[] unstable = {changing};
        String[] before = PackageNameProjection.project(unstable);
        if (PackageNameProjection.project(unstable) == before) throw new AssertionError("stale concurrent population");
        // Identity keys are weak, but entry/name budgets must also hold while
        // every snapshot is strongly retained by an active model.
        List<IJavaElement[]> retained = new ArrayList<>();
        PackageNameProjection.invalidate();
        for (int i = 0; i < 4100; i++) {
            IJavaElement[] snapshot = {a}; retained.add(snapshot); PackageNameProjection.project(snapshot);
        }
        if (!PackageNameProjection.stats().contains("\"evictions\":1")) throw new AssertionError("entry budget");
        IJavaElement[] oversized = new IJavaElement[200001]; Arrays.fill(oversized, a);
        String[] over = PackageNameProjection.project(oversized);
        if (PackageNameProjection.project(oversized) == over) throw new AssertionError("oversized snapshot retained");
        // Load/verify the transformed class too, rather than just its helper.
        Class.forName("org.eclipse.jdt.internal.core.search.matching.JavaSearchNameEnvironment").getDeclaredMethods();
        System.out.println("{\"projectionAndPatchedClassVerificationPassed\":true}");
    }
}
