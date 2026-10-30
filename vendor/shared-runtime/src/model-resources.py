"""Bounded resource operations through public ComfyGit workspace APIs.

ComfyGit remains the model-index owner. Input arrives over stdin; no database is
opened directly by an app and no provider credentials are returned.
"""
import json
import sys
from pathlib import Path
from importlib.metadata import version


class ScanProgress:
    """Stream ComfyGit's public file-count callbacks to the shared job API."""
    def emit(self, **progress):
        print(json.dumps({"progress": progress}), flush=True)

    def on_scan_start(self, total_files):
        self.emit(stage="indexing", completedFiles=0, totalFiles=total_files,
                  message="Indexing shared model storage")

    def on_file_processed(self, current, total, filename):
        self.emit(stage="indexing", completedFiles=current, totalFiles=total,
                  currentFile=filename, message=f"Indexed {current} of {total} files")

    def on_scan_complete(self, result):
        if result.error_count:
            raise ValueError(f"Indexing needs attention: {result.error_count} files failed. "
                             "The folder may already be selected. Run Scan to retry. "
                             + "; ".join(result.errors[:3]))
        self.emit(stage="refreshing", message="Updating environment model paths")



def main(request):
    from comfygit_core.core.workspace import Workspace
    workspace = Workspace.open(Path(request["workspace"]))
    if request["action"] in ("uninstall-plan", "uninstall"):
        selected = Path(request["path"]).absolute()
        root = workspace.get_models_directory().absolute()
        selected.relative_to(root)
        matches = [location for model in workspace.get_model_inventory()
                   for location in model.locations
                   if Path(location.base_directory, location.relative_path).absolute() == selected]
        if len(matches) != 1 or matches[0].id is None:
            raise ValueError("Scan this model before uninstalling; exactly one indexed location is required")
        plan = workspace.plan_model_deletion(str(selected), location_id=matches[0].id)
        value = plan.to_dict()
        if request["action"] == "uninstall-plan":
            return value
        if value != request["expected_plan"]:
            raise ValueError("Model usage or location changed. Review uninstall again.")
        result = workspace.apply_model_deletion_plan(
            plan, allow_referenced=True,
            allow_incomplete_recovery=request.get("catalog_recovery_verified") is True,
        ).to_dict()
        if result["errors"]:
            raise ValueError("ComfyGit could not finish uninstall: " + json.dumps(result["errors"]))
        return result
    if request["action"] == "scan":
        workspace.sync_model_directory(progress=ScanProgress())
    elif request["action"] == "storage":
        workspace.set_models_directory(Path(request["path"]), progress=ScanProgress())
    elif request["action"] != "inventory":
        raise ValueError("Unsupported resource operation")
    result = {"models_directory": str(workspace.get_models_directory()),
              "models": [model.to_dict() for model in workspace.get_model_inventory()]}
    result["core_version"] = version("comfygit-core")
    result["index_path"] = str(workspace.paths.cache / "models.db")
    return result


if __name__ == "__main__":
    try:
        print(json.dumps(main(json.load(sys.stdin))), flush=True)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
