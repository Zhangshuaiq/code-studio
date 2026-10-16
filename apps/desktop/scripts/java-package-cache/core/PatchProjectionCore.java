import java.nio.file.*;
import java.util.*;
import java.util.jar.*;
import java.io.*;
import java.security.MessageDigest;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;
import org.objectweb.asm.util.*;

/** Offline, version-locked transformation of a private copy, not an agent. */
public class PatchProjectionCore {
    static final String OWNER = "org/eclipse/jdt/internal/core/search/matching/JavaSearchNameEnvironment";
    static final String HELPER = "org/eclipse/jdt/internal/core/search/matching/PackageNameProjection";
    static Map<String, String> methods(byte[] bytes) {
        ClassNode type = new ClassNode();
        new ClassReader(bytes).accept(type, ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
        Map<String, String> result = new LinkedHashMap<>();
        for (MethodNode method : type.methods) {
            Textifier text = new Textifier(); method.accept(new TraceMethodVisitor(text));
            result.put(method.name + method.desc, text.getText().toString());
        }
        return result;
    }
    static byte[] patch(byte[] bytes) {
        ClassReader reader = new ClassReader(bytes); ClassNode type = new ClassNode(); reader.accept(type, 0);
        if (!type.name.equals(OWNER)) throw new IllegalArgumentException("Unexpected JDT class");
        int changed = 0;
        for (MethodNode method : type.methods) {
            if (!method.name.equals("indexPackageNames") || !method.desc.equals("(Lorg/eclipse/jdt/internal/core/builder/ClasspathLocation;Lorg/eclipse/jdt/core/IPackageFragmentRoot;)V")) continue;
            MethodInsnNode children = null, elementName = null;
            for (AbstractInsnNode instruction : method.instructions) if (instruction instanceof MethodInsnNode call) {
                if (call.owner.equals("org/eclipse/jdt/core/IPackageFragmentRoot") && call.name.equals("getChildren")) {
                    if (children != null) throw new IllegalArgumentException("Multiple getChildren sites"); children = call;
                }
                if (call.owner.equals("org/eclipse/jdt/core/IJavaElement") && call.name.equals("getElementName")) {
                    if (elementName != null) throw new IllegalArgumentException("Multiple name sites"); elementName = call;
                }
            }
            if (children == null || elementName == null) throw new IllegalArgumentException("JDT method shape changed");
            AbstractInsnNode dot = elementName.getNext(), slash = dot.getNext(), replace = slash.getNext();
            if (!(dot instanceof IntInsnNode d) || d.operand != 46 || !(slash instanceof IntInsnNode s) || s.operand != 47 || !(replace instanceof MethodInsnNode r) || !r.owner.equals("java/lang/String") || !r.name.equals("replace") || !r.desc.equals("(CC)Ljava/lang/String;")) throw new IllegalArgumentException("Normalization site changed");
            method.instructions.set(children, new MethodInsnNode(Opcodes.INVOKESTATIC, HELPER, "names", "(Lorg/eclipse/jdt/core/IPackageFragmentRoot;)[Ljava/lang/String;", false));
            method.instructions.remove(elementName); method.instructions.remove(dot); method.instructions.remove(slash); method.instructions.remove(replace);
            // The array elements in this first loop are now normalized strings.
            // Remove stale debug local descriptors; COMPUTE_FRAMES derives types.
            method.localVariables = null; changed++;
        }
        if (changed != 1) throw new IllegalArgumentException("Expected exactly one target method");
        ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_FRAMES | ClassWriter.COMPUTE_MAXS);
        type.accept(writer); byte[] result = writer.toByteArray();
        Map<String, String> before = methods(bytes), after = methods(result);
        if (!before.keySet().equals(after.keySet())) throw new IllegalArgumentException("Method set changed");
        int differences = 0;
        for (String method : before.keySet()) if (!before.get(method).equals(after.get(method))) {
            if (!method.startsWith("indexPackageNames(")) throw new IllegalArgumentException("Unrelated method changed: " + method);
            differences++;
        }
        if (differences != 1) throw new IllegalArgumentException("Expected exactly one semantic method change");
        return result;
    }
    public static void main(String[] args) throws Exception {
        Path input = Path.of(args[0]), output = Path.of(args[1]), helper = Path.of(args[2]);
        String sha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(input)));
        if (!sha.equals("723e30be1e841516c388ebb32017cb8b36662808f46be5265b78cc06bd4fe71c")) throw new IllegalArgumentException("Unsupported JDT core artifact; refuse to patch");
        try (JarFile jar = new JarFile(input.toFile())) {
            Manifest manifest = new Manifest(jar.getManifest());
            // This is a locally modified experiment, not an Eclipse-signed build.
            manifest.getEntries().clear();
            manifest.getMainAttributes().putValue("Code-Studio-Projection-Experiment", "snapshot-v1");
            try (JarOutputStream result = new JarOutputStream(Files.newOutputStream(output, StandardOpenOption.CREATE_NEW), manifest)) {
                Enumeration<JarEntry> entries = jar.entries();
                int patchedEntries = 0;
                while (entries.hasMoreElements()) {
                    JarEntry entry = entries.nextElement(); String name = entry.getName();
                    if (name.equalsIgnoreCase("META-INF/MANIFEST.MF") || name.matches("(?i)META-INF/[^/]+\\.(SF|RSA|DSA|EC)")) continue;
                    byte[] bytes = jar.getInputStream(entry).readAllBytes();
                    if (name.equals(OWNER + ".class")) { bytes = patch(bytes); patchedEntries++; }
                    result.putNextEntry(new JarEntry(name)); result.write(bytes); result.closeEntry();
                }
                if (patchedEntries != 1) throw new IllegalArgumentException("Expected exactly one core class entry");
                result.putNextEntry(new JarEntry(HELPER + ".class")); result.write(Files.readAllBytes(helper)); result.closeEntry();
            }
        }
        System.out.println("{\"originalCoreSha256\":\"" + sha + "\",\"patchedExactlyOneMethod\":true}");
    }
}
