# Rovloom：多机器通用 MCP 系统设计

版本：0.5 · 日期：2026-10-18 · 原作者：Luvus Tester
状态：用户已批准同一 Gateway 支持 Luvus 与 Herdr；多 runtime provider 公共契约为冻结候选，具体实现待父会话协调。四项安全原则与管理 UI 要求沿用，Bun 工具链已在 main 验收；多 provider 尚未实现。
范围：仅文档，不启动编码 Agent，不变更已有实现和运行中 Luvus 会话。
配套：《IMPLEMENTATION-PLAN.md》。本文替代此前讨论中的概念草案，不覆盖旧编码 Agent 文件。

项目展示名为 **Rovloom**，仓库暂名 `luvus-mcp`。Luvus/Herdr 是受支持的原生 runtime 名；package、CLI、工具/环境变量/协议字段等既有机器标识保持兼容，详见 [README 命名说明](../README.md#name-and-compatibility-identifiers)。原作者署名与历史证据保持原文。

修订基线：main `5124d459fa0f712fd1dbb9f164a3513e3e538716`（含 Linux Luvus P0、安全设计与 Bun 基线）。本次只修订文档；安全原则见 [ADR 0002](adr/0002-safety-retention-recovery-late-evidence.md)，公共字段、迁移与分阶段边界以 [ADR 0004](adr/0004-multi-runtime-provider.md) 为准。

v0.4 补充：历史范围/恢复/预留耗尽保证边界、[内置 Web UI 设计](GATEWAY-WEBUI.md)（issue #14），并记录先行 Bun 迁移 #15。P0 中 Node/npm/SDK 的真实历史证据不改写为 Bun 通过。

v0.5 补充：同设备一套身份/一条 Connector 出站连接、多 runtime adapters；显式 provider Target、可信 binding、独立权限/契约/恢复保证和 wire v2。文中 UHP/Host/native replay 条款专属已验证的 Luvus，不套用到 Herdr；Provider key 等历史措辞指 model provider 的密钥，不是 runtime provider 身份。

## 1. 设计结论

构建一个项目、一套 Rovloom 程序，提供 gateway 与 connector 两种运行模式；设计中的可执行标识 `luvus-mcp` 暂作兼容标识保留，不在本轮重命名：

- Gateway 集成 MCP Server、设备注册、身份与权限、请求路由、结果账本和订阅管理。
- Connector 部署在每台目标主机，一套设备身份、一个主动 WSS 出站连接，运行多个可信配置的 Luvus/Herdr adapters。
- 主 Agent 按稳定 `machine_id + provider_id + profile + session` 指定实例，机器/provider 展示名只用于查询展示；新 provider 不继承另一实例的授权。
- 对外是少量通用 MCP 工具；功能目录和参数按远端发现，不为数百个 UHP 方法逐一包装工具。
- 普通调用、持续事件/终端通道、Host profile 分别适配，共用路由和权限机制。
- Luvus 全功能口径仍为受支持 UHP 能力；Herdr 首个切片仅发现/状态/核实被动只读/事件状态重建，不宣称等价 UHP、终端控制或全部写入。所有能力均须明确授权。

本文所有新增工具名、CLI、网络帧、错误码和默认值都是拟议网关协议，不是 Luvus/Herdr 已有接口。

## 2. 用户需求与边界

### 2.1 必须满足

R1. 无 SSH；支持多台不同内网机器；目标机只需能主动访问 Gateway。
R2. 同一个程序、同一个版本分发，运行不同角色，不拆成三个独立产品。
R3. 注册分配 ID，可改名；机器列表可见在线状态、版本、标签和连接健康。
R4. 主 Agent 可发现、描述和调用任意获授权的远端 UHP 方法，包含 workspace、pane、agent、Git、DIFF、worktree、task、automation、module、UI 等。
R5. 支持多轮 agent 对话、长等待、持续事件、终端观察和获授权的终端控制。
R6. 显式目标，防止跨机器、跨 session、跨终端误操作；断线不可盲目重放变更。
R7. 不泄露 Provider key、设备凭据和 UHP delegated token；有审计和资源上限。
R8. 机器增删和配对可由获授权主 Agent 发起，但目标机器的本地安装与授权不能由注册动作凭空代替。
R9. 同 Gateway/同设备可同时有 Luvus、Herdr 及多个同 kind 实例；同名 method/session/terminal ID 的路由、权限、结果与去重彼此隔离，不跨 provider 自动 failover。

### 2.2 不在首版承诺内

- 不替代 Luvus UI，不复制 TUI 渲染器，不自建 agent harness。
- 不提供独立任意 shell RPC；需要命令执行时使用已授权的 UHP 终端/pane 能力。
- 不承诺任意 shell/agent 在 server 重启后续跑，不把 queued 当 completed。
- 不做公网裸端口、不做无认证 WS；不自动安装或升级远端 Luvus。
- 不做多 Gateway 主动/主动集群或跨租户 SaaS；首版为单管理员空间、单活 Gateway。
- 不把跨机器任务当作分布式事务；每次调用只对应一台机器，跨机器流程由主 Agent 编排。

## 3. 已核对的底层事实

以下是外部协议事实，区别于本文自己的设计决策：

F1. Luvus UHP 使用结构化请求和响应，普通请求可通过 `luvus uhp proxy` 处理；持续事件及终端流需连接发现的本地 endpoint。Host profile 是另一入口，可以在 session 未运行时使用。[S1]
F2. `luvus uhp schema` 输出安装版本的 schema bundle，不需启动 server；`uhp.capabilities` 是运行中服务的能力发现。不能假定存在 `uhp.schema` 这个 RPC 方法。[S2]
F3. UHP 有并发 revision、终端身份及事件恢复要求；客户端需处理 generation 变化与事件缺口。[S3][S4]
F4. MCP 可通过 stdio 或 Streamable HTTP 承载；HTTP 授权和本地 stdio 凭据获取方式不同。[S5][S6]
F5. Herdr v0.9.5 固定源码 commit `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01` 使用 JSON socket id/method/params，安装 schema 来自 `herdr api schema --json`，ping 协议号 22 与有限能力不等于完整在线方法目录；无等价独立 Host/通用 cancel/通用原子 terminal fence。事件缺口只能重建当前状态，recent 读取副作用与 prompt 完成归属须单独验证。[ADR 0004 官方来源](adr/0004-multi-runtime-provider.md#官方来源与核验边界)

v0.2 最初只读核对 Luvus 0.14.3；随后 #3 的 Linux 原生 RPC、Host、事件和终端控制已获验收，范围与证据见 [P0 契约与回放指引](p0/README.md)。安装 schema 223 个方法中 144 个仅有通用 params object；不能把存在方法枚举当作完整参数约束。网页文档可能领先安装版本，以安装契约与实时能力为准。本次 v0.3 修订未新增运行测试。

## 4. 部署与信任边界

```text
主 Agent / MCP Host
        │ stdio（本地网关）或 MCP Streamable HTTP + HTTPS
        ▼
┌──────────────── Gateway ─────────────────┐
│ MCP facade / 主体身份 / 授权策略          │
│ 机器注册 / 设备凭据 / 路由 / 调用账本     │
│ schema 索引 / 订阅缓存 / 结果读取 / 审计 │
└─────────────▲────────────────▲───────────┘
              │ WSS 主动出站    │ WSS 主动出站
       ┌──────┴──────┐  ┌──────┴──────┐
       │ Connector A │  │ Connector B │
       │ 本地策略    │  │ 本地策略    │
       │ Luvus/Herdr │  │ Luvus/Herdr │
       │ adapters    │  │ adapters    │
       └──────┬──────┘  └──────┬──────┘
              ▼                ▼
       各 provider 实例    各 provider 实例
              ▼                ▼
         Pi / 其他 agent   Pi / 其他 agent
```

三条边界独立认证：
1. MCP caller → Gateway：谁可以控制哪些机器和能力。
2. Connector → Gateway：哪一个已注册设备在连接；不是靠 hostname/name 自报决定身份。
3. Connector → 本地 runtime：各 binding 的本地账号权限与适用的原生 delegated scope。

Connector 只允许管理员固定的各 runtime binary、状态根和 session 策略，由非秘密 config_ref/revision 绑定；主 Agent 不得提交路径、环境、endpoint 或任意 SSH 目标来选 adapter。设备广告不自动创建/重绑 provider；双方 binding 不一致拒绝派发。

### 4.1 两种 Gateway 部署

- 本地托管：MCP Host 以 stdio 启动 Gateway；Connector 连到此机器可达的 WSS 地址。进程退出后远端变 offline；日志只写 stderr，stdout 专供 MCP。
- 常驻托管：同一程序运行 Gateway daemon，MCP 走 HTTPS Streamable HTTP；推荐用于长期在线的多机器部署。无需额外开发独立 MCP 服务。

两种模式共用业务核心；同一数据库只允许一个 Gateway writer。不同 MCP stdio 客户端不能同时各自启动网关并争用同一状态目录。

### 4.2 Gateway 内置管理 Web UI

同一 Gateway 产物内置设备/连接认证状态的管理页，默认仅 loopback；管理 listener/API 与 Connector WSS、HTTP MCP 的身份和服务边界分离。页面与后端分别实施管理员认证/授权，敏感凭据不回显，变更有后台确认、revision/epoch fence 和审计。暂时断开仅关闭指定连接，持久授权不变；撤销则持久拒绝新认证并断开连接，不能把二者混为一项。

设备列表/详情包括 online/offline/可信 reconnecting、认证状态、最近心跳、失败原因与快照过期标记。恢复隔离时仅独立本机恢复管理员可看有限历史/诊断，禁止配对、发放新 scope 或开放业务；storage_degraded 不允许 UI 绕过写入门禁。最小页面、API、空/错误态、刷新与远程 TLS/访问控制要求见 [GATEWAY-WEBUI.md](GATEWAY-WEBUI.md)。issue #14 的顺序为 #8 → #14 → #9，硬依赖 #5/#6/#8；不增加外部网站或多租户平台，本轮不做前端开发。

## 5. 身份模型与数据

### 5.1 Machine

| 字段 | 规则 |
|---|---|
| machine_id | Gateway 生成的随机稳定 ID，不变、不复用，不由设备随意声明 |
| name | 管理员空间内唯一，可改；展示名与 ID 不混用；规范化后做唯一校验 |
| labels | 管理员可控标签，不作为设备身份 |
| status | pending / offline / connecting / online / degraded / revoked |
| device_credential_id | 内部凭据记录引用，不返回 secret |
| connector_instance_id | 每个 Connector 进程不同，用于诊断，不替代 machine_id |
| connection_epoch | 每次认证成功的通道绑定分配新值，隔离迟到响应 |
| last_seen_at | Gateway 接收心跳的时间，不相信设备时钟用于认证 |
| reported_info | OS、hostname、版本，仅未受信设备元数据 |
| policy_revision | 设备授权策略版本，用于拒绝过期授权 |

`name` 查询必须返回精确结果；无唯一结果则要求澄清。实际 `call`、stream 和危险管理工具必须传 machine_id，不提供隐式 current machine。改名不会改变 ID 和在途路由。

### 5.2 Runtime Provider Binding / Session

同一 machine 下有多个 provider_id；每个绑定一个固定 runtime 实例（kind=luvus|herdr）及可信 config_ref、单调 binding_revision、enabled。provider_id 不复用，kind/状态根/实例身份不能原地换成另一实例；替换须新 ID，原地升级须新 revision/重发现。runtime 与 model provider 命名空间分离。字段与生命周期详见 ADR 0004。

路由键：`(machine_id, provider_id, profile, session)`。新调用/开流必须带 expected_binding_revision，实际 revision 固定进 attempt；缺失不默认选择任一 runtime。
- profile=session：显式 session 名必填，包括 default；不继承当前 shell 的目标。
- profile=host：仅适用于 Luvus；无 session endpoint，目标 session 等参数遵循 Host 自身 schema。Herdr 仅 profile=session，不将 server.* 当 Host。
- 结果句柄再绑定 server_generation、terminal_id、workspace_id 等原生身份（若适用）。
- Gateway 自身 machine_id 与 Luvus 的 machine.* 方法记录完全不同，不复用 ID 命名空间。官方方法目录中，部分 machine.* 只存在于 `uhp access --machines`；首版 host/session 接入不能假称支持该专用 profile。覆盖账本将其标为 profile_not_exposed，后续如有需求再独立接入，不把它用作本 Gateway 设备注册后端。[S2]
- Herdr 的 machine/SSH federation 同样不作为 Gateway 注册、出站通道或隐式跨机器转发后端。所有原生 ID、session、句柄、分类与契约缓存均带 provider/revision。

### 5.3 持久化建议

Gateway 使用 SQLite（事务、schema migration、单活 writer），保存 machines、provider bindings/revisions、enrollment、credential hashes、policy、calls、contract sources、result metadata、audit、stream metadata。大结果保存受限文件对象，数据库只存引用和摘要。现有 v3 待 #5 原子迁移；来源可证明的旧记录仅映射唯一 legacy Luvus binding，ACL/去重/句柄一同迁移，不明来源禁用、旧摘要/TTL/墓碑不丢，详见 ADR 0004。恢复后的 binding 默认禁用重新确认。
Connector 使用权限受限状态目录保存设备凭据及最小调用日志；Linux/macOS 建议目录 0700/文件 0600，Windows 使用等效 ACL，不把 POSIX mode 当跨平台安全保证。

在线状态、WS 对象不从数据库“恢复为 online”。Gateway 重启后一律等待设备重新认证；不执行持久化的待发变更。

### 5.4 备份恢复的隔离边界

备份可能早于撤销、配对消费或调用送达记录；校验文件完整不等于证明安全状态是最新。支持的恢复流程必须在独立目录先进入 `recovery_quarantined`，关闭业务派发、结果读取、Connector 认证和 enrollment 兑换，只允许受保护的本地恢复管理。不能把备份中的 ready 标记、管理员角色或旧凭据作为解除隔离的授权。

恢复过程至少完成：

1. 核实无旧 writer，保留源备份且不自动删锁；验证数据库 migration、对象引用和备份时间/版本，不能执行备份中的命令或任意路径。
2. 产生新的 `recovery_generation`（恢复代次，区别于 connection_epoch 和 Luvus server_generation），使恢复前的设备凭据/配对凭据全部不可用于认证；未消费 enrollment 也一律失效。机器 ID 可留作历史引用，需受信本地管理员逐机确认后重新配对，不能凭同名自动接管。
3. caller ACL、Owner/Host admin、清理权限及策略先按拒绝处理。只有独立于旧备份的可信当前策略或新的本地管理员确认才能重新授予；旧 OAuth token 的签名有效不能证明旧 ACL 仍有效。此流程描述未来管理机制，本次不创建或轮换任何真实凭据。
4. 所有设备 offline，所有通道/流句柄失效，新连接重新分配 epoch 并绑定新恢复代次；恢复前的晚到回复不能补写恢复后的调用。
5. 关闭恢复前的去重范围，旧 history_epoch 只作为历史引用，不导入 active 集合；不得把旧 call、pending 队列或客户端重试缓存自动改写到新恢复代次/新范围。备份中缺失的旧 key 返回 `dedup_history_unavailable`，绝不据此新建并派发；恢复记录中的“未发送”若缺少覆盖备份后时间段的可信证据，也不能作为未执行证明。已知结果只作注明备份时点的历史证据，未能证明结局的在途调用标记 unknown。
6. 按原始过期时间与显式 discard 状态清理/屏蔽内容，不能因恢复或重新授权刷新 TTL；保持历史墓碑。若备份后是否发生 discard/过期/撤权无法由独立可信当前资料确认，所有恢复原文默认不可读，不得从旧副本建句柄；仅重授权不足以证明原文可以复活。默认备份本就不带原文；例外包含原文的备份也受这条保守规则限制。
7. 记录恢复来源、丢失时间段、重新授权和重新配对结果，经本地受信管理员显式解除隔离后才创建并发放绑定新 recovery_generation 的 history_epoch。新范围只受理重新授权后由 caller 明确发起的新意图；旧消息缺少/不匹配恢复代次、缺少原范围或要求自动换范围时一律拒绝，不自动恢复发送队列。

默认不依赖外部防回滚服务，因此不承诺从一份旧备份重建其后全部撤销/调用历史；采用失效旧认证、拒绝旧范围和人工对账来控制风险。完整性/新鲜度无法证实时继续隔离。该保证适用于支持的恢复流程；手工替换全部运行文件或整机快照绕过恢复流程，不能靠同样被回滚的数据库标记自动识别，也不得宣称具备这种检测能力。

## 6. 注册、配对和凭据生命周期

### 6.1 注册分两步

1. 获授权用户/Agent 调用 `machines_register`，填写 name、labels、初始 policy，创建 pending 记录。
2. 由受保护的管理渠道签发一次性短时 enrollment credential；主 Agent 只收到 registration_id、配对状态和不含凭据的提示。
3. 目标机管理员运行同一程序的 Connector，通过本地安全输入/受限文件完成配对。
4. Gateway 事务性消费 enrollment，分配/绑定 machine_id，签发独立的高熵设备凭据。
5. 设备保存凭据，后续重连使用设备身份，不复用 enrollment；Gateway 仅存验证所需摘要。
6. 完成策略、协议协商和能力发现后 online；仅 socket 接通不等于 ready。

建议 enrollment 有效期 10 分钟、仅可消费一次；并发兑换只有一次成功。上述数值为可配置默认草案。

### 6.2 生命周期

- 改名：授权检查 + 唯一性事务，保留 ID。
- 轮换：有界双凭据过渡，成功后撤销旧凭据；日志不保存明文。
- 撤销：立即拒绝新请求、断通道并关闭订阅；已送入 Luvus 的工作不保证自动停止。
- 重装：凭据丢失需人工批准重新配对，不能凭同 hostname 自动接管旧 ID。
- 克隆：同一设备身份并发连接默认返回 duplicate_device_connection，不静默“后连接踢前连接”。明确 takeover 必须有授权并更新 epoch；旧 epoch 响应隔离；同一有效 epoch 的晚到证据另按 §11.1 处理。
- provider 禁用：独立 providers_manage 权限、真实管理确认、新 binding revision，阻止该实例的调用/流/结果读取与补证；设备身份及其它 providers 不受影响。不停止原生工作、不复活旧句柄，重新启用须重发现/重授权。设备撤销则覆盖全部 providers。

## 7. MCP 工具面

所有工具均按调用者 ACL 过滤目标；只返回调用者有权看到的机器、方法和结果。

### 7.1 注册管理

| 工具（拟议） | 主要输入 | 主要输出 |
|---|---|---|
| machines_list | filter、cursor、limit | 可见机器分页 |
| machines_get | machine_id 或精确 name（只读） | ID、连接状态、健康、策略摘要 |
| machines_register | name、labels、requested_policy | registration_id、pending；不含配对 secret |
| machines_rename | machine_id、name | 更新记录 |
| machines_revoke | machine_id、reason | revoked；报告在途调用状态 |

注册/撤销需要 admin 权限，不能因 caller 能使用 agent 就自动授予设备管理权限。危险动作若配置审批，审批是 Gateway 的真实状态与外部人工授权，不接受模型自填 `approved:true`。

### 7.2 能力与调用

| 工具（拟议） | 职责 |
|---|---|
| providers_list / providers_get | 返回当前 caller 可见的已配置实例、kind、binding revision、启停/可达状态；不返回秘密配置 |
| runtime_discover | 指定完整 Target，返回 ContractSource、方法摘要、独立分类/schema/传输/支持状态、保证与有效权限 |
| runtime_describe | 按 method 或关键词查对应 provider 的契约与调用语义；按需分页 |
| runtime_call | 发送一条 native_request；短等待或返回 call_id，保留该 provider 原生结果 |
| runtime_call_get | 读取调用状态；结果大时分页/句柄，不暗中重试 |
| runtime_call_cancel | 请求停止等待/桥接，返回实际取消程度，不声称撤销原生动作 |
| runtime_result_read | 按原 provider/binding 重授权读取结果句柄，支持 cursor、字节上限和 TTL |

新工具使用 runtime_*；旧 luvus_* 仅为明确 Luvus 兼容别名，不可静默路由 Herdr。以下为 runtime_call 的 Luvus 示例；request id/凭据仍由 adapter 管理：

```json
{
  "target": {"machine_id":"m_01","provider_id":"p_luvus_01","profile":"session","session":"agent-lab"},
  "expected_binding_revision": 1,
  "native_request": {"method": "agent.list", "params": {}},
  "wait_ms": 10000,
  "execution_timeout_ms": 30000,
  "expected_server_generation": "optional-observed-generation"
}
```

`native_request` 保留对应 schema 的并发/幂等字段；Luvus 与 Herdr 分别验证，不能互相补字段。Gateway 分配原生 request id；auth/凭据/目标注入字段保留，禁止 caller 传入或读取。绝不合成自动确认字段。带 key 调用另须 ADR 0002 的 history_epoch/recovery_generation（示例省略）；provider_kind/contract_ref 由可信 binding/契约解析而非 caller 自证。

响应外壳示意：

```json
{
  "call_id": "call_01",
  "target": {"machine_id":"m_01","provider_id":"p_luvus_01","profile":"session","session":"agent-lab"},
  "provider_kind": "luvus",
  "binding_revision": 1,
  "contract_ref": "sha256:example-contract-reference",
  "state": "responded",
  "delivery": "response_received",
  "native_response": {"id":"u_01","result":{}},
  "truncated": false
}
```

Gateway 错误放 gateway_error，原生错误保留在 native_response.error，不混命名空间；uhp_response 仅供显式 legacy Luvus 兼容入口。无原生回复不伪造 result。原生内容只在安全分类允许且 §12.3 期限内提供；过期/discard 后仅返回状态与最小证据，不再生 result_id。

### 7.3 流与终端控制

| 工具（拟议） | 职责 |
|---|---|
| runtime_stream_open | 完整 Target、expected_binding_revision、原生 streaming method/params，打开已适配通道 |
| runtime_stream_read | stream_id、cursor、max_bytes、wait_ms，有界读取与缺口状态 |
| runtime_stream_write | stream_id、frame；仅向已验证获授权双向通道写入原生允许帧，Herdr MVP 禁用 |
| runtime_stream_close | 释放订阅、本地连接和适用的原生 lease；不默认关闭 pane/agent |

不把无限流作为一直不返回的 MCP 工具调用。MCP Host 通过句柄分批读；协议通知可作优化，但不能作为唯一可靠结果渠道。
Luvus 终端 control 的双向输入不是普通 RPC：仅 open/read 不足以覆盖，因此明确 stream_write；capture 等一次调用仍走 runtime_call。Herdr 不因工具同名继承该控制协议。
二进制/图片上传只在远端公布且已完成帧/容量验证后宣告支持；未适配的子协议返回 unsupported_stream_feature，而不是宣称全覆盖。

## 8. 能力发现和 schema

有效执行方法集 = 远端实时支持 ∩ 可信且完整的安全分类 ∩ 已适配传输 ∩ 接入权限（若有）∩ Gateway caller 策略 ∩ Connector 本地策略；schema 校验状态单独判断。

发现步骤：
1. Connector 获取安装 binary version 和本地 `luvus uhp schema` bundle，计算 hash。
2. session 通道查询实时 uhp.capabilities；host 通道查询 host.capabilities；两者不混为一张权限表。
3. 按 machine/provider/binding revision/kind/profile/session/generation（原生有则使用）/binary/schema hash/adapter revision/双方 policy revision/安全分类 revision 缓存；重启/升级或契约不匹配则失效。
4. describe 从 schema 提取方法相关分支，同时保留所有传递引用、根约束、条件约束及外部 document 依赖；不能只剪出一个 properties。
5. 每次变更前重新确认目标在线、epoch、generation 和策略；过期发现返回 capability_stale，不透明降级。

以上 CLI/capabilities 流程属于 Luvus。Herdr 用自己的安装 schema 与 ping 版本/有限能力；support_basis=schema_and_version，候选方法不得伪报在线验证。公共 ContractSource 必须可追踪 binary/schema 哈希、命令、server/protocol、原生 generation（没有则 null）、adapter/classification revision；describe 逐方法声明 event_recovery/terminal_fence/cancel/prompt_completion 保证，枚举见 ADR 0004。schema 状态与安全分类不得跨 kind、实例或同名方法继承。

安全分类与参数 schema 是两个独立维度。分类必须来自绑定确切版本/契约的受信本地评审资料及已核验原生 method_contracts，至少说明：作用（读/写/外部副作用、是否幂等及传输类型）、高权限（Owner、Host admin、任意终端/agent 执行、凭据管理和所需确认）、结果是否可能包含秘密及其保存/交付方式。字段缺失、来源不受信或互相冲突即 `classification_unavailable`；不能凭方法前缀、通用 object schema、客户端自报或远端广告自行补齐。原生声明不能提升本地授权。

若 provider 没有等价完整的原生 method_contracts（Herdr 当前即属此类），必须由固定 binary/schema 的可信本地评审补足全部安全维度；未齐全仍拒绝，不能拿有限 ping/schema 当安全声明。

未知/未完整分类的方法允许被发现，但默认拒绝执行，Owner 和 raw-contract 也不能绕过。应分别展示 classification_status、schema_status、transport_status 和策略拒绝原因。凭据/令牌类秘密结果需要专门 custody 或默认拒绝该调用；一般潜在敏感内容需明确的读取授权、保留与交付规则，不声称能自动识别所有秘密。“只读”不代表结果可直接交给模型，也不能把真实 token 混入普通结果句柄/日志。通用 action.invoke 或流控制的子动作也必须分类，不能以已知容器方法包住未知作用。

旧 binary、新 server 或相反的情况：返回版本及 schema 来源。严格模式中，参数契约缺失/不完整时拒绝。只有安全分类完整、传输已适配、当前双方策略允许且秘密结果路径已落实的方法，Owner 才能显式选择仅放宽参数校验的 raw-contract；标注 validation=unavailable，仍执行 envelope、大小、保留字段和安全检查。它不能替代完整参数验证，不能把网页 schema 冒充安装版，也不能自动允许新增流帧。P0 的 144 个参数缺口不能自动等同于 144 个安全分类未知，反之亦然。

## 9. Connector 的原生适配

§9.1–9.3 是 Luvus adapter；各 adapter 共用设备连接与有界调度/预算，保持自己的原生契约。单 provider 故障不冒充设备断线。

### 9.1 普通调用

以固定 argv spawn 管理员指定的 luvus binary：明确 --session 和固定状态根，写入单条 JSON，收集有界 stdout、stderr、exit status。使用 shell=false，不拼接命令字符串。不要硬编码默认 socket 路径。

长等调用有独立执行 deadline；MCP 前端等待窗口到期可返回 call_id，不能因此自动杀死动作并宣称未执行。stdout 超限、格式错误、进程异常与原生 UHP error 分开报告。

### 9.2 流调用

以 `luvus session list --json` 的 endpoint 为发现入口，读取现有 running 行并验证本地归属后连接 Unix socket / Windows named pipe；不从 session 名手工拼平台路径，也不接受远端命名管道地址。这个入口在官方终端文档中有说明，但仍需对每个实际目标版本/平台实证；缺少有效 endpoint 时返回 endpoint_discovery_unavailable，不发布该平台流支持。[S4]

保留原生 handshake、frame、序列、terminal identity、control lease 和 ack；网关不改写原生 content revision。控制流独占租约交由 Luvus 决定，不能靠 Gateway 单方面声称拥有控制权。[S4]

### 9.3 Host profile

host.call 仍经 profile=host 的通用调用，不另建任意命令执行入口。Host 能力、普通 session 能力及 schema 来源分别报告；Host 的安装、删除等确认字段只能由获授权且确有确认的操作携带。[S1][S2]
Gateway 停止/重启目标 session 的回复丢失时，采用 Host 只读状态查询对账，不重新发一次 stop/restart。

### 9.4 Herdr JSON adapter 的分阶段范围

只读研究 v0.9.5/协议22不等于原生运行验收；先经独立 P0-H 验证固定 binary/schema、endpoint 归属/peer、framing、被动只读与事件恢复。首个切片仅发现、状态、核实被动只读、事件失效后当前状态重建；排除未核实 recent 读取、prompt/run/input、Host 模拟及 UI renderer。外层 binding/generation 检查不能补造原子终端 fence；prompt wait 仅为状态观察，不保证本 prompt 完成；取消仅释放可确认的桥接资源。写入/终端后续单独验证，具体边界见 ADR 0004。

## 10. Gateway ↔ Connector 自定义协议

传输：WSS；一个 WebSocket message 对应一个 UTF-8 JSON envelope。新业务协议 major=2/minor=0；必填 provider/native/契约字段不塞入严格 v1。旧 v1 默认不开业务执行；需要兼容须显式锁定迁移证明的唯一 legacy Luvus binding，缺少安全历史证明仍拒绝，禁止失败后自动降级/跨 runtime 重试。完整兼容规则见 ADR 0004。此 wire 版本与 MCP revision 独立。

Envelope 基本字段：protocol_major/minor、type、message_id、connection_epoch、payload。
类别：enroll、authenticate、welcome、request、accepted、response、stream_open/data/input/close、cancel、heartbeat、error。
- TLS 验证必需；只有显式本机开发模式可用 loopback ws。
- credential 不在 URL query、日志或 MCP 输出里；按受保护的握手流程传输。
- major 在业务前协商，不兼容拒绝；minor 仅协商显式 feature 交集，未知字段/枚举拒绝，不静默剥除；安全必需字段变化升级 major。
- request/accepted/response/cancel/流均关联认证 machine、provider_id、binding_revision、provider_kind、profile/session、contract_ref、recovery_generation、call/attempt/epoch/native id；v2 用 native_request/native_response。旧 binding/provider 或 epoch/恢复代次/其它 attempt 的回复不能补写结果。
- 去重范围使用由 Gateway 发放的 history_epoch（§11.2）；它不是设备 credential、连接身份或 Luvus generation。字段名/编码与能力协商由 #4 冻结，客户端不能自行创造有效范围。
- frame 和并发有限额，校验 type、大小、嵌套深度和 deadline；Connector 不可无限 spawn。
- 心跳只证明通道健康，不证明本地 Luvus/Provider 健康；健康报告分别列出。

不设计自动远端写任务队列：离线请求立即失败；不能网络恢复后突然执行旧 prompt。

## 11. 调用状态机、超时与幂等

```text
created → authorized → dispatching → connector_accepted → responded
   └──── not_dispatched / rejected / expired_before_dispatch
                    └──── outcome_unknown（可能已进入 Luvus）
                              └──── responded（仅同一已验证 attempt 的可靠晚到证据）
```

Connector accepted 表示桥接接收，不等于 Luvus 执行，也不等于 agent 消费 prompt。Gateway 有记录不等于完成。

| 情形 | 返回语义 | 是否自动重发 |
|---|---|---|
| 未上线/未授权/尚未派发就超时 | not_dispatched 或 rejected | 不自动排队 |
| 发送后断线、子进程被终止、Gateway 崩溃 | outcome_unknown | 写操作禁止自动重发 |
| 获得原生 UHP error | responded + 原始 error | 由 caller 对账后决策 |
| 获得 submitted/queued | responded，但业务未完成 | 不补发 prompt |
| 只读临时失败 | 可新建 attempt，保留历史 | 仅契约标记只读且策略允许、有总 deadline |
| 同一已验证 attempt 的可靠晚到 response | 可追加证据并细化 unknown；内容过期则只存最小元数据 | 不重新派发、不改写原超时通知 |
| 旧 epoch/恢复代次、其它 attempt 或无法关联的回复 | 隔离或拒绝，当前结果不变 | 不自动重试 |

Gateway client_request_key 在 §11.2 的受信历史范围内，去重同一 caller + 目标 + 请求摘要的重复提交；同 key 不同请求报 conflict。账本持久化用于减少重复，不能承诺 exactly-once。Gateway→Connector 跨崩溃与本地 UHP 执行不可能在本设计里事务性提交。
原生幂等键只用于实时能力明确支持的方法，保持原位置和值；普通 request id 不是幂等键。
取消 MCP 等待不会回滚远端命令；发送取消请求仅尽力释放观察/本地子进程资源，若已执行返回 cancel_unconfirmed。终端 stream_write 同样区分 queue admission 与原生 ack；断线丢 ack 时不能自动重发输入。

Gateway 的 expected_server_generation 只提供桥接层的目标核对：若原生方法不支持同一临界区内的身份/revision 前置条件，就不能保证检查与执行间绝无重启竞态。严格控制应使用原生 fence；缺少 fence 的操作必须在 describe 中标注保证强度，不能宣传外层字段具有原子性。

该边界逐 provider/方法适用。Herdr 普通 JSON 输入不提供等价通用原子 terminal incarnation fence，写入/控制未验收即禁用。只读重试也须证明 method+params 无输入/滚动等副作用；不能按 read 前缀自动换 attempt，更不能跨 provider failover。unknown 补证另外要求原 provider binding 仍可信有效且未禁用，不能把同名原生 id 的其它 adapter 回复接纳。

### 11.1 可靠晚到回复只能补充原 attempt 的证据

晚到不是新执行。仅当接收上下文已认证且仍有效、机器未撤销、恢复代次/connection_epoch 仍与原 attempt 一致、call/attempt/native request id/目标全部匹配、原生 response 对应契约与 frame 校验通过时，才可在同一 writer 事务中补充 `outcome_unknown`。若 call 已转入其它 attempt、已有冲突终态或历史记录已过期，不更新当前结果；旧 epoch 的 Connector 缓存重发也不例外。普通断线重连/恢复会产生新 epoch/恢复代次，因此不保证跨这些边界接纳原晚到回复。

保留原先发送、超时、取消、unknown 的历史事实和证据到达时间/摘要；最新视图可变为 responded + late_evidence=true，不把它说成在 deadline 内完成。原生 queued 仍只证明排队。相同已验证 response 的重复消息不产生新句柄或执行；不同内容的冲突回复不覆盖已接受结果，作有界审计/隔离。取消不会撤销真实动作，也不阻止在这些条件下记录其可靠结果。

补充结果受当前授权、分类、内容 TTL 和 discard 状态约束：内容已过期/已清理时只留受保护的最小证据（相关 ID、接收时间、response hash/长度、result/error 类别），不保存原文、不重新生成句柄、不延长任何保留期限。原始调用/墓碑已删除则不凭回复重建调用。此规则不授权重新派发、接收旧认证通道，或让其他 caller 读取结果。

### 11.2 有限去重窗口与旧范围拒绝

去重墓碑默认保留 30 天，自首次原子登记调用时固定 dedup_expires_at，不随重试、句柄读取或晚到回复续期。它保留 caller、目标、请求摘要、key 的受保护摘要、原 call/attempt 关联、过期/discard 状态及最小结局信息，不含原始参数或结果；在窗口内同 key 返回原状态，内容过期也不能变成新执行。

为了让有限墓碑到期后仍拒绝旧提交，受保护的调用范围还绑定 Gateway 发放的 `history_epoch`。每个范围允许登记新 key 的时长默认最多 24 小时，且必须不长于该范围冻结的墓碑期限；之后只可查询/重返仍存在的同 key，未找到时返回 dedup_history_unavailable，禁止新建。新调用使用新范围；客户端重试不能自动把旧 key 改绑新范围或生成新 key。缺少有效范围的带 key 调用拒绝，不静默套用当前范围；跨范围的同文本 key 是新意图，不承诺去重。

Gateway 只接受自己仍登记且绑定当前恢复代次的范围；旧/未知范围即使其逐 key 墓碑已清理也不能新建调用。恢复、历史损坏或无法证明未发生回滚时关闭旧范围，进入 §5.4 的恢复流程；不以备份里“没有这个 key”作为首次调用证明。最小字段及兼容迁移由 #4/#5 实现，现有 v3 不具备这一保证。

范围的创建时间、accept_new_until、绑定的恢复代次和 dedup_ttl 必须由 Gateway 原子持久化，不能只相信客户端给出的时间或 signed-looking 字符串。每条新调用使用其范围冻结的 dedup_ttl，满足 `accept_new_until <= scope_created_at + frozen_dedup_ttl <= call_created_at + frozen_dedup_ttl = dedup_expires_at`；新 key 的准入采用严格 `now < accept_new_until`。因此任一墓碑最早到期时，该范围已经不允许登记新 key；查 key 与检查范围必须在同一 writer 事务完成。配置缩短期限要创建新范围并先退役旧范围，不能保留旧 active 范围却缩短其中调用的墓碑。

| 提交所在范围/记录 | 允许行为 |
|---|---|
| 当前恢复代次内 active 范围、同 key 已存在 | 返回同一调用；摘要不符报 conflict，不再次派发 |
| 同一 active 范围、key 不存在，所有准入检查通过 | 可原子登记新调用；此为范围内的新意图 |
| 已退役但仍可信的范围、同 key 仍存在 | 只重返原状态，不续期、不复活内容 |
| 退役范围 key 已到期/缺失，或范围记录已清理/未知 | dedup_history_unavailable；不得改用当前范围补建 |
| 恢复前范围、恢复代次不匹配或历史完整性存疑 | 拒绝创建；仅按受限历史查询/恢复流程处理 |

范围记录可在其引用窗口结束后清理，但缺记录必须等于不可信，绝不能回退为 active。普通重启只有在范围与账本完整性可确认时保留原范围，否则按恢复隔离处理。scope ID 永不复用；客户端重试须保留原 recovery_generation/history_epoch/key 关联，不能在收到过期/恢复错误后自动 discovery 当前范围并重发。Gateway 没有跨范围的无限内容相似性判重能力；显式新意图使用新 key/范围后，即使参数与历史相同，也可能执行。这是已声明的保证边界，不能把“换范围重新发送”当作透明恢复或 exactly-once。

未携带 client_request_key 的调用没有客户端重试去重保证，同样不得由网关补发 unknown 写操作。超过 30 天不承诺仍有逐调用结果/去重查询记录，但旧范围拒绝创建仍成立；用户明确采用新范围/新 key 发起新意图时可能再次执行，不能被包装成一次“安全重试”。

## 12. 事件恢复、背压与大结果

### 12.1 事件一致性

遵循原生 subscribe → 另连接 snapshot → 丢弃 snapshot 之前缓冲事件 → 顺序应用；缺口、overflow、EOF、generation 变化后标记 resync_required 并重取快照。[S3]

上述序号规则仅用于已验证的 Luvus。Herdr 的事件与 snapshot 没有共同序号边界；events_lost/断线时显式 gap，重新订阅后另连接 snapshot 整体替换缓存，事件只作失效信号，串行刷新且读取中有事件则再读。不把缓存事件载荷重放到快照上，不编造 sequence/replay 或历史连续性；state_rebuild_only 只恢复当前状态。两种游标/恢复状态均按 provider/binding/session 隔离。

保留两种游标：原生 event_sequence 与网关 delivery_cursor。delivery_cursor 不代替原生连续性。多机器的序号没有全局时序意义。
流重连不宣称无损：原生重放窗口不够时明确 gap；终端 observe 不支持重放时重新 capture。

### 12.2 资源边界建议

- 普通 MCP 返回默认最多 64 KiB；较大完整 UHP 回复保存为 result_id，返回摘要、长度、hash、截断标记和读取方式，不静默丢字段。
- 传输 envelope 分片后重组，且单个 UHP payload 不超过远端广告上限；schema bundle 作为独立有界对象传输，不受 session frame 限制猜测。
- 每设备普通在途 8、等待 4、订阅 8；均可配置且受原生限制进一步约束。
- 同设备多 providers 共用上述设备上限，并可分配更窄 provider 子限额；§12.3 总量不按 provider 倍增，单实例拥塞不得无限挤占其它实例。
- 默认普通执行超时 30 秒，长等上限 10 分钟；Caller 只控制更窄范围，不能越过管理员上限。
- 每订阅缓存默认 4 MiB；满时报告 overflow、停止或要求 resync，不无界增长。
- 原始内容、句柄和去重墓碑分别按 §12.3 保留；内容可能敏感，权限校验同原调用，撤销后立即不可读。
- 网络/订阅配额独立于模型 token 预算，使用结构化分页让主 Agent 按需获取。

这些数值是初始预算，性能阶段校准，不是 Luvus 固有限制。

### 12.3 内容、句柄、墓碑与全库预算

以下为可配置的设计默认值，尚未实现。MiB = 1,048,576 bytes；时间均使用 Gateway 可信时钟，记录固定 expires_at。配置变更只影响新登记对象；缩短既有期限须受保护维护并明确去重边界，已经过期或 discard 的内容不能被延长期限复活。

| 对象/配置 | 默认值 | 计时、预算与保证边界 |
|---|---|---|
| 原始内容 `content_ttl` / `content_bytes` | 1 小时 / 128 MiB | 调用首次登记即固定 content_expires_at；包含内联 response、外部对象、单次终端 capture 等内容副本，不只大结果；被明确识别的秘密走独立 custody，不落普通结果库 |
| 结果句柄 `handle_ttl` / `handle_payload_bytes` | 1 小时 / 16 MiB | 每个句柄 expires_at = min(创建时间 + handle_ttl, content_expires_at)；16 MiB 是 128 MiB 内容池内的子上限，实际复制字节计入内容/全库预算，不重复算成免费缓存 |
| 调用元数据 `call_metadata_ttl`、去重墓碑 `dedup_ttl` / `call_metadata_bytes` | 各 30 天 / 共用 64 MiB | 自调用首次登记计时；call_metadata_ttl 不得小于 dedup_ttl；unknown 也只保留有界的最小记录，不承诺无限历史；墓碑期内不得因容量压力提前丢失去重 |
| 新 key 范围 `history_epoch_max_age` | 24 小时 | 不大于该范围冻结的 dedup_ttl；退役范围只重返已有 key，缺失时拒绝创建，见 §11.2 |
| 结构化审计 `audit_ttl` / `audit_bytes` | 30 天 / 64 MiB | 自审计事件创建计时；不含 prompt、原始输出或 secret；到达上限不截断仍在承诺期内的必需动作记录，应阻断需新增该记录的动作 |
| 身份/撤销/策略元数据 `security_metadata_bytes` | 16 MiB；不按内容 TTL 自动删除 | 不能为了回收内容或墓碑而复活撤销/配对；达到上限拒绝新分配，需受保护维护 |
| 受管备份 `backup_ttl` / `backup_max_count` / `backup_bytes` | 7 天 / 2 份 / 合计 128 MiB | 按需人工发起，不自动调度；默认逻辑导出必要元数据，排除原始内容/句柄载荷与所有明文凭据；如另行授权包含原文，仍保留原 expires_at 并披露备份中的物理残留 |
| 全部受管存储 `storage_total_bytes` / `storage_reserve_bytes` | 512 MiB / 其中预留 64 MiB | 总量覆盖 SQLite（含空闲页）、WAL/SHM、外部对象、受管日志/备份与维护临时文件；预留用于已接收调用的收尾/有界审计和恢复，不用于新增业务；各子预算不替代总预算 |

持续流仍按 §12.1/§12.2 使用有界内存队列，不默认持久化流帧；单次 capture 等作为普通结果登记时纳入此内容池。结果句柄 TTL 不替代流本身的生命周期/背压规则。

`storage_reserve_bytes < storage_total_bytes`，各池均受总量约束，不能把子上限相加当成额外空间。该总量约束受管文件与数据字节，不是整个磁盘或同账号其它进程的 OS 配额；磁盘实际剩余空间另行校验。准入前预留调用元数据、必需审计和有界结果容量，按实际字节归还；不能为了收尾无限突破总预算。容量不足时先回收已过期内容/句柄及合法到期元数据，仍不足则在派发前显式 storage_exhausted，既有未知写操作不重发；异常收尾缺少原文时保留已预留的最小证据并明确 content_unavailable。拒绝流量审计有界聚合，不能靠无限日志绕过预算。

内容期限覆盖内联与句柄两条读取路径。内容过期/显式 discard 后，call_get、result_read、同 key 重试、晚到回复和备份恢复都不能重新返回原文或制造新句柄；已有句柄也立即失效。句柄先过期而原始内容尚在有效期且未 discard 时，可以按当前授权创建另一短句柄，但不得延长 content_expires_at，也不改变去重截止时间。显式清理继续要求调用归属、当前方法策略和独立 discard_response 权限；自动到期/配额维护是受限后台职责，不能由普通 caller 借此绕过清理权限。

§11.1 晚到结果若到达时内容窗口已结束，只能补充最小证据；内容窗口按调用登记时刻固定，不以迟到的“首次收到响应”重新开始。TTL 表示服务读取/保存逻辑的期限，SQL 删除不承诺对空闲页、WAL、文件系统快照、已导出副本或备份作物理擦除。受管备份也受总量和期限约束；管理员自行导出的副本不在此可控范围，恢复时仍不得刷新原 TTL。

跨字段约束：TTL、容量、数量均为正且能用约定时间/字节精度安全表示；`call_metadata_ttl >= dedup_ttl`；每个范围冻结 `history_epoch_max_age <= frozen_dedup_ttl`；句柄有效期按 min 公式截断（不强制配置的 handle_ttl 小于 content_ttl）。`0 < storage_reserve_bytes < storage_total_bytes`，各存储子上限不得大于总量，普通新业务只能在总量减预留及已有预约后做准入。句柄载荷是内容子池，`handle_payload_bytes <= content_bytes`；管理恢复/审计的预留不能绕过各自子预算。默认非重叠子池 128+64+64+16+128=400 MiB，加 64 MiB 预留为 464 MiB；剩余 48 MiB 只是默认余量，索引/空闲页/WAL/SHM/临时文件仍按实际字节计入，不能视作未计量空间。

### 12.4 预留耗尽与持久化失败

64 MiB 是总预算内的应用收尾预留，不是无限紧急池，也不是文件系统成功写入的保证。派发前必须先原子持久化调用/attempt/范围绑定、最小去重墓碑与“可能送达”的 dispatching 锚点，并预留受限的收尾/必需审计空间；若这一前置提交失败，禁止向 Connector/UHP 写出，返回 not_dispatched + storage_exhausted（仅在确实尚未写出的情况下）。预约总和不能超过可用预留；无法为下一次派发保证有界收尾容量时停止新准入。

若预留也用尽，或磁盘/WAL/I/O 故障使已有预约不可兑现，则进入 storage_degraded：停止新调用派发、流输入、配对/新认证等会扩大副作用或安全状态的动作；只在不会新分配/持久化内容且仍有授权的条件下允许有界只读诊断。先尝试合法到期回收；不得提前删除墓碑/仍有效审计、放宽预算、再执行 unknown 写入或自动丢弃撤销记录。不能持久化撤销等安全变更时，不能报告“已生效”；必要时停止接受认证/关闭相关通道来保持拒绝服务状态，等待受保护维护。

已经可能送达的动作不能改称 not_dispatched，也不能声称取消或回滚。若连最终 unknown/晚到证据都无法持久化，保留此前已提交的 dispatching/accepted 锚点，内存/当前错误返回只注明结果持久化不可用；原记录按不确定处理，重启时保守转 unknown 且不重放。无法证明锚点/账本完整则恢复隔离。晚到更新事务失败不能发布 durable responded，也不能创建句柄；证据可能丢失的事实必须明确，不能承诺预留总能保存最终回复。

拒绝流量/故障只做有界、无秘密的瞬时告警/聚合，不能用无限日志弥补写满或宣称审计完整。只有在预算、持久化完整性和必要审计恢复并通过健康检查后，受保护管理才可解除 degraded；不自动重派之前的调用。本节是 #5 的故障门禁，非本次运行配置或已实现恢复行为。

## 13. 授权、安全和审计

### 13.1 授权模型

按 principal × machine_id × provider_id/binding_revision/kind × profile × session × method/contract/classification scope 授权，必要时追加确认规则。按完整 provider scope 分组求交，不能让独立 allowlist 的笛卡尔积扩大权限；设备权限不隐含未来新 provider 权限。
- observer：只读能力；“只读”按契约和风险分类，不只看方法前缀。
- orchestrator：明确授权的 agent/task/worktree 编排；能给 agent 发任意 prompt 也可能导致任意代码执行，不能称安全沙箱。
- owner：配置目标范围内所有允许的 UHP；Host admin 和凭据管理独立授予。

最外层 ACL 是上限，Connector 本地策略再次检查。禁止通过 runtime_call/旧别名绕过 machine revoke、provider disable、原生 token 管理或 admin 审批；凭据类方法如开放则使用专门 custody，不原样交给模型。结果/流/清理/晚到路径同样校验完整 provider 关联。

三种角色共同受 §8 的安全分类门禁限制：Owner 不代表允许未知作用、未知高权限要求或未知秘密结果处理。只有分类完整而参数 schema 缺失时，才可能在显式 raw-contract 下讨论调用；两个缺口须分别拒绝/说明。派发、流写入和结果交付均重新核对分类 revision 与双方当前策略，不能只在 discover 时检查一次。

### 13.2 MCP 入口认证

常驻 HTTP Gateway 按所选 MCP 规范实现资源服务器认证，校验 token audience、issuer、有效期与 scope；复用兼容身份服务，不在首版自造 OAuth 授权服务器。stdio 使用本地 OS 信任和环境/安全配置取凭据；两类凭据不与设备 credential 互用。[S5][S6]
开发用固定 bearer token 只允许 loopback/明确受限环境，不宣称完整标准授权兼容，不能作为公网正式发布条件。

### 13.3 高权限事实

Owner endpoint、pane.run、terminal control 及 agent prompt 都可能触达远端账号权限。session allowlist、路径规则不是 OS 沙箱；如需强隔离，用专用账号/容器等外部边界。
Gateway 被攻陷可影响已授权设备，Connector 失陷可伪造该设备输出；不宣称应用层能防御已被控制的端点。

### 13.4 审计

默认记录 caller、machine/provider/binding revision/kind/profile/session、method、contract_ref、call_id、epoch、原生 generation（若有）、policy/classification revision、时间、状态、大小；参数只记录脱敏摘要。prompt、终端输出、配置可能含秘密，默认不进日志。
设备/配对/UHP/OAuth secret 永不写日志、URL、进程参数或 MCP content。结果保存无法保证自动识别所有秘密，所以限制访问、存留、导出；可配置磁盘加密/系统加密卷。
Agent 输出按不可信数据处理，不能驱动自动越权确认。撤销权限先阻断新动作，再关闭流，报告仍可能运行的工作。
审计和结果分池保留，具体期限与预算按 §12.3。保留可信晚到证据或恢复管理记录不授予内容读取权限；审计也不能成为秘密结果的旁路。

## 14. 兼容性、模块和可观测性

拟议模块：cli、mcp-facade、registry/enrollment、provider-bindings、identity-policy、router-call-ledger、result-store、schema-index、connector-transport、runtime-adapter 接口、luvus-uhp-rpc/stream、herdr-json、audit-health。契约来源与恢复保证留在各 adapter，业务核心不将 Herdr 转写为 UHP。

实现语言保持 TypeScript；#15 Bun 1.4.3 工具链已验收并合入 main=5124d45，node:sqlite 由 Bun 提供，精确证据见 [ADR 0003](adr/0003-bun-toolchain.md) 与 [开发与验证指引](bun/README.md)。本轮不改 package/lock、源码、测试或脚本。Linux 的通过不扩展为跨平台或新 adapters 已验收。

[ADR 0001](adr/0001-p0-version-and-contract-baseline.md) 保留 Node 24.19.0/npm 11.9.0/SQLite 3.53.3 的 P0 历史证据；它不是当前工具链默认值。#15 已从真实 package/lock 保留 MCP SDK 1.32.1、Ajv 8.20.0 和 ws 8.22.0；不因多 provider 升级 SDK 2.x 或重写 MCP 架构。已验证 MCP revision 仍为 2025-11-25；其它运行时/客户端须分别联调。

公开 health 分层：Gateway ready、设备 link/认证、Connector ready、各 runtime provider enabled/binding readiness、profile/session reachable、model provider/agent 任务错误。一个 adapter 故障不代表设备离线；model provider 错误不代表 Gateway 不在线。
指标：在途数、队列拒绝、请求延迟、unknown 计数、连接重试、流缺口/背压、schema 缓存命中、凭据失败；不以 machine 高基数无限生成标签。

## 15. 关键设计选择（ADR 摘要）

| 决策 | 理由 / 取舍 |
|---|---|
| 单项目双模式 | 共用协议和版本，不把角色强迫合成同一进程 |
| 一设备身份/一连接、多 provider adapters | Target 显式 provider，权限/去重/结果隔离；原生契约与恢复保证分别表达 |
| Wire major 2 与明确 legacy Luvus 迁移 | 必需路由字段不以默认值兼容，旧调用不转其它 runtime |
| Connector 主动 WSS | 适合出站可达的内网；不自动解决出口被拦或代理限制 |
| 通用元工具 | 保持丰富功能，按需 schema，避免静态工具爆炸 |
| 写调用只接受 machine_id | 防改名、同名、上下文漂移串机 |
| Host/RPC/stream 分开适配 | 不把单请求 proxy 误当万能隧道 |
| 一次性配对 + 独立设备凭据 | 注册与长期身份分离，支持撤销与轮换 |
| 单活 SQLite | 首版操作简单；不支持多副本 writer/自动 HA |
| 不承诺 exactly-once | 跨网络与 UHP 执行无原子事务，宁可明确 unknown |
| Gateway/Connector 双层策略 | 完整接口与安全授权独立；Owner 权限显式授予 |
| 未知安全分类默认拒绝 | 与参数 schema 缺口分开；raw-contract 不能越过高权限/秘密结果门禁 |
| 内容/句柄/墓碑分期及全库预算 | 内容到期不可再生，有限去重窗口与旧范围拒绝明确，不宣称无限历史 |
| 备份恢复先隔离 | 旧认证与配对全部失效，旧范围拒绝，重新授权后才恢复业务 |
| 可靠晚到结果作为证据追加 | 同一已验证 attempt/有效 epoch 可细化 unknown，不重发，其他关联隔离 |

## 16. 待确认事项与默认建议

1. 首批平台：建议 Linux + macOS，Windows 适配阶段单独验收；未测试不得宣称支持。
2. Gateway 部署：建议单机常驻 HTTPS；本地 stdio 作为开发/个人模式。
3. 身份服务：由部署方选择兼容 OAuth 服务；决定前不对公网开放 HTTP MCP。
4. 是否授予 Owner/Host admin：默认只读，显式扩大；这是部署选择，不削减协议可表达能力。
5. 单机多 LUVUS_HOME/Herdr 状态根：同 machine 下不同 provider_id；新实例显式配置/授权，不复用身份。
6. 原生 endpoint 的平台实证和高级终端帧：协议实验阶段冻结。

四项 v0.3 原则已采纳，不再列作未决问题；§12.3 为供实现与父会话验收的可配置默认值，不是已运行的策略。#4/#5 的具体实现、CLI 配置编码和迁移尚待开发；本次仅文档修订不授予开发/凭据/部署或远端发布权限。

多 runtime provider 与内置 Web UI 已确认；Bun 基线已合入。待父会话协调 #4 的 v2/公共字段，#5 的迁移及 P0-H 的原生证据；未实证 Herdr 被动读 allowlist、写入/终端能力不开放。常规技术默认由实现方按 ADR 0004 落实，无需用户重复批准已采纳方向。

## 17. 完整性验收口径

不得用“当前共有 N 个方法”作永久验收。生成覆盖账本，每个实时方法归类：
- 普通请求已路由且契约校验；
- 持续/双向流已适配；
- Host profile 已适配；
- 权限明确禁用；
- 尚不支持且写明原因。

全功能就绪要求：所有目标版本能力都有分类、授权允许的功能有实际调用路径，普通方法通用透传不必逐个写业务代码；高风险、流、安装辅助等不能被一句“raw call”掩盖。

上述账本按 runtime kind/provider/版本/profile 分开生成；Herdr 首切片仅以其明确范围验收，不因 Luvus 全功能通过而继承支持。跨 provider 同名授权/去重/句柄隔离、迁移来源证明、wire major/strict 字段拒绝、provider 禁用与设备撤销差异须另有证据，见实施方案 §4.3。

后续验收还必须分别证明：未知安全分类在所有角色下拒绝；内容到期/discard 后所有读取和重建路径关闭且墓碑保留；有限去重范围到期/恢复回滚时旧 key 不会新建派发；恢复前撤销与配对消费不复活；同一有效 attempt 的可靠晚到结果可补证，旧 epoch/恢复代次/其他 attempt 不污染结果。#4/#5 的具体验收清单见实施方案 §4.1。

## 18. 参考来源与本次核验

[S1] Luvus — Getting started with UHP（普通 proxy、Host profile、连接边界）
[S2] Luvus — Method reference（schema CLI 与方法目录）
[S3] Luvus — Schemas and conformance（能力、并发与事件恢复）
[S4] Luvus — Terminal methods（终端身份、观察与控制）
[S5] MCP — Transports（本次网页 latest 指向 2026-07-28）
[S6] MCP — Authorization（HTTP 授权及凭据边界）
[S7] MCP TypeScript SDK（Context7 查阅，用于语言/SDK 可行性；具体版本待实施锁定）

来源地址（便于后续复核）：
```text
S1 https://luvus.dev/docs/uhp/getting-started/
S2 https://luvus.dev/docs/uhp/methods/
S3 https://luvus.dev/docs/uhp/conformance/
S4 https://luvus.dev/docs/uhp/terminal/
S5 https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
S6 https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
S7 https://github.com/modelcontextprotocol/typescript-sdk
```

固定版本的核验入口为 `luvus --version`、`luvus help uhp`、`luvus uhp schema`。Linux P0 原生契约、有效输入与回放方法见 [P0 指引](p0/README.md)，不能把它扩展为 Gateway/Connector 已实现。本次 v0.3 的新增规则来源是用户对四项原则的采纳，新增默认值是设计建议，不是 Luvus/MCP 官方行为或实现测试结论。
