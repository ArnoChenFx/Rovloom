# #4 原生契约 validator 前置提案

日期：2026-10-18 UTC。状态：**待接口评审的设计与纯 fixture 草案；没有生产 validator 实现，#4 未完成。**

本分支从已验收 main `9c4a7fe34fc3efa461d96a502860e61b05817c44` 建立。已读仓库 README、[HANDOVER](../HANDOVER.md)、[P0 REVIEW](../p0/REVIEW.md)、[ADR 0001](../adr/0001-p0-version-and-contract-baseline.md)、DESIGN/IMPLEMENTATION-PLAN v0.2，以及 [#4](https://github.com/ArnoChenFx/luvus-mcp/issues/4)（含新增 #15 前置评论）和 [#15](https://github.com/ArnoChenFx/luvus-mcp/issues/15)。未发现适用的 AGENTS.md。

本提案只覆盖安装版原生契约的编译、发现映射、结构校验和安全接缝。wire envelope 冻结、认证传输、持久化/迟到结果更新、Bun 迁移分别由对应任务负责；不重复原生 P0。实现必须从包含 #15 验收的最新基线开始，使用其精确 Bun pin、唯一锁文件及无 Node 回退门禁。SDK 固定 `@modelcontextprotocol/sdk@1.32.1`，实证 MCP revision 仍为 `2025-11-25`；本提案不升级 SDK。

## 1. 已审查的原文与覆盖含义

原文：[schema-bundle.json](../../fixtures/p0/linux-luvus-0.14.3/schema-bundle.json)，404,048 bytes，SHA-256 `00e3bb8862b9f3602164bdbe3f11cd7b466e7f7098aa2942dd3878d0b1abdbe6`。binary 0.14.3 / UHP 1.0；binary SHA-256 `895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9`。来源以 P0 provenance 为准；hash 是身份关联和完整性证据，本身不是可信来源认证。

| profile | schema 方法 | 有方法条件分支 | 只有通用 params object | 运行时证据 |
|---|---:|---:|---:|---|
| session | 197 | 53 | 144 | 独立 session capabilities |
| host | 17 | 17 | 0 | 无 session server 的 Host capabilities |
| access_machines | 9 | 9 | 0 | 只有 schema；未启动此 profile，未取得实时权限分类 |
| 合计 | 223 | 79 | 144 | 方法出现不代表可派发 |

完整 request 有 55 个条件分支，覆盖 79 个不同方法；documents 有 29 个文档，一般 event catalog 有 63 个 payload 键。伴随的 [native-method-map.tsv](native-method-map.tsv) 逐项列出 223 方法、profile、transport、参数证据、分支 pointer、原生权限提示、边界提示和默认禁用状态；[terminal-capability-map.tsv](terminal-capability-map.tsv) 将 24 个终端 capability 与 2 个 feature 映射到方法/action/字段。它们从原文/实时 fixture 重算或逐项登记，**不是受信安全分类表或生产 allowlist**。

144 项不能以“schema 验证通过”展示为参数完整：根要求 id/method/params、限制额外根字段，但 params 只是 object，任意未知参数键仍可通过。**strict 模式**对这 144 项返回 `parameter_schema_incomplete`；describe 可返回原始片段和缺口。**显式有范围的 raw-contract 模式**在可信安全分类及其它授权 gate 全部满足时可调用 generic 方法，标注 `validation=generic`；这 144 项并未从产品能力永久移除。79 项只能声称 `conditional_branch`，不能声称业务语义完备。P0 的 `pane_id:"9999999999"` 满足模式却被原生拒绝，就是结构与原生语义的边界。校验成功不证明目标存在、原生原子 fence、授权、动作已执行或 prompt 已消费。

所有 144 项属于 session；Host 的 17 项虽均有分支，仍包含 9 个 admin 方法。session 有 28 个原生 admin scope，其中 3 个是 uhp.token.*。9 个 machine.* 不映射成 Gateway 设备注册 API，继续 `profile_not_exposed`。方法分类、参数覆盖、安全授权、adapter 支持必须分列，不能沿用 coverage 单个 reason 的优先级掩盖其它缺口。

## 2. 可以独立实现的模块与接口

建议新增 `src/native-contract/`，内核纯同步计算、无数据库/网络/子进程调用，不导入 protocol.ts、store.ts 或 MCP SDK。下面名称及类型是内核接口提案，不是已经冻结的公共 API。资源隔离宿主将内核放在 worker 内运行，对外用异步私有调用封装；编译后的 Ajv 函数留在 worker，跨边界只传有界数据和 opaque handle，不尝试复制函数。JSON 值始终只读，成功返回原始已检查值；不补默认值、不类型转换、不删除字段、不重新制造原生 response。

```ts
type Check<T> =
  | { ok: true; value: T; evidence: ContractEvidence }
  | { ok: false; error: ContractFailure };

type ContractIdentity = Readonly<{
  binary_sha256: string; schema_sha256: string;
  protocol: { name: 'luvus-uhp'; major: 1; minor: 0 };
  revision: string; // 网关审核的契约 revision，不冒充原生字段
}>;

type ContractEvidence = Readonly<{
  contract: ContractIdentity;
  documents: readonly string[];
  coverage: 'root_only' | 'generic_params_only' | 'conditional_branch';
}>;

type NativeContext = Readonly<{
  machine_id: string;
  target: { profile: 'session'; session: string } | { profile: 'host' };
  connection_epoch: string;
  server_generation: string | null; // Host 无 generation 事实时用 null
  capability_revision: string;
  caller_policy_revision: string;
  local_policy_revision: string;
  contract: ContractIdentity;
}>;

interface NativeValidator {
  describe(view: CapabilityView, method: string): Check<MethodDescriptor>;
  checkRequest(view: CapabilityView, request: unknown): Check<CheckedRequest>;
  checkResponseShape(response: unknown, family: 'general' | 'terminal'): Check<CheckedResponseShape>;
  checkResponse(context: CheckedRequest | BoundResponseContext, response: unknown): Check<CheckedResponse>;
  checkEvent(stream: CheckedStreamContext, event: unknown): Check<CheckedEvent>;
  checkControl(stream: CheckedStreamContext, frame: unknown): Check<CheckedControl>;
}

function compileBundle(
  bytes: Uint8Array, expected: ContractIdentity, limits: CompileLimits
): Check<CompiledContract>;

function bindCapabilities(
  contract: CompiledContract, response: unknown,
  context: NativeContext, source: VerifiedNativeSource
): Check<CapabilityView>;
```

`CompiledContract`/`CapabilityView`/`Checked*` 由模块工厂建立，内部持有不可从 JSON 重建的品牌/引用，绑定 immutable context 与原生请求 id。传输层只能交 unknown 给工厂，不能信任外部对象自报 `checked:true`。编译器不接受 caller 提供的 resolver、远程 URL loader 或可执行 schema。`VerifiedNativeSource` 由将来的本地 endpoint/认证链模块建立；**结构校验不能创建来源认证证明**。

`MethodDescriptor` 至少含 method/profile/transport、request 根 URI 与所有分支 pointers、依赖文档、coverage、native access/scope/idempotent 提示、运行能力状态、参数缺口、安全分类状态、管理/秘密边界、adapter 支持及多项拒绝原因。返回缺失字段的 unavailable 状态，不推测网页 schema。

`checkRequest` 负责完整原生请求的结构及绑定，能返回带 `generic_params_only` 证据的结构成功，用于离线审计/describe，或作为显式 raw-contract 的候选输入；它的返回类型不能叫 DispatchPermit。实际派发还必须执行后文全部 gate：strict 拒绝 generic，raw-contract 必须另验受信范围授权。编译失败没有可用 validator；schema 不存在和参数细节不完整是不同结果。

`checkResponseShape` 可独立重放 P0 故意非法请求所获的合规原生 error，证据仅为根结构；不要求把该非法请求伪装成 CheckedRequest，也不能据此接纳调用结果。`checkResponse` 复用结构检查并做原请求/方法/身份绑定，才返回有绑定的 CheckedResponse。普通结果入口只接受后者且还要检查可信 result boundary，不能接受 shape-only 值或从 payload 自报 ordinary。

含 auth 的 CheckedRequest 仅留在 Connector 受保护内存，不能序列化到 wire、describe、账本、普通结果或错误诊断；Gateway 可先验证不含 auth 的完整根，Connector 注入后复验。边界输入应由有界 bytes parser 生成无行为 JSON；不承诺 JavaScript 可以无副作用识别任意 Proxy。直接 object 入口仅供内部 JSON 值，拒绝访问器/异常原型，调用方不能把任意可执行对象传入。

独立的 `checkDispatch`（由授权任务持有）应消耗候选请求 + 显式执行模式 + 受信分类 + 已认证 principal + 双方策略 + 管理/秘密 gate；raw-contract 另需 `VerifiedRawGrant`。成功才产生内存内不可序列化的 `DispatchPermit`，附带真实参数验证状态。Connector 在写入本地 UHP 前再核对同一 context。协议层与 Router 接入只消费这些结果，不复制第二套 schema 判断；本任务不修改既有 check/authorize 函数。

```ts
type ExecutionMode = 'strict' | 'raw_contract';
type ParameterValidation = 'schema' | 'generic' | 'unavailable';

function checkDispatch(
  candidate: CheckedRequest | RawRequestCandidate,
  mode: ExecutionMode,
  authorization: VerifiedDispatchContext,
  rawGrant?: VerifiedRawGrant
): Check<DispatchPermit>; // permit 保留 mode、validation、原始 coverage 和 grant 审计引用
```

这仍是接口提案，没有实现或冻结公共 wire 字段。`CheckedRequest` 只证明可用 schema 下的实际检查，generic 证据仍保留；`RawRequestCandidate` 仅供方法/参数契约不可用的显式 raw 路径，由受保护工厂从已验证 discovery、绑定目标及有界原生 envelope 建立，**不冒充 CheckedRequest 或编译成功**。全部 schema 编译失败时 strict 内核仍不可用；raw 接入必须使用独立的可信 discovery/已支持 UHP 版本的最小 envelope 边界，不能从失败的 CompiledContract 伪造 view。成功 raw permit 可建立仅用于响应关联的 `BoundResponseContext`，不产生参数已完整验证的证明；现有可用 response schema 与 ID/身份/结果边界仍强制检查，缺少安全的响应边界不能由 raw 豁免。该上下文亦可由可信恢复工厂建立，绝不直接从外部 JSON 强转。提供者及这些工厂的具体编码留授权/接入负责人冻结。

## 3. 能力、方法与字段映射

### 3.1 发现及缓存

| 原生事实 | 提案中的用途 | 不能推导的事实 |
|---|---|---|
| bundle.documents 的 URL 键、$id、protocol | 本地编译资源索引、契约 identity | URL 可联网、该 binary 正在服务 |
| capabilities.methods | 当前 profile 的在线方法集合 | gateway 已授权/已有传输 |
| method_contracts 的 method/access/scope/idempotent | 待审核权限与风险输入，精确方法 join | read 即低风险、idempotent 即可自动重发 |
| access.allowed_methods（若有） | 接入权限的额外上限 | 缺省 local_owner 可越过 Gateway 权限 |
| terminal.capabilities / features | 逐项已审核能力与 adapter 支持的交集 | capability 字符串都可当方法调用 |
| limits.frame_bytes / terminal_stream_frame_bytes | 本地对象/流上限的进一步收窄 | schema bundle 或外层 WSS frame 上限 |
| session/server_generation/endpoint 身份 | 精确实例缓存与原生身份 fence | envelope epoch 已认证 socket |

Session 用 uhp.capabilities；Host 用 host.capabilities，独立缓存。校验完整原生 response 后，再以固定版本 capability 形状检查 methods 唯一、method_contracts 精确一对一、字段类型/枚举、profile/协议/实例吻合。native response schema 对 capabilities 的多数项只给宽泛 object/array，所以此额外步骤不可省略。未知方法可标 `discovered_unclassified`，不能获得执行许可；冲突/重复 classification 记录不可采用“最后一个胜出”。未知传输、未知 terminal feature/action 分别标不可派发，不降级 RPC。

缓存键至少为 machine_id + profile/session + generation（Host 以 null 显式缺省）+ connection_epoch + binary/schema hashes + contract revision + capability revision + caller/local policy revisions。能力快照变化/断线/重连/版本变化均使旧 view 失效；不跨 profile 复用。Host 不能伪造 generation。初次 discovery 是内部、固定只读 bootstrap 路径，仍须可信本地来源；不能因尚无 capabilities 就开放任意方法。

### 3.2 请求与响应

| 边界 | 字段处理 |
|---|---|
| caller 请求 | method 必填；params 缺省是否允许由 facade 冻结。建议保留现有可选 params 输入，适配时显式构造 `{}` 并记录，不在 validator 内默补。caller 的原生 id/auth 一律拒绝 |
| 原生 request | id/method/params 全部必填，id 采用原生 `[A-Za-z0-9._:-]+` 及 128 字符上限，和 wire message/call/attempt ID 分开；Connector 分配 id、受保护地注入 auth 后复验完整根 |
| 并发/幂等 | 只保留安装 schema 实际允许的位置和值；本版额外根 if_revision/idempotency_key 不合法。部分 params 有 if_revision/idempotency_key，不搬到外层，不合成 confirm |
| 普通 response | 完整根 schema：必须有原生 id、result/error 恰一、result 为 object、error 含字符串 code/message、额外根字段拒绝。按原始请求精确 id 关联 |
| 原生 error | 全局 error 允许扩展字段和任意 error.data，完整保留；不能因不识别 code 而伪造成功/网关错误。受条件约束的 agent_not_running.data 仍校验 |
| 条件 result | snapshot、agent_wait、observed agent_prompt、agent_list/title 等继续套用全局 allOf；不能只编译 result.properties |
| terminal response | terminal.backend.* 和 control action 响应同时通过全局 response 与 terminal response；后者拒绝额外 error 字段，允许 metadata/dispatch，不把普通 error.data 套入终端 |

JSON Schema 无法执行的已知 UTF-8 字节约束要单列语义检查：task.add 的 title ≤256 bytes、prompt ≤32768 bytes，task.update 的 prompt ≤32768 bytes，terminal.frame 的 text ≤65536 bytes。前几项来自 request.$defs 中的 `$comment`，不能只用字符长度或 Ajv 通过代替。其它未形式化的原生业务约束继续披露，不自称校验完备。

terminal 的结构 oneOf 接受多个 result type，**本身不关联所请求方法**。额外关联表：inventory→terminal_backend_inventory，snapshot→terminal_backend_snapshot，validate→terminal_backend_validation，processes→terminal_backend_processes，capture→terminal_backend_capture，observe/control→terminal_backend_stream（mode 必须匹配 open），create→terminal_backend_created，wait_change→terminal_backend_change，wait_output→terminal_backend_output，events.subscribe→subscription_started，type_literal/paste_text/submit_text/send_key/set_title/notify/close→terminal_backend_action。通用 uhp.capabilities bootstrap 用全局 response + capability 形状检查；不能一概套 terminal 的精简 capabilities result，因为 P0 的 session capabilities 有额外合法字段。非终端大部分方法没有方法专属 result schema，describe 必须披露 `root_only`，不靠命名猜 result.type。

### 3.3 事件与双向输入

普通事件先验 event envelope，再按 event_catalog 的精确键校验 **data**（不是拿整条事件验证 catalog 根）。terminal.created/moved/metadata_changed/output_ready/exited/closed 同时适用 terminal event 与 catalog payload；terminal.frame、terminal.resync_required 只在终端已审核流上下文使用 terminal event schema，不因 catalog 无键而丢弃。未知事件、错误 stream family、未经协商 feature 均拒绝并交流层结束/要求 resync，不能当普通 result。

保留 sequence、content_revision、原生 generation/terminal_id/pane_id；checkEvent 对绑定身份核对，流状态机负责单流顺序、gap/resync/EOF 和 lease 生命周期。terminal.frame 的 UTF-8 字节数另查，不用 JSON Schema 的字符 maxLength 代替字节上限；bytes 与 text、lines 与原生行计算规则必须一致。行语义需实现者用固定源码/fixture 补齐边界用例，不能凭 split 猜测。JSON 数值无法精确表示时拒绝，不把 >2^53-1 的计数/时间戳静默舍入。

control frame 必须按 action 的完整 oneOf 校验，绑定已授权 control stream、每帧重新授权及输入 id 去重；observe 流永不可写。本版 schema 有 type_literal、paste_text、submit_text、send_key、paste_image、upload_start/chunk/finish/cancel 共 9 action。前四项可作为最小实现切片；图片/上传虽存在 schema 和 capability，P0 未验收，初版 adapter 继续禁用。control_stream 能力不自动授权所有 action。queued ack 不代表消费，丢 ack 不自动重发。

终端映射表的 field_or_selector 是对应输入的字段位置；control_action 非 `-` 时指 action frame 的 params，不是 control open request 的 params。RPC 与同名 frame 共用能力提示仍须分别校验 schema、权限与大小，不能把 text 拼进 open 请求。

## 4. Schema 编译与独立资源预算

继续使用已锁 Ajv 8.20.0 的 Ajv2020。strict:false 只关闭原文写法告警；coerceTypes/useDefaults/removeAdditional 均为 false；不注册自定义可执行关键字/format，不提供 loadSchema。完整 addSchema(document, URL) 后编译所有 29 文档，保留根 allOf/oneOf/$defs/条件约束；describe 裁剪只作展示，执行始终验完整根。

resolver 只在预先接纳的 documents 中按 URI 基址解析绝对/相对 $ref 与 JSON Pointer；键与显式 $id 须一致，无 $id 的 method 文档以 URL 键为基址。所有别名副本（bundle.request/response/event/event_catalog、terminal.documents/methods 等）必须与 documents 的对应原文一致；不能让 describe 和执行各用不同副本。未知 dialect、未登记文档、缺 fragment、重复 $id、URL/路径逃逸、非法 schema、未支持的引用关键字均失败关闭。预扫描 schema 位置的关键字白名单，避免 strict:false 静默忽略未来约束；properties/$defs 内的业务键不误当关键字。URL 是索引，绝不读文件/取网络。

本版无生产可用的循环契约需求；提案拒绝有引用递归的 bundle，区分合法重复 DAG 引用与当前展开栈中的递归。预扫描限额先于 Ajv 编译，避免依赖库栈溢出；编译放在可被超时终止的 worker，超过时间预算整体不可用。不能假设同步 Promise 超时可终止 CPU 编译。

| 对象 | 初始建议上限 | 说明 |
|---|---|---|
| 单 UHP 普通请求/响应 JSON bytes | min(1 MiB，本地配置，已验证原生上限) | 解析前检查；Host 不借 session limits，使用本地 Host 上限 |
| 终端 frame JSON / text | 64 KiB frame 上限再收窄；text 独立查 UTF-8 | schema 中 input 文本上限较大，不代表流 frame 可超限 |
| 已解码普通对象 | 深度 64、节点 100,000、集合项 100,000 | 独立于字节；只接受解析所得的无行为 JSON |
| schema bundle | 2 MiB，总节点 150,000，深度 64，最多 64 documents | 原文 404,048 bytes，可在此预算内；不复用普通 frame 常量 |
| 单 schema document | 512 KiB，最多 2,048 个 $ref，依赖路径最多 32 层 | 总预算继续生效，重复目标缓存，不指数展开 |
| 编译 | worker 2 秒/64 MiB 预算提案 | 需 #15 Bun worker 实测，超限给 compile_limit，不自动放宽 |

这些是待实现压测的本地预算，不是原生协议宣称的固定值。wire 分片/重组由 wire 任务另行冻结：总对象长度、checksum、索引/数量、超时、并发对象数均有界；只有完整重组并验 hash 后才调用 validator。拆成很多小 frame 不能越过整体对象上限。本模块不实现分片。

## 5. 受信安全分类与独立边界

共同派发门禁是：在线实时方法 ∩ 接入权限上限 ∩ 受信安全分类 ∩ 已实现传输/子能力 ∩ caller 策略 ∩ Connector 本地策略 ∩ 独立管理/秘密权限。**参数契约策略另层处理**：strict 要求可用的参数约束；显式 raw-contract 允许在受信范围内接受参数覆盖缺口。每项分别留状态；不以任一成功替代其它项。

| 层/模式 | 参数契约要求 | 失败/成功语义 |
|---|---|---|
| strict（默认） | 完整应用现有根/引用/条件约束，有方法参数约束；不要求宣称原生业务语义完备 | generic 拒绝为 parameter_schema_incomplete；缺失/不可用拒绝为 schema_unavailable；不自动切 raw |
| 显式有范围 raw-contract | 已认证请求显式选择 raw，受保护策略提供独立 VerifiedRawGrant；保留全部可用检查 | generic 可准入并标 validation=generic；无可用方法/参数 schema 时可准入并标 validation=unavailable；不伪称完整通过 |
| 所有模式的安全门禁 | 分类存在、已知、有效、可信且绑定当前上下文；管理/确认/秘密边界分别满足 | missing/unknown/invalid/untrusted 均拒绝；Owner、raw 或 schema 完整都不能豁免 |

`VerifiedRawGrant` 由受保护配置/授权工厂提供，必须限定 principal、machine、profile/session、精确 methods、版本/契约状态与 capability/policy revisions 及有效期，带审计引用。契约不可用时明确绑定 `unavailable` 状态及可信发现版本，不能伪造已验证 digest。每次派发在 Gateway/Connector 双方复验范围、时效及策略；Owner 身份、caller 的 raw_requested 或自填 grant/classification 都不产生授权。未来方法仍需可信分类和明确方法范围，不能预授权所有未知未来方法。

raw 只放宽已明确承认的参数覆盖缺口：继续执行有界 JSON/原生 envelope、保留字段、身份与路由校验，以及仍可用的 schema 约束；已知字段违反现有约束不能降格为 unavailable 后放行，来源不可信、身份/契约完整性不符也不能借 raw 豁免。它不补齐 adapter、不开放未知流帧、不放宽响应/结果与 secret custody 边界。两种模式的 describe/permit/审计分别记录实际 coverage 与 validation；没有完整参数证据时不得输出 complete/fully_validated。

方法已在线公布却未进入安装 schema 枚举时，strict 仍拒绝；显式 raw 可将其记为方法契约 unavailable，按可信分类及精确 grant 使用已支持版本的最小 envelope 检查，不伪造原枚举通过。已登记方法的参数违反现有约束属于 invalid，不能用这一缺方法契约路径绕过。

受信分类记录至少绑定 profile + method（控制帧另绑 action）+ contract digest/revision + capability revision，包含 effect/risk、native scope、required management permission、result boundary（ordinary/protected_secret），由管理员审核的版本化 registry 或等价受保护配置产生。可信模块验证来源并建立品牌；caller 输入、仅有相同 hash、Owner 名称、native local_owner 自报均不能建立信任。214 个实时原生 method_contracts 是审核输入，并非本任务已为其授予网关分类。新增方法必须补可信分类及边界审核，不能凭前缀套模板。

分类缺失、未知枚举、无效/矛盾、来源不可信均默认拒绝；即使 Owner/raw/future 入口、caller/local methods 白名单匹配、参数 schema 完整也不例外。这和 schema_unavailable/parameter_schema_incomplete 分开记录。建议先做身份/来源/安全 gate，再做详细 schema 诊断，防止未认证 caller 借错误窥探契约；内部审计可同时报告多个有界 reason。

管理边界独立于 owner/一般方法权限：Gateway 注册/撤销/配对、Host admin、原生 admin 必须有相应管理授权与真实确认状态（如需要），拒绝自填 approved/confirm 当授权。原生 confirm:true 只满足 schema，不代表网关已有外部确认。

秘密结果边界独立于管理权限：uhp.token.* 全族只能进入单独 secret custody 通道，普通 call/raw/stream/结果句柄/迟到证据均不得把 token 暴露到模型、普通结果库、日志或错误详情。即使已批准 token.create 管理操作，成功结果也不进普通 result pipeline；没有 custody 实现则派发前拒绝。未来方法若分类要求 protected_secret 也受相同规则；分类缺失时先拒绝，不能先执行再尝试关键词脱敏。普通输出也可能含秘密，不能声称 schema 可识别全部秘密。

## 6. 错误分类及保真

错误对象提案：`{ origin:'contract'|'authorization'|'transport'|'native', code, stage, contract_digest?, instance_pointer?, schema_pointer?, detail_reason? }`。contract/authorization code 属网关命名空间；具体 wire error 外壳由 wire 任务映射。只输出有界 metadata，不含原参数、schema 原文、secret、Ajv verbose data。已有 GatewayError 的兼容映射留接入任务。

| 类别 | 建议 code / detail_reason | 行为 |
|---|---|---|
| 数据边界 | invalid_utf8 / invalid_json / duplicate_json_key / json_number_precision / object_limit | 不派发；拒绝原型/访问器/循环对象，不做有损解析 |
| 契约获取/编译 | schema_unavailable（missing_document / missing_fragment / unsupported_dialect / unsupported_reference / duplicate_id / alias_mismatch / reference_cycle / reference_limit / compile_limit / invalid_schema） | strict view 不可用，无远程 fallback；仅独立显式 raw 授权可接受 validation=unavailable，不把编译失败改成成功 |
| 参数缺口 | parameter_schema_incomplete | 结构审计可通过，strict 派发拒绝；raw 可按范围授权准入并保留 validation=generic；不是安全分类缺失 |
| raw 范围授权 | raw_contract_not_authorized / raw_contract_scope_mismatch / raw_contract_grant_expired / raw_contract_grant_stale | 有 raw 请求标志仍可能拒绝；不能默认为 Owner 提供 grant |
| 数据不符 | native_request_invalid / native_response_invalid / native_event_invalid / native_control_invalid | 不修改原生 payload 来迎合 schema |
| 发现/上下文 | capability_stale / capability_invalid / method_not_advertised / profile_not_exposed / unsupported_transport / unsupported_stream_feature / native_id_mismatch / native_result_mismatch / native_identity_mismatch | 不跨实例/通道降级、不重发 |
| 安全分类 | safety_classification_missing / unknown / invalid / untrusted（wire 可统一 code + reason） | 始终拒绝，与 schema 错误独立 |
| 独立授权 | forbidden / management_forbidden / confirmation_required / secret_boundary_required | Owner/raw 不豁免；普通结果管道不可接秘密 |
| 本地传输 | endpoint/process/stdout_limit/deadline/disconnect | transport origin，不合成原生 error；派发后由账本保守 unknown |
| 合规原生 error | 原始 response.error.code/message/data/扩展 | responded + 完整原文；不是 validator 失败，不丢 data |

响应原文结构不合规、ID 错误或超限时，不能把可能执行过的调用变成 not_dispatched；保持 unknown 及无秘密诊断。gateway code 不写回 uhp_response.error。

## 7. 可靠迟到证据的接缝

本模块只提供绑定原始 CheckedRequest 的完整 response 校验与 contract identity；它不接纳迟到证据、不更新 Store、不创建执行。#4 wire + #5 持久化任务必须从原持久化 attempt 锚点取 machine_id、generation、epoch、call_id、attempt_id、target、native request id、contract revision/digest，和已认证来源逐一精确匹配。不能信任消息自己声明 expected 值；当前契约改变时也不能拿新 schema 代验旧 attempt。

恢复后若内存 CheckedRequest 已不存在，由 #5 可信恢复工厂从已校验的原持久化锚点建立仅供响应检查的上下文；不能将外部 JSON 直接强转品牌，也不能把恢复上下文转为 CheckedRequest/DispatchPermit。此恢复接缝与字段保留由 #5 冻结，本提案不假设现有 Store 已保存全部字段。

只有原已派发同一次 attempt、原契约仍可用、完整 response 合规的证据才能交 #5 做补充。相同证据重复、冲突或重放均拒绝；去重记录有界，拒绝不重复更新/派发。timeout/disconnect 历史保留，过期/discard 的原内容不能恢复，秘密通道不能转入普通结果。matrix 中列的是联合任务的接缝测试要求，本草案不声称通过这些测试。

## 8. Fixture 矩阵与验证边界

[matrix.json](../../fixtures/issue4/native-validator/matrix.json) 是可物化的 seed + 单一变更/生成器 + expected 断言草案；所有内容来自固定 P0 fixture 或合成 JSON。按阶段区分结构校验、发现、安全派发、流状态、迟到证据。正例的 accept 仅对标注阶段有效；仅 `dispatch` 阶段可断言是否允许派发。特别保留“generic 参数 schema 接受但 strict 拒绝”“显式 raw 授权 generic 准入但 validation=generic”和“schema 接受但原生 invalid_params”的边界用例。

| 族 | 必需正反范围 |
|---|---|
| bundle | 29 文档、相对/传递 ref、无 $id、根 allOf/oneOf；缺文档/fragment、错误 dialect、重复 id/副本冲突、递归/过深/过大、拒绝任何网络/文件 resolver |
| capabilities | session/Host 分开、完整 join；重复/缺失/未知/伪造分类、代次/hash/policy revision 变化、machine profile 禁用 |
| request | 原生必填 id/method/params、额外根拒绝；prompt wait 条件、keys dependentRequired、automation create/update not、terminal 嵌套引用/边界；144 generic 全量独立遍历 |
| response | P0 原生 error/data 保真、id/互斥/root/type；条件 result/error.data、terminal error/result/mode/身份关联；schema 正例不推导业务完成 |
| event/control | 一般 catalog、terminal.frame/resync；未知/错流/错身份/多字节超限、sequence/gap；只读不可写、control action 条件、advanced feature 默认禁用、ack 不重发 |
| safety/mode | strict 的 generic 拒绝与 raw 的有范围准入；raw 无 grant/错范围/过期/过时拒绝；两种模式下 missing/unknown/invalid/untrusted 均拒绝，与 schema 缺口分离；Owner/future/caller 伪分类、admin/真实确认、secret pipeline 所有旁路 |
| result | 普通结果按调用归属和最新策略复验；inline/handle/late 与未来 secret 方法都不能因 Owner/raw 或管理 grant 进入普通结果，discard 仍需独立权限 |
| late | 同 attempt 合规补充且派发次数不变；锚点每一字段错配/冲突/重复、过期/discard/secret 结果不复活 |

`python3 scripts/issue4/audit_native_design.py` 仅验证映射与源文件一致、seed/变更可物化、矩阵不缺关键族、P0 文件 hash 不变，不执行 JSON Schema/授权/流/存储校验。通过数不得写成 validator 测试通过数。实现后为每个 case 接入 #15 Bun 测试，拒绝以 skip/mock dispatch 替代实际 gate，并补 144 generic 的全量 Ajv 接受 + strict 拒绝，以及有可信分类/范围 grant 的 raw 准入和正确 validation 标记。保留现有公共/P0 测试，不能挪走或改写历史结果。

## 9. 可分配文件范围、冲突及交接

| 可独立任务 | 可写范围（实现阶段建议） | 依赖/禁止范围 |
|---|---|---|
| A：编译与索引 | src/native-contract/bundle.ts、types.ts、limits.ts；新增 test/native-contract/bundle.test.ts | #15 通过后使用已锁 Ajv；不动 protocol/store/锁文件 |
| B：原生结构校验 | src/native-contract/validator.ts、catalog.ts；新增 test/native-contract/native.test.ts | A 的内部类型可先一起评审；不实现传输/数据库 |
| C：受信分类与安全 gate | src/native-contract/safety.ts、reviewed 分类数据；新增 test/native-contract/safety.test.ts | 与授权负责人冻结 VerifiedNativeSource/DispatchPermit；不从 native scope 自动授予权限 |
| D：wire 接入 | 由 wire 负责人独占 src/protocol.ts 与其测试 | 接入 A/B/C；认证、方向、ID、分片、minor 协商另做，不混淆为 schema 成功 |
| E：持久化与迟到证据 | 由 #5 负责人独占 src/store.ts 及相关测试 | 记录原契约/attempt 锚点、retention/discard；不在 validator 修改存储 |
| F：迁移门禁 | #15 负责人独占 package.json、锁文件、运行脚本/CI | 本任务不安装/迁移 Bun，不升级 SDK |

当前变更仅新增 docs/issue4、fixtures/issue4/native-validator、scripts/issue4 下文件；未改 src、package.json、锁文件、现有公共测试或 P0 原文。独立交接写在本文，不改共享 HANDOVER，减少并行冲突。后续新增 test 子目录是否被 Bun 发现必须由 #15 验收后的命令验证。

需要显式对齐的语义：DESIGN §8 和 IMPLEMENTATION-PLAN §9 的显式 raw-contract 能力保留；其 Owner/future 表述须补充 #4 新采纳的安全分类强制门禁。未知安全分类默认拒绝，不等于缺参数 schema 永久禁用。generic 144 / schema unavailable 仅在 strict 下拒绝；显式有范围 raw 在可信分类与全部其它 gate 满足时可准入，保留 generic/unavailable 状态。本次只提出接口与矩阵，没有实际启用任何模式；映射表 runtime_enabled=false 表示尚无实现，不表示产品级永久拒绝。README/HANDOVER 的历史分支/Node 命令由迁移/集成负责人更新；不改历史 P0 结果。P0 audit 的一般事件 catalog 特例仅覆盖 terminal.frame，生产 validator 还需登记 terminal.resync_required；这不是重做 P0 或宣称其原生溢出已验收。

剩余实施前接缝：wire 负责人冻结外壳错误映射/分片和 late anchor 的字段编码；安全负责人冻结可信来源/分类配置/管理授权/custody 的具体提供者；#15 确认 Ajv 编译与 worker 限制在 Bun 的实际行为。任何未提供者保持禁用。无需部署选择即可实现纯编译/结构检查，但这些模块完成仍不等于 #4、认证传输、原生 adapter 或生产可用。
