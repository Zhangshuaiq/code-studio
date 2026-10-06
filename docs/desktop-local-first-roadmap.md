# Code Studio 本地优先桌面版 Roadmap

> 状态基线：2026-09-23。本文是实施路线图；已上线能力仍以源码、README 和技术方案为准。

## 1. 产品原则

> 网页版是桌面端唯一的布局与交互基准。桌面端复用网页版的全局侧栏、项目列表、工作区、代码/历史/预览标签、右侧智能助手和底部日志结构；仅在数据访问与“打开本地文件夹”等操作上适配本机能力，不另行设计一套桌面界面。

1. 本地项目、本地编辑和本地 Agent 不以登录或远程 API 可用为前提。
2. 用户本机目录是个人项目代码的唯一事实来源；许可证失效不得阻止读取、导出或提交用户代码。
3. 桌面 UI 默认只连接随客户端启动的 Local API。Local API 负责本机能力，并按需访问个人云或企业控制面。
4. 浏览器版本继续使用 Remote API；本地与远程执行共享 DTO、事件协议、模型 Provider 和工具契约，不共享完整部署单元。
5. 个人版不加载企业治理模块；团队/企业能力通过服务端 entitlement 和组织权限叠加。
6. 密钥只保存在其实际使用位置：本地密钥进入系统凭据库，企业密钥留在企业服务端。
7. 企业策略必须由 Local API 强制执行，不能只依靠前端隐藏入口。
8. 个人桌面版（Community / Personal Pro）的数据库增删改查直接执行，不接入审批；应用视当前用户为数据库功能管理员，实际执行权限由配置的数据库账号决定。团队/企业版沿用独立治理规则。

## 2. 目标架构

```text
Electron
├── React UI
├── Local API（127.0.0.1 随机端口 + 启动令牌）
│   ├── Local Workspace：文件、Git、搜索、命令
│   ├── Agent Runtime：模型与 CLI
│   ├── Preview Runtime：本机进程，可选 Docker
│   ├── Connector Runtime：DB、Kafka、Kubernetes
│   └── Local Store：SQLite + 系统凭据库
└── 可选 Control API
    ├── Personal Cloud：账号、订阅、设备、同步
    └── Team/Enterprise：组织、权限、策略、审计、远程执行
```

Local API 不是现有服务端 API 的完整复制。两者复用领域包和协议，但加载不同模块：桌面端不依赖 PostgreSQL、Redis、BullMQ 或独立 Worker。

## 3. 产品版本与登录状态

| 能力 | 未登录 / Community | Personal Pro | Team | Enterprise |
| --- | --- | --- | --- | --- |
| 本地项目、文件、Git、终端 | 是 | 是 | 是 | 是，可受策略约束 |
| 本地 Agent 与用户模型 | 是 | 是 | 是 | 是，可强制企业模型 |
| 本地搜索、代码导航、预览 | 是 | 是 | 是 | 是 |
| 设置/对话同步 | 否 | 是 | 是 | 是 |
| 团队项目、需求、知识库 | 否 | 否 | 是 | 是 |
| 远程执行与集中部署 | 否 | 可选增值 | 是 | 是 |
| RBAC、审批和审计 | 否 | 否 | 基础 | 完整 |
| SSO、SCIM、策略、私有化 | 否 | 否 | 可选 | 是 |

首次启动必须允许直接“打开本地项目”，登录个人账号和连接企业工作区都是可选入口。

## 4. 数据归属

| 数据 | 默认事实来源 |
| --- | --- |
| 项目代码、Git 仓库 | 用户本机目录 |
| 最近项目、路径映射、UI 设置 | 本地 SQLite |
| 本地任务与对话历史 | 本地 SQLite；用户明确开启后才同步 |
| 模型/连接器非敏感配置 | 本地 SQLite |
| API Key、Git Token、数据库密码 | macOS Keychain / Windows Credential Manager |
| 个人账号、订阅、设备激活 | Personal Cloud |
| 企业成员、权限、策略和审计 | Enterprise Control API |

## 5. 分阶段实施

### Phase 0：交互稳定与架构契约

状态：已完成（基础版本）。

- [x] Electron Windows/macOS 基础打包。
- [x] AI 运行中切换页面后的会话内事件回放。
- [x] 工作区代码/预览/历史常驻，避免切换时重建编辑器和 iframe。
- [x] 桌面项目路由页签保留独立工作区实例，切换至数据源等页面后返回不重载文件树/索引；后台项目不响应全局编辑快捷键。
- [x] 工作区默认进入代码页。
- [x] 定义版本 entitlement、执行事件、工作区和模型配置的共享契约。
- [x] 为 Local API 与 Control API 划定稳定路由命名空间。

验收：现有 Web 构建通过；共享契约不依赖 Electron、NestJS 或 React。

### Phase 1：可离线启动的桌面底座

状态：已完成（基础版本）。

- [x] Electron 启动仅监听 `127.0.0.1` 随机端口的 Local API。
- [x] 每次启动生成高强度会话令牌并校验 Origin；不向局域网暴露端口。
- [x] 打包并由 Local API 托管 React 静态资源，不再依赖 Vite 或远程 Web 地址。
- [x] 无账号进入本地首页，支持打开/创建本地目录。
- [x] 引入本地 SQLite，保存最近项目、设置和版本迁移记录。
- [x] Windows/macOS 系统凭据库适配（Electron safeStorage：Keychain / DPAPI，SQLite 仅保存密文）。
- [x] 远程服务器连接保留为可选 Control API 配置，而非启动前置条件。

验收：断网、无 Docker、无 PostgreSQL、无 Redis、未登录时，可以安装、启动并进入本地首页。

### Phase 2：本地工作区与高级搜索

状态：已完成（基础版本）。

- [x] 目录选择授权、最近项目和失效路径恢复。
- [x] 本地文件树、读取、原子保存、外部修改检测和冲突提示。
- [x] Git 状态、diff、选择文件提交、分支创建/切换及远程 fetch/pull/push。
- [x] 使用 ripgrep 的全局文本搜索，支持正则、大小写、文件过滤和 `.gitignore`。
- [x] 快速打开文件（Cmd/Ctrl+P）、编辑位置历史前进/后退。
- [x] Search Everywhere：文件、文本、符号、动作统一入口（Cmd/Ctrl+P；`@` 符号、`#` 全文、`>` 动作）。

当前增量：TypeScript/JavaScript、Python、Java、C/C++ 与 Vue 已接入项目级语言服务，支持未保存内容同步、F12、Cmd/Ctrl+点击、定义、引用、悬浮提示、文档符号和工作区符号；真实跨文件导航测试已覆盖上述语言。本地 Git 已接入分支/领先落后状态、变更文件选择、工作区/暂存区 diff、本地提交、分支创建/切换及远程同步，所有路径由 Local API 做工作区边界校验，Push 前由界面二次确认。

文件查看增量：工作区会按文件类型自动选择查看器。文本继续由 Monaco 编辑；PNG/JPEG/GIF/WebP/SVG/BMP/ICO 和 PDF 通过工作区边界校验后的本地流预览；`.xlsx` 与 `.csv` 在 Local API 内解析为多工作表网格，并限制为 20 个工作表、500 行、100 列和 20 MiB，避免大文件阻塞客户端。未知二进制及旧版 `.xls` 会显示明确的不支持提示，不再按 UTF-8 文本打开。

验收：十万文件级仓库搜索不会阻塞 UI；结果可准确跳转到行列；本地保存不经过 Control API。

### Phase 3：本地模型与 Agent Runtime

状态：进行中。

- [x] 复用统一模型配置与 Provider 契约，并持久化本地执行配置。（Codex 模型目录从本机 CLI 动态读取；模型连接与每次项目对话均可选择具体模型和推理强度，任务保存模型快照，并按模型汇总真实 input/cached/output token 消耗）
- [ ] 支持本机 Codex、Claude、Aider、Ollama/LM Studio 和 OpenAI-compatible API。（运行适配器与本机发现已完成；模型页已提供真实连接诊断：Codex/Claude 检查本机账号登录，Aider 检查 CLI 与模型端点，Ollama/LM Studio/OpenAI-compatible 检查模型列表、认证、延迟和配置模型是否存在；当前开发机已验证 Codex CLI 0.156.1 与 Claude Code 2.1.168 登录状态，OpenAI-compatible 已通过带认证的集成测试，Aider/Ollama/LM Studio 仍需具备对应运行时后逐项验收）
- [x] Agent 由 Local API 直接在本地工作区启动，不经过 BullMQ、Redis 或服务端 Worker。
- [x] 同一工作区单写者、取消、超时和进程树清理。
- [x] 本地任务/对话持久化，重启后把遗留运行任务标记为中断。
- [x] Agent 工具调用审批与目录边界校验。（只读代码分析工具可直接调用；工作区写任务通过原生确认框逐次授权，令牌绑定项目、模型和任务内容、60 秒失效且仅可使用一次；Codex 使用原生 workspace sandbox，Claude 禁用 Shell/网络工具，Aider 限定 subtree，进程启动前再次校验规范化后的真实工作区根目录）

当前增量：已在 macOS 实机识别 Codex CLI 0.156.1 与 Claude Code 2.1.168，并按真实 `exec` / `--print` 参数校正启动方式；桌面 GUI PATH 会补入 Homebrew 与用户级 CLI 目录。任务启动前必须选择只读或工作区写入权限。写入任务不再信任网页确认：Electron 主进程显示原生授权框，确认后签发绑定项目、60 秒过期且只能消费一次的随机令牌，Local API 对缺失、跨项目或重放令牌均拒绝启动。Codex 使用内建 `read-only/workspace-write` sandbox，并禁用项目级用户配置与会话落盘；Claude 使用只读/编辑工具白名单，禁用 Bash、Slash Command 和项目 MCP 注入；Aider 仅允许显式写入任务并启用 subtree 限制。CLI 非交互协议尚不能把每一次工具审批暂停并回调桌面 UI，因此“逐工具审批”仍保持未完成。Aider、Ollama/LM Studio 仍需在安装环境中验收。

验收：关闭远程 API 后仍能完成一次模型调用、文件修改、diff 审阅和本地 Git 提交。

### Phase 4：本地预览、终端与连接器

状态：进行中。

- [x] 本地终端 PTY 和命令权限提示。
- [x] Node、Java、Python 项目本机预览生命周期与端口分配。（Node `package.json` 脚本、Django/Python `app.py`、Maven/Gradle Spring Boot 首批配置）
- [x] 客户端退出时清理子进程；异常退出后可恢复或清理遗留状态。
- [x] Docker 作为可选运行时，不作为桌面版前置条件。（仅在项目包含 Dockerfile 且用户主动选择时构建；绑定本机回环端口，输出进入运行日志，停止或退出时清理容器与临时镜像）
- [x] 数据库、Kafka、Kubernetes 连接由 Local API 使用本机网络执行。（PostgreSQL、MySQL、Kafka、Kubernetes 首批连接与真实连通测试）
- [x] 本地日志、构建日志和资源状态。（代码区底部统一展示终端、项目运行输出、预览状态和最近智能任务状态）
- [x] Java main 入口运行与 DAP 调试。（顶部入口选择、运行/Debug/停止，底部控制台、调用栈、可展开变量、暂停/继续/单步；行号左侧断点及当前执行行。复用 JDT 编译、依赖与 JDK 解析，支持程序/JVM 参数、保存后重新编译。真实 Java 与 Electron 界面测试通过，不依赖远程 Worker。）
- [ ] JUnit/TestNG、远程 Attach、多线程选择、表达式求值、条件断点、热替换和跨重启运行配置持久化；Python/Node DAP 适配器仍待接入。

验收：不启动服务器 Worker 即可运行、预览和调试本地项目；连接器凭证不离开本机。

当前增量：Local API 只允许启动自动检测出的明确配置：`package.json` 中的 `dev/start/preview/serve`、Django `manage.py runserver`、Python `app.py`、Maven/Gradle Spring Boot。每个项目分配随机 loopback 端口，框架参数和环境变量均固定到 `127.0.0.1`，保留最多 500 行日志，并在客户端正常退出时终止完整预览进程树；桌面预览页支持选择配置、启动、停止、内嵌页面和外部浏览器打开。启动命令前必须由用户确认。

终端增量：工作区已接入真实 PTY 与 xterm，支持 ANSI、交互输入、窗口尺寸同步、滚动历史、会话恢复及主动结束；Shell 的初始目录固定为当前项目，首次启动前提示终端可以执行命令和修改文件，客户端退出时统一清理会话。

连接器增量：首页提供 PostgreSQL、MySQL、Kafka 与 Kubernetes 连接管理。非敏感配置进入本地 SQLite，密码与 Token 由系统凭据加密；连接测试分别执行数据库查询/心跳、Kafka 元数据读取和 Kubernetes 版本请求，均由 Local API 直接使用当前设备网络，响应和错误不会返回凭据。

个人数据库权限增量：Community / Personal Pro 对 PostgreSQL、MySQL 直接执行单条 SQL，支持增删改查及数据库账号允许的 DDL，不走审批或写入确认；写操作返回影响行数，带 RETURNING 的 PostgreSQL 写操作返回结果表。打开连接面板不会自动执行 SQL。Local API 根据当前版本和企业策略决定读写权限，不信任渲染层传入的权限字段；团队/企业模式暂保留只读规则，后续独立接入治理。PostgreSQL 已提供隔离 schema 实机 CRUD 测试，MySQL 写操作仍待真实环境验收。

进程恢复增量：Agent 与预览命令由独立守护进程托管，守护进程每 500ms 检查桌面主进程；主进程崩溃或被强制结束时，会对命令进程组执行 TERM/KILL 清理。正常退出仍由 Runtime 主动停止并等待子进程，终端 PTY 在控制端关闭后触发挂断与统一清理。

### Phase 5：本地代码智能与 LSP

状态：进行中。TypeScript/JavaScript、Python 与 Java 已形成可用的首批语言服务链路，高阶重构能力正在后续接入。

- [x] Local LSP Manager：进程启动、按项目复用、项目打开时一次性后台预热、空闲回收、崩溃恢复和退出清理。
- [x] Monaco 编辑器与本地语言服务通道（定义、引用、悬浮和文档符号 Provider）。
- [x] TypeScript/JavaScript、Pyright、JDT LS 首批接入。（Java 项目内源码跳转已通过 JDT LS 实测，并在冷启动无结果时使用项目符号索引回退；JAR/JDK 依赖通过 JDT LS 返回的项目绑定只读引用打开源码或反编译实现，不开放任意外部路径。已实测 JDK String 与无源码包的自建 JAR 方法实现）
- [x] 定义/声明/类型跳转、引用、实现、悬浮、诊断和补全。
- [x] Lombok 生成方法识别。（随包提供 Lombok 1.18.38 javaagent 和 Java Debug 0.53.2 插件；测试覆盖 `@Data` getter/setter 无误报、真正不存在的方法仍报错及编译运行。项目仍须声明 Lombok 依赖，不屏蔽真实诊断。）
- [x] Java 运行前首次完整重建，清除升级前缓存中的 Lombok 旧错误；后续成功运行使用增量编译。编译失败展示真实文件/行号及错误列表，点击可跳转源码。已使用 `fx-server` 只读源码快照验证完整编译成功，不修改原项目、不执行应用。
- [x] Debug 暂停状态版本化，防止异步调用栈/单步响应覆盖新暂停；源码定位等待目标 Monaco 挂载，变量按当前会话/暂停/调用帧重新读取，Java 惰性对象引用先解析再展开真实字段。实现及排障详见 [代码导航与 Java Debug](./editor-code-intelligence.md)。
- [x] 工作区符号、文档符号、调用层级、跨文件重命名和 Quick Fix。
- [x] Agent 复用 `workspace_symbols`、`find_references`、`definition` 和 `diagnostics` 工具。（OpenAI 兼容与 Ollama 模型通过受控函数调用读取项目代码索引；调用次数、结果数量与响应大小均有限制）
- [ ] 后续接入 gopls、rust-analyzer、clangd 和 Vue Language Tools。（四类适配器与 Monaco Provider 已接入；clangd 已通过真实 C++ 跨文件测试；Vue Language Server 2.2.12 已作为桌面依赖随包交付，并通过 `.vue` 到 TypeScript 的真实跨文件定义跳转测试；gopls 与 rust-analyzer 仍待具备对应运行时的环境兼容性验收）

验收：TypeScript、Python、Java 示例工程通过跨文件定义跳转和引用查找；大型仓库索引有明确资源上限。

索引资源边界：后台预加载最多 500 个源码文件、总计 8 MiB、单文件 256 KiB；达到限制时 Local API 返回 `truncated` 与结构化 `limits`，桌面工作区显示非阻断提示，未预加载文件仍可按需打开并交给语言服务处理。

### Phase 6：个人账号与许可证

状态：进行中。

- [x] Community 永久允许无账号本地使用。（桌面入口在登录判断前进入本地首页；Local API 能力契约明确核心功能无需账号、许可证或远程 API，且核心访问无到期时间）
- [x] 个人账号、订阅、套餐、设备和兑换码后台。（复用现有账号/JWT/RBAC；Control API 提供套餐分配、设备与兑换码管理；兑换码只保存 SHA-256 摘要、原码仅在创建时展示一次，并在数据库锁内限制总次数与账号重复使用；Web 管理后台提供套餐分配、兑换码生成/停用和用量查看。支付提供商属于可选商业接入，不作为本地版或许可证后台的运行前置条件）
- [ ] 在线登录签发非对称签名 License Token，本地只内置验证公钥。（Control API 已实现 Ed25519 Token 签发，声明格式与桌面验签器完成跨端测试；桌面“账户与许可证”页面已通过 Local API 安全代理完成登录和在线激活，远程 access token 使用系统凭据能力加密且不暴露给渲染层；仍待正式构建公钥注入）
- [x] 设备激活、用户自助撤销和合理设备上限。（Control API 提供激活、设备列表和自助撤销；桌面账户页已接入；并发设备上限通过 PostgreSQL advisory lock 串行执行；退出账号保留已验签的离线许可证且不影响 Community 核心能力）
- [x] 离线宽限期和挑战/响应式离线许可证文件。（客户端可通过原生文件对话框导出设备挑战、导入签发文件；Web 管理端可为指定套餐用户签发 Ed25519 响应。响应绑定设备与随机 nonce，申请 30 天失效且仅可导入一次；服务端和 Local API 已覆盖签名、过期、设备绑定及防重放测试）
- [x] 到期只关闭付费能力，不锁定本地代码。（验签失败、设备不匹配、到期或移除许可证均降级为 Community；项目、文件、Git、终端、预览、本地 Agent、搜索、代码导航和连接器保持可用）
- [ ] 可选设置/对话同步和明确的隐私开关。（本地显式开关、默认关闭、`cloud.sync` entitlement 强制校验及本地变更审计已完成；真实同步服务与冲突合并仍待实现）

验收：未登录、在线授权、宽限期离线、离线许可证、到期降级五条链路均有自动化测试。

### Phase 7：Team 与 Enterprise 控制面

状态：进行中。

- [ ] 组织、团队、邀请、席位和域名验证。（组织、成员角色和席位上限的数据模型、Control API 与 Web 企业控制台已完成；邮箱邀请支持创建/撤销/接受，员工从网页或桌面账户页输入 7 天有效的单次代码。数据库仅保存邀请摘要，接受时检查邮箱和当前席位。域名验证已增加 DNS TXT 挑战、7 天有效期、刷新/移除及跨组织独占认领，验证不会自动授予成员权限。真实 PostgreSQL 隔离 schema 测试已覆盖并发席位、邀请重放、域名独占与移除；DNS 内容使用受控测试记录。邀请/域名迁移尚未部署，公网企业 DNS 与组织到项目组的权限映射仍待验收）
- [ ] 组织角色、项目角色、发布/运维/审计职责分离。
- [ ] 企业模型、远程执行、需求、知识库、审批和审计。
- [ ] OIDC，随后支持 SAML、SCIM 和 LDAP/AD。
- [ ] 企业策略：模型、外发、Shell、MCP、Git 主机、连接器、离线和最低客户端版本。
- [ ] Local API 签名策略缓存、过期处理和强制执行。（Control API 已仅向有效 Enterprise 套餐的组织成员签发 Ed25519 策略；客户端激活 Enterprise 时强制同步并验签，支持手动刷新、本地缓存、离线宽限/过期后 fail-closed，以及模型、终端、连接器、Git 远程主机、网络目标和最低客户端版本强制执行；MCP 服务器白名单仍待实现）
- [ ] SaaS 与私有化 Control API 部署模式。

验收：员工通过企业 SSO 登录；管理员可分配席位/权限、下发策略、撤销设备和审计高风险操作。

## 6. 跨阶段质量门槛

- Windows x64 与 macOS arm64/x64 构建；正式发布启用签名和 macOS notarization。
- 本地 HTTP 只绑定 loopback，启动令牌不写日志，不接受任意 Origin。
- 本地路径、源码和密钥默认不上传；任何同步都必须显式开启并可审计。
- 数据库迁移可回滚或安全前滚；升级失败不能损坏用户项目。
- Agent、终端、预览和 LSP 子进程都有资源限制与完整进程树清理。
- 每阶段同时提供自动化测试、故障恢复测试和对应用户文档。

## 7. 与现有文档的关系

- [`editor-code-intelligence.md`](./editor-code-intelligence.md) 继续描述浏览器/远程工作区能力；Phase 5 描述桌面本地 LSP，两者共享协议而不共享运行实例。
- [`agent-worker-deployment.md`](./agent-worker-deployment.md) 仅适用于远程执行；桌面本地 Agent 不进入 BullMQ。
- [`mcp-agent-design.md`](./mcp-agent-design.md) 的审批与工具契约可复用；本地工具由 Local API 执行并遵守企业策略。
