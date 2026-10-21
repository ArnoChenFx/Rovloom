# SQLite 运行治理

本文说明当前 Store/Router 的本机宿主接口和操作边界。系统保留默认值与安全语义以
[DESIGN §6](DESIGN.md#6-持久化与默认限额)为准，精确类型见
[Store](../src/store.ts)、[Router](../src/router.ts)与
[持久化接线](../src/integration/persistence.ts)。产品 CLI 和管理服务通过 runtime 宿主使用这些
接口；本节说明进程内存储边界，不把本机维护接口自动开放为远程 API。

## 状态库与宿主信任

Store 创建规范 schema v5，只接收全新库或同版本库，拒绝未发布的 v1/v2/v3/v4，且不修改其
源文件。现存旧库应保留在隔离目录供人工核对；不要靠重命名版本号、补默认 provider 或
导入旧 key 继续执行。不提供旧库迁移或隐式升级入口。

文件库与运行配置使用 Linux/macOS/Windows 的普通文件访问：路径须为绝对规范路径，
目录与文件类型须正确，访问权限由操作系统决定，不额外检查 UID、现存 mode 或 Windows ACL，
也不禁止普通符号链接。新建目录/文件仍请求 0700/0600，不修改已有路径的权限。
数据库的符号链接会解析到同一锁路径；数据库硬链接仍拒绝，避免同库绕过单 writer 锁。
专用状态目录内的文件与子目录计入受管存储；符号链接文件计入目标大小，不递归符号链接目录。
不要放入不相关文件。普通文件兼容性不代表各平台原生 Connector 或后台服务均已交付。

`.lock` 使用独占创建；成功关闭才释放自己的锁。异常退出留下的锁不会自动删除。
完整性检查或版本检查失败不能继续写业务。SQLite 使用 FULL synchronous、DELETE journal；
它们依赖操作系统/文件系统的持久性，不承诺抵抗管理员直接替换整机状态或失效硬件。

Store 是受信进程内接口。认证、当前双端策略、精确本地 binding、契约与分类、原生 endpoint
来源和确认记录必须独立提供；不能把模型参数、设备广告或 JSON 中的 true 当作这些事实。
`management` 回调默认不存在，provider 管理、设备撤销、审计读取、备份、降级恢复、解除隔离
和恢复设备重新配对均因此拒绝。宿主回调须核实真实管理员、独立操作权限、目标、当前 fence
和一次性真实确认；Store 在同一事务消费 confirmation_id，阻止重复使用。该回调不是管理员
身份服务的替代品。注册与普通 enrollment 签发也只能置于受保护的本机管理面。

## 设备凭据与生命周期

设备凭据的 SHA-256 摘要与设备状态、连接 epoch、`credential_revision` 同在 `machines` 行，所有变化都在
Store 的单个 writer 事务内完成，没有第二个数据库或外部确认桥。

`redeem(token)` 在一个事务内消费 enrollment、生成凭据、保存摘要并递增 `credential_revision`；
`connect(machine, credential)` 在一个事务内核对摘要、拒绝 revoked、待确认和重复在线设备，并分配 fresh
epoch 与审计；`assertConnection(connection, lease?)` 核对当前代次、在线状态、epoch 以及（可选）该
连接认证时的凭据摘要。返回 epoch 不代表 provider ready。凭据不过期，直到撤销或重配。

`resetDeviceEnrollment(machineId, recoveryGeneration, expectedEpoch): void` 供受保护的同 ID 重配使用，
`expectedEpoch` 必须为当前 epoch 或离线时的 null。独立 `management` 确认的 action 是
`device_enrollment_reset`，target 是 machineId；fence 是按 `boundedJson` 序列化的
`{ recovery_generation, connection_epoch: expectedEpoch }`，不能仅按设备名确认。事务清除旧
credential hash、enrollment 和 epoch，设备变为同 ID pending；该设备所有 providers 的未派发调用变为
not_dispatched，未完成的已派发调用收敛为 outcome_unknown，不重放旧调用。本库成功 COMMIT 后发布设备级
fence，释放该设备全部 provider、旧 epoch 的执行/仅响应上下文及尚无法归属调用的在途分片；即使没有调用行
也发布。回收通知带可信设备作用域，不清理其它设备的在途分片。缺少确认、代次或 epoch 不符、预算或最终提交
失败均整体回滚且不发布通知；宿主在成功返回后关闭该设备的实际 socket。

`denyDelivery(machine, credentialDigest)` 在凭据交付失败或结果未知时，仅当摘要匹配当前凭据才清除它、断开
在线 epoch，并把设备置为 pending 且要求确认；之后只能经确认的重新配对恢复。降级时也可执行（收紧权限）。

## 登记、派发与读取

新调用必须带完整 Wire v2 Target、expected binding revision、contract_ref、验证模式与双方
policy revision。Router 按完整 target/method/action grant 双端求交，并持续重授权读取、派发
和取消；discard_response 另需独立权限。provider 启停消耗独立管理确认并递增 revision，旧
attempt/句柄不复用。设备撤销覆盖所有 providers，且不表示原生动作已经停止。

`Router.admit(principal, target, request, options)` 使用必填的绝对毫秒 `deadline`，返回
`{ call, created }`；底层为 `Store.admitCall`。首次登记须满足 `now < deadline <= now + 600000`，
非正安全整数或与 `timeoutMs` 混用返回 invalid_deadline，首次已到期返回 deadline_exceeded。
双端当前授权、policy revision 复验、完整 provider 绑定、scope/key 摘要查询、新行和审计在同一
writer 事务内完成，预算及 COMMIT 成功后才返回 `created: true`。同范围同 key 的精确重复返回
原调用及 `created: false`，原执行期限已过或 scope 已退役也不续期；任何登记条件差异返回
request_key_conflict，未知或失效 history 继续拒绝。调用方必须仅对首次登记尝试取得派发锚点，
重复返回即使仍为 created 状态也不得重发；`created: true` 本身不是派发或原生执行许可。
Router 登记和取消统一返回 `response: null` 的元数据投影；响应原文仅由另经当前 read 授权的
get/readResult 返回，命中已完成旧调用也不能凭 dispatch/cancel 权限取得原文。
`runtime_call_get` 每轮由 `Router.get` → `Store.call` 取得最新持久时钟并重验归属、恢复及双端 ACL，
不跨轮缓存时间。共同 provider 结果层的前置 `Router.checkResultRead` 与实际分页共用句柄、期限和
参数校验，但不构造正文页；原 Wire 与当前权限末次复验后仍由 `Store.readResult` 重新读页，
句柄删除或到期必须拒绝。本轮预检成功不授予后续读取权，也不刷新任何期限或取消时钟高水位。
`Router.saveResult` 先以当前归属、内容和期限读取已有句柄元数据，命中时保留原 ID/摘要/期限，
不进入签发事务或全量预算检查；缺失时仍由原 `Store.saveResult` 事务执行签发与预算检查。
provider 结果层在此路径前后仍复验原 Wire 与当前授权，不用缓存句柄代替本次授权。
Store 的可选 `authorize` 是独立可信宿主参数，必须同步返回 undefined；异常或非 undefined
返回值回滚登记，不支持异步授权，也不承诺撤销异步回调已产生的外部影响。Router 不从工具 JSON
接收该回调。内部 `Router.create` / `Store.createCall` 保留相对 `timeoutMs` 和原有 Call 返回值，
共用上述 writer 登记；旧键仍须匹配首次持续时长，不能按重送时间刷新绝对期限。

`createCall` 保存不可变意图和期限；`dispatch` 在同一 writer 事务固定 machine/provider/kind/
revision、恢复代次、连接 epoch、call/attempt/native ID、契约、登记条件和审计，并预约收尾
预算。只有事务成功返回的 binding 才可用于实际发送。当前每个调用只允许一次 attempt，
不提供自动只读重试；重连、超时、取消或重启均不重派。

宿主可用 persistentBackend 提供账本事实，再注入独立来源创建 Luvus adapter。编码和 native
派发许可仍须逐次通过真实 native/Wire 门禁；取得 binding 本身不是原生执行授权。响应使用
commitLuvusResponse：在同一事务重新核对原锚点并执行 adapter.planEvidence，提交成功后才
能对外发布 durable responded。相同证据幂等，冲突或任何关联不匹配均拒绝。超时/取消审计
保留，迟到证据另记到达事件，不增加 attempt，也不刷新内容期限。同一合法原生锚点的冲突
响应拒绝且保留原结果，每个调用在审计保留窗内最多一条脱敏冲突记录；不保存冲突载荷。
冲突审计须先提交才返回通常的冲突拒绝；配额或提交失败返回 storage_degraded，不声称已记录。

`persistentBackend` 订阅 Store 的提交后回收通知。RPC 内容到期或 discard 后，adapter 从原真实
permit 密封仅响应上下文，释放原请求、候选、permit 和能力广告引用；密封失败或预算不足时
直接释放执行上下文，不保留原文作为后备。密封元数据与执行缓存共享 attempt 数量及快照字节
预算，固定原内容/去重期限；`stats` 只返回数量和计量，不暴露业务内容。Store 清理事务失败
不会发布回收通知，adapter 另有默认每秒的内存期限维护，即使空闲或账本清理失败也按可信时间
回收原文。`maintenance_interval_ms` 可设为 1–60,000 毫秒；无法取得可信时钟则关闭并释放上下文。
adapter.close 停止自身定时器并取消订阅；Store.close、重配、断连、撤销、provider fence 或去重到期
释放对应上下文，不能靠新连接恢复。

adapter 的临时分片缓存另受 Wire 传输子额和首片固定期限约束，默认维护也清理空闲对象。
内容清理或身份 fence 会保守释放当前连接所有未完成分片，留下短期 ID 墓碑；后续新收到的
正文仍只可用于有界验证，不恢复内容读取或保留权。该清理可能中止其它调用的在途分片，
不能据此重派可能已经送达的原动作。传输预约与活动/墓碑计量由 stats 独立报告，不冒称
snapshot_bytes 包含分片缓冲；精确子额见[原生集成接口](protocol/NATIVE-CONTRACT.md)。

Store 默认每秒维护到期状态、原文、句柄、墓碑和审计，close 停止定时器；可配置为
1–60,000 毫秒，确定性测试可显式 expire。读取、派发和响应提交也核对关键期限，不依赖定时器
恰好运行。Router.wait 只等待本地状态，最多 25 秒，返回 call_id/状态；它不改变执行 deadline。
未派发到期收敛为 not_dispatched，可能已经送达则保持 outcome_unknown。取消只收敛桥接状态。

## History 与分层保留

带 key 调用须显式使用 Store.openHistory 发放的范围。范围固定 principal、machine/provider/
binding、恢复代次、创建时间、准入期限和去重 TTL；旧 scope 的查询、冲突判断与首次登记在
同一事务完成。openHistory 的 retire 参数原子关闭旧范围并建立新范围，不迁移旧调用或 key。
scope/key 不存在不等于首次意图：已过期、未知或已清理范围一律拒绝，新 scope 只能用于明确
的新意图。范围 ID 不复用。无 key 调用没有客户端重送去重保证，也没有自动重放入口。

所有内容从首次登记固定期限，包括保存的请求参数与 inline 响应。句柄仅引用该内容，不复制
载荷；其期限取 min(创建时间 + handle_ttl, 原内容期限)。句柄到期可在原内容仍有效时重新签发，
但内容到期/discard 后不可重新读取或生成句柄。到期维护将请求和响应清空；discard 即时清空并
保留状态和摘要证据。metadata-only 迟到证据不复活内容。调用元数据期限至少覆盖该 scope 冻结的
墓碑期限，配置缩短不改写既有对象的固定期限。

`readResult` 的每页返回实际 `results.expires`，是 Store 时钟使用的绝对毫秒截止时间；
`now < expires` 才有效，等于截止时间即拒绝。句柄期限可以早于原内容期限，不能用
`content_expires` 替代。读取只查询既有句柄，不调用 saveResult、不重建或续期；若授权检查后
句柄已被清理或到期，分页元数据查询返回 result_not_found。返回期限仅是本次读取的快照，
后续 discard、设备撤销或策略撤权仍可提前阻止读取，结果读取继续沿用现有授权及分页上限。

Store 持久化观测时间高水位，读取也推进；事务外每次观察仍核对宿主时间与持久锚点，
仅当时间超过已持久值时更新，同一毫秒重复读取不再写入。事务提交仍持久化固定事务时间，
不缓存授权、结果或跨操作时钟。时钟回拨进入降级并拒绝相关操作。它不能证明关机
期间的真实经过时间，也不能自动检测整个数据库与防回滚状态一起回退；恢复必须走隔离流程。

## 预算与降级

全局预算涵盖 SQLite 已分配/空闲页、事务 journal、状态目录内对象/日志/维护文件，以及配置的
独立备份目录。内容、句柄、调用/history 元数据、审计、安全元数据和备份分别受子额约束。
provider 数量不会增加总额。默认 64 MiB 安全预留不用于普通准入；每个实际 dispatch 预约
至少 16 KiB 最小证据与必要审计容量，并在审计/调用元数据子额内按原调用剩余状态义务预约；
必要记录较大时全库预约相应增加。其它调用和管理写入不得占用这些子额预约；状态推进只结算
本调用已完成的义务，事务失败不释放预约。终态提交释放剩余预约，unknown 在保留期内仍占预约。

容量检查与提交失败都会阻止发送许可返回；SQLite FULL/I/O、审计/元数据或预留耗尽进入
storage_degraded。内存、数据库模式和尽力写入的 `.degraded` 标记共同保持拒绝；磁盘满时
标记本身也可能无法写入，已提交的 dispatch 锚点仍保留，重启保守 unknown。降级阻止新派发、
新配对/认证和新增句柄；仍获授权的有界读取与清理可继续。失败的响应事务不会发布 responded，
不会补发原动作，原始 SQL/异常/参数不会写入普通错误。

恢复写入后先合法清理到期数据，核对空间、子额与 SQLite 完整性，再由独立管理调用
resumeStorage。它不自动重试旧调用。应用预算与预约并非操作系统磁盘预留；备份和其它进程也
可能抢占空间。部署还须以独立磁盘/进程配额及受管日志策略约束宿主。

## 备份与受控恢复

只在隔离测试资源验证这些步骤；真实数据库的清理、删锁或恢复需要另行授权。

1. 用受保护管理面调用 backup，目标为配置的独立 0700 backupDirectory 内全新文件。
   快照为全新逻辑 SQLite 导出，默认不含请求/响应原文、结果句柄、credential hash 或 enrollment；
   保留必要最小历史与审计，并预先进入 recovery_quarantined、新 generation、禁用的新 revision
   bindings、关闭的旧 scope。备份数量、容量和固定 TTL 受限；到期清理不删除带 writer 锁的备份。
2. 恢复前停旧 writer，并在旧备份之外核实无写进程及源库/锁归属；先保留源备份和相关文件。
   不自动删崩溃锁，不执行备份内命令，不直接打开仍由原库管理 TTL 的备份作为生产库。复制到
   全新独立 0700 恢复目录、保持 0600 后才打开。没有可靠防回滚来源时，维持隔离。
3. quarantine 拒绝普通认证、配对签发/消费、内容读取与新派发。由独立当前可信管理员核对来源、
   丢失时间段、当前撤销/策略与各 binding 本机配置，再显式 completeRecovery。快照中的旧管理员
   数据、权限或已消费配对不能作为解除依据。无法确认则保持隔离。
4. 解除后旧凭据和 enrollment 仍失效。逐设备独立确认后重新配对；逐 provider 重新确认并使用
   新 revision；当前 caller/local 策略由备份外来源提供。旧 attempt/scope/pending 不转绑到新代次，
   恢复内容保持 unavailable，不因重新授权恢复原文。只为明确的新意图发放新 scope。

unknown 对账只允许仍处在原有效连接、同一恢复代次和 binding 的可靠证据，经原 opaque native
handle 与原生来源复验后补充。内容清理后仍存活的 RPC 密封上下文只允许 metadata-only 对账，
持续复核完整 binding、契约、能力摘要、原 native ID、method-result 和含 LF 的在线帧预算；不取回
请求、不授权响应原文读取或保留、不生成派发许可、不续期限。证据事务失败不发布 responded，原有效
密封上下文保留到其固定期限，受保护恢复后可以对账但不能补发。没有重启后的响应上下文恢复工厂；
丢失 handle、重启、旧 epoch 或恢复 generation 均保持拒绝，不能从旧 JSON/hash 构造 permit。
Store 的 metadata-only 事务能力不等于这些原生来源已恢复，也不证明远端动作没有执行。

SQL DELETE/secure_delete 和逻辑 TTL 均不承诺物理擦除。空闲页、journal、文件系统快照、外部
副本、已移动备份或设备缓存仍可能残留；受管备份外的副本不会被 Store 自动删除。需要物理销毁
时使用另行审查的存储生命周期机制，不能以“内容不可读”宣称字节已消失。
