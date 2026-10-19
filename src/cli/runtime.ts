// 唯一CLI组合实际角色工厂；受保护身份、策略、凭据和native来源由宿主解析，不从argv补造。
import { createGatewayRuntime, createConnectorRuntime } from '../runtime/index.js'
import type { GatewayRuntimeOptions, ConnectorRuntimeOptions } from '../runtime/index.js'
import { RuntimeGatewayService } from '../mcp/runtime-service.js'
import type { GatewayCatalogProvider } from '../mcp/native-catalog.js'
import type { HttpAuthenticationProvider } from '../mcp/http.js'
import {
  StoreManagementWriteService,
  createManagementHandler,
  createManagementSessionAdapter,
  startManagementListener,
  type ManagementWriteOptions,
  type ManagementWriteHttpOptions,
  type ManagementSessionSource
} from '../admin/index.js'
import type { ConnectorConfig, GatewayConfig } from './config.js'
import type { CliRuntime, CliServiceHost } from './run.js'
import type { CliUpdateHost } from './update.js'

export type RuntimeCliManagement = Pick<ManagementWriteOptions, 'pairingPolicy' | 'providerEnable'> & {
  port: number
  // 只通知实际回环地址，不建立管理员身份、CSRF证明或执行许可。
  listening?(url: string): void
} & (
    | {
        // 直接消费现有受保护会话源；同一identities和实际Origin由唯一组合点绑定。
        session: { sessions: ManagementSessionSource; cookie_name: string }
        http?: Omit<ManagementWriteHttpOptions, 'service' | 'origin' | 'authenticate' | 'verifyCsrf'>
      }
    | {
        session?: never
        http: Omit<ManagementWriteHttpOptions, 'service' | 'origin'>
      }
  )
export type RuntimeCliHost = {
  gateway?(config: GatewayConfig): Promise<{
    options: GatewayRuntimeOptions
    authentication: HttpAuthenticationProvider
    catalog?: GatewayCatalogProvider
    management?: RuntimeCliManagement
  }>
  connector?(config: ConnectorConfig): Promise<ConnectorRuntimeOptions>
  service?: CliServiceHost
  update?: CliUpdateHost
}

// 只把可信资源交给已存在的角色工厂；Gateway监听设备通道，MCP listener继续由runCli唯一持有。
export function createRuntimeCliRuntime(host: RuntimeCliHost): CliRuntime {
  const runtime: CliRuntime = { service: host.service, update: host.update }
  if (host.gateway) {
    runtime.gateway = /* 先建立唯一常驻宿主，再装配MCP及独立管理面；失败时释放已交付资源。 */ async (config) => {
      const resource = await host.gateway!(config)
      const managementOptions = resource.management ? { ...resource.management } : undefined
      const gateway = await createGatewayRuntime(resource.options)
      let service: RuntimeGatewayService | undefined
      let management: ReturnType<typeof startManagementListener> | undefined
      let closing: Promise<void> | undefined
      const close = /* MCP由调用者先停；随后关闭管理listener、清理游标，最后释放设备通道及唯一writer。 */ () => {
        // 先同步封锁新MCP请求，不能在异步释放管理面/角色资源期间继续准入。
        service?.close()
        closing ??= Promise.resolve().then(
          /* 无论管理关闭是否失败，都必须回收真实Gateway资源。 */ async () => {
            try {
              management?.stop()
            } finally {
              await gateway.close()
            }
          }
        )
        return closing
      }
      try {
        service = new RuntimeGatewayService({
          runtime: gateway,
          identities: resource.options.identities,
          localPolicies: resource.options.localPolicies,
          catalog: resource.catalog,
          managementCapabilities: managementOptions
            ? /* 只观察已装配端口及当前持久状态，不在提示读取时执行启用证明或确认。 */ (target) => {
                const capabilities = ['devices_rename', 'devices_disconnect', 'devices_revoke'] as const
                const provider = target.provider_id
                  ? gateway.store.provider(target.machine_id, target.provider_id)
                  : undefined
                return provider && (provider.enabled || typeof managementOptions.providerEnable === 'function')
                  ? [...capabilities, 'providers_manage']
                  : capabilities
              }
            : undefined
        })
        if (managementOptions) {
          const options = managementOptions
          const writes = new StoreManagementWriteService({
            store: gateway.store,
            identities: resource.options.identities,
            reads: service.management,
            transport: gateway.transport,
            pairingPolicy: options.pairingPolicy,
            providerEnable: options.providerEnable
          })
          management = startManagementListener({
            port: options.port,
            maxRequestBodySize: 16_384,
            handler: /* 同一listener挂现行读写handler，不复制管理协议或创建默认session。 */ (origin) => {
              const authentication = options.session
                ? createManagementSessionAdapter({
                    ...options.session,
                    identities: resource.options.identities,
                    origin
                  })
                : options.http
              return createManagementHandler({
                ...options.http,
                authenticate: authentication.authenticate,
                verifyCsrf: authentication.verifyCsrf,
                service: writes,
                origin
              })
            }
          })
          options.listening?.(management.url)
        }
        return { service, authentication: resource.authentication, closed: gateway.closed, close }
      } catch (error) {
        await close()
        throw error
      }
    }
  }
  if (host.connector) {
    runtime.connector = /* 既有工厂接真实Wire/native session与持久claims，不使用第二份transport。 */ async (config) =>
      createConnectorRuntime(await host.connector!(config))
  }
  return runtime
}
