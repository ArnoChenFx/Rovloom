# Rovloom：Luvus 原生 validator 纯模块交付

日期：2026-10-18 UTC。分支 `task/issue-4-native-validator-impl`。
基线 main `5124d459fa0f712fd1dbb9f164a3513e3e538716`；提案重放为 `33b7ec0`、`b053360`，无冲突。原分支及 `backup/issue-4-native-validator-design-8ac180d` 保留。

**本次完成 Luvus 0.14.3 / UHP 1.0 的纯校验切片，不表示 #4 整体完成、真实认证/权限来源、原生新运行或可部署传输。**依据为最新 DESIGN v0.4、ADR 0002/0003、#4/#15 与父会话授权。未实现 Herdr、多 provider Target、Wire codec 或持久化。

本页保留 dfd40915 原交付的 154 项证据；随后一次聚焦复核修复累计字节预算与精确 permit/ack 关联，增补后 161 项通过，见 [FOCUSED-REVIEW](FOCUSED-REVIEW.md)。不将原日志改写为后续结果。

## 公共接入

入口：[src/native-contract/index.ts](../../src/native-contract/index.ts)；准确类型：[types.ts](../../src/native-contract/types.ts)；Wire 对齐说明：[IMPLEMENTATION-API](IMPLEMENTATION-API.md)。顶层公共导出未变。

```ts
compileBundle(bytes: Uint8Array | string, options: CompileOptions): Check<CompiledContract>
createNativeValidator(contract: CompiledContract): NativeValidator
parseNativeJson(bytes: Uint8Array | string, limits?: Partial<Limits>): Check<Json>
inspectRequestGate(candidate: DispatchCandidate, auth: DispatchAuthorization): Check<NativeRequestGate>
checkDispatch(candidate: DispatchCandidate, auth: DispatchAuthorization): Check<DispatchPermit>
checkResultBoundary(permit: DispatchPermit, auth: ResultAuthorization): Check<void>
checkSequence(previous: number, incoming: number): Check<void>
```

实例提供 bindCapabilities、describe、checkRequest/checkRawRequest、checkResponseShape/checkResponse、openStream、checkEvent、checkControl。所有数据检查返回 Check；创建 validator 的工厂要求本模块产生的有效 compiled handle。可信上下文必须由受保护 provider 提供，不能来自 wire 输入中的自报 boolean。模块不发网络请求、不查数据库、不 spawn，不创造认证或管理权限。

`inspectRequestGate` 返回与 Wire 一致的七项字段：classification_status、schema_status、transport_status、authorized、secret_result_authorized、raw_contract_authorized。它不创建派发 permit；即使 raw grant 为真，分类 missing 仍须拒绝。complete 仅表示已应用安装版条件约束；generic 固定 incomplete，不表示业务语义完备。

Wire 的 raw-contract 需映射为模块 raw_contract。NativeBinding 强制 kind=luvus、provider_id、binding_revision、contract_source_ref，并绑定现有 Target、server generation、connection/recovery epoch、精确 binary/schema hashes/revision、capability、双策略与 classification revisions。call/attempt 外壳核对仍归 Wire；native ID 在 CheckedRequest/控制候选中精确关联。Adapter 必须按完整 AttemptBinding 保存内存 handle；组合 contractDigest/不可变 ContractSource 由可信 registry 解析，不能盲转为 schema_sha256 或接受 caller 自报 provider 身份。

## 实现及安全边界

- 29 documents 全部离线编译；完整根、allOf/oneOf、条件、依赖字段、not、相对/传递引用保留。无远程 loader/文件 resolver；引用闭包、缺 fragment、循环/深度/大小、未知 dialect/keyword/$id/别名冲突均失败关闭。Ajv 不补默认值、不转换类型、不删字段。
- 原文含一个未引用的 `$defs/locatorProperties` 属性字典，不是有效参数约束。本模块仅对准确 URI/path/四键作兼容，逐子项检查，拒绝 `$ref` 直接把该字典当可执行 schema；没有全局忽略未知关键字。
- 197 session / 17 Host 的实时能力和 native contracts 精确 join；9 个 machine.* 不开放。214 个原生提示不自动变成 Gateway 分类，未附受信分类时不可派发。未知在线方法的 transport 初始 unclassified，受信评审 + 显式 adapter 声明后才可作普通 raw RPC/Host；未知 stream 不降级。
- 144 个 generic 方法在 strict 拒绝；Owner 显式 raw + 精确、有效 grant + 当前双方策略 + 完整受信安全分类可准入，保留 validation=generic。方法参数 schema 缺失但其余可信 bundle/response 边界存在时，raw 保留 unavailable。整个 bundle 不可编译时不制造响应边界。
- 分类的作用/幂等/transport、高权限/确认及结果敏感性/读取/保存/交付均为必需信息，核对原生提示及确切 revision；missing/unknown/invalid/untrusted 分开拒绝。通用 action.invoke 和每个 control action 需独立子动作分类；没有生产分类注册表的虚假默认值。
- 管理权限与 Owner 独立；uhp.token.* 不能被评审成普通结果，无 custody/正确 channel 则派发前拒绝。结果读取还需当前分类来源/revision及双方重授权，分类已变化则安全拒绝旧 permit；不以 Owner/raw 绕过。
- 原生 response/error/data/扩展按对应 schema 保真，核对原生 ID/方法/result type/stream mode/identity；shape-only 不可 openStream。控制 ack 绑定逐输入 permit，queued 不声称已消费。
- 一般 event catalog 与专用 terminal event 分开；生产路径覆盖 terminal.frame（含合法 sequence=0）、terminal.resync_required、六种终端 catalog event；字节/行数、身份和 stream family 额外检查。图片/上传只凭广告不启用，必须有显式 adapter action 支持和独立分类。
- UTF-8 致命解码、重复 JSON 键、整数精度、无行为对象/访问器、循环/隐藏字段、独立字节/深度/节点预算有拒绝检查。已检查数据为冻结快照，handle 复制为 JSON 不产生许可。诊断不含 payload/secret。

## 实跑证据

[机器可读记录](implementation-verification.json)含命令、退出码、版本和日志 hash；[逐项矩阵覆盖](matrix-implementation-coverage.json)对全部 143 项分列。全部执行使用 Bun 1.4.3，完整 revision `c6da4a4d3010e5553438c60f6bd76d981976867c`；archive/binary 与 #15 已验收 provenance 的 SHA-256 一致。冻结安装成功，SDK 1.32.1、Ajv 8.20.0 未升级，未新增依赖。

| 检查 | 结果 |
|---|---|
| `bun --no-env-file run test` | **154 pass / 0 fail**，8 文件；原 20 项 + 新模块 134 项，无 skip/todo |
| 143 矩阵 | **119 个 case 实际执行通过**；24 个后续集成项列明，未冒称执行。144 generic 有全量结构/strict/raw 展开断言，额外子动作由合成可信测试工厂显式分类 |
| P0 实际保存的 LF 记录 | 29 个新模块可接受请求/输入、1 个故意 stale-generation 被绑定检查拒绝、2 个故意非法 schema 输入；29 response / 23 event 全部重放，合法 error.data 保真。不是原生新运行 |
| `bun --no-env-file run test:p0` | JS **7 pass** + Python **7 pass** |
| `bun --no-env-file run test:bun` | **5 pass / 0 fail** |
| `bun --no-env-file run typecheck` | exit 0；既有 strict/noUncheckedIndexedAccess TypeScript 7.0.2 |
| 既有 `run build` / `run smoke` | exit 0 / 0；未改四个既有 entrypoints |
| 独立 native module Bun build / artifact-smoke.ts | exit 0 / 0；target bun、ESM、packages external，实际导入产物验证 8 个值导出、29 文档编译、error.data 保真 |
| Node/npm/npx 失败 shim | 探针各 exit 99；验证工作流零调用，未发现 fallback marker |
| 资料 audit / diff whitespace / 受保护文件比对 | exit 0；既有 P0 原文与公共代码/测试/锁文件保持不变 |

构建新增模块的可复现命令（Bun 1.4.3 已在 PATH）：

```sh
bun --no-env-file build ./src/native-contract/index.ts --target bun --format esm --packages external --outdir /tmp/issue4-native-module
# /tmp 产物需可解析项目已安装的 external 依赖；本次使用自建临时 node_modules 链接。
bun --no-env-file ./test/native-contract/artifact-smoke.ts /tmp/issue4-native-module/index.js
```

P0/Bun 历史报告未改写；只有最后成功日志存入 implementation-logs。开发中的初次 PATH 缺失、类型诊断、control ack 错套 open mode 以及旧 raw fixture 缺 Owner 前提均已修复后复跑；没有用失败/少跑结果冒充通过。

## 剩余集成及限制

1. 24 个矩阵项归结果存储/TTL/discard、可靠晚到持久化或流生命周期。纯 checkResultBoundary/checkSequence 有独立单元验证，不证明完整场景完成。ADR 0002 对重复晚到的幂等处理及内容过期后仅最小元数据规则优先于前置草案，#5 集成时应统一旧矩阵期望。
2. 不实现 Wire envelope、call/attempt 去重、分片、网络认证、权限/分类 provider、custody 实际存储或稳定恢复 factory。恢复后无原生内存 handle 当前安全拒绝；不能从消息字段重建许可。原生 schema 检查不证明 endpoint 已认证。
3. 不实施 worker 的硬 2 秒/64 MiB 隔离；同步内核只有确定的结构预算。仅接纳可信 provider 固定身份的已审核契约，宿主在开放更广契约输入前须独立落实 CPU/内存隔离。
4. 已锁 Ajv 仍为 devDependency，新增模块不进入既有四项顶层 build entrypoints；本次独立产物验证通过。运行依赖/打包接线由统一集成负责人决定，未擅改 package、锁文件、CI 或公共导出。
5. 多 provider Wire 已给出 provider/revision/ContractSource 关联要求，本模块仅在私有 Luvus binding 中保留并核对这些身份。正式 v2Target 与 ContractSource 摘要编码由薄适配/registry 负责，不改公共 Target，不把 Herdr 同名方法强塞 UHP。
6. **现有 CI inventory 是集成阻碍**：scripts/bun/verify.py:165 将全项目 test 固定为 20，:30–35 只抽取顶层 test/*.test.ts 的静态名称。对本次 154-pass 日志实际调用 validate_tests(...,20)，得到预期拒绝 `foundation: test count differs`。父会话/CI 负责人须保留原 20 项独立门禁，并接纳经审查的新增 native/Wire inventory；仅把 20 改成 154 仍不能解决非递归/动态矩阵名称检查。未改 CI/verify.py，也未声称本分支整套 CI 已通过。

当前只在授权目录实现并本地提交；没有推送、合并、部署、签发真实凭据或关闭 #4。
