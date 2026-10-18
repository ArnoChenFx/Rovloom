# Luvus 多机器通用 MCP：实施方案

版本：0.3 · 日期：2026-10-18 · 原作者：Luvus Tester
状态：供后续开发执行的计划；v0.3 仅按用户采纳的四项原则修订文档，没有实施这些新规则。
配套：《DESIGN.md》。下文的命令/工具名称均为拟议接口。

当前已验收 Linux P0 基线为 `d2455e878f93e162a2a54bb58c1e5785aecd0949`。原有内部实现不等于新验收门禁已满足；本次不自动启动 #4/#5。详见 [ADR 0002](adr/0002-safety-retention-recovery-late-evidence.md)。

## 1. 交付目标与工作纪律

交付一个项目、一套 `luvus-mcp` 程序，以 gateway / connector 两种模式运行。Gateway 提供统一 MCP，Connector 主动出站连接并访问本机 Luvus；主 Agent 以 machine_id/name 管理多机器，以通用 UHP 调用使用丰富功能。

实施不能用“能 list_agents”代替完整网关，也不能用一个无限制 shell 接口代替 UHP。

工作纪律：
- 本计划不授权现在写代码、安装服务、签发凭据或部署；开发开始须有后续明确指令。
- 已有 `luvus-mcp/` 下的旧 Agent 产物属于未核验草稿；本轮不修改它们，不假定已完成任何阶段。
- 后续接手先登记原文件、Git 状态与备份/差异，不删除或覆盖用户原工作；决定复用与否必须说明依据。
- 真实实验仅使用自己新建的 named session、目录、pane、worktree；显式目标、不抢用户焦点。
- 所有验收以命令输出、协议记录、断言和独立复核为证据，不以模型自报成功为准。
- 文档、测试数据和日志不存真实密钥；不让测试读取 .env 或私人凭据来“验证安全”。

## 2. 首版范围分层

| 层次 | 交付能力 | 对外称谓 |
|---|---|---|
| A：核心链路 | 单机配对、MCP stdio、WSS Connector、普通 UHP 发现/描述/调用、结果句柄、权限 | 内部技术预览，不宣称全功能 |
| B：多机与可靠性 | 两机同 pane ID 隔离、重连、持久化、撤销、unknown 语义、Host profile | 多机预览，仍列明流缺口 |
| C：流与治理 | 事件恢复、终端观察/双向控制、背压、权限收敛、真实任务治理 | 功能候选版 |
| D：部署发行 | HTTP MCP 认证、跨机器联调、平台矩阵、运维/恢复、覆盖账本 | 达到实际验收范围后发布 |

任何阶段可交付可用切片，但“所有已发现方法都有分类”与“全部允许能力已有传输实现”是两个不同指标。版本说明必须披露未覆盖项。

## 3. 技术基线与需要冻结的决策

建议 TypeScript + 一个 CLI，模块化业务核心；选择仍受支持的 Node LTS，锁定当时兼容的 MCP SDK、schema validator、WebSocket 和 SQLite 依赖版本。
- 采用已验收 P0 的 [ADR 0001](adr/0001-p0-version-and-contract-baseline.md) 版本锁，不按“latest”替换依赖。
- MCP stdio 与 Streamable HTTP 共用同一 facade；优先本地 stdio 联调，公网 HTTP 在授权验收后才开放。SDK 1.32.1 当前实测 2025-11-25 的 initialize 路径；2026-07-28 元数据/握手机制不同，不能混称兼容，目标客户端须实际协商。
- Gateway 与 Connector 的网络协议自定义且版本化；不是把内部 WSS 冒充 MCP 或 UHP。
- schema 使用安装 binary 的 bundle + 实时 capabilities；外部 JSON Schema 引用按已下载 bundle 解析，禁止任意 URL 自动取远程 schema。
- 持久化先用单活 SQLite；migration、文件权限、结果配额与崩溃恢复纳入首版。
- 部署反代、TLS 证书、OAuth 服务为外部依赖，写清职责，不自建身份产品。
- 未知安全分类默认拒绝；与参数 schema 不足分别处理，Owner/raw-contract 不绕过作用、高权限和秘密结果门禁。
- 内容/句柄/墓碑的期限、分池与全库预算以 DESIGN §12.3 为唯一默认值表；恢复先隔离、历史范围和晚到证据分别依 DESIGN §5.4、§11.2、§11.1。

建议依赖顺序：
```text
P0 协议与范围实证
  ↓
P1 契约/状态/身份/存储
  ↓
P2 配对与 Connector 通道
  ↓
P3 普通 UHP + MCP stdio
  ↓
P4 多机可靠性与 Host
  ↓
P5 事件与终端流
  ↓
P6 HTTP MCP 与安全加固
  ↓
P7 真实联调、文档与发行
```
安全是各阶段约束，不是 P6 才补；P6 是完整 HTTP 入口与攻击面门禁。

## 4. 分阶段实施

### P0 — 协议实证与设计冻结

工作：
1. 确定新项目位置、已有草稿处理方式与交付平台。
2. 在独立 LUVUS_HOME/named session 采集 binary/server 版本、schema bundle、session capabilities、Host capabilities 和 endpoint 发现结果；敏感项脱敏。
3. 确认普通请求 framing、进程退出码、超时、Host 不需运行 session 的行为。
4. 确认 events.subscribe、snapshot、after_sequence、终端 observe/control 的握手、身份 fence、ack 和生命周期。
5. 以官方 `luvus session list --json` 的 running endpoint 发现方式为基线，分别在 Linux、macOS、Windows 核对本地归属与可连接性，不靠复制内部 socket 命名规律。
6. 选择 SDK、Node LTS、schema validation 策略、目标 MCP 客户端与认证服务；形成 ADR。
7. 定义协议能力覆盖清单生成规则：每个原生方法标注 RPC/Host/stream、schema 和授权状态。

交付：协议调查记录、脱敏 fixture、ADR、平台/版本矩阵、设计差异清单。
退出门禁：至少 Linux 的 RPC、Host、事件、终端 control 各有最小原生证据；未实证项不能用猜测继续实现。网站与本机差异需登记，而不是更新 binary 掩盖。

### P1 — 契约、数据模型和调用状态机

工作：
- 冻结 Gateway/Connector envelope、major/minor、错误命名空间和消息大小约束。
- 实现机器 ID、唯一 name、pending/online/revoked 等状态与 connection_epoch。
- 建立 SQLite schema、原子 migration、单实例 writer 锁与隔离恢复流程；不能从备份复活认证/配对/ACL。
- 定义 call_id、client_request_key、请求摘要、目标键、delivery 与 outcome_unknown；冻结 history_epoch/recovery_generation 的绑定及可靠晚到证据条件。
- 定义 caller policy 和 Connector 本地 policy 的交集；作用、高权限、秘密结果分类缺失/冲突时，所有角色 fail closed；参数 schema 不足另行标记。
- 定义原始内容、句柄、调用/墓碑和审计的独立固定到期时间、全库预算与容量准入；内容到期/discard 后不得从旧 response 再生句柄。

交付：契约文件、数据字典、迁移与单测。
退出门禁：重名/改名/ID 不变、并发事务、重复 key 不同内容冲突、恢复不重放动作、越权读取结果及下列 #4/#5 新清单均有自动断言；已有 20 个回归不能替代它们。

#### 4.1 #4 / #5 的补充验收与交付边界

本节按现有 issue 分工同步本地验收计划；GitHub issue 文本由父会话另行维护，本次未修改。

**#4 [P1a] 协议与原生契约校验：**
- [ ] 在 wire/data dictionary 中区分安全分类、参数 schema 和传输适配状态。分类至少覆盖作用/幂等性/传输、高权限与确认、秘密结果交付；缺失、冲突、非可信来源及未知子动作在 observer/orchestrator/owner/raw-contract 下均拒绝执行。
- [ ] 安全分类完整而仅参数 schema 不足时，严格模式拒绝，显式 raw-contract 只能放宽参数验证；保留 envelope/限额/保留字段/当前策略/秘密结果检查。用 P0 的 144 项缺口和 native 额外约束分别作回归，不声称枚举即参数验证。
- [ ] 冻结恢复代次、history_epoch、call/attempt/epoch/native id 关联、方向、重复与冲突回复规则；同一有效 attempt 的可靠晚到 response 可以输出追加证据意图，旧 epoch/恢复代次/其它 attempt 不可更新当前结果。
- [ ] 描述 unknown 细化、原超时/取消历史不变、content_status 与固定 expires_at。带 key 但缺少有效 history_epoch 不得暗用当前范围；协议 codec 不负责实际修改账本或宣称 socket 已认证。
- [ ] 以上契约正反 fixture 覆盖 unknown 分类与仅缺 schema 的差异、秘密结果旁路、错关联、重复/冲突、过期/已清理内容状态；原 #4 的全部 envelope、版本协商、schema 引用/边界和未认证拒绝要求保持。

**#5 [P1b] 调度、保留、审计和恢复：**
- [ ] 使用 fake clock 验证 DESIGN §12.3 的全部默认值与非法组合；原始内联/对象、句柄、墓碑/调用元数据分别到期。句柄到期可在内容仍有效时重建，但不得延长内容截止；内容过期/discard 后通过 call_get/result_read/同 key/晚到/备份恢复均不可复活原文或句柄。
- [ ] 在当前策略及独立 discard_response 权限下清理；内容删除不删除未到期墓碑。验证 24 小时新 key 范围退役、30 天墓碑到期、相同 key 的冲突、未知/旧范围和缺失历史，拒绝旧 key 重新派发；重试器不自动更换 key/范围。
- [ ] 证明 16 MiB 句柄子配额不能绕过 128 MiB 内容池和 512 MiB 受管总量；SQLite/WAL/SHM/对象/受管审计/备份/维护临时文件计入总量。64 MiB 预留用于既有工作收尾，新派发先做预算准入，容量不足不提前删墓碑、不自动重放，拒绝审计有界。
- [ ] 仅用自建数据库/临时目录演练“备份后撤销、已消费配对、已派发 key 后再恢复旧备份”。必须先隔离、使旧凭据/配对失效、关闭旧历史范围、ACL 默认拒绝并重新授权/配对；缺失 key/丢失在途历史不能变为首次派发或未执行证明，旧回包与内容期限也不能复活。
- [ ] 对缺少可信当前撤销/历史资料的恢复保持隔离；明确支持流程与手工整机回滚检测的保证边界。恢复/migration 中断、预算不足、单 writer、原子失败和不自动删锁仍须重复证据。
- [ ] 同一仍有效的已认证 attempt 在 deadline/取消之后收到可靠 response，可原子补证并细化 unknown，历史超时保留且不重新派发；重复只幂等补证，冲突不覆盖；旧 epoch/恢复代次/其它 attempt/已删除历史隔离。内容到期/discard 后晚到只记最小证据，不续 TTL、不建句柄、不绕过撤权。
- [ ] 原 #5 的结构化审计/假 secret、迁移、私有路径/平台权限与 Node 24 typecheck/test/build 要求保持；编码时修正现有 v3 与这些新门禁的差异，不把本次文档修订写成实现通过。

### P2 — 配对、设备身份与主动连接

工作：
- 完成 registration pending → 一次性 enrollment → 设备 credential 绑定。
- enrollment 只通过受保护管理渠道交付，不在 MCP 普通输出中吐 secret。
- WSS、TLS 验证、协议版本协商、认证、心跳、退避重连和并发连接冲突。
- 实现凭据撤销、轮换、过期与重新配对；设备持久状态限制访问权限。
- 接收请求前同时确认通道 ready、策略/安全分类 revision、epoch、恢复代次和本地配置；恢复隔离未解除时认证/配对不得受理。
- 单次启动可从环境/受限文件获取凭据，运行参数和日志不携带明文。

交付：Gateway listener、Connector 长连接、配对管理流程、连接健康。
退出门禁：同名不替代身份；token 重放/过期/错误证书被拒；断线后相同设备 ID 保持不变；复制凭据连接不能静默顶替；撤销立即切断新调用。

### P3 — 通用 UHP RPC 与 MCP stdio 垂直切片

工作：
- Connector shell=false 调用固定 Luvus binary，明确状态根/session，处理单请求 proxy。
- 本地 CLI schema 获取与实时 capabilities 分开；不存在的 uhp.schema RPC 不得被编码进去。
- schema 按方法裁剪时保留闭包、根条件和 document 引用；参数 schema 不足标记 unavailable，与未知安全分类默认拒绝分别执行，raw-contract 不越权。
- 实现 machines_list/get/register/rename/revoke 与 discover/describe/call/call_get/call_cancel/result_read。
- 通用 call 在安全分类允许及内容有效期内保留原始 result/error、字段和 revision；凭据秘密交 custody，过期/清理返回 content_status，Gateway 错误另层表达。
- 短 wait 窗口返回 call_id；长执行和结果缓存不绑定 MCP 连接是否持续。
- 大回复保存完整原文/结构对象并提供分段读取；索引字段可摘要，不能静默截掉 error 或并发字段。
- stdio stdout 仅 MCP，日志走 stderr；真实 MCP Client 验证工具 discovery 与结构化错误。

交付：单机端到端预览、schema fixture 测试、真实 stdio MCP 集成测试。
退出门禁：不写方法专用业务 wrapper 也能调用多个不同方法族；原生 error 深度相等；参数含引号/分号不会变 shell 执行；输出上限、超时与 subprocess 错误清晰区分。

### P4 — 多机器可靠性、持久化与 Host profile

工作：
- 两个 Connector 同时连接，分别绑定独立实例，所有变更仅接受 machine_id。
- Host 发现/通用调用与 session 发现分离，明确缺省 profile 与 session 校验。
- 在派发前/接收后/写入 UHP 后/收到响应前后注入断线和进程崩溃。
- 账本恢复时按可证明的送达状态返回 not_dispatched 或 outcome_unknown，不制造“安全重试”假象。
- 对 client_request_key 仅重返原状态，不因 MCP 重连重执行；只有原生支持的方法才传递幂等键。
- Connector 有界诊断日志可辅助对账，但不承诺 exactly-once；同一有效 attempt 的可靠晚到结果可补证，旧 epoch/恢复代次/其它 attempt 隔离，不能靠重连缓存重放写请求。
- Gateway 重启时设备重新上线，调用/订阅句柄状态明确；设备 offline 不排队写操作。
- Host 安装/删除/更新等带真实人工确认机制；普通 Agent 不能自填 approved 绕过。

交付：两机集成、恢复/对账说明、Host 权限测试。
退出门禁：A/B 都有 pane 3 时请求不串机；改名/离线/重启不改变路由；丢回复不重复 prompt/start；Host 禁权时所有路径都拒绝。

### P5 — 事件、终端观察和双向控制

工作：
- 实现本地持久 UHP adapter 与 stream_open/read/write/close。
- events.subscribe + 独立 snapshot 启动，保留原生 sequence 与网关 cursor；gap/overflow/generation 变化显式 resync。
- observe 保留帧边界及 revision；终端控制保留 native lease、输入关联与 ack。
- stream_write 只允许对应原生 frame schema；只读 subscription 不能写，关闭流不自动关闭 pane。
- 原生 replay 不足时明确缺口；不可 replay 的 observe 改为重新 capture，不谎报连续。
- 每设备/每 caller 并发、内存队列、字节率、最大对象与流 TTL；处理慢读者背压。
- 终端图片/上传等子能力单独登记。未完成适配时工具明确拒绝，能力矩阵不标“已覆盖”。

交付：事件恢复测试、真实终端观测/控制证据、流资源测量。
退出门禁：两个订阅互不吞事件；旧 generation 的控制被拒；第二客户端拿不到已占用控制租约；读者停止不造成无界内存；关闭后原生 lease/子进程连接释放。

### P6 — HTTP MCP、安全与部署门禁

工作：
- MCP Streamable HTTP 按选定协议与目标 Host 协商，身份绑定 MCP caller，不用 MCP session ID 代替认证。
- 接入兼容 OAuth 身份服务，校验 token issuer/audience/scope/过期；Connector credential 与 MCP token 隔离。
- 实施 HTTP Origin/Host、DNS rebinding、请求体/连接限额、TLS 与反代配置测试，具体要求遵守所选 MCP 规范。
- 审计默认不记 prompt/输出/secret；参数与错误脱敏，限制结果库读取、保留和导出。
- schema 外部引用限制、路径/配置注入、认证洪泛、假 Connector、恶意 stream frame 等专项测试。
- admin 撤销、设备轮换、Gateway 隔离恢复/旧范围拒绝与本地权限检查，不能复活备份后的撤销或配对权限。
- 整理最小部署脚本/服务配置方案；不自动将开发模式的裸 WS 暴露公网。

交付：安全检查表、威胁模型测试、运维手册、兼容 MCP 客户端证据。
退出门禁：跨 caller 读不到机器/结果/订阅；撤销后拒新请求并终止流；日志扫描无植入的假 secret；HTTP 正式部署不依赖裸固定 token；安全检查无未解释的高风险缺口。

### P7 — 真实多机联调、治理场景和发行

工作：
- 至少两台真实机器以出站连接方式部署，不使用 SSH 数据通道；验证不同名字、相同 pane 编号与至少两个 session。
- 一份安装产物分别跑 gateway/connector；启动帮助、配置校验、升级兼容、降级/备份流程齐全。
- 在临时仓库完成真实多轮 agent 对话、任务依赖、租约冲突、worktree、测试门禁、retry、merge 冲突及清理。
- Provider 超时与 stalled 用 mock provider/可控 fixture 注入，不读取真实密钥、不故意影响用户付费工作。
- 每个阶段都保留实际失败与未验证项；实际机器不足则标明“本地双 Connector 模拟”，不得称远端多机实测。
- 对所有已发现方法生成覆盖账本；高权限变更做代表性实验，不为了凑覆盖执行不可逆删除/安装。
- 提供 README、示例配置（无密钥）、协议版本、数据迁移、权限风险、操作手册和结果报告。

交付：候选发行包、部署说明、真实测试报告、覆盖矩阵、已知限制。
退出门禁：满足第 6 节最终验收；未通过项写进发布阻断或明确版本边界。

## 5. 自动化测试矩阵

| 编号 | 场景 | 断言 | 层级 |
|---|---|---|---|
| T01 | 重名、改名、删除后重注册 | ID 稳定/不复用，唯一约束 | 单元/存储 |
| T02 | enrollment 过期、重放、并发消费 | 仅一次成功，无 secret 日志 | 集成 |
| T03 | 两机同 pane/workspace 显示编号 | 精确 machine + session 路由 | E2E |
| T04 | Gateway/Connector/原生任一层错误 | 不伪造 UHP result，不丢 error.data | 契约 |
| T05 | schema $ref、条件分支、版本不匹配 | 裁剪结果完整，不错接受参数 | 单元/契约 |
| T06 | 同范围 client_request_key 重试/不同参数 | 返原状态/报冲突，不重复执行；内容过期不新建句柄 | 集成 |
| T07 | UHP 派发前断线 vs 执行后断线 | not_dispatched vs unknown，无写重放 | 故障注入 |
| T08 | Gateway 重启/重复设备/旧 epoch 响应 | 不假 online、不串在途调用；旧恢复代次也拒绝 | 故障注入 |
| T09 | events replay gap、overflow、restart | resync_required，不能伪装连续 | 流测试 |
| T10 | terminal identity 过期/控制竞争 | 原生拒绝保留，无自动降级 | 真 UHP |
| T11 | 慢订阅者、大结果、多并发 | 配额生效、可读完整对象、内存有界 | 压测 |
| T12 | revoke/轮换/跨主体读取句柄 | 所有入口一致拒绝，secret 隔离 | 安全 |
| T13 | Host 无 session 运行 / admin 禁权 | 正确 profile；无暗中启动服务 | 真 UHP |
| T14 | 恶意文件名、参数/环境注入 | shell=false，不越过固定本地边界 | 安全 |
| T15 | prompt 回显与状态误报 | 不把回显或 done 当完成证据 | agent 实验 |
| T16 | 取消 MCP 或杀 bridge 后原任务继续 | 不声称远端回滚；unknown 可对账 | 故障注入 |
| T17 | SDK/协议版本与 stdio/HTTP | 所选版本的元数据/握手、认证、分页/错误兼容 | 客户端联调 |
| T18 | 新方法/未知流能力出现 | 可发现；未知安全分类/子动作默认拒绝，Owner/raw-contract 不绕过 | 兼容性 |
| T19 | 分类未知 vs 仅参数 schema 不足 | 作用/高权限/秘密结果可信分类独立于参数验证，凭据秘密不进普通结果 | 契约/安全 |
| T20 | 内容/句柄/墓碑分期及容量压力 | 固定期限、内容不复活、墓碑不提前丢；全库含 WAL/备份且准入有界 | fake clock/存储 |
| T21 | 范围退役/墓碑清理/丢失历史 | 已存在 key 返回原状态，旧或未知范围未找到 key 则拒绝新建 | fake clock/恢复 |
| T22 | 备份后撤销/配对消费/调用送达再回滚 | 先隔离、旧认证失效、策略重授权、旧 key 不重放，期限不重置 | 恢复故障注入 |
| T23 | unknown 后同 attempt 晚到/冲突/内容过期 | 只补可靠证据，不重派、不续期；错 epoch/恢复代次/attempt 隔离 | 调度/故障注入 |

优先以 deterministic mock 测故障状态，再用真实 Luvus 验证关键路径。运行平台、网络、版本、commit、命令、退出码、原生回复与副作用断言都应进入测试证据。

## 6. 最终验收：以用户工作流为准

### A. 安装与身份
- 相同发布产物可启动两个角色；两台机器主动连上，不配置 SSH。
- 主 Agent 可获授权创建注册记录，目标管理员完成配对；ID/name 查找明确，credential 不进模型上下文。
- Connector 重启仍用同一 ID；撤销与重新配对行为可解释。

### B. 完整的通用操作
- 主 Agent 先 describe 再 call，跨至少五类方法族成功，证明非硬编码 agent 工具。
- session 与 Host 能力分别发现；原生 result/error、revision 和幂等参数不被丢弃。
- 安装版本所有方法/流能力都有分类；被策略禁用与尚未实现明确区分。
- 写操作目标是 machine_id + 显式 profile/session；不靠“当前机器”。

### C. 可靠性与安全
- 丢回复后没有重复执行非幂等操作；返回 unknown 并有只读对账路径。
- 事件可恢复或明确 resync，终端 lease 正确，慢读者不爆内存。
- 主体 A 不能借同名机器、结果/流句柄或通用 call 获取 B 的权限。
- Owner 风险与 Host admin 授权显式，不把路径/session 规则当沙箱。
- 未知安全分类默认拒绝；参数 schema 缺口独立展示，显式 raw-contract 不绕过分类和秘密结果交付。
- 内容/句柄到期、去重墓碑窗口及全库预算分别验收；过期/清理、晚到回复与备份恢复不能再生原文。
- 备份恢复先隔离，旧凭据/配对/ACL 不自动生效，旧历史范围缺 key 不触发重发；可靠同 attempt 晚到只补证。

### D. Agent 治理演示
- 同一 pane 连续三轮：建立 nonce/记忆 → 追问 → 改动临时文件并独立断言，明确每轮完成。
- 输出等待的完成标记不能原样出现在 prompt 中：可要求 agent 返回两个已知片段的组合，并在最终 agent 消息/文件或 JSONL 结果中验证来源，而非匹配输入回显。
- Pi 的 no_positive_state_evidence 已知；status done 只当提示，不能作为完成门禁。若需读取原生会话记录，只读取本测试创建并绑定的文件，不扫描用户其他会话。
- 两任务相同路径冲突、依赖等待、门禁失败、retry 保存旧 attempt、merge 冲突 blocked、人工授权后处理、清理按顺序完成。

## 7. 文档与交付包

建议后续项目包含：
- DESIGN.md / IMPLEMENTATION-PLAN.md / ADR 目录。
- CLI 与配置参考：gateway/connector、状态目录、固定 binary/实例、配额、TLS/OAuth、配对与轮换。
- Wire protocol：版本、帧、状态机、错误、流与取消。
- Capability coverage：binary/server/schema/SDK/平台版本及每方法分类。
- TEST-REPORT.md：真实通过/失败/未验证，不只列测试名字。
- OPERATIONS.md：重启、unknown 对账、offline、泄露撤销、backup/migration、磁盘满、证书过期。
- SECURITY.md：Owner 权限、agent prompt 的执行风险、日志和结果保留、报告渠道。
- ADR 0002：四项已采纳原则、可配置默认值及 #4/#5 尚未实现的验收要求。
- 无真实密钥的示例配置和部署说明。

## 8. 工期与排期建议

粗估为单个熟悉 TypeScript/网络协议工程师的有效工作日，不是承诺日期，也不是 Agent 运行时长：

| 阶段 | 估算 |
|---|---|
| P0 | 1–2 天 |
| P1 | 2–3 天 |
| P2 | 2–3 天 |
| P3 | 2–4 天 |
| P4 | 2–3 天 |
| P5 | 3–5 天 |
| P6 | 3–5 天 |
| P7 | 2–4 天 |

合计约 17–29 个有效工作日；外部认证、跨平台、真实网络和高级终端子协议可能增加工作量。P0 后再重新估算，不用这些数字推导自动交付承诺。Linux 核心预览可在 P3 后交付，但必须标注限制。

## 9. 风险、阻断与降级

| 风险 | 应对 | 是否可跳过 |
|---|---|---|
| 目标平台 endpoint 发现兼容性不同 | P0 实证 session list 的 endpoint；不猜内部路径 | 完整流支持不可跳过 |
| 本地 schema 与运行 server 不同 | hash/版本分离、严格拒绝；完整安全分类下 Owner 才可显式放宽参数验证 | 不可静默降级 |
| 只有单次 proxy | 先 RPC 预览；补持久流和 Host | 不可称全功能 |
| Connector 凭据被复制 | 重复连接拒绝、轮换/撤销、显式 takeover | 不可省略 |
| Provider 错误导致 agent 停滞 | 区分链路、Luvus、Provider，展示输出，不盲目重发 | 不可伪报完成 |
| 数据/日志含秘密 | 默认少记录、限制结果、脱敏与系统加密、短 TTL | 安全门禁 |
| 只有本地模拟两机 | 发布说明写未做真实多机测试 | 不能冒充验收 |
| 既有草稿不符合契约 | 差异审计；重用须通过同一门禁 | 不因已有代码减标准 |
| 高权限误操作 | 显式目标、双层策略、外部审批、隔离测试账号 | 不靠 prompt 约束 |
| 旧备份复活撤销/配对/去重 | 先隔离、旧认证失效、旧范围拒绝、独立重新授权；不以记录缺失证明未执行 | 不可跳过 |
| 墓碑有限期限与容量不足 | 范围退役阻止旧 key 新建；拒绝新准入，不提前删除承诺期内去重 | 不可隐瞒边界 |

## 10. 后续启动开发前需要确认

建议默认：单管理员、Linux Gateway、Linux/macOS Connector、单活 SQLite、开发 stdio、正式 HTTPS MCP；Owner/Host admin 默认关闭但可显式授权。
尚需确认的部署选择：Gateway 实际运行位置和可达地址、首批目标 OS、兼容 MCP Host、OAuth 服务、能否提供两台真实测试机器。现在无需索要这些信息才能完成文档；它们是 P0/部署阶段输入。

Linux P0 已通过。四项 v0.3 原则已由用户采纳，默认值与具体文档修订待父会话验收；之后由父会话派发 #4/#5，并同步其 GitHub issue。当前只获授权做本地文档修订，不由此启动功能开发、真实恢复或凭据操作。

## 11. 来源与核验边界

底层协议来源及版本说明见 DESIGN §18。实施方案的阶段、工期、测试矩阵和默认预算是作者建议，不是官方产品承诺。
v0.2 最初只有只读 help/schema；后续 Linux P0 已有 [原生复核证据](p0/REVIEW.md)。本次 v0.3 仅做本地文档一致性自查，以上新增测试属于后续验收要求，没有在本次实施，也没有验证新的 Gateway/Connector 功能。
