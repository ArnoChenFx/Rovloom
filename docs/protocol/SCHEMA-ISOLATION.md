# Luvus schema 硬预算执行边界

本模块为 [原生契约](NATIVE-CONTRACT.md)提供 Linux x64/glibc >= 2.34 的隔离编译工厂。
它运行同一份 Ajv2020 编译器和完整 bundle 预检，不替代来源认证、registry、分类、
调用授权或原生 endpoint 验证。Herdr 的独立编译入口尚未接入此工厂。

## 调用与资源归属

生产宿主从受保护构建配置提供 `assets_directory`，从已核验 registry 提供原始
bundle 字节及 `CompileOptions.identity`，调用
`compileBundleIsolated(bytes, options, { assets_directory })`。路径不能来自 Wire、
原生消息或 caller 参数；部署方须保护目录及其祖先，禁止非受信进程替换构建产物。
工厂核验产物清单、固定源码摘要与执行文件摘要；摘要检查不是下载来源认证。
未知平台、缺少 libc 原语或产物、摘要不符均返回 `schema_unavailable`，没有软限制回退。
同步 `compileBundle` 保留给已审核离线测试，不能用作生产失败回退。

返回的 `CompiledContract` 可直接交给 `createNativeValidator`、Luvus catalog 与现有
Wire adapter。所有候选、permit、stream 和仅响应上下文仍在宿主私有 WeakMap 中产生，
没有把跨进程 JSON 恢复成许可。安装/契约退役、宿主关闭时调用
`releaseCompiledContract(originalHandle)`；复制句柄不能释放或重建上下文。

每个编译上下文只接纳一个契约。全宿主至多四个上下文，超额拒绝；宿主须按生命周期
及时释放。正常释放/超时由不可被 JS 捕获的原生信号处理器先 SIGKILL 并 wait 回收校验子进程、
再 _exit 销毁编译父进程，宿主同步 wait4 回收；宿主异常死亡由 PDEATHSIG
终止编译器，编译器死亡同样终止其短命校验子进程。没有自动重启或从旧摘要恢复句柄。
进程失效后，派发、读取、保留、响应、stream 与仅响应入口都拒绝；清理入口仍可撤销
已有请求/响应登记。

## 硬限制与原文寿命

| 范围 | 执行限制 |
|---|---|
| 一次编译 | 宿主绝对 2 秒截止包含启动、校验构建产物及 IPC；原生进程从 JS 初始化前另设内核实时时限 2 秒 |
| 每次结构校验 | 宿主绝对 2 秒与原生内核 2 秒，进度不续期；超时整个旧编译上下文失效 |
| 每个原生进程 | JS 分配上限 64 MiB；初始化前设置 RLIMIT_AS 64 MiB，包含代码、C 分配、栈及 JS；RLIMIT_CORE 为 0 |
| IPC | 请求最长 8 MiB、响应最长 1 MiB，准确版本/递增序号/随机代次/契约身份绑定；只返回有限元数据与结构结论 |

64 MiB 是**每个原生进程**的地址空间及 JS 分配上限。每个上下文有一个仅存 schema 的
编译父进程，每次校验再分叉一个短命子进程；最多四个父进程及四个同时存活的校验子进程。
这不是整个宿主或进程组共用 64 MiB 的承诺，Bun 自身也不受该原生预算限制。

Ajv/JS VM 可能缓存上一次校验数据或错误。为使禁存请求不滞留于长期编译器，父进程只在
C 层接收有界帧，分叉后才把原生请求送入子 VM；父进程清零该帧缓冲，子进程在回复后立即
退出。长期 VM 始终只持有 schema。结果原文不从子 VM 返回，宿主仍按既有原文寿命清理
自身引用。`CompilerMetrics.spawn_peak_rss_bytes` 是 wait4 的保守计量，包含 posix_spawn
在 exec 前继承的 Bun 页；它不是原生 VM 峰值或 64 MiB 验收证明。测试直接核对自建
原生进程 `/proc` 的 limits、VmPeak、文件描述符与环境。

解释器未链接 QuickJS libc/std/os 模块，只暴露有界 IPC、随机代次与丢弃日志的 console。
不存在 schema 网络/文件加载器；URL 只是本地闭包索引。该边界控制资源和可用接口，
不声称同 UID 的原生引擎漏洞具备额外 OS 权限沙箱。

## 固定依赖与构建

- 保留 `ajv@8.20.0` 的完整 JSON Schema 2020-12 语义及现有预检，不手写裁剪执行子集。
  关闭生成代码的可选优化遍历以减少编译工作；不关闭 meta-schema 校验或任何已有约束。
- 使用 jsdom 的 [whatwg-url](https://github.com/jsdom/whatwg-url) 17.3.0 实现 WHATWG URL，
  使用 [@exodus/bytes](https://github.com/ExodusOSS/bytes) 1.16.0 的裸引擎 TextEncoder/Decoder
  与严格 UTF-8，实现来自已发布包；没有自行编写 URL/编码兼容层。
- [@noble/hashes](https://github.com/paulmillr/noble-hashes) 2.4.0 提供跨宿主相同 SHA-256，
  不因 QuickJS 缺少 Node crypto 改变契约摘要。
- [官方 QuickJS](https://github.com/bellard/quickjs) 固定到
  `84e723f1ace5e3823cef8149dd0f890fe74b77ce`（VERSION 2026-06-04），
  原始源码归档、MIT 许可证与摘要在 [来源清单](../../fixtures/toolchain/quickjs/provenance.json)。
  构建先核摘要，再拒绝路径穿越、链接及超额解包；不执行归档内脚本。

新增直接依赖均固定精确版本并锁定完整依赖图及 integrity。上述 JS 包和 QuickJS 为 MIT；
传递依赖及各自许可证保留在冻结安装中。成熟项目和版本锁不等同于无漏洞证明，更新仍须
重新审核源码/依赖图并执行完整正反例。Bun 的安装脚本保持禁用。
构建仅使用归档中的五个引擎 C 文件和受维护的 IPC driver，需 GCC、binutils、glibc
开发文件及 Python 3.12+，输出二进制、许可证和摘要清单到 `dist/native-contract/`。
相同工具链的两次干净构建须逐字节一致，验证器检查这一点；不承诺跨 GCC/glibc 的二进制一致。

`bun run test` 总是从当前源码重建执行器。`bun run test:isolated` 再以隔离契约回放完整
主测试，覆盖原有分类、raw、响应 data、流与迟到上下文；专门负例覆盖引用/方言、
未知协议版本、恶意编译增长、正则回溯、旧代次、真实内核限制、反复超时无后代残留及异常父死亡。
所有测试使用离线 fixture 或自建临时进程，不建立原生 endpoint，也不产生真实权限证据。
