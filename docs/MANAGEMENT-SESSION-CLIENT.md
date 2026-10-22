# 管理会话适配与浏览器确认逻辑

> 本文描述所属细节的现行实现；系统语义以 [DESIGN](DESIGN.md) 为准，冲突时以 DESIGN 为准（导航见 [文档索引](README.md)，总览见 [协议总览](PROTOCOL.md)）。

本切片接在 [管理写服务](MANAGEMENT-WRITES.md) 的既有事务和 HTTP handler 上，语义沿用
[DESIGN](DESIGN.md) 与 [GATEWAY-WEBUI](GATEWAY-WEBUI.md)。提供设备三动作、provider禁用、pending注册/配对/取消及原申请进度的
可复用逻辑。生产 CLI 可接收既有受保护宿主的管理页面交付接口；默认入口不配置管理员或签发秘密。
生产 `browser.ts` 已通过 `mountWebUi` 的第四参数消费既有写客户端；首次用户认证及真实会话来源仍由现有宿主负责。
没有生产会话来源时不能启用写操作。测试里的临时管理员、cookie 与 CSRF 不是生产身份。

## 运行宿主接口

`src/admin/index.ts` 导出 `createManagementSessionAdapter` 和 `ManagementSessionSource`。
适配器只消费宿主已经建立的受保护会话，不签发 cookie、token、CSRF，不创建账户、角色或 listener。
会话来源必须使用与 `GatewayRuntimeOptions.identities`、原共享读服务及写服务**同一个对象引用**；
形状相同的另一个来源也会拒绝，查询等待期间替换来源同样拒绝。

```ts
import { createManagementSessionAdapter, createManagementHandler } from './admin/index.js'

const sessionAdapter = createManagementSessionAdapter({
  identities: runtimeIdentities,
  sessions: protectedManagementSessions,
  cookie_name: protectedCookieName,
  origin: managementOrigin
})
const managementHttp = createManagementHandler({
  service: sharedManagementService,
  origin: managementOrigin,
  authenticate: sessionAdapter.authenticate,
  verifyCsrf: sessionAdapter.verifyCsrf,
  publicError: classifyManagementReadError,
  assets
})
```

上述变量均由既有宿主提供；`sharedManagementService` 使用原 Store、Router 与 Gateway。
适配器不代替运行宿主的 `runAuthenticated`，普通 caller 不能借该函数取得管理员身份。
listener 所有者挂接 `managementHttp.fetch` 并在退出时调用 `stop`，不应另起管理服务器。

尚待生产宿主交付的精确端口是：

- `protectedManagementSessions.identities === runtimeIdentities`。
- `resolveCookie(rawCookie, signal)` 查询当前受保护后端，返回
  `{ caller: { principal_id }, session_ref, expires_at, csrf_sha256 }` 或 `null`；
  `expires_at` 是可信服务器毫秒时间，`csrf_sha256` 是当前会话 CSRF 原值的 SHA-256 小写摘要。
  后端必须逐次检查失效/撤销并响应取消，不从 cookie 正文、请求头自报身份或普通请求参数造管理员。
- 同一 `identities.administrator(caller, session_ref)` 必须同步解析**当前**有效管理会话、期限、
  assurance、政策修订与精确目标 grants，供写事务内最后一次复核。HTTP 会话查询不能替代该复核。
- 现有受保护 bootstrap 在真实用户流程中建立会话、设置受保护 cookie 并将 CSRF 原值交付页面内存。
  首次授权及原管理会话更新/撤销由该后端负责；不建立公开登录端点或默认信任。

适配器只从指定 cookie 取得不透明查询键；拒绝重复/畸形 cookie、错误 Host/Origin 和跨站 Fetch Metadata。
没有 bearer 或 URL 身份回退。认证及 CSRF 分别重查当前绑定和 administrator，CSRF 要求 POST、精确 Origin、
当前会话及恒定时间摘要比较。查询异常、过期、撤销、时钟回退或来源不符均拒绝，不输出底层异常。
HTTP handler 原有的五秒等待、并发与正文边界仍然生效；不合作的后端在实际结束前继续占用额度。

## 生产宿主与页面交付

`ProductionCliSources.management` 接收非秘密 `port`、`http.assets/publicError`、可选 `listening`、
原管理动作回调和 `resolveLease(request, signal): Promise<ManagementSessionLease | null>`。
上述函数端口来自静态受信宿主代码，不能将回调放入 argv、URL 或 JSON 模板；必须同时提供原
`ProductionCliSources.administrator`。原 provider 的 `management` 与该宿主配置不能同时使用。
缺少管理员来源时启动拒绝，未配置管理面时保持关闭。

唯一产品loader也可通过Gateway `runtime.json`中的可选`management_ref`选择角色私有
`refs/<ref>.json`，装配现行文件来源适配器。它与静态administrator/management
端口互斥；监听固定127.0.0.1，管理端口不得与MCP或设备listener冲突。
未配置该ref仍不开启管理面，配置缺失/不合法时在打开provider或writer前失败。

来源精确字段为`schema_version: 1`、`kind: 'management-session-source'`、`port`、
`sessions`、`pairing_policy_refs`。每条session只消费既有
`ManagementSessionLease`、现行`Administrator`与独立`credential_sha256`。
摘要对应原管理员后端交付的32..256字符base64url高熵证明，不用于人工短密码；不能与任何MCP
凭据摘要重复。此适配器不创建账号、不签发该上游证明，也不从principal、文件权限或普通header
自动授予管理员。无秘密runtime模板只选择ref，不包含证明、cookie或CSRF。

根页面使用[HTTP Basic](https://www.rfc-editor.org/rfc/rfc7617.html)核验这一个请求携带的独立证明：
用户名为既有principal引用，密码为该证明；只接受规范Base64封装及有界ASCII内容。
未认证时返回固定401 challenge。只有实际证明、当前私有来源和原固定租期同时有效，才交给下述
authority bootstrap；管理API仍只接受原Cookie/CSRF，不接受Basic、MCP Bearer或URL身份回退。
证明原值不保存到配置、租期、页面、日志或CLI参数。来源变更、删除、权限丢失或时钟回拨会封锁
本轮来源；恢复旧文件不能恢复已有cookie，须由真实上游来源重新交付后显式重启。

`pairing_policy_refs`只标识原配置者已批准的策略引用；实际管理员grant、确认、Store和凭据交付仍由
原模块核对。

默认入口加载本次构建的实际WebUI资源。模块与standalone使用既有资源白名单插件内嵌相同产物；
源码入口只读固定`dist/webui`，缺包明确不可用，没有cwd、请求路径或配置指定的网页目录回退。

`resolveLease` 必须验证**这一个 Request** 已被原宿主保护，并返回原服务认可的
`caller/management_session_ref/issued_at/expires_at`，或无会话时返回 `null`。
loopback、Host、Origin、OS 用户、普通 header、MCP bearer 或固定管理员记录都不能替代此验证。
不生成新 session 引用，不延长旧租期。根页面不接收管理 cookie，不能依赖它反向认证根请求。

组合器复用唯一 Gateway 的 Store、authority 与身份来源，将页面初始化纳入原 HTTP handler 的
Host/Origin 检查、16 项在途上限及五秒预算。仅无查询的 `GET /` 和 `GET /index.html` 初始化；
普通静态资源、HEAD、查询参数及跨站请求不调用会话来源。`null` 返回不含秘密的原页面。
有效既有 lease 首次经 `authority.bootstrap(lease, { signal, rotate: false })` 验证后，建立最多五分钟的本地窗口：

- cookie 为随机不透明值，host-only、`HttpOnly; SameSite=Strict; Path=/admin/v1`，到期使用实际固定租期。
  Cookie 不按端口隔离；同 host 其它服务仍能接收匹配路径的 cookie，必须属于同一管理员信任边界。
  不能把 loopback 端口分离描述为 cookie 隔离。
- CSRF 原值仅出现在无缓存 HTML 的 `meta[name="rovloom-management-bootstrap"]`，
  `content` 为 base64url 原值，`data-expires-at` 为服务器毫秒截止。
  HTML 不包含 cookie、principal 或 session 引用，JSON、日志和监听地址不携带秘密。
- 刷新、新标签、首响应丢失与并发加载均再次核验根请求的独立上游证明及当前管理员，
  然后恢复同一有效 Cookie/CSRF 和原截止；不因页面加载旋转或滑动期限。
  initializer 为此只在有界进程内存保留交付原值，最多4096个与authority容量同时约束的引用；
  authority仍只用摘要解析。对应交付解析失效时删除缓存，initializer释放时由进程回收；无磁盘、URL、日志、JSON或浏览器持久存储副本。
- 本地五分钟窗口到期，管理API和旧Cookie仍401。根页面必须再次由`resolveLease`核验独立证明，
  才以`reauthenticate: true`建立新Cookie/CSRF；新截止不超过首次绑定的上游`expires_at`及当前时间后五分钟。
  单凭Cookie或修改旧lease时间不能续期。并发重认证复用同一新交付，旧Cookie/CSRF永不复活。
- 显式撤销、观察到的管理员/政策失效、原来源变更、上游到期、时钟回退及关闭继续fail closed；
  恢复页面不会解除这些墓碑。请求取消、listener停止或截止后不提交迟到签发，
  尚未结束的来源继续占用额度。浏览器过期后需刷新并重新通过根页面认证，不自动重放任何管理写入。

浏览器端使用现有写客户端所需的唯一回调：

```ts
const client = createManagementWriteClient({ csrf: createManagementPageCsrf(document) })
```

`createManagementPageCsrf` 读取后立即移除全部匹配 meta，只在闭包保存唯一合法原值；
缺失、重复、损坏、到期或该次 signal 已取消时返回 `null`。不读取 cookie、URL、principal、
session 引用或持久存储。UI 将该 `client` 交给其既有页面挂载入口；401/403 清理沿用页面自身行为，
宿主可以卸载页面并关闭客户端，无新增失效事件协议。此接口不代表默认 browser.ts 已挂载写动作。

## 浏览器接口与确认顺序

`src/webui/index.ts` 导出 `createManagementWriteClient`、`createDeviceManagementFlow`、
`ManagementClientError` 与共用类型。模块能独立构建到浏览器，不依赖 Node、Store 或服务端会话解析器。
设备详情与默认 `browser.ts` 已消费下列逻辑。`createManagementPageCsrf(document)` 沿用 CLI 的单 meta 契约：
宿主在 `no-store` HTML 中交付 `meta[name="rovloom-management-bootstrap"]`，其 `content` 为43字符 base64url CSRF，
`data-expires-at` 为实际 Unix 毫秒截止。消费立即移除全部匹配 meta，重复/无效交付拒绝，截止后清空内存原值。
该回调不建立身份、不读取 cookie、不写 URL 或浏览器存储；缺失原值时客户端在发送前拒绝。

```ts
const client = createManagementWriteClient({ csrf: protectedBootstrapCsrf })
const flow = createDeviceManagementFlow({ transport: client })
const review = await flow.prepare({ action: 'device_disconnect', machine_id })
// 页面展示review后，仅由本次用户明确确认触发：
const result = await flow.confirm()
// result.phase === 'unconfirmed'时，只可按原关联查询：
const reconciled = await flow.checkReceipt()
```

页面宿主接缝为 `mountWebUi(root, read, clock?, client)`。`client` 可由上例的
`createManagementWriteClient({ csrf: protectedBootstrapCsrf })` 创建，只消费宿主既有受保护内存结果。
页面卸载函数释放本页 flow；客户端的创建者随后显式调用 `client.close()`。
此接口不定义新的登录、bootstrap HTTP 端点或管理员身份来源。实际页面交互的隔离验收见
[开发说明](DEVELOPMENT.md#管理页面的隔离验证)。

示例各步骤是独立用户交互，不能在准备完成后自动执行确认或对账。每个 flow 只处理一个意图：

1. `prepare` 分配一次 request_id，取得服务器 history、当前 recovery_generation/revision/epoch 与待确认摘要。
   恢复代次不符或断开目标没有当前 epoch 则拒绝；此步骤不执行业务变更。
2. 页面从 `state().review` 展示原动作、机器 ID、名称或 epoch、原因、截止与受影响 provider。
   `confirm` 只在 awaiting_confirmation 状态有效，后台确认必须保持同一摘要、原截止与完整影响集合，
   然后最多提交一次原管理动作。
   点击状态不构成授权，所有权限与 fence 仍由服务器事务核对。
3. 只有匹配原 request/history/generation、动作、目标与 operation_digest 的 `current_durable` 回执
   可以表示当前提交；备份证据或 outcome_unknown 保持 unconfirmed。
4. 丢响应、提交中取消、超时或损坏回复保留原关联；`checkReceipt` 只查 `operations_get`，不会重新确认、
   换 ID/history 或重发动作。会话撤销后对账仍可拒绝，此时继续显示未确认。

`cancel` 停止等待，阻止确认阶段的迟到回复继续提交；已经开始提交的操作保持未确认。
`dispose` 停止本实例后续动作；共享客户端由其所有者显式 `close`，不会关闭 Gateway、删除后台确认或回滚 native 工作。
客户端无自动重试，也不在 localStorage、URL、普通 DTO 或日志保存 cookie、CSRF、设备凭据或 enrollment。
CSRF 提供函数必须只返回既有受保护 bootstrap 的内存结果；不能用测试常量或任意 bearer 代替生产来源。

客户端只有固定十二项 POST 操作（包括原 `pairings_get`，不开放 `providers_enable`），使用 same-origin credentials、拒绝重定向、禁缓存，输入和回复均严格校验字段、
关联、枚举与大小。请求最大 16 KiB、回复最大 32 KiB、并发八项、等待最多五秒；取消但未收尾的任务仍占额度。
未知/超大/非 UTF-8 回复和错误正文仅变成固定错误分类。返回的状态是冻结 JSON 快照，不包含管理 session 引用。
回执的 native_work 始终保留 may_continue；断开保留身份且可重连，撤销阻止旧身份重新接入。

## 验证边界

`test/admin/session-adapter.test.ts` 覆盖同一来源、逐请求撤权/过期、CSRF、跨站输入、取消与错误脱敏。
`test/webui/write-flow.test.ts` 和 `write-client.test.ts` 通过真实临时 Store、写服务及 Request/handler，
验证三个动作、明确确认、重复点击、取消/迟到、丢响应后原回执对账、过期与伪造/备份证据。
备份证据测试是受控协议回复，不声称执行真实恢复；socket 断开/重连仍由原双 Connector 集成覆盖。
`write-browser-bundle.test.mjs` 只验证浏览器模块构建，不构成真实登录、按钮、浏览器端到端或用户设备验收。
`test/cli/management-page.test.ts` 验证真实 adapter/authority/Store 的固定交付、取消、并发与拒绝边界；`test/cli/management-recovery.test.ts`覆盖真实受保护文件来源的刷新、首响应丢失、本地到期重认证、并发轮换及上游/撤销截止；
`production.test.ts` 的页面闭环使用显式合成会话来源，经实际产品工厂及同一 Store 完成确认改名和撤权。
`bootstrap.test.ts` 的 DOM 为明确端口 fixture，不构成真实浏览器验收；真实账户配置与凭据仍须另行授权。
