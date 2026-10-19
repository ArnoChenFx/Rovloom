/** 将唯一受管的方形 PNG 原字节包入单帧 ICO，保留背景且不放大、不重绘。 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

export const iconSource = 'docs/assets/brand/rovloom-mark-orange.png'

/** 固定 192 像素原图及 ICO 元数据，拒绝误用复合展示图或伪造更高分辨率。 */
export function writeWindowsIcon(destination) {
  const png = readFileSync(iconSource)
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  assert.equal(png.toString('ascii', 12, 16), 'IHDR')
  assert.equal(png.readUInt32BE(16), 192)
  assert.equal(png.readUInt32BE(20), 192)
  const header = Buffer.alloc(22)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  header[6] = 192
  header[7] = 192
  header.writeUInt16LE(1, 10)
  header.writeUInt16LE(32, 12)
  header.writeUInt32LE(png.length, 14)
  header.writeUInt32LE(22, 18)
  writeFileSync(destination, Buffer.concat([header, png]))
  return png
}
