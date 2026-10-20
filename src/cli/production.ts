// 唯一产品入口按固定role/ref加载真实资源；JSON不能重建opaque native来源或执行任意模块。
import { openGatewayState, createManagementSessionAuthority } from '../runtime/index.js'
import { X509Certificate } from 'node:crypto'
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
import { DEFAULT_LIMITS } from '../native-contract/index.js'
import { openCallerSource } from './caller-source.js'
import { readRuntimeFile, readRuntimeJson, runtimeReference } from './runtime-files.js'
import { createRuntimeCliRuntime } from './runtime.js'
import { readRuntimeConfig } from './runtime-config.js'
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
    capabilities: ['rpc', 'history_scope', 'admission_receipt', ...(context ? ['admission_context'] : [])],
    required: ['rpc', 'admission_receipt', ...(context ? ['admission_context'] : [])]
  }
}

/** 小配置只选择角色私有目录中的schema引用；原字节/pin仍由现有Luvus资源工厂核验。 */
function providerValue(directory: string, reference: string): unknown {
  const value = readRuntimeJson(runtimeReference(directory, reference))
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('kind' in value) ||
    value.kind !== 'luvus' ||
    !('authentication' in value) ||
    value.authentication !== 'remote_connector' ||
    !('contract' in value) ||
    !value.contract ||
    typeof value.contract !== 'object' ||
    Array.isArray(value.contract) ||
    !Object.hasOwn(value.contract, 'schema_bundle_ref')
  ) {
    return value
  }
  const contract = value.contract as Record<string, unknown>
  if (Object.hasOwn(contract, 'schema_bundle')) {
    throw new CliError('invalid_config')
  }
  const { schema_bundle_ref, ...pin } = contract
  const bytes = readRuntimeFile(runtimeReference(directory, schema_bundle_ref), DEFAULT_LIMITS.bundle_bytes)
  try {
    return {
      ...value,
      contract: { ...pin, schema_bundle: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
    }
  } catch {
    throw new CliError('invalid_config')
  } finally {
    bytes.fill(0)
  }
}

// provider配置只交给固定链接的真实来源resolver；没有resolver时不读取或宣称实例就绪。
function references(directory: string, refs: readonly string[]): readonly ProductionProviderReference[] {
  return Object.freeze(
    refs.map(
      /* 不解释native字段，不把普通JSON转换成来源、custody或派发许可。 */ (reference) =>
        Object.freeze({ reference, value: providerValue(directory, reference) })
    )
  )
}

// 默认Gateway可读取既有caller、TLS及唯一双库；配置了native引用却没有真实来源时明确不可用。
export function createProductionCliRuntime(sources: ProductionCliSources = {}) {
  return createRuntimeCliRuntime({
    gateway: /* 常规启动只打开已配置资源，不注册设备、签发enrollment/token或bootstrap管理cookie。 */ async (config) => {
      const settings = readRuntimeConfig(config)
      if (settings.provider_config_refs.length && !sources.gateway) {
        throw new CliError('backend_unavailable', 3)
      }
      if (sources.management && typeof sources.administrator !== 'function') {
        throw new CliError('backend_unavailable', 3)
      }
      if (settings.management_ref && (sources.management || sources.administrator || sources.authorizeIdentity)) {
        throw new CliError('invalid_config')
      }
      let protectedManagement: ReturnType<typeof openProtectedManagementSource> | undefined
      const hostname = config.mcp_hostname === '::1' ? '[::1]' : config.mcp_hostname
      const caller = openCallerSource(
        runtimeReference(config.state_dir, config.authentication_ref),
        new URL(`http://${hostname}:${config.mcp_port}/mcp`).href,
        settings.management_ref
          ? /* 管理来源须在下方完整校验后才可返回现有管理员，启动窗口不提供默认身份。 */ (caller, session) =>
              protectedManagement?.administrator(caller, session) ?? null
          : sources.administrator?.bind(sources)
      )
      let authority: ManagementSessionAuthority
      try {
        if (settings.management_ref) {
          protectedManagement = openProtectedManagementSource(config, settings.management_ref)
          if (protectedManagement.management.port === settings.device_listener.port) {
            throw new CliError('invalid_config')
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
        const certificate = readRuntimeFile(
          runtimeReference(config.state_dir, settings.device_listener.tls_ref, '.cert.pem'),
          65_536
        )
        const key = readRuntimeFile(
          runtimeReference(config.state_dir, settings.device_listener.tls_ref, '.key.pem'),
          65_536
        )
        const tls = { cert: certificate.toString('utf8'), key: key.toString('utf8') }
        certificate.fill(0)
        key.fill(0)
        provider = await sources.gateway?.(
          config,
          references(config.state_dir, settings.provider_config_refs),
          authority
        )
        if (sources.gateway && !provider) {
          throw new CliError('invalid_config')
        }
        if (
          provider &&
          (provider.providers.length !== settings.provider_config_refs.length ||
            new Set(
              provider.providers.map(/* 每个配置引用只能由其自身来源履行一次。 */ (entry) => entry.binding.config_ref)
            ).size !== settings.provider_config_refs.length ||
            provider.providers.some(
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
        const configuredManagement = protectedManagement?.management ?? sources.management
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
            tls,
            offer: offer(provider?.admission_context)
          },
          release
        }
        const common = {
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
    connector: /* 只把已有设备凭据和CA接到真实session所有者；缺provider实现绝不创建心跳stub。 */ async (config) => {
      const settings = readRuntimeConfig(config)
      if (!sources.connector) {
        throw new CliError('backend_unavailable', 3)
      }
      const caBytes = readRuntimeFile(runtimeReference(config.state_dir, settings.ca_ref, '.ca.pem'), 65_536)
      let ca: string
      try {
        ca = caBytes.toString('utf8')
        const pem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g
        const certificates = ca.match(pem)
        if (!certificates?.length || ca.replace(pem, '').trim()) {
          throw new CliError('invalid_config')
        }
        for (const certificate of certificates) {
          new X509Certificate(certificate)
        }
      } catch {
        throw new CliError('invalid_config')
      } finally {
        caBytes.fill(0)
      }
      const path = runtimeReference(config.state_dir, settings.credential_ref)
      const credential = /* 启动和每次认证均读取同一既有凭据，固定错误不反射路径或秘密。 */ () => {
        try {
          return loadCredential(path)
        } catch {
          throw new CliError('backend_unavailable', 3)
        }
      }
      // 先验证静态认证输入，缺失或非法时不得启动provider所属的native child。
      credential()
      const resource = await sources.connector(config, references(config.state_dir, settings.provider_config_refs))
      try {
        // 资源准备可能跨异步边界；期间撤去凭据也必须立即释放本次资源并退出。
        credential()
        const transport = {
          ca,
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
