#!/usr/bin/env python3
"""Package the clean chatgpt branch without replacing the earlier download ZIPs."""
from pathlib import Path
import hashlib
import json
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'artifacts' / 'chatgpt'


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT).decode().strip()


def build(name, entries):
    path = OUT / name
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
        for source, destination in entries:
            archive.write(source, destination)
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        assert set(archive.namelist()) == {destination for _, destination in entries}
        for source, destination in entries:
            assert archive.read(destination) == source.read_bytes(), destination
    return {'path':str(path), 'files':len(entries), 'bytes':path.stat().st_size,
            'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}


def main():
    if git('branch', '--show-current') != 'chatgpt':
        raise SystemExit('This builder is for the local chatgpt branch.')
    if git('status', '--porcelain'):
        raise SystemExit('Commit verified source changes before packaging.')
    OUT.mkdir(parents=True, exist_ok=True)
    names = subprocess.check_output(['git','ls-files','-z'], cwd=ROOT).decode().rstrip('\0').split('\0')
    # Only version-controlled files enter the source archive: no profiles, caches,
    # screenshots, local settings, or build artifacts picked up by a broad walk.
    source = [(ROOT / name, 'tabscribe/' + name) for name in sorted(names)]
    extension = [(ROOT / name, 'tabscribe-extension/' + name.removeprefix('extension/'))
                 for name in sorted(names) if name.startswith('extension/')]
    assert any(name.endswith('/manifest.json') for _, name in extension)
    packages = [build('tabscribe-chatgpt-extension.zip', extension),
                build('tabscribe-chatgpt-source.zip', source)]
    report = {'branch':git('branch','--show-current'), 'commit':git('rev-parse','HEAD'),
              'packages':packages, 'integrity':'Every entry compared byte-for-byte to the working tree.'}
    (OUT / 'package-report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
