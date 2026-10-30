# Default character-sheet pipeline

New CAST character jobs use `cast-krea-character-sheet-v2`. One ComfyUI prompt runs the entire dependency chain:

1. Generate a 1024 × 1536 close-up with Krea 2 Turbo and CAST step-4000 LoRA, strength 1.
2. Quantize the source consistently with PNG saving, resize it according to height and proportions, and center it horizontally at y = 48 by default on a 1024 × 1536 canvas.
3. Generate the body using the same character description, CAST LoRA 1, outpaint LoRA 1, and registered reference attention.
4. Restore the resized source pixels, with a 16-pixel inward feather at the boundary.
5. Concatenate the original portrait and restored body into the final 2048 × 1536 sheet.

Both samplers use 8 Euler/simple steps, CFG 1. The API body seed defaults to `(seed + 1000003) % 2147483648`; an explicit `bodySeed` preserves reviewed reruns. Fixed settings and placement are retained in each job graph. The left panel preserves the full-resolution portrait; the right panel preserves its resized face interior. Body anatomy and outfit continuation remain generated content requiring visual review.

## API

`POST /cast-studio/api/jobs` retains the existing traits, direction, batchSize (1–4), seed, steps (8), and idempotencyKey fields. `promptOverride` edits the close-up prompt; `fullBodyPromptOverride` edits the body prompt. Both are optional and limited to 12,000 characters. Optional `bodySeed` accepts 0–2147483647 and `referenceTop` accepts 0–512 pixels (default 48), retaining extra headroom for tall hair or crests. Automatic prompts compile the same traits and direction for each view. When only the close-up is manually edited, the body prompt uses that exact edited description preceded by explicit full-body framing instructions. Old valid framing values are accepted for client compatibility; new jobs always return a character sheet.

Poll `/api/jobs/{id}`. `image` is the combined sheet. `artifacts.portrait`, `artifacts["full-body"]`, and `artifacts["raw-body"]` expose retained component PNGs. A job becomes complete only after all contracted outputs have downloaded successfully. Repeated submissions with the same key and identical request return the same job; changed requests with the same key reject. Ambiguous worker submissions remain uncertain and are never blindly retried.

The job manifest retains both exact prompts, both seeds, traits, executable graph, editable workflow with job-specific widget values, I/O contract, model hashes, and environment provenance. Native ComfyUI history and all output hashes are retained with the batch. Completed batches are committed to managed storage and expose `storageVersion`. Legacy jobs keep their original manifests and single-image outputs.

This private prototype has job/history persistence, **not authenticated per-user account storage**. The future API host must associate the job and storage version with its authenticated owner and authorize all reads/downloads. A client-supplied user ID is not an authorization boundary. No account database or H3 video generation is added by this change.

## ComfyUI handoff

Load `workflows/character-sheet.json` in ComfyUI, or submit `workflows/krea-api.json` through `/prompt`. The editable graph was exported and reloaded through the installed frontend; its executable inputs were compared with the API graph. `contract.json` maps API inputs and identifies the primary sheet output (node 9). API consumers should use the contract rather than selecting the first arbitrary ComfyUI output.

Install `custom_nodes/cast-character-sheet` with ComfyGit `node dev-link`. It vendors the tested Rebels registered outpaint implementation, with CAST placement and sheet assembly extensions. Keep LICENSE and NOTICE. Required model filenames, SHA-256 values and managed storage versions are in `models.json`; model weights are not bundled. The private CAST LoRA must be supplied from the authorized project asset.

`scripts/krea-worker.py` holds renewable reader leases for the CAST LoRA, VAE and outpaint LoRA for the worker lifetime. The admitted Arch worker retains its existing unrestricted CPU/RAM policy, `--reserve-vram 0`, and the previously tested smart-memory mode. Unrelated jobs keep their GPU ownership.

## Explore reference sheets — 2026-10-29 UTC

All 26 Explore characters have a 2048 × 1536 reference sheet: original or regenerated portrait on the left, matching full body on the right. Sixteen existing portraits use the outpaint-only subset; ten former body-only examples use a fresh portrait followed by outpainting. Those ten are approximations of the old characters, not identity-locked reconstructions. Original gallery records, sources and generation provenance remain retained.

The grid alternates 13 portrait and 13 body thumbnails. Every card opens its complete sheet, offers the original PNG and manifest, and loads both exact prompts, both seeds and placement when recreated. `docs/gallery-sheets.json` maps selections to retained originals; `src/gallery.json` keeps the earlier generation record separately from the sheet recipe.

| Height | Reference portrait width | With oversized head |
| --- | ---: | ---: |
| Tall | 192 | 288 |
| Average | 224 | 384 |
| Short | 384 | 448 |
| Very short (workflow control) | 448 | 448 |

Reference height maintains the portrait's aspect ratio. The API and ComfyUI node share `reference-placement.json`. The existing creator's Short + Oversized head settings cover the strongest short-body treatment. Tall hair or crests may need extra top room: Dev uses 240 pixels and Perry 96. These offsets are retained for recreation.

Load `workflows/portrait-to-sheet.json` for an existing close-up, or submit `portrait-to-sheet-api.json`. Its contract replaces the first sampler with `LoadImage`; the full workflow continues to generate both views. Both editable workflows resolve in ComfyGit snapshot `844c92eb80c89b93f0b9b7dd4b4e23db7ab8ac13` with five models and six custom classes.

The gallery run was visually reviewed on Fey. Median native execution was 10.164 seconds for the 16 outpaint-only selections and 21.323 seconds for the ten regenerated-portrait selections (Perry's final repair reused its portrait cache). These warm-worker times exclude startup, queue and transfers. Rejected attempts remain in the experiment record, including clipped hair/crests and an incorrect human interpretation of Perry. All 26 selected face interiors match the resized source pixels exactly outside the feathered seam. Import verifies every full-resolution portrait/body panel against the sheet and all 16 existing portraits against their source pixels.

The production Arch worker remains queued behind unrelated H3 work. The earlier v1 smoke job is retained unchanged. Gallery delivery does not require GPU availability. Hub Library registration remains pending because the installed CLI has no `library` command; the discoverable sidecar remains beside the app.

## Application verification

All 26 sheet viewers and original-PNG downloads passed through both staging and the deployed private Tailnet URL. Browser checks also covered exact prompt/seed recreation for three representative characters, mobile download/recreation, and no horizontal overflow. Twenty unit checks and the TypeScript/Vite build passed.

The exact Perry replay completed from ComfyUI cache in 0.806 seconds (`asv_ca5ac1665a084dda851444bd01a03373`). A fresh Short + Oversized head API job exercised both samplers in 21.438 seconds (`asv_a716f93d1cf241d1a986eabeae1dd0f8`), retaining width 448, top 48, and the explicit body seed in its executable graph. Selected gallery originals and review evidence are retained as `asv_4ffacf958279486bbd0173a3c815ff02`.
