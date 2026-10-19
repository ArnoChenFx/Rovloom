# Rovloom 实施计划

[DESIGN](DESIGN.md)定义最终有效的系统语义；本计划只维护能力差距、交付依赖与验收门禁，不重复定义 Target、授权、Wire 字段或保留默认值。文档入口见 [导航](README.md)。测试命令与可复现输入分别由开发/协议指引维护；具体提交、执行日志、测试批次和评审进度留在 CI/PR。

## 1. 可复用能力与实现差距

| 边界 | 可复用能力 | 尚须交付 |
|---|---|---|
| 原生证据 | 固定 Luvus Linux 契约、RPC/Host/事件/终端输入及离线回放 | 各目标版本/平台、实际客户端、HTTP/OAuth、Herdr 独立证据 |
| 工具链 | Bun、独立严格类型检查、冻结依赖、模块 build/smoke、隔离验证入口 | 各发行平台验证、服务可执行入口与发行配置 |
| Native validator | Linux x64 硬预算 bundle 编译、完整根/引用/条件校验、多轴分类/权限、raw 范围 grant、opaque permit、响应/事件/控制校验 | 其他平台隔离、受信生产分类与来源提供方及宿主生命周期接线 |
| Wire 2 | 严格 codec/协商、显式 provider/context、内存去重、对象重组、流状态、历史准入/晚到证据计划 | 真认证/WSS、持久化事务、实际发送/重复抑制/资源释放的宿主接线 |
| Luvus 集成 | Wire 接真实 NativeValidator，独立 input permit/ack、frame 读取与原文保留门禁、有界 RPC 仅响应上下文及生命周期回收 | 生产 backend；安全接收、准入、发送、账本提交的端到端联动 |
| Store/Router | 规范 v4 SQLite、完整 provider/binding 账本与 grant、固定内容期限、持久 history、全库/子额/预约、降级、隔离快照、同 epoch 的 metadata-only 事务晚到接线 | 生产管理/认证来源、跨平台验证及服务运维入口 |
| 产品服务 | 受信宿主 WSS/loopback RPC、持久 hash 身份、一次性证明/socket 失效与专用交付模块、隔离模拟 Connector | Gateway/Connector 角色 CLI、MCP facade、生产宿主、原生 adapters、管理 UI 和部署发行 |
| Herdr | 固定官方 binary/schema 来源、完整根回放、专用边界/并发验证器、只读原生编解码与共享 attempt 接缝 | P0-H 副作用覆盖与独立评审、精确生产 allowlist、硬预算 schema 编译、可信原生 backend、共享门禁与实际网关接线；写入/终端另行设计 |

Store/Router 使用 Wire V2Target 与完整 tuple grant；native validator 仍由 integration 显式投影
profile Target，provider fence 独立核对。生产宿主必须注入真实认证、双端本机 binding、原生
来源与契约/分类；persisted backend 不制造这些事实。实现边界与操作见[存储运行指引](STORAGE.md)。

当前规范 schema 从全新库建立，未发布旧版/未知 schema 明确拒绝且源文件不变，不提供旧库
迁移或 legacy binding 入口；不得为旧历史补默认 provider/scope、换 key 或重新执行。

### 包与命令兼容边界

产品名统一为 Rovloom。`package.json` 的实际包标识仍为 `luvus-mcp`；其迁移需要同步 package/lock、消费者与构建验证，作为独立代码交付项，不能通过文档替换伪装完成。该标识只用于解释现存技术兼容，不作为产品或拟议命令名。

尚无可运行的 Gateway/Connector 服务 CLI，不能给出虚构的 `rovloom gateway` 或旧包名启动命令。原生 `luvus`、`herdr` 命令及 UHP/原生字段保留原义；`luvus_*` 若交付，只能是 DESIGN 规定的受限 Luvus 兼容别名。

## 2. 交付顺序

```text
安装契约/原生证据 → 公共协议与校验器 → 持久化/授权/恢复
                                            ↓
                                  配对认证与设备 WSS
                                            ↓
                              Luvus RPC + MCP stdio
                                            ↓
                         多机可靠性/Host → 事件与终端
                                            ↓
                          HTTP 授权/内置管理 UI → 发行
Herdr P0-H → 被动读/事件语义评审 → 独立 adapter → 同一网关接线
```

安全门禁从最早切片生效，不延后到发行阶段。管理 UI 依赖可信管理员认证、设备/provider 管理和持久化后端；不以页面替代后端。Herdr 证据可以独立准备，但通过原生测试后仍须逐项完成相同产品接线和隔离门禁。

## 3. 长期交付项

### 3.1 统一模型、原生契约与宿主接口

- 将业务 registry、Store、Router、策略、摘要及句柄统一到 DESIGN 的 provider/binding/contract 模型；保留 Wire/native 显式接缝，避免给旧类型加 optional provider 默认值。
- 为集成 backend 提供独立当前认证、登记 attempt、双端配置、契约/分类、endpoint 来源、policy、真实确认、custody、可信时间及 durable response anchor。缺任一必要来源拒绝，不从消息构造 true。
- Luvus 的 Linux x64 硬预算工厂落实 [DESIGN §8](DESIGN.md#8-能力发现契约与派发授权)的 2 秒/64 MiB 限制，保持同步 NativeValidator/adapter 与进程内 opaque handle 边界；资源按每个原生进程计量，具体范围见[隔离执行边界](protocol/SCHEMA-ISOLATION.md)。生产宿主仍须提供受保护产物、已核验 registry 并接通安装退役/释放；其他平台与 Herdr 编译入口独立交付，不以同步编译回退。只接纳已审核 bundle，不开放任意外部 schema 自动编译。
- 确认完全无 bundle 的 raw 路径之前维持拒绝；已有 generic 参数 raw 保留现有约束及实际 validation 标记，不借此降低分类/来源标准。

交付：统一数据模型、可信来源工厂、隔离编译宿主及自动化正反例。Wire 编码与 native 签名只在各自规范维护。

### 3.2 持久化、预算与恢复

- 只创建当前规范 schema，明确拒绝旧版/未知版本且不修改源库，不建立 legacy binding 或历史兼容入口。
- 实现 provider-scoped 双端授权，调用/attempt/原生 ID/契约和 policy revisions 持久锚点；派发前提交与预算预约成功才允许写出。
- 持久化 history scope、冻结期限、请求摘要/墓碑及原子准入/冲突；Wire 的纯计划函数须在同一 writer 事务中使用，恢复/重试不换范围。
- 实现固定内容/句柄/墓碑/审计期限与全受管存储预算，覆盖内联、对象、WAL/SHM、日志、备份、临时文件；读取与保留授权分别执行，禁存/过期/discard 不复活原文。
- 实现 storage_degraded 的副作用入口封锁、最小 durable 锚点、提交失败不假报结果/撤销；不得通过提前删墓碑或无限日志弥补容量。
- 实现隔离恢复、新 recovery_generation、旧凭据/配对/范围失效、ACL 默认拒绝、binding 重新确认、恢复原文保守不可读；解除隔离不恢复旧队列。
- 实现同一有效 attempt 的事务晚到补证、重复幂等与冲突隔离；丢失原生上下文、旧 epoch/恢复代次、provider 禁用等不能补写或重新派发。
- RPC 原文清理后只保留从真实 permit 密封的最小响应约束，独立计量与按期释放；SQLite 清理失败也不依赖后续访问回收内存原文。证据提交失败仅允许原有效上下文恢复对账，不恢复派发能力。

交付：规范 SQLite schema、fake clock/真实磁盘故障测试、本机受保护恢复接口与运维说明。服务级运维入口仍待交付；不提供跨重启的响应上下文恢复或重放。

### 3.3 设备身份、配对与 WSS

当前模块及隔离验证范围见[通道接线](TRANSPORT.md)。listener / 出站连接已复用现有 Wire 和
持久账本；独立 hash-only 身份库、一次性证明、配对/轮换专用 custody 和精确 socket 封锁已与受保护
Store 身份桥完成隔离组合验证。生产管理员/配置来源、全局预算分配、流接线及真实多机
仍须完成以下门禁。

- 实现一次性 enrollment 签发/受保护交付、原子兑换、独立设备认证、撤销/轮换、重复连接拒绝与授权 takeover；凭据不入模型、URL、argv 或日志。
- Store 提供受保护的 verified 连接及同 ID 重配桥：注入独立一次性凭据校验证明、管理确认与 epoch fence；重配提交后按设备作用域释放执行/仅响应上下文和分片，跨库失败保留外部 blocked，不宣称双库原子提交。接口与失败顺序见[存储运行指引](STORAGE.md#独立身份库的设备生命周期桥)，身份/WSS 宿主仍须实现证明消费、同步通道阻断及新配对完成后的解锁。
- 实现 TLS、握手协商、心跳、退避重连、认证 epoch 与恢复代次绑定；socket 已连接不等于 ready，离线不排队变更。
- 实现双端 binding/revision 核对、provider 禁用与设备撤销的独立事务/资源处理；一个 adapter 故障不撤其它 provider 权限。

交付：Gateway listener、Connector 出站通道、管理后端与可信状态观测。

### 3.4 Luvus RPC、MCP 与多机可靠性

- 交付固定 binary/root、shell=false 的 RPC/Host adapter，以及目标平台的本地 endpoint/peer 验证；发现/缓存按完整来源隔离。
- 实现 DESIGN 的通用机器/provider/runtime 工具面及 stdio facade，短 wait 与执行 deadline 分离，大结果有界分页，原生 result/error 深度保真。
- 用真实 SDK 客户端验证工具发现、参数、结构化结果与错误；所选 MCP revision 不自动继承其它 revision 兼容性。
- 在派发前后、原生执行前后、响应接收/提交前后注入故障；没有未写出证明就 unknown，不把 submitted/queued 当业务完成。
- 验证 Host 独立权限/真实确认，stop/restart 丢回复只读对账；两台设备及多个 provider 的同名 ID 不能串路由。

交付：可运行角色入口、单机垂直切片、两机可靠性与 Host 实证。仅本地双 Connector 模拟不能标真实远端多机。

### 3.5 流、input permit 与内容交付

- 接通开流 ack/原同一份 permit、逐 action input 独立许可/ID、input ack 选择、每 frame 当前读取检查；重复编解码不生成可重复执行许可。
- 宿主先消费消息重复判断，再执行实际发送；流外层 sequence、原生 sequence/identity、lease、队列背压分别处理，丢 ack 不重发输入。
- 实现 Luvus 事件 snapshot/replay/gap，observe 缺口 capture，关闭/撤权/禁用/到期释放 handle、本地资源及适用 lease；不自动关 pane。
- 高级图片/上传等子能力逐项实证，未适配明确拒绝；result.retention=none 的即时读取与 metadata-only 证据路径独立验证。

交付：真实事件/终端证据、资源测量与持续/双向流 MCP 工具。

### 3.6 Herdr 原生验证与有限切片

离线输入、方法门禁与归档命令见[开发指引](DEVELOPMENT.md#herdr-p0-h-离线输入)。
生产允许集保持为空；合成回放通过不减少以下原生证据要求，归档审计也不建立
可信 endpoint、安装来源或执行许可。

已有原生组件回放固定版本的 `ping {}` / `session.snapshot {}` RPC，执行候选仅限
`ping {}`，复用现有 provider/Store/Wire 身份和门禁；它不提供 socket backend、证据提交或 Gateway 服务。
共享 response anchor、失效订阅/关闭及请求回收后的最小仅响应上下文尚未接入，不能直接
替代 transport 的完整 adapter，也不表示真实 Store 的 TTL 后证据路径已经接通。
`ping` 只满足健康核对；snapshot 的公共前置标题同步及活动 UI/agent/通知覆盖仍需
分类评审。当前不得把候选接口或安装 schema 回放称为默认状态接入已完成。

- P0-H 固定官方 binary 来源/hash、安装 schema/方言/闭包、实际 ping/protocol、endpoint 归属/peer、framing/大小及断线行为，使用自建隔离实例。
- 按 method+params+版本核实被动读，断言焦点、viewport、输入、agent 状态/通知均无未声明副作用；recent 等未经证明不进 allowlist。
- 验证订阅确认、events_lost/EOF、另一连接 snapshot 与脏刷新，明确 gap/state_rebuild_only，不重放载荷覆盖快照或伪造序号。
- 在评审过的精确范围上实现独立 adapter，再接入同一 registry/policy/账本/MCP；Wire 的 Herdr candidate 拒绝须经相应代码交付和验收后才可改变。原生实证不是系统就绪证明。
- 写入/终端、幂等/ack、incarnation TOCTOU、prompt 完成归属、取消及副作用读取另立设计门禁；未定默认拒绝，不模拟 UHP 保证。

交付：可复现原生输入、精确分类/允许集、有限切片及多 provider 隔离测试；不宣称完整 Herdr 控制。

### 3.7 管理 UI、HTTP 与发行

- 按 [管理 UI 规范](GATEWAY-WEBUI.md)交付独立认证/listener、设备/provider 状态、配对申请、断开/撤销/启停、后台真实确认、revision 冲突及过期快照。
- 接入所选 MCP Host/兼容 OAuth，验证 issuer/audience/scope、Origin/Host、TLS/反代与限额；设备/MCP/管理身份不得混用。
- 完成实际平台、跨网络双机、升级/回退/恢复、磁盘满、证书过期及凭据泄露处置；构建统一产物和无密钥示例配置，迁移实际包标识及其消费者。
- 维护安装/配置/运维/安全参考、按版本/profile 的能力覆盖账本和发行范围。具体执行证据放 CI/PR，不在规范记录 main SHA、分支、worker 或测试批次。

交付：管理 UI、正式 HTTP 入口、可复现发行包及明确支持矩阵。

## 4. 关键联合验收

以下是交付断言，语义和默认数值引用 DESIGN，不在此建立第二套定义。

| 场景 | 必须证明 |
|---|---|
| 同设备 Luvus、Herdr、第二同 kind，复用 session/method/pane/native ID/key | 路由、分类、grant、缓存、结果、流、去重和晚到互不串实例；无跨 runtime retry |
| 错 kind/provider/revision/契约/epoch/恢复代次 | 所有业务入口拒绝，广告/JSON 不能建立来源、permit 或身份 |
| caller/local 完整 grant 交集 | 不产生笛卡尔授权，新 provider 不继承权限，Owner/raw/未知子动作仍过分类门禁 |
| generic 参数与未知分类 | 两种缺口独立；有范围 raw 不绕过已有约束、管理、确认、秘密或传输 |
| 开流/input/ack | 同一 permit 开流，每个 input 单独授权，实际 ack 按 input ID 选择；未知/未派发 ack 与 observe 写入拒绝 |
| 内容读取与保留 | 每条流 frame 都检查实际 payload；retention=none 可按当前权限即时读，但证据仅元数据；撤权/过期/discard 及全部读取路径不复活内容 |
| history 新意图与旧 retry | active/retired/unknown、边界同刻、配置缩短、墓碑/范围删除均不把旧 key 缺失当首次派发 |
| 晚到/重复/冲突 | 同一有效 attempt 可事务补证、保留超时历史，不重派/续期；错关联隔离，提交失败不发布终态 |
| 配额/磁盘/WAL/I/O 失败 | 全库计量、预留准入、派发前锚点、降级封锁；不提前丢墓碑，可能送达保持 unknown |
| 备份后撤销/配对消费/送达/discard，再恢复旧备份 | 先隔离、旧身份/范围失效、来源/ACL/binding 重确认；丢历史不变成未执行证明，原文不复活 |
| provider 禁用/重新启用、设备断开/撤销 | 独立权限/确认/fence/影响；新 revision 不复用旧流/句柄/attempt，设备撤销覆盖全部 |
| 真实 agent/终端流程 | 回显、status done、queued、旧 turn 状态均不冒充本次完成；以独立文件/最终消息/实际副作用对账 |

先用确定性 mock/fake clock 验证故障边界，再用隔离原生实例证明平台关键路径。真实实验只使用自己新建的状态根、session、pane、目录与临时仓库，不读取私人凭据或影响用户付费任务。fixture 中的来源 hash/version 是不可变测试输入，不是仓库开发进度。

## 5. 未决输入与发布阻断

部署方需选择 Gateway 地址、目标 OS/原生版本、MCP Host、身份服务、TLS/代理及真实双机环境；相应输入与实证不足阻断对应支持声明，不阻断维护系统设计。Herdr 写入/终端保证、精确被动读允许集与完全无 bundle raw 属于 DESIGN 所列待设计决策，不能由实现默认值擅自开放。

任何可用切片都必须披露边界：模块可校验不等于已认证传输，原生 P0/P0-H 不等于服务已接线，Linux 成功不等于跨平台，工具链成功不等于产品上线。实现落后由本计划追踪，不能反向降低 DESIGN 的多 provider 与安全要求。
