# 开发与验证

Rovloom 使用 **Bun** 执行与构建（`package.json` 的 `engines.bun` 只声明最低版本，依赖用 `^` 范围，
`bun.lock` 保证 CI 可复现）。CI 同时跑最低版本与最新版本，见 [CI](../.github/workflows/bun.yml)；
选择依据见 [ADR 0003](adr/0003-bun-toolchain.md)。

## 日常命令

在仓库根目录执行：

```sh
bun --version
bun install --frozen-lockfile --ignore-scripts
bun run lint
bun run format:check
bun run typecheck
bun run test
bun run build
bun run smoke
```

可选：`bun run test:protocol`、`bun run test:toolchain` 聚焦运行；`bun run audit:luvus` 核对固定的 Luvus 原生输入。

`bunfig.toml` 禁止自动读取 `.env` 和依赖安装脚本；子进程另显式传入 `--no-env-file`。
`typecheck` 由 Bun 启动 TypeScript 编译器，保留 `strict` 和 `noUncheckedIndexedAccess`；
转译不能替代类型检查。

构建先清空 `dist`，向 `dist/src/` 输出 contracts/store/router/protocol、
native-contract、wire、integration、persistence、transport、runtime、Herdr、webui、admin、Luvus connector、mcp、cli、service 模块及 CLI main 的 Bun ESM 入口、共享 chunk 与外部
source maps，依赖外置；准确入口清单由`scripts/bun/build.mjs`维护。共享 chunk 保持错误类型和内存 handle 身份。
原生编译 Worker 由同一 Bun 构建入口独立打包并内嵌，含锁定 Ajv；不增加第二运行时、
原生归档或 FFI。源码直接使用固定本地 Worker，产物不回退读取 TS 源码。
smoke 从产物验证原生离线编译、request/error/result 边界、v2 往返及旧帧/缺失 provider 拒绝、
SQLite 文件重开、无副作用的 service 模块导入，以及 CLI help 和配置模板解析。缺后端启动的退出码与输出由
[CLI 测试](../test/cli/cli.test.ts)验证。CLI 预览及受信宿主接口见
[MCP Streamable HTTP 契约](protocol/MCP-HTTP.md)，开机服务模块及受信 CLI 接缝见 [SERVICE](SERVICE.md)；
当前没有已装配的生产服务宿主、Node target 或声明产物。

产品分发使用独立的 [Bun 单文件构建与验收](DISTRIBUTION.md)，输出到 `dist/release/`。
它复用真实 CLI 入口与 WebUI 构建；入口未合入或宿主未接通时明确保留待验状态。

管理页另以 browser target 输出 `dist/webui/` 的 ESM、HTML/CSS 与外部 source maps，
不依赖 Node、远端字体或 UI 框架。默认入口以固定同源 GET 读取管理 API；未配置宿主 listener/服务时显示不可用，不加载测试数据。
`dist/src/admin/index.js` 只提供宿主组合模块，不自动启动；可信会话与共享 service 的注入边界见 [管理页设计](GATEWAY-WEBUI.md#只读-http-宿主桥)。
顶栏与 favicon 复用[透明背景的橙色 R](assets/brand/rovloom-mark-transparent.png)；[横版全名图](assets/brand/rovloom-logo.png)仍保留在静态产物中。构建和隔离验证保持两张原 PNG 的字节、背景及纵横比。

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

语言/主题另有覆盖图标按钮的键盘/外部关闭、八种屏宽、两语两主题、系统变化、偏好存储失败及认证失效的浏览器检查：

```sh
python3 scripts/webui/check-preferences.py --url http://127.0.0.1:PORT --output /tmp/rovloom-webui-preferences-new
```

控制台布局检查另外核对桌面行列对齐、首屏设备可见、详情分区、320px 命中尺寸，
以及原生诊断折叠区在年龄/语言重绘后的键盘焦点，并记录两语两主题及主要空/错/过期状态：

```sh
python3 scripts/webui/check-layout.py --url http://127.0.0.1:PORT --output /tmp/rovloom-webui-layout-new
```

将 `PORT` 替换为本次预览端口；输出目录必须全新且位于 checkout 外。
原展示检查固定使用中文，语言/主题及布局检查覆盖中文与 English 及320px布局；均生成截图与 JSON 断言结果。
它们验证真实 Chromium 上的合成 UI 数据、转义、
焦点、导航、取消、部分失败及会话失效展示，不验证真实管理后端或安全认证。
浏览器检查需显式运行，不从工具链通过推导浏览器或跨平台验收。

设备、provider与配对操作可独立使用临时 Store、现有会话/CSRF handler 和页面状态机验收：

```sh
bun --no-env-file scripts/webui/preview.mjs 33231 --actions
python3 scripts/webui/check-actions.py --url http://127.0.0.1:33231 --output /tmp/rovloom-webui-actions-new
python3 scripts/webui/check-lifecycle.py --url http://127.0.0.1:33231 --output /tmp/rovloom-webui-lifecycle-new
python3 scripts/webui/check-bootstrap.py --url http://127.0.0.1:33231 --output /tmp/rovloom-webui-bootstrap-new
python3 scripts/webui/check-retry-deadline.py --url http://127.0.0.1:33231 --output /tmp/rovloom-webui-retry-deadline-new
```

该服务只在显式 `/fixtures/` 让生产 `browser.js` 消费 CLI 同式 meta，拒绝根入口，所有设备和会话均为本次内存 fixture。
检查包括两语两主题、桌面/320px、实际改名/断开/撤销、一次确认、重复点击、错误恢复、
取消/导航与迟到、丢响应后原回执核对及原确认截止。lifecycle检查另覆盖单实例禁用（精确确认、一次提交、其它实例不受影响，且页面没有启用入口）。
fixture内兑换仅作用于自建临时设备，不是实际用户设备操作。bootstrap 检查额外覆盖实际 DOM 消费、
重复/无效交付、在页过期及永久卸载；不验证真实管理员、宿主秘密交付或用户设备。
跨截止检查在真实临时 Store 提交后延迟回执，验证提交中、未确认及查询中的重试事件均保留原关联，
直接交付或查询原回执只对应一次设备提交；覆盖英文桌面与中文深色320px。

## 固定输入与维护用途

| 数据 | 用途 |
|---|---|
| [Luvus 0.14.3 原始采集](../test/fixtures/luvus/0.14.3/linux/manifest.json) | 安装 schema 原文字节、实时能力、RPC/Host/终端记录、endpoint 与清理断言；测试和审计直接读取 |
| [原生来源](../test/fixtures/luvus/0.14.3/provenance.json) | 官方 release/binary hash、固定源码 commit 及 29 个 schema 文档对应关系 |
| [覆盖账本](../test/fixtures/native-contract/coverage.json) | Luvus/Wire 测试与审计重算逐方法基线；历史 not_implemented/not_enabled 不代表当前许可 |
| [方法映射](../test/fixtures/native-contract/native-method-map.tsv)、[终端映射](../test/fixtures/native-contract/terminal-capability-map.tsv) | 审计方法/profile/transport/参数证据及 24 个 capability、2 个 feature；不作为安全分类或生产 allowlist |
| [矩阵](../test/fixtures/native-contract/matrix.json) | 原生测试物化 seed、变更、生成器及正反断言；文件内历史提案状态不充当运行结果 |
| [无效 pane](../test/fixtures/luvus/0.14.3/invalid-pane.json)、[失效路由](../test/fixtures/luvus/0.14.3/stale-pane.json) | 从独立原生采集中逐字摘取的 request/response；含 binary/schema hash、原归档 hash、Git blob 与记录位置；前者明确来自未完成采集 |

所有 Bun 回归统一位于 `test/` 并由 `bun run test` 执行；`test:protocol` 和
`test:toolchain` 仅供聚焦运行。`audit:luvus` 核对必需文件、
schema 闭包、请求/响应关联、退出码、endpoint/peer 身份与清理状态。它们均不启动
原生实例、不联网。真实SDK回环Streamable HTTP协商位于 `test/mcp/`，每次检查当前锁定依赖；
SDK 运行报告打印到 stdout，不写回仓库快照。

### 维护目录与生成规则

- `src/connector/{luvus,herdr}` 放原生 adapter；`native-contract`、`wire`、`transport`、
  `storage`、`integration`、`mcp`、`webui` 按实际职责维护。根 Store/Router/协议入口继续
  作为现行公共入口，避免仅为整齐改变全部调用方。
- `scripts/{luvus,herdr}` 放固定版本原生输入的采集、审计和验证工具；`scripts/bun` 放
  build 与 smoke；`scripts/maintenance` 放文档渲染等维护脚本。
- `test/fixtures/{luvus,herdr}` 按版本保存协议原文、来源与许可证，`native-contract` 保存
  当前映射和矩阵。捕获中的历史 session/路径标记保留原文，不作为维护目录命名。

`coverage.json` 由 `bun scripts/luvus/audit-fixtures.mjs --write` 从固定原文生成；


原生 schema 没有预编译资产：Worker 对每份安装 schema 用锁定 Ajv 完整编译（冷编译约 0.7 秒，接纳期限 10 秒）。原生 fixture 字节不规范化。
运行时完整检查和精确失配回退见
[原生契约](protocol/NATIVE-CONTRACT.md#编译-worker-与生成物接纳)。
Herdr 的 `src/connector/herdr/generated/` 同样保存固定 0.9.5 正式 schema 的完整根资产，
由独立 provenance、现行 binary/schema 身份、编译器源码及实际 Ajv 包摘要绑定。
上述 generate/check 与正式构建会分别对 Luvus、Herdr 各完整编译一次并逐字节核对；
Herdr 运行时 Worker 用精确摘要选择已核对资产；未知 schema 从实际原字节完整编译。命中但资产损坏直接失败，不用运行时重编译掩盖损坏。
Herdr 整体接纳期限为 10 秒，覆盖慢速平台的 Worker 冷启动；宿主初始化校验、安装来源与不可复制品牌仍逐次核对。
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
主采集完整回放与两组补充原生交换持续维护协议断言，这些回归随 `bun run test` 执行；历史采集保留其原始运行时和证据范围。

## Herdr 离线输入

[方法表](../src/connector/herdr/methods.ts)实现固定来源的 65 个普通 RPC，参数由安装 schema 完整根验证。
[静态 policy](../test/fixtures/herdr/0.9.5/method-policy.json)已覆盖这 65 个方法，记录条件与风险，保持 `authorizes_dispatch: false`，不发行派发权限。
离线回放仍只接纳 `ping {}` 和 `session.snapshot {}`，且 `authorizes_dispatch:false`。
离线工具不运行 Herdr、不发现或连接 socket，也不创建凭据。
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

### Herdr 普通 RPC 与资源工厂

`HerdrInstallation.open(config, processBinding, signal?)`核对实际安装版本、原始 schema hash、
独立异步 Worker 资产接纳和同一受监管 child 的 socket peer。`launchHerdrProcess`只负责显式启动；
发现、Gateway 工厂与方法描述均不自动启动或认领已有实例。宿主等待 endpoint 就绪并持有原 child。

`createHerdrGatewayResources({config, signal?, now?})`返回 `providers/session/catalog/describe/release`，
交给既有 `createProviderGatewayRuntime`，会话使用外部提供的唯一 Store。
`createHerdrConnectorResources({config, installation, now, policies, releaseOwner, release_timeout_ms?})`
返回 `providers/session/release/release_timeout_ms`，交给 `createProviderConnectorRuntime`；
`providers`为原受保护路由描述，供同一runtime组合会话，不是来自广告的原生来源。
受保护 ref 由 `readHerdrProviderRefConfig`读取，字段及精确返回类型以
[`provider.ts`](../src/connector/herdr/provider.ts)为准；必须提供完整 Target、binding revision、
config ref、固定 expected source、schema 路径及独立 peer policy revision。Connector 另需
固定本机路径、principal、独立 claims 账本；正常重启使用 `open`，不重建丢失墓碑。

唯一 CLI owner 负责资源解析和角色装配，复用现有 HTTP MCP/管理会话。Luvus 专用工厂与目录类型
不能强制转换成 Herdr 类型；目录须接通 provider 分支、当前 Store binding 和双方策略。
双端协商 `rpc`。资源的 `providers[].preflightRequest`必须随原 providers 传入中性 runtime；它在唯一 Store 准入事务中使用本次真实 native request ID 和同一完整编译根预检，错误参数不登记 call/history key、不触碰共享设备连接。真正派发和原生写入前的来源、权限、schema 与持久 claims 复验继续保留。释放责任与预算见[通道接线](TRANSPORT.md)。

可复用检查入口：

MCP组件回归统一使用`createMcpFacade`与`RuntimeGatewayService`；没有单独的六工具构建入口。

```sh
bun run typecheck
bun run build
bun run smoke
bun test ./test/connector/herdr ./test/mcp/runtime.test.ts
python3 -B scripts/herdr/audit_methods.py --source-tree /absolute/path/to/pinned-herdr-source
```

静态方法矩阵可由固定官方源码和现有 `build()/audit()`确定性重建；policy 没有整文件生成器。
矩阵、policy 与[启动输入](../test/fixtures/herdr/0.9.5/agent-startup.json)、
[工作流输入](../test/fixtures/herdr/0.9.5/workflow.json)均已在库，用于静态/合成回归、离线结构校验和回放。
输入中的 capture、native 或 Store-verified provenance 声明尚未经独立原生验收，不能据此报告
真实管理、模型请求或同会话多轮成功。固定协议来源、摘要与许可证见
[provenance](../test/fixtures/herdr/0.9.5/provenance.json)和[许可证说明](../test/fixtures/herdr/0.9.5/LICENSE)。
独立原生与模型验收仍需在自有实例另行实测。
`scripts/herdr/verify-runtime.ts`只在显式提供自有 binary 和新报告路径时验收管理工作流；
其stdio宿主复用创建runtime时同一identities、localPolicies和原Herdr owner目录，遵循
[统一MCP契约](protocol/MCP-HTTP.md)。SDK枚举三页通用工具；自有私有目录中的`mcp-target.json`
只交付非秘密Target/revision/contract提示，目录与每次准入仍重新授权。调用使用绝对deadline，
原生响应经原结果句柄和不透明游标分页还原，保留完整原生error及其data。
可选 Agent/模型验收还需明确的 OpenCode binary、私有配置和 model，不继承用户凭据。
启动或 `interactive_ready`不证明模型调用；同会话两轮须独立关联 user/assistant 消息与回答。
局部组件、注释套件或构建通过均不能替代完整测试和实际宿主验收。

`verify-workspace-metadata.ts`是独立的自有 workspace 元数据验收入口。需提供固定官方版本的绝对
binary 路径，以及 checkout 外尚不存在的绝对报告路径；运行环境须允许在`/workspace`创建私有
临时目录。它经既有安装、Wire、Store与唯一发送账本核对TTL实际过期、seq保留、no-op和clear，
只在本次自有实例中创建合成workspace，不运行模型或继承用户会话。报告记录实际检查与清理结果；
下列命令是运行方法，不表示已完成原生验收。

```sh
bun --no-env-file scripts/herdr/verify-workspace-metadata.ts \
  --binary /absolute/verified/herdr \
  --report /tmp/rovloom-herdr-metadata-new.json
```

## 实现范围

Linux 原生基线不证明跨平台、商业 MCP Host、HTTP/OAuth 或真实双机已验收；
SDK 实证 revision 为 `2025-11-25`，Bun 的 `process.version` 只是 Node 兼容值。
223 方法中 144 个只有 generic params object，不能宣称完整参数校验。
原生接口与宿主接缝见 [原生校验](protocol/NATIVE-CONTRACT.md)，外层见
[Wire v2](protocol/WIRE-PROTOCOL.md)。产品设计、保留/恢复规则及 Herdr 门禁以
[DESIGN](DESIGN.md)、[issue 跟踪](https://github.com/ArnoChenFx/rovloom/issues)和 ADR 为准。

SQLite 使用 Bun 的 `node:sqlite`，当前规范 schema v6 要求全新库并拒绝未发布的旧库。
Store/Router 已提供 provider/binding、固定原文期限、`client_request_key` 去重、全局预算、降级与隔离快照；
本机管理接口与独立可信来源的接线边界见[存储运行指引](STORAGE.md)。测试使用临时 SQLite
文件、真实 SQLITE_FULL 与异常退出，不触及真实库。WSS/loopback 模块与独立宿主接线见
[通道接线](TRANSPORT.md)，测试证书另需 Linux `/usr/bin/openssl`。生产持久身份与跨平台普通文件已接入；
不提供重启后的原生响应上下文恢复。unknown 不重放，取消不代表回滚，逻辑删除不保证物理擦除。
Herdr 普通 RPC 已接唯一 CLI/HTTP MCP；首次配置向导、同会话两轮、原生跨平台及实际双机等剩余验收见 issue 跟踪，不以模块通过宣称全部交付。
