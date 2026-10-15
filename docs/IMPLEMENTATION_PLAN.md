# Media Detection Engine Implementation Plan

> **For agentic workers:** Use subagent-driven-development for independent parser/collector tasks and inline execution for shared state and browser integration. Track each task below and verify before committing.

**Goal:** Build an original TypeScript MV3 media detector and minimal debugging popup, then compare it with the installed original on the same authorized pages.

**Architecture:** Network, DOM/resource and manifest evidence converge in a serialized, document-scoped store. A bounded manifest probe enriches and groups sources. Session snapshots survive worker instance restarts; browser code never assumes webRequest provides bodies.

**Tech Stack:** TypeScript, native Chrome MV3 APIs, esbuild, Node's test runner, fast-xml-parser for validated MPD XML, linkedom only for DOM fixture tests.

**Spec:** [DETECTION_ARCHITECTURE.md](DETECTION_ARCHITECTURE.md); [DETECTION_TEST_MATRIX.md](DETECTION_TEST_MATRIX.md).

## Global constraints and rulings

- Original code only; no proprietary extension source or research captures in the build.
- Minimum Chrome 120; required permissions `webRequest`, `webNavigation`, `storage`, HTTP(S) host access.
- Preserve exact signed queries; never promote blob URLs to remote downloadable sources.
- Reject stale document/generation work; show failed manifest fetches explicitly.
- No DRM/paywall/access-control bypass and no download implementation in this milestone.
- Ruling: the user's Phase 3 request authorizes implementation after the completed research/design work. The earlier extra approval checkpoint was unnecessary; it is withdrawn.
- Ruling: use the authorized current workspace on `feat/detection-engine`, preserving the user's capture. A separate worktree adds no needed isolation to this otherwise empty implementation tree.
- Ruling: browser-test fixtures and research remain separate from production source. No optional worktree or execution-choice prompt interrupts the authorized task.

## Task 1: Typed core, classification and state transitions

**Files:** `src/core/model.ts`, `identity.ts`, `classify.ts`, `reducer.ts`; `tests/core.test.ts`.

**Interfaces:** `normalizeUrl(url): string | undefined`; `classify(observation): {kind,status,probe,reason?} | undefined`; `emptySnapshot(): Snapshot`; `navigate(state, tabId, url, now, documentId?): Snapshot`; `ingest(state, observation): {state: Snapshot, probe?: ProbeJob}`; `applyManifest(state, job, info): Snapshot`; `probeFailed(state, job, reason): Snapshot`.

- [ ] Write behavioral tests for MIME versus suffix, tiny valid media, fragments, signed URL identity, multi-method deduplication, parent-child grouping, unrelated videos and stale generation rejection.
- [ ] Run `npm test`; verify the missing behavior fails.
- [ ] Implement pure transitions with bounded state, explicit provenance/status and immutable snapshots.
- [ ] Run tests/typecheck and commit the verified core.

Representative acceptance assertion (expectation derived from a literal fixture):

```ts
assert.equal(classify({tabId: 1, frameId: 0, url: 'https://cdn.test/file', method: 'network', mime: 'video/webm', statusCode: 206})?.kind, 'direct');
```

## Task 2: Independent HLS and DASH parsers

**Files:** `src/manifests/hls.ts`, `dash.ts`, shared parser helpers as needed; `tests/manifests.test.ts`; original `tests/fixtures/*`.

**Interfaces:** `parseHls(text, baseUrl): ManifestInfo`; `parseDash(text, baseUrl): ManifestInfo`. Throw an Error for invalid, excessive or unsupported manifest structure; no network I/O. Consume `Variant`/`ManifestInfo` from core model.

- [ ] Write failing fixture tests: quoted HLS attributes, relative `.jpg` renditions, audio/subtitle groups, live/VOD, segments/initialization, protection markers; DASH BaseURL inheritance, periods/representations/audio, malformed XML and entity rejection.
- [ ] Run the targeted tests and observe expected failures.
- [ ] Implement independent parsers with text/depth limits and validated XML, preserving queries and explicit child relationships.
- [ ] Run fixtures/typecheck; review source and commit the parser stage.

```ts
assert.deepEqual(parseHls(master, 'https://cdn.test/path/master.m3u8').variants.filter(v => v.kind === 'video').map(v => v.height), [720, 1080]);
```

## Task 3: Durable browser store and manifest probe

**Files:** `src/background/store.ts`, `manifest-probe.ts`, `network.ts`, `index.ts`; `tests/store.test.ts`, `tests/probe.test.ts`.

**Interfaces:** `DetectionStore` accepts asynchronous `load`/`save` functions; serializes reducer updates; exposes `read()` and `dispatch(...)`. `ManifestProbe` accepts injected fetch and store, deduplicates jobs, limits concurrency/bytes/deadline, and records results against the originating epoch.

- [ ] Write failing tests with real deferred promises for restoration ordering, concurrent writes, rejected save/revision behavior, stale probe completion, queue deduplication, timeout and streamed-size rejection.
- [ ] Implement and wire synchronously registered network/navigation/message listeners. Capture request generation before responses; sender metadata supplies trusted tab/frame/document IDs.
- [ ] Restore pending work on wake-up without indefinite keepalive. Invalidate top and frame documents on navigation; remove closed tabs.
- [ ] Run all relevant tests and typecheck, then commit browser integration.

```ts
assert.equal(Object.values((await store.read()).tabs['1'].media).length, 0); // old-epoch probe completed after navigate
```

## Task 4: DOM/resource collector, debug UI and distributable

**Files:** `src/content/collector.ts`, `index.ts`; `src/popup/index.ts`, `index.html`, `style.css`; `extension/manifest.json`; `scripts/build.mjs`; `tests/content.test.ts`, artifact checks.

**Interfaces:** collector reports `Observation` payloads without trusted tab IDs; background validates and fills provenance from sender. Popup reads the queried browser tab's snapshot, renders text safely, exposes URL copy/rescan and diagnostics.

- [ ] Write failing DOM fixture tests for initial/current/source URLs, inserted elements, changed source, blob context, resource candidates and reachable open shadow roots.
- [ ] Implement bounded batched collectors and schema-validated messages, without forcing playback or reading cross-origin parent DOM.
- [ ] Build minimal accessible controls; bundle only manifest, runtime JS and popup assets. No research files in dist.
- [ ] Run DOM/core tests, typecheck, build and inspect the artifact; commit.

## Task 5: Browser comparison, lifecycle tests and gap fixes

**Files:** original test server/fixtures under `tests/browser/`; executable browser harness under `scripts/`; result summaries under `docs/`; README usage/limits.

- [ ] Load the built extension in a browser that supports unpacked-extension automation, preserving the original test profile. Verify installation, service worker and content injection.
- [ ] Exercise real valid direct MP4/WebM, HLS, DASH, delayed JS source, blob/MSE, multi-origin iframe, multiple videos/qualities, and no-video cases.
- [ ] Stop/restart the actual worker; verify session recovery, tab/frame navigation, stale async rejection and popup rendering.
- [ ] Compare independent original/new snapshots and timing evidence under identical conditions. Retain failed/blocked outcomes; do not infer parity from unit tests.
- [ ] Fix measured gaps with failing regression tests first. Run `npm run check`, artifact audit and the affected browser cases, then commit.

## Completion evidence

Every completed task records its actual commands/results and commit in `DEVELOPMENT_PROGRESS.md`. Completion of the full objective requires original/new results across all eight requested categories plus documented limitations, not merely a successful build or a subset of green fixtures.
