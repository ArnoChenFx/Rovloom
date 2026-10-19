# Rovloom Wire v2：provider 绑定与执行边界

执行版本 major **2** / minor **0**。Wire codec、provider scope、关联和有界对象判断通过 `src/integration/luvus-wire.ts` 接入真实 Luvus NativeValidator，见 [原生校验与宿主接口](NATIVE-CONTRACT.md)。认证、存储和传输由宿主提供可信实现。

原生 runtime Luvus/Herdr、UHP 标识与源协议 fixture 保持原样。

## 版本与入口

`decodeWireFrame(input, context)` / `encodeWireFrame(frame, context)` 只接受 v2。
major 不同直接拒绝，不自动协商回 v1；minor 为双方与本实现已支持 minor 的交集上界。
能力只取双方显式广告且当前 minor 已知的交集。未知可选能力忽略，未知/未共同支持的 required 能力拒绝。
capabilities/required 最多各 64 项，无重复；required 必须属于本方 capabilities。

| 可选 feature | 用途 |
|---|---|
| rpc | 普通 request/accepted/response/cancel |
| history_scope | 显式登记 history_epoch/client_request_key |
| late_evidence | unknown 同次 attempt 补证 |
| objects | 有界 envelope/schema_bundle 分片 |
| events | 原生事件流 |
| terminal_observe | 终端观察 |
| terminal_control | 终端输入；同时要求 terminal_observe |

业务帧使用已选定 minor，不能按消息重新猜版本或放行未知 feature。welcome 必须匹配本地保存的 offer/required，
并用 in_reply_to 核对原握手 message_id；收到 welcome 不自动产生已认证上下文。

项目尚未发布，不提供 Wire v1 的兼容 decoder 或执行入口。旧帧直接拒绝，
不补默认 provider；v2 的 provider 缺失或可信 binding 不可用时不得执行。
当前 history scope/TTL 算法、Store 数据库 v1→v3 迁移及外部原生协议版本独立保留。
顶层 protocol 的版本为 2.0；epoch-only 调用或缺 context 的编码拒绝。

## 身份、Target 与绑定

每个 WebSocket message 对应一个 UTF-8 JSON envelope。共同根字段为
`protocol_major, protocol_minor, type, message_id, payload`；已认证帧还必须带
`machine_id, recovery_generation, connection_epoch`，逐项核对外部当前认证连接。

```ts
type V2Target =
  | { machine_id: string; provider_id: string; profile: 'session'; session: string }
  | { machine_id: string; provider_id: string; profile: 'host' };
type ProviderBinding = {
  machine_id: string; provider_id: string; kind: 'luvus' | 'herdr';
  config_ref: string; binding_revision: number; enabled: boolean;
};
```

V2Target 定义在 wire 内；integration adapter 显式投影到公共 contracts.Target，并在 NativeBinding 单独保留 provider 身份。
Target 不包含 kind 或 expected_binding_revision；未知字段严格拒绝。session 显式非空，不继承 shell/current/default。
provider_id 只在所属 machine 内解析，稳定且不可复用；binding_revision 为正安全整数、单调且不可复用。
配置/启用状态变化必须分配新 revision。历史分配与不可复用由可信 registry 事务保证，codec 不伪称能从单个快照证明。
config_ref 是受信本地配置的 opaque 引用，codec 不读取该路径/URI，也不接受 caller 替换本地 endpoint。

当前 resolver 必须返回 machine/provider 精确匹配的可信 binding。先检查 enabled，再检查 kind/revision；
禁用实例阻断其派发、流、内容读取辅助判断与迟到补证，不撤销设备身份，也不影响其它 provider 的心跳/绑定。
重新启用的新 revision 不能沿用旧 attempt。kind 的实际选择来自可信 binding，消息只回显该快照并被核对。

Herdr 的 host profile 在派发前报 unsupported_profile；当前 session 执行门禁固定报 provider_support_candidate。
support_status=validated 也不解除该门禁。类型和来源描述不授予执行权限。

## ContractSource 与 contract_ref

```ts
type ContractSource = {
  provider_kind: 'luvus' | 'herdr'; protocol_family: 'uhp' | 'herdr-json';
  binary_version: string; binary_sha256: string; schema_sha256: string;
  schema_origin: 'installed_cli';
  schema_command: 'luvus uhp schema' | 'herdr api schema --json';
  server_version: string | null; native_protocol_version: string | null;
  runtime_generation: string | null; adapter_revision: string;
  classification_revision: string | null;
  support_basis: 'live_catalog' | 'schema_and_version';
};
```

`contract_ref = SHA256(boundedJson(ContractSource))`，编码为 64 位小写 hex，具有不可变内容含义。
它不是签名、认证、执行许可，也不是 native request id。candidate 描述可有摘要，但不能形成可执行契约。
必填来源缺失、未知 schema_origin/命令、kind/protocol/命令不一致均拒绝；不能用网页 schema 代替 installed_cli。
null 如实表达未观察到的可选 server/protocol/generation 值，不合成原生 generation。
任何来源值变化都会改变 contract_ref。当前可执行 Luvus 还要求可信 validated 状态、live_catalog 和非空 classification_revision；
分类完整性及方法/子动作的多轴门禁继续由原生模块判定。

wire 只按 ref 查可信 ContractRecord `{source, support_status:'candidate'|'validated'}` 并重新计算摘要核对，
不接受消息附带 ContractSource 来自证。原生缓存与 handle 必须另绑定完整 provider/profile/session/attempt，
不能仅按 schema hash 或 ref 跨 provider 共享执行身份。

## Attempt 与调用外层

```ts
type AttemptIdentity = {
  call_id: string; attempt_id: string; native_request_id: string;
  target: V2Target; provider_kind: 'luvus' | 'herdr';
  binding_revision: number; contract_ref: string;
  registration: {
    deadline: number;
    history: { history_epoch: string; client_request_key: string } | null;
    caller_policy_revision: string; local_policy_revision: string;
  };
};
type AttemptBinding = ConnectionIdentity & AttemptIdentity;
```

request/open 的 `payload.expected_binding_revision` 是独立调用字段，必须与 attempt.binding_revision 和可信当前 binding 一致；
它不属于 Target/native_request。登记 deadline/history/双方 policy revision 放在 attempt.registration，后续帧完整回显。
原锚点核对覆盖 machine、provider、revision、kind、profile/session、恢复代次、epoch、call/attempt/native ID、contract_ref 及 registration。
不能换目标/契约/范围/登记条件或采用新 revision 接纳旧执行。

所有 attempt 帧（包括 request/open）都需要独立 resolveAttempt，禁止根据收到的 payload 构造预期锚点。
新派发还核对当前双方 policy revision 与登记版本一致；已有响应只可进入受保护的接收/证据路径，读取要重新授权。
deadline 是正安全整数毫秒；codec 不调用不可信设备时钟。实际写出前由宿主原子核对 deadline、预算并提交 dispatching 锚点。

下面是完整 request JSON。contract_ref 由固定原生 fixture 来源加明确的 synthetic 测试 adapter/classification revision 计算，
不是生产分类或执行授权。无 opaque native handle/认证凭据写入示例。

```json
{
  "protocol_major": 2,
  "protocol_minor": 0,
  "type": "request",
  "message_id": "example_request",
  "machine_id": "machine_1",
  "recovery_generation": "recovery_1",
  "connection_epoch": "connection_1",
  "payload": {
    "attempt": {
      "call_id": "call_1",
      "attempt_id": "attempt_1",
      "native_request_id": "proxy-ping",
      "target": {
        "machine_id": "machine_1",
        "provider_id": "provider_1",
        "profile": "session",
        "session": "p0-issue3"
      },
      "provider_kind": "luvus",
      "binding_revision": 1,
      "contract_ref": "aa705145f483bd10592632ee9748978c745f0ff7e73263271fe6e3fae234e973",
      "registration": {
        "deadline": 1000,
        "history": {
          "history_epoch": "history_1",
          "client_request_key": "key_1"
        },
        "caller_policy_revision": "caller_policy_1",
        "local_policy_revision": "local_policy_1"
      }
    },
    "expected_binding_revision": 1,
    "native_request": {
      "method": "ping",
      "params": {}
    },
    "validation": "strict"
  }
}
```

[完整 JSON 示例](../../test/wire/v2-examples.json)另含 accepted、response、cancel、stream_open/data/input/close，
每个都是无缩写、带完整 attempt 的 v2 envelope；测试逐帧实际解析验证。native request/response 与终端内容来自隔离 P0 记录，
外层 provider/policy/handle/授权上下文为明确 synthetic 测试数据。

| type | 方向 | 必填 payload |
|---|---|---|
| enroll | Connector → Gateway，预认证 | registration_id, connector_instance_id, enrollment_credential, offer |
| authenticate | Connector → Gateway，预认证 | machine_id, recovery_generation, connector_instance_id, device_credential, offer |
| welcome | Gateway → Connector，预认证 | machine_id, recovery_generation, connection_epoch, in_reply_to, selected |
| request | Gateway → Connector | attempt, expected_binding_revision, native_request, validation |
| accepted | Connector → Gateway | attempt |
| response | Connector → Gateway | attempt, native_response |
| cancel | Gateway → Connector | attempt, reason |
| heartbeat | 双向 | sequence |
| stream_open | Gateway → Connector | request 的全部字段，另 stream_id, feature |
| stream_data | Connector → Gateway | attempt, stream_id, feature, sequence, frame |
| stream_input | Gateway → Connector | attempt, stream_id, feature, sequence, frame |
| stream_close | 双向 | attempt, stream_id, reason |
| error | 双向，预认证或已认证 | source, code, retryable, cause_message_id? |
| object_chunk | 双向，schema_bundle 仅 Connector → Gateway | object_id, kind, total_bytes, sha256, chunk_count, index, data |

所有根/payload/target/registration 字段严格列举，未知枚举拒绝。native payload 的完整根/条件/$ref 验证交给可信 kind 的 validator。
已认证业务帧不能使用未协商 minor 或未知 major；握手 offer 的较高 minor 仅表示协商上界，
不允许直接执行该版本的业务帧。
网关错误 source 仅 gateway/transport，code 不含原文；原生 error/data 原样保留在 native_response，不伪装成网关 error。
accepted 不是远端执行/消费成功；cancel 不等于回滚；stream_close 不生成关闭 pane 的原生请求。

## 可信 context 与原生薄适配

已认证 context 包含当前连接事实、resolveProvider、resolveContract、双边 ProviderPolicies、
`validators: Partial<Record<ProviderKind, NativePayloadValidator>>`、resolveAttempt 和 resolveNativeSource。
缺任一必要来源都默认拒绝。authenticated/active 是外部事实输入，不由 epoch/welcome 自报产生；
codec 不实现 TLS、凭据认证/签发或撤销来源。

```ts
type NativeValidationContext = {
  binding: AttemptBinding; method: string; mode: 'strict' | 'raw-contract';
  transport: 'rpc' | 'stream'; feature?: StreamFeature;
  native_handle?: unknown; trusted_source?: unknown;
};
interface NativePayloadValidator {
  requestGate(fullNativeRequest: JsonObject, context: NativeValidationContext): RequestGate;
  validateRequest(fullNativeRequest: JsonObject, context: NativeValidationContext): void;
  validateResponse(response: JsonObject, context: NativeValidationContext): void;
  validateStreamFrame?(frame: JsonObject, context: NativeValidationContext & {
    feature: StreamFeature; direction: 'data' | 'input'
  }): void;
  checkDispatch?(frame: JsonObject, context: NativeValidationContext): void;
}
```

wire 先拒绝 native_request 的 caller id/auth，核对原登记 method/mode，再从 resolveAttempt.binding 注入 native_request_id，
把完整原生 request 传给 validator。选择 validator 使用受信 ProviderBinding.kind，不使用 caller 自报字段。
`raw-contract` 在原生薄适配中映射 native `raw_contract`；原生 Check 失败转 code-only WireError，不能返回 false 当 void 成功。
wire 也把异常 message/原始 data 清除，只保留合法 code 或通用 native_* 错误；成功 void 必须实际返回 undefined。

响应与流必须有原 attempt 的 opaque native_handle 和 resolveNativeSource 当前返回的独立可信来源；缺失即拒绝。
handle 由原生 checkRequest/permit 流程生成，按完整 AttemptBinding 保存在受信过程内映射；不能从响应内容重建。
本模块不发明 native handle，也不把不可序列化验证器对象冒充持久化记录。
stream data 由适配器做原生 event/handshake/ack 类型验证；event 使用 checkEvent，合法原生 response/ack 使用相应原 handle。
input 先做 checkControl/完整帧校验，再每帧 checkDispatch；后者显式收到当前原生 frame 与可信 context，
可按实际子动作作多轴判断，无须共享“最近一帧”的可变缓存，也不能沿用 open 时权限。
原生 generation/terminal identity/lease/ack 语义仍由 adapter 保留，外层序号不能替代。

RequestGate 由原生多轴 gate 提供：classification_status、schema_status(complete/generic/unavailable)、
transport_status、authorized、secret_result_authorized、raw_contract_authorized。
只有 trusted_complete 分类、支持传输、当前授权及秘密交付路径可执行；strict 对 generic/unavailable 分别报参数契约不完整/不可用。
只有独立显式 raw 授权可放宽参数 schema；原生 permit 的 generic/unavailable 状态必须保留，不映成 complete。
Owner 身份、raw 选择、未来方法或未知子动作不绕过分类/高权限/秘密门禁。

`createLuvusWireAdapter` 已实现 NativeValidator 的 Check/handle 适配：从 backend 取得原登记请求、双端 provider 和独立 nativeSource，私有保存最初 DispatchPermit，用同一 permit 验证开流 ack，并逐次重新授权控制输入与结果读取。精确 native 签名见 [原生校验与宿主接口](NATIVE-CONTRACT.md)。
集成测试使用真实 native 模块编译固定 Luvus fixture 的 29 个离线 documents；认证、分类及 provider 来源由明确的 synthetic backend 提供，不构成生产来源证明。

## Provider scope 权限

```ts
type ProviderGrant = { target: V2Target; methods: string[];
  actions: Array<'dispatch' | 'read' | 'stream_input' | 'cancel'> };
type ProviderPolicy = { revision: string; grants: ProviderGrant[] };
type ProviderPolicies = { caller: ProviderPolicy; local: ProviderPolicy };
```

授权必须在 caller 和 local **分别存在同一完整 Target + method + action 的 grant 行**。
没有 wildcard，不将 machines/providers/sessions/methods 平铺成笛卡尔积；未知旧 policy 字段拒绝。
一方授权 `(machine_1,provider_2,session A)` 和另一条授权 `(machine_1,provider_1,session B)`，不能拼成 provider_1/session A。
每边最多 4096 行，每行最多 256 方法、4 actions；空列表自然拒绝。

`assertProviderAccess(binding, method, action, context)` 供宿主做当前 binding/禁用与 provider scope 判断；
它不替代各入口的 caller/设备身份认证。普通派发、取消、逐帧输入在 codec 中使用对应 action。
响应接收仅为内部关联/验证，不等于读取授权；晚到 payload 保存意图还要求当前 read scope 和受信 ResponseContentPolicy。
caller 撤权后仍可有受保护的最小接收审计，不能据此交付内容。provider 禁用则连原 attempt 的补证也拒绝。

## 登记、history 与可靠迟到接口

| 纯接口 | 宿主必须保证的可信输入与原子后续 |
|---|---|
| registeredRequestDigest(payload, callerId) | 来自已认证 caller；摘要绑定完整 Target/provider/revision/kind/契约/登记条件/validation/native request，不含新分配 call/attempt/native ID |
| planHistoryAdmission(reference, generation, digest, scope, record, now) | scope/key 按 caller 与原历史范围在同一 writer 查询；采用 return_existing/register_new 意图也在同一事务 |
| resolveAttempt | 返回原完整 AttemptBinding、method/mode/transport/feature，以及存在时的原 native handle；不从消息补建 |
| assertProviderAccess | 当前可信 provider snapshot 与双方完整 scope；不是身份认证来源 |
| planResponseEvidence(frame, context, anchor, now, policy?) | durable dispatch 原锚点、固定内容/墓碑期限、当前分类/内容权限；事务成功后才发布状态 |

registeredRequestDigest 是已登记 wire 意图的规范摘要，不是自动迁移/重签旧 key 的授权。
旧重试必须继续使用原 recovery_generation/history_epoch/key/原登记数据；不能发现新 provider revision/契约后自动重算重派。
同 scope 已有 key 只返回原 call；摘要不同 conflict。active 缺 key 且 now < accept_new_until 才给登记意图；
退役/未知/旧恢复代次/缺失历史或截止同刻均拒绝。冻结 TTL 与原创建/截止约束沿用 ADR 0002；没有隐式当前 scope。

迟到响应必须仍在有效认证连接、当前 provider 启用且 revision/contract/全部 attempt 精确匹配，原 native handle/source 和完整原生响应通过。
unknown 补证需 late_evidence feature；缺锚点、旧 attempt、墓碑已删、冲突或旧 revision 一律拒绝，不创建执行。
意图恒为 dispatch:false；原超时/取消历史和 TTL 不变。相同 hash/长度 duplicate 不产生 payload/句柄写入意图。
expired/discarded/unavailable 或当前分类/内容权限/read scope 未许可时，仅 metadata_only：ID、接收时间、hash/长度、result/error 类别。
不恢复原文、不生成句柄、不续期。事务失败保留 unknown，不能将内存 plan 作为 durable responded。
持久化、固定期限、预算、恢复隔离与旧 DB 迁移属于宿主职责。
原生较低帧预算同样适用于 metadata_only 补证；原文不保留不代表可以跳过响应校验。
`ResponseEvidencePlan` 保持无持久化副作用：宿主必须在同一 writer 事务中再次核对原锚点、
证据 hash/长度、固定期限和当前状态后提交；事务失败不得发布 responded 或制造重派。

## 资源、顺序与重组

| 边界 | 规则 |
|---|---|
| 单 message | 1 MiB UTF-8 JSON；非法 UTF-8/JSON/BOM/孤立 surrogate 拒绝 |
| JSON | 深度 0..64，最多 100,000 个 value 节点；编码拒绝循环/getter/toJSON 类对象/symbol/稀疏数组 |
| 网关 ID | `[A-Za-z0-9_-]{1,128}`；原生 request ID `[A-Za-z0-9._:-]{1,128}`；摘要 64 位小写 hex |
| 对象/bundle | envelope 8 MiB / schema_bundle 16 MiB，各自独立；不扩大原生广告的更低限额 |
| 分片 | 原始字节 64 KiB，最后一片短，规范 padded base64；chunk_count 精确 ceil，index 从 0 顺序 |
| 重组 | 同一认证连接/方向最多 4 对象、20 MiB 预约，首片起固定 30 秒，重复/进度不续期 |
| MessageWindow | 默认 4096 个已验证逻辑消息、固定 60 秒；相同 ID/内容 duplicate，冲突拒绝，满窗拒绝 |

分片描述冲突/片冲突隔离，错序拒绝，完成后校验完整原始字节 SHA-256；完成/失败对象 ID 有界保留 30 秒关闭窗。
超时于下一次 push 清理，内存始终受预约与数量上限；断开后销毁该连接 assembler。checksum 不是认证。
重组 envelope 再完整走 v2 provider/契约/关联/原生门禁，不允许嵌套 object_chunk；bundle 只作为未授信 JSON 对象交付，
需原生模块离线编译引用闭包/dialect/根/条件约束后才能使用，不联网抓任意 URL。
原生默认 bundle 编译预算为 2 MiB/64 documents，与 Wire 重组预算独立；完整数值见
[原生校验接口](NATIVE-CONTRACT.md#契约与内存许可)。首版 Luvus 只编译宿主已审核的本地安装
schema，由 Bun Worker 完整编译并生成 standalone，以 2 秒逻辑接纳期限、取消及迟到拒绝
控制初始化；宿主同步执行已接纳的生成函数，不承诺硬 heap 上限或 Worker 物理退出时限。
重组对象不因此成为受信安装 schema；流程与限制见
[编译接纳边界](NATIVE-CONTRACT.md#编译-worker-与生成物接纳)。

MessageWindow 只是连接内存窗；窗口后/重启后的执行幂等性依赖宿主持久化，不能将窗口过期视为新派发许可。
stream open 建 opening，首个合法 data 转外层 open；input 仅 open 的 terminal_control，data/input 各自从 0 严格递增。
重复由 MessageWindow 先过滤，错序/关闭后输入拒绝；这不替代原生握手成功、队列消费或终端 lease 证明。

构建与验证命令见 [开发指引](../DEVELOPMENT.md)，后续宿主能力见
[实施计划](../IMPLEMENTATION-PLAN.md)。
