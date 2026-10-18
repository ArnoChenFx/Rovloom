# Rovloom 管理 UI：最小管理面设计

日期：2026-10-18。状态：管理 UI 与多 runtime provider 设计需求已确认，具体接口待父会话协调；没有实现前端、管理 listener 或认证后端。
依据：[DESIGN v0.5](DESIGN.md)、[ADR 0002](adr/0002-safety-retention-recovery-late-evidence.md)、[ADR 0004](adr/0004-multi-runtime-provider.md)。正式任务为 [issue #14](https://github.com/ArnoChenFx/luvus-mcp/issues/14)，顺序 #8 → #14 → #9，硬依赖 #5/#6/#8；provider 数据迁移/管理 API 也必须先具备，当前不启动开发。

## 范围与服务边界

Web UI 展示产品名 **Rovloom**；页面标题为「Rovloom 管理」，登录壳与导航品牌为「Rovloom」。设备、runtime provider、连接/认证等业务名称保持原义；Luvus/Herdr 继续显示为 runtime 名，不把机器标识 `luvus-mcp` 用作页面产品标题。仓库/兼容标识见 [README 命名说明](../README.md#name-and-compatibility-identifiers)。

Web UI 内置于同一 Rovloom Gateway 程序/发行产物，Connector 不启动 UI。它管理设备与连接认证状态及其已配置 runtime providers，不另建外部网站，不增加多租户、通用终端、任意 shell、结果浏览或完整运维平台。provider 专指 Luvus/Herdr 实例，不是 LLM/model vendor；页面不管理 model API key。

管理 UI/HTTP API 使用独立管理 listener 与认证/授权中间件；Connector WSS、MCP stdio/HTTP 维持各自协议与身份边界。可以复用实现模块及已选身份服务，但 MCP token、设备 credential、enrollment 或“已连接机器”身份不自动获得管理员会话/权限；管理 API 不能成为 native 通用调用旁路。

默认仅绑定 IPv4 loopback `127.0.0.1`，端口可配置；无管理员认证配置则不启动管理面，不能以 loopback 代替登录。IPv6 loopback 需明确配置；不自动绑定所有接口。远程管理必须另行启用并配置 TLS、反向代理信任边界、允许的 Host/Origin 和访问控制，不能为 UI 默认开放公网或关闭 TLS 校验。恢复隔离时仅允许独立可信的本机恢复管理认证，不从旧备份恢复远程管理开放状态。

页面路由与 API 分别检查管理员身份/当前授权：未登录只显示登录壳，不返回设备数据；API 每次检查 admin 权限及具体管理能力。浏览器会话使用安全 Cookie、CSRF 防护、同源/Origin/Host 验证与必要的 CSP；不把管理 bearer、设备 credential 或 enrollment 存入 URL/localStorage 或页面日志。具体登录实现由后端认证任务冻结，不自建 OAuth 产品，不在本次配置真实管理员凭据。

## 页面与状态

设备列表/详情至少显示：machine_id、唯一名称、labels、连接状态、认证状态、最近心跳（Gateway 收到时刻）、状态观测时间、当前 connection_epoch 的安全引用、最近失败 reason_code/发生时间，以及配对/撤销状态。机器报告的 OS/version 可展示但标注来源，不能作为认证依据。失败原因使用脱敏枚举/摘要，不返回 token、原生 stderr、请求正文或私人路径。

连接状态与授权状态分开：

| 状态维度 | 展示与依据 |
|---|---|
| 未配对/pending | 注册已存在，尚无有效设备认证；不显示为在线 |
| connecting / reconnecting | 后端实际观察并可信关联到该 machine 的建连/重新握手阶段；不能只因 offline 推测正在重连，未认证自报名称不能改变已有设备状态 |
| online / degraded / offline | 分别依据有效设备通道、心跳/本地健康异常、断线/协议超时；连接在线不代表每个 runtime provider/session 正常 |
| authenticated / failed / expired / revoked | 当前认证结果与持久授权状态；旧连接成功记录不能覆盖当前 revoked |
| recovery_quarantined / storage_degraded | Gateway 全局模式，覆盖普通操作可用性；不得把旧快照中的 online/authenticated 当当前状态 |

设备详情展开已配置 provider 行：provider_id、kind=luvus|herdr、binding_revision、非秘密 config_ref、enabled、ready/unreachable/binding_mismatch/migration_unresolved、观测时间和来源；可显示已核实 binary/server/protocol/schema 摘要、classification/schema/transport/support 状态及恢复保证，未知则标未核实。config_ref 不展开本地路径/环境或秘密。未授权 provider 不进入摘要、计数或 API。每行状态来自该 binding 的观测；一个 Herdr adapter 故障不把设备或 Luvus 行改成离线，LLM/model 错误另列任务层。

UI 可只读查看已配置 bindings；新增实例、选择 binary/root/endpoint、修改 config_ref 或 kind 的可信绑定继续由受保护本机配置与后端管理审批完成，最小 UI 不提供任意路径/命令输入。旧来源不明的 migration_unresolved 行保持禁用，不能点选同名 Herdr 代替旧 Luvus。

默认可见页面每 5 秒读取快照，隐藏页面暂停轮询，回到前台立即刷新；单次读取超时 5 秒。距最后成功快照 15 秒或发生 epoch/恢复代次变化即标记过期，显示观测时间/心跳年龄，禁用基于该快照的变更直到刷新。显示年龄使用服务时间及本次请求后的单调经过时间，不因浏览器时钟回退而“变新”。断网保留带过期标记的只读视图，不伪装实时数据；后续可选 SSE 优化不替代快照，当前不要求另做流系统。

空态区分：没有设备（引导建立配对申请）、无符合筛选项、无查看权限；错误态区分未登录/认证过期 401、无权限 403、版本冲突 409、后端暂不可用 503、容量不足。401 清除内存中敏感状态并停轮询，登录后重新取快照；所有写操作在超时/重新登录后都不自动重放。409 必须刷新并重新确认，不能自动带新 revision 重试。

## 管理流程

1. **设备配对**：管理员新建设备/选择已有 machine，查看目标与拟授策略后确认，创建 pending 配对申请。UI 只显示 registration/pairing ID、状态与有效期；一次性 enrollment 的签发/交付继续使用受保护的本机管理渠道及 Connector 本地安全输入，UI/API 不回显 secret、二维码 secret 或带密钥链接。凭据兑换遵循一次性、过期、恢复代次约束；配对成功后展示设备认证与通道状态，不把申请创建当认证成功。
2. **暂时断开**：确认具体 machine 与当前 epoch 后仅关闭这条连接，保留持久设备授权。UI 明示 Connector 可以再次主动连接；这不停止原生工作、不保证回滚在途动作，也不形成持久封禁。
3. **撤销授权**：单独确认持久撤销的设备、影响和原因；后端在持久撤销提交后关闭相关连接、拒绝新认证/派发并终止流。失败时不能显示“已撤销”；已送出的动作可能继续，保持 unknown/对账边界。重新启用需新的明确重新配对/授权流程，不能以 reconnect 自动恢复。
4. **取消配对申请**：只使指定 pending enrollment 申请不可兑换，不能暗中撤销已有设备 credential；已兑换/状态改变则冲突，刷新后重新评估。
5. **禁用/重新启用 provider**：与断开设备、撤销设备分开。必须有独立 providers_manage 权限及真实确认，目标包含 machine_id/provider_id/expected_binding_revision。禁用事务成功后递增 binding revision，阻断该实例派发/读取/补证并关闭其流，显示已送出工作可能继续和 unknown；不撤设备 credential，不误停其它 providers。重新启用要求双端配置一致、重发现/重授权及新 revision，旧流/句柄/attempt 不复活；不自动刷新 TTL 或重派旧请求。仅设备管理权限不足以执行此项。

敏感变更须有真实管理员会话、后台保存并绑定该会话/操作摘要/目标/revision/epoch 的一次性确认记录，以及原子审计；不能由 caller 提交 approved:true 自证确认。确认有效期默认 2 分钟，过期、操作摘要变化或 revision/epoch 变化须重新确认。确认引用只经受保护请求体传递，不放 URL 或普通日志。此处管理员交互不替代必要的原生 Host 确认，UI 最小范围不提供这些 Host 操作。

## 最小管理 API 契约（拟议）

仅固定操作枚举；未知 action、安全分类不完整或当前策略不允许，一律拒绝。管理请求与响应均有界。所有写入含 request_id、history_epoch、recovery_generation、expected_revision、reason 和适用的 confirmation_id；断开额外含 expected_connection_epoch。后端按当前管理 principal/目标去重，复用同请求必须保留原范围与关联；不得更换 ID/范围自动续发。响应不携带凭据正文。

| API | 输入/输出及副作用 |
|---|---|
| GET /admin/v1/status | 返回 server_time、observed_at、mode、recovery_generation、管理 policy revision、刷新建议及服务健康；normal 模式可读取已存在的管理员 history_epoch/截止时间，GET 不创建或续期 scope，隔离态不发放范围；不返回配置 secret |
| GET /admin/v1/devices | cursor、limit、允许的状态筛选；默认 50、最大 200。返回获授权设备摘要与 next_cursor，分页不绕权限 |
| GET /admin/v1/devices/{machine_id} | 设备身份、连接/认证/配对状态、最近心跳、脱敏失败原因、revision 和观测时间；无 result 内容或 credential |
| GET /admin/v1/devices/{machine_id}/providers | 分页返回授权内的已配置 runtime provider 状态、binding_revision 与观测来源；默认50/最大200，不返回 binary/root/endpoint 路径或秘密，不创建 binding/scope |
| GET /admin/v1/devices/{machine_id}/providers/{provider_id} | 返回该 binding 的 kind/config_ref 安全引用、启停/可达、契约摘要/保证与未核实原因；未知/不明来源禁用，不能从 name 默认替代 |
| GET /admin/v1/operations/{request_id} | 同一管理 principal/原 history_epoch 下的操作回执、结果确认程度和审计关联；过期/缺失历史明确报错，不能按“没有记录”自动新建。恢复的回执注明备份时点，不能当当前送达证明 |
| POST /admin/v1/confirmations | 提交固定 action、目标、操作摘要与预期 revision/epoch；创建待真人确认记录。页面展示摘要并由同一管理员交互确认；后端确认步骤不能由普通 MCP/Connector 身份调用 |
| POST /admin/v1/confirmations/{id}/confirm | 当前管理员会话 + CSRF，确认先前摘要；返回一次性 confirmation_id/截止时间，不执行设备动作；重复确认不延长期限 |
| POST /admin/v1/pairings | 新设备名称/labels 或明确已有 machine_id、受限 policy 引用及确认；建立 pending 注册/配对申请。返回 machine_id、pairing_id、状态、expires_at、requires_local_issuance；不返回 enrollment secret，不自动扩大权限 |
| POST /admin/v1/pairings/{id}/cancel | 确认申请及当前 revision；使仍 pending 的申请失效，返回新状态；不撤销其它授权 |
| POST /admin/v1/devices/{machine_id}/disconnect | 确认 machine/epoch，暂时关闭该通道；返回 disconnected/epoch 与 persistent_authorization=unchanged；不得误关闭之后重连的新 epoch |
| POST /admin/v1/devices/{machine_id}/revoke | 确认设备与权限影响，原子记录持久撤销与审计；返回 revoked/新 revision 或明确失败，不能凭仅发出关闭请求声称持久撤销成功 |
| POST /admin/v1/devices/{machine_id}/providers/{provider_id}/disable | providers_manage + 确认 + expected_binding_revision；原子禁用/新 revision/审计，阻断该实例全部业务路径，设备 credential 与其它 provider 不变 |
| POST /admin/v1/devices/{machine_id}/providers/{provider_id}/enable | providers_manage + 新确认 + expected_binding_revision；双端可信配置一致及重新授权后启用新 revision，能力未重发现仍不 ready，不能复用旧句柄/队列 |

写响应至少包含 request_id、目标、operation_state、新 revision、审计关联 ID、observed_at；有在途不确定动作则列明 unknown 影响。容量、会话或网络失败没有可靠提交证明时 UI 显示“结果未确认”，保留原关联并只读查询原设备/操作状态；不自动重新提交写请求，也不把读到相似状态当作证明该次操作成功。

provider 管理操作还必含 expected_binding_revision，确认摘要/history scope/去重关联绑定完整 machine/provider/binding/kind；expected_revision 继续表示管理资源 revision，不能拿设备 revision 代替 binding fence。设备撤销的影响确认列出全部已配置 providers；provider 禁用只列本实例。409、epoch/恢复代次/binding revision 变化或快照过期后均重新读取和确认，不自动套新 revision 重试。API 路径中的 /admin/v1 是管理 API 版本，与 Gateway/Connector wire 2.0、MCP revision 独立。

审计遵循 ADR 0002 的无原文/无 secret 与预算规则，记录管理员、目标、动作、确认记录安全引用、revision/epoch、结果/时间。配对签发/兑换的秘密不进入普通调用结果库、UI 或审计。确认/配对元数据也计入受管预算，不能靠管理面绕过 storage_degraded 或 64 MiB 预留耗尽规则。

## 恢复隔离与存储故障下的 UI

recovery_quarantined 仅允许通过独立于旧备份的本机恢复管理员认证读取恢复模式、备份来源/时点、完整性检查、设备历史摘要、旧认证失效状态和脱敏阻断原因。旧在线/权限数据标注“备份历史”；不显示原始结果、secret 或新 pairing 口令。不能配对/签发/兑换、断开/撤销写入、发放新 history scope、重开业务或把旧请求移到新 scope。解除隔离与重新建立管理员授权继续由受保护本机恢复流程完成，最小 UI 不增加一键解锁接口。

恢复的 provider bindings 全部按备份历史展示、默认禁用；来源/当前配置/授权重新确认前不能 enable，不能由旧 enabled 标志或同名 session 推定可达。隔离态禁止 provider 启停等管理写入；storage_degraded 同样拒绝。provider 禁用未成功持久化不能显示已禁用，前端按钮状态不替代后端门禁。

storage_degraded 时只允许可满足预算/授权的有界只读诊断；禁用所有管理写按钮，明确持久撤销可能尚未生效。后端仍要独立拒绝对应请求，不能仅靠前端 disabled。原调用结局无法持久化则保留 unknown/dispatch 锚点，UI 不显示为已完成；晚到证据也不绕过当前恢复代次、epoch、内容截止和已清理状态。

## 后续 issue 验收（尚未运行）

- 管理 UI 与 API 双重管理员检查；MCP/设备/配对身份不能调用管理动作，未授权数据不进入页面或 API。
- 配对全流程不回显凭据；真实后台确认、CSRF、审计、revision/epoch 冲突、重复/超时均有测试；确认状态不是 approved 布尔绕过。
- disconnect 只断指定 epoch 且允许已授权 Connector 重连；revoke 持久化后拒绝重连，失败不假报成功；原生工作不被暗中终止。
- 同设备 Luvus/Herdr/第二同 kind 行分别显示；provider 禁用/重新启用有独立权限、确认和 revision 冲突测试，其它行与设备授权不被误改。旧句柄/补证/队列不复活；设备撤销覆盖全部。未知分类/状态恢复保证不因 UI 展示变成已支持。
- 空态、401/403/409/503、断网/过期快照/刷新和心跳来源清楚；reconnecting 由可信证据产生，数据过期禁止变更。
- 默认仅本机、远程需显式 TLS/访问控制；恢复/存储隔离的页面与 API 均拒绝写入、旧范围不复活；不把 UI 测试称作跨平台或生产部署验收。
- 前端构建/测试沿用 #15 已合入 main 的 Bun 1.4.3 基线；新 UI/Herdr 仍须独立验收，不把旧 Node/Luvus P0 或 Bun 工具链结果改写为这些功能通过。
