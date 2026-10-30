"""Resume an app-owned materialization without replacing existing environments."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import shutil
import tomllib
import tempfile

cg, source, workspace, environment, models_root, strategy, recipe_digest = sys.argv[1:8]
bundled_nodes = json.loads(sys.argv[8]) if len(sys.argv) > 8 else {}
torch_backend = sys.argv[9] if len(sys.argv) > 9 else 'auto'
root = Path(workspace) / 'environments' / environment
receipt = root / '.akatz-materialization.json'
manifest = root / '.cec/pyproject.toml'
hash_file = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
if root.exists():
    if not receipt.is_file():
        raise RuntimeError('Existing environment has no matching app setup receipt. It was preserved; choose a new environment.')
    previous = json.loads(receipt.read_text())
    if previous.get('torch_backend', 'auto') != torch_backend:
        raise RuntimeError('Existing environment uses a different PyTorch backend. It was preserved; choose a new environment.')
    if previous['recipe_digest'] != recipe_digest or previous['manifest_sha256'] != hash_file(manifest):
        raise RuntimeError('Existing app environment differs from its setup receipt. It was preserved.')
    print('Reusing the verified materialized app environment', flush=True)
else:
    if not bundled_nodes:
        subprocess.run([cg, 'materialize', source, '--name', environment, '--workspace', workspace, '--models-dir', models_root, '--models', strategy, '--torch-backend', torch_backend], check=True)
    else:
        from comfygit_core.core.workspace import Workspace
        from comfygit_core.models.exceptions import CDWorkspaceNotFoundError
        from comfygit_core.models.protocols import ImportCallbacks

        source_root = Path(source).resolve()
        nodes = tomllib.loads((source_root / 'pyproject.toml').read_text())['tool']['comfygit']['nodes']
        copies = []
        for node_id, relative in bundled_nodes.items():
            node = nodes[node_id]
            origin = (source_root / relative).resolve()
            name = node['name']
            if not origin.is_relative_to(source_root) or Path(name).name != name or name in ('.', '..'):
                raise RuntimeError('Bundled node path escapes its staged recipe')
            if not (origin / '__init__.py').is_file():
                raise RuntimeError('Bundled node entrypoint is missing: ' + node_id)
            if any(p.is_symlink() for p in origin.rglob('*')):
                raise RuntimeError('Bundled nodes must contain regular staged files')
            bundle = None
            bundle_file = origin / 'git-bundle.json'
            if bundle_file.is_file():
                import base64
                import re
                record = json.loads(bundle_file.read_text())
                bundle = base64.b64decode(record['body'], validate=True)
                if hashlib.sha256(bundle).hexdigest() != record['sha256']:
                    raise RuntimeError('Bundled git source checksum differs')
                if not re.fullmatch('[a-f0-9]{40}', record['revision']) or record['revision'] != node.get('pinned_commit'):
                    raise RuntimeError('Bundled git revision differs from the recipe')
            copies.append((origin, name, bundle, node.get('pinned_commit')))

        class BundledCallbacks(ImportCallbacks):
            def on_phase(self, phase, description):
                print(description, flush=True)
                if phase == 'sync_environment':
                    for origin, name, bundle, revision in copies:
                        destination = root / 'ComfyUI' / 'custom_nodes' / name
                        if destination.exists():
                            raise RuntimeError('Existing node preserved: ' + name)
                        if bundle is None:
                            shutil.copytree(origin, destination)
                        else:
                            with tempfile.NamedTemporaryFile(suffix='.bundle') as handle:
                                handle.write(bundle)
                                handle.flush()
                                subprocess.run(['git', 'clone', '--no-checkout', handle.name, str(destination)], check=True)
                            subprocess.run(['git', '-C', str(destination), 'checkout', '--detach', revision], check=True)

            def on_error(self, error):
                print(error, flush=True)

        try:
            instance = Workspace.open(Path(workspace))
        except CDWorkspaceNotFoundError:
            instance = Workspace.create(Path(workspace))
        if instance.get_models_directory() != Path(models_root):
            instance.set_models_directory(Path(models_root))
        instance.materialize_environment(source_root, environment, model_strategy=strategy,
                                         callbacks=BundledCallbacks(), torch_backend=torch_backend)
    temporary = receipt.with_suffix('.tmp')
    temporary.write_text(json.dumps({'schema_version': 1, 'recipe_digest': recipe_digest, 'manifest_sha256': hash_file(manifest), 'torch_backend': torch_backend}, indent=2))
    os.replace(temporary, receipt)
