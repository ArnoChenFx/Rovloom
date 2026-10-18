# Issue #4 原生校验与 Wire v2 本地整合

日期：2026-10-18 UTC。已完成原成果恢复、本地整合、可信薄适配与 Bun 验收修复；**#4 尚未全部完成，也不是可部署 Gateway/Connector**。未推送集成分支、创建 PR、合并 main、关闭 issue 或部署。

## 仓库、身份和原始成果

实际目录仍是 `/workspace/luvus-mcp`。初始快照为 `work@9c4a7fe`，origin 使用旧名且没有本地 main。通过已连接的 **ArnoChenFx**（用户 ID `24894259`）核实仓库 ID `1423932347` 即 `ArnoChenFx/Rovloom`，具有仓库权限。origin 已更新为 `https://github.com/ArnoChenFx/Rovloom.git`；本地 main/origin/main 保持 `5ce1ee585265f456cb5e85d0d2d821cb5abfe897`，独立分支为 `task/issue4-native-wire-integration`。

终端 token 无效，未使用 projCC、读取/搬运凭据或把 Git 作者当作账户授权。公开只读 fetch 禁用了 credential helper 与额外认证头；本地新增提交标记自动化作者 Codex。父任务批准的是两个旧成果分支的发布，本轮不把该许可扩大到集成分支。

| 成果 | 经本容器 fetch 核对的远端提交 | tree | 对应原本地提交（父任务提供） |
|---|---|---|---|
| `task/issue-4-native-validator-impl` | `5531020fbcabe82d5e4011169a4ee5e86317eb05` | `76802ce6dd392fb754fd7ed8c76d02fc5024d4ad` | `fdb624803cc8b1385ce8e9346a05ded1670a91b9` |
| `task/issue-4-wire-protocol` | `7d7c6611e6893add450c9fba7d5906f7229ddd76` | `3d8ac6ffa72692c95b55cb33802511521bfa284c` | `7035a69c7e786954bc03cf3b553c35b191a72eb7` |

两者基线均为 `5124d459fa0f712fd1dbb9f164a3513e3e538716`。本地分别以 merge commit `7c72bdb`、`2445501` 保留四步 native 与 v1→v2 两步 wire 历史；先前 Bun 修复提交 `f59bf2d` 保留。原生实现、原生测试/矩阵与其已发布成果无差异；未根据摘要重写。先前 bundle 在新容器缺失，Wire Library 正常接收及一次指定本地目标重试均失败；最终使用获授权发布的原始 Git 分支恢复，没有绕过网络限制。

## 整合范围与可信边界

`src/integration/luvus-wire.ts` 的 `createLuvusWireAdapter(backend)` 将真实 NativeValidator 接到 v2。backend 必须由宿主认证、账本、双端受保护配置及原生 endpoint 证明实现；禁止用消息、设备广告或 caller 输入构造 backend。`direction` 由宿主连接角色确定。工厂不提供默认信任、默认 provider、默认权限，也不暴露可由 JSON 重建的 validator/context/permit。

- 每帧独立查询原登记 attempt、原请求、认证 connection、Gateway/Connector 两端 binding、不可变 ContractSource、当前双方精确 Target grant，以及实际原生来源证明。kind/config_ref/revision 必须双端一致；消息的参数也须与登记请求一致。
- 将 v2 Target 显式投影为 Luvus Target，并在 NativeBinding 保留 provider/revision/contract_ref。ContractIdentity 来自 registry 的真实编译 handle，不把组合 contract_ref 当 schema hash。原生来源必须独立返回 authenticated/source_verified 证明并精确匹配，不能反射消息字段后填 true。
- 按精确 provider tuple 先求双方交集，再投影给旧 native Policy；不从独立 allowlist 形成笛卡尔授权。Owner、raw grant、分类、管理权限、确认和 custody 均只取受信 resolver。generic 的 native `incomplete` 映射为 wire `generic`，严格模式拒绝；raw 不覆盖已有约束或缺失分类。
- requestGate 只检查多轴门禁，validateRequest 再取得 DispatchPermit。重复编解码保留最初 permit；stream ack 必须由该 permit 的 checkResponse 验证后才能 openStream。流打开失败的原生 error 保真且不建立流。
- 每条控制输入先 checkControl，再按具体 action 重新 checkDispatch；输入 ack 按自己的 native ID/permit 关联。codec 同时把 stream_id 固定到可信 attempt，不能另选同名流。
- checkResult 独立核对当前 authenticated reader、当前分类、provider/read grant、秘密交付路径与内容状态。planEvidence 只返回待持久化的意图；expired/discarded/unavailable 或撤权时不输出 payload、不延长截止、不生成新执行。
- 内存 handle/source token 不序列化；release 后不能从回复重建 permit。默认至多 128 个 attempts、每个 128 个 control IDs，并独立计量最多 16 MiB 保留 JSON 快照；这是快照计量，不是 JS heap 隔离。分片和去重使用各自有界实例。
- decode/encode 是校验入口，不是派发。宿主实际接收须用 observeMessage 对重复返回值分流，并通过 advanceStream 的私有状态核对外层顺序，重复不得再次发送给原生执行。acceptChunk 重组后仍执行完整原生门禁；包内 schema 不自动成为可信 registry。
- 非预期 backend 异常仅返回 `native_adapter_unavailable`，不把私有异常文本或原生 payload 拼入错误。

Herdr 仍由 provider gate 无条件拒绝执行，必须等待独立 P0-H；不会因提供一个同名方法或 validator 而获准。

## 原 20 项与新增测试

Wire 原成果替换了原协议测试，组合首次为 186 pass/0 fail，但验收脚本正确报告原 20 项缺失。现恢复原 3 项协议测试的完整测试体和断言，显式只检查 `foundation-v1-history` 的严格只读历史记录；返回 read_only/unresolved，不提供默认 provider 或执行上下文。另保留原成果的 v2 顶层入口测试；业务 `src/protocol.ts` 只接受 v2 与认证上下文。

其余 4 个原基础测试文件 SHA-256 不变；协议测试从 `const request` 起的全部测试体与 main 完全相同，只调整导入和只读测试 wrapper。不是删断言或把 v1 放回执行入口。

`verify.py` 读取 Bun JUnit，递归核对测试文件、逐项失败/skip/todo/disabled，并按历史 inventory 确认原 20 项全部通过；实际数量写入报告，不再固定为 20 或从单引号顶层源码猜标题。新增 Python harness 用真实 Bun 的 23 项嵌套/参数化测试及失败场景验证验收器，5 项全部通过。

Wire 外层复用原生有界 JSON parser，避免 JSON.parse 吞掉重复键后 native 无法识别；精度损失提前拒绝并保留已有 Wire `invalid_integer` 错误接口。没有放松旧 Wire 负例。

## 构建与验证

统一 build 现在包含 foundation、native-contract、wire 和 integration 三个新增入口。Ajv 8.20.0 移到运行依赖，119 个锁定 package 的完整条目、版本/integrity 与 main 相同；未升级 SDK 或其它依赖。产物 smoke 从构建后的各入口共享编译 handle，实际完成 request→native error response→result boundary，并编译 29 个离线文档、验证 v1 只读记录和 SQLite reopen。

```sh
python3 scripts/bun/verify.py \
  --bun /workspace/toolchains/bun-1.4.3/bun \
  --output /workspace/issue4-integration-final
```

Bun 精确 1.4.3/revision `c6da4a4d3010e5553438c60f6bd76d981976867c`，归档/官方 checksum/binary SHA-256 与已验收 provenance 一致。最终 Linux 验证：

| 检查 | 结果 |
|---|---|
| test/ 全量（含原 20、native、Wire 与 10 项真实适配集成） | **199 pass / 0 fail，15 文件，无 skip/todo** |
| 验收脚本 Python 回归 | **5/5** |
| P0 JS / Python | **7/7 + 7/7** |
| Bun 兼容性 | **5/5** |
| 空缓存 frozen install、实装依赖审计 | 通过，未改 package/lock |
| strict/noUncheckedIndexedAccess 与文件覆盖 | 通过；负例按预期退出 1 |
| P0 与 Bun 原生 fixture 审计 | 通过，只重放已有证据 |
| 统一 build / 构建产物 smoke | 通过，清除 stale 输出 |
| Node/npm/npx 执行追踪 | **0 次**，失败 shim 探针各退出 99 |
| 源码/设计/fixture 保全、119 项 lock 比对、whitespace | 通过 |

最终原始证据在 `/workspace/issue4-integration-final/`：verification.json、foundation.junit.xml、15 项命令日志及 execve 追踪；类型负例以外全部命令 exit 0。本仓库保留 [验证清单](issue4/integration-verification.json) 与 [审查证明](issue4/integration-review.json)。旧实现/聚焦复核日志保持历史，不冒称本轮新运行。

## #4 尚未完成与剩余依赖

- #5 尚无 provider-scoped Store 迁移、durable dispatch/attempt 锚点、原子 history/dedup 准入、固定内容/句柄期限、总量预算/降级、隔离恢复和同次可靠晚到结果的事务落库。当前 backend 是接入接口及测试实现，**没有拿 Store v3 填假 provider/recovery 信息**。EvidencePlan、permit 或 codec 成功都不是持久化 responded，也不证明已实际发送。
- 生产认证/endpoint 证明、真实管理确认、custody、WSS、Connector/MCP 接线、网络发送前后的原子准入仍由 #5/#6 及后续 adapter 阶段落实。恢复后没有合法内存 handle 必须拒绝，不能从消息重建。
- 本地许可缓存须由宿主在关闭/到期/撤权等生命周期显式 release；当前没有生产调度器，不声称内存原文已按内容 TTL 物理擦除。SQL/备份物理擦除亦未实现。
- 原生 native sequence/replay、终端 lease 释放/背压与真实多机故障证据还不是这次纯模块接线的证明；外层状态机不等于原生 replay 保证。
- 同步 schema 内核只有结构预算，没有兑现硬 2 秒/64 MiB worker CPU/heap 隔离；不能对任意外部 schema 开放自动编译。跨平台、商业 MCP Host、OAuth、真实双机与 Herdr P0-H 未验收。

本轮未改已合入的 DESIGN/IMPLEMENTATION-PLAN/ADR 0004、旧 Router/Store/contracts 或原 P0/Bun fixtures。发送后失联仍按 outcome_unknown，不重放写入，取消不代表回滚。最终本地提交与 bundle 以交付消息为准。
