# ADR 0003：Bun 执行与开发工具链

状态：采纳（已修订：不再固定精确版本）。

## 决策

使用 Bun 执行安装、TypeScript、测试和构建，使用提交的文本 lock（`bun.lock`）保证 CI 可复现；不依赖 Node/npm/npx 回退。类型检查由 TypeScript 编译器独立执行，Bun 的转译或打包成功不代替它。

保留 `node:sqlite` 接口，由 Bun 提供实现，避免同时维护两套存储后端。SQLite 文件、事务、绑定和 writer 语义须在实际运行时验证；`process.version` 的 Node 兼容字符串不是 Node 执行证据。

**版本策略**：

- `package.json` 的 `engines.bun` 只声明**最低**版本；依赖与 devDependencies 使用 `^` 范围，不固定补丁版本，也不使用 `packageManager` 精确 pin。
- CI 同时在最低版本与最新版本上跑 lint、format、typecheck、test、build、smoke。最低版本通过才允许提高 `engines.bun`。
- 发行构建使用构建当时的最新 Bun；实际版本写入 release manifest 的 `bun` 字段，仅作记录，不参与校验。
- 依赖升级通过常规升级 PR 完成，由 CI 把关。

构建按源码入口列表输出模块，依赖外置；禁用自动 `.env` 加载与 install lifecycle scripts。

## 理由

原先把 Bun、TypeScript 和全部依赖锁到精确版本，并在测试里断言版本号。这样换一个补丁版本就会出现与代码无关的失败，升级成本高，却没有换来额外的安全性：供应链风险由 lockfile 与 CI 控制，运行时版本差异由最低/最新矩阵暴露。

## 边界

工具链验证只证明其平台与测试范围，不证明其它 OS、商业 MCP Host、OAuth 或服务部署已完成；这些由端到端验收单独负责。
