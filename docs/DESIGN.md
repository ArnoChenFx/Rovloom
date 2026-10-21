# Rovloom 系统设计

本文是 Rovloom 的权威设计，描述**目标**架构与语义。当前实现与本文的差距按阶段跟踪在 GitHub issue [S3–S7](https://github.com/ArnoChenFx/Rovloom/issues?q=is%3Aissue+%5BS)；专项规范（[Wire](protocol/WIRE-PROTOCOL.md)、[原生契约](protocol/NATIVE-CONTRACT.md)、[存储](STORAGE.md) 等）目前描述的是**现有实现**，会随这些阶段合并或修订，冲突时以本文为准。历史设计（含已删除的隔离恢复、逐 input permit 等机制）见 `git log -- docs/DESIGN.md` 与 [归档 ADR](adr/archive/)。

## 1. 产品

Rovloom 让 AI Agent 通过一个 MCP 入口，访问多台设备上的本地 **Luvus** 与 **Herdr** runtime。

- 一个 **Gateway**：MCP 入口、设备注册与认证、调用方授权、路由、调用账本、结果存储、管理 UI。
- 每台设备一个 **Connector**：主动出站 WSS 连到 Gateway，承载若干 **provider**（一个 Luvus 或 Herdr 实例对应一个 provider）。
- runtime 留在各自机器上；Rovloom 不安装、不启动、不升级它们，不复制它们的 UI，也不提供独立的任意 shell RPC。

目标用户：一个管理员，几台自己的机器，一个主 Agent。**不是**多租户、多活集群或公网 SaaS。

## 2. 威胁模型

| 在范围内 | 不在范围内 |
|---|---|
| 网络上的未授权方（没有 Bearer、没有设备凭据） | Gateway 或 Connector 所在主机已被攻陷 |
| 泄露或过期的 Bearer / 设备凭据 | 同机其它 OS 用户读取状态目录（交给 OS 文件权限） |
| 管理员配置错误导致的误暴露（默认只监听 loopback） | 整机回滚、备份篡改的自动检测 |
| 调用方越权访问未授权的设备或方法 | 对 Agent 内部工具的沙箱（终端本身就是目标账号权限） |
| 断线、重启导致的重复执行 | exactly-once、跨机器事务 |

终端与 Agent prompt 具有目标账号的执行权限，不是沙箱；强隔离依赖专用账号或容器。

## 3. 不变量

实现和后续变更必须保持以下 8 条，其余机制按需取舍。

1. **显式目标**：每次调用给出 `machine_id + provider_id (+ session)`；没有"当前机器"，不跨 provider 自动 failover。`machine_id`、`provider_id` 由 Gateway 生成，稳定、不复用；名称只用于展示。
2. **设备身份**：一次性配对码换取设备凭据，Gateway 只存 hash；传输必须 TLS（显式 loopback 开发模式除外）；凭据比较用常量时间；凭据不进 URL、argv 或日志。
3. **调用方授权在 Gateway 做一次**：`caller → (machine, provider, method 集合)` 的授权由 Gateway 判定；设备或 provider 的新增不继承已有授权。
4. **终端执行开关**：Connector 本地布尔配置 `allow_terminal_execution`，默认关，是唯一的 Connector 侧授权。
5. **结果不确定性**：可能已送达的调用在断线、超时或崩溃后标 `outcome_unknown`，不自动重发变更；只读方法由调用方显式重试；晚到的响应只补充原调用的证据，不重新执行。
6. **有界资源**：请求体、单帧、单页、并发、结果保留时长、总存储都有上限，超限明确拒绝。
7. **秘密不入日志**：凭据、prompt、原始输出和私人路径不写日志与审计。
8. **HTTP 基础加固**：严格 JSON 解析（拒绝重复键、过深对象、截断 UTF-8）、`Content-Length` 预检、Origin/Host 校验、固定错误体、默认只监听 loopback。

## 4. 架构

```text
MCP Client ──HTTPS (Bearer / OIDC JWT)──▶ Gateway ◀──WSS (设备凭据)── Connector ── Provider (Luvus | Herdr)
                                             │                         本地终端开关
                                          SQLite（单库、单 writer）
```

| 模块 | 职责 |
|---|---|
| `mcp/` | Streamable HTTP facade、工具定义、参数校验 |
| `gateway/`（现 `runtime/`、`store`、`transport/`） | 设备注册与配对、caller ACL、路由、调用账本、结果存储、审计 |
| `connector/` | 出站 WSS、provider 生命周期、本地终端开关 |
| provider 适配器 | Luvus（UHP）与 Herdr（JSON socket）各自保留原生协议，Rovloom 不把 Herdr 改写成 UHP |
| `wire/` | Gateway ↔ Connector 的单一 major JSON 信封 |
| 原生契约校验 | 安装版 schema 的进程内 Ajv 校验，按 schema hash 缓存 |
| `admin/`、`webui/` | 独立 listener 与管理会话的管理 API 与 Web UI |
| `cli/`、`service/` | 单一可执行文件、角色配置、开机服务 |

三条认证边界相互独立：调用方 → Gateway、Connector → Gateway、Connector → 本地 runtime。Connector 只执行管理员在本机配置固定的 binary 与状态根；调用方不能提交 binary 路径、endpoint、环境或状态根。MCP 身份、设备凭据与管理会话互不通用。

### 4.1 Machine 与 Provider

- `Machine`：Gateway 随机生成的稳定 ID；持久授权状态与连接观测分开存放；每次成功认证产生新的 `connection_epoch`。
- `Provider binding`：`(machine_id, provider_id, kind, config_ref, binding_revision, enabled)`。`kind` 不可变（Luvus / Herdr）；实例换了（kind、状态根或实例身份变化）必须用新的 `provider_id`；启停和配置变化递增 `binding_revision`。
- `Target`：`(machine_id, provider_id, profile, session)`；调用同时带 `expected_binding_revision`，不匹配即拒绝。
- 设备断开、撤销设备、禁用 provider 是三种不同操作：断开只关闭当前连接；撤销持久拒绝新认证；禁用 provider 阻断该实例的派发而不影响设备与其它 provider。
- 单个 provider 失效不关闭整条连接，也不影响同设备其它 provider。

### 4.2 方法表与授权

每个 provider 内置一份静态方法表，把原生方法归为 `read / write / terminal / admin`：

- 表中没有的方法一律拒绝；`schema` 通过只代表参数合法，不代表允许调用。
- 调用方 ACL 授权到 `(machine, provider, method 集合)`；`terminal` 类方法还要求 Connector 的终端开关开启；`admin` 类方法（如 Luvus Host stop/restart）需要独立的管理授权。
- Herdr 当前接入 65 个普通 RPC；其余原生方法不开放，直到有真实需求。Luvus 接入协议与实际接口兼容的 UHP 能力。
- 兼容性按实际安装的 schema 和方法能力判断，**版本号只用于诊断**，不设版本白名单。

### 4.3 一次调用的生命周期

```text
runtime_call
  → [Gateway] 认证 caller → 查 ACL → 方法表 → schema 校验 → 写 calls(dispatching) → WSS 发 request
  → [Connector] 终端开关 / 方法表支持性 → provider 执行 → response
  → [Gateway] 写 responded + 结果（受 result_ttl）→ 返回
```

```text
created → authorized → dispatching → connector_accepted → responded
     └─ rejected / not_dispatched
                         └─ outcome_unknown ── (晚到响应) ──▶ responded + late_evidence
```

- 只有能证明未写出时才报告 `not_dispatched`；可能送达后断线、超时或崩溃保持 `outcome_unknown`。
- 同一 `call_id` 至多派发一次：以 `calls` 表中 `call_id` 的唯一约束与持久化的 `dispatching` 状态保证，重启不重放。
- `client_request_key`：同一 key + 同一请求摘要返回原调用；同 key 不同摘要报冲突；key 的有效期等于 `metadata_ttl`。
- 取消只报告实际能确认的程度：停止等待、停止桥接，不宣称原生回滚。
- 前端 `wait` 到期可返回 `call_id`，执行 deadline 独立。设备离线立即失败，重连不执行旧请求。

### 4.4 结果与流

- 结果原文保存在 Gateway，受 `result_ttl` 与单结果上限约束；响应必须放入单个 1 MiB Wire 帧，超限不分片（调用保持 unknown）。
- 读取按 keyset 游标分页，每页重新检查调用方权限。
- 流（事件订阅、终端观察/输入）按需开放；Luvus 与 Herdr 的事件语义不同（Herdr 的事件与 snapshot 没有共同序号，只保证状态重建），不承诺 replay。

## 5. 认证

| 对象 | 方式 |
|---|---|
| MCP 调用方 | Bearer 令牌（`rovloom token create / list / renew / rotate / revoke`，热生效；摘要注册表在状态目录）；可选 OIDC JWT 校验 issuer、audience、scope。资源 URL 与配置的受信 `mcp.public_url` 比较（只比较 Host 与固定 `/mcp` 路径，不信转发头），兼容反向代理 / TLS 终止 |
| 设备 | 一次性配对码（默认 10 分钟内有效，并发兑换仅一次成功）→ 设备凭据（不过期，撤销或重配时失效）；重复连接默认拒绝。凭据轮换 / 已配对设备重新配对**尚未提供**（跟踪于 [#165](https://github.com/ArnoChenFx/Rovloom/issues/165)），目前凭据丢失或泄漏时在管理页撤销该设备，并把 Connector 当作新设备重新首次配对 |
| 管理员 | 独立 listener、会话与 CSRF；高影响操作（撤销、禁用 provider、停服）要求管理员在后台真实确认，不接受模型自填 `approved: true` |

固定 Bearer 的开发模式仅限 loopback。

## 6. 持久化与默认限额

单个 SQLite 库、单 writer；大对象存文件并在库里记录摘要与引用。新目录/文件请求 0700/0600，不改写已有路径的权限。项目未发布，只维护当前 schema；遇到旧版或未知 schema 在任何写入前拒绝。

| 项 | 默认 |
|---|---|
| MCP 请求体 | 1 MiB |
| Wire 单帧 / 单结果 | 1 MiB |
| MCP 单页 | 64 KiB |
| 每设备在途 / 等待 / 订阅 | 8 / 4 / 8 |
| 执行超时 / 长等上限 | 30 秒 / 10 分钟 |
| `result_ttl` | 1 小时 |
| `metadata_ttl`（含 key 去重窗口、审计） | 30 天 |
| `storage_max_bytes` | 512 MiB；超限拒绝新调用，不提前删除未过期元数据 |

期限在首次登记时固定，读取、重试、晚到都不会刷新。时钟回退时拒绝新调用，不延长已有期限。磁盘或 I/O 写失败时进入 `storage_degraded`：停止新派发与配对，不报告未提交的变更已生效；可能已送达的调用保持 `outcome_unknown`。

**备份与恢复**：备份只包含元数据，默认不含结果原文与凭据。从备份恢复后一律**重新配对所有设备**（旧设备凭据、未消费的配对码失效），所有 provider 默认禁用，调用方 ACL 需重新授予；备份之前的 `outcome_unknown` 保持未知，不重放。不检测整机回滚。

## 7. MCP 工具面

| 工具 | 职责 |
|---|---|
| `machines_list` / `machines_get` | 查询可见设备、连接与健康 |
| `providers_list` | 查询可见 provider、kind、binding revision、启停和 readiness |
| `runtime_describe` | 某个 Target 的方法表、参数 schema、权限与传输 |
| `runtime_call` | 发起调用；短等或返回 `call_id` |
| `runtime_call_get` / `runtime_call_cancel` | 读取状态与证据 / 请求停止等待 |
| `runtime_result_read` | 分页读取结果 |

设备注册、改名、撤销以及 provider 启停只在管理 UI / CLI，不经 MCP。调用方只提交 `method / params` 等允许的字段，不能提交原生 request id 或认证字段。所有列表与计数按调用方 ACL 过滤。

## 8. 可观测性

健康分层报告：Gateway 状态、设备连接、各 provider 的 enabled / readiness、model provider 或 Agent 任务错误。单个 provider 的故障不等于设备离线，model API 错误不等于网关断线。指标包括在途 / 拒绝 / 延迟 / unknown / 重连 / 认证失败，标签有界，不含目标内容。

## 9. 工程约定

- 语言 TypeScript；开发和发行使用 **Bun**。`package.json` 只声明最低版本（`engines.bun`）与依赖范围，提交 `bun.lock` 保证 CI 可复现；CI 同时跑最低版本与最新版本。版本固定不是质量门禁，详见 [ADR 0003](adr/0003-bun-toolchain.md)。
- 质量门禁：`lint`、`format:check`、`typecheck`、`test`、`build`、`smoke`。需要真实机器或第三方 runtime 的验证放在端到端验收（issue S7），不进单元测试门禁。
- 注释写给读者：模块职责、公共接口、不明显的约束和安全决策需要注释；不要求每个函数都有。

## 10. 参考

- Luvus：[UHP](https://luvus.dev/docs/uhp/getting-started/)、[方法](https://luvus.dev/docs/uhp/methods/)、[契约](https://luvus.dev/docs/uhp/conformance/)、[终端](https://luvus.dev/docs/uhp/terminal/)；固定输入见 [开发指引](DEVELOPMENT.md#固定输入与维护用途)。
- MCP：[生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、[传输](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[授权](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)；[TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。
- Herdr：研究边界见 [ADR 0004](adr/0004-multi-runtime-provider.md)。
