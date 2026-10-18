# Luvus 原生校验与 Wire v2 接入契约

`src/integration/luvus-wire.ts` 的 `createLuvusWireAdapter(backend, limits?)` 将真实 NativeValidator 接到 Wire v2。原生接口见 [IMPLEMENTATION-API](issue4/IMPLEMENTATION-API.md)，封装和 provider 规则见 [WIRE-PROTOCOL](issue4/WIRE-PROTOCOL.md)。这是模块接入层；**#4 仍未全部完成，不代表可部署 Gateway/Connector**。

## 宿主必须提供的可信来源

`NativeWireBackend` 的完整类型以源码为准。backend 必须由宿主认证、账本、双端受保护配置及原生 endpoint 证明实现，禁止由消息、设备广告或 caller 输入构造可信结果。

| backend 来源 | 必须保证 |
|---|---|
| `connection` / `currentPrincipal` | 当前已认证且 active 的连接、恢复代次、epoch 与读取身份 |
| `attempt` | 原登记的完整 AttemptBinding、原请求、principal、method/mode/transport，以及流的 feature/stream_id |
| `provider` / `localProvider` | Gateway 与 Connector 两端独立受保护的配置，完整 binding 必须一致 |
| `contract` | 不可变 ContractSource、真实编译 handle、能力与分类 revision；重算 contract_ref 并核对 binary/schema 身份 |
| `nativeSource` | 独立原生 endpoint/身份实证，authenticated/source_verified 均成立且完整 NativeBinding 精确匹配 |
| `policies` / `authority` | 当前双方精确 Target grant、可信分类、Owner/raw 范围 grant、管理权限、真实确认及 custody |
| `now` / `contentStatus` / `responseAnchor` | 受信时钟、固定内容状态与 durable 原派发锚点；不能由响应补建 |

`direction` 由宿主连接角色确定。工厂不提供默认信任、默认 provider 或默认权限。v2 Target 显式投影为原生 Target，provider/revision/contract_ref 另保留在 NativeBinding；组合 contract_ref 不能直接强转为 schema hash。权限按完整 provider tuple 求双方交集后才投影给原生 Policy，不能从独立 allowlist 拼成笛卡尔授权。

## 请求、流与结果的生命周期

- 每帧独立查询原登记 attempt、双端 provider、契约与原生来源；参数也须与登记请求一致。`requestGate` 只判断多轴门禁，`validateRequest` 再取得 DispatchPermit。generic 的 native `incomplete` 映射为 wire `generic`，严格模式拒绝；raw 不覆盖既有约束或缺失分类。
- 重复编解码保留最初 permit。stream ack 必须由同一 permit 的 `checkResponse` 验证后才能 `openStream`；原生开流错误保持原样且不建立流。
- 每条控制输入先 `checkControl`，再按具体 action 重新 `checkDispatch`。输入 ack 按自身 native ID/permit 关联；stream_id 固定到可信 attempt，不能另选同名流。
- `checkResult` 独立核对当前 authenticated reader、当前分类、provider/read grant、秘密交付路径及内容状态。`planEvidence` 仅返回待持久化意图；expired/discarded/unavailable 或撤权时不输出 payload，不延长截止，不生成新执行。原生 error/data 保留在响应中；非预期 backend 异常只返回 `native_adapter_unavailable`。
- 内存 handle/source token 不序列化；release 后及恢复缺失合法 handle 时不能从回复重建 permit。宿主须在关闭、到期和撤权等生命周期显式 `release`。
- decode/encode 是校验入口。宿主接收须用 `observeMessage` 过滤重复，并由 `advanceStream` 的私有状态检查外层顺序，重复不得再次发送给原生执行。`acceptChunk` 重组后仍执行完整门禁；包内 schema 不自动成为可信 registry。

默认至多 128 个 attempts、每个 128 个 control IDs，并独立计量至多 16 MiB 保留 JSON 快照。该计量不是 JS heap 隔离；分片和去重使用各自有界实例。Herdr 在独立 P0-H 完成前仍无条件拒绝执行。

## 构建与可复现检查

统一 build 的七个入口包含 foundation 的 contracts/store/router/protocol、native-contract、wire 和 integration。Ajv 8.20.0 是运行依赖。产物 smoke 使用构建入口共享真实编译 handle，执行 request → native error response → result boundary、离线 bundle 编译、v1 只读记录和 SQLite reopen。

使用固定 Bun 1.4.3 和 Linux strace，在仓库外指定新的证据目录：

```sh
python3 scripts/bun/verify.py --output /tmp/rovloom-verification
python3 scripts/issue4/audit_native_design.py
```

验收器递归核对 Bun JUnit 中的测试文件及失败/skip/todo/disabled，并保留历史 inventory 的原 20 项保障；原协议测试只走 `foundation-v1-history` 只读入口，业务 `src/protocol.ts` 只接受 v2 与认证上下文。临时命令输出留在仓库外，验收摘要见 PR 描述与 CI。

## #4 尚未完成的范围

- #5 的 provider-scoped Store 迁移、durable dispatch/attempt 锚点、原子 history/dedup/晚到证据事务、固定内容和句柄期限、总量预算及隔离恢复。当前 backend 是接入接口及测试实现，没有把 Store v3 当作可信生产 backend；EvidencePlan、permit 或 codec 成功不代表实际发送或持久化 responded。
- 生产认证与 endpoint 证明、真实管理确认、custody、WSS、Connector/MCP 接线和网络发送前后的原子准入。恢复后缺 handle 必须拒绝，不能重新派发以恢复结果。
- 内容 TTL 的物理擦除、SQL/备份擦除、原生 sequence/replay、终端 lease 释放/背压及真实多机故障证明。外层状态机不等于原生 replay 保证。
- schema 内核的硬 2 秒/64 MiB worker CPU/heap 隔离、跨平台、商业 MCP Host、OAuth、真实双机与 Herdr P0-H。结构预算不允许向任意外部 schema 开放自动编译。

发送后失联保持 outcome_unknown，不重放写入；取消不代表回滚。
