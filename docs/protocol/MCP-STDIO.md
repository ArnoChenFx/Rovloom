# MCP stdio 与 CLI 宿主契约

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
- `StdioCallerProvider.resolve({uid, gid})` 由宿主依据当前 OS 身份及受保护配置解析 principal，
  每次调用重新读取有效绑定。caller 参数、`_meta`、环境变量和设备凭据均不参与身份建立。
  缺少身份时拒绝。该预览只提供 POSIX UID/GID 路径，未证明的平台保持拒绝。
  `createLocalCallerProvider(path, bindingRef)` 提供当前 POSIX 身份到已有 principal 的文件绑定实现；
  path 仅由受信宿主指定，不是 MCP 参数或独立 CLI 新增选项。它不创建身份、政策或管理员会话。
- 共享业务 context 仅包含受信 caller 与 wait_signal；OS 身份只交给 stdio 的身份解析器。
  WebUI 可复用相同设备/provider DTO 与业务服务，须由独立管理员认证向同一身份/策略后端取得
  principal，不能从浏览器 JSON 构造身份，或把 stdio 身份自动升级为管理员。
  设备断开、provider 启停、健康与真实确认管理仍须各自的后端接口，不能伪装为 runtime_call。
- `context.wait_signal` 仅用于停止前端等待。MCP 取消、EOF 或关闭不调用 `runtime_call_cancel`，
  不表示取消执行、回滚、not_dispatched 或可重发。服务关闭也必须保留可能送达的 unknown 锚点。
- `CliRuntime.gateway(config)` 返回 service、caller 与 `close()`；CLI 使用 `startStdioFacade`
  运行标准 stdio。`CliRuntime.connector(config)` 返回 `closed`/`close()`，由 transport 宿主负责连接。
  宿主必须有界启动，关闭不得将可能已执行的工作误报为回滚。配置不加载任意模块或命令。
- `createTransportCliRuntime(host)` 复用已合入的 `createGateway/createConnector`，不实现第二套通道。
  Gateway 宿主交付已打开的 Store、同一身份/政策来源、caller、验证身份桥及逐 socket session；
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

宿主可用 `createLocalCallerProvider` 为 caller 注入受保护文件。文件为当前 POSIX 用户持有的
私有 regular file，父目录无组/其它用户权限，文件无组/其它用户权限，最多 16 KiB。
结构为 `{schema_version: 1, bindings: [...]}`；每条记录恰含 ref、uid、gid、principal_id，
ref 对应 Gateway 的 caller_binding_ref，数字 uid/gid 必须同时等于本次真实 OS 身份。
同一 ref/uid/gid 不允许重复；额外权限、秘密字段、重复 JSON 键、非法 UTF-8/BOM、
最终文件/直接父目录 symlink 或不合格保护均使本次解析返回未认证；更高层目录的信任由受信宿主保证。
每次工具请求重新打开并读取，文件撤销即时生效；
不从 USER/环境变量、MCP 元数据或设备凭据推导身份。空 bindings 不授权任何 principal。
principal 的存在与当前政策仍由同一 GatewayIdentitySource 检查，文件绑定本身不授予业务权限。

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
公共 createCall 目前只接收相对 timeoutMs、返回 Call，服务不能猜测是否首次登记或刷新期限。
读取须通过原 Wire adapter 的 checkResult，绑定当前 reader、完整 attempt、原 permit 和普通交付通道；
只用当前分类、原请求重校验或 responseAnchor 不能恢复原派发时的秘密/保留授权。
transport 默认在提交后释放执行上下文；显式 retainOriginalRead 的有界保留仍须通过原 resolver，
不能把仅供晚到元数据核验的 ResponseOnlyContext 当作读取许可。结果页使用 Store.readResult 返回的
实际句柄 expires（Store 绝对毫秒，now < expires 有效），不能用内容期限代替，或创建新句柄续期。
机器注册/改名的现有 Store 审计仍使用 local，缺少调用者归属事务；
撤销还缺当前通道关闭和完整管理回执，三项均拒绝，不调用凭据签发/兑换或伪造管理成功。
Store 的受保护设备生命周期桥不替代这些管理端口；deviceLifecycle 只可由可信宿主显式注入，
facade 不调用 connectVerifiedDevice/resetDeviceEnrollment，也不消费凭据校验证明或解除身份 blocked。
独立入口仍需受保护的 caller 配置和真实身份来源，不能自动采用测试工厂。

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
提供 HTTP listener。恢复隔离只允许独立 recovery_local 管理会话读 status，普通元数据和全部
写入均拒绝；storage_degraded 仅保留满足授权/预算的有界读取及现有独立清理路径。

## MCP 消息与工具

使用锁定 SDK 1.32.1 的 `Server`、`StdioServerTransport` 和官方请求 schema，
已验证 revision 为 `2025-11-25`。SDK 自身的协商不能作为其它 revision、商业 Host、HTTP/OAuth
或真实双机兼容的证据。`startStdioFacade` 是经过错误脱敏和消息大小限制的 stdio 入口；
裸 `createMcpFacade` 供可信宿主组合，使用其它 transport 时须自行提供同等边界。

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
不回显请求值、服务异常、私人路径或栈。stdout 只写协议，stderr 仅允许固定诊断代码。

tools/list 每页 5 项，用 SDK 标准 nextCursor；此游标仅索引静态目录。
业务列表和结果游标由服务产生，须绑定 caller、查询/Target、结果、期限和当前授权，
不能将任意 offset 当授权。结果读取 max_bytes 默认 4096、上限 16384；服务须按 UTF-8/编码
边界形成可读页，不能擅自放宽原生/结果限额。

完整 stdio 输出帧（包括文本副本、JSON 转义和 envelope）最多 64 KiB，输入缓冲最多 1 MiB，
单工具参数最多 64 KiB，最多 16 个工具请求在途，字符串请求 ID 最多 128 字节。
输出另以最多 16 个待发送帧、合计 1 MiB UTF-8 字节限制队列；单次只向 stdout 提交一帧，
等待其物理写回调及适用 drain 后才释放发送预算和内部关联。公共 ID 在该帧开始写入时解除
接收关联，客户端收到回复后即可复用，旧发送的收尾不会删除新关联。下游背压时暂停 stdin，排空后恢复；
同一输入 chunk 内已解析的回复也计入该队列，超限关闭会话，不丢帧伪装成功或自动重试。
关闭会明确拒绝未完成发送，移除 drain 监听并终止尚未完成的 stdout 写入；错误处理保留到实际
终止事件，EOF 后晚到的 EPIPE 仍由所属写回调观察，只产生固定诊断，不回显底层异常。
字节流先做增量严格 UTF-8 验证，非法/截断序列关闭，不让 SDK 替换字符后派发。
公共请求 ID 在 stdio 边界映射为 SDK 私有正整数并在回复中还原；0/空字符串同样可取消。
取消只终止等待，并抑制尚未开始物理写入的晚到或排队回复；这些等待取消后可复用公共 ID。
开始写入即提交该回复，之后的取消不能撤回已交给 stdout 的帧；客户端须消费该回复后再复用 ID。
重复在途 ID 或超过 1024 个在途协议关联会关闭会话，避免覆盖等待/关闭关联；不自动重发。
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
Gateway 使用 caller_binding_ref，Connector 使用 provider_config_refs 和无凭据 WSS origin。
URL 禁止 userinfo/query/fragment/自定义路径，endpoint 路径由受信 transport 宿主固定。
不接受 argv secret、enrollment、配对、账号注册或任意 shell 命令。

将模板保存到当前用户持有的 0700 目录中，配置文件设为 0600，替换为受信绝对路径后，
使用 `config check --config /absolute/protected/config.json` 只读验证。
配置不允许未知字段；读取拒绝 symlink、非 regular file、宽松权限和超过 16 KiB 的文件。
state_dir 在这里仅作绝对规范路径校验，实际目录所有权、单 writer、锁和可信引用解析由宿主负责。
CLI 不创建数据库、真实凭据或连接。

`gateway --config ...` / `connector --config ...` 在没有相应宿主时退出 3；
注入宿主后，EOF（Gateway）、SIGINT 或 SIGTERM 关闭桥接及本地资源，关闭失败退出 1。
help、版本、检查结果和错误写 stderr；只有显式 config template 输出非秘密 JSON 到 stdout，
Gateway 运行期 stdout 始终专用于 MCP。退出码为 0 正常、2 参数/配置错误、3 缺后端、1 运行失败。

## 验证范围

[真实 SDK 测试](../../test/mcp/stdio.test.ts)使用 SDK Client/stdio 子进程，
业务实现仅为明确标注的 [服务 stub](../../test/mcp/stub-server.ts)。
这证明 facade 的协议、参数、caller 注入、错误、分页和关闭边界，不能证明真实授权服务、
原生五类方法执行、持久去重、配对或两台机器的 transport。
[CLI 测试](../../test/cli/cli.test.ts)验证两角色解析、配置拒绝、同一 bundle 和缺后端行为。
新增[真实 Store 测试](../../test/mcp/store-service.test.ts)、[SDK 接线测试](../../test/mcp/store-sdk.test.ts)
和[CLI writer 生命周期测试](../../test/cli/store-runtime.test.ts)使用隔离数据库与合成身份；
人工历史不证明原生执行。生产垂直切片仍依赖 native adapter 与可信 caller/config 宿主联合验收。
管理写入另需管理持久端口；不把该管理面后端或后续双机/HTTP/发行验收列作本期 native 五方法族证据。
[本机 caller 文件测试](../../test/cli/caller-binding.test.ts)核对私有文件、真实 POSIX 匹配、歧义拒绝和即时撤销。
[SDK/CLI/Store 测试](../../test/mcp/local-caller.test.ts)经真实 SDK 子进程装配 caller 文件与实际 Store，
验证授权元数据查询、撤销后拒绝及 EOF 释放 writer；身份政策为合成 fixture，未启动 Connector 或 native。
单文件独立入口仍未装配这些宿主，不能将模块测试当作五方法族原生闭环或两角色实际启动验收。
[transport CLI 测试](../../test/cli/transport-runtime.test.ts)实际经过 runCli、listener、TLS socket、
拒绝认证、EOF/信号及资源清理，并验证交错异步请求的 caller 隔离和身份撤销。
身份/原生回调仍是明确的测试 fixture，认证全部拒绝；该测试不证明 native 执行或生产宿主启动。
[catalog SDK 测试](../../test/mcp/catalog.test.ts)使用实际 Luvus catalog/NativeValidator、实际 Store
和标准 stdio 客户端验证授权目录、描述、分页及来源 fence。设备凭据/epoch、在线能力和来源证明
明确为人工 fixture；没有执行原生 RPC，不计为真实五方法族 discover→describe→call→get/read 验收。
