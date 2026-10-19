// 流式下载官方计划资产并检查精确大小和 SHA256；不执行下载内容，摘要不代表发布者认证。
import { createHash } from 'node:crypto'
import { MAX_BINARY_BYTES, UpdateError } from './contract.js'
import { readOfficial, type UpdateNetwork } from './network.js'
import { validateDownloadPlan, type UpdatePlan } from './plan.js'

export type UpdateSink = (chunk: Uint8Array) => Promise<void>
export type VerifiedDownload = Readonly<{ size: number; sha256: string }>

// sink 必须属于隔离暂存事务；只有本函数成功返回后，暂存文件才可进入替换候选状态。
export async function downloadUpdate(
  network: UpdateNetwork,
  plan: UpdatePlan,
  sink: UpdateSink
): Promise<VerifiedDownload> {
  const asset = validateDownloadPlan(plan)
  const hash = createHash('sha256')
  const size = await readOfficial(
    network,
    { kind: 'asset', tag: plan.tag, name: asset.name },
    MAX_BINARY_BYTES,
    /* 同步计入流摘要后把受控片段写入私有暂存。 */ async (chunk) => {
      hash.update(chunk)
      await sink(chunk)
    },
    asset.size
  )
  const sha256 = hash.digest('hex')
  if (sha256 !== asset.sha256) {
    throw new UpdateError('checksum_mismatch')
  }
  return Object.freeze({ size, sha256 })
}
