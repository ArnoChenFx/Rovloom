/** 验证 Windows 程序图标是已提交的透明背景多尺寸 ICO，并被原字节写入构建目录。 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { test } from 'node:test'
import { iconSizes, iconSource, parseIcon, writeWindowsIcon } from '../../scripts/release/icon.mjs'

/** 解出 8 位 RGBA PNG 的 alpha 通道（仅支持本图标使用的非交错、逐行 filter）。 */
function alphaPlane(png) {
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const chunks = []
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset)
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      chunks.push(png.subarray(offset + 8, offset + 8 + length))
    }
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * 4
  const rows = []
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? line[x - 4] : 0
      const up = previous[x]
      const upLeft = x >= 4 ? previous[x - 4] : 0
      const predictor =
        filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? (left + up) >> 1
              : filter === 4
                ? (() => {
                    const p = left + up - upLeft
                    const pa = Math.abs(p - left)
                    const pb = Math.abs(p - up)
                    const pc = Math.abs(p - upLeft)
                    return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
                  })()
                : 0
      line[x] = (line[x] + predictor) & 255
    }
    rows.push(line)
    previous = line
  }
  return { width, height, alpha: (x, y) => rows[y][x * 4 + 3] }
}

test(
  'icon has every standard size, all transparent RGBA frames with fully transparent corners',
  /** 角落 alpha 为 0 说明背景是透明的，而不是不透明的方形底色。 */ () => {
    const frames = parseIcon(readFileSync(iconSource))
    assert.deepEqual(
      frames.map(/** 目录顺序即尺寸顺序。 */ (frame) => frame.size),
      iconSizes
    )
    for (const frame of frames) {
      const plane = alphaPlane(frame.png)
      const last = frame.size - 1
      for (const [x, y] of [
        [0, 0],
        [last, 0],
        [0, last],
        [last, last]
      ]) {
        assert.equal(plane.alpha(x, y), 0, `${frame.size}px corner (${x},${y}) must be transparent`)
      }
      let opaque = 0
      for (let y = 0; y < frame.size; y++) {
        for (let x = 0; x < frame.size; x++) {
          opaque += plane.alpha(x, y) > 128 ? 1 : 0
        }
      }
      assert(opaque > frame.size * frame.size * 0.15, `${frame.size}px glyph must be visible`)
    }
  }
)

test(
  'build copies the committed icon bytes without rewriting them',
  /** 构建不重绘、不缩放：目标文件与受管文件逐字节相同。 */ () => {
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-icon-'))
    try {
      const destination = join(directory, 'rovloom.ico')
      writeWindowsIcon(destination)
      assert.deepEqual(readFileSync(destination), readFileSync(iconSource))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
