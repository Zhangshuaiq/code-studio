# Node 沙箱镜像（前端项目：React + Vite）
ARG NODE_BASE_IMAGE=node:20-bookworm
FROM ${NODE_BASE_IMAGE}

# 基础工具
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# 预留 npm 私服配置挂载点（后续平台安装时可预设）
# COPY .npmrc /root/.npmrc

WORKDIR /workspace

# 容器保持存活，供编排服务 exec / 启动 dev server
CMD ["sleep", "infinity"]
