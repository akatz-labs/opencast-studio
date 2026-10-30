"""Pinned comfy-kitchen 0.2.39 fix for INT8 matrices exceeding 2**31 elements.

Keep the Triton kernels enabled, but promote row/column offsets before stride
multiplication. Only the app's isolated environment is changed. Atomic replacement
avoids modifying other uv environments sharing a hard-linked package file.
"""
import hashlib
from importlib.metadata import distribution
from pathlib import Path
import sys

ORIGINAL_SHA256 = 'fd7045ab8afaf7f92f6d7123a4483cdb6149ff1890defb709c6849af422e08ed'


def patched_source(source):
    for axis in ('m', 'n'):
        name = 'am' if axis == 'm' else 'bn'
        old = f'    offs_{name} = (pid_{axis} * block_{axis} + tl.arange(0, block_{axis})) % {axis}'
        if source.count(old) != 2:
            raise RuntimeError('Unexpected pinned INT8 kernel source; review the runtime fix.')
        source = source.replace(old, old.split(' = ')[0] + ' = (' + old.split(' = ')[1] + ').to(tl.int64)')
    return source


def main():
    package = distribution('comfy-kitchen')
    if package.version != '0.2.39':
        raise RuntimeError('INT8 offset fix requires the pinned comfy-kitchen 0.2.39.')
    target = Path(package.locate_file('comfy_kitchen/backends/triton/quantization.py'))
    source = target.read_text()
    original = source
    for axis in ('m', 'n'):
        name = 'am' if axis == 'm' else 'bn'
        expression = f'(pid_{axis} * block_{axis} + tl.arange(0, block_{axis})) % {axis}'
        original = original.replace(f'offs_{name} = ({expression}).to(tl.int64)', f'offs_{name} = {expression}')
    if hashlib.sha256(original.encode()).hexdigest() != ORIGINAL_SHA256:
        raise RuntimeError('Pinned comfy-kitchen source differs; refusing an unverified patch.')
    patched = patched_source(original)
    if '--check' in sys.argv:
        if source != patched:
            raise RuntimeError('Required INT8 64-bit offset fix is missing.')
    elif source != patched:
        pending = target.with_suffix('.opencast-pending')
        pending.write_text(patched)
        pending.chmod(target.stat().st_mode)
        pending.replace(target)
    print('opencast-int8-offsets-ready')


if __name__ == '__main__':
    main()
