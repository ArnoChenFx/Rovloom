# 管理会话适配与浏览器确认逻辑

本切片接在 [管理写服务](MANAGEMENT-WRITES.md) 的既有事务和 HTTP handler 上，语义沿用
[DESIGN](DESIGN.md) 与 [GATEWAY-WEBUI](GATEWAY-WEBUI.md)。仅提供改名、显式断开和持久撤销的
可复用逻辑；生产 `browser.ts` 已通过 `mountWebUi` 的第四参数消费既有写客户端。真实管理员来源、管理 listener、受保护 cookie 与 bootstrap HTML 的交付仍由宿主接线。
没有生产会话来源时不能启用写操作。测试里的临时管理员、cookie 与 CSRF 不是生产身份。

## 运行宿主接口

`src/admin/index.ts` 导出 `createManagementSessionAdapter` 和 `ManagementSessionSource`。
适配器只消费宿主已经建立的受保护会话，不签发 cookie、token、CSRF，不创建账户、角色、身份库或 listener。
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
  cookie 属性、首次授权、更新/撤销及秘密交付由该后端负责；本切片没有这些端点或默认信任。

适配器只从指定 cookie 取得不透明查询键；拒绝重复/畸形 cookie、错误 Host/Origin 和跨站 Fetch Metadata。
没有 bearer 或 URL 身份回退。认证及 CSRF 分别重查当前绑定和 administrator，CSRF 要求 POST、精确 Origin、
当前会话及恒定时间摘要比较。查询异常、过期、撤销、时钟回退或来源不符均拒绝，不输出底层异常。
HTTP handler 原有的五秒等待、并发与正文边界仍然生效；不合作的后端在实际结束前继续占用额度。

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
   然后最多提交一次设备动作。
   点击状态不构成授权，所有权限与 fence 仍由服务器事务核对。
3. 只有匹配原 request/history/generation、动作、目标与 operation_digest 的 `current_durable` 回执
   可以表示当前提交；备份证据或 outcome_unknown 保持 unconfirmed。
4. 丢响应、提交中取消、超时或损坏回复保留原关联；`checkReceipt` 只查 `operations_get`，不会重新确认、
   换 ID/history 或重发动作。会话撤销后对账仍可拒绝，此时继续显示未确认。

`cancel` 停止等待，阻止确认阶段的迟到回复继续提交；已经开始提交的操作保持未确认。
`dispose` 停止本实例后续动作；共享客户端由其所有者显式 `close`，不会关闭 Gateway、删除后台确认或回滚 native 工作。
客户端无自动重试，也不在 localStorage、URL、普通 DTO 或日志保存 cookie、CSRF、设备凭据或 enrollment。
CSRF 提供函数必须只返回既有受保护 bootstrap 的内存结果；不能用测试常量或任意 bearer 代替生产来源。

客户端只有固定八项 POST 操作，使用 same-origin credentials、拒绝重定向、禁缓存，输入和回复均严格校验字段、
关联、枚举与大小。请求最大 16 KiB、回复最大 32 KiB、并发八项、等待最多五秒；取消但未收尾的任务仍占额度。
未知/超大/非 UTF-8 回复和错误正文仅变成固定错误分类。返回的状态是冻结 JSON 快照，不包含管理 session 引用。
回执的 native_work 始终保留 may_continue；断开保留身份且可重连，撤销阻止旧身份重新接入。

## 验证边界

`test/admin/session-adapter.test.ts` 覆盖同一来源、逐请求撤权/过期、CSRF、跨站输入、取消与错误脱敏。
`test/webui/write-flow.test.ts` 和 `write-client.test.ts` 通过真实临时 Store、写服务及 Request/handler，
验证三个动作、明确确认、重复点击、取消/迟到、丢响应后原回执对账、过期与伪造/备份证据。
备份证据测试是受控协议回复，不声称执行真实恢复；socket 断开/重连仍由原双 Connector 集成覆盖。
`write-browser-bundle.test.mjs` 只验证浏览器模块构建，不构成真实登录、按钮、浏览器端到端或用户设备验收。
