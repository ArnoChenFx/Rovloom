# Rovloom 管理 UI：最小管理面设计

本文定义内置管理页面、交互与管理 API；系统身份、授权、provider 生命周期、历史范围及恢复/预算规则以 [DESIGN](DESIGN.md)为唯一来源。实现差距与前置依赖见[实施计划](IMPLEMENTATION-PLAN.md)，文档职责见[导航](README.md)。以下是目标契约，不表示服务已交付。

## 可本地验证的展示模块

[展示入口](../src/webui/index.ts)提供无第三方 UI 依赖的列表/详情、分层状态和只读快照生命周期；
[读取组合层](../src/webui/read.ts)直接消费 [MCP/CLI 共享管理契约](../src/mcp/management.ts)，
不接收浏览器提交的 `AdminContext`、principal 或管理会话引用，不实现另一套身份服务。
宿主通过 `ManagementReadTransport` 接入既有受保护管理传输，每个读取仍由后端重新认证、核对精确目标与权限。
该传输须把公共失败映射为 `ReadError`；原始错误/正文不应传给页面。

当前构建同时输出 Bun 展示/宿主模块和 `dist/webui/` 静态资源，默认浏览器入口通过固定同源 GET 读取六项管理资源，
不自动启动管理 listener、提供登录/退出或加载测试数据。默认入口消费宿主受保护 HTML 的单次 CSRF meta，
并通过既有写客户端接入设备改名、断开和撤销的一次确认与回执流程；缺失或无效交付在网络发送前拒绝。
配对及 provider 页面操作仍不可用；没有后台一次性确认或持久提交证明时不显示成功。
展示、HTTP 接口测试通过不表示 issue #14、生产会话接线或真实设备链路已完成。

共享读取未提供设备 ready 证明、配对进度、最近连接/重连时间、OS/version、实际监听范围或管理员会话截止时间；
页面明确显示缺口。`persisted_state=online` 不填补 `Observed.verification=unverified`，
权限提示的 `expires_at` 与 history 截止时间均不作为登录期限。宿主如有可信管理会话截止信息，
可通过内部 `TimedSnapshot.sessionExpiresAt` 传递；未提供时依靠每次重新认证的读取，收到 401 即清空并停轮询。

读取前后核对全局模式、恢复代次、管理策略/history fence 及详情的设备 revision/epoch；变化拒绝混合快照，并取前后 status 较早的观测时间计算页面年龄。
设备、连接、认证、provider 登记与原生运行观测还分别按自己的 `observed_at` 和服务时间/单调经过时间计算十五秒过期；新 status 不续期旧子观测。过期状态只作历史展示，不显示绿色在线/ready；当前认证未核实不显示绿色在线，provider 运行观测或所依赖设备认证/链路未核实也不显示绿色 ready。
待配对登记不显示旧连接的在线或已认证徽标；新鲜原生运行观测仍可独立展示，但不能据此显示 provider 绿色 ready。
展示边界最多 200 行、512 KiB，并拒绝未知字段和越目标数据；HTTP 桥同时执行输入、输出和在途任务预算；这不替代宿主会话服务及共享业务授权。
恢复隔离仅读取并展示最小 status；provider 的 403/暂不可用单独显示，401 使整页失效；设备/整页读取不可见的404同样清空旧页并停止读取，provider/权限提示的局部404只降级该部分且仍复核设备，避免撤权后保留旧详情。
隔离 fixture 与真实 Chromium 的复现入口见[开发指引](DEVELOPMENT.md#管理页面的隔离验证)。

## 语言与主题

页面按开发者控制台组织：方形橙 R 与产品导航、语言/主题偏好和当前读取操作分层，
内容共享 1280px 最大宽度与 8px 间距基准。中性底色承担主要阅读，橙色仅用于品牌、活动导航、刷新和焦点；
明暗主题分别使用一致的正常、未知/警告、撤销/失败语义色，状态始终保留文字而不只靠颜色。
桌面设备页用固定列的行式列表对齐标识、连接/认证、Gateway 接收的最近心跳和各层观测年龄；
绝对观测时间在提示与详情中可读，未知与过期文字常驻。窄屏改为带字段标题的顺序布局。
详情将连接/认证、持久登记、观测来源和运行实例分区，provider 在同一列表内独立展示。
Gateway 的监听/认证缺口、组件状态和观测时间保持可见，只有恢复代次与策略标识使用可展开的诊断区域；
展开状态及键盘焦点在年龄重绘和本地化时保留。空、读取中和失败页面使用统一状态版式，
所有未接后端操作继续禁用，并展示原有含义与风险说明，不增加模拟统计或新管理操作。

顶栏使用翻译图标和系统/太阳/月亮图标按钮，点击后展开语言或主题选项，当前选择带勾选标记。
图标保留本地化无障碍名称、当前值说明与悬停提示；支持 Tab、方向键、Enter/Space、Esc 和点击外部收起，
选择后焦点回到入口，导航时收起面板。语言默认按浏览器优先级匹配中文或 English，
中文地区变体使用简体中文词典，其它语言回退 English；主题默认跟随系统，也可手选浅色或深色。
中英文词典以共享键类型和测试校验完整键集与插值；标题、`document.lang`、状态、公共错误、空态、
操作说明与无障碍名称同步切换，可信服务日期以本地化格式显示 UTC，相对时间继续使用原单调年龄。
设备名、标签、ID、原生方法和协议引用保持原文；固定错误说明附带原始协议码，不改变后端授权。

页面只把固定枚举保存在 `localStorage` 的 `rovloom.webui.language` 与 `rovloom.webui.theme` 两个键，
不保存身份、token、设备数据或快照。不合法或不可访问的存储回到浏览器/系统默认；保存失败时本页选择仍生效。
语言切换重绘当前快照、主题切换只更新 CSS 属性，均不新建 reader、不刷新/取消后台、不改路由或延长过期时间。
样式使用 CSS 变量与 `light-dark()` 共享色板，保留原方形橙 R、键盘焦点和窄屏布局，CSP 不放宽。
词典与偏好逻辑并入现有 browser/chunk，主题在现有 CSS 中。经典脚本 `theme.js` 在 CSS 前同步恢复已保存主题，
主模块延迟时也保持正确首屏；该资源是 HTTP 必需白名单，并由共享构建器静态导入、内嵌到单文件内存资源清单。

## 只读 HTTP 宿主桥

### 页面设备操作接缝

`mountWebUi(root, read, clock?, management?)` 可注入现有 `ManagementWriteTransport`，
在设备详情启用权限提示允许且当前快照有效的改名、断开和撤销入口。提示只控制入口，
每一步仍由原写服务验证管理员、CSRF、目标和资源 fence；不从浏览器生成管理员身份。
改名只接受 Store 现有名称约束，不提供尚未接入的标签修改。配对和 provider 操作继续显示不可用。

页面复用 `createDeviceManagementFlow`：准备只获取后台摘要；明确确认才提交。
对话框展示目标、名称或精确连接代次、revision、原因、原截止和撤销影响实例。
重复点击不产生第二次提交；准备失败只能由用户重新准备，丢响应或提交中取消只能查询原回执。
重新准备只允许失败、未提交、提交前已取消，或尚未提交且确认已过期的阶段；
已发送操作跨过确认截止仍保留原关联，不能通过重试按钮丢弃在途或未确认结果。
导航/隐藏会取消旧等待，迟到结果不能操作新页面；未确认关联仅保留于内存，可从页面入口重新打开核对。
语言/年龄重绘保留输入与稳定控件，确认截止使用现有可信服务时间锚点，不因刷新而延长。
会话或权限失效清空详情与确认内容。回执仅表达持久提交，物理通道未确认和 native 工作可能继续的含义保持可见。

注入客户端由宿主拥有并显式关闭。生产 `browser.ts` 调用 `createManagementPageCsrf`，
读取唯一的 `meta[name="rovloom-management-bootstrap"]`：`content` 为43字符 base64url CSRF，
`data-expires-at` 为实际 Unix 毫秒截止。查询后立即移除全部匹配节点；重复、无效或到期交付返回空，
有效原值仅保留于内存，不读取 cookie 或创建管理员。永久离开卸载页面并关闭客户端；BFCache 保留原截止。
真实身份来源、受保护 cookie 和 `no-store` HTML 注入仍由 CLI/宿主提供，没有测试 CSRF 或身份回退。
`--actions` 预览仅在 `/fixtures/` 用生产 `browser.js` 消费相同 meta，连接独立临时 Store、真实 handler 和合成短期会话；
根入口拒绝返回该 fixture，不作为生产数据或真实设备验收。

[宿主入口](../src/admin/index.ts)提供 `startManagementReadListener`、可嵌入的
`createManagementReadHandler` 和固定构建产物加载器 `loadManagementAssets`。
listener 只绑定 `127.0.0.1` 的显式独立端口，不自动启动、不关闭宿主共享 Store。
宿主必须注入同一 `GatewayManagementService`（现行 Store 服务的 `.management`），以及
`authenticate(request, signal): Promise<Pick<AdminContext, 'caller' | 'management_session_ref'> | null>`。
该适配器验证既有受信管理会话；返回 null 表示未登录或过期。缺少适配器时开端口前失败，
没有默认 admin、测试 token 或浏览器自报身份字段。HTTP 请求的等待信号由桥创建，
每个 read 仅调用一次共享 `execute`，授权与查询仍由共享服务执行。

静态壳可在未登录时加载，不包含身份或管理数据；所有六项数据请求均重新认证。
登录、会话签发/续期/撤销及 CSRF/session cookie 配置由宿主的既有身份服务负责，本模块不发行 cookie。
宿主 `publicError` 仅把已识别共享服务错误映射到固定 HTTP 分类：
`unauthenticated`→401、`forbidden`→403、`not_found`→404、
`invalid_arguments`→`invalid_request`/400、`invalid_cursor`→400、
`conflict`/`binding_revision_conflict`→`conflict`/409、`deadline_exceeded`→`timeout`/504，
其余不可用/容量/隔离错误映射到 `unavailable`/503。分类器省略、抛错或返回未知值均只给固定503，
不检查任意错误对象上的自报 code，不返回异常正文。输出 DTO 复用页面字段白名单校验，失败为502。
浏览器把400视为需要重新取范围的冲突；404显示“资源不存在或无法查看”，不泄露存在性。

桥只接受六项固定 GET；Host/URL 必须匹配实际端口，存在的 Origin 必须同源，跨站 Fetch Metadata 拒绝。
无 CORS 放行；响应均 no-store、固定 CSP、nosniff，静态文件只来自宿主提供的固定内存白名单，
不提供源码映射或请求指定的文件路径。URL最多32 KiB、48个/16 KiB请求头、单次输出512 KiB、
每页200项、最多16个未结束任务；全局准入桶允许32次突发、每秒补8次，未登录请求同样计费，耗尽返回429/Retry-After；读取5秒超时。断开、停止及超时立即终止等待并传播 AbortSignal，
迟到响应/拒绝不能写回；不理会取消的实际任务结束前仍占额度。
浏览器使用 same-origin credentials、禁止重定向及缓存，流式限制正文后才解析 JSON，
不将后端正文错误或身份参数传给页面。

当前接口测试使用显式合成 service/会话；生产宿主仍须装配真实共享 service 与受信会话适配器。
Store 服务未提供的 transport/native 观测继续显示 unverified，不从持久 online 生成心跳或 epoch。

## 可信 transport 读投影

[投影模块](../src/mcp/transport-observations.ts)由同一[宿主入口](../src/admin/index.ts)导出，
供共享管理服务消费现有 `Gateway.observations: GatewayTransportObservationSource`。
它只转换已经授权的 `DeviceSnapshot`，不枚举设备、不读取身份、不代替共享服务或 HTTP 会话认证。
生产组合点须由共享服务注入同一 Gateway 的观测来源；未注入时设备连接与认证保持未核实。

每次读取先完成共享管理员及精确资源授权，再调用 `sampleManagementTransport(source)`，
随后从同一 Store 取得 `mode/server_time/recovery_generation/stale_after_ms` fence，
用 `createManagementTransportProjection(sample, fence)` 投影本次已授权设备，并只替换 status 的 transport 分量。
服务返回时间不得早于本次取样，DTO 仍由共享服务生成并经过既有输出校验；不能跨请求缓存投影或扩大分页范围。
非 active、恢复代次不符、来源失败、缺失、未来或十五秒过期观测均不生成在线/已认证证明。
每层保留真实 `observed_at`，较新全局取样不续期旧连接/认证；心跳只显示 Gateway 实际收到的时刻。
pending/revoked 优先保留共享服务已有且新鲜的 Store 认证证明，旧 transport 样本不能恢复设备授权。

该端口只证明当前连接与认证；断开后没有可信 offline/reconnecting/失败原因时继续显示未核实。
`connection_epoch_ref` 是展示用安全引用，不能作为断开确认或原始 epoch fence。
`dispatch_ready` 不投影为 provider/native ready，native 分量和 provider 运行观测维持各自真实来源。
没有一次性确认、持久回执及同一管理员写入门禁时，断开/撤销等页面操作继续不可用。
真实双 SQLite、持久设备证明与 loopback Connector 的验证位于
[集成测试](../test/webui/observations.integration.test.ts)；测试管理员与 native 执行来源仍是隔离 fixture，不能据此宣称生产会话或原生能力已验收。

## 管理写服务组件

[共享管理写服务](MANAGEMENT-WRITES.md)已提供同 Store 事务、独立管理员授权、后台一次性确认与持久回执，
支持 pending 注册/配对申请、改名、进度、取消、精确 epoch 断开、持久撤销及 provider 启停的受信端口。
生产 session/CSRF、秘密交付进度和 provider 重新启用证明仍须运行宿主接线，缺失即拒绝。
窄 HTTP handler 复用现有读桥，不启动第二 listener；三个设备页面动作消费已公布的固定 actions POST，
下文目标 REST 路由及其余页面操作仍待接线，
不因服务模块或合成测试称管理产品已上线。

## 范围与服务边界

Web UI 展示产品名 **Rovloom**；页面标题为「Rovloom 管理」，登录壳与导航品牌为「Rovloom」。设备、runtime provider、连接/认证等业务名称保持原义；Luvus/Herdr 继续显示为 runtime 名，页面不展示包兼容标识作为产品名。

Web UI 内置于同一 Rovloom Gateway 程序/发行产物，Connector 不启动 UI。它管理设备与连接认证状态及其已配置 runtime providers，不另建外部网站，不增加多租户、通用终端、任意 shell、结果浏览或完整运维平台。provider 专指 Luvus/Herdr 实例，不是 LLM/model vendor；页面不管理 model API key。

管理 UI/HTTP API 使用独立管理 listener 与认证/授权中间件；Connector WSS、MCP stdio/HTTP 维持各自协议与身份边界。可以复用实现模块及已选身份服务，但 MCP token、设备 credential、enrollment 或“已连接机器”身份不自动获得管理员会话/权限；管理 API 不能成为 native 通用调用旁路。

默认仅绑定 IPv4 loopback `127.0.0.1`，端口可配置；无管理员认证配置则不启动管理面，不能以 loopback 代替登录。IPv6 loopback 需明确配置；不自动绑定所有接口。远程管理必须另行启用并配置 TLS、反向代理信任边界、允许的 Host/Origin 和访问控制，不能为 UI 默认开放公网或关闭 TLS 校验。恢复隔离时仅允许独立可信的本机恢复管理认证，不从旧备份恢复远程管理开放状态。

页面路由与 API 分别检查管理员身份/当前授权：未登录只显示登录壳，不返回设备数据；API 每次检查 admin 权限及具体管理能力。浏览器会话使用安全 Cookie、CSRF 防护、同源/Origin/Host 验证与必要的 CSP；不把管理 bearer、设备 credential 或 enrollment 存入 URL/localStorage 或页面日志。登录机制由管理员认证后端提供，不自建 OAuth 产品，不能从设备/MCP 身份推导。

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

UI 可只读查看已配置 bindings；实例新建/替换与受信配置变更遵循 [DESIGN §5.2](DESIGN.md#52-runtime-provider-binding--session)，由受保护本机配置与后端管理审批完成，不能原地修改 kind 或换成另一实例。最小 UI 不提供 binary/root/endpoint、任意路径或命令输入。旧来源不明的 migration_unresolved 行保持禁用，不能点选同名 Herdr 代替旧 Luvus。

默认可见页面每 5 秒读取快照，隐藏页面暂停轮询，回到前台立即刷新；单次读取超时 5 秒。距最后成功快照 15 秒或发生 epoch/恢复代次变化即标记过期，显示观测时间/心跳年龄，禁用基于该快照的变更直到刷新。显示年龄使用服务时间及本次请求后的单调经过时间，不因浏览器时钟回退而“变新”。断网保留带过期标记的只读视图，不伪装实时数据；后续可选 SSE 优化不替代快照，无需另建流系统。

空态区分：没有设备（引导建立配对申请）、无符合筛选项、无查看权限；错误态区分未登录/认证过期 401、无权限 403、版本冲突 409、后端暂不可用 503、容量不足。401 清除内存中敏感状态并停轮询，登录后重新取快照；所有写操作在超时/重新登录后都不自动重放。409 必须刷新并重新确认，不能自动带新 revision 重试。

## 管理流程

1. **设备配对**：管理员新建设备/选择已有 machine，查看目标与拟授策略后确认，创建 pending 配对申请。UI 只显示 registration/pairing ID、状态与有效期；一次性 enrollment 的签发/交付继续使用受保护的本机管理渠道及 Connector 本地安全输入，UI/API 不回显 secret、二维码 secret 或带密钥链接。凭据兑换遵循一次性、过期、恢复代次约束；配对成功后展示设备认证与通道状态，不把申请创建当认证成功。
2. **暂时断开**：确认具体 machine 与当前 epoch 后仅关闭这条连接，保留持久设备授权。UI 明示 Connector 可以再次主动连接；这不停止原生工作、不保证回滚在途动作，也不形成持久封禁。
3. **撤销授权**：单独确认持久撤销的设备、影响和原因；后端在持久撤销提交后关闭相关连接、拒绝新认证/派发并终止流。失败时不能显示“已撤销”；已送出的动作可能继续，保持 unknown/对账边界。重新启用需新的明确重新配对/授权流程，不能以 reconnect 自动恢复。
4. **取消配对申请**：只使指定 pending enrollment 申请不可兑换，不能暗中撤销已有设备 credential；已兑换/状态改变则冲突，刷新后重新评估。
5. **禁用/重新启用 provider**：与断开设备、撤销设备分开。必须有独立 providers_manage 权限及真实确认，目标包含 machine_id/provider_id/expected_binding_revision。禁用事务成功后递增 binding revision，阻断该实例派发/读取/补证并关闭其流，显示已送出工作可能继续和 unknown；不撤设备 credential，不误停其它 providers。重新启用要求双端配置一致、重发现/重授权及新 revision，旧流/句柄/attempt 不复活；不自动刷新 TTL 或重派旧请求。仅设备管理权限不足以执行此项。

敏感变更须有真实管理员会话、后台保存并绑定该会话/操作摘要/目标/revision/epoch 的一次性确认记录，以及原子审计；不能由 caller 提交 approved:true 自证确认。确认有效期默认 2 分钟，过期、操作摘要变化或 revision/epoch 变化须重新确认。确认引用只经受保护请求体传递，不放 URL 或普通日志。此处管理员交互不替代必要的原生 Host 确认，UI 最小范围不提供这些 Host 操作。

## 最小管理 API 契约

仅固定操作枚举；未知 action、安全分类不完整或当前策略不允许，一律拒绝。管理请求与响应均有界。所有写入含 request_id、history_epoch、recovery_generation、expected_revision、reason 和适用的 confirmation_id；断开额外含 expected_connection_epoch。后端按当前管理 principal/目标去重，复用同请求必须保留原范围与关联；不得更换 ID/范围自动续发。响应不携带凭据正文。

| API | 输入/输出及副作用 |
|---|---|
| GET /admin/v1/status | 返回 server_time、observed_at、mode、recovery_generation、管理 policy revision、刷新建议及服务健康；normal 模式可读取已存在的管理员 history_epoch/截止时间，GET 不创建或续期 scope，隔离态不发放范围；不返回配置 secret |
| GET /admin/v1/devices | cursor、limit、允许的状态筛选；默认 50、最大 200。返回获授权设备摘要与 next_cursor，分页不绕权限 |
| GET /admin/v1/devices/{machine_id} | 设备身份、连接/认证/配对状态、最近心跳、脱敏失败原因、revision 和观测时间；无 result 内容或 credential |
| GET /admin/v1/devices/{machine_id}/providers | 分页返回授权内的已配置 runtime provider 状态、binding_revision 与观测来源；默认50/最大200，不返回 binary/root/endpoint 路径或秘密，不创建 binding/scope |
| GET /admin/v1/devices/{machine_id}/providers/{provider_id} | 返回该 binding 的 kind/config_ref 安全引用、启停/可达、契约摘要/保证与未核实原因；未知/不明来源禁用，不能从 name 默认替代 |
| GET /admin/v1/devices/{machine_id}/permissions | `permissions_get` 的精确设备范围；可选 `provider_id` 指定同一设备的 provider。返回当前受信管理 principal 的权限提示和截止时间，GET 不创建 scope，不接受 caller/session 参数 |
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

审计遵循 DESIGN 的无原文/无 secret 与预算规则，记录管理员、目标、动作、确认记录安全引用、revision/epoch、结果/时间。配对签发/兑换的秘密不进入普通调用结果库、UI 或审计。确认/配对元数据也计入受管预算，不能靠管理面绕过 storage_degraded 或收尾预留耗尽规则。

## 恢复隔离与存储故障下的 UI

recovery_quarantined 仅允许通过独立于旧备份的本机恢复管理员认证读取恢复模式、备份来源/时点、完整性检查、设备历史摘要、旧认证失效状态和脱敏阻断原因。旧在线/权限数据标注“备份历史”；不显示原始结果、secret 或新 pairing 口令。不能配对/签发/兑换、断开/撤销写入、发放新 history scope、重开业务或把旧请求移到新 scope。解除隔离与重新建立管理员授权继续由受保护本机恢复流程完成，最小 UI 不增加一键解锁接口。

恢复的 provider bindings 全部按备份历史展示、默认禁用；来源/当前配置/授权重新确认前不能 enable，不能由旧 enabled 标志或同名 session 推定可达。隔离态禁止 provider 启停等管理写入；storage_degraded 同样拒绝。provider 禁用未成功持久化不能显示已禁用，前端按钮状态不替代后端门禁。

storage_degraded 时只允许可满足预算/授权的有界只读诊断；禁用所有管理写按钮，明确持久撤销可能尚未生效。后端仍要独立拒绝对应请求，不能仅靠前端 disabled。原调用结局无法持久化则保留 unknown/dispatch 锚点，UI 不显示为已完成；晚到证据也不绕过当前恢复代次、epoch、内容截止和已清理状态。

## 管理面验收要求

- 管理 UI 与 API 双重管理员检查；MCP/设备/配对身份不能调用管理动作，未授权数据不进入页面或 API。
- 配对全流程不回显凭据；真实后台确认、CSRF、审计、revision/epoch 冲突、重复/超时均有测试；确认状态不是 approved 布尔绕过。
- disconnect 只断指定 epoch 且允许已授权 Connector 重连；revoke 持久化后拒绝重连，失败不假报成功；原生工作不被暗中终止。
- 同设备 Luvus/Herdr/第二同 kind 行分别显示；provider 禁用/重新启用有独立权限、确认和 revision 冲突测试，其它行与设备授权不被误改。旧句柄/补证/队列不复活；设备撤销覆盖全部。未知分类/状态恢复保证不因 UI 展示变成已支持。
- 空态、401/403/409/503、断网/过期快照/刷新和心跳来源清楚；reconnecting 由可信证据产生，数据过期禁止变更。
- 默认仅本机、远程需显式 TLS/访问控制；恢复/存储隔离的页面与 API 均拒绝写入、旧范围不复活；不把 UI 测试称作跨平台或生产部署验收。
- 构建/测试使用[开发指引](DEVELOPMENT.md)的工具链；页面、管理后端、平台和部署分别验收，不能以工具链或原生实验代替。
