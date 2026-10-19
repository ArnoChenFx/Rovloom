# 限定 Herdr 离线证据的解析、文件边界、引用闭包和状态重建模型，不授予原生派发许可。
"""Herdr P0-H 离线证据边界；不连接、启动或授权任何原生实例。"""

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
from urllib.parse import unquote, urldefrag


ROOT = Path(__file__).resolve().parents[2]
POLICY = ROOT / 'test/fixtures/herdr/0.9.5/method-policy.json'
# 这是离线工具自己的限额，不是已经实测的 Herdr transport 上限。
MAX_FILE = 2 * 1024 * 1024
MAX_TOTAL = 8 * 1024 * 1024
MAX_LINE = 64 * 1024
MAX_FILES = 32
DIALECT = 'https://json-schema.org/draft/2020-12/schema'


class Rejected(ValueError):
    pass


# 条件不成立时抛出统一拒绝异常，供各离线边界检查使用。
def require(condition, reason):
    if not condition:
        raise Rejected(reason)


# 返回原始字节的 SHA-256 摘要，绑定归档清单与文件内容。
def sha(data):
    return hashlib.sha256(data).hexdigest()


# 严格解析 UTF-8 JSON，拒绝重复键、非有限数、无效字符和过大结构。
def decode(data):
    # 构造 JSON 对象时拒绝重复键和键中的 Unicode 代理字符。
    def pairs(items):
        value = {}
        for key, item in items:
            require(not any(0xD800 <= ord(char) <= 0xDFFF for char in key), 'invalid Unicode scalar')
            require(key not in value, 'duplicate JSON key')
            value[key] = item
        return value

    # 作为 JSON 数值常量回调，拒绝 NaN 和 Infinity 等非有限值。
    def invalid(_value):
        raise Rejected('non-finite JSON number')

    try:
        value = json.loads(data.decode('utf-8'), object_pairs_hook=pairs, parse_constant=invalid)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise Rejected('invalid JSON or UTF-8') from error
    count = 0
    pending = [(value, 0)]
    while pending:
        item, depth = pending.pop()
        count += 1
        require(depth <= 48 and count <= 50000, 'JSON structure limit')
        if isinstance(item, dict):
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)
        elif isinstance(item, float):
            # json.loads can turn an otherwise valid exponent into infinity.
            require(float('-inf') < item < float('inf'), 'non-finite JSON number')
        elif isinstance(item, str):
            require(not any(0xD800 <= ord(char) <= 0xDFFF for char in item), 'invalid Unicode scalar')
    return value


# 在固定目录描述符下读取受限普通文件，拒绝越界、链接和过大文件。
def read_file(root, name):
    require(isinstance(name, str) and name and '\\' not in name, 'unsafe artifact path')
    path = PurePosixPath(name)
    require(not path.is_absolute() and all(part not in ('.', '..') for part in name.split('/')),
            'unsafe artifact path')
    current = root
    for part in path.parts:
        current = current / part
        require(not current.is_symlink(), 'symlink artifact')
    # 用目录 fd 和 O_NOFOLLOW 固定读取路径；先前的 lstat 不能消除替换竞态。
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(descriptor, 'rb') as stream:
            status = os.fstat(stream.fileno())
            require(stat.S_ISREG(status.st_mode), 'missing regular artifact')
            require(status.st_nlink == 1 and status.st_size <= MAX_FILE, 'artifact link or size limit')
            data = stream.read(MAX_FILE + 1)
    finally:
        os.close(directory)
    require(len(data) <= MAX_FILE, 'artifact size limit')
    return data


# 仅分类未获派发许可的原因；候选方法仍需完整原生安全评审，所有分类均禁止派发。
def method_classification(method, params):
    if method in ('ping', 'session.snapshot') and type(params) is dict and not params:
        reason = 'candidate_without_complete_native_safety_review'
    elif method in ('pane.read', 'agent.read'):
        reason = 'read_side_effects_unverified'
    elif method in ('events.subscribe', 'events.wait'):
        reason = 'subscription_side_effects_unverified'
    else:
        reason = 'outside_reviewed_readonly_scope'
    return {'dispatch_allowed': False, 'reason': reason}


# 校验字节上限和唯一完整 JSON 行，返回解析后的原生对象帧。
def frame(data):
    require(isinstance(data, bytes) and len(data) <= MAX_LINE, 'frame size limit')
    require(data.endswith(b'\n') and data.count(b'\n') == 1, 'one complete JSON line required')
    value = decode(data)
    require(type(value) is dict, 'native frame must be an object')
    return value


# 离线校验候选请求与响应关联并保留原生字段，无响应时标记结果未知。
def exchange(request_bytes, response_bytes):
    request = frame(request_bytes)
    require(set(request) == {'id', 'method', 'params'}, 'unexpected request envelope')
    require(isinstance(request['id'], str) and 0 < len(request['id']) <= 128, 'invalid request id')
    require(request['method'] in ('ping', 'session.snapshot') and
            type(request['params']) is dict and not request['params'],
            'request outside offline replay candidates')
    if response_bytes is None:
        return {'request': request, 'response': None, 'outcome': 'outcome_unknown'}
    response = frame(response_bytes)
    require(response.get('id') == request['id'], 'response id mismatch')
    require(('result' in response) != ('error' in response), 'result/error must be exclusive')
    if 'result' in response:
        result = response['result']
        require(type(result) is dict and isinstance(result.get('type'), str) and result['type'],
                'invalid native result')
        require(result['type'] == {'ping': 'pong', 'session.snapshot': 'session_snapshot'}[request['method']],
                'result method mismatch')
        if request['method'] == 'ping':
            require(isinstance(result.get('version'), str) and result['version'] and
                    type(result.get('protocol')) is int and 0 <= result['protocol'] <= 0xFFFFFFFF and
                    (result.get('capabilities') is None or type(result['capabilities']) is dict),
                    'invalid native pong metadata')
        else:
            require(type(result.get('snapshot')) is dict, 'invalid native snapshot envelope')
    else:
        error = response['error']
        require(type(error) is dict and isinstance(error.get('code'), str) and error['code'] and
                isinstance(error.get('message'), str), 'invalid native error')
    # 返回原生字段和值；原始字节另保存在文件中，不转换为 UHP。
    return {'request': request, 'response': response, 'outcome': 'native_error' if 'error' in response else 'response'}


# 只核对指定方言 schema 的离线引用闭包，不执行参数验证或远程加载。
def schema_closure(documents, root_name):
    require(root_name in documents and 0 < len(documents) <= MAX_FILES, 'schema root or count')
    decoded = {name: decode(data) for name, data in documents.items()}
    ids = {}
    for name, document in decoded.items():
        require(type(document) is dict and document.get('$schema') == DIALECT, 'unsupported schema dialect')
        identity = document.get('$id', name)
        require(isinstance(identity, str) and identity and '#' not in identity and identity not in ids,
                'duplicate or invalid schema id')
        ids[identity] = name
    for name, document in decoded.items():
        pending = [document]
        while pending:
            item = pending.pop()
            if isinstance(item, list):
                pending.extend(item)
            elif isinstance(item, dict):
                require(not ({'$dynamicRef', '$recursiveRef', '$anchor', '$dynamicAnchor'} & set(item)),
                        'unsupported schema reference feature')
                require(item is document or '$id' not in item, 'nested schema id unsupported')
                if '$ref' in item:
                    require(isinstance(item['$ref'], str), 'invalid schema reference')
                    base, fragment = urldefrag(item['$ref'])
                    target_name = ids.get(base) if base else name
                    require(target_name in decoded, 'schema reference outside offline closure')
                    target = decoded[target_name]
                    pointer = unquote(fragment)
                    require(not pointer or pointer.startswith('/'), 'schema anchor unsupported')
                    for token in pointer.split('/')[1:] if pointer else []:
                        require(not re.search(r'~(?![01])', token), 'invalid JSON pointer escape')
                        token = token.replace('~1', '/').replace('~0', '~')
                        if isinstance(target, dict):
                            require(token in target, 'missing schema pointer')
                            target = target[token]
                        elif isinstance(target, list):
                            require(re.fullmatch(r'0|[1-9][0-9]*', token) and int(token) < len(target),
                                    'missing schema pointer')
                            target = target[int(token)]
                        else:
                            raise Rejected('missing schema pointer')
                    require(type(target) in (dict, bool), 'schema reference is not a schema')
                pending.extend(item.values())
    return {'dialect': DIALECT, 'documents': len(documents), 'parameter_validation': 'not_performed'}


# 核对归档清单、原始字节及实例绑定，返回明确未获原生认证的离线检查摘要。
def audit(root):
    root = Path(root)
    require(not root.is_symlink() and root.is_dir(), 'invalid evidence root')
    require(root.absolute() == root.resolve(), 'noncanonical evidence root')
    raw_manifest = read_file(root, 'capture.json')
    require(b'ROVLOOM_P0H_FAKE_SECRET' not in raw_manifest, 'fake secret canary found')
    manifest = decode(raw_manifest)
    require(type(manifest) is dict and manifest.get('format') == 1, 'unsupported capture format')
    require(manifest.get('evidence_kind') in ('synthetic', 'unverified_capture'), 'invalid evidence kind')
    files = manifest.get('files')
    require(type(files) is dict and 0 < len(files) <= MAX_FILES and 'capture.json' not in files,
            'invalid artifact inventory')
    actual = set()
    for index, path in enumerate(root.rglob('*')):
        require(index < MAX_FILES * 2, 'artifact tree limit')
        require(not path.is_symlink(), 'symlink artifact')
        if not path.is_dir():
            actual.add(path.relative_to(root).as_posix())
    require(actual == set(files) | {'capture.json'}, 'artifact inventory mismatch')
    content, total = {}, len(raw_manifest)
    for name, digest in files.items():
        require(isinstance(digest, str) and re.fullmatch(r'[0-9a-f]{64}', digest), 'invalid artifact hash')
        content[name] = read_file(root, name)
        total += len(content[name])
        require(total <= MAX_TOTAL, 'evidence total size limit')
        require(sha(content[name]) == digest, 'artifact hash mismatch')
        # 固定假 secret 是回归 canary；这不能检测所有未知秘密。
        require(b'ROVLOOM_P0H_FAKE_SECRET' not in content[name], 'fake secret canary found')
    binding = manifest.get('binding')
    require(type(binding) is dict and set(binding) == {'instance', 'binary_sha256', 'schema_sha256', 'version', 'protocol'},
            'incomplete recorded binding')
    require(isinstance(binding['instance'], str) and binding['instance'] and
            isinstance(binding['version'], str) and binding['version'] and
            type(binding['protocol']) is int and binding['protocol'] > 0, 'invalid recorded binding')
    require(all(isinstance(binding[key], str) and re.fullmatch(r'[0-9a-f]{64}', binding[key])
                for key in ('binary_sha256', 'schema_sha256')), 'invalid recorded binding hash')
    schema = manifest['schema']
    require(schema['root'] in content and binding['schema_sha256'] == sha(content[schema['root']]),
            'installed schema hash mismatch')
    require(len(schema['documents']) == len(set(schema['documents'])), 'duplicate schema document')
    closure = schema_closure({name: content[name] for name in schema['documents']}, schema['root'])
    referenced = set(schema['documents'])
    observations = manifest.get('observations', [])
    require(type(observations) is list and len(observations) <= MAX_FILES, 'invalid observation inventory')
    for observation in observations:
        require(type(observation) is dict and set(observation) == {'role', 'file'} and
                observation['role'] in ('official_origin', 'endpoint_peer', 'side_effects', 'framing', 'subscriptions') and
                observation['file'] in content, 'invalid recorded observation')
        # 仅归档原文，不将观察文件内的 true/source_verified 当作可信来源。
        referenced.add(observation['file'])
    for command, argv in [('version', ['herdr', '--version']), ('schema_export', ['herdr', 'api', 'schema', '--json'])]:
        record = manifest[command]
        require(record['argv'] == argv and record['exit_code'] == 0, 'invalid recorded CLI outcome')
        require(record['stdout'] in content and record['stderr'] in content, 'missing raw CLI evidence')
        referenced.update((record['stdout'], record['stderr']))
    require(manifest['schema_export']['stdout'] == schema['root'], 'schema is not raw CLI stdout')
    require(content[manifest['version']['stdout']].decode('utf-8').strip() == 'herdr ' + binding['version'],
            'recorded version mismatch')
    outcomes = []
    records = manifest['exchanges']
    require(type(records) is list and 0 < len(records) <= 32, 'invalid exchange inventory')
    for record in records:
        require(record['binding'] == binding, 'exchange instance or contract mismatch')
        require(record['termination'] in ('response', 'eof', 'timeout'), 'unknown termination')
        response = record['response']
        require((response is not None) == (record['termination'] == 'response'), 'termination/response mismatch')
        referenced.add(record['request'])
        if response is not None:
            referenced.add(response)
        result = exchange(content[record['request']], content[response] if response else None)
        if result['request']['method'] == 'ping' and result['outcome'] == 'response':
            pong = result['response']['result']
            require(pong['version'] == binding['version'] and pong['protocol'] == binding['protocol'],
                    'recorded ping version or protocol mismatch')
        outcomes.append(result['outcome'])
    require(referenced == set(content), 'unreferenced raw artifact')
    policy = decode(POLICY.read_bytes())
    require(policy['production_allowlist'] == [], 'Herdr native gate is not satisfied')
    return {'offline_audit': 'passed', 'evidence_kind': manifest['evidence_kind'],
            'manifest_sha256': sha(raw_manifest),
            'native_verified': False, 'production_allowlist': [], 'schema': closure,
            'outcomes': outcomes, 'bytes': total,
            'observations_recorded_only': len(observations),
            'unverified': ['official_binary_origin', 'installed_binary_execution', 'endpoint_and_peer',
                           'native_framing_limits', 'passive_side_effects', 'subscription_and_rebuild']}


class StateRebuild:
    """离线状态模型；ticket 只是本次读取身份，不是原生序号或 incarnation。"""

    # 初始化无订阅、无缓存且需刷新的离线状态，记录连接身份与缺口标记。
    def __init__(self):
        self.connection = None
        self.acknowledged = False
        self.inflight = None
        self.cache = None
        self.dirty = True
        self.gap_seen = False
        self.connections_seen = set()

    # 登记有界且未用过的订阅连接，废弃旧读取并标记状态需要刷新。
    def subscribe(self, connection):
        require(isinstance(connection, str) and connection, 'invalid subscription connection')
        require(connection not in self.connections_seen and len(self.connections_seen) < 32,
                'subscription connection must be fresh and bounded')
        self.connections_seen.add(connection)
        self.connection = connection
        self.acknowledged = False
        self.inflight = None
        self.dirty = True

    # 仅接受当前订阅的一次确认，允许后续快照读取。
    def acknowledge(self, connection):
        require(self.connection is not None and connection == self.connection and not self.acknowledged,
                'unexpected subscription acknowledgement')
        self.acknowledged = True

    # 仅接受已确认订阅的事件，并标记当前缓存需要刷新。
    def invalidate(self, connection):
        require(connection == self.connection and self.acknowledged, 'event outside acknowledged subscription')
        self.dirty = True

    # 订阅出现缺口时清除连接与在途读取，要求重新订阅并保留缺口标记。
    def gap(self, connection):
        require(self.connection is not None and connection == self.connection, 'gap from another subscription')
        self.connection = None
        self.acknowledged = False
        self.inflight = None
        self.dirty = True
        self.gap_seen = True

    # 确认订阅就绪且读取使用另一连接后，串行创建本次快照票据。
    def begin_snapshot(self, connection):
        require(self.acknowledged and connection != self.connection and isinstance(connection, str) and connection,
                'snapshot needs acknowledged subscription and another connection')
        require(self.inflight is None, 'snapshot refresh must be serialized')
        self.inflight = object()
        self.dirty = False
        return self.inflight

    # 仅接纳当前票据，深拷贝替换缓存并返回是否需再次刷新及保证范围。
    def finish_snapshot(self, ticket, snapshot):
        require(ticket is not None and ticket is self.inflight, 'stale snapshot response')
        self.cache = deepcopy(snapshot)
        self.inflight = None
        return {'refresh_again': self.dirty, 'gap_seen': self.gap_seen, 'guarantee': 'state_rebuild_only'}
