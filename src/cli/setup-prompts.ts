// 现有安装确认的展示文字；本地开关与批准状态继续由原配置和流程处理。

// Connector 明确展示本次用户配置的实际开关，不把已开启状态描述成关闭。
export function connectorNativePrompt(enabled: boolean | undefined): string {
  return enabled === true
    ? 'Discover Luvus and create isolated state (terminal execution ENABLED in user config)? / 发现 Luvus 并创建隔离状态（用户配置已开启终端执行）？'
    : 'Discover this Luvus installation and create its isolated local state (terminal execution disabled)? / 发现 Luvus 并创建隔离状态（关闭终端执行）？'
}

// Gateway 仅展示已核验的安装标签/摘要，本机批准不证明远端 Connector 的开关值。
export function gatewayNativePrompt(version: string, binarySha256: string): string {
  return (
    "Allow this paired device's measured Luvus (" +
    version +
    ', binary SHA-256 ' +
    binarySha256 +
    ") for reviewed workspace/Agent operations and one local MCP caller? Terminal execution is controlled by the Connector machine owner's local configuration. / 批准这台设备的实测 Luvus、普通窗口/Agent 操作及一个本机 MCP caller（终端执行由 Connector 本机所有者配置决定）？"
  )
}
