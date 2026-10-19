# SQLite 运行治理

本文说明当前 Store/Router 的本机宿主接口和操作边界。系统保留默认值与安全语义以
[DESIGN §12](DESIGN.md#12-事件结果与保留)为准，精确类型见
[Store](../src/store.ts)、[Router](../src/router.ts)与
[持久化接线](../src/integration/persistence.ts)。这些模块尚不构成远程管理 API 或服务 CLI。

## 状态库与宿主信任

Store 创建规范 schema v4，只接收全新库或同版本库，拒绝未发布的 v1/v2/v3，且不修改其
源文件。现存旧库应保留在隔离目录供人工核对；不要靠重命名版本号、补默认 provider 或
导入旧 key 继续执行。不提供旧库迁移或隐式升级入口。

文件库当前只支持 Linux：绝对规范路径、无符号链接祖先、直属父目录由当前用户持有且为
0700、数据库为当前用户持有的普通单链接 0600 文件。专用状态目录内的全部文件与子目录
均计入受管存储；不要放入不相关文件。macOS/Windows 存储入口明确拒绝，仍待独立验证。

`.lock` 使用独占创建；成功关闭才释放自己的锁。异常退出留下的锁不会自动删除。
完整性检查或版本检查失败不能继续写业务。SQLite 使用 FULL synchronous、DELETE journal；
它们依赖操作系统/文件系统的持久性，不承诺抵抗管理员直接替换整机状态或失效硬件。

Store 是受信进程内接口。认证、当前双端策略、精确本地 binding、契约与分类、原生 endpoint
来源和确认记录必须独立提供；不能把模型参数、设备广告或 JSON 中的 true 当作这些事实。
`management` 回调默认不存在，provider 管理、设备撤销、审计读取、备份、降级恢复、解除隔离
和恢复设备重新配对均因此拒绝。宿主回调须核实真实管理员、独立操作权限、目标、当前 fence
和一次性真实确认；Store 在同一事务消费 confirmation_id，阻止重复使用。该回调不是管理员
身份服务的替代品。注册与普通 enrollment 签发也只能置于受保护的本机管理面。

## 独立身份库的设备生命周期桥

`connectVerifiedDevice(machineId, recoveryGeneration): string` 只由独立身份库完成凭据校验的
受保护宿主调用。在同一 Store writer 事务内，核对 active、当前 generation、已配对 offline、
无现存 epoch 且无待完成的恢复确认，再消费宿主的一次性校验证明。只有 epoch、预算与审计
成功提交后才返回；pending、撤销、重复在线、隔离或降级均拒绝。它不接收凭据，也不依赖旧
credential hash；普通 caller 的设备 ID 或 `verified=true` 不构成证明。

宿主创建 Store 时必须注入同步 `deviceLifecycle(request): boolean`，缺省拒绝。连接分支的
request 为 `{ action: 'connect', machine_id, recovery_generation }`：回调必须核实独立身份未
blocked、已配对且当前请求的凭据确已验证，并同步消费绑定该设备和 generation 的一次性证明。
只查询“设备存在”或返回默认 true 不合格。证明消费成功而 Store 随后失败时，不返回 epoch，
不复用该证明；连接保持未就绪，新的认证须重新验证凭据。返回 epoch 仍不代表 provider ready。

`resetDeviceEnrollment(machineId, recoveryGeneration, expectedEpoch, prepare): void` 供受保护
的同 ID 重配使用，`expectedEpoch` 必须为当前 epoch 或离线时的 null。独立 `management`
确认的 action 是 `device_enrollment_reset`，target 是 machineId；fence 是按 `boundedJson`
序列化的 `{ recovery_generation, connection_epoch: expectedEpoch }`，不能仅按设备名确认。
事务清除旧 credential hash、enrollment 和 epoch，设备变为同 ID pending；该设备所有 providers
的未派发调用变为 not_dispatched，未完成的已派发调用收敛为 outcome_unknown，不重放旧调用。
本库成功 COMMIT 后发布设备级 fence，释放该设备全部 provider、旧 epoch 的执行/仅响应上下文及
尚无法归属调用的在途分片；即使没有调用行也发布。回收通知带可信设备作用域，不清理其它设备的
在途分片。Store 回滚不发布这个成功通知，不能用它替代宿主在 prepare 阶段的同步业务阻断。

两个数据库不构成原子事务。Store 在调用 prepare 前检查管理确认、fence 并预检本库变更预算；
prepare 在本次调用内同步执行恰好一次，只能将独立身份库按本次 fence 持久化为 blocked，不能
激活新身份或解除阻断。返回值必须是 undefined，Promise 返回拒绝。随后宿主回调收到
`{ action: 'reset_enrollment', machine_id, recovery_generation, expected_epoch }`，独立核对
该精确 fence 的 blocked 确已提交，才允许 Store 最终提交。须从独立事务/连接观察提交事实，
不能把 prepare 同一未提交事务中的读取或内存标志当作 durable。缺少确认、fence 错误或前置预算失败
不调用 prepare；prepare 抛错、阻断复核失败或最终提交失败都回滚 Store。prepare 中不得重入
Store 的 writer 操作，不提供通用 SQL 或事务回调入口。

身份库已提交后若 Store 失败或进程中止，外部 blocked 必须保留；不得用补偿、自动重试或启动
恢复解除它。宿主须在受保护重配过程中阻止旧身份的新请求并停止旧连接/订阅；Store 不能替身份库
或 WSS 保证这一点。失败按实际结论报告并要求新的受保护重配流程；只有 Store 成功返回
后才能签发新的 enrollment，独立身份库也只能在新的配对完成后解除 blocked。WSS 接线只使用
此受保护桥，不能缓存原 secret 绕用 `connect`，也不能把“连接库失败”解释为凭据仍有效。
独立身份库的持久化预算、防回滚、配对/轮换及通道关闭仍由该身份宿主实现。

## 登记、派发与读取

新调用必须带完整 Wire v2 Target、expected binding revision、contract_ref、验证模式与双方
policy revision。Router 按完整 target/method/action grant 双端求交，并持续重授权读取、派发
和取消；discard_response 另需独立权限。provider 启停消耗独立管理确认并递增 revision，旧
attempt/句柄不复用。设备撤销覆盖所有 providers，且不表示原生动作已经停止。

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

Store 持久化观测时间高水位，读取也推进；时钟回拨进入降级并拒绝相关操作。它不能证明关机
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
