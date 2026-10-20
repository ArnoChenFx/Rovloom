# Luvus 原生校验与宿主接口

`src/native-contract/index.ts` 提供异步安装契约编译，以及同步原生校验和授权内核，
`src/integration/luvus-wire.ts` 的 `createLuvusWireAdapter(backend, limits?)`
将其接入 [Wire v2](WIRE-PROTOCOL.md)。准确签名以源码及
`src/native-contract/types.ts` 为准；安全原则、provider 模型和恢复设计分别见
[ADR 0002](../adr/0002-safety-retention-recovery-late-evidence.md)、
[ADR 0004](../adr/0004-multi-runtime-provider.md)。模块接入不代表可部署服务。

`src/connector/luvus/index.ts` 提供固定配置的本地普通 RPC 传输，复用上述 Wire
校验器；资源归属、完整 frame 预算、取消语义及所需宿主证明见
[Luvus 本地 adapter](LUVUS-LOCAL-ADAPTER.md)。缺少可信宿主接线时拒绝派发。

## 契约与内存许可

`await compileBundle(bytes, options, signal?)` 在 Bun Worker 中接纳安装 bundle 的完整根、条件及引用闭包；精确命中固定官方资产时复用已生成代码，其余使用 Ajv2020 离线完整编译并生成官方 standalone 校验代码。
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
原生编译预算。以上为结构/字节预算，不代表 JS heap 大小或 CPU 隔离。

### 编译 Worker 与生成物接纳

首版只接受宿主已审核并精确 pin 的安装版 schema 原字节。远端 Gateway 可独立接收受保护
配置交付的同一固定资料，本地 Worker 编译，不要求安装或运行 Luvus；不自动信任 Wire 重组对象、远端 URL 或 caller
提交的 schema。公共工厂只收原字节、安装身份/限额和可选取消信号，不接收代码、路径或
Worker 工厂。源码和构建产物使用同一个固定 Bun Worker 入口；构建时内嵌 Worker 模块。
Worker 每次先完成原字节摘要、文档、方言、关键字、引用闭包、alias 与当前预算检查，
再以精确 binary/schema SHA 查询受保护的内嵌资产目录。命中时核对编译器、锁定 Ajv、
代码、完整元数据及独立资产摘要，只缓存冻结产物数据，宿主仍逐次登记独立 opaque handle。
未知 binary/schema SHA 继续使用锁定 Ajv 8.20.0 和固定选项执行完整根、条件、引用闭包及事件分支编译；
禁止未知方言/关键字、自定义 format/keyword、在线 resolver 和裁剪约束。

固定输入目录为 `scripts/native-contract/precompiled-inputs.json`，只引用已审核的仓库原字节
及收集记录，不接受外部路径或 URL。`bun run native:generate` 显式重新完整编译并更新资产；
`bun run native:check` 与正常构建在独立 Worker 中重新完整编译核对，生成器不查询现有资产，
缺失、额外或过期生成文件均拒绝。构建观察预算为 30 秒，不扩大产品的 2 秒接纳期限。
单文件打包探针同时验证官方资产内嵌、禁止 Ajv 重新编译的命中路径，以及合成未知 schema
经实际 Worker 完整编译与两个 runtime helper 的正反例；此探针不验证 CLI 或真实原生执行。

每进程至多一个在途编译、没有等待队列；并发返回 `compiler_busy`。从工厂调用开始的
2 秒接纳期限覆盖启动、预检、资产核对或完整编译/standalone 生成、消息与宿主初始化。失败只返回安全
错误码和固定 reason，不透传 schema、生成代码、私人路径或异常原文。普通 schema
拒绝统一投影为 `origin: contract / code: schema_unavailable / stage: compile` 和固定 reason，
包括缺失字段、非法根/目录形状及离线引用失败；拒绝后 Worker 可复用。宿主仍严格拒绝
错误命名空间、阶段、缺失/额外字段等私有协议损坏。取消、期限或 Worker/私有协议故障会永久退役当前编译服务，
请求终止 Worker，并拒绝后续任务及所有迟到回复；恢复需要角色进程重新初始化，
不会自动补建 Worker。预先取消的调用不启动 Worker。角色宿主须等待工厂成功后才发布
就绪，初始化取消/关闭通过 signal 传播；空闲 Worker 不保持进程存活。

宿主只消费自己当前 Worker 的当前任务回复。私有协议准确版本为 1，未知版本/字段、
错误任务身份一律拒绝。产物绑定 binary/schema/revision、固定 Ajv/生成器版本、生成选项
摘要及源码摘要；摘要只检验一致性，来源由私有任务通道保证。生成源码至多 8 MiB，
元数据按单 JSON 对象预算检查；必须完整覆盖所有根和事件导出。宿主用私有 CJS
容器初始化生成函数，`require` 只映射锁定 Ajv 的 `ucs2length` 和 `equal` 两个纯 helper；
不创建 Ajv 实例、不重编译 schema，也不以 ESM 全局模块缓存保留产物。核对和加载均
在期限内通过才登记真实 CompiledContract。既有同步 validator、opaque 许可及事务
接口不变；复制 Worker/JSON 数据不能恢复许可。已接纳契约不依赖编译 Worker 存活。

这是可取消、可拒绝迟到产物的编译边界，不承诺 64 MiB 硬 heap 隔离、Worker 在指定
时刻物理退出或主线程硬实时响应。主线程仍需解析生成 JavaScript，并同步执行后续
校验；这些阶段没有独立 CPU/heap 硬隔离。`smol`、终止事件、定时器及字节/节点
计量都不是硬资源上限的证明；任意不受信 schema 自动编译不在首版范围。

session capability 必须提供正安全整数的 `limits.frame_bytes`、
`terminal.limits.request_bytes` 与 `terminal.limits.response_bytes`。
原请求、bound response、event 和 control 分别执行通用与适用终端预算的交集，
计入完整 UTF-8 JSON 和结束 LF。`checkResponseShape` 没有原 capability，不能证明
在线较低预算或来源关联通过。Connector 注入受保护 auth 后，实际写出入口还须
重新计量完整帧；禁止用注入前长度作为可发送证明。

`checkCapabilitiesShape(input, expected)` 复用原响应 schema、完整方法目录、protocol、
session/generation 和 terminal 预算检查，只返回 shape 结果；它不读取认证标志或登记
view、response handle、candidate、permit。远端 epoch 接纳可在没有 MCP caller 时用它
拒绝非法快照。之后 `bindCapabilities` 仍必须取得独立当前 `TrustedNativeContext`，
并生成 Gateway 本地 opaque view；shape 成功不授予读取或派发权限。

固定 Luvus 0.14.3 有 29 文档、223 方法，其中 79 个有条件参数分支，144 个只有
通用 params object；79 个也不代表业务语义完备。session、Host 与未接入的
access_machines 分开，machine.* 不用作 Gateway 设备注册。数据及审计入口见
[开发指引](../DEVELOPMENT.md#固定输入与维护用途)。

`checkRequestShape` 使用原有有界复制：已收录方法检查完整已编译请求根，未知方法只检查
既有 raw 最小信封。成功返回 void，不表示参数覆盖完整或获得 raw 授权；不登记
能力视图、候选、来源或执行许可，不检查在线能力及分类授权。Gateway 可将它接入既有
Store 首次登记事务的同步 preflight，非法参数回滚登记；后续原 Wire 与实际 IO 门禁仍完整复验。

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

`encodeResponseObject(responseFrame, objectId)` 只封装原 adapter 私有上下文中的响应编码，
复用 `fragmentObject` 并返回只读的有界 Wire 文本分片；没有公开 context 或新的许可工厂。
必须仍持有原请求状态、当前读取许可和协商的 objects，不能由 JSON、冷 adapter 或 binding
重建。接收端复用 `acceptChunk`，只在完整内层响应验证后调用原 `commitLuvusResponse`。
发送、背压与受保护的活读取解析见 [transport 接线](../TRANSPORT.md#响应对象与原始读取)。

结果层创建句柄前使用原 adapter 的 `checkResultRetention(binding, nativeFrame): void`。
它先核对活的原请求、精确响应和当前读取授权，再用原 permit 复验派发时及当前分类的保留许可；
`retention:none` 即使可读也拒绝保存，当前放宽不能复活派发时禁存内容。无原上下文时拒绝，
不从账本或响应 JSON 创建 permit；证据计划与该 port 共用这一检查。
该保留 port 仅支持普通 RPC；流及控制 ack 报 `result_retention_rpc_only`，不借开流许可保留控制结果。

宿主能力的交付范围与后续门禁见 [实施计划](../IMPLEMENTATION-PLAN.md)。
