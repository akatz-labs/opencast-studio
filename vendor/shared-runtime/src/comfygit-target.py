"""Read-only JSON adapter over installed ComfyGit public APIs.

Executed by a selected ComfyGit Python runtime, locally or over OpenSSH. It never
creates a workspace, scans/reorganizes a model directory, or downloads packages.
"""

import hashlib
import json
import sys
import tempfile
from dataclasses import asdict
from importlib.metadata import version
from pathlib import Path


def inspect_request(request):
    from comfygit_core.core.workspace import Workspace

    workspace = Workspace.open(Path(request["workspace"]))
    inventory = workspace.get_resource_inventory().to_dict()
    analyses = []
    for recipe in request["recipes"]:
        manifest = recipe["manifest"].encode("utf-8")
        if hashlib.sha256(manifest).hexdigest() != recipe["sha256"]:
            raise ValueError("Recipe changed before target inspection")
        with tempfile.TemporaryDirectory(prefix="akatz-recipe-inspect-") as temporary:
            root = Path(temporary)
            (root / "pyproject.toml").write_bytes(manifest)
            analysis = workspace.import_analyzer.analyze_import(root)
            models = []
            for model in analysis.models:
                row = asdict(model)
                relative = Path(model.relative_path)
                if relative.is_absolute() or ".." in relative.parts:
                    raise ValueError("Recipe contains an invalid model path")
                candidate = Path(inventory["models_directory"]) / relative
                row["expected_path_present"] = bool(relative.parts) and candidate.is_file()
                models.append(row)
            analyses.append({
                "id": recipe["id"],
                "recipeSha256": recipe["sha256"],
                "models": models,
                "nodeCount": analysis.total_nodes,
                "workflowCount": analysis.total_workflows,
                "comfyuiRevision": analysis.comfyui_commit_sha or analysis.comfyui_version,
            })
    return {
        "schemaVersion": 1,
        "coreVersion": version("comfygit-core"),
        "inventory": inventory,
        "analyses": analyses,
    }


if __name__ == "__main__":
    try:
        result = inspect_request(json.load(sys.stdin))
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
