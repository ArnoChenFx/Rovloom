# ADR 0008：Connector 紧凑发送墓碑

状态：随 #249 的实现 PR 评审；取代 ADR 0005 的存储格式，保留其期限证明。

## 决策

共享的 Luvus/Herdr 持久发送账本独立升为 schema v2，每行仅保存 `call_id`、`attempt_id`、32 字节 SHA-256 `binding_digest`（SQLite BLOB）和 `expires`。摘要覆盖已完成完整校验的规范化绑定，包括设备、generation、epoch、provider、目标、策略版本和原 deadline。SQLite CHECK 拒绝非 BLOB 或长度不是 32 的摘要。

去重仍先按 `(call_id, attempt_id)` 唯一键拒绝；即使新请求的绑定或摘要不同，也不能再次 claim。摘要只用于独立连接的提交读回核对，不提供恢复绑定、授权或 native 写入许可的能力。

## 期限与安全性

#226 已把墓碑保留期从 30 天改为原执行 deadline，证明在 [ADR 0005](0005-connector-claim-lifetime.md)。本次不再缩短任何期限：

1. now < deadline：唯一键保留，任何 epoch/provider 下重复 attempt 均拒绝。
2. now >= deadline：完整请求在清理前已被 deadline 检查拒绝；不能因墓碑已删除重新派发。
3. 回收、插入、持久时钟推进仍在同一 FULL 同步事务中。重启后低于高水位的时间一律拒绝；失败事务整体回滚。

因此摘要不必恢复已删去的 binding JSON 来判断回收：v2 的 `expires` 本身就是固定原 deadline。容量错误的最早回收时间直接取未回收行的 min(expires)，排除回滚的候选。

## 版本与容量

默认条数 1024、字节 4 MiB、单 writer、实际文件和 rollback journal 预算均不变。节省字节不会扩大保护期内并发额度。收益取决于原 binding 大小、ID 长度、SQLite 页和索引开销，不承诺容量提高十倍。

v1 不会被当作空库、自动转换或清空；正常 open 拒绝旧 schema 并保留原文件和所有活墓碑。当前没有旧版本部署，不增加升级路径。不要删除正在使用的账本来解除去重保护。

## 验证

实际 SQLite 覆盖 32 字节规范摘要读回、同 attempt 改 epoch/provider、未过期容量保护、恰好 deadline、正常关闭重开、持久时钟回拨、两轮各 1024 次、字节耗尽与 schema v1 拒绝。官方 Luvus IPC 验收同步按摘要核对，不依赖已删除的 JSON 列。
