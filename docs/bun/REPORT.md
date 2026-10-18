# Issue #15：Bun 工具链迁移验收报告

日期：2026-10-18 UTC。实现基点 `4f963d1997751a4f392604cc060d0a99f157998a`，本地任务分支 `task/issue-15-bun-toolchain`。父会话后续要求将仅设计/Bun 增量对齐到已合并 main `9c4a7fe34fc3efa461d96a502860e61b05817c44`；已 fetch 核实其 tree 为 `4790655b5f8ab960805ec780ff0237c1160aaa94`，与本地审定 P0 `d2455e8` 完全相同。设计 v0.4 的全部变更保留，不在本任务实现 P1 或管理 UI。

后续按验收视角完成[复核与定点补验](REVIEW.md)：TypeScript7.0.2确为原版本、119保留条目不变，另补实际原生采集的零Node追踪、100安装路径审计、CI显式校验及测试发现门禁。下文原完整运行日志与729项归档保留；发布授权和当前状态以复核/PR为准。

## 结论与版本来源

本机 Debian 13.6 x86_64 已完成无 Node 可执行文件依赖的 Bun 开发/执行验收。使用官方 [Bun 1.4.3 发布页](https://bun.com/blog/bun-v1.4.3)（2026-10-10）与 [oven-sh/bun 官方 release 资产](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.3)。下载静态版本链接，未执行 curl 安装脚本，未全局安装或修改系统配置。

| 项目 | 实际观察 |
| --- | --- |
| Bun | 1.4.3，revision `c6da4a4d3010e5553438c60f6bd76d981976867c` |
| Linux x64 ZIP SHA-256 | `3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18`，与官方 SHASUMS256.txt 一致 |
| Bun 二进制 SHA-256 | `7ce7d6b654eddeec20afddf2396317fba6dc19ab52788a27e894e1806bf8f24b` |
| SQLite | 对 `node:sqlite` 真正执行 `SELECT sqlite_version()`：3.53.4 |
| TypeScript | 保留 7.0.2；Bun 显式运行 dispatcher，再启动其锁定的原生编译器 |
| SDK / Ajv / ws | 1.32.1 / 8.20.0 / 8.22.0，版本与 integrity 均不变 |
| SDK 实际 stdio 协商 | 2025-11-25；独立子进程、initialize/initialized、tools/list、ping、stderr 空 |

`process.version` 为 Bun 提供的 `v26.3.0` 兼容字符串，不能说成 Node 26 实测。完整来源见 [provenance.json](provenance.json)，SDK 线缆见 [sdk-compatibility.json](sdk-compatibility.json)。不采用 Bun 内建 checker 替代原独立 TypeScript 检查；Bun build/test 转译成功也不算类型验收。

## 实现范围

- `.bun-version`、`packageManager: bun@1.4.3`、`engines.bun`、版本检查及 CI 一致；删除当前 `.node-version` 和 npm lock，历史报告不改。
- 先由 Bun 导入真实 npm v3 lock，再删除 tsx 依赖。最终文本 `bun.lock` 保留 119 个条目，版本和完整 integrity 逐条相等；移除 29 个仅属 tsx/esbuild/fsevents/平台包的条目，新增 0、升级 0。嵌套 `content-type` 版本亦逐项比较，未按名称误去重。详见 [dependency-migration.json](dependency-migration.json)。冻结空目录安装实际安装 97 个当前平台包；它与跨平台 lock 的条目数含义不同。
- 原 `src/`、5 个基础测试文件及 20 项断言主体未改。`node:sqlite` 无需替换；新增测试使用真实 SQLite，不使用 mock 数据库。迁移 v1/v2→v3、重开、unknown/no replay、权限、单写锁、BLOB/UTF-8 按字节分页仍由原测试验证；新增触发器故障验证 Store 事务确实回滚 token 消费。
- 构建改为 Bun.build，四个现有模块入口，target=bun / ESM / packages=external / splitting / 外部 sourcemaps，先删除 dist。产物保留 `dist/src/*.js` 路径；共享 chunk 保证跨模块 GatewayError identity。实际导入全部产物入口，检查导出集合及真实磁盘数据库重开。当前没有可运行服务 CLI，未添加伪入口；不声明 Node-target 或 declaration 产物。
- SDK 子进程使用同一 Bun `process.execPath`，显式 `--no-env-file`，保留隔离 PATH；新增 SIGTERM/stdout/stderr/强制超时终止测试。原生 Luvus 调用方式不改。
- [官方文档](https://bun.com/docs/runtime/environment-variables) 明确自动加载 `.env`；仓库 `bunfig.toml` 设置 `env=false`，工作流和子进程再显式禁用。仅创建非敏感 `.env` 样本验证，未读取任何用户 `.env`。生命周期脚本全部禁用，未增加 trustedDependencies；扫描发现部分保留依赖有 prepare 字段，记录在验收 JSON，实际无执行需求。
- 新增最小 Linux GitHub Actions 配置，精确校验 Bun 下载哈希并运行同一隔离验证器；checkout 固定官方 v4.2.2 commit，persist-credentials=false。本地验证已执行，远端 Actions 尚未运行，因为 Bun 分支未发布。

## 实际验收与执行链

完整可重放入口（Bun 1.4.3、Python 3、Linux strace）：

```sh
python3 scripts/bun/verify.py --bun /absolute/path/to/bun --output /tmp/new-bun-verification
```

验证器复制代码、必要 fixture、明确列出的工具链文件及原覆盖账本到临时项目；不复制用户 home、env、npm 配置、凭据或任何已有数据库。新建 HOME 和空依赖缓存，PATH 仅有 Bun、Python、sh 及 node/npm/npx 拒绝脚本。先分别验证三者返回 99，清除探针记录后追踪全部后续命令的 execve/execveat。真实工作流中 Node/npm/npx 尝试为 0（亦拒绝 nodejs 或未核算的 execveat）。环境只另继承云平台必要、无 userinfo 的代理/CA 配置；变量名可见，值不记录、不扩大网络权限。

| 检查 | 实际结果 |
| --- | --- |
| 空缓存 `install --frozen-lockfile --ignore-scripts` | 通过，package.json/bun.lock hash 不变 |
| 独立 `tsc --noEmit` / `--showConfig` | 通过，strict、noUncheckedIndexedAccess，全部 4 src + 5 test 文件 |
| 临时纳入同一 tsconfig 的错误文件 | 如预期失败 exit 1，TS2322 与 TS2532；随后删除 |
| 原基础测试 | 20 pass，0 fail，0 skip |
| 原 P0 JavaScript / Python | 7 pass + 7 OK，无跳过 |
| 新 Bun 兼容性测试 | 5 pass，0 fail |
| 原 P0 hash/schema/语义审计 | 通过，原 fixture 和原账本保持原样 |
| 本轮新原生记录 Bun 重放 | 通过，29 schema 文档，31 请求/30 响应/19 events，2 项故意无效请求 |
| clean build + artifact smoke | 通过，删除预置 stale.js，10 个 ESM/chunk/map 文件，真实磁盘写入重开 |

共 39 项自动测试通过，另含类型错误反例、构建 smoke 与原生审计，不能把这些合并成原基础测试数。[verification/verification.json](verification/verification.json) 提供每条命令、退出状态、日志/执行链 hash，目录内保留脱敏 stdout/stderr 及 exec trace。TypeScript 原生编译器是预先锁定的官方依赖，不是 Node fallback。trace 中 Python 的 uname 路径探测可返回 ENOENT，不影响系统调用获取平台信息。

开发验证中已修复验证器自身的三项准备问题：版本报告原先早于安装、遗漏复制只读 coverage.json、预期类型错误退出码应为 TypeScript 7 的 1；均未放宽产品测试或类型规则。第一次无代理的空环境无法解析 registry 域名，已只继承必要的非凭据平台网络配置，并增加超时整组子进程清理。最终完整运行通过。

## 本轮最小原生证据

使用已审定官方 Linux Luvus 0.14.3 binary SHA-256 `895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9`，执行原 collector：

```sh
python3 scripts/p0/collect_native.py --binary /absolute/path/to/luvus --output /tmp/new-native-capture
bun --no-env-file run p0:bun-native
```

全新 0700 目录、最小 child env、自建 session/实例；仅 synthetic Python 终端输入。RPC、Host、snapshot/events/replay、terminal observe/control 身份 fence/lease/ack/关闭及拒绝边界均来自原生进程。729 项采集断言通过，核验 endpoint UID/mode/inode/ctime/peer PID；server 已停止、无运行 session、临时根目录删除。无现有用户会话、真实账户、付费调用或持久凭据操作。执行来源中的返回文本未当作外部指令。

新归档独立保存在 [fixtures/bun/native-evidence.tar.gz](../../fixtures/bun/native-evidence.tar.gz)，SHA-256 `71c38aa6ce308cb71fe02746a8380034e2869b75d82c8c288edefd3b4935cc41`；人工范围复核及密钥形态扫描通过，路径已由 collector 脱敏。原 P0 fixture/归档/Node 报告均未重写。原 collector environment 中的 base_commit 字段仍为它的历史 916cae2，本轮真实 harness 基点 4f963d1 单独列在 [native-verification.json](native-verification.json)，不伪改已采集字节。

## P0 发布与本地交付边界

此前 CLI 的 projCC push 返回 403；用户随后明确授权使用既有 ArnoChenFx 连接的正常 Git 对象 API。仅 P0 分支成功发布，无权限、凭据或网络设置更改。API 不能保留原 author/time，提交映射为 eedba1b → a26c6366136d60bd188d877e041a37f0cd9ddba7；d2455e8 → **6d4ef0c4d4daaf200a7ce1cc5b229850fda8978f**，tree 逐字节相同、两步父提交顺序不变。已 fetch、比较 tree/diff，远端 P0 分支内容通过核对。

- [已发布 P0 分支](https://github.com/ArnoChenFx/luvus-mcp/tree/task/issue-3-native-evidence)
- [不可变 P0 报告](https://github.com/ArnoChenFx/luvus-mcp/blob/6d4ef0c4d4daaf200a7ce1cc5b229850fda8978f/docs/p0/REPORT.md) / [复核](https://github.com/ArnoChenFx/luvus-mcp/blob/6d4ef0c4d4daaf200a7ce1cc5b229850fda8978f/docs/p0/REVIEW.md)

之后 PR1/P0 的 main 合并由父会话单独完成。本任务只在本地保留设计/Bun 增量并对齐该 main；未创建/合并 PR，未发布设计/Bun 分支、部署或自动推进 #4。没有开发阻断；父会话需审查本地提交再安排发布与后续任务。macOS/Windows、商业 MCP Host、OAuth、双机及 P1 实现不在本轮验收内。
