# 通用 provider 的角色接缝

> 本文描述所属细节的现行实现；系统语义以 [DESIGN](DESIGN.md) 为准，冲突时以 DESIGN 为准（导航见 [文档索引](README.md)，总览见 [协议总览](PROTOCOL.md)）。

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
| `createConnectorAdmissionBackend` | 实际认证 `Connection`、受保护完整 Target→principal 路由、当前双端政策、共享 `ConnectorAttemptBook`（本机固定保留期）及可信单调时钟 |
| `createProviderResultAccess` | 原 Wire 只读/保留门禁、当前主体/政策和完整受保护 provider binding及预算；不取得 Wire 编码或原生执行能力 |

`GatewayRuntimeOptions.hosted`显式交付中性provider的`providers/session`分组；
`providers`仍只属于原Luvus本机/远端注册表，两者共享唯一Store、Router和认证listener。
每个实际epoch先取得原会话，再由`composeGatewaySessions`按完整Target及kind委托原adapter。
原Luvus目录继续绑定真实连接、pin和能力来源；`kind: 'mixed'`目录只选择原resolver，
每次发现、描述、分页仍走原authorizer，不从describe重建目录或native来源。

`createLuvusConnectorSessions`复用原Luvus builder而不启动transport，独立Luvus入口也使用同一builder。
`composeConnectorSessions`把它与其它原会话交给唯一中性Connector宿主。
完整路由来自原owner配置。实际执行、schema、socket证据及持久claims仍由各自原端口检查。
原Luvus快照getter保持稳定并逐次复核，Herdr没有对象传输或快照时不补造这些能力。

组合会话的执行/响应上下文合计至多128，原快照字节合计至多16MiB，
跨provider消息ID使用共享有界去重窗。
组合层不复制Store、Router、Wire codec或连接，不增加原native单请求预算。
关闭先同步封锁，再逐一回收原adapter/owner；部分失败不跳过其余owner，失败与晚到清理仍进入原角色终态。

通用 Gateway 不要求 UHP schema、Luvus delegation 或 Luvus native peer evidence。
实际 provider 的原生来源、schema、权限与 executeWire 仍由其既有已审实现负责。
Gateway session 回调发生关闭重入或包装失败时回收已取得的 Wire/session；客户端退出只关闭其连接，
不会关闭常驻 Gateway。Gateway 的长期资源仍按既有 `release()`结果关闭；
Connector 的有界逻辑关闭及未确认 owner 观察接口保持原语义。

## Connector 准入后端

`createConnectorAdmissionBackend`仅在真实原 Wire 同步 decode 期间提供候选视图；
完整认证、受保护 route、原登记政策修订与 deadline 全过后才提交原文和共享去重摘要。
去重期限取 `ConnectorAttemptBook` 的本机固定保留期（默认 30 天，必须覆盖请求 deadline），
首次登记后固定，绝不以重连时间加 TTL 刷新。close 只释放本 epoch 请求原文，
不清除共享 book 或持久发送墓碑（claims）。

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
宿主持有的真实 `HerdrInstallation`、当前策略与独立 claims，再交给通用 Connector runtime。
安装/schema 编译须在角色启动前完成；双端协商 `rpc`，
Gateway 的原 `providers[].preflightRequest`须随配置传入，保留同一完整根的登记预检与最终派发复验。
释放责任与原生帧预算见[Herdr 资源接线](TRANSPORT.md#herdr-资源工厂)。

隔离构建和验证入口见[开发指引](DEVELOPMENT.md#隔离验收)，Herdr 专用验证见
[原生验证](DEVELOPMENT.md#专用原生验证)及[普通 RPC 与资源工厂](DEVELOPMENT.md#herdr-普通-rpc-与资源工厂)。
模块构建和静态回归不证明公开 CLI/HTTP MCP 联合运行、真实原生管理或同会话两轮回答；
剩余验收见[issue 跟踪](https://github.com/ArnoChenFx/Rovloom/issues)。
