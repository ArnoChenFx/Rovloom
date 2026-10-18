# Issue #4 本地整合记录

日期：2026-10-18 UTC。当前仅完成 checkout 校正和 Bun 测试发现修复；两份原始成果尚待跨任务转移，未据摘要重建实现，不能宣称 #4 已完成。

## 仓库与身份

- 实际目录 `/workspace/luvus-mcp` 初始为 `work@9c4a7fe34fc3efa461d96a502860e61b05817c44`，origin 使用旧名且没有本地 main。
- 通过已连接的 **ArnoChenFx**（GitHub 用户 ID `24894259`）只读核实仓库 ID `1423932347` 对应 `ArnoChenFx/Rovloom`，权限包含 admin/pull/push；本轮没有远端写入。
- 以禁用 credential helper/额外认证头的公开只读 fetch 取得 main；origin 已改为 `https://github.com/ArnoChenFx/Rovloom.git`。
- 本地 main、origin/main 与整合分支起点均为 `5ce1ee585265f456cb5e85d0d2d821cb5abfe897`；分支 `task/issue4-native-wire-integration`。
- 终端 GH_TOKEN 无效，没有使用 projCC、提取/搬运凭据或把 Git 作者元数据当作账户授权；本地新增提交使用自动化作者 Codex。
- 已读 HANDOVER、DESIGN、IMPLEMENTATION-PLAN、ADR 0001/0002/0004 及 issue #4/#5。沿用 Rovloom 品牌、多 provider v2、Herdr P0-H 前不可执行的边界。

## 等待原始成果

| 成果 | 原提交 | 所需恢复文件 |
|---|---|---|
| 原生校验，线程 `01a14ddf-2736-7748-ac5d-8a8fa06e6039` | `fdb624803cc8b1385ce8e9346a05ded1670a91b9` | `/workspace/rovloom-native-validator-fdb6248.bundle` |
| Wire v2，线程 `01a14dfd-6188-7202-a352-39883ac2b00c` | `7035a69c7e786954bc03cf3b553c35b191a72eb7` | `/tmp/issue4-wire-v2.bundle`，基线 `5124d459fa0f712fd1dbb9f164a3513e3e538716` |

这些文件与提交对象都不在新容器；Personal Context 也不可用。父会话已协调原任务导出，不启动重复导出任务。可将 bundle/完整 format-patch 放入本容器 `/workspace`，或提供可读取附件的文件 ID/文件名、下载地址及 SHA-256；取得后先验证文件和 Git 对象，再应用已有实现。

## 已完成的 Bun 修复

`scripts/bun/verify.py` 不再要求新增后测试总数仍为 20，也不再用只识别顶层单引号标题的正则猜测全部测试。它读取 Bun JUnit 报告，逐项拒绝失败、跳过、todo/disabled，核对所有递归测试文件实际出现在报告中，再按历史 inventory 逐文件确认原 20 项全部通过。验证报告记录实际测试数量并保留 JUnit。

`scripts/bun/test_verify.py` 的 5 项回归使用真实 Bun：23 项包含嵌套/参数化新增测试可通过；漏发现文件、替换原基线、新增失败、skip/todo 均拒绝。新 harness 数量从实际报告读取。原 5 个基础测试文件的 SHA-256 与原 inventory 完全相同；未减少原断言。

## 验证证据

固定 Bun `1.4.3`，revision `c6da4a4d3010e5553438c60f6bd76d981976867c`；官方归档、校验文件及 binary SHA-256 与仓库 provenance 相同。Linux 验证期间屏蔽 Node/npm/npx，执行追踪为零次调用。

```sh
python3 scripts/bun/verify.py \
  --bun /workspace/toolchains/bun-1.4.3/bun \
  --output /workspace/issue4-discovery-final-verification
```

原基础 **20/20**、新验收脚本 **5/5**、P0 JS **7/7**、P0 Python **7/7**、Bun 兼容 **5/5**。空缓存 frozen install、依赖审计、strict/noUncheckedIndexedAccess 类型检查、全部测试、P0/Bun 原生 fixture 审计、构建与构建产物 smoke 均通过；类型负例按预期退出 1，其余命令退出 0。证据为上述目录的 `verification.json`、`foundation.junit.xml` 和各命令日志/execve 追踪。未重采原生实验，未执行 Herdr binary 或真实网络链路。

## 尚未完成

原生成果/可信薄适配层与 Wire v2 的整合需等原始内容，现阶段未动 `src/`。未来必须核对同一 DispatchPermit 流确认、完整 provider/revision/contract 关联、不可伪造的当前授权与 binding，以及 generic 参数契约不可标 complete。

#5 仍负责 provider-scoped Store 迁移、dispatch 持久化锚点、去重 history/recovery、分层内容期限/预算、隔离恢复与同次可靠晚到结果的原子落库。现有 Store v3 不提供这些保证；协议/内存校验不能替代它们。Herdr 仍须独立 P0-H。未推送、建 PR、合并、关闭 issue 或部署。
