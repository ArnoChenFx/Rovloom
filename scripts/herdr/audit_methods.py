"""离线核对固定 Herdr 方法覆盖；源码目录仅供读取，不连接或执行原生实例。"""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys

from contract import decode, require


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / 'test/fixtures/herdr/0.9.5'
MATRIX = FIXTURES / 'method-coverage.json'
COMMIT = '2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01'

# 这些分组是固定源码的风险盘点，不是逐参数安全证明或授权分类。
GROUPS = {
    'health': 'ping',
    'metadata_read': '''server.agent_manifests session.snapshot workspace.list workspace.get
        tab.list tab.get agent.list agent.get agent.explain pane.layout pane.process_info
        layout.export pane.neighbor pane.edges pane.list pane.current pane.get
        integration.list plugin.list plugin.action.list plugin.log.list''',
    'terminal_read': '''agent.read pane.read pane.selection.read pane.copy_motion
        pane.copy_search pane.link.resolve''',
    'organization_mutation': '''workspace.focus workspace.rename workspace.move workspace.move_block
        tab.focus tab.rename tab.move agent.rename agent.focus pane.swap pane.move pane.zoom
        layout.apply layout.set_split_ratio pane.focus_direction pane.resize pane.focus pane.rename''',
    'runtime_lifecycle': '''workspace.create workspace.close tab.create tab.close pane.split pane.close
        popup.close plugin.pane.open plugin.pane.close''',
    'server_lifecycle': 'server.stop server.live_handoff',
    'server_configuration': 'server.reload_config server.reload_agent_manifests',
    'credential_transport': 'server.ssh_agent.register',
    'presentation_mutation': '''notification.show product_announcement.dismiss release_notes.dismiss
        client.window_title.set client.window_title.clear client_shell.surface.set
        agent.view.set agent.view.clear plugin.pane.focus''',
    'authority_metadata': '''workspace.report_metadata pane.report_agent pane.report_agent_session
        pane.report_metadata pane.clear_agent_authority pane.release_agent''',
    'terminal_control': 'pane.scroll pane.clear pane.edit_scrollback pane.input.set',
    'terminal_input': 'agent.send_keys pane.send_text pane.send_keys pane.send_input',
    'agent_execution': 'agent.start agent.prompt',
    'generic_execution': 'command.invoke plugin.action.invoke pane.link.activate',
    'worktree_read': 'worktree.list',
    'worktree_mutation': 'worktree.create worktree.open worktree.remove',
    'integration_management': 'integration.install integration.uninstall',
    'plugin_management': 'plugin.link plugin.unlink plugin.enable plugin.disable',
    'event_subscription': 'events.subscribe',
    'condition_wait': 'events.wait agent.wait pane.wait_for_output',
}

# 风险列记录可能触及的边界；即使返回数据，也不能从方法名称推导被动性。
RISKS = {
    'health': ['connection_and_diagnostic_resources'],
    'metadata_read': ['sensitive_metadata', 'app_request_prelude_mutations'],
    'terminal_read': ['sensitive_terminal_content', 'parameter_dependent_read_effects', 'app_request_prelude_mutations'],
    'organization_mutation': ['focus_layout_or_labels', 'possible_terminal_resize_or_focus_signals'],
    'runtime_lifecycle': ['spawn_or_close_runtime_resources', 'possible_process_termination'],
    'server_lifecycle': ['session_server_availability', 'process_handoff_or_shutdown'],
    'server_configuration': ['configuration_or_detection_authority_change'],
    'credential_transport': ['ssh_agent_socket_access', 'connection_scoped_registration'],
    'presentation_mutation': ['client_or_app_presentation', 'possible_notification_or_sound'],
    'authority_metadata': ['agent_identity_or_metadata_authority', 'possible_detection_or_notification_change'],
    'terminal_control': ['viewport_scrollback_or_input_state', 'possible_editor_process_or_terminal_effect'],
    'terminal_input': ['pty_input', 'target_account_execution_authority'],
    'agent_execution': ['agent_process_or_prompt_submission', 'possible_model_provider_spend'],
    'generic_execution': ['configured_command_or_plugin_execution', 'target_account_execution_authority'],
    'worktree_read': ['filesystem_and_git_discovery', 'app_request_prelude_mutations'],
    'worktree_mutation': ['filesystem_or_git_mutation', 'workspace_creation_or_open'],
    'integration_management': ['integration_files_or_install_state'],
    'plugin_management': ['plugin_registry_or_activation', 'possible_plugin_runtime_effects'],
    'event_subscription': ['connection_and_event_buffer_resources', 'filter_dependent_app_probes', 'sensitive_event_payloads'],
    'condition_wait': ['connection_and_waiter_resources', 'repeated_app_or_terminal_probes', 'timeout_is_not_cancel'],
}

SLICES = {
    'H1': '固定来源、完整 schema、provider/Store 授权与精确 ping 只读接线',
    'H2': '逐参数状态读取与 App 前置副作用；附着 UI、标题、通知及 viewport 对照',
    'H3': '事件过滤、资源限额、gap/EOF 与独立快照重建；仅 state_rebuild_only',
    'H4': 'workspace/tab/pane 生命周期及布局、焦点操作的身份与授权',
    'H5': '终端输入和控制逐参数验收；读取不能代替写入身份保证',
    'H6': 'agent 启动、prompt 与等待；独立证明提交、状态和结果归属',
    'H7': 'worktree、integration、plugin 与配置命令的文件和执行权限',
    'H8': 'server 生命周期、客户端专属端点与凭据传输独立管理边界',
}
SLICE_FOR_GROUP = {
    'health': 'H1', 'metadata_read': 'H2', 'terminal_read': 'H2',
    'event_subscription': 'H3', 'condition_wait': 'H6',
    'organization_mutation': 'H4', 'runtime_lifecycle': 'H4', 'authority_metadata': 'H4',
    'terminal_control': 'H5', 'terminal_input': 'H5', 'agent_execution': 'H6',
    'generic_execution': 'H7', 'worktree_read': 'H7', 'worktree_mutation': 'H7',
    'integration_management': 'H7', 'plugin_management': 'H7',
    'server_configuration': 'H8', 'server_lifecycle': 'H8',
    'credential_transport': 'H8', 'presentation_mutation': 'H8',
}
# 按执行路径归属拆开等待和视图方法，避免把所有等待都归入 prompt 切片。
SLICE_OVERRIDES = {
    'events.wait': 'H3', 'pane.wait_for_output': 'H2',
    'agent.view.set': 'H4', 'agent.view.clear': 'H4', 'plugin.pane.focus': 'H4',
}
UNAVAILABLE = [
    'generic_cancel', 'terminal_atomic_identity_fence', 'run_correlated_prompt_completion',
    'event_snapshot_common_sequence', 'client_cursor_replay', 'uhp_compatibility',
]


def read_json(path):
    """严格读取本地 JSON，重复键等歧义一律拒绝。"""
    return decode(Path(path).read_bytes())


def digest(raw):
    """计算文件原文字节摘要，用于固定 schema 与源码来源。"""
    return hashlib.sha256(raw).hexdigest()


def pointer(document, reference):
    """只解析本文件 JSON Pointer，不下载引用也不复制参数定义。"""
    require(isinstance(reference, str) and reference.startswith('#/'), 'local schema pointer required')
    value = document
    for token in reference[2:].split('/'):
        require(not re.search(r'~(?![01])', token), 'invalid pointer escape')
        token = token.replace('~1', '/').replace('~0', '~')
        if isinstance(value, list):
            require(re.fullmatch(r'0|[1-9][0-9]*', token) and int(token) < len(value), 'missing schema pointer')
            value = value[int(token)]
        else:
            require(type(value) is dict and token in value, 'missing schema pointer')
            value = value[token]
    return value


def methods(schema):
    """从完整 request 根逐分支枚举原生方法，拒绝重复或未知参数引用形状。"""
    entries = []
    for index, branch in enumerate(schema['schemas']['request']['oneOf']):
        props = branch['properties']
        name = props['method']['const']
        require(isinstance(name, str) and set(props['params']) == {'$ref'}, 'unexpected native parameter shape')
        reference = props['params']['$ref']
        require(type(pointer(schema, reference)) is dict, 'parameter root is not a schema')
        entries.append((name, index, reference))
    require(len({name for name, _, _ in entries}) == len(entries), 'duplicate schema method')
    return entries


def categories():
    """把显式逐方法分组展开；遗漏或重复方法由后续完整性检查拒绝。"""
    result = {}
    for group, names in GROUPS.items():
        for name in names.split():
            require(name not in result, 'duplicate method classification')
            result[name] = group
    return result


def source_ref(tree, path, needle, anchors, sources, start=0):
    """在固定源码文件查找唯一语义锚点，记录真实行号与整文件摘要。"""
    raw = (tree / path).read_bytes()
    lines = raw.decode().splitlines()
    matches = [index for index, line in enumerate(lines) if index >= start and needle in line]
    require(matches, 'missing source anchor: ' + path + ': ' + needle)
    index = matches[0]
    key = path + '#L' + str(index + 1)
    anchors[key] = lines[index].strip()
    sources[path] = digest(raw)
    return key


def transport_for(name):
    """区分原生单次响应、等待、事件长连接和客户端专属命令通道。"""
    if name == 'events.subscribe':
        return 'json_socket_subscription_started_then_events_or_error_eof'
    if name == 'server.ssh_agent.register':
        return 'json_socket_ok_then_connection_scoped_registration'
    if name == 'client_shell.surface.set':
        return 'json_socket_rejected_client_shell_endpoint_only'
    if name in ('agent.prompt', 'agent.wait', 'events.wait', 'pane.wait_for_output'):
        return 'json_socket_one_response_optional_wait_or_disconnect'
    return 'json_socket_one_response_then_close'


def build(tree, schema, provenance):
    """只读遍历固定 schema 与源码分派生成能力矩阵；不执行任何原生方法。"""
    tree = Path(tree)
    require(digest((tree / 'docs/next/api/herdr-api.schema.json').read_bytes()) == provenance['schema_sha256'],
            'fixed source schema differs from installed fixture')
    entries, grouped = methods(schema), categories()
    require(set(grouped) == {name for name, _, _ in entries}, 'method classification coverage differs from schema')
    anchors, sources, rows = {}, {}, []
    declaration = (tree / 'src/api/schema.rs').read_text()
    variants = dict(re.findall(r'#\[serde\(rename = "([^"]+)"\)\]\s*(\w+)\(', declaration))
    require(set(variants) == set(grouped), 'source method declarations differ from schema')
    definitions = {}
    for path in sorted((tree / 'src/app').rglob('*.rs')):
        if '/tests/' in str(path):
            continue
        for match in re.finditer(r'\bfn (handle_\w+)\s*\(', path.read_text()):
            definitions.setdefault(match[1], path.relative_to(tree).as_posix())
    app_start = (tree / 'src/app/api.rs').read_text().splitlines().index(
        '    pub(crate) fn handle_api_request_after_internal_events_drained(')
    special = {
        'ping': ('src/api/server.rs', 'if matches!(&request.method, Method::Ping(_))'),
        'server.stop': ('src/api/server.rs', 'if matches!(&request.method, Method::ServerStop(_))'),
        'server.live_handoff': ('src/server/headless/lifecycle.rs', 'fn perform_live_handoff('),
        'server.ssh_agent.register': ('src/api/server.rs', 'Method::ServerSshAgentRegister(params) =>'),
        'server.reload_config': ('src/server/headless.rs', 'let report = self.reload_server_config(true);'),
        'notification.show': ('src/server/headless/notifications.rs', 'fn handle_notification_show_api('),
        'client.window_title.set': ('src/server/headless.rs', 'fn handle_client_window_title_api('),
        'client.window_title.clear': ('src/server/headless.rs', 'fn handle_client_window_title_api('),
        'client_shell.surface.set': ('src/server/headless/endpoint_requests.rs', 'Method::ClientShellSurfaceSet(params)'),
        'events.subscribe': ('src/api/server.rs', 'fn stream_subscriptions('),
        'events.wait': ('src/api/wait.rs', 'fn wait_for_event('),
        'agent.wait': ('src/api/wait.rs', 'fn wait_for_agent('),
        'pane.wait_for_output': ('src/api/wait.rs', 'fn wait_for_output('),
        'agent.prompt': ('src/app/api/agents.rs', 'fn handle_deferred_agent_api_request('),
    }
    for name, index, reference in entries:
        variant, group = variants[name], grouped[name]
        refs = {'declaration': source_ref(tree, 'src/api/schema.rs', variant + '(', anchors, sources)}
        if name in ('ping', 'server.stop', 'client_shell.surface.set'):
            refs['transport_dispatch'] = source_ref(tree, 'src/api/server.rs',
                                                    'if matches!(&request.method, Method::' + variant, anchors, sources)
        elif name in ('server.ssh_agent.register', 'events.subscribe', 'events.wait', 'agent.prompt', 'agent.wait', 'pane.wait_for_output'):
            refs['transport_dispatch'] = source_ref(tree, 'src/api/server.rs', 'Method::' + variant + '(params) =>', anchors, sources)
        else:
            refs['transport_dispatch'] = source_ref(tree, 'src/api/server.rs', 'dispatch_to_app(request, api_tx,', anchors, sources)
        if name.startswith('worktree.'):
            handler = ('src/app/api/worktrees/deferred.rs', 'fn handle_deferred_worktree_api_request(')
        elif name in special:
            handler = special[name]
        else:
            function = 'handle_' + name.replace('.', '_')
            handler = (definitions[function], 'fn ' + function + '(') if function in definitions else (
                'src/app/api.rs', 'Method::' + variant + '(')
        refs['implementation'] = source_ref(tree, *handler, anchors, sources,
                                           start=app_start if handler[0] == 'src/app/api.rs' else 0)
        if name.startswith('worktree.'):
            refs['deferred_dispatch'] = source_ref(tree, 'src/app/api/worktrees/deferred.rs',
                                                  'Method::' + variant + '(', anchors, sources)
        elif name not in special:
            refs['app_dispatch'] = source_ref(tree, 'src/app/api.rs', 'Method::' + variant + '(',
                                             anchors, sources, start=app_start)
        if group != 'health' and name not in ('events.subscribe', 'server.ssh_agent.register', 'client_shell.surface.set', 'server.stop'):
            refs['app_prelude'] = source_ref(tree, 'src/server/headless.rs',
                                            'fn handle_api_request_with_shutdown_check_inner(', anchors, sources)
        if name == 'events.subscribe':
            refs['filter_dispatch'] = source_ref(tree, 'src/api/subscriptions.rs', 'pub(super) fn new(', anchors, sources)
            refs['retained_history'] = source_ref(tree, 'src/api/subscriptions.rs', 'fn subscription_events_after(', anchors, sources)
        if name == 'agent.prompt':
            refs['wait_dispatch'] = source_ref(tree, 'src/api/wait.rs', 'fn prompt_agent(', anchors, sources)
        codec = name in ('ping', 'session.snapshot')
        rows.append({
            'method': name,
            'request_schema': 'schema.json#/schemas/request/oneOf/' + str(index),
            'parameter_schema': 'schema.json#/schemas/request/oneOf/' + str(index) + '/properties/params',
            'native_parameter_ref': reference,
            'source_refs': refs,
            'transport': transport_for(name),
            'risk_category': group,
            'risk_boundaries': RISKS[group],
            'review_scope': 'exact_empty_object' if name == 'ping' else 'requires_independent_method_and_params_review',
            'adapter_support': {'codec': codec, 'local_passive_review': name == 'ping',
                                'production_dispatch': False,
                                'status': 'codec_only_candidate' if codec else 'not_implemented'},
            'unavailable_bridge_guarantees': UNAVAILABLE,
            'next_slice': SLICE_OVERRIDES.get(name, SLICE_FOR_GROUP[group]),
        })
    return {
        'format': 1, 'runtime': 'herdr', 'version': provenance['version'],
        'protocol': provenance['protocol'], 'source_repository': 'herdrdev/herdr',
        'source_commit': COMMIT, 'source_base_url': 'https://github.com/herdrdev/herdr/blob/' + COMMIT + '/',
        'schema_file': 'schema.json', 'schema_sha256': provenance['schema_sha256'],
        'method_count': len(rows), 'production_allowlist': [],
        'scope': 'static capability and risk inventory; not native execution evidence or execution authorization',
        'sources_sha256': dict(sorted(sources.items())), 'source_anchors': dict(sorted(anchors.items())),
        'source_validation': 'audit --source-tree checks file bytes and exact line anchors; default audit is offline schema coverage only',
        'guarantee_scope': 'unavailable in the current bridge; native local identity checks, content revisions and method-specific acknowledgements are not interchangeable with these guarantees',
        'parameter_scope': 'original schema pointers only; source review and exact method+params evidence remain required',
        'transport_scope': 'local JSON socket; client_shell.surface.set is rejected there and handled on its separate client endpoint',
        'not_advertised_as_methods': ['agent.run', 'session.create', 'session.destroy', 'server.start', 'cancel'],
        'slices': SLICES, 'methods': rows,
    }


def audit(matrix, schema, provenance, tree=None):
    """核对完整覆盖、引用、拒绝边界和可选源码摘要，不把审计通过提升为产品许可。"""
    require(matrix['format'] == 1 and matrix['runtime'] == 'herdr', 'unsupported method matrix')
    require(matrix['source_commit'] == provenance['source_commit'] == COMMIT, 'source commit mismatch')
    require(matrix['source_repository'] == 'herdrdev/herdr' and matrix['source_base_url'] ==
            'https://github.com/herdrdev/herdr/blob/' + COMMIT + '/', 'source repository mismatch')
    require(matrix['version'] == provenance['version'] and matrix['protocol'] == provenance['protocol'], 'native version mismatch')
    require(matrix['schema_sha256'] == provenance['schema_sha256'], 'schema hash mismatch')
    require(matrix['production_allowlist'] == [], 'inventory cannot grant production permission')
    expected, grouped = methods(schema), categories()
    rows = matrix['methods']
    require(matrix['method_count'] == len(rows) == len(expected), 'method count mismatch')
    require([row['method'] for row in rows] == [entry[0] for entry in expected], 'method coverage or order mismatch')
    require(matrix['slices'] == SLICES, 'unknown implementation slices')
    for row, (name, index, reference) in zip(rows, expected):
        base = 'schema.json#/schemas/request/oneOf/' + str(index)
        require(row['request_schema'] == base and row['parameter_schema'] == base + '/properties/params', 'method schema pointer mismatch')
        require(row['native_parameter_ref'] == reference and pointer(schema, reference), 'native parameter reference mismatch')
        require(row['transport'] == transport_for(name), 'native transport mismatch')
        group = grouped[name]
        require(row['risk_category'] == group and row['risk_boundaries'] == RISKS[group], 'risk classification mismatch')
        require(row['next_slice'] == SLICE_OVERRIDES.get(name, SLICE_FOR_GROUP[group]), 'implementation slice mismatch')
        require(row['review_scope'] == ('exact_empty_object' if name == 'ping' else 'requires_independent_method_and_params_review'), 'review scope broadened')
        require(row['adapter_support'] == {'codec': name in ('ping', 'session.snapshot'),
                'local_passive_review': name == 'ping', 'production_dispatch': False,
                'status': 'codec_only_candidate' if name in ('ping', 'session.snapshot') else 'not_implemented'},
                'inventory adapter support or permission broadened')
        require(row['unavailable_bridge_guarantees'] == UNAVAILABLE, 'unsupported guarantee promotion')
        require({'declaration', 'transport_dispatch', 'implementation'} <= set(row['source_refs']), 'missing source dispatch evidence')
        for key in row['source_refs'].values():
            require(key in matrix['source_anchors'], 'missing source anchor')
        variant = ''.join(part[0].upper() + part[1:] for part in re.split(r'[._]', name))
        require(matrix['source_anchors'][row['source_refs']['declaration']].startswith(variant + '('),
                'method declaration anchor mismatch')
    for path, value in matrix['sources_sha256'].items():
        require(re.fullmatch(r'src/[a-zA-Z0-9_/.-]+\.rs', path) and '..' not in PurePosixPath(path).parts and
                isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value), 'invalid source hash record')
    for key, anchor in matrix['source_anchors'].items():
        match = re.fullmatch(r'(src/[a-zA-Z0-9_/.-]+\.rs)#L([1-9][0-9]*)', key)
        require(match and type(anchor) is str and anchor, 'invalid source reference')
        path, line = match[1], int(match[2])
        require('..' not in PurePosixPath(path).parts and path in matrix['sources_sha256'], 'source outside reviewed set')
        if tree is not None:
            raw = (Path(tree) / path).read_bytes()
            require(digest(raw) == matrix['sources_sha256'][path], 'source file hash mismatch')
            lines = raw.decode().splitlines()
            require(line <= len(lines) and lines[line-1].strip() == anchor, 'source line anchor mismatch')
    if tree is not None:
        require(matrix == build(tree, schema, provenance), 'matrix differs from fixed source traversal')
    return {'method_count': len(rows), 'categories': dict(sorted(Counter(row['risk_category'] for row in rows).items())),
            'source_bytes_verified': tree is not None, 'native_methods_executed': 0,
            'production_allowlist': [], 'guarantees_promoted': False}


def main():
    """提供默认只读审计，以及显式源码目录下的确定性矩阵重建入口。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-tree', type=Path)
    parser.add_argument('--write', action='store_true', help='只重写固定 method-coverage.json；需要 --source-tree')
    args = parser.parse_args()
    try:
        provenance = read_json(FIXTURES / 'provenance.json')
        raw = (FIXTURES / 'schema.json').read_bytes()
        require(digest(raw) == provenance['schema_sha256'], 'installed fixture schema hash mismatch')
        schema = decode(raw)
        if args.write:
            require(args.source_tree is not None, 'source tree required for generation')
            matrix = build(args.source_tree, schema, provenance)
            audit(matrix, schema, provenance, args.source_tree)
            MATRIX.write_text(json.dumps(matrix, ensure_ascii=False, indent=2) + '\n')
        else:
            matrix = read_json(MATRIX)
        print(json.dumps(audit(matrix, schema, provenance, args.source_tree), ensure_ascii=False))
        return 0
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({'method_audit': 'rejected', 'error_type': type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
