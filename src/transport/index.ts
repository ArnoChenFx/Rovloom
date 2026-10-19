// 集中导出可组合的 transport、持久身份与专用交付接口，不提供默认授权或第二套 CLI。
export { createGateway } from './gateway.js'
export type { GatewayOptions, OriginalRead, OriginalReadResolver } from './gateway.js'
export type { TransportObserved, GatewayTransportSnapshot, GatewayTransportObservationSource } from './observation.js'
export { createConnector } from './connector.js'
export type {
  ConnectorOptions,
  NativeConnectorOptions,
  WireConnectorOptions,
  ConnectorWireSession,
  WireExecutionResult
} from './connector.js'
export type { IdentityHost, DeviceCredential } from './identity.js'
export { PairingAdmin } from './pairing.js'
export type { ManagementHost, ManagementAction } from './pairing.js'
export { loadCredential, saveCredential, createFileCredentialSink } from './credentials.js'
export type { Session, Connection, Readiness, Adapter } from './common.js'
export { IdentityStore } from './identity-store.js'
export type {
  IdentityStoreOptions,
  IdentityAuthorizer,
  IdentityApproval,
  IdentityIntent,
  IdentityUsage
} from './identity-store.js'
export { PersistentIdentity } from './persistent-identity.js'
export type { DeviceLedger, PersistentIdentityOptions } from './persistent-identity.js'
export { createPairingDelivery } from './custody.js'
export type {
  PairingBackend,
  CredentialSink,
  PairingRequest,
  CredentialDeliveryContext,
  CredentialDeliveryAck
} from './custody.js'
export { createStoreDeviceLedger, createStoreIdentityFacts } from './store-identity.js'
export type { IdentityLifecycleStore, StoreIdentityFacts, StoreIdentityBridges } from './store-identity.js'
export { PersistentProofIdentity } from './proof-identity.js'
export type { DeviceProofHost, VerifiedDeviceProof } from './proof-identity.js'
export { ChannelRegistry } from './channel-host.js'
export type { ChannelHost, SocketChannel } from './channel-host.js'
export { createDeviceLifecycleWiring, createDeviceLifecycleAdapter } from './lifecycle.js'
export type {
  DeviceLifecycleRequest,
  DeviceLifecycleVerifier,
  LifecycleStoreFactory,
  DeviceLifecycleWiring
} from './lifecycle.js'
export type { AdmissionRequest } from '../wire/admission.js'
export type { AuthenticatedAdmissionReceipt, AdmissionReceiptSink } from './admission-proof.js'
export { ConnectorAdmissionReceipts } from './admission-receipts.js'
export type { ConnectorAdmissionReceiptsOptions } from './admission-receipts.js'
export type { AdmissionContextReader, TrustedAdmissionSnapshot, AdmissionReceiptContext } from '../wire/admission.js'
