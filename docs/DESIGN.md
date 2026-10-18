# Luvus 多机器通用 MCP：系统设计

版本：0.2 · 日期：2026-10-17 · 作者：Luvus Tester
状态：设计建议，待评审；不是实现报告，不表示已有代码满足本设计。
范围：仅文档，不启动编码 Agent，不变更已有实现和运行中 Luvus 会话。
配套：《IMPLEMENTATION-PLAN.md》。本文替代此前讨论中的概念草案，不覆盖旧编码 Agent 文件。

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

本机只读核对：`luvus --version` 为 0.14.3；`luvus help uhp` 列出 schema/proxy 等入口；schema 根键包括 request、response、event、event_catalog、terminal、access、documents、protocol。本次未启动 Luvus 进行新测试。网页文档可能领先安装版本，以每台机器的安装契约与实时能力为准。

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
- 克隆：同一设备身份并发连接默认返回 duplicate_device_connection，不静默“后连接踢前连接”。明确 takeover 必须有授权并更新 epoch；旧响应失效。

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

Gateway 错误放 `gateway_error`，原生错误保留在 `uhp_response.error`，不混为一个命名空间。无原生回复时不伪造 UHP result。

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

有效方法集 = 远端实时支持 ∩ 接入权限（若有）∩ Gateway caller 策略 ∩ Connector 本地策略。

发现步骤：
1. Connector 获取安装 binary version 和本地 `luvus uhp schema` bundle，计算 hash。
2. session 通道查询实时 uhp.capabilities；host 通道查询 host.capabilities；两者不混为一张权限表。
3. 按 machine/profile/session/generation/binary/schema hash/policy revision 缓存；重启/升级或契约不匹配则失效。
4. describe 从 schema 提取方法相关分支，同时保留所有传递引用、根约束、条件约束及外部 document 依赖；不能只剪出一个 properties。
5. 每次变更前重新确认目标在线、epoch、generation 和策略；过期发现返回 capability_stale，不透明降级。

旧 binary、新 server 或相反的情况：返回版本及 schema 来源。严格模式中，缺少可用契约的方法不执行；Owner 可显式启用 raw-contract 模式，按在线支持透传但标注 validation=unavailable，不能把网页 schema 冒充运行版本。

未知未来方法默认可被发现；授权策略决定是否调用。restricted 模式默认拒绝未分类方法；Owner 模式可以明确选择允许未来原生方法，但需告知相应风险。新增流协议仍需适配，不自动当普通 RPC。

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
- 所有响应按 call_id + attempt_id + connection_epoch 关联；迟到响应不改变其他调用。
- frame 和并发有限额，校验 type、大小、嵌套深度和 deadline；Connector 不可无限 spawn。
- 心跳只证明通道健康，不证明本地 Luvus/Provider 健康；健康报告分别列出。

不设计自动远端写任务队列：离线请求立即失败；不能网络恢复后突然执行旧 prompt。

## 11. 调用状态机、超时与幂等

```text
created → authorized → dispatching → connector_accepted → responded
   └──── not_dispatched / rejected / expired_before_dispatch
                    └──── outcome_unknown（可能已进入 Luvus）
```

Connector accepted 表示桥接接收，不等于 Luvus 执行，也不等于 agent 消费 prompt。Gateway 有记录不等于完成。

| 情形 | 返回语义 | 是否自动重发 |
|---|---|---|
| 未上线/未授权/尚未派发就超时 | not_dispatched 或 rejected | 不自动排队 |
| 发送后断线、子进程被终止、Gateway 崩溃 | outcome_unknown | 写操作禁止自动重发 |
| 获得原生 UHP error | responded + 原始 error | 由 caller 对账后决策 |
| 获得 submitted/queued | responded，但业务未完成 | 不补发 prompt |
| 只读临时失败 | 可新建 attempt，保留历史 | 仅契约标记只读且策略允许、有总 deadline |

Gateway client_request_key 只去重同一 caller + 目标 + 请求摘要的重复提交；同 key 不同请求报 conflict。账本持久化用于减少重复，不能承诺 exactly-once。Gateway→Connector 跨崩溃与本地 UHP 执行不可能在本设计里事务性提交。
原生幂等键只用于实时能力明确支持的方法，保持原位置和值；普通 request id 不是幂等键。
取消 MCP 等待不会回滚远端命令；发送取消请求仅尽力释放观察/本地子进程资源，若已执行返回 cancel_unconfirmed。终端 stream_write 同样区分 queue admission 与原生 ack；断线丢 ack 时不能自动重发输入。

Gateway 的 expected_server_generation 只提供桥接层的目标核对：若原生方法不支持同一临界区内的身份/revision 前置条件，就不能保证检查与执行间绝无重启竞态。严格控制应使用原生 fence；缺少 fence 的操作必须在 describe 中标注保证强度，不能宣传外层字段具有原子性。

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
- 大结果 TTL 默认 1 小时，受限总空间；内容可能敏感，权限校验同原调用，撤销后立即不可读。
- 网络/订阅配额独立于模型 token 预算，使用结构化分页让主 Agent 按需获取。

这些数值是初始预算，性能阶段校准，不是 Luvus 固有限制。

## 13. 授权、安全和审计

### 13.1 授权模型

按 principal × machine_id × profile × session × method/contract scope 授权，必要时追加确认规则。
- observer：只读能力；“只读”按契约和风险分类，不只看方法前缀。
- orchestrator：明确授权的 agent/task/worktree 编排；能给 agent 发任意 prompt 也可能导致任意代码执行，不能称安全沙箱。
- owner：配置目标范围内所有允许的 UHP；Host admin 和凭据管理独立授予。

最外层 ACL 是上限，Connector 本地策略再次检查。禁止通过 luvus_call 绕过 machine revoke、原生 token 管理或 admin 审批；凭据类方法如开放则使用专门 secret custody 流程，不原样把 token result 交给模型。

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

## 14. 兼容性、模块和可观测性

拟议模块：cli、mcp-facade、registry/enrollment、identity-policy、router-call-ledger、result-store、schema-index、connector-transport、local-uhp-rpc、local-uhp-stream、audit-health。

建议实现语言 TypeScript；选当时支持的 Node LTS，锁定 SDK/依赖版本并留 ADR。Node 版本、MCP protocol version 不在设计阶段凭“latest”硬写；实施前针对目标客户端做协商和兼容验证。

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

## 16. 待确认事项与默认建议

1. 首批平台：建议 Linux + macOS，Windows 适配阶段单独验收；未测试不得宣称支持。
2. Gateway 部署：建议单机常驻 HTTPS；本地 stdio 作为开发/个人模式。
3. 身份服务：由部署方选择兼容 OAuth 服务；决定前不对公网开放 HTTP MCP。
4. 是否授予 Owner/Host admin：默认只读，显式扩大；这是部署选择，不削减协议可表达能力。
5. 单机多 LUVUS_HOME：首版按不同注册目标处理。
6. 原生 endpoint 的平台实证和高级终端帧：协议实验阶段冻结。

## 17. 完整性验收口径

不得用“当前共有 N 个方法”作永久验收。生成覆盖账本，每个实时方法归类：
- 普通请求已路由且契约校验；
- 持续/双向流已适配；
- Host profile 已适配；
- 权限明确禁用；
- 尚不支持且写明原因。

全功能就绪要求：所有目标版本能力都有分类、授权允许的功能有实际调用路径，普通方法通用透传不必逐个写业务代码；高风险、流、安装辅助等不能被一句“raw call”掩盖。

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

本机只读核验命令：`luvus --version`、`luvus help uhp`、`luvus uhp schema`。一次临时解析命令因错误地占用了管道 stdin 导致 luvus stdout Broken pipe；随后正确解析成功，此异常不是本设计产品测试结果。
