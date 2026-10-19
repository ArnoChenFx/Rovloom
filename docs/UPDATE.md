# 自更新模块与接线边界

`src/update/index.ts` 是可组合模块，没有第二个 CLI、角色服务、定时更新器或安装器。
`handleUpdateCommand(args, host)` 供 #8 的唯一 CLI 调用：返回数字为该命令退出码，
`undefined` 表示交还原 parser。宿主传入原 CLI 的版本常量、运行平台、`fetch` 和 stderr writer。
检查不读取安装路径、配置、数据库或 service 注册，不调用文件系统或执行器。
默认配置仍由原 CLI 维护为已验证 home 下的 `.config/rovloom/{gateway|connector}.json`。
本模块没有配置路径参数，也不改变 Gateway 持久 HTTP-only 方向。

## 当前行为

| 命令接缝 | 当前结果 |
| --- | --- |
| `update --check` | 只读官方最新稳定 Release 元数据和 manifest，报告 current、target、status；不下载二进制、不写文件 |
| `update`，相同版本 | `up_to_date`，退出 0，不下载 |
| `update`，当前新于官方版本 | `newer_than_release`，退出 0，不降级、不下载 |
| `update`，存在新版本 | 先报告版本；返回 `replacement_unavailable` / 5，不下载、不替换、不停服务 |
| `update --help` | 离线显示该接缝的用法和阻断边界 |
| URL、路径、force、脚本、其它参数 | `invalid_arguments` / 2，不请求网络 |

main 尚未合入唯一 CLI 及后台宿主；此表是模块行为，不能写成已可运行的产品命令。
本轮没有实现原地替换，也没有向命令接缝注入不安全的“下载即成功”回调。
缺少下文 service/runtime 事务前，`update` 的可用新版本路径始终返回非零。

退出码：0 完成检查或明确无更新；1 未分类宿主错误；2 参数/当前版本/平台错误；
3 网络/超时/元数据/大小/摘要错误；4 暂存权限/命名空间/锁/文件失败；5 缺安全替换宿主。
原始响应、底层异常、签名 URL、用户路径和 argv 不进入公开错误信息。

## 发布契约协调

以下是本模块测试使用的**待发布任务确认的候选契约**，不是对现有远端资产的推测。
发布 workflow 由另一任务负责；确认后双方必须使用同一份契约再集成。
本轮所有 Release 响应和载荷来自注入 fetch 的合成样例，没有为测试创建 tag 或 Release。

- 唯一仓库：`ArnoChenFx/Rovloom`；固定 manifest 资产 `rovloom-update.json`。
- 稳定 tag：`v<SemVer>`，manifest `version` 不含 `v`，必须逐字满足 `tag === 'v' + version`；拒绝预发行。
- 未压缩单文件名：`rovloom-<os>-<arch>`，Windows 添加 `.exe`。
- 平台词汇：`linux`、`darwin`、`windows`；架构 `x64`、`arm64`。运行时 `win32` 归一为 `windows`。
  六个元组表示 parser 支持范围，不表示已发布或实机验收；只有 manifest 明确列出的资产才能下载。
- JSON 顶层字段恰为 `schemaVersion: 1`、`repository`、`tag`、`version`、`assets`。
- `assets` 为 1–6 项数组；每项字段恰为 `os`、`arch`、`name`、`size`、`sha256`；平台不可重复。
  `size` 为 1–268435456 的整数字节数；`sha256` 为 64 位小写 hex。不得加入 URL、路径或命令字段。
- Release API 中 manifest 和所选 binary 必须各出现一次、状态 uploaded、大小与实际一致、下载地址等于本地构造的官方地址。
  manifest 上限 128 KiB，Release JSON 上限 1 MiB；缺平台资产明确失败，不回退其它架构或更早发行。

仅访问固定 `https://api.github.com/repos/ArnoChenFx/Rovloom/releases/latest`，
核对 `draft=false`、`prerelease=false` 和稳定 tag。它代表 GitHub 标记的最新稳定发行，
模块不会枚举或自行重新定义所有历史 Release 的排序。比较遵循 SemVer，忽略构建元数据；
同核心版本的稳定发行可更新预发行，较低版本一律不下载。

官方资产地址由本地 tag 和名称构造。fetch 必须 `redirect: manual`、`credentials: omit`；
API 禁止跳转，资产只允许一次 HTTPS 跳往精确的 `release-assets.githubusercontent.com`，
拒绝凭据、非默认端口、fragment、其它主机及多跳。模块不提供替换仓库、镜像或 URL 的 CLI 参数。
每次请求与响应体共用最多 60 秒时限；流式检查总字节、Content-Length、清单大小及 SHA256，
不解压、不调用 shell、不执行下载内容。

**未签名的 checksum 只能证明清单与载荷的传输完整性，不能认证发布者，不能抵御仓库或发布凭据被攻陷。**
本模块没有签名/信任根实现，不得把 HTTPS 或 manifest 摘要称为该级别的认证。

## 独立下载与暂存

`downloadUpdate(network, plan, sink)` 重新核验计划，只有精确大小与 SHA256 都通过才返回 receipt。
sink 中的字节在返回前不可信；它必须属于能在失败时清理的隔离事务。
`withStagedUpdate(root, network, plan, inspect, files?)` 提供这样的 Linux 暂存事务：

- root 必须已存在、为当前 UID 的私有真实目录、无符号链接，组/其他用户没有权限；
  祖先共享可写目录仅允许 sticky 目录。调用方须保证命名空间由可信账户管理；
  这不是针对同 UID 恶意程序或可改名祖先所有者的隔离机制，也不能代替安装路径/有效 ACL 验证。
- 一次 `mkdir` 获取固定根锁，冲突立即返回 `update_busy`；不按 PID、进程名或锁年龄删除未知锁。
  调用方选用的 root 必须在全部更新实例间一致；它不能替代 service 的跨角色注册锁。
- `mkdtemp` 自建私有子目录，`O_EXCL|O_NOFOLLOW` 创建 0600 候选文件；处理短写、fsync 和关闭。
  文件不可执行；inspect 仅在完整验证后取得临时候选路径，返回后候选会清理。
- 成功、网络失败、摘要失败、文件失败和 inspect 失败都会尝试关闭及精确清理自建文件/目录/锁，
  不递归删除其它内容。清理失败也非零，可能保留私有残余文件供人工检查；不能称为清理成功。
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

## 验证范围 / Verification boundary

本地 Linux 实际执行的是合成数据的纯逻辑/网络模型，以及自有临时目录的权限、锁、写入、短写和失败清理。
没有下载或运行官方发行 binary，没有原地替换、系统服务停止、真实注册变更、sudo 或 ACL 修改。
六平台元组与 CDN 是注入模型；它们不构成 macOS、Windows 或 Linux 服务实装验收。
没有验证 Windows exe 占用/替换、macOS 签名/ACL、Unix 可执行所有权保留与原子回滚、服务重启后就绪。

English: this change delivers a read-only version check, a bounded official-source downloader, isolated Linux staging,
and a narrow hook for the existing CLI. In-place replacement is unavailable and fails with exit 5 when a newer
release exists. It does not update an actual installation or alter boot registration, services, configuration,
databases, or user data. Checksums provide integrity only. Cross-OS models are not native installation acceptance.
