# 开发与验证

工具链固定为 **Bun 1.4.3**，由 `.bun-version`、`package.json` 和
[CI](../.github/workflows/bun.yml)共同约束。选择依据见
[ADR 0003](adr/0003-bun-toolchain.md)，官方 release、binary hash 与 revision 见
[来源数据](../scripts/bun/provenance.json)。

## 日常命令

在仓库根目录执行：

```sh
bun --version
bun install --frozen-lockfile --ignore-scripts
bun run toolchain
bun run comments:check
bun run typecheck
bun run test
bun run test:protocol
bun run test:toolchain
bun run audit:luvus
python3 scripts/native-contract/audit-fixtures.py
bun run build
bun run smoke
```

`bunfig.toml` 禁止自动读取 `.env` 和依赖安装脚本；验证器及子进程另显式传入
`--no-env-file`。`typecheck` 由 Bun 启动锁定的 TypeScript 7.0.2 dispatcher，
再执行其原生编译器，保留 `strict` 和 `noUncheckedIndexedAccess`；转译不能
替代类型检查，也不要直接运行 TypeScript 的 Node shebang。

代码文件职责、函数实现及全部回调的中文说明按[代码注释约定](#代码注释约定)执行，
覆盖检查纳入 CI。

构建先清空 `dist`，向 `dist/src/` 输出 contracts/store/router/protocol、
native-contract、wire、integration、persistence、transport、Herdr、webui、admin 与独立 service 十三个 Bun ESM 入口、共享 chunk 与外部
source maps，依赖外置。共享 chunk 保持错误类型和内存 handle 身份。
smoke 从产物验证原生离线编译、request/error/result 边界、v2 往返及旧帧/缺失 provider 拒绝、
SQLite 文件重开及无副作用的 service 模块导入。开机服务模块及 CLI 接缝见 [SERVICE](SERVICE.md)；当前没有已装配的服务 CLI、Node target 或声明产物。

产品分发使用独立的 [Bun 单文件构建与验收](DISTRIBUTION.md)，输出到 `dist/release/`。
它复用真实 CLI 入口与 WebUI 构建；入口未合入或宿主未接通时明确保留待验状态。

管理页另以 browser target 输出 `dist/webui/` 的 ESM、HTML/CSS 与外部 source maps，
不依赖 Node、远端字体或 UI 框架。默认入口以固定同源 GET 读取管理 API；未配置宿主 listener/服务时显示不可用，不加载测试数据。
`dist/src/admin/index.js` 只提供宿主组合模块，不自动启动；可信会话与共享 service 的注入边界见 [管理页设计](GATEWAY-WEBUI.md#只读-http-宿主桥)。
顶栏与 favicon 复用[独立橙色 R](assets/brand/rovloom-mark-orange.png)；[横版全名图](assets/brand/rovloom-logo.png)仍保留在静态产物中。构建和隔离验证保持两张原 PNG 的字节、背景及纵横比。

## 管理页面的隔离验证

`bun run test` 自动包含 `test/webui/` 的共享 DTO 消费、边界与生命周期测试。
构建后可运行仅监听 `127.0.0.1`、随机端口的展示验证服务：

```sh
bun --no-env-file scripts/webui/preview.mjs
```

日志给出本次端口。`/` 使用构建后的入口，由于预览不提供 API，明确显示读取不可用；`/fixtures/` 显式使用隔离测试数据，
不包含管理 API、真实管理员授权或 Connector。它是测试工具，不能用来部署管理面。
验证完以 Ctrl-C 关闭。

已有 Python Playwright 与 `/usr/bin/chromium` 的环境可另开终端执行：

```sh
python3 scripts/webui/check-browser.py --url http://127.0.0.1:PORT --output /tmp/rovloom-webui-browser-new
```

语言/主题另有覆盖两语两主题、系统变化、偏好存储失败及认证失效的浏览器检查：

```sh
python3 scripts/webui/check-preferences.py --url http://127.0.0.1:PORT --output /tmp/rovloom-webui-preferences-new
```

将 `PORT` 替换为本次预览端口；输出目录必须全新且位于 checkout 外。
原展示检查固定使用中文，语言/主题检查覆盖中文与 English 及320px布局；两者生成截图与 JSON 断言结果。
它们验证真实 Chromium 上的合成 UI 数据、转义、
焦点、导航、取消、部分失败及会话失效展示，不验证真实管理后端或安全认证。
浏览器检查需显式运行，不从工具链通过推导浏览器或跨平台验收。

## 隔离验收

Linux 需 Python 3、strace 和固定 Bun，在 checkout 外指定尚不存在的输出目录：

```sh
python3 scripts/bun/verify.py --bun /absolute/path/to/bun --output /tmp/rovloom-verification-new
```

验证器在新项目、新 HOME、空缓存与最小环境中冻结安装，审计实装依赖，运行
strict 类型检查及故意错误反例、验收器自身回归、递归发现的全部主测试、
P0 JS/Python 测试、Bun 兼容测试、fixture 审计、clean build 与产物 smoke。
Node/npm/npx 阻断探针必须返回 99，项目 execve/execveat 追踪不得出现 Node
回退。GitHub Actions 的 checkout 宿主不属于项目运行时。

## 代码注释约定

`src/`、`test/`、`scripts/` 中维护的 JavaScript/TypeScript 和 Python 文件，
必须在文件开头写简洁中文职责说明；shebang、Python 编码声明可置于其前。
每个函数实现都要有就近中文注释，说明实际功能与作用，必要时解释副作用、
失败边界和返回语义。范围包含方法、构造器、getter/setter、箭头函数、匿名
函数、嵌套回调、Python `async def` 和 `lambda`。不要用重述名称的空话充数，
不要混入开发日志；保留已有有效注释。

JS/TS 将说明写在函数、方法或直接初始化函数的变量/属性声明前；调用参数里的
回调应在该函数节点前写 `/* 中文说明 */`，不能沿用外层函数说明。文件职责和
首个函数说明使用独立注释块，以空行分隔。Python 使用 `#` 写在 `def` 或首个
装饰器前；`lambda` 的说明放在最近所在语句前或该 lambda 所在行尾。不要为了
补注释添加或修改 docstring，因为它会改变运行时的 `__doc__`。已有中文
docstring 可以作为说明保留。

`bun run comments:check` 复用锁定的 TypeScript 7 AST 与 Python `ast/tokenize`，
递归检查上述三个目录内的 `.js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.cts/.py`，并在
语法错误时失败。无实现体的类型签名、接口方法、重载和抽象方法不计作函数
实现；声明文件仍检查文件职责。代码字符串里的样例不会被当作嵌套代码解析。
固定输入中的 JSON/锁文件、依赖和生成物不属于代码检查范围；三个维护目录内
的文件不能仅凭 `fixtures`、`vendor` 等目录名豁免。未来如引入真正的第三方
代码或生成代码，应审查后使用明确路径例外。门禁检查注释位置与中文覆盖，
注释准确性和信息量仍须人工审查。
编写时应对照真实控制流，说明该函数的输入处理、输出、拒绝边界或副作用；
“执行函数”“处理回调”等重述名称的文字不能作为有用说明。自动门禁只判断
注释位置与是否包含汉字，不验证自然语言正确性。

新增代码或合入其他工作分支后，先运行以下门禁，再执行上面的完整验收：

```sh
bun run comments:check
bun run test:quality
python3 scripts/maintenance/run_python_tests.py --output /tmp/rovloom-worker-python-new.json
```

输出路径须为尚不存在的新文件。覆盖检查不依赖 Git，在隔离验证副本中同样
运行，并包含未跟踪的维护代码；临时探针和执行报告应放在 checkout 外。

纯注释修改可执行 `bun run comments:equivalence -- --base <commit>`，比较基线
代码的解析结构与当前代码。它忽略注释和格式位置，但保留运算符、字面量、
类型语法和自动分号插入造成的结构差异；Python 按编码声明解析源码原字节，
使用完整 AST 比对，docstring 也不能悄悄变化。该检查不替代类型检查、测试和构建。新增检查工具及其测试
由正常质量门禁验证，不属于基线代码的纯注释等价比较。
AST 比较不解释编译器或打包器的特殊指令注释；此类指令仍须保留并单独审查。
JS/TS 的 JSDoc、triple-slash、`@ts-nocheck`、`@__PURE__` 等注释，以及 Python
`# type:` 注释，不受该比较保护；JS/TS shebang 和 `"use strict"` 等真实语法
语句会保留，Python 编码声明通过原字节解码参与解析，docstring 则是实际 AST。
等价检查也不比较源码行号、栈位置或函数源码反射结果。它只用于指定基线的
纯注释补丁，不能代替业务变更的测试；新增文件由覆盖与常规质量门禁验证。

主测试数量与标题随当前代码维护，不依赖固定历史 inventory。门禁要求非空且一致的
JUnit 报告，核对当前完整测试文件集合均有实际执行的 case，并将运行日志的通过数
与报告核对；失败、skip、todo、disabled 均不得通过。独立维护检查还核对仓库内
所有主测试、脚本测试与 Python 测试文件的执行证据。执行输出和验收结果放 CI/PR，
不向仓库提交逐轮报告。

完整 Bun 套件的外层 watchdog 为 300 秒，其它验证命令仍为 180 秒；产品编译预算、
业务期限和各用例时限独立保留。验证器打印套件实际耗时、用例摘要与 watchdog。
命令超时后仍非零退出，在既有 `--output` 目录留下标记 `complete: false` 的阶段诊断、
最近观察到的测试，以及脱敏的日志/追踪尾部（分别最多 128 KiB / 1 MiB）。这些不完整
记录不能替代完整 JUnit、成功构建或执行覆盖证明，也不纳入 Git。

## 固定输入与维护用途

| 数据 | 用途 |
|---|---|
| [Luvus 0.14.3 原始采集](../test/fixtures/luvus/0.14.3/linux/manifest.json) | 安装 schema 原文字节、实时能力、RPC/Host/终端记录、endpoint 与清理断言；测试和审计直接读取 |
| [原生来源](../test/fixtures/luvus/0.14.3/provenance.json) | 官方 release/binary hash、固定源码 commit 及 29 个 schema 文档对应关系 |
| [覆盖账本](../test/fixtures/native-contract/coverage.json) | Luvus/Wire 测试与审计重算逐方法基线；历史 not_implemented/not_enabled 不代表当前许可 |
| [方法映射](../test/fixtures/native-contract/native-method-map.tsv)、[终端映射](../test/fixtures/native-contract/terminal-capability-map.tsv) | 审计方法/profile/transport/参数证据及 24 个 capability、2 个 feature；不作为安全分类或生产 allowlist |
| [矩阵](../test/fixtures/native-contract/matrix.json) | 原生测试物化 seed、变更、生成器及正反断言；文件内历史提案状态不充当运行结果 |
| [无效 pane](../test/fixtures/luvus/0.14.3/invalid-pane.json)、[失效路由](../test/fixtures/luvus/0.14.3/stale-pane.json) | 从独立原生采集中逐字摘取的 request/response；含 binary/schema hash、原归档 hash、Git blob 与记录位置；前者明确来自未完成采集 |

所有 Bun 回归统一位于 `test/` 并由 `bun run test` 执行。`test:protocol` 和
`test:toolchain` 仅供聚焦运行；完整 verifier 只运行一次统一套件，用 JUnit 核对当前
文件集合、实际用例数、零失败和零跳过。Python 工具测试也按功能放在 `test/`，由
`scripts/maintenance/run_python_tests.py` 在逐文件独立进程中发现并执行。

`scripts/native-contract/audit-fixtures.py` 校验 manifest/hash、离线引用、映射和
矩阵可物化性；它不执行 validator/授权/流/存储验收。`audit:luvus` 另核对必需文件、
schema 闭包、请求/响应关联、退出码、endpoint/peer 身份与清理状态。它们均不启动
原生实例、不联网。真实 SDK stdio 子进程协商位于 `test/mcp/`，每次检查当前锁定依赖；
SDK 运行报告打印到 stdout，不写回仓库快照。

### 维护目录与生成规则

- `src/connector/{luvus,herdr}` 放原生 adapter；`native-contract`、`wire`、`transport`、
  `storage`、`integration`、`mcp`、`webui` 按实际职责维护。根 Store/Router/协议入口继续
  作为现行公共入口，避免仅为整齐改变全部调用方。
- `scripts/{luvus,herdr}` 放固定版本原生输入的采集、审计和验证工具；`scripts/bun` 放
  工具链 pin、冻结安装检查、build、smoke 与隔离 verifier；`scripts/maintenance` 放仓库门禁。
- `test/fixtures/{luvus,herdr}` 按版本保存协议原文、来源与许可证，`native-contract` 保存
  当前映射和矩阵。捕获中的历史 session/路径标记保留原文，不作为维护目录命名。

`coverage.json` 由 `bun scripts/luvus/audit-fixtures.mjs --write` 从固定原文生成；
方法 TSV 由 `python3 scripts/native-contract/audit-fixtures.py --write-map` 生成。
更新输入时显式生成并审查差异；日常 CI 只重算比对，不修改版本化输入。
`dist/`、Python 缓存、工具执行日志及逐轮验收报告不提交。所有采集和验证输出使用
checkout 外的全新私有路径；SDK/工具链运行元数据也只进入 CI/PR 或临时目录。

重新采集先按 provenance 核验官方 binary，指定全新输出，不覆盖已提交 fixture：

```sh
python3 scripts/luvus/collect.py --binary /absolute/path/to/luvus --output /tmp/rovloom-native-new
```

采集器在 `/workspace` 创建自己的 0700 状态根、named session 和合成终端输入，
不继承用户 HOME/session；这不是 OS 文件沙箱。流、server、临时根在 finally
清理，SIGKILL/机器崩溃仍需外部回收。升级先评审契约/分类，再重新采集、审计。
主采集完整回放与两组补充原生交换持续维护协议断言，无 Node 约束由当前 verifier 的
阻断探针和 strace 执行追踪验证；不以历史压缩采集包的重复回放代替当前检查。

## Herdr 离线输入

[方法门禁](../test/fixtures/herdr/0.9.5/method-policy.json)的生产允许集为空；`ping {}` 和
`session.snapshot {}` 仅是固定官方来源中的研究候选，任意其它参数、读取变体、
订阅和写入均不获产品许可。离线工具不运行 Herdr、不发现或连接 socket，也不创建凭据。
真实采集须另有预先准备并获授权的专用实例及官方 binary。

```sh
python3 test/herdr/test_contract.py
python3 scripts/herdr/audit.py test/fixtures/herdr/synthetic
```

[合成 fixture](../test/fixtures/herdr/synthetic/capture.json)只验证离线工具，版本、binary
摘要、schema 和协议样本均非安装版实测证据。审计核对原始文件 hash、记录中的
实例/契约、CLI argv/退出码、单行 JSON、原生 result/error 关联和缺回复的
`outcome_unknown`；schema 仅检查已提供文档的方言与引用闭包，不编译或验证
完整方法参数。只支持 draft 2020-12、精确离线文档 ID 和 JSON Pointer，未知
引用特征拒绝，不联网补齐。文件/总量/帧限额属于工具自身，不代表原生上限。

将预先导出的证据按 fixture 结构放入自己拥有的 0700 目录，保留 CLI stdout、
stderr 和协议帧原字节，填写文件清单与记录中的 binding。真实导出标记为
`unverified_capture`；本地文件自报身份或 hash 不能建立生产来源。归档只校验、
复制并再次审计，输出须全新且位于 checkout 与输入之外：

```sh
python3 scripts/herdr/collect.py --input /absolute/private/herdr-export --output /tmp/rovloom-herdr-evidence-new
```

可用 `observations: [{"role": "endpoint_peer", "file": "endpoint.json"}]` 引用额外
原文；role 限 `official_origin`、`endpoint_peer`、`side_effects`、`framing`、
`subscriptions`。这些文件仅记录和校验 hash，其自报结论不获得认证。

归档目录/文件权限为 0700/0600；不接受链接、越界路径、未列文件或超限输入，
失败清理本次输出。已知假 secret canary 扫描不代替人工脱敏或完整秘密检测。
审计成功仍输出 `native_verified: false`、空生产允许集及未验证项，不签发执行
许可。实际 endpoint/peer、binary 来源与运行、被动读副作用、订阅确认和失联
必须在专用实例分别实测，并由独立评审确认覆盖范围。

`StateRebuild` 是离线状态模型：订阅确认后从另一连接读取快照，串行刷新，
读取中有事件则再读；gap/EOF 使在途快照失效并要求新订阅。事件仅表示失效，
不将其载荷重放到快照。合成回放只演示 `state_rebuild_only` 语义，不能为原生
事件历史、序号、订阅副作用或产品 adapter 提供保证。实测结论与阻断留在 PR/CI。

### 专用原生验证

安装来源固定在[Herdr provenance](../test/fixtures/herdr/0.9.5/provenance.json)：官方
release/asset、源码 commit、Linux binary 与安装 schema 的 SHA-256、协议与方言。
升级需先重新核对官方当前 release、下载 hash 和安装契约；验证器不自动下载或升级。

获得专用临时实例的运行授权后，可使用匹配 pin 的普通本地 binary：

```sh
python3 scripts/herdr/verify_native.py --binary /absolute/verified/herdr --output /tmp/rovloom-herdr-native-new
```

命令只在全新私有 HOME/XDG 根启动一个新 named session，以直接监管的进程 PID
核对 Linux `SO_PEERCRED`，不查询其它进程的受限 `/proc` 路径。它不继承 SSH、
模型凭据或用户配置，关闭后台版本/manifest 更新和 agent 恢复。合成终端只计数
输入且不执行命令；`workspace.create/rename` 只用于生成本次新建资源的测试事件，
不进入产品允许集。验证器会故意积压订阅并杀死自己的原生进程，不能指向已有会话。

原始 CLI schema、请求/响应、事件、native error、退出码和文件 hash 写入指定的
0700/0600 输出目录；临时状态根与合成子进程在 finally 清理。失败步骤保留失败，
缺少真实 `events_lost`、清理不完整或断言关闭时命令非零退出。引用闭包审计不替代
完整参数编译；静态合成 pane 的可观测状态/输入比较不证明所有 UI、agent、通知或
其它参数无副作用。原生通过范围和失败保留在 PR/CI，生产 allowlist 与保证仍须独立
评审和实际 adapter 接线，不从本地验证报告生成执行许可。

保留窗边界和并发刷新使用独立实验，每个场景各建全新实例：

```sh
python3 scripts/herdr/verify_readonly.py --binary /absolute/verified/herdr --output /tmp/rovloom-herdr-readonly-new
```

实验先用独立对照实际观察大事件写超时后的截断帧和 EOF，再观察一条尚未写完的大
事件，以相同设置的受控背压固定下一批轮询的游标，再分别生成
512/513 条自己的重命名事件。完整事件、`events_lost` 和 EOF 均须实际收到；超时、
生成超预算或游标未固定即失败。游标的解释依赖固定官方实现，不是公共原生序号。
512 场景读满后另发 marker 并实际读取其事件，确认订阅仍能继续消费；marker 不计入
初始保留窗。生成预算包含最后一次请求返回，不能只检查请求开始时间。
大事件只用于测试，不放宽产品 64 KiB 帧限额。并发场景记录真实客户端请求区间、
脏刷新和整体替换；另用合成 OSC 标题/输出观察元数据变化，不向 PTY 发送输入。
原生日志与失败轮次继续只留在临时输出和 PR/CI。

### 只读 adapter 接缝

[原生组件](../src/connector/herdr/readonly.ts)复用 Wire 的 `AttemptBinding`、`ContractRecord`、
双端策略与 Store attempt，不创建第二套设备/provider 身份。协议回放限
`ping {}` 和 `session.snapshot {}` 的 RPC，保留原生 result/error；adapter 执行候选
进一步限 `ping {}`，snapshot 仍因副作用覆盖不足而拒绝。流、raw、Host、其它参数、
终端和写入均拒绝。共享 provider 的 Herdr candidate 硬门禁仍保持关闭。

[安装 schema 原文](../test/fixtures/herdr/0.9.5/schema.json)的 hash 对应固定 provenance，
[脱敏原生回放](../test/fixtures/herdr/0.9.5/readonly.json)仅替换路径和请求 ID；上游许可见
[LICENSE.herdr](../test/fixtures/herdr/0.9.5/LICENSE)。测试从完整 request/success/error 根编译，
不把 method envelope 检查冒充完整 schema 校验。

宿主须实现源码中的 `HerdrReadonlyBackend`：从现有 Store 取原 attempt/内容状态，
重新解析当前连接、registry、双端完整 Target grants；独立核对安装契约和本机
endpoint/peer 后持有不可序列化来源 token。实例或连接改变时替换 token，旧句柄失效。
同一完整 binding 的重复解析复用私有句柄和原 permit；换 epoch/恢复代次不得复用。
原生响应证据验证不依赖当前内容读者、read grant 或原策略 revision 仍生效；它始终
核对原锚点/permit、当前有效连接/provider 与独立来源。读取撤权、过期或 discard
只能进入 Store 的最小证据分流，原文保存和交付仍须另查当前权限及原期限。
完整 schema 编译仍须满足 DESIGN 的可终止 worker 与硬资源预算；测试中的直接
编译不能满足这个生产门禁。原生传输、共享 provider 支持切换、Store 证据提交及
实际 Gateway/Connector 接线未由这个组件交付。

当前证据测试由合成 backend 保留原 attempt；它不证明真实 Store 清理请求后的迟到路径。
Herdr 尚未接入共享的 `responseAnchor`、`subscribeInvalidation`、失效关闭及最小仅响应
上下文，不能直接充当现行 transport 的完整 adapter。宿主原 attempt 回收后仍需补齐
这些接口及事务接线，不能从保留状态反例推导生产 metadata-only 已可用。

`ping` 足以核对存活和版本，不能提供当前 session 状态。`session.snapshot` 经过公共
请求前置的待处理终端标题同步，可能更新标题缓存并发布 pane 元数据事件；它不是
冻结状态读取。只测静态 pane、合成输出和并发重命名，不证明活动 UI、真实 agent
或通知路径无副作用，不能据此默认给 observer 开放。生产允许集继续为空。

## 实现范围

Linux 原生基线不证明跨平台、商业 MCP Host、HTTP/OAuth 或真实双机已验收；
SDK 实证 revision 为 `2025-11-25`，Bun 的 `process.version` 只是 Node 兼容值。
223 方法中 144 个只有 generic params object，不能宣称完整参数校验。
原生接口与宿主接缝见 [原生校验](protocol/NATIVE-CONTRACT.md)，外层见
[Wire v2](protocol/WIRE-PROTOCOL.md)。产品设计、保留/恢复规则及 Herdr 门禁以
[DESIGN](DESIGN.md)、[实施计划](IMPLEMENTATION-PLAN.md)和 ADR 为准。

SQLite 使用 Bun 的 `node:sqlite`，当前规范 schema v4 要求全新库并拒绝未发布的旧库。
Store/Router 已提供 provider/binding、固定原文期限、持久 history、全局预算、降级与隔离快照；
本机管理接口与独立可信来源的接线边界见[存储运行指引](STORAGE.md)。测试使用临时 SQLite
文件、真实 SQLITE_FULL 与异常退出，不触及真实库。WSS/loopback 模块与独立宿主接线见
[通道接线](TRANSPORT.md)，测试证书另需 Linux `/usr/bin/openssl`。生产持久身份服务、跨平台存储和重启后的原生
响应上下文恢复仍待接线；unknown 不重放，取消不代表回滚，逻辑删除不保证物理擦除。
Herdr 未通过独立 P0-H，仍不可执行。
