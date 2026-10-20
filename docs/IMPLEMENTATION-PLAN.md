# Rovloom 实施计划

[DESIGN](DESIGN.md)定义最终有效的系统语义；本计划只维护能力差距、交付依赖与验收门禁，不重复定义 Target、授权、Wire 字段或保留默认值。文档入口见 [导航](README.md)。测试命令与可复现输入分别由开发/协议指引维护；具体提交、执行日志、测试批次和评审进度留在 CI/PR。

## 1. 可复用能力与实现差距

| 边界 | 可复用能力 | 尚须交付 |
|---|---|---|
| 原生证据 | 固定 Luvus Linux 契约、RPC/Host/事件/终端输入及离线回放；Linux x64 同机双角色 Herdr `ping` 产品 smoke | 各目标版本/平台、实际客户端、HTTP/OAuth、真实双机及 Herdr 模型对话验收 |
| 工具链 | Bun、严格类型检查、冻结依赖、模块 build/smoke、单文件 CLI、六目标编译/Gateway 产品 smoke 工作流及 tag 发行配置 | 各次发行仍须通过实际目标门禁，见 [发行指引](DISTRIBUTION.md) |
| Native validator | Bun Worker 完整预检、standalone 资产复用与完整编译、期限/取消/迟到拒绝、完整 schema 校验、多轴分类/权限、raw 范围 grant、opaque permit；Luvus/Herdr 来源工厂已接产品宿主 | 各目标原生来源验证；任意外部 schema 自动接纳及硬 CPU/heap 隔离不在首版范围 |
| Wire 2 | 严格 codec/协商、provider/context、重复抑制、对象重组、流状态、持久 history/晚到事务、Herdr 普通拒绝消息 codec，以及认证 WSS RPC 宿主接线 | 剩余流能力的产品接线、真实多机故障验收 |
| Luvus 集成 | 生产原生来源与远端 Gateway 接线、真实 NativeValidator、准入/发送/账本提交、独立 input permit/ack、frame 读取门禁、有界响应上下文及回收 | 真实跨网络双机、各目标原生环境与完整事件/终端工作流验收 |
| Store/Router | 规范 v5 SQLite、provider/binding 账本与 grant、固定内容期限、持久 history、全库/子额/预约、降级、隔离快照、事务晚到接线；产品身份/管理来源与跨平台普通文件接入；列表与结果无状态分页 | 列表查询和完整结果读取成本；备份/隔离恢复的服务级运维入口 |
| 设备通道 | 生产 WSS/loopback RPC、持久 hash 身份、一次性证明/socket 失效、原生 adapter/CLI 接线及 Linux x64 所选 Luvus/Herdr 来源的首次配对与初始化 | offline/revoked 重配重置、凭据轮换的完整产品流程与真实多机验收 |
| 产品服务 | 双角色 CLI、MCP Streamable HTTP、Store/Router 查询及清理、请求认证、生产管理 session/CSRF/custody、原子准入与持久 claim、Luvus/Herdr catalog、WebUI 确认/回执及认证后恢复 | provider 重新启用证明、所选实际 MCP Host/OAuth、完整工作流与发行部署验收 |
| 开机服务 | Linux systemd、macOS 系统域 LaunchDaemon 与 Windows 既有用户 BootTrigger 的 Gateway 生产宿主；Linux x64 Connector 服务；前后台共用角色配置；见 [SERVICE](SERVICE.md) | 三平台重启开机实测及部署环境验收 |
| Herdr | 最多 65 个普通 RPC、独立原生来源/Worker、Store/Wire/结果锚点与持久 claim；唯一 CLI loader、mixed runtime、HTTP MCP 目录及 Herdr/mixed 首次配置向导 | 同会话真实两轮及模型出口、其余 37 方法、原生跨平台和实际双机部署验收 |
| 直接终端执行 | 本地布尔开关、共享方法/参数判定、Luvus/Herdr 最终写入复查、持久 claim 后关闭及断连不重派、单文件 CLI 开关、通用宿主目录状态转发及 Herdr 普通拒绝闭环；见[终端执行](TERMINAL-EXECUTION.md) | 隔离原生命令、逐命令退出证据和独立双向控制验收 |

Store/Router 使用 Wire V2Target 与完整 tuple grant；native validator 仍由 integration 显式投影
profile Target，provider fence 独立核对。生产宿主必须注入真实认证、双端本机 binding、原生
来源与契约/分类；persisted backend 不制造这些事实。实现边界与操作见[存储运行指引](STORAGE.md)。

当前规范 schema 从全新库建立，未发布旧版/未知 schema 明确拒绝且源文件不变，不提供旧库
迁移或 legacy binding 入口；不得为旧历史补默认 provider/scope、换 key 或重新执行。

### 包与命令兼容边界

产品名统一为 Rovloom。`package.json` 的实际包标识仍为 `luvus-mcp`；其迁移需要同步 package/lock、消费者与构建验证，作为独立代码交付项，不能通过文档替换伪装完成。该标识只用于解释现存技术兼容，不作为产品或拟议命令名。

唯一 CLI 已装配 Gateway/Connector 生产宿主、角色配置与 MCP facade；
不支持的宿主环境或缺少必需来源仍明确拒绝。支持平台和后台入口以发行/服务指引为准。
本地命令及宿主接口见 [MCP Streamable HTTP 契约](protocol/MCP-HTTP.md)。
原生 `luvus`、`herdr` 命令及 UHP/原生字段保留原义；`luvus_*` 若交付，只能是 DESIGN 规定的受限 Luvus 兼容别名。

## 2. 交付顺序

```text
安装契约/原生证据 → 公共协议与校验器 → 持久化/授权/恢复
                                            ↓
                                  配对认证与设备 WSS
                                            ↓
                              Luvus RPC + MCP Streamable HTTP
                                            ↓
                         多机可靠性/Host → 事件与终端
                                            ↓
                          HTTP 授权/内置管理 UI → 发行
Herdr 固定契约/普通 RPC → 独立来源与共享 Store/Wire → 唯一 CLI/MCP 联合验收
```

安全门禁从最早切片生效，不延后到发行阶段。管理 UI 依赖可信管理员认证、设备/provider 管理和持久化后端；不以页面替代后端。Herdr 证据可以独立准备，但通过原生测试后仍须逐项完成相同产品接线和隔离门禁。

## 3. 长期交付项

以下保留最终实现约束与联合验收要求；其中已有能力的当前状态以第 1 节为准，
不能把每项要求都解释为尚未实现。

### 3.1 统一模型、原生契约与宿主接口

- 将业务 registry、Store、Router、策略、摘要及句柄统一到 DESIGN 的 provider/binding/contract 模型；保留 Wire/native 显式接缝，避免给旧类型加 optional provider 默认值。
- 为集成 backend 提供独立当前认证、登记 attempt、双端配置、契约/分类、endpoint 来源、policy、真实确认、custody、可信时间及 durable response anchor。缺任一必要来源拒绝，不从消息构造 true。
- Luvus `compileBundle` 通过 Bun Worker 完整预检后精确复用构建期完整 standalone 资产，未命中仍完整编译；2 秒接纳期限、取消、单在途准入和任务代次拒绝迟到产物。宿主核对编译器版本、实际来源身份、生成选项、摘要、完整导出及 helper 白名单后只加载生成函数，登记本进程 opaque handle；同步 NativeValidator/Wire/事务接口保持不变。接纳实际本地安装 bundle 并按协议/接口判断，版本用于诊断，不开放外部 schema 或任意生成代码加载；首版无硬 heap 或物理退出时限保证，边界以 [DESIGN §8](DESIGN.md#8-能力发现契约与派发授权)为准。角色宿主仍须在就绪前等待工厂，并将关闭/取消信号传入初始化；不能把跨 Worker 复制对象恢复成许可。
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

交付：规范 SQLite schema、fake clock/真实磁盘故障测试、本机受保护恢复接口与运维说明。备份/隔离恢复的服务级运维入口仍待交付；不提供跨重启的响应上下文恢复或重放。

### 3.3 设备身份、配对与 WSS

当前模块及隔离验证范围见[通道接线](TRANSPORT.md)。listener / 出站连接已复用现有 Wire 和
持久账本；独立 hash-only 身份库、一次性证明、配对/轮换专用 custody 和精确 socket 封锁已与受保护
Store 身份桥完成隔离组合验证，并已接入生产 CLI 的管理员与配置来源。
剩余流接线、重配/轮换产品流程及真实多机仍须完成以下门禁。

Gateway 已提供独立的[可信只读观测端口](TRANSPORT.md#可信只读观测)：实际认证连接、
接收心跳和逐 provider 派发门禁由内部事件及当前 fence 复验，持久 online 不补作实时事实。
管理快照的授权组合及 HTTP 已接产品服务；原生 runtime 状态仍须来自实际连接与来源证明，缺来源保持未知。

- 实现一次性 enrollment 签发/受保护交付、原子兑换、独立设备认证、撤销/轮换、重复连接拒绝与授权 takeover；凭据不入模型、URL、argv 或日志。
- Store 提供受保护的 verified 连接及同 ID 重配桥：注入独立一次性凭据校验证明、管理确认与 epoch fence；重配提交后按设备作用域释放执行/仅响应上下文和分片，跨库失败保留外部 blocked，不宣称双库原子提交。接口与失败顺序见[存储运行指引](STORAGE.md#独立身份库的设备生命周期桥)，身份/WSS 宿主仍须实现证明消费、同步通道阻断及新配对完成后的解锁。
- 实现 TLS、握手协商、心跳、退避重连、认证 epoch 与恢复代次绑定；socket 已连接不等于 ready，离线不排队变更。
- 实现双端 binding/revision 核对、provider 禁用与设备撤销的独立事务/资源处理；一个 adapter 故障不撤其它 provider 权限。

交付：Gateway listener、Connector 出站通道、管理后端与可信状态观测。

### 3.4 Luvus RPC、MCP 与多机可靠性

认证通道已有原始 Wire RPC hook、精确 attempt 的取消观察传递、受控响应对象发送/重组、活原请求读取及原 permit 保留检查 port，接口见
[transport 接线](TRANSPORT.md#原始-wire-执行接缝)。隔离 IPC 组合不替代生产 peer/auth/唯一
claim、公共发现/结果分页或真实HTTP/MCP 联合验收；各层继续保留自身原请求状态和提交归属。

- 交付固定 binary/root、shell=false 的 RPC/Host adapter，以及目标平台的本地 endpoint/peer 验证；发现/缓存按完整来源隔离。
- 实现 DESIGN 的通用机器/provider/runtime 工具面及 Streamable HTTP facade，短 wait 与执行 deadline 分离，大结果有界分页，原生 result/error 深度保真。
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

### 3.6 Herdr 普通 RPC 与剩余验收

已在 Linux x86_64 接入最多 65 个 Herdr 方法（以实际安装 schema 为准，版本仅作诊断），覆盖 workspace/tab/pane/Agent
普通 RPC、原始完整 schema 校验、当前双端策略与完整 Target、原 Store 内容/响应锚点、
独立 Connector 准入记录及持久唯一 claims。模块不添加第二套设备、CLI、provider registry 或 Store。

- 唯一 CLI 已接入两个资源工厂和 provider 目录，复用现有 MCP/管理宿主；Linux x64 首次配置支持 Herdr/mixed，继续以实际原生环境联合验证单设备多 provider。
- 完整 65 方法静态 policy 及启动/工作流回归输入已在库；确定性方法矩阵只证明源码/schema 覆盖，不授予执行。输入中的原生采集声明与完整管理工作流仍须逐项实测。
- 待在允许的模型出口完成同一真实会话两轮；Agent 启动、prompt 提交、状态等待与真实回答分别验收。
- 待其余 37 方法及独立事件/流、Host、raw 能力的设计和交付；不以名称猜测开放。
- 待原生跨平台、实际双机与发行部署验收；保留未通过的完整回归结论，局部通过不替代。

observer 被动读、原生 cancel、原子 terminal fence、共同事件序号/replay 和 per-turn receipt
继续保持未提供，不能由静态盘点、schema 成功或 `agent.wait`状态补造。

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

部署方需选择 Gateway 地址、目标 OS/原生版本、MCP Host、身份服务、TLS/代理及真实双机环境；相应输入与实证不足阻断对应支持声明，不阻断维护系统设计。Herdr 原子写入/终端保证、observer 精确被动读允许集与完全无 bundle raw 属于 DESIGN 所列待设计决策，不能由普通 RPC 实现默认值擅自开放。

任何可用切片都必须披露边界：模块可校验不等于已认证传输，原生 P0/P0-H 不等于服务已接线，Linux 成功不等于跨平台，工具链成功不等于产品上线。实现落后由本计划追踪，不能反向降低 DESIGN 的多 provider 与安全要求。
