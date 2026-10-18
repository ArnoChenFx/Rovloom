# ADR 0001：P0 版本、契约来源与协商基线

日期：2026-10-18 UTC。状态：本任务已执行的开发基线，待父会话验收。
依据：issue #3、DESIGN v0.2、IMPLEMENTATION-PLAN v0.2；基线提交 `916cae2412b69f3432caf264fd411ea1a4b3093f`。

## 决策与已验证范围

| 项目 | 固定值 | 证据与限制 |
|---|---|---|
| Luvus binary / server | `0.14.3`，Linux x86_64 musl release | 官方校验文件匹配；CLI version、server status、原生 ping 一致 |
| UHP | `luvus-uhp` major 1 / minor 0 | session 与 Host 实时 capabilities；不同 profile 分开缓存 |
| Node | 精确复验 `24.19.0`；支持分支 `>=24.19.0 <25` | `.node-version` 固定复现版本；收窄原来未经本次验证的 Node 26 engines 承诺 |
| npm | `11.9.0` | 本环境实测；没有自动升级 |
| MCP SDK | `@modelcontextprotocol/sdk@1.32.1` | npm 官方 registry 包、完整 lockfile integrity；独立 stdio 子进程验证 |
| JSON Schema validator | `ajv@8.20.0`，`Ajv2020` | 29 个安装文档全部离线编译；使用 JSON Schema 2020-12 |
| WebSocket | `ws@8.22.0` | 精确锁定，尚未实现或验收 Gateway WSS、TLS 或重连 |
| SQLite | Node 内置 `node:sqlite`，该 Node 的 SQLite `3.53.3` | 复用已有 Store；20 个基础回归通过。不引入另一套 SQLite 实现 |
| 开发兼容客户端 | 同版本 SDK 的 `Client` + `StdioClientTransport` | initialize / initialized / tools/list / ping / close 实测；商业 MCP Host 尚未选择 |
| MCP wire revision | `2025-11-25` | SDK 源码常量与 stdio 实际协商相同；不宣称支持 `2026-07-28` |

这三个新增 npm 包暂放在 devDependencies，供 P0 调查、schema 回放和客户端兼容测试使用；正式 adapter 引入时再决定运行依赖边界。已有 TypeScript/tsx/@types/node 锁保持不变；`@types/node@26.6.5` 是历史编译类型包，不代表 Node 26 运行时已测试。

Node 官方发布表在本次核验时列出 v24 为 LTS、v26 为 Current；没有因官网有更高 patch 而替换 #2 已通过的 `24.19.0`。[Node 发布表](https://nodejs.org/en/about/previous-releases)、[精确版本 SQLite 文档](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html)。

## MCP 规范适用性

正式设计的 S5/S6 `2026-07-28` 页面**确实存在**。该 revision 的 transport 使用逐请求元数据，并单列对旧 initialize 模式的兼容规则。所锁 SDK 1.32.1 的实际 `LATEST_PROTOCOL_VERSION` 是 `2025-11-25`，支持列表没有 `2026-07-28`。因此本次固定旧 revision 的开发 stdio 路径，不能套用新版元数据模型后继续声称该 SDK 自动兼容。

- [2025-11-25 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)：本次 initialize → initialized 协商路径的规范依据。
- [2025-11-25 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)：stdio 的 LF JSON-RPC 与 stdout/stderr 分离。
- [2025-11-25 authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)：将来采用该 revision 的 HTTP 入口时需据此实现；本次没有 OAuth 验收。
- [2026-07-28 transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)、[authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)：本次核验存在，不能据此推断 SDK 支持。

[SDK 实际协商记录](../p0/sdk-compatibility.json)保留 wire；执行脚本不接入 Luvus，也不是 Gateway。SDK 声称的其它旧 revisions 本次没有逐一联调。选定商业 MCP Host 后必须记录其具体版本与协商结果；要求 2026-07-28 时需另外选择兼容实现并做迁移评审。

## UHP 契约与外部引用

1. 以安装 binary 的 `luvus uhp schema` 原文作为版本化契约。原文 SHA-256 为 `00e3bb8862b9f3602164bdbe3f11cd7b466e7f7098aa2942dd3878d0b1abdbe6`。其 29 个 `documents` 与官方 `v0.14.3` 对应源码逐文档 JSON 相等，见 [provenance.json](../p0/provenance.json)。网页不覆盖它。
2. schema 文件不是能力/权限清单。实时 session 197 方法，Host 17 方法，另有 9 个 `machine.*` 仅出现在 schema/专用 access profile 文档中。`access --machines` 未启动，不能把其 machine 身份作为网关设备注册。
3. `documents` URL 是**本地 bundle 内的索引键**。使用 Ajv2020 `addSchema(document, URL)`，保留完整根约束、`allOf`、`oneOf` 和传递引用；不提供 `loadSchema`，不联网取 `$ref`，不把未知 URL 当文件路径。缺失引用/未知 dialect 必须失败关闭。
4. Ajv 的 `strict:false` 只关闭对原生 schema 写法的 lint 告警；`coerceTypes/useDefaults/removeAdditional` 均关闭，原生数据不被修改。缺 id、result/error 并存、额外根字段、条件分支不符、缺失/外部引用都有拒绝测试。[Ajv draft 文档](https://ajv.js.org/json-schema.html)。
5. **144/223 方法只有通用 params object；79/223 有条件参数分支。**存在分支也不等于其全部业务语义已经形式化。#4 不得把枚举发现、通用 object 验证称作完整方法参数验证；`parameter_schema_incomplete` 须在严格执行路径中拒绝或明确待决，不能自行从网页拼 schema，也不能静默启用 raw-contract。
6. 普通 response 使用全局 response schema；终端 response 再应用 terminal response；一般 event 同时验证 envelope 与 event_catalog payload；`terminal.frame` 属 terminal event schema，并不在一般 event_catalog 中。不能把缺 catalog 键误判成未知普通事件后丢弃。
7. 缓存键须至少含 binary hash/schema hash、profile、session、原生 generation；未知版本/能力变化要重新发现。P0 没有实现这个生产缓存，脚本仅提供固定版本证据。

## Endpoint、framing 与能力协商

Linux endpoint 只来自新实例 `luvus --session p0-issue3 session list --json` 的精确 running 行；使用 `endpoint.address`，不使用 `server status` 展示的 client socket，不拼内部命名。采集器对每次连接重复检查绝对路径、无 symlink、父目录不可组/全局写、私有目录 0700、socket 0600、有效 UID、设备/inode/ctime，随后检查 Linux `SO_PEERCRED` 的 UID 和本任务 server PID。

该采集器额外限制 endpoint 必须在自己刚创建的状态根内，不能充当接受远端任意 endpoint 的通用 adapter。Linux `/tmp` 长路径别名、macOS peer credentials/规范化、Windows 本地 pipe DACL 与 server token SID 尚未验证，不能放宽判断来假称支持。固定标签的[官方 endpoint 规则](https://github.com/RizRiyz/luvus/blob/54003ce9568acb2977e4bbdbb30a61f99faa0465/protocol/uhp/v1/terminal/endpoint-validation.md)是未来各平台调查输入。

普通 proxy 单次请求/响应，双帧输入只处理首帧；无 LF/非法 JSON 是进程错误，原生 UHP error 则保留原始 id/error 且 CLI 退出 1。持续流必须连接发现的 endpoint。终端需要 server_generation + terminal_id + pane_id；本次原生拒绝 stale_server/stale_terminal/control_conflict 均保留。控制写 ack 的 queued 不代表消费，测试另用子进程变换输出证明消费。关闭流释放 lease，关闭 pane 需要显式原生 close；不能混为一事。

Gateway↔Connector 的协议仍是已有内部 1.0 草稿，不是 UHP 或 MCP。major 拒绝、minor 能力交集、方向约束和认证握手仍待 #4/#5 后续设计；本 ADR 不把历史 exact-minor 检查提升成生产协商，也不替父会话未决语义做决定。取消/超时不等于回滚；发送后失联保持 `outcome_unknown`，不重放写入。

## 仍需用户选择/后续验收

Gateway 部署位置/可达地址、目标 OS、具体 MCP Host 与版本、OAuth 服务、两台真实机器未指定。当前无需这些输入即可完成 Linux P0；这些缺项阻断对应的跨平台、客户端正式兼容、HTTP/OAuth 和双机发行门禁。没有创建持久凭据、配置网络安全设置或部署服务。父会话在 #4/#5 前讨论的协议语义仍以其后续决议为准。
