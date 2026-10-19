// 在严格编译中固定CLI宿主的Wire/原生执行互斥与真实resolver边界，不启动网络或原生进程。
import type { ConnectorTransportResources, GatewayTransportPorts, TransportCliHost } from '../../src/cli/index.js'
import type {
  ConnectorWireSession,
  NativeConnectorOptions,
  OriginalReadResolver,
  WireConnectorOptions
} from '../../src/transport/index.js'

// 只供独立类型检查执行正反契约；运行时不会调用这些宿主或创建任何凭据。
export function cliTransportTypeChecks(
  native: Omit<NativeConnectorOptions, 'url'>,
  wire: Omit<WireConnectorOptions, 'url'>,
  session: ConnectorWireSession,
  ports: GatewayTransportPorts
) {
  const nativeResources: ConnectorTransportResources = {
    transport: native,
    close: /* 编译fixture不持有运行资源。 */ async () => {}
  }
  const wireResources: ConnectorTransportResources = {
    transport: wire,
    close: /* 编译fixture不持有运行资源。 */ async () => {}
  }
  const mixed = {
    ...native,
    session: /* 此负例混合原生回调与Wire会话，必须在宿主类型处拒绝。 */ () => session
  }
  const mixedResources: ConnectorTransportResources = {
    // @ts-expect-error CLI组合必须保留底层两种执行模式的互斥约束。
    transport: mixed,
    close: /* 编译负例不持有运行资源。 */ async () => {}
  }
  const host: TransportCliHost = {
    connector: /* 受信宿主可直接返回真实Wire模式，无需伪造nativeInput或execute。 */ async () => wireResources
  }
  const resolver: OriginalReadResolver = ports.resolveOriginalRead
  return { nativeResources, wireResources, mixedResources, host, resolver }
}
