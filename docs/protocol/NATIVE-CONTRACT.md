# Luvus 原生校验与宿主接口

`src/native-contract/index.ts` 提供纯同步、无 I/O 的契约内核，
`src/integration/luvus-wire.ts` 的 `createLuvusWireAdapter(backend, limits?)`
将其接入 [Wire v2](WIRE-PROTOCOL.md)。准确签名以源码及
`src/native-contract/types.ts` 为准；安全原则、provider 模型和恢复设计分别见
[ADR 0002](../adr/0002-safety-retention-recovery-late-evidence.md)、
[ADR 0004](../adr/0004-multi-runtime-provider.md)。模块接入不代表可部署服务。

`src/connector/luvus/index.ts` 提供固定配置的本地普通 RPC 传输，复用上述 Wire
校验器；资源归属、完整 frame 预算、取消语义及所需宿主证明见
[Luvus 本地 adapter](LUVUS-LOCAL-ADAPTER.md)。缺少可信宿主接线时拒绝派发。

## 契约与内存许可

`compileBundle` 用 Ajv2020 离线编译安装 bundle 的完整根、条件及引用闭包；
不联网解析 $ref，不读路径，不补默认值、不转换类型、不删除原生字段。
URL 是 bundle 内索引。未知方言、关键字、缺引用、副本冲突及资源超限拒绝。
`parseNativeJson` 执行有界 JSON 检查；对象入口只供内部无行为 JSON。
字符串与 UTF-8 字节入口均拒绝 BOM。引用遍历使用显式栈，结构嵌套不消耗
JS 调用栈；循环和超过预算的引用链返回 schema_unavailable，不生成 handle。

| 原生内核预算 | 默认上界 |
|---|---|
| 单 JSON 对象 | 1 MiB、深度 64、100,000 个 value 节点 |
| 安装 bundle | 2 MiB、150,000 个 value 节点 |
| documents | 64 份，每份 512 KiB |
| 引用 | 2,048 条，任一路径至多 32 条 $ref；结构边不计引用深度 |
| terminal.frame JSON 编码 | 64 KiB（不含 LF）；另验原生 text/bytes/lines 约束 |

该 64 KiB 不适用于所有 terminal event；如 terminal.metadata_changed 仍按单 JSON
对象及当前在线帧预算校验。control 也受 `terminal_frame_bytes` 的 JSON 编码预算约束，
此项同样不含 LF；下述在线 request/response 帧预算则包含 LF，两项分别执行。

`CompileOptions.limits` 只能降低这些上界。Wire 的 16 MiB bundle 重组上界不扩大
原生编译预算。以上为结构/字节预算；同步 `compileBundle` 没有硬 CPU/heap 隔离，
只能用于已审核本地 bundle。生产自动接纳 schema 仍须先交付 DESIGN 的可终止独立
编译 worker 和 2 秒/64 MiB 限额；线程选项、定时器或快照计量不能作其验收证明。

session capability 必须提供正安全整数的 `limits.frame_bytes`、
`terminal.limits.request_bytes` 与 `terminal.limits.response_bytes`。
原请求、bound response、event 和 control 分别执行通用与适用终端预算的交集，
计入完整 UTF-8 JSON 和结束 LF。`checkResponseShape` 没有原 capability，不能证明
在线较低预算或来源关联通过。Connector 注入受保护 auth 后，实际写出入口还须
重新计量完整帧；禁止用注入前长度作为可发送证明。

固定 Luvus 0.14.3 有 29 文档、223 方法，其中 79 个有条件参数分支，144 个只有
通用 params object；79 个也不代表业务语义完备。session、Host 与未接入的
access_machines 分开，machine.* 不用作 Gateway 设备注册。数据及审计入口见
[开发指引](../DEVELOPMENT.md#固定输入与维护用途)。

`checkRequest`/`checkRawRequest` 建立候选，`inspectRequestGate` 独立报告分类、
schema、传输及授权状态，`checkDispatch` 成功才产生不可从 JSON 复制的
DispatchPermit。strict 拒绝 generic/unavailable；raw_contract 只在 Owner
显式选择、可信精确范围 grant 有效且其它门禁均满足时放宽参数覆盖，保留实际
validation。缺失/未知/不完整/不可信分类、管理权限、真实确认及 secret custody
在所有模式中仍强制检查；不能借 raw 绕过已存在的 schema 约束。

raw 的 validation=unavailable 仅适用于已有可信、可编译 bundle 及可用 response
边界，但在线方法未收录于该 bundle 的方法 schema 的情形。整个 bundle 编译失败仍为
schema_unavailable，不能建立 validator/许可，也不能借 raw 作为无 schema 执行入口。
原生 method_contracts 仅用于核对受信本地分类，不单独授权；通用分派还必须分类
具体子动作，raw grant 绑定 principal、完整目标、精确方法、契约/revisions 与时效。

`checkResponseShape` 仅证明结构；`checkResponse` 再关联原候选/permit、native ID、
方法结果及可信来源。RPC 可由真实 permit 的 `sealResponseContext` 固定最小结果约束、
原生 ID、完整 NativeBinding 与含 LF 的在线响应帧预算；独立 opaque 上下文不保留请求参数、
原 permit/candidate 或完整 capabilities。`releaseRequestContext` 撤销同一 RPC 候选的全部许可，
一并断开原请求及分类登记；持有先前 CheckedResponse 也不能通过内部关联反向保留原请求。
宿主同步丢弃自己的原文引用。`checkResponseOnly` 只返回 `Check<void>`，复验同一契约和来源，
不返回载荷、不授予读取/派发/开流能力；`releaseResponseContext` 释放它。没有 JSON 恢复工厂，
不能让旧 epoch 或恢复代次重新有效。流/控制许可不走此 RPC 释放路径。
Luvus adapter 把内容清理后的 RPC 切换为这种上下文；仅响应状态共享 attempt/快照预算，
只允许原固定去重期限内的 metadata-only 证据提交。Store 提交后通知与 adapter 独立内存期限维护
共同回收原文；断连、撤销、provider fence、关闭或去重到期释放句柄。证据提交失败不变更已提交
结果，也不触发重发；存储恢复后仍须使用原存活句柄及当前独立来源复验。
`openStream` 的 ack 必须由同一份 DispatchPermit 验证，
另一份 permit 或复制 handle 均无效。`checkEvent`、`checkControl` 及
`checkSequence` 不提供实际 replay、队列消费、lease 释放或网络副作用。
保留完整原生 error/data，网关错误不写回原生 error。

## 宿主必须提供的可信来源

`NativeWireBackend` 必须由认证、账本、双端受保护配置及原生 endpoint 证明实现。
不得用 caller、消息、设备广告或相同 hash 自证信任。

| backend 来源 | 必须保证 |
|---|---|
| connection / currentPrincipal | 当前已认证且 active 的连接、恢复代次、epoch 与读取身份 |
| attempt | 原登记完整 AttemptBinding、请求、principal、method/mode/transport，流另有 feature/stream_id |
| provider / localProvider | 双端独立受保护配置，完整 binding 精确一致 |
| contract | 不可变 ContractSource、真实编译 handle、能力/分类 revision；重算 ref 并核对 binary/schema |
| nativeSource | 独立 endpoint/身份实证，authenticated/source_verified 成立且完整 NativeBinding 匹配 |
| policies / authority | 当前双方精确 Target grant、可信分类、Owner/raw grant、管理权限、真实确认与 custody |
| now / contentStatus / responseAnchor | 受信时钟、固定内容状态与 durable 原派发锚点；不从回复补建 |

direction 来自宿主角色。v2 Target 显式投影为原生 Target，kind/provider/revision/
contract_source_ref 单独保存在 NativeBinding；revision 不作字符串/数字转换。
组合 contract_ref 不能强转为 schema hash。完整 provider tuple 求双方权限交集
后才投影给原生 Policy，不从独立数组拼笛卡尔授权。原生 supported_transports
及 supported_control_actions 必须显式提供，未知未来流不自动适配。
`contract` resolver 只能返回已接纳的 handle；`schema_bundle` 重组结果不授予编译或
登记权限。opaque handle、permit 和来源 token 均不能跨进程/重启序列化后恢复为原凭证。

## 请求、控制与交付生命周期

- 每帧重新读取原 attempt、双端 binding、契约和原生来源，核对原请求；caller 的
  id/auth 拒绝，native ID 从登记绑定注入，auth 仅由 Connector 受保护注入。
  requestGate 不生成 permit，validateRequest 再 checkDispatch；Check 失败只转
  code/reason，不记录 payload。backend 异常返回 native_adapter_unavailable。
- adapter 按完整 AttemptBinding 私有保存最初 permit，重复编解码不替换。
  开流错误不建立流；ack 必须经同一 permit 验证。每条控制输入先 checkControl，
  再按 action 重新 checkDispatch。高级图片/上传无 adapter 证明时不启用。
- control ack 按同一 attempt 内自己的 native ID/permit 验证，不能借 open ID。
  `checkResult(binding, nativeFrame)` 对流逐条强制指定实际 response/event；
  缺省报 result_selector_required，未知或未派发控制 ID 报 control_ack_unbound。
  RPC 可省略 frame。解码/顺序校验成功不授予内容读取权限。
- checkResultBoundary 另验当前 reader、分类 revision、双方 read grant、custody
  和内容状态；分类变更不能沿用旧 ordinary 分类。planEvidence 只返回待持久化
  意图，原分类和当前分类 retention 均为 caller_policy 才能包含 payload。
  retention:none 可允许即时读取，证据仅元数据。过期/discarded/unavailable 或
  撤权不得输出原文、生成句柄或延长期限；事务成功前不能发布 durable responded。
- 宿主须先 observeMessage 过滤重复，再 advanceStream 检查外层顺序，重复不得
  再执行；acceptChunk 重组后仍走完整门禁，包内 schema 不自动进入可信 registry。
  内存 handle/source token 不序列化，关闭、到期、撤权须 release；恢复缺 handle
  时拒绝，不从回复重建 permit，不通过重新派发恢复结果。

默认至多 128 attempts、每个 128 control IDs、合计 16 MiB 保留 JSON 快照；
快照逐项扣 UTF-8/转义/键/标点预算，超限先拒绝。共享 CompiledContract 可共享
handle，但完整可信 binding 仍须一致。该计量不是 JS heap 隔离。

对象分片使用独立 Wire 传输子额：每连接方向最多 4 个活动对象、20 MiB 声明总长预约，
活动对象与拒绝墓碑合计最多 4096 项；不计入上述快照字节。首片固定 30 秒截止时间，
进度和重复片不续期，adapter 空闲维护也释放到期组装引用。内容或身份 fence 发生时，
未完成对象尚不能可信关联到具体调用，adapter 保守释放该连接所有活动分片，保留有界 ID
墓碑拒绝续传与短期重建；可能中止其它调用的在途分片，不据此自动重派原动作。

宿主能力的交付范围与后续门禁见 [实施计划](../IMPLEMENTATION-PLAN.md)。
