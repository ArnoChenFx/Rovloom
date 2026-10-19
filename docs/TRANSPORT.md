# Gateway / Connector 通道接线

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
| `openGatewayState(options)` | 在既有私有目录打开唯一 Store、唯一 hash-only 身份库及一次性证明桥；返回同一 ChannelRegistry 和受信凭据管理端口，不自动注册、兑换或签发 |
| `await createGatewayRuntime(options)` | 组合一个 Router、实际设备 listener、每 socket Wire、可信请求作用域和 `createLuvusResultAccess`；返回 `transport`、`closed/close`、`admit/get/cancel/results` |
| `runAuthenticated(caller, operation)` | 仅供完成认证的 HTTP/stdio adapter 注入身份引用；逐操作从同一身份源重读 principal，请求结束、迟到异步工作或关闭后不可沿用 |
| `await createConnectorRuntime(options)` | 复用实际出站认证 transport，每个 epoch 建立独立 Wire 与 `LuvusRpcAdapter.dispatch(raw, signal)`，保留原始请求帧；长期 claims/custody 在显式角色关闭后释放 |
| `createConnectorAdmissionBackend(options)` | 在认证连接及本机固定路由下暂存候选，原 Wire 全部校验通过后才提交有界本机请求锚点；不打开 Gateway writer、不制造 permit |

HTTP MCP 由认证 adapter 建立 caller，不能把旧 stdio UID/GID、MCP session ID、设备凭据或
请求 JSON 当成远程身份。管理员认证仍使用独立 session/权限，runtime 不授予管理身份。
Gateway 是常驻宿主，客户端断开或前端等待结束不调用 `close` 或 `cancel`；终止服务由所属
进程的显式生命周期控制。模块不写 stdout；唯一入口决定 HTTP 常驻和日志通道。

Gateway 准入仅 `created=true` 才调用真实 transport 派发；重复 key 只返回原元数据，不重新
发送或延长期限。登记提交后派发失败仍返回同一调用的当前账本元数据，便于无 history 的调用对账；
锚点前未发送与锚点后 unknown 保留 Store 实际状态，不隐式重试。返回前仍重新核对当前身份及
read 权限，撤权后不返回新旧调用 ID。`get/cancel` 始终不含原文。`results.open/read` 每次通过当前归属、双端 ACL、
原请求 Wire 的读取/保留门禁及 Store 固定期限；缺原 Wire 时不从数据库重建许可。
响应保留在同步提交栈内按原持久 caller 的当前权限评估，不使用最近 HTTP caller；普通交付
仍要求当前请求作用域。显式 cancel 复用现有 Wire 取消，不宣称 native 回滚；断线不重放。

本机 provider 配置须与已注册 canonical binding 一致，工厂不隐式注册、重绑或扩大权限。
当前每个 runtime provider 配置固定完整 session Target；同一连接的本机策略使用同一全局修订，
每项查询只贡献该完整 Target 的 grants。相同 contract_ref 的完整 capabilities/修订或编译身份
冲突在启动时拒绝，不能让另一实例的记录后写覆盖。管理提交后仍须重新配置/发现失效的实例。

身份库从总安全、审计和磁盘预算保守预留独立份额，实际目录字节仍计入 Store 总量。
身份安装/轮换需要宿主独立的动作级确认。`changed(machine)` 必须交给同一 Gateway 的正常
断连；prepare 使用共享 ChannelRegistry 仅同步封锁通道，不重入 Store。开启失败与显式关闭
均尝试清理所属资源；`close()` 与 `closed` 使用相同完成结果，释放失败保持失败。

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

### 受信原截止交付

Wire 可选能力 `admission_receipt`由 Gateway 在原派发事务提交后、原请求之前交付完整
binding、规范请求摘要和 Store 原 dedup 截止。Connector 经实际认证连接及原 codec 校验后
才产生一次性 opaque 交付证明，`ConnectorAdmissionReceipts`将其独立持久保存；不读取
Gateway Store，也不保存请求正文或制造执行许可。缺回执、冲突、旧 epoch、摘要不符或过期
均拒绝执行。文件、锁、固定期限与时钟高水位逐次复核，崩溃标记不自动接管。

启用此能力的宿主将它列入 required，并把同一持久接收端交给 session 的 `admissions`
及 `ConnectorAdmissionOptions.receipts`，其 `dedupExpires`交给共享 book 与 claims。
默认 offer 仍仅 `rpc`。显式 `retention_ms`只证明本机首次固定期限，不代替 Gateway 原值。
旧 cutoff-only `admission_receipt` 未携带 caller principal，Connector principal 来自受保护单一固定本机路由。
协商 `admission_context` 时额外交付原 caller、Store 同式摘要和原锚点，并与该完整 Target 路由核对；
字段与提交后更新规则见 [Provider 角色](PROVIDER-RUNTIME.md)。
跨 epoch 共享 book/回执与原持久唯一 claims，断连不清墓碑，不续期或重放工作。

### 管理会话与 provider 接缝

`createManagementSessionAuthority`复用同一身份服务认可的既有管理员及原 session ref。
显式 bootstrap 只建立至多五分钟的 cookie/CSRF 查询绑定，不创建账户、角色、身份数据库或
长期凭据；同一宿主内 ref 的首次截止不滑动，重启使全部旧 cookie 失效。秘密只交给本次受信 bootstrap 调用者，宿主负责实际
用户认证、cookie 属性和专用交付。没有既有有效管理员来源则拒绝。

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

### 生产来源边界

当前提供受控 Linux Luvus child 来源、显式有限 custody 与认证原截止交付；外部 supervisor
的实例交付及跨进程原生来源证明仍未提供。已有端口的来源责任如下：

| 已有消费端口 | 受信来源责任 |
|---|---|
| `RuntimeProvider.source/ready/contract`、session 的 `verifyPeer/assertEvidence` | 固定 binary/schema、root/session 和启动配置的受控实例生命周期，以及实际每条 IPC socket 的 peer；退出、路径替换或 generation 变化使来源失效 |
| session 的 `delegation`、`LuvusBoundDelegation` | 专用 custody 交付的受限 token 与原始签发记录，绑定完整 config/native generation、方法、scope、issued/expires；调用 JSON 不能自报权限，不回退 Owner，不在重连时刷新 |
| `ConnectorAttemptBookOptions.dedupExpires`、session 的 `dedupExpires` | 唯一 Store 已提交 `responseAnchor(binding)` 的原截止；跨进程来源须独立认证并核对完整 binding、请求摘要和固定期限，本机 retention 不能代替 |
| `GatewayRuntimeOptions.identities`、`runAuthenticated` | 唯一 HTTP 认证 adapter 交付受保护身份引用，逐操作重查当前 principal；设备凭据、管理员 session 和 MCP caller 分别保留各自来源 |

opaque 实例不能经 JSON 序列化成为跨进程归属证明。OS 服务的 `running` 状态、发行文件
校验和设备认证均不能单独证明原生实例。来源缺失或失效保持拒绝；未确认退出仍保留拥有
状态。真实持久凭据的创建、轮换或原生撤销属于独立授权操作，角色工厂不隐含执行。

`test/runtime`覆盖隔离双库、实际认证连接、唯一派发、原 Wire 结果、关闭重入、迟到请求作用域、
能力冲突及开发来源拒绝。自建 native listener 的回归与官方 binary 的隔离运行是不同证据。
正式公开 CLI 的 GatewayHTTP + Connector 产品 smoke、用户身份配置、远端双机、OpenCode
客户端及外部 supervisor 仍须各自验收；模块 build 或 help/version 不代替产品运行。

## 通道与可信宿主

`createGateway` 监听 `/connector`，`createConnector` 主动出站。默认必须 WSS；
Connector 强制 `rejectUnauthorized: true`，可从受保护配置传入 CA，仍核对 hostname。
开发 WS 必须显式开启 `developmentLoopback`，且 listener / URL 使用数字 loopback 地址。
不接受 URL 用户信息、查询或 fragment；设备 listener 拒绝浏览器 Origin 和其它路径。
本模块不配置系统信任、TLS 反代或公网入口。

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

`IdentityStore` 是 Linux 专用 hash-only SQLite。`PersistentIdentity` 复用它实施凭据管理；
`PersistentProofIdentity` 与生命周期接线复用同一实例，提供 Store 事务消费的证明和 Gateway `IdentityHost`。
单 writer 锁、FULL synchronous、DELETE journal、schema/完整性检查、时间高水位、确认消费、
轮换/撤销和管理审计均持久保存；凭据原文不入 Gateway 身份库。每次认证及业务入口核对当前
租期、恢复代次和业务 Store epoch。时钟回退、提交/预算失败或原始恢复代次不符默认拒绝；
不会删崩溃锁或自动解除拒绝标记。管理操作须由宿主核实精确 action/target/revision/epoch，
一次性 confirmation 最多有效五分钟，消费记录跨重启保留至原确认期限结束。

轮换最多两份凭据，旧凭据重叠至 min(原期限, now + overlap)，重叠最多十分钟；显式结束轮换
即时使旧凭据失效。显式 takeover 绑定原 epoch、签发只交给新 custody 的新凭据，并立即废止
旧凭据；旧 Connector 或复制者不能通过自动重连抢回连接。默认凭据期限为一天，宿主可在
一毫秒至 31 天范围内明确配置，不自动续期。
同 ID 重配、撤销和 takeover 采用先提交 blocked，再完成 Store 操作并收敛的顺序；中途失败
或进程退出仍为 blocked，不自动恢复权限。重配先由 Store 核对管理确认和精确 epoch，再在
同一 writer 事务中调用同步 prepare 提交身份拒绝状态，旧管理快照不能先破坏当前连接。
prepare 先通过独立身份确认并提交 blocked，再关闭实际通道；身份确认拒绝时原 socket 与 epoch
保持可用，关闭失败时 blocked 仍持久保留。
`PersistentIdentityOptions.block(machine)` 专用于 prepare，应组合
`gateway.channels.blockAndClose(machine)`；它同步拒绝通道、销毁 adapter/订阅，再关闭 socket，
不能调用 `Store.disconnect` 或重入主 Store。`changed(machine)` 用于管理提交之后，应组合
`gateway.disconnect(machine)` 或等价正常断连，释放旧 Store epoch，让轮换后的凭据可以重连。
已配置一次性证明的 Gateway 使用生命周期接线返回的 `identityHost`，凭据管理实例不能替代
受保护证明协调器直接认证。

`createStoreIdentityFacts` 可独立组合当前 Store 的 generation、active/clock 门禁、连接 fence、
精确 epoch 断开与持久撤销，提供这些事实不代表签发认证或重配权限。
`createStoreDeviceLedger` 可组合明确注入的受信生命周期扩展，再用真实 Store 核对返回 epoch。
`createDeviceLifecycleWiring(open, identity)` 要求 `open(verify)` 将同步 verify 注入受保护的
`StoreOptions.deviceLifecycle`，并独立配置 management。返回值必须实际实现下列原子方法：

```ts
connectVerifiedDevice(machineId: string, generation: string): string
resetDeviceEnrollment(machineId: string, generation: string, expectedEpoch: string | null, prepare: () => void): void
```

连接事务须核对当前代次、offline、epoch 为 null、无需确认，并同步消费一次性证明；预算、
审计和 fresh epoch 提交后才返回。重配须先核对精确 nullable epoch 及独立管理确认：action 为
`device_enrollment_reset`，target 为 machine ID，fence 为
`boundedJson({recovery_generation: generation, connection_epoch: expectedEpoch})`。
Store 先暂存清除 enrollment/凭据/epoch 和停止调用并预检预算，再恰好一次调用同步 prepare，
最后在独立身份连接观察到匹配 blocked 后提交。Promise 或非 undefined prepare 结果均拒绝。

Store 已提供这两个受保护方法；无 deviceLifecycle 证明回调仍拒绝，较旧宿主缺任一方法时
构造报 `identity_bridge_unavailable`。没有私有 SQL、原始 credential 持久代理或占位成功。
隔离组合测试使用真实磁盘 Store、同一 IdentityStore、实际 WSS socket 和真实 adapter；
仅管理员、凭据、CA 与原生来源使用无生产效力 fixture，不声称生产身份服务或远端多机验收。

`PersistentProofIdentity` 的证明只接受私有注册表中完全相同的进程内对象，不能克隆、序列化
或跨重启恢复；每个最多五秒，最多 128 个，失败消费也销毁。消费时从同一身份库的独立只读
SQLite 连接复验已提交 revision、hash、代次、active 和固定期限；读快照显式结束事务。
独立观察也维护持久时间高水位。身份 schema 从全新 version 2 建立，旧未发布/未知版本拒绝，
不提供迁移。精确 blocked fence 与凭据、确认、审计在同一库，不复制第二份身份真相。

`ChannelRegistry` 为具体 socket 分配独立 `SocketChannel`。Gateway 只在认证提交成功后绑定
该 socket 的 epoch，再创建/注册 session，之后才发布 routing/ready。认证提交后复验本次精确
凭据 hash，不能用同时 active 的其它 hash 代替。重配 prepare 先同步提交精确身份 blocked，
再使全部旧作用域不可取身份、释放 session/订阅/adapter、关闭 socket；不重入 Store 断连。
主 Store 后续失败仍保留外部 blocked，不能提前新配对。
只有 reset 成功返回后才收敛到 pending。`createDeviceLifecycleAdapter` 复用 persistentBackend，
每次 connection 和 nativeSource 解析前后都复验所属 socket、独立身份库和 Store 当前 fence，
原生来源的 machine/恢复代次/epoch 必须匹配。旧 backend 不因同设备新 socket 上线而复活。
通道关闭显式调用 adapter.close，销毁执行/仅响应/分片/去重上下文，取消 Store 提交后失效订阅
与维护 timer，再关闭宿主资源。正常 Store COMMIT 的 device_fence 通知仍独立按设备作用域回收。
身份库默认最多 1024 设备、8192 条未到期审计、4096 个有效确认，文件/事务上限 8 MiB。
审计默认 90 天，确认按原到期时间清理；满额不提前删有效记录。构造必须注入 guard/checkBudget：
宿主须从总安全/审计子额中明确预留身份库份额，并将文件纳入 Store 全受管存储预算，不能把
独立限额当作额外免费容量。内存租期和代理原始凭据的 mock 工厂仅保留在 test/transport，生产入口不导出它们。

注册及一次性短时 enrollment 复用 Store。`createPairingDelivery` 将 Store 原子兑换、身份 hash
提交和独立 `CredentialSink` 串起；配对和轮换仅向受信专用 sink 交付 secret，普通返回只有
machine/delivery ID 与 delivered 状态。渠道授权先于消费，按 enroll/rotate 与固定身份分别核对。
sink 只可在收到专用 custody 完成确认后 resolve，确认须精确回显 delivery ID、machine、
恢复代次及 credential revision，不能把已排队当交付成功。每次交付有超时、
AbortSignal 和并发上限；失败按精确凭据 hash 核对当前及过渡租期并持久拒绝，revision 推进
不能绕过，已完全替换的旧交付清理不误封新凭据。签发提交后 changed 通知抛错也先持久拒绝
尚未返回 custody 的新凭据。交付前固定内部摘要与确认轴，只向 sink 传副本，sink 清理入参
不能改变撤销依据或确认目标。忽略关闭的发送仍占额度直到真正结束。
不自动重发、不重置 enrollment 消费。丢交付须新的独立授权同 ID 重配；跨库失败保持拒绝，
不承诺跨库原子提交。Wire 没有专用凭据交付响应，listener 继续拒绝 enroll，不将秘密放入 welcome。

Connector 从受保护启动回调读凭据，`saveCredential` / `loadCredential` 提供 Linux 专用绝对路径、
无符号链接祖先、当前用户的 0700 父目录及 0600 单链接普通文件校验。创建用独占/no-follow，
替换用同目录 fsync / rename；不自动修改现存目录权限，不支持未经验证的 Windows ACL。
只应在用户另行批准后配置真实持久凭据。正常 Connector 重启继续读同一 machine ID；
文件丢失直接拒绝，不按 hostname/name 重建或接管设备。
`createFileCredentialSink` 把经过授权的交付写入固定启动配置的受限路径；它核对预期 machine /
恢复代次、只使用一次，并在文件及父目录 fsync 完成后报告交付成功。路径不从工具输入指定。

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

### 响应对象与原始读取

超过 transport 单帧限制的响应要求双方 offer 显式协商 `objects`，否则拒绝；默认 offer
仍只含 `rpc`。现行 Wire adapter 提供 `encodeResponseObject(responseFrame, objectId)`，
返回有界只读字符串分片列表。它在原私有上下文中完整验证响应，复用 `fragmentObject`，
不暴露 CodecContext、validator 或 permit。不能用冷 adapter、持久 JSON 或 binding 重建许可。

Connector 预检每片预算，使用同一 socket 发送；每片前复核当前读取许可和原 epoch，背压
只在当前有界在途响应内等待，最多一个固定对象传输期限，不建立重连队列。Gateway 的外层
接收窗先去重，再以原 adapter `acceptChunk` 顺序重组；完整 hash/长度/原生验证通过后才
观察内层响应并执行原提交事务。分片本身不进入内层 `observeMessage`。部分传输、坏 hash、
撤权、关闭、COMMIT 失败均不能报告 responded；旧 epoch 的分片和迟到 hook 不转交给新连接。
小响应也在同步写出前用原 Wire 复验响应及当前 read；宿主 hook 的等待不能延长旧读取授权。

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
`late_evidence`，经原 `commitLuvusResponse` 事务补证，保留取消历史及原 deadline/history/TTL。

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
一日自签 mock TLS 证书和合成原生来源。Wire 接缝另组合实际 LuvusRpcAdapter、临时唯一
claim 库和自建 Unix listener，验证原始帧、原生错误、分片、读取失效与提交故障。TLS 负例在独立 loopback listener 验证未知 CA
及错误 hostname；证书生成只调用 Linux `/usr/bin/openssl`，不导入系统信任。
RPC 的 seen 上限独立于 transport；标准回归收紧至 2 验证满额及 fresh epoch，新意图不可自动重放。
默认 128 的扩展回归使用同一真实 adapter/IPC harness，执行 128 次成功、第 129 次拒绝及第 130 个新意图：

```sh
bun --no-env-file -e 'import { verifyRpcCapacity } from "./test/transport/wire-capacity-helpers.ts"; await verifyRpcCapacity(128)'
```

日志负例用 stdin 交付随机 mock secret，并扫描子进程 stdout/stderr、普通审计和业务帧。
基础生命周期单测保留明确 mock 扩展的失败窗口；真实组合测试另使用实际 Store 两个桥方法、
磁盘双库和双 Connector，覆盖 WSS、精确重配/同 ID、新凭据/撤销、主库失败后公开恢复、
旧 backend 封锁、重启、epoch 不重放及 adapter 关闭后释放监听容量。未用第二张模拟身份表替代
IdentityStore；Store/Wire 核心协议没有增加 transport 表或私有 SQL，响应对象只增加原 Wire
adapter 的受控封装入口。
完整工具链门禁见 [开发指引](DEVELOPMENT.md)。这些证据不构成实际远端多机、生产身份服务、
跨平台凭据存储、MCP facade 或发布验收。
