# Luvus 多机器通用 MCP：系统设计

版本：0.3 · 日期：2026-10-18 · 原作者：Luvus Tester
状态：四项安全/保留/恢复/迟到回复原则已获用户采纳；具体修订待父会话验收，不表示已有代码满足本设计。
范围：仅文档，不启动编码 Agent，不变更已有实现和运行中 Luvus 会话。
配套：《IMPLEMENTATION-PLAN.md》。本文替代此前讨论中的概念草案，不覆盖旧编码 Agent 文件。

修订基线：已验收的 Linux P0 提交 `d2455e878f93e162a2a54bb58c1e5785aecd0949`。本次只修订文档；决策及实现缺口见 [ADR 0002](adr/0002-safety-retention-recovery-late-evidence.md)。

## 1. 设计结论

构建一个项目、一套可执行程序 `luvus-mcp`，提供 `gateway` 与 `connector` 两种运行模式：

- Gateway 集成 MCP Server、设备注册、身份与权限、请求路由、结果账本和订阅管理。
- Connector 部署在每台 Luvus 主机，主动出站连接 Gateway，适配本地 UHP。
- 主 Agent 按稳定 `machine_id` 指定机器，按 `name` 查询和展示，按显式 session 指定 Luvus 服务。
- 对外是少量通用 MCP 工具；功能目录和参数按远端发现，不为数百个 UHP 方法逐一包装工具。
- 普通调用、持续事件/终端通道、Host profile 分别适配，共用路由和权限机制。
- 全功能表示“可表达、可路由所有受支持的 UHP 能力”，不表示默认授予所有权限，也不表示覆盖所有 CLI 安装/下载操作。

本文所有新增工具名、CLI、网络帧、错误码和默认值都是拟议网关协议，不是 Luvus 已有接口。

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

v0.2 最初只读核对 Luvus 0.14.3；随后 #3 的 Linux 原生 RPC、Host、事件和终端控制已获验收，范围与证据见 [P0 复核](p0/REVIEW.md)。安装 schema 223 个方法中 144 个仅有通用 params object；不能把存在方法枚举当作完整参数约束。网页文档可能领先安装版本，以安装契约与实时能力为准。本次 v0.3 修订未新增运行测试。

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
       │ UHP adapter │  │ UHP adapter │
       └──────┬──────┘  └──────┬──────┘
              ▼                ▼
       Luvus host/session  Luvus host/session
              ▼                ▼
         Pi / 其他 agent   Pi / 其他 agent
```

三条边界独立认证：
1. MCP caller → Gateway：谁可以控制哪些机器和能力。
2. Connector → Gateway：哪一个已注册设备在连接；不是靠 hostname/name 自报决定身份。
3. Connector → 本地 Luvus：本地账号权限与可选 delegated scope。

Connector 只允许管理员固定的 Luvus 可执行路径、状态根和 session 访问策略。主 Agent 不得提交可执行文件路径、环境变量或任意本地 endpoint 来绕过这些边界。

### 4.1 两种 Gateway 部署

- 本地托管：MCP Host 以 stdio 启动 Gateway；Connector 连到此机器可达的 WSS 地址。进程退出后远端变 offline；日志只写 stderr，stdout 专供 MCP。
- 常驻托管：同一程序运行 Gateway daemon，MCP 走 HTTPS Streamable HTTP；推荐用于长期在线的多机器部署。无需额外开发独立 MCP 服务。

两种模式共用业务核心；同一数据库只允许一个 Gateway writer。不同 MCP stdio 客户端不能同时各自启动网关并争用同一状态目录。

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

### 5.2 Luvus Instance / Session

首版约束：一个 Connector 管理一个固定 LUVUS_HOME/安装实例，内含多个 session。不同状态根作为不同注册目标，避免共享一台物理机上的身份混淆；将来可增加 instance_id，不在首版暗中支持。

路由键：`(machine_id, profile, session)`。
- profile=session：显式 session 名必填，包括 default；不继承当前 shell 的目标。
- profile=host：无 session endpoint；目标 session 等参数遵循 Host 方法自身 schema，不凭外层值猜测。
- 结果句柄再绑定 server_generation、terminal_id、workspace_id 等原生身份（若适用）。
- Gateway 自身 machine_id 与 Luvus 的 machine.* 方法记录完全不同，不复用 ID 命名空间。官方方法目录中，部分 machine.* 只存在于 `uhp access --machines`；首版 host/session 接入不能假称支持该专用 profile。覆盖账本将其标为 profile_not_exposed，后续如有需求再独立接入，不把它用作本 Gateway 设备注册后端。[S2]

### 5.3 持久化建议

Gateway 使用 SQLite（事务、schema migration、单活 writer），保存 machines、enrollment、credential hashes、policy、calls、result metadata、audit、stream metadata。大结果保存受限文件对象，数据库只存引用和摘要。
Connector 使用权限受限状态目录保存设备凭据及最小调用日志；Linux/macOS 建议目录 0700/文件 0600，Windows 使用等效 ACL，不把 POSIX mode 当跨平台安全保证。

在线状态、WS 对象不从数据库“恢复为 online”。Gateway 重启后一律等待设备重新认证；不执行持久化的待发变更。

### 5.4 备份恢复的隔离边界

备份可能早于撤销、配对消费或调用送达记录；校验文件完整不等于证明安全状态是最新。支持的恢复流程必须在独立目录先进入 `recovery_quarantined`，关闭业务派发、结果读取、Connector 认证和 enrollment 兑换，只允许受保护的本地恢复管理。不能把备份中的 ready 标记、管理员角色或旧凭据作为解除隔离的授权。

恢复过程至少完成：

1. 核实无旧 writer，保留源备份且不自动删锁；验证数据库 migration、对象引用和备份时间/版本，不能执行备份中的命令或任意路径。
2. 产生新的 `recovery_generation`（恢复代次，区别于 connection_epoch 和 Luvus server_generation），使恢复前的设备凭据/配对凭据全部不可用于认证；未消费 enrollment 也一律失效。机器 ID 可留作历史引用，需受信本地管理员逐机确认后重新配对，不能凭同名自动接管。
3. caller ACL、Owner/Host admin、清理权限及策略先按拒绝处理。只有独立于旧备份的可信当前策略或新的本地管理员确认才能重新授予；旧 OAuth token 的签名有效不能证明旧 ACL 仍有效。此流程描述未来管理机制，本次不创建或轮换任何真实凭据。
4. 所有设备 offline，所有通道/流句柄失效，新连接重新分配 epoch 并绑定新恢复代次；恢复前的晚到回复不能补写恢复后的调用。
5. 关闭恢复前的去重范围，发放新的 `history_epoch`（§11.2）。备份中缺失的旧 key 返回 `dedup_history_unavailable`，绝不据此新建并派发；恢复记录中的“未发送”若缺少覆盖备份后时间段的可信证据，也不能作为未执行证明。已知结果只作注明备份时点的历史证据，未能证明结局的在途调用标记 unknown。
6. 按原始过期时间与显式 discard 状态清理/屏蔽内容，不能因恢复或重新授权刷新 TTL；保持历史墓碑。最后记录恢复来源、丢失时间段、重新授权和重新配对结果，经本地受信管理员显式解除隔离，不能自动恢复发送队列。

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
| luvus_discover | 指定 machine_id/profile/session，返回版本、方法摘要、effective permissions、limits、generation、schema hash |
| luvus_describe | 按 method 或关键词查参数、结果 schema、调用语义；按需分页，不返回全部数百项 |
| luvus_call | 发送一条普通 UHP 请求；支持短等待或返回 call_id，保留原生结果 |
| luvus_call_get | 读取调用状态；结果大时分页/结果句柄，不暗中重试 |
| luvus_call_cancel | 请求停止等待/桥接，返回可确认的取消程度，不声称撤销远端动作 |
| luvus_result_read | 读取授权范围内的结果句柄，支持 cursor、字节上限和 TTL |

`luvus_call` 概念输入：

```json
{
  "machine_id": "m_01",
  "profile": "session",
  "session": "agent-lab",
  "request": {"method": "agent.list", "params": {}},
  "wait_ms": 10000,
  "execution_timeout_ms": 30000,
  "expected_server_generation": "optional-observed-generation"
}
```

`request` 保留 UHP schema 允许的并发/幂等字段，具体位置按安装 schema。Gateway 分配原生 request id；`auth` 属保留字段，由 Connector 注入，禁止 caller 读取/传入原生 token。绝不合成自动确认字段。

响应外壳示意：

```json
{
  "call_id": "call_01",
  "target": {"machine_id":"m_01","name":"home-linux","profile":"session","session":"agent-lab"},
  "state": "responded",
  "delivery": "response_received",
  "uhp_response": {"id":"u_01","result":{}},
  "truncated": false
}
```

Gateway 错误放 `gateway_error`，原生错误保留在 `uhp_response.error`，不混为一个命名空间。无原生回复时不伪造 UHP result。原生内容只在安全分类允许且 §12.3 内容期限内提供；过期/显式清理后仅返回状态、受保护的最小证据元数据及 content_status，不从旧内联响应重新生成 result_id。

### 7.3 流与终端控制

| 工具（拟议） | 职责 |
|---|---|
| luvus_stream_open | 指定原生 streaming method、params 和目标，打开订阅或终端通道 |
| luvus_stream_read | stream_id、cursor、max_bytes、wait_ms，有界读取与缺口状态 |
| luvus_stream_write | stream_id、frame；仅向已授权双向通道写入官方 schema 允许的输入帧 |
| luvus_stream_close | 释放订阅、本地连接和控制 lease；不默认关闭 pane/agent |

不把无限流作为一直不返回的 MCP 工具调用。MCP Host 通过句柄分批读；协议通知可作优化，但不能作为唯一可靠结果渠道。
终端 control 的双向输入不是普通 RPC：仅 open/read 不足以覆盖，因此明确 stream_write；capture 等一次调用仍走 luvus_call。
二进制/图片上传只在远端公布且已完成帧/容量验证后宣告支持；未适配的子协议返回 unsupported_stream_feature，而不是宣称全覆盖。

## 8. 能力发现和 schema

有效执行方法集 = 远端实时支持 ∩ 可信且完整的安全分类 ∩ 已适配传输 ∩ 接入权限（若有）∩ Gateway caller 策略 ∩ Connector 本地策略；schema 校验状态单独判断。

发现步骤：
1. Connector 获取安装 binary version 和本地 `luvus uhp schema` bundle，计算 hash。
2. session 通道查询实时 uhp.capabilities；host 通道查询 host.capabilities；两者不混为一张权限表。
3. 按 machine/profile/session/generation/binary/schema hash/policy revision/安全分类 revision 缓存；重启/升级或契约不匹配则失效。
4. describe 从 schema 提取方法相关分支，同时保留所有传递引用、根约束、条件约束及外部 document 依赖；不能只剪出一个 properties。
5. 每次变更前重新确认目标在线、epoch、generation 和策略；过期发现返回 capability_stale，不透明降级。

安全分类与参数 schema 是两个独立维度。分类必须来自绑定确切版本/契约的受信本地评审资料及已核验原生 method_contracts，至少说明：作用（读/写/外部副作用、是否幂等及传输类型）、高权限（Owner、Host admin、任意终端/agent 执行、凭据管理和所需确认）、结果是否可能包含秘密及其保存/交付方式。字段缺失、来源不受信或互相冲突即 `classification_unavailable`；不能凭方法前缀、通用 object schema、客户端自报或远端广告自行补齐。原生声明不能提升本地授权。

未知/未完整分类的方法允许被发现，但默认拒绝执行，Owner 和 raw-contract 也不能绕过。应分别展示 classification_status、schema_status、transport_status 和策略拒绝原因。凭据/令牌类秘密结果需要专门 custody 或默认拒绝该调用；一般潜在敏感内容需明确的读取授权、保留与交付规则，不声称能自动识别所有秘密。“只读”不代表结果可直接交给模型，也不能把真实 token 混入普通结果句柄/日志。通用 action.invoke 或流控制的子动作也必须分类，不能以已知容器方法包住未知作用。

旧 binary、新 server 或相反的情况：返回版本及 schema 来源。严格模式中，参数契约缺失/不完整时拒绝。只有安全分类完整、传输已适配、当前双方策略允许且秘密结果路径已落实的方法，Owner 才能显式选择仅放宽参数校验的 raw-contract；标注 validation=unavailable，仍执行 envelope、大小、保留字段和安全检查。它不能替代完整参数验证，不能把网页 schema 冒充安装版，也不能自动允许新增流帧。P0 的 144 个参数缺口不能自动等同于 144 个安全分类未知，反之亦然。

## 9. Connector 的本地 UHP 适配

### 9.1 普通调用

以固定 argv spawn 管理员指定的 luvus binary：明确 --session 和固定状态根，写入单条 JSON，收集有界 stdout、stderr、exit status。使用 shell=false，不拼接命令字符串。不要硬编码默认 socket 路径。

长等调用有独立执行 deadline；MCP 前端等待窗口到期可返回 call_id，不能因此自动杀死动作并宣称未执行。stdout 超限、格式错误、进程异常与原生 UHP error 分开报告。

### 9.2 流调用

以 `luvus session list --json` 的 endpoint 为发现入口，读取现有 running 行并验证本地归属后连接 Unix socket / Windows named pipe；不从 session 名手工拼平台路径，也不接受远端命名管道地址。这个入口在官方终端文档中有说明，但仍需对每个实际目标版本/平台实证；缺少有效 endpoint 时返回 endpoint_discovery_unavailable，不发布该平台流支持。[S4]

保留原生 handshake、frame、序列、terminal identity、control lease 和 ack；网关不改写原生 content revision。控制流独占租约交由 Luvus 决定，不能靠 Gateway 单方面声称拥有控制权。[S4]

### 9.3 Host profile

host.call 仍经 profile=host 的通用调用，不另建任意命令执行入口。Host 能力、普通 session 能力及 schema 来源分别报告；Host 的安装、删除等确认字段只能由获授权且确有确认的操作携带。[S1][S2]
Gateway 停止/重启目标 session 的回复丢失时，采用 Host 只读状态查询对账，不重新发一次 stop/restart。

## 10. Gateway ↔ Connector 自定义协议

传输：WSS；一个 WebSocket message 对应一个 UTF-8 JSON envelope，不再称作“每行一个 WebSocket 帧”。此协议不同于 UHP 的本地 LF framing。

Envelope 基本字段：protocol_major/minor、type、message_id、connection_epoch、payload。
类别：enroll、authenticate、welcome、request、accepted、response、stream_open/data/input/close、cancel、heartbeat、error。
- TLS 验证必需；只有显式本机开发模式可用 loopback ws。
- credential 不在 URL query、日志或 MCP 输出里；按受保护的握手流程传输。
- major 不兼容拒绝连接；minor 能力协商后使用交集，不静默猜字段。
- 所有响应绑定认证 machine、recovery_generation、call_id、attempt_id、connection_epoch 和 native request id；重复/迟到处置见 §11.1，旧 epoch/恢复代次或其它 attempt 不改变当前结果。
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

### 11.1 可靠晚到回复只能补充原 attempt 的证据

晚到不是新执行。仅当接收上下文已认证且仍有效、机器未撤销、恢复代次/connection_epoch 仍与原 attempt 一致、call/attempt/native request id/目标全部匹配、原生 response 对应契约与 frame 校验通过时，才可在同一 writer 事务中补充 `outcome_unknown`。若 call 已转入其它 attempt、已有冲突终态或历史记录已过期，不更新当前结果；旧 epoch 的 Connector 缓存重发也不例外。普通断线重连/恢复会产生新 epoch/恢复代次，因此不保证跨这些边界接纳原晚到回复。

保留原先发送、超时、取消、unknown 的历史事实和证据到达时间/摘要；最新视图可变为 responded + late_evidence=true，不把它说成在 deadline 内完成。原生 queued 仍只证明排队。相同已验证 response 的重复消息不产生新句柄或执行；不同内容的冲突回复不覆盖已接受结果，作有界审计/隔离。取消不会撤销真实动作，也不阻止在这些条件下记录其可靠结果。

补充结果受当前授权、分类、内容 TTL 和 discard 状态约束：内容已过期/已清理时只留受保护的最小证据（相关 ID、接收时间、response hash/长度、result/error 类别），不保存原文、不重新生成句柄、不延长任何保留期限。原始调用/墓碑已删除则不凭回复重建调用。此规则不授权重新派发、接收旧认证通道，或让其他 caller 读取结果。

### 11.2 有限去重窗口与旧范围拒绝

去重墓碑默认保留 30 天，自首次原子登记调用时固定 dedup_expires_at，不随重试、句柄读取或晚到回复续期。它保留 caller、目标、请求摘要、key 的受保护摘要、原 call/attempt 关联、过期/discard 状态及最小结局信息，不含原始参数或结果；在窗口内同 key 返回原状态，内容过期也不能变成新执行。

为了让有限墓碑到期后仍拒绝旧提交，受保护的调用范围还绑定 Gateway 发放的 `history_epoch`。每个范围允许登记新 key 的时长默认最多 24 小时，且必须不长于该范围冻结的墓碑期限；之后只可查询/重返仍存在的同 key，未找到时返回 dedup_history_unavailable，禁止新建。新调用使用新范围；客户端重试不能自动把旧 key 改绑新范围或生成新 key。缺少有效范围的带 key 调用拒绝，不静默套用当前范围；跨范围的同文本 key 是新意图，不承诺去重。

Gateway 只接受自己仍登记且绑定当前恢复代次的范围；旧/未知范围即使其逐 key 墓碑已清理也不能新建调用。恢复、历史损坏或无法证明未发生回滚时关闭旧范围，进入 §5.4 的恢复流程；不以备份里“没有这个 key”作为首次调用证明。最小字段及兼容迁移由 #4/#5 实现，现有 v3 不具备这一保证。

未携带 client_request_key 的调用没有客户端重试去重保证，同样不得由网关补发 unknown 写操作。超过 30 天不承诺仍有逐调用结果/去重查询记录，但旧范围拒绝创建仍成立；用户明确采用新范围/新 key 发起新意图时可能再次执行，不能被包装成一次“安全重试”。

## 12. 事件恢复、背压与大结果

### 12.1 事件一致性

遵循原生 subscribe → 另连接 snapshot → 丢弃 snapshot 之前缓冲事件 → 顺序应用；缺口、overflow、EOF、generation 变化后标记 resync_required 并重取快照。[S3]

保留两种游标：原生 event_sequence 与网关 delivery_cursor。delivery_cursor 不代替原生连续性。多机器的序号没有全局时序意义。
流重连不宣称无损：原生重放窗口不够时明确 gap；终端 observe 不支持重放时重新 capture。

### 12.2 资源边界建议

- 普通 MCP 返回默认最多 64 KiB；较大完整 UHP 回复保存为 result_id，返回摘要、长度、hash、截断标记和读取方式，不静默丢字段。
- 传输 envelope 分片后重组，且单个 UHP payload 不超过远端广告上限；schema bundle 作为独立有界对象传输，不受 session frame 限制猜测。
- 每设备普通在途 8、等待 4、订阅 8；均可配置且受原生限制进一步约束。
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

## 13. 授权、安全和审计

### 13.1 授权模型

按 principal × machine_id × profile × session × method/contract scope 授权，必要时追加确认规则。
- observer：只读能力；“只读”按契约和风险分类，不只看方法前缀。
- orchestrator：明确授权的 agent/task/worktree 编排；能给 agent 发任意 prompt 也可能导致任意代码执行，不能称安全沙箱。
- owner：配置目标范围内所有允许的 UHP；Host admin 和凭据管理独立授予。

最外层 ACL 是上限，Connector 本地策略再次检查。禁止通过 luvus_call 绕过 machine revoke、原生 token 管理或 admin 审批；凭据类方法如开放则使用专门 secret custody 流程，不原样把 token result 交给模型。

三种角色共同受 §8 的安全分类门禁限制：Owner 不代表允许未知作用、未知高权限要求或未知秘密结果处理。只有分类完整而参数 schema 缺失时，才可能在显式 raw-contract 下讨论调用；两个缺口须分别拒绝/说明。派发、流写入和结果交付均重新核对分类 revision 与双方当前策略，不能只在 discover 时检查一次。

### 13.2 MCP 入口认证

常驻 HTTP Gateway 按所选 MCP 规范实现资源服务器认证，校验 token audience、issuer、有效期与 scope；复用兼容身份服务，不在首版自造 OAuth 授权服务器。stdio 使用本地 OS 信任和环境/安全配置取凭据；两类凭据不与设备 credential 互用。[S5][S6]
开发用固定 bearer token 只允许 loopback/明确受限环境，不宣称完整标准授权兼容，不能作为公网正式发布条件。

### 13.3 高权限事实

Owner endpoint、pane.run、terminal control 及 agent prompt 都可能触达远端账号权限。session allowlist、路径规则不是 OS 沙箱；如需强隔离，用专用账号/容器等外部边界。
Gateway 被攻陷可影响已授权设备，Connector 失陷可伪造该设备输出；不宣称应用层能防御已被控制的端点。

### 13.4 审计

默认记录 caller、machine/profile/session、method、call_id、epoch、generation、policy revision、时间、状态、大小；参数只记录经过脱敏的摘要。prompt、终端输出、配置可能含秘密，默认不进入普通日志。
设备/配对/UHP/OAuth secret 永不写日志、URL、进程参数或 MCP content。结果保存无法保证自动识别所有秘密，所以限制访问、存留、导出；可配置磁盘加密/系统加密卷。
Agent 输出按不可信数据处理，不能驱动自动越权确认。撤销权限先阻断新动作，再关闭流，报告仍可能运行的工作。
审计和结果分池保留，具体期限与预算按 §12.3。保留可信晚到证据或恢复管理记录不授予内容读取权限；审计也不能成为秘密结果的旁路。

## 14. 兼容性、模块和可观测性

拟议模块：cli、mcp-facade、registry/enrollment、identity-policy、router-call-ledger、result-store、schema-index、connector-transport、local-uhp-rpc、local-uhp-stream、audit-health。

实现语言保持 TypeScript；Node/SDK/validator/WebSocket/SQLite 采用 [ADR 0001](adr/0001-p0-version-and-contract-baseline.md) 的已验收 P0 开发基线。SDK 1.32.1 本次已验证的 MCP revision 是 2025-11-25，不因参考文档含 2026-07-28 就宣称兼容；其它客户端仍需实际协商。

公开 health 分层：Gateway ready、设备 link、Connector ready、Host profile 可用、各 session reachable；Provider 错误属于 agent 任务层，不能显示成 Gateway 不在线。
指标：在途数、队列拒绝、请求延迟、unknown 计数、连接重试、流缺口/背压、schema 缓存命中、凭据失败；不以 machine 高基数无限生成标签。

## 15. 关键设计选择（ADR 摘要）

| 决策 | 理由 / 取舍 |
|---|---|
| 单项目双模式 | 共用协议和版本，不把角色强迫合成同一进程 |
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
5. 单机多 LUVUS_HOME：首版按不同注册目标处理。
6. 原生 endpoint 的平台实证和高级终端帧：协议实验阶段冻结。

四项 v0.3 原则已采纳，不再列作未决问题；§12.3 为供实现与父会话验收的可配置默认值，不是已运行的策略。#4/#5 的具体实现、CLI 配置编码和迁移尚待开发；本次仅文档修订不授予开发/凭据/部署或远端发布权限。

## 17. 完整性验收口径

不得用“当前共有 N 个方法”作永久验收。生成覆盖账本，每个实时方法归类：
- 普通请求已路由且契约校验；
- 持续/双向流已适配；
- Host profile 已适配；
- 权限明确禁用；
- 尚不支持且写明原因。

全功能就绪要求：所有目标版本能力都有分类、授权允许的功能有实际调用路径，普通方法通用透传不必逐个写业务代码；高风险、流、安装辅助等不能被一句“raw call”掩盖。

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

v0.2 最初只读核验命令：`luvus --version`、`luvus help uhp`、`luvus uhp schema`。一次临时解析曾因管道 stdin 使用错误导致 Broken pipe，之后解析成功。后续 Linux P0 原生验收见 [REPORT](p0/REPORT.md) 与 [REVIEW](p0/REVIEW.md)，不能把它扩展为 Gateway/Connector 已实现。本次 v0.3 的新增规则来源是用户对四项原则的采纳，新增默认值是设计建议，不是 Luvus/MCP 官方行为或实现测试结论。
