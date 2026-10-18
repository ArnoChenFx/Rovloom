# ADR 0002：Rovloom 安全分类、有限保留、隔离恢复与晚到证据

日期：2026-10-18 UTC。状态：用户已采纳四项原则；本地设计细则及默认值待父会话验收，尚未实现。
基线：已验收 Linux P0 提交 `d2455e878f93e162a2a54bb58c1e5785aecd0949`。本次仅修改设计、实施计划、交接及 ADR；不授权后续功能开发、真实清理/恢复、凭据操作或发布设计分支。

用户采纳的原问题是：“是否采用未知安全分类默认拒绝、分开定义内容与去重保留期、备份恢复先隔离，并允许同次执行的可靠迟到回复补充 unknown 结果？”本 ADR 将这些原则落实为待实现契约，不把用户对原则的采纳说成已验证实现。

## D1：安全分类门禁与参数 schema 分开

可信分类绑定确切 binary/契约与本地评审 revision，至少包含：

| 维度 | 必须说明 |
|---|---|
| 作用 | 读、写、外部副作用、幂等性、RPC/Host/stream，以及通用分派方法的实际子动作 |
| 高权限 | Owner、Host admin、任意终端/agent 执行、凭据管理、所需确认与策略权限 |
| 秘密结果 | 凭据/token 只能交专用 custody；潜在敏感内容有明确读取授权、保存期限与交付方式；未知时拒绝 |
| 来源与边界 | 已核验原生 method_contracts + 受信本地评审资料；缺字段、来源不可信或冲突即不完整，不能由远端广告、调用输入或方法前缀提升权限 |

分类未知/不完整时可发现但不可执行；observer/orchestrator/owner/raw-contract 均受此约束。classification_status、schema_status 与 transport_status 须分别表达，不能合并成一个“支持”标记。分类可信完整而仅参数 schema 不足时，严格模式拒绝；Owner 可显式选择只放宽参数验证的 raw-contract，其余授权、传输、envelope/大小、保留字段和秘密结果门禁仍在。

P0 的 144/223 通用 params object 是**参数契约缺口**，不能直接等同于安全分类缺口。其余 79 个有条件分支的方法也不一定覆盖原生全部语义。本次不构造虚假的完整分类表、不更改已验收 coverage 的 not_implemented/not_enabled 状态；#4 应以两个独立状态及负例落实设计。

## D2：内容、句柄和去重承诺分别到期

全部可配置默认值的权威表位于 [DESIGN §12.3](../DESIGN.md#123-内容句柄墓碑与全库预算)，本 ADR 不另设不同数值：

| 参数 | 默认值 | 约束/计量 |
|---|---|---|
| content_ttl / content_bytes | 1 小时 / 128 MiB | 调用首次登记固定期限；包含内联、对象与单次 capture 副本 |
| handle_ttl / handle_payload_bytes | 1 小时 / 16 MiB | 有效期按 min(句柄创建+TTL, 内容截止)；载荷属于内容子池 |
| call_metadata_ttl / dedup_ttl / call_metadata_bytes | 30 天 / 30 天 / 合计 64 MiB | 元数据不短于墓碑期；不含原始参数/结果，不随重试续期 |
| history_epoch_max_age | 24 小时 | 只控制登记新 key 的时间；不大于该范围冻结 dedup_ttl |
| audit_ttl / audit_bytes | 30 天 / 64 MiB | 无 prompt/原文/secret；不提前删除承诺期内必需审计 |
| security_metadata_bytes | 16 MiB | 身份/撤销/策略不按内容 TTL 自动删除，满额拒绝新分配 |
| backup_ttl / backup_max_count / backup_bytes | 7 天 / 2 份 / 合计 128 MiB | 按需逻辑导出必要元数据，默认排除原文与明文凭据，无自动调度 |
| storage_total_bytes / storage_reserve_bytes | 512 MiB / 其中 64 MiB | DB/空闲页、WAL/SHM、对象、受管日志/备份及临时文件全部计量；预留仅收尾 |

跨字段约束完整列举：所有 TTL/字节/数量为正且可安全表示；call_metadata_ttl >= dedup_ttl；范围冻结 history_epoch_max_age <= frozen_dedup_ttl；handle_payload_bytes <= content_bytes；handle_expires_at <= content_expires_at；0 < storage_reserve_bytes < storage_total_bytes，各子上限不大于总量，正常准入扣除预留及已有预约；恢复/审计占用预留仍不可突破各自子预算。子池不叠加成总量之外的空间，默认 400 MiB 非重叠子池 + 64 MiB 预留 = 464 MiB，剩余 48 MiB 也须按实际文件/索引等计量。持续流仍使用独立有界内存队列，不默认持久化帧。

TTL 从服务可信的首次登记/创建时间固定计算；不由读取、重复调用、晚到回复或恢复重置。时间回退或无法确认是否已到期时不得延长有效性，标记时钟异常并拒绝相关续期/派发，#5 需测边界。缩短现有去重期不能借普通配置热更新提前丢记录；必须关闭旧范围并按受保护维护过程处理。

有限墓碑与“到期后仍不把旧提交重新派发”需要一个额外边界：Gateway 发放 history_epoch，新的带 key 调用必须显式绑定有效范围。范围退役后只能重返仍有记录的 key，未找到一律 dedup_history_unavailable；未知/丢失/恢复前的范围不能登记新 key。重试器不自动换范围或换 key。30 天之后不承诺仍有逐调用查询记录；用户明确发起新范围/新 key 的新意图，可能再执行同样动作，不是 exactly-once 保证。

该保证依靠拒绝旧范围创建，而非无限保存 key。Gateway 持久化 scope_created_at、accept_new_until、绑定恢复代次和 frozen_dedup_ttl；新调用都采用这个冻结期限，配置变化不得在仍 active 的旧范围内缩短墓碑。严格 now < accept_new_until 的原子准入与 `accept_new_until <= scope_created_at + frozen_dedup_ttl <= call_created_at + frozen_dedup_ttl` 保证：任一墓碑能合法删除前，该范围已经不能登记缺失 key。范围元数据清理后视为 unknown，不能默认 active；scope ID 不复用。

因此 active+已有 key 返回原调用；active+新 key 才可登记；退役+已有 key 只重返；退役/未知/恢复前范围+缺失 key 一律拒绝。客户端 discovery 新 scope 不得用于续发旧请求；原 retry 绑定的 recovery_generation/history_epoch/key 不能被服务端、迁移器、恢复工具或 SDK 自动改写。此方案不能识别所有参数相同但以全新 key/范围明确提交的新意图，保证不扩展到这种语义去重。

例如：t0 登记后 content_expires_at=t0+1 小时；t0+45 分钟才建句柄，最多只剩 15 分钟；t0+2 小时即使内联副本或可信晚到 response 尚在，也只能返回 content_status 与最小证据，不能重建原文或句柄。显式 discard 同样不可复活，且保持独立 discard_response 权限。句柄先到期、原文仍有效的情形可以重新授权后建短句柄，但内容和墓碑截止时间不动。

容量不足先合法回收已过期数据，再拒绝新增派发；不能提前删去重、截断必需审计或以未知写操作重放来“补救”。SQL 删除不等于物理擦除；备份和外部副本的残留边界必须披露。默认逻辑备份不带原文，不能用整库文件复制冒称这一默认行为。

64 MiB 收尾预留用尽时按 [DESIGN §12.4](../DESIGN.md#124-预留耗尽与持久化失败) 安全失败：

1. 在实际写出到 Connector/UHP 前，先持久化最小 call/attempt/范围/墓碑与可能送达的 dispatching 锚点，并预留有界收尾/审计容量；前置事务失败则不写出，只有能证明没写出时返回 not_dispatched。
2. 预留也耗尽或真实磁盘/WAL/I/O 写失败，进入 storage_degraded，停止新增派发、流输入、配对/新认证等；不突破总量、不提前删墓碑、不重放旧写操作。不能提交撤销等安全状态时不报告其已生效，必要时停止认证/关闭相关通道。
3. 已可能送达但结局无法持久化，保留先前 durable dispatching/accepted 锚点并按 unknown 对待；重启仍不重放，锚点不可信则恢复隔离。无法保存可靠晚到证据时不发布 durable responded、不建句柄；允许丢失该回复证据，不能以预留存在为由保证永不丢证。
4. 只做有界无秘密的瞬时告警/聚合，不伪称审计完整。健康/完整性/预算恢复并经受保护管理后才解除 degraded；不自动重派。应用预约不是 OS 物理保留，外部填盘/写失败仍按这条边界处理。

## D3：旧备份先隔离，旧权限不能因回滚生效

恢复流程与普通重启分开：新目录恢复必须先 recovery_quarantined，业务派发/内容读取/Connector 认证/enrollment 兑换关闭。先校验单 writer、备份版本和对象边界，绝不自动删除崩溃锁或把旧管理员凭据当作恢复授权。

默认恢复不是“恢复旧凭据继续使用”：

1. 新 recovery_generation 使所有恢复前设备/配对凭据失效，未消费且未过期的 enrollment 也失效；旧 machine_id 仅保留历史关联，需受信本地管理员逐机确认并重新配对。
2. caller ACL、Owner/Host admin、独立清理权限默认拒绝，使用旧备份之外的可信当前策略或本地重新授权；OAuth token 有效不意味着旧策略可复活。
3. 设备 offline，新 epoch，旧流/结果句柄不可沿用；内容期限及 discard 状态按原值执行，不能重置。备份后是否发生 discard/过期/撤权不明时，恢复原文默认不可读且不能建句柄，仅重新授予 ACL 不足以证明它可恢复；默认只恢复无原文的元数据，例外备份同样服从该保守规则。
4. 关闭旧 history_epoch、不导入 active 集合，不把旧 pending/call/retry cache 重新打上新恢复代次。备份后丢失 key 不能当成新请求。没有覆盖丢失时段的可靠证据，恢复的“未发送”也不能证明未执行；在途结局按 unknown，历史确定结果注明其备份时点。
5. 经受信本地管理员明确解除隔离后才创建/发放绑定新 recovery_generation 的 scope，接收重新授权后明确的新意图；缺失/不匹配恢复代次、旧范围或要求自动换范围的请求必须拒绝。禁止恢复待发队列、重放旧请求或自动终止可能仍在运行的 Luvus 工作。

例：第 2 天备份、第 4 天撤销/配对消费/派发、第 5 天恢复第 2 天备份。即使回滚库仍称 credential 有效、enrollment 未用且缺少某 key，隔离流程仍使旧认证/配对失效、关闭旧范围并拒绝该缺失 key 的派发；不必伪称已经重建第 4 天完整历史。

没有独立的可信新鲜度来源时，不承诺自动检测整机/全部文件一起回滚；支持的恢复工具必须显式隔离，无法证明当前安全状态时不自动开放。此边界不引入新的外部身份产品，也不在本任务中配置任何凭据、权限或服务。

## D4：同次执行的可靠晚到回复可追加 unknown 证据

允许的更新是 `outcome_unknown → responded + late_evidence`，且保留原超时、取消、发送及 unknown 历史。它反映后续证据到达，不宣称在 deadline 前完成，也不把 queued 当业务完成。机器、恢复代次、仍有效认证 epoch、call_id、attempt_id、native request id、目标与契约全部匹配；同一 writer 原子处理，不重新派发。

| 到达情形 | 必须处理 |
|---|---|
| 相同仍有效 attempt/epoch，可信完整 response，内容未过期 | 可追加原生结果证据，按当前读取权限/分类交付 |
| 同一可靠证据但内容已到期/discard | 只记受保护的 ID、时间、hash/长度、result/error 类别；不保存原文、不建句柄、不续期 |
| 同一 response 重复 | 幂等，无新执行/新句柄/期限刷新 |
| 同一关联但内容冲突 | 不覆盖已接纳结果，有界记录冲突并隔离 |
| 旧 epoch、旧恢复代次、其它 attempt 或机器已撤销 | 隔离/拒绝，不改变当前结果 |
| 原调用/墓碑已经删除，或 call 已切换其它 attempt | 不重建调用，不以旧回复覆盖当前 attempt |

普通断线/重启后往往更换 epoch；本规则没有授权重连缓存绕过身份 fence。caller 撤权立即阻止读取，保留受保护的最小接收审计不等于重新执行或授予内容访问；机器/通道信任已失效时则不得补写结果。

“可靠补证”还要求该追加事务成功持久化。预留/磁盘耗尽导致事务失败时保留原 unknown 或 durable dispatch 锚点，不把只在内存看到的 response 发布为 durable 终态；不重试原操作、不延长 TTL。恢复后旧认证/旧 epoch 的回复仍隔离，不能通过新 scope 为它重新创建调用。

## #4/#5 实现与一致性门禁

本地实施清单见 [IMPLEMENTATION-PLAN §4.1](../IMPLEMENTATION-PLAN.md#41-4--5-的补充验收与交付边界)：#4 冻结分类/schema 状态、history_epoch/recovery_generation 及晚到证据的 wire 关联；#5 实现固定 TTL、池/总预算、准入、范围退役、隔离恢复与事务性晚到更新。该清单需父会话同步到 GitHub，当前未改 issue。

现有 v3 只限制句柄载荷，内联响应不在 16 MiB 配额内；句柄 TTL 未删除原文；receive 尚拒绝 unknown 状态的 response。它也没有 history_epoch、recovery_generation 或隔离恢复门禁。这些都是后续迁移/回归的明确缺口，不在本次改源码来掩盖。原有身份 ID、路由、独立清理权限、无静默重放、单活 SQLite、主动 WSS 与 MCP 版本取舍保持。

待 #4 冻结的是字段具体编码/协商和旧数据的只读兼容映射，不是重新讨论已采纳的四项原则；无法证明的旧分类/过期/认证/去重状态须拒绝或隔离。新增默认值是本次设计建议，可由父会话在验收时调整，不是用户逐个指定的运行配置。
