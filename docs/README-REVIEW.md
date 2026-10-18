# README、品牌与架构图验收记录

日期：2026-10-18 UTC。范围：独立文档分支；不包含代码整合成果。

## 基线与范围

- 已核验 origin 为 `https://github.com/ArnoChenFx/Rovloom.git`，远端 main 与本地文档基线均为
  `5ce1ee585265f456cb5e85d0d2d821cb5abfe897`。
- GitHub 连接已核验为 `ArnoChenFx`（用户 ID 24894259）；发布使用同一连接。
- 复用 main README 中的兼容标识、开发及存储说明；新增中文对应文档、语言互链、品牌资产和双语图。
- 功能状态按此基线描述：SQLite/Router/codec 为已有基础层；provider 持久化、认证、WSS 与适配器
  接线仍待实现。未合并代码不计为 main 已有功能。
- 变更只涉及 `README.md`、`README-zh.md`、`docs/assets/` 及本记录。
  `src/`、`test/`、脚本、fixture、依赖、锁文件与工具链保持基线树对象。

## 已完成检查

- 双语 README 的 **11 条 Bun 命令逐字相同**；版本 pin 与 package 脚本名相符。
  完整验证由 Bun 的 `verify` 脚本入口调用，Python 3 与 strace 前置在正文说明。
- README 与品牌/架构说明中的 **42 处本地链接及锚点通过**；仓库链接与 Web UI issue #14
  经指定连接读取确认有效。现有设计指向英文命名兼容章节的锚点保留。
- 两个 README 的 Mermaid 块与各自 `.mmd` 图源逐字相同；去掉译文标签后图结构相同。
- Mermaid **11.12.2** 在 Chromium 实际解析和渲染英文/中文 × 浅色/深色四种组合；
  各图 **11 个节点、12 条边**。已目视复核图中文字、连接方向和主题对比度。
- 虚线仅表示 Connector 主动向 Gateway 发起 WSS；实线表示请求下行、结果/事件返回。
  图只展示最终目标组件、职责、连接与数据流，不包含开发进度标签；
  认证/WSS/provider 存储待实现、Herdr 待 P0-H 默认拒绝和 Web UI 规划状态均保留在独立的当前状态小节。
- 原始 PNG **2172 × 724、428,629 字节**，SHA256
  `e0940cf61b4feee2c6db2226a8fe6c998f057427819f04e40a0902b3639d7dbe`，
  Git blob `a6aec714299977b40b6bb98a663559e0c5df2993`。
  已实际查看，标志为编织 R 兼首字母，后接 `ovloom`。
- README 展示 SVG 的内嵌 PNG 与原图逐字节相同，白色底板使深墨蓝字标在深浅主题均可读；
  无脚本、外部资源或字体依赖，原始透明 PNG 独立保留。
- Git whitespace 检查通过；未新增产品功能测试。本轮未运行业务/原生测试，现有 P0/Bun 报告的
  历史结果不改记为本轮执行，也不构成新认证/WSS/Herdr 功能验收。

## 合并前依赖

该文档 PR 保持 **Draft**。代码整合 [PR #19](https://github.com/ArnoChenFx/Rovloom/pull/19)
应先合入，再对照届时 main 重验并更新双语功能状态、
构建输出及命令；当前基础层表述不能直接当作整合完成后的支持矩阵。
独立 P0-H 前 Herdr 执行保持默认拒绝。此分支不合并 main、不关闭 issue。

远端分支、最终提交、全树比对与 PR 状态以交付消息及 PR 验收记录为准。
