# 开发与验证

面向贡献者。Rovloom 用 **Bun** 执行与构建。`package.json` 的 `engines.bun` 声明最低版本，依赖用 `^` 范围，`bun.lock` 保证可复现。CI 只跑最新稳定版（[Bun verification](../.github/workflows/bun.yml)），选择依据见 [ADR 0003](adr/0003-bun-toolchain.md)。提交前的约定见 [CONTRIBUTING](../CONTRIBUTING.md)。

## 日常命令

在仓库根目录执行：

```sh
bun install --frozen-lockfile --ignore-scripts
bun run lint
bun run format:check
bun run typecheck
bun run test
bun run build
bun run smoke
```

- `bun run format` 与 `bun run lint:fix` 自动修正格式与可修复的 lint 问题。
- `bun run test:protocol`、`bun run test:toolchain` 聚焦运行协议与工具链测试。
- `bun run audit:luvus` 核对固定的 Luvus 原生输入。

`bunfig.toml` 禁止自动读取 `.env` 和依赖安装脚本，子进程也显式传入 `--no-env-file`。`typecheck` 由 Bun 启动 TypeScript 编译器，保留 `strict` 与 `noUncheckedIndexedAccess`；转译不能替代类型检查。

## 构建产物

`bun run build` 先清空 `dist/`，再输出：

- `dist/src/`：各模块的 Bun ESM 入口、共享 chunk 与外部 source maps，依赖外置。入口清单由 `scripts/bun/build.mjs` 维护。
- `dist/webui/`：管理页的 browser target 产物（ESM、HTML、CSS、外部 source maps），不依赖 Node、远端字体或 UI 框架。

原生 schema 编译 Worker 随同一构建独立打包并内嵌锁定的 Ajv，不增加第二运行时、原生归档或 FFI。`bun run smoke` 从产物验证离线编译、请求/错误/结果边界、SQLite 文件重开、service 模块导入，以及 CLI help 与配置模板。

发行用的单文件构建和验收见 [DISTRIBUTION](DISTRIBUTION.md)，输出到 `dist/release/`。CLI 与 Gateway 的接口契约见 [MCP Streamable HTTP](protocol/MCP-HTTP.md) 与 [SERVICE](SERVICE.md)。

## 源码目录

- `src/connector/{luvus,herdr}`：原生 adapter。`native-contract`、`wire`、`transport`、`storage`、`integration`、`mcp`、`webui`、`admin`、`service` 按职责划分；根目录的 Store、Router 与协议文件是公共入口。
- `scripts/{luvus,herdr}`：固定版本原生输入的采集、审计和验证工具。`scripts/bun`：构建与 smoke。`scripts/release`：发行。`scripts/webui`：管理页浏览器检查。`scripts/maintenance`：维护脚本。
- `test/`：所有 Bun 回归，由 `bun run test` 执行。`test/fixtures/{luvus,herdr}` 按版本保存协议原文、来源与许可证，`test/fixtures/native-contract` 保存当前映射和矩阵。
- 端到端验收见 [e2e/README](../e2e/README.md)，不属于单元测试门禁。

## 管理页面的隔离验证

`bun run test` 已包含 `test/webui/`。构建后可运行只监听 `127.0.0.1`、随机端口的预览服务：

```sh
bun --no-env-file scripts/webui/preview.mjs
```

日志给出端口。`/` 使用构建后的入口，预览不提供 API，因此显示读取不可用；`/fixtures/` 使用隔离的测试数据，不含真实管理 API、管理员授权或 Connector。它是测试工具，不能用于部署管理页。用 Ctrl-C 关闭。

浏览器检查需要 Python Playwright 与 Chromium。一次运行全部检查：

```sh
bun run build
scripts/webui/check-all.sh [输出目录]
```

`CHROMIUM_PATH` 可指定 Chromium。单项检查为 `scripts/webui/check-{browser,preferences,layout,actions,lifecycle,bootstrap,retry-deadline}.py`，参数 `--url http://127.0.0.1:PORT --output <新目录>`；`actions`、`lifecycle`、`bootstrap`、`retry-deadline` 需要 `preview.mjs <端口> --actions`。输出目录必须是 checkout 外的新目录。

这些检查在真实 Chromium 上验证合成数据的展示、转义、焦点、导航、取消、部分失败、会话失效，两种语言与两种主题，以及桌面和 320px 布局。它们不验证真实管理后端或认证。设计与验收要求见 [GATEWAY-WEBUI](GATEWAY-WEBUI.md)。

## 固定输入与维护用途

| 数据 | 用途 |
|---|---|
| [Luvus 0.14.3 原始采集](../test/fixtures/luvus/0.14.3/linux/manifest.json) | 安装 schema 原文、实时能力、RPC/Host/终端记录、endpoint 与清理断言；测试和审计直接读取 |
| [Luvus 来源](../test/fixtures/luvus/0.14.3/provenance.json) | 官方 release 与 binary 摘要、固定源码 commit、schema 文档对应关系 |
| [覆盖账本](../test/fixtures/native-contract/coverage.json) | Luvus/Wire 测试与审计重算的逐方法基线 |
| [方法映射](../test/fixtures/native-contract/native-method-map.tsv)、[终端映射](../test/fixtures/native-contract/terminal-capability-map.tsv) | 审计用的方法、profile、transport、参数与终端 capability 证据；不是安全分类，也不是生产 allowlist |
| [矩阵](../test/fixtures/native-contract/matrix.json) | 原生测试物化的 seed、变更、生成器及正反断言 |
| [无效 pane](../test/fixtures/luvus/0.14.3/invalid-pane.json)、[失效路由](../test/fixtures/luvus/0.14.3/stale-pane.json) | 从独立原生采集逐字摘取的请求/响应，含 binary/schema 摘要与记录位置 |
| [Herdr 0.9.5 来源](../test/fixtures/herdr/0.9.5/provenance.json) | 官方 release 与 asset、源码 commit、Linux binary 与 schema 的 SHA-256、协议与方言；许可证见同目录 `LICENSE` |
| [Herdr 方法策略](../test/fixtures/herdr/0.9.5/method-policy.json)、[启动输入](../test/fixtures/herdr/0.9.5/agent-startup.json)、[工作流输入](../test/fixtures/herdr/0.9.5/workflow.json) | 静态与合成回归、离线结构校验和回放；策略不授权派发 |

fixture 字节不规范化，捕获中的 session 与路径标记保留原文。`coverage.json` 由 `bun scripts/luvus/audit-fixtures.mjs --write` 从固定原文生成。更新输入时显式生成并审查差异，日常 CI 只重算比对，不修改版本化输入。`dist/`、Python 缓存、工具日志和逐轮验收报告不提交；采集与验证输出写到 checkout 外的全新私有目录。

原生 schema 没有预编译资产：Worker 对每份安装 schema 用锁定 Ajv 完整编译（冷编译约 0.7 秒，接纳期限 10 秒）。运行时检查与失配回退见[原生契约](protocol/NATIVE-CONTRACT.md)。

## 重新采集与原生验证

这些工具面向升级 Luvus/Herdr 版本的维护者，不属于产品运行路径，对应的 Python 单元测试由 [python-tools 工作流](../.github/workflows/python-tools.yml)执行。

升级前先重新核对官方 release、下载摘要与安装契约；工具不会自动下载或升级 binary。

- **Luvus 采集**：按 provenance 核验官方 binary 后，输出到全新目录，不覆盖已提交 fixture。采集器在 `/workspace` 下创建自己的 0700 状态根、named session 与合成终端输入，不继承用户 HOME 或 session；这不是 OS 级沙箱。

  ```sh
  python3 scripts/luvus/collect.py --binary /absolute/path/to/luvus --output /tmp/rovloom-native-new
  ```

- **Herdr 离线审计**：不运行 Herdr、不发现或连接 socket。

  ```sh
  python3 test/herdr/test_contract.py
  python3 scripts/herdr/audit.py test/fixtures/herdr/synthetic
  python3 -B scripts/herdr/audit_methods.py --source-tree /absolute/path/to/pinned-herdr-source
  ```

  `synthetic` fixture 只验证离线工具，其版本、摘要和样本不是安装版的实测证据。`scripts/herdr/collect.py --input <私有导出目录> --output <新目录>` 把预先导出的证据校验后归档（目录 0700、文件 0600，拒绝链接、越界路径与未列文件）。审计通过也不签发执行许可。

- **Herdr 原生验证**：需要获授权的专用临时实例和与 pin 匹配的 binary。

  ```sh
  python3 scripts/herdr/verify_native.py --binary /absolute/verified/herdr --output /tmp/rovloom-herdr-native-new
  python3 scripts/herdr/verify_readonly.py --binary /absolute/verified/herdr --output /tmp/rovloom-herdr-readonly-new
  ```

  两个命令都在全新私有 HOME/XDG 根启动新的 named session，不接入已有会话，不继承 SSH、模型凭据或用户配置，并在结束时清理自己的进程。`verify_native.py` 核对 binary、契约与订阅边界；`verify_readonly.py` 观察事件保留窗边界与并发刷新。结果只写入输出目录，不生成产品执行许可。

- **Herdr 管理工作流**：`scripts/herdr/verify-runtime.ts` 与 `scripts/herdr/verify-workspace-metadata.ts` 在自有 binary 上验收管理工作流与 workspace 元数据，需显式提供 binary 路径和 checkout 外的新报告路径。

## 范围说明

测试基线是 Linux 原生环境。Bun 的 `process.version` 只是 Node 兼容值，MCP SDK 的协议 revision 由依赖锁定。跨平台、真实双机、NAT/TLS 的验收见 [e2e/README](../e2e/README.md) 与 [Windows e2e](../.github/workflows/windows-e2e.yml)。

SQLite 使用 Bun 的 `node:sqlite`，要求全新库，不迁移旧库。测试使用临时 SQLite 文件。原生接口见[原生契约](protocol/NATIVE-CONTRACT.md)，外层协议见 [Wire v2](protocol/WIRE-PROTOCOL.md)，存储见 [STORAGE](STORAGE.md)，通道见 [TRANSPORT](TRANSPORT.md)，整体设计见 [DESIGN](DESIGN.md)。


### CI scheduling

All workflow Bun setup uses the latest stable release, and external GitHub Actions use stable major version tags. Bun verification, Gateway platforms and standalone candidates run once per PR update and on pushes to `main`; ordinary superseded runs are cancelled. The reusable Bun workflow remains available to Release, whose tag verification is not cancelled by this policy. Workflow dispatch remains available.

Native e2e workflows always report a planning job and an acceptance summary. Product source, dependencies and build changes select native acceptance; prose-only changes skip the expensive runner jobs. Planning uses the full base/head Git diff, including deletions, and runs acceptance if history cannot be inspected. A selected failed, cancelled or skipped job fails the summary. `two-host acceptance`, `macos acceptance` and `windows acceptance` can be used as stable required checks; existing repository branch protection is not changed by this PR.

Job budgets are 20 minutes for Bun/Gateway, 30 for standalone, 10 for platform primitives and 25 for native e2e; planning, frozen installs and artifact uploads have separate 5-minute bounds. Queue time is outside a job timeout. Use Actions run creation/start timestamps and step start/end timestamps to distinguish queueing, dependency downloads, compilation, native operations and upload. Preserve the failing step's evidence before changing operation deadlines. Only static downloads have bounded retry; native writes and service operations are not retried generically. Known Intel macOS startup races remain tracked in #217.
