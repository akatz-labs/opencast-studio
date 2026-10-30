# Third-party notices

The shared executor transport in `server/executor-client.mjs` is adapted from the MIT-licensed app-config executor client. It retains local/SSH transport, hashed input uploads and verified output downloads. Machine discovery and default workstation configuration are not bundled.

MIT License

Copyright (c) 2026 Akatz Labs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The pinned shared runtime is included under `vendor/shared-runtime`, with its
MIT license and exact file identities in `provenance.json`. Its package identity
and standard shared storage names are upstream compatibility identifiers, not
workstation configuration. The ComfyGit wheel bundle under `resources/toolchain`
retains each distribution's license metadata and checksums.

The shared runtime includes a documented CPU-only installation patch. It skips GPU session release for dependency-only installation jobs and rejects service startup under that mode; the patch hash is recorded in provenance.json.

## About badges

Brand icons in `public/badges` are from [Simple Icons](https://simpleicons.org/), distributed under [CC0 1.0](https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md). Source URLs are recorded in `src/about-links.json`. Brand names and marks belong to their respective owners. The website globe uses the existing Lucide icon library.
