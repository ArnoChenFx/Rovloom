# luvus-mcp 开发交接

日期：2026-10-18（UTC）

## Issue #3 后续交接（2026-10-18 UTC）

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
