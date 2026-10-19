# 单文件发行候选

Rovloom 使用固定 **Bun 1.4.3** 的 `bun build --compile` 分发单文件可执行程序。
源码开发的模块构建仍用 `bun run build`。发行构建直接使用 `src/cli/main.ts`，
不会生成替代 CLI 或装配第二套 Gateway/Connector。
该入口未合入时，`bun run release:build` 明确失败；设施探针通过不能证明产品可用。

## 构建与验收

在仓库根目录冻结安装依赖后执行：

```sh
bun run release:build
bun run release:smoke /absolute/path/to/dist/release/bun-linux-x64/candidate/rovloom
```

输出在被忽略的 `dist/release/<target>/candidate/`，包含 binary 与构建清单。
构建清单分别保留 runtime 和产品接线待验状态；构建成功不能自动改为验收通过。
smoke 只复制 binary 到临时目录，以空 PATH、新 HOME 和不含源码/node_modules 的 cwd
执行帮助、版本、模板与参数拒绝，检查退出码和 stdout/stderr。它不证明真实 MCP 调用、
生产管理员认证、双机角色或 Luvus/Herdr 服务已经接通。

[本机 CI](../.github/workflows/standalone.yml)分别在 Linux x64 和 Windows x64 编译、执行。
真实入口缺失时，仅上传明确标为 `packaging-probe` 的设施探针；它检查 Worker、受控静态 helper、
WebUI 原字节及内存 SQLite，并用漏掉 Worker 的反例验证缺包失败。
探针不代表生产 Ajv 工厂或宿主接线。真实入口存在时另行上传 `cli-preview-candidate`。
所有上传均为短期 Actions artifacts，不签名、不发布 GitHub Release；其他 OS/架构须独立本机验收。

## Worker 与内置资源接口

[产品清单](../scripts/release/product.mjs)维护真实入口、附加 Worker 和受控资源，
[构建器](../scripts/release/build.mjs)也可由测试或可信构建脚本传入同样的显式清单。
Worker 必须列为额外 entrypoint；入口输出统一使用唯一文件名，普通 Worker 宿主使用
`new Worker(new URL('./worker-name.ts', import.meta.url))`，源码中与该 Worker 同目录。
Worker 文件名必须唯一。受控 helper、Ajv standalone 产物和 schema 通过静态 import，
或 `with { type: 'file' }` 导入后读取嵌入路径；不能从 cwd 补包或调用外部 Bun。
schema 工厂的 `compiler-worker.ts` 及 `compilerWorkerPlugin()` 列入固定接入边界：
构建器必须应用工厂自带的受控 Blob 定位插件并 bundle 依赖，不能绕过插件直接编译原始入口。
其最终实现合入后，CI 另运行 `scripts/release/native-smoke.mjs`，验证真实异步编译、
29 份离线 schema 和原生错误数据保真；验收通过前仍是待接线候选。

构建专用模块 `rovloom:management-assets` 导出 `loadEmbeddedManagementAssets()`，
返回现有管理 HTTP 桥接受的 `ManagementAssets` 内存 Map。
可信宿主将该 Map 注入既有 `createManagementReadHandler` 或 `startManagementReadListener` 的 `assets`；
构建本身不启动 listener，也不提供默认身份或认证。
资源沿用同一 WebUI 构建与现有白名单，包含 HTML、JS/chunks、CSS、独立应用标和横版全名原图。
显式嵌入的受管静态资源不含测试页面、SQLite 运行状态、凭据、用户配置或外部 Luvus/Herdr binary。
不自动扫描或复制其它服务目录；资源缺失必须失败。

## Windows 程序图标

唯一来源是[独立橙色方形标](assets/brand/rovloom-mark-orange.png)。构建仅把原始 **192×192 PNG**
封装进单帧 ICO，保留浅色背景、原字节和分辨率；不使用复合展示图、不重绘、不承诺更高尺寸。
Windows 本机编译传入 `windows.icon`，保持控制台子系统以支持 CLI/MCP stdio。
CI 解析实际 EXE 的 `RT_GROUP_ICON`/`RT_ICON`，逐字节比对原 PNG 并核对控制台子系统，
随后隔离执行；Linux 交叉编译不能作为 Windows 图标生效或 Windows runtime 通过的证据。
构建器因此拒绝从非 Windows 主机生成带品牌图标的 Windows 候选。

选项与嵌入方式以 [Bun 官方 executables 文档](https://bun.sh/docs/bundler/executables)为依据，
本仓库固定版本的实际 binary/CI 验收优先于文档示例。
