# 供应链版本与校验策略

机器可读清单位于 [`supply-chain-versions.json`](./supply-chain-versions.json)。更新沙箱基础镜像或外部工具时，应同时更新该清单和对应 Dockerfile。

## 生产约束

- `NODE_BASE_IMAGE`、`PYTHON_BASE_IMAGE`、`JAVA_BASE_IMAGE` 必须传入企业仓库中的 `name@sha256:digest`，Dockerfile 中的 tag 仅供本地开发。
- 所有环境默认采用 `DEPENDENCY_ACCESS_POLICY=proxy-upstream`，npm、PyPI、Maven 均通过受控代理解析；内部代理可以访问官方上游并缓存仓库中尚不存在的依赖。
- 可配置 `proxy-cache-only` 或 `direct`。前者仍由应用强制走内部代理，但必须由代理管理员在 Nexus/Artifactory 侧关闭上游；后者不注入代理地址，需经过明确的部署配置评审。
- Maven 通过 `DEPENDENCY_MAVEN_MIRROR_URL` 指向受控镜像；平台只在隔离 Job 的临时 `/tmp` 中生成 `settings.xml`，不会修改项目文件。生产 Kubernetes 的代理模式强制三类代理均为 HTTPS，且禁止把用户名或密码直接编码进 URL。
- 直接下载的归档必须固定版本并在解压前校验 SHA-256。
- Android Command-line Tools 的版本和哈希以 Android Developers 官方下载页为准；不得只替换 URL 或版本号。
- 基础镜像晋级前应完成漏洞、许可证和来源扫描，并保存扫描报告与最终 digest。
- 构建完成后将四类最终沙箱镜像推送到受控仓库，以仓库返回的 digest 填入 Helm `runtime.images.node/java/python/reactNative`。平台启动配置和创建 Kubernetes Job 时会再次拒绝可变 tag。
- digest 只能保证内容不可变，不能证明发布者身份。生产集群还应由平台团队使用 Kyverno、Sigstore policy-controller 或同类准入控制器验证签名；该类集群级策略不由应用 Chart 自动安装。

## 镜像晋级顺序

1. 使用固定 digest 的基础镜像构建沙箱镜像。
2. 对最终镜像执行漏洞、许可证和恶意文件扫描。
3. 使用受管密钥或 keyless 身份签名最终镜像，并保存 provenance/SBOM。
4. 将最终 digest 更新到生产 values，经代码评审后部署。
5. 准入控制器同时校验允许的仓库前缀、签名身份和 digest，任一条件不满足即拒绝 Job。

生产示例中的全零 digest 是故意不可运行的占位符，部署前必须替换，避免遗漏配置时退回可变 tag。

仓库提供 `npm run supply-chain:validate` 检查清单、Android 工具版本及哈希是否同步；生产流水线应设置三个基础镜像环境变量，并执行 `npm run supply-chain:validate:production`，拒绝缺失 digest 或仍使用可变 tag 的构建。该脚本不访问网络，也不替代镜像漏洞、许可证和来源扫描。
