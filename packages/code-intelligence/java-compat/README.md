# Java 索引退出兼容补丁（实验）

此目录不是自行开发的 language server，也没有替换 JDT 原始 JAR。补丁由开发者显式传入可信的本地 `resources.indexThreadGuardJar` 才会启动；默认资源和已安装客户端不启用。

目的：在 `org.eclipse.jdt.core` bundle 为 OSGi STOPPING 状态时，禁止 `org.eclipse.jdt.internal.core.search.processing.JobManager.reset()` 重新创建索引线程。ACTIVE/STARTING、bundle 不存在的场景继续原始实现；不增加运行时同步锁，其他方法及运行时索引不禁用。早期实验曾对 reset 加同步锁，现已撤回，不能将其小项目结果推广至大项目。关闭后继任务在框架停止过程中重建线程，是当前针对退出线程快照的兼容性假设，不应推广为所有 JDT 卡顿的原因。

构建：`node apps/desktop/scripts/build-index-thread-guard.cjs`。构建器在临时目录编译 Java 8 兼容字节码，使用现有 JDT 发行包的 ASM，保留 ASM 原始 JAR 和授权元数据，不将 Eclipse mock 类打入补丁包。需要本机 javac/jar，仅供开发验证；未加入正式安装/打包流水线。

验证：`node apps/desktop/scripts/benchmark-java-lifecycle.cjs --cycles=3 --summary --index-thread-guard=<输出的绝对 JAR 路径>`。需要同时保留旁边的 `asm.jar`。只有收到补丁实际转换的固定 stderr 标记才算已应用；标记转为无敏感内容的生命周期事件，不混入 LSP stdout。真实 Java 导航和运行测试可通过 `CODE_STUDIO_TEST_INDEX_THREAD_GUARD_JAR` 显式选择该补丁。

验收边界：行为单测、隔离项目生命周期、Java 源码/JAR/JDK、Lombok、格式化、运行和断点调试；大项目、多操作系统、升级后持久缓存完整性及长期运行仍需专项验收。尚未默认启用，不意味着整个 P0 已完成。
