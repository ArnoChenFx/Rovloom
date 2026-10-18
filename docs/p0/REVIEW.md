# Issue #3 验收复核

日期：2026-10-18 UTC。审查对象：`eedba1bb6f4319d6e3d5bef134bbf7a5754799ed`。
结论：**下列可修复问题已修复并复验，当前四条验收标准通过，可供父会话验收后作为 #4 的 Linux 0.14.3 调查基线。**未自行关闭 issue、推送、合并或启动 #4。正式设计中的授权、未知结果与数据保留语义均未改动。

这是同一开发任务中新一轮按独立审查步骤作出的复核，不宣称第三方审计或可独立证明当前运行模型身份。用户指定的运行设置沿用父会话安排。

## 按 issue 的四条验收标准

| 标准 | 结果 | 复核证据与边界 |
|---|---|---|
| Linux RPC、Host、事件、terminal control 的可追溯原生最小证据 | 通过 | 读取原始 LF wire、CLI 退出码和真实 server PID；新建隔离实例再次完成所有路径，补测 valid terminal + 不同已发现 pane 的 `stale_route` 拒绝 |
| fixture 无真实 secret、私人会话、无关文件，版本/hash/命令/退出码/副作用齐全 | 通过（审计漏项已修复） | 原 manifest 全文件 hash 通过；新增必需文件集合及无额外文件检查；完整重建 Host、peer、终端消费与清理；新实例在采集器外确认根已删除、server exit 0、两个自建子进程消失 |
| 网站/安装版差异登记，未知 schema/endpoint/平台不猜测 | 通过 | 29 个 document 对固定官方源码 commit 逐一 JSON 对等；重算 144/223 参数缺口；MCP 2026-07-28 页面存在，但所锁 SDK 只在本次协商 2025-11-25；跨平台未测保持明确 |
| ADR/覆盖矩阵足以供后续 validator/adapter 设计，未达门禁保持阻断 | 通过，限调查基线 | 223 个方法均有 profile/transport/schema/权限/未支持原因；没有把 native probe 当作 Gateway 已实现。原有授权/协议未决项及其它平台门禁仍交父会话决定 |

## 八项工作范围逐项检查

1. **版本与隔离：通过。**原提交父 SHA 是已验收 `916cae2…`。Luvus release binary/server/ping 均 0.14.3；本轮仍是 Debian 13.6 x86_64、Node 24.19.0、npm 11.9.0；实际 SQLite 内存查询返回 3.53.3。HOME/XDG/LUVUS_HOME 是完全构造的新子进程环境，没有继承已有 Luvus 选择器或调用者配置。这不构成 OS 文件访问沙箱，不能宣称该 Unix 用户无法读取其它文件。
2. **schema/capabilities/原生记录：通过。**原始 schema 字节 hash 固定为 `00e3bb…bdbe6`，全部 29 个 document 对 `git show 54003ce9568acb2977e4bbdbb30a61f99faa0465:<path>` 再做 hash 与 JSON 对照。独立 capabilities 副本现在必须与 transcript 的实际回复完全相同。
3. **proxy、Host、超时与生命周期：通过。**独立检查每条 CLI exit 0/1/-15 与 timed_out；Host 三个只读方法在前后无 running session 时成功；普通 ping 单 LF/EOF；无 LF、非法 JSON、未知方法、原生 wait timeout 及本地 deadline 分别保留真实失败语义。
4. **endpoint 归属与权限：Linux 通过。**running endpoint 来自 CLI 精确 named row；每个 method socket 都有其自身的 endpoint 校验记录与同 UID/实际 server PID 的 SO_PEERCRED。路径类型、symlink 和精确 inode/ctime 由采集器在 Python 中校验；离线审计重建其中已保存的 UID/mode/发现绑定。mtime/ctime 大整数不是未来 JSON wire 中可随意用 JS Number 承诺纳秒精度的字段。macOS/Windows 仍未测试。
5. **Linux 最小流与终端：通过。**新采集中 generation、terminal lifetime、pane route 三种不匹配分别返回 stale_server/stale_terminal/stale_route。租约冲突、释放后重获、queued ack、子进程实际变换输出、流关闭不关闭 pane、显式 pane close、事件 replay/sequence、observe EOF 均重建验证。
6. **fixture/覆盖生成：通过（审计漏项已修复）。**原账本重新生成完全一致，197 session + 17 Host + 9 access_machines = 223；四个已审核流单列，machines profile 不用作网关注册。所有网关状态仍 not_implemented/not_enabled。生成器只作为固定版本账本工具，未来新版本仍需人工确认未知传输与权限。
7. **ADR/版本/规范：通过，保留已声明限制。**安装包实际版本与 package-lock 再核对。SDK 独立 stdio 实测报告与原报告完全相同；其 types.js 常量为 2025-11-25，支持列表没有 2026-07-28。SDK client/server 探针只证明选定 SDK 的这一条 stdio 协商，不替代真实商业 MCP Host 或 Gateway E2E。ws 锁版本，尚未做 WSS/TLS 验收。
8. **平台矩阵/外部输入：通过。**Linux 已测范围、macOS/Windows 未测及权限差异已写出；部署地址、目标 OS、具体 MCP Host/version、OAuth 服务、两台真机没有被假定或擅自配置。它们不阻断此 Linux 调查，但阻断对应后续阶段的完成声明。

## 已修复问题

| 问题 | 原风险 | 修复与回归 |
|---|---|---|
| 离线审计只验 schema、hash 与一部分保存断言 | 修改 Host exit code、peer UID、删除 endpoint validation 或 capabilities 副本偏离 transcript，原审计仍可能放行 | 新增 `native-trace.mjs`，直接重建原生行为与关联；变异测试明确拒绝这四类错误以及清理发现仍 running 的情况 |
| manifest 未强制覆盖全部必需文件，也未拒绝额外文件 | 后续人工拷贝漏列/夹带文件时，不能靠审计发现 | 必需集合、目录实际集合、普通文件类型检查；新增漏列与无关文件回归 |
| 清理阶段发现命令/证据写入失败会跳过后续删除 | 再采集失败时可能残留私有临时目录、丢失诊断 | 先完成流/server/根清理，再保存证据；发现失败仍保存失败状态与 manifest；输出写失败也先删除根；以自身短生命周期子进程注入测试 |
| Python `assert` 可被 `-O` 跳过 | 以优化模式启动时 endpoint 安全检查失效 | `check()` 显式 raise AssertionError；`python3 -O ...` 七项边界/失败清理测试通过 |
| SDK 报告依赖版本只读取 lock | node_modules 与 lock 不一致时可能错误标注运行版本 | 探针同时读取实际安装 package.json，必须与锁定版本一致 |

修复后没有剩余阻断 #3 Linux 最小验收的问题。SIGKILL/机器崩溃时无法保证 finally 执行，仍需运行环境回收；本次没有把脚本异常清理升级成崩溃容错承诺。采集器及其离线审计均不是生产 adapter。

## 144/223 与 SDK 的特别复核

独立遍历安装 request schema 根 `allOf.if.properties.method`，得到 79 个带条件分支的方法，剩余 144 个。进一步对这 144 个方法逐一输入 `params:{p0_unannounced:["synthetic"]}`，完整根 schema 全部接受，直接证明它们没有方法专用参数约束，而非只复述生成器的计数。79 个带分支的方法也不能由此宣称业务语义完备。

新增原生反例：`pane_id:"9999999999"` 满足 schema 的 1–10 位正数字符串模式，但 server 返回 `invalid_params / pane_id is invalid`。该次采集因预期 stale_route 而失败，失败断言、原生拒绝及成功清理均保留在补充包的 v2 目录。随后改用 snapshot 中已发现的有效另一 pane ID，v3 得到正确 stale_route。两次不混为一次成功运行，也没有重放任何输入。

SDK 复核读取实际安装版本 1.32.1、`LATEST_PROTOCOL_VERSION`/`SUPPORTED_PROTOCOL_VERSIONS`、实际 initialize/result/initialized wire，再执行 tools/list、ping 和关闭。原 `sdk-compatibility.json` 与本轮结果完全相同。官方 [2025-11-25 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) 和 [2026-07-28 transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) 均再次访问确认存在，结论保持在版本支持列表与本次协商的范围内。

## 复验结果与支持文件

| 本轮检查 | 结果 |
|---|---|
| 官方 archive 随附 checksum 重算 | OK；binary SHA 与原 provenance 一致；没有重新安装或升级 |
| 原 fixture 加强审计 | 29 documents / 30 requests / 29 responses / 23 events / 2 intentional invalid |
| 新隔离 native v3 | collector + finish 成功，727 动态断言；29 documents / 31 requests / 30 responses / 21 events / 2 intentional invalid |
| 外部清理观察 | 临时根实际不存在；server exit 0；本次 inventory 中两个自建 PID 均不再存在 |
| `npm run typecheck` / `npm test` / `npm run build` | exit 0 / 20 passed / exit 0 |
| `npm run test:p0` | Node 7 passed + Python 7 passed |
| `python3 -O scripts/p0/test_endpoint.py` | 7 passed |
| `npm run p0:audit` / `git diff --check` | exit 0 / 通过 |

事件数由 native 输出合并时序决定，新旧采集的 21/23 不相等是已记录的实际结果；没有为了对齐计数补造事件。原 fixture 及其 manifest 没有改写。

- [机器可读复验摘要](review-verification.json)记录原提交、命令范围、清理外部检查、schema 源码对照、SDK 和测试结果。
- [补充原生证据归档](../../fixtures/p0/review-native-evidence.tar.gz)包含已脱敏的 v2 失败尝试与 v3 成功运行。归档 SHA-256 为 `c96e145ad04b7ffd42a5d96624db81a68599ca769b5a10d8e15857e900e3fb23`；各目录内另有逐文件 manifest。文件都是本次固定文本、全新实例与诊断；没有真实 auth、私有 HOME 内容或无关文件。
- 解压到新的临时目录后可运行 `inspectFixtures(<v3目录>)` 重放成功集；v2 是故意保留的失败集，应被完整验收审计拒绝，不能当成完成证据。
- 官方来源限定：[0.14.3 release](https://github.com/RizRiyz/luvus/releases/tag/v0.14.3)、[官方安装文档](https://luvus.dev/docs/getting-started/installation/)、固定 commit 的源码。checksum 是同一发布渠道的完整性验证，不是独立签名/构建证明。

## 供父会话决策

建议父会话验收本次修复提交及上述证据后，将它作为 #4 的**已冻结版本、已知缺口和测试输入**。144 项参数缺口、79 项仍有原生额外约束、MCP revision 适用性必须进入 #4 的设计，不能由“当前测试通过”推导完整参数验证或新版兼容。正式授权、retention、raw-contract、envelope 协商等语义仍由父会话另行确认；此处没有改变或提前实现这些决定。
