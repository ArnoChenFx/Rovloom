# Rovloom 的 Luvus validator 接口

当前模块通过 `src/integration/luvus-wire.ts` 接入 Wire v2；宿主 backend、生命周期及未完成边界见 [接入契约](../ISSUE4-INTEGRATION.md)。设计依据为 DESIGN 与 ADR 0002/0003/0004；源码类型是准确签名的维护来源。

原生公共入口为 `src/native-contract/index.js`，导出以下函数及相关类型：

```ts
compileBundle(bytes: Uint8Array | string, options: CompileOptions): Check<CompiledContract>
createNativeValidator(contract: CompiledContract): NativeValidator
parseNativeJson(bytes: Uint8Array | string, limits?: Partial<Limits>): Check<Json>
checkDispatch(candidate: DispatchCandidate, authorization: DispatchAuthorization): Check<DispatchPermit>
inspectRequestGate(candidate: DispatchCandidate, authorization: DispatchAuthorization): Check<NativeRequestGate>
checkResultBoundary(permit: DispatchPermit, authorization: ResultAuthorization): Check<void>
checkSequence(previous: number, incoming: number): Check<void>
```

`NativeValidator` 的完整方法签名及全部输入类型在 `src/native-contract/types.ts`。纯结构函数返回 Check，不抛原生 payload 到异常/诊断；成功值保留完整原生结构并形成不可从 JSON 复制的内存 handle。checkResponseShape 只有结构证据；checkResponse 再关联请求/permit、原生 ID、方法结果类型与可信来源上下文。openStream 仅接受派发 permit 与绑定的 ack；control shape 不代替每次 checkDispatch。

`TrustedNativeContext` 必须由已有或将来的认证/endpoint 层提供，含 `authenticated`、`source_verified` 与完整 binding（target、generation、connection/recovery epoch、contract hashes/revision、capability/双策略/classification revisions）。这些显式输入不证明本模块已实现 TLS/socket 或权限来源；严禁从 wire payload 直接构造为 true。

NativeBinding 另强制 `kind:'luvus'`、`provider_id:string`、`binding_revision:string|number`、`contract_source_ref:string`。revision 不作字符串/数字转换，精确比较；ref 是可信 registry 解析不可变 ContractSource 后给出的固定不透明引用，不接受 caller 自报。Wire 的 v2Target 由 adapter 明确投影成现有 machine/profile/session Target，provider/revision 单独保留在 binding；不改公共 Target。错误 kind、provider、revision 或来源引用不能借同名 native ID 复用 handle。

`DispatchAuthorization` 另需受信本地 classification 输入、当前双方 Policy、principal、管理权限、真实确认、结果 channel/custody、执行模式与原始范围 grant。native method_contracts 仅用于核对评审分类，不能独自授予权限。分类缺失/未知/不完整/不可信在所有模式中拒绝；通用分派的具体子动作也必须分类。

`supported_transports` 是必须显式提供才能准入的 adapter 能力输入（省略即不支持）；`supported_control_actions` 是控制输入的独立上限。未知在线方法的 descriptor.transport 为 unclassified，只能由受信评审声明普通 RPC/Host transport 且 provider 显式支持后进入 raw；未知未来 stream 不自动适配。

strict 默认拒绝 generic/unavailable。raw 必须是 Owner 显式选择并具有绑定 principal/目标/精确方法/版本与 revisions/时效的 raw grant；仅放宽参数覆盖，保留 validation=generic/unavailable。Owner 本身不等于 grant，raw 不绕过独立管理、确认、秘密结果、传输或已存在约束。

raw unavailable 的本地切片是：已有可信且可编译 bundle/response 边界，但在线方法没有方法参数 schema。整个 bundle 不可编译时不制造安全响应边界，仍返回 schema_unavailable；若要支持完全无 bundle 的 raw，须另行定义受信的独立最小 request/response 契约。高级图片/上传 action 无 adapter 证明默认不启用。

编译内核同步、无 I/O，执行解析/大小/深度/引用闭包/关键字检查。宿主 worker 的硬 CPU/内存隔离不在纯模块内，不能宣称已兑现提案的 2 秒/64 MiB；运行时宿主仍须补齐该门禁。Ajv 8.20.0 已列为运行依赖，统一 build 包含 native-contract、wire 与 integration 入口。

Wire 已提供有界重组、去重窗、流状态及迟到证据意图；#5 的持久化、TTL/discard 事务与恢复仍待实现。本模块只提供完整原生响应与来源绑定检查，不更新账本或证明持久化成功。

## Wire 薄适配边界

Wire 的 `raw-contract` 映射为模块的 `raw_contract`。Wire adapter 用可信 resolveAttempt 建立 binding；reject caller 自带的原生 id/auth，再注入受信 binding.native_request_id（auth 只由 Connector 注入）。必须核对 context.method 与 request.method。模块 binding 不重定义公共 Target/provider，也不自行理解 call/attempt envelope；adapter 的私有 handle 表必须按完整 AttemptBinding 定位，不能只用 method 或 native ID 查找。

`requestGate` 可先调用 checkRawRequest 建立候选，再调用 inspectRequestGate。后者返回 classification_status、schema_status、transport_status、authorized、secret_result_authorized、raw_contract_authorized 六个字段；不生成 permit。schema complete 只表示有安装版条件约束且已实际应用，generic 必定 incomplete，不能解释成业务语义完备。raw grant 为真与分类 missing 可同时存在；Wire 必须合取门禁，不能只检查 raw flag。

`validateRequest():void` 再调用 checkDispatch；只有成功 permit 可进入后续实际派发，由 wire/账本控制是否已经发送。Check 的失败可转为仅 code/reason 的异常，不写入原生 error，也不记录 payload。模块不创建任何真实认证或权限来源。

`validateResponse():void` 从私有表取原 CheckedRequest/DispatchPermit，并调用 checkResponse(handle,response,trustedSource)。该检查精确验证原生 id、完整 response、方法/模式/身份及契约/source binding。Wire 仍负责 call/attempt/nativeID/target/contractRevision/digest 全锚点核对。恢复后缺内存 handle 时当前切片安全拒绝，不从消息自报字段恢复；#5 的受信恢复工厂仍待统一集成。

Wire 的 contractDigest 若是组合契约摘要，不得直接强转为本模块 schema_sha256；必须由可信 registry 将其解析为准确的 binary/schema hashes 与 revision。本模块没有跨 runtime 的同名方法兼容逻辑。

结果检查仍是独立入口：ResultAuthorization 必须提供当前 classification_source_verified/revision、当前双方读取授权、principal、channel 与内容状态。分类 revision 已变化或来源无法确认时当前切片拒绝旧 permit 的内容读取，不能沿用旧普通结果分类；恢复/重新评审后的只读上下文重建留 #5 集成，不通过重新派发解决。

`validateStreamFrame` 对事件 data 调用 checkEvent；control input 调用 checkControl，再逐帧 checkDispatch。control 的 ack 是 native response，不是 event：按同一 stream/attempt 下的 input native ID 找到其 permit 后调用 checkResponse，不把 open native ID 误用到每条 ack。绑定 ack 后才可 openStream；shape-only response 或复制的 handle 都不能建立流。纯 checkSequence 只作有界顺序判断，不实现 replay、队列、lease 释放或 close 的网络副作用。

`openStream` 的 ack 必须由 `checkResponse(同一份 DispatchPermit, ack, trustedSource)` 产生；仅由 CheckedRequest 验证后 bound=true，或同一候选产生的另一份 permit，均不足以建立流。复制的 ack/permit 不能建立许可。

JSON 对象快照按字符串转义、UTF-8、键、标点和标量逐项扣累计字节预算，超限立即拒绝，不先克隆或序列化整份超限对象。同一 CompiledContract 的工厂可以共享内存 handle，但完整可信 binding 仍须精确一致；工厂对象身份不是 provider 身份。
