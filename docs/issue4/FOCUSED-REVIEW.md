# Rovloom Luvus validator 聚焦验收复核

日期：2026-10-18 UTC。复核原提交 `dfd40915dcfd3c462e09fb2da1bd0d36fb713cb1`；仅执行父会话指定的一轮复核及自身缺陷修复，不扩展功能，不改公共 Target、Wire、CI 或仓库名称。

## 确认并修复的两项缺陷

1. **直接对象的累计字节预算检查过晚。**原 snapshot 在克隆后 stringify 整个对象才计总量，重复字符串数组可能先造成过量序列化分配。使用约 1.6 MiB 的合成 batch、随后无效 tail，可复现预算还未生效就处理后续字段。现按字符串的 JSON 转义/UTF-8、键、标点和标量逐项扣预算，超限立即拒绝，不构造整份超限 JSON；字符串输入先检查长度下界。新增精确边界和多字节/转义测试。
2. **stream ack 只关联 candidate，未关联精确 permit。**同一候选产生 principal A/B 两份合法 permit 时，原 openStream 可用 A 的 ack 建 B 的流。已实际复现，现响应内部记录原 permit，openStream 必须精确相同；同 principal 的另一份 permit、事后授权、CheckedRequest-only 的 bound response、复制的 ack 均拒绝。原生保存 fixture 的重放改为先取得 permit，再用该 permit 验证 ack，没有 stub 许可。

补正一条 WeakMap 注释：同一 CompiledContract 的工厂可共享内存 handle，真正的隔离边界是完整可信 binding；不能把 JavaScript 工厂对象身份宣传为 provider 身份隔离。

## 指定项目的复核结果

| 项目 | 结果及证据边界 |
|---|---|
| Check 成功而 gate 拒绝 | Gate.ok 只表示判定成功。generic strict 拒绝；把 gate 或复制候选传给 checkDispatch/openStream/checkResultBoundary 均被运行时 WeakMap 拒绝。模块无发送 I/O，Wire 仍须合取七维 gate，并取得真实 permit |
| 伪造 handle / 错来源 | 新测试对 provider_id、binding_revision、contract_source_ref、旧 connection/recovery epoch 分别在 response、event、control 再授权入口拒绝；来源未核验也拒绝。原有 provider kind/contract digest/复制 permit 等测试保留 |
| raw 与 custody | 有效 raw grant 仍可得到 secret_result_authorized=false；分类 missing/untrusted、管理授权不足、custody 不具备均不能产生 permit。测试的可信 provider/分类数据是明确合成输入，不是真实认证来源验收 |
| schema 闭包与资源 | 原矩阵实际编译的缺 document/fragment、外部/file ref、循环、33 层引用、bundle 大小等反例继续执行；新增实际节点、文档数、单文档、引用数/深度的收窄预算，以及 150001 额外节点的拒绝检查 |
| native 字段保真 | request params/auth、普通 error.data/未知扩展/`__proto__` 自有键、多字节字符串和嵌套值深度相等；未知根/已约束参数字段拒绝，原对象不被剥字段；default 不注入。保真指 JSON 结构和值，不宣称原始空白或数字词法逐字节相同 |
| 119 + 24 | 从成功测试日志提取 119 个唯一矩阵 ID，与 coverage 文件精确相等；143 个定义/coverage ID 全集相同。24 项确为 result 9、stream 5、late 10；没有 stub/skip 当作通过 |

## 实跑及保留风险

- Bun 1.4.3：全项目 **161 pass / 0 fail**，含原基础 20 与模块 141；聚焦新增 7 项另独立运行通过。
- strict typecheck、独立 native module Bun ESM build、真实导入产物 smoke 均 exit 0；没有 Node/npm/npx fallback marker。
- 未重新采集原生 Luvus，未重跑无关网络部署或凭据流程。原 dfd40915 的 P0 JS/Python、兼容及构建证据按原记录保留。
- 同步 Ajv 的 CPU/正则执行时间、硬内存隔离**仍未验收/实现**。结构上限及已审核 Source 不是 worker sandbox；当前接口只能由可信 resolver 提供已审核契约身份，不能把同一消息自带 digest 当来源证明。没有运行可能卡死的恶意正则来伪称硬隔离通过。
- 真实认证/权限来源、持久化迟到证据、TTL/discard、流 lease/关闭/队列、恢复 handle 与现有 CI inventory 修复仍归后续集成；#4 整体未完成。

准确 API 与完整输入类型在 [跨环境快照](FOCUSED-REVIEW-API.md)，与 src/native-contract/types.ts 同源，**没有改签名**。Wire 须用同一 permit 验证开流 ack；恢复后无 handle 的安全拒绝保持。

本轮到本地提交及可恢复 bundle/patch 为止，不发布、不启动新任务、不改 repo 名。所有测试/构建命令均已退出，未启动临时服务；最终收尾另确认本任务 Bun binary 无残留进程。
