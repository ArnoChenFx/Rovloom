# 自更新模块与接线边界

`src/update/index.ts` 是可组合模块，没有第二个 CLI、角色服务、定时更新器或安装器。
`handleUpdateCommand(args, host)` 供 #8 的唯一 CLI 调用：返回数字为该命令退出码，
`undefined` 表示交还原 parser。宿主传入原 CLI 的版本常量、运行平台、libc 证明、`fetch` 和 stderr writer。Linux 必须明确传入 `libc: glibc`；可由受信 Bun `process.report.getReport().header.glibcVersionRuntime` 证明，缺失或 musl 拒绝，不能读环境变量猜测。
检查不读取安装路径、配置、数据库或 service 注册，不调用文件系统或执行器。
默认配置仍由原 CLI 维护为已验证 home 下的 `.config/rovloom/{gateway|connector}.json`。
本模块没有配置路径参数，也不改变 Gateway 持久 HTTP-only 方向。

## 当前行为

| 命令接缝 | 当前结果 |
| --- | --- |
| `update --check` | 只读官方最新稳定 Release、manifest 与有界 tag 提交元数据，报告 current、target、status；不下载二进制、不写文件 |
| `update`，相同版本 | `up_to_date`，退出 0，不下载 |
| `update`，当前新于官方版本 | `newer_than_release`，退出 0，不降级、不下载 |
| `update`，存在新版本 | 先报告版本；返回 `replacement_unavailable` / 5，不下载、不替换、不停服务 |
| `update --help` | 离线显示该接缝的用法和阻断边界 |
| URL、路径、force、脚本、其它参数 | `invalid_arguments` / 2，不请求网络 |

main 尚未合入唯一 CLI 及后台宿主；此表是模块行为，不能写成已可运行的产品命令。
本轮没有实现原地替换，也没有向命令接缝注入不安全的“下载即成功”回调。
缺少下文 service/runtime 事务前，`update` 的可用新版本路径始终返回非零。

退出码：0 完成检查或明确无更新；1 未分类宿主错误；2 参数/当前版本/平台错误；
3 网络/超时/元数据/大小/摘要错误；4 暂存权限/命名空间/锁/文件失败或 `staging_io_pending`；5 缺安全替换宿主。
原始响应、底层异常、签名 URL、用户路径和 argv 不进入公开错误信息。

## 发布契约协调

本模块已核对并保留已合入 main `b0d12b747cf815984bcb209ae08ccea537f4f1d5` 的[发布任务 PR63](https://github.com/ArnoChenFx/Rovloom/pull/63) 的 `scripts/release/metadata.mjs`、`platforms.json` 与封装测试。以下字段与该发布契约一致；六平台 runner 与工具链已由父任务独立审查，但当前仍只有 probe，不能当作已发布或全平台产品验收。
共享纯校验位于 `src/release/contract.ts`：`versionFromTag`、`assetName`、`validateReleaseManifest`。更新端与本 PR 中的发布 metadata 均使用：发布端导入版本/命名，并在 assemble 后调用清单校验，原重复规则已移除；原发布工作流和其它脚本保持 main 内容。不能让运行时导入会读磁盘平台文件的 metadata.mjs。
本轮所有 Release 响应和载荷来自注入 fetch 的合成样例，没有为测试创建 tag 或 Release。

- 唯一仓库：`ArnoChenFx/Rovloom`；固定 manifest 资产 `release-manifest.json`。
- 稳定 tag：`v<SemVer>`，manifest `version` 不含 `v`，必须逐字满足 `tag === 'v' + version`；默认更新拒绝预发行。版本禁止 `+build`、数字前导零及不安全整数；发布器可使用同一语法发布预发行。
- 未压缩单文件名：`rovloom-<version>-<os>-<arch>`，Windows 添加 `.exe`。
- 平台词汇：`linux`、`darwin`、`windows`；架构 `x64`、`arm64`。运行时 `win32` 归一为 `windows`。
  Linux 必须 `libc: glibc`，其它 OS 必须 `libc: null`。六个元组表示 parser 支持范围，不表示已发布或实机验收；只有 manifest 明确列出的资产才能下载。
- JSON 顶层字段恰为 `schemaVersion: 1`、`repository`、`tag`、`version`、`commit`、`bun`、`assets`。`commit` 必须为 40 位小写 SHA，`bun` 必须为 `1.4.3`；有界解引用官方 tag 必须落到该提交，循环、未知类型或不匹配拒绝。
- `assets` 为 1–6 项数组；每项字段恰为 `os`、`arch`、`libc`、`name`、`size`、`sha256`；平台不可重复。
  `size` 为 1–268435456 的整数字节数；`sha256` 为 64 位小写 hex。不得加入 URL、路径或命令字段。
- Release API 中 manifest 和所选 binary 必须各出现一次、状态 uploaded、大小与实际一致、下载地址等于本地构造的官方地址。
  manifest 上限 128 KiB，Release JSON 上限 1 MiB；缺平台资产明确失败，不回退其它架构或更早发行。

Release 来源固定为 `https://api.github.com/repos/ArnoChenFx/Rovloom/releases/latest`，
核对 `draft=false`、`prerelease=false` 和稳定 tag；另外只允许本仓库固定 git/ref/tags 与 git/tags API 路径核验 manifest.commit，附注 tag 最多解引用四层。它代表 GitHub 标记的最新稳定发行，
模块不会枚举或自行重新定义所有历史 Release 的排序。比较遵循同一规范 SemVer；
同核心版本的稳定发行可更新预发行，较低版本一律不下载。

官方资产地址由本地 tag 和名称构造。fetch 必须 `redirect: manual`、`credentials: omit`；
API 禁止跳转，资产只允许一次 HTTPS 跳往精确的 `release-assets.githubusercontent.com`，
拒绝凭据、非默认端口、fragment、其它主机及多跳。模块不提供替换仓库、镜像或 URL 的 CLI 参数。
每次 fetch、跳转、响应体读取和异步 consumer 共用最多 60 秒逻辑等待时限；流式检查总字节、Content-Length、清单大小及 SHA256，
不解压、不调用 shell、不执行下载内容。JSON 使用既有受预算解析器拒绝重复键（含转义后相同键）、损坏 UTF-8、BOM、不安全整数、超过 32 层或 50000 节点的结构。

**未签名的 checksum 只能证明清单与载荷的传输完整性，不能认证发布者，不能抵御仓库或发布凭据被攻陷。**
`SHA256SUMS` 由发布任务覆盖六个 binary 与 manifest；更新端使用同一 manifest 内的摘要，不把另一份未签名 checksum 当作独立信任根。
本模块没有签名/信任根实现，不得把 HTTPS 或 manifest 摘要称为该级别的认证。

## 独立下载与暂存

`downloadUpdate(network, plan, sink)` 重新核验计划，只有精确大小与 SHA256 都通过才返回 receipt。
sink 中的字节在返回前不可信；它必须属于能在失败时清理的隔离事务。
sink 签名为 `(chunk, signal) => Promise<void>`，取消会传播到该 signal；其 Promise 的完成必须代表全部相关副作用真实静止，不能只启动后台写入就提前完成。
`request_timeout` 使调用方有界返回，但不证明底层 syscall、适配器或线程已经停止；自定义 sink 的所有者须在真实 Promise 静止前保持其资源隔离，不能立即重用同一文件或释放更新锁。
`withStagedUpdate(root, network, plan, inspect, files?)` 提供这样的 Linux 暂存事务：

- root 必须已存在、为当前 UID 的私有真实目录、无符号链接，组/其他用户没有权限；
  祖先共享可写目录仅允许 sticky 目录。调用方须保证命名空间由可信账户管理；
  这不是针对同 UID 恶意程序或可改名祖先所有者的隔离机制，也不能代替安装路径/有效 ACL 验证。
- 一次 `mkdir` 获取固定根锁，冲突立即返回 `update_busy`；不按 PID、进程名或锁年龄删除未知锁。
  调用方选用的 root 必须在全部更新实例间一致；它不能替代 service 的跨角色注册锁。
- `mkdtemp` 自建私有子目录，`O_EXCL|O_NOFOLLOW` 创建 0600 候选文件；处理短写、fsync 和关闭。
  文件不可执行；inspect 仅在完整验证后取得临时候选路径及取消 signal，完成后候选会清理。
- 成功、网络失败、摘要失败、文件失败和 inspect 失败都会尝试关闭及精确清理自建文件/目录/锁，
  不递归删除其它内容。清理失败也非零，可能保留私有残余文件供人工检查；不能称为清理成功。
- 原生 I/O 与观察者每次逻辑等待也至多 60 秒（测试可收紧），并跟踪真实 Promise 的静止状态。
  pending write、fsync、open 或 cleanup 超时返回 `staging_io_pending` / 4；已取得或迟到取得的锁、私有目录和候选均隔离保留，不继续删除或允许下一实例复用。
  只有全部旧 I/O/consumer 真正静止后才按句柄、候选、子目录、锁的顺序尝试后台清理；迟到结果只更新原事务的所有权记录，不能二次删除新实例的锁。
  永久 pending 时后台清理与锁释放没有有限完成保证；进程崩溃后也不自动清旧锁。这是有界逻辑返回与隔离保证，不是 OS I/O 强退保证，不得凭超时/PID/锁年龄手动假定已静止。
- macOS/Windows 缺有效 ACL 证明接口，原生暂存明确拒绝。流式内存 sink 和计划测试可模型验证 Windows 元组，
  不表示 Windows 写盘或替换可用。

文件系统可注入以测试短写/权限/清理故障。暂存锁只控制该暂存事务；
本模块没有安装路径定位、chmod/chown/ACL 修改、sudo、可执行文件 rename 或服务操作。

## 原地替换所缺的 service/runtime 接口

PR61 当前是按角色的控制后端，不具备以下完整事务。必须由原 service/runtime 所有者提供，
不能复制系统后端、把 `uninstall` 当更新前置步骤，或声称已有接线：

1. **全局更新租约与已注册角色快照**：按可信安装身份取得安装级锁，同时与 gateway/connector 的注册操作互斥；
   核对每个角色的可执行路径、配置、账户、状态、bootEnabled 与 controlRetained。
   查询失败或同名异物不能视为无服务。固定 root、权限、运行时产品身份必须由宿主证明。
2. **停止与恢复会话**：只停止快照中使用该 binary 且原本运行的本项目实例，等待有界、可靠的静止证明；
   不按名字或任意 PID 杀进程。恢复精确的原角色与 boot/control 状态，失败保留恢复证据。
   不调用 install/uninstall 清空注册，不改配置、数据库、凭据、日志或任何用户数据。
3. **POSIX 替换事务**：验证真实可执行路径和全部祖先的所有权/权限/有效 ACL，明确处理符号链接，
   同文件系统私有暂存、原 mode/UID/GID 保持、可恢复旧版本、原子替换与目录持久化。
   先验证目标二进制的产品/版本/平台，再验证恢复后业务就绪，之后才允许清理旧版本。
   每一步失败必须回滚或明确报告未恢复状态；权限不足报错，不自动提权或修改 ACL。
4. **Windows 受控退出后替换宿主**：使用随产品审查的固定 helper/原生实现及可验证进程身份，
   等待当前 exe 句柄释放后执行受限文件事务，保留旧版、有效 ACL 和可恢复状态；
   新版验证失败恢复旧版及原服务。不能执行下载脚本、临时任意 PowerShell、按进程名/任意 PID 杀进程。
   父 CLI 何时返回成功、helper 如何报告失败/中断，必须有持久且可核验的交付协议。

在这些端口和实机验收完成前，不能添加一个不检查上述事实的 `apply()` 回调来放行产品 `update`。

### 最小端口建议与后续实施

以下是由父协调交给原 service/runtime 所有者的接线建议，**尚未实现**；本检查切片不等于用户的完整 `update` 已完成。

| 所有者 | 最小端口 | 必须提供的事实 |
| --- | --- | --- |
| service | `beginInstallationUpdate(verifiedInstallation, signal) -> lease` | 与该安装两个角色的注册和全部 lifecycle 操作互斥；opaque lease 与不可变原始角色快照，含 config/account 引用、运行态、bootEnabled、controlRetained |
| service lease | `quiesce(signal) -> receipt` | 仅停止快照中原本运行且使用该 binary 的本项目实例；可靠静止证明，无任意 PID/进程名输入 |
| service lease | `restoreOriginalState(verifiedBinary, signal) -> health` | 恢复原本运行的角色并核验版本/业务就绪；原 boot/control/config 状态保留，恢复失败保留可恢复记录 |
| service lease | `finish(committed | rolled_back)` | 只有旧/新版状态已核验才结束事务；未恢复或未静止时保留保护，不把注销注册当解锁 |
| runtime | `inspectInstallation(execPath) -> verifiedInstallation` | 真实文件身份、OS/arch/libc、路径/所有权/有效 ACL/符号链接策略及受保护状态根；不从不可信配置自报 |
| runtime | `verifyCandidate(path, expectedIdentity, signal) -> verifiedBinary` | 固定维护的产品版本/平台/启动探针，不能接受远端命令、脚本或 URL；逻辑取消和真实静止分别证明 |

按以下顺序继续落地，每段分别审查和验收，不以永久 stub 结束：

1. 审合本检查/下载/暂存切片，并在唯一 CLI 接入该窄 hook；原地更新继续明确拒绝。
2. 在上述租约上实现 POSIX 文件事务：可信目标路径与 ACL/符号链接策略、同盘私有候选、可恢复旧版、原子替换、目录持久化与失败回滚；保留旧版直到候选和原角色恢复就绪均通过。加入每阶段故障/崩溃恢复、双角色及并发注册测试，再分别进行 Linux 与 macOS 实装验证。
3. 实现随同产品构建并审查的 Windows 受控 helper：经受保护事务 ID、IPC/句柄与已验证父进程身份交付，不接受任意 PID；退出后按固定文件事务替换，持久报告成功/回滚/未恢复状态。完成 exe 占用、ACL、断电/中断、失败恢复和原服务状态的 Windows 实装验收后才开放该平台 `update` 成功路径。

## 验证范围 / Verification boundary

本地 Linux 实际执行的是合成数据的纯逻辑/网络模型，以及自有临时目录的权限、锁、写入、短写和失败清理。
没有下载或运行官方发行 binary，没有原地替换、系统服务停止、真实注册变更、sudo 或 ACL 修改。
六平台元组与 CDN 是注入模型；它们不构成 macOS、Windows 或 Linux 服务实装验收。
没有验证 Windows exe 占用/替换、macOS 签名/ACL、Unix 可执行所有权保留与原子回滚、服务重启后就绪。

English: this change delivers a read-only version check, a bounded official-source downloader, isolated Linux staging,
and a narrow hook for the existing CLI. In-place replacement is unavailable and fails with exit 5 when a newer
release exists. It does not update an actual installation or alter boot registration, services, configuration,
databases, or user data. Checksums provide integrity only. Cross-OS models are not native installation acceptance.
