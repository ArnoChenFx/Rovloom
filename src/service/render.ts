// 为三种原生开机设施生成声明，分别处理 unit、plist/XML 与 Windows argv 的转义。
import { launchArguments, manifest, serviceName } from './spec.js'
import type { ServiceSpec } from './types.js'

// systemd 参数逐项引用并转义反斜杠和 specifier；ExecStart 的冒号前缀统一禁用环境展开。
export function unitQuote(value: string): string {
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"'
}

// XML 文本只编码标记字符，不拼接 shell 或 PowerShell 表达式。
export function xmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

// 按 Windows CRT 的引号与反斜杠规则编码单个参数，尾部反斜杠也必须翻倍。
export function windowsQuote(value: string): string {
  return '"' + value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1') + '"'
}

// 输出 systemd 系统 unit；enable 关联 multi-user.target，安装本身不启动。
export function renderSystemd(spec: ServiceSpec): string {
  return `# ${manifest(spec)}
[Unit]
Description=Rovloom ${spec.role}
After=network.target

[Service]
Type=exec
User=${spec.account}
WorkingDirectory=${spec.directory.replaceAll('%', '%%')}
ExecStart=:${[spec.executable, ...launchArguments(spec)].map(unitQuote).join(' ')}
Restart=no
TimeoutStartSec=30
TimeoutStopSec=30
KillMode=control-group
KillSignal=SIGTERM
StandardInput=null
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`
}

// 输出系统域 LaunchDaemon；不用 KeepAlive，bootout 后不会自动重拉实例。
export function renderLaunchd(spec: ServiceSpec): string {
  const args = [spec.executable, ...launchArguments(spec)]
    .map(/* 每个数组元素独立保留 argv 边界。 */ (a) => `<string>${xmlText(a)}</string>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${manifest(spec)} -->
<plist version="1.0"><dict>
<key>Label</key><string>${serviceName(spec.role, 'darwin')}</string>
<key>ProgramArguments</key><array>${args}</array>
<key>UserName</key><string>${xmlText(spec.account)}</string>
<key>WorkingDirectory</key><string>${xmlText(spec.directory)}</string>
<key>StandardInPath</key><string>/dev/null</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>ExitTimeOut</key><integer>30</integer>
</dict></plist>
`
}

// 输出既有用户的BootTrigger任务；S4U无需保存密码或等待登录，配置始终使用安装时固定路径。
export function renderTask(spec: ServiceSpec): string {
  const args = launchArguments(spec).map(windowsQuote).join(' ')
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>${manifest(spec)}</Description></RegistrationInfo>
<Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>
<Principals><Principal id="Service"><UserId>${xmlText(spec.account)}</UserId><LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>false</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><RunOnlyIfIdle>false</RunOnlyIfIdle><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
<Actions Context="Service"><Exec><Command>${xmlText(spec.executable)}</Command><Arguments>${xmlText(args)}</Arguments><WorkingDirectory>${xmlText(spec.directory)}</WorkingDirectory></Exec></Actions>
</Task>
`
}

// 依据已验证的平台选择唯一原生格式。
export function renderDefinition(spec: ServiceSpec): string {
  if (spec.platform === 'linux') {
    return renderSystemd(spec)
  }
  return spec.platform === 'darwin' ? renderLaunchd(spec) : renderTask(spec)
}
