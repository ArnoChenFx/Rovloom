# MCP Streamable HTTP 与持久 CLI 宿主契约

本文维护 `src/mcp`、`src/cli` 的接线边界；系统语义以 [DESIGN](../DESIGN.md#7-mcp-工具面)为准。
模块属于内部技术预览。`StoreGatewayService` 与 `createStoreCliRuntime` 已接实际 Store/Router；
独立 CLI 默认未装配受信身份、设备 transport 或原生 adapter，角色启动仍返回 `backend_unavailable`。
工具发现、人工历史或服务 stub 的结果不能称为原生执行成功。

## 宿主接口

准确签名见 [MCP 类型](../../src/mcp/types.ts)和 [CLI 接口](../../src/cli/run.ts)。

- `GatewayService.execute(name, args, context)` 接收严格校验后的 `ToolArguments[name]`，
  返回 `ServiceReply[name]`。每个请求仅调用服务一次；facade 不持有调用账本、不生成 native ID、
  history scope、内容句柄或执行许可，不重试、不跨 provider 改写目标。
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
  CLI拥有MCP listener；宿主不重复创建入口。Connector仍返回closed/close，具体transport由宿主建立。
  stdin EOF及客户端退出不停止持久Gateway；只有角色终止信号触发listener及宿主资源清理。
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
  transport 类型，工厂不剥原帧或重注入 auth，固定使用 WSS origin 的 `/connector` 端点。
  两角色关闭均先停止实际 transport 再释放宿主资源，重复关闭共用同一 Promise；启动失败也清理。
  缺少角色宿主不会创建默认身份、设备或 native 服务，独立 `main.ts` 尚未装配生产宿主。

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
列表游标为最多 128 个、30 秒有效的进程内关联，绑定 principal、查询/limit、双方政策及恢复代次；
每页重新授权，旧政策、查询变更、期限或重启后明确 invalid_cursor，不能将 offset 当作权限。

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
调用准入须在同一 Store 事务使用绝对 deadline，并区分新登记与原 history/key 命中；
现有 Router.admit 已提供同步 CallAdmission（call/created）与绝对 deadline 端口，MCP runtime 尚未装配；
不能从旧 createCall 的相对 timeout 或既有 state 猜测首次登记，created=false 即使仍为 created 也不得派发。
读取须通过原 Wire adapter 的 checkResult，绑定当前 reader、完整 attempt、原 permit 和普通交付通道；
只用当前分类、原请求重校验或 responseAnchor 不能恢复原派发时的秘密/保留授权。
transport 默认在提交后释放执行上下文；显式 retainOriginalRead 的有界保留仍须通过原 resolver，
不能把仅供晚到元数据核验的 ResponseOnlyContext 当作读取许可。结果页使用 Store.readResult 返回的
实际句柄 expires（Store 绝对毫秒，now < expires 有效），不能用内容期限代替，或创建新句柄续期。
机器注册/改名的现有 Store 审计仍使用 local，缺少调用者归属事务；
撤销还缺当前通道关闭和完整管理回执，三项均拒绝，不调用凭据签发/兑换或伪造管理成功。
Store 的受保护设备生命周期桥不替代这些管理端口；deviceLifecycle 只可由可信宿主显式注入，
facade 不调用 connectVerifiedDevice/resetDeviceEnrollment，也不消费凭据校验证明或解除身份 blocked。
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

operations_get、确认、配对和所有管理写入目前返回 backend_unavailable。完整后端必须在
Store writer 的同一事务保存管理 history/请求摘要、真实确认消费、状态变更和带 actor 的审计回执，
不能用内存 Map、业务 call、换 key 或查询到相似状态冒充该次操作已提交。request_id 标识待执行
意图；确认记录和动作回执使用区分种类的幂等命名空间，均绑定原 principal/session/history。
确认摘要必须覆盖 action、完整 target/kind、reason、恢复代次、管理 revision、binding revision
和适用 epoch；后台返回保存的 summary，真人确认默认至多 2 分钟，重复确认不续期。
HTTP 写超时后仅查询原 operations_get；未知结果不自动重放。GET 不能签发 scope 或凭据。

断开必须由真实 transport 关闭确切 epoch；Store.disconnect 只是持久账本收敛，不是通道关闭。
provider 启停还须双端配置核对、独立 providers_manage、确认及新 revision，并释放对应资源；
旧流/句柄/attempt 不复用，原生工作可能继续。Store 当前没有设备管理 revision、管理员
history/回执与注册/改名 actor 事务端口，需由存储/管理后端补齐；本模块不绕开它们写私有 SQL。

管理读请求需拒绝未知字段，设备/provider 标识符最多 128 字节，cursor 最多 1024 字符，
分页默认 50、最大 200，设备 states 筛选只接纳上述有界枚举。HTTP 适配器还须限制请求体和响应字节并映射固定公共错误；模块没有
提供独立管理 HTTP listener。恢复隔离只允许独立 recovery_local 管理会话读 status，普通元数据和全部
写入均拒绝；storage_degraded 仅保留满足授权/预算的有界读取及现有独立清理路径。

## MCP 消息与工具

使用锁定SDK 1.32.1的 `Server`、`WebStandardStreamableHTTPServerTransport` 和官方请求schema，
实现已核实的2025-11-25协商。只使用Streamable HTTP，不保留stdio或旧HTTP+SSE兼容入口。
`startHttpFacade` 通过Bun.serve提供默认回环listener；`createHttpFacade`供明确的TLS/反向代理宿主组合。
不升级依赖或照抄其它SDK版本API；本地测试不代表商业Host、OAuth或真实双机验收。

每个stateful会话独立拥有Server/transport，所有会话复用同一业务service/Store/Router。
每请求先认证并与会话绑定的principal精确匹配，sessionID仅用于路由。
默认最多64会话，空闲15分钟清理；最多256个HTTP请求等待，每请求35秒deadline（宿主上限60秒）。
逐请求取消只影响自身等待；DELETE和会话过期关闭该会话，不停止Gateway或取消native。
无event store，不承诺断线事件重放；失败后的业务重试仍受原history/key门禁约束。

只接固定 `/mcp`，不接受query、userinfo或其它路径。Host必须精确匹配受信origin；
Origin存在时须命中显式完整origin白名单，缺Origin允许标准非浏览器客户端。
不信任X-Forwarded-*等转发身份头。默认只绑定127.0.0.1或::1；公网TLS/认证不由模板自动启用。
管理UI/API、设备WSS与MCP保持独立listener/身份/权限边界。
原始请求体在任何JSON解析前限1MiB并受deadline约束，严格拒绝重复JSON键、非法/截断UTF8、
过深/过多节点及批量RPC；传给SDK的parsedBody已过同一字节上限。总header最多16KiB。
SDK负责初始化、协议版本、HTTP方法、Accept/Content-Type与标准会话检查。
SSE响应起始只有刷新响应头的注释，无额外MCP通知；普通诊断只输出固定代码。

工具包括 machines 的 list/get/register/rename/revoke、providers 的 list/get，
以及 runtime 的 discover/describe/call/call_get/call_cancel/result_read/response_discard。
不暴露流、Host 特权捷径、provider 管理或 `luvus_*` 别名；工具存在不证明具体 runtime 已开放。
所有参数根拒绝未知字段。Target 使用完整 machine/provider/profile/session，Host 分支禁止 session。
caller 不能注入 principal/admin/discard_response，native_request 只允许 method/params，不能自填 id/auth。
原生参数的完整约束及额外秘密/注入字段仍由受信安装契约和服务检查。

`runtime_call` 要求 expected_binding_revision、contract_ref 和绝对毫秒 deadline。
validation 默认 strict，wait_ms 默认 0、上限 5000；短等与执行期限独立。
有 key 的请求必须携带服务发放的 history_epoch、recovery_generation 和原 client_request_key，
facade 不为重试更换任何范围。`runtime_response_discard` 是独立动作，服务必须验证归属、
原方法当前策略和专门 discard_response 权限。注册仅投影非秘密 registration_id、pending 和渠道提示，
不会签发或转发 enrollment。设备/provider 公共视图仅输出类型中列出的展示字段。

成功结构为 `structuredContent: {data: ...}`，并提供 JSON 文本副本。
原生 error 保持在 `data.native_response.error`，服务以 `is_error` 标明工具错误；
网关拒绝为 `isError: true` 和 `gateway_error: {code}`。未知工具/参数为固定 JSON-RPC 错误，
不回显请求值、服务异常、私人路径或栈。HTTP承载协议，stdout不承载MCP；stderr仅允许固定诊断代码。

tools/list 每页 5 项，用 SDK 标准 nextCursor；此游标仅索引静态目录。
业务列表和结果游标由服务产生，须绑定 caller、查询/Target、结果、期限和当前授权，
不能将任意 offset 当授权。结果读取 max_bytes 默认 4096、上限 16384；服务须按 UTF-8/编码
边界形成可读页，不能擅自放宽原生/结果限额。

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

两种角色使用相同入口和版本。模板只包含固定绝对 state_dir 与非秘密引用；
Gateway使用固定回环HTTP地址、端口与authentication_ref，Connector 使用 provider_config_refs 和无凭据 WSS origin。
URL 禁止 userinfo/query/fragment/自定义路径，endpoint 路径由受信 transport 宿主固定。
不接受 argv secret、enrollment、配对、账号注册或任意 shell 命令。

将模板保存到当前用户持有的 0700 目录中，配置文件设为 0600，替换为受信绝对路径后，
使用 `config check --config /absolute/protected/config.json` 只读验证。
`gateway` 默认读取 `~/.config/rovloom/gateway.json`，`connector` 默认读取
`~/.config/rovloom/connector.json`；Windows 同样使用用户 home 下的 `.config/rovloom`，不改用 AppData。
当前受保护配置读取仅支持 POSIX；Windows 只定义上述路径规则，实际读取返回 `config_platform_unsupported`。
显式 `--config` 优先且不依赖 home。`resolveRoleConfigPath` 是 CLI 和服务宿主共用的路径选择接口；
选择后仍核对配置 role 与子命令，不回退另一角色文件，不自动创建目录、配置或秘密。
所选文件或目录缺失时返回固定 `config_not_found`；缺省路径无法取得有效 home 时返回
`config_home_unavailable`。这些诊断不输出实际路径。
配置不允许未知字段；读取拒绝 symlink、非 regular file、宽松权限和超过 16 KiB 的文件。
state_dir 在这里仅作绝对规范路径校验，实际目录所有权、单 writer、锁和可信引用解析由宿主负责。
CLI 不创建数据库、真实凭据或连接。

`gateway [--config ...]` / `connector [--config ...]` 在没有相应宿主时退出 3；
注入宿主后持续监听HTTP；stdin EOF与客户端退出不停止Gateway，SIGINT或SIGTERM关闭本地资源，失败退出1。
help、版本、检查结果和错误写 stderr；只有显式 config template 输出非秘密 JSON 到 stdout，
Gateway运行期stdout不承载MCP或身份材料。退出码为 0 正常、2 参数/配置错误、3 缺后端、1 运行失败。

## 验证范围

[真实HTTP SDK测试](../../test/mcp/http.test.ts)使用官方StreamableHTTPClientTransport和真实回环listener，
业务实现仅为明确标注的[服务stub](../../test/mcp/stub-fixture.ts)。它保留14工具、五方法族stub、
参数拒绝、结构化/文本保真、分页、原生error、超响应、history及等待取消断言，不构成生产native证明。
[HTTP边界测试](../../test/mcp/boundaries.test.ts)覆盖Host/Origin、逐请求认证、跨主体会话、DELETE/断开、
大小/编码/JSON、容量/过期/deadline、falsey ID、重复关联及等待隔离。
[SDK契约探针](../../test/mcp/sdk-compatibility.test.mjs)用同一锁定版本真实协商2025-11-25。
[CLI测试](../../test/cli/cli.test.ts)验证双角色、配置拒绝、同一bundle、stdin EOF持久运行和缺后端行为；
[默认路径测试](../../test/cli/config-path.test.ts)验证显式优先、角色隔离、home、空格Unicode和无创建。
[Store业务](../../test/mcp/store-service.test.ts)、[Store HTTP SDK](../../test/mcp/store-sdk.test.ts)、
[CLI writer](../../test/cli/store-runtime.test.ts)使用真实隔离数据库与合成身份，保留授权、元数据和清理断言。
[transport CLI](../../test/cli/transport-runtime.test.ts)实际经过listener/TLS拒绝认证、EOF持续运行、信号清理，
并验证交错异步caller隔离和身份撤销；认证/native回调仍是明确fixture。
[catalog业务](../../test/mcp/catalog.test.ts)与[HTTP SDK](../../test/mcp/catalog-sdk.test.ts)使用真实
Luvus catalog/NativeValidator及Store，身份、在线能力及来源为人工fixture，不执行原生RPC。
生产host装配、真实HTTP认证、native执行/结果交付和管理写入必须另以实际环境验收；
缺后端动作继续明确拒绝，不能以模块测试、工具发现或stub成功代替。
