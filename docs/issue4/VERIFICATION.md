# #4 原生 validator 前置设计交付记录

日期：2026-10-18 UTC。分支：`task/issue-4-native-validator-design`。
起点及本次核对的 origin/main：`9c4a7fe34fc3efa461d96a502860e61b05817c44`。
**本记录是设计资料审计，不是 #4 实现验收，也不是 Bun 迁移、原生 P0 或生产认证验收。**

## 交付

- [接口提案与文件分工](NATIVE-VALIDATOR-PROPOSAL.md)：纯编译/校验接口、可信来源与派发接缝、参数覆盖、字段/错误映射、大小预算、独立管理/秘密结果边界、迟到证据接缝及冲突。
- [223 方法映射](native-method-map.tsv)：197 session / 17 Host / 9 access_machines；144 generic / 79 conditional，全部 runtime_enabled=false；没有将原生 method_contracts 升格为已审核 Gateway 分类。
- [终端能力映射](terminal-capability-map.tsv)：24 capability + 2 feature，按方法/action/字段登记；全部未启用，图片/上传明确 deferred。
- [矩阵草案](../../fixtures/issue4/native-validator/matrix.json)：27 seed、128 个正反场景定义；涵盖 11 个阶段，其中部分要求全量展开 144 方法或逐个变异迟到锚点。case 定义数不是实际执行测试数。
- [标准库资料审计脚本](../../scripts/issue4/audit_native_design.py)和[机器可读结果](design-audit.json)。脚本不安装依赖、不取 schema URL、不访问用户数据、不创建实例或凭据。

## 实际检查

本环境 Python `3.12.14`。未安装/迁移 Bun，未安装项目依赖，未修改版本 pin。

| 命令/检查 | 结果与限度 |
|---|---|
| `python3 scripts/issue4/audit_native_design.py` | exit 0；原 P0 manifest 全文件 hash/长度一致，29 documents、188 个原文 $ref occurrence 本地解析，223 方法与 P0 ledger 精确一致，26 终端映射完整，27 seed/矩阵变更可物化，128 草案阶段/正反/安全必需项检查通过 |
| `python3 -O scripts/issue4/audit_native_design.py` | exit 0；输出与普通模式相同，关键资料检查不依赖可跳过的 assert |
| 普通/优化输出 `cmp` | exit 0；机器可读报告一致 |
| 新增文件 staged whitespace 检查 | `git diff --cached --check` exit 0 |
| 对 base 的受保护范围 diff | exit 0，无修改：src、test、package.json、package-lock.json、fixtures/p0、scripts/p0、docs/HANDOVER.md、docs/p0 |

额外以环境已有 `jsonschema 4.26.0`/Draft202012 和拒绝远程 retrieve 的内存 Registry 对 55 条可物化的 request/response/event/control 草案做结构复核；20 个结构正例没有 schema 错误。task title 字节上限、事件 bytes 一致性及错误流上下文这 3 条反例需要显式语义检查，不能仅靠 JSON Schema 拒绝。此检查是提案审阅辅证，使用的不是项目锁定 Ajv/Bun，不计入生产 validator 测试通过数。其余上下文/授权/状态机预期仍待实现验证。

未运行：生产 validator（尚不存在）、Bun install/typecheck/test/build/smoke、现有基础回归/P0 harness、WSS/SDK/真实原生或多机实验。此次只新增资料与独立 Python 审计，没有用旧 Node 结果冒充 Bun 门禁，没有重做原生 P0。

## 冲突与剩余接缝

1. DESIGN §8 / IMPLEMENTATION-PLAN §9 的 Owner/future/raw 旧表述须在 #4 集成时更新为已采纳的受信安全分类默认拒绝；无例外可越过独立管理、确认、secret custody/结果边界。
2. P0 脚本对无 catalog 键终端事件的特例只有 terminal.frame；生产实现还需按专用 schema 登记 terminal.resync_required，不能把前者的最小原生验收推导为溢出/高级流全部已测。
3. 迁移负责人将提供统一新 main；实现任务从包含 Bun 验收的新基线接入。本次新增路径与 package/锁文件/protocol/store/原公共测试无编辑重叠。
4. wire 错误外壳/分片、可信来源与分类 provider、管理/custody provider、#5 原持久化 attempt 锚点及 retention 语义仍由对应负责人冻结。纯编译和结构校验可按本提案独立分配；缺少 provider 的派发路径继续拒绝。

本地提交交父会话审阅；没有推送、合并、部署、创建凭据或关闭 issue。
