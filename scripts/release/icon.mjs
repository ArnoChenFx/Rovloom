/** 校验并原样复制已提交的透明背景多尺寸 ICO；不在构建时缩放、重绘或改写任何帧。 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

export const iconSource = 'docs/assets/brand/rovloom-icon.ico'
export const iconSizes = [16, 24, 32, 48, 64, 128, 256]

/** 解析 ICO 目录：全部是 32 位 RGBA PNG 帧，尺寸与目录一致，且每帧的角落完全透明。 */
export function parseIcon(bytes) {
  assert.equal(bytes.readUInt16LE(0), 0)
  assert.equal(bytes.readUInt16LE(2), 1)
  const count = bytes.readUInt16LE(4)
  assert.equal(count, iconSizes.length)
  const frames = []
  for (let index = 0; index < count; index++) {
    const entry = 6 + 16 * index
    const size = bytes[entry] || 256
    const length = bytes.readUInt32LE(entry + 8)
    const offset = bytes.readUInt32LE(entry + 12)
    assert.equal(size, iconSizes[index])
    assert.equal(bytes[entry + 1] || 256, size)
    assert.equal(bytes.readUInt16LE(entry + 4), 1)
    assert.equal(bytes.readUInt16LE(entry + 6), 32)
    const png = bytes.subarray(offset, offset + length)
    assert.equal(png.length, length)
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    assert.equal(png.toString('ascii', 12, 16), 'IHDR')
    assert.equal(png.readUInt32BE(16), size)
    assert.equal(png.readUInt32BE(20), size)
    // 位深 8、颜色类型 6（RGBA）：背景由 alpha 通道表达，而不是不透明底色。
    assert.equal(png[24], 8)
    assert.equal(png[25], 6)
    frames.push({ size, png })
  }
  return frames
}

/** 把已提交 ICO 的原字节写到构建目录，返回各帧供清单记录。 */
export function writeWindowsIcon(destination) {
  const bytes = readFileSync(iconSource)
  const frames = parseIcon(bytes)
  writeFileSync(destination, bytes)
  return frames
}
