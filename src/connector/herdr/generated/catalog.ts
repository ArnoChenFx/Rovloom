// 构建生成的固定 Herdr 资产与独立摘要目录；仅用 native:generate 显式更新。
import asset from './herdr-0.9.5.compiled.json' with { type: 'json' }
import type { HerdrPrecompiledEntry } from '../precompiled.js'

export const HERDR_PRECOMPILED: HerdrPrecompiledEntry = Object.freeze({
  compiler_sha256: '7f2ffa7830c5e217914183df69642baf93877908bdbcc4f1fd390e793205e500',
  ajv_sha256: '61fd98ce80129a8566ef21c40a0e64afb3f06b43ad96c661655177ad154d6e9f',
  asset_sha256: '0b8c9b33208dc7fec8d71c8315c01522ff7a4473bf1b22ea18b8d9e6a8c54119',
  asset
})
