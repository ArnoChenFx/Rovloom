// 在线配对认领面：与离线 setup 共用设备 listener 的非 WebSocket 路径。认领秘密只以摘要落库；
// 批准产生的设备凭据只保存在本进程内存 custody 中，设备出示认领秘密领取并确认后即删除，超时或重启一律收敛为失败并拒绝该凭据。
import { randomBytes } from 'node:crypto'
import { digest, GatewayError } from '../contracts.js'
import { fields, id, object } from '../wire/index.js'
import type { Store } from '../store.js'
import { requestJson, setupReply } from './pairing-http.js'

// 核对码使用去混淆字符集，只供双边人工比对，不是凭据。
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
// 生成 8 位核对码；随机源与其它秘密材料相同，不用 Math.random。
function userCode(): string {
  const bytes = randomBytes(8)
  let code = ''
  for (const byte of bytes) {
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length]
  }
  return code
}

type Hold = { machine_id: string; credential: string; timer: ReturnType<typeof setTimeout> }

/** 在线认领的内存 custody 与 HTTP 面；Store 负责全部持久状态，本类不落盘任何秘密。 */
export class OnlinePairingHttp {
  private readonly holds = new Map<string, Hold>()
  private readonly closing = new AbortController()
  /** 时钟只影响本进程的到期展示与交付计时，持久到期始终由 Store 账本判定。 */
  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now
  ) {}

  // 管理批准提交前暂存凭据；交付窗口与认领自身的到期一致，窗口内未确认即收敛失败。
  hold(event: { machine_id: string; claim_id: string; credential: string }): void {
    const claim = this.store.pairingClaim(event.claim_id)
    this.drop(event.claim_id)
    const delay = Math.min(Math.max(claim.expires - this.now(), 0), 600_000)
    const timer = setTimeout(/* 交付窗口到期未确认时拒绝凭据并失败认领。 */ () => this.expire(event.claim_id), delay)
    timer.unref()
    this.holds.set(event.claim_id, { machine_id: event.machine_id, credential: event.credential, timer })
  }

  // 启动收敛：内存 custody 已随进程丢失的已批准认领一律失败，并按当前凭据摘要拒绝未送达凭据。
  reconcile(): void {
    for (const claim of this.store.approvedPairingClaims()) {
      if (this.holds.has(claim.claim_id)) {
        continue
      }
      try {
        const current = this.store.credentialDigest(claim.machine_id)
        this.store.failPairingClaim(claim.claim_id)
        if (current) {
          this.store.denyDelivery(claim.machine_id, current)
        }
      } catch {
        /* 单个认领收敛失败不阻断启动，其余认领与网关照常。 */
      }
    }
  }

  // 关闭时停止全部交付计时；未交付认领留待下次启动 reconcile 收敛，不在此处伪造结果。
  close(): void {
    this.closing.abort()
    for (const hold of this.holds.values()) {
      clearTimeout(hold.timer)
    }
    this.holds.clear()
  }

  // 只处理认领路径，其余路径返回 undefined 交回 setup handler 或 listener 的既有拒绝。
  handle(request: Request): Promise<Response> | undefined {
    const url = new URL(request.url)
    if (!['/pairing/claim', '/pairing/claim/status', '/pairing/claim/ack'].includes(url.pathname)) {
      return undefined
    }
    if (
      this.closing.signal.aborted ||
      request.method !== 'POST' ||
      request.headers.has('origin') ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json'
    ) {
      return Promise.resolve(setupReply({ error: 'online_pairing_request_refused' }, 403))
    }
    return this.dispatch(url.pathname, request)
  }

  private async dispatch(path: string, request: Request): Promise<Response> {
    try {
      const input = await requestJson(request, 4096, this.closing.signal)
      if (path === '/pairing/claim') {
        return this.claim(input)
      }
      id(input.claim_id)
      const claim_id = input.claim_id as string
      if (typeof input.secret !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(input.secret)) {
        throw new GatewayError('invalid_pairing_claim')
      }
      // 秘密核对在账本内以摘要定长比对完成；不匹配与不存在同错，避免枚举认领状态。
      const claim = this.store.verifyPairingClaimSecret(claim_id, input.secret)
      if (path === '/pairing/claim/status') {
        if (claim.status === 'pending' && claim.expires <= this.now()) {
          return setupReply({ status: 'expired' })
        }
        if (claim.status === 'approved') {
          const hold = this.holds.get(claim_id)
          // 已批准但内存 custody 不存在（例如网关重启）即交付失败，不返回任何凭据。
          return hold
            ? setupReply({ status: 'approved', credential: hold.credential })
            : setupReply({ status: 'failed' })
        }
        return setupReply({ status: claim.status })
      }
      // ack：只有账本仍为 approved 且内存 custody 仍持有凭据时才能完成交付。
      if (claim.status !== 'approved' || !this.holds.has(claim_id)) {
        throw new GatewayError('invalid_pairing_claim')
      }
      this.store.completePairingClaim(claim_id)
      this.drop(claim_id)
      return setupReply({ status: 'delivered' })
    } catch (error) {
      const code = error instanceof GatewayError ? error.code : 'online_pairing_request_invalid'
      return setupReply({ error: code }, code === 'pairing_claim_conflict' ? 409 : 400)
    }
  }

  // 发起认领：pairing_id 是公开申请标识，真正的持有证明是设备生成的认领秘密（此处只收其摘要）。
  private claim(input: Record<string, unknown>): Response {
    const value = object(input)
    fields(value, ['pairing_id', 'secret_hash'])
    id(value.pairing_id)
    const pairing_id = value.pairing_id as string
    if (typeof value.secret_hash !== 'string' || !/^[0-9a-f]{64}$/.test(value.secret_hash)) {
      throw new GatewayError('invalid_pairing_claim')
    }
    const application = this.store.pairingApplication(pairing_id)
    if (!application) {
      throw new GatewayError('pairing_not_found')
    }
    const created = this.store.startPairingClaim(application.machine_id, pairing_id, value.secret_hash, userCode())
    return setupReply({
      claim_id: created.claim_id,
      user_code: created.user_code,
      expires_at: created.expires
    })
  }

  private expire(claim_id: string): void {
    const hold = this.holds.get(claim_id)
    if (!hold) {
      return
    }
    this.holds.delete(claim_id)
    try {
      this.store.failPairingClaim(claim_id)
      this.store.denyDelivery(hold.machine_id, digest(hold.credential))
    } catch {
      /* 收敛失败不向后台计时器抛出；认领保持已批准状态，等待重启 reconcile。 */
    }
  }

  private drop(claim_id: string): void {
    const hold = this.holds.get(claim_id)
    if (hold) {
      clearTimeout(hold.timer)
      this.holds.delete(claim_id)
    }
  }
}
