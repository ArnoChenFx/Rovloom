# 通用 provider 的角色接缝

通用 runtime 在既有认证通道和唯一 Store/Router 上提供 Gateway/Connector 装配接口；
公开 CLI/HTTP MCP、配置解析和资源 loader 由唯一入口负责。`createGatewayRuntime`与
`createProviderGatewayRuntime`调用同一 Gateway 装配核心，Luvus result factory 保留兼容接口。
各 provider 交付自己的原生来源、校验、会话与执行能力；装配仍须通过当前 Store/provider 门禁。

## 宿主接口

精确导出与类型见 [runtime 入口](../src/runtime/index.ts)及[宿主类型](../src/runtime/types.ts)：

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
同一 Connector epoch 的当前路由只允许一个明确原 caller；缺失或多主体歧义保持拒绝。

## 结果与预算

结果读取及证据提交消费公共 `Adapter`，`commitNativeResponse`仍在唯一 Store 事务中调用
实际原 Wire `planEvidence`；旧 `commitLuvusResponse`导出名保留。
证据保留按原 caller 的当前权限评估，交付按当前 HTTP caller 逐页重验，不能借用最近主体。

每个中性 provider 必须显式指定 `max_response_bytes`，为不超过 Wire 对象硬上限的正安全整数；
旧 Luvus 入口固定保留 1 MiB 上限。超过 provider 预算时只收窄原 Wire 的原文保留意图，
仍提交实际摘要，不保存响应正文。结果 open/read 继续复验完整 canonical binding、原 kind/revision、
当前授权、原内容状态/期限与原 Wire 读及独立保留门禁。
所有 provider 的正文、句柄与分页继续由同一 Store 全局预算计量，不按 provider 复制资源池。

## 与 Luvus、Herdr 资源工厂的组合

受控 Luvus 来源用 `openManagedLuvusRoot → startManagedLuvus`取得实例；
动作批准与 `issueRestricted`成功后，才用实际 custody 的 `contract`构造 `createManagedLuvusProvider`。
受控 process 的初始探测 contract 不替代受限 custody contract。
管理面共用 `ManagementSessionAuthority.identities/sessions`，MCP caller 与设备身份各走独立来源。
真实用户的登录、持久凭据与动作批准仍由产品流程明确完成，测试不能配置替代品。

Herdr 的[资源工厂](../src/connector/herdr/provider.ts)提供
`createHerdrGatewayResources`与 `createHerdrConnectorResources`。
Gateway 资源交付 `providers/session/catalog/describe/release`，通过
`persistentHerdrBackend(services.store, ...)`复用外部唯一 Store；Connector 资源消费
宿主持有的真实 `HerdrInstallation`、当前策略与独立 receipts/claims，再交给通用 Connector runtime。
安装/schema 编译须在角色启动前完成；双端协商须包含 `rpc/admission_receipt/admission_context`，
Gateway 的原 `providers[].preflightRequest`须随配置传入，保留同一完整根的登记预检与最终派发复验。
释放责任与原生帧预算见[Herdr 资源接线](TRANSPORT.md#herdr-资源工厂)。

隔离构建和验证入口见[开发指引](DEVELOPMENT.md#隔离验收)，Herdr 专用验证见
[原生验证](DEVELOPMENT.md#专用原生验证)及[普通 RPC 与资源工厂](DEVELOPMENT.md#herdr-普通-rpc-与资源工厂)。
模块构建和静态回归不证明公开 CLI/HTTP MCP 联合运行、真实原生管理或同会话两轮回答；
剩余验收见[实施计划](IMPLEMENTATION-PLAN.md#36-herdr-普通-rpc-与剩余验收)。
