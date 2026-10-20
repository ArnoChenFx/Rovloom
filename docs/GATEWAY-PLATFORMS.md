# Gateway 私有文件平台边界

纯 Gateway 的角色配置、managed JSON 和 SQLite 账本共用私有文件层。Linux/macOS
实现已接入正式配置/启动入口；macOS 支持验收以独立
[Gateway private platforms](../.github/workflows/gateway-platforms.yml) 原生任务为准，
不能由 Linux 测试结果推导。此页不声明 Connector 原生进程或开机服务的跨平台可用性。

POSIX 文件要求当前 UID、普通文件、单硬链接和私有权限。运行状态和账本要求文件
`0600`、直接父目录 `0700`；只读角色文件允许所有者收紧写权限。祖先不能是软链接。
有界读取在同一 fd 上检查实际权限和对象身份，并在读取后核对大小及修改时间。
新文件先检查实际 fd 权限再写入正文。首次角色配置保留排他临时文件、fsync、原子
link 发布和并发获胜者重新校验；已有对象权限不足时拒绝，不自动 chmod 或改 ACL。

macOS 通过固定系统库的 `acl_get_fd_np` 检查实际 fd 的扩展 ACL。私有叶拒绝非零
扩展 allow；祖先只接受已知且不授予写入、删除、改权限的 allow。deny 不被解释成
可以抵消不安全 allow 的证明。未知 tag/权限位、ACL 读取失败或超预算均拒绝。
使用的 ABI 和返回值依据 Apple 的
[acl_entry.c](https://github.com/apple-oss-distributions/Libc/blob/main/posix1e/acl_entry.c)
及 [sys/acl.h](https://github.com/apple-oss-distributions/Libc/blob/main/include/sys/acl.h)。
这是一条保守边界；已有共享目录或额外授权不会被自动修复。

独立原生任务在 Linux/macOS x64/arm64 上构建实际单文件产品，运行私有文件、
Darwin 实际 ACL 负例、锁和 unknown 不重派回归，再启动未配对 Gateway 两次，
核对双库持久化、MCP 401 及正常关闭。全部数据在任务自有临时目录，只使用合成账本，
不签发生产身份、不连接原生用户会话、不调用模型。

Windows 仍返回平台不支持。已经有私有数据 ACL 纯判定及测试：
`src/storage/windows-private-acl.ts`；它拒绝安装器可以接受的外部只读授权，要求当前
SID 所有权、受保护 DACL，以及 SQLite journal 需要的文件/目录继承权限。
此判定尚未代替实际原生文件读取，不能据此宣称 Windows Gateway 可用。

Windows 后续接线需要保留以下真实对象证据：

- 复用 `windowsCurrentSid`、`windowsPrivateAttributes` 和同句柄
  `inspectWindowsFileSecurity`，补充受保护 DACL 和 ACE 继承标志读取；不能只复用
  安装器防篡改判定，因为私有正文还需要保密。
- 在 NTFS 的实际句柄上拒绝 reparse point、附加数据流、多硬链接及路径身份变化，
  同句柄有界读取并核对 file ID；新建时直接应用私有安全描述符。
- 排他创建临时文件后实际 flush，以不覆盖的原生 rename 发布，保留并发获胜者校验；
  不能使用 Node 的 mode 位或将文件写入返回当作持久完成。
- SQLite 存活期间持有不共享删除的祖先/数据库 lease，并验证 journal 继承边界；
  数据库关闭后再释放 lease 与自有锁。保留派发前持久化、崩溃锁和 unknown 不重派。
- Windows x64/arm64 原生任务对真实单文件 CLI、双库、ACL/reparse/替换负例验收通过后，
  才能解除现有平台拒绝。不能扩大原生 Connector Owner 的 Linux 进程身份边界。
