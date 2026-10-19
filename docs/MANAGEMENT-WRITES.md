# 共享管理写服务接线

本模块是 #14/#8 的受信宿主组件，系统语义以 [DESIGN](DESIGN.md) 为准。
它复用同一 Store、既有设备身份及管理会话来源，不初始化角色、账户、配置凭据或 listener。
没有生产 session 来源时保持拒绝；合成管理员测试不代表真实身份交付完成。

## 服务组合

`src/admin/index.ts` 导出 `StoreManagementWriteService`、`ManagementServiceError` 和
`createManagementHandler`。准确参数以源码及 [management.ts](../src/mcp/management.ts) 为准。

运行宿主将同一已打开的 Store、`GatewayIdentitySource` 和原 Gateway 的 `refresh()` 交给写服务，
可将原 `StoreGatewayService.management` 作为 `reads` 注入。六项管理读取继续委托原服务，
写服务不复制查询、Router、MCP facade、HTTPMCP 或 CLI。`refresh()` 逐连接校验实际 Store fence，
不会按 machine_id 盲目关闭重连后的新连接。

`identities.principal/administrator` 每次请求及事务内重新解析。管理员 principal 必须匹配当前
会话，assurance 必须是 administrator，grant 必须匹配具体动作及 machine/provider。
恢复本机身份不能通过普通写服务解除隔离。MCP caller、设备凭据、loopback 和按钮状态均不构成管理授权。

额外受信端口：

- `pairingPolicy(ref, admin, machine?)` 核对当前受保护配对策略引用，缺失/拒绝则不能建立申请。
  引用只记录在申请中，不授予任何 caller、设备或 provider 权限。
- `providerEnable(target, oldRevision)` 必须复核同实例双端可信配置、重发现与重新授权；缺失时拒绝启用。
  返回 true 的测试回调只证明端口行为，不证明真实 native 来源或生产启用已经验收。
- 配对秘密签发、交付和独立 IdentityStore 的已签发/失败进度仍由原受保护 custody/本机管理宿主负责。
  此服务不签发 enrollment、设备 credential 或 token，不接收秘密正文；`issuance` 明确为 unverified。
  受保护宿主可调用 `Store.issuePairingEnrollment(machine, pairingId, policyRef, ttlMs)`，仍须 Store 原独立
  management 授权提供 pairing_enrollment_issue 的精确批准。它绑定申请、目标、策略、恢复代次及原申请截止，
  每份申请最多签发一次，签发与 issued 标记原子提交。秘密只返回给受保护 custody，不进入普通服务。
  已有管理申请的设备拒绝 legacy 无关联签发/兑换；redeem 仅更新同一 pairing_id，旧材料不能完成新申请。

## 操作顺序

1. `history_open` 用受保护 POST 建立或返回同会话/政策现存范围。接收新意图最多五分钟，重复查询不续期。
   无写权限拒绝。范围不由 GET 自动创建，也不能把丢失的旧请求换到新 history 重试。
2. 已有目标先用 `write_state_get` 取得当前 resource_revision、恢复代次及适用的原始 connection_epoch。
   它要求精确目标的独立写权限；展示 DTO 的 connection_epoch_ref 不能代替此 fence。
   provider 的 resource_revision 取该 binding revision，另必须提交 expected_binding_revision 与 kind。
   新注册使用 expected_revision=0。
3. `confirmations_create` 保存 operation、目标、request_id/history、原因枚举、当前政策、会话摘要与资源 fence。
   返回待确认摘要和固定两分钟截止；设备撤销额外列出受影响的全部已配置 provider。
4. 同一管理会话通过 `confirmations_confirm` 提交原 confirmation_id 和 operation_digest，完成后台一次性确认。
   确认不会执行业务，不接受 approved:true，也不延长期限。真实人机交互和 session/CSRF 保护由现有管理宿主提供。
5. 提交对应写动作。事务重新核对授权、history、代次、revision、epoch、kind/binding 和完整摘要，
   同时保存业务变更、确认消费、真实 actor 审计与操作回执。必要审计/预算/COMMIT 失败不报告成功。
6. 重复已提交请求返回同一持久回执，旧 fence 不再次作用于新连接。`operations_get` 可按原会话/history/代次对账；
   缺失回执表示结果未确认，不能推断未执行或换 ID 重发。当前撤权仍会阻止读取。

支持的最小动作是 pending 注册/配对申请、改名、无秘密配对进度、取消 pending 申请、
精确 epoch 断开、持久撤销、provider 禁用及有证明端口的启用。
已有设备的重新配对重置仍须原独立身份生命周期和受保护确认，本服务只接受仍 pending 的申请，
不会把 online/offline/revoked 设备直接重置、接管或重新签发凭据。

`pairings_create` 返回稳定 machine_id、pairing_id、期限和 requires_local_issuance，设备仍 pending。
进度仅报告 pending/paired/cancelled/expired 和未接线的秘密交付状态；paired 仅依据当前申请有效期内、同 Store enrollment 消费事务的明确关联记录；
独立身份交付尚未接线时不从其它申请或当前 online/offline 推断消费，不把创建申请当作认证成功。取消只允许当前 pending 申请并废弃该设备当前
Store enrollment，不撤已有设备 credential；已兑换或 fence 变化时冲突。

断开保留持久授权，可以重新认证。撤销清除主 Store 身份授权与内容，全部旧身份通过同一 Store
认证/派发门禁拒绝；独立身份库仍可能保存不可用的历史 hash，需要原生命周期宿主按其自身确认规则清理。
服务不会伪称跨库事务。provider 变更递增 binding_revision，旧 attempt/内容/流能力不能恢复。
所有回执保持 native_work=may_continue；已送入 native 的工作可能继续执行。

通道效果保守返回 unconfirmed：Store fence 已持久生效，宿主 refresh 在 COMMIT 后执行，
但此接口不具有可原子证明 socket 物理关闭的回执。关闭失败不把已提交撤销改报未提交。
前端可重新读取现场状态，不能将此效果解释为原生工作已回滚。

原因只接收 administrator_request、maintenance、device_lost、pairing_cancelled 四个枚举，
不把自由文本、秘密或原始请求写入审计。已认证且原 history 可核验的业务拒绝另记录固定 reason_code，
失败业务事务不产生已提交回执。

## HTTP 窄 handler

`createManagementHandler` 只组合 handler，不启动 listener。宿主必须明确提供同一 service、
现有 `authenticate`、`verifyCsrf` 和 IPv4 loopback origin；没有默认登录/会话/CSRF 信任。
现有六项 GET 和静态资源继续交给原读桥。

当前写接线使用固定 `POST /admin/v1/actions/{operation}`，operation 为上文服务操作名，
输入恰为共享类型中的 JSON。目标、confirmation_id、history 和 fence 都在受保护正文；
路径和 query 不接收秘密或确认引用。它是供宿主组合的最小端口，UI 目标 REST 路由尚未接线。

写路径强制实际 Host/URL 和 Origin 同源，存在的 Fetch Metadata 必须 same-origin；
CSRF header `x-rovloom-csrf` 必须存在且经当前 session 后端验证。拒绝 GET 变更、额外字段、
重复 JSON 键、非 JSON/非 UTF-8、压缩或传输编码正文和查询参数。请求头最多48项/16 KiB，
正文16 KiB、输出32 KiB、并发8、突发16/每秒补4、等待五秒；取消或迟到任务实际结束前仍占额度。
超时、断线或停止返回 outcome_unconfirmed，不自动重放。响应 no-store，无 CORS 放行，固定错误不含底层异常。
此 handler 不管理 cookie；HttpOnly/SameSite/Secure 与受信 session 建立/撤销仍属现有认证适配器。

宿主必须设置实际 listener 的正文/连接上限并默认 loopback；本模块不增加公网、反代或 TLS 配置。

## 同库 schema、预算与恢复

规范 schema v5 为 machines 增加单调 resource_revision/labels，并加入 admin_history、
admin_confirmations、admin_operations、admin_pairings。它们全部属于原 Store writer，
计入 security_metadata_bytes 和全库/磁盘预算，复用原审计期限。没有第二套设备或身份注册库。
原配对/连接/断开/改名等生命周期更新也推进设备 revision，使旧确认失效。

旧的未发布 v1–v4 及未知库在任何业务改写前拒绝，不迁移、不改版本号或覆盖源库。
全新状态必须在独立新目录建立。恢复快照沿用原隔离流程，不复制有效管理 history、确认、回执或配对申请；
新 generation 和 recovery_quarantined 阻止旧范围再次使用。普通写服务不能解除隔离。

history 在接收截止加 audit_ttl 后清理，相关确认/回执先清理；配对申请按原期限加 audit_ttl 清理。
过期/缺失 history 一律拒绝，不自动重建旧意图。storage_degraded 与 recovery_quarantined 拒绝管理变更。

writer 内会话到期、权限撤销或当前证明返回拒绝，只转换本服务白名单中的已知管理拒绝为 Store 业务错误，
回滚且保持健康库 active；确认不消费、回执不产生，后续健康业务仍可继续。未知宿主异常或真实 SQLite 异常
保持原存储故障降级路径，不将全部异常降格为业务拒绝。相关回归见 test/admin/write-refusals.test.ts。

## 证据边界

`test/admin` 使用实际 Store/SQLite、已合并的持久身份桥和两个真实 loopback Connector。
覆盖事务/确认/回执原子性、磁盘重开、重复/丢响应、精确权限、期限、取消/兑换竞态、
断开后重连与新 epoch、撤销后旧 Connector 实际重试被拒绝、provider 独立 revision、恢复隔离和HTTP攻击输入。
管理员、策略、凭据及 native 来源仍为临时合成材料；未操作用户设备、未创建生产账户或长期配置。
HTTP 测试是 Request/handler 集成，不构成生产登录、浏览器/WebUI、远程部署、Windows 或真实 native 能力验收。
