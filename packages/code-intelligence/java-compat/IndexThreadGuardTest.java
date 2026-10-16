package codestudio.compat;
import java.io.*;
import java.lang.reflect.Modifier;
public final class IndexThreadGuardTest {
    public static class Fixture {
        public int value;
        public void reset() { Runnable action = () -> value++; action.run(); }
        public void reset(int ignored) { value++; }
    }
    private static byte[] resource(String name) throws Exception {
        try (InputStream input = IndexThreadGuardTest.class.getResourceAsStream(name)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[4096]; int count;
            while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
            return output.toByteArray();
        }
    }
    public static void main(String[] args) throws Exception {
        byte[] changed = IndexThreadGuardAgent.guardReset(resource("IndexThreadGuardTest$Fixture.class"));
        Class<?> fixture = new ClassLoader() { Class<?> loadBytes() { return defineClass(null, changed, 0, changed.length); } }.loadBytes();
        Object instance = fixture.getConstructor().newInstance();
        if (Modifier.isSynchronized(fixture.getDeclaredMethod("reset").getModifiers())) throw new AssertionError("Added a runtime lock");
        if (Modifier.isSynchronized(fixture.getDeclaredMethod("reset", int.class).getModifiers())) throw new AssertionError("Wrong overload");
        org.eclipse.core.runtime.Platform.state = 32;
        fixture.getMethod("reset").invoke(instance);
        if (fixture.getField("value").getInt(instance) != 1) throw new AssertionError("Normal reset lost");
        org.eclipse.core.runtime.Platform.state = 16;
        fixture.getMethod("reset").invoke(instance);
        if (fixture.getField("value").getInt(instance) != 1) throw new AssertionError("Stopping reset not suppressed");
        org.eclipse.core.runtime.Platform.state = -1;
        fixture.getMethod("reset").invoke(instance);
        if (fixture.getField("value").getInt(instance) != 2) throw new AssertionError("Missing bundle reset lost");
        try { IndexThreadGuardAgent.guardReset(resource("IndexThreadGuardTest.class")); throw new AssertionError("Missing reset accepted"); }
        catch (IllegalArgumentException expected) {}
        System.out.println("Index guard: verifier, normal/stopping/missing bundle and overload tests passed");
    }
}
