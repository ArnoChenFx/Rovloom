// 在受限引擎中安装锁定库的标准 UTF-8 实现，不使用不完整的编码或 URL 手写 shim。
import { TextEncoder, TextDecoder } from '@exodus/bytes/encoding.js'
globalThis.TextEncoder = TextEncoder
globalThis.TextDecoder = TextDecoder
