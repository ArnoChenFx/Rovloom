/** 将固定安装 schema、内核 peer 与受监管进程合为不可序列化的本机来源，不负责启动宿主。 */
import type { NativePeer } from '../local/linux-peer.js'
import { boundedJson, contractRef } from '../../wire/index.js'
import type { AttemptBinding, JsonObject } from '../../wire/types.js'
import { compileHerdrSchemas } from './compiler-api.js'
import { checkHerdrSignal, herdrDeadline, runHerdrCommand, withHerdrSocket } from './io.js'
import {
  HerdrLocalError,
  herdrEndpoint,
  isHerdrInstanceBinding,
  inspectHerdrPath,
  pinHerdrConfig,
  readHerdrPeer,
  verifyHerdrInstallation,
  measureHerdrInstallation
} from './local.js'
import type { HerdrEndpoint, HerdrInstanceBinding, HerdrLocalConfig } from './local.js'
import type { HerdrContractRecord, HerdrNativeSource } from './readonly.js'
import type { HerdrHostServices } from './persistence.js'
import { observedHerdrSource } from './review.js'

const installationKey = Object.freeze({})

export class HerdrInstallation {
  readonly config: HerdrLocalConfig
  readonly #process: HerdrInstanceBinding
  readonly #binary: string
  readonly #endpoint: HerdrEndpoint
  readonly #record: HerdrContractRecord
  readonly #schemaDocument: JsonObject
  readonly #token = Object.freeze({})
  #closed = false

  /** 仅 open 完成实际安装和 peer 核对后建立来源，调用者不能传入自报 schema 或 token。 */
  private constructor(
    config: HerdrLocalConfig,
    processBinding: HerdrInstanceBinding,
    binary: string,
    endpoint: HerdrEndpoint,
    record: HerdrContractRecord,
    schemaDocument: JsonObject,
    key: object
  ) {
    if (key !== installationKey) {
      throw new HerdrLocalError('herdr_installation_receipt_required')
    }
    this.config = config
    this.#process = processBinding
    this.#binary = binary
    this.#endpoint = endpoint
    this.#record = record
    this.#schemaDocument = schemaDocument
  }

  /** 只运行固定 argv 的版本诊断/schema 命令及一次无请求连接；不执行 ping、不扫描其它 session 或自动启动。 */
  static async open(
    input: HerdrLocalConfig,
    processBinding: HerdrInstanceBinding,
    signal?: AbortSignal
  ): Promise<HerdrInstallation> {
    const scope = herdrDeadline(signal, 10_000)
    try {
      const config = pinHerdrConfig(input)
      if (!isHerdrInstanceBinding(processBinding)) {
        throw new HerdrLocalError('herdr_supervised_process_required')
      }
      processBinding.assert(config)
      const measured = measureHerdrInstallation(config)
      const binary = measured.stamp
      const versionScope = herdrDeadline(scope.signal, 1000)
      const version = await runHerdrCommand(config, 'version', versionScope.signal)
        .catch(
          /** 不支持版本命令仅降低诊断；身份、IO、期限错误仍拒绝。 */ (error: unknown) => {
            if (
              error instanceof HerdrLocalError &&
              (error.code === 'herdr_cli_exit' || (error.code === 'herdr_timeout' && !scope.signal.aborted))
            ) {
              return Buffer.alloc(0)
            }
            throw error
          }
        )
        .finally(/** 诊断不占用后续必需接口的完整等待范围。 */ () => versionScope.close())
      const label = version
        .toString('utf8')
        .trim()
        .replace(/^herdr\s+/i, '')
      const binaryVersion =
        label.length > 0 &&
        label.length <= 128 &&
        [...label].every(
          /** 版本仅展示有界单行诊断。 */ (character) =>
            character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
        )
          ? label
          : 'unavailable'
      const raw = await runHerdrCommand(config, 'schema', scope.signal)
      const schemas = await compileHerdrSchemas(raw, scope.signal)
      checkHerdrSignal(scope.signal)
      const endpoint = herdrEndpoint(config)
      await withHerdrSocket(
        endpoint,
        scope.signal,
        /** 无原生写入，核对同一 socket 的内核凭据后立即关闭。 */ async (socket) => {
          processBinding.assert(config, await readHerdrPeer(socket, endpoint))
        }
      )
      checkHerdrSignal(scope.signal)
      if (verifyHerdrInstallation(config) !== binary || herdrEndpoint(config).stamp !== endpoint.stamp) {
        throw new HerdrLocalError('herdr_installation_changed')
      }
      processBinding.assert(config)
      const source = Object.freeze(
        observedHerdrSource(binaryVersion, measured.sha256, schemas.schema_sha256, schemas.protocol)
      )
      const record = Object.freeze({ wire: Object.freeze({ source, support_status: 'validated' as const }), schemas })
      return new HerdrInstallation(
        config,
        processBinding,
        binary,
        endpoint,
        record,
        JSON.parse(raw.toString('utf8')) as JsonObject,
        installationKey
      )
    } finally {
      scope.close()
    }
  }

  /** 核对原进程、路径身份及 endpoint；写入边界还重算同一受保护 binary 的摘要。 */
  assert(peer?: NativePeer, fullHash = false): HerdrEndpoint {
    if (this.#closed) {
      throw new HerdrLocalError('herdr_installation_closed')
    }
    this.#process.assert(this.config, peer)
    if (
      (fullHash
        ? verifyHerdrInstallation(this.config, this.#record.wire.source.binary_sha256)
        : inspectHerdrPath(this.config.binary, 'binary')) !== this.#binary ||
      herdrEndpoint(this.config).stamp !== this.#endpoint.stamp
    ) {
      throw new HerdrLocalError('herdr_installation_changed')
    }
    return this.#endpoint
  }

  /** 返回实际导出并经异步 Worker 编译的完整根，不接受 registry 替换其校验函数。 */
  record(): HerdrContractRecord {
    this.assert()
    return this.#record
  }

  /** 返回同次实际 CLI 导出且已核摘要的公开 schema 副本，供 MCP 描述方法，不签发执行许可。 */
  schemaDocument(): JsonObject {
    this.assert()
    return structuredClone(this.#schemaDocument)
  }

  /** 每个来源令牌只覆盖安装时的完整 Target、修订和固定契约；变化后不会迁移旧许可。 */
  source(binding: AttemptBinding): HerdrNativeSource | undefined {
    this.assert()
    if (
      binding.provider_kind !== 'herdr' ||
      binding.machine_id !== this.config.target.machine_id ||
      binding.binding_revision !== this.config.binding_revision ||
      boundedJson(binding.target) !== boundedJson(this.config.target) ||
      binding.contract_ref !== contractRef(this.#record.wire.source)
    ) {
      return undefined
    }
    return {
      role: 'local_installation',
      binding: JSON.parse(boundedJson(binding)) as AttemptBinding,
      token: this.#token
    }
  }

  /** 关闭本机来源能力，不停止 Herdr 或清除宿主所有的受监管进程。 */
  close(): void {
    this.#closed = true
  }
}

/** 将实际安装接入原宿主认证/策略和 provider 配置，Store 仍单独核对 registry 与当前 epoch。 */
export function createHerdrHostServices(
  installation: HerdrInstallation,
  services: Omit<HerdrHostServices, 'contract' | 'nativeSource'>
): HerdrHostServices {
  return {
    ...services,
    contract: /** 仅按实际安装来源的完整摘要查找，不从响应或 caller 导入契约。 */ (ref) => {
      const record = installation.record()
      return contractRef(record.wire.source) === ref ? record : undefined
    },
    nativeSource: /** 同时检查受保护配置引用，固定 Target 不意味着配置内容自动可信。 */ (binding) => {
      const provider = services.localProvider(binding.target)
      if (!provider || provider.config_ref !== installation.config.config_ref) {
        return undefined
      }
      return installation.source(binding)
    }
  }
}
