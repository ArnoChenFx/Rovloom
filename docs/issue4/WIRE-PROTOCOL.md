# Issue #4：Gateway / Connector wire 1.0（内部契约）

日期：2026-10-18 UTC。基线 main `5124d459fa0f712fd1dbb9f164a3513e3e538716`。
依据：DESIGN v0.4 §10–12、IMPLEMENTATION-PLAN §4.1、ADR 0001/0002/0003 及 issue #4。
本交付是纯 codec、协商、关联判断与有界内存辅助模块；不启动 listener，不验证或签发真实凭据。
实现见 `src/wire/`。当前 Target 严格沿用 `src/contracts.ts`，未增加 provider 标识。
未来 Target 字段、provider 路由及相应版本策略须由父会话协调，本任务不冻结该兼容变更。

## 信任与调用边界

每个 WebSocket message 是一个 UTF-8 JSON envelope。禁止 BOM、非法 UTF-8、非法 JSON、非有限数、孤立 surrogate、
过深/过大值。编码额外拒绝 getter、toJSON 类对象、稀疏数组、循环和 symbol，避免执行输入代码。
所有类型严格核对根字段和 payload 字段；未知帧/流功能拒绝，不猜测语义。

`decodeWireFrame(input, context)` / `encodeWireFrame(frame, context)` 接收显式受信 context：

```ts
type CodecContext =
  | { phase: 'preauth'; direction: Direction;
      offer?: VersionOffer; handshake_message_id?: string }
  | { phase: 'authenticated'; direction: Direction;
      connection: ConnectionIdentity & {
        authenticated: true; active: true; negotiated: Negotiated
      };
      native?: NativePayloadValidator;
      resolveAttempt?: (received: AttemptIdentity) => NativeValidationContext | undefined };
```

`direction` 是本帧的传送方向，不是当前进程角色。`connection` 必须来自真实认证/撤销层；
`authenticated/active` 只是外部事实的注入契约，不是 codec 生成的安全证明。集成层每次操作都须确认其仍有效。
不得将帧、welcome、自报 machine 或 epoch 相等当成认证来源。测试中的 context 为明确的 synthetic 输入。
`resolveAttempt` 必须查询独立可信的原锚点，禁止用收到的 attempt 生成“预期”锚点。

顶层 `src/protocol.ts` 保持原五个运行时导出名与版本常量。调用签名收紧为显式 context：
旧 `decodeFrame(input, epoch)` 和省略 context 的 `encodeFrame(frame)` 均报 `authenticated_context_required`。
该语义变更已在实施前报父会话；原 epoch-only 草稿不保留可派发兼容路径。
原 Envelope/Payloads 类型导出名也保留，字段形状按本数据字典收紧。
`src/wire/index.ts` 是内部子模块入口；未新增 package/public 顶层导出。

## 版本与能力

本实现支持 wire major 1 / minor 0；与 UHP 1.0、MCP 2025-11-25 是三个独立协议。
Offer 为 `{major, minor, capabilities, required}`；minor 表示支持上界。
协商 major 不同即拒绝；minor 为双方和本实现上界的最小值。能力只取双方显式广告、且该 minor 已知的交集。
未知可选能力不启用；任何未知/未共同启用的 required 能力拒绝。
数组最多 64 项，无重复；required 必须属于本方 capabilities。

| 能力 | wire 1.0 行为 |
|---|---|
| rpc | request / accepted / response / cancel 的普通调用路径 |
| history_scope | request/open 中允许显式 history 引用 |
| late_evidence | unknown 的同次响应证据判断 |
| objects | object_chunk 与有界重组 |
| events | 原生事件流 |
| terminal_observe | 终端只读流 |
| terminal_control | 双向终端流；同时要求 terminal_observe |

业务帧必须精确使用 selected minor，不重新按单帧协商。welcome 必须属于本地保存的 offer，满足全部本地 required，
并以 `in_reply_to` 核对握手 message_id。welcome 本身不将 context 切为 authenticated。
更高 minor 的远端 offer 可协商到 0；不会因精确 minor 不同直接拒绝。
当前 strict 字段集合下，未来扩展必须先定义版本/能力及兼容规则，不接受未协商字段。

## 数据字典与方向

所有帧共有 `protocol_major, protocol_minor, type, message_id, payload`。
预认证 enroll/authenticate/welcome/error 的根字段仅有以上五项。
已认证所有帧另必需 `machine_id, recovery_generation, connection_epoch`，逐项比对外部连接事实。
网关 ID 使用 `[A-Za-z0-9_-]{1,128}`；原生 request ID 保留 UHP `[A-Za-z0-9._:-]{1,128}`。
contract_digest 使用小写 SHA-256 hex。时间为非负安全整数毫秒，deadline/期限必须为正；
是否已过期以及写出前的原子 deadline 检查由 #5 调度/准入完成。

| type | 方向 | 必填 payload（`?` 表示可选） |
|---|---|---|
| enroll | Connector → Gateway，预认证 | registration_id, connector_instance_id, enrollment_credential, offer |
| authenticate | Connector → Gateway，预认证 | machine_id, recovery_generation, connector_instance_id, device_credential, offer |
| welcome | Gateway → Connector，预认证 | machine_id, recovery_generation, connection_epoch, in_reply_to, selected |
| request | Gateway → Connector | attempt, uhp_request, deadline, validation, history? |
| accepted | Connector → Gateway | attempt |
| response | Connector → Gateway | attempt, uhp_response |
| cancel | Gateway → Connector | attempt, reason |
| heartbeat | 双向 | sequence |
| stream_open | Gateway → Connector | request 的全部字段，另 stream_id, feature |
| stream_data | Connector → Gateway | attempt, stream_id, feature, sequence, frame |
| stream_input | Gateway → Connector | attempt, stream_id, feature, sequence, frame |
| stream_close | 双向 | attempt, stream_id, reason |
| error | 双向，预认证或已认证 | source, code, retryable, cause_message_id? |
| object_chunk | 双向，schema_bundle 只允许 Connector → Gateway | object_id, kind, total_bytes, sha256, chunk_count, index, data |

`attempt` 为 `{call_id, attempt_id, native_request_id, target, contract_revision, contract_digest}`。
与外层连接身份合起来构成 `AttemptBinding`；不能省略任一维度。
Target 为 `{machine_id, profile:'host'}` 或 `{machine_id, profile:'session', session}`，
machine 必须等于已认证连接 machine；session 显式非空，不继承 shell/default/current。
`history` 仅为 `{history_epoch, client_request_key}`；恢复代次使用外层 recovery_generation。
任何带 key 的入口都必须显式保留该二元引用；禁止从 discovery 静默补当前范围。

`validation` 必填 strict/raw-contract，不能自动降级。`uhp_request` 是完整原生请求，原生 id 必须与 attempt 一致；
不允许 caller 注入 auth。原 SDK 工具层的无 id 请求需在受信 adapter 分配原生 id 后再进入 wire。
`uhp_response` 原样保留 result/error（含 error.data），原生 id 必须一致；结果/错误只允许其一，
随后仍须完整原生 schema 校验。`accepted` 只表示桥接接收，不表示执行/消费/成功。

cancel reason 为 caller_cancelled/deadline_exceeded；close reason 为
normal/cancelled/overflow/resync_required/transport_error。取消不代表远端回滚，close 不生成关闭 pane 的原生操作。
heartbeat sequence 从 0 开始；心跳只表示链路健康。序号为安全整数，不代替原生 event_sequence/ack。

## 原生验证与分类注入

```ts
type NativeValidationContext = {
  binding: AttemptBinding;
  method: string;
  mode: 'strict' | 'raw-contract';
  transport: 'rpc' | 'stream';
  feature?: 'events' | 'terminal_observe' | 'terminal_control';
};
interface NativePayloadValidator {
  requestGate(request: Record<string, unknown>, context: NativeValidationContext): RequestGate;
  validateRequest(request: Record<string, unknown>, context: NativeValidationContext): void;
  validateResponse(response: Record<string, unknown>, context: NativeValidationContext): void;
  validateStreamFrame?(frame: Record<string, unknown>, context: NativeValidationContext & {
    feature: 'events' | 'terminal_observe' | 'terminal_control'; direction: 'data' | 'input'
  }): void;
}
```

验证器失败抛异常，不能返回 false 后继续。不得修改输入、coerce/default/remove 字段、联网抓 schema 或把 URL 当路径。
生产 validator 须来自绑定安装 binary/完整契约闭包的模块；本任务不在 `src/native-contract/` 写实现。
`resolveAttempt` 返回同一 NativeValidationContext；响应/accepted/cancel/流帧会核对其完整 binding。
stream_data/input 的 feature 必须精确匹配原 attempt 的可信 transport/feature；response 仅用于 rpc。
原生数据是 RPC response、事件、控制输入还是 ack，及其 server_generation/terminal identity/lease，均由原生 validator/adapter 判定。

`RequestGate` 的状态与权限必须由受信集成层生成，绝不能来自 caller、wire payload 或远端自报：

| 字段 | 合法值与 gate |
|---|---|
| classification_status | trusted_complete / missing / unknown / invalid / untrusted；只有 trusted_complete 可执行 |
| schema_status | complete / incomplete / unavailable；strict 只允许 complete |
| transport_status | supported / unsupported；只允许 supported |
| authorized | 当前 Gateway caller 与 Connector 本地策略及必要确认均通过 |
| secret_result_authorized | 已有合适秘密 custody/敏感内容授权、保留与交付路径 |
| raw_contract_authorized | 当前 Owner 独立显式 raw 授权；不能仅因 Owner 身份或 payload 选择 raw 就给 true |

trusted_complete 必须覆盖 ADR 0002 的作用/幂等性/传输、子动作、高权限/确认、秘密结果与可信契约/本地评审来源。
布尔字段是外部事实的传递契约，不在 wire 中伪造分类表或真实身份。未知子动作不能借已知容器方法获准。
分类先检查；其余门禁失败也不因 raw 放宽。raw 只可放宽 params 的不完整/不可用状态；
完整 envelope、大小、auth 保留字段、原生 id/根/条件、当前授权与秘密门禁保持。
144 个通用 params object 是 schema 缺口，不是完整参数验证，也不能直接当成安全分类未知。

主要错误按 code/source 区分：classification_unavailable、parameter_schema_incomplete、parameter_schema_unavailable、
unsupported_transport、forbidden、raw_contract_forbidden、native_validator_unavailable、stream_validator_unavailable。
原生模块的 schema/闭包错误应保留其独立 code，不包成 UHP error，也不回显 payload/secret。

## 生命周期、重复与迟到证据

普通状态沿用 created → dispatching → connector_accepted → responded；
可能已送达而未有回复保持 outcome_unknown。codec 不登记调用、不写出 UHP，不执行任何 replay。
accepted/cancel/response 没有原锚点时拒绝；不得因收到帧而新建 attempt。
实际状态转换、deadline、取消与 durable dispatch 锚点均由 #5 在单 writer 事务中实现。

`MessageWindow.observe` 对完整已验证的逻辑业务帧按 machine/generation/epoch/direction/message_id 记 SHA-256。
相同 ID/相同内容返回 duplicate，冲突报 message_id_conflict。默认最多 4096 项、60 秒固定窗口，
重复不续期，满窗拒绝，不提前淘汰承诺期内 ID；时钟回退拒绝。
该窗口仅为连接内存去重。超过窗口或重启后的执行幂等性必须依靠 #5 的持久化 call/attempt/history，
不能将窗口过期的新消息视为新执行授权。object_chunk 的片内重复由 assembler 处理，完成后的内部 envelope 仍走该窗口。

`advanceStream` 为纯状态转换：open 建 opening，首个已验证 data 转 open；input 只允许 open 的 terminal_control。
data/input 分别从外层序号 0 严格递增；重复交给 MessageWindow 先过滤，错序拒绝，close 后拒绝输入/数据。
这里的 open 仅表示外层流有合法数据，不代替原生握手/lease/ack 成功证明。

`planResponseEvidence(response, context, anchor, now, policy?)` 输出 append/duplicate 意图，永远 `dispatch:false`。
unknown 细化要求 late_evidence 能力，原仍有效认证连接与原持久化 attempt 的全部 binding 精确一致，
完整原生 response 验证通过，墓碑仍在且未切 attempt。无锚点、not_dispatched、旧 epoch/恢复代次、
契约/目标变化或冲突均拒绝。相同 response hash/长度重复不创建原文写入意图或句柄，不续期限。

可用且未过期的内容，只有当前受信 `policy={classification_status:'trusted_complete', retain_content_authorized:true}`
才可进入 payload 待提交意图；缺失/不可信分类或未授权时固定 delivery=metadata_only。
该判断不可来自旧持久化 ACL、caller 或 response 自报；custody 类秘密不能借此布尔值进入普通内容路径。
expired/discarded/unavailable 同样只输出受保护的 binding、接收时间、
response hash/字节数、result/error 类别与固定 expires_at，不携带原文，也不产生句柄。
函数不修改原 anchor/超时/取消历史；#5 必须保留历史、当前授权、预算、原子持久化与发布。
事务失败仍保持 unknown；在内存观察到 plan 不构成 durable responded。该意图不是 caller 可直接读取的返回体。

## History scope

`HistoryScope` 必须来自 Gateway 的受信持久化记录：history_epoch、recovery_generation、status(active/retired)、
scope_created_at、accept_new_until、frozen_dedup_ttl。scope 不存在不回退为 active。
`planHistoryAdmission` 核对引用、恢复代次、key 摘要、请求摘要、固定期限：

| 条件 | 结果 |
|---|---|
| 可信范围 + 未过期已有 key + 同请求摘要 | return_existing；退役也只返回原 call_id |
| active + 缺 key + now < accept_new_until | register_new 意图；dedup_expires_at=now+冻结 TTL |
| 已有 key 请求摘要不同 | request_key_conflict |
| 截止同刻/退役缺 key/未知范围/旧恢复代次/墓碑到期 | dedup_history_unavailable |

强制 `scope_created_at < accept_new_until <= scope_created_at + frozen_dedup_ttl`，
已有记录须在准入期创建且 dedup_expires_at 等于首次创建加冻结 TTL。
查 scope/key 与采用意图必须在 #5 同一事务内完成；函数不签发 scope、不迁移旧重试缓存、不证明历史完整性。
隔离恢复、scope 元数据清理、24 小时/30 天配置默认值与备份新鲜度由 #5 处理。
客户端和服务端均不得自动重写 recovery_generation/history_epoch/key。显式新范围/新 key 是新意图，
即使参数相同也不承诺跨范围语义去重或 exactly-once。

## 大小、分片与资源

| 边界 | 固定上限/规则 |
|---|---|
| 单 WebSocket message | 1 MiB UTF-8 JSON |
| 逻辑 envelope object | 8 MiB；重组后仍完整验证 |
| schema_bundle object | 16 MiB；独立于 session 原生 frame 广告上限 |
| JSON 深度/节点 | 根深度 0，最大 64；最多 100,000 个 value 节点 |
| 分片 | 原始字节每片 64 KiB，最后一片可更短，规范 padded base64 |
| 并发重组/总预约 | 每个认证连接/方向最多 4 对象、20 MiB |
| 重组截止 | 首片起 30 秒；重复/进度不续期，截止同刻拒绝 |

object_chunk 是显式 objects 能力；kind 为 envelope/schema_bundle。total_bytes、sha256 与 chunk_count 全片一致；
chunk_count 精确等于 ceil(total_bytes/64KiB)，index 从 0 顺序，大小必须与片位置相符。
相同片重复幂等；片内容/描述冲突隔离，乱序拒绝，末片校验整个原始字节 SHA-256。
完成/失败对象 ID 保留有界 30 秒关闭窗，不自动重用。每连接/方向单独 assembler，换身份/epoch 不复用。
超时内存于下一次 push 清理，始终受预约/数量上限；集成层也可销毁整个已断开的 assembler。

envelope 完成后禁止嵌套 object_chunk，重新执行方向、连接、关联、原生与授权检查。
schema_bundle 只作为未授信 JSON 对象交付；必须经 native-contract 离线引用闭包、dialect、循环/深度/大小等门禁后使用。
checksum 只证明完整性，不是签名或认证。逻辑 UHP request/response 还须服从原生广告/本地策略的更低上限，
由原生 validator/transport 集成实施；此处较大的 object 上限不允许扩大本地 UHP 能力。

## 验证、交付与未接入边界

`test/wire/helpers.ts` 离线编译原 P0 fixture 的 29 个 documents，未使用 loadSchema；
使用录制的完整 request/response、真实 terminal.frame/control 输入验证 wire 注入点。
正反覆盖根/条件约束、原生 ID、error.data 保留、版本交集、所有帧方向/缺字段、认证与锚点 fence、
分类与 schema 独立、144 个 generic 缺口、raw 独立授权、history 截止/旧代次、可靠迟到/冲突/内容不可复活、
UTF-8/Unicode/JSON/大小/深度、有界去重、真实 bundle 分片、错序/checksum/超时/容量及流状态。
error.data 的嵌套保留为合成边界样本；没有冒称 P0 录制了不存在的 error.data。

测试 Gate 的分类/授权是 synthetic 明确注入；没有构造生产安全分类来源，也没有用 mock 宣称原生门禁完成。
生产 native-contract 接口适配与联合测试尚需父会话提供精确 API；此模块缺 validator 默认拒绝。
预认证凭据只有 synthetic 字符串，没有网络认证、真实 enrollment 消费、WSS/TLS、持久化、调度或发行验收。
结果交付/秘密 custody、native stream generation/lease/ack、去重事务、恢复隔离与晚到提交仍属于对应后续任务。

以下验收结果以本文件末尾最终记录为准；本交付仅本地提交，不推送、合并或部署。

### 本地验收记录

Bun 1.4.3 / revision `c6da4a4d3010e5553438c60f6bd76d981976867c`，binary SHA-256
`7ce7d6b654eddeec20afddf2396317fba6dc19ab52788a27e894e1806bf8f24b` 与既有审定基线一致。
环境原先无 Bun，从官方 npm `@oven/bun-linux-x64@1.4.3` 提取相同字节到 `/tmp/issue4-tools/bun`，
未全局安装；GitHub 读取仅使用 ArnoChenFx 既有 connector。指定 main 的 tree/blobs/签名 commit 对象经 connector
导入本地并逐一核对 Git hash；本地浅边界在指定 main，不改远端。

所有下列命令使用 `bun --no-env-file`，`run` 在本表省略重复前缀：

| 检查 | 结果 / 退出码 |
|---|---|
| install --frozen-lockfile --ignore-scripts | 97 包，0；package/bun.lock 未变 |
| run typecheck | strict / noUncheckedIndexedAccess 全部源码和测试通过，0 |
| run test | 36 pass / 0 fail / 0 skip，0；17 项非协议既有回归 + 19 项协议/边界测试 |
| run test:p0 | 原 P0 JS 7 pass + Python 7 OK，0 |
| run test:bun | 5 pass / 0 fail，0 |
| run p0:audit | 29 文档、30 request、29 response、23 event、2 故意无效，0 |
| run p0:bun-native | 仅重放既有 Bun 原生归档，729 项历史采集断言全通过，0；未新启动真实 Luvus |
| run build | 10 个 ESM/chunk/map 产物，0 |
| run smoke | 顶层导出集合/共享 GatewayError/真实 SQLite 重开，0 |
| 独立 protocol 产物 smoke | 直接导入 dist：heartbeat 往返、epoch-only 拒绝、缺 native validator 拒绝，0 |

额外 Linux strace 执行链记录主测试/typecheck/P0/兼容/审计/build/smoke；PATH 前置 node/nodejs/npm/npx exit99
拒绝脚本，实际这些可执行文件尝试数为 0。原始日志和 SHA-256 收据在临时目录
`/tmp/issue4-final-verification/verification.json`，未随仓库提交，不能冒称已上传持久附件。
最终收据 SHA-256 为 `1ad1352981ed352f44736dc42782cbdfd18823219e981255fab19b054dcb85ff`。

确实执行了原版 `python3 scripts/bun/verify.py --bun /tmp/issue4-tools/bun --output /tmp/issue4-unmodified-verify`：
其空缓存冻结安装、实装依赖审计、strict 配置/完整文件发现、TypeScript 类型错误负例全部通过；
基础 36 项测试进程也退出 0，随后该验证器因硬编码预期 20 项报 `foundation: test count differs`，整体退出 1。
该脚本还只扫描顶层 `*.test.ts`，须由父会话在获准范围更新递归发现及计数，再重跑 CI；
本任务按所有权约束未修改脚本/CI，未将该失败说成 CI 通过。原始记录在 `/tmp/issue4-unmodified-verify/`。

构建继续只有原四个入口；未被 protocol 引用的 history/evidence/object/stream 辅助模块是经 tsc/test 验证的内部源码，
将由后续 transport/store 集成导入后进入对应产物，不在本任务偷偷扩展公共构建入口。
生产 native-contract 薄适配、其真实分类/当前授权来源与联合门禁，及 #5 持久化/恢复/调度仍是明确集成边界。
