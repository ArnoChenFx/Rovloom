# ADR 0005：Connector 发送墓碑的回收边界

状态：提议；随 #218 的实现 PR 评审。

## 问题

生产 Connector 的持久发送账本最多 1024 条 / 4 MiB，内存准入表最多 4096 条 / 4 MiB。两者保留 30 天，把 Gateway 的调用 key 去重窗口当成了 Connector 的执行防重窗口。已完成调用也持续占额，重启不会清空持久账本。

## 决策与证明

Gateway 为新调用生成 call / attempt ID，首次登记后固定完整绑定和 deadline；同一 key 只返回原调用，不重派。调用方不能自定这些 ID。Connector 只接受当前认证连接及受保护路由上的完整意图，执行窗口最多 10 分钟。

发送墓碑和内存锚点固定保留至该意图的执行 deadline，重复校验、重连和释放正文均不延长期限。对同一完整意图：

1. 本机时间小于 deadline：墓碑尚未回收，持久唯一键在实际 native 写入之前阻止第二次 claim；跨 epoch、provider 或正常重启也不能绕过。
2. 本机时间大于等于 deadline：准入、transport、持久 claim 和最后写入门禁拒绝该意图，不再依赖墓碑存在。
3. 时钟回退：清理、插入和持久时钟高水位推进共用一个 SQLite 事务。回收一条 deadline ≤ t 的记录后，库中时钟至少为 t；重启后的 claim 不能接受小于 t 的时钟。事务中断则三项一同回滚。内存锚点也检查进程内时钟高水位。

因此回收后的原请求不能再次写入 native。回收只处理防重索引，不取消已派发的原生工作，也不把 unknown 改成未派发。Gateway 的 30 天 key 去重窗口及结果 TTL 均不变。Luvus RPC adapter 的 128 条和 Herdr execution hook 的 4096 条 epoch 内防重索引也遵循同一原 deadline，不能在更内层留下终身累计上限；保护期内额度不变。

此证明依赖受信 Gateway 不复用已生成的 call / attempt ID、不改写原 deadline。复用相同 ID 并伪造一个新 deadline 是不同绑定；未到期时仍按冲突拒绝，回收后不承诺永久识别恶意 Gateway 伪造的另一意图。原方案也只保留 30 天。宿主时钟与整个状态一起回滚、丢失账本或恢复旧磁盘快照不在保证内；正常启动缺库仍拒绝重建。

## 兼容与容量

账本 schema 不变。新记录的 expires 等于已核验的原 deadline；回收同时检查旧记录 binding 中的原 deadline，使旧版 30 天记录无需删库或重配即可释放。未到期记录不回收；无效 JSON、文件身份变化、无法验证提交或存储失败均阻止派发。

容量仍有硬上限。十分钟内累计超过预算的请求会被拒绝，不通过扩大默认配额、驱逐活记录或自动重派来掩盖。本地 transport 状态与交互式 CLI 报告容量类别及 `reclaim_at`（Unix 毫秒）；行数满额报告最早 deadline，字节不足不能保证仅等到期即可恢复，报告 null 并要求存储检查。容量失败仍不新增 Wire 未派发证明，不自动重试原调用。SQLite 复用空页，不自动 VACUUM。更紧凑的摘要记录需要 schema 升级，不在本次改动中。

## 验证

使用实际 SQLite 在生产默认配额下连续完成两轮各 1024 个 claim，并跨关闭重开验证；覆盖旧 expires、deadline 边界、活记录满额、绑定变化、持久时钟回退和文件预算。内存表覆盖累计超过 4096 条及未过期记录保护。实际 Luvus adapter 入口覆盖累计 258 次及保护期 128 条满额，Herdr runtime 入口在合法 Wire 校验后的受控取消下覆盖 4097 次（模拟安装、没有 native RPC），并验证保护期 4096 条满额不被驱逐。容量错误在同步准入和 Herdr 写前准备层保留本地诊断；一旦进入 socket write 不再保留可误读为未发送的容量类型。现有 native adapter / transport 回归继续验证最后写入门禁和 unknown 不重放。
