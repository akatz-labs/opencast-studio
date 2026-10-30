# Local setup

## What is included

This repository contains the OpenCast Studio interface, loopback Node API, durable
local job queue and media store, shared local/SSH GPU executor, pinned ComfyGit
installer, character workflows and FLUX3/Pika motion workflows. No cloud service,
Supabase deployment, database server, account system or payment backend is required.
API schemas stay portable so a separately maintained backend can use the same UI.

## Requirements

- Node.js 22.18 or newer and npm for the app. Run `npm run doctor` to inspect tools.
- Linux x64 with an NVIDIA GPU for automatic GPU setup. macOS/Windows users can
  run the UI and connect a compatible remote Linux executor over SSH.
- Python 3 or uv, Git, a C++ compiler (`g++`), FFmpeg and FFprobe on the executor.
  FFprobe is also needed by the API for uploaded-video validation.
- An NVIDIA driver compatible with the pinned PyTorch builds: CUDA 13.0 for Krea,
  CUDA 12.8 for Pika. A CUDA toolkit is not required merely to run the pinned wheels.
- Roughly **76.3 GiB of model files**, plus runtime packages, caches and output
  space. Leave additional disk space for these; the model total is not the total
  installation size. Use Resources to select the model disk before installing.

Actual character and motion renders have been tested on a 24 GiB RTX 4090 worker
with 128 GiB system RAM. These are tested hardware, not established minimums.
Both workflows explicitly enable dynamic VRAM. Large jobs may still exceed
available VRAM/RAM; a memory error is not permission to change the user's settings.

## Launch

```sh
npm ci
npm run build
npm start
```

Open the printed URL (normally `http://localhost:8389`) on that machine. Interactive
startup opens a browser when supported. On first launch, **Settings → Resources**
opens because the runtime is missing. The app does not download models on startup.

Choose **Model folder**, click **Use folder**, then **Install missing**. Runtime
packages are installed separately from model files. Existing matching models are
reused, downloaded models are checked against pinned byte counts and SHA-256,
and setup receipts survive browser closure.

The three FLUX3 weights marked **manual** require accepting the publisher's access
conditions on Hugging Face. Download the exact revision and filename linked in
Resources into the shown subfolder. Do not substitute another quantization or
filename. Then click **Scan models** to hash and index existing files. The public
OpenCast LoRA and the remaining public dependencies download automatically.
Each model retains its publisher's license and access conditions; the application
license does not replace them. No Hugging Face token is bundled or required in Git.

Once the character dependencies are ready, generate a character sheet. Once the
motion dependencies are ready, select a reference video and one character, choose
character swap or motion transfer, then generate. Each job starts its pinned
ComfyUI runtime on demand and stops its own runtime after saving outputs.

## Where files go

- App state and generated outputs: `~/.local/share/opencast`, overridden with
  `OPENCAST_DATA`. Configuration variables must be exported; `.env` is an example,
  not an implicitly loaded file.
- Shared worker/runtime files use the vendored shared runtime's standard user
  data directory. On Linux this defaults under `~/.local/share/akatz`; this is an
  upstream package namespace, not a required user account or machine name.
- Models use the selected shared model folder. Changing the folder does not move
  or delete the old model files. Preserve other applications' shared models.

For a remote worker, see the JSON example in README.md and set
`OPENCAST_RESOURCE_CONFIG` to that private file. The worker must already be
reachable through SSH and its local executor service. Installation will preserve
unrelated GPU sessions; it will not take over an unknown runtime.

## Check a clean installation

```sh
npm test
npm run build
npm run audit:release
```

Confirm that first-run Resources opens, no download starts before Install missing,
Generate enables after its dependencies are ready, and a real generation produces
downloadable media with its settings and workflow. Reload and confirm history is
retained. CPU tests cannot establish GPU compatibility; actual rendering is a
separate validation step.

`npm run package:source` optionally creates an ignored source ZIP under `artifacts/`
(requires the `zip` command). GitHub normally needs only the source tree.

## Troubleshooting

- **Generate unavailable:** inspect Resources and the message above Generate.
  Check missing/gated files, executor identity and connection before retrying.
- **Setup interrupted:** inspect the retained setup log and resume Install missing.
  Do not remove runtime locks belonging to an active operation.
- **Worker connection lost:** the request stays saved. Restore the connection;
  avoid creating duplicate requests for the same in-progress generation.
- **Generation failed:** open the job's error and inspect retained executor logs.
  The pinned Pika runtime includes the tested INT8 indexing correction for long
  tensors. Do not overwrite it with an unreviewed package update.
- **Remote worker unavailable:** restore that configured worker. The installer
  does not silently replace a remote configuration with a local GPU runtime.

The local API and executor bind to loopback and assume a trusted local user.
Public multiuser hosting belongs in the separate hosted backend project.
