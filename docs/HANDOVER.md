# luvus-mcp 开发交接

日期：2026-10-18（UTC）

## 本地设计 v0.4 修订交接（2026-10-18 UTC）

父会话已确认 #3 Linux 范围通过；本轮从 `d2455e878f93e162a2a54bb58c1e5785aecd0949` 新建本地分支 `docs/adopted-safety-retention-recovery`，只修订文档。当前正式依据为 [DESIGN v0.4](DESIGN.md)、[IMPLEMENTATION-PLAN v0.4](IMPLEMENTATION-PLAN.md) 与 [ADR 0002](adr/0002-safety-retention-recovery-late-evidence.md)。初次 v0.3 本地提交为 dfa26ea；本轮补严其边界并加入以下用户新需求。后文关于 v0.2/旧门禁的内容保留为历史交接，不能当成当前实施结论。

新增需求与顺序：未来开发工具链改用 Bun，独立 [#15](https://github.com/ArnoChenFx/luvus-mcp/issues/15) 在 #4 前；本轮不迁移、不安装、不改 lock。Bun 1.4.3 是 issue 建议，需核对官方来源与实际可用性。后续必须从已验收 d2455e8 的真实 package.json/lock 出发，已有 SDK 1.32.1/Ajv 8.20.0/ws 8.22.0，不能沿用旧 916cae2“没有 SDK”的观察，不顺带升级 SDK 2.x 或改 MCP 架构。Node24/npm 的 P0 结果保留真实版本；是否仍需 Node runtime/node:sqlite 须独立验证，当前尚无 Bun 通过证据。

Gateway 内置管理 UI 为 [#14](https://github.com/ArnoChenFx/luvus-mcp/issues/14)，顺序 #8 → #14 → #9，硬依赖 #5/#6/#8。[详细设计](GATEWAY-WEBUI.md) 包括设备/连接/认证状态、配对/暂时断开/持久撤销、管理 API、独立管理员认证授权、无凭据回显、确认审计、仅本机默认与远程 TLS、空/错误/过期状态及隔离态限制。本轮未做前端或独立外部网站，父会话后续派发。

用户采纳的四项原则已同步：未知安全分类默认拒绝（与仅缺参数 schema 分开，Owner/raw-contract 不绕过作用/高权限/秘密结果）；原始内容、句柄和去重墓碑分别保留，内容到期/显式 discard 后不再生原文或句柄；备份恢复先隔离，旧认证/配对失效、策略重授权、旧历史范围拒绝；同一有效已验证 attempt 的可靠晚到结果只追加证据，旧 epoch/恢复代次/其它 attempt 隔离，不重新派发。

可配置默认值以 DESIGN §12.3 为准：内容/句柄各 1 小时，调用/墓碑各 30 天，新 key 范围最多 24 小时；内容 128 MiB、句柄子池 16 MiB、调用/墓碑 64 MiB、审计 64 MiB、身份策略元数据 16 MiB、受管备份合计 128 MiB；总预算 512 MiB，内含收尾预留 64 MiB。备份默认只带必要元数据，7 天/2 份，不自动调度。这些数值是供父会话验收的设计默认值，尚未运行。

为满足有限墓碑到期后仍不重派的边界，设计补充由 Gateway 发放并退役的 history_epoch；恢复另有 recovery_generation，不能复用连接 epoch。旧/未知范围缺 key 时拒绝新建，重试器不能自动改绑新范围。#4 冻结编码/关联，#5 落实期限、预算、迁移、隔离恢复与晚到事务，补充验收见实施方案 §4.1；本轮不改 GitHub issue、不启动其实现。

后续文档复核补严：scope 冻结期限及严格原子准入保证任何墓碑到期时其范围已停止登记新 key；恢复解除隔离后才发放新 scope，旧 pending/call/retry cache 不改绑。备份后 discard/撤权不明的原文保持不可读。64 MiB 预留用尽或真实写失败时进入 storage_degraded；写出前先提交 dispatch 锚点，结局/补证不能持久化就保留 unknown 而非伪称 responded，不提前删墓碑或自动重派。完整规则和跨字段约束见 DESIGN §11.2/§12.3/§12.4 及 ADR 0002。

现有 v3/codec 不具备这些新增保证：句柄 TTL 不删除内联原文、16 MiB 只限句柄载荷、unknown 回复当前会被拒绝，亦没有恢复/历史代次。源码、已有测试、依赖锁与已验收 P0 fixture 本轮未改；只执行文档一致性检查，不能声称新功能测试通过。

发布边界：用户另行明确批准只推送已验收 P0 分支。核实 origin 为 `https://github.com/ArnoChenFx/luvus-mcp.git`、P0 ref 精确为 d2455e8，并审查文本及归档无密钥形态数据/auth 请求后，执行一次普通非强制 push；现有命令环境身份 projCC 被仓库返回 HTTP 403 拒绝，推送未完成。未切换/创建凭据、未重试绕过、未发布设计分支或合并 main；当前没有可声称已发布的 P0 报告 GitHub 链接。父会话可安排具备该仓库写权限的既有授权身份执行同一 P0 ref 推送，本地交付均保留。

用户随后指定 ArnoChenFx；已通过现有 GitHub connector 的 link_6ad4579ce7d48191b645982203d60bb7 只读验证 profile_id=24894259、nickname=ArnoChenFx，且对本仓库权限为 admin。该连接标识不是 token，平台未提供把它绑定到本地 git push 的入口。云 CLI 仅观察到 GH_TOKEN 环境绑定（只检查变量名），gh 的账号状态报告该绑定不可用、API 请求 Forbidden，未验证到本地可正常选择的 ArnoChenFx 身份；不读取/搬运凭据、不用接口替代上传代码、不重试推送。最小解除步骤是由平台/任务配置将云 Git 的既有授权账号绑定到 ArnoChenFx，并验证认证 login 后再执行原 P0 ref 推送；无需重复批准发布，也不扩大 OAuth 权限。

交付保全状态：当前工具目录没有 cloud_threads.attach。Library 技能包不可读取；现有上传工具虽成功准备了 P0 patch/bundle 会话，但未接管 workspace_path，随后两次独立文件 PUT 均遇 URLError，未 finalize，故没有 Library 持久文件，更没有持久任务附件。不得把本地路径或 upload_session_id 说成已上传成果。可用交付仍是本环境的 patch/bundle 下载链接；需在环境关闭前由父会话/平台下载并附入其支持的任务附件，或在账号绑定修复后通过已授权的原 P0 推送保全。设计分支尚无发布授权，不能随 P0 一起发布。

## Issue #3 后续交接（2026-10-18 UTC）

本次交付后又执行一轮[验收复核](p0/REVIEW.md)：加强原生记录语义审计、manifest 文件集合检查与失败清理；原 fixture 保持不变，新隔离原生运行补齐 stale_route 证据。复验为基础测试 20 项、P0 Node 7 项与 Python 7 项全部通过；正式设计和 `src/` 未改。父会话以本分支最新修复提交及该复核报告验收，未自动推进 #4。

下文原交接是历史基线。本次从远端核实的 `916cae2412b69f3432caf264fd411ea1a4b3093f` 建立独立本地分支 `task/issue-3-native-evidence`，未推送/合并。

- Linux 0.14.3 的 RPC、无 session server 的 Host、events/snapshot/replay、terminal observe/control 的身份 fence、租约、ack、关闭均已采集原生证据；实例均为全新隔离目录，已清理。
- [P0 报告与重放命令](p0/REPORT.md)、[ADR 0001](adr/0001-p0-version-and-contract-baseline.md)、[逐方法账本](p0/coverage.json)、[版本来源](p0/provenance.json)、[原生 fixtures](../fixtures/p0/linux-luvus-0.14.3/manifest.json)。父会话据此验收 #3；没有自动推进或关闭后续 issue。
- 223 个 schema 方法中 197 session / 17 Host / 9 access_machines；144 项只有通用 params object。#4 必须区分参数契约缺口与已验证 envelope，不能将普通 schema 枚举当完整方法校验。
- 精确锁定 MCP SDK 1.32.1、Ajv 8.20.0、ws 8.22.0；Node 开发基线收窄至 24，`.node-version` 固定 24.19.0。SDK 实际 stdio 协商是 2025-11-25，不能套用设计所引用的 2026-07-28 元数据规则宣称兼容。
- 原有 `src/` 与 20 项基础测试未改；另有 5 项 fixture/SDK 测试及 5 项 endpoint 边界单测。全部通过；P0 证据不等于 Gateway/Connector 已实现或可部署。
- macOS/Windows、商业 MCP Host、OAuth、双机、背压/overflow/高级终端帧未验收；部署位置、目标 OS、具体客户端和身份服务仍需用户选择。#4/#5 的额外语义澄清由父会话另行决议，本次未擅自覆盖。

## 1. 交接结论

用户决定由其他人继续开发。本次仅保存、复测并上传当前可交接内容，不继续派发 Pi，不合并 `main`。

- 仓库：`ArnoChenFx/luvus-mcp`。
- 接手分支：`feat/reviewed-core-foundation`，现有 **Draft PR #1**；请勿只检出 `main` 后误认为实现代码缺失。
- 本次上传前的远端分支提交：`92b8a2808693cefcec29cd9051ffefea3052fb4a`。
- 本次保存的第六批源码本地提交：`6cf59601d79c7be4855f024036d911fb11b54259`，父提交为 `3d58cd3`。
- GitHub 插件上传会生成不同的提交 SHA；以 PR 分支的最新提交和文件内容为交付准据，不要把本地源码 SHA 当成远端提交 SHA。
- 当前仅为**内部基础层及协议草稿**，不是可运行的 MCP Gateway/Connector，不能部署为生产服务，P0/P1 未完成。
- Pi 会话已停止，本机复核匹配 Pi 进程数为 0；每 10 分钟的自动跟进例程已暂停，不会自动续派。

正式依据仍为 `docs/DESIGN.md` 和 `docs/IMPLEMENTATION-PLAN.md` v0.2。本次没有修改这两份正式文档。

## 2. 已有实现

- TypeScript 内部契约与有界 JSON 规范化、显式 machine/profile/session 路由。
- SQLite 机器注册、唯一可改名称、稳定 ID、一次性 enrollment、凭据哈希、重复连接拒绝、epoch 隔离和撤销。
- 调用账本、请求键去重、机器/调用/attempt/epoch 响应关联、断线与重启后的保守 `outcome_unknown`；不自动重放可能已执行的写操作。
- Router 对调用归属及 caller/local 双方策略重授权；身份必须由未来认证层提供，不能从工具输入中构造。
- 结果句柄：字节分页、base64、SHA-256、TTL、16 MiB 句柄载荷配额、未过期句柄复用；原始内联响应不计入此配额。
- 显式响应清理保留调用记录与去重墓碑，删除句柄及内联响应；第六批新增独立 `discard_response` 权限，默认读取者不能清理。
- 源码与测试现有注释为中文，后续继续保持中文注释。

关键文件：

| 文件 | 内容 |
|---|---|
| `src/contracts.ts` | 目标/请求/策略及 JSON 边界 |
| `src/store.ts` | SQLite、机器身份、调用账本、结果生命周期、v1/v2→v3 迁移 |
| `src/router.ts` | 重授权与显式清理权限 |
| `src/protocol.ts` | 第六批业务 envelope **草稿** |
| `test/*.test.ts` | 当前 20 项内部回归 |
| `docs/FOUNDATION-REVIEW.md` | 各批审核证据和历史门禁 |
| `docs/PROGRESS.md` | 分批实现进度与限制 |

## 3. 第六批保存范围及限制

Pi 连接重试失败时留下 4 个未提交文件。本次人工检查并复测后，将它们保存为 `6cf5960`：

- `src/router.ts`、`test/retention.test.ts`：清理响应必须同时具有调用归属、原方法策略许可及 `principal.permissions.discard_response === true`。认证后的权限来源、撤权刷新和远程工具接线仍未实现。
- `src/protocol.ts`、`test/protocol.test.ts`：版本 1.0 的 request / accepted / response / cancel / heartbeat envelope 编解码草稿；包含大小、字段、关联 ID、epoch 和部分 payload 校验。

协议草稿**不是完整契约验证**，以下问题明确留给接手者：

1. 只接受精确 minor 0，尚无设计要求的 minor 能力交集协商。
2. `uhp_response` 只做 result/error 互斥检查，尚不验证完整安装版 UHP schema。交接时只读检查安装版 `luvus uhp schema`，其 response 还要求原生 `id`、更具体的 result/error 结构等；当前协议测试不构成原生兼容实证。
3. envelope 的 expected epoch 比对不等于 socket 已认证，不证明目标机器归属，也不提供消息去重、deadline 调度或方向约束。
4. 没有 enroll/authenticate/welcome/error 或流消息实现，没有 WSS listener、Connector 循环或 Router/Store 实际接线。

不要把这些草稿默认暴露给外部网络，也不要将测试通过解释成可部署或完成 P0。

## 4. 本次独立验证

主机 Node `v25.9.0`（不在 package engines 支持范围内）：

- `npm run typecheck`：通过。
- `npm test`：**20 passed / 0 failed**。
- `npm run build`：通过。

目标运行时 Node `v24.22.0`：

- 全部 **20 passed / 0 failed**。

另执行 staged whitespace check，通过。未在本次交接中重新安装依赖，未验证 Node 26，未做真实双机或联网协议端到端测试。

接手后推荐从 PR 分支干净检出，在 Node 24 下运行：

```sh
git clone --branch feat/reviewed-core-foundation https://github.com/ArnoChenFx/luvus-mcp.git
cd luvus-mcp
npm ci
npm run typecheck
npm test
npm run build
```

本次额外使用的独立目标运行时验证命令：

```sh
npx --yes --package=node@24 -c 'node --version; node --import tsx --test test/*.test.ts'
```

## 5. 接手后仍需完成

按正式实施方案推进，不把下面事项理解为已实现：

- **P0 原生协议实证**：安装 schema fixture、实时 capabilities、RPC、Host profile、endpoint 归属/权限、事件及终端控制；仅使用自建测试会话，不干扰用户会话。
- **真实链路**：单项目单程序 Gateway/Connector 双模式、Connector 主动 WSS 出站、多机注册与握手、TLS、受保护的管理和配对通道。
- **MCP / UHP**：MCP 通用工具面、schema 发现、UHP 完整验证/适配、Host/事件/终端流、双向控制与背压。
- **安全及治理**：认证 caller 绑定、管理权限、独立删除权限来源、凭据轮换、审计、并发/传输限额、deadline/expire 调度、故障注入。
- **存储**：全库配额/保留、备份、私有父目录、Windows ACL、恢复工具。句柄 TTL 不删除原始响应；SQL 逻辑删除不是物理擦除，备份/空闲页可能仍有旧数据。
- **交付**：CLI、部署说明、真实多机及运行时/平台矩阵测试；全部通过后再判断是否满足阶段门禁。

安全语义不得改变：发送后断线可能已执行，返回 `outcome_unknown`；取消不等于远端动作回滚；不得静默重放写操作，不自动确认高风险动作。

## 6. 本机历史现场与交接边界

- 正式实现目录：`/home/boxuser/.lorca/workspaces/bot-547e269c/luvus-mcp-implementation/`，本地分支 `feat/core-contracts-ledger`。
- `../luvus-mcp/` 是旧未核验草稿，未作为正式实现，也未在本次上传。
- `../deliverables/luvus-mcp/` 保留设计原稿、分批补丁、审核记录和本交接文件。
- Pi 终端 Git push 曾 403；由聊天 GitHub 插件提交成功。未向 Pi 提供插件凭据，不应为接手而复制任何凭据。
- SQLite 崩溃锁不能自动删除；先确认无写进程、备份，再按恢复规则处理。
- Pi 已按用户要求停止，不再自动重试；他人接手不依赖恢复 Pi 会话或读取本地聊天历史。
