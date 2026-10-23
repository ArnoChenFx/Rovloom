# ADR 0003：Bun 执行与开发工具链

状态：采纳。

## 决策

使用 Bun 执行安装、TypeScript、测试和构建，使用提交的文本 lock（`bun.lock`）保证 CI 可复现。不依赖 Node、npm 或 npx 回退。类型检查由 TypeScript 编译器独立执行，Bun 的转译或打包成功不代替它。

存储保留 `node:sqlite` 接口，由 Bun 提供实现，避免同时维护两套存储后端。SQLite 文件、事务、绑定和 writer 语义须在实际运行时验证。`process.version` 的 Node 兼容字符串不是 Node 执行证据。

**版本策略**

- `package.json` 的 `engines.bun` 只声明最低版本。依赖与 devDependencies 使用 `^` 范围，不固定补丁版本，也不使用 `packageManager` 精确 pin。
- CI 只使用最新稳定版 Bun 运行 lint、format、typecheck、test、build、smoke（见 [CI 配置](../../.github/workflows/bun.yml)），不再维护最低版本矩阵。`engines.bun` 继续表达运行时最低兼容要求。
- 发行构建使用构建时的最新 Bun。实际版本写入 release manifest 的 `bun` 字段，仅作记录，不参与校验。
- 依赖升级通过常规升级 PR 完成，由 CI 把关。

构建按源码入口列表输出模块，依赖外置。禁用自动 `.env` 加载与 install lifecycle scripts（见 `bunfig.toml`）。

## 理由

把 Bun、TypeScript 和全部依赖固定到精确版本，会让一次补丁升级引发与代码无关的失败，升级成本高，却不带来额外的安全性。依赖由 lockfile 与 CI 校验，CI 和发行构建跟随最新稳定版 Bun；GitHub Actions 使用维护时核对的最新稳定主版本标签。

## 边界

工具链验证只证明其平台与测试范围，不证明其它 OS、商业 MCP Host、OAuth 或服务部署可用。这些由端到端验收负责，见 [开发指引](../DEVELOPMENT.md)。
