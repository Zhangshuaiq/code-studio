package codestudio.compat;
import java.lang.instrument.*;
import java.security.ProtectionDomain;
import org.objectweb.asm.*;
/** Experimental diagnostic only; do not resurrect the indexer during bundle stop. */
public final class IndexThreadGuardAgent {
    public static void premain(String args, Instrumentation instrumentation) {
        instrumentation.addTransformer(new ClassFileTransformer() {
            public byte[] transform(ClassLoader loader, String name, Class<?> type, ProtectionDomain domain, byte[] bytes) throws IllegalClassFormatException {
                if (!"org/eclipse/jdt/internal/core/search/processing/JobManager".equals(name)) return null;
                try { byte[] guarded = guardReset(bytes); System.err.println("CODE_STUDIO_INDEX_GUARD_APPLIED"); return guarded; }
                catch (RuntimeException error) { throw new IllegalClassFormatException("Diagnostic guard could not transform JDT JobManager"); }
            }
        });
    }
    public static byte[] guardReset(byte[] original) {
        ClassReader reader = new ClassReader(original);
        ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_MAXS);
        final int[] changed = {0};
        reader.accept(new ClassVisitor(Opcodes.ASM9, writer) {
            public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
                if (!"reset".equals(name) || !"()V".equals(descriptor)) return super.visitMethod(access, name, descriptor, signature, exceptions);
                if ((access & (Opcodes.ACC_STATIC | Opcodes.ACC_NATIVE | Opcodes.ACC_ABSTRACT)) != 0) throw new IllegalArgumentException("Unexpected reset method");
                changed[0]++;
                return new MethodVisitor(Opcodes.ASM9, super.visitMethod(access, name, descriptor, signature, exceptions)) {
                    public void visitCode() {
                        super.visitCode(); Label exists = new Label(), ready = new Label();
                        visitLdcInsn("org.eclipse.jdt.core");
                        visitMethodInsn(Opcodes.INVOKESTATIC, "org/eclipse/core/runtime/Platform", "getBundle", "(Ljava/lang/String;)Lorg/osgi/framework/Bundle;", false);
                        visitInsn(Opcodes.DUP); visitJumpInsn(Opcodes.IFNONNULL, exists);
                        visitInsn(Opcodes.POP); visitJumpInsn(Opcodes.GOTO, ready);
                        visitLabel(exists); visitFrame(Opcodes.F_SAME1, 0, null, 1, new Object[] {"org/osgi/framework/Bundle"});
                        visitMethodInsn(Opcodes.INVOKEINTERFACE, "org/osgi/framework/Bundle", "getState", "()I", true);
                        visitIntInsn(Opcodes.BIPUSH, 16); // Bundle.STOPPING
                        visitJumpInsn(Opcodes.IF_ICMPNE, ready); visitInsn(Opcodes.RETURN);
                        visitLabel(ready); visitFrame(Opcodes.F_SAME, 0, null, 0, null);
                    }
                };
            }
        }, 0);
        if (changed[0] != 1) throw new IllegalArgumentException("Expected one instance reset method");
        return writer.toByteArray();
    }
}
