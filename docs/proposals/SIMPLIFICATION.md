# Rovloom 简化方案（提案）

状态：**已确认（维护者回复"没问题，开始吧"）**。[DESIGN](../DESIGN.md) 已按本文重写，IMPLEMENTATION-PLAN 已删除，issue 已重建为 S0–S8（#146–#154）。S0、S1（部分）、S2（部分）已在本分支落地，其余见各 issue。
本文中的行数是对 `main@3377f65` 的粗略统计，"可减少"的数字是估算，不是承诺。

## 进展（持续更新）

| 阶段 | 状态 |
|---|---|
| S0 工具链 | 已完成，待 CI 验证（#146） |
| S1 删除 | 自更新、Python 门禁、注释检查已删；预编译资产待测量（#147） |
| S2 文档 | DESIGN 已重写；PROTOCOL/OPERATIONS 合并待 S4/S5 之后（#148） |
| S3 存储 | 读路径不写时钟、设备凭据并入单库、`DeviceLedger` 抽出、字节子额与全表扫描删除均已完成；Store 余下拆分与 TTL 收敛待办（#149）。**keyset 分页不再需要**：分页对象是按 ACL 授权的小列表，结果读取早已是无状态游标 |
| S5a 流机制 | 已完成并合并（#155）：Wire stream 帧、stream 能力/动作、validator 流 API、luvus-wire 流状态均已删除 |
| S5b 去分片 | `object_chunk` 帧、`objects` 能力、`wire/objects.ts`、adapter 的 `encodeResponseObject/decodeObject/acceptChunk` 与 transport 分片收发均已删除；响应预算收敛到单帧 1 MiB，**超限响应不截断而是写出失败、调用保持 unknown**（避免截断后的原生 JSON 被误认为完整结果）。Wire 单 major、`provider_snapshot` 简化、工具面精简待办（#151） |
| S5c 工具面 | MCP 工具 14→11：删除 `machines_register/rename/revoke`(真实服务本就返回 backend_unavailable,设备管理只在 UI/CLI)。Wire 能力协商简化、单 provider 失效不关整连接待办（#151） |
| S3d TTL 收敛 | `content_ttl`+`handle_ttl`→`result_ttl`（句柄与原内容同期限，不再单独续签）；`call_metadata_ttl`+`dedup_ttl`+`audit_ttl`→`metadata_ttl`。`history_epoch_max_age` 已随 S4c 删除 |
| S4a 恢复隔离 | 已删除 `recovery_quarantined` 模式、`completeRecovery` 与 `recovery_local` 管理会话：备份快照里设备回到 pending、凭据清空、provider 禁用并升版，恢复后以正常模式启动，**备份恢复 = 重新配对**。保留 `recovery_generation`（随 S4 末尾处理） |
| S4b 准入回执 | 已删除 `admission_receipt` / `admission_context` 能力与帧、Gateway 侧回执发送与订阅、`ConnectorAdmissionReceipts` / `ConnectorAdmissionLedger` / 认证 proof（净删约 3000 行）。Connector 只用本机固定保留期的 `ConnectorAttemptBook`（默认 30 天，须覆盖 deadline）+ 持久 dispatch claims 去重；Gateway 在 Store 持久 `dispatching` 之后才发送 request。Herdr 连接器配置不再有 `receipts` 账本 |
| S4c 调用去重 | 已删除调用去重的 `history_epoch` / `history` 表 / `Store.openHistory` / `history_epoch_max_age` / `history_scope` 能力 / `registration.history`（Wire 不再携带 key）以及 `planHistoryAdmission`；MCP `runtime_call.history{...}` 改为可选 `client_request_key`。去重作用域 = `(principal, client_request_key)`，窗口 = `metadata_ttl`，窗口外同 key 是新意图（不再返回 `dedup_history_unavailable`）。管理端的 `admin_history` / `history_open`（写操作幂等）留给后续阶段 |
| S6 认证 | 已完成：`rovloom token create/list/renew/rotate/revoke`（摘要注册表、热读、可选重叠期）、受信 `mcp.public_url`（反代 / TLS 终止）。未做：OIDC（需先定 JWKS / 映射）与设备凭据轮换（调查发现“已配对设备重新配对”链路不存在，见 #165） |
| S4d-1 方法表 | 已删除逐调用拼装的多轴 `SafetyClassification` 快照（effect / requires_owner / management_permission / confirmation_required / 结果敏感度 / sub_action）、custody 结果通道、`classifications` / `classification_source_verified` / `permissions` / `confirmation_verified` / `custody_available` / `result_channel` / `supported_transports` 授权输入、`inspectRequestGate` 与 Wire 逐帧 `RequestGate`；改为 `src/native-contract/methods.ts` 的静态方法表（表外方法一律拒绝，契约广告提示须与表逐字段一致），保留 raw_contract。流类 / token / host 管理方法不在表中 |
| S7 e2e | 已完成：`e2e/`（真实产物 + 官方 Herdr 0.9.5 + 官方 MCP SDK）7 个场景全部通过，含重复请求、终端开关、Connector 重启/崩溃、设备撤销、未知结果不重发。边界：单机双进程、无 Luvus 真实链路、未跑 LLM Agent；崩溃恢复缺口见 #167 |
| S4d-2、S4d-3、S8 | 未开始（S4d-2：permit / 句柄 / 响应上下文；S4d-3：管理端 `admin_history` 与 `recovery_generation`） |

## 1. 为什么要简化

当前实现 `src` 约 5.4 万行、`test` 约 7 万行、`scripts` 约 1.3 万行（大量 Python/JS 验证脚本）、文档约 30 篇，另有两份共 2.8 MB 的预编译 JSON Schema 资产。
而产品实际定位只是：**一个管理员，几台机器，一个 MCP 入口**。设计却按"不信任任何一层、每层独立复验、备份回滚可证伪"来建，结果是：

- 同一个授权或校验在 Gateway、Connector、Router、Store、结果读取各做一遍；
- 为"物理上无法保证"的东西（exactly-once、Worker 硬 CPU 隔离、整机回滚检测）写了大量规范和测试；
- 还没有任何一次真实双机端到端验收（见 #13），机制先于验证；
- 工具链被锁死到精确版本（Bun 1.4.3、TypeScript 7.0.2、全部依赖精确版本），测试里直接断言版本号，换一个 Bun 补丁版就有 10 个测试失败。

目标：**把"能不能用"放到第一位**，在保留少数真正有价值的不变量的前提下，删掉其余。

## 2. 威胁模型（重新定义）

| 在范围内 | 不在范围内 |
|---|---|
| 网络上的未授权方（没有 Bearer、没有设备凭据） | Gateway 或 Connector 所在主机已被攻陷 |
| 拿到过期/泄露的 Bearer 或设备凭据 | 同机其它 OS 用户读取状态目录（交给文件权限和 OS） |
| 管理员配置错误导致误暴露（默认只监听 loopback） | 整机回滚/备份篡改的自动检测 |
| 调用方越权访问未授权的设备或方法 | 对 Agent 内部工具的沙箱（终端本身就是目标账号权限） |
| 网络断线/重启导致的重复执行 | exactly-once、跨机事务 |

## 3. 保留的不变量（只保留这些）

1. **显式目标**：每次调用必须给出 `machine_id + provider_id (+ session)`，没有"当前机器"，不跨 provider 自动 failover。
2. **设备身份**：一次性配对码 → 设备凭据；Gateway 只存 hash；仅 TLS（或显式 loopback 开发模式）；常量时间比较。
3. **调用方授权**：Gateway 侧对 `caller → machine/provider/method 集合` 做**一次**授权。
4. **终端执行开关**：Connector 本地 `allow_terminal_execution`，默认关，是唯一的 Connector 侧授权。
5. **结果不确定性**：可能已送达的调用断线后标 `outcome_unknown`，不自动重发变更；只读方法可由调用方显式重试。
6. **有界资源**：请求体、单帧、单页、并发、结果保留时长、总存储都有上限，超限明确拒绝。
7. **秘密不入日志**：凭据、prompt、原始输出不写日志和审计。
8. 加固已有的基础项继续保留：严格 JSON 解析（拒绝重复键/过深）、Origin/Host 校验、固定错误体、`Content-Length` 预检。

## 4. 简化清单

### 4.1 删除（整块移除）

| 项 | 位置 | 理由 |
|---|---|---|
| 自更新事务（POSIX + Windows helper） | `src/update/`（≈4.3K 行）、`docs/UPDATE.md` | 文档自己承认"自动替换尚不可用"；用 release 下载 + 包管理即可 |
| 预编译 schema 资产与构建期"逐字节一致"校验（**待测量后再删**，见 #147） | `src/*/generated/*.json`（2.8 MB）、`scripts/native-contract/`、precompile Worker | 目标是进程内 Ajv + 按 schema hash 缓存；但现有设计的 2 秒接纳期限依赖预编译，必须先测量冷编译耗时 |
| 隔离恢复（quarantine / recovery_generation / history_epoch） | DESIGN §5.4、§11.2、`src/storage/backup.ts`、`wire/history.ts` 相关 | 恢复备份 = 重新配对，简单且更安全；不再设计"证明备份之后没发生什么" |
| 逐 input 独立 DispatchPermit、不透明 handle、per-frame 读取门禁 | `src/integration/luvus-wire.ts`、`runtime/native-custody.ts`、`native-contract/internal.ts` | 同一调用上的同一授权重复发放/复验；改为"准入时授权一次，带 attempt_id 执行" |
| Admission receipt / proof 机制 | `transport/admission-*.ts`、`runtime/connector-admission-ledger.ts`（≈1.4K 行） | 用 `call_id` 唯一约束 + 持久 dispatching 状态即可达到同样的"不重复发送" |
| Python 验证/审计脚本与 `verify.py` 大一统门禁 | `scripts/**`（≈1.3 万行，含 `check.py`、`audit-*`、`verify-*`） | 门禁改为 `typecheck` + `lint` + `test` + `build`，真实环境验证另放 `e2e/` |
| 中文注释强制检查 | `scripts/maintenance/comments.mjs`、`comment_equivalence.mjs` | 注释不是门禁；只要求公共接口与不明显的约束有注释 |
| 额外 Wire 能力：对象分片、`provider_snapshot` 同 epoch 测量、多 feature 协商 | `wire/objects.ts`、`wire/negotiation.ts` 等 | 结果上限收紧到单帧（见 §5.3），不需要分片；版本协商简化为单一 major |
| 5 套 TTL/预算 | `storage/config.ts`、`budget.ts`、DESIGN §12.3 | 简化为 `result_ttl`、`metadata_ttl`、`storage_max_bytes` 三项 |

### 4.2 合并 / 缩小

| 项 | 现状 | 目标 |
|---|---|---|
| SQLite 数据库 | `gateway.db` + `identity.db` 双库，部分提交需跨库协调 | 单库、单 writer、同一事务 |
| `Store` | 1852 行一个类 | 拆成 `devices`、`calls`、`results`、`audit` 四个模块，共用一个连接 |
| 分页 | 取全量数组再 `slice`，HMAC 游标 | SQL keyset 游标，不再需要游标密钥 |
| 两套 Connector 宿主 | 纯 Luvus 专用 host + 通用 host | 只保留通用 host |
| 工具面 | 17 个 MCP 工具 | 约 10 个：`machines_list/get`、`providers_list`、`runtime_describe`、`runtime_call`、`runtime_call_get`、`runtime_call_cancel`、`runtime_result_read`、`runtime_stream_*`（合并为 open/read/write/close 中的必要子集）；注册/改名/撤销只在管理 UI/CLI，不经 MCP |
| 安全分类 | 绑定 binary/schema/契约/revision 的多轴分类 + 评审 | 每个 provider 一份静态方法表：`read / write / terminal / admin`；未知方法默认拒绝 |
| 时间持久化 | 每次读取都 UPDATE 时钟高水位（一次结果读取 200+ 次写） | 仅在启动与写事务内记录；检测时钟回退只在写路径做 |
| Windows/macOS/Linux 服务 | 三套独立宿主 | 保留，但只提供 `install/start/stop/status/uninstall`，不做探针诊断体系 |
| 文档 | ≈30 篇、约 6K 行 | 见 §7 |

### 4.3 保留但不再扩张

- Herdr 现有 65 个方法：保持，不再接剩余 37 个，直到有真实需求。
- 管理 Web UI：保留现有页面，不再新增确认流程层级。
- Windows Gateway 服务：保留已实现部分，不新增。

## 5. 目标架构

```text
MCP Client ──HTTPS(Bearer / OIDC JWT)──▶ Gateway ◀──WSS(设备凭据)── Connector ── Provider(Luvus | Herdr)
                                          │                                      本地终端开关
                                       SQLite（单库）
```

### 5.1 模块（目标 ≤ 2.5 万行 `src`）

| 模块 | 职责 |
|---|---|
| `mcp/` | Streamable HTTP facade、工具定义、参数校验 |
| `gateway/` | 设备注册/配对、caller ACL、路由、调用账本、结果存储、审计 |
| `connector/` | 出站 WSS、provider 生命周期、本地终端开关 |
| `providers/luvus`、`providers/herdr` | 各自协议适配 + 静态方法表 |
| `wire/` | 单一 major 的 JSON 信封与流状态机 |
| `schema/` | 进程内 Ajv + 缓存 |
| `admin/` | 管理 API 与 Web UI |
| `cli/`、`service/` | 入口与开机服务 |

### 5.2 一次调用的生命周期

```text
runtime_call → [Gateway] 认证 caller → 查 ACL → 校验参数(schema) → 写 calls(dispatching) → WSS 发 request
             → [Connector] 终端开关/方法表检查 → provider 执行 → response
             → [Gateway] 写 responded + 结果(受 result_ttl) → 返回
断线：dispatching 且无 response → outcome_unknown；晚到 response 只补充证据，不重新执行
```

关键简化：**一次授权发生在 Gateway；Connector 只做它独有的事（终端开关、方法表是否支持、本地原生错误）**。不再有"双端 grant 交集 + 分类 revision + permit"。

### 5.3 默认限额（可配置）

| 项 | 默认 |
|---|---|
| MCP 请求体 | 1 MiB |
| 单帧（Wire）/ 单结果 | 1 MiB；超限结果截断并标记，不分片 |
| 单页 | 64 KiB |
| 每设备在途 | 8 |
| `result_ttl` / `metadata_ttl` | 1 小时 / 30 天 |
| `storage_max_bytes` | 512 MiB；超限拒绝新调用 |

### 5.4 认证

- 设备：配对码 → 设备凭据（hash 存储），支持 `rovloom device rotate`。
- MCP caller：**Bearer 令牌可轮换/续期**（`rovloom token create/rotate/revoke`），并支持可选 OIDC JWT 校验（issuer、audience、scope）。
- 资源 URL 比较改为配置的受信 `public_url`（兼容反向代理/TLS 终止），不再用 `request.url` 精确比较。
- 管理 UI 独立 listener 与会话，保留。

## 6. 工具链：不再固定死

- 移除 `.bun-version` 强制、`packageManager` 精确 pin、`engines.bun: "1.4.3"`、`scripts/bun/provenance.json`、`scripts/bun/toolchain.mjs`、各测试里对 `process.versions.bun === '1.4.3'` 的断言。
- 改为**范围声明**：`engines` 给最低版本（Bun ≥ 1.3 或 Node ≥ 22.5，以 `node:sqlite` 可用为准，实现时用 CI 矩阵确认最低版本）。
- 依赖使用 `^` 范围，**保留 `bun.lock`** 以保证 CI 可复现；用定期升级 PR（Dependabot/Renovate）保持新鲜。
- CI 矩阵：`min` 与 `latest` 两个版本；发行构建使用 CI 里当时的 `latest`，并把实际版本写入 release manifest（记录，不强制）。
- 保留 `oxlint` / `oxfmt` / `tsc`，版本范围化；不再要求 `tsc` 为 7.x。

## 7. 文档重整

| 保留/新建 | 来源 |
|---|---|
| `README.md` / `README-zh.md` | 精简，补一个"两台机器、一个 Agent"的典型用例 |
| `docs/QUICK-START*.md` | 保留，并合并 #144 的 Docker/一键安装内容 |
| `docs/DESIGN.md` | **重写**：≈ 300 行，只含 §2–§5 的内容 |
| `docs/PROTOCOL.md` | 合并 WIRE-PROTOCOL、MCP-HTTP、NATIVE-CONTRACT 的现行部分 |
| `docs/OPERATIONS.md` | 合并 CONFIGURATION、SERVICE、DOCKER、STORAGE、DISTRIBUTION |
| `docs/adr/` | 保留 0003（改写为"工具链不固定"）、0004；0001/0002 归档到 `docs/adr/archive/` |
| 删除 | IMPLEMENTATION-PLAN（改用 issue/里程碑）、UPDATE、TRANSPORT、MANAGED-RUNTIME-VERIFICATION、TERMINAL-EXECUTION（并入 OPERATIONS）、LUVUS-OPERATIONS 等 |

## 8. 实施阶段

每阶段独立 PR，保持 `main` 始终可构建、可测试。

| 阶段 | 内容 | 风险 |
|---|---|---|
| **S0** | 解除工具链固定（§6）；CI 改矩阵；删除版本断言测试 | 低 |
| **S1** | 删除自更新、预编译资产、Python 门禁脚本、注释检查（纯删除） | 低 |
| **S2** | 重写 DESIGN/PROTOCOL/OPERATIONS 文档，归档旧 ADR | 低 |
| **S3** | 合并双库；拆分 Store；keyset 分页；去掉每读时钟写 | 中（需迁移测试） |
| **S4** | 授权简化：删 permit/receipt/admission ledger/恢复隔离；静态方法表 | **高**（核心安全路径，需逐项评审） |
| **S5** | Wire 单 major、去分片；MCP 工具面精简到约 10 个 | 中（对外接口变化） |
| **S6** | 认证：Bearer 轮换/续期、OIDC、受信 `public_url` | 中 |
| **S7** | 真实双机 + 真实 MCP 客户端的 e2e 验收（独立 `e2e/` 目录，不进单元测试门禁） | — |

阶段 S4 之前保留旧实现，S4 以"先加新路径与等价回归测试，再删旧路径"的方式进行。

## 9. Issue 重整

### 9.1 现有 10 个 open issue 的处理

| # | 标题 | 处理 |
|---|---|---|
| 85 | 架构审查跟踪（第三轮） | 关闭（superseded）；有效问题已并入下方新 issue |
| 8 | [P3b] 双角色 CLI 与持久 HTTP MCP | 关闭（已实现主链路）；剩余验收并入 S7 |
| 9 | [P4] 多机故障隔离 + Host profile | 关闭；并入 S7 |
| 10 | [P5a] 事件恢复与终端只读流 | 关闭（not planned，按新设计不做事件 replay） |
| 11 | [P5b] 终端双向控制 | 关闭；流能力按需另开 |
| 12 | [P6] 远程认证与安全部署门禁 | 关闭；由 S6 取代 |
| 13 | [P7] 真实多机/平台矩阵/发行验收 | 关闭；由 S7 取代 |
| 14 | [P3c] Gateway Web UI | 关闭（已实现）；剩余并入 S2/S6 |
| 23 | Herdr 完整接入 | 关闭；保留 65 方法，剩余按需 |
| 90 | docs: 中英文 Quick Start | 关闭；由 #144 与 S2 承接 |

PR #144（Docker/一键安装文档）与本方案不冲突，保留。

### 9.2 新 issue（建立时以 `S0…S7` 作为父 issue，其下挂子任务）

- **S0** 解除工具链固定：engines 范围、`^` 依赖、CI 矩阵、删除版本断言
- **S1** 删除自更新、预编译资产、Python 门禁、注释检查
- **S2** 重写 DESIGN / PROTOCOL / OPERATIONS，归档旧 ADR
- **S3** 单库 + Store 拆分 + keyset 分页 + 去掉读路径时钟写
- **S4** 授权路径简化（逐模块子任务：permit、receipt/ledger、恢复隔离、分类→方法表）
- **S5** Wire 单 major + 去分片 + 精简工具面
- **S6** Bearer 轮换/续期 + OIDC + 受信 `public_url`
- **S7** 真实双机 e2e（Luvus、Herdr 各一条 discover→describe→call→get→read 链路，含断线/重启/撤销）
- **S8** 最小公开发行：二进制下载 + Docker 镜像 + Quick Start 验证

## 10. 需要维护者确认的决定

1. §4.1 的删除清单，尤其是**隔离恢复**与**permit/receipt**——这是对安全语义的实质放宽（威胁模型缩到 §2）。
2. 恢复策略：备份恢复后一律重新配对（会丢失旧调用的去重保证）。
3. MCP 工具是否去掉 `machines_register/rename/revoke`（只留管理 UI/CLI）。
4. 运行时：以 Bun 为主，是否同时承诺 Node ≥ 22.5。
5. 现有 `luvus-mcp` 包名改为 `rovloom` 的时机（建议 S0 一并处理）。
