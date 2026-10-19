# 单文件构建与 tag 发行

Rovloom 使用固定 **Bun 1.4.3** 的 `bun build --compile` 分发单文件可执行程序。
源码开发的模块构建仍用 `bun run build`。发行构建直接使用 `src/cli/main.ts`，
不会生成替代 CLI 或装配第二套 Gateway/Connector。
该入口未合入时，`bun run release:build` 明确失败；设施探针通过不能证明产品可用。

## 构建与验收

在仓库根目录冻结安装依赖后执行：

```sh
bun run release:build
bun run release:smoke /absolute/path/to/dist/release/bun-linux-x64/candidate/rovloom
```

输出在被忽略的 `dist/release/<target>/candidate/`，包含 binary 与构建清单。
构建清单分别保留 runtime 和产品接线待验状态；构建成功不能自动改为验收通过。
smoke 只复制 binary 到临时目录，以空 PATH、新 HOME 和不含源码/node_modules 的 cwd
执行帮助、版本、模板与参数拒绝，检查退出码和 stdout/stderr。它不证明真实 MCP 调用、
生产管理员认证、双机角色或 Luvus/Herdr 服务已经接通。

[本机 CI](../.github/workflows/standalone.yml)按下述六项原生矩阵编译、执行。
真实入口缺失时，仅上传明确标为 `packaging-probe` 的设施探针；它检查 Worker、受控静态 helper、
WebUI 原字节及内存 SQLite，并用漏掉 Worker 的反例验证缺包失败。
探针不代表生产 Ajv 工厂或宿主接线。真实入口存在时另行上传 `cli-preview-candidate`。
该 CI 只上传短期 Actions artifacts，不签名、不发布 GitHub Release。

## Tag 发行门禁

[发行 workflow](../.github/workflows/release.yml)仅由用户推送 `v*` tag 触发，没有手工发布入口。
合法版本为规范 `vMAJOR.MINOR.PATCH[-PRERELEASE]`：数字不带前导零，预发布标识遵循
SemVer，数字必须可精确比较；不接受 `+build`，避免同版本别名和下载名歧义。
唯一规则是 `tag.slice(1) === package.json.version === src/mcp/version.ts 导出的 PRODUCT_VERSION`。
发布不改写版本、不从环境变量覆盖版本。准备发行时须先让源码版本一致并通过评审，再创建 tag；
例如 `v0.1.1` 仅说明格式，本文和测试不会创建它。

所有发行 job 精确 checkout 事件的完整提交 SHA。校验 job 重新读取远端 tag，支持
lightweight/annotated tag；提交不符即失败。随后复用完整 Bun verification，包括 Oxc、
中文注释、Python 维护测试、输入审计、冻结安装、严格类型、全仓测试覆盖、构建及隔离 smoke。
Linux 真实产品打包 smoke 通过后才启动六项矩阵；每项都重新编译并在原生 runner 运行产品 smoke。
任何步骤失败都不公开 Release。仅最后的 publish job 具有 `contents: write`，其他 job
仅 `contents: read`；checkout 不保留凭据。不需要 PAT、长期秘密、签名服务或 OIDC 权限。

产品入口尚未交付时发行不可用。[产品清单](../scripts/release/product.mjs)的 `releaseSmoke`
当前为 `null`，必须由真实 HTTP 产品接线改为受维护的 `scripts/release/<name>.mjs`。
该程序由固定 Bun 调用，收到两个参数：绝对 binary 路径与不含 `v` 的精确版本，
成功退出才允许产生发行收据。它必须只复制此 binary 到空 cwd/PATH、新用户目录，
用临时配置启动真实持久 Gateway，验证 HTTP 就绪、同一入口的实际 MCP 通道、
内置 WebUI 完整白名单资源与真实 schema Worker；关闭服务后检查进程退出。
无外部 Luvus/Herdr 服务的回归不能冒充原生副作用验收。
该脚本及产品装配由 CLI 实现负责，本发行设施不创建替代入口或测试服务器。
只有 help/版本、设施探针、模块测试或人为 ready 标志都不能替代这个产品验收。

### 支持矩阵

[唯一矩阵](../scripts/release/platforms.json)同时决定 native CI、tag 构建、工具链归档校验和与资产契约：

| OS 标识 | arch | libc | Bun compile 目标 | GitHub 原生 runner |
|---|---|---|---|---|
| linux | x64 | glibc | bun-linux-x64 | ubuntu-24.04 |
| linux | arm64 | glibc | bun-linux-arm64 | ubuntu-24.04-arm |
| darwin | x64 | null | bun-darwin-x64 | macos-15-intel |
| darwin | arm64 | null | bun-darwin-arm64 | macos-15 |
| windows | x64 | null | bun-windows-x64 | windows-2025 |
| windows | arm64 | null | bun-windows-arm64 | windows-11-arm |

目标依据固定版本的 [Bun CompileTarget](https://github.com/oven-sh/bun/blob/bun-v1.4.3/packages/bun-types/bun.d.ts)、
[官方 executables 文档](https://bun.com/docs/bundler/executables)和
[GitHub runner 列表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。
工具链 SHA256 来自 [Bun 1.4.3 官方校验和](https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/SHASUMS256.txt)，
安装器先核对归档字节与成员，再使用原生 executable；官方归档的 `aarch64` 在产品契约统一写作 `arm64`。
不提供 musl、32 位、其它 arch 或模拟执行的发行资产；runner 系统版本不代表已验证所有更旧系统。
支持目标须在该次 tag 的原生产品 smoke 全部通过后才实际交付。
Windows 两种 arch 均要求原生 Windows 图标资源检查；不能用跨编译代替。

### 资产与更新器契约

官方来源固定为 `ArnoChenFx/Rovloom` 的 GitHub Releases。
每次发行恰有六个原始单文件 binary、`release-manifest.json` 与 `SHA256SUMS`，
不上传探针、构建清单、源码目录、用户配置、数据库或凭据。
binary 命名为 `rovloom-<version>-<os>-<arch>`，Windows 追加 `.exe`；version 不含 `v`。
例如 Linux x64 对应 `rovloom-0.1.1-linux-x64`。

`release-manifest.json` 为 UTF-8 JSON、两空格缩进、固定字段及矩阵顺序、末尾 LF，
无时间戳、runner 路径或私有配置。公开字段如下：

| 字段 | 契约 |
|---|---|
| schemaVersion | 数字 `1` |
| repository | 固定字符串 `ArnoChenFx/Rovloom` |
| tag / version | 精确原 tag / 去掉开头 `v` 的版本 |
| commit | tag 对应完整 40 位小写提交 SHA |
| bun | 固定字符串 `1.4.3` |
| assets | 按矩阵顺序排列的六项数组 |
| assets[].os / arch / libc | 上表的标识；非 Linux 的 libc 为 JSON null |
| assets[].name | 精确下载文件名，不是路径或 URL |
| assets[].size | 正整数，原始 binary 字节长度 |
| assets[].sha256 | binary 字节的 64 位小写 SHA256 十六进制 |

下载路径固定为 `https://github.com/ArnoChenFx/Rovloom/releases/download/<tag>/<name>`，
manifest 也来自同 tag 的 `release-manifest.json`。不接受 manifest 自报的其它仓库、镜像或下载 URL。
更新器应精确匹配 OS/arch/libc、manifest 版本、资产名、长度和摘要；未知 schema/平台应拒绝。
稳定版与预发布版由版本是否带预发布标识决定；预发布不会成为稳定 latest。
稳定版用 GitHub 的 `make_latest: legacy` 避免后补旧 tag 强制成为 latest；
更新器仍须自行比较规范版本并筛选稳定通道。
`SHA256SUMS` 使用 `<sha256>  <name>\n`，先列六个 binary，最后列 manifest 的摘要；
manifest 不包含自身摘要，校验和文件也不自引用。摘要提供字节完整性，不是发布者签名。

### 失败、重跑与不可覆盖

同一 tag 使用 workflow concurrency 串行且不取消正在运行的发行。
构建 artifacts 以校验 job 的运行尝试编号隔离；重跑失败 job 继续使用同一 artifact 集合，
重跑所有 job 则生成新集合，不能混用其它 tag、提交或不完整矩阵。
聚合器先核对恰好六项目录、各项收据中的 tag/commit/版本及实际文件字节，再使用写权限。
上传前、公开前均重新解析远端 tag；移动 tag 不允许发布到旧提交。

发布器先查包含草稿的 Release 列表，只创建带精确 tag/commit 契约标记的 draft。
上传每个缺失资产后，必须由 GitHub 端返回完整资产集合、`uploaded` 状态、精确长度和 SHA256
才会将 `draft` 改为 false。中断可能留下未公开的草稿；重跑只补齐完全一致草稿的缺失资产。
已有同名资产、额外资产、不同提交/说明、缺失摘要或不同字节都失败，不删除或覆盖。
已公开且完整同字节的发行，重跑只读成功；重新构建得到不同字节也拒绝覆盖，
不承诺 Bun 产物跨运行逐字可复现。冲突草稿须由维护者核实并显式处理，随后重跑所有 job；
已公开版本的修正使用新的规范版本和 tag。

真实发布者签名及 macOS 公证未配置；Bun 自身生成的本机签名不构成发行者认证。
本流程不申请 `id-token` 或 `attestations` 写权限，也不声称提供 keyless provenance。

## Worker 与内置资源接口

[产品清单](../scripts/release/product.mjs)维护真实入口、附加 Worker 和受控资源，
[构建器](../scripts/release/build.mjs)也可由测试或可信构建脚本传入同样的显式清单。
Worker 必须列为额外 entrypoint；入口输出统一使用唯一文件名，普通 Worker 宿主使用
`new Worker(new URL('./worker-name.ts', import.meta.url))`，源码中与该 Worker 同目录。
Worker 文件名必须唯一。受控 helper、Ajv standalone 产物和 schema 通过静态 import，
或 `with { type: 'file' }` 导入后读取嵌入路径；不能从 cwd 补包或调用外部 Bun。
schema 工厂的 `compiler-worker.ts` 及 `compilerWorkerPlugin()` 列入固定接入边界：
构建器必须应用工厂自带的受控 Blob 定位插件并 bundle 依赖，不能绕过插件直接编译原始入口。
其最终实现合入后，CI 另运行 `scripts/release/native-smoke.mjs`，验证真实异步编译、
29 份离线 schema 和原生错误数据保真；验收通过前仍是待接线候选。

构建专用模块 `rovloom:management-assets` 导出 `loadEmbeddedManagementAssets()`，
返回现有管理 HTTP 桥接受的 `ManagementAssets` 内存 Map。
可信宿主将该 Map 注入既有 `createManagementReadHandler` 或 `startManagementReadListener` 的 `assets`；
构建本身不启动 listener，也不提供默认身份或认证。
资源沿用同一 WebUI 构建与现有白名单，包含 HTML、JS/chunks、CSS、独立应用标和横版全名原图。
显式嵌入的受管静态资源不含测试页面、SQLite 运行状态、凭据、用户配置或外部 Luvus/Herdr binary。
不自动扫描或复制其它服务目录；资源缺失必须失败。

## Windows 程序图标

唯一来源是[独立橙色方形标](assets/brand/rovloom-mark-orange.png)。构建仅把原始 **192×192 PNG**
封装进单帧 ICO，保留浅色背景、原字节和分辨率；不使用复合展示图、不重绘、不承诺更高尺寸。
Windows 本机编译传入 `windows.icon`，保持控制台子系统以支持 CLI 诊断和交互。
CI 解析实际 EXE 的 `RT_GROUP_ICON`/`RT_ICON`，逐字节比对原 PNG 并核对控制台子系统，
随后隔离执行；Linux 交叉编译不能作为 Windows 图标生效或 Windows runtime 通过的证据。
构建器因此拒绝从非 Windows 主机生成带品牌图标的 Windows 候选。

选项与嵌入方式以 [Bun 官方 executables 文档](https://bun.sh/docs/bundler/executables)为依据，
本仓库固定版本的实际 binary/CI 验收优先于文档示例。
