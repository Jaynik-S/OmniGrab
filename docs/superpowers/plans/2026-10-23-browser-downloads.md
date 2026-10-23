# Browser downloads implementation plan

> **For agentic workers:** Use subagent-driven-development task by task. Each implementation receives its own brief and fresh spec/quality review. The controller retains the acceptance ledger. Do not dispatch nested subagents.

**Goal:** The actual toolbar downloads the full selected Cinejoy episode as a valid MP4 with video/audio, selected quality, progress/cancel/retry and truthful Chrome completion.

**Architecture:** Preserve the existing detector. Add a separate durable download coordinator, one offscreen host, a dedicated packet-remux worker, bounded job-scoped binary transport, OPFS output and a Chrome Downloads save stage.

**Tech Stack:** Existing TypeScript/Chrome MV3/Node tests/Playwright, pinned `mediabunny` 1.62.1, local FFmpeg/ffprobe as independent test tools only.

**Spec:** [approved browser download design](../specs/2026-10-23-browser-downloads-design.md).

## Global constraints

- Keep the existing detector and its provenance. Preserve the distinction between an HLS source and an MP4 output.
- Pin public `mediabunny` **1.62.1**, MPL-2.0, with package integrity and notices. Bundle executable code locally. No original extension source, library binary, site rule or private protocol is copied.
- Add `downloads`, `offscreen`, and `unlimitedStorage` to the current three API permissions. No native helper, `scripting`, DNR, cookie API, DRM workflow or WASM CSP change is part of this proposal.
- Chrome 120 minimum; one processing job, two queued jobs, 50 recent terminal records. Metadata is separate from detection snapshots and media bytes never enter Chrome storage.
- Persisted phases are `queued`, `resolving`, `processing`, `ready-to-save`, `saving`, `complete`, `failed`, `canceled`, `interrupted`. `finalizing` is progress within processing, not a separate job phase.
- Four active resource fetches globally; one unacknowledged chunk per request; 256 KiB raw chunks; 8 MiB aggregate queued binary budget; 32 MiB input cache; 2 MiB manifests; 64 MiB bounded media reads with ranges for larger objects; at most three attempts for retryable failure.
- No success on missing audio, wrong quality, truncated source, muxer completion alone or a blob URL. Chrome saving must complete and the final saved media must pass independent validation.
- All media samples, full downloaded files and temporary browser profiles stay outside Git and `dist`.

## Shared interface map

Task 1 defines the authoritative types. Preserve these names across later tasks; add narrowly needed fields through the controller's recorded contract amendments.

```ts
interface DownloadStartRequest {
  requestId: string; tabId: number; epoch: number; mediaId: string;
  instance: number; variantId?: string; filename?: string;
}
interface DownloadSelection {
  tabId: number; epoch: number; mediaId: string; instance: number;
  pageUrl: string; frameId: number; documentId: string;
  sourceUrl: string; videoUrl: string; audioUrl?: string;
  requestedVariantId?: string;
  width?: number; height?: number; filename: string; output: 'mp4';
}
interface ByteRange { start: number; end: number; }
interface ResourceGrant { url: string; range?: ByteRange; }
interface DownloadPlan {
  selection: DownloadSelection;
  manifests: Array<{ url: string; text: string }>;
  resources: ResourceGrant[]; duration?: number;
}
type ResourceFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
interface SeekableOutput {
  write(data: Uint8Array, position: number): Promise<void>;
  flush(): Promise<void>; close(): Promise<void>;
}
interface RemuxProgress {
  phase: 'processing' | 'finalizing'; inputBytes: number;
  outputBytes: number; seconds?: number; duration?: number;
}
interface RemuxResult {
  bytes: number; duration: number;
  video: { codec: string; width: number; height: number };
  audio: { codec: string; channels: number; sampleRate: number };
}
```

`DownloadJob` is a versioned persisted metadata record containing ID/request ID/selection, phase/timestamps, progress, optional temporary file/browser download ID and structured failure. Its exact declaration belongs to Task 1. The coordinator and popup consume it rather than inventing separate versions.

Byte-range ends are inclusive. Fresh master validation excludes I-frame-only selections and resolves a declared default external audio rendition; ambiguous audio is rejected rather than guessed. Manifest request/final aliases use normalized absolute resource URIs resolved from the final response URL, preserving exact queries and all range/map/protection/discontinuity tags.

`requestedVariantId` is copied only from an explicit request; undefined means automatic highest-normal-video selection after fresh-master validation. A resolved `DownloadPlan.selection` contains actual final rendition URLs/dimensions; the coordinator keeps the initial persisted `job.selection` immutable for stable duplicate identity and passes the resolved plan to the host/engine. `sourceUrl` preserves original source identity. The engine reads selected `videoUrl`/`audioUrl`, never the master.

## Task 1: Validated selection, HLS plan and durable job metadata

**Files:** create `src/downloads/model.ts`, `validation.ts`, `plan.ts`, `hls-plan.ts`, `store.ts`; tests `tests/download-plan.test.ts`, `download-store.test.ts`.

**Consumes:** existing `Snapshot`, `MediaItem`, variants, document bindings and exact URL/parser helpers. **Produces:** shared interfaces above; `selectDownload(snapshot, request): DownloadSelection`; `resolveDownloadPlan(selection, fetcher, signal): Promise<DownloadPlan>`; a serialized `DownloadStore` with read/dispatch and injected storage adapter.

- [x] Write selection tests before implementation, including a genuine two-quality source and a stale instance/document rejection:

```ts
const selected = selectDownload(snapshot, {
  requestId: 'download-test-1', tabId: 7, epoch: 3,
  mediaId: item.id, instance: item.instance ?? 0,
  variantId: item.variants.find(v => v.height === 720)!.id,
  filename: 'Episode: one.mp4',
});
assert.equal(selected.height, 720);
assert.equal(selected.videoUrl, 'https://media.test/720/playlist.jpg');
assert.equal(selected.filename, 'Episode_ one.mp4');
assert.throws(() => selectDownload(snapshot, { ...request, instance: 999 }), /stale/i);
```

- [x] Run `node --experimental-strip-types --test tests/download-plan.test.ts`; retain the expected missing-feature/failing-assertion evidence.
- [x] Implement strict trusted-input shape/size checks, safe leaf filename generation, current tab/epoch/instance/frame/document binding, confirmed clear HLS eligibility, actual video rendition selection, declared associated audio and exact signed URLs. Reject an invalid supplied rendition rather than falling back silently.
- [x] Revalidate a fresh master when needed to distinguish normal video renditions from I-frame-only entries and resolve declared default audio; fetch only the selected video/audio media manifests, never every rendition. Parse maps, literal segments, byte ranges and discontinuity metadata needed for grants. Reject keys/protected or unsupported download constructs explicitly. Reuse supported helpers without changing detection behavior. Store actual fetched final URLs and manifest aliases so redirects resolve correctly.
- [x] Write and run store RED/GREEN tests: save-before-ack, immutable reads, restore shape/version validation, failed writes do not corrupt committed state, terminal retention, queue cap and duplicate request/source selection identities. Keep metadata bounded and private URL values out of diagnostic output.
- [x] Run focused tests, `npm.cmd run typecheck`, then the full unit suite once. Self-review and commit only Task 1 files. Report public signatures for downstream use plus RED/GREEN evidence.

## Task 2: Licensed packet remux engine and seekable disk output

**Files:** modify package/lock; create `src/downloads/remux.ts`, `opfs.ts`, focused `remux-source.ts`, `remux-validation.ts`; tests `tests/download-remux.test.ts`, `download-opfs.test.ts`; isolated native engine harness if browser APIs require it. Add local dependency notices/source reference; no original binaries.

**Consumes:** Task 1 `DownloadPlan`, `ResourceFetch`, `SeekableOutput`, progress/result types. **Produces:** `remuxToMp4(plan, { fetcher, output, signal, onProgress }): Promise<RemuxResult>` and a browser OPFS writer implementing the offset-aware output contract.

- [x] Install the exact approved public dependency and inspect its shipped declarations/license:

```powershell
npm.cmd install --save-exact mediabunny@1.62.1
```

- [x] Generate original deterministic short H.264/AAC fixtures with installed FFmpeg in ignored scratch. Include multiplexed HLS fMP4, MPEG-TS, selected 720/1080 quality and separate audio. A first regression must fail because no remux function exists or no valid output is produced.
- [x] Implement selected-playlist `Input`/`HLS_FORMATS` and explicit `EncodedPacketSink` → encoded video/audio source copying. Validate actual codec/config and selected dimensions. Preserve decode order and bounded A/V interleaving, await writes and do not use conversion modes that silently discard/re-encode tracks. Pass a custom `fetchFn` and hard global 32 MiB cache bound; retain MIME-disguised media by validated format bytes. Shipped library positive cache targets are soft: disable its persistent caches and use one grant-clipped, bounded block/range cache in the engine adapter; verify actual request/byte amplification.
- [x] Use `Mp4OutputFormat({ fastStart: false })` plus offset-aware `StreamTarget`. Prove short writes and backward patches with a real seekable sink:

```ts
await writer.write(Uint8Array.of(1, 2, 3), 0);
await writer.write(Uint8Array.of(9), 1);
await writer.flush();
await writer.close();
assert.deepEqual(await readOutput(), Uint8Array.of(1, 9, 3));
```

- [x] Test abort, truncated source, wrong selected dimensions, missing audio, invalid ranges and output failure. All handles/input/output resources close on both success and failure; flush/close precedes final File access. Count progress bytes from actual input/output, not manifest length.
- [x] Process the ignored captured `.superpowers/cinejoy-init-and-first-segment.mp4` through the engine as supplemental compatibility evidence. It is an approximately eight-second sample, not the final episode; generate committed tests independently.
- [x] Validate actual produced output with installed ffprobe and a decoder pass. Prove native OPFS in Chromium, not only a Node-memory writer. Run focused tests/typecheck/full unit suite once, self-review and commit. Report license/version/integrity and actual engine interfaces.

## Task 3: Bounded binary transport and page-context fallback

**Files:** create `src/downloads/transport.ts`, `binary-protocol.ts`, `src/content/download-fetch.ts`; minimally extend content entry point; tests `tests/download-transport.test.ts`, `download-content.test.ts` plus owned-browser transport harness.

**Consumes:** selection/plan grants and `ResourceFetch`. **Produces:** context-aware fetch client with fetch-compatible streaming responses, explicit grant updates, abort/dispose and metrics; trusted content receiver/port protocol for the offscreen host.

- [x] Write RED tests for worker404/page200 binary success, chunks larger than one message, MIME-disguised fragments, truthful response/final URL, exact range/status, failed fallback, stale-document rejection, duplicate/out-of-order chunks and abort.
- [x] Define and test JSON-safe `request`, `headers`, `chunk`, `ack`, `end`, `error`, `abort` messages with job/request IDs, monotonically increasing sequence/offset and bounded base64 data. Content validates same-extension trusted sender and accepts only the job's initial selected manifests then explicitly granted resources.
- [x] Preserve limits with a delayed consumer:

```ts
assert.ok(metrics.maximumActive <= 4);
assert.ok(metrics.maximumQueuedBytes <= 8 * 1024 * 1024);
assert.ok(metrics.maximumUnacknowledgedPerRequest <= 1);
assert.equal(metrics.afterAbort.active, 0);
assert.equal(metrics.afterAbort.queuedBytes, 0);
```

- [x] Connect originating content ports directly to the offscreen host using runtime connections, with a coordinator-validated one-time capability and exact document binding. The service worker requests attachment through `tabs.sendMessage`; it must not relay every binary byte or be the sole owner of a long transfer. Preserve transfer through a real service-worker stop/wake. Revalidate source/document when establishing or re-establishing a port.
- [x] Return a `ReadableStream`-backed response. ACK follows downstream acceptance; validate base64 length before decode; track aggregate physical resources and release only after actual cancellation/settlement. Use finite idle/request deadlines and at most three retryable attempts. Resume/retry only where exact range semantics prove correctness.
- [x] Native controls must cover real page CORS, withheld headers/body, physical socket cancellation, bounded concurrency, range mismatch, port disconnect and navigation. Require exact-document detach/settled receipt or proven old-document teardown before reusing disconnected physical slots; protect live/settling capabilities independently of bounded settled replay history. Keep the existing 2 MiB text handler unchanged. Run focused tests/typecheck/full unit suite once, self-review and commit. Report event/schema names and attachment API.

## Task 4: Offscreen host, worker and durable Chrome save coordinator

**Files:** create `src/downloads/coordinator.ts`, `offscreen.ts`, `offscreen.html`, `worker.ts`, browser adapter helpers; minimally extend background entry point and manifest/build; focused coordinator/host tests and native fixture download harness.

**Consumes:** reviewed Tasks 1–3 interfaces. **Produces:** `createDownloadCoordinator` with trusted `start`, `cancel`, `retry`, `snapshot`, `reconcile`; offscreen host lifecycle and downloadable finalized file. The background routes popup-only `download-start`, `download-cancel`, `download-retry`, `download-snapshot` messages. Every public result includes an explicit job/error outcome.

- [x] RED tests for idempotent start, save-before-start, one active/two queued, stale selection, trusted sender checks, host-creation races, real restart reconciliation and final save completion/interruption.
- [x] Add approved permissions and bundle only local executable entry points. Idempotently create one offscreen document using Chrome-120-compatible `runtime.getContexts` and `WORKERS`/`BLOBS`. Build allowlist grows to exactly the chosen worker/host/license files; audit the existing parser notice and new package notice/source reference.
- [x] The offscreen host owns workers, fetch clients, bounded pending resource requests, OPFS files and object URLs. Worker fetch broker can transfer ReadableStream bodies/ArrayBuffers through native `postMessage`; it must propagate AbortSignal into host/content IO and avoid full-resource accumulation. Offscreen only uses extension runtime APIs; Downloads remains in the service worker.
- [x] Resolve selected manifests, grant only resolved resources, run reviewed remux, verify result and close writer, then obtain a file-backed blob URL. The coordinator persists ready metadata and starts Chrome saving:

```ts
const id = await chrome.downloads.download({
  url: ready.objectUrl, filename: job.selection.filename,
  conflictAction: 'uniquify', saveAs: false,
});
// Persist id with phase saving; only its actual complete event permits complete.
```

- [x] Persist attachment identity before delivery and reconcile exact-document physical settlement after host loss. Strictly validated optional attachment/save-intent metadata may extend the authoritative job/store schema. Reconcile Chrome events/search and active host work after wake. A browser-complete event arriving before the ID save is resolved through persisted start/save ordering and follow-up search, not lost. Detect lost worker/host/browser process as interrupted; do not replay a duplicate transfer. Cancel queued/processing/saving appropriately and release resources after consumers finish. Startup removes or records orphan temporary files safely under the download namespace.
- [x] Native fixture: actual Chrome download completes; saved file matches expected tracks/duration; popup closure and actual SW stop/wake do not duplicate/restart work; cancellation/error cleanup is real. Run focused tests/typecheck/full unit suite/build, self-review and commit. Keep current detection listeners synchronous.

## Task 5: Usable popup controls and live job state

**Files:** minimally modify `src/popup/view.ts`, `index.ts`, styles/HTML as needed; tests `tests/popup.test.ts` and focused download-view/controller tests; native actual action popup harness.

**Consumes:** `DownloadJob` and reviewed background messages. **Produces:** per-source filename/output/quality/Download controls and live progress/cancel/retry/save outcomes with safe text rendering.

- [ ] RED tests require a real two-quality selector and user action data:

```ts
assert.deepEqual([...quality.options].map(o => o.textContent), ['1080p', '720p']);
quality.value = item.variants.find(v => v.height === 720)!.id;
downloadButton.click();
assert.equal(started.variantId, quality.value);
assert.equal(started.mediaId, item.id);
```

- [ ] Show HLS source and MP4 output separately, preserve page-title fallback, and create safe editable filename defaults. Disable unsupported/protected/unconfirmed sources with a reason; no download action on a blob URL. Preserve all source details/copy controls as secondary evidence.
- [ ] Preserve form edits/quality selection while storage updates arrive. Use stable request IDs to prevent double clicks starting duplicate jobs. Render queued/processing/finalizing/saving/complete/canceled/interrupted/failed honestly; unknown total size remains unknown. Progress bytes refer to media/output, not manifest bytes.
- [ ] Wire cancel/retry and errors, subscribe to the separate job-storage updates, and keep active-tab context correct. A download for an older source remains visible as its own job even after detection navigation, rather than attaching it to an unrelated row.
- [ ] Native actual action popup: select 720p, click Download, close/reopen popup, observe current job, cancel/retry and validate resulting saved file. Inspect screenshots/readability at existing width. Run focused tests/typecheck/full unit suite/build, self-review and commit.

## Task 6: Full Cinejoy output, failure controls and final review

**Files:** native download fixture/live harnesses under `tests/`, original generated fixture helpers; evidence under `docs/rea-evidence/downloads/`; README/product instructions and progress ledger. No media in Git.

**Consumes:** frozen built extension and reviewed source. **Produces:** actual final saved Cinejoy MP4 and independent evidence for the approved acceptance gates.

- [ ] Add native regression/control cases before any fixes needed by this phase. Record the authoritative RED condition, repair through the responsible implementation agent and scoped review, then rerun affected controls.
- [ ] Generate own HLS TS/fMP4, separate audio, byte-range, discontinuity and negative/protected sources. Validate saved outputs, exact selected quality/audio and resource use. Add a long-duration packet fixture and a >2 GiB transport/seekable-OPFS control; report those scopes accurately instead of calling a sparse IO file a proven large media remux.
- [ ] Capture actual full Cinejoy 1080p Download action in a fresh ours-only Chromium profile, selected exact episode, normal authorized playback/page context, and controlled workspace download directory. Wait on the real job/download handles; do not restart because a polling window expires. Pause the page's own player after detection to avoid unnecessary playback traffic.
- [ ] Retain build/library/fixture identities, selected manifest, expected 797 media entries, actual requested segments/ranges/bytes, actual Chrome complete state, output identity, bounded queue/memory samples and temporary-file cleanup. Never log private header/cookie/auth values.
- [ ] Independently probe/count and decode the entire saved output:

```powershell
ffprobe -v error -count_packets -show_streams -show_format -of json .superpowers/download-acceptance/cinejoy-1080p.mp4
ffmpeg -v error -i .superpowers/download-acceptance/cinejoy-1080p.mp4 -map 0:v:0 -map 0:a:0 -f null -
```

The harness supplies the real path as an argument array, checks exit codes, verifies 1920×1080 H.264 + AAC stereo and duration within two seconds of 3189.561635, and exercises first/middle/end playback/seeks. No preview result satisfies this step.

- [ ] Verify 720p selection and failure/lifecycle cases: popup close, actual SW stop/wake, content page navigation/closure, fetch/mux/save cancel, stall, range/truncation/expiry, quota/write error and Chrome interruption. Truthful recovery/cleanup matters; page-dependent loss cannot be reported as success.
- [ ] Run final `npm.cmd run check`, audited artifact/license checks, affected native detector neighbors and a whole-download-branch review with the actual plan/spec/ledger/evidence. Apply one final fix wave if needed, scoped re-review, then rerun final frozen-artifact acceptance impacted by changes.
- [ ] Update README/setup/reload instructions and research reports with measured behavior, exact hashes, commands and remaining limits. Mark this feature/goal complete only after all required evidence passes; broader untested original features remain explicitly unproven. Commit the reviewable final result.
