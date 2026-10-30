# Working on OpenCast Studio

This repository is the local application: React UI, Node API, ComfyGit installer,
GPU executor, and bundled ComfyUI workflows. Cloud execution, accounts, billing,
databases and object-storage implementations belong in a separate repository.
Keep the frontend's versioned API contract portable.

## Start here

1. Read README.md and docs/LOCAL_SETUP.md. Run `npm run doctor` for a read-only
   prerequisite check. The interface can run without a GPU; generation needs a
   compatible Linux x64 NVIDIA machine, locally or over SSH.
2. Run `npm ci`, `npm run build`, then `npm start`. Open the printed loopback URL.
3. On first launch, Settings opens Resources. Let the operator choose a model
   folder before selecting Install missing. The catalog is approximately 76 GiB;
   do not trigger large downloads without the operator choosing setup.
4. Use the bundled installer and model manifest. Do not silently change pinned
   models, dependency versions, seeds, prompts, dimensions or generation steps.
   Gated Hugging Face files require the user's access and license acceptance.
   Never commit tokens. Scan models verifies existing files against the catalog.
5. Confirm the relevant feature is available before submitting generation.
   Check the actual output and retained workflow, not only queue acceptance.

## Source map

- `src/`: UI. `shared/api-contract.ts`: request/response schemas.
- `server/start.mjs`: local entry point. `server/shared-executor.mjs`: durable jobs.
- `server/setup*.mjs`: worker bootstrap, pinned runtimes, models and readiness.
- `resources/models.json`: authoritative model URLs, revisions, sizes and hashes.
- `resources/runtimes/`: ComfyGit recipes and dependency locks.
- `resources/motion/`: editable and executable FLUX3 + Pika workflows and worker.
- `resources/runtime-fixes/`: pinned runtime corrections with integrity checks.
- `workflows/`: character sheet workflows and I/O contracts.
- `vendor/shared-runtime/`: attributed local/SSH worker infrastructure.

## Verification and boundaries

Run `npm test`, `npm run build`, `npm run audit:release`, and optionally
`npm run package:source`. Browser tests document their environment variables;
GPU regression tests are separate and consume actual GPU resources.

Use dynamic VRAM for character and motion jobs. Preserve unrelated running jobs
and model caches. Diagnose errors from retained receipts/logs; do not blindly
resubmit an uncertain generation. Do not expose the unauthenticated local worker
on the public internet. Keep user state, generated outputs, caches, build output,
source archives and deployment configuration outside Git.

Validate external inputs at the owning boundary. Trust typed internal contracts.
Use exceptions for recovery or error translation, and keep changes focused.
