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

import collect as collector
from contract import (
    audit, decode, DIALECT, exchange, frame, MAX_LINE, method_classification,
    read_file, Rejected, ROOT, schema_closure, sha, StateRebuild,
)


FIXTURE = ROOT / 'fixtures/p0h/synthetic'


def encoded(value):
    return (json.dumps(value, separators=(',', ':')) + '\n').encode()


def document(**values):
    return encoded({'$schema': DIALECT, **values})


class NativeFrames(unittest.TestCase):
    def setUp(self):
        self.request = (FIXTURE / 'ping.request.jsonl').read_bytes()
        self.response = (FIXTURE / 'ping.response.jsonl').read_bytes()

    def test_preserves_native_unknown_values(self):
        raw = b'{ "id":"synthetic-ping", "result":{"type":"pong","version":"synthetic","protocol":22,"extra":{"x":[1,null,true]}} }\n'
        result = exchange(self.request, raw)
        self.assertEqual(result['response']['result']['extra'], {'x': [1, None, True]})
        self.assertEqual(result['response'], decode(raw))

    def test_preserves_native_error(self):
        result = exchange((FIXTURE / 'snapshot.request.jsonl').read_bytes(),
                          (FIXTURE / 'snapshot.error.jsonl').read_bytes())
        self.assertEqual(result['outcome'], 'native_error')
        self.assertEqual(result['response']['error']['details'], {'unmodified': True})

    def test_absent_reply_is_unknown(self):
        result = exchange(self.request, None)
        self.assertEqual(result['outcome'], 'outcome_unknown')
        self.assertIsNone(result['response'])

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

    def test_candidates_still_have_no_dispatch_permission(self):
        for method in ('ping', 'session.snapshot'):
            self.assertEqual(method_classification(method, {}), {
                'dispatch_allowed': False, 'reason': 'research_candidate_without_native_side_effect_evidence',
            })

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

    def test_caller_envelope_injection_and_invalid_id_rejected(self):
        request = decode(self.request)
        for update in ({'endpoint': '/other.sock'}, {'auth': 'fake'}, {'id': ''}, {'id': 1}):
            with self.subTest(update=update), self.assertRaises(Rejected):
                exchange(encoded({**request, **update}), None)

    def test_json_line_boundaries(self):
        for raw in [self.request.rstrip(b'\n'), self.request * 2, b'\n', b'[]\n',
                    b' ' * MAX_LINE + self.request, b'{}\ntrailing']:
            with self.subTest(size=len(raw)), self.assertRaises(Rejected):
                frame(raw)
        self.assertEqual(frame(b'{"x":1}\r\n'), {'x': 1})

    def test_ambiguous_invalid_or_excessive_json_rejected(self):
        for raw in [b'{"id":"a","id":"b"}', b'{"x":NaN}', b'{"x":1e999}',
                    b'"\xff"', b'"\\ud800"', b'{"\\udfff":1}', b'[' * 50 + b'0' + b']' * 50]:
            with self.subTest(raw=raw[:30]), self.assertRaises(Rejected):
                decode(raw)


class SchemaClosure(unittest.TestCase):
    def test_local_and_offline_id_references(self):
        documents = {
            'root.json': document(**{'$id': 'urn:root', 'allOf': [{'$ref': 'urn:other#/$defs/a~1b'}]}),
            'other.json': document(**{'$id': 'urn:other', '$defs': {'a/b': {'type': 'string'}}}),
        }
        result = schema_closure(documents, 'root.json')
        self.assertEqual(result['documents'], 2)
        self.assertEqual(result['parameter_validation'], 'not_performed')

    def test_cycles_only_check_closure(self):
        self.assertEqual(schema_closure({'root': document(**{'$ref': '#'})}, 'root')['documents'], 1)

    def test_missing_remote_and_file_references_fail_offline(self):
        for ref in ('https://example.invalid/remote.json', 'file:///etc/passwd', '#/$defs/missing', '#anchor'):
            with self.subTest(ref=ref), self.assertRaises(Rejected):
                schema_closure({'root': document(**{'$ref': ref})}, 'root')

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

    def test_pointer_arrays_escapes_and_target_type(self):
        schema_closure({'root': document(**{'allOf': [True], '$ref': '#/allOf/0'})}, 'root')
        for ref in ('#/allOf/01', '#/allOf/2', '#/allOf/-', '#/name', '#/~2'):
            with self.subTest(ref=ref), self.assertRaises(Rejected):
                schema_closure({'root': document(**{'allOf': [True], 'name': 1, '$ref': ref})}, 'root')


class Archive(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='rovloom-p0h-unit-')
        self.parent = Path(self.temp.name)
        self.root = self.parent / 'input'
        shutil.copytree(FIXTURE, self.root)
        self.root.chmod(0o700)
        self.manifest = json.loads((self.root / 'capture.json').read_text())

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        (self.root / 'capture.json').write_bytes(encoded(self.manifest))

    def replace_raw(self, name, data):
        (self.root / name).write_bytes(data)
        self.manifest['files'][name] = sha(data)
        self.save()

    def test_fixture_reports_only_offline_validation(self):
        result = audit(self.root)
        self.assertEqual(result['offline_audit'], 'passed')
        self.assertFalse(result['native_verified'])
        self.assertEqual(result['production_allowlist'], [])
        self.assertEqual(result['outcomes'], ['response', 'response', 'native_error', 'outcome_unknown', 'outcome_unknown'])
        self.assertIn('endpoint_and_peer', result['unverified'])

    def test_self_reported_capture_cannot_promote_native_evidence(self):
        self.manifest['evidence_kind'] = 'unverified_capture'
        self.save()
        self.assertFalse(audit(self.root)['native_verified'])
        self.manifest['evidence_kind'] = 'native_verified'
        self.save()
        with self.assertRaises(Rejected):
            audit(self.root)

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

    def test_allowlist_cannot_be_enabled_by_fixture(self):
        policy = self.parent / 'policy.json'
        policy.write_bytes(encoded({'production_allowlist': [{'method': 'ping', 'params': {}}]}))
        with patch('contract.POLICY', policy), self.assertRaisesRegex(Rejected, 'native gate'):
            audit(self.root)

    def test_wrong_instance_and_each_contract_dimension(self):
        for field, value in [('instance', 'other'), ('binary_sha256', '1' * 64),
                             ('schema_sha256', '2' * 64), ('version', 'other'), ('protocol', 999)]:
            with self.subTest(field=field):
                changed = deepcopy(self.manifest)
                changed['exchanges'][0]['binding'][field] = value
                (self.root / 'capture.json').write_bytes(encoded(changed))
                with self.assertRaisesRegex(Rejected, 'instance or contract'):
                    audit(self.root)

    def test_raw_hash_mismatch(self):
        (self.root / 'ping.response.jsonl').write_bytes(b'{}\n')
        with self.assertRaisesRegex(Rejected, 'hash mismatch'):
            audit(self.root)

    def test_schema_hash_must_bind_raw_stdout(self):
        self.manifest['binding']['schema_sha256'] = '0' * 64
        self.save()
        with self.assertRaisesRegex(Rejected, 'schema hash'):
            audit(self.root)

    def test_ping_version_and_protocol_bind_recorded_instance(self):
        original = decode((self.root / 'ping.response.jsonl').read_bytes())
        for key, value in [('version', 'other'), ('protocol', 999)]:
            changed = deepcopy(original)
            changed['result'][key] = value
            self.replace_raw('ping.response.jsonl', encoded(changed))
            with self.subTest(key=key), self.assertRaisesRegex(Rejected, 'ping version or protocol'):
                audit(self.root)

    def test_fake_secret_in_raw_or_manifest(self):
        self.replace_raw('version.stderr', b'ROVLOOM_P0H_FAKE_SECRET')
        with self.assertRaisesRegex(Rejected, 'canary'):
            audit(self.root)
        self.replace_raw('version.stderr', b'')
        self.manifest['note'] = 'ROVLOOM_P0H_FAKE_SECRET'
        self.save()
        with self.assertRaisesRegex(Rejected, 'canary'):
            audit(self.root)

    def test_unlisted_or_missing_file(self):
        extra = self.root / 'extra'
        extra.write_bytes(b'not approved')
        with self.assertRaisesRegex(Rejected, 'inventory mismatch'):
            audit(self.root)
        extra.unlink()
        (self.root / 'version.stderr').unlink()
        with self.assertRaisesRegex(Rejected, 'inventory mismatch'):
            audit(self.root)

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

    def test_fifo_and_symlink_parent_are_rejected(self):
        fifo = self.root / 'fifo'
        os.mkfifo(fifo)
        with self.assertRaisesRegex(Rejected, 'regular artifact'):
            read_file(self.root, 'fifo')
        alias = self.parent / 'alias'
        alias.symlink_to(self.parent, target_is_directory=True)
        with self.assertRaisesRegex(Rejected, 'noncanonical'):
            audit(alias / 'input')

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

    def test_eof_cannot_also_contain_response(self):
        self.manifest['exchanges'][0]['termination'] = 'eof'
        self.save()
        with self.assertRaisesRegex(Rejected, 'termination/response'):
            audit(self.root)

    def test_duplicate_and_unreferenced_schema_evidence(self):
        self.manifest['schema']['documents'] *= 2
        self.save()
        with self.assertRaisesRegex(Rejected, 'duplicate schema'):
            audit(self.root)
        self.manifest['schema']['documents'] = ['schema.json']
        self.replace_raw('unused.json', document())
        with self.assertRaisesRegex(Rejected, 'unreferenced'):
            audit(self.root)

    def test_inventory_and_total_limits(self):
        with patch('contract.MAX_FILES', 2), self.assertRaisesRegex(Rejected, 'inventory'):
            audit(self.root)
        with patch('contract.MAX_TOTAL', 10), self.assertRaisesRegex(Rejected, 'total size'):
            audit(self.root)

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

    def test_collection_rejects_unprivate_input_and_existing_or_nested_output(self):
        for output in (self.root, self.root / 'nested', ROOT / 'p0h-must-not-be-created'):
            with self.subTest(output=output), self.assertRaises(Rejected):
                collector.collect(self.root, output)
        self.root.chmod(0o755)
        output = self.parent / 'not-created'
        with self.assertRaisesRegex(Rejected, 'private owned'):
            collector.collect(self.root, output)
        self.assertFalse(output.exists())

    def test_collection_cleans_failed_copy_and_leaves_input(self):
        output = self.parent / 'failed'
        with patch('collect.audit', side_effect=[audit(self.root), Rejected('synthetic verification failure')]):
            with self.assertRaises(Rejected):
                collector.collect(self.root, output)
        self.assertFalse(output.exists())
        self.assertEqual(audit(self.root)['offline_audit'], 'passed')

    def test_collection_rejects_consistently_replaced_manifest(self):
        self.save()
        original = audit(self.root)
        output = self.parent / 'replaced'

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

    def test_cli_rejection_does_not_print_payload_or_path(self):
        self.replace_raw('version.stderr', b'ROVLOOM_P0H_FAKE_SECRET')
        for script, arguments in [('audit.py', [str(self.root)]),
                                  ('collect.py', ['--input', str(self.root), '--output', str(self.parent / 'no')])]:
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/p0h' / script), *arguments],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn('ROVLOOM_P0H_FAKE_SECRET', result.stdout + result.stderr)
            self.assertNotIn(str(self.root), result.stdout + result.stderr)


class Rebuild(unittest.TestCase):
    def setUp(self):
        self.model = StateRebuild()

    def ready(self, connection='sub-a'):
        self.model.subscribe(connection)
        self.model.acknowledge(connection)

    def test_ack_and_other_connection_are_required(self):
        with self.assertRaises(Rejected):
            self.model.acknowledge(None)
        self.model.subscribe('sub-a')
        with self.assertRaises(Rejected):
            self.model.begin_snapshot('read-a')
        self.model.acknowledge('sub-a')
        with self.assertRaises(Rejected):
            self.model.begin_snapshot('sub-a')

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

    def test_event_during_read_requires_serialized_second_refresh(self):
        self.ready()
        ticket = self.model.begin_snapshot('read-a')
        with self.assertRaises(Rejected):
            self.model.begin_snapshot('read-b')
        self.model.invalidate('sub-a')
        self.assertTrue(self.model.finish_snapshot(ticket, {'current': 1})['refresh_again'])
        ticket = self.model.begin_snapshot('read-b')
        self.assertFalse(self.model.finish_snapshot(ticket, {'current': 2})['refresh_again'])

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

    def test_wrong_connection_ack_event_and_stale_ticket_rejected(self):
        self.ready()
        for action in (lambda: self.model.acknowledge('other'), lambda: self.model.invalidate('other'),
                       lambda: self.model.gap('other'), lambda: self.model.finish_snapshot(object(), {})):
            with self.assertRaises(Rejected):
                action()
        self.model.gap('sub-a')
        with self.assertRaises(Rejected):
            self.model.subscribe('sub-a')
        with self.assertRaises(Rejected):
            self.model.invalidate('sub-a')


if __name__ == '__main__':
    unittest.main()
