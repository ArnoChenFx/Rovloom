# 从透明全名图中取出橙色 R，生成透明背景的方形标与多尺寸 Windows ICO；仅维护时运行，构建只读已提交的结果。
import io
import struct
from pathlib import Path

import numpy as np
from PIL import Image

BRAND = Path('docs/assets/brand')
SIZES = (16, 24, 32, 48, 64, 128, 256)


# 只保留橙色字形像素及其原始半透明边缘；深蓝 ovloom 与白底噪点不进入图标。
def extract_mark(logo):
    pixels = np.array(Image.open(logo).convert('RGBA')).astype(int)
    left, right, top, bottom = 200, 700, 150, 620
    region = pixels[top:bottom, left:right].copy()
    red, blue, alpha = region[..., 0], region[..., 2], region[..., 3]
    region[..., 3] = np.where((alpha > 0) & (red - blue > 60), alpha, 0)
    rows, columns = np.where(region[..., 3] > 128)
    glyph = Image.fromarray(
        region[rows.min():rows.max() + 1, columns.min():columns.max() + 1].astype('uint8'), 'RGBA'
    )
    side = int(max(glyph.size) * 1.12)
    square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    square.paste(glyph, ((side - glyph.width) // 2, (side - glyph.height) // 2), glyph)
    return square


# 每个尺寸都是独立缩放的 32 位 RGBA PNG 帧，Windows Vista 之后原生支持。
def write_icon(square, destination):
    frames = []
    for size in SIZES:
        buffer = io.BytesIO()
        scaled = np.array(square.resize((size, size), Image.LANCZOS))
        scaled[scaled[..., 3] < 4] = 0  # 缩放产生的近乎透明残留归零，保证背景是真正的全透明
        Image.fromarray(scaled, 'RGBA').save(buffer, 'PNG', optimize=True)
        frames.append((size, buffer.getvalue()))
    header = struct.pack('<HHH', 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    entries, bodies = b'', b''
    for size, body in frames:
        entries += struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(body), offset)
        bodies += body
        offset += len(body)
    destination.write_bytes(header + entries + bodies)


if __name__ == '__main__':
    mark = extract_mark(BRAND / 'rovloom-logo.png')
    mark.resize((256, 256), Image.LANCZOS).save(BRAND / 'rovloom-mark-transparent.png', optimize=True)
    write_icon(mark, BRAND / 'rovloom-icon.ico')
    print('wrote rovloom-mark-transparent.png and rovloom-icon.ico', SIZES)
