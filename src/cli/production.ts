// 唯一产品入口按固定role/ref加载真实资源；JSON不能重建opaque native来源或执行任意模块。
import { privateDirectory } from './first-config.js'
import { join } from 'node:path'
import { openGatewayState, createManagementSessionAuthority } from '../runtime/index.js'
import type {
  GatewayRuntimeOptions,
  ProviderGatewayRuntimeOptions,
  ManagementSessionAuthority,
  GatewayStateOptions
} from '../runtime/index.js'
import type { VersionOffer } from '../wire/types.js'
import type { GatewayIdentitySource } from '../mcp/management.js'
import type { ManagementWriteHttpOptions } from '../admin/index.js'
import { loadCredential } from '../transport/index.js'
import { CliError, type ConnectorConfig, type GatewayConfig } from './config.js'
import { openCallerSource } from './caller-source.js'
import { readRuntimeJson, runtimeReference } from './runtime-files.js'
import { createRuntimeCliRuntime } from './runtime.js'
import { readRuntimeConfig } from './runtime-config.js'
import { loadProductManagementAssets } from './management-assets.js'
import { openProtectedManagementSource } from './management-source.js'
import {
  createManagementPageInitializer,
  MANAGEMENT_COOKIE_NAME,
  type ManagementPageLeaseSource
} from './management-page.js'
import type {
  RuntimeCliGatewayResources,
  RuntimeCliGateway,
  RuntimeCliManagement,
  RuntimeCliConnectorResources,
  RuntimeCliProviderResources
} from './runtime.js'

export type ProductionProviderReference = Readonly<{ reference: string; value: unknown }>
export type ProductionGatewayManagement = Omit<RuntimeCliManagement, 'session' | 'http'> & {
  http?: Pick<ManagementWriteHttpOptions, 'assets' | 'publicError'>
}
export type ProductionManagementHost = ProductionGatewayManagement & {
  // 必须验证这一个Request的既有受保护管理员会话；null交付无秘密的只读页面。
  resolveLease: ManagementPageLeaseSource
  bootstrap_challenge?: 'basic'
}
type ProductionGatewayCommon = Pick<RuntimeCliGatewayResources, 'catalog'> & {
  // 需要原caller/锚点的provider显式启用现行协商能力，不复制receipt或ledger实现。
  admission_context?: true
  management?: ProductionGatewayManagement
  started?(gateway: RuntimeCliGateway): void
  release(): Promise<void>
}
export type ProductionGatewayResources = ProductionGatewayCommon &
  (
    | { kind?: 'luvus'; providers: GatewayRuntimeOptions['providers'] }
    | {
        kind: 'mixed'
        providers: GatewayRuntimeOptions['providers']
        hosted: NonNullable<GatewayRuntimeOptions['hosted']>
      }
    | {
        kind: 'provider'
        providers: ProviderGatewayRuntimeOptions['providers']
        session: ProviderGatewayRuntimeOptions['session']
      }
  )
export type ProductionConnectorResources = { admission_context?: true } & (
  | Omit<RuntimeCliConnectorResources, 'transport'>
  | Omit<RuntimeCliProviderResources, 'transport'>
)
export type ProductionCliSources = {
  // 现有管理员、一次性身份批准仍须独立交付；默认值明确拒绝，不从MCP token升级。
  administrator?: GatewayIdentitySource['administrator']
  // 只允许静态受信宿主注入，不接入argv、URL或JSON配置。
  management?: ProductionManagementHost
  authorizeIdentity?: GatewayStateOptions['authorizeIdentity']
  gateway?(
    config: GatewayConfig,
    references: readonly ProductionProviderReference[],
    authority: ManagementSessionAuthority
  ): Promise<ProductionGatewayResources>
  connector?(
    config: ConnectorConfig,
    references: readonly ProductionProviderReference[]
  ): Promise<ProductionConnectorResources>
}

// 只组合已有Wire协商声明；各provider的真实接收端和持久原截止仍由其session交付。
function offer(context: true | undefined): VersionOffer {
  return {
    major: 2,
    minor: 0,
    capabilities: [
      'rpc',
      'dispatch_refusal',
      'history_scope',
      'admission_receipt',
      ...(context ? ['admission_context'] : [])
    ],
    required: ['rpc', 'admission_receipt', ...(context ? ['admission_context'] : [])]
  }
}

// 未配对的本地Gateway可以真实监听，但不授予任何MCP身份、管理员或原生权限。
function unpairedCaller() {
  return {
    setupRequired: true,
    identities: {
      principal: /* 未配对没有caller身份。 */ () => null,
      administrator: /* 未配对没有管理员。 */ () => null
    } as GatewayIdentitySource,
    authentication: { authenticate: /* 拒绝全部未建立的Bearer身份。 */ () => null },
    localPolicies: /* 没有设备或原生授权。 */ () => ({ revision: 'unpaired', grants: [] }),
    /* 无外部身份源需要释放。 */
    close() {}
  }
}

// 身份状态缺失表示首次待配对；损坏或权限错误仍拒绝，不采用默认账号或测试凭据兜底。
function managedCaller(config: GatewayConfig, administrator?: GatewayIdentitySource['administrator']) {
  const path = runtimeReference(config.state_dir, 'mcp-callers')
  try {
    readRuntimeJson(path)
  } catch (error) {
    if (error instanceof CliError && error.code === 'backend_unavailable') {
      return unpairedCaller()
    }
    throw error
  }
  const hostname = config.mcp_hostname === '::1' ? '[::1]' : config.mcp_hostname
  return { ...openCallerSource(path, `http://${hostname}:${config.mcp_port}/mcp`, administrator), setupRequired: false }
}

// 默认Gateway打开真实双库并可等待首次配对；程序管理的provider仍由固定工厂核验。
export function createProductionCliRuntime(sources: ProductionCliSources = {}) {
  return createRuntimeCliRuntime({
    gateway: /* 常规启动只打开已配置资源，不注册设备、签发enrollment/token或bootstrap管理cookie。 */ async (config) => {
      privateDirectory(config.state_dir)
      privateDirectory(join(config.state_dir, 'managed'))
      const settings = readRuntimeConfig(config)
      if (settings.provider_config_refs.length && !sources.gateway) {
        throw new CliError('backend_unavailable', 3)
      }
      if (sources.management && typeof sources.administrator !== 'function') {
        throw new CliError('backend_unavailable', 3)
      }
      let protectedManagement: ReturnType<typeof openProtectedManagementSource> | undefined
      const caller = managedCaller(
        config,
        /* 逐次询问原独立管理来源，不从MCP提升权限。 */ (who, session) =>
          protectedManagement?.administrator(who, session) ?? sources.administrator?.(who, session) ?? null
      )

      let authority: ManagementSessionAuthority
      try {
        if (config.management_enabled && !sources.management) {
          try {
            readRuntimeJson(runtimeReference(config.state_dir, 'management'))
            protectedManagement = openProtectedManagementSource(config, 'management')
            if (protectedManagement.management.port !== config.management_port) {
              throw new CliError('invalid_config')
            }
          } catch (error) {
            if (!(error instanceof CliError) || error.code !== 'backend_unavailable') {
              throw error
            }
          }
        }
        authority = createManagementSessionAuthority(caller.identities)
        protectedManagement?.bindAuthority(authority)
      } catch (error) {
        protectedManagement?.close()
        caller.close()
        throw error
      }
      let provider: ProductionGatewayResources | undefined
      let state: ReturnType<typeof openGatewayState> | undefined
      let closing: Promise<void> | undefined
      const release = /* 关闭所有交付者并最终回收同一双库；不因某个provider释放失败遗留writer。 */ () => {
        closing ??= Promise.resolve().then(
          /* shutdown始终撤去会话和caller来源，外部provider仍须报告其真实物理释放结果。 */ async () => {
            try {
              await provider?.release()
            } finally {
              authority.close()
              protectedManagement?.close()
              caller.close()
              state?.close()
            }
          }
        )
        return closing
      }
      try {
        provider = await sources.gateway?.(config, settings.providers, authority)
        if (sources.gateway && !provider) {
          throw new CliError('invalid_config')
        }
        // 核对所有原条目，但不把中性provider放入Luvus原生注册表或丢弃其session。
        const declared = provider
          ? [
              ...provider.providers,
              ...(provider.kind === 'mixed'
                ? provider.hosted.flatMap(
                    /** 仅收集原宿主的完整条目供引用校验，运行时仍保留明确分组。 */ (group) => group.providers
                  )
                : [])
            ]
          : []
        if (
          provider &&
          (declared.length !== settings.provider_config_refs.length ||
            new Set(declared.map(/* 每个配置引用只能由其自身来源履行一次。 */ (entry) => entry.binding.config_ref))
              .size !== settings.provider_config_refs.length ||
            declared.some(
              /* 实际来源仍须逐个属于配置选择，受信resolver也不能附带未声明provider。 */ (entry) =>
                !settings.provider_config_refs.includes(entry.binding.config_ref)
            ))
        ) {
          throw new CliError('invalid_config')
        }
        let gateway: RuntimeCliGateway | undefined
        state = openGatewayState({
          state_directory: config.state_dir,
          identity_reservation: { security_bytes: 1_048_576, audit_bytes: 4_194_304, file_bytes: 8_388_608 },
          authorizeIdentity:
            protectedManagement?.authorizeIdentity ??
            sources.authorizeIdentity ??
            /* 缺独立动作级批准时不提供默认身份变更。 */ (() => {
              throw new CliError('backend_unavailable', 3)
            }),
          changed: /* 只在身份提交后断开同一runtime的设备通道，正常启动不调用它。 */ (machine) => {
            if (!gateway) {
              throw new CliError('backend_unavailable', 3)
            }
            gateway.transport.disconnect(machine)
          }
        })
        const anonymousManagement: ProductionManagementHost | undefined =
          config.management_enabled && !protectedManagement && !sources.management
            ? {
                port: config.management_port,
                resolveLease: /* 匿名页面不创建管理员会话。 */ async () => null,
                http: { assets: loadProductManagementAssets() }
              }
            : undefined
        const configuredManagement = protectedManagement?.management ?? sources.management ?? anonymousManagement
        if (configuredManagement && provider?.management) {
          throw new CliError('invalid_config')
        }
        const managementHost = configuredManagement ?? provider?.management
        const management = managementHost
          ? {
              port: managementHost.port,
              listening: managementHost.listening?.bind(managementHost),
              pairingPolicy: managementHost.pairingPolicy?.bind(managementHost),
              providerEnable: managementHost.providerEnable?.bind(managementHost),
              http: {
                assets: managementHost.http?.assets,
                publicError: managementHost.http?.publicError?.bind(managementHost.http),
                initializePage: configuredManagement
                  ? createManagementPageInitializer(
                      authority,
                      configuredManagement.resolveLease.bind(configuredManagement),
                      {
                        challenge: configuredManagement.bootstrap_challenge
                      }
                    )
                  : undefined
              },
              session: { sessions: authority.sessions, cookie_name: MANAGEMENT_COOKIE_NAME, authority }
            }
          : undefined
        const options = {
          lifecycle: state.lifecycle,
          channels: state.channels,
          identities: authority.identities,
          localPolicies: caller.localPolicies,
          listener: {
            hostname: settings.device_listener.hostname,
            port: settings.device_listener.port,
            offer: offer(provider?.admission_context)
          },
          release
        }
        const common = {
          setupRequired: caller.setupRequired,
          authentication: caller.authentication,
          catalog: provider?.catalog,
          management,
          started: /* 绑定唯一已建立runtime，不在配置中记录端口对象或派发许可。 */ (active: RuntimeCliGateway) => {
            gateway = active
            provider?.started?.(active)
          }
        }
        if (provider?.kind === 'provider') {
          return {
            ...common,
            kind: 'provider' as const,
            options: { ...options, providers: provider.providers, session: provider.session.bind(provider) }
          }
        }
        return {
          ...common,
          options: {
            ...options,
            providers: provider?.providers ?? [],
            ...(provider?.kind === 'mixed' ? { hosted: provider.hosted } : {})
          }
        }
      } catch (error) {
        await release()
        throw error
      }
    },
    connector: /* 只把程序保管的设备凭据接到真实session所有者；缺provider实现绝不创建心跳stub。 */ async (config) => {
      privateDirectory(config.state_dir)
      privateDirectory(join(config.state_dir, 'managed'))
      const settings = readRuntimeConfig(config)
      if (!sources.connector) {
        throw new CliError('backend_unavailable', 3)
      }
      if (!config.gateway_url || settings.providers.length === 0) {
        throw new CliError('configuration_required')
      }
      const path = runtimeReference(config.state_dir, settings.credential_ref)
      const credential = /* 启动和每次认证均读取同一既有凭据，固定错误不反射路径或秘密。 */ () => {
        try {
          return loadCredential(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new CliError('configuration_required')
          }
          throw new CliError('backend_unavailable', 3)
        }
      }
      // 先验证静态认证输入，缺失或非法时不得启动provider所属的native child。
      credential()
      const resource = await sources.connector(config, settings.providers)
      try {
        // 资源准备可能跨异步边界；期间撤去凭据也必须立即释放本次资源并退出。
        credential()
        const transport = {
          credential,
          offer: offer(resource.admission_context)
        }
        if (resource.kind === 'provider') {
          return {
            kind: 'provider' as const,
            transport,
            session: resource.session.bind(resource),
            release: resource.release.bind(resource),
            release_timeout_ms: resource.release_timeout_ms,
            provider_snapshot: resource.provider_snapshot
          }
        }
        return {
          transport,
          ...(resource.provider_snapshot === true ? { provider_snapshot: true as const } : {}),
          session: resource.session.bind(resource),
          release: resource.release.bind(resource)
        }
      } catch (error) {
        await resource.release()
        throw error
      }
    }
  })
}
