# 单文件构建与 tag 发行

面向维护者。Rovloom 用构建时的 **Bun**（CI 使用最新稳定版，实际版本记录在 manifest 的 `bun` 字段）通过 `bun build --compile` 分发单文件可执行程序。发行构建直接使用 `src/cli/main.ts`，不生成替代 CLI。日常源码构建仍用 `bun run build`。

## 构建与验收

在仓库根目录冻结安装依赖后执行：

```sh
bun run release:build
bun run release:smoke /absolute/path/to/dist/release/bun-linux-x64/candidate/rovloom
```

输出在被忽略的 `dist/release/<target>/candidate/`，包含 binary 与构建清单。`release:smoke` 把 binary 复制到临时目录，以空 PATH、新 HOME 和不含源码的 cwd 执行帮助、版本、模板与参数拒绝，并检查退出码和 stdout/stderr。

[Standalone CI](../.github/workflows/standalone.yml) 在六个原生 runner 上编译并执行：

- 服务生命周期模型与原生服务定义解析测试，用户安装器的隔离测试。
- 打包设施探针（`packaging-probe`）：检查 Worker、静态 helper、WebUI 原字节与内存 SQLite，并用漏掉 Worker 的反例验证缺包会失败。
- 产品候选的 `release:build` 与 `release:smoke`；Windows 另验证 EXE 图标与控制台子系统。
- 一次性服务生命周期验收：在一次性托管虚拟机上走真实 OS 服务注册。
- [产品 smoke](../scripts/release/product-smoke.mjs)：六个平台都运行[Gateway smoke](../scripts/release/gateway-smoke.mjs)，验证认证 MCP、管理页白名单资源、正常关闭与 Luvus/Herdr schema 工厂。Linux x64 另运行[双角色 smoke](../scripts/release/dual-role-smoke.mjs)：从同一 binary 启动 Gateway 与 Connector，经回环 WebSocket 接纳合成设备身份，调用官方 Herdr 的 `ping`，经 MCP 读回持久化结果。其余五个平台返回 `connector: unsupported`。

smoke 不调用模型、不使用真实外部凭据、不安装系统服务（服务验收除外）。官方 Herdr 下载使用固定 SHA256、大小和时间限制，只在本轮私有目录运行。该 CI 只上传短期 Actions artifacts，不签名、不发布 Release。

常规 PR 门禁见 [CONTRIBUTING](../CONTRIBUTING.md) 与 [Bun verification](../.github/workflows/bun.yml)：`lint`、`format:check`、`typecheck`、`test`、`build`、`smoke`。

## Tag 发行门禁

[发行 workflow](../.github/workflows/release.yml) 仅由推送 `v*` tag 触发，没有手工发布入口。

**版本规则。** 合法 tag 为 `vMAJOR.MINOR.PATCH[-PRERELEASE]`：数字不带前导零，预发布标识遵循 SemVer，不接受 `+build`。唯一规则是 `tag.slice(1) === package.json.version === src/mcp/version.ts 的 PRODUCT_VERSION`。发布不改写版本，也不从环境变量覆盖。先让源码版本一致并通过评审，再创建 tag。

**流程。**

1. `validate`：重新读取远端 tag（lightweight 与 annotated 均可），核对提交 SHA 与版本一致性。
2. `quality`：复用完整 Bun verification。
3. `preflight`：在 Linux x64 上构建真实产品并跑完整产品 smoke。
4. `build`：六项矩阵分别在原生 runner 上重新编译，运行产品 smoke，上传收据与 binary。
5. `publish`：核对恰好六项产物后创建草稿 Release、上传资产，校验通过才公开。

任何步骤失败都不公开 Release。只有 `publish` 具有 `contents: write`，其他 job 只有 `contents: read`，checkout 不保留凭据。流程不需要 PAT、长期秘密、签名服务或 OIDC 权限。

产品清单 [product.mjs](../scripts/release/product.mjs) 把 `releaseSmoke` 指向 `scripts/release/product-smoke.mjs`。该脚本收到绝对 binary 路径与不含 `v` 的精确版本，成功退出才产生发行收据。help/版本检查、设施探针或模块测试都不能替代它。

### 支持矩阵

[platforms.json](../scripts/release/platforms.json) 是唯一矩阵，同时决定 native CI、tag 构建与资产契约：

| OS | arch | libc | Bun compile 目标 | GitHub 原生 runner |
|---|---|---|---|---|
| linux | x64 | glibc | bun-linux-x64 | ubuntu-24.04 |
| linux | arm64 | glibc | bun-linux-arm64 | ubuntu-24.04-arm |
| darwin | x64 | null | bun-darwin-x64 | macos-15-intel |
| darwin | arm64 | null | bun-darwin-arm64 | macos-15 |
| windows | x64 | null | bun-windows-x64 | windows-2025 |
| windows | arm64 | null | bun-windows-arm64 | windows-11-arm |

目标依据 [Bun CompileTarget](https://github.com/oven-sh/bun/blob/main/packages/bun-types/bun.d.ts)、[Bun executables 文档](https://bun.com/docs/bundler/executables)和 [GitHub runner 列表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。官方归档中的 `aarch64` 在产品契约里写作 `arm64`。不提供 musl、32 位、其它 arch 或模拟执行的资产。

每个目标都必须在对应原生 runner 上通过 Gateway 产品 smoke。完整双角色原生 smoke 只在 Linux x64 运行；Windows x64 Connector（附着 Herdr / Luvus、开机任务、崩溃清理）由独立的 [Windows e2e](../.github/workflows/windows-e2e.yml) 验收。Windows 两种 arch 都要求原生图标资源检查，交叉编译不能替代。

### 资产与 manifest 契约

官方来源固定为 `ArnoChenFx/rovloom` 的 GitHub Releases。每次发行恰有六个原始单文件 binary、`release-manifest.json` 与 `SHA256SUMS`，不上传探针、构建清单、源码目录、用户配置、数据库或凭据。binary 命名为 `rovloom-<version>-<os>-<arch>`，Windows 追加 `.exe`，`<version>` 不含 `v`。

`release-manifest.json` 为 UTF-8 JSON，两空格缩进，字段与矩阵顺序固定，末尾 LF，不含时间戳或 runner 路径：

| 字段 | 契约 |
|---|---|
| schemaVersion | 数字 `1` |
| repository | 固定字符串 `ArnoChenFx/rovloom` |
| tag / version | 精确原 tag / 去掉开头 `v` 的版本 |
| commit | tag 对应的完整 40 位小写提交 SHA |
| bun | 构建所用 Bun 版本（仅记录，不校验） |
| assets | 按矩阵顺序排列的六项数组 |
| assets[].os / arch / libc | 上表标识；非 Linux 的 libc 为 JSON null |
| assets[].name | 精确下载文件名，不是路径或 URL |
| assets[].size | 正整数，binary 字节长度 |
| assets[].sha256 | binary 字节的 64 位小写 SHA256 十六进制 |

下载路径固定为 `https://github.com/ArnoChenFx/rovloom/releases/download/<tag>/<name>`，manifest 来自同 tag 的 `release-manifest.json`。消费方必须精确匹配 OS/arch/libc、版本、资产名、长度和摘要，拒绝未知 schema 或平台，不接受 manifest 自报的其它仓库或下载 URL。

版本带预发布标识即为预发布，不会成为 latest；稳定版使用 `make_latest: legacy`，避免后补的旧 tag 抢占 latest。`SHA256SUMS` 每行为 `<sha256>  <name>`，先列六个 binary，最后是 manifest，自身不入列。摘要保证字节完整性，不是发布者签名。真实发布者签名和 macOS 公证未配置，Bun 自带的本机签名不构成发行者认证。

### 失败、重跑与不可覆盖

同一 tag 的发行串行执行，不取消进行中的运行。构建 artifacts 按校验 job 的运行尝试编号隔离：重跑失败 job 沿用同一集合，重跑全部 job 生成新集合，不会混用其它 tag、提交或不完整矩阵。聚合前后都会重新解析远端 tag，tag 被移动时拒绝发布。

发布器只创建带精确 tag/commit 标记的 draft。每个资产上传后，GitHub 返回完整资产集合、`uploaded` 状态、精确长度和 SHA256，才会把 `draft` 改为 false。中断可能留下未公开的草稿，重跑只补齐完全一致草稿的缺失资产。同名资产、额外资产、不同提交或不同字节都会失败，既不删除也不覆盖。已公开且字节一致的发行重跑只读成功；重新构建出不同字节也拒绝覆盖，因为 Bun 产物不保证跨运行逐字可复现。冲突的草稿由维护者核实后处理，已公开版本的修正使用新版本和新 tag。

### 发行后核验

[Verify published release](../.github/workflows/verify-release.yml) 手动触发：从真实公开 Release 下载六平台二进制，按 `SHA256SUMS` 校验并运行 `--version`；同时在六个平台运行官方安装器，确认 latest 稳定路径可用。它不构建，也不写仓库。

## Worker 与内置资源接口

[产品清单](../scripts/release/product.mjs)维护真实入口、附加 Worker 和受控资源，[构建器](../scripts/release/build.mjs)按同样的显式清单编译。

- Worker 必须列为额外 entrypoint，文件名唯一，宿主用 `new Worker(new URL('./worker-name.ts', import.meta.url))` 引用同目录文件。
- 受控 helper、Ajv standalone 产物和 schema 通过静态 import，或 `with { type: 'file' }` 导入后读取嵌入路径。不能从 cwd 补包或调用外部 Bun。
- schema 工厂的 `compiler-worker.ts` 须配合 `compilerWorkerPlugin()` 打包，不能绕过插件直接编译原始入口。CI 的 [native-smoke](../scripts/release/native-smoke.mjs) 验证真实异步编译与离线 schema 数据保真。
- 构建专用模块 `rovloom:management-assets` 导出 `loadEmbeddedManagementAssets()`，返回管理 HTTP 桥所需的内存 `ManagementAssets` Map，内容为 WebUI 构建的白名单资源：HTML、JS/chunks、CSS、应用标和横版全名图。资源缺失必须失败。嵌入内容不含测试页面、运行状态、凭据、用户配置或外部 Luvus/Herdr binary。

## Windows 程序图标

唯一来源是已提交的[透明背景多尺寸 ICO](assets/brand/rovloom-icon.ico)（16/24/32/48/64/128/256，每帧为 32 位 RGBA PNG）。它由[维护脚本](../scripts/maintenance/make-windows-icon.py)从透明的[横版全名原图](assets/brand/rovloom-logo.png)取出橙色 R 缩放生成；构建只按原字节复制，不在构建时缩放或重绘。

Windows 本机编译传入 `windows.icon`，保持控制台子系统以支持 CLI 诊断与交互。CI 解析实际 EXE 的 `RT_GROUP_ICON`/`RT_ICON`，逐帧比对受管 ICO 并核对控制台子系统。构建器拒绝从非 Windows 主机生成带品牌图标的 Windows 产物。

## 用户安装器

[install.sh](../scripts/install.sh) 与 [install.ps1](../scripts/install.ps1) 始终安装官方 `latest` 稳定 Release，没有版本参数。每次只解析一次稳定 tag，再从该 tag 下载 `SHA256SUMS` 和精确 OS/arch 资产，安装期间 latest 切换不会混用版本。

- Linux 只接纳 glibc；macOS 支持 x64/arm64；Windows 按原生 OS 架构选择，而不是进程架构。
- 脚本不需要 Bun 或 Node，在用户目录暂存，校验摘要后在同一文件系统内原子替换；下载、校验或替换失败保留既有程序。
- 不创建配置或身份，不安装系统服务，不修改 PATH。
- [隔离安装测试](../test/release/install.test.mjs)用合成下载在六平台运行，Windows 另运行[原生 PowerShell 替换测试](../test/release/install-windows.ps1)。

安装命令见 [Quick Start](QUICK-START.md) 与 [快速开始](QUICK-START-zh.md)。

## 容器镜像

[容器 workflow](../.github/workflows/container.yml) 构建 Linux Gateway 镜像，部署方式见 [Docker deployment](DOCKER.md) 与 [Docker 部署](DOCKER-zh.md)。

- PR 与 main 只构建并在原生 `amd64`、`arm64` runner 上启动测试，不登录也不推送 registry。
- 正式发布只在官方 `Tagged product release` 成功后触发：先核验 tag、commit、公开 Release、六平台清单与 `SHA256SUMS`，再用其中两个 Linux binary 构建镜像。
- 两个架构测试都通过后，发布 job 以临时 `GITHUB_TOKEN` 和最小 `packages: write` 推送 GHCR，并创建带实际版本的多架构 manifest。`latest` 只指向当前官方最新稳定版的同批镜像。
- 已有版本只有在两个完整镜像摘要与本次已测试产物完全一致时才复用，用于补齐失败的 latest 步骤；字节不同或 registry 查询不确定时拒绝覆盖。
- 容器 smoke 在无外网的临时容器和私有命名卷中核对非 root 运行、准确的 binary 摘要、单文件首次配置、真实数据库、MCP 401、内置管理资源、正常终止和重启持久性。
- GHCR 新包默认是 private。维护者需在首次发布后确认包为公开、且仓库有写入权限；工作流不修改账号或包设置。匿名拉取失败时先检查这两项，不要加入长期 token。

## 更新

Rovloom 不提供自更新。升级就是下载新的发行资产（或重新运行安装器）并替换可执行文件。
