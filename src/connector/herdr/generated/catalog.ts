// 构建生成的固定 Herdr 资产与独立摘要目录；仅用 native:generate 显式更新。
import asset from './herdr-0.9.5.compiled.json' with { type: 'json' }
import type { HerdrPrecompiledEntry } from '../precompiled.js'

export const HERDR_PRECOMPILED: HerdrPrecompiledEntry = Object.freeze({
  compiler_sha256: '351741737ac675681e189a529c3e996b2e1085d93d4ef46bfe1bf50e4a24fe79',
  ajv_sha256: '61fd98ce80129a8566ef21c40a0e64afb3f06b43ad96c661655177ad154d6e9f',
  asset_sha256: '2955c21490fb6920fbb8576ca81ab94fff0bc206d27c8211faf98623a6d23037',
  asset
})
