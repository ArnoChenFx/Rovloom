# MCP Streamable HTTP 与持久 CLI 宿主契约

本文维护 `src/mcp`、`src/cli` 的接线边界；系统语义以 [DESIGN](../DESIGN.md#7-mcp-工具面)为准。
模块属于内部技术预览。`StoreGatewayService` 与 `createStoreCliRuntime` 已接实际 Store/Router；
独立 CLI 的 Gateway 打开真实 Store 和设备 transport；未配对时拒绝 MCP 身份。
真实本地终端可完成一个 Connector 的一次性配对与已安装 Luvus 初始化；非 TTY 缺资源明确拒绝。
工具发现、人工历史或服务 stub 的结果不能称为原生执行成功。

## 宿主接口

准确签名见 [MCP 类型](../../src/mcp/types.ts)和 [CLI 接口](../../src/cli/run.ts)。

- `GatewayService.execute(name, args, context)` 接收严格校验后的 `ToolArguments[name]`，
  返回 `ServiceReply[name]`。每个请求仅调用服务一次；facade 不持有调用账本、不生成 native ID、
  内容句柄或执行许可，不重试、不跨 provider 改写目标。
- 服务必须在每次操作核验当前归属、完整 Target 的双端 ACL、分类、binding/contract fence、
  管理权限与真实确认、结果读取/保留及持久化门禁。列表、计数、描述和游标同样须按 caller 过滤。
  当前 Store/Router 的完整 tuple 政策用于已接线读取和清理；它们不能替代 native 分类、内容 custody 或管理员会话。
- `HttpAuthenticationProvider.authenticate(request, signal)` 由受信认证宿主逐HTTP请求验证现有凭据、
  issuer/audience、期限、资源与scope，再映射已有 principal。缺身份拒绝；不从本机UID、转发头、
  arguments、`_meta` 或 `Mcp-Session-Id` 建立远程身份，不自动签发或创建真实凭据。
- 共享业务 context 只包含冻结 caller 与 wait_signal；每个请求通过独立异步作用域传递。
  WebUI 使用独立管理员认证和管理listener，不能把MCP或设备身份自动升级为管理员。
- `context.wait_signal` 只停止前端等待。标准MCP取消、HTTP断开或DELETE不调用业务
  `runtime_call_cancel`，不表示native取消、回滚、not_dispatched或可重发；持久unknown锚点保留。
- `CliRuntime.gateway(config)` 返回 service、authentication、可选 listening(url) 与 close()。
  可选 closed 用于观察实际角色结束或关闭失败。
  CLI拥有MCP listener；宿主不重复创建入口。Connector仍返回closed/close，具体transport由宿主建立。
  stdin EOF及客户端退出不停止持久Gateway；角色终止信号或真实角色closed触发listener及宿主资源清理。
- `createRuntimeCliRuntime(host)` 消费 `src/runtime/index.ts` 的实际角色工厂。
  `host.gateway(config)` 交付 `RuntimeCliGatewayResources`，即
  `{options: GatewayRuntimeOptions, authentication, catalog?, management?, started?}`；`started`只绑定该唯一runtime的身份提交通知。
  `host.connector(config)`交付Luvus的`RuntimeCliConnectorResources`，或`kind: 'provider'`的
  `RuntimeCliProviderResources`给PR71中性宿主；保留原session/release，transport省略url。
  CLI从所选gateway_url固定`/connector`；结构类型旧资源若夹带不同url，在连接或凭据读取前拒绝并release。
  工厂复用原Store/Router、原子admit、
  显式cancel及results.open/read/discard，不复制runtime或凭据/原生来源实现。
  `RuntimeGatewayService` 将每次MCP请求置于runtime.runAuthenticated的当前caller作用域；
  call/get只返回同次已授权元数据及可用的真实结果句柄，结果页逐次通过原Wire读取/保留门禁。
  Luvus Connector资源的provider_snapshot声明穿过production/runtime两层CLI交给原角色工厂，
  由runtime协商并交付原generation的实际快照；未声明的资源不添加该能力。
  程序管理的provider条目把实际schema交给现有工厂核验，不从用户角色JSON选择schema/ref/pin。
  原始schema内容不剥BOM、不修改其摘要；用户初始化层不生成固定版本或pin。
  原attempt查询失败时，重新授权后只返回最新调用元数据和content_reason_code，不恢复旧Wire或正文；
  错误回调中的同步撤权也必须拒绝交付调用ID。
  结果cursor绑定caller、result_id、max_bytes及固定期限；不接受客户端任意字节偏移。
  close入口同步封锁新MCP请求，再关闭管理listener、设备通道和资源；已经送达native的工作可能继续。
- `createTransportCliRuntime(host)` 复用已合入的 `createGateway/createConnector`，不实现第二套通道。
  Gateway 宿主交付已打开的 Store、同一身份/政策来源、authentication、验证身份桥及逐 socket session；
  工厂组合一个 Router 和实际 listener，可选 service 工厂收到同一 Store/Router/transport。
  service 工厂同时取得 principal()、当前 localPolicies、originalAttempt(callId, attemptId) 与
  实际 transport 的 resolveOriginalRead(callId)，
  供原生结果模块接线；principal 每次从所属请求重读受保护身份，原请求索引先经同一 Router
  核对归属和当前 read 政策，再读取 Store 中尚有效的原 attempt，不缓存请求或制造 permit。
  完成后还需读取原 Wire 时，受保护宿主须显式设置 retainOriginalRead: true；结果模块逐页重新
  解析原请求并调用 checkResult，创建句柄前另调用 checkResultRetention，不将已取得的引用当永久授权。
  dispatch 只接受所属服务请求的异步 caller 作用域，并重新解析当前身份；没有请求作用域即拒绝。
  Connector 宿主交付受保护凭据及逐 epoch 会话；支持原生 JSON 回调或实际 executeWire hook 的互斥
  transport 类型，工厂不剥原帧或重注入 auth，固定使用 WS/WSS origin 的 `/connector` 端点。
  两角色关闭均先停止实际 transport 再释放宿主资源，重复关闭共用同一 Promise；启动失败也清理。
  独立 `main.ts`按需加载[生产资源加载器](../../src/cli/production.ts)，从固定私有文件绑定实际
  `openGatewayState`、HTTP/WS监听、caller摘要及PR71管理authority。缺少角色来源不会创建默认身份、设备或native服务。
  原生opaque实例及跨进程来源仍由静态链接的受信resolver负责，不能从ref JSON重建；
  Store当前不公开已打开文件路径，CLI不读取私有字段，也不把配置自报路径当作验证事实。

Facade 与 CLI 不实现 #5 的存储/审计、#6 的设备认证/transport 或 #7 的原生来源/执行。
服务用固定 `FacadeServiceError` 代码报告网关拒绝；其它异常仅输出 `internal_error`。
服务返回的普通内容必须已通过读取与秘密交付门禁，凭据类结果不能进入此通道。
facade 不能识别普通原生内容中所有未知秘密，也不能替代后端的 custody 判断。

## 实际 Store 服务与独立管理接口

[StoreGatewayService](../../src/mcp/store-service.ts)接收实际 Store、同一 GatewayIdentitySource 与
当前 LocalPolicies，直接组合 Router，不读私有 SQL、不维护第二份设备注册表或调用账本。
[CLI 工厂](../../src/cli/store-runtime.ts)在受信宿主显式装配后，按 state_dir 打开 gateway.db；
沿用 Store 的目录保护、单 writer、预算与恢复门禁，关闭时释放资源，不自动创建目录或接入设备。

当前已接线 machines_list/get、providers_list/get、runtime_call_get 元数据和
runtime_response_discard。MCP 可见设备/provider 仅由当前 caller 的完整 read tuple 与本地政策
求交，结果仍从 Store 读取；不存在的 binding 不由 grant 补造。名称只在授权候选中精确查询。
单次查询最多处理 256 条 caller/local grants 与 256 次 tuple 求交，超过返回 busy。
列表游标使用服务实例私有密钥的 HMAC-SHA256 签名，无逐页记录或共享名额，绑定 principal、
查询/limit、双方政策、恢复代次、位置及固定期限。后继期限至多 30 秒，并受更早的目录期限约束；
后续页与重读不续期，每页重新授权。旧政策、查询变更、期限或重启后明确 invalid_cursor，不能将 offset 当作权限。

调用查询仅投影真实账本元数据，content_delivery 固定 unavailable，不输出 native_response、请求、
principal 或内部 epoch。Store 公共 Call 尚无可独立读取的 contract_ref，返回 null，不从失效
native handle 或旧 JSON 重建来源。wait_ms 只做短等，每次轮询重读当前 Principal/双方政策；
取消等待不改账本、不调用 Router.cancel、不派发或重试。
清理使用 Router.discardResponse 验证归属、原方法当前 read tuple 及独立 discard_response，
再由 Store 原子清空请求/响应、删除句柄并写入实际 principal 的审计；期限不续期。
沿用 Store 在 COMMIT 后发布的内容回收通知，回滚不通知。宿主 adapter 可按现行原生契约
保留有界仅响应上下文供同 epoch 元数据对账；它不恢复内容读取、原请求或派发权限。

`StoreGatewayOptions.catalog` 可显式接入 `GatewayCatalogProvider.resolve(target, principal)`。
宿主返回实际 NativeContractRecord、独立认证的 TrustedNativeContext、当前 local_provider 与固定 expires_at；
它们来自受保护 registry，不能从 MCP、session listing 或 read 标签生成。服务复用 Luvus 的
createLuvusCatalog，核对 Store 在线 epoch/恢复代次、完整 Target、provider/config/binding、
来源引用、双方政策及 capability/classification revisions。能力内容摘要和期限参与一致性检查，
即使宿主忘记更新 revision，同次查询发生能力变更也拒绝。目录扫描最多 256 项，逐项求当前
双方 read 交集后才分页；游标还绑定完整来源、能力内容/期限和当前政策。describe 仅接受该
授权集合的精确方法，保持 classification_status=not_evaluated，不签发执行许可。
缺少该宿主时 discover/describe 返回 backend_unavailable；注册过期/错误来源同样拒绝。

runtime_call/call_cancel/result_read 尚未完成服务装配，返回 backend_unavailable。transport 已提供
原始 Wire hook、响应对象和活原请求 resolver；宿主可按现行契约将每个 epoch 的 executeWire 直接接到
实际 LuvusRpcAdapter.dispatch，不能用原生 JSON execute 代替或重新注入 auth。唯一持久 claim、
事务准入及当前内容读取模块仍须独立组合，不能以 hook 已存在宣称公共调用成功。
调用准入须在同一 Store 事务使用绝对 deadline，并区分新登记与原 key 命中；
现有 Router.admit 已提供同步 CallAdmission（call/created）与绝对 deadline 端口，RuntimeGatewayService委托真实runtime.admit；
不能从旧 createCall 的相对 timeout 或既有 state 猜测首次登记，created=false 即使仍为 created 也不得派发。
读取须通过原 Wire adapter 的 checkResult，绑定当前 reader、完整 attempt、原 permit 和普通交付通道；
只用当前分类、原请求重校验或 responseAnchor 不能恢复原派发时的秘密/保留授权。
transport 默认在提交后释放执行上下文；显式 retainOriginalRead 的有界保留仍须通过原 resolver，
不能把仅供晚到元数据核验的 ResponseOnlyContext 当作读取许可。结果页使用 Store.readResult 返回的
实际句柄 expires（Store 绝对毫秒，now < expires 有效），不能用内容期限代替，或创建新句柄续期。
机器注册/改名/撤销只在管理 UI / CLI，MCP 不提供这些工具；MCP caller 无法触达设备凭据签发/兑换或管理确认。
Store 的设备凭据与重配接口不替代这些管理端口；facade 不调用 resetDeviceEnrollment/denyDelivery，
也不签发或兑换凭据。
独立入口仍需受信HTTP认证和真实身份来源，不能自动采用测试工厂。

[management.ts](../../src/mcp/management.ts)是 WebUI 可复用的完整服务类型，包括设备连接/认证、
provider、健康、权限快照、独立会话 context、确认摘要、写入 fence 与操作回执。
管理 listener、Cookie/CSRF、Host/Origin 和真人确认流程仍以[管理 UI 规范](../GATEWAY-WEBUI.md)为准。
GatewayIdentitySource.principal 返回现有 Router Principal；administrator 用同一身份后端另行
验证当前管理 session 与精确管理 grants，不能由 MCP 或设备身份自动获得。会话引用只由中间件
注入 context，不属于请求 JSON。devices_read 不授予 providers_read 或 providers_manage。

service.management 当前实现 status、devices_list/get、providers_list/get、permissions_get。
devices_list 可用 states 指定 1–4 个不重复的 pending/offline/online/revoked 持久状态，
筛选绑定游标且在授权后执行；不把 connecting/reconnecting 等未知现场状态当持久状态筛选。
所有列表仅枚举当前精确管理 grant 的资源；无全局通配授权或额外注册表。未知 labels、设备管理
revision、现场连接/心跳、native 来源保持 null/unverified；持久 pending/revoked 可按 Store
事实显示，旧 online 行不能证明当前认证或健康。配置引用只输出安全标识符，路径返回 null。
机器 link 可为 unverified，provider 启用不等于 ready。GET status 的管理员 history 为 null，
不会创建、续期或借用业务 history。权限快照只作 5 秒 UI 提示；有管理权限但缺后端时 allowed
仍为 false，reason_code 为 backend_unavailable，不能据此生成执行许可。

角色组合器配置management时，以同一Store/identities、上述management六读和实际transport.refresh创建
`StoreManagementWriteService`，再把现行`createManagementHandler`挂到共用`startManagementListener`。
管理listener仅绑定127.0.0.1，读写handler正文上限16KiB；独立只读入口继续限制1字节。
宿主交付非秘密port及可选assets；认证可提供独立authenticate/verifyCsrf，或提供
`session: { sessions, cookie_name }`交由既有`createManagementSessionAdapter`组合。
session来源的identities必须与runtime完全同一对象；适配器在实际listener Origin下逐请求验证cookie和CSRF，
不同来源在启动时拒绝并释放已打开角色。不能用MCP身份代替管理员会话，不创建登录或新的管理员来源。
生产宿主可通过`ProductionCliSources.management.resolveLease`交付原受保护页面请求的既有lease，
同一authority至多一次设置短期管理cookie并将CSRF放入页面内存回调；默认无宿主仍禁用。
受保护会话源与浏览器确认/回执客户端契约见[MANAGEMENT-SESSION-CLIENT](../MANAGEMENT-SESSION-CLIENT.md)。
pairingPolicy、providerEnable缺失时对应写操作拒绝；权限提示仅观察已装配能力与当前grant/Store模式，
不调用确认、签发或provider启用证明，也不构成执行许可。
确认、回执及管理写服务在
Store writer 的同一事务保存管理 history/请求摘要、真实确认消费、状态变更和带 actor 的审计回执，
不能用内存 Map、业务 call、换 key 或查询到相似状态冒充该次操作已提交。request_id 标识待执行
意图；确认记录和动作回执使用区分种类的幂等命名空间，均绑定原 principal/session/history。
确认摘要必须覆盖 action、完整 target/kind、reason、恢复代次、管理 revision、binding revision
和适用 epoch；后台返回保存的 summary，真人确认默认至多 2 分钟，重复确认不续期。
HTTP 写超时后仅查询原 operations_get；未知结果不自动重放。GET 不能签发 scope 或凭据。

断开必须由真实 transport 关闭确切 epoch；Store.disconnect 只是持久账本收敛，不是通道关闭。
provider 启停还须双端配置核对、独立 providers_manage、确认及新 revision，并释放对应资源；
旧流/句柄/attempt 不复用，原生工作可能继续。设备管理revision、管理员history/确认/回执和actor事务
复用已合入的Store/管理端口，准确签名与生产session/custody边界见[管理写服务](../MANAGEMENT-WRITES.md)。

管理读请求需拒绝未知字段，设备/provider 标识符最多 128 字节，cursor 最多 1024 字符，
分页默认 50、最大 200，设备 states 筛选只接纳上述有界枚举。HTTP 适配器限制请求体和响应字节并映射固定公共错误。
storage_degraded 仅保留满足授权/预算的有界读取及现有独立清理路径。

## MCP 消息与工具

使用锁定SDK 1.32.1的 `Server`、`WebStandardStreamableHTTPServerTransport` 和官方请求schema，
实现已核实的2025-11-25协商。只使用Streamable HTTP，不保留stdio或旧HTTP+SSE兼容入口。
`startHttpFacade` 通过Bun.serve提供默认回环listener；`createHttpFacade`供明确的TLS/反向代理宿主组合。
不升级依赖或照抄其它SDK版本API；本地测试不代表商业Host、OAuth或真实双机验收。

每个stateful会话独立拥有Server/transport，所有会话复用同一业务service/Store/Router。
每请求先认证并与会话绑定的principal精确匹配，sessionID仅用于路由。
默认最多64会话，空闲15分钟清理；最多256个HTTP请求等待，每请求35秒deadline（宿主上限60秒）。
逐请求取消只影响自身等待；DELETE和会话过期关闭该会话，不停止Gateway或取消native。
无event store，不承诺断线事件重放；失败后的业务重试仍受原 client_request_key 门禁约束。

只接固定 `/mcp`，不接受query、userinfo或其它路径。Host必须精确匹配受信origin；
Origin存在时须命中显式完整origin白名单，缺Origin允许标准非浏览器客户端。
不信任X-Forwarded-*等转发身份头。默认只绑定127.0.0.1或::1；公网TLS/认证不由模板自动启用。
管理UI/API、设备WSS与MCP保持独立listener/身份/权限边界。
原始请求体在任何JSON解析前限1MiB并受deadline约束，严格拒绝重复JSON键、非法/截断UTF8、
过深/过多节点及批量RPC；传给SDK的parsedBody已过同一字节上限。总header最多16KiB。
SDK负责初始化、协议版本、HTTP方法、Accept/Content-Type与标准会话检查。
SSE响应起始只有刷新响应头的注释，无额外MCP通知；普通诊断只输出固定代码。

工具共 11 个：machines 的 list/get、providers 的 list/get，
以及 runtime 的 discover/describe/call/call_get/call_cancel/result_read/response_discard。
不暴露流、Host 特权捷径、provider 管理或 `luvus_*` 别名；工具存在不证明具体 runtime 已开放。
所有参数根拒绝未知字段。Target 使用完整 machine/provider/profile/session，Host 分支禁止 session。
caller 不能注入 principal/admin/discard_response，native_request 只允许 method/params，不能自填 id/auth。
原生参数的完整约束及额外秘密/注入字段仍由受信安装契约和服务检查。

`runtime_call` 要求 expected_binding_revision、contract_ref 和绝对毫秒 deadline。
validation 默认 strict，wait_ms 默认 0、上限 5000；短等与执行期限独立。
重送同一意图须使用原 `client_request_key`（可选，同主体内去重，窗口为 `metadata_ttl`）；
facade 不生成或更换 key。`runtime_response_discard` 是独立动作，服务必须验证归属、
原方法当前策略和专门 discard_response 权限。设备/provider 公共视图仅输出类型中列出的展示字段。

成功结构为 `structuredContent: {data: ...}`，并提供 JSON 文本副本。
服务若交付已授权内联原生响应，其error保持在 `data.native_response.error`，以 `is_error` 标明工具错误。
`RuntimeGatewayService`的call/get返回元数据与`result`句柄，元数据响应不标记原生error；
`runtime_result_read`以base64页交付原始响应字节，原生error.code/message/data均保持原文，不改成网关错误。
网关拒绝为 `isError: true` 和 `gateway_error: {code}`。未知工具/参数为固定 JSON-RPC 错误，
不回显请求值、服务异常、私人路径或栈。HTTP承载协议，stdout不承载MCP；stderr仅允许固定诊断代码。

Luvus 完整原生请求 schema 在首次登记的同步 preflight 中拒绝时，`runtime_call` 返回
`isError: true` 与 `gateway_error: {code: 'native_request_invalid', outcome: 'not_dispatched'}`。
该错误仅证明本请求尚未建立 call/dispatch 锚点，坏请求不占 key，不发送业务 Wire，也不关闭 WSS。
已有 key 仍返回原调用的真实状态；旧 unknown 不倒退或重派。相同错误码来自其它阶段时不附此 outcome。
预检不授予执行权限，仍须后续原来源、在线能力、分类、策略及最终 IO 检查；网关不交付参数或 schema 错误正文。

tools/list 每页 5 项，用 SDK 标准 nextCursor；此游标仅索引静态目录。
业务列表和结果游标由服务产生，须绑定 caller、查询/Target、结果、期限和当前授权，
不能将任意 offset 当授权。结果读取 max_bytes 默认 4096、上限 16384；服务须按 UTF-8/编码
边界形成可读页，不能擅自放宽原生/结果限额。

`RuntimeGatewayService` 的结果 cursor 使用服务实例私有的 HMAC-SHA256 密钥，完整绑定
caller、result_id、max_bytes、服务产生的字节位置及绝对期限，不接受自行修改的位置或期限。
无 cursor 的读取开始一次下载；首个后继期限为当前时间加 30 秒与实际句柄期限的较早者，
之后所有后继沿用该期限或更早的实际句柄期限，推进及重试均不续期。
同一有效 cursor 的重复读取返回相同页及相同后继引用，包括 EOF 页；每次仍重新验证
当前身份、双方 ACL、原 Wire 许可及实际内容/句柄期限。无 cursor 的重新读取可开始新下载，
但不得延长实际结果有效期。过期、篡改、跨 caller/result/页大小或服务重启的 cursor 返回 invalid_cursor。
结果 cursor 无逐页或逐下载服务端记录，只有实例的 32 字节签名密钥；长下载和 EOF
不占用共享游标名额。业务列表同样没有共享游标名额；结果句柄与正文仍受原有全局预算约束。

完整公开JSON-RPC响应（含文本副本、JSON转义和envelope）最多64KiB，单工具参数最多64KiB，
每会话最多16个工具请求在途，字符串请求ID最多128字节，协议关联最多1024项。
公共ID映射为SDK私有正整数，0/空字符串也能取消；每个POST持有专属预留token，重复在途ID在
SDK修改映射前返回409，旧请求的finally、断开和晚到回复不能清除或取消同ID的新关联。
取消只停止SDK与前端等待，关闭原响应流并清理映射；独立runtime_call_cancel才调用后端取消接口。
HTTP背压保持逐块读取；断开或deadline主动清理SDK源流，即使外层已有排队注释也不保留GET keepalive。
服务须先形成设计要求的有界摘要与合法结果句柄；facade 不会自动存储大响应。
仍超限时只返回 response_too_large、truncated、已授权内容的字节/hash 和适用 call_id，
不制造句柄，也不再次执行。超过现有 JSON 边界的非法服务结果拒绝为 internal_error。
普通结果的 hash、游标和关联 ID 也属于受限元数据，服务不得跳过读取授权。

## 本地 CLI

使用仓库锁定 Bun，先冻结安装，再执行：

```sh
bun --no-env-file run build
bun --no-env-file dist/src/cli/main.js --help
bun --no-env-file dist/src/cli/main.js config template gateway
bun --no-env-file dist/src/cli/main.js config template connector
```

需要单文件预览产物时，可在本地执行：

```sh
bun --no-env-file build src/cli/main.ts --target=bun --outfile /tmp/rovloom-preview.js
bun --no-env-file /tmp/rovloom-preview.js --help
```

两种角色使用相同入口和版本。每个角色只有一份分组用户JSON，完整字段、默认值和平台限制见
[配置参考](../CONFIGURATION-zh.md)。默认路径分别为当前用户home下的
`.config/rovloom/gateway.json`、`connector.json`；显式`--config`覆盖精确文件位置。
Linux角色启动在文件缺失时独占创建0600文件及0700目录，已有文件（包括坏文件）永不覆盖。
`config check`和`check-runtime`保持只读，不创建文件；无选项时读取两份默认用户文件并逐角色报告，
`--role gateway|connector`单选，`--config ABS`覆盖文件且可与role联合核对。已有显式文件不依赖home，生成缺失文件
需要home以选择默认数据目录。Windows沿用同样路径约定，实际受保护读取仍未支持。
角色解析拒绝未知字段、旧扁平格式、用户ref/TLS/CA路径、secret、identity和pin。

用户业务参数来自唯一角色文件；程序管理资源位于`data.directory`中的私有`managed/`，
不加载旧`runtime.json`或`refs/`。provider registry为`providers.json`，只接收同角色、至多32条
`{reference,value}`条目，总JSON上限1MiB，原生来源继续由静态工厂验证，不因JSON自报可信而放行。
该条目是内部发现/装配结果，不是用户准备清单，初始化层不会写死native版本或摘要。

公开生产加载器创建缺失的私有数据目录，打开唯一Gateway Store和普通HTTP/WS监听。
未建立caller状态时Gateway真实运行并提示`pairing_required`，认证与管理员均返回空身份。
程序管理的既有caller来源固定为`managed/mcp-callers.json`，其精确字段为
`schema_version: 1`、`kind: 'mcp-caller-source'`、canonical完整`resource`、
现行`ProviderPolicy`形状的`local_policy`及1..64条`callers`。
每条caller只含`principal: { id, policy }`、`token_sha256`、`issued_at`、`expires_at`；
主体和凭据摘要均唯一，绝不保存原Bearer。它消费既有身份，不是登录或凭据发行接口。
`resource`须等于canonical MCP URL（包括`/mcp`）；每次主体/策略/认证仍复核同一文件代次及期限。
损坏、权限变化、内容变化或时钟回拨继续拒绝，不能靠恢复旧文件续期。

管理监听由角色JSON的`management`分组控制；缺独立管理状态时仅交付无会话页面，不能默认管理员。
既有独立管理来源为程序管理的`management.json`，其监听端口须与用户分组一致。
证明、固定租期、Cookie/CSRF与逐动作身份批准仍复用
[管理来源与页面交付](../MANAGEMENT-SESSION-CLIENT.md#生产宿主与页面交付)。

Connector地址来自`gateway.url`，固定端点为`/connector`；本机/可信网络可用WS，公网WSS由
外部标准TLS反向代理终止。出站WSS使用系统信任与强制hostname/证书校验，无CA或跳过验证选项。
既有配对凭据由`loadCredential`读取程序管理的`managed/device.json`，仍在provider准备前校验、
准备后复验，并在后续每次连接重读；撤去凭据时释放本次资源。
缺地址、provider或配对凭据返回`configuration_required`，非TTY不等待stdin。
真实内核 TTY 与当前 UID/私有角色文件核对后才创建本机确认对象；网络 JSON、MCP Bearer、
管理 cookie 或流对象自报 isTTY 不能创建本机批准。Gateway在取得唯一writer且监听成功后，
经明确确认调用原PairingAdmin登记/签发；同一设备listener的固定POST `/pairing/redeem`、
`/pairing/ack`、`/pairing/status`、`/pairing/native` 拒绝Origin/重定向地址字段/非JSON，
不提供公开注册或签发接口；body读取限5秒/16个并发，退出中止读取和本机问答并等待原handler收尾。
兑换沿原createPairingDelivery的5秒持久交付期限，设备先用原
createFileCredentialSink落盘再回传完整ack。ACK/状态/native短请求使用原IdentityHost凭据与epoch，
完成setup后关闭这些短认证路径，避免状态查询夺取已运行WS的epoch。结果不确定保留原attempt，
不重新注册、重发secret、清除身份或删除账本。

Connector通过单份业务配置的`native.provider`选择`luvus`（默认）、`herdr`或`mixed`。
状态查询返回所选完整Target的权限提案，不在Gateway另行批准之前开放运行权限；
native清单最多含每种来源各一份，混合方法按各自Target分别授权，不生成笛卡尔权限。
Luvus初始化只用实际安装测量/完整schema编译与原managed root/claims工厂；
程序管理的control、n、h、w为互不重叠的私有目录。n完整路径超过52字节在兑换前拒绝，
不放宽原endpoint归属门禁。Gateway另经本机批准为精确Target定义provider及一个普通MCP caller，
不授予管理身份；Bearer仅交付本机TTY/私有mcp-client文件。静态配置提交只记configured，
旧listener/唯一writer完整关闭后重开正式来源，只有transport观察到实际认证provider ready才记ready。
Herdr同样测量本机安装、运行固定schema命令并复用既有完整编译和claims工厂；
Gateway自己核验原schema字节，选择本机私有保存路径，不接受Connector文件路径或可信句柄。
每种来源都由原静态生产工厂重开，全部所选来源实际ready后才报告connector_ready。
Agent/模型认证由用户在私有HOME/XDG中独立完成；不确定状态恢复和续期引导仍未接通。

`config check-runtime [--role gateway|connector] [--config ABS]`复用角色及现有provider registry校验，成功输出
`runtime_config_valid`；不加载caller/设备凭据、验证native/Agent或打开数据库。
它不表示端口可监听、设备已连接或模型已回复；私有runtime读取仍要求Linux。
真实session所有者必须交付持久claims；Connector 以本机固定保留期的 attempt book 去重。

非空provider引用须由静态链接的`ProductionCliSources.gateway/connector`解析为实际opaque来源，
每个Gateway ref恰好对应其自身provider。唯一`main.ts`按需加载固定工厂表，Luvus使用runtime的
`createLuvusProductionSources()`，其实际配置见[Luvus操作装配](../LUVUS-OPERATIONS.md)。Gateway attach
已有本机实例，Connector持有明确managed child；首次本地Luvus引导可通过既有初始化API交付root和
持久资源，后续只以open重开。已有root/账本不可因缺文件自动重建；用户JSON不能自报来源或pin。
Herdr双角色静态注册`createHerdrProductionSources()`。单个Gateway引用采用
`{ kind: 'herdr', config: <HerdrProviderRefConfig> }`封套，`config_ref`须与引用名一致；原工厂只接收
`config`，不追加kind。Gateway直接复用`createHerdrGatewayResources`，不启动Herdr进程。
Connector封套另含`native: { mode: 'managed' }`、完整`ProviderPolicies`的`policies`，且原`config`
须含`connector`。只接受单个明确managed引用，不支持attach。原所有者先校验schema/binary，再持有
本次真实child及installation，复用`createHerdrConnectorResources`的当前policies、now与releaseOwner；
不创建身份凭据。关闭确认本次child退出后才移除自己的同inode排他标记，未确认退出保持失败。
固定工厂按Luvus/Herdr分组准备原资源，再由同一runtime组合会话；各owner原有的引用数量和来源限制保留。
未知kind、重复引用在取得资源前拒绝；缺工厂或空Connector引用返回`backend_unavailable`，不创建native成功stub。
外部supervisor实例交付和跨进程native来源仍遵循[TRANSPORT](../TRANSPORT.md#生产来源边界)的未完成边界。
受信embedding可交付现有管理员来源；加载器使用PR71同一authority的identities/sessions，
PR69 handler完成认证、CSRF及原预算准入后，才在service委托处建立该cookie的管理作用域。
默认入口不bootstrap管理cookie，也不因MCP bearer或`providers_manage`取得native-custody批准。

Gateway资源采用明确联合：旧`kind?: 'luvus'`交付现行`GatewayRuntimeOptions.providers`；
中性`kind: 'provider'`交付`ProviderGatewayRuntimeOptions.providers/session`，CLI直接调用
同一runtime模块的`createProviderGatewayRuntime`。中性provider显式给出`max_response_bytes`，
不要求Luvus contract/source/authority；`session(connection, channel, services)`只交付当前真实epoch的
原provider Session，异步安装须在resolver返回前完成。CLI保留session原对象的this，不复制其协议或生命周期。


中性目录用`catalog: { kind: 'provider', resolve(target, principal) }`。resolve从当前原生安装/能力返回
`ProviderCatalogSource`：完整target、当前local_provider、contract_ref、capability_revision、每个观察视图的expires_at、
原生methods描述列表及`describe(method)`。同一Store服务沿用完整Target/read交集、当前主体和绑定校验，
稳定目录身份绑定契约、能力修订、方法内容、provider配置及恢复代次，不把每次resolve的观察期限作为修订。
同次描述仍受最早取得的观察期限约束；每页重新核验当前有效视图，后续游标沿用原期限与当前视图的
较早值，不能通过resolve或翻页续期。它不会把目录或schema变成执行许可。实际调用仍走同一runtime准入、原Wire和原生backend。
旧Luvus catalog结构与校验路径保持兼容；CLI使用`resource.catalog ?? gateway.catalog`消费同一真实
连接上的目录，Herdr无需填造UHP schema或Luvus可信来源。混合资源用`kind: 'mixed'`分别交付
原Luvus providers与`hosted`中性会话组，目录的`select(target)`只委托原resolver；
Luvus目录在唯一runtime建立后绑定其实际catalog。Connector复用原Luvus session builder与Herdr原owner，
共享一套设备身份和一条出站连接，不增加Router、Wire codec或原生许可入口。精确接口见
[provider runtime](../PROVIDER-RUNTIME.md)。

`gateway [--config ...]` / `connector [--config ...]`缺真实来源时退出3；
Gateway持续监听HTTP，stdin EOF与客户端退出不停止它，SIGINT或SIGTERM关闭本地资源，失败退出1。
`CliRuntime.service` 可注入 `platform`、真实 `ServiceManager` 及受信 `resolveDefaultConfig(role)`；
唯一CLI在读取角色配置前委托服务模块，诊断统一写入stderr。`service --help` 独立可用，其余动作
缺宿主返回 `backend_unavailable`。默认路径只接受宿主已验证身份的共享helper结果；详见 [SERVICE](../SERVICE.md)。

`update --help`离线可用；`update --check`复用固定官方来源和现行更新预算，只读版本、manifest与tag元数据。
CLI使用构建版本和实际平台，Linux只接受运行时报告的glibc证明；版本状态和固定错误仅写stderr。
当前预发行版本按规范SemVer比较，目标限官方稳定发行。默认入口缺可信安装及服务事务，存在新版本时
`update`返回`replacement_unavailable`/5，不下载或替换；受信embedding可注入现行POSIX事务，

help、版本、检查结果和错误写 stderr；只有显式 config template 输出非秘密 JSON 到 stdout，
Gateway运行期stdout不承载MCP或身份材料。退出码为 0 正常、2 参数/配置错误、3 缺后端、1 运行失败。

## 验证范围

[真实HTTP SDK测试](../../test/mcp/http.test.ts)使用官方StreamableHTTPClientTransport和真实回环listener，
业务实现仅为明确标注的[服务stub](../../test/mcp/stub-fixture.ts)。它保留11工具、五方法族stub、
参数拒绝、结构化/文本保真、分页、原生error、超响应、history及等待取消断言，不构成生产native证明。
[HTTP边界测试](../../test/mcp/boundaries.test.ts)覆盖Host/Origin、逐请求认证、跨主体会话、DELETE/断开、
大小/编码/JSON、容量/过期/deadline、falsey ID、重复关联及等待隔离。
[SDK契约探针](../../test/mcp/sdk-compatibility.test.mjs)用同一锁定版本真实协商2025-11-25。
[CLI测试](../../test/cli/cli.test.ts)验证双角色、配置拒绝、同一bundle、stdin EOF持久运行和缺后端行为；
[默认路径测试](../../test/cli/config-path.test.ts)验证显式优先、角色隔离、home、空格Unicode及首次缺失文件生成。
[Store业务](../../test/mcp/store-service.test.ts)、[Store HTTP SDK](../../test/mcp/store-sdk.test.ts)、
[CLI writer](../../test/cli/store-runtime.test.ts)使用真实隔离数据库与合成身份，保留授权、元数据和清理断言。
[公开生产CLI测试](../../test/cli/production.test.ts)直接运行`main.ts`子进程，以私有合成caller摘要和本地WS
接正式HTTP SDK及实际 Store，覆盖EOF、撤权、退出释放和缺native来源明确拒绝，不注入业务service。
[管理作用域测试](../../test/cli/management-scope.test.ts)使用真实PR69/PR71认证与作用域；业务计数stub
只验证原CSRF/关闭预算和单次委托，不作为实际管理写入或custody证明。
[transport CLI](../../test/cli/transport-runtime.test.ts)实际经过listener/WS拒绝认证、EOF持续运行、信号清理，
并验证交错异步caller隔离和身份撤销；认证/native回调仍是明确fixture。
[catalog业务](../../test/mcp/catalog.test.ts)与[HTTP SDK](../../test/mcp/catalog-sdk.test.ts)使用真实
Luvus catalog/NativeValidator及Store，身份、在线能力及来源为人工fixture，不执行原生RPC。
生产host装配、真实HTTP认证、native执行/结果交付和管理写入必须另以实际环境验收；
缺后端动作继续明确拒绝，不能以模块测试、工具发现或stub成功代替。

[真实会话驱动](../../test/mcp/native-conversation.ts)的`runNativeConversation(plan)`接收已经连接的
正式SDK客户端、固定绝对deadline和provider原生字段映射。provider宿主负责受控真实实例及既有凭据，
映射仅构造官方请求或投影原生响应，不返回业务成功替身。流程从原生发现结果选择窗口/session，执行并
验证官方管理请求，读取原生Agent状态，再在同一session连续发送两轮提示并读取实际回复。
第二轮提示不携带第一轮的随机marker，必须从上下文准确回忆；回复的原生prompt关联键、不同message_id、
session_id和agent_id均核对，前后状态也核对同一Agent。状态来源为inferred/unknown不能通过此原生状态验收。
原生异步回复由`replyRequest(sent, selected)`读取，`reply(response, sent)`保留当前发送的原生关联；
不重发prompt。每次`runtime_call`仅准入一次，等待只查询原call_id，结果分页校验原大小与摘要。
驱动不自行启动用户实例、输出提示/回复或登记通过；须由各provider真实环境测试调用并保留原生证据。

Luvus 的唯一 CLI 隔离入口先构建同一 `main.ts`，再启动其 Gateway/Connector 子进程：

```sh
bun --no-env-file run build
bun --no-env-file scripts/mcp/verify-luvus-cli.mjs \
  --built-cli \
  --binary /absolute/protected/luvus \
  --opencode-binary /absolute/protected/opencode \
  --temporary-parent /absolute/protected/parent \
  --acknowledge-nonproduction
```

`--opencode-binary` 可省略；提供时复用固定官方 binary 摘要及隔离 OpenCode 配置，
省略时只执行六个窗口/Agent目录读取，报告`verification_scope: selected_window_read_only`，不提交Agent输入。
只操作本轮新建 root、短期合成身份和原代理环境。省略 `--built-cli` 使用源码入口；
`--standalone-cli` 使用现有 `release:build` 生成的 Linux x64 候选，两种产物选项互斥。
三者均进入同一产品 main，不提供另一套 parser、native adapter 或成功后端。

此脚本的 Gateway、Connector 与 Luvus 位于同一机器，WSS 使用loopback；默认Gateway在本机
attach既有Luvus。加`--remote-gateway`时，Gateway配置只含固定pin与受保护schema引用，
目录来自实际认证Connector快照，不交付本机native引用。两种模式均不构成跨机验收；
Connector位于另一台机器且不共享runtime文件系统的部署仍须单独验证。
该验收的临时远端配置仅为本轮合成caller与实际用到的已审raw方法显式设置`raw_grant`；
产品配置的raw批准仍由受保护宿主独立提供。

加 `--minimum-native` 时仅核对真实 provider/分页目录、describe、单次 `pane.list` 和原结果分页摘要，
再验收 SDK 断开、角色关闭与自有目录回收；报告范围为 `verification_scope: native_rpc_minimum`。
该选项与 `--opencode-binary` 互斥，不执行窗口变更、Agent 输入或模型请求，也不表示完整会话验收。

正式 SDK 流程位于 [luvus-sdk-flow.mjs](../../scripts/mcp/luvus-sdk-flow.mjs)：核对当前 provider
绑定与分页目录，从实际 pane 选择稳定 workspace/tab ID 并回读，显式选中 pane/Agent 后
只提交一次输入，再读取同一 terminal 的原生输出。未知状态与 null Agent session 原样保留；
输入 submitted、TUI 输出及进程存活不表示模型回复，报告始终区分模型/两轮未验证。
schema、启动、目录或原生请求失败都会使整个 CLI 验收非零退出，不跳过编译守卫或手写 artifact。

每个新原生意图最多30秒，SDK单请求服从该意图剩余deadline；查询使用零短等并间隔100ms，只读取原call_id。
结果已responded后，读取另有最多30秒固定交付窗口，同时受原句柄expires_at与整个流程截止约束；
交付窗口只建立一次，结果分页不能刷新它、句柄TTL或已准入意图的deadline。
总流程按最小1次、窗口读取6次、含Agent输入11次
原生意图分别封顶；`budgets`报告保留各层预算，最多256条诊断只含固定阶段、状态、序号及耗时。
每次结果大小与摘要核验完成后输出一条脱敏进度，不输出原生正文、路径、句柄或提示。

[SDK 流程测试](../../test/mcp/luvus-cli-flow.test.mjs)独立使用明确服务 stub，覆盖分页、原 call
轮询、未派发 created 的 null 契约、已绑定契约倒退、稳定 ID、单次输入、结果摘要及 terminal/Target
漂移拒绝。它只证明协议和流程断言可执行，不能代替上述真实 CLI/native 验收。

<a id="client-call-sequence"></a>

## 客户端调用顺序

本节面向 MCP 客户端实现者；普通安装操作见[快速开始](../QUICK-START-zh.md)。
可接受的参数由[实际 MCP schema](../../src/mcp/schema.ts)定义。

1. 使用已签发的 Bearer 初始化 Streamable HTTP，并加载全部工具页。
2. 通过 `machines_list`、`providers_list` 和 `providers_get` 查看设备、provider、
   就绪状态及当前 `binding_revision`。
3. 使用初始化时显示或管理员提供的完整 Target：`machine_id`、`provider_id`、
   `profile`，以及 session profile 所需的 `session`。
   provider 列表不提供 `profile`/`session`，不得猜测。
4. 将该 Target 和观察到的 revision 作为 `expected_binding_revision` 传给
   `runtime_discover`，逐页跟随 `next_cursor`。用 `runtime_describe` 描述精确方法，
   并保留其返回的 `contract_ref` 和原生参数 schema。
5. 携带该 Target/revision/contract 和 `native_request:{method,params}`，
   只提交一次 `runtime_call`。`deadline` 是未来的 Unix 毫秒绝对时间；
   可选的 `wait_ms` 为0–5000，只控制前端等待。
6. 保留 `call_id`，通过 `runtime_call_get` 查询原调用。取得可用的 `result.result_id`
   后，用 `runtime_result_read` 读取结果，跟随 `next_cursor` 至 `eof`，并遵循
   `encoding`。超时不代表获准重新提交。

先调用 `workspace.list`，再使用该 provider 描述的 tab/pane 列表方法。
Luvus 的 `workspace.list` 等通用方法要求 `validation:"raw-contract"` 和 raw 授权。
Luvus 的 `pane.list`、`agent.prompt`、`agent.send`、`agent.wait` 和 `agent.keys`
使用严格校验；Herdr 使用其实际 schema 和严格校验。
不得复用其他 provider 的 ID、revision 或契约摘要。

对话前，先描述 `agent.list/get/explain/read`，再选择实际观察到的 Agent/窗格。
启动已安装的 Agent 时，Luvus 的 `agent.start` 接受 `pane`，Herdr 接受 `pane_id`；
其余字段按各自原生 schema 填写。Luvus 的 `agent.prompt` 使用 `target`、`text`、
观察到的 `terminal_id` 和 `strict:true`；Herdr 使用 `target`、`text`，以及可选的
对象型 `wait`。按已描述的 `agent.get/wait/read` 操作读取真实回复，并保持同一段
原生会话。不得用任意可执行参数或环境变量绕过已禁用的终端执行。
