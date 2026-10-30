"""Install an app-pinned ComfyGit toolchain with a verified uv executable.
This owns only its content-addressed tools directory; no system packages change.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

UV_URL = 'https://files.pythonhosted.org/packages/75/2e/62273ee6c9fbebccd8248c153b44870f81ebf5267c31edf4c095d78537fb/uv-0.11.28-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl'
UV_SHA256 = '49fe42df9f42056037473f3876adec1615709b57d3470ed39178ff420f3afb9f'
UV_SIZE = 27127688

def main(target, manifest):
    windows = platform.system() == 'Windows'
    if platform.system() not in ('Linux', 'Windows') or platform.machine().lower() not in ('x86_64', 'amd64'):
        raise RuntimeError('Managed runtime requires Linux or Windows x86_64.')
    for tool in (['git'] if windows else ['git', 'g++']):
        if not shutil.which(tool):
            raise RuntimeError(f'Install the operating-system {tool} tool, then retry runtime setup.')
    target = Path(target)
    manifest = Path(manifest)
    pins = json.loads(manifest.read_text())
    uv_pin = pins.get('platforms', {}).get('windows-x64') if windows else None
    if windows and not uv_pin:
        raise RuntimeError('This app has not supplied a verified Windows bootstrap pin.')
    requirements = manifest.parent / 'requirements.txt'
    if hashlib.sha256(requirements.read_bytes()).hexdigest() != pins['requirements_sha256']:
        raise RuntimeError('ComfyGit requirements checksum differs')
    wheels = []
    for pin in pins['wheels']:
        path = manifest.parent / pin['filename']
        if hashlib.sha256(path.read_bytes()).hexdigest() != pin['sha256']:
            raise RuntimeError('Bundled ComfyGit wheel checksum differs')
        wheels.append(str(path))
    target.mkdir(parents=True, exist_ok=True)
    uv = target / ('uv.exe' if windows else 'uv')
    if not uv.exists():
        print('Downloading verified Python setup tool', flush=True)
        with urllib.request.urlopen(uv_pin['url'] if windows else UV_URL, timeout=60) as response:
            data = response.read(64 * 1024 * 1024 + 1 if windows else UV_SIZE + 1)
        if (not windows and len(data) != UV_SIZE) or len(data)>64*1024*1024 or hashlib.sha256(data).hexdigest() != (uv_pin['sha256'] if windows else UV_SHA256):
            raise RuntimeError('Python setup tool failed checksum verification')
        archive = zipfile.ZipFile(io.BytesIO(data))
        names = [name for name in archive.namelist() if (Path(name).name == 'uv.exe' if windows else name.endswith('/scripts/uv'))]
        if len(names) != 1:
            raise RuntimeError('Unexpected Python setup tool package layout')
        with tempfile.NamedTemporaryFile(dir=target, delete=False) as handle:
            handle.write(archive.read(names[0])); temporary = Path(handle.name)
        temporary.chmod(0o700); os.replace(temporary, uv)
    python = target / ('venv/Scripts/python.exe' if windows else 'venv/bin/python')
    if not python.exists():
        subprocess.run([str(uv), 'venv', '--python', '3.11', str(target / 'venv')], check=True)
    print('Installing app-pinned ComfyGit tools', flush=True)
    subprocess.run([str(uv), 'pip', 'install', '--python', str(python), '-r', str(requirements), *wheels], check=True)
    subprocess.run([str(python), '-c', 'from comfygit_core import Workspace; from importlib.metadata import version; import sys; assert all(version(name)==sys.argv[1] for name in ("comfygit","comfygit-core","comfygit-studio"))', pins['version']], check=True)
    subprocess.run([str(uv), 'pip', 'check', '--python', str(python)], check=True)
    print('Managed ComfyGit tools ready', flush=True)

if __name__ == '__main__':
    main(*sys.argv[1:])
