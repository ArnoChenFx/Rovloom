# 通用 provider 的角色接缝

本片在既有认证通道和唯一 Store/Router 上增加通用装配接口；公开 CLI/HTTP MCP、
配置解析和生产资源 loader 继续由唯一入口维护。旧 `createGatewayRuntime`与
新 `createProviderGatewayRuntime`调用同一装配核心，旧 Luvus result factory 仍是兼容 wrapper。
本片自身不包含 Herdr backend，也不解除 Store 对尚未合入 provider 的候选门禁。

## 宿主接口

`src/runtime/index.ts`公开以下端口：

| 接口 | 受保护宿主须交付的实际资源 |
|---|---|
| `createProviderGatewayRuntime` | 同一 Store/身份宿主、当前 HTTP caller 身份源、精确完整 Target/provider binding、双端政策修订、独立 native readiness 和显式结果字节预算 |
| `ProviderGatewayRuntimeOptions.session(connection, channel, services)` | 当前实际认证 epoch 的原 provider `Session`；异步安装在启动前完成，不能在此把 JSON 转为原生来源 |
| `GatewayProviderServices` | 唯一 `store/router`、当前 `localProvider/localPolicies/policies`和 `currentPrincipal`；证据保留同步栈内为原持久 caller，其余操作从当前可信 HTTP 作用域取主体 |
| `createProviderConnectorRuntime` | provider 原 `adapter/executeWire/readiness/close`；外部宿主持有安装、进程与持久 claims，全部 epoch 停止后由显式 `release`释放 |
| `createConnectorAdmissionLedger` | 实际认证 `Connection`、受保护完整 Target→principal 路由、当前双端政策、独立 `AdmissionContextReader`、共享 `ConnectorAttemptBook`及可信单调时钟 |
| `createProviderResultAccess` | 原 Wire 只读/保留门禁、当前主体/政策和完整受保护 provider binding及预算；不取得 Wire 编码或原生执行能力 |

通用 Gateway 不要求 UHP schema、Luvus delegation 或 Luvus native peer evidence。
实际 provider 的原生来源、schema、权限与 executeWire 仍由其既有已审实现负责。
Gateway session 回调发生关闭重入或包装失败时回收已取得的 Wire/session；客户端退出只关闭其连接，
不会关闭常驻 Gateway。Gateway 的长期资源仍按既有 `release()`结果关闭；
Connector 的有界逻辑关闭及未确认 owner 观察接口保持原语义。

## 独立原准入上下文

可选协商能力 `admission_context`依赖 `rpc`和旧 `admission_receipt`，默认 offer 仍仅 `rpc`。
旧 cutoff-only receipt 及调用端兼容；其缺失字段不能被升级成通用执行准入。
协议精确字段见 [Wire 协议](protocol/WIRE-PROTOCOL.md)。

Gateway 从唯一 Store 已提交 attempt/responseAnchor 发送原 principal、完整 binding、
两种用途独立的摘要、原锚点、sequence 与 fence。`registered_request_sha256`直接复用
`registeredRequestDigest(payload, principalId)`，与 Store `request_hash`同式；
`request_sha256`继续保持旧完整派发帧摘要语义，不能互换。

Connector 的 `ConnectorAdmissionReceipts`须配置完整受保护 routes，先同步持久提交后才通知 reader。
同序列精确重复幂等，跳号/回退/冲突拒绝；原身份、摘要、method/mode、三类期限保持固定，
状态和内容只能收紧。TTL/epoch 的本机不可逆 floor 与认证 source sequence 分开保存，
重启不恢复旧 epoch 或执行许可。断连先持久 fence，再关闭 session；持久失败仍清理并降级。

`createConnectorAdmissionLedger`仅在真实原 Wire 同步 decode 期间提供候选视图；
完整认证、双摘要、受保护 route、原登记政策修订及最终 fence 全过后才提交原文和共享去重摘要。
新请求只允许 dispatching/connector_accepted，unknown/responded 仍可用于已有尝试的晚到最小证据。
正文回收、dedup 和原 deadline 分别采用原绝对截止，绝不以重连时间加 TTL 替代。
失效通知先回收本机原文，再通知 provider 原 Wire；close 不清除共享 book、receipt 或发送墓碑。

网络状态更新是认证有序异步消息，既不是瞬时远端撤权，也不是执行许可。
实际写入仍须经 provider 自己的当前身份/策略/安装/真实 socket peer、原 Wire 和持久发送 claims 门禁。
同一 Connector epoch 的首切片路由只允许一个明确原 caller；缺失或多主体歧义保持拒绝。

## 结果与预算

结果读取及证据提交消费公共 `Adapter`，`commitNativeResponse`仍在唯一 Store 事务中调用
实际原 Wire `planEvidence`；旧 `commitLuvusResponse`导出名保留。
证据保留按原 caller 的当前权限评估，交付按当前 HTTP caller 逐页重验，不能借用最近主体。

每个中性 provider 必须显式指定 `max_response_bytes`，为不超过 Wire 对象硬上限的正安全整数；
旧 Luvus 入口固定保留 1 MiB 上限。超过 provider 预算时只收窄原 Wire 的原文保留意图，
仍提交实际摘要，不保存响应正文。结果 open/read 继续复验完整 canonical binding、原 kind/revision、
当前授权、原内容状态/期限与原 Wire 读及独立保留门禁。
所有 provider 的正文、句柄与分页继续由同一 Store 全局预算计量，不按 provider 复制资源池。

## 与生产 loader、Herdr 的组合

生产 Luvus loader 用 `openManagedLuvusRoot → startManagedLuvus`取得受控实例；
动作批准与 `issueRestricted`成功后，才用实际 custody 的 `contract`构造 `createManagedLuvusProvider`。
受控 process 的初始探测 contract 不替代受限 custody contract。
管理面共用 `ManagementSessionAuthority.identities/sessions`，MCP caller 与设备身份各走独立来源。
真实用户的登录、持久凭据与动作批准仍由产品流程明确完成，测试不能配置替代品。

Herdr 的异步 `HerdrInstallation.open`、`createHerdrHostServices`、`persistentHerdrBackend`
与 `createHerdrRuntime`由其独立切片维护。它们按上述结构组合即可消费通用角色，
不需要另一套 Herdr backend/Store/协议。实际 H1 安装与生产路由门禁仍须对应切片合入后验收。
官方 Luvus 的隔离构建模块复核另见 [可复现入口 PR74](https://github.com/ArnoChenFx/Rovloom/pull/74)，
其成功不能代替公开 CLI/HTTP 或 Herdr 原生运行验收。
