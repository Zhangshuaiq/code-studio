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
- [x] Java 运行配置跨重启持久化。（每项目保存当前 main 入口、程序参数与 JVM 参数，显式保存/清除；完整配置经系统凭据加密后存入本地 SQLite，不写入项目、不访问 Control API。恢复时核对入口，已失效入口需用户重新选择；参数不绕过运行时的编译、入口校验和企业策略。）
- [x] Java 暂停调用帧的手动表达式求值。（基本值、对象结果与字段展开、方法调用、错误反馈；仅用户提交时执行，明确提示潜在副作用。Local API 校验当前会话/暂停版本和帧，响应后再次校验，切帧或新暂停清除旧结果；求值后重新读取变量，不后台自动执行。）
- [x] Java 行断点按项目本地持久化与重启恢复。（本地加密配置、自动保存/恢复、请求串行避免旧快照覆盖、恢复期间点击合并；恢复不等待语言服务。删除文件最后一个断点时向 DAP 显式清除该 source。配置测试 7/7、Local API 回归 19/19 通过；实际 Electron renderer 重载后无需再次点击即可恢复断点，并完成真实 Java 暂停定位、变量、求值、单步、停止和编译错误导航回归。）
- [x] Java 条件断点。（行号左侧右键编辑条件、条件标记与悬浮说明；本机加密持久化，兼容既有行号快照；DAP 能力协商，不支持时拒绝，不静默退化为普通断点。条件求值可能有副作用，编辑表单明确提示。）
- [x] Java 命中次数与日志断点。（右键设置、第 N 次命中暂停、日志表达式插值输出且不暂停；独立能力检查，本机加密保存/恢复。真实 Java Adapter 的暂停事件计数验证通过。）
- [x] Java 编辑行断点迁移基础：插入/删除行、多光标编辑、撤销插入行；保留条件/计数/日志字段，源码未保存时暂缓持久化，保存后提交新位置。真实 Monaco/Electron 与 Java 调试回归通过。
- [x] 删除断点所在行后撤销/重做自动恢复；统一监听项目 Java 模型，覆盖跨文件符号重命名产生的非当前页签编辑。历史按项目隔离、内存有界，手动改断点及模型重置清理旧历史。
- [x] 草稿放弃与部分保存的断点一致性：每文件保留磁盘源码对应的断点检查点，写入成功才推进；关闭并放弃草稿恢复检查点，保存/移动请求未完成时禁止关闭文件。

断点保存边界补强（2026-10-12）：内存中的草稿位置、磁盘源码对应位置与加密配置写入位置明确分离。`BreakpointDiskCheckpoints` 在发起单文件/全部保存前复制断点对象，只在对应源码写入成功后提交该文件的检查点；未成功的文件不推进，HTTP 期间的后续编辑不改变捕获快照。关闭并放弃草稿先恢复其最近成功保存的断点，清理撤销历史，再在全部草稿清空后沿用串行保存流程。保存或路径移动未完成时不允许关闭文件，避免关闭后异步写入仍推进磁盘。新增检查点测试验证元数据复制及部分成功/失败边界；共 41 项本地接口、断点、文件移动与运行配置测试通过，客户端构建通过。真实 Electron 测试延迟一次保存响应，确认无法关闭；保持另一个文件未保存时单独保存 Main，把断点从 4 推进到磁盘行 5；再次插入移到草稿行 6 后放弃两个文件，配置恢复 5，重新打开看到磁盘行 5，再还原源码至行 4。完整 Java 调试回归通过。未替换本机安装包，未将整个本地优先/企业控制面目标标记完成。
- [x] 右键重命名/移动文件和文件夹：同步已打开模型、页签、光标导航路径及本地断点配置；拒绝覆盖、Git 元数据、路径越界、符号链接路径、自身子目录及活动 Java 运行期间的移动。
- [x] 多命名 Java 运行配置：本机加密保存名称、入口、程序/JVM 参数和当前选择；支持新建、更新/改名、切换、删除及重启恢复，兼容旧单配置。
- [x] Java 多线程调试：线程下拉/刷新、切换调用栈与变量、显式暂停所选线程、单步所选线程、继续所有线程；部分线程暂停状态与旧变量引用隔离验证通过。
- [ ] JUnit/TestNG、远程 Attach 和热替换；Python/Node DAP 适配器仍待接入。IDE 语义 Move Refactoring（自动修改 Java 包名/引用）、外部修改后的语义断点重定位作为后续增量。

Java 多线程调试增量（2026-10-12）：暂停后通过 DAP threads 获取线程，CSS 下拉切换 threadId，再请求该线程 stackTrace；切换推进检查上下文 stopVersion，清空旧调用栈与变量，迟到响应不能覆盖新暂停/新会话。线程集合显示最多 1000 项且保留当前线程，超限明确提示，名称限制 500 字符；调用栈请求最多 50 帧。实际 Java Adapter 的断点默认仅暂停事件线程，选中运行中的其他线程可能没有调用栈；界面明确提示，用户可显式暂停所选线程，不自动改变程序执行。记录已知暂停线程 ID，按 continued/allThreadsContinued 更新；继续一个线程后其他线程仍暂停时，保持暂停状态并切换到剩余线程，而不是误报全部运行。增加 Java Adapter continueAll 扩展的显式“继续所有线程”；协议继续事件/响应省略 allThreadsContinued 时按全部继续处理。结束、停止和连接关闭清空线程状态。41 项暂停状态/本地 API/配置/断点回归及 renderer 构建通过；真实 Java/Electron 测试在工作线程断点后显式暂停主线程，分别显示 workerValue=73 与 mainValue=42，自动定位源码，拒绝旧 scopes 请求，刷新不改变暂停版本，工作线程单步到下一行并继续全部结束；原完整 Java UI 回归也退出 0。两个 Java smoke 使用独立临时 Electron userData，避免共用缓存。未替换本机安装包；线程终止、线程分组/过滤、虚拟线程规模性能和跨线程表达式高级控制尚未逐项实现/验收。

多命名运行配置增量（2026-10-12）：在优先完成混合文件类型/Markdown 修复和文档后继续 roadmap。新增 GET/POST java-run/configurations，按项目存储完整加密列表和 selectedId，最多 20 个配置，名称经 NFC/trim 规范化，限制 80 字符、拒绝控制字符及重名；每条保留原参数边界及字段白名单。旧单配置读为“默认配置”，仅首次修改时迁移到新加密键，写入新数据后才清理旧键；旧单配置 GET/POST 仍读取/更新当前选择，旧 DELETE 明确清空整个集合。新界面删除只删除当前条目，剩余配置自动选择第一条，不误删其他环境。断点存储单独覆盖 remove，防止共享基类移除运行配置集合。配置恢复失败不覆盖损坏数据，不阻止用户临时运行。6 项运行配置测试覆盖校验、加密、迁移、项目隔离、重启和旧接口兼容；与桌面 API/断点/共享文件类型共 35 项回归通过。真实 Java UI 创建开发/生产两套配置、CSS 下拉切换、重载恢复开发选择、运行输出 profile=dev:dev 证明程序/JVM 参数有效、删除开发配置后生产配置保留并自动恢复；既有断点/源码/变量/文件移动回归同时通过。未替换本机安装包；JUnit/Attach/热替换等仍未完成。

断点迁移补齐（2026-10-12）：更新上一增量的“撤销删除不恢复、跨文件路径迁移未实现”限制。用 Monaco alternativeVersionId 为修改前后保存小型断点快照，undo/redo 返回已知版本时恢复完整断点对象，包括最后一个已删除的条件/计数/日志断点。全部历史最多 256 个版本快照、20000 个断点条目，不存源码；超限淘汰的历史、手动改变断点后清理的历史及重新打开模型不承诺恢复已删除断点。统一监听同项目可写 Java 模型，已准备为草稿的跨文件编辑也更新文件状态及断点，不再依赖当前编辑器 onChange。文件树右键提供项目相对目标路径，要求父目录存在、所有草稿已保存并等待此前断点保存完成；API 在同一请求内移动文件与保存迁移后的配置，保存失败回滚文件路径，刷新索引并通知运行中的语言服务，重启恢复新路径。非 Java 项目无需等待 Java 断点初始化也能使用移动。39 项本地接口/迁移/运行配置测试、客户端构建及真实 Java/Electron 回归全部通过；真实测试包含最后断点删除的 undo/redo、非当前页签编辑后的全部保存、文件移出/移回及文件夹重命名。此移动不修改 Java 包名或引用，不等于语义 Move Refactoring；文件系统与 SQLite 并非跨资源原子事务，进程在两次提交之间崩溃的恢复日志仍需后续补强。本轮未替换本机安装包。

Java 编辑行断点迁移增量（2026-10-12）：更新此前“断点位置迁移未完成”的状态。使用 Monaco 编辑前 range 与替换文本计算行偏移，同批编辑从后向前处理。完整删除的行移除其断点，行合并时去重。仅消费非 isFlush 的可写 Java 编辑事件，避免初次加载或整模型重置当成用户编辑。迁移先更新内存与标记，所有未保存文件恢复为已保存状态后才串行持久化并刷新活动 DAP 快照。12 项迁移/断点测试、客户端构建及完整真实 Java UI 调试回归通过，包括实际插入、保存、撤销、再保存，并检查磁盘文件与配置行号同步。本轮未替换本机客户端。此增量不是语义重构跟踪：被删除行的断点不会因撤销删除自动复原，外部文件修改/模型 flush、文件重命名及热替换仍需独立实现。

验收：不启动服务器 Worker 即可运行、预览和调试本地项目；连接器凭证不离开本机。

当前增量：Local API 只允许启动自动检测出的明确配置：`package.json` 中的 `dev/start/preview/serve`、Django `manage.py runserver`、Python `app.py`、Maven/Gradle Spring Boot。每个项目分配随机 loopback 端口，框架参数和环境变量均固定到 `127.0.0.1`，保留最多 500 行日志，并在客户端正常退出时终止完整预览进程树；桌面预览页支持选择配置、启动、停止、内嵌页面和外部浏览器打开。启动命令前必须由用户确认。

终端增量：工作区已接入真实 PTY 与 xterm，支持 ANSI、交互输入、窗口尺寸同步、滚动历史、会话恢复及主动结束；Shell 的初始目录固定为当前项目，首次启动前提示终端可以执行命令和修改文件，客户端退出时统一清理会话。

Java 断点恢复增量（2026-10-11）：`/api/local/projects/:id/java-run/breakpoint-configuration` 提供 GET/POST/DELETE，仅保存项目相对 Java 路径和行号；完整快照经系统凭据能力加密后保存到本地 SQLite，按项目 ID 隔离，不写入源码，不需要登录或启动 JDT，不访问 Control API。最多 200 个文件、每文件 1000 个断点、总计 5000 个输入行号；拒绝路径穿越、绝对路径、依赖虚拟源码及非整数/越界行号，去重排序并去掉空文件组。桌面打开工作区自动恢复，行号边栏点击后串行自动保存；读取未结束时的点击先记为操作，再与恢复快照合并，旧项目响应不能覆盖新项目。Debug 在读取结束前不可启动，避免首次启动漏掉恢复断点。系统凭据不可用或缓存无法解密时不静默覆盖，反馈恢复/保存失败；临时内存断点和普通 Run 仍可使用。DAP 对已移除的 source 发送空断点列表，避免 UI 删除最后一个断点却继续暂停。7 项配置/运行配置测试覆盖实际 Local API 关停再启动、项目隔离、加密文件内容检查、无加密能力、坏密文和 DAP 清除。真实界面回归使用隔离 Java 项目与系统凭据替身；不等于安装包或跨平台验收。尚未实现条件断点、命中次数、日志断点、源码编辑后的断点位置自动迁移或重命名/删除文件的持久化跟随。

连接器增量：首页提供 PostgreSQL、MySQL、Kafka 与 Kubernetes 连接管理。非敏感配置进入本地 SQLite，密码与 Token 由系统凭据加密；连接测试分别执行数据库查询/心跳、Kafka 元数据读取和 Kubernetes 版本请求，均由 Local API 直接使用当前设备网络，响应和错误不会返回凭据。

Java 命中次数与日志断点增量（2026-10-12）：更新此前“命中次数/日志断点未实现”的状态。右键断点表单新增命中次数和日志消息；命中次数仅接受 1–2147483647 的正整数字符串，匹配当前 Java Adapter 的整数计数解析，不接受 >5、%2、==3 等会被该 Adapter 忽略的表达式。日志消息支持 Adapter 的 `{expression}` 插值，绿色标记与悬浮说明区别于普通/条件断点，非空日志意味着输出而不暂停。两类字段均有独立 DAP capability 校验，不支持则明确拒绝；日志/条件消息不在客户端解释执行。配置快照兼容整数及已有条件对象，提取 line/condition/hitCondition/logMessage，保留日志空格、限制字符串 2000 字符并拒绝 NUL，继续本机加密持久化；Java Adapter 的 userNotification 进入受限本地运行日志，避免表达式错误完全丢失。7 项断点测试通过，22 项 Local API/运行配置回归通过。真实 Electron + Java 测试从 DapConnection 记录所有 stopped 事件：计数 3 在 i=2 首次暂停，继续后结束且总暂停仅 1 次；纯日志断点产生 trace:0–3，重载保留绿色标记，总暂停 0 次；完整此前调试回归退出码为 0。未替换本机安装包。条件、命中次数与日志联用的复杂计数顺序未逐组合验收，不承诺每 N 次、比较运算等扩展语法；源码编辑位置迁移、多配置和其他 DAP 待办仍未完成。

Java 条件断点增量（2026-10-12）：取代上一阶段“条件断点尚未实现”的状态。桌面端右键 Java 行号左侧编辑表达式，应用后显示空心条件标记及悬浮说明；取消不提交，条件留空恢复普通断点。数字行号旧快照保持兼容，有条件时使用 `{line, condition}`，仍由系统凭据加密保存在本机，启动恢复和运行中变更复用已有同步机制。Runtime 检查 Adapter initialize 返回的 supportsConditionalBreakpoints，不支持时明确拒绝，条件不在前端求值；只发送受限 line/condition 字段。6 项断点测试与 22 项 Local API/运行配置回归通过。真实 Java + Electron 测试验证右键编辑、加密快照恢复、循环 i=0/1 不暂停、i=2 暂停、运行中改为 i==3 后再次暂停、清空条件恢复普通断点及停止；整套回归退出码 0。开发 renderer 构建通过，未替换本机安装包；不宣称完成条件表达式语法诊断、命中次数、日志断点、断点位置迁移、Attach 或其他语言 DAP。

Java 动态断点可靠性增量（2026-10-12）：调试动作忙碌时保留最新断点快照，动作结束后再同步，不再静默丢弃 gutter 点击；界面根据最新调试状态决定补发，停止后不再补发。后端按会话串行处理 DAP 更新，复制请求数组，失败不会使后续更新队列永久失效。5 项专项测试通过，涵盖并发阻塞、快照隔离、错误后恢复、清除及持久化。真实 Electron + Java Adapter 测试延迟第一个断点 HTTP 响应 500ms，在等待期间先移除第 4 行、再添加第 5 行，最终检查 Adapter 已确认快照仅剩第 5 行；完整回归继续验证单步、变量、求值、停止、编译错误定位及运行配置恢复/清除，退出码为 0。这是开发 renderer 与隔离项目验证，不代表已安装客户端包含此改动，也未实现条件断点等剩余 DAP 能力。

个人数据库权限增量：Community / Personal Pro 对 PostgreSQL、MySQL 直接执行单条 SQL，支持增删改查及数据库账号允许的 DDL，不走审批或写入确认；写操作返回影响行数，带 RETURNING 的 PostgreSQL 写操作返回结果表。打开连接面板不会自动执行 SQL。Local API 根据当前版本和企业策略决定读写权限，不信任渲染层传入的权限字段；团队/企业模式暂保留只读规则，后续独立接入治理。PostgreSQL 已提供隔离 schema 实机 CRUD 测试，MySQL 写操作仍待真实环境验收。

进程恢复增量：Agent 与预览命令由独立守护进程托管，守护进程每 500ms 检查桌面主进程；主进程崩溃或被强制结束时，会对命令进程组执行 TERM/KILL 清理。正常退出仍由 Runtime 主动停止并等待子进程，终端 PTY 在控制端关闭后触发挂断与统一清理。

### Phase 5：本地代码智能与 LSP

状态：进行中。TypeScript/JavaScript、Python 与 Java 已形成可用的首批语言服务链路，高阶重构能力正在后续接入。

- [x] Local LSP Manager：进程启动、按项目复用、项目打开时一次性后台预热、空闲回收、崩溃恢复和退出清理。
- [x] Monaco 编辑器与本地语言服务通道（定义、引用、悬浮和文档符号 Provider）。
- [x] 网页端复用共用语言运行时：远程 REST 语言接口、未保存缓冲区同步、项目隔离与 Java/JAR/JDK 只读源码；F12、跨文件行列定位、文件缓存和编辑器实例复用。真实 TS/Java API 与生产网页 UI 分别验收；多副本语言服务路由仍待完善，见 `editor-code-intelligence.md`。
- [x] TypeScript/JavaScript、Pyright、JDT LS 首批接入。（Java 项目内源码跳转已通过 JDT LS 实测，并在冷启动无结果时使用项目符号索引回退；JAR/JDK 依赖通过 JDT LS 返回的项目绑定只读引用打开源码或反编译实现，不开放任意外部路径。已实测 JDK String 与无源码包的自建 JAR 方法实现）
- [x] 定义/声明/类型跳转、引用、实现、悬浮、诊断和补全。
- [x] Lombok 生成方法识别。（随包提供 Lombok 1.18.38 javaagent 和 Java Debug 0.53.2 插件；测试覆盖 `@Data` getter/setter 无误报、真正不存在的方法仍报错及编译运行。项目仍须声明 Lombok 依赖，不屏蔽真实诊断。）
- [x] Java 运行前首次完整重建，清除升级前缓存中的 Lombok 旧错误；后续成功运行使用增量编译。编译失败展示真实文件/行号及错误列表，点击可跳转源码。已使用 `fx-server` 只读源码快照验证完整编译成功，不修改原项目、不执行应用。
- [x] Debug 暂停状态版本化，防止异步调用栈/单步响应覆盖新暂停；源码定位等待目标 Monaco 挂载，变量按当前会话/暂停/调用帧重新读取，Java 惰性对象引用先解析再展开真实字段。实现及排障详见 [代码导航与 Java Debug](./editor-code-intelligence.md)。
- [x] 工作区符号、文档符号、调用层级、跨文件重命名和 Quick Fix。
- [x] Agent 复用 `workspace_symbols`、`find_references`、`definition` 和 `diagnostics` 工具。（OpenAI 兼容与 Ollama 模型通过受控函数调用读取项目代码索引；调用次数、结果数量与响应大小均有限制）
- [ ] 后续接入 gopls、rust-analyzer、clangd 和 Vue Language Tools。（四类适配器与 Monaco Provider 已接入；clangd 已通过真实 C++ 跨文件测试；Vue Language Server 2.2.12 已作为桌面依赖随包交付，并通过 `.vue` 到 TypeScript 的真实跨文件定义跳转测试；gopls 与 rust-analyzer 仍待具备对应运行时的环境兼容性验收）

验收：TypeScript、Python、Java 示例工程通过跨文件定义跳转和引用查找；大型仓库索引有明确资源上限。

索引资源边界：桌面工作区不再启动时全量创建源码模型，文件与跳转目标按需加载；引用/实现预览最多加载 100 个目标、约 8 MiB，最多 4 路并发。兼容源码内容接口仍保留 500 文件、8 MiB 总量、256 KiB 单文件上限，但不再用于常规启动预加载。文件元数据快照最多 10,000 项，并持久化到用户数据目录；再次打开先读取快照，后台立即校验，此后每 120 秒检查变更，通知已运行的语言服务。Java 的语义索引继续由 JDT LS 的持久化工作目录管理，并非把源码文件列表当成引用关系。

- [x] 光标位置前进/后退历史（最多 100 项），支持同文件和跨文件、已缓存文件及只读依赖源码；提供 IDEA / VS Code / Eclipse 导航快捷键方案并持久化选择。
- [x] 实现/引用目标模型按需加载与原生编辑器 opener；TypeScript 跨文件查询先建立完整项目语义图，避免初次查询遗漏未打开的实现文件。
- [x] 异步持久化文件索引、后台定期刷新、收起目录不渲染子树。仍需用真实大型 Java 工程持续量化冷/热启动时间及峰值内存，不宣称首次索引零等待。
- [x] 默认文件索引与按查询分文件的导航缓存；热点 LRU 有项目/条数/体积上限，定期增量失效与近期查询后台刷新。保留可选 SQLite schema 8 差量存储，不默认全量加载所有引用到内存。1 万条合成元数据的本机预热读取基准约 13 ms（JSON）/45 ms（SQLite）；不等同于真实大项目语义索引耗时。

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
- [x] 基础组织角色与组织内成员管理。（账户页“我的组织”；owner 可修改组织角色和移除成员，admin 可查看成员及移除普通成员，member 仅查看自身所属组织。Control API 每次读取当前数据库成员身份，不把组织角色映射为平台管理员；跨组织与角色提升均拒绝。角色变更/移除使用组织事务锁，并保护最后一名有效 owner，包括平台管理员旧入口。）
- [x] 组织 owner/admin 自助邀请。（账户页复用企业邀请组件；owner 可邀请 member/admin，admin 仅邀请 member、撤销普通成员邀请，不得通过同邮箱重新生成来替换管理角色邀请。列表不回传原始令牌或摘要；生成时一次展示，撤销前确认，跨组织/非管理角色/停用均在后端拒绝。事务锁内重新授权并检查席位，邀请接受仍绑定邮箱、有效期和单次消费。）
- [x] 组织高风险 API 操作的基础审计。（组织创建、成员添加/移除/角色修改、邀请生成/接受/撤销、域名创建/验证/移除、策略更新；复用现有 AuditLog 和平台审计检索。记录操作者、组织、目标 ID、成功结果中白名单角色字段及成功/业务失败状态，不保存邀请代码、邮箱请求体、响应密钥或 URL 查询参数。）
- [x] 当前组织写入 API 的事务成功审计与白名单前后快照。（19 个写入路由、11 类动作覆盖组织创建、成员、邀请、域名和策略；业务状态与成功记录同事务提交/回滚，DNS 在事务外执行、持锁后重新授权并校验。真实 PostgreSQL 故障回滚及 JWT/桌面代理回归通过；仅指成功写入的一致性，不替代下方 outbox、完整失败/拒绝事件与职责分离要求。）
- [x] 组织范围审计查看。（账户页“我的组织”内提供操作记录、关键词/操作者/动作/结果/时间筛选、分页、详情及手动刷新。后端按当前有效 owner/admin 授权，固定组织 ID、organization 资源类型及 organization.* 动作范围；普通成员不加载记录，权限失败后不继续展示缓存记录。）
- [x] 独立组织只读审计员。（auditor 仅查看本组织审计，不获得成员、邀请、域名或安全策略管理权限，不获得平台 audit:read 或项目权限。owner/平台管理员可分配或邀请；admin 不能分配、修改、移除或通过重发替换审计员角色。网页/桌面共享角色选择、邀请标签和审计页面，撤权/停用后后端拒绝，界面隐藏旧记录。）
- [x] 组织 owner/admin 自助域名验证。（账户页复用企业域名组件，可生成 DNS TXT 挑战、检查验证与确认后移除；跨组织、普通成员、停用身份禁止访问。DNS 查询前授权，写入前在组织锁内重新授权，避免查询期间身份撤销后继续生效；平台原入口保留。验证不会自动授权成员。）
- [x] 桌面账户页复用组织成员/角色、邀请管理、域名与操作记录组件。（登录后按当前组织角色展示，未登录个人模式不挂载；Local API 只代理列出的组织路由，远程 bearer 留在本机加密存储。缓存按服务器/账户/登录会话隔离，退出或会话改变时取消并移除旧查询；旧请求和旧响应拒绝，远程登录失效后收起组织界面。）
- [x] 组织安全策略自助管理。（owner 可修改、admin 只读，member/停用/跨组织拒绝；平台、网页与桌面复用策略表单。组织锁内重新授权，按 updatedAt 校验草稿版本并防止并发静默覆盖；保存前确认，冲突保留草稿，重新读取前确认放弃修改。）
- [ ] 项目角色、发布/运维/审计职责分离，以及事务级可靠审计/outbox与变更前后快照。
- [ ] 企业模型、远程执行、需求、知识库、审批和审计。
- [ ] OIDC，随后支持 SAML、SCIM 和 LDAP/AD。
- [ ] 企业策略：模型、外发、Shell、MCP、Git 主机、连接器、离线和最低客户端版本。
- [ ] Local API 签名策略缓存、过期处理和强制执行。（Control API 已仅向有效 Enterprise 套餐的组织成员签发 Ed25519 策略；客户端激活 Enterprise 时强制同步并验签，支持手动刷新、本地缓存、离线宽限/过期后 fail-closed，以及模型、终端、连接器、Git 远程主机、网络目标和最低客户端版本强制执行；MCP 服务器白名单仍待实现）
- [ ] SaaS 与私有化 Control API 部署模式。

验收：员工通过企业 SSO 登录；管理员可分配席位/权限、下发策略、撤销设备和审计高风险操作。

组织权限增量（2026-10-08）：平台管理员仍负责创建组织并分配首名 owner；组织 owner/admin 无需平台 `admin:users` 权限即可在网页账户页使用组织范围成员管理。`GET /control/enterprise/organizations` 只返回当前用户的有效成员关系；`GET /control/enterprise/organizations/:id/members` 要求该组织 owner/admin；`PUT .../members/:userId/role` 和 `DELETE .../members/:userId` 在组织事务锁内重新授权。admin 不得提升自己或普通成员为管理角色，也不能移除管理角色；最后一名有效 owner 不能被删除/降级，需先指定另一名有效 owner。

成员角色或资格改变后，后续 Control API 请求按数据库新身份生效，不依赖旧 JWT 中的角色声明。已签发的桌面离线策略仍遵循既有刷新/过期/离线宽限机制，不能宣称组织移除会即时吊销离线客户端缓存。组织成员关系不自动授予项目组、项目读写或平台角色；这部分继续单独实现。邀请、域名、操作记录及安全策略已增加组织内管理入口；安全策略仅 owner 可修改，admin 只读。桌面无登录个人模式不加载“我的组织”组件。

组织邀请使用说明：平台管理员先在企业控制台创建组织并分配 owner；owner/admin 登录网页账户页，选择“我的组织”，输入员工邮箱、选择允许的邀请角色并生成代码。代码需由管理员自行发送，当前没有自动邮件投递。员工使用相同邮箱账户，在网页或桌面账户页接受邀请。`GET/POST /control/enterprise/organizations/:id/invitations` 和 `DELETE .../invitations/:invitationId` 按当前组织成员身份授权，无需平台 `admin:users`；平台原入口仍保留。生成与撤销同样使用组织事务锁，不能利用待处理邀请覆盖、跨组织 ID 或过期角色越权；接受邀请仍执行现有席位及防重放检查。

组织域名使用说明：有效 owner/admin 在账户页“我的组织”生成域名验证记录，将指定名称和值加入自己的 DNS TXT 配置，等待生效后点击“检查 DNS”。`GET/POST /control/enterprise/organizations/:id/domains`、`POST .../domains/:domainId/verify`、`DELETE .../domains/:domainId` 无需平台权限，仍复用 7 天有效期、跨组织独占、记录更新防竞态和 100 个域名上限。所有域名写入统一先域名锁、再组织锁；创建在锁内授权，验证在 DNS 查询前授权且查询后重新授权，删除在锁内重新授权。角色修改同样使用组织锁，拒绝旧角色在等待期间继续写入。列表按组织与登录账户隔离缓存，权限查询失败隐藏旧记录；移除前确认，TXT 值仅在授权管理界面展示，不进入审计请求体/响应内容。真实 PostgreSQL 测试覆盖跨组织/普通成员/停用拒绝、DNS 期间降级后无验证写入以及 admin 验证/删除；Electron fixture 覆盖生成记录、展示 TXT、验证状态与删除确认。测试 DNS 为受控记录，不代表已验证公网 DNS 或已部署迁移。

组织域名 HTTP 验收补充（2026-10-09）：真实 Nest/JWT 请求使用生产 Controller/Service，测试 owner/admin 列表、创建、验证、删除与成员降级后立即拒绝；跨组织验证在 DNS 查询前拒绝。AuditInterceptor 记录 domainId 和成功/失败，不复制随机挑战 token 或完整 TXT 验证值。HTTP 测试数据库为内存夹具，事务与并发语义另由 PostgreSQL 隔离测试证明。审计异步落库的测试等待实际记录在新查询中可见，不只判断 count；同次查询快照一致性已另行修复，跨次/跨页快照一致性仍未保证。

桌面组织控制面增量（2026-10-09）：桌面本地账户页登录后复用网页的 OrganizationMemberships、OrganizationInvitations、OrganizationDomains、OrganizationAudit、OrganizationPolicy，不建立另一套组织布局。OrganizationControlProvider 仅替换请求连接和查询身份：网页继续使用网页 JWT 连接，桌面通过同源 HttpOnly 本地会话访问 `GET /api/local/account/enterprise/organizations`、组织成员列表/角色修改/移除、邀请生成/撤销、域名生成/验证/移除、审计查询和组织策略 GET/PUT。Local API 使用严格路由/方法/请求字段及审计查询键白名单，不允许通用 URL 代理、平台管理路由、客户端指定别的资源过滤条件或任意 body。业务角色仍由 Control API 当前数据库身份授权，代理不自行授予组织权限，也不上传本地项目源码。

组织安全策略使用说明：`GET /control/enterprise/organizations/:id/policy` 要求有效 owner/admin；`PUT` 要求 owner，并提交完整策略字段及读到的 `expectedUpdatedAt`。所有策略写入（包括平台入口）使用组织事务锁，并推进单调毫秒 updatedAt；组织 owner 写入在锁内再次授权并检查版本，不匹配返回 409 ORGANIZATION_POLICY_CONFLICT，不覆盖其他人的修改。admin 不能通过旧 JWT、直接 API 或桌面代理修改策略。表单复用 EnterprisePolicyCard：终端开关、模型/连接器/Git/网络主机白名单、最低版本和 0–90 天离线宽限。输入逗号时保留分隔符，提交转换为列表；接口不保存 UI 额外字段。保存前确认，草稿绑定最初读取的版本，后台读取不悄悄换成新版本；冲突保留输入，重新读取会确认丢弃未保存修改。

策略更新只影响后续签发与客户端刷新，不会即时替换已签发离线令牌，也不改变 Community 本地核心能力。既有策略签发仍要求有效 Enterprise 订阅；此增量没有新增推送、即时吊销、多组织策略选择、MCP 白名单或更细的安全管理员职责。测试覆盖 owner/admin/member/停用/跨组织授权、DTO、旧版本冲突、真实 PostgreSQL 并发更新仅一个成功及平台修改使旧草稿失效；签名测试证明新策略被桌面验签接受、旧签名令牌保持原内容。桌面真实 renderer+Local API 的隔离 Control fixture 验证保存确认、冲突保留草稿、重新读取、admin 只读和逗号输入；网页 fixture 回归共用表单与确认。不代表已完成生产企业端到端部署。

终端策略执行补强（2026-10-11）：Local API 在创建终端、已有终端输入及调整尺寸时重新读取并验签缓存策略；异步请求体读取结束后再次校验，避免只在打开终端时授权。有效期及离线宽限期按已签发策略允许操作，超过 offlineUntil 后已有会话也返回 403 LOCAL_ENTERPRISE_POLICY_DENIED，不再将输入发送给 PTY。读取输出及主动关闭不受此开关限制，确保用户能检查结果和清理进程；刷新为禁用终端的策略仍统一关闭执行会话。真实 HTTP + LocalTerminalRuntime、替身 PTY 测试覆盖个人免登录启动、有效/宽限期输入、自然过期拒绝、输出/关闭可用及禁用策略刷新清理。尚未增加自然过期时主动停止已运行命令的后台定时器，因此不宣称已运行进程会在到期时自动终止，也不将终端开关视为本机所有 Shell/Agent 的系统级沙箱。

Git 主机策略补强（2026-10-11）：工作区变更锁内统一解析同步远程、校验策略并执行。显式选择远程优先；默认推送按 branch.pushRemote、remote.pushDefault、branch.remote、origin 解析，拉取使用 branch.remote 或 origin；fetch-all 校验所有已配置远程。推送使用 `git remote get-url --push --all` 检查独立 pushurl、多个推送地址及 Git 展开的 URL 重写，执行显式使用同一远程，不再让裸 `git push` 换用另一个默认远程。对应配置及 URL 解析语义见 [Git config 文档](https://git-scm.com/docs/git-config) 和 [Git remote 文档](https://git-scm.com/docs/git-remote)。企业模式下未知远程、远程组及无法确认的自定义传输 helper 拒绝执行；当前要求配置命名远程，不支持直接在 branch.pushRemote 配 URL。`.` 按本地仓库策略处理，参数不接受以 `-` 开头的远程名。匿名个人模式不启用主机白名单。隔离仓库测试覆盖配置优先级、pushurl/重写绕过、fetch-all 和 HTTP 拒绝；两个本地裸仓库的实际推送证明显式选择不受 branch.pushRemote 干扰。Local API/Git 历史回归 27 项通过，新增实际推送后专项 5 项通过。此校验不是操作系统网络沙箱，不覆盖 Git hooks、自定义 SSH 命令、HTTP 重定向、DNS 变化或外部进程直接修改仓库配置，企业完整外发控制仍未标记完成。

桌面登录安全边界：远程 accessToken 加密存储并仅由 Local API 加入 Authorization；renderer 只收到用户摘要及非授权性的 controlSessionId。组织请求需额外带当前会话标识，同时仍受本地启动令牌/HttpOnly cookie 和 Origin 检查保护。缓存身份包括服务器、用户 ID、随机登录会话，登录后即使用户名相同也不会复用上个会话；退出/身份变化取消并移除旧查询。Local API 在转发前和返回后校验会话，旧响应不能交给新账户；旧 401 不能清除新登录凭据。已发往远程的变更无法通过取消 UI 请求回滚，仍由后端权限/事务约束决定结果。登录凭据绑定登录时服务地址，改变服务地址需重新登录，不会把旧 bearer 发给新服务器；旧版未保存服务绑定的登录也需重新登录，本地项目、文件和许可证保留。

未登录个人模式不加载组织组件、不请求企业服务器；远程 401/旧会话 409 会刷新桌面账户状态并清理旧组织界面，个人本地能力不被关闭。接受邀请成功后自动刷新组织列表。验证新增 `node --test apps/desktop/test/organization-control-proxy.test.cjs apps/desktop/test/local-api.test.cjs apps/desktop/test/license-verifier.test.cjs`，覆盖代理白名单、服务器绑定、会话轮换、旧响应丢弃、旧 401 保留新会话、远程错误秘密排除及本地核心回归。先运行 `node apps/desktop/scripts/prepare-renderer.cjs`，再运行 `node_modules/.bin/electron apps/desktop/scripts/smoke-desktop-organizations.cjs`；此测试使用真正 desktop-local renderer、生产 preload 和 Local API，并使用隔离的 Control HTTP fixture，覆盖无需登录、成员角色确认、邀请、接受邀请后刷新、域名、审计、账户切换与登录过期。真实 Control 后端角色/并发语义仍由 Nest/JWT 与 PostgreSQL 测试分别证明；尚未替代公网部署、企业 SSO 和生产端到端验收。

组织审计增量：上述变更接口使用 `@Audit` 元数据进入现有全局 AuditInterceptor，action 使用 `organization.*`，resourceType 使用 `organization`。路由中的 `:id` 作为组织 ID；成员、邀请和域名子资源 ID 通过显式 targetParams 白名单保存。接受邀请成功后从已确认结果取得组织 ID；新增成员/邀请的目标 ID 和生效角色使用 resultFields 白名单，只取返回值中的指定标量字段，不保存整个返回对象。敏感接口统一省略请求体，失败也不复制可能回显输入的异常文本。URL 查询部分不写入审计，深层请求内容截断而不是原样返回；IP 使用 Express 的 req.ip/连接地址，需由部署显式配置可信代理，不直接信任调用者的 X-Forwarded-For。

平台“审计日志”仍需要已有 `audit:read` 权限。组织 owner/admin 另可从账户页“我的组织”查看本组织操作记录，无需平台审计权限。`GET /control/enterprise/organizations/:id/audit` 每次检查数据库中有效管理成员身份，查询固定 `resourceId=:id`、`resourceType=organization` 和 `action=organization.*`；操作者 OR 条件、关键词、动作、结果及时间筛选不能替换这些隔离条件。页码 1–100000、每页 1–100，使用 createdAt/id 倒序；只返回展示必要字段，不返回 IP、请求路径或内部 searchText。组织 owner/admin **不会**因此获得平台审计或其他组织数据访问权。界面支持筛选、分页、详情和手动刷新；权限拒绝不重试、不继续显示旧表格，普通成员不挂载该组件。当前记录包括进入业务链路后的权限拒绝和 DTO 校验失败；登录/平台 Guard 在拦截器之前拒绝的请求尚不覆盖。当前组织创建、成员、邀请、域名与策略的服务调用会记录事务成功；其他控制面 Service 直接调用不由拦截器自动记录。

可靠性边界：非组织链路的部分操作及失败事件仍沿用 AuditService 的异步非阻断落库，也没有持久化重试队列。2026-10-12 已将当前组织控制面的 11 类动作（组织创建、成员新增/角色修改/移除、安全策略更新、邀请生成/撤销/接受、域名生成/验证/移除）的成功记录纳入同一 PostgreSQL 事务，并记录白名单前后快照（详见下段）。这不证明全平台控制面或失败事件已满足事务一致性及合规级完整留痕。其他操作的事务审计/outbox、保留策略、防篡改导出、独立只读审计员角色及完整拒绝事件仍需继续推进；基础审计和组织范围查看不替代这些要求。

事务审计增量（2026-10-12）：网页组织管理与平台管理的五个成员写入路由通过真实认证上下文传递 actor、服务端 IP、method 与去查询串的 path；平台管理员身份仅用于留痕，不误作组织成员权限判断。三个服务方法在既有组织锁事务内写入 AuditLog，失败不捕获，成员写入与记录一起提交或回滚。before/after 只保留成员 id、organizationId、userId、role、status；新增 before=null、移除 after=null，修改前立即复制快照防止引用被覆盖，不记录邮箱、邀请令牌、密码或请求正文。成功拦截器通过 transactionalSuccess 标记跳过重复记录，失败仍保留脱敏的 best-effort 记录；因此数据库故障时失败事件也可能丢失，此处没有宣称失败记录的可靠投递或 outbox 已完成。

验证：真实 PostgreSQL 随机隔离 schema 中用数据库 CHECK 约束分别拒绝三个动作的审计写入，证实新增、改角色、删除均回滚，成员和成功记录数量保持不变；正常改角色和移除的前后快照及平台身份正确。现有席位并发、单次邀请、域名归属、最后所有者保护与审计 RepeatableRead 快照回归同时执行。真实 JWT HTTP 回归另外检查成功记录唯一、认证 actor 和服务端 IP；单元检查事务成功不重复、失败仍记录、查询串敏感信息剥离及五个路由元数据。无需新增迁移；测试只创建/清理隔离 schema，不修改现有业务数据或重启用户 API/客户端。项目角色/职责分离及全控制面的可靠审计大项仍保持未完成。

审计读取一致性增量（2026-10-09）：组织审计与平台审计的列表/总数使用 PostgreSQL RepeatableRead 事务，平台动作/资源过滤选项同样使用一致快照。列表排序统一为 createdAt DESC、id DESC，避免时间戳相同记录没有明确顺序。组织查询仍在事务中先检查有效 owner/admin，固定组织/资源/动作范围；该快照不阻塞后续权限修改，也不承诺撤权会中断已经开始的读取。数据库测试使用生产查询方法，在 findMany 已返回后由独立连接提交匹配的新记录，再执行 count：修复后的同次响应保留 1 条/总数 1，后续刷新返回 2 条/总数 2；强制 ReadCommitted 的负对照重现 1 条/总数 2，证明测试确实覆盖原竞态。此增量不改变异步写入、跨页面新增导致 offset 翻页漂移、导出一致快照或审计持久化可靠性边界；这些仍需后续实现。

安全策略事务审计增量（2026-10-12）：组织 owner 与平台管理员的两个策略 PUT 路由复用成员操作的真实认证 actor/context 和 transactionalSuccess 标记，不重复写成功记录。`updatePolicy` 在组织锁内重新检查 owner 身份与草稿版本、规范化白名单、复制 before，再保存策略及 AuditLog，任一写入失败整体回滚。平台操作保持独立平台权限，不要求组织成员身份；组织存在性检查也移到当前事务连接内，避免持锁时额外占用连接。快照只包含 terminalEnabled、模型/连接器/Git/网络白名单、minimumClientVersion、offlineDays、ISO updatedAt，数组立即复制，不引用可变返回对象，不存请求额外字段、expectedUpdatedAt、密钥或令牌。缺失策略由平台 upsert 恢复时 before=null；owner 对缺失/过期版本仍返回冲突。

最新可靠性口径：上述 11 类组织服务操作即使直接由服务层调用也会写事务成功记录；没有传 HTTP 上下文时用系统身份或已知 actorId 留痕，不虚构请求 IP。接受邀请必以实际用户 id 为 actor，不允许审计上下文覆盖该身份。其他控制面服务调用仍不由全局拦截器自动留痕。审计记录读取界面仍由网页/桌面共享组织审计组件展示；没有新增与个人本地模式无关的远程依赖。失败事件仍是异步尽力记录，完整拒绝事件、outbox、其他控制面写入及合规保留能力尚未完成。

策略验证：真实 PostgreSQL 隔离测试证实同版本并发更新仅一份成功且仅一条成功审计，快照版本对应真实前后值；用数据库约束拒绝策略审计后，owner/平台更新的策略内容与 updatedAt 均保持不变，平台恢复缺失策略也不会遗留新策略行。正常恢复记录 before=null。真实 JWT HTTP 回归检查成功记录不重复、actor 与前后值；单元检查规范化后的快照、敏感扩展字段排除、修改返回数组不会改写快照、两个路由事务标记和平台授权身份分离。`RUN_ENTERPRISE_DB_TESTS=1 node --test apps/api/test/enterprise-control-integration.test.cjs apps/api/test/enterprise-policy-service.test.cjs apps/api/test/organization-audit.test.cjs` 的 20 项全部通过（无跳过）。无需新增数据库迁移，不重启用户服务或替换安装包。

审计验证：`node --test apps/api/test/organization-audit.test.cjs apps/api/test/enterprise-policy-service.test.cjs` 检查所有组织变更路由的标注、真实 HTTP 成功/失败记录、目标字段、响应/请求/查询/异常文本中的秘密排除及深层脱敏，并验证组织查询固定范围、当前角色授权、分页/时间参数和非法过滤字段拒绝。PostgreSQL 隔离测试使用生产 AuditInterceptor/AuditService，验证成功和失败真实落库、现有检索接口及 invitation token 不进入 detail/searchText；额外插入其他组织、错误资源类型和非组织动作的诱饵记录，证明组织查询不返回它们，验证实际分页与筛选。Electron UI fixture 验证分页、关键词重置到第一页、详情、管理权限失效后隐藏缓存和普通成员不请求记录；不替代真实后端权限测试。无需变更用户业务表或新增数据库迁移。

邀请事务审计增量（2026-10-12）：组织/平台生成与撤销邀请的四个路由，以及接受邀请路由，均通过真实认证上下文写事务成功记录，拦截器跳过重复成功日志。生成时记录新邀请和同邮箱待处理旧邀请的前后状态，重发所撤销的旧邀请不能先于审计提交；撤销时记录 pending→revoked。接受时在同一组织锁事务内提交邀请 accepted、成员新增/重新激活及审计，快照同时包含邀请与成员，已有成员角色保留且记录实际最终角色。邀请快照只含 id、organizationId、role、status、expiresAt、invitedById、acceptedById、acceptedAt，明确排除邮箱、原始代码及 tokenHash；日期转字符串、对象立即复制，后续行/返回值修改不会改变历史快照。HTTP 原始正文、响应 token、查询参数和错误中的敏感值均不进入审计。

邀请验证：真实 PostgreSQL 隔离 schema 中分别拒绝三个动作的 AuditLog INSERT，验证重发旧邀请状态/代码不变、撤销仍为 pending、接受不会遗留 accepted 邀请或成员，成功记录数量不变。正常重发记录旧邀请 revoked 与新邀请 pending；两次并发接受同一代码仅一次成功、一条成功审计，旧代码/重放拒绝。真实 JWT HTTP 验证生成、撤销、接受三类成功记录不重复，接受接口要求认证与匹配邮箱、成功记录归属实际组织/用户；另外检查已有成员重新激活时保留 admin 角色及快照不可变。该增量验收时连同成员/策略/审计/桌面控制代理的 24 项测试全部通过、无跳过；API 构建通过，git diff --check 通过。没有修改用户业务数据、重启用户服务、替换客户端或新增迁移。组织创建、域名变更已由下述增量补齐；outbox、完整拒绝事件和合规留存仍待继续。

组织创建/域名事务审计增量（2026-10-12）：创建组织、嵌套默认策略与 AuditLog 在同一事务提交，失败不留下组织或策略孤儿；快照包含组织 id/name/slug/seatLimit/verifiedDomains 与默认安全策略白名单，不复制请求扩展字段。域名生成/刷新挑战、验证与移除同时记录域名快照和组织 verifiedDomains 前后值，快照只含 id、organizationId、domain、expiresAt、verifiedAt，不保存 token 或 DNS recordValue。平台与组织入口沿用既有不同权限边界并传递实际认证身份，成功拦截器不再重复记录。域名写入统一 domain→organization 锁顺序；DNS 在事务外执行，随后持锁重新授权、读取域名/组织当前状态并核对挑战，删除也在锁后重读。已验证域名的重复生成/验证不旋转挑战或重复 DNS，但仍在持锁事务内写成功记录；若审计不可用，同样返回失败而不是无记录地成功。

本轮验证：数据库 CHECK 故障注入确认组织创建连同默认策略整体回滚，域名首次生成及重新生成挑战均不遗留写入，验证失败不修改 verifiedAt/verifiedDomains，删除失败保留完整域名记录与组织列表。正常验证/删除快照前后正确，重复已验证操作不重复 DNS 且每次仅一条成功记录，日志不含挑战代码/recordValue。真实 JWT HTTP 检查组织成员的域名生成、验证、重复验证及删除快照、身份与记录数量；单元覆盖平台组织/域名上下文、所有 19 个写入路由事务标记和创建快照不可变。`RUN_ENTERPRISE_DB_TESTS=1 node --test apps/api/test/enterprise-control-integration.test.cjs apps/api/test/enterprise-policy-service.test.cjs apps/api/test/organization-audit.test.cjs apps/desktop/test/organization-control-proxy.test.cjs` 的 26 项全部通过，无跳过，API 构建与 git diff --check 通过。测试只使用随机隔离 schema，未修改业务数据、重启用户服务、替换安装包或新增迁移。上述不等同于 outbox、完整拒绝留痕、防篡改归档或整个 roadmap 已完成。

只读审计员增量（2026-10-12）：组织成员/邀请角色增加 auditor。`organizationAudit` 独立检查当前 active owner/admin/auditor，而所有管理链路仍检查 owner/admin，策略编辑仍仅 owner；平台全局审计与项目角色不因组织身份而改变。owner 可将成员改为 auditor 或邀请 auditor，平台添加成员也支持 auditor；admin 不可授予该角色、管理审计员成员或撤销/重发非 member 邀请，重发检查使用非 member 条件，防止把 auditor 邀请静默降成 member。最后所有者降为 auditor 仍被拒绝。接受 auditor 邀请后实际成员角色为 auditor；已有成员接受邀请仍保留原角色，不隐式提权。角色数据库列本来为 String，本次只更新注释，无数据迁移。

共享界面中审计员只挂载 OrganizationAudit，不请求成员、邀请、域名或管理策略；owner/admin 原有布局顺序保持不变，角色标签由同一 organization-roles 模块维护。桌面白名单代理同步接受 auditor 的角色修改/邀请参数，但仍由远端数据库身份授权，不把前端隐藏按钮当权限边界。真实 PostgreSQL 与 JWT HTTP 验证审计员同组织只读、跨组织拒绝、全部管理读写拒绝、admin 无法改动审计员及其邀请、降级和停用后拒绝，旧 JWT 角色声明不能保留权限。两端实际 UI 回归检查仅审计内容、没有管理请求、刷新收到 403 后缓存行消失，桌面同时覆盖匿名个人模式与账户切换隔离。此增量不替代发布/运维/项目角色分离，也未完成 outbox 或全平台审计角色。

本机客户端更新（2026-10-12，用户明确要求）：桌面版本升为 0.1.1，npm lockfile 同步。安装前文件类型/编码/预览与组织权限/审计/桌面代理共 44 项测试全部通过，API、网页与桌面 renderer 构建通过；两端组织 UI 已验证审计员只读与撤权缓存处理。macOS ARM64 重新打包，检查 ASAR 中 Local API、共享 file-preview/file-types/file-text 和 renderer/index 与当前源码构建一致，嵌入版本 0.1.1；本机使用 ad-hoc 签名并通过 codesign --verify --deep --strict，不宣称 Developer ID 公证或公开分发已完成。

已安装 `/Applications/Code Studio.app` 并启动，旧版保留 `/Applications/Code Studio.backup-0.1.0-20261012-173240.app`，没有删除本地数据目录、项目或索引缓存。新旧 ASAR SHA-256 分别为 `72b6bfbe12f882e93f12b0820cb82fd8edbbc10699b77529c565171854ae2ee7` 与 `e328f7b9b6ff1305fed3ccc4230d1692dcce192d72377a206c0c8fb7b34215c6`。启动日志证实 api-ready/window-ready，本机健康检查确认已安装进程的 loopback Local API ready；这只证明窗口启动，不代表大型项目语言索引已完成。本次未重启用户远程 API，组织服务端代码的最新能力需部署/重启对应 API 后才能在既有服务实例上生效；本地文件识别修复已随新版客户端安装。

验证：`npm run build --workspace apps/api`；`node --test apps/api/test/enterprise-policy-service.test.cjs` 覆盖管理权限、跨组织、角色升级、停用、owner 保护及带真实 JWT 校验的 HTTP 路由（测试专用身份 Strategy，业务授权仍调用实际 Service）；`RUN_ENTERPRISE_DB_TESTS=1 node --test apps/api/test/enterprise-control-integration.test.cjs` 在隔离 PostgreSQL schema 中验证并发降级保留 owner，同时回归席位、邀请和域名机制。网页账户页交互测试使用 `node_modules/.bin/electron apps/desktop/scripts/smoke-organization-roles.cjs`，需先构建 Web；UI 使用隔离 HTTP fixture，不连接用户服务器，不能替代上述真实数据库权限测试。

## 6. 跨阶段质量门槛

- Windows x64 与 macOS arm64/x64 构建；正式发布启用签名和 macOS notarization。
- 本地 HTTP 只绑定 loopback，启动令牌不写日志，不接受任意 Origin。
- 本地路径、源码和密钥默认不上传；任何同步都必须显式开启并可审计。
- 数据库迁移可回滚或安全前滚；升级失败不能损坏用户项目。
- Agent、终端、预览和 LSP 子进程都有资源限制与完整进程树清理。
- 每阶段同时提供自动化测试、故障恢复测试和对应用户文档。

## 7. 与现有文档的关系

2026-10-10 编辑器菜单补齐进度：中文菜单、重复菜单清理、网页 F12 冲突、文本跨文件重命名确认/草稿/全部保存及磁盘版本保护已落地，并加入真实 Electron 交互回归。涉及文件改名的 Java 类型重构、全工作区事务撤销、真实大型 Java 项目压力验收与剪贴板权限验收仍为待办；资源重构当前明确报错且不应用部分修改。详细边界见 `editor-code-intelligence.md` 第 K 节。

- [`editor-code-intelligence.md`](./editor-code-intelligence.md) 继续描述浏览器/远程工作区能力；Phase 5 描述桌面本地 LSP，两者共享协议而不共享运行实例。
- [`agent-worker-deployment.md`](./agent-worker-deployment.md) 仅适用于远程执行；桌面本地 Agent 不进入 BullMQ。
- [`mcp-agent-design.md`](./mcp-agent-design.md) 的审批与工具契约可复用；本地工具由 Local API 执行并遵守企业策略。

## 8. 快速索引层实施计划（2026-10-10，分阶段实施）

本次 macOS arm64 客户端已打包并安装到 `/Applications/Code Studio.app`，旧安装保留为 `/Applications/Code Studio.app.backup-20261010-183329`。构建产物与安装后的 app.asar SHA-256 一致。真实启动日志记录：窗口 ready-to-show 414 ms；已存在工作区缓存的 site-tpl-manage，Java 服务 ServiceReady 12,871 ms，JDT 工作区导入 168 ms。它们是单次观测，不是耗时上限或首次全量索引基准；初始化阶段包含 JVM/OSGi、插件及状态恢复，不能把 12.9 秒全部解释为项目索引。

目标：在 JDT 后台恢复期间，优先提供文件定位、类型/成员搜索、当前文件大纲与经过有效性校验的历史跳转。不是从零替代 Java 编译器，也不承诺把首次完整语义索引压缩为毫秒。底部语言服务状态提示已发布；快速索引基础与两端搜索接入进度见 8.8～8.10，不能视为全部阶段完成或已经更新安装包。

### 8.1 已有能力与具体瓶颈

- `WorkspaceIndex` 已有磁盘文件快照、文件变更扫描、按查询持久化导航结果与有界热点 LRU；这不是完整符号表或引用图。
- `/symbols` 仍调用 `buildSourceIndex` 逐次读取源码，再用正则找声明。它受 500 文件/8 MiB 总量/256 KiB 单文件限制，也不能正确覆盖完整 Java 方法声明。快速符号搜索应替代这条链路，而不是提高预加载上限。
- 当前导航缓存以项目文件快照 revision 整体失效，改动一个文件会影响其他文件的历史结果；JAR/JDK 虚拟源码引用只属于活跃会话，当前不能跨进程恢复。
- 文件树快照上限为 10,000 项。快速索引覆盖率必须单独记录，不能将树上限以内的扫描完成当成全项目索引完成。

### 8.2 分层与查询规则

| 层 | 内容与实现 | 能力边界 |
| --- | --- | --- |
| 文件层 | 保留现有快照快速恢复；目录/文件变更可增量更新 | 文件定位不等待 JDT；树与索引覆盖上限分开 |
| 语法符号层 | 本地后台线程解析 Java 声明、包、imports、成员及显式继承关系；独立 SQLite 索引库，按需查询 | 提供搜索/大纲/候选；语法节点及 extends 文本不是已解析类型关系 |
| 精确语义层 | JDT 的定义、实现、引用和类型分析；保存带有效性证据的热点结果 | 重载、泛型、静态导入、Lombok、依赖及安全重构由 JDT 校验 |

路由顺序：已校验的语义缓存 → 精确语言服务；语法层服务符号搜索及显式候选展示。不能因候选只剩一个就默认它是正确的 Java 方法/实现，也不能使用正则同名匹配冒充精确 F12。历史结果失效且 JDT 未就绪时，底部显示加载状态，可查看候选，不执行不可靠的自动跳转；重构永远不能使用模糊索引结果。

### 8.3 存储、解析与后台调度

建议独立 `fast-index.sqlite3`，不在账户/许可证业务数据库增加高频索引写入。基础表：projects（根目录指纹、schema/parser 版本、环境指纹和 generation）、files（项目/相对路径、stat、内容哈希、解析状态）、symbols（所属文件、包/模块、名称、种类、容器及 Range）、imports、semantic_cache（查询、源/目标哈希、环境指纹、验证代次和结果）。继承与引用分开保存语法候选和经 JDT 确认的边，不混为同一种关系。不保存完整源码、密钥、未保存草稿；项目索引不上传。

Java 解析优先做 Tree-sitter + WASM 可行性验证，避免为了符号搜索启动第二个 JVM，并降低 Electron 原生 ABI 打包维护成本。Tree-sitter 提供增量语法解析，不自带 Java 完整类型解析。需验证 Java grammar 对 record、嵌套类、注解、泛型与编辑中不完整代码的覆盖；采用固定 parser/grammar 版本，升级时重建相关索引。Tree-sitter 字节位置必须转换为 Monaco/LSP UTF-16 行列位置，测试中文、emoji 与 CRLF，不直接复制 byte offset。

SQLite 采用 WAL、短事务和单写入者；名称/包/路径建立 B-tree 索引。FTS5 可用于分词与前缀搜索，但驼峰缩写、任意子串及模糊匹配需独立规范化键/候选算法，不宣称 FTS 自动支持全部 IDE 搜索语义。开发 Node 的内存库已验证 FTS5 可用，正式接入前还需验证打包后的 Electron runtime 与三种目标平台。数据库与解析运行在本地后台线程，不占用 Electron 主线程或 renderer，也不引入远程任务 Worker。

调度优先级：用户当前文件/显式查询 → 当前模块 → 其他模块。采用有界任务队列、去重、取消、分批提交及线程让出；初版 1 个写入线程，解析并发先限制 1–2 路并依据测量调整。只读/解析待处理文件，不给每个文件创建 Monaco 模型；热点按条数与字节同时限额。源码根来自项目配置和后续 JDT 校验，默认跳过构建输出，但显式配置的 generated-sources 不能被 blanket target 排除误伤。

### 8.4 增量与正确性

打开时读取项目目录、少量热点和索引元信息，不把整个 SQLite 或全部引用装入内存。文件保存/新增/删除立即投递差量更新；文件监视事件合并去抖，保留低频扫描兜底。变更文件按需计算内容哈希，未变文件不重复解析；分支切换取消旧 generation 工作，过期写入和响应不能覆盖新状态。删除符号与相关边在短事务内提交；崩溃后用 dirty 状态恢复，坏缓存可重建，不阻止项目打开。

未保存编辑仅使用内存 overlay，并以模型版本拒绝过期结果，不污染持久化索引。语法符号只需文件级失效；语义缓存除源/目标哈希外，还需 POM/模块、依赖/JAR、项目 JDK、源码根、Lombok/处理器及解析工具版本指纹。跨模块引用依赖图不完整时必须保守失效相关项目语义缓存，不能只验证源文件后继续返回旧引用。只有依赖图有充分覆盖与测试后，才启用精细的反向依赖失效。

JAR/JDK 缓存另做后续阶段：用依赖文件哈希/JDK 版本和类/成员标识生成可恢复引用，进入 Local API 受控路径校验，并区分源码包与反编译结果；不能持久化活跃 JDT 会话的虚拟路径后直接复用。

### 8.5 分阶段交付与验收

1. **先建立性能基线与兼容性 spike。** 用真实大型 Java 项目记录文件数、代码体积、模块/依赖、冷/热缓存状态，测窗口显示、文件树可用、首次搜索、索引就绪、峰值内存、CPU 与 UI 卡顿；验证打包后 WASM/parser、FTS5 与 UTF-16 坐标。分开 JVM 启动与索引耗时。
2. **完成持久化符号搜索和当前文件大纲。** 新增 FastIndex/后台线程/独立库，接入 `/symbols`，冷打开优先当前文件，热打开直接查已有符号，显示真实覆盖率，避免逐查询源码扫描。旧读取接口不扩展为全量预加载。
3. **完成事件驱动增量刷新和缓存有效性。** 覆盖保存、文件/目录新增删除、外部修改、分支切换、POM/JAR/JDK 变化、未保存 overlay、崩溃和版本升级；不完整依赖图采用保守失效。
4. **增强精确导航缓存及依赖源码恢复。** JDT 后台校验后补充已确认引用关系，优先热点，独立验收过期行号、同名类、重载、泛型、Lombok 与跨模块场景。

初始验收目标（不是当前已达到的承诺）：约定机器和测试项目规模下，热缓存符号搜索 P95 ≤100 ms，已有索引的打开不等待 JVM/全库解析，新增/修改文件尽快可检索且结果版本一致；记录索引期间输入/滚动延迟与主线程长任务，不以一次平均耗时替代流畅度验证。资源超限、遗漏和索引尚未完成需明确展示，不能静默返回“完整”结果。首轮 benchmark 完成后再设定大项目冷建索引的总耗时和资源预算。

参考：[Tree-sitter 增量语法解析](https://tree-sitter.github.io/tree-sitter/)、[SQLite FTS5](https://www.sqlite.org/fts5.html)、[SQLite WAL](https://www.sqlite.org/wal.html)。以上为实施设计，不代表快速索引层已交付。

### 8.6 真实工作区基线与覆盖率修正（2026-10-10）

新增可复现只读基准 `apps/desktop/scripts/benchmark-real-workspace.cjs`。执行命令：`node apps/desktop/scripts/benchmark-real-workspace.cjs /absolute/project/path 20`。仅启动独立 loopback Local API，应用缓存写入临时目录，完成后关闭并清理，不修改项目，不输出源码与项目绝对路径。记录机器/runtime、项目快照规模、接口延迟、RSS、CPU 和 Node 事件循环延迟；缓存重开测试复用临时 SQLite，但 OS 缓存未受控，不能叫“冷磁盘”。

本机 Apple M2 / 8 逻辑核 / 24 GiB / Node 22.22.1，对 site-tpl-manage 的一次结果：文件树 2,512 项，1,646 个 Java 文件，Java 源码 5,952,400 bytes，11 个 pom.xml；树未截断，旧源码读取层实际只读 500 文件 / 3,024,345 bytes，源码覆盖已截断。

| 测量项 | 本次结果 |
| --- | --- |
| 空应用缓存首次文件树请求 | 150.882 ms |
| 首次有限源码读取 | 178.373 ms |
| 关闭 API 后重开已持久化文件树 | 12.505 ms |
| 文件树请求，20 次 median / P95 | 5.233 / 7.736 ms |
| `Service` 符号搜索，20 次 median / P95 | 85.879 / 89.847 ms |
| 有限源码读取，20 次 median / P95 | 112.930 / 118.612 ms |
| 同进程峰值 RSS / 基线 RSS | 312,639,488 / 69,222,400 bytes |
| 同进程事件循环延迟 P95 / max | 25.035 / 31.539 ms |

这些接口计时包含 HTTP/JSON；服务与基准客户端处于同一 Node 进程，RSS 包括返回源码和客户端 JSON 解码，不能解释为桌面 IDE 空闲内存或后台索引独立开销。没有测 Electron 输入/滚动延迟、窗口显示、JDT、完整语义索引或解析器，也没有完成 Tree-sitter/WASM 兼容性 spike。符号搜索低于 100 ms 但遗漏其他源码，因此**不满足完整项目快速索引验收**。

基准确认的正确性问题已修正：`/symbols` 原来只在返回 200 匹配时声明 truncated，遗漏了底层 500 文件/字节上限。现将文件树和源码读取截断传播到结果，返回 sourceTruncated/sourceFiles/sourceBytes/limits；搜索窗口显示覆盖范围或结果截断提示，并拒绝被取消请求覆盖新查询结果。新增回归：505 文件工作区搜索不存在的符号，即使返回零匹配也必须说明范围不完整。此修正未提高源码读取上限，也不冒充持久化符号层。

下一步仍是固定解析器/grammar 的兼容性 spike，再实现后台线程与独立持久化符号库；本次源码与测试更新尚未重新安装客户端，前一批安装版本记录见第 9 节。

### 8.7 Java WASM / 后台线程 / SQLite 兼容性原型（2026-10-10）

新增共享 `packages/code-intelligence/java-syntax-index.cjs`，固定 `web-tree-sitter@0.27.1` 与 `tree-sitter-java@0.23.5`；仅加载 grammar 的 WASM，不加载其原生 Node binding、不启动第二个 JVM。提取类、接口、record、枚举、注解、构造器、方法、重载声明、字段与 record 参数，保留容器、package/imports、声明范围和名称范围；显式继承子句标为 `resolved: false`，整体结果标为 `semantic: false`，不作为精确引用或安全重构证据。

坐标契约已实际验证：固定版本的 web-tree-sitter 字符串输入返回 UTF-16 index/column；这与底层 C 的 UTF-8 byte offset 不同。通过 `source.slice(startIndex, endIndex) === name.text` 校验名称位置，并从 UTF-16 index 计算行列。测试覆盖中文标识符、前置 emoji、CRLF；不能再把 JS binding 的 index 当 UTF-8 字节进行二次转换。解析树与 parser 显式释放，不保留全部项目语法树。

新增只读 `apps/desktop/scripts/spike-java-fast-index.cjs`：一个后台线程递归扫描 Java 源码，无 500 文件或 10,000 树项的项目总量上限；逐文件解析并用短事务写入独立临时 SQLite WAL + FTS5，关闭/重开数据库再查询。单文件保护预算为 1 MiB、100,000 访问节点、10,000 符号及 2 秒解析/遍历时间；错误、截断与拒绝文件有独立统计，不静默声称覆盖完整。原型默认略过 `.git/node_modules/target/build/dist/.gradle/.idea` 和符号链接，显式 generated-sources 源根支持仍需生产实现补齐。

运行：`node apps/desktop/scripts/spike-java-fast-index.cjs /absolute/project/path`；Electron 开发 runtime 验证：`node_modules/.bin/electron apps/desktop/scripts/spike-java-fast-index.cjs /absolute/project/path`。使用自建临时目录保存索引，完成后终止线程并清理，不修改项目和本机安装客户端。

site-tpl-manage / Apple M2 / macOS arm64 的一次结果，两种 runtime 都发现并处理 1,646 Java 文件 / 5,952,400 bytes，提取 15,420 符号；语法错误、截断、拒绝文件、不可读目录均为 0：

| 项目 | Node 22.22.1 | Electron 37.10.3 / Node 22.21.1 |
| --- | --- | --- |
| 解析器初始化 | 17.558 ms | 19.083 ms |
| 扫描、解析与 SQLite 建库总计 | 2,939.815 ms | 2,530.031 ms |
| 数据库关闭后重开 | 0.136 ms | 0.112 ms |
| 单文件读取+解析+插入 P95 | 5.834 ms | 5.219 ms |
| `Service*` FTS 前缀查询 P95，30 次 / 45 结果 | 0.089 ms | 0.081 ms |
| 主线程事件循环延迟 P95 / max | 11.067 / 11.887 ms | 12.583 / 12.632 ms |

这是实际项目原型结果，不是完整 IDE 打开时间或语义索引时间；查询不包含 HTTP/renderer，也不支持任意子串/驼峰缩写匹配。开发 Electron 后台线程已验证 WASM 和 FTS5，尚未验证最终 asar 包、Windows/macOS x64 或输入/滚动延迟；不能用本结果宣称所有目标平台已兼容。3 项解析器回归和基准统计测试通过，包含重载、嵌套、record、Unicode 坐标、不完整语法与资源预算。

尚未接入产品 `/symbols`、持久化重建/版本迁移、增量事件、草稿 overlay、候选匹配/排序及底部覆盖率状态；它们仍是第 8.5 节后续交付，当前产品的旧读取上限没有被直接取消。项目生产依赖安全审计另发现待处理项（14 个报告项，含 1 critical）；没有执行跨项目 `npm audit fix` 或将依赖安全整改宣称完成。

解析器使用方式参考：[Tree-sitter 官方 WASM 说明](https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/README.md)，坐标结论以本次固定版本测试为准。

### 8.8 正式索引存储、增量扫描与后台线程基础（2026-10-10）

第 8.7 节之后新增共享实现：`fast-index-store.cjs`、`java-fast-index.cjs`、`fast-index-worker.cjs`、`fast-index-client.cjs`。目前是可供 Local API 集成的正式基础模块，尚未切换产品 `/symbols` 请求链路；不能将模块完成等同于已经发布客户端快速搜索。

- 独立 SQLite WAL 数据库保存文件 stamp/SHA-256、package/imports、未解析继承子句、符号种类/容器/UTF-16 Range；不保存源码正文。带 application_id 和 root 归属检查，拒绝误用业务数据库或另一工作区数据库。parser/extractor 版本变化原子清理本索引派生数据；未来 schema 版本拒绝打开，不擅自降级删除。
- 符号使用 FTS5 trigram 子串候选与 B-tree 驼峰缩写键，短查询明确走数据库扫描，统一排序为精确名称→名称前缀→缩写前缀→子串。所有查询参数化，返回最多 200（内部支持上限 500）并提示结果截断。提供按文件查询大纲，不一次加载全部项目符号到内存。
- 每次扫描分 generation，按文件短事务原子替换符号及 FTS 记录；未变 stat 跳过读取，stat 变化但 SHA-256 不变则仅更新元信息，删除文件移除旧符号。旧 generation 写入拒绝，连续刷新取消过时扫描；扫描未完成/不可读目录/单文件拒绝或截断不标记覆盖完整。
- 重开保留已有符号但先标为 `needs-validation`，可以查询候选，后台重新检查文件；不会把“数据库上次已完成”当作“这次文件仍未变化”。不可读目录不构成删除证据，保守保留旧条目并报告部分覆盖。
- 递归扫描不受 500 源码文件或 10,000 文件树项总量限制；沿用默认构建目录过滤，显式生成源根配置仍待接入。跳过符号链接并检查目录/文件实际路径，文件读取缓冲限定 1 MiB+1，防止增长中的文件突破内存预算；单文件解析预算沿用第 8.7 节。
- 一个 Node 后台线程执行扫描/解析/SQLite，线程内复用 parser，语法树逐文件释放；不创建 Monaco 模型或启动第二个 JVM。IPC 请求最多 64 个，初始化和请求有超时，关闭最多等待 5 秒后终止线程，已提交 SQLite 文件事务保留供下次校验。强制刷新可取消正在扫描的旧 generation。

验证：`fast-index-store.test.cjs`、`java-fast-index.test.cjs`、`fast-index-client.test.cjs`、`java-syntax-index.test.cjs`。覆盖 505 文件完整索引与缓存重开零重解析、内容更新/删除/同哈希复用、FTS 原子替换、子串/缩写/中文短查询、过时 generation、版本失效、失败事务回滚、外部符号链接、超大/二进制文件、扫描取消、线程初始化失败与退出、数据库归属保护。

新增真实基准 `scripts/benchmark-fast-index.cjs`，使用上述正式模块，不复用原型玩具数据库。site-tpl-manage 单次观测：

| 测量 | Node 22.22.1 | Electron 37.10.3 / Node 22.21.1 |
| --- | --- | --- |
| 首次完整扫描+解析+正式 SQLite 建库 | 3,954.520 ms | 3,967.354 ms |
| 重开线程并首次返回缓存搜索结果 | 52.187 ms | 78.550 ms |
| 后台重校验 1,646 文件，0 文件重解析 | 367.810 ms | 340.062 ms |
| `Service` 子串搜索含 IPC，30 次 P95 | 17.144 ms | 15.356 ms |
| 主线程事件循环延迟 P95 / max | 12.026 / 12.657 ms | 12.567 / 13.279 ms |

均保存 1,646 文件/15,420 符号，无拒绝或解析截断；重校验前返回状态为 needs-validation，不能当成已验证的精确语义引用。搜索包含更完整的符号元信息、排序和 200 个结果，与第 8.7 节只取 45 个结果的 FTS 前缀查询不可直接比较。以上不含 HTTP/renderer/JDT、真实冷磁盘、用户输入延迟或最终安装包；本轮未重新安装客户端。

下一步：Local API 与网页 Workspace API 的项目索引生命周期和多项目线程配额、坏缓存恢复、源根配置；两端接入打开/保存/新增删除/外部变更/分支切换事件和低频增量兜底；替换 Java 符号搜索与大纲请求并展示后台进度；校验返回位置的文件 hash，接入未保存 overlay；最后验证网页生产构建、最终 asar 和 Windows/macOS x64。精确导航/依赖指纹与引用缓存仍由第 8.5 节第 4 阶段完成，不使用语法同名候选冒充正确 F12。

### 8.9 网页端与桌面端共同交付约束

2026-10-12 文件识别优先修复：两端按单个文件而非项目语言分类，复用共享类型表、后端分类器及 Markdown 查看器。补齐最长复合后缀、`mvnw`/`gradlew` 等完整文件名、Markdown 别名与未知文本回退，防止控制字符二进制被当作可编辑源码；前端文件名查表避免原型属性误匹配。已增加混合 Java 项目读写/保护测试与两端真实界面用例。详细处理顺序、编码及预览边界见 `docs/editor-code-intelligence.md` 的“混合文件识别补充”。这是文件识别修复，不表示所有二进制格式已有专用预览器。

用户确认：本节快速索引优化必须适用于网页客户端，不以桌面端单独完成作为交付条件。

- 共享 `packages/code-intelligence` 的解析、持久化、增量扫描、查询和后台调度逻辑；桌面由 Local API 在本机工作区执行，网页由 Workspace API 在服务器授权工作区执行。浏览器不直接访问用户本地磁盘，也不需要安装桌面客户端才能使用服务器索引。
- 两端均提供首次后台建索引、再次打开复用缓存、后台增量校验、搜索与大纲的部分结果和一致的加载进度。缓存尚未校验与结果截断明确区分，不把正在初始化当作失败弹窗。
- 网页请求沿用会话及项目权限校验，索引身份绑定用户、项目、实际工作区和分支；未保存缓冲区按用户隔离。查询返回前再次校验权限及工作区是否切换，禁止跨项目/跨用户泄漏源码或符号。
- 网页保留服务器资源配额和多项目并发控制，索引缓存目录独立于源码目录；多副本部署需要明确工作区归属与请求路由，不能假设每个 API 副本都能看到同一磁盘缓存。
- 验收分别覆盖两端的大于 500 文件项目、缓存重开、保存/新增/删除、分支切换、外部变更、过期位置校验、未保存编辑及后台加载交互；网页另外验证无权限、跨用户请求和分支切换中的并发查询。

当前状态：共享索引基础已实现，两端搜索接口和网页交互已接入，详见 8.10；上述为共同交付要求，不代表全部完成或已经上线。

### 8.10 两端索引生命周期与搜索接入

新增共享 `FastIndexManager`：按调用方传入的受控身份及规范工作区路径生成独立缓存键，数据库路径不含 PID，重启复用已有数据。默认最多 2 个后台线程；串行分配防止并发超配，正在执行查询的线程不被淘汰，没有可用线程则返回可重试的资源等待状态。空闲 10 分钟回收，活跃项目每 120 秒增量检查；关闭时停止定时器并关闭线程。后台扫描失败保留可观察状态，不产生未处理 Promise rejection。坏缓存备份/自动恢复、事件去抖和磁盘配额仍待补齐。

- 桌面：打开文件树预热；`GET /symbols` 的 Java 部分读取共享 SQLite，不再占用旧 500 文件预算；其他语言仍走原有受限声明扫描并单独标记覆盖限制。保存/新增/删除及文件树检测变更触发后台校验。符号快捷搜索在索引进行中每 2 秒重查，取消过时请求；等待线程显示小字，不显示通用失败。新增 `language/fast-symbols`、`language/fast-document-symbols`、`language/index-status` GET/POST 接口，沿用本地鉴权和项目边界。
- 网页：上述三种操作通过现有会话 REST POST 入口暴露，与精确 LSP 请求分开排队，不等待 JDT 初始化；无需开启 `LSP_ENABLED` 才能搜索 Java 语法符号。调用前后检查项目权限、工作区根路径及分支；用户身份参与缓存键。`FilesService.write` 成功后通知已有同根索引校验，保存成功不依赖索引更新完成。缓存位置、线程数量和周期由 `FAST_INDEX_ROOT`、`FAST_INDEX_MAX_WORKERS`、`FAST_INDEX_INTERVAL_MS` 配置。
- 网页文件树搜索框支持 `@名称` 搜索 Java 类型/成员；加载状态在小字及不确定进度条显示，部分结果自动刷新，不将加载中的空列表当作“没有匹配结果”。请求取消时不应用旧响应。本阶段初始只搜索磁盘版本，随后已接入草稿 overlay（见 8.11）；快速大纲接口已具备，但编辑器大纲菜单尚未切换到该接口。
- 网页引用预览：实际打开目标时通过 Monaco 关闭引用预览命令清理旧窗口，再复用同一编辑器切换模型；避免 pinned peek 默认在复用编辑器后重新显示旧引用窗口。普通预览选择不触发这一清理。

验证：共享解析/存储/增量/客户端/管理层 17 项测试通过；Local API、Git、数据源回归 27 项通过，1 项真实 PostgreSQL 按环境开关跳过。网页快速索引 505 文件、无 JDT、用户隔离、保存通知及权限/分支变化测试通过；真实 JWT/DTO REST 测试覆盖新增搜索路由。API 与网页生产构建通过。生产网页 renderer + 隔离 HTTP fixture 验证索引进度、部分结果轮询、符号打开、引用预览退出，并回归 F12、源码只读、未保存草稿、编辑器复用及位置历史；fixture 不能替代实际服务器性能验收。

尚未完成：点击候选前的文件 hash/位置有效性校验、事件去抖、网页 Git/外部变更即时通知（已有定时扫描兜底）、生成源码根、坏缓存自动恢复、多副本路由、精确引用关系持久化与语义依赖失效；大项目两端 HTTP/UI 性能验收、最终安装包及跨平台验收仍待完成。本轮未重新打包、安装或部署服务器。

### 8.11 网页与桌面未保存 Java 草稿索引

快速搜索及快速大纲接口支持请求级 `documents: [{path, content}]`。后台线程用同一个 Java parser 解析草稿，草稿文件的磁盘符号在 SQL 阶段排除，再合并/排序草稿声明；排除发生在结果数量限制之前，避免一个旧文件的大量匹配挤掉其他文件。空草稿同样覆盖磁盘声明，已有父目录下尚未落盘的文件也可作为请求级候选。草稿不写入 SQLite、文件或跨请求缓存，不影响扫描 generation；不带草稿的下一次查询仍读取磁盘版本。

- 结果提供 `overlayApplied`、`overlayFiles`、`overlayTruncated`，符号带 SHA-256 和 `hashSource: overlay/disk`。快速大纲也支持当前文件 `content`，两端 API 均可将其作为该文件的草稿覆盖。语法错误保留声明的 incomplete 信息，不冒充精确语义结果。
- 路径必须是工作区相对 Java 文件路径，拒绝绝对路径、目录穿越、重复路径、忽略目录、符号链接及非普通文件。每次最多 20 个 Java 草稿、总 UTF-8 源码最多 1 MiB；总解析预算 2 秒、单文件最多 1 秒、草稿符号总预算 20,000。超过处理预算明确拒绝或标记截断，不静默沿用旧磁盘声明。
- parser 初始化使用共享 Promise，避免后台扫描和草稿请求同时创建并遗失 parser；语法树逐文件释放，关闭时等待正在初始化的 parser 并释放资源。请求只临时持有草稿，不持久化全文或请求级符号。
- 网页搜索监听编辑器草稿身份，250 ms 防抖，变化后查询键立即切换并取消旧请求；查询键只保存身份编号，不包含源码全文，已卸载查询不保留缓存。桌面快捷搜索对编辑变化采用原有 180 ms 防抖，`POST /symbols` 同时保留其他语言的旧搜索结果。两端复用 `collectJavaDrafts`，只收集有改动的可编辑 Java 文件，排除 JAR/JDK 只读源；超过 20 文件、500,000 字符单文件或前端 900,000 字节序列化预算时要求先保存，不截断草稿列表。

验证：共享索引与前端收集 23 项测试通过；网页 Service/JWT REST 及桌面 Local API 验证草稿替换、空草稿、请求隔离、用户隔离、不落盘、排除旧声明、路径与 UTF-8 预算、并发 parser 初始化。API、网页和桌面 renderer 构建通过。网页生产 renderer + 隔离 HTTP fixture 验证草稿上传与继续编辑后的自动刷新；新增 `smoke-fast-index-drafts.cjs` 在真实 Electron renderer + Local API + SQLite 后台线程验证未保存类搜索、旧声明消失、编辑后更新、实际行列定位及磁盘源码保持原样，使用隔离临时项目，不修改用户项目。

仍待完成：候选点击前 hash/位置有效性校验（草稿在结果返回后继续变化时不得跳到旧位置）、语法大纲菜单降级接入、事件去抖、坏缓存恢复、实际大项目两端性能和最终安装包验收。此增量没有实现语义引用关系持久化，也没有重新安装客户端或部署网页服务器。

### 8.12 候选位置验证（2026-10-11）

网页与桌面点击 Java 快速搜索结果前重新读取目标文件；有未保存草稿时以草稿为显示内容。浏览器计算 SHA-256，与结果的 disk/overlay hash 比较，并检查 UTF-16 行列处是否仍是完整符号名称。文件、草稿、项目或选择在异步读取期间变化时取消旧导航。失效候选保留当前编辑内容和光标，触发后台索引刷新，要求选择新结果，不自动跳至旧坐标。CR-only 源码解析与 Monaco 行列一致，提取器版本升级使旧派生缓存重建。网页同文件的引用预览定位交给 Monaco，不误关闭刚创建的引用窗口。

### 8.13 Git Blame（2026-10-11）

两端复用 `useGitBlame` 和 `GitBlameDetails`。编辑器工具栏“行注释”及右键 Git Blame 开关显示作者、日期、短提交号和原行号；点击注释栏打开提交摘要、作者邮箱、完整 hash 和只读逐文件 before/after 差异。再次点击开关恢复普通行号。未提交/未保存行显示“未提交修改”，没有历史提交详情。随文件切换和内容修改更新，450 ms 防抖、取消旧请求，结果必须与当前编辑器内容一致；注释使用 Monaco 原生行号布局，与折叠、滚动、换行同步。

服务端 `POST /sessions/:id/git/blame` 继承 JWT、PROJECT_READ、工作区锁及项目卷访问校验，严格 DTO 校验；桌面 `POST /api/local/projects/:id/git/blame` 继承本地令牌及 Origin 校验。两端共享 `git-blame.cjs`，运行只读 `git --literal-pathspecs blame --line-porcelain --contents - -- path`，通过 stdin 传当前编辑内容，不写入文件/索引/提交，不连接远程仓库。路径逐段校验，拒绝穿越、绝对路径、`.git` 和符号链接；最多 1 MiB、20,000 行，命令超时 15 秒、输出预算 16 MiB。未提交新文件、无历史仓库、二进制和超大文件使用行内说明，不伪造归属。重命名跟踪遵循 Git 的历史匹配规则；此实现不是 IDEA 全部高级历史功能的复制。

### 8.14 本机交付及实际启动问题（2026-10-11）

Blame、Java 快速索引/草稿、候选校验及 Git 历史相关回归通过；网页生产构建真实 UI 覆盖 Blame 开关/提交详情关闭后的 F12、Cmd 点击、引用预览、实现类、光标历史、JAR/JDK 只读源、草稿搜索和过期候选；最终 app.asar 真实 UI 覆盖本地 Blame、提交详情、SQLite/WASM 后台索引、未保存修改、外部变化刷新和正确目标行列。API/Web/桌面渲染构建通过，`git diff --check` 无错误。本次仅验收 macOS arm64 本机包，不代表 Windows/x64 或公开签名/公证已验收。

最新客户端已替换 `/Applications/Code Studio.app` 并启动；旧版本保留 `/Applications/Code Studio.app.backup-20261011-004000`，用户项目与配置未删除。最终 app.asar SHA-256：`e328f7b9b6ff1305fed3ccc4230d1692dcce192d72377a206c0c8fb7b34215c6`。网页入口 `http://127.0.0.1:5173/`，API `http://localhost:3000/api`，运行时开启 `LSP_ENABLED=true`。

实际网页验证发现本机 API 默认共享语言组件目录未准备（先前语言集成 fixture 指向桌面缓存，不能证明默认本机部署完整）。已复用桌面已校验组件补齐共享缓存，并执行 API `prepare-language-servers` 校验；无指定 resources 的独立临时 Java 项目已成功启动并返回真实 hover。部署前仍必须准备组件；Dockerfile.api 已包含此步骤。

实际桌面本次窗口就绪 474 ms；一个已有 Java 缓存的大项目 initialize 完成 14.314 秒，30 秒等待后服务请求放行 44.318 秒，但 `ServiceReady/project-ready` 为 99.788 秒。另一个项目 23.666 秒就绪。第一项目日志显示 initialized 与恢复 Maven 11 模块之间约 85 秒等待，当前证据未证明是磁盘读取、网络还是其他 JDT 后台工作；不能承诺再次启动秒开，也不能把请求放行时间视为项目真正完成。此启动性能问题尚未解决，后续需按阶段/JDT 线程采样定位，不能误称快速语法索引等于完整语义服务秒开。

### 8.15 网页文件预览差异审查（2026-10-11）

2026-10-12 文本编码增量：更新下面此前“非 UTF-8 均不支持”的状态。共享 file-text.cjs 支持 UTF-8（有/无 BOM）及带 BOM UTF-16LE/BE，打开为正常 Unicode，保存保留磁盘编码/BOM/字节序，不信任客户端任意编码字段。原始字节版本摘要识别只改编码的外部冲突。网页/桌面显示编码信息，搜索/源码索引/LSP 同步用同一解码器；Java 快速索引解析解码文本但保持原字节 hash，解析规则版本升级后语法缓存需重建一次，后续热缓存保持复用。23 项编码/文件回归、30 项 API/索引回归、8 项真实语言服务及3项Git测试通过，两端构建与最终 UI 编码编辑/保存验收通过。UTF-8 BOM Blame 不再制造未提交行；UTF-16 行注释明确禁用而不是返回错误归属。GBK、无 BOM UTF-16、UTF-32、编码转换选择器及其他工具链编码兼容未一并完成，继续保留待办。未替换本机安装包。完整边界见技术文档 P 节。

2026-10-12 Markdown 链接导航增量：更新下面上一批“相对 Markdown 链接待实现”的状态。两端共用 markdownNavigation、标题锚点插件和链接组件，支持项目相对文件、代码 #L行号C列号、同文档及跨文档章节；通过既有工作区导航打开文件、保留草稿，跨 Markdown 章节自动预览并滚动到标题。非法路径/协议/位置不会触发读取，找不到章节有提示，不执行文档链接所指的 Shell/SQL，不自动保存。21 项相关回归、两端构建与生产网页/桌面 UI 测试全部通过：准确 SQL 行列、远处标题实际滚动到可见区域、Markdown 草稿保留，既有代码导航与多类型预览保持通过。标题 ID 使用当前共享规则，章节精确位置尚不作为历史书签；非 UTF-8 编码和超大文档虚拟化仍待实现。详见技术文档 P 节。本轮未替换本机安装包。

2026-10-12 混合文件类型补齐：按文件扩展名/特殊名称而非项目语言分类；统一 file-types.json、编辑器语言映射、MIME、树目录排除与文件图标。Java 项目中的 JSON/XML/SQL/Shell/Markdown、.env、.gitignore、Maven Wrapper 配置等可正常识别和打开，未知文本仍可编辑。两端复用 Markdown 源码/预览/分屏组件，使用当前草稿实时渲染 GFM 表格和项目内部相对图片，不自动保存；网页图片保持 JWT 授权，禁用文档 HTML 脚本及外部图片自动加载。18 项文件/预览/索引测试、35 项本地 API/运行配置/断点回归及真实网页/桌面 UI 验收通过，API/web/desktop renderer 构建通过；各命令的重复测试不合计为独立用例。两端源码与预览逻辑已补齐，但本机安装包和当前运行的旧 API 未替换/重启。Java 字节码/归档等仅识别并提示不支持原始预览，非 UTF-8 编码解码、相对 Markdown 链接导航、超大文档虚拟化仍是后续能力，不能宣称支持任意二进制格式。详细原理与边界见技术文档 P 节。按用户优先顺序先完成这项修复与文档，再继续多命名运行配置等 roadmap 工作。

用户实测指出两端文件类型未对齐。源码确认：网页 `FilesService.read` 一律 UTF-8 读取、512 KiB 上限，`CodeEditor` 仅 Monaco/DiffEditor；桌面另有类型元数据、图片/PDF 原始预览和 ExcelJS 表格接口，支持图片、PDF、xlsx、csv，旧版 xls 明确不支持。代码智能、搜索与 Blame 验收不能证明多类型文件预览已完成。

- [x] 提取共享类型判断和预览组件，两端使用一致的图片/PDF/表格布局，不将非文本文件作为编辑草稿、格式化或代码诊断输入。
- [x] 网页增加已鉴权的元数据、原始预览及表格接口；保持会话/项目读权限、路径穿越/符号链接拒绝、类型和体积预算。
- [x] 浏览器通过带 JWT 请求头的请求加载二进制并使用短生命周期 Blob URL；不把 access token 放到 URL，不开放匿名原始文件接口；切换/关闭释放 Blob，拒绝过期响应。
- [x] 验证图片、PDF、多工作表 xlsx、csv、Unicode 路径、未支持格式、大小上限、未授权访问、多标签切换、文本草稿恢复和非文本不可保存；两个真实 renderer 分别验收。

已实现：共享 `file-preview.cjs` 类型识别及表格解析、共享 `WorkspaceFileViewer`；网页 `files/content` 返回非文本元数据，`files/preview` 返回带 nosniff/no-store 的受限图片/PDF，`files/spreadsheet` 返回只读工作表。网页和本地保存接口均拒绝将现有预览文件按文本覆盖。桌面二进制元数据不再读取整个文件。表格限制 20 MiB 输入、64 MiB ZIP 实际展开、10,000 ZIP 条目、20 工作表/500 行/100 列、10,000 字符单元格和 4 MiB 显示内容，截断有提示。

验证：新增 5 项真实 Service/JWT REST 测试覆盖类型、Unicode 路径、原始字节、未授权和缺权限、跨会话、穿越/链接/目录、大小限制、损坏表格、大于旧 512 KiB 限制的图片元数据、显示截断、不可文本覆盖；既有文件列表和版本冲突测试回归通过。网页生产 renderer 验证 PNG 实际解码、PDF.js 实际页面像素与文字、翻页和缩放、慢响应切换不覆盖新文件、Blob 与 PDF worker 释放、多工作表/CSV、未支持 xls、禁用保存、文本草稿恢复；桌面真实 Local API/SQLite worker + renderer 验证相同布局、PDF 文字及翻页、预览切换、草稿保留、大纲与符号搜索。代码构建及这些定向验证通过，不宣称整个仓库全量测试或所有格式均已验收。

PDF 查看器不依赖浏览器内嵌插件，懒加载同版本 PDF.js 与 worker；字符映射、字体及 WASM 随构建复制到本地静态资源，支持离线使用，不访问 CDN。支持翻页、缩放和适应宽度；加密 PDF 暂不支持密码输入，尚无可选择的文字层。

安装包内 macOS arm64 预览与快速索引已追加隔离验证（见 8.18）。尚待完成：安装后的主入口、Windows/macOS x64 预览验收。本轮网页及本机 API 已同步，桌面源码/renderer 已更新，但尚未替换本机已安装客户端。

### 8.16 Java 快速文件大纲

共享 Monaco DocumentSymbol Provider 对项目 Java 文件改用 `fast-document-symbols`，携带当前缓冲区内容，后台 WASM 解析后转换为嵌套的类、构造器、方法和字段大纲；UTF-16 位置使用一基坐标直接转换，丢弃修改期间返回的旧大纲，解析截断时提示仅展示部分符号。JAR/JDK 虚拟源码继续使用项目绑定 JDT 文档符号，定义、引用和实现仍是精确语义查询，不用同名语法符号推断跳转。

Provider 测试覆盖快速接口而非 JDT 初始化、当前草稿、版本失效、嵌套类型及成员、Unicode 坐标和只读依赖源码。网页真实大纲菜单及桌面真实 Local API 的未保存类/方法大纲已通过 UI 验证，既有搜索、候选校验与导航流程回归通过。

### 8.17 两端快速索引的文件事件合并

共享 `FastIndexManager` 对保存、新增、删除以及网页工作区变更通知采用 180 ms 防抖，连续事件最多等待 1 秒便启动后台扫描；手动 `index-refresh` 立即扫描，不等待防抖。周期扫描仍按既有间隔执行。修改一到即标记当前身份索引 `needs-validation`/`complete: false`，搜索旧缓存保留可用结果但明确部分覆盖，不把待更新结果显示成已完成。每次失效递增 revision，旧扫描完成不得清除后来修改的待校验状态。

同一 root 的活跃身份共同失效，其他项目保持独立。待刷新项目不被空闲清理提前回收；容量回收和关闭取消事件定时器，后续重新打开仍需校验磁盘。此优化合并扫描触发次数，不代表 JDT 语义初始化更快，也未实现操作系统文件监听或精确引用持久化。

验证入口：`fast-index-manager.test.cjs` 覆盖连续保存只触发一次扫描、待刷新搜索/大纲不宣称完整、root 隔离、手动刷新、旧扫描完成竞态、持续事件最大等待及关闭取消。真实 Local API 覆盖超过 500 文件的搜索、保存、删除及重新打开缓存；网页 Service 覆盖保存通知、身份隔离和授权重验。本轮源码已更新，现有长驻 API 与已安装桌面尚未重启加载此增量。

### 8.18 macOS arm64 ASAR 隔离验收

最新 desktop-local renderer 已重新构建，使用 electron-builder 生成独立目录 `apps/desktop/release/preview-validation/mac-arm64/Code Studio.app`，未覆盖旧 release 或 `/Applications` 客户端。包体约 597 MiB，`app.asar` SHA-256 为 `c5dfb7a8bc843efee25cd1f2398c59d811c7bb3763d0f4013e309a6e3fc72d05`。构建关闭自动签名发现，仅用于本机验证，未进行 Developer ID 签名、公证或公开发布。

`smoke-fast-index-drafts.cjs` 支持 `CODE_STUDIO_TEST_PACKAGE` 指向真实 `app.asar`：从包内加载 Local API 和 renderer，强制检查索引 worker、两份 tree-sitter WASM、ExcelJS 均解析到包内，不允许落回开发依赖。检查打包的 PDF CMap、字体和 WASM，实际通过 Local API 加载 PDF worker 并绘制、翻页；图片解码、工作表切换、CSV、未保存源码恢复、大纲、SQLite 搜索与过期候选刷新通过。renderer 测试拦截外部 HTTP 请求，断言没有远程/CDN请求，且 PDF 静态资源无 HTTP 错误。

关闭真实 Local API 后，用包内客户端重开同一 SQLite：首次扫描前已能查询上次保存的符号位置，未保存草稿没有进入持久化库；后台校验 `parsedFiles: 0`、`unchangedFiles: 2`，完成后索引就绪。此测试证明包内模块/资源与小型工作区缓存闭环，不证明整个 IDE 秒开或 JDT 语义缓存无需初始化。

验证宿主为同版本开发 Electron，加载实际归档里的生产代码及界面；没有启动打包应用主入口或替换用户客户端，因此不将该测试称为安装后全流程验收。Windows、macOS x64、大项目输入/滚动性能、正式签名和发布仍待完成。

### 8.19 启动时坏快速索引缓存恢复

两端后台 worker 共用 `recoverable-fast-index-store.cjs`。只有成功验证 SQLite 应用标识、schema 版本和工作区身份后，才建立独占写入的 `.owner.json` 标记；身份摘要绑定数据库路径及规范工作区 root，不记录源码。已有有效旧缓存首次打开会补充标记并保留符号。打开时检查文件头及 SQLite schema，遇到 `SQLITE_CORRUPT`/`SQLITE_NOTADB` 且所有权标记吻合，才将数据库及当时存在的 WAL/SHM 移到同目录唯一 `.corrupt-UUID` 备份，再创建空索引并后台扫描。文件头损坏在 SQLite 打开前识别，避免它提前清理附属文件；schema 探测只读，但 SQLite 仍可能刷新临时 SHM 记账内容。

无标记的坏文件、错误身份/损坏标记、业务数据库、新于客户端的 schema、符号链接/硬链接、权限与磁盘错误不自动移动或覆盖。备份不自动删除；状态只返回恢复原因和时间，不暴露服务器绝对路径。恢复后初始结果不完整，完成重建再声明就绪，之后热打开仍复用缓存。项目源码与未保存草稿不参与备份或重写。

5 项恢复测试覆盖坏文件头、有效头但 schema 损坏、WAL/SHM 备份、重建/再打开、旧缓存迁移、外来数据库、错误 root、新版本、标记损坏与文件链接；既有存储/扫描/管理器/worker 回归通过。真实 Local API 对超过 500 文件的索引注入损坏后重开并恢复查询；网页 Service 验证同样恢复、先鉴权再打开缓存及源码保留。

范围是 worker 启动时检测到的 SQLite 文件/schema 损坏；运行中才发现的页面、FTS 或 JSON 记录损坏尚未做透明恢复，也没有启动全库完整性扫描。旧版已损坏且从未建立标记的缓存不能安全自动认领；备份磁盘配额、多实例互斥及 Windows 文件锁场景仍待完善。本轮没有重启长驻 API、重新打包或替换客户端，8.18 的归档不含此后新增的恢复模块。

### 8.20 真实大项目快速索引 UI 基线

新增 `benchmark-index-ui.cjs`，使用可见的生产 desktop-local renderer、真实 Local API/SQLite worker、只读 site-tpl-manage 和临时应用状态。第二轮重用第一轮索引库。为分离快速索引开销，测试阻断 JDT prepare/语义查询、Java target discovery、源码写入和外部 HTTP；因此不是完整 Java IDE 的启动或代码编辑性能测试。逐字符通过 `webContents.sendInputEvent` 输入到真实 React 搜索框，记录从发送前到下一 rAF 的延迟、帧间隔及支持时的 long-task 观测，统计全部输入事件，缺样本即失败，不用 DOM 值赋值代替字符事件。

Apple M2 / 24 GiB / Electron 37.10.3 / arm64 一次基线：2,512 文件树项、1,646 Java 文件、15,420 符号；两轮最终 complete，0 拒绝/截断/目录错误。

| 指标 | 空应用缓存 | 重开持久化缓存 |
| --- | --- | --- |
| 网页导航到项目列表可用 | 352.4 ms | 178.7 ms |
| 点击项目到搜索框/文件树界面可用 | 33.0 ms | 27.9 ms |
| 点击项目到观测索引就绪 | 10,063.5 ms | 1,466.7 ms |
| 热搜索 HTTP P95（30 次） | 25.0 ms | 45.8 ms |
| 加载阶段搜索框字符到下一帧 P95 / max | 20.1 / 30.6 ms | 35.4 / 94.5 ms |
| 加载阶段帧间隔 P95 / max | 33.3 / 159.9 ms | 33.2 / 67.2 ms |
| 就绪阶段字符到下一帧 P95 | 14.7 ms | 16.0 ms |

第一次搜索在 scanning 阶段已返回 77 个部分结果，重开校验期间返回 200 个缓存结果。索引就绪时间包含 UI 操作、HTTP 轮询及输入压测，不等于纯 worker 建库时间；加载阶段也可能包含轮询观测前已结束的索引。搜索框渲染、实际代码输入、滚动、GPU 展示、OS 键盘延迟不可混为一谈；HTTP 搜索不含 UI 防抖与候选渲染。OS 磁盘缓存未受控，这不是冷磁盘数据。

同一源码的单独 Node worker 对照：冷建 3,954.4 ms，线程重开首次缓存查询 54.8 ms，增量校验 384.8 ms/0 文件重解析，IPC 搜索 P95 17.1 ms。与 UI 压测不是相同 runtime/负载，不根据差值推断单一瓶颈。当前证据证明快速搜索达到本次 P95 ≤100 ms 的目标，但不能证明整个 IDE 无卡顿：仍有偶发长帧，下一步应分段采样 CPU/布局与查询负载，并补代码编辑、滚动和网页端基线，不宣称完整性能验收通过。本轮没有重新打包、安装或重启用户服务。

### 8.21 两端文件树构建与桌面输入渲染优化

两端共用 `workspace-file-tree.ts`，按完整相对路径 Map 查找节点，避免大量同层文件下对每个新节点遍历已有兄弟；排序迭代 Map，不递归遍历构建树。保留目录优先、名称排序、相对路径和重复项合并，拒绝无效路径。桌面输入显式 directory 项，不再只根据文件推导目录，因此空文件夹可见。网页当前文件列表仍只提供文件路径，此改动不宣称网页 API 已新增空目录管理。

桌面 `LocalFileTree` 使用 memo 和稳定动作回调，最新创建/删除处理器通过 ref 获取，避免搜索输入和其他无关状态变化重渲染整棵文件树，仍在文件列表、选中文件及 active 状态变化时更新。`@/#/>` 模式不再额外扫描文件名候选，保持原有布局与快捷键。

3 项树结构测试通过：网页/桌面相同文件列表生成相同树、空目录/重复项/路径边界、一万个同层文件和 1,500 级路径不截断。网页导航、精确跳转、预览、草稿、过期候选 UI 回归通过；桌面补测右键新建空目录、刷新后可见及删除，并回归大纲、SQLite 搜索、PDF/表格和草稿恢复。

同机器/项目再次运行 UI 基准：首次观测索引就绪 8,614.7 ms，重开校验 1,377.1 ms，覆盖仍为 1,646 文件/15,420 符号且 complete。加载阶段字符到下一帧 P95 分别 14.9/15.1 ms（上轮 20.1/35.4 ms），帧间隔 P95 分别 17.5/17.5 ms（上轮 33.3/33.2 ms）；热 HTTP 搜索 P95 为 32.9/24.5 ms。只是两次单轮观测，系统负载和 OS 缓存不受控，不将变化全部归因于树优化。

仍存在首次就绪后 116.6 ms 的偶发帧间隔、62.8 ms 的输入 max，缓存校验期间第一次搜索 120.0 ms；即使 long-task observer 支持且未报告长任务，也不能据此宣称没有 GPU/布局/调度卡顿。后续仍需 CPU/渲染跟踪、代码编辑和滚动及网页性能基线。本轮已重建两端 renderer，未重新打包或替换已安装客户端。

### 8.22 大项目 Monaco 编辑与滚动基线

`benchmark-index-ui.cjs` 在快速索引就绪后，从真实项目选择不超过 256 KiB 的较大 Java 文件，通过产品快捷搜索打开生产 Monaco。仅在内存草稿末尾加入测试注释，通过 Electron char 事件输入 30 字符，核对 30 次实际模型变更；Monaco 的文本输入不保证通用 DOM input 监听完整，因此模型变更事件负责计时。滚动发送 30 次真实宿主合成 wheel，同时核对轮事件及实际视口变化，缺样本则失败，不把仅收到事件但未滚动视口当作有效测量。

滚轮事件需包含 `wheelTicksY`，因为当前 Monaco `StandardWheelEvent` 优先读取旧 `wheelDeltaY`，只设置 deltaY 时可能收到 wheel 而不滚动。参数参考 [Electron MouseWheelInputEvent](https://www.electronjs.org/docs/latest/api/structures/mouse-wheel-input-event)，处理依据为本仓库安装的 `monaco-editor/esm/vs/base/browser/mouseEvent.js`。这是基准工具修正，不宣称产品物理鼠标滚动曾因此失效。

本机 Apple M2 / 24 GiB / Electron 37.10.3，对同一 1,646 Java 文件项目的单轮结果：选中文件草稿准备后 2,604 行/120,507 字符，视口 503 px；每轮核对 30 字符变更、30 wheel 样本，并观察到 35 次包含初始定位的视口变化。结束时恢复原模型内容，磁盘 SHA-256 保持相同，临时应用目录清理，源码写入/运行/外部请求持续阻断。

| 索引就绪后的测量项 | 第一轮 renderer | 缓存重开 renderer |
| --- | --- | --- |
| 选择文件到 Monaco 可用 | 274.4 ms | 276.3 ms |
| 字符发出→模型变更→下一帧 P95 / max | 19.4 / 20.4 ms | 22.4 / 50.3 ms |
| 代码输入阶段帧间隔 P95 / max | 17.7 / 17.7 ms | 17.5 / 49.5 ms |
| wheel→下一帧 P95 / max | 17.4 / 19.9 ms | 17.8 / 18.9 ms |
| 滚动阶段帧间隔 P95 / max | 17.5 / 33.4 ms | 17.5 / 17.7 ms |

这是索引已就绪、JDT/诊断/补全被排除后的单文件短负载，包含宿主 IPC，rAF 不等于最终像素呈现。未测快速索引/JDT 同时更新时的代码输入、长时间编辑、复杂装饰、多编辑器、多次统计重复、网页或安装包性能；本轮仍有 50.3 ms 输入 max，不能据此宣称完整 IDE 流畅度验收完成。快速索引本轮观测首次 8,283.3 ms、热校验 580.1 ms，仅保留为本轮背景状态，不替代前述分层基线或承诺稳定启动时间。

### 8.23 Java 缓存恢复与自动构建分阶段启动（2026-10-12）

用户在本机 0.1.1 看到 Java 加载 80 秒。只读日志核对：该轮 JDT 启动至真正 ServiceReady 约 191.6 秒，initialize 回应约 17.1 秒，initialized 后至导入开始约 173 秒，随后 11 个 Maven 模块的 workspace 初始化约 1.1 秒。不能把该空档直接解释为扫描 1,647 个 Java 文件：运行中的共享快速索引已完整覆盖 15,419 个符号，状态接口约 9 ms；三次实际符号搜索返回 63 项，耗时 23/8/6 ms。后者是已就绪索引的查询时间，不是重开加载时间，也不代表所有语义跳转耗时。

隔离诊断使用项目只读快照（1,818 个文件、约 6.8 MB），不附加到或重启用户 IDE。`profile-java-startup.cjs` 采集自己独立 JDT 进程的 jcmd 线程栈，优先保留 Java/Maven/网络及构建相关栈；诊断就绪上限改为 240 秒，不是产品延长用户等待。原启动顺序单轮：fresh 11.8 s、persisted 44.1 s，较慢缓存轮栈中有 Eclipse AutoBuildJob / JavaBuilder / Compiler。关闭自动构建的对照：fresh 12.2 s、persisted 6.1 s。保留自动构建但延后启用：fresh 21.7 s、persisted 6.1 s，记录 project-ready 后 autobuild-enabled。这些是隔离单轮，不是统计保证；尚不能证明原本 173 秒空档完全由自动构建导致。

共享 LocalLspManager 默认在初始化、configuration 回应和初始化配置通知中使用 autobuild=false，收到真实 ServiceReady 后开启 autobuild=true；不因 30 秒 ready 等待兜底而提前开启。仅等待配置通知写出，不等待全项目编译。显式 Java 运行/调试 buildWorkspace、诊断和语义服务仍保留，不把自动构建永久关闭来制造“快速就绪”。javaAutobuild=false 和 deferJavaAutobuild=false 仅为诊断/兼容开关，正常产品调用默认延后后启用。生命周期增加 autobuild-enabled / autobuild-enable-failed，后续启动可区分导入可用与后台构建。

网页/桌面共用状态条，快速索引与 Java 状态独立请求、独立取消，不把快速索引状态排到长语义请求之后。Java 文件可直接启动快速状态轮询，不依赖 JDT 已给出 provider；显示完整就绪文件数、缓存可用但后台校验、部分覆盖或尚未建立。Java 一侧显示“语义服务正在加载”或“后台分析与构建”，不再把两层统称“项目与缓存索引加载”。没有 invented 百分比；完整覆盖、部分覆盖、后台失败不混为就绪。已有快速搜索/大纲接口本来独立于 JDT，新界面暴露实际可用状态，并不宣称变量/依赖源码的精确语义导航可由语法索引替代。

验证：真实语言服务测试检查初始化和 project-ready 时自动构建尚未开启、之后配置成功写出且只开启一次，并回归 Java 源码/JAR/JDK 跳转与诊断；Lombok/运行/断点/变量/单步/停止真实运行时测试通过。网页生产界面故意保持 Java importing，确认快速索引已就绪且 Monaco 快速大纲能打开，再恢复语义就绪，完整导航、预览、草稿与 UTF-16 保存回归通过；桌面完整 Java Debug 界面回归同样通过。网页与桌面 renderer 构建、状态文本单元测试通过。此次只更新源码/测试/文档，没有替换或重启正在运行的 0.1.1 客户端；原 173 秒异常的全因定位、更多项目/重复测量及构建并行期间编辑流畅度仍需继续验证。

后续安装验证（2026-10-12，用户明确要求）：客户端版本升级为 0.1.2，lockfile 同步。最终串行回归 22/22 通过、无跳过，覆盖网页/桌面快速索引、真实多语言导航、Java 自动构建延迟开启、Lombok 与 Debug；API 和桌面 renderer 构建通过。打包核对 ASAR 中共享语言服务、文件类型、Local API 与 renderer 入口均与当前源码一致；ASAR SHA-256 为 `9f20d96635ea32a025ac62532c4b4ac5e460f4c52e89fe72120da7cd217a70a8`。本机 ad-hoc 签名通过严格验证，不代表 Developer ID 公证已完成。

已替换 `/Applications/Code Studio.app` 并实际启动，本地健康接口返回 HTTP 200、`status=ready`、`remoteApiRequired=false`。旧版保留在 `/Applications/Code Studio.backup-0.1.1-20261012-184543.app`，用户数据和项目未删除，远程 API 未重启。网页 Docker 构建补入共享文件类型 JSON，避免容器构建时缺失依赖。

后续开发安排：按用户要求，先提交并 push 当前已验证成果，再从该提交新建独立开发分支实现 SQL、Shell 编辑智能提示与 Redis 连接管理；这些能力不计入 0.1.2 已完成内容。两端优先复用补全与连接协议，不能只提供菜单入口或语法高亮代替上下文智能提示。

### 8.24 SQL / Shell 智能提示与 Redis 独立开发分支（2026-10-12）

基线提交 `60171f6f` 已 push 原分支；从该提交切换至 `feature/sql-shell-intelligence-redis`。保持 0.1.2 安装版本不变，新分支能力完成回归后再发布，不把未完成能力计入已安装版。

Shell 第一阶段使用共享 `LocalLspManager` 接入 `bash-language-server`，网页 REST 与桌面 Local API 不另写解析器。共享文件类型注册表同时定义 Bash 可解析范围：`.sh`、`.bash`、mvnw、gradlew、`.bashrc`、`.bash_profile`、`.profile`；Zsh、Fish、PowerShell 仍保留各自语法高亮，但不套用 Bash 诊断。Monaco 注册补全（`$`、`{`、`-`、`/` 触发）、导航、悬浮、引用与大纲；两端草稿同步包含 Bash 文件，查询不保存文件、不执行项目脚本。语言服务关闭由原 guardian / graceful lifecycle 管理。

启动时只向语言服务转发可执行文件检索环境（PATH、Windows SystemRoot），不转发服务进程中的 API/数据库凭据。关闭 explainshell 网络端点及 ShellCheck 外部 source 读取；ShellCheck / shfmt 未打包时不能宣称其额外 lint / 格式化能力已具备。后台预分析最多 2,000 个匹配文件，打开其它文件仍可按需解析，不等于项目文件数量限制或全项目索引已完成。Bash 初始化后解析异步完成：按 publishDiagnostics 的文档版本同步首次打开和草稿查询，限制等待 5 秒并清理等待者，避免空结果或旧版本结果；不是固定睡眠。

补全转换同时修复 LSP/Monaco kind 枚举不一致，保留 textEdit、insert/replace 范围、snippet 格式、additionalTextEdits 和 isIncomplete；过滤其它项目和不受支持的 Shell 方言。真实 Bash 测试验证草稿变量补全、函数定义/引用/大纲及无扩展名 wrapper，源文件内容保持不变。共享编辑器/文件类型 25 项测试及真实多语言 10 项测试全部通过；网页构建通过。完整两端真实界面与打包验证仍需继续。

补充界面验证：隔离 Electron 测试使用真实 Local API 与 Bash 服务，打开项目内 run.sh，在 Monaco 中输入未保存变量并触发建议，实际补全弹层显示 `DRAFT_VALUE`，同时验证磁盘文件未变；桌面 renderer 构建通过。网页真实端到端 Bash 服务/权限验证及新版本安装包测试仍未完成。

后续要求（尚未完成）：

- [ ] SQL 工作区补全支持方言、关键字/片段、项目 DDL/别名和绑定数据库表/列；连接和元数据缓存按项目及连接隔离，编辑时只查询结构、不执行 SQL，网页/桌面复用相同组件和补全逻辑。
- [ ] Redis 本地连接新增/编辑/测试、TLS/ACL/数据库选择、SCAN 分页、键类型/TTL/值预览与增删改；不用 KEYS 全量扫描，大值有明确截断说明；凭据加密、不回显，个人版写入不审批但遵守数据库 ACL，破坏性操作有确认。
- [ ] Redis 网页/桌面共用详情组件和传输协议，网页继续使用现有权限/审批边界；新增菜单不代替真实连接、浏览与 CRUD。
- [ ] Shell 两端真实 UI、REST 身份隔离和打包后解析资源验证，方言边界与超时/退出覆盖；可选 ShellCheck/shfmt 的安装、能力探测与安全调用单独验证。

依赖安全检查发现仓库仍有既有生产依赖公告，不能宣称项目安全审计全绿；尚未执行跨功能 `npm audit fix`。此项不通过忽略错误来完成，需要按依赖影响范围单独评估及回归。

### 8.25 共享 SQL 语法与上下文补全第一阶段（2026-10-12）

新分支增加 `sql-intelligence.ts`，采用现有 CodeMirror SQL 解析器和 schema/keyword completion sources；数据库 SQL 编辑器删除全量平铺关键词/表/列 override，网页与桌面数据库详情通过原共享 `SqlEditor` 使用相同语法上下文补全。PostgreSQL/MySQL 元数据分别按方言处理，支持限定名、引号内的点和转义引号，表别名的列候选不会混入其它表的列，注释与字符串不触发补全。数据库详情的列结构缓存按本地/远程、连接 ID、数据库和连接更新时间隔离，切换范围不复用旧列结构。

项目 Monaco SQL 文件通过共享语言 provider 安装同一补全逻辑，不依赖 JDT、不执行 SQL。未绑定数据库时采用 Standard SQL；从同一工作区已打开 SQL 模型中提取 CREATE TABLE 字段（含未保存草稿），使用语法树而不是在注释/字符串里匹配正则。DDL 按模型版本缓存，文档或 DDL 来源改变、项目退出、取消请求时丢弃旧候选；异项目模型不读取。单文件 100 万字符、总已打开 DDL 400 万字符的解析预算超出时标注部分解析，不宣称已覆盖全项目。ALTER、动态 SQL、厂商完整 DDL 语义及未打开文件的全项目 schema 索引尚未实现。

`sql-workspace-provider.ts` 按首次 SQL 补全请求动态加载解析模块；项目首屏不静态加载 SQL/CodeMirror 解析器，构建中解析块约 382 KB 独立分包，避免仅打开 Java/TS 工作区也承担该负担。此数字是构建产物大小，不是加载延时或内存测量。

单元测试验证引号/原型式命名、DDL 注释和字符串排除、别名列、跨项目隔离、草稿修改及异步旧结果取消；延迟加载测试确认外项目不触发加载及加载期间修改文档会取消候选。SQL、编辑器导航与混合文件共 32 项测试通过。网页与桌面 renderer 最终构建通过；实际两端 SQL 界面验证修改未保存建表文件后，另一份 SQL 的别名补全显示新列而非旧列，原磁盘内容不变。网页完整导航、预览、Markdown、UTF-16 保存回归同时通过；首次网页测试误用展示层不换行空格作加载判断，改为真实模型内容后重跑通过。

项目 SQL 文件的数据库绑定选择、只读元数据传输、列按需加载与权限撤销处理仍待下一阶段，不通过自动暴露全部已保存数据库来替代绑定。Redis 连接/详情/CRUD 仍未完成。当前仅开发分支更新，已安装 0.1.2 不变。

### 8.26 Redis 本地连接与共享命令详情第一阶段（2026-10-12）

桌面数据源列表新增 Redis 类型、连接编辑和共享 `DbQueryPage` 详情入口；支持主机/端口（默认 6379）、数据库编号、ACL 用户名、密码与 TLS。密码沿用本机凭据加密和“留空保留”机制，公开配置不返回明文；修改数据库编号后保留连接身份。实际请求由 Local API 在本机发起，不访问远程数据库 API。Redis 主机加入企业网络白名单检查，连接器许可沿用企业策略；既有企业默认策略没有自动增加 Redis，管理员仍须明确允许。

本地 Redis 运行时使用 ioredis，连接和命令各 5 秒超时、无自动重连，操作结束后断开。个人 community / personal-pro 模式且不强制企业策略时，Local API 判定写权限，不信任请求中的 readOnly；企业/受管模式仍只读。共享 Redis 编辑器根据本地能力提供 SET/HSET/集合写等命令提示，网页远程服务只读边界未放宽。共享参数解析支持引号、空值、空格、转义和 Unicode，不执行 shell/eval；删除与过期时间修改由界面确认，后端亦要求确认字段；配置、ACL、EVAL、FLUSH、KEYS 等危险/未支持命令拒绝，不把个人版不审批解释为允许清空所有数据库。

命令注册表集中在 `packages/code-intelligence/redis-commands.json`，前端确认/提示与运行时命令范围复用；网页 Docker 构建复制该共享文件。SCAN 使用 cursor/MATCH/COUNT（1–100），不使用 KEYS，COUNT 是 Redis 的批量提示而非严格条数保证。GET 预览最多 64 KiB 并返回长度/截断标记；大 HGET 字段只返回长度说明，MGET 最多 10 个键，GETRANGE 限定范围；结果 JSON 超过 256 KB 提示缩小范围。当前预览读取不是跨命令事务快照，变化中的值/类型可能导致重试或大小信息变化，不宣称强一致或完整二进制导出。

验证：Redis 参数/命令解析、范围与只读校验、Local API 鉴权/错误脱敏/编辑持久化，以及真实开发 Redis 连接、CRUD、TTL、SCAN、数据库 0/1 隔离和大值截断，共 5 项测试全部通过且无跳过。真实测试只创建并清理自己命名的两个随机测试键，未清空数据库或删除业务键。已有连接编辑和元数据回归 4 项通过，真实 PostgreSQL 案例本轮未启用（跳过 1 项），不计入已验证数。桌面 renderer 构建通过，隔离 Electron 界面验证实际数据源入口、DB 编号编辑、密码隐藏/保留、共享详情、带空格的 SET 参数、删除确认、数字 0 结果显示和无远程 API 请求；该 UI 案例使用模拟执行器，真实 Redis 由前述运行时测试覆盖。

仍待补齐：可视化 SCAN 键浏览和各键类型详情/TTL 编辑、哈希/列表/集合分页预览、二进制值处理、真实 TLS/ACL 服务集成、企业签名策略 Redis 专项回归及安装包验证。当前没有把 Redis 所有能力标为完成；开发分支未提交/发布新版本，已安装 0.1.2 不变。

### 8.27 共用 Redis 键浏览、分段字节预览与授权重检（2026-10-12）

新增共享纯读取模块 `redis-browser.cjs` 与两端共用 `RedisBrowser`。网页沿用带 JWT / 权限守卫的 `/db-query/:id/execute`，通过嵌套校验 DTO 接收 `redisBrowse`；桌面沿用带 Local API 身份校验的连接 explore。只接受 scan/inspect/value 三类操作，不由任意命令或 action 字符串分派写入；浏览请求即使夹带 SET 也不会执行该命令。网页 Redis 连接同时补入已有配置的用户名/密码/TLS，按需连接并在结束时断开。

SCAN 采用 Buffer 响应，不用 KEYS，匹配/游标/COUNT 有校验。返回下一游标与当前页键列表；前端只保留当前页，不无界累计整个 Redis 的键。返回条数上限 500、键名 8 KiB、编码后页条目预算 128 KB，省略项显式标记 partial/omitted，不把 COUNT 当严格条数或把省略页声称为完整扫描。二进制/控制字节键以 Base64 引用，UTF-8 BOM 作为键本身字节保留，选择键不因显示编码而指向另一个键。

查看键展示类型、PTTL 与字节数/集合项数；字符串使用 GETRANGE Buffer 每段 16 KiB，前后翻段、刷新值，返回偏移、下一偏移、hasMore/截断说明。该范围不是完整有效 UTF-8 或含控制字节时，以 Base64 无损展示，不用替换字符丢失数据，也不把跨字符切片误称为整份值的编码。哈希/列表/集合/有序集合/流当前只读类型和数量，不加载全量值；其分页值详情仍待实现，界面有明确说明。

读取返回前，网页重检数据源成员授权并核对解密配置，桌面重检连接更新时间/凭据/配置与最新企业连接器/网络策略；变化时不返回旧数据。前端连接范围变化会重挂组件并取消旧请求，翻页/搜索清空旧选择和预览，权限/配置错误清理已有键和值；不会把已撤权的值一直留在旧预览里。Redis 字节范围与元数据跨命令非事务快照，在线变更可能造成类型变化/过期/重试，不宣称强一致快照。

验证：本轮 Redis 13 项测试全部通过且无跳过，覆盖真实 Redis 扫描/TTL、中文跨段重组、二进制键值、个人 CRUD、数据库 0/1 隔离、Local API 进行中修改连接、网页服务读取前后授权与配置重检、只读写命令拒绝、DTO 非法操作/字段校验。真实测试仅写入和删除自己的随机测试键。API、网页和桌面 renderer 构建通过；桌面实际界面验证键选择、TTL 与下一段及既有编辑/写命令回归；网页生产界面通过隔离鉴权 HTTP fixture 验证共用浏览、游标翻页、TTL/值展示及模拟 403 撤权后清空缓存。HTTP fixture 不等于部署环境的 JWT/Redis 联调，服务器真实读取与授权重检另由上述服务测试覆盖。

仍未完成：集合分页值与编辑/TTL 可视化操作、SQL 项目数据库绑定、真实 TLS/ACL 与企业签名策略专项集成、Windows/macOS 新安装包验收。未重新安装或发布客户端，也未重启用户正在使用的远程 API；网页部署须同时更新 API DTO/实现，不能仅发布前端后宣称已可用。

### 8.28 Redis 四类集合有界分页（2026-10-12）

共用浏览器补入 hash/list/set/zset 表格、分数、当前页刷新与翻页；列表和有序集合可按索引返回上一页，哈希/集合可继续扫描或从头读取。底层共用 `redis-collection.cjs` 和 `redis-buffer.cjs`，两端不分别解析成员或丢弃二进制引用。每次最多 25 行，单个预览/可操作成员引用最多 1 KiB，超出时显式显示原始字节长度及截断；巨大哈希字段只返回长度，不下载内容，不把部分预览当完整值。

使用固定的应用内 EVAL_RO 只读脚本，不接收用户脚本，不向可写 EVAL 降级。基本集合分页需要 Redis 7+ 和 EVAL_RO/对应读取命令 ACL；哈希通过 HSCAN NOVALUES 避免整批大值，要求 Redis 7.4+。版本/ACL 不支持时返回明确能力提示，基本键/字符串浏览和其它原生读取不因此关闭，不修改用户数据库 ACL 或配置。本机开发 Redis 实测 7.4.10。依据：[EVAL_RO](https://redis.io/docs/latest/commands/eval_ro/) / [HSCAN NOVALUES](https://redis.io/docs/latest/commands/hscan/)。

SCAN 的 COUNT 不是严格页大小。紧凑编码集合可能返回整个批次，因此额外传递 scanOffset：同一 Redis 游标内按 25 行窗口续读，窗口结束后才推进底层游标；即使 Redis 返回 0，也不能提前认定当前大批次已展示完。前端按 hasMore/nextScanOffset 续页，只保存当前行，不累积无界集合。在线成员变化可能使 SCAN 结果重复/移动，仍不宣称一致性快照。脚本仅限制返回客户端的内容；Redis 本身仍可能形成原始扫描批次或列表大元素，深列表索引成本会随偏移增加，不宣称服务端临时内存/执行时间恒定。

验证：最终 Redis 15 项测试通过、无跳过，真实运行验证四种类型、小/空/100 KB 哈希值、100 KB 列表元素截断、列表后页、100 个紧凑集合成员完整续读和二进制有序集合成员/分数；只读脚本权限失败不会改调用 EVAL。API、网页、桌面 renderer 构建通过。实际桌面 UI 验证四类表格、哈希大字段提示、列表和游标为 0 的集合下一页、分数，并回归连接/命令/删除确认；生产网页 UI 验证紧凑批次续页参数、只读协议及撤权清理（隔离 HTTP fixture），真实底层 Redis 由上述测试覆盖。测试只创建并清理自己的随机键。

仍待：可视化新增/编辑/删除成员与 TTL 操作、完整大字段读取策略、Redis Stream 值浏览、SQL 项目数据库绑定、真实 TLS/ACL/企业策略专项回归与新安装包验证。当前开发分支工作未发布，已安装客户端及运行中的远程 API 不变。

### 8.29 Redis 可视化删除与 TTL 修改（2026-10-13）

共享浏览组件增加设置 TTL（秒）、永久保存和删除键。仅 Local API 浏览响应明确返回 canWriteRedis 时显示按钮，网页不传递直接修改 transport，远程 ExecuteQueryDto 不接受 redisMutation；个人版仍无需审批，受管/企业模式不可因客户端按钮或 readOnly 参数获得写权限。

新增本机专用 `redis-mutation.cjs`，只接受 delete/expire/persist、精确 UTF-8/Base64 键引用、确认标志和有界整数 TTL；不混合浏览/任意命令。删除使用 UNLINK，避免前台同步释放大值；修改前预检键是否存在及类型。类型预检与修改是不同 Redis 命令，不宣称事务 CAS 或并发更新冲突保护已完整实现。

Redis 连接建立后以及类型读取后、真正写命令前，重新核对同一连接配置/凭据、许可证个人模式和企业网络/连接器策略；请求已断开时不开始修改。旧命令编辑器的写命令同样在连接建立后重检权限。客户端禁止修改期间操作同一浏览面板，取消确认不发请求，成功后刷新 TTL/预览或键页；连接/页面退出取消展示中的异步结果，但已经送达 Redis 的写命令无法由前端取消回滚，不宣称退出自动撤销已执行操作。

验证：真实随机测试键验证 TTL、PERSIST、Base64 二进制键删除及权限检查抛错时不写入；单元测试覆盖只读/缺确认/非法 TTL/类型变化和类型查询后撤权；网页 DTO 拒绝直接修改协议。实际桌面 UI 验证取消删除、设置 TTL、永久保存、删除后清空预览并刷新列表，再回归集合与命令操作（界面使用隔离模拟执行器，真实 Redis 另由运行时测试覆盖）。桌面 renderer 构建通过，git diff --check 通过。

最终 Redis 18 项回归全部通过、无跳过，包括上述新增修改操作及既有连接、分页、只读和授权保护。

仍待：可视化新键/值与集合成员新增编辑删除、冲突检测、SQL 工作区绑定数据库、真实 TLS/ACL/企业策略专项联调、完整两端与安装包发布回归。当前已安装版本不变，不因增加三个操作按钮把 Redis 或整个 roadmap 标为完成。

### 8.30 Redis 新字符串键与版本保护编辑（2026-10-13）

个人本地浏览面板补入新增键和完整字符串编辑；键/值均支持 UTF-8 或 Base64 输入，复用自定义 Select 而非原生下拉，单次写入上限 16 KiB。新增使用 SET NX，已有键不覆盖。完整字符串预览返回基于原始字节的 SHA-256 版本；非首段、不完整/截断预览没有编辑版本，不允许把预览片段当完整值保存。

编辑使用 WATCH 监视准确键引用，再核对类型/大小和有界 GETRANGE 原始字节摘要，权限重检后通过 MULTI/EXEC SET KEEPTTL 保留当前过期时间。旧摘要、读取期间变化/过期、WATCH 冲突及错误事务返回均不覆盖现值，不自动重试旧内容。此机制保护该字符串编辑流程，不等于所有 Redis/成员修改均已有版本 CAS，也不实现跨连接权限变更的分布式原子事务。Redis 命令已送达后的网络失败仍可能出现执行结果不确定，不宣称请求超时意味着数据库未修改。

编辑器绑定打开时的键和版本，换选其它键不会把旧草稿写到新键；失败保留草稿，放弃需确认，未保存内容接入 code-studio:quit-check 和 beforeunload。当前仍未实现跨菜单/路由的持久化草稿与统一离开提示，不宣称任意切页都能保留数据库表单。

验证：最终 Redis 20 项测试通过、无跳过；真实 Redis 验证 SET NX 重复新增不覆盖、TTL 保留、旧版本拒绝、WATCH 与 EXEC 之间其它连接修改后的拒绝覆盖、二进制值写入和大值不给编辑版本。实际桌面界面验证新键新增、完整值编辑、版本传递、未保存草稿退出检测及既有键/集合/命令回归（界面使用隔离模拟执行器，真实存储由前述运行时测试覆盖）。桌面 renderer 构建、git diff --check 通过。网页仍只读，未增加远程直接修改协议；本次未部署 API 或重新安装客户端。

仍待：哈希/列表/集合/有序集合成员可视化编辑与冲突处理、跨路由数据库草稿保护、SQL 工作区数据库绑定、真实 TLS/ACL/企业策略专项集成以及新版本完整发布验收；整体 roadmap 保持进行中。

### 8.31 哈希字段新增、编辑与删除（2026-10-13）

个人本地 Redis 哈希详情增加字段新增、完整字段编辑和删除。字段和值支持 UTF-8/Base64，复用同一 CSS 选择器、确认、草稿与权限流程；操作绑定打开时的键/字段引用和版本，不按截断显示名定位。完整小字段在只读分页中返回原始字节摘要；大字段、不完整名称引用没有编辑/删除按钮。确认信息同时展示键和字段，新增不会静默覆盖已存在字段。

所有字段修改 WATCH 整个哈希键。新增检验字段未存在；编辑/删除使用固定 EVAL_RO 检查 HSTRLEN 并仅在 16 KiB 以内读取完整字段，比较预览摘要，权限重检后 MULTI/EXEC HSET/HDEL。旧版本、删除/改类型、其它连接并发修改或权限变化都不自动覆盖或重试；HSET/HDEL 保留现有键 TTL。监视整个键会因其它字段变化而保守冲突，尚非细粒度字段事务；删除最后一个字段导致 Redis 键消失，由刷新后的不存在状态明确反馈。

真实 Redis 测试通过：重复新增拒绝、字段版本编辑、旧版本删除拒绝、读取与 EXEC 之间其它连接更新后的拒绝覆盖、TTL 保留、二进制字段引用与删除。实际桌面界面通过新增→编辑→删除字段及既有集合/命令/字符串操作回归；界面使用隔离模拟执行器，真实存储另外测试。大字段完整编辑、列表/集合/有序集合成员操作、SQL 数据库绑定、跨菜单草稿保护和整体安装包验收仍未完成，不据此标记全部 Redis 或 roadmap 完成。当前工作只在开发分支，安装版本与远程 API 未变更。

本轮最终 Redis 22 项回归全部通过、无跳过；最后的桌面 renderer 构建与 git diff --check 通过。

### 8.32 SQL 数据库绑定上下文接入层（2026-10-13）

新增 `workspace-sql-context.ts`，按 local/remote、工作区与远程用户范围隔离数据库元数据；远程范围必须显式提供用户身份。上下文不可变且有 30 秒有效期、单调递增版本，清理后重新绑定不复用旧版本。只复制方言、表名和字段名称/类型，不缓存连接配置或任意额外元数据字段；表/列数及序列化字节有资源边界，过大元数据明确拒绝，不声称完整加载。

共享 Monaco SQL provider 及其惰性加载器接受上下文读取回调，可组合已打开本地 DDL 与授权数据库结构，同名表的数据库列优先。补全结束前重新核对上下文版本/过期情况，切换连接、清空权限缓存或上下文过期时不发布旧列；旧 DDL 语法回退保持可用。这是后续连接选择和元数据传输的接入基础，不是项目绑定功能已交付。

验证：SQL 与既有编辑导航共 27 项测试通过，覆盖不同工作区/用户范围、不可变复制、额外密码字段不留存、精确到期、清理后新版本、连接切换期间旧响应拒绝、绑定列优先与过期候选清除。网页构建通过。连接/数据库选择界面、两端实际只读元数据请求、读前读后授权检查、自动列按需加载、偏好持久化与两端端到端验收仍待继续；本轮没有连接用户数据库、发布安装包或重启远程 API。

### 8.33 两端 SQL 连接/数据库/表选择与实际补全（2026-10-13）

工作区 SQL 文件增加共用 `WorkspaceSqlBinding`，使用 CSS Select 选择关系型连接、数据库和提示表；只在 SQL 文件展示，不让 Java/TS 打开即加载数据库结构。桌面使用本机连接列表和 metadata，网页使用授权数据源及新只读 metadata 路由；传输适配复用同一组件和上下文。只传连接 ID/数据库/表名，不传项目 SQL 内容、不会执行用户查询。所选表的列进入既有别名补全，数据库列优先于同名本地 DDL，包括默认 schema 下未限定 schema 的 DDL，方言变化也会重新解析本地声明。

新增服务端 `SqlMetadataDto` 和关系型 metadata 读取包装：读前读取已授权配置，读后重新核对数据源成员与配置，不返回已撤权或已变更连接的旧结果。桌面 metadata 也在读后重检连接凭据/配置及当前企业网络/连接器策略。结构返回最多 500 项且携带 truncated，不将部分列表表述为完整索引；元数据仅查询数据库目录/结构，不改变数据库或连接配置。

上下文 30 秒到期，活动页每 20 秒刷新结构；隐藏桌面项目暂停刷新并清除候选上下文，重新激活后读取。请求切换/卸载 AbortSignal 取消与旧结果丢弃，切换连接/数据库/表先清空旧候选。网页额外使用每个编辑器登录会话的单调编号隔离上下文，token 改变时换范围，不把 token 写入缓存键，也不要求 HTTP 页面支持 crypto.randomUUID。Monaco 提供器通过 ref 获取最新范围，不因 /auth/me 到达或连接切换而重建整个编辑器。

验证：SQL/编辑导航和服务权限单元测试 29 项通过；Local API 模拟慢元数据查询验证编辑连接后返回 409 而非旧私有表名。API、网页与桌面 renderer 构建通过。实际桌面界面选择连接→数据库→表后补全返回绑定列并排除同名 DDL 旧列，原文件未保存/修改；使用模拟数据库、元数据 calls 断言且执行查询接口故意抛错。生产网页完整导航/多文件预览/Markdown/UTF-16/DDL 回归通过，并验证同一选择条绑定后的数据库列建议；网页使用隔离鉴权 HTTP fixture，不等于已部署新 API，也不宣称已连通用户业务数据库。

尚待：按 SQL 引用自动加载多个表的列、跨 SQL/非 SQL 页签的绑定偏好持久化、复杂/非 public 远程 schema 标识符、真实数据库两端联调、刷新/撤权/后台状态更完整 UI 负例、新安装包发布回归，以及其它 roadmap 事项。当前明确选择“提示表”加载列，不把这个阶段缩写成所有 SQL 语义智能已完成。未重启远程 API 或替换客户端；前端上线须同步更新 metadata 路由。

### 8.34 SQL 绑定偏好保存与恢复（开发分支，2026-10-13）

共用工作区绑定组件保存连接 ID、数据库名与提示表名；不保存密码、SQL 文本、列结构或授权结果。桌面通过受启动令牌/同源保护的 Local API，按项目 ID 写入已有 SQLite 设置表，避免随机 API 端口导致浏览器存储跨重启失效。网页使用按用户和工作区隔离的浏览器 localStorage；不是服务器同步配置，清理浏览器数据会丢失。写入按同一工作区串行，避免连续切换后旧请求覆盖新选择。

打开 SQL 文件恢复时，先加载偏好，再读取当前授权连接列表、数据库列表和表列表，逐级核对引用；失效引用不进入智能提示。列结构仍从当前连接重新查询，沿用过期、撤权、配置变更与取消请求保护，不把上次保存的引用当成权限证明。切换非 SQL 文件再返回通过重新挂载恢复；SQL 文件之间共享工作区设置。

验证：新增 2 项测试通过，覆盖引用校验、额外密码/列字段剥离、未授权拒绝、无效连接拒绝及 Local API 重启持久化。网页与桌面 renderer 构建通过，隔离 Electron 实际界面验证绑定选择、数据库列补全、页面重载后连接/数据库/表自动恢复，测试项目文件未改变。界面数据库仍为模拟元数据，并非业务数据库联调；网页偏好恢复的独立浏览器回归尚待补充。未发布新安装包，未提交本开发分支。

仍待完成：复杂远程 schema、真实数据库两端联调，以及 Redis 更多集合编辑和 roadmap 后续事项。第 8.33 节的绑定持久化待办由本节替代；随后网页隔离回归已验证跨 SQL/Markdown 页签恢复，见第 8.35 节。不将这一步视为完整 SQL 语义能力或全部 IDE 目标完成。

### 8.35 SQL 引用表自动加载（开发分支，2026-10-13）

两端共用绑定组件接收当前 SQL 草稿，600 毫秒防抖后懒加载已有 SQL 解析器。按语法节点发现 FROM/JOIN、逗号表列表、UPDATE/INTO 和嵌套查询的表引用；不从注释/字符串提取，跳过表值函数和 CTE 名，嵌套 CTE 不污染外层范围。PostgreSQL 未引用标识符转小写，引用标识符保留大小写、空格与转义字符。这里只发现常见引用，不是完整数据库 SQL 语义分析器，不推导动态 SQL、视图输出或任意厂商特殊语法。

引用仅与当前授权 metadata 返回的表匹配，自动读取多表列后交给已有别名补全；不发送文件内容到数据库 API，不执行用户 SQL。修改连接、数据库、引用或停用项目时仍取消旧请求/丢弃结果，20 秒刷新和 30 秒上下文到期保持不变。单次列加载最多 8 表、并发最多 3；手动提示表排在自动引用之前，超出时界面说明“已加载前 8 张表 · 提示表可优先加载”。单文件解析上限 1,000,000 字符、自动匹配前 128 个引用，超出明确标识部分覆盖/可手动选择；不将资源限制描述为完整解析。列表沿用 500 项上限与截断标志。PostgreSQL 未限定 schema 暂按 public 匹配，不宣称已解析真实 search_path；远程非 public/复杂 schema 仍待完善。

验证：SQL 11 项测试通过，新增引用发现、CTE/嵌套范围、引用字符、小写折叠、资源边界回归。网页/桌面构建通过。隔离桌面实际界面验证 JOIN 两表列自动读取、别名候选隔离、绑定重载恢复；网页完整导航/混合文件/Markdown/UTF-16 回归通过，同时验证无需手选表的数据库列提示与跨 SQL/Markdown 页签绑定恢复。界面 metadata 为模拟授权服务，未执行 SQL；不等同于已部署新远程 API 或业务数据库联调。当前仍在独立开发分支，未重新安装客户端或提交发布。

### 8.36 Redis 集合/有序集合成员编辑（开发分支，2026-10-13）

共享 `RedisBrowser` 增加 Set 成员新增/删除与 ZSet 成员新增、分数编辑/删除。桌面个人版使用本机执行，不经过审批；操作确认仍保留，权限由 Local API 根据当前许可/企业策略确定，不信任请求体 readOnly。网页继续走授权只读服务，没有本机写入入口；不能将个人本地写权限扩大为远程数据源写权限。

成员引用支持 UTF-8/Base64，写入最多 8 KiB；分数只接受有限十进制/科学计数法数字，不接受 NaN、无穷或十六进制。编辑仅改变分数，不暗中重命名成员。新增检查已存在成员并拒绝覆盖；删除 Set 校验存在，ZSet 编辑/删除校验原始分数字符串。WATCH 当前集合、重新检查连接/权限、MULTI/EXEC 写入；并发集合/TTL 变化会失败而非覆盖，普通修改保留已有 TTL，删除最后一个成员时 Redis 自然删除空集合。Set 存在性/分数比较不是历史版本号，不能检测 WATCH 之前已经结束且最终状态相同的 ABA 变更；不宣称历史快照隔离。

界面仅为拥有完整成员引用的行提供操作；大于 1 KiB 的浏览成员仍只预览，不能用截断名删除/编辑，较大成员可使用受权限约束的命令编辑器。失败保留表单草稿，未保存变更接入现有退出检查。列表按索引修改/删除、集合创建类型选择、跨详情路由的草稿恢复、TLS/ACL/企业策略完整联调及发布仍待完成，不将本批表述为完整 Redis 管理工具。

验证：桌面 Redis 全套 20 项通过（启用真实 Redis 测试），含新增成员测试；随后加强的提交前撤权测试也通过。真实测试只创建并清理随机键，验证二进制成员、TTL、重复成员拒绝、旧分数拒绝与并发写入保护。API Redis 校验/权限/解析及真实服务只读、撤权/配置变更保护 4 项全部通过，无跳过；这不等于远程 API 已部署。桌面实际界面覆盖 Set 新增/删除、ZSet 新增/修改分数/删除及既有字符串/哈希/分页操作，使用模拟存储；网页隔离只读回归通过，增加写按钮隐藏断言。两端 renderer/web 构建与 diff 检查通过。客户端未重新安装，开发分支未提交发布。

### 8.37 Redis 列表按索引增删改（开发分支，2026-10-13）

共享列表详情增加从头部/尾部新增、编辑指定索引、删除指定索引；个人版本机执行仍无需审批，保留操作确认。表单保存读取时的键、非负索引、列表长度和完整值 SHA-256，不能因另选键而改写目标。列表预览仅对完整的 1 KiB 内行附加版本并展示编辑/删除；写入支持 UTF-8/Base64、空值，每次最多 16 KiB。新增检查已有列表类型/长度；编辑/删除检查类型、长度、索引及该位置值版本，WATCH 后再次复核权限并用 MULTI/EXEC 执行，列表或 TTL 在提交前变化则拒绝，不覆盖其他位置。

删除使用应用固定的单键脚本，从较近端移动相邻值，再弹出端点；不用 LREM 按值删除，也不使用临时占位值，因此重复值、空值、二进制值不误匹配，未删除项顺序保持。与读取脚本分开：可视化写入口内部使用固定 EVAL，命令编辑器仍不允许任意 EVAL/上传脚本。脚本写前校验所需命令 ACL（[Redis Lua API](https://redis.io/docs/latest/develop/programmability/lua-api/)），预读所有待移动值并检查资源预算，再写入；尚未做独立受限 ACL 实例联调，不将默认用户测试当成所有权限组合已覆盖。

可视化删除最多移动 1000 项，每项不超过 16 KiB、累计不超过 1 MiB；超出移动距离的按钮禁用，超大相邻值/累计预算由服务端拒绝，拒绝时不做索引移动。只删除一个索引；最后一项删除后 Redis 自然删除键，其余修改保留 TTL。Lua LINDEX 对超大相邻值仍会产生服务器临时内存，资源预算不是 Redis 峰值内存绝对上限；脚本/事务也不等于任意运行错误自动回滚。网络超时、异常中断后应刷新确认状态，不盲目重试。长度/值比较不能检测 WATCH 开始前已结束且最终状态相同的 ABA 变更；不宣称稳定条目 ID 或历史快照隔离。

验证：桌面/API Redis 全套 26 项通过，无跳过；真实列表测试覆盖重复值精确删除、左右两侧移动、二进制/空值、TTL 保留、单项删除、旧长度/值拒绝、提交期间列表变化、提交前撤权与超大移动拒绝后列表不变。测试只创建并清理随机键。隔离桌面界面覆盖后续页索引编辑、精确删除及头部新增，数据存储为模拟服务；网页列表预览及写按钮隐藏回归通过，远程仍只读。网页/桌面 renderer 构建及 diff 检查通过。本批不代表全部 roadmap 完成：类型化新建集合、跨详情草稿恢复、企业策略/TLS/受限 ACL 联调和安装包发布仍待继续；未安装或提交本开发分支。

### 8.38 Push 自动构建桌面安装包（2026-10-13）

新增 `.github/workflows/desktop-build.yml`：所有分支/tag 的 push 与手动 workflow_dispatch 触发，不使用路径过滤，不因后续 push 取消前一次构建。并行原生 runner 构建 macOS x64/arm64 DMG+ZIP、Windows x64 NSIS Setup EXE+Portable EXE；Windows 两种输出设置不同文件名，避免互相覆盖。Windows renderer 通过 cmd.exe 运行固定 npm 命令，避免直接 spawn npm.cmd 的平台错误。Action 固定提交哈希，仓库只读权限、不保留 checkout 凭据，不传入签名密钥；`--publish never` 不自动创建 Release。

安装依赖使用 npm ci 与锁文件；语言工具缓存按操作系统、架构及安装脚本哈希隔离。每个构建校验两种预期包存在且非空，生成 SHA256SUMS.txt/build-info.json，再上传 Actions Artifacts（名称含完整提交 SHA，保留 14 天）。到仓库 Actions → Desktop packages → 对应运行下载平台产物；包内含 JDT LS、Lombok、Java debug 工具，Java 项目仍需要用户本机 JDK。CI 包没有 Developer ID 公证或 Windows 可信证书签名，系统安全提示仍可能出现；不是正式签名发布/自动更新验收。

本机测试只能验证当前 macOS 平台；Windows/Intel macOS 实际构建与运行结果须以首次 Actions 运行及目标系统安装验证为准，不以 YAML 校验代替。该流程从包含 workflow 的提交 push 开始生效；旧提交不会追溯触发。收费/分钟数依仓库 GitHub Actions 配额，默认未增加公开 Release 发布。

本批本机 macOS arm64 使用 workflow 同一打包命令成功生成 DMG/ZIP，3 项配置/产物校验测试与 electron-builder JSON schema 校验通过；未替换已安装客户端。Windows 与 Intel 构建等待首次云端结果。

首次云端构建在 Java 调试插件冷下载时暴露 HTTP 编码问题：Marketplace 即使收到 Accept-Encoding: identity 仍返回 Content-Encoding: gzip，旧脚本将压缩响应直接交给 ZIP 解压器，导致 central directory 错误。已改为按 HTTP 编码流式解码 gzip/deflate/br，对传输和解码后的数据分别限制 100 MiB，处理截断/异常响应；VSIX 格式检查及提取后固定 JAR SHA-256 校验保持启用。桌面包装脚本与共享模块入口同步调整，CI 加入下载解码回归。5 项下载/打包配置测试通过，禁用本机 Maven/VS Code 缓存的真实网络安装及两个 JAR 哈希校验通过；这证明下载故障修复，不代替新的 Windows 完整打包结果。

### 8.39 macOS 本机调试签名与下载分发边界

此前 Actions 使用 CSC_IDENTITY_AUTO_DISCOVERY=false 完全跳过签名，本机按相同配置生成的应用 codesign 校验报“code has no resources but signature indicates they must be present”；构建成功不等于有效应用签名。mac.identity 改为显式 `-`，自动 ad-hoc 签名，配置 Electron JIT/本机原生模块所需 entitlements，保留 hardened runtime。只忽略 JDT 的 `org.eclipse.equinox.app` 数据目录（名称像应用但不是应用 bundle），不会跳过真实 Electron helpers。共享语言包新增 npm files 白名单，但本机实际 ASAR 检查仍发现 electron-builder 依赖收集夹带缓存；不能将白名单视为彻底消除缓存夹带的验证结论，后续需完善依赖文件过滤。JDT/Java tools 的正式资源入口仍为 extraResources。

本机无需付费证书、Apple 登录或网络公证即可运行开发模式/构建调试包。`npm run desktop:dev` 启动源码客户端；`npm run dist:mac --workspace apps/desktop -- --arm64 --publish never` 构建 Apple Silicon 包（Intel 使用 --x64）。自动构建解开实际 ZIP，再做 codesign --verify --deep --strict，通过才上传；build-info 标识 ad-hoc/non-notarized，不冒充 Developer ID 正式签名。

ad-hoc 保证签名完整性，不代表通过浏览器下载后的 Gatekeeper 信任。正式分发还需 Apple Developer Program 的 Developer ID Application 证书和 Apple 公证，参见 [Apple Developer ID](https://developer.apple.com/developer-id/)；相关私钥/密码应放受保护的 CI secrets，不写入仓库或聊天。本批不自动配置/使用开发者账户，不关闭 Gatekeeper 或删除下载隔离标记。本机成功启动不能代替隔离下载场景验收。

### 8.40 本机安装与统一标题（2026-10-13）

网页 index.html 标题、登录页旧平台标题及侧栏 tooltip 改为 `code studio`；桌面窗口标题固定同一名称，防止页面 title 更新重新覆盖。品牌回归测试、网页生产构建、macOS arm64 DMG/ZIP 构建通过。

已安装并打开 `/Applications/Code Studio.app`，未改用户数据；本次目标路径原本不存在，没有移除旧应用或备份。安装应用的 ad-hoc 深度/严格签名校验通过，安装 ASAR 与构建产物相同，SHA-256 为 `dd28115f76ff226bf962d332582cd5d6104e1e00df185277837153046bc51c1a`。实际已安装进程的本地 HTTP 页面标题为 code studio，健康接口返回 ready / desktop-local / community / remoteApiRequired=false。该验收是本机安装与启动，不代表浏览器隔离下载或 Developer ID 公证验收；未部署远程网页服务。

## 9. 数据源管理与 Git 版本管理补齐（2026-10-10）

### 9.1 数据源：同一详情组件，本机执行

桌面关系型数据库详情直接复用网页版 `DbQueryPage`，通过可选 `DbQueryTransport` 替换请求层，保留数据库/表列表、表结构、SQL 编辑器和结果表布局。个人版 SQL 在本机执行，不走远程审批；数据库账户自身的权限仍由数据库决定。数据源支持编辑已有连接，保存保留原 ID；密码留空保留加密凭据，修改密码才替换，接口不返回明文。主机填写 IP/域名，端口单独填写；支持 IPv6，拒绝把 `10.62.172.112:5432` 当作 DNS 主机。

本地 metadata API 支持 PostgreSQL/MySQL 数据库、表和列；所选数据库只影响本次查询，不覆盖保存的连接配置。表/列元数据查询参数化，SQL 标识符独立引用；元数据最多 500 行，并明确提示截断。详情查询和缓存按连接 ID/更新时间隔离，不请求远程数据源 API。

已验证：连接编辑及凭据保留/替换/重启持久化测试、PostgreSQL/MySQL 元数据测试、真实 PostgreSQL 本机 CRUD 测试、Electron 编辑→详情→表结构→SQL 结果回归。真实数据库测试只创建并清理随机测试 schema，不使用用户业务表。

能力边界：桌面导入、导出、备份和迁移入口保留同一布局，但尚未接入本地执行，当前禁用并给出说明；不能视为所有数据库高级管理功能已经完成。

### 9.2 Git 问题审核与实现

| 原问题 | 本次处理 |
| --- | --- |
| 新建分支使用 Electron 不支持的 `window.prompt` | 复用应用 CSS 输入弹窗，调用本机 Git 校验、创建并切换分支 |
| “历史”页签只有工作区代码/未提交变更 | 复用网页版 `HistoryPanel`，接入本机提交历史与提交差异，按 100 条分页 |
| 提交选中文件混入其他已暂存文件 | literal pathspec + `git commit --only`，保留未选文件的暂存状态；包含重命名源路径并区分已暂存删除 |
| 分支切换后文件内容与行号缓存仍沿用旧分支 | 刷新文件快照、清空文件缓冲/光标历史、重新读取活跃文件，并同步 Monaco 保留的模型 |
| 未跟踪文件无法看差异 | 使用只读 no-index 差异；新增文件逐个展示，不合并为目录项 |
| 空仓库分支名异常、子目录工作区路径错误 | symbolic-ref 获取实际分支；Git 状态路径转为工作区相对路径 |
| 任意 Git 失败仅显示“本地操作失败” | Git 错误返回 409 和具体原因，不隐藏分支校验/切换失败原因 |
| 历史恢复可能覆盖编辑草稿/未提交代码 | 前端拒绝存在未保存草稿；后端拒绝仓库存在未提交或未跟踪文件；恢复生成新提交，保留原历史，不使用 hard reset |

提交、切换、同步和恢复在同一工作区内串行执行，减少 index.lock 竞争。Fetch/Pull/Push 保留企业主机策略检查，Pull 后刷新文件快照；另选远程推送时不静默忽略用户所选远程。编辑器有未保存修改时阻止分支切换/Pull；所选提交文件未保存时先要求保存。

历史差异支持首个提交、删除、重命名与第一父提交比较；二进制和超大文本显示不可预览说明。文本预览单文件 256 KiB、累计 8 MiB；单次提交超过 100 个变更文件时明确提示使用 Git 工具，不静默截断。历史由本机 Git 仓库提供，不上传代码或提交记录。

验证脚本：`test/local-git-history.test.cjs`、`scripts/smoke-git-workspace.cjs`；覆盖首次提交、分页、子目录范围、选择提交隔离、已暂存重命名、历史差异、恢复保护、CSS 分支弹窗、连续分支切换和编辑器草稿保护。以测试实际结果作为验收，不将尚未通过的界面回归提前视为完成。

本批验收结果：相关 API 回归 26 项通过、1 项真实 PostgreSQL 测试按环境开关跳过（该项在数据源开发阶段已独立通过）；数据源与 Git 的 Electron 界面回归均通过；TypeScript/renderer 构建与 `git diff --check` 通过。macOS arm64 客户端已重新打包并替换 `/Applications/Code Studio.app`，旧版本备份为 `/Applications/Code Studio.app.backup-20261010-223540`，未删除用户数据。安装后的 `app.asar` 与构建产物 SHA-256 均为 `6464fce931cd187970b6d22e0cea3ee35d2784a0c78970a2a517403722deac9d`。本机测试构建尚未进行 Developer ID 签名与公证，不是公开发布验收。

后续版本管理待办：远程分支管理/跟踪分支专用界面、分支删除/重命名、stash、合并/变基及冲突解决器、提交身份与远程凭据设置界面；当前可用本机 Git/终端执行，不等于这些完整 IDE 功能已实现。快速索引层仍按第 8 节分步实施，本批不标为完成。
