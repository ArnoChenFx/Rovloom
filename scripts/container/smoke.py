#!/usr/bin/env python3
# 在无外网的自有容器和命名卷验收真实Gateway；不创建外部身份、原生实例或模型工作。
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import re
import subprocess
import time
import uuid


# 子命令输出只供断言；失败不转发配置、数据库或角色日志。
def command(*args, timeout=30):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('container_command_failed: ' + args[0])
    return result.stdout.strip()


# 每次读取真实Docker状态；不把启动成功、进程存在或401单独称为完整产品验收。
def healthy(name):
    end = time.monotonic() + 35
    while time.monotonic() < end:
        state = json.loads(command('inspect', '--format', '{{json .State}}', name))
        if not state['Running']:
            raise RuntimeError('container_gateway_exited')
        if state.get('Health', {}).get('Status') == 'healthy':
            return
        time.sleep(0.2)
    raise RuntimeError('container_health_timeout')


# 仅访问本容器回环MCP和管理页；所有输出留在本测试进程内存。
def check_gateway(name):
    assert command('exec', name, 'id', '-u') == '10001'
    assert command('exec', name, 'stat', '-c', '%a:%u', '/home/rovloom/.config/rovloom/gateway.json') == '600:10001'
    html = command('exec', name, 'curl', '--noproxy', '*', '--fail', '--silent', 'http://127.0.0.1:9445/')
    assert 'browser.js' in html and 'manage.css' in html
    assert 'rovloom-management-bootstrap' not in html
    for resource in ['browser.js', 'theme.js', 'manage.css', 'rovloom-mark-orange.png', 'rovloom-logo.png']:
        command('exec', name, 'curl', '--noproxy', '*', '--fail', '--silent', '--output', '/dev/null',
                'http://127.0.0.1:9445/' + resource)
    command('exec', name, 'test', '-s', '/home/rovloom/.local/share/rovloom/gateway/gateway.db')
    config = command('exec', name, 'cat', '/home/rovloom/.config/rovloom/gateway.json')
    parsed = json.loads(config)
    assert parsed['data']['directory'] == '/home/rovloom/.local/share/rovloom/gateway'
    assert 'authentication_ref' not in parsed and 'tls' not in config
    # 无TTY运行不能创建首次初始化计划、身份或provider授权；只检查自有临时卷的程序管理目录。
    managed = '/home/rovloom/.local/share/rovloom/gateway/managed'
    assert command('exec', name, 'find', managed, '-mindepth', '1', '-maxdepth', '1', '-printf', 'x') == ''
    return hashlib.sha256(config.encode()).hexdigest()


# 每个名称都由本进程随机生成；finally只删除自己创建的容器和卷。
def smoke(image, sha256, version):
    assert re.fullmatch(r'[0-9a-f]{64}', sha256)
    suffix = uuid.uuid4().hex
    name = 'rovloom-container-smoke-' + suffix
    config_volume = name + '-config'
    data_volume = name + '-data'
    made_volumes = []
    created = False
    try:
        for volume in [config_volume, data_volume]:
            command('volume', 'create', volume)
            made_volumes.append(volume)
        command('create', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
                '--mount', 'type=volume,source=' + config_volume + ',target=/home/rovloom/.config/rovloom',
                '--mount', 'type=volume,source=' + data_volume + ',target=/home/rovloom/.local/share/rovloom', image)
        created = True
        assert command('inspect', '--format', '{{.Config.User}}', name) == '10001:10001'
        assert command('inspect', '--format', '{{.Config.Tty}}:{{.Config.OpenStdin}}', name) == 'false:false'
        # 仅以Docker exec读取准确字节摘要；版本使用同一个已编译产品的固定诊断通道。
        command('start', name)
        healthy(name)
        assert command('exec', name, 'sha256sum', '/usr/local/bin/rovloom').split()[0] == sha256
        result = subprocess.run(['docker', 'exec', name, '/usr/local/bin/rovloom', '--version'],
                                capture_output=True, text=True, timeout=5)
        assert result.returncode == 0 and result.stdout == '' and result.stderr == 'Rovloom ' + version + '\n'
        before = check_gateway(name)
        command('exec', name, 'sh', '-c', 'printf fixture > /home/rovloom/.local/share/rovloom/.container-smoke-marker')
        command('stop', '--time', '10', name, timeout=15)
        assert command('inspect', '--format', '{{.State.ExitCode}}:{{.State.OOMKilled}}', name) == '0:false'
        command('start', name)
        healthy(name)
        assert check_gateway(name) == before
        assert command('exec', name, 'cat', '/home/rovloom/.local/share/rovloom/.container-smoke-marker') == 'fixture'
        command('stop', '--time', '10', name, timeout=15)
        assert command('inspect', '--format', '{{.State.ExitCode}}:{{.State.OOMKilled}}', name) == '0:false'
        # 日志不打印或保存，且只接受未配对的固定诊断，不接受配置/凭据泄漏。
        logs = subprocess.run(['docker', 'logs', name], capture_output=True, text=True, timeout=5)
        expected_diagnostic = ('gateway_listening http://127.0.0.1:9444/mcp\npairing_required\n'
                               'Gateway is running; complete local pairing and native setup before using an Agent.\n'
                               'Gateway 已启动；使用 Agent 前仍需完成本地配对和原生初始化。\n')
        assert logs.returncode == 0 and logs.stdout == '' and logs.stderr == expected_diagnostic * 2
        return {'scope': 'native-linux-container', 'user': 10001, 'binary': 'exact', 'gateway': 'unpaired',
                'mcpAuthentication': 'required', 'embeddedWebui': 'pass', 'persistentVolumes': 'pass',
                'gracefulRestart': 'pass', 'nativeProviderExecution': 'not-exercised'}
    finally:
        if created:
            command('rm', '--force', name)
        for volume in reversed(made_volumes):
            command('volume', 'rm', volume)


# 真实Compose路径仅在rootful原生Linux Engine验收；临时项目和卷不触及用户部署。
def compose_smoke(image, sha256, compose_path):
    security = json.loads(command('info', '--format', '{{json .SecurityOptions}}'))
    assert not any('rootless' in option for option in security)
    project = 'rovloom-compose-smoke-' + uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix='rovloom-compose-fixture-') as temporary:
        override = Path(temporary) / 'override.json'
        override.write_text(json.dumps({'services': {'gateway': {'image': image, 'pull_policy': 'never',
                                                               'restart': 'no'}}}))

        # 固定维护文件加本例唯一image override；不接受用户配置或任意shell内容。
        def compose(*arguments, timeout=30):
            return command('compose', '--project-name', project, '--file', str(Path(compose_path).resolve()),
                           '--file', str(override), *arguments, timeout=timeout)

        try:
            compose('up', '--detach', timeout=45)
            container = compose('ps', '--all', '--quiet', 'gateway')
            assert re.fullmatch(r'[0-9a-f]{64}', container)
            assert command('inspect', '--format', '{{.HostConfig.NetworkMode}}', container) == 'host'
            healthy(container)
            check_gateway(container)
            assert command('exec', container, 'sha256sum', '/usr/local/bin/rovloom').split()[0] == sha256
            compose('stop', '--timeout', '10', timeout=15)
            assert command('inspect', '--format', '{{.State.ExitCode}}:{{.State.OOMKilled}}', container) == '0:false'
            return {'scope': 'native-rootful-linux-compose', 'gateway': 'unpaired', 'hostLoopback': 'pass',
                    'persistentVolumes': 'pass', 'gracefulShutdown': 'pass'}
        finally:
            compose('down', '--volumes', '--remove-orphans', timeout=30)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image')
    parser.add_argument('sha256')
    parser.add_argument('version')
    parser.add_argument('--compose')
    args = parser.parse_args()
    print(json.dumps(smoke(args.image, args.sha256, args.version)))
    if args.compose:
        print(json.dumps(compose_smoke(args.image, args.sha256, args.compose)))
