# ADR 0003：Bun 执行与开发工具链

状态：采纳。工具链命令与精确锁定值由 [开发指引](../DEVELOPMENT.md)、[.bun-version](../../.bun-version)、package/lock 及 CI 维护；本 ADR 记录运行时与构建选择的理由。

## 决策

使用官方 Bun 执行安装、TypeScript、测试、P0 JavaScript harness 和 Bun 目标 ESM 构建，使用冻结文本 lock；不依赖 Node/npm/npx 回退。不把 Bun 转译/打包成功当严格类型检查，独立由锁定的 TypeScript 编译器检查。

保留 `node:sqlite` 接口，由 Bun 提供实现，避免同时维护两套存储后端。SQLite 文件、事务、migration、绑定、分页和 writer 语义须在实际执行运行时验证；`process.version` 的 Node 兼容字符串不是 Node 执行证据。

构建按源码入口列表输出模块，依赖外置，共享 chunk 保持错误/handle 所需模块身份一致，先清理旧产物，再执行真实文件数据库和跨模块 smoke。模块入口清单以构建脚本为准，不在文档复制易失效的入口数量；模块产物不等于服务 CLI。

禁用自动 `.env` 加载与 install lifecycle scripts，验证使用新临时项目、空缓存和新 HOME，不复制用户状态/凭据。质量命令直接由固定 Bun 执行，以真实子进程退出码、JUnit 与源码执行覆盖验收；平台 proxy/CA 可以按验证器规则继承，凭据和值不写日志。

验证范围调整：全进程树追踪与 Node/npm/npx 拒绝探针不再属于普通质量门禁。既有追踪失败仍是历史失败证据，不因本次范围调整改判成功；运行记录只描述实际执行的命令和测试。

## 理由与边界

单一执行工具链减少运行/构建差异，保留既有 SQLite API 和依赖锁可以缩小迁移面。独立类型检查和构建 smoke 分别覆盖转译无法保证的类型正确性及产物行为，不能互相替代。

外部发行来源、binary hash/revision 和不可变测试 provenance 保留在 [工具链来源](../../scripts/bun/provenance.json)；每轮输出与验收状态留在 CI/PR。历史 Node 原生采集不改写成 Bun 采集，两条路径的原始证据独立维护。

工具链验证只证明其平台与测试范围，不证明其它 OS、商业 MCP Host、OAuth、多 provider 生产后端或服务部署已完成。系统架构与待交付项分别以 DESIGN、实施计划为准。
