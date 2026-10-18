#!/usr/bin/env python3
"""用 Bun 重放 issue #15 的独立原生记录；不启动 Luvus。"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bun', default=shutil.which('bun'))
    args = parser.parse_args()
    if not args.bun:
        raise SystemExit('Bun 1.4.3 required')
    repo = Path(__file__).resolve().parents[2]
    archive = repo / 'fixtures/bun/native-evidence.tar.gz'
    archive_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
    if archive_hash != '71c38aa6ce308cb71fe02746a8380034e2869b75d82c8c288edefd3b4935cc41':
        raise RuntimeError('native archive changed')
    with tempfile.TemporaryDirectory(prefix='luvus-bun-native-replay-') as temporary:
        root = Path(temporary)
        with tarfile.open(archive, 'r:gz') as source:
            for member in source:
                if not member.isfile() or member.name.count('/') != 1 or not member.name.startswith('native/') or member.size > 2_000_000:
                    raise RuntimeError('unexpected archive member')
                (root / Path(member.name).name).write_bytes(source.extractfile(member).read())
        code = 'import {inspectFixtures} from "./scripts/p0/audit-fixtures.mjs"; console.log(JSON.stringify(inspectFixtures(process.argv[1])))'
        result = subprocess.run([args.bun, '--no-env-file', '-e', code, str(root)],
                                cwd=repo, capture_output=True, text=True, timeout=30, check=True)
        assertions = json.loads((root / 'assertions.json').read_text())
        environment = json.loads((root / 'environment.json').read_text())
        report = {'archiveSha256': archive_hash, 'runtime': 'Bun 1.4.3',
                  'nativeBinarySha256': environment['binary_sha256'],
                  'nativeStartedAt': environment['started_at'],
                  'harnessBaseCommit': '4f963d1997751a4f392604cc060d0a99f157998a',
                  'collectorHistoricalBaseField': environment['base_commit'],
                  'assertions': len(assertions), 'allPassed': all(item['passed'] for item in assertions),
                  'wireValidation': json.loads(result.stdout), 'cleanup': environment['cleanup'],
                  'scope': 'new isolated Linux Luvus 0.14.3 instance/session; synthetic terminal input only; no Gateway/Connector claim'}
        print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
