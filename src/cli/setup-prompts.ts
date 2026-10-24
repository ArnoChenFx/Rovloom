// 现有安装确认的展示文字；本地开关与批准状态继续由原配置和流程处理。

import { cliMessages, formatMessage, type CliLanguage } from './messages.js'

// Connector 明确展示本次用户配置的实际开关，不把已开启状态描述成关闭。
export function connectorNativePrompt(
  enabled: boolean | undefined,
  kind: 'Luvus' | 'Herdr' = 'Luvus',
  attach = false,
  language: CliLanguage = 'en'
): string {
  const messages = cliMessages(language)
  const key = attach
    ? enabled === true
      ? 'setup.prompt.connectorNativeAttachEnabled'
      : 'setup.prompt.connectorNativeAttachDisabled'
    : enabled === true
      ? 'setup.prompt.connectorNativeIsolatedEnabled'
      : 'setup.prompt.connectorNativeIsolatedDisabled'
  return formatMessage(messages[key], { kind })
}

// Gateway 仅展示已核验的安装标签/摘要，本机批准不证明远端 Connector 的开关值。
export function gatewayNativePrompt(version: string, binarySha256: string, language: CliLanguage = 'en'): string {
  return formatMessage(cliMessages(language)['setup.prompt.gatewayNative'], {
    version,
    sha: binarySha256
  })
}
