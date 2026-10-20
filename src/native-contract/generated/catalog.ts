// 构建生成的固定资产目录；用 native:generate 显式更新，独立摘要不能由运行时输入替换。
import asset0 from './luvus-0.14.3-linux-x64.compiled.json' with { type: 'json' }
import type { PrecompiledEntry } from '../precompiled.js'

export const PRECOMPILED_ASSETS: readonly PrecompiledEntry[] = Object.freeze([
  Object.freeze({
    binary_version: '0.14.3',
    binary_sha256: '895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9',
    schema_sha256: '00e3bb8862b9f3602164bdbe3f11cd7b466e7f7098aa2942dd3878d0b1abdbe6',
    compiler_sha256: '67056c2b4f83cf1a202eefe65342468b77a29e31812d9ea5f781ac5c2ce8d41a',
    ajv_sha256: '61fd98ce80129a8566ef21c40a0e64afb3f06b43ad96c661655177ad154d6e9f',
    asset_sha256: '7503096afd950f9ef09b3d4d450e95f2daf60ed8c6f12f944ccabef596d0c1cf',
    asset: asset0
  })
])
