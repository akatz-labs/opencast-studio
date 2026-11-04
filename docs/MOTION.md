# OpenCast video workflows

OpenCast uses Alisson's Character Swap v1.1 for character replacement and TARA
Motion Transfer v1.0 for motion transfer. Both run MiniMax H3 Ref2VA with the
8-step DMD Turbo LoRA. They do not generate an anchor image or load Pika Flex.

Character swap supplies the full source clip as aligned guide latents. Motion
transfer supplies it as a native video reference with TARA temporal attention.
The current motion-transfer weights already incorporate the training adapter;
do not add that adapter a second time.

## Inputs and output

`/api/v1/jobs` accepts `character-swap` or `motion-transfer`, asset IDs for
`video` and `character`, and an optional `background` for motion transfer.
`parameters.prompt` is prepended to the mode's reusable instructions, for
example “Replace the boxing man with the fox girl.” The optional **Character details** field (`characterDescription` in the API)
gives a short description of the reference character. Explore and generated
characters prefill this field from their recorded traits; uploaded images leave
it blank for you to describe.
When blank, the template refers to the replacement character in Picture 1.

`quality: "480p"` selects approximately 0.5 MP; `"720p"` selects approximately
1 MP. These compatibility identifiers are pixel budgets, not fixed heights.
Dimensions follow the source aspect ratio, rounded to multiples of 32.
The source is normalized to 24 fps without changing its speed, capped at 15
seconds, then rounded down to H3's 17n + 5 frame grid: at most 345 frames
(14.375 seconds). Optional `seed` makes sampling reproducible. Legacy
`anchorSeed` values are accepted but unused by this revision.

Character swap preserves the source setting. Motion transfer uses the supplied
background, or the character reference's setting when it defines one; otherwise
it preserves the source setting. Single continuous shots are the preferred
input. The workflow does not detect scene cuts. Inspect identity, pose and
background throughout the resulting video.

For character swap, available source audio also conditions the guide. Motion
transfer follows the published TARA recipe without audio conditioning.
`keepAudio` copies the source soundtrack into the final video; it does not
request newly generated speech. Silent inputs remain silent.

## Installation and runtime

In Resources, choose a model directory and select Install missing. The manifest
pins seven video dependencies: the H3 INT8 model, NVFP4 text encoder, FP16 video
VAE, audio VAE, DMD Turbo LoRA, Character Swap LoRA and TARA Motion Transfer
LoRA. Existing matching files are reused. FLUX image-editing models are no
longer required. Character creation retains its separate Krea dependencies.

Runtime setup supports Linux x64 with an NVIDIA GPU and installs an isolated
ComfyGit environment. The internal profile ID `pika` remains for compatibility;
the active workflow version is `opencast-alisson-v1`. Older installed runtimes
are preserved and are not selected for the new workflow until updated.

Each job uses an isolated ComfyUI process and releases it on completion. Dynamic
VRAM, zero reserved VRAM, Triton kernels and the pinned INT8 offset fix remain
enabled; compilation is disabled. This permits normal model residency management
and does not guarantee every duration/resolution fits a particular GPU.
A trusted deployment may set `jobLauncher` in resource settings to integrate
its GPU admission system. Personal installations need no fleet-specific setup.

## Graphs, provenance and licenses

`resources/motion/alisson/graph.py` builds the active API graphs. The adjacent
`character-swap.api.json` and `motion-transfer.api.json` are concrete examples.
The `*_workflow_native_nodes_*.json` files are Alisson's original editable
ComfyUI examples, retained for reference; they are not the app's generated graph.
The older `OpenCast-Motion.json` and FLUX graph files are historical recipes.

Both active modes use 8 Euler/simple steps, CFG 1 and video/audio sigma shifts
12/3. TARA uses strength 2, a 0.2-second window, 0.25-second falloff, penalty cap
6 and structure guidance 1. Prompts adapt the upstream templates to the app's
reference inputs and optional background. Model URLs, revisions, hashes and
licenses are in `resources/models.json`; upstream documentation and licenses
are retained alongside the graphs. TARA node source and attribution are in
`custom_nodes/opencast-tara`.

Model licenses are separate from the application's license. Alisson's published
terms restrict hosted inference; obtain the author's permission for a hosted
service. Permission arranged for a particular deployment does not transfer to
other installers. The bundled BFS TARA source retains its GPL-3.0 license.

Jobs retain the submitted graph, ComfyUI history, expanded prompt, model/runtime
identities, source/reference inputs, seed, native output, playable video and
poster. An uncertain submission is not automatically resubmitted.

## Validation — 2026-11-04

The new package installed into a fresh isolated ComfyGit environment on an
existing Linux RTX 4090 executor. Both app modes completed the same 107-frame
boxing/fox test at 544 × 928, 24 fps and seed 42; motion transfer used a separate
fantasy background. Both inputs were silent. Standalone graph tests also
completed. Playback, seeking and downloads passed at desktop and phone widths.
A subsequent browser-submitted swap with only a brief instruction kept the source
actor. At that same seed, adding a reference-character description produced
the fox-girl replacement; the brief prompt also worked at seed 42. Successful
execution therefore does not establish reliable swapping for every prompt or
seed. The optional Character details field provides this tested prompt control.
Comfy Cloud also completed both 107-frame modes at 0.5 MP. The hosted app
submitted both modes through its public UI and retained their videos, workflow
graphs and manifests. These cloud runs use the same model recipe, with separate
GPU/runtime versions from the local executor.

Fresh-machine bootstrap, audio-conditioned rendering, 1 MP and full-duration
rendering require separate runtime validation.

### Reference-led motion prompt

Motion transfer uses a fixed six-section `motion_transfer:` prompt based on the
upstream manual example. Picture 1 supplies identity, clothing, proportions and
rendering style. Optional Picture 2 replaces the environment; without it the guide
setting is retained unless the user asks for another setting. Video 1 supplies
performance, timing and camera movement through native reference conditioning and
TARA, with no source-video Add Guide.

Direction is off by default and blank when enabled for the first time. Only
explicitly enabled direction text is prepended. Character-trait descriptions are
neither sent by this mode nor inserted by its recipe; the optional Character details
field remains available for character swapping.
