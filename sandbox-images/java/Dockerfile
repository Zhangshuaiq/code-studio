# Java 沙箱镜像（阶段 2 完善）
# 第一期：Maven + JDK 17
ARG JAVA_BASE_IMAGE=maven:3.9-eclipse-temurin-17
FROM ${JAVA_BASE_IMAGE}

# 基础工具
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# 预留 Maven 私服 settings.xml 挂载点
# COPY settings.xml /root/.m2/settings.xml

# 依赖缓存层占位：阶段 2 用一个 warmup pom 预热常用依赖
# COPY warmup-pom.xml /tmp/pom.xml
# RUN mvn -f /tmp/pom.xml dependency:go-offline

WORKDIR /workspace

# 容器保持存活，供编排服务 exec 命令
CMD ["sleep", "infinity"]
