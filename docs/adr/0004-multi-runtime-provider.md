# ADR 0004：Rovloom 同一 Gateway 的多 runtime provider

日期：2026-10-18 UTC。状态：用户已批准纳入正式设计；以下公共接口作为 #4/wire/native 的冻结候选，待父会话协调实现方验收。本轮仅文档与本地提交，未实现、未运行 Herdr binary、未创建凭据、未部署/发布/合并。
基线：main `5124d459fa0f712fd1dbb9f164a3513e3e538716`，沿用 ADR 0002 安全与恢复原则、ADR 0003 的 Bun 1.4.3 / SDK 1.32.1 基线。本文替代 DESIGN v0.4「一个 Connector 只绑定一个 Luvus 安装实例」的限制；不替代已有安全门禁。

## 先冻结公共接口

下面的名称与语义供 wire/native 模块直接对齐；TypeScript 仅为数据字典，不是本轮源码改动。`provider` 专指 runtime provider；LLM/model vendor 另称 model provider，二者不得共用身份或权限字段。

```ts
type RuntimeKind = 'luvus' | 'herdr';
type Target =
  | { machine_id: string; provider_id: string; profile: 'session'; session: string }
  | { machine_id: string; provider_id: string; profile: 'host'; session?: never };

type ProviderBinding = {
  machine_id: string;
  provider_id: string;                 // 设备内持久、不可复用的实例 ID
  kind: RuntimeKind;                   // 创建后不可改为另一 kind
  config_ref: string;                  // 受信 Connector 配置的非秘密不透明引用
  binding_revision: number;            // 正安全整数，单调递增、不可复用
  enabled: boolean;
};

type ContractSource = {
  provider_kind: RuntimeKind;
  protocol_family: 'uhp' | 'herdr-json';
  binary_version: string;
  binary_sha256: string;
  schema_sha256: string;
  schema_origin: 'installed_cli';
  schema_command: 'luvus uhp schema' | 'herdr api schema --json';
  server_version: string | null;
  native_protocol_version: string | null;
  runtime_generation: string | null;  // 仅原生可验证 incarnation；无则 null
  adapter_revision: string;
  classification_revision: string | null;
  support_basis: 'live_catalog' | 'schema_and_version';
};
```

1. `Target` 四元组是路由身份；kind 从可信 binding 解析，不能由请求自报选 adapter。Herdr 首版仅 `profile=session`，显式 session 必须与受信配置/本地发现一致；无运行实例时报 unavailable，不隐式启动。`profile=host` 只对验证过的 Luvus binding 有效，不映射到 Herdr `server.*`。
2. `binding_revision` 不放进稳定 Target；每个新调用/开流另带必填 `expected_binding_revision`，Gateway/Connector 双方匹配后把实际 `binding_revision` 固定进 attempt。配置、启停或策略所依赖的 binding 改动均递增，不能在同一 revision 重新启用旧上下文。替换 kind、状态根或另一 runtime 实例必须创建新 provider_id；普通原地 binary 升级可保留 ID，但增 revision 并重新发现。
3. `config_ref` 只由受信本地配置及管理审批绑定；不含路径/密钥，不可作为 caller 指定 binary、状态根、环境、endpoint 或 SSH 目标的输入。Gateway 保存经管理认可的引用/revision，认证设备广告不得自行创建/重绑实例或扩大权限；双端不一致返回 `provider_binding_mismatch`。
4. 调用关联上下文统一为 `machine_id + provider_id + binding_revision + provider_kind + profile/session + recovery_generation + connection_epoch + call_id + attempt_id + native_request_id + contract_ref`。`contract_ref` 是绑定上述 ContractSource 的不可变内容摘要引用；request、accepted、response、cancel 以及流消息均引用相同上下文。deadline/history_epoch/双方 policy revision 随调用登记；不可用后来的发现结果重写原 attempt。ID 与 revision 的具体编码沿用 #4 的有界严格规则。
5. `native_request` / `native_response` 由可信 `provider_kind` 区分，保留对应 schema 的原生 JSON，不改写为另一协议。caller request 禁止 `id`、`auth` 及 adapter 管理的凭据/目标字段；原生 id 由 Gateway 分配并在实际发送记录中保留。原生 error 与 `gateway_error` 分层；缺原生回复不造 result。传输保留解析后的原生字段和值，不承诺 JSON 空白/键序字节不变；内容保留与 custody 仍按 ADR 0002。
6. 描述/发现还独立返回 `classification_status`、`schema_status`、`transport_status`、`support_status`（verified / candidate / unavailable）和 `guarantees={event_recovery,terminal_fence,cancel,prompt_completion}`。恢复枚举分别为 native_replay / state_rebuild_only / unavailable；fence 为 native_atomic / bridge_check_only / unavailable；cancel 为 native_confirmed / bridge_only / unavailable；prompt completion 为 turn_correlated / state_only / unavailable。这些是按目标与方法实证的上限，不能仅因 kind=Luvus 就全部取强值。未知状态显式 unavailable/null，不能冒充原生 generation。ContractSource 缺任一必要来源则不形成可执行 contract_ref；研究资料单列 research_ref，不填假 binary/schema hash。

## 身份、适配层与权限

一台设备一个 machine_id、一套设备 credential、一个 Connector 主动 WSS 连接；同一 Connector 进程可运行多个受信 provider adapters，分别管理一个 Luvus 或 Herdr 实例的多个 session。不同设备仍独立认证；不把 Herdr 自带 SSH/machine federation 用作本项目出站连接或设备注册。

Gateway 核心只管理认证、策略交集、显式路由、账本、预算与句柄。adapter 负责自己的 endpoint 发现与本地归属、schema、原生版本/能力、请求/事件/终端编解码和保证声明。Luvus 的 Host/session/UHP 与 Herdr JSON socket 不互相模拟。Herdr UI 二进制 renderer 不是 JSON adapter 的默认能力，也不因 schema 中有某方法而自动实现流。

授权单元是 `(principal, machine_id, provider_id, binding_revision, kind, profile, session, method, contract_ref, classification_revision)` 的精确评估；策略可引用当前 binding，但每次派发/流写/读结果都校验最新策略及 binding 仍有效。机器权限只给上限，不自动授予新 provider。caller 与 Connector 本地规则都按明确的 provider scope 分组，不能用独立 machines/providers/sessions/methods 数组的笛卡尔积产生未授予组合。Owner/raw-contract 不跨 provider，不绕过 ADR 0002 的作用、高权限、秘密结果或未知子动作门禁。同名 `agent.prompt` 不共享分类或审批；model provider key 不进入 runtime binding。

Herdr 没有等价完整的原生安全 method_contracts 时，分类必须由绑定该 binary/schema 的受信本地评审补足全部维度；未补齐仍不可执行。原生 schema/有限能力声明只作核对依据，不充当权限或安全分类来源。binding 的配置引用/内容只能在本机受保护配置中改变；Gateway 管理启停可通过认证控制面同步更高 revision，由 Connector 在不改变 config_ref/kind/root 的前提下确认，双方确认前不派发，不把远程 enable 当作本地策略授权。

设备撤销持久拒绝整台机器认证和全部 providers；暂时断开只关闭指定设备 connection_epoch。provider 禁用是独立的管理权限 `providers_manage`（设备管理权限不隐含授予），持久阻止该 provider 的派发、流输入、结果/流读取与晚到补证，关闭其流/本地桥接资源并报告在途 unknown；不撤设备凭据、不阻断其它 provider、不声称停止原生工作。重启用须真实管理员确认、新 revision、重发现与重新授权；原在途/流/句柄不可复用，不能复活过期/discard 内容。已有内容若仍有效，只能在显式授权其历史 binding 后签发新句柄；默认保持不可读。相同机器的其它 provider 不因其中一个 runtime 故障自动掉线。

## 隔离键与数据迁移

| 对象 | 新持久化/关联要求 |
|---|---|
| bindings | `(machine_id, provider_id)` 唯一；保留不可变 kind、受信 config_ref、各 revision 与启停/删除墓碑；不复用 ID |
| call / attempt / 请求摘要 | 保存完整 Target、binding revision、kind、contract_ref、native id 及 ADR 0002 关联，不仅保存方法名 |
| 去重范围/墓碑 | scope 绑定 principal、recovery_generation、machine/provider/binding；`(scope, key)` 唯一，请求摘要覆盖完整目标与原生请求；旧 retry 不得自动换 provider/revision/scope |
| result / stream | 绑定原 call/attempt/provider/revision/contract、原生 session/terminal identity（若有），每次重授权；不能靠猜中同名 pane、cursor 或 ID 读取另一 provider |
| contract / discovery cache | Target + binding revision + binary/schema hash + 原生 generation（若有）+ adapter/classification/双方 policy revisions；不得跨 kind/session 共用 |
| audit / health | provider 与设备分层；无原文/secret，revision 与观测来源可追踪；预算仍为全 Gateway 总量，不随 provider 数量倍增 |

现有 v3 只有 machine/profile/session，唯一 key 为 `(principal, request_key)`，不具备上述隔离。#5 分配下一数据库 migration 版本并与其余 P1 变更合并，不能在本轮凭空宣布已升级。迁移必须：

1. 停派发、备份、确认单 writer；事务性创建 binding/来源/历史关联，保留原库作只读证据。失败/中断回滚到旧只读状态，不自动发送、删锁或续期。
2. 对可由已知旧版 schema/安装配置证明来源为 Luvus 的每台设备，创建**唯一** `legacy_luvus` 默认 binding（该设备下稳定 provider_id 的保留别名），保存原 config_ref 与可信迁移证明，初始禁用待双端确认；不是所有新机器的默认 provider。原 Target、ACL、call/attempt、result、stream、dedup 与审计必须一并映射，不只加一列。无法证明旧实例/来源、多个候选 root 或缺字段时标 `migration_unresolved`、禁用并阻断操作；不得绑定 Herdr 或猜选第一个实例。
3. 旧 ACL 仅限经证明的旧 Luvus 实例，不授予新 providers。旧未知分类/schema/TTL/恢复/历史范围继续按 ADR 0002 拒绝或隔离；不能伪造原生来源 hash 或 active history_epoch。历史原文只在原截止/discard/当前授权可证明时受限读取。
4. 保留旧 key 的历史解析与冲突规则及原摘要版本，增加明确的 legacy tombstone 索引；同旧 key 仍只能重返原调用/报冲突，不通过新 provider scope 变成新执行。已过期/缺失或不能证明的范围返回 dedup_history_unavailable；迁移器不为旧请求分配新的有效范围。新请求摘要用独立 digest version，不能重新散列后丢失旧去重承诺。
5. 不迁移活连接/流为在线；可能送达的旧 attempt 维持 unknown，不跨 provider 补证。保留原 created/expires/discard、恢复代次与历史边界，备份恢复仍须重新确认所有 binding，默认禁用。数据库升级后的旧 writer/降级程序必须拒绝打开，回退仅通过隔离恢复流程。

旧版因多个状态根分别注册出的多个 machine_id 不自动合并；名称、hostname 或物理机相同不足以证明设备身份可合并。保留原凭据/撤销边界，由未来受保护维护流程另行处理，不能迁移时为满足“一设备一连接”转移授权或去重历史。

## Wire 与 MCP 兼容

新业务协议选择 **major=2 / minor=0**：必填 provider_id、binding revision、contract_ref、provider_kind 与 native_request/native_response 是破坏性变更，不能在严格 v1 payload 中增字段或通过 optional 默认隐藏。其余 #4 正在冻结的 recovery/history/分类字段并入 v2；本 ADR 不把已有 v1 草稿称已支持。认证协商先选择双方支持的 major，无法选择则在业务消息前失败；不能捕获 v2 失败后重发 v1。

v2 的 minor 只通过显式 feature 交集加入约定的可选扩展；安全/路由必需语义变化升级 major。每种消息仍严格校验字段、方向和关联；未知字段/枚举/必须 feature 拒绝，不能静默剥除。接收其它 major 的帧不按 v2 解释；v1 codec 保持独立，不因通用 decoder 接受新字段而削弱校验。

默认不开放 v1 业务调用；如后续提供迁移兼容入口，必须由管理员显式启用、认证设备固定在经迁移确认的唯一 legacy Luvus binding，禁止 v1 管理/发现其它 providers。旧 key 先查历史映射，只能重返/报冲突；缺少 ADR 0002 所需 scope/恢复证明的旧调用拒绝执行。新 native result 只在该 Luvus 兼容入口映射为 uhp_response；绝不把 Herdr 包装成 UHP。不得靠新机器默认 provider 或相同 session 名承接旧调用。

新通用 MCP 名称使用 `runtime_discover/describe/call/call_get/call_cancel/result_read/stream_open/stream_read/stream_write/stream_close`，增加 `providers_list/get`（经 ACL 过滤的已配置实例，不是模型供应商）。`luvus_*` 仅作可选 Luvus 兼容别名，仍须显式 target 或上述受保护 legacy 映射；不能经旧工具名意外调用 Herdr。此为工具 schema 的显式版本变更，与 SDK 的 MCP revision 2025-11-25 相互独立。管理操作仍在独立管理面，普通 runtime_call 不能增删/禁用 binding。

## Herdr 研究与首个切片

只读核对官方仓库 v0.9.5，commit `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01`，Cargo version 0.9.5、`src/protocol/wire.rs` 协议常量 22。网页为入口，版本化源码用于此次研究；未来运行契约必须重新取安装 CLI schema、binary hash 与实际 ping，不以研究源码替代生产来源。本轮未编译/启动/安装 binary，也无 Herdr 原生运行证据。

| 差异 | 适配决策与门禁 |
|---|---|
| 请求 id/method/params，成功/失败为自己的 JSON 类型；安装 CLI 可导出 schema | 用 Herdr 原生 schema 验证，不套 UHP document/root/错误结构；离线引用仍闭包解析，禁止网络 $ref |
| ping 返回 version/protocol 及有限 capabilities，无等价完整逐方法在线能力目录 | support_basis=schema_and_version，只列 candidate，未实证不得宣称 live_catalog/verified；方法与语义由版本/schema/可信评审交集确定，不发未知方法探测副作用 |
| 没有等价独立 Host、通用 cancel 与完整原子 terminal incarnation fence | Host/控制返回 unsupported；取消只能描述 bridge_only，外层 revision/generation 检查不承诺原子性；endpoint protocol generation 是协议兼容号，不是 runtime incarnation |
| events_lost 后断开，snapshot 与事件无共同序号边界，无通用 replay | 明确 gap；新订阅等 subscription_started，另一连接取 session.snapshot 整体替换；事件作失效通知，串行刷新，刷新期间变脏则再读。只恢复当前状态，不能重放载荷覆盖快照或伪造丢失历史 |
| 某些 recent 输出读取可能滚动 viewport / 向 TUI 送输入 | 按 method+params+具体实现评审，默认排除，不能凭 read 名或 schema 当 observer；仅已核实被动读取可进入切片 |
| agent.prompt 的 wait 观察状态转换，可能由已在执行的旧 turn 满足 | completion=state_only，不宣称本 prompt 已完成；write/prompt/run/input 不进首个切片 |

Herdr MVP 仅已配置实例发现、版本/状态、经核实被动只读及事件失效后状态重建；均须独立 **P0-H** 隔离实证通过后才开放。无 provider 自动安装/启动/升级，无 native federation、UI renderer、写入、agent prompt、pane run/send、Host 模拟。随后单独验证写入和终端：幂等/去重、输入 ack、incarnation TOCTOU、prompt 完成归属、cancel 与副作用读取，未达到保证则明确禁用，不为了同一工具面降低 Luvus 保证。

## 后续验收与协调阻断

- 同设备 Luvus + Herdr + 第二同 kind 实例，使用相同 session/method/pane/terminal/native id/key；授权、分类、缓存、结果、流、晚到回复均不串实例。同一个 legacy key 不因迁移重新执行。
- binding 不符/旧 revision/未知 provider/Herdr host/v1 新字段/v2 缺字段/未协商 feature 在派发前拒绝。禁用一个 provider 不影响设备凭据及其它 adapter；设备撤销覆盖全部，禁用后旧 reply 不补证。
- 双端配置不一致、原生升级/重启、adapter 故障、旧备份与 schema/分类冲突须关闭相应能力；跨 provider 自动 failover/retry 永不发生。内容/去重 TTL、全库预算、恢复隔离与存储故障门禁沿用 ADR 0002。
- P0-H 记录 binary 来源/哈希、安装 schema/方言/引用、ping22、endpoint 归属/权限/peer、framing/大小、被动读负例与事件缺口重建；至少隔离 Linux 有证据，不能将 Luvus P0 或只读研究当 Herdr 已验收。
- #4/wire/native 先对齐本节公共类型、v2 discriminant 与 contract_ref，再分别推进；#5 才实现数据库迁移与 provider-scoped 授权/去重/句柄。#14 增 provider 状态/禁用 UI，保持 #5/#6/#8 后端依赖。本轮未修改 issue 或运行源码。

待父会话验收的冲突只有实现协调：现有 v1 `request/uhp_response` 与 Target/Policy/schema v3 不兼容，不能并行实现后用默认值拼接；#4 需共同采纳 v2 与本数据字典。Herdr 本机安装/运行与平台证据、被动读精确 allowlist、以后终端写保证是后续实验阻断；不要求用户为常规字段命名填写问卷。

## 官方来源与核验边界

- [官方仓库固定 commit](https://github.com/herdrdev/herdr/tree/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01)、[官网入口](https://herdr.dev/)。
- [固定 socket API 文档](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/docs/next/website/src/content/docs/socket-api.mdx)：安装 schema、JSON socket、事件缺口/状态重建。
- [原生请求枚举](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/api/schema.rs)、[响应类型](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/api/schema/response.rs)、[ping 能力类型](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/api/schema/server.rs)、[协议常量](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/protocol/wire.rs)。
- [pane 读取分派](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/app/api/panes.rs)、[terminal recent 读取/Windows fallback](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/pane/terminal.rs)、[agent 自动化说明](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/docs/next/website/src/content/docs/agent-automation.mdx)：副作用与完成归属需要独立验证；无等价 Host/cancel/fence 是此次固定请求枚举/实现审查结论，不是对未来版本的永久断言。

仓库只读 clone 后固定到上述 commit，核对源码/文档；官网已浏览。未使用/覆盖旧研究线程，当前工具不能读取或投递至其它 source thread；公共候选先以本文件和进度消息交付，最终由父会话读取本地分支/提交协调。
