// 构建生成的固定 Herdr 资产与独立摘要目录；仅用 native:generate 显式更新。
import asset from './herdr-0.9.5.compiled.json' with { type: 'json' }
import type { HerdrPrecompiledEntry } from '../precompiled.js'

export const HERDR_PRECOMPILED: HerdrPrecompiledEntry = Object.freeze({
  compiler_sha256: 'd2bfed51fe50ca0aa79ccff7f1a0e182ba99cfdaf915884fa887467be3a481d4',
  ajv_sha256: '61fd98ce80129a8566ef21c40a0e64afb3f06b43ad96c661655177ad154d6e9f',
  asset_sha256: '000450750469687114cb59a99b587db416642c6674e7936988a05a60d3108f27',
  asset
})
