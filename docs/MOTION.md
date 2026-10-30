# OpenCast motion workflow

OpenCast Studio uses FLUX3 Klein to edit the opening frame, then Pika H3 Flex to
produce the video. Both character swap and motion transfer use this pipeline.
There is no GPT image service, SAM mask, depth model, or character-swap LoRA.

The editable workflow is `resources/motion/OpenCast-Motion.json`. Double-click
its FLUX3 anchor subgraph to inspect prompt expansion and image editing. The
backend runs the equivalent flat API graph in `pipeline.flat.api.json`. The
native and flat output graphs are compared in the test suite. Source recipes
are retained under `resources/motion/source`; `scripts/build-motion-graph.mjs`
rebuilds the combined flat graph.

## Inputs and output

The existing `/api/v1/jobs` contract accepts `character-swap` or
`motion-transfer`, asset IDs for `video` and `character`, and an optional
`background` for motion transfer. `parameters.prompt` is prepended to the
reusable mode-specific instructions. Blank instructions target the main person.
`quality: "480p"` selects approximately 0.5 MP; `"720p"` selects approximately
1 MP. These legacy quality identifiers are pixel budgets, not fixed heights.
The anchor always uses 1 MP. Optional `seed` and `anchorSeed` allow replay;
otherwise the backend generates and saves both seeds once per admission.

The source is normalized to 24 fps without changing its speed. Up to 15 seconds
are used; the workflow rounds down to H3's 17n + 5 frame grid, at most 345 frames
(14.375 seconds). It does not detect scene cuts. Source audio conditions H3's
reference and guide. `keepAudio` includes generated audio in the final MP4;
turning it off mutes the export without changing model conditioning.

Character swap preserves the source setting. Motion transfer uses the uploaded
background, or the character image's setting when none is supplied. A neutral
character sheet does not define a new environment. These generative edits can
change pose, framing and background details; inspect the result.

## Local installation

Run the app, open Resources, choose the model directory, and select Install
missing. The shared executor installs an isolated ComfyGit runtime with the
bundled Python/package lock. It advertises both motion features automatically
once their dependency probes pass. No hand-written workflow binding is needed.

The manifest includes the FLUX3 image model, Qwen3-VL image encoder, Qwen3.5
prompt upsampler and FLUX2 VAE, plus Pika/H3's model, encoder, adapter and VAEs.
The three FLUX3 weights are gated: accept the conditions at their linked Hugging
Face repository, download the pinned files into the displayed directories, then
select Scan models. Public files install automatically; matching existing files
are reused. Credentials never go through browser job requests.

Automatic runtime setup currently supports Linux x64 with a suitable NVIDIA GPU.
Each motion job owns an isolated ComfyUI process, releases it after completion,
and uses the pinned core revision, compiler-disabled Triton kernels and zero
reserved VRAM. Normal memory management allows inactive model weights to move
to system RAM: retaining every model on a 24 GB GPU exhausted VRAM during H3
loading in the integration test. Resolution and duration are not reduced.
A trusted deployment can set a `jobLauncher` JSON argument array
in its resource settings to admit work on a shared GPU scheduler; `{jobId}` is
expanded to the immutable executor job ID. Personal installs need no fleet names
or launcher configuration. The same asset/job API works over a local or SSH
executor transport and can be implemented by a cloud executor later.

The app retains the normalized workflow, both executed API graphs, ComfyUI
submission/history receipts, expanded prompt, generated anchor, native output,
playable MP4, poster, seeds and output metadata. No accepted job is automatically
resubmitted after an uncertain result. Existing character and video histories
remain readable when the shared motion driver is enabled.

## Recipe provenance

FLUX3 uses the tested distilled INT8 recipe: official image-edit system prompt,
Qwen3.5 9B INT8 expansion, 16 Euler/simple steps, CFG 1, native multi-image
reference latents, 1 MP. The exploratory generic prompt refinements were not
selected because they did not reliably improve geometry. Pika retains the
six-step Flex adapter recipe and opening-frame Add Guide. Runtime and model
revisions, sizes and hashes are pinned in `resources/runtimes/pika` and
`resources/models.json`. Model licenses remain those of their publishers.

## Integration validation — 2026-10-30

Two 5.17-second inputs completed on a 24 GB RTX 4090: character swap at
544 × 960 (204 seconds), and motion transfer with an uploaded background at
864 × 1152 (523 seconds). Both produced 124 frames at 24 fps and playable
MP4s. Browser playback, original-reference display, downloads with matching
SHA256, HTTP range requests, cancellation, and automatic GPU release passed.
The 45-test suite and production build passed. The standalone entry point
discovered the installed motion driver and resolved bundled Explore references.

These checks used an existing Linux executor. Fresh-machine bootstrap, the
full 15-second input cap, and Comfy Cloud execution were not exercised.

Runtime reliability: both character and motion jobs explicitly enable dynamic VRAM (`--enable-dynamic-vram`, reserve 0). This manages residency automatically but does not guarantee arbitrary workloads fit. The pinned Pika environment applies the bundled comfy-kitchen 0.2.39 INT8 offset fix using atomic file replacement, so other environments remain unchanged. INT8 row/column offsets use 64-bit arithmetic before stride multiplication to support outputs exceeding 2^31 elements; Triton remains enabled. The installer checks the exact original source hash and probes the patched state. `tests/int8-offsets-gpu.py` is the explicit GPU regression for this boundary.
