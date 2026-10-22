# Gateway / Connector 通道接线

> 本文描述所属细节的现行实现；系统语义以 [DESIGN](DESIGN.md) 为准，冲突时以 DESIGN 为准（导航见 [文档索引](README.md)，总览见 [协议总览](PROTOCOL.md)）。

本模块是 Bun 的受信进程内 transport 接口，不是服务 CLI、身份服务或生产部署入口。
语义以 [DESIGN](DESIGN.md) 为准，帧只使用现有 [Wire v2](protocol/WIRE-PROTOCOL.md)，
账本接线复用 [Store/Router](STORAGE.md)。源码入口为 [transport](../src/transport/index.ts)。

## 运行宿主装配

[runtime](../src/runtime/index.ts)提供独立的 Gateway/Connector 宿主工厂，准确类型见
[types.ts](../src/runtime/types.ts)。CLI、配置解析、HTTP/MCP 协议和管理写服务分别消费这些端口，
不在本模块增加第二套入口。配置默认路径 `~/.config/rovloom/gateway.json` 或 `connector.json`
及显式路径优先的规则由 CLI 负责；runtime 只接收其已核实、已解析的受保护宿主输入。

| 接口 | 责任与寿命 |
|---|---|
| `openGatewayState(options)` | 在既有私有目录打开唯一 Store（单个 SQLite），组合设备认证生命周期；返回同一 ChannelRegistry 和凭据交付端口，不自动注册、兑换或签发 |
| `await createGatewayRuntime(options)` | 组合一个 Router、实际设备 listener、每 socket Wire、可信请求作用域和 `createLuvusResultAccess`；返回 `transport`、`closed/close`、`admit/get/cancel/results` |
| `runAuthenticated(caller, operation)` | 仅供完成认证的 HTTP/stdio adapter 注入身份引用；逐操作从同一身份源重读 principal，请求结束、迟到异步工作或关闭后不可沿用 |
| `await createConnectorRuntime(options)` | 复用实际出站认证 transport，每个 epoch 建立独立 Wire 与 `LuvusRpcAdapter.dispatch(raw, signal)`，保留原始请求帧；长期 claims/custody 在显式角色关闭后释放 |
| `createConnectorAdmissionBackend(options)` | 在认证连接及本机固定路由下暂存候选，原 Wire 全部校验通过后才提交有界本机请求锚点；不打开 Gateway writer、不制造 permit |

HTTP MCP 由认证 adapter 建立 caller，不能把旧 stdio UID/GID、MCP session ID、设备凭据或
请求 JSON 当成远程身份。管理员认证仍使用独立 session/权限，runtime 不授予管理身份。
Gateway 是常驻宿主，客户端断开或前端等待结束不调用 `close` 或 `cancel`；终止服务由所属
进程的显式生命周期控制。模块不写 stdout；唯一入口决定 HTTP 常驻和日志通道。

Gateway 准入仅 `created=true` 才调用真实 transport 派发；重复 key 只返回原元数据，不重新
发送或延长期限。登记提交后派发失败仍返回同一调用的当前账本元数据，便于无 key 的调用对账；
锚点前未发送与锚点后 unknown 保留 Store 实际状态，不隐式重试。返回前仍重新核对当前身份及
read 权限，撤权后不返回新旧调用 ID。`get/cancel` 始终不含原文。`results.open/read` 每次通过当前归属、双端 ACL、
原请求 Wire 的读取/保留门禁及 Store 固定期限；缺原 Wire 时不从数据库重建许可。
响应保留在同步提交栈内按原持久 caller 的当前权限评估，不使用最近 HTTP caller；普通交付
仍要求当前请求作用域。显式 cancel 复用现有 Wire 取消，不宣称 native 回滚；断线不重放。

本机 provider 配置须与已注册 canonical binding 一致，工厂不隐式注册、重绑或扩大权限。
当前每个 runtime provider 配置固定完整 session Target；同一连接的本机策略使用同一全局修订，
每项查询只贡献该完整 Target 的 grants。相同 contract_ref 的完整 capabilities/修订或编译身份
冲突在启动时拒绝，不能让另一实例的记录后写覆盖。管理提交后仍须重新配置/发现失效的实例。

`changed(machine)` 必须交给同一 Gateway 的正常断连，只在凭据交付被拒绝并提交后调用。开启失败与显式关闭
均尝试清理所属资源；`close()` 与 `closed` 使用相同完成结果，释放失败保持失败。

### 单 provider 来源失效

生产 CLI 在原 RPC offer 中启用可选 `provider_fence`。宿主的 `Session.fenceProvider(binding)`
同步核对并永久撤回本 epoch 的原完整绑定；`providerFences()` 只返回这些原配置，不提供来源或执行许可。
组合会话在此模式下让每个原 owner 只管理一个 provider；Gateway 为各原 Luvus 实例建立独立
生命周期 adapter，Herdr 沿用自己的原 owner。缺少同步端口时拒绝协商，不回退为模拟成功。

单个来源失效、readiness 丢失或快照变化会关闭对应原 adapter/owner、原远端 pin 和读取上下文，
通知同一认证通道的对端撤回相同完整绑定，并将该来源未确定完成的在途调用按原 Store 事务记为
unknown。健康 provider 保留同一连接与 epoch，原 pending 调用和后续调用继续经过原 Wire 门禁。
设备撤销、认证错误、全局策略冲突、资源超限、原 owner 清理失败及断线仍按原通道规则处理；
未确认回收不能作为新上下文的可用预算。未启用此扩展的宿主
沿用原会话关闭行为。

本 epoch 的撤回不可逆，底层恢复不重新接纳旧来源。显式新配置/认证可建立新 epoch 的原来源，
旧 binding、结果许可或 unknown 调用不会迁移、重放或补造成功。迟到失败来源的普通 RPC 只作
有界丢弃，保留认证 envelope 与完整绑定核对；详细限制见 [Wire 协议](protocol/WIRE-PROTOCOL.md#可选逐-provider-来源撤回)。
不增加原生事件或终端流隔离。

混合 Connector 中，Herdr 的既有端点阻止启动时，原工厂在取得 child/owner/writer 前只交付
`ProviderUnavailableError` 的原受保护配置。混合宿主将该配置作为不可用声明交给原组合会话，
不创建替代 adapter、native 来源或执行后端；必须协商 `provider_fence`，随后由原通道明确撤回，
健康 Luvus owner 保留。未知启动错误或未确认清理仍失败并回收已交付资源。既有 socket 无论
存活、拒连或归属未知均不删除、接管或自动重启；底层端点恢复也不复活本 epoch 的不可用声明。

### 明确受限的原生开发来源

`startDevelopmentLuvus(config, { acknowledge_nonproduction: true, token_ttl_s, scopes })`仅支持
固定官方 Luvus 0.14.3 Linux x64 IPC，要求 state/cwd 空白、HOME 仅含四个空白私有 XDG 目录。
这是显式本机隔离启动操作；正常角色工厂不会自动启动原生实例。它独占本轮目录标记，以固定
binary/root/session、最小环境和固定 argv 启动直接 child，持有 pidfd，反复核对 `/proc`
启动时钟、exe/inode、argv/env/cwd、路径身份及 socket。每个实际 socket 用内核 SO_PEERCRED
核对这个仍受控的 child，JSON PID、同 uid、随机 actor 或复制的 evidence 都不是证明。

私有 bootstrap 只在同一受控 peer 上签发最多五分钟的 `read` 或显式 `read + orchestration`
token，再以该 token 读取实际能力并确认实例空白。秘密仅驻留专用内存，不进入 Store、普通
响应、日志或参数；每个实际准入 binding 延迟取得 `LuvusBoundDelegation`，所有 epoch 沿用
原签发/到期时刻，不刷新 token。关闭移除内存秘密并仅向本轮 child 的 pidfd 请求终止，不自动
删除状态；信号失败或等待截止不等于物理退出，须保留拥有标记并准确报告清理未完成。
`createDevelopmentLuvusProvider`只为 `automation.list`、`task.add`、`task.update`提供固定手工
审核的普通 RPC 分类；仍须 caller/local grants、原生权限及原 Wire 许可，不开放 raw、Host、
终端、token 方法或秘密结果。其它能力缺分类继续拒绝。

外部 supervisor 的 opaque 实例交付和真实用户持久凭据仍须独立受信配置与动作级批准；
受控自有 child 与有限 custody 的实际接口见下节，开发来源不能冒充生产安装。
Herdr 不使用这套 Luvus 来源。

### 受控持久 Luvus 来源

`initializeManagedLuvusRoot`只在显式调用时登记空白自有 root，核对固定官方 Luvus 0.14.3
Linux x64 安装与私有目录，持久记录完整配置、目录身份和独立 custody 上限。
`openManagedLuvusRoot`只重开同一记录与目录身份；不读取业务正文、不认领用户已有实例。
`startManagedLuvus`持有排他 owner 锁，直接创建固定 child/pidfd，并核对实际 socket peer、
安装契约和原生 generation；启动不发行 token。未确认退出不释放 owner 锁。

`issueRestricted`只在独立 native-custody 授权和精确一次批准后签发至多五分钟的有限内存
委托。批准文件绑定 root/revision、配置摘要、真实 generation、scope、方法和 TTL；消费墓碑
先持久提交，再发送一次原生发行请求，失败不重放。普通管理权限与 `providers_manage`
不能代替此授权。所有 epoch 沿用原 issued/expires，custody 关闭只清除内存秘密；process
关闭才请求停止自有 child，不把忘记秘密声称为原生撤销。

批准 writer 在返回可信时间前同步保存持久高水位，close/reopen 不归零；已观察过期的批准
不能因时钟回拨恢复。私有 clock 记录与固定 inode 锚绑定同一 root/config，更新的 pending
标记在完整落盘核验后才移除；缺失、替换、损坏或未完成提交均拒绝，不自动重建或接管。
正常 close 只移除本轮仍匹配的锁。目录须为规范绝对路径，拒绝 `.`、相对路径和折叠别名。

`createManagedLuvusProvider`只接受真实 opaque custody，复用开发来源同一份三项已审普通
RPC 分类，使用独立契约修订。它不增加方法、scope、raw、Host、终端或秘密结果权限。
Herdr 的来源、协议、分类与凭据仍由其 provider 实现分别交付。

### Connector 本机去重

Gateway 在 Store 派发事务提交（持久 `dispatching`）后才发送 `request`，没有额外的“回执”或上下文帧。
Connector 用内存 attempt book（受保护配置固定的本机保留期，默认 30 天，必须覆盖请求 deadline）记录
`call_id:attempt_id` 与请求摘要，并以持久 claims 阻止同一 attempt 在任何 epoch、重启后再次写入原生。
principal 来自受保护的单一固定本机路由，不读取 Gateway Store，也不保存请求正文或制造执行许可。
跨 epoch 共享 book 与持久唯一 claims，断连不清墓碑、不续期或重放工作。

### 管理会话与 provider 接缝

`createManagementSessionAuthority`复用同一身份服务认可的既有管理员及原 session ref。
显式 bootstrap 只建立至多五分钟的 cookie/CSRF 查询绑定，不创建账户、角色、身份数据库或
长期凭据；同一宿主内 ref 的首次截止不滑动，重启使全部旧 cookie 失效。秘密只交给本次受信 bootstrap 调用者，宿主负责实际
用户认证、cookie 属性和专用交付。没有既有有效管理员来源则拒绝。
`bootstrap(lease, { signal, rotate: false })` 用于受保护页面的至多一次交付：已有引用立即拒绝，
不旋转或撤销原秘密；提交前检查取消及来源回调重入。省略该选项的显式本机动作保持原旋转语义。
生产页面交付和浏览器内存回调见[管理会话客户端](MANAGEMENT-SESSION-CLIENT.md)。

其 `sessions.identities`与返回的 `identities`为同一对象；Gateway 和管理读写服务使用该对象，
管理 HTTP 使用现有 `createManagementSessionAdapter`消费 `sessions`。查询和 writer 的
`administrator`均复验当前来源、固定期限和撤销；MCP caller、设备凭据或 session id 不升级
成管理身份。独立本机 custody 审批还须当前管理作用域与精确 native-custody grant。

`createProviderConnectorRuntime`只管理通用认证通道和角色寿命，provider 自行交付已有
`ConnectorWireSession`的 adapter、执行、readiness 与关闭资源；不选择原生协议或凭据。
现有 `createConnectorRuntime`保留 Luvus IPC 的专用装配边界，Herdr 不借此伪装 UHP。

通用 Connector 的 `close/closed`使用同一逻辑结果，默认至多等待 release 五秒；受保护配置
`release_timeout_ms`仅可在 1..5000ms 内收紧。超时返回 `connector_runtime_close_timeout`，
不取消或重试原 release，不宣称物理资源已释放。`releaseSettled`和 `releaseStatus()`继续
观察原回调；pending/failed 保留所交付 owner 引用，晚成功只更新独立观察，不改判关闭结果。
启动失败的 `ConnectorHostStartupError.shutdown`保留同一关闭与所有者观察入口，调用者须
保留它直到实际释放确认；`owner_held`仅表示本宿主保留引用，不证明内核退出状态。

### Herdr 资源工厂

`createHerdrGatewayResources`提供中性 Gateway 所需的 `providers/session/catalog/describe/release`。
其 session 消费现有已认证 `connection/channel`及 `GatewayProviderServices`，以
`persistentHerdrBackend(services.store, ...)`复用唯一 Store 的原 caller、完整 Target、契约、
响应/内容锚点和固定期限。Gateway 来源仅代表已认证 Connector 通道，不冒充本机 Herdr 安装。

`createHerdrConnectorResources`要求宿主交付真实 `HerdrInstallation`、时钟、当前 policies 与
`releaseOwner`，返回给 `createProviderConnectorRuntime`的 session。
Connector 使用内存 attempt book 和原持久 claims，不打开 Gateway writer。
正常重启以 `open`重开同一账本；`create`仅用于显式首次初始化。

单个 session 关闭只撤销其 adapter/准入后端/桥接等待；长期 claims 与 child 归资源 owner。
资源 release 先关闭全部 epoch，再关闭 writers 和 installation，最后只调用一次 `releaseOwner`。
安装关闭不证明 child 已退出，原 owner 须停止并等待自己持有的进程；Gateway release 不关闭外部 Store。
所有 provider 仍共享 Store 的正文与句柄总预算。Herdr 当前单条原生 JSON LF 上限 65536 字节，
不使用对象/流分片；超限、schema 错误和未知结果不能变成成功或自动重放。目录逐方法公开 request/response 的完整 UTF-8 JSON 加 LF 帧预算、无响应分页和无对象传输。固定官方 schema 的 snapshot/list 没有分页参数；`pane.read/agent.read`的 `lines`只取末尾行、最多 1000 行，不能限制字节，也没有 continuation cursor。不能把 Store 对已收到结果的分页当作原生响应分页。

唯一 CLI/HTTP MCP 装配须增加 provider 工厂与目录分支，保留当前 Luvus 接口和管理宿主。
原生副作用和 Agent 状态保持原义，桥接取消不等于 native cancel，同会话多轮回答另行验收。

### 生产来源边界

当前提供受控 Linux Luvus child 来源与显式有限 custody；外部 supervisor
的实例交付及跨进程原生来源证明仍未提供。已有端口的来源责任如下：

| 已有消费端口 | 受信来源责任 |
|---|---|
| `RuntimeProvider.source/ready/contract`、session 的 `verifyPeer/assertEvidence` | 固定 binary/schema、root/session 和启动配置的受控实例生命周期，以及实际每条 IPC socket 的 peer；退出、路径替换或 generation 变化使来源失效 |
| session 的 `delegation`、`LuvusBoundDelegation` | 专用 custody 交付的受限 token 与原始签发记录，绑定完整 config/native generation、方法、scope、issued/expires；调用 JSON 不能自报权限，不回退 Owner，不在重连时刷新 |
| `ConnectorAttemptBookOptions.retention_ms`、session 的 `dedupExpires` | Connector 受保护配置固定的本机保留期，必须覆盖请求执行 deadline；首次登记后固定，重连与读取都不刷新 |
| `GatewayRuntimeOptions.identities`、`runAuthenticated` | 唯一 HTTP 认证 adapter 交付受保护身份引用，逐操作重查当前 principal；设备凭据、管理员 session 和 MCP caller 分别保留各自来源 |

opaque 实例不能经 JSON 序列化成为跨进程归属证明。OS 服务的 `running` 状态、发行文件
校验和设备认证均不能单独证明原生实例。来源缺失或失效保持拒绝；未确认退出仍保留拥有
状态。真实持久凭据的创建、轮换或原生撤销属于独立授权操作，角色工厂不隐含执行。

`test/runtime`覆盖隔离 Store、实际认证连接、唯一派发、原 Wire 结果、关闭重入、迟到请求作用域、
能力冲突及开发来源拒绝。自建 native listener 的回归与官方 binary 的隔离运行是不同证据。
正式公开 CLI 的 GatewayHTTP + Connector 产品 smoke、用户身份配置、远端双机、OpenCode
客户端及外部 supervisor 仍须各自验收；模块 build 或 help/version 不代替产品运行。

## 通道与可信宿主

`createGateway` 监听普通WS `/connector`，`createConnector`主动出站到WS/WSS origin。
本机或可信网络使用HTTP/WS；公网TLS由外部标准HTTPS/WSS反向代理终止。
Connector WSS使用系统信任并强制`rejectUnauthorized: true`及hostname验证，不接受CA覆盖或跳过验证。
不接受URL用户信息、查询或fragment；设备listener拒绝浏览器Origin和其它路径。
本模块不安装系统信任、不创建证书，也不配置反向代理。用户参数见[配置参考](CONFIGURATION-zh.md)。

宿主分别注入设备 `IdentityHost`、当前 caller principal、双端固定 binding / policy、
契约、原生来源和 native adapter。设备自报名称、connector_instance_id、JSON 或 welcome
都不能建立这些事实。Gateway session 应由 `persistentBackend` 接到 Store；生产模块没有
测试授权工厂。fixture 仅位于 test 中，其来源、策略、管理员和 delegated token 均无生产效力。

状态依次为连接中、已认证、provider ready。设备认证后才分配 epoch；ready 逐 provider 核对
双端 binding（含 enabled/revision/config_ref）、策略 revision 与宿主原生健康。一个实例不 ready
不阻止其它实例。`status()` 只返回有界状态和 ID，不返回凭据、请求或原生内容。
宿主须独立保证对端配置来源，不能把设备广告转换成 readiness 中的 trusted 本地配置。

## 可信只读观测

`gateway.observations` 实现 `GatewayTransportObservationSource`，只有无参数的同步
`snapshot()`，类型见 [observation.ts](../src/transport/observation.ts)。宿主可将它独立注入
管理快照提供方；本接口不增加管理权限、HTTP listener 或 MCP 接线，不能直接交给浏览器作为授权。

快照包含可信 Store 毫秒时钟的 `observed_at`、当前 `recovery_generation`、本 listener 的
`transport` 可用性和实际认证 peer 的 `devices`。只核验当前 live socket、身份租期、ChannelRegistry
绑定和 Store fence；持久化 `online` 不构成本 Gateway 的实时来源。连接只提供有证据的
`online`，认证只提供 `authenticated`，缺少或失效的来源保持 `unverified`；不推断
`offline/reconnecting/revoked/auth_failed`。正常关闭后条目消失，消费者须将缺项保留为未知。

`connection_epoch_ref` 是每次实际认证生成的独立随机引用，fresh epoch 必须更换，不能用于
Store、管理确认或派发 fence，也不暴露原始 epoch。`last_heartbeat_at` 初始为 `null`，仅在
合法 heartbeat 完成消息去重及序号检查后记录本机接收时间；发送心跳、业务帧、重复帧和读取
均不刷新它，不接受客户端自报时间。

provider 项包含稳定 ID、当前 `binding_revision` 和 `dispatch_ready`；后者只说明既有 Gateway
派发门禁，核对当前 canonical binding、双端配置/策略、宿主 readiness 与 Wire 可用性。
`false` 不表示原生不可达，`true` 也不是原生 runtime、binary/schema 摘要、contract 或支持传输
的独立证明。这些字段以及 native 组件继续由各自可信来源提供，缺来源不得补 verified。
所有宿主回调完成后再次统一核对连接和 canonical binding，较晚设备回调使较早设备失效时
不能留下旧 ready。Store 降级、隔离、代次变化或可信时钟异常使本次读取固定报
`transport_observation_unavailable`，管理层可映射为 `backend_unavailable`，不得沿用旧成功。

返回值递归冻结且不持有凭据、请求、原生内容或宿主异常原文；不维护历史表、订阅或新 timer，
按现有连接额度和每连接最多 64 个 provider 有界取样。读取不调用断连/撤销/轮换或原生执行；
既有 Store 时钟和 fence 校验仍维护持久时间高水位。消费者每次请求重新取样，按管理契约执行
过期和权限过滤；历史快照副本不能继续作为当前权威，也不能转换为可执行许可。

## 配对、凭据与管理

设备凭据的摘要保存在 Store 的 `machines` 行内，和设备状态、连接 epoch 同库同事务；不存在第二个
身份数据库、跨库顺序或一次性证明对象。

- **配对**：管理确认后签发一次性 enrollment。`Store.redeem(token)` 在一个事务内消费 enrollment、
  生成凭据、保存其 SHA-256 摘要并递增 `credential_revision`；原文只返回给专用 custody。
- **认证**：`createDeviceLifecycle(store).identityHost.authenticate(machine, generation, credential)`
  校验凭据格式与恢复代次后调用 `Store.connect`，同一事务核对摘要、拒绝 revoked/待确认/重复在线设备，
  并分配 fresh `connection_epoch` 与审计。凭据不过期，直到撤销或重配（轮换见 S6 issue）。
- **持续核对**：`assert(identity, lease)` 每次核对当前代次、在线状态、epoch 与该 socket 认证时的
  凭据摘要；撤销、重配或旧 epoch 立即失效。`Store.connect`/`assertConnection` 不写时钟，读路径只与
  内存高水位比较。
- **撤销**：`Store.revoke` 单事务清除凭据、epoch、enrollment，收敛调用并使上下文失效；宿主随后断开通道。
- **同 ID 重配**：`Store.resetDeviceEnrollment(machine, generation, expectedEpoch)` 在一个事务内核对
  管理确认（action `device_enrollment_reset`，fence 为
  `boundedJson({recovery_generation, connection_epoch})`）、停止调用、清除凭据与 enrollment，设备回到
  `pending`。提交后宿主关闭该设备全部旧 socket（`DeviceLifecycleWiring.reset` 会这样做）；事务失败则整体回滚。
- **交付失败**：`Store.denyDelivery(machine, digest)` 仅当摘要匹配当前凭据时清除它、断开在线 epoch 并把
  设备置为 `pending` 且要求确认，之后只能经确认的重新配对恢复。

`ChannelRegistry` 为具体 socket 分配独立 `SocketChannel`。Gateway 只在认证成功后绑定该 socket 的
epoch，再创建/注册 session，之后才发布 routing/ready。`createDeviceLifecycleAdapter` 复用
persistentBackend，每次 connection 和 nativeSource 解析前后都复验所属 socket 与 Store 当前 fence，
原生来源的 machine/恢复代次/epoch 必须匹配。旧 backend 不因同设备新 socket 上线而复活。通道关闭显式
调用 adapter.close，销毁执行/仅响应/去重上下文，取消 Store 提交后失效订阅与维护 timer，再关闭宿主资源。
正常 Store COMMIT 的 device_fence 通知仍独立按设备作用域回收。

结果访问层前后两次取得原上下文时，解析仅核对当前 caller ACL、认证 peer、Store 锚点、实际内容期限及原
Wire 是否关闭；带正文的完整 Wire 门禁仍在本轮策略回调前后各执行一次。解析引用不授予读取权，不跨轮缓存
权限、时钟或正文；末次授权后仍由 Store 新读实际页，第二连接删除句柄和跨期必须生效。

`createPairingDelivery` 将 Store 原子兑换和独立 `CredentialSink` 串起：仅向受信专用 sink 交付 secret，
普通返回只有 machine/delivery ID 与 delivered 状态。渠道授权先于消费。sink 只可在收到专用 custody 完成确认后
resolve，确认须精确回显 delivery ID、machine、恢复代次及 credential revision。每次交付有超时、
AbortSignal 和并发上限；失败按精确凭据摘要调用 `denyDelivery`。交付前固定内部摘要与确认轴，只向 sink 传副本，
sink 清理入参不能改变拒绝依据或确认目标。忽略关闭的发送仍占额度直到真正结束。不自动重发、不重置 enrollment
消费；丢交付须新的独立授权同 ID 重配。Wire 没有专用凭据交付响应，listener 继续拒绝 enroll，不将秘密放入 welcome。

## 派发、响应与关闭

### 原始 Wire 执行接缝

处理完整 Wire request 的本机 adapter 使用 `WireConnectorOptions`，其 `session(connection)`
返回 `ConnectorWireSession`。公开类型为：

```ts
type WireExecutionResult = Readonly<{ binding: AttemptBinding; native_response: JsonObject }>
type ConnectorWireSession = Session & {
  /** 接收当前 socket 已验证的原始 Wire 文本，不剥字段、重编码或在 transport 注入原生 auth。 */
  executeWire(rawWireRequest: string, signal: AbortSignal): Promise<WireExecutionResult>
}
```

Hook 仅在原 Wire adapter 解码/原生许可检查、消息与 attempt 去重、ready、deadline 和额度
通过后调用，传入收到的原字符串，保留外层空白和 message_id。它与 `nativeInput`/`execute`
在类型和运行时互斥，失败、空返回或错误 binding 均关闭该 socket，不回退或自动重试。
`native_bytes` 只用于原生 JSON 注入模式；Wire 模式的 id/auth/LF 完整原生帧预算归实际
原生 adapter 的受保护配置。transport 自身仍核对完整 Wire 单帧、对象和在途额度。

对 Luvus 的宿主接线如下；配置、services、readiness 和 host 均须来自独立受保护来源：

```ts
/** 每个认证 epoch 新建自己的两个 Wire 状态，不能借用最近上线设备或旧连接的 adapter。 */
session(connection) {
  const backend = persistentBackend(store, trustedServices(connection))
  const rpc = new LuvusRpcAdapter(fixedConfig(connection), { ...trustedRpcHost(connection), backend })
  try {
    const adapter = createLuvusWireAdapter(backend)
    return {
      adapter,
      /** 直接交完整原帧；LuvusRpcAdapter 负责唯一一次原生 auth 与宿主 durable claim。 */
      executeWire: (raw, signal) => rpc.dispatch(raw, signal),
      /** 独立读取当前双端配置与本机健康。 */
      readiness: () => trustedReadiness(connection),
      /** transport 已先关闭自己的 Wire；此处销毁本机 RPC adapter 的 IO、私有 Wire 和订阅。 */
      close: () => rpc.close()
    }
  } catch (error) {
    rpc.close()
    throw error
  }
}
```

这不是另一个导出工厂。`claimDispatch` 必须独立持久、原子、唯一地登记原 attempt 并复验
权限/epoch/generation/deadline；再次 `Store.dispatch` 或收到 accepted 均不能代替 claim。
本机 `RpcResult` 保留原生响应，Connector 复验完整返回 binding，再用自己持有原请求的
Wire 编码；Gateway 只用其原请求 Wire 调用 `commitLuvusResponse`，提交后才发布 responded。

### 响应与原始读取

响应必须放入单个 Wire 帧；超过 transport 单帧限制的响应不分片，Connector 写出时以预算错误失败，Gateway 只保留 unknown 元数据。Connector 在写出前用原 Wire 复验响应及当前 read，宿主 hook 的等待不能延长旧读取授权；COMMIT 失败不能报告 responded。

受保护宿主通过 `gateway.resolveOriginalRead(callId)` 取得
`{ binding, wire } | undefined`：binding 是副本，wire 是仍持有该原请求的实际 Gateway
adapter。每次解析都核对宿主当前 caller、原归属、读取 grant、来源、设备与 binding fence；
每页实际读取前仍须调用 `wire.checkResult(binding)`，不能把已取得引用当作后续永久授权。
结果层创建持久句柄之前必须调用 `wire.checkResultRetention(binding, nativeFrame): void`：
它核对同一活原请求及精确响应，复用原 permit，要求派发时和当前分类都允许保留，且仍须当前
读取授权及秘密通道。单纯 `checkResult` 可读不能代替该保留门禁；禁存内容不因当前分类放宽复活。
本保留 port 仅支持普通 RPC，流及控制 ack 一律拒绝，不能借开流 permit 为控制输入创建持久句柄。
该 port 不提供公开工具、内容分页、磁盘结果或新的 validator/permit 工厂，结果层继续复用
Store 的 `saveResult/readResult` 和当前读取门禁。

Gateway 默认在完成后释放原请求上下文；尚在途的实际 Wire 可直接解析。需要完成后的分页读取
时，受保护宿主须显式设置 `retainOriginalRead: true`，按预算有界保留完成调用的原状态。
`read_contexts` 默认 128，可显式收紧或配置至 Wire 去重容量上限；满额在新派发事务之前拒绝，
不提前驱逐有效上下文。关闭、
旧 epoch、原请求已释放、discard、TTL 或当前读取拒绝时 resolver 返回 undefined。
宿主显式 `wire.release(binding)` 后，后续派发会回收该读取额度；当前 caller 或 grant 被拒绝
只影响本次读取，不驱逐仍有效的所有者上下文。
内容清理不会由读取恢复原文；在途调用的原 Wire 仍按既有规则保留最小仅响应补证状态。
这个接缝不代表 MCP facade、生产 peer/auth/claim、普通大结果分页或真实多机已验收。

Gateway `dispatch(call_id)` 从宿主当前 principal 经 Router 重授权，Store 事务返回 binding 后
才编码和发送。Connector 以独立宿主账本与原生来源校验 request，不从消息构造 attempt。
原生 JSON 执行模式的 auth 由宿主 `nativeInput` 注入；它只能添加 auth，完整注入后 JSON 再按原生帧预算计量，
成功才发 accepted 并调用宿主 execute。响应通过原 adapter 和 `commitLuvusResponse` 事务提交，
提交前不发布 durable responded。accepted 不等于原生完成。

`gateway.cancel(call_id): Call` 只从同一可信宿主取得当前 principal，复用 `Router.cancel`
逐次复验归属及当前双端 cancel 权限，先提交持久停止，再向原活 socket 的精确
machine/generation/epoch/call/attempt/native ID 发送既有 Wire cancel。无需额外 read 权限；
返回值是去掉响应正文的宿主内部调用元数据，须按公共 DTO 投影，不能直接作为工具回复。
未派发调用为 `not_dispatched`，可能已送达的调用
仍为 `outcome_unknown`；没有取消 ack，成功写出也不能投影为 `bridge_stopped` 或
`native_confirmed`。MCP/CLI 宿主只在显式 call_cancel 操作调用此端口，前端 wait_signal
仅结束等待，不能自动转成执行取消。

取消提交失败不发送。提交后先释放 Gateway 本地等待并消费一次发送机会；重复取消、
缺原上下文、关闭、旧 epoch 或发送失败均不重发、不排队，也不回滚已提交的状态。
原 Wire 响应约束仍受既有容量和固定保留期限限制；取消不主动销毁迟到补证能力。
取消后在途 accepted 不复活状态或误关共享通道；合法同 attempt 响应仍须协商
`late_evidence`，经原 `commitLuvusResponse` 事务补证，保留取消历史及原 deadline/TTL。

Connector 复用原 Wire 的方向、完整 binding、当前双端 cancel 权限及消息去重，再只中止
同一运行 attempt 的 AbortController。已有 `executeWire` hook 把该 signal 传给实际
`LuvusRpcAdapter.dispatch`，沿用其本地等待中止路径，不另建取消执行器。取消后的拒绝不关闭
其它调用或设备；忽略 signal 的工作仍占 Connector 原生并发额度，实际 Promise 结束后才释放。

模块可直接组合既有服务 backend：Gateway 接 call_id 与宿主 current principal；Connector
execute 接完整原生 JSON、AbortSignal 和独立账本固定的 AttemptBinding，宿主据此选择固定
provider adapter，不能从原生 JSON 的路径/endpoint 或自报 provider 选择执行来源。本模块没有
第二套 CLI。首版 Luvus 只编译宿主已审核的本地安装 schema；Bun Worker 完整编译并生成
standalone，以 2 秒逻辑接纳期限、取消及迟到拒绝控制初始化，宿主同步执行已接纳的生成函数。
这不提供硬 heap 上限或 Worker 在指定时刻物理退出的保证，详见
[编译接纳边界](protocol/NATIVE-CONTRACT.md#编译-worker-与生成物接纳)。连接 ready 或 fixture
编译成功仍不能替代生产宿主所需的来源、分类与执行授权。

当前业务范围为普通 RPC、逐调用观察取消及已协商响应对象。流、请求对象和 schema 分发尚未
接到原生执行，不得广告为这些能力已可用。
每次实际执行前检查 deadline；观察取消/关闭通过 AbortSignal 通知宿主，**不代表原生回滚**。
宿主 execute 必须有界并响应观察关闭，忽略 AbortSignal 的工作仍占并发预算直至完成。
provider 不可用时停止其响应交付/观察，设备撤销或断线关闭全部 session 资源。

断线后原 epoch 的在途调用由 Store 保守记 outcome_unknown。抖动指数退避只重建通道，
不排队或重放任何 request，也不跨 runtime failover。新连接使用稳定设备 ID 和新 epoch。
旧 epoch、恢复代次、binding/policy fence 或缺少原生 handle 的响应拒绝。同一 adapter 的有界
仅响应上下文可配合 Store 原锚点提交 metadata-only 晚到证据，仍要求独立当前原生来源及契约；
宿主失去这些来源时拒绝，不能把 Store 请求字段当来源。重启丢失内存 handle 后保持拒绝，
不从 JSON/hash 补造上下文或执行许可。

## 资源与验证边界

默认 Gateway 同时 64 条连接、8 条未认证连接、每分钟 120 次认证、每秒每连接 256 条消息、
128 条全局在途请求；Connector 同时 8 个原生执行。每帧与完整原生 JSON 默认上限 1 MiB。
握手 5 秒、心跳 5 秒、无有效心跳 20 秒关闭；有界单个维护 timer 覆盖失效与清理。
发送不建立重连队列；单帧背压或超限直接关闭，响应对象只在固定传输期限内等待 socket 空间。
已经提交派发锚点的失败调用保持 unknown。接收窗口满拒绝、不提前淘汰；同一 attempt 不执行
两次。Connector 释放完成的 transport 执行上下文，Gateway 按上节有界保留原请求读取上下文。
一个 Connector epoch 最多记录 4096 个已接收 attempt，达到上限后关闭并经退避重连。
所有重连都不迁入旧工作。宿主 stop 必须停止 timer、listener、session 和观察资源。

`bun run test` 自动发现 test/transport；它使用两个本地模拟 Connector、临时 SQLite/凭据目录、
普通WS和合成原生来源。Wire 接缝另组合实际 LuvusRpcAdapter、临时唯一
claim 库和自建 Unix listener，验证原始帧、原生错误、超限响应、读取失效与提交故障。TLS负例在独立loopback HTTPS listener验证系统信任拒绝自签证书，旧CA/关闭验证输入不能绕过；
合成证书仅使用Linux `/usr/bin/openssl`生成，不导入系统信任。
RPC 的 seen 上限独立于 transport；标准回归收紧至 2 验证满额及 fresh epoch，新意图不可自动重放。
默认 128 的扩展回归使用同一真实 adapter/IPC harness，执行 128 次成功、第 129 次拒绝及第 130 个新意图：

```sh
bun --no-env-file -e 'import { verifyRpcCapacity } from "./test/transport/wire-capacity-helpers.ts"; await verifyRpcCapacity(128)'
```

日志负例用 stdin 交付随机 mock secret，并扫描子进程 stdout/stderr、普通审计和业务帧。
真实组合测试（`test/transport/real-lifecycle.test.ts`）使用磁盘 Store、实际 WSS socket 和真实 adapter，覆盖 WS、
精确重配/同 ID、撤销、提交失败回滚、重启、epoch 不重放及 adapter 关闭后释放监听容量；Store/Wire 核心协议没有
增加 transport 表或私有 SQL。
完整工具链门禁见 [开发指引](DEVELOPMENT.md)。这些证据不构成实际远端多机、生产身份服务、
跨平台凭据存储、MCP facade 或发布验收。
