# Credits and license notices

## SketchForge-3D

SketchForge-3D is an upstream project by the SketchForge contributors.

- Upstream repository: https://github.com/Formsmith746/SketchForge-3D
- Copyright: Copyright (c) 2026 SketchForge contributors
- License: GNU Affero General Public License v3.0 only (`AGPL-3.0-only`)
- Upstream license file: `LICENSE`

This file and the TL4K integration changes do not change the upstream license. Any modified SketchForge build distributed over a network must provide the corresponding source under the same license.

## TL4K CAD integration

The TL4K integration branch adds a generic adapter for:

- authenticated multipart delivery to the TL4K gateway;
- automatic `.skf` and thumbnail snapshots;
- save status, retry and conflict handling;
- source-link requirements for the deployed build.

The TL4K gateway, connector, TechyWeb launcher, dashboard and session/artifact services are separate TL4K components. They are not part of the SketchForge source tree and are not relicensed by this notice.

The source URL for the exact integration commit must be published before a production build is released. The build must set `NEXT_PUBLIC_SOURCE_CODE_URL` to the corresponding source revision.

## Third-party dependencies

The dependency set must be audited from the exact `package-lock.json` used by the build. The final release credits must list any dependency or asset whose license requires attribution, including Three.js, geometry/WASM components, Electron and bundled assets.

This file is a working fork notice and must be reviewed before the first TL4K CAD production release.

## Adapter implementation checkpoint

The first integration slice is implemented in the fork without importing TL4K modules:

- `apps/web/src/lib/remoteAutosave.ts` provides the configurable multipart adapter and IndexedDB queue;
- `apps/web/src/app/page.tsx` keeps the existing local `.skf` cache and forwards completed local packages plus the latest thumbnail;
- `tests/unit/remoteAutosave.test.ts` covers disabled mode, multipart payloads, retry/idempotency and `409` conflicts;
- `deploy/docker/Dockerfile` and `deploy/docker/compose.yaml` expose the autosave endpoint and corresponding-source URL as build arguments.

The gateway endpoint, authorization, session mapping and storage connector remain separate TL4K work. The fork must not be deployed until its public source revision and the corresponding `NEXT_PUBLIC_SOURCE_CODE_URL` are fixed.
