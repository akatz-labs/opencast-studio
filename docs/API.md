# OpenCast Studio API v1

The browser talks only to the OpenCast backend. It does not submit ComfyUI graphs,
select worker hosts, send provider credentials, or persist signed media URLs as
generation inputs. `shared/api-contract.ts` defines the wire schemas; a running
backend publishes JSON Schema at `GET /api/v1/schemas`.

```text
OpenCast frontend
  ├─ POST assets/uploads → upload destination → PUT/POST file → POST complete
  ├─ POST jobs { kind, inputs: asset IDs, parameters, idempotencyKey }
  └─ GET jobs → output asset IDs + renewable access URLs
          │
OpenCast backend (ownership, durable requests, storage, executor adapter)
          ├─ existing Krea worker / shared FLUX3 + Pika worker
          ├─ shared local or SSH executor via the shared executor v1 protocol
          └─ optional external backend implementing the same browser API
```

## Routes

All paths below are relative to `/api/v1`. The frontend can target a
different backend with `VITE_OPENCAST_API_BASE`. Prefer a same-origin reverse proxy;
separate origins require the backend's explicit origin allowlist and appropriate
cookie settings. API requests use credentials; cross-origin signed uploads do not.

| Method | Route | Contract |
| --- | --- | --- |
| GET | `capabilities` | Configured operations, media limits, local auth/billing flags |
| GET | `schemas` | JSON Schema generated from the shared schemas |
| POST | `assets/uploads` | `{idempotencyKey, kind, name, contentType, bytes}` |
| PUT/POST | returned upload URL | Raw file for PUT; returned form fields plus `file` for form POST |
| POST | `assets/:id/complete` | `{}`; validate stored bytes and return ready asset |
| GET | `assets/:id/access` | Fresh `{url, downloadUrl, expiresAt}` |
| POST | `assets/import` | `{kind: "gallery" or "generated", id, role?}`; server resolves original, never thumbnail |
| GET | `jobs?kind=character` | Newest first; omit kind to get all operation types |
| POST | `jobs` | Discriminated generation request; returns `{jobs}` for single or batch |
| GET | `jobs/:id` | Current job and output access |
| POST | `jobs/:id/cancel` | `{}`; unsupported cancellation returns conflict |
| POST | `jobs/:id/name` | `{name}` |

Example swap request:

```json
{
  "idempotencyKey": "b40defca-d70e-4fd0-a64d-a92c26121317",
  "kind": "character-swap",
  "inputs": {
    "video": "08089b48-de06-4c73-89dc-88c1bc39e6d8",
    "character": "29286a0f-933c-48fd-8492-91924998021c"
  },
  "parameters": {
    "prompt": "the person on the left",
    "quality": "720p",
    "keepAudio": true
  }
}
```

`motion-transfer` has the same media/settings contract, with optional
`inputs.background`. Its prompt is the enabled direction text, or empty when the
direction control is off. `character` accepts traits, art direction, prompt
overrides, seeds, reference placement and batch size without media inputs. The
UI checks capabilities before enabling generation. Motion operations become
available when the Pika H3 Flex installation and its models are ready.

Idempotency keys are UUIDs. Keep the same key and exact settings after a lost
response; changing settings under a key returns 409. Jobs expose application
IDs and safe presentation details, not worker paths or installation handles.
Output roles include `image` (character sheet), `portrait`, `full-body`, `video`,
`poster`, `source`, `reference`, and `manifest`, where available. Output URLs are
access leases: do not store them as identities or append query parameters to
signed URLs. Use the returned download URL as supplied. Polling jobs refreshes
their access URLs; `assets/:id/access` explicitly renews access.

Errors use `{error: {code, message}}`. Invalid inputs return 400; inaccessible
assets/jobs return 404; not-ready media, changed request keys and unconfigured
workflows return 409. Media validation failures return 422. Unknown internal
errors return 500 without stack traces, and preserve the request for reconciliation.

## Backend boundaries

`apiV1` accepts an asset service, executor, and principal resolver. The resolver
returns a stable user ID after authenticating the request. Every asset and job
lookup must enforce that owner. The current runnable entry points deliberately
use the local principal and bind to loopback; they are trusted local tools, not
public account services. Hosted authentication, database, storage and cloud
execution implementations belong in a separate backend repository and are not
included here. An external backend must enforce authentication and ownership;
CORS is not authentication.

An executor implements:

```text
capabilities() → {operations, authentication, billing}
submit(validatedRequest, owner) → Job[]
list(owner, optionalKind) → Job[]
get(jobId, owner) → Job
cancel(jobId, owner) → Job
rename(jobId, name, owner) → Job
importAsset(validatedSource, owner) → {id, status}
```

The executor must deduplicate/reconcile acceptance by stable source identity,
because the API can restart after the provider accepts work but before its
receipt is saved. It must persist the exact execution binding before submission.
Changing the selected backend must never redirect an already accepted job.

The shared adapter uses the portable transport in `server/executor-client.mjs`. It
uploads hashed inputs, freezes `appId`, `instanceId`, `sourceJobId`, executor and
installation IDs, submits `/v1/jobs`, polls phase, and downloads outputs with
size/SHA256 verification. Its private ledger survives restart. An uncertain
terminal result is retained for operator reconciliation, not silently rerun.

The storage implementation owns `issueUpload`, `upload`, `receive`, `inspect`,
`retain`, `access`, and `serve`. The asset service owns IDs, owner checks,
idempotency and readiness. Local storage streams bounded bytes to a temporary
file, validates image decoding or video container/duration/dimensions, computes
the content hash and finalizes retention. Uploaded names are metadata, never
filesystem paths. The fleet adapter uses managed storage for uploaded bytes;
the portable entry point stores files in its configured data directory.

A hosted storage adapter can issue short-lived signed PUT or form POST requests
and inspect the resulting object on completion. It must verify ownership,
actual size/type/content, and object immutability before making an asset ready.
It may return fresh signed access URLs instead of proxying content. Provider
secrets and privileged Supabase keys stay on the backend. Do not accept arbitrary
remote URLs as media inputs. The browser path has been tested against both signed
PUT and form POST fixtures; no Supabase adapter is deployed yet.

## Portable local service

Prerequisites: Node 22.18+ and npm; `ffprobe` for video validation. GPU execution,
ComfyGit installation, models and admission belong to the shared runner.

```sh
npm ci
npm run build
npm start
```

This starts the UI/API on port 8389 and stores private state under
`~/.local/share/opencast`. With no configuration, history/uploads work and
generation is explicitly unavailable. `PORT`, `OPENCAST_DATA`, `OPENCAST_DIST` and
`OPENCAST_ALLOWED_ORIGINS` are optional overrides. No models download or GPU service
starts implicitly. Resources installs the bundled motion worker and discovers its ready features automatically. See [MOTION.md](MOTION.md).

For an explicit deployment override, set `OPENCAST_EXECUTOR_CONFIG` to a private server JSON file shaped as follows. The
placeholder IDs must be replaced with the shared executor's real registry IDs:

```json
{
  "appId": "opencast",
  "instanceId": "my-cast-installation",
  "executorId": "REPLACE_WITH_REGISTERED_EXECUTOR",
  "target": {"kind": "local", "port": 8841},
  "recipes": {
    "character": {
      "installationId": "REPLACE_WITH_PINNED_INSTALLATION",
      "feature": "character",
      "revision": "REPLACE_WITH_RECIPE_REVISION",
      "module": "./character-recipe.mjs",
      "outputs": {
        "image": {"name": "sheet.png", "contentType": "image/png"},
        "portrait": {"name": "portrait.png", "contentType": "image/png"},
        "full-body": {"name": "body.png", "contentType": "image/png"}
      }
    }
  }
}
```

An SSH target instead uses `{kind: "ssh", host, port, sshPort?}` through the
existing SSH tunnel implementation. The backend recipe module exports:

```js
export async function prepare({request, jobId, inputFiles, directory}) {
  // Compile the exact workflow and pinned installation input contract.
  // inputFiles maps video/character/background to validated local originals.
  // Write reproducible graph/manifest files inside directory.
  return {
    inputs: /* the selected worker installation's domain contract */ {},
    files: /* logical filename → absolute retained input file */ {},
    details: /* safe UI presentation fields, no secrets or paths */ {}
  };
}
```

This is the integration point for the workflow thread. The worker adapter and
recipe must agree on feature, input fields, result filenames and runtime revision;
the app does not guess these from a ComfyUI graph. Recipe code is trusted backend
code and is never supplied by a browser. Keep revisions immutable. Example
catalog originals require a catalog/storage adapter; the portable shared runner
currently accepts uploaded references and its own generated character sheets.

## Deployment and verification status

`server/index.mjs` preserves the current fleet deployment and legacy routes while
mounting v1 over existing history and the managed Krea and FLUX3/Pika workers. `server/start.mjs` is the portable
shared-executor entry point. The same frontend uses v1 in both cases.

Tests cover media validation, ownership, restart/idempotency, conflicting keys,
rejected URLs/extra fields, SDK recovery after a lost admission response, actual
signed PUT/form POST browser uploads, renewable access, and existing history and
drag behavior. These are API/transport tests, not new GPU quality results.

Each generation starts its pinned ComfyGit runtime on demand; no temporary ComfyUI port is required. Connection failures preserve the request and appear in history, while startup, rendering and retention have distinct states.

Still separate work: Comfy Cloud adapter after its deployment documentation arrives; Supabase object
storage and authenticated principals/RLS; account UI, credit ledger, reservation,
settlement/refunds and payment integration; public deployment and fresh-machine
GPU bootstrap. Do not expose the local service publicly as a paid multiuser app.

## Resource management

`GET /api/v1/resources` returns the model catalog, connection state, runtime
readiness and resource jobs. `POST /api/v1/resources` accepts `setup`, `initialize`,
`scan`, or `download` with `resourceIds`. These local-admin operations require
the local principal and a privately configured, identity-pinned executor. The
browser cannot supply paths or model URLs. Hosted adapters must supply a separate
administrator authorization policy before exposing resource management.

Initial inspection may report `checking` while a large shared model index loads.
Concurrent inventory reads are coalesced and cached for up to five minutes; job progress is polled separately. An explicit Refresh bypasses the inventory cache. A catalog with unpublished
weights registers only its downloadable subset with the executor; manual weights
remain explicitly pending in the app. Model readiness and workflow installation
readiness are separate.

`setup` starts or resumes a durable backend setup process. It uses the configured
remote target or defaults to the local executor on port 8841. Read-only resource
inspection never bootstraps a worker. Snapshots include `executorKind`,
`setupAvailable`, and `setupJob` (status, progress and message). Setup receipts
are private backend state; installation plans and paths cannot be supplied by
the browser. The shared executor owns runtime jobs and model downloads.

### First-run setup and model storage

`GET /resources` adds `onboarding: {state, message}`, where state is `checking`, `required`, `ready`, or `unavailable`. Readiness checks installed runtime probes and model inventory, not whether a GPU runtime is awake. `modelDirectory: {path, currentPath, pending}` exposes the selected folder and currently indexed folder. A browser opens Resources once when its startup check reports `required`; no startup request installs anything.

`POST /resources` with `{ "action": "model-folder", "path": "/absolute/model-directory" }` persists a folder choice on the backend. It is rejected during setup. The next explicit `setup` action applies it through the shared executor storage API before runtime installation or downloads. Paths are on the selected executor. Existing files are preserved; changing the model store affects that ComfyGit workspace.
