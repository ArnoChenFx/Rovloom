# 用合成输入测试 Herdr 离线帧、归档、schema 引用与状态重建边界，不代表原生验收。
"""只测离线工具；合成输入、断线和状态模型均不计入原生 Herdr 验收。"""

from copy import deepcopy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

# 从当前仓库显式载入被测维护工具，隔离不同测试文件的导入状态。
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/herdr'))

import collect as collector
from contract import (
    audit, decode, DIALECT, exchange, frame, MAX_LINE, method_classification,
    audit_method_policy, read_file, Rejected, ROOT, schema_closure, sha, StateRebuild,
    reviewed_production_allowlist,
)


FIXTURE = ROOT / 'test/fixtures/herdr/synthetic'


# 把测试值编码为以换行结束的紧凑 JSON 字节。
def encoded(value):
    return (json.dumps(value, separators=(',', ':')) + '\n').encode()


# 为测试 schema 添加指定方言声明后编码为 JSON 字节。
def document(**values):
    return encoded({'$schema': DIALECT, **values})


class NativeFrames(unittest.TestCase):
    # 读取合成 ping 请求和响应原文字节，供帧边界测试复用。
    def setUp(self):
        self.request = (FIXTURE / 'ping.request.jsonl').read_bytes()
        self.response = (FIXTURE / 'ping.response.jsonl').read_bytes()

    # 验证原生响应的未知字段及嵌套值在离线解析后完整保留。
    def test_preserves_native_unknown_values(self):
        raw = b'{ "id":"synthetic-ping", "result":{"type":"pong","version":"synthetic","protocol":22,"extra":{"x":[1,null,true]}} }\n'
        result = exchange(self.request, raw)
        self.assertEqual(result['response']['result']['extra'], {'x': [1, None, True]})
        self.assertEqual(result['response'], decode(raw))

    # 验证原生错误保持独立结果分类且其细节不被改写。
    def test_preserves_native_error(self):
        result = exchange((FIXTURE / 'snapshot.request.jsonl').read_bytes(),
                          (FIXTURE / 'snapshot.error.jsonl').read_bytes())
        self.assertEqual(result['outcome'], 'native_error')
        self.assertEqual(result['response']['error']['details'], {'unmodified': True})

    # 验证没有响应只标记为结果未知，不伪造成功或错误响应。
    def test_absent_reply_is_unknown(self):
        result = exchange(self.request, None)
        self.assertEqual(result['outcome'], 'outcome_unknown')
        self.assertIsNone(result['response'])

    # 验证响应关联、方法类型和 result/error 互斥约束均被检查。
    def test_wrong_id_method_and_result_error_exclusivity(self):
        for response in [
            {'id': 'other', 'result': {'type': 'pong'}},
            {'id': 'synthetic-ping', 'result': {'type': 'session_snapshot'}},
            {'id': 'synthetic-ping', 'result': {'type': 'pong'}, 'error': None},
            {'id': 'synthetic-ping'},
            {'id': 'synthetic-ping', 'result': None},
            {'id': 'synthetic-ping', 'error': {'code': 1, 'message': 'bad'}},
        ]:
            with self.subTest(response=response), self.assertRaises(Rejected):
                exchange(self.request, encoded(response))

    # 验证危险、未审查或参数不符的方法既无派发许可也不能离线回放。
    def test_dangerous_or_unknown_method_params_are_not_replayed(self):
        for method, params in [
            ('pane.read', {'source': 'recent'}), ('pane.read', {'source': 'visible'}),
            ('pane.read', {'source': 'viewport'}), ('agent.read', {}),
            ('events.subscribe', {'subscriptions': []}), ('events.wait', {}),
            ('pane.send_input', {}), ('agent.prompt', {}), ('ping', {'unknown': True}),
            ('server.stop', {}), ('unknown.read', {}), ('ping', []),
        ]:
            with self.subTest(method=method, params=params):
                self.assertFalse(method_classification(method, params)['dispatch_allowed'])
                with self.assertRaises(Rejected):
                    exchange(encoded({'id': 'id', 'method': method, 'params': params}), None)

    # 验证 H1 条件实现和未核实快照均不能通过离线分类函数取得派发许可。
    def test_offline_classification_still_has_no_dispatch_permission(self):
        for method, reason in [('ping', 'offline_audit_has_no_execution_authority'),
                               ('session.snapshot', 'snapshot_side_effects_unverified')]:
            self.assertEqual(method_classification(method, {}), {'dispatch_allowed': False, 'reason': reason})

    # 验证 pong 和快照必须携带有效原生元数据，不能仅靠类型标签通过。
    def test_native_metadata_is_not_invented_from_type_tag(self):
        response = decode(self.response)
        for update in ({'protocol': True}, {'protocol': -1}, {'version': None}, {'capabilities': []}):
            changed = deepcopy(response)
            changed['result'].update(update)
            with self.subTest(update=update), self.assertRaisesRegex(Rejected, 'pong metadata'):
                exchange(self.request, encoded(changed))
        with self.assertRaisesRegex(Rejected, 'snapshot envelope'):
            exchange((FIXTURE / 'snapshot.request.jsonl').read_bytes(),
                     encoded({'id': 'synthetic-snapshot', 'result': {'type': 'session_snapshot'}}))

    # 验证调用者不能注入端点或认证字段，且请求标识必须有效。
    def test_caller_envelope_injection_and_invalid_id_rejected(self):
        request = decode(self.request)
        for update in ({'endpoint': '/other.sock'}, {'auth': 'fake'}, {'id': ''}, {'id': 1}):
            with self.subTest(update=update), self.assertRaises(Rejected):
                exchange(encoded({**request, **update}), None)

    # 验证缺失换行、多帧、超长和尾随数据被拒绝，并允许 CRLF。
    def test_json_line_boundaries(self):
        for raw in [self.request.rstrip(b'\n'), self.request * 2, b'\n', b'[]\n',
                    b' ' * MAX_LINE + self.request, b'{}\ntrailing']:
            with self.subTest(size=len(raw)), self.assertRaises(Rejected):
                frame(raw)
        self.assertEqual(frame(b'{"x":1}\r\n'), {'x': 1})

    # 验证重复键、非法编码、非有限数和过深结构均被拒绝。
    def test_ambiguous_invalid_or_excessive_json_rejected(self):
        for raw in [b'{"id":"a","id":"b"}', b'{"x":NaN}', b'{"x":1e999}',
                    b'"\xff"', b'"\\ud800"', b'{"\\udfff":1}', b'[' * 50 + b'0' + b']' * 50]:
            with self.subTest(raw=raw[:30]), self.assertRaises(Rejected):
                decode(raw)


class SchemaClosure(unittest.TestCase):
    # 验证离线跨文档标识与转义指针可解析，且结果明确未做参数验证。
    def test_local_and_offline_id_references(self):
        documents = {
            'root.json': document(**{'$id': 'urn:root', 'allOf': [{'$ref': 'urn:other#/$defs/a~1b'}]}),
            'other.json': document(**{'$id': 'urn:other', '$defs': {'a/b': {'type': 'string'}}}),
        }
        result = schema_closure(documents, 'root.json')
        self.assertEqual(result['documents'], 2)
        self.assertEqual(result['parameter_validation'], 'not_performed')

    # 验证自引用不会导致无限递归，检查结果仅表示引用闭包成立。
    def test_cycles_only_check_closure(self):
        self.assertEqual(schema_closure({'root': document(**{'$ref': '#'})}, 'root')['documents'], 1)

    # 验证远程、文件 URL 和缺失指针或锚点不会触发外部加载且均被拒绝。
    def test_missing_remote_and_file_references_fail_offline(self):
        for ref in ('https://example.invalid/remote.json', 'file:///etc/passwd', '#/$defs/missing', '#anchor'):
            with self.subTest(ref=ref), self.assertRaises(Rejected):
                schema_closure({'root': document(**{'$ref': ref})}, 'root')

    # 验证不支持的方言、动态引用、锚点及无效或重复标识均被拒绝。
    def test_dialects_ids_and_unsupported_ref_features_fail(self):
        for value in [
            {'$schema': 'http://json-schema.org/draft-07/schema#'},
            {'$schema': DIALECT, '$dynamicRef': '#'},
            {'$schema': DIALECT, '$recursiveRef': '#'},
            {'$schema': DIALECT, '$anchor': 'a'},
            {'$schema': DIALECT, '$defs': {'x': {'$id': 'urn:nested'}}},
            {'$schema': DIALECT, '$id': 'urn:x#fragment'},
        ]:
            with self.subTest(value=value), self.assertRaises(Rejected):
                schema_closure({'root': encoded(value)}, 'root')
        with self.assertRaises(Rejected):
            schema_closure({'a': document(**{'$id': 'same'}), 'b': document(**{'$id': 'same'})}, 'a')

    # 验证数组指针可定位 schema，而非法索引、转义或非 schema 目标被拒绝。
    def test_pointer_arrays_escapes_and_target_type(self):
        schema_closure({'root': document(**{'allOf': [True], '$ref': '#/allOf/0'})}, 'root')
        for ref in ('#/allOf/01', '#/allOf/2', '#/allOf/-', '#/name', '#/~2'):
            with self.subTest(ref=ref), self.assertRaises(Rejected):
                schema_closure({'root': document(**{'allOf': [True], 'name': 1, '$ref': ref})}, 'root')


class ReviewedRuntimePolicy(unittest.TestCase):
    # 复制固定方法策略，每个反例都不能改变原始 fixture。
    def setUp(self):
        self.policy = decode((ROOT / 'test/fixtures/herdr/0.9.5/method-policy.json').read_bytes())

    # 验证固定来源与版本对应实际安装 provenance，TS 运行时修订也同步维护。
    def test_fixed_identity_matches_provenance_and_runtime_revision(self):
        audit_method_policy(self.policy)
        record, = self.policy['production_allowlist']
        provenance = decode((ROOT / 'test/fixtures/herdr/0.9.5/provenance.json').read_bytes())
        for name in ('binary_sha256', 'schema_sha256'):
            self.assertEqual(record['source'][name], provenance[name])
        self.assertEqual(record['source']['binary_version'], provenance['version'])
        self.assertEqual(record['platform'], provenance['platform'])
        review = (ROOT / 'src/connector/herdr/review.ts').read_text()
        for name in ('adapter_revision', 'classification_revision'):
            self.assertIn(name + ": '" + record['source'][name] + "'", review)
        self.assertEqual(record['native_process_image_hash'], 'not_measured')
        self.assertFalse(method_classification(record['method'], record['params'])['dispatch_allowed'])

    # 验证方法、参数、平台、进程边界、来源摘要和修订都不能从 fixture 放宽。
    def test_each_runtime_scope_dimension_is_exact(self):
        for name, value in [('method', 'session.snapshot'), ('params', {'extra': True}),
                            ('platform', 'darwin-arm64'), ('profile', 'host'), ('validation', 'raw'),
                            ('instance_source', 'self_reported_pid'), ('required_runtime_checks', [])]:
            changed = deepcopy(self.policy)
            changed['production_allowlist'][0][name] = value
            with self.subTest(name=name), self.assertRaisesRegex(Rejected, 'production scope'):
                audit_method_policy(changed)
        for name, value in [('binary_sha256', 'a' * 64), ('schema_sha256', 'a' * 64),
                            ('binary_version', 'future'), ('adapter_revision', 'future'),
                            ('classification_revision', 'future')]:
            changed = deepcopy(self.policy)
            changed['production_allowlist'][0]['source'][name] = value
            with self.subTest(name=name), self.assertRaisesRegex(Rejected, 'production scope'):
                audit_method_policy(changed)
        self.policy['production_allowlist'].append(deepcopy(self.policy['production_allowlist'][0]))
        with self.assertRaisesRegex(Rejected, 'production scope'):
            audit_method_policy(self.policy)

    # 验证离线候选或所谓原生保证中的 true 不会变成执行许可。
    def test_replay_permission_and_native_guarantees_cannot_be_promoted(self):
        self.policy['offline_replay_candidates'][0]['dispatch_allowed'] = True
        with self.assertRaisesRegex(Rejected, 'replay cannot authorize'):
            audit_method_policy(self.policy)
        self.setUp()
        self.policy['guarantees']['cancel'] = 'available'
        with self.assertRaisesRegex(Rejected, 'guarantee promotion'):
            audit_method_policy(self.policy)
        self.assertEqual(reviewed_production_allowlist()[0]['params'], {})


class Archive(unittest.TestCase):
    # 复制合成 fixture 到私有临时输入目录，并加载可修改的清单。
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='rovloom-p0h-unit-')
        self.parent = Path(self.temp.name)
        self.root = self.parent / 'input'
        shutil.copytree(FIXTURE, self.root)
        self.root.chmod(0o700)
        self.manifest = json.loads((self.root / 'capture.json').read_text())

    # 清理本测试创建的输入和输出归档目录。
    def tearDown(self):
        self.temp.cleanup()

    # 把当前清单重新编码写入输入归档。
    def save(self):
        (self.root / 'capture.json').write_bytes(encoded(self.manifest))

    # 替换原始证据字节并同步清单哈希，用于构造内部一致的变更输入。
    def replace_raw(self, name, data):
        (self.root / name).write_bytes(data)
        self.manifest['files'][name] = sha(data)
        self.save()

    # 验证合成归档只获得离线通过结果，仍无原生认证或生产许可。
    def test_fixture_reports_only_offline_validation(self):
        result = audit(self.root)
        self.assertEqual(result['offline_audit'], 'passed')
        self.assertFalse(result['native_verified'])
        self.assertEqual(result['production_allowlist'], [])
        self.assertFalse(result['authorizes_dispatch'])
        self.assertEqual(result['reviewed_runtime_methods'], ['ping'])
        self.assertEqual(result['outcomes'], ['response', 'response', 'native_error', 'outcome_unknown', 'outcome_unknown'])
        self.assertIn('endpoint_and_peer', result['unverified'])

    # 验证自报证据类型不能把未核实采集提升为已认证原生证据。
    def test_self_reported_capture_cannot_promote_native_evidence(self):
        self.manifest['evidence_kind'] = 'unverified_capture'
        self.save()
        self.assertFalse(audit(self.root)['native_verified'])
        self.manifest['evidence_kind'] = 'native_verified'
        self.save()
        with self.assertRaises(Rejected):
            audit(self.root)

    # 验证观察原文可归档但自报可信声明无效，非法观察角色被拒绝。
    def test_raw_observations_are_archived_without_authenticating_their_claims(self):
        self.manifest['observations'] = [{'role': 'endpoint_peer', 'file': 'endpoint.json'}]
        self.replace_raw('endpoint.json', encoded({'source_verified': True, 'synthetic': True}))
        result = audit(self.root)
        self.assertEqual(result['observations_recorded_only'], 1)
        self.assertFalse(result['native_verified'])
        self.assertIn('endpoint_and_peer', result['unverified'])
        self.manifest['observations'][0]['role'] = 'permission'
        self.save()
        with self.assertRaisesRegex(Rejected, 'recorded observation'):
            audit(self.root)

    # 验证缺少精确条件的 fixture 不能开启许可，布尔自报授权同样拒绝。
    def test_allowlist_cannot_be_enabled_by_fixture(self):
        policy = self.parent / 'policy.json'
        policy.write_bytes(encoded({'production_allowlist': [{'method': 'ping', 'params': {}}]}))
        with patch('contract.POLICY', policy), self.assertRaises(Rejected):
            audit(self.root)
        value = decode((ROOT / 'test/fixtures/herdr/0.9.5/method-policy.json').read_bytes())
        value['authorizes_dispatch'] = True
        policy.write_bytes(encoded(value))
        with patch('contract.POLICY', policy), self.assertRaisesRegex(Rejected, 'authorize dispatch'):
            audit(self.root)

    # 验证每条交换记录的实例和契约各维度必须与归档绑定一致。
    def test_wrong_instance_and_each_contract_dimension(self):
        for field, value in [('instance', 'other'), ('binary_sha256', '1' * 64),
                             ('schema_sha256', '2' * 64), ('version', 'other'), ('protocol', 999)]:
            with self.subTest(field=field):
                changed = deepcopy(self.manifest)
                changed['exchanges'][0]['binding'][field] = value
                (self.root / 'capture.json').write_bytes(encoded(changed))
                with self.assertRaisesRegex(Rejected, 'instance or contract'):
                    audit(self.root)

    # 验证原始响应字节与清单哈希不一致时被拒绝。
    def test_raw_hash_mismatch(self):
        (self.root / 'ping.response.jsonl').write_bytes(b'{}\n')
        with self.assertRaisesRegex(Rejected, 'hash mismatch'):
            audit(self.root)

    # 验证绑定中的 schema 摘要必须匹配所保存的原始导出字节。
    def test_schema_hash_must_bind_raw_stdout(self):
        self.manifest['binding']['schema_sha256'] = '0' * 64
        self.save()
        with self.assertRaisesRegex(Rejected, 'schema hash'):
            audit(self.root)

    # 验证 ping 的版本和协议必须与归档记录的实例绑定一致。
    def test_ping_version_and_protocol_bind_recorded_instance(self):
        original = decode((self.root / 'ping.response.jsonl').read_bytes())
        for key, value in [('version', 'other'), ('protocol', 999)]:
            changed = deepcopy(original)
            changed['result'][key] = value
            self.replace_raw('ping.response.jsonl', encoded(changed))
            with self.subTest(key=key), self.assertRaisesRegex(Rejected, 'ping version or protocol'):
                audit(self.root)

    # 验证固定秘密哨兵出现在原始文件或清单时都会被拒绝。
    def test_fake_secret_in_raw_or_manifest(self):
        self.replace_raw('version.stderr', b'ROVLOOM_P0H_FAKE_SECRET')
        with self.assertRaisesRegex(Rejected, 'canary'):
            audit(self.root)
        self.replace_raw('version.stderr', b'')
        self.manifest['note'] = 'ROVLOOM_P0H_FAKE_SECRET'
        self.save()
        with self.assertRaisesRegex(Rejected, 'canary'):
            audit(self.root)

    # 验证额外未登记文件和清单列出但缺失的文件都会导致拒绝。
    def test_unlisted_or_missing_file(self):
        extra = self.root / 'extra'
        extra.write_bytes(b'not approved')
        with self.assertRaisesRegex(Rejected, 'inventory mismatch'):
            audit(self.root)
        extra.unlink()
        (self.root / 'version.stderr').unlink()
        with self.assertRaisesRegex(Rejected, 'inventory mismatch'):
            audit(self.root)

    # 验证越界路径、符号链接、硬链接和超限文件不能作为证据读取。
    def test_paths_links_and_large_files_rejected(self):
        for name in ('../outside', '/etc/passwd', 'a/../schema.json', 'a\\b', './schema.json'):
            with self.subTest(name=name), self.assertRaises(Rejected):
                read_file(self.root, name)
        outside = self.parent / 'outside'
        outside.write_bytes(b'not evidence')
        link = self.root / 'link'
        link.symlink_to(outside)
        with self.assertRaisesRegex(Rejected, 'symlink'):
            audit(self.root)
        link.unlink()
        os.link(outside, link)
        with self.assertRaisesRegex(Rejected, 'link or size'):
            read_file(self.root, 'link')
        link.unlink()
        with patch('contract.MAX_FILE', 16), self.assertRaises(Rejected):
            read_file(self.root, 'schema.json')

    # 验证 FIFO 不是普通证据文件，且经符号链接父路径访问的根目录被拒绝。
    def test_fifo_and_symlink_parent_are_rejected(self):
        fifo = self.root / 'fifo'
        os.mkfifo(fifo)
        with self.assertRaisesRegex(Rejected, 'regular artifact'):
            read_file(self.root, 'fifo')
        alias = self.parent / 'alias'
        alias.symlink_to(self.parent, target_is_directory=True)
        with self.assertRaisesRegex(Rejected, 'noncanonical'):
            audit(alias / 'input')

    # 验证归档中的 CLI 参数、退出码和版本原文必须符合记录约束。
    def test_cli_exit_version_and_termination_evidence(self):
        for key, field, value in [('version', 'exit_code', 1), ('schema_export', 'exit_code', -9),
                                  ('version', 'argv', ['herdr', 'status'])]:
            changed = deepcopy(self.manifest)
            changed[key][field] = value
            (self.root / 'capture.json').write_bytes(encoded(changed))
            with self.subTest(key=key, field=field), self.assertRaises(Rejected):
                audit(self.root)
        self.save()
        self.replace_raw('version.stdout', b'herdr different\n')
        with self.assertRaisesRegex(Rejected, 'version mismatch'):
            audit(self.root)

    # 验证 EOF 终止记录不能同时宣称已收到响应。
    def test_eof_cannot_also_contain_response(self):
        self.manifest['exchanges'][0]['termination'] = 'eof'
        self.save()
        with self.assertRaisesRegex(Rejected, 'termination/response'):
            audit(self.root)

    # 验证重复 schema 文档和未被任何记录引用的原始文件会被拒绝。
    def test_duplicate_and_unreferenced_schema_evidence(self):
        self.manifest['schema']['documents'] *= 2
        self.save()
        with self.assertRaisesRegex(Rejected, 'duplicate schema'):
            audit(self.root)
        self.manifest['schema']['documents'] = ['schema.json']
        self.replace_raw('unused.json', document())
        with self.assertRaisesRegex(Rejected, 'unreferenced'):
            audit(self.root)

    # 验证证据清单文件数量与总字节数限制均会执行。
    def test_inventory_and_total_limits(self):
        with patch('contract.MAX_FILES', 2), self.assertRaisesRegex(Rejected, 'inventory'):
            audit(self.root)
        with patch('contract.MAX_TOTAL', 10), self.assertRaisesRegex(Rejected, 'total size'):
            audit(self.root)

    # 验证归档逐字节保留证据并设置私有权限，过程中不启动进程或创建 socket。
    def test_collection_preserves_bytes_and_never_launches_or_connects(self):
        output = self.parent / 'collected'
        with patch('subprocess.Popen') as process, patch('socket.socket') as socket:
            result = collector.collect(self.root, output)
            process.assert_not_called()
            socket.assert_not_called()
        self.assertFalse(result['native_verified'])
        for source in self.root.iterdir():
            self.assertEqual(source.read_bytes(), (output / source.name).read_bytes())
            self.assertEqual((output / source.name).stat().st_mode & 0o777, 0o600)
        self.assertEqual(output.stat().st_mode & 0o777, 0o700)

    # 验证非私有输入、已有输出及位于输入或检出目录内的输出均被拒绝。
    def test_collection_rejects_unprivate_input_and_existing_or_nested_output(self):
        for output in (self.root, self.root / 'nested', ROOT / 'p0h-must-not-be-created'):
            with self.subTest(output=output), self.assertRaises(Rejected):
                collector.collect(self.root, output)
        self.root.chmod(0o755)
        output = self.parent / 'not-created'
        with self.assertRaisesRegex(Rejected, 'private owned'):
            collector.collect(self.root, output)
        self.assertFalse(output.exists())

    # 验证复制后复核失败会删除输出，同时保留可再次审计的输入。
    def test_collection_cleans_failed_copy_and_leaves_input(self):
        output = self.parent / 'failed'
        with patch('collect.audit', side_effect=[audit(self.root), Rejected('synthetic verification failure')]):
            with self.assertRaises(Rejected):
                collector.collect(self.root, output)
        self.assertFalse(output.exists())
        self.assertEqual(audit(self.root)['offline_audit'], 'passed')

    # 验证即使源变更后内部一致且总字节数不变，归档仍发现复制期间的替换。
    def test_collection_rejects_consistently_replaced_manifest(self):
        self.save()
        original = audit(self.root)
        output = self.parent / 'replaced'

        # 在首次输入审计时替换全部实例绑定但返回旧摘要，模拟一致性替换竞态。
        def changed_source(path):
            if path == self.root:
                self.manifest['binding']['instance'] = 'synthetic-herdr-b'
                for record in self.manifest['exchanges']:
                    record['binding']['instance'] = 'synthetic-herdr-b'
                self.save()
                self.assertEqual(audit(path)['bytes'], original['bytes'])
                return original
            return audit(path)

        with patch('collect.audit', side_effect=changed_source), self.assertRaisesRegex(Rejected, 'source changed'):
            collector.collect(self.root, output)
        self.assertFalse(output.exists())

    # 验证审计和归档 CLI 拒绝含秘密哨兵的输入时不会回显载荷或用户路径。
    def test_cli_rejection_does_not_print_payload_or_path(self):
        self.replace_raw('version.stderr', b'ROVLOOM_P0H_FAKE_SECRET')
        for script, arguments in [('audit.py', [str(self.root)]),
                                  ('collect.py', ['--input', str(self.root), '--output', str(self.parent / 'no')])]:
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/herdr' / script), *arguments],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn('ROVLOOM_P0H_FAKE_SECRET', result.stdout + result.stderr)
            self.assertNotIn(str(self.root), result.stdout + result.stderr)


class Rebuild(unittest.TestCase):
    # 为每个测试建立独立的离线状态重建模型。
    def setUp(self):
        self.model = StateRebuild()

    # 登记并确认指定订阅连接，使模型可开始快照读取。
    def ready(self, connection='sub-a'):
        self.model.subscribe(connection)
        self.model.acknowledge(connection)

    # 验证快照读取必须先确认订阅，并使用另一条连接。
    def test_ack_and_other_connection_are_required(self):
        with self.assertRaises(Rejected):
            self.model.acknowledge(None)
        self.model.subscribe('sub-a')
        with self.assertRaises(Rejected):
            self.model.begin_snapshot('read-a')
        self.model.acknowledge('sub-a')
        with self.assertRaises(Rejected):
            self.model.begin_snapshot('sub-a')

    # 验证快照深拷贝替换缓存，并仅承诺重建当前状态。
    def test_snapshot_replaces_cache_without_replaying_events(self):
        self.ready()
        ticket = self.model.begin_snapshot('read-a')
        first = {'panes': [{'id': 'old'}]}
        result = self.model.finish_snapshot(ticket, first)
        first['panes'].clear()
        self.assertEqual(self.model.cache, {'panes': [{'id': 'old'}]})
        self.assertEqual(result['guarantee'], 'state_rebuild_only')
        self.model.invalidate('sub-a')
        ticket = self.model.begin_snapshot('read-b')
        self.model.finish_snapshot(ticket, {'panes': []})
        self.assertEqual(self.model.cache, {'panes': []})

    # 验证快照读取必须串行，期间事件使完成结果要求再次刷新。
    def test_event_during_read_requires_serialized_second_refresh(self):
        self.ready()
        ticket = self.model.begin_snapshot('read-a')
        with self.assertRaises(Rejected):
            self.model.begin_snapshot('read-b')
        self.model.invalidate('sub-a')
        self.assertTrue(self.model.finish_snapshot(ticket, {'current': 1})['refresh_again'])
        ticket = self.model.begin_snapshot('read-b')
        self.assertFalse(self.model.finish_snapshot(ticket, {'current': 2})['refresh_again'])

    # 验证订阅缺口使在途票据失效，重新订阅后才能重建状态且保留缺口记录。
    def test_events_lost_or_eof_invalidates_inflight_and_requires_resubscription(self):
        self.ready()
        ticket = self.model.begin_snapshot('read-a')
        self.model.gap('sub-a')
        with self.assertRaises(Rejected):
            self.model.finish_snapshot(ticket, {'stale': True})
        with self.assertRaises(Rejected):
            self.model.begin_snapshot('read-b')
        self.ready('sub-b')
        ticket = self.model.begin_snapshot('read-b')
        result = self.model.finish_snapshot(ticket, {'rebuilt': True})
        self.assertTrue(result['gap_seen'])
        self.assertEqual(result['guarantee'], 'state_rebuild_only')

    # 验证其他连接的确认、事件、缺口以及过期读取票据均被拒绝。
    def test_wrong_connection_ack_event_and_stale_ticket_rejected(self):
        self.ready()
        for action in (lambda: self.model.acknowledge('other'), lambda: self.model.invalidate('other'),  # 两个回调分别模拟其他连接的订阅确认和事件失效通知。
                       lambda: self.model.gap('other'), lambda: self.model.finish_snapshot(object(), {})):  # 两个回调分别模拟其他连接的缺口通知和持无效票据的快照完成。
            with self.assertRaises(Rejected):
                action()
        self.model.gap('sub-a')
        with self.assertRaises(Rejected):
            self.model.subscribe('sub-a')
        with self.assertRaises(Rejected):
            self.model.invalidate('sub-a')


if __name__ == '__main__':
    unittest.main()
