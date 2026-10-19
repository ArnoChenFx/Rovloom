"""检查全量方法盘点的漏项、错误引用及保证越权；不执行 Herdr。"""

from copy import deepcopy
from pathlib import Path
import sys
import tempfile
import unittest

# 显式载入当前 checkout 的离线盘点工具，避免依赖外部安装。
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/herdr'))

from contract import Rejected
from audit_methods import FIXTURES, MATRIX, audit, methods, read_json


class MethodInventory(unittest.TestCase):
    """完整性审计必须拒绝漏方法、错 schema 根以及伪造支持范围。"""

    def setUp(self):
        """每个反例使用独立矩阵副本，保持仓库 fixture 不变。"""
        self.matrix = read_json(MATRIX)
        self.schema = read_json(FIXTURES / 'schema.json')
        self.provenance = read_json(FIXTURES / 'provenance.json')

    def checked(self, matrix=None, schema=None, tree=None):
        """调用真实审计入口，默认只读固定文件而不访问源码或实例。"""
        return audit(matrix or self.matrix, schema or self.schema, self.provenance, tree)

    def row(self, name):
        """按完整原生方法名称取得当前测试副本中的唯一条目。"""
        return next(row for row in self.matrix['methods'] if row['method'] == name)

    def test_all_native_methods_are_covered_without_execution_permission(self):
        """精确覆盖 102 个原生方法，离线审计不自报源码验真或执行许可。"""
        result = self.checked()
        self.assertEqual(result['method_count'], 102)
        self.assertEqual(sum(result['categories'].values()), 102)
        self.assertEqual(result['native_methods_executed'], 0)
        self.assertFalse(result['source_bytes_verified'])
        self.assertEqual(result['production_allowlist'], [])
        self.assertFalse(result['guarantees_promoted'])

    def test_missing_duplicate_or_new_schema_method_cannot_hide_in_counts(self):
        """删项、等长替换重复项及新增未知方法都不能伪装完整覆盖。"""
        changed = deepcopy(self.matrix)
        changed['methods'].pop()
        changed['method_count'] -= 1
        with self.assertRaisesRegex(Rejected, 'method count'):
            self.checked(matrix=changed)
        changed = deepcopy(self.matrix)
        changed['methods'][-1] = deepcopy(changed['methods'][0])
        with self.assertRaisesRegex(Rejected, 'coverage'):
            self.checked(matrix=changed)
        schema = deepcopy(self.schema)
        branch = deepcopy(schema['schemas']['request']['oneOf'][0])
        branch['properties']['method']['const'] = 'unknown.read'
        schema['schemas']['request']['oneOf'].append(branch)
        with self.assertRaisesRegex(Rejected, 'method count'):
            self.checked(schema=schema)

    def test_parameter_schema_cannot_point_to_another_method_or_be_copied(self):
        """同样是 EmptyParams 也须保留该方法原生分支，不能代入相邻方法。"""
        self.row('session.snapshot')['parameter_schema'] = self.row('ping')['parameter_schema']
        with self.assertRaisesRegex(Rejected, 'pointer mismatch'):
            self.checked()
        self.setUp()
        self.row('ping')['native_parameter_ref'] = {'type': 'object'}
        with self.assertRaisesRegex(Rejected, 'parameter reference'):
            self.checked()

    def test_duplicate_native_methods_are_rejected_before_matrix_comparison(self):
        """原生 schema 本身若重复方法，不允许用表格重复项补齐。"""
        schema = deepcopy(self.schema)
        schema['schemas']['request']['oneOf'].append(deepcopy(schema['schemas']['request']['oneOf'][0]))
        with self.assertRaisesRegex(Rejected, 'duplicate schema method'):
            methods(schema)

    def test_codec_support_and_passive_review_do_not_promote_production(self):
        """快照编解码不等于被动评审，ping 的本地评审也不自动授予派发。"""
        self.assertTrue(self.row('ping')['adapter_support']['local_passive_review'])
        self.assertTrue(self.row('session.snapshot')['adapter_support']['codec'])
        self.assertFalse(self.row('session.snapshot')['adapter_support']['local_passive_review'])
        for name, field in [('session.snapshot', 'local_passive_review'), ('events.subscribe', 'codec'),
                            ('ping', 'production_dispatch')]:
            with self.subTest(method=name, field=field):
                changed = deepcopy(self.matrix)
                row = next(row for row in changed['methods'] if row['method'] == name)
                row['adapter_support'][field] = True
                with self.assertRaisesRegex(Rejected, 'support or permission'):
                    self.checked(matrix=changed)
        self.matrix['production_allowlist'] = [{'method': 'ping', 'params': {}}]
        with self.assertRaisesRegex(Rejected, 'production permission'):
            self.checked()

    def test_stream_and_endpoint_transports_cannot_be_flattened(self):
        """事件流、SSH 注册连接和客户端专属命令均不得冒充普通一次响应。"""
        for name in ('events.subscribe', 'server.ssh_agent.register', 'client_shell.surface.set'):
            with self.subTest(method=name):
                changed = deepcopy(self.matrix)
                row = next(row for row in changed['methods'] if row['method'] == name)
                row['transport'] = 'json_socket_one_response_then_close'
                with self.assertRaisesRegex(Rejected, 'transport mismatch'):
                    self.checked(matrix=changed)

    def test_read_name_does_not_remove_side_effect_risk_or_add_guarantees(self):
        """读取前缀、prompt 状态或复制的 UHP 保证都不能放宽当前边界。"""
        self.row('pane.read')['risk_boundaries'] = []
        with self.assertRaisesRegex(Rejected, 'risk classification'):
            self.checked()
        self.setUp()
        self.row('agent.prompt')['unavailable_bridge_guarantees'].remove('run_correlated_prompt_completion')
        with self.assertRaisesRegex(Rejected, 'guarantee promotion'):
            self.checked()

    def test_missing_or_cross_method_source_anchors_are_rejected(self):
        """缺少分派引用或把别的方法声明指过来均无法通过离线核对。"""
        self.row('ping')['source_refs'].pop('transport_dispatch')
        with self.assertRaisesRegex(Rejected, 'dispatch evidence'):
            self.checked()
        self.setUp()
        self.row('ping')['source_refs']['declaration'] = self.row('session.snapshot')['source_refs']['declaration']
        with self.assertRaisesRegex(Rejected, 'declaration anchor'):
            self.checked()

    def test_supplied_source_tree_must_match_recorded_file_bytes(self):
        """提供源码目录时，改动的整文件摘要必须先于行号与覆盖再生校验被拒绝。"""
        first = next(iter(self.matrix['source_anchors']))
        relative = first.split('#', 1)[0]
        with tempfile.TemporaryDirectory(prefix='herdr-method-source-') as directory:
            path = Path(directory) / relative
            path.parent.mkdir(parents=True)
            path.write_text('// 合成变更；从不执行\n')
            with self.assertRaisesRegex(Rejected, 'source file hash'):
                self.checked(tree=Path(directory))


if __name__ == '__main__':
    unittest.main()
