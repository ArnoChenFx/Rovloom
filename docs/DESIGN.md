# Rovloom 系统设计

本文是 Rovloom 当前唯一权威系统设计，定义最终有效的架构与安全语义。实现差距、交付依赖和验收门禁统一维护在 [IMPLEMENTATION-PLAN](IMPLEMENTATION-PLAN.md)；本文的要求不等于能力已上线。文档职责与阅读入口见 [文档导航](README.md)。

精确 Wire 编码由 [Wire 协议](protocol/WIRE-PROTOCOL.md)维护，原生校验器及宿主接线由 [原生契约](protocol/NATIVE-CONTRACT.md)维护，准确签名以源码类型为准。这些文档细化本文，不另设不同的目标、授权或恢复语义。ADR 保存现行决策的理由与证据边界，历史修订使用 Git 查询。

## 1. 设计结论

Rovloom 是一个多机器 MCP 网关项目，同一发行产物提供 Gateway 与 Connector 两种角色：

- Gateway 负责 MCP facade、设备注册与认证、provider bindings、caller 授权、路由、调用账本、结果、订阅及审计；内置管理 Web UI。
- 每台设备一个 Connector，使用一套设备身份、一条主动 WSS 出站连接，承载多个受信配置的 runtime adapters。
- 一个 runtime provider binding 对应一个 Luvus 或 Herdr 实例；同 kind 的多个实例也各有独立 provider_id。runtime provider 与 LLM/model provider 是不同概念。
- 每次调用使用显式 Target 和预期 binding revision；权限、契约、原生身份、去重、结果与流都隔离到该实例，禁止跨 provider 自动 failover。
- 对外提供少量通用 MCP 工具，按目标发现和描述原生方法；普通 RPC、Host 与持续/双向流分别适配。
- Luvus 的目标范围是受支持版本内获授权的 UHP 能力。Herdr 的初始范围是发现、状态、经核实被动只读和事件失效后的当前状态重建；写入、终端控制及更强保证须独立设计和验证。

## 2. 用户需求与边界

必须支持多台内网设备主动连接，无 SSH 数据通道；设备使用稳定 ID，可改名，在线状态、认证、版本和健康可见。主 Agent 可以在明确授权后发现、描述、调用远端能力，进行多轮 agent 编排、长等待、事件和适用的终端观察/控制。新增设备或 provider 不继承其它目标权限。

注册不能代替目标机器的本地安装、可信配置和授权。结果、设备凭据、原生 delegated token、OAuth token 与 model API key 各有边界，不能进入普通日志或未经授权的模型内容。

首版采用单管理员空间、单活 Gateway 和 SQLite writer，不承诺多活集群、跨机器事务或 exactly-once。每次原生调用只选一个明确实例，跨机器工作流由 caller 编排。Rovloom 不复制 runtime UI、TUI renderer 或 agent harness，不自动安装/启动/升级远端 runtime，也不提供独立任意 shell RPC。终端和 agent prompt 本身具有目标账号的执行权限，不能当作沙箱。

## 3. 原生协议与证据边界

Luvus 普通请求可通过 `luvus uhp proxy`；持续事件/终端连接经可信本地发现的 endpoint。`luvus uhp schema` 导出安装 binary 的契约，实时 `uhp.capabilities` 与 `host.capabilities` 分属 session/Host，不能虚构 `uhp.schema` RPC。Host 可以不依赖运行中的 session；`access --machines` 是另一原生 profile，不作为 Rovloom 设备注册后端。[Luvus 来源](#18-参考来源)

固定版本的原生证据、schema 覆盖及重放方法见 [Luvus 契约指引](DEVELOPMENT.md#固定输入与维护用途)。参数枚举或通用 object schema 不证明完整参数约束，更不证明安全分类、权限或网关传输已实现。网页不能替代安装版契约。

Herdr 使用自己的 JSON socket 协议和安装 CLI schema，不是 UHP。固定源码研究、适配理由与证据边界见 [ADR 0004](adr/0004-multi-runtime-provider.md#官方来源与核验边界)。研究引用只能作为 research_ref，不能填充生产 binary/schema hash 或生成执行许可。P0-H 原生验证也只证明其测试范围，不能单独证明 Gateway/Connector 架构已接通。

MCP、Rovloom Wire 和各原生协议独立版本化；所选 MCP revision 与 SDK 的关系见 [ADR 0001](adr/0001-p0-version-and-contract-baseline.md)。不能凭网站 latest 推断 SDK 或实际客户端兼容。

## 4. 部署与信任边界

```text
主 Agent / MCP Host
        │ stdio 或 HTTPS Streamable HTTP
        ▼
Gateway：MCP / 身份与策略 / provider registry / 账本与结果
        ▲                         ▲
        │ 主动 WSS                │ 主动 WSS
Connector A                   Connector B
  ├─ Luvus adapter              ├─ Herdr adapter
  └─ Herdr adapter              └─ Luvus adapters
```

三条边界独立认证：caller → Gateway；设备 Connector → Gateway；Connector → 本地原生实例。machine_id 不由 hostname/name 自报产生，epoch 或 welcome 也不能自行证明通道已认证。原生来源必须由本机受保护配置、endpoint 归属及平台身份核验建立；收到的消息、设备广告和 caller 参数不能自证 `authenticated/source_verified`。

Connector 仅执行管理员固定的 binary、状态根和 session 策略。caller 不能提交 binary 路径、环境、endpoint、状态根或 SSH 目标选择 adapter。设备广告不得创建、重绑或扩大 binding；双方受保护配置不一致即拒绝派发。

### 4.1 两种 Gateway 部署

本地模式由 MCP Host 通过 stdio 启动 Gateway，stdout 仅承载 MCP，日志写 stderr；设备须可达其 WSS 地址。常驻模式由同一程序运行 Gateway，MCP 走 HTTPS Streamable HTTP，适合长期在线设备。两者共用业务核心，同一数据库仅一个 writer；多个 stdio Host 不能各自争用同一状态目录。

### 4.2 Gateway 内置管理 Web UI

管理面内置在 Gateway 产物，默认 loopback，独立 listener、管理员认证与授权，不与设备或 MCP 身份混用。设备断开、持久撤销、provider 禁用是不同操作。恢复隔离/存储降级约束对页面和 API 同样生效。管理页、确认流程和 API 的唯一细节定义在 [GATEWAY-WEBUI](GATEWAY-WEBUI.md)。

## 5. 身份模型与数据

### 5.1 Machine

machine_id 由 Gateway 随机生成，稳定、不复用；name 在管理员空间规范化后唯一，可改，仅用于展示和精确只读查询。变更、调用、流和危险管理操作都使用 ID，不存在隐式 current machine。labels、OS、hostname 和设备自报版本不是身份。

设备持久授权状态与连接观测分开保存。每个 Connector 进程有诊断用 connector_instance_id；每次成功认证分配新的 connection_epoch，绑定 recovery_generation。心跳时间使用 Gateway 接收时间；socket 接通不能直接标 ready，须完成认证、协商、策略和能力核对。设备连接在线也不保证其各 provider/session 健康。

### 5.2 Runtime Provider Binding / Session

以下是系统身份语义；精确字段形状、编码及摘要算法见 Wire 协议。

| 对象 | 规则 |
|---|---|
| Target | 稳定路由键 `(machine_id, provider_id, profile, session)`；host 分支没有 session，session 分支必须显式非空，包括名为 default 的 session |
| ProviderBinding | machine/provider、不可变 kind、非秘密 opaque config_ref、正安全整数 binding_revision 与 enabled；provider_id 在所属 machine 内稳定且不复用 |
| revision fence | binding_revision 不属于稳定 Target；新调用/开流另带 expected_binding_revision，双端匹配后把实际 revision 固定进 attempt |
| 实例替换 | kind、状态根或实例身份更换必须新 provider_id；原地 binary 升级可以保留 ID，但增 revision 并重发现；启停和依赖配置变化也不能复用 revision |
| 配置归属 | config_ref 只引用受信本机配置，不是 caller 可解析/改写的路径、URI 或秘密；远程启停不得重绑 binary/root 或扩大本地授权 |
| profile | Luvus 分别接入 session/Host；Herdr 仅 session，无实例则 unavailable，不暗中启动；不得把 server.* 映射成 Host |

provider kind 从可信 registry 解析，消息里的 kind 仅回显并被核对。原生 machine/SSH federation 不能替代 Rovloom 出站连接、身份或隐式跨机器转发。

每个 attempt 固定完整 Target、provider kind/revision、contract_ref、call_id、attempt_id、native_request_id、connection_epoch、recovery_generation，以及登记 deadline、history reference 和双方 policy revision。所有响应、accepted、cancel、流消息都关联原 attempt。原生 generation、terminal_id、pane_id、workspace_id 等按实际协议另外绑定，不能用同名 ID 跨实例关联。缓存还绑定 binary/schema、adapter、classification 和能力 revision；contract_ref 相同也不意味着执行身份可共享。

### 5.3 持久化与迁移

Gateway 使用 SQLite 保存机器、凭据 hash、配对消费、bindings/revisions、策略、契约来源、调用/attempt、历史范围、内容元数据、流元数据及审计；大对象放受限文件，保存摘要/引用。Connector 使用权限受限状态目录及最小有界调用记录。POSIX 可使用目录 0700/文件 0600；Windows 需等效 ACL，不能把 mode 位当跨平台证明。

迁移必须停派发、确认单 writer、备份并事务性升级，失败保持旧库只读；不自动删锁、续期或发请求。旧记录只有在安装配置/契约可证明来源时，才能映射该设备唯一的 legacy Luvus binding，初始禁用待双端确认。未知/多个 root 或来源不完整标 migration_unresolved，不能猜第一个 provider，更不能映射 Herdr。

Target、ACL、call/attempt、结果、流、审计及去重历史必须一起迁移。保留旧摘要版本、key 历史索引、原 TTL/discard 与恢复边界；旧 key 先查原历史，只能重返或报冲突，历史缺失拒绝，不能借新 scope 再执行。不能补造 active history、分类、native 来源或 hash。旧多个 machine_id 不凭同名/同 hostname 自动合并。升级后旧 writer/降级程序拒绝打开新库，回退走隔离恢复。

进程重启不恢复 online 连接、原生 lease 或可执行队列。可能已派发的调用保守 unknown；不重放持久化变更，不跨 provider 补证。

### 5.4 备份恢复的隔离边界

备份完整不证明它包含后续撤销、配对消费、discard 或送达记录。支持的恢复流程必须先在独立目录进入 recovery_quarantined，关闭业务派发、内容读取、Connector 认证与 enrollment 兑换，只允许独立可信本机恢复管理。

恢复依次完成：

1. 确认无旧 writer，保留源备份，核对 migration、对象引用和来源/时间；不自动删锁，不执行备份中的命令或任意路径。
2. 创建新的 recovery_generation，所有恢复前设备/配对凭据及未消费 enrollment 失效。机器 ID 只留历史关联，逐机受信确认，解除隔离后重新配对；所有 binding 默认禁用，重新核对本机配置与来源。
3. caller ACL、Owner/Host admin、清理/管理权限默认拒绝，只按旧备份之外的可信当前策略或本机重新确认授予。旧管理员记录、ready 标记或有效 OAuth 签名不足以解除隔离。
4. 所有设备 offline，旧流/句柄失效，新认证另分 epoch。关闭旧 history_epoch，不导入 active 集合，不给旧 call/pending/retry 换恢复代次或范围。
5. 恢复前缺 key 返回 dedup_history_unavailable；备份中的“未发送”若无覆盖丢失时段的可信证据，也不能证明未执行。在途按 unknown，已知历史结局注明备份时点。
6. 原 expires_at/discard 不变；备份后 discard/过期/撤权无法独立确认时，恢复原文默认不可读，不能建句柄。仅重新授予 ACL 不能证明原文可复活；默认备份排除原文，例外备份也受此规则约束。
7. 记录来源、丢失时间段和重新确认结果；受信本机管理员显式解除隔离后才发放新恢复代次的范围，接收重新授权后明确的新意图。旧请求不能自动迁入新范围，也不自动终止可能仍运行的原生工作。

无独立防回滚来源时，不承诺自动检测整机/全部运行文件一起回滚，亦不承诺从旧备份重建后续完整历史。无法证明当前安全状态时维持隔离；手工绕过支持流程的整机替换不在检测保证内。

## 6. 注册、配对与生命周期

获授权管理员创建 pending 注册，返回非秘密 registration_id。受保护本机管理渠道签发一次性 enrollment，目标机器经安全输入完成兑换，得到独立设备凭据。Gateway 原子记录消费，只保存凭据 hash；enrollment 和长期凭据不进入普通 MCP 输出、URL 或日志。配对有效期默认最多 10 分钟，并发兑换仅一次成功。

凭据轮换采用有界双凭据过渡，完成后撤销旧凭据。丢失凭据须重新批准配对，不能凭 hostname 接管。重复设备连接默认拒绝，不静默踢掉旧连接；显式授权 takeover 产生新 epoch 并隔离旧响应。

| 操作 | 持久语义与影响 |
|---|---|
| 暂时断开设备 | 仅关闭指定 connection_epoch，授权不变，Connector 可以重连 |
| 撤销设备 | 持久拒绝新认证并断开设备全部 providers/流；已送入原生的工作可能继续 |
| 禁用 provider | 独立 providers_manage 权限与真实确认，持久递增 revision，阻断该实例派发、流输入、内容读取与晚到补证，关闭其桥接资源；设备凭据及其它 providers 保持独立 |
| 重新启用 provider | 新确认、新 revision、双端配置核对、重发现与重授权；旧 attempt/流/句柄不复用，不重派旧工作；仍有效的历史内容仅在显式授权其历史 binding 后可签发新句柄 |

持久变更与必要审计未提交时不能报告已生效。管理确认必须是后台保存并绑定真实管理员/操作/目标/fence 的一次性记录，不能接受模型自填 approved:true。普通 runtime_call 不管理 bindings。

## 7. MCP 工具面

下表定义目标工具职责；可运行入口与交付情况见实施计划。所有发现、计数、分页与结果都按当前 caller ACL 过滤，不返回秘密配置。

| 工具 | 职责 |
|---|---|
| machines_list / machines_get | 查询可见设备、连接/认证及健康；name 仅可精确只读查找 |
| machines_register / machines_rename / machines_revoke | 独立管理授权下发起注册、改名或撤销；注册不返回配对 secret |
| providers_list / providers_get | 查询可见已配置实例、kind、binding revision、启停和 readiness |
| runtime_discover / runtime_describe | 完整 Target 的来源、能力、参数覆盖、安全分类、传输、支持依据、逐方法保证与有效权限 |
| runtime_call | 完整 Target、expected_binding_revision、native_request、执行期限/验证模式及适用 history reference；短等或返回 call_id |
| runtime_call_get / runtime_call_cancel | 读取状态/证据，或请求停止等待/桥接；不暗中重试，不宣称回滚 |
| runtime_result_read | 按当前读取权限及内容状态分页读句柄，字节、cursor、期限有界 |
| runtime_stream_open / runtime_stream_read | 完整 Target/revision 开已适配流，再按 stream_id/cursor 有界读取 |
| runtime_stream_write / runtime_stream_close | 获授权控制流逐条输入，或释放桥接/订阅及适用原生 lease；close 不默认关闭 pane/agent |

caller 仅提交原生 method/params 等允许字段，不能提交原生 id/auth、adapter 管理的凭据或目标注入字段。Gateway 分配原生请求 ID，Connector 经受保护流程注入适用 auth；不合成原生确认字段。原生并发/幂等字段保留安装 schema 允许的位置和值。

响应包含 call/attempt 关联、Target/revision、kind、contract_ref、delivery/state、内容状态及适用的 native_response/句柄。原生 result/error 保留解析后的字段和值；不承诺 JSON 空白/键序字节不变。gateway_error 与原生 error 分层，缺回复不伪造 result；大对象不静默截掉字段。

旧 `luvus_*` 名称只能作为显式启用的 Luvus 兼容别名，仍须完整目标或受保护 legacy 映射，不能调用 Herdr。不把尚未交付的工具或 CLI 当作可执行命令。

## 8. 能力发现、契约与派发授权

ContractSource 记录 provider kind/protocol family、安装 binary version/hash、安装 CLI schema hash/origin/command、可观测 server/protocol/runtime generation、adapter/classification revision 与 support_basis。字段形状与 contract_ref 内容摘要编码唯一维护在 Wire 协议。摘要是不可变来源引用，不是签名、认证或执行许可；不同 Target 可有相同摘要，但执行 handle 仍隔离。必要来源缺失不能建立可执行契约；无原生 incarnation 时 generation 为 null，不能填桥接计数冒充。

Luvus 安装 schema 与 session/Host 在线能力分别核对；Herdr 安装 schema、实际版本与有限 ping 能力只能提供 schema_and_version 依据，不能伪称 live_catalog。Wire 的 ContractRecord 以 candidate/validated 表示来源的候选/已验证状态；无法建立记录的不可用原因另外表达。validated 也不代替逐方法门禁或产品就绪验收。

有效派发集合是以下约束的交集：原生支持依据、完整可信安全分类、已实现传输/子能力、适用的原生接入 scope、Gateway caller grant、Connector 本地 grant，以及独立管理/确认/秘密交付要求。参数校验另轴判断。每方必须存在同一个完整 Target + method + action 的授权组合，不能把独立 machines/providers/sessions/methods 数组拼成未授权的笛卡尔积。设备权限不自动授权新 provider。

安全分类绑定确切 binary/schema/契约、目标与评审 revision，覆盖作用/副作用/幂等性/传输、高权限/确认、结果敏感性/交付/保留，控制或通用分派还须分类具体 action。原生 method_contracts 是核对输入，不是本地授权。缺失、未知、冲突或来源不可信一律拒绝；schema、方法前缀、caller、设备广告、Owner/raw 都不能补齐分类。Herdr 无等价完整分类时须固定版本的可信本地评审补足。

strict 必须应用完整根、条件和离线引用闭包，并有方法参数约束；generic/unavailable 不能标完整。Owner 显式选择 raw-contract 且有绑定 principal、完整目标、精确方法、版本/revisions/期限的独立 grant 时，只可放宽明确的参数覆盖缺口。保留所有已有约束、有界 envelope、保留字段、来源、传输、安全分类、权限和结果边界；已知参数不合法不能降格放行。整个 bundle 不可用且没有独立受信最小 request/response 契约时仍拒绝；完全无 bundle 的 raw 路径待另行设计。

schema 只从接纳的本地 bundle 闭包解析，URL 是索引，不联网/读任意文件补 `$ref`；缺引用、未知方言或无法应用的约束失败关闭。不补默认值、不类型转换、不删字段。describe 裁剪只用于展示，执行仍检查完整根。schema 编译须在可终止的独立 worker 中受硬资源限制：编译时间预算 2 秒、heap 预算 64 MiB；超限终止并返回不可用，不自动放宽。该预算是设计要求，不由结构检查、JSON 快照计量或同步 Promise 超时代替，也不表示宿主已实现 CPU/heap 隔离。

派发与流输入前核对当前双端 binding、策略、分类、能力、epoch、generation 及 deadline；任一失效拒绝，不能透明降级。缓存按完整来源和上下文失效。发现、安全分类、参数覆盖、传输与支持状态分别呈现，不合成一个“支持”标记。

逐目标/方法描述保证上限：event_recovery 为 native_replay/state_rebuild_only/unavailable；terminal_fence 为 native_atomic/bridge_check_only/unavailable；cancel 为 native_confirmed/bridge_only/unavailable；prompt_completion 为 turn_correlated/state_only/unavailable。未知取 unavailable，kind=Luvus 也不自动得到最强值。桥接 expected generation 核对不能消除检查与原生执行之间的 TOCTOU；严格原子控制依赖原生同临界区 fence。

## 9. 原生 adapters 与流许可

### 9.1 Luvus RPC 与 Host

固定 argv、shell=false 启动受信 Luvus binary，显式状态根和 session/profile，按单请求 proxy 收集有界 stdout/stderr/退出状态，不拼 shell 字符串。Host 的 schema、能力及高权限独立；stop/restart 丢回复用只读状态对账，不再发一次变更。原生 UHP error、进程失败、非法输出和 stdout 超限分别报告。

### 9.2 本地 endpoint 与可信 native identity

持续流从 `luvus session list --json` 等已验证发现入口取得精确运行实例 endpoint，再检查平台本地归属与 peer。不能手拼 socket 路径、使用展示地址或接受远程 pipe。每次连接都核验 endpoint 与受信 binary/root/session 的关联；缺少目标平台证明则不发布该平台流支持。

opaque native handle/permit 只由成功校验产生，关联完整原 attempt、契约和独立 TrustedNativeContext；不得从 wire JSON、相同 hash、response 自报身份或类型转换重建。原生响应须按原契约复验 ID、方法结果、generation/terminal 身份和来源；contract_ref 不可强转 schema hash。恢复缺合法 handle 时拒绝；未来恢复工厂只能从可信持久锚点建立仅响应检查上下文，不能制造派发许可。

### 9.3 开流、逐条 input 和读取

开流 ack 必须由**原同一份 DispatchPermit**校验，成功后才建立 stream；shape-only ack、复制 handle、另一份 permit 或原生错误均不能开流。

每条 input 先验证具体 action/帧和当前原生身份，再重新取得自己的 DispatchPermit，复核当前双端流写授权及安全门禁。它有独立 native ID，不能复用 open ID/许可；同 ID 不同内容拒绝，同内容重复不再次发送。input ack 必须按该 input ID 找原 permit 校验，未知/未派发/跨 attempt ID 拒绝，不能回退开流许可。queued/admission ack 不等于原生消费，丢 ack 不自动重发。

每条实际交付的 response/event/ack 还须独立经过当前结果读取门禁；stream 必须指定实际 frame，按其原 input 或开流上下文评估。codec、外层 sequence 或 advanceStream 成功不授予读取权限。关闭、到期、撤权、provider 禁用与连接失效均须释放受限 handle/桥接资源；释放桥接不代表停止原生工作。

observe 永不可写；图片/上传等高级 action 只有在契约、分类、帧/容量和 adapter 均独立验证后开放，未知子协议拒绝。

### 9.4 Herdr JSON adapter

保留 Herdr 原生 request/result/error，不模拟 UHP、Host、通用 cancel、原子 terminal fence 或 UI renderer。初始切片必须在独立 P0-H 证明安装契约、endpoint/peer、framing、被动读和事件重建后接入。recent 等读取可能有滚动/输入副作用，按具体 method+params+实现审核，未核实不进 observer。prompt wait 的状态变化不能证明本次 prompt 完成。

被动读精确 allowlist、写入/终端原子身份保证、prompt 完成归属与取消语义尚无充分证据的部分属于待设计决策，默认拒绝；不能用 Luvus 证据或外层 revision 补造保证。

## 10. Gateway ↔ Connector Wire

业务协议采用 Wire 2.0，WSS 上一个 WebSocket message 是一个 UTF-8 JSON envelope。握手、字段、方向、feature、对象分片和精确限额由 Wire 协议唯一维护。MCP、管理 API 与 Wire 的版本彼此独立。

认证前仅允许握手类别；业务前选定共同 major/minor。未知可选 capability 在协商中不启用，未知/不共同支持的 required capability 拒绝；选定后业务帧未知字段/枚举、未协商 feature、错方向/关联均拒绝，不能静默剥字段。TLS 校验必需，仅显式本机开发模式可用 loopback WS；凭据不放 URL、argv 或日志。

Wire v1 只作只读历史解析，不生成可执行 v2 context，不补默认 provider，不在 v2 失败后回退重发。若未来提供 v1 执行迁移入口，须另行设计、明确管理员启用及唯一可证明的 legacy Luvus 绑定；缺少恢复/history 证明仍拒绝，Herdr 永不包装成 UHP。

消息去重窗、流序列与持久调用去重是不同层。宿主必须消费重复判断并防止重复发送；窗到期/codec 成功都不能证明原生未执行。对象重组成功只证明字节/摘要边界，schema 仍须受信 registry 和编译核验。没有自动远端变更队列：设备离线立即失败，重连不突然执行旧 prompt。

## 11. 调用状态机、超时与幂等

```text
created → authorized → dispatching → connector_accepted → responded
     └─ rejected / not_dispatched / expired_before_dispatch
                              └─ outcome_unknown
                                   └─ responded + late_evidence
```

这是语义状态图，持久字段编码见 Wire/集成契约。accepted 仅证明桥接接收，responded 仅证明收到合规原生响应；原生 submitted/queued 不能标业务完成。前端 wait 到期可返回 call_id，执行 deadline 独立，不能因此报告远端回滚。

只有能证明未写出时才报告 not_dispatched。可能送达后断线、超时、桥接终止或崩溃保持 outcome_unknown，禁止自动重发变更。只读重试也须具体契约证明 method+params 无副作用，策略允许且在总 deadline 内，以新 attempt 保留历史，不能跨 provider/revision 偷换目标。普通 native request ID 不是幂等键，原生幂等键仅用于实证支持的方法。

取消只报告实际可确认程度，不把停止等待/本地进程当原生撤销。不承诺跨 Gateway、Connector 与原生执行的原子提交或 exactly-once。

### 11.1 可靠晚到回复只能补充原 attempt 的证据

晚到不是新执行。原 durable 派发锚点、仍有效的认证连接、设备、provider/revision/kind、恢复代次、epoch、完整 Target、call/attempt/native ID、登记条件、契约和独立原生来源均匹配，且原 permit/响应校验合法时，才可在同一 writer 事务追加 unknown 的证据。设备撤销、provider 禁用、旧 epoch/恢复代次、其它 attempt、已删除历史或冲突终态一律不补写。普通重连产生新 epoch，不允许缓存绕过。

保留原发送/超时/取消/unknown 历史及证据到达时间，不改称按时完成。相同 response 重复幂等，不新派发、不建新句柄或续期；冲突内容不覆盖已有结果，作有界隔离/审计。晚到原文须另过当前读取与保留门禁；过期/discard/禁存/撤权时最多保存受保护的 ID、时间、hash/长度和 result/error 类别，不能复活内容。

证据计划只是待提交意图。事务失败不能发布 durable responded 或生成句柄，保留原 durable dispatch/unknown 锚点；证据可能丢失，不以重试原动作“补救”。

### 11.2 有限去重窗口与旧范围拒绝

带 client_request_key 的 runtime 调用显式绑定 Gateway 持久发放的 history_epoch 与 recovery_generation；范围还绑定 principal、machine/provider/binding。`(scope, key)` 唯一，请求摘要覆盖完整目标、契约、验证模式、登记条件与原生请求，摘要算法/版本见 Wire 协议。同 key 不同摘要报 conflict，不能改变执行条件重试。

范围冻结 scope_created_at、accept_new_until、frozen_dedup_ttl。新 key 只在原子检查 `now < accept_new_until` 后登记，call 的 dedup_expires_at 从首次登记固定。必须满足：

```text
accept_new_until <= scope_created_at + frozen_dedup_ttl
                <= call_created_at + frozen_dedup_ttl = dedup_expires_at
```

因此墓碑合法到期前，原范围已停止登记新 key。范围检查、key 查询/冲突与新调用登记在同一 writer 事务内完成，不能以客户端时间或像签名的字符串代替来源。缩短配置不得提前丢已有承诺或保留旧 active 范围却缩短其墓碑。

| 范围/记录 | 行为 |
|---|---|
| 当前可信 active 范围，key 存在 | 返回原调用或摘要 conflict，不再派发、不续期 |
| 同 active 范围，key 不存在且全部准入通过 | 原子登记新意图 |
| 已退役但仍可信，key 尚有效 | 只重返原状态 |
| 退役/未知/已清理范围，key 缺失或过期 | dedup_history_unavailable，禁止补建 |
| 恢复前范围/代次不符/历史完整性存疑 | 拒绝新建，按隔离历史处理 |

范围 ID 不复用，缺记录绝不默认 active。重试器、迁移器和恢复工具不能自动换 key/范围/provider/revision/恢复代次；明确的新意图可以采用新 key/范围并可能执行相同动作，系统不提供无限语义去重。无 key 调用没有客户端重试去重承诺，也不因此允许补发 unknown 写操作。保留时长以 §12.3 为准。

## 12. 事件、结果与保留

### 12.1 事件一致性

Luvus 按已验证的原生 subscribe → 独立 snapshot → 共同序号边界丢弃旧缓冲 → 顺序应用；gap、overflow、EOF、generation 变化显式 resync_required，原生 replay 窗不足不能伪装连续。无 replay 的终端 observe 重新 capture。

Herdr 的事件与 snapshot 没有共同序号边界。events_lost/断线后报告 gap，重订阅并等待确认，再从另一连接取 snapshot 整体替换缓存；事件只作失效通知，串行刷新，读取中有新事件则再读。不把缓冲事件载荷重放到快照上，不编造 sequence 或丢失历史，保证仅 state_rebuild_only。

原生 event_sequence（若存在）与 Gateway delivery_cursor 分开；后者不证明原生连续性。游标、缓存和恢复状态按 provider/binding/session 隔离，多机器没有全局事件顺序。

### 12.2 资源边界

| 配置 | 设计默认值/限制 |
|---|---|
| 普通 MCP 返回/单页 | 64 KiB；更大内容返回摘要、hash、长度、截断标记与有界读取方式 |
| 每设备普通在途/等待/订阅 | 8 / 4 / 8；所有 providers 共用，可有更窄子额，原生上限继续收窄 |
| 普通执行超时/长等上限 | 30 秒 / 10 分钟；caller 只可收窄管理员上限 |
| 每订阅队列 | 4 MiB 内存；满则明确 overflow、停止或 resync，不默认持久化 |

Wire 单帧、整体对象、分片和 schema 编译的独立限额见各协议/API 文档，不从 MCP 页大小推导。原生 payload 不超其可信上限；多 provider 不倍增设备/全库预算，也不能让一个 adapter 无限挤占其它实例。

### 12.3 内容、句柄、墓碑与全库预算

**读取授权与原文保留授权独立。** 读取须当前 principal/完整目标/双端 grant、可信当前分类、原 permit、内容状态及秘密交付通道均允许；原派发许可不自动授权读取。保留还必须同时获派发时和当前分类允许。retention=none 可以允许满足读取门禁的即时交付，但不得保存原文、写普通结果库、生成句柄或通过晚到/备份转成可保存内容。协议接收/结构校验成功不能代替任一门禁。

以下是系统唯一保留默认值表。MiB = 1,048,576 bytes；期限使用 Gateway 可信时间，在首次登记时固定，普通配置变更只影响新登记对象，不能由读取、重试、晚到、重新授权或恢复刷新。时间回退或无法判断到期时不延长有效性，标记时钟异常并拒绝相关派发/续期。

| 对象/配置 | 默认值 | 计量与保证 |
|---|---|---|
| content_ttl / content_bytes | 1 小时 / 128 MiB | 调用首次登记固定 content_expires_at；包含内联、对象、单次 capture 及实际副本；受保护秘密走专用 custody |
| handle_ttl / handle_payload_bytes | 1 小时 / 16 MiB | expires=min(句柄创建+TTL, content_expires_at)；载荷是内容池子额，实际复制也计全库 |
| call_metadata_ttl / dedup_ttl / call_metadata_bytes | 各 30 天 / 共用 64 MiB | 首次登记固定，元数据期限不短于墓碑；无原参数/输出，unknown 不承诺无限历史 |
| history_epoch_max_age | 24 小时 | 登记新 key 的最长时间，不大于范围冻结 dedup_ttl；退役后缺 key 拒绝 |
| audit_ttl / audit_bytes | 30 天 / 64 MiB | 无 prompt/原文/secret；不提前截断承诺期内必需审计，满则拒绝需新增记录的动作 |
| security_metadata_bytes | 16 MiB | 身份/撤销/策略不按内容 TTL 删除，满则拒绝新分配 |
| backup_ttl / backup_max_count / backup_bytes | 7 天 / 2 份 / 共用 128 MiB | 按需逻辑导出必要元数据；默认排除原文、句柄载荷及明文凭据；例外原文保留原期限并披露残留 |
| storage_total_bytes / storage_reserve_bytes | 512 MiB / 其中 64 MiB | 包含 DB/空闲页、WAL/SHM、对象、受管日志/备份及维护临时文件；预留仅供既有工作收尾/必要审计与恢复 |

所有 TTL/容量/数量须为正且安全可表示；call_metadata_ttl >= dedup_ttl；范围 history_epoch_max_age <= frozen_dedup_ttl；handle_payload_bytes <= content_bytes；handle_expires_at <= content_expires_at；0 < storage_reserve_bytes < storage_total_bytes。各子额不大于总量，正常准入扣除预留及已有预约；恢复/审计使用预留也不突破子额。默认非重叠子池共 400 MiB，加预留 464 MiB，剩余仍按实际文件字节计量，不能当未计量空间。

内容到期/discard 后 call_get、result_read、同 key、晚到、内联副本和恢复均不可返回原文或重建句柄；墓碑继续保留。仅句柄到期而内容仍有效、允许保留且当前授权通过时可建更短新句柄，内容截止不变。显式 discard 须调用归属、当前策略及独立 discard_response 权限；后台到期维护不是 caller 删除旁路。

容量不足先合法回收已到期内容/元数据，仍不足在派发前拒绝，不提前丢墓碑或必需审计；拒绝流量日志有界聚合。预算是受管存储上限，不是整个磁盘的 OS 配额。TTL/SQL 删除是服务逻辑边界，不承诺擦除空闲页、WAL、文件系统快照、外部导出副本或备份的物理字节；恢复不得刷新原 TTL。

### 12.4 预留耗尽与持久化失败

实际写往 Connector/原生前，必须原子持久化 call/attempt、范围/key/摘要、最小墓碑、可能送达的 dispatching 锚点及必要审计，并预约有界收尾容量。前置提交失败不得写出；仅确证未写出才能报告 not_dispatched + storage_exhausted。

应用预约不是 OS 写入保证。预留耗尽或磁盘/WAL/I/O 失败进入 storage_degraded，停止新派发、流 input、配对/新认证及扩大安全状态的写操作；只允许仍获授权且不新增内容/超预算的有界诊断。不能提前删墓碑、放宽总额、复活撤销或重放 unknown。撤销等安全变更无法提交时不报告成功，必要时停止认证/关闭相关通道维持拒绝服务。

可能送达但最终结局无法持久化时，保留已有 durable dispatching/accepted 锚点，按 unknown 对待；重启也不重放。锚点/账本不可信则恢复隔离。晚到事务失败不发布 durable responded、不建句柄，允许证据丢失，不能伪称审计完整。只有预算、完整性和必要审计恢复、经受保护管理后才解除降级，不自动重派。

## 13. 角色、认证与审计

observer、orchestrator、owner 是目标范围内的授权配置：observer 仅经分类的被动只读；orchestrator 仅明确授予的 agent/task/worktree 编排；owner 在指定范围内可获更广方法授权。三者都受 §8 交集约束，Owner 不默认获得 raw grant、Host admin、凭据管理、providers_manage 或 discard_response。agent prompt/终端可触达目标账号执行权限；session/path allowlist 不是 OS 沙箱，强隔离依赖专用账号/容器等外部边界。

HTTP MCP 按所选规范验证 issuer、audience、有效期与 scope，使用兼容身份服务，不自造 OAuth 产品；MCP session ID 不充当身份。stdio 使用本地 OS 信任及受保护配置，不与设备凭据互用。固定 bearer 开发模式只适用 loopback/明确受限环境，不能据此通过正式公网授权门禁。

审计记录 caller、完整目标/provider/revision、method/action、契约/分类/策略 revision、call/attempt/epoch/恢复代次、适用原生 generation、时间/状态/大小与受保护摘要。prompt、原参数/输出、私人路径和 secret 默认不入日志/错误。参数摘要、hash 与历史证据也按受限元数据处理，不因不含原文而公开。

凭据/token 类结果必须专用 custody，普通 call/raw/stream/结果/晚到/错误路径均不能交给模型；没有该通道则派发前拒绝。一般输出可能含未知秘密，不能宣称自动检测完备。原生/agent 输出是不可信数据，不能驱动越权确认。Gateway 或 Connector 被攻陷的端点不能由应用层反向建立信任。

## 14. 模块与可观测性

职责划分为 CLI/MCP facade、registry/enrollment、provider bindings、identity/policy、router/ledger、result store、schema registry、Connector transport、各 runtime adapter、audit/health 及管理 UI。核心不把 Herdr 改写为 UHP，adapter 自己维护原生来源、传输和保证。

实现语言为 TypeScript，执行与构建使用 [Bun 工具链决策](adr/0003-bun-toolchain.md)，开发命令见 [开发指引](DEVELOPMENT.md)。模块构建成功不是服务入口、网络认证或上线证明。

健康分层报告 Gateway mode/readiness、设备认证/link、Connector、各 binding enabled/readiness、profile/session、model provider/agent 任务错误。单 adapter 故障不等于设备离线，model API 错误不等于网关断线。指标包括在途/拒绝/延迟、unknown、重连、缺口/背压、契约缓存和认证失败；标签及错误聚合有界，不泄露目标内容。

## 15. 决策理由

- [ADR 0001](adr/0001-p0-version-and-contract-baseline.md)：安装版契约与独立协议版本边界。
- [ADR 0002](adr/0002-safety-retention-recovery-late-evidence.md)：分类默认拒绝、有限保留、隔离恢复与可靠晚到证据。
- [ADR 0003](adr/0003-bun-toolchain.md)：Bun 执行与开发工具链。
- [ADR 0004](adr/0004-multi-runtime-provider.md)：多实例 provider 隔离、Wire 破坏性版本及 Herdr 证据边界。

## 16. 待设计决策与部署输入

Herdr 被动读精确 allowlist、任何写入/终端控制、prompt 归属和取消保证，以及完全无可用 bundle 的 raw 最小契约，均须独立证据及设计评审，未定默认拒绝。未来可执行 v1 兼容入口也须另行设计，不从历史 decoder 推导。

目标 OS/原生版本、Gateway 可达地址、TLS/反代、MCP Host/版本、身份服务及真实双机环境是部署输入；按平台/客户端单独验收，不能由一个 Linux fixture 推导跨平台支持。Owner/Host admin 默认不授予。已经明确的多 provider、安全语义和管理 UI 不因实现滞后退回单 provider 设计。

## 17. 完整性验收口径

按 runtime kind、实例、原生版本、profile、方法/子能力生成覆盖账本，分别列出来源、安全分类、参数覆盖、授权、传输、保证及未开放原因。不以永久方法总数验收，不以普通透传或 raw 掩盖未知子动作、流、秘密和高权限边界。

发行只能宣称实际通过的范围。必须独立证明多 provider 同名 ID 隔离、双端授权交集、Wire 严格边界、可信 native identity、逐 input permit/读取、禁用与设备撤销差异、内容不复活、有限去重旧范围拒绝、持久化失败及隔离恢复。具体验收矩阵与交付依赖以实施计划为准；原生实验、模块单测、端到端服务和真实多机是不同证据层。

## 18. 参考来源

- Luvus：[UHP 入口](https://luvus.dev/docs/uhp/getting-started/)、[方法](https://luvus.dev/docs/uhp/methods/)、[契约](https://luvus.dev/docs/uhp/conformance/)、[终端](https://luvus.dev/docs/uhp/terminal/)。安装版来源及固定数据见 [P0 指引](DEVELOPMENT.md#固定输入与维护用途)。
- MCP：所选 revision 的 [生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、[传输](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[授权](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)；[TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。协议选择理由见 ADR 0001。
- Herdr：固定官方源码/文档及其研究边界集中在 ADR 0004；新的安装版本必须重新取得生产来源，不能沿用研究身份。
