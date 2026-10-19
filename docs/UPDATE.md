# 自更新模块与接线边界

`src/update/index.ts` 提供版本检查、受限下载、隔离暂存、受控 POSIX 原子更新事务和 Windows 固定 helper 事务接缝。
`handleUpdateCommand(args, host)` 供唯一 CLI 调用：返回数字为该命令退出码，
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
| `update`，存在新版本且配置 `PosixUpdater` | 核验安装与最新资产，下载/验证候选，静止已登记角色，原子替换并验证恢复；全部完成退出 0 |
| `update`，Windows 且配置 `WindowsUpdater` | 父端准备固定 helper，返回 `handoff_pending` / 4 与回执路径后退出；最终结果由 helper 实际退出码和持久回执确认 |
| `update`，缺事务宿主或 Windows helper | 先报告版本；返回 `replacement_unavailable` / 5，不下载、不替换、不停服务 |
| `update --help` | 离线显示该接缝的用法和阻断边界 |
| URL、路径、force、脚本、其它参数 | `invalid_arguments` / 2，不请求网络 |

此表描述模块接缝；产品命令仍需要唯一 CLI 与后台宿主装配。
POSIX 事务由 `createPosixUpdater({ executable, services, verifyRoleReady? })` 绑定已验证的安装路径和既有 `ServiceManager`，通过 `host.posixUpdater` 注入该唯一接缝；不接受裸 apply 回调或 argv 替换路径。
源代码 Bun 的 `process.execPath` 不能代表 Rovloom 安装；原程序必须通过固定产品版本探针。Windows helper 未配置时保持拒绝。下载或暂存成功不能作为升级完成的结果。

退出码：0 完成检查或明确无更新；1 未分类宿主错误；2 参数/当前版本/平台错误；
3 网络/元数据/大小/摘要/候选验证错误；4 权限、命名空间、锁、文件、清理或逻辑 I/O 等待失败；5 缺必要宿主/平台设施；6 已验证回滚到原版本和原服务运行态；7 恢复未能完成，旧版、记录与锁受到保护。
`update_io_pending` / 4 只表示调用方停止等待；真实事务可能在后台补偿或完成已提交清理，不能据此假定取消或失败已经完成。
原始响应、底层异常、签名 URL、用户路径和 argv 不进入公开错误信息。

## 发行资产契约

发行元数据由 `scripts/release/metadata.mjs` 按 `scripts/release/platforms.json` 的平台表生成。
发布器与更新端共用 `src/release/contract.ts` 中的 `versionFromTag`、`assetName` 和 `validateReleaseManifest`；
发布器在聚合资产后校验清单。运行时使用无 I/O 的共享校验模块，不导入会读取磁盘平台表的发行构建模块。
平台表和打包探针不表示资产已发布或产品已完成各平台验收；更新端只接纳官方 Release 明确列出的资产。

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
`SHA256SUMS` 由发行构建器覆盖六个 binary 与 manifest；更新端使用同一 manifest 内的摘要，不把另一份未签名 checksum 当作独立信任根。
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
- 原生 I/O 与观察者每次逻辑等待也至多 60 秒（可通过 timeoutMs 收紧），并跟踪真实 Promise 的静止状态。
  pending write、fsync、open 或 cleanup 超时返回 `staging_io_pending` / 4；已取得或迟到取得的锁、私有目录和候选均隔离保留，不继续删除或允许下一实例复用。
  只有全部旧 I/O/consumer 真正静止后才按句柄、候选、子目录、锁的顺序尝试后台清理；迟到结果只更新原事务的所有权记录，不能二次删除新实例的锁。
  永久 pending 时后台清理与锁释放没有有限完成保证；进程崩溃后也不自动清旧锁。这是有界逻辑返回与隔离保证，不是 OS I/O 强退保证，不得凭超时/PID/锁年龄手动假定已静止。
- macOS/Windows 缺有效 ACL 证明接口，原生暂存明确拒绝；这些平台的内存下载与计划处理不等于写盘或替换能力。

文件系统通过注入端口提供，适配器必须保留短写、权限及清理失败语义。此独立暂存锁只控制暂存事务；安装替换和服务协调由以下 POSIX 状态机负责。

## POSIX 原子更新事务

`PosixUpdater` 只支持当前本机 OS/arch，Linux 还需运行时 glibc 证明。可信宿主选定安装路径与既有服务管理器；存在原本运行的角色时，必须提供 `verifyRoleReady(spec, expectedVersion, signal)`，缺失时在停止或下载候选前拒绝。
业务探针必须证明该指定版本的实际角色就绪，不能以 supervisor running、固定 true 或版本字符串替代。

### 安装边界

- 拒绝非规范绝对路径、控制字符、任意符号链接、额外硬链接、非当前 UID 持有的目标、组/其它用户可写文件及 setuid/setgid/sticky 特殊模式。
- 校验叶文件与全部祖先的真实路径和权限，信任 root、文件系统根拥有者及当前 UID；共享可写祖先只允许管理员拥有的 sticky 目录。具有这些身份的恶意程序及不遵守锁的外部管理员不在隔离假设内，检测到其变更后仍不盲目覆盖。
- Linux 使用固定 `/bin/ls` 的 GNU 权限标记和 `/usr/sbin/getcap`，拒绝扩展 ACL、安全 context、能力等无法保持的叶访问元数据；工具缺失或查询失败明确非零，不安装依赖、不 sudo、不降低验证。
- macOS 复用 service 的完整祖先 ACL 检查；祖先 xattr 保持原样，需替换的叶文件带未知 xattr 时拒绝。不会修改既有 ACL。
- 原程序和候选均须为对应架构的 ELF64 或薄 Mach-O64；不执行 shebang/脚本。固定 `--version` 必须退出 0、stdout 为空、stderr 恰为 `Rovloom <version>\n`。
- 持有原程序和父目录句柄，以无损 inode/dev、UID/GID、mode、大小和 SHA256 核对身份；候选只设置为与原文件完全相同的 UID/GID/mode。每次破坏性替换前重新检查旧身份与访问边界。

GNU 扩展访问标记的语义依据 [GNU ls 文档](https://www.gnu.org/software/coreutils/manual/coreutils.html#What-information-is-listed)；无法识别的标记不能被忽略。

### 文件与服务状态机

1. 下载前和下载后、停止服务前分别重新核对官方最新稳定发行与所选 tag/commit/资产，拒绝缓存或篡改的计划。
2. 在同盘父目录独占创建固定安装锁，配合 `ServiceManager.withBinaryUpdate` 同时取得 gateway、connector 原角色锁。所有正常 install/uninstall/start/stop/restart 都与该范围互斥；只处理指向本安装的已登记角色。
3. 在私有 0700 事务目录中创建 0600 候选，验证原生头并通过持有句柄独立校验实际落盘大小/SHA256，通过后才执行产品版本检查；网络流摘要不能代替落盘摘要。保留旧程序硬链接 `previous`。恢复记录、事务目录及其父目录入口 fsync 完成后才允许停止或 rename。
4. 保持声明、自启、账户、配置和数据引用不变，复用受控后端停止角色并重新确认 PID/Job 静止。未识别注册或 starting/stopping/failed 初态拒绝；macOS 已加载但停止的 job，以及撤自启后仍在运行的 job，均无法等价恢复，亦在变更前拒绝。更新不通过偷偷 enable 绕过 disabled override。
5. 对旧句柄/路径、父目录和备份重新核验，在同一文件系统以 rename 原子替换并 fsync 父目录。只恢复原本运行的角色；保留原 boot/control 状态，分别验证监管稳定和指定版本的业务就绪。全部业务探针结束后再次核对每个原角色的运行/停止状态，探针后退出也会失败并进入回滚。
6. 最终产品版本和所有恢复证明通过、提交记录持久化后，才清理旧版、候选和记录，并精确释放自有 inode 的锁。清理失败仍非零，不能把已下载或已换文件当作完整成功。

角色恢复、候选或替换失败时，先使可能运行的新版角色静止，核对目标仍是已知原/候选 inode，再用旧版备份原子回滚、fsync、验证原版本并恢复原运行意图；成功回滚退出 6。
外部未知 inode 不会被覆盖。恢复失败退出 7，并保留旧版、恢复记录、安装锁和两个角色锁；真实 I/O 静止后显式关闭句柄，持久锁文件继续阻止误启动和并发注册。恢复保护错误不能被内层 close/lstat 清理错误覆盖，必须传到外层角色锁，使两个角色均保持阻断。

记录包含 phase、安装身份、旧/新版本、候选身份及原角色快照，只含配置和账户引用、不复制配置内容；文件为 0600，父目录为 0700。
阶段包括 backing_up、prepared、quiescing、quiesced、replacing、replaced、restoring、committed、rolling_back、rolled_back 和 recovery_required。
进程崩溃或未知旧锁不会通过 PID、年龄或进程名被自动清除；跨进程的自动崩溃恢复入口尚未提供，必须先独立证明旧副作用静止及记录/备份完整，不能盲目删锁。

### 期限与后台所有权

调用方逻辑总等待至多 180 秒，可由 `timeoutMs` 收紧；网络、consumer 和系统命令仍有各自更短期限。取消信号只阻止向前推进，回滚和原服务恢复使用独立安全路径。
`update_io_pending` / 4 返回后，真实事务仍受强所有权保护，安装和角色锁不会随 Promise 等待结束或垃圾回收而释放；只有真实 I/O 结算后才能补偿和清理。
`updater.settled()` 只观察已启动事务何时真正退出，不能强制解锁；永久 pending 没有有限物理完成保证。已进入持久恢复保护的事务通过锁文件保留阻断，不依赖泄漏的句柄保持互斥。

## 服务与运行时接口

| 组件 | 端口 | 职责 |
| --- | --- | --- |
| service | `withBinaryUpdate(executable, operation)` | 固定顺序同时取两个既有角色锁，冻结匹配本安装的 spec、运行态与 boot/control 状态；作用域外的 session 无效 |
| session | `quiesce()` / `assertQuiescent()` | 不注销或 enable/disable，复用既有后端停止本项目角色并逐次核验静止及原声明 |
| session | `restore(version, ready, signal?)` | 只恢复原本运行的角色，尝试恢复全部匹配角色，再汇总失败；分别核验监管与业务就绪 |
| runtime | `verifyRoleReady(spec, version, signal)` | 证明指定版本的真实角色就绪；Promise 静止前不得遗留未声明的副作用 |

`service install/uninstall` 仍只控制未来开机启动；更新不调用这两个操作清空或重建注册。
配置、数据库、凭据、日志和用户数据不属于事务删除或替换范围。

## Windows 固定 helper 事务

`createWindowsUpdater({ executable })` 只接受可信宿主选定的安装；执行时必须与内核报告的当前映像逐字相同。
唯一 CLI 在普通 parser 和角色启动之前调用 `handleWindowsUpdateHelperCommand(args, host)`，不匹配时返回 `undefined`；仅匹配固定隐藏命令且参数数量正确时才读取继承 stdin。该接缝不是第二 CLI，不接受路径、PID、URL、脚本或自定义 helper 参数。
helper host 提供既有 `ServiceManager`、官方网络适配器、真正的 `verifyRoleReady(spec, version, signal)` 和 stdin/stdout/诊断流。构造 manager 应无副作用；原生后端仍要求管理员权限、预先存在且受保护的 ServiceControl 目录及既有安装/运行时验证器，缺失时明确非零，不创建或修复 ACL。
未配置 `windowsUpdater` 的产品命令继续返回 5。接缝实现和隔离样例通过不代表唯一产品入口或真实 Task Scheduler 已验收。

### 父退出与结果语义

1. 父端先核验原生 PE、当前严格版本和原文件卷/ID/大小/SHA256/owner/group/DACL。在已核验父目录下新建私有事务目录，复制当前已安装程序为固定 `helper.exe` 并重新核验字节和权限；不会执行尚未验证的下载载荷。
2. 封存官方稳定版计划、父映像/出生时间、原文件身份及私有目录卷/ID/安全摘要。一次性 secret 只通过自有 stdin 交付，不进 argv、日志或持久 journal。本地 HMAC 只绑定本次 IPC 字节，不认证 GitHub 发行者。
3. helper 以 detached 子进程启动，自行从内核派生直接父对象并持有 QUERY_LIMITED_INFORMATION | SYNCHRONIZE 句柄；核对自身映像/字节和封存目录身份。固定安装锁由 helper 独占创建，既有 gateway、connector 锁也由同一 helper 固定顺序取得并持有到补偿结束，不转交锁或按 PID/锁年龄清锁。
4. helper 在持锁范围重新查询官方发行，下载自有候选、核对真实落盘大小/SHA256/PE/严格版本及最新发行，写入 prepared journal/回执后，才用本次 MAC 返回 ready。父端关闭其目录能力并写入固定 commit，报告 `handoff_pending` / 4、事务 ID、回执路径后退出；这个非零结果不是“更新成功”。
5. commit、stdin EOF、父端逻辑 exit 事件都不能授予替换许可。helper 最多等待内核父对象退出 30 秒，成功后再次复核最新发行、原文件和候选，才停止原角色并进入文件替换。安装、角色声明、自启、账户、配置和数据引用保持原样。

最终回执是私有事务目录内的 `receipt.json`，含 schemaVersion、transactionId、jobSha256、sequence、state、固定 code 与 exitCode。回执只能表示最后一次成功持久化的状态；若之后清理或回写失败，可能仍保留较早的回执，helper 的非零退出/诊断优先，不能仅凭旧回执断言它已经退出。中间态 exitCode 为 null，不能据此报告完成；`windowsReceiptExit` 对未验证替换态返回 7，其它待完成态返回 4。

| 最终状态 | helper 实际退出码 | 含义 |
| --- | --- | --- |
| updated | 0 | 文件、版本、原运行意图及真实角色就绪均已验证 |
| rolled_back | 6 | 已验证恢复旧文件、旧版本与原运行意图 |
| recovery_required | 7 | 未知目标或恢复失败；保留旧版、journal、安装锁与两个角色锁 |
| aborted | 1–5 | 替换前拒绝或失败；回执保存具体退出类别，不把通用待完成码冒充最终码 |
| cleanup_required | 4 | 已验证文件结果后仍存在清理问题，不能报告完整成功 |

### 文件、服务与失败边界

- 仅支持固定本机 NTFS 卷；拒绝 reparse、额外硬链接、所有 ADS（包括下载来源标记）、未知属性、不可信写权限和非对应架构 PE。持有祖先目录句柄；不修改既有安装或目录 ACL，不提权或回退 shell 下载脚本。
- 候选先复制原文件，其 owner/group/DACL 的严格摘要必须完全相同；再独占打开这个已知对象，仅截断/写入自有候选默认流。同步短写循环与 flush/close 完成后，独立重开核对实际大小、摘要、原生头和权限，通过后才执行候选 `--version`。
- 不使用会合并 ACE 的 ReplaceFileW，不忽略继承标志或新增显式 ACE。固定 preserve/install/reject/restore 仅使用同盘 MoveFileExW，拒绝覆盖、跨卷复制及重启延迟；每步前持久记录阶段。两个移动之间目标路径暂缺，不具备 POSIX 单次 rename 的原子可见性，也不宣称断电恢复。
- 复用 `withBinaryUpdate` 的快照、quiesce、assertQuiescent 和 restore。只恢复原本运行的角色，分开验证监管稳定与指定版本业务就绪，并在全部探针后重新检查原运行/停止状态；不调用 install/uninstall 或 enable/remove。
- 新版健康或文件步骤失败时，即使回滚记录写入失败也先尽力使每个可能运行的新版角色静止；单个角色停止失败不能跳过其它角色。记录写失败后不继续未记录的文件移动，保留恢复保护。随后再核对已知原/候选文件 ID、字节和权限，拒绝覆盖未知目标。已知候选移到 rejected，原 previous 移回原路径并验证旧版本和原角色；无法证明时保留恢复保护并退出 7。
- 总前进期限 180 秒；取消或逻辑超时不证明底层 syscall/回调已静止。helper 维持真实事务所有权，不因事件循环暂空以默认零退出；原生操作/探针未结算时，不能提前解锁。安全回滚用独立路径，不受前进取消中断。
- 成功或已验证回滚后释放自有安装/角色锁，保留本次目录中的备份、helper、journal 和最终回执。尚未实现自动修剪及跨进程崩溃恢复；未知残留锁不自动回收。保留记录不是配置/数据库副本，不删除用户数据。

### 验收范围

Windows x64/arm64 的自有临时 PE 验收覆盖实际父仍存活时不替换、内核父退出后替换、真实新旧版本进程、两角色恢复模型、健康失败回滚、未知目标保留旧版与全部锁，以及严格 owner/group/DACL、文件 ID、回执与实际 helper 退出码 0/6/7。测试只读打开自己启动的 helper，核对其映像/出生时间并等内核对象真正退出后才清理目录，不杀进程、不放宽清理重试。

Task Scheduler 监管、角色声明和 boot 状态在该样例中仍是模型；实际角色子进程、文件、父退出及 helper 退出码是原生验收。真实 Task Scheduler 生命周期、任意安装 ACL、SACL、断电/崩溃后恢复与唯一产品 CLI 接线尚未验收。SACL 不属于当前严格摘要的认证范围，不能据此宣称支持任意 Windows 安装；生产接线前须完成这些安装元数据及系统服务边界的验收。
Linux 上的模型、单文件打包与 Worker 探针不能代替以上原生验收；POSIX 的真实 systemd/launchd 生命周期亦尚未验收。
