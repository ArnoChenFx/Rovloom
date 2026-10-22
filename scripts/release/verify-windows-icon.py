# 校验 Windows EXE 的真实 PE 图标资源与控制台子系统，不用文件名或构建成功推断图标生效。
import argparse
from pathlib import Path
import struct


# 按 PE 格式读取资源目录，返回每个叶节点的类型、名称、语言和原始字节。
def resources(executable):
    data = Path(executable).read_bytes()
    if data[:2] != b'MZ':
        raise ValueError('not a Windows PE executable')
    pe = struct.unpack_from('<I', data, 0x3c)[0]
    if data[pe:pe + 4] != b'PE\0\0':
        raise ValueError('invalid PE signature')
    sections = struct.unpack_from('<H', data, pe + 6)[0]
    optional_size = struct.unpack_from('<H', data, pe + 20)[0]
    optional = pe + 24
    magic = struct.unpack_from('<H', data, optional)[0]
    if magic not in (0x10b, 0x20b):
        raise ValueError('unsupported PE optional header')
    if struct.unpack_from('<H', data, optional + 68)[0] != 3:
        raise ValueError('CLI must retain IMAGE_SUBSYSTEM_WINDOWS_CUI')
    directories = optional + (112 if magic == 0x20b else 96)
    resource_rva, resource_size = struct.unpack_from('<II', data, directories + 16)
    if not resource_rva or not resource_size:
        raise ValueError('missing PE resources')
    table = optional + optional_size

    # 将资源 RVA 映射到文件中的实际区段，拒绝越界虚拟地址。
    def offset(rva, size=1):
        for index in range(sections):
            section = table + 40 * index
            virtual_size, address, raw_size, raw = struct.unpack_from('<IIII', data, section + 8)
            delta = rva - address
            if 0 <= delta and delta + size <= min(max(virtual_size, raw_size), raw_size):
                if raw + delta + size <= len(data):
                    return raw + delta
        raise ValueError('resource RVA outside file sections')

    base = offset(resource_rva, resource_size)
    result = []

    # 仅遍历三层资源树，拒绝循环或指向资源目录之外的节点。
    def walk(relative, path):
        if len(path) >= 3 or relative + 16 > resource_size:
            raise ValueError('invalid resource tree')
        node = base + relative
        named, ids = struct.unpack_from('<HH', data, node + 12)
        for index in range(named + ids):
            entry = node + 16 + index * 8
            if entry + 8 > base + resource_size:
                raise ValueError('resource entry out of bounds')
            name, child = struct.unpack_from('<II', data, entry)
            current = (*path, name)
            if child & 0x80000000:
                walk(child & 0x7fffffff, current)
            else:
                if len(current) != 3 or child + 16 > resource_size:
                    raise ValueError('invalid resource leaf')
                rva, size = struct.unpack_from('<II', data, base + child)
                start = offset(rva, size)
                result.append((current, data[start:start + size]))

    walk(0, ())
    return result


# 读取已提交 ICO 的目录与各帧 PNG 字节。
def icon_frames(ico):
    data = Path(ico).read_bytes()
    reserved, kind, count = struct.unpack_from('<HHH', data)
    if (reserved, kind) != (0, 1) or count < 1:
        raise ValueError('invalid managed ICO')
    frames = []
    for index in range(count):
        width, height, _, _, planes, bits, size, offset = struct.unpack_from('<BBBBHHII', data, 6 + 16 * index)
        frames.append(((width or 256, height or 256, planes, bits), data[offset:offset + size]))
    return frames


# 将首选图标组逐项关联到 RT_ICON，要求帧集合与受管 ICO 逐字节一致（透明背景的多尺寸 PNG 帧）。
def verify(executable, ico):
    expected = icon_frames(ico)
    entries = resources(executable)
    groups = sorted((path, body) for path, body in entries if path[0] == 14)
    if not groups:
        raise ValueError('missing RT_GROUP_ICON')
    path, group = groups[0]
    reserved, kind, count = struct.unpack_from('<HHH', group)
    if (reserved, kind, count) != (0, 1, len(expected)) or len(group) != 6 + 14 * count:
        raise ValueError('primary icon must contain exactly the managed frames')
    actual = []
    for index in range(count):
        width, height, colors, reserved, planes, bits, size, icon_id = struct.unpack_from(
            '<BBBBHHIH', group, 6 + 14 * index
        )
        if (colors, reserved) != (0, 0):
            raise ValueError('icon frame metadata mismatch')
        matches = [body for key, body in entries if key == (3, icon_id, path[2])]
        if len(matches) != 1 or size != len(matches[0]):
            raise ValueError('RT_ICON entry missing or size mismatch')
        actual.append(((width or 256, height or 256, planes, bits), matches[0]))
    if sorted(actual) != sorted(expected):
        raise ValueError('RT_ICON frames differ from the managed transparent icon')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Verify native Windows executable icon and console subsystem')
    parser.add_argument('executable')
    parser.add_argument('--ico', default='docs/assets/brand/rovloom-icon.ico')
    arguments = parser.parse_args()
    verify(arguments.executable, arguments.ico)
    print('PE icon: exact managed transparent multi-size ICO frames; console subsystem: pass')
