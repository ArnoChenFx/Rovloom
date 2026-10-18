# Luvus 原生校验与宿主接口

`src/native-contract/index.ts` 提供纯同步、无 I/O 的契约内核，
`src/integration/luvus-wire.ts` 的 `createLuvusWireAdapter(backend, limits?)`
将其接入 [Wire v2](WIRE-PROTOCOL.md)。准确签名以源码及
`src/native-contract/types.ts` 为准；安全原则、provider 模型和恢复设计分别见
[ADR 0002](../adr/0002-safety-retention-recovery-late-evidence.md)、
[ADR 0004](../adr/0004-multi-runtime-provider.md)。模块接入不代表可部署服务。

## 契约与内存许可

`compileBundle` 用 Ajv2020 离线编译安装 bundle 的完整根、条件及引用闭包；
不联网解析 $ref，不读路径，不补默认值、不转换类型、不删除原生字段。
URL 是 bundle 内索引。未知方言、关键字、缺引用、副本冲突及资源超限拒绝。
`parseNativeJson` 执行有界 JSON 检查；对象入口只供内部无行为 JSON。

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

`checkResponseShape` 仅证明结构；`checkResponse` 再关联原候选/permit、native ID、
方法结果及可信来源。`openStream` 的 ack 必须由同一份 DispatchPermit 验证，
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

宿主能力的交付范围与后续门禁见 [实施计划](../IMPLEMENTATION-PLAN.md)。
