# React Native / Expo Android 构建沙箱。
# Google Android SDK 的 Linux 工具链按 amd64 发布；Apple Silicon 开发机请使用
# `docker build --platform linux/amd64`，生产环境推荐运行在 Linux amd64 构建节点。
ARG NODE_BASE_IMAGE=node:20-bookworm
FROM --platform=linux/amd64 ${NODE_BASE_IMAGE}

ARG ANDROID_CMDLINE_TOOLS=15859902
ARG ANDROID_CMDLINE_TOOLS_SHA256=4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583
ARG ANDROID_API_LEVEL=34
ARG ANDROID_BUILD_TOOLS=34.0.0

ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/build-tools/34.0.0:$PATH \
    EXPO_NO_TELEMETRY=1 \
    CI=1

RUN apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      ca-certificates \
      git \
      openjdk-17-jdk-headless \
      unzip \
      wget \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p "${ANDROID_HOME}/cmdline-tools" /tmp/android-tools \
    && wget -q \
      "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS}_latest.zip" \
      -O /tmp/android-tools.zip \
    && echo "${ANDROID_CMDLINE_TOOLS_SHA256}  /tmp/android-tools.zip" | sha256sum -c - \
    && unzip -q /tmp/android-tools.zip -d /tmp/android-tools \
    && mv /tmp/android-tools/cmdline-tools "${ANDROID_HOME}/cmdline-tools/latest" \
    && rm -rf /tmp/android-tools /tmp/android-tools.zip \
    && yes | sdkmanager --licenses >/dev/null 2>&1 || true

RUN sdkmanager \
      "platform-tools" \
      "platforms;android-${ANDROID_API_LEVEL}" \
      "build-tools;${ANDROID_BUILD_TOOLS}" \
    && rm -rf /root/.android/cache /root/.gradle/caches

WORKDIR /workspace

# 容器保持存活，由平台通过 docker exec 执行 npm / Expo / Gradle / ADB。
CMD ["sleep", "infinity"]
