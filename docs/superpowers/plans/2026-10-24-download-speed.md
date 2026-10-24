# Download Speed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Substantially reduce full Cinejoy 1080p download time using the approved current-permission browser path, with measured before/after evidence and independently verified complete output.

**Architecture:** Keep the durable coordinator, offscreen host, worker, Mediabunny packet remux, OPFS and Chrome saving. Optimize byte conversion, job-scoped route selection, bounded range fetching and validation scheduling inside their existing boundaries. No copied DownloadHelper source, binary or private protocol.

**Tech Stack:** TypeScript, Chrome MV3 (minimum 120), Mediabunny 1.62.1, Node 24 tests, native Chrome/Playwright/CDP, FFmpeg/FFprobe.

**Spec:** `docs/superpowers/specs/2026-10-24-download-speed-design.md` (approach 1 approved).

## Global Constraints

- Keep Mediabunny 1.62.1, OPFS, Chrome saving and current authorization model.
- Keep raw runtime chunks at 256 KiB and one unacknowledged chunk per physical request.
- Retain the 8 MiB aggregate queue bound and no service-worker media relay.
- Use at most four physical fetches globally, including speculative work. Reserve demand capacity; at most three speculative reads may run, in selected playlist order.
- Keep a hard 32 MiB shared retained cache; library caches remain disabled.
- Range-ignored whole-object fallback remains capped at 64 MiB and must not permit four speculative 64 MiB allocations.
- No full-video buffer in memory; media and temporary profiles stay outside Git/dist.
- Never persist hints across jobs/navigation or use another document's context.
- Post-header/body failure is terminal; no unsafe byte resume.
- No success until the matching Chrome download completes.
- Keep public job phases/schema/permissions, popup interaction and output format stable unless a concrete necessity is reviewed first.
- Approach 2 requires a separate explicit permission/design decision.

## File responsibilities

`binary-protocol.ts` owns validated runtime byte encoding. A focused `worker-progress.ts` helper owns worker-boundary coalescing, used by `worker.ts`. `transport.ts` owns proven route hints and retains physical leases. `remux-source.ts` owns bounded read windows/cache/in-flight scheduling, with a focused helper permitted if the scheduling implementation needs its own unit. `remux-validation.ts` owns segment identities/probes; `remux.ts` installs validation at the consumption boundary. Unit files exercise those boundaries; native scripts measure production built artifacts. Research/performance findings go in `docs/DOWNLOAD_SPEED_INVESTIGATION.md` and portable summarized JSON receipts.

### Task 1: Fast binary conversion and bounded worker progress

**Files:** Modify `src/downloads/binary-protocol.ts`, `src/downloads/worker.ts`; create `src/downloads/worker-progress.ts`, `tests/download-binary.test.ts`; extend `tests/download-worker.test.ts`.

**Interfaces:** Preserve `decodeChunk(value: unknown): Uint8Array`, `produceBinary(...)`, and the binary message schema. Add `createWorkerProgress(send: (progress: RemuxProgress) => void, intervalMs?: number)` returning `{ push(progress: RemuxProgress): void; flush(): void; dispose(): void }`. This helper only coalesces progress; heartbeat stays in `worker.ts`.

- [x] Write conversion tests with literal bytes and real producer messages; use a scoped native-method shim only to exercise feature selection on Node, restoring descriptors in finally. Test lengths 1, 2, 3, 8193 and 262144; malformed alphabet, padding, wrong byte length, oversized input, sequence and offset. A missing fast path must fail a native-path test; fallback retains independent exact-byte comparisons.

```ts
const chunk = { type: 'chunk', jobId: 'j', requestId: 'r', sequence: 0, offset: 0, bytes: 3, data: 'AP+A' };
assert.deepEqual([...decodeChunk(chunk)], [0, 255, 128]);
assert.throws(() => decodeChunk({ ...chunk, data: 'AP A' }), /download-chunk-invalid/);
```

- [x] Write coalescing tests using Node mock timers: first actual input and phase transition arrive immediately, a burst is bounded, flush publishes newest exact counters before complete/failed, disposal cancels timers. The mutation is posting every packet or losing final counters.

```ts
const sent: RemuxProgress[] = [];
const progress = createWorkerProgress(value => sent.push(value));
for (let n = 1; n <= 1000; n++) progress.push({ phase: 'processing', inputBytes: n, outputBytes: 0, seconds: 0 });
assert.equal(sent.length, 1);
progress.flush();
assert.equal(sent.at(-1)!.inputBytes, 1000);
progress.dispose();
```

- [x] Run `node --experimental-strip-types --test tests/download-binary.test.ts tests/download-worker.test.ts`; retain expected failing output before implementation.
- [x] Feature-detect native methods by structural types, preserving `this` receivers. Decode fallback uses a preallocated typed array and indexed `charCodeAt` loop, avoiding `Uint8Array.from` callbacks. Native encoding uses `.toBase64()` when available; retain bounded old-browser encoding fallback. Keep validation before conversion and verify resulting length. Implement the timer helper with latest-value replacement and immediate meaningful transitions; flush/dispose on both worker completion and failure.

```ts
const result = new Uint8Array(raw.length);
for (let index = 0; index < raw.length; index++) result[index] = raw.charCodeAt(index);
```

- [x] Run focused tests, `npm.cmd run typecheck`, and existing transport/content tests. Benchmark the same public decoder payload used in the investigation with warmup, exact checksum and Node version; do not impose CPU time assertions in unit tests. Commit the focused code/tests; write test evidence to the ignored task report, without force-adding scratch artifacts.

### Task 2: Reuse the proven page route within a job/document

**Files:** Modify `src/downloads/transport.ts`; extend `tests/download-transport.test.ts`, `tests/download-transport-timeout.test.ts`; reuse `tests/download-transport-fixtures.ts`.

**Interfaces:** Keep `createDownloadTransport(options)` and `ResourceFetch` unchanged. Store origin hints only inside that transport instance, bound to its existing capability and selected document. Existing `checkDocument`, `attempt`, physical `done` and shared three-attempt/deadline accounting remain authoritative.

- [x] Add a two-resource real-port test: direct fetch returns 404, page fetch succeeds for both; after consuming and settling first response the second resource bypasses primary. Assert exact output bytes and one direct call rather than two.

```ts
const transport = createDownloadTransport({ jobId: 'j', selection, runtimeId: 'test', validateDocument: async () => true,
  fetcher: async () => { primaryCalls++; return new Response(null, { status: 404 }); } });
await attachPage(transport, async () => new Response(new Uint8Array([4, 5, 6])));
transport.grantResources([{ url: 'https://cdn.test/a' }, { url: 'https://cdn.test/b' }]);
for (const url of ['https://cdn.test/a', 'https://cdn.test/b']) assert.deepEqual([...new Uint8Array(await (await transport.fetch(url)).arrayBuffer())], [4, 5, 6]);
assert.equal(primaryCalls, 1);
await transport.dispose();
```

- [x] Add isolation tests for a different origin, new transport/job, stale document and failed page body. Add eligible pre-header stale-hint invalidation/recovery with exact bounded attempt order, including abort/quarantine. No attempt after body failure.
- [x] Run focused transport tests and retain intended failures.
- [x] Add a transport-local origin set. Only establish a hint after the fallback page transaction settles successfully, not merely after headers. When a preferred page route fails before headers with an eligible recoverable error, clear it and try primary within the existing budget. Do not retry caller abort, grant/document failure, body failure or uncertain physical ownership. Clear hints during disposal.

```ts
const origin = new URL(url).origin;
let page = provenPageOrigins.has(origin) && !!port && ready;
```

- [x] Run transport/timeouts/content tests and typecheck. Report attempts saved and all lease/queue invariants. Commit.

### Task 3: Larger bounded ranges and owned read-ahead

**Files:** Modify `src/downloads/remux-source.ts`; create `tests/download-remux-source.test.ts`; extend relevant cache assertions in `tests/download-remux.test.ts`. A `src/downloads/remux-read-cache.ts` helper is permitted if needed to keep scheduling separate from Mediabunny source construction.

**Interfaces:** Preserve the `RemuxSourceAdapter` constructor and `fetch/open/release/dispose/check` consumers. Add an internal optional final constructor options argument `{ readWindowBytes?: number; prefetch?: boolean }` for controlled native benchmarking; default window 4 MiB. Add a readonly metrics object with actual `cachedBytes`, `maximumCachedBytes`, `inFlightBytes`, `maximumInFlightBytes`, `active`, `maximumActive`, `speculative`, `maximumSpeculative`, `requests`, and `cacheHits`. No new popup controls or durable schema. `dispose` must synchronously abort and clear retained state; an async `settled(): Promise<void>` allows remux cleanup to await owned network settlement.

- [ ] Test sequential requests spanning a multi-MiB granted object: exact bytes, fewer HTTP requests, truthful Content-Range, final short window. Test restricted MAP/ranges never widened, query identity, same-window concurrent demand deduplication, cache LRU eviction under more than 32 MiB, and actual owned ArrayBuffer accounting.

```ts
const first = await adapter.fetch(url, { headers: { Range: 'bytes=0-31' } });
assert.deepEqual([...new Uint8Array(await first.arrayBuffer())], Array.from({ length: 32 }, (_, n) => n));
const second = await adapter.fetch(url, { headers: { Range: 'bytes=262144-262175' } });
assert.equal(second.headers.get('Content-Range'), 'bytes 262144-262175/10485760');
assert.equal(requests, 1);
```

- [ ] Add a delayed native-like stream fixture that exposes multiple selected-resource reads. Assert at most four total active reads, at most three speculative, foreground progress while speculation is present, cancellation aborts/settles all work, and no unhandled prefetch rejection. Test 200 fallback with known/unknown range support, invalid lengths/truncation, large allocation serialization, and cancellation while waiting for allocation capacity.
- [ ] Run new source/cache tests against current code; retain failures proving repeated ranges/no prefetch and missing settlement.
- [ ] Implement deduplicated aligned windows clipped to grants and known object ends. Retain actual windows or independent copied blocks with accurate accounting; avoid retaining small views of large uncounted buffers. Cache admission evicts before exceeding 32 MiB. Register every read before launch and release byte/slot accounting in finally. Queue at most three selected next resources/windows for speculative execution; a demand can promote an already-owned speculative request rather than duplicate it.

```ts
const windowStart = Math.max(grant.range?.start ?? 0, Math.floor(start / readWindowBytes) * readWindowBytes);
const windowEnd = Math.min(windowStart + readWindowBytes - 1, grant.range?.end ?? Infinity, knownTotal - 1);
```

- [ ] Disable speculative admission for origins observed to ignore ranges. Serialize complete-object allocation, including first unknown-origin responses, with a separate bounded allocation gate; do not buffer stalled responses outside accounting. All complete bodies remain capped at 64 MiB. Preserve transport's max four physical leases; adapter scheduling may be stricter but never looser. A later task will await adapter settlement in remux finally.
- [ ] Run focused source/remux tests, typecheck and full check once this unit is stable. Report window request counts and peak cache/staging/active/speculative metrics. Commit.

### Task 4: Validate each unambiguous segment immediately before consumption

**Files:** Modify `src/downloads/remux-validation.ts`, `src/downloads/remux-source.ts`, `src/downloads/remux.ts`, `tests/download-remux.test.ts`; create `tests/download-remux-validation.test.ts` if identity classification benefits from a small focused test.

**Interfaces:** Preserve the eager `validateSegmentConfigurations(...)` as fallback. Add `prepareSegmentValidation(plan, sources, video, audio): Promise<void>` and `sources.setSegmentGate(gate: (url: string) => Promise<void>): void`. `open(url, probeText?)` uses async CustomPathedSource handling; probeText mode bypasses only that Input's gate. Root manifests and MAP resources are not media gates. This task consumes Task 3's `settled()` method.

- [ ] Update the existing blocked-later-segment test to assert useful MP4 output before the later segment finishes instead of preserving the deliberately removed all-fragment startup pass. Add a delayed final fragment fixture and assert output begins without downloading that fragment. The regression must fail against eager validation.

```ts
const progress: RemuxProgress[] = [];
// The fixture blocks the last segment body, while the real first segment is available.
assert.ok(progress.some(value => value.outputBytes > 0), 'earlier validated segments must reach MP4 output');
```

- [ ] Keep actual later video/audio/TS config mismatch tests. Add repeated-URL/byte-range/MAP ambiguity cases that deliberately select eager fallback; test probe gate isolation, one validation per identity, rejection propagation and cancellation without recursive waits. Initial tracks/config/dimensions are checked before muxing.
- [ ] Run focused remux tests and retain the eager-startup regression failure before changing scheduling.
- [ ] Extract segment descriptors containing playlist URL, media URL, MAP/range identity, text and track responsibilities from the existing strict parser. If identities cannot map URL to exactly one segment configuration, run eager validation. Otherwise install a promise-memoized gate and validate the initial segment(s) as well as all later segment children. A reused bootstrap UrlSource must not bypass initial verification. Gate uses probe-only Inputs, releases each in finally, and checks expected signatures using the existing codec/config rules. Keep full Input timestamps and packet iteration unchanged.

```ts
const validation = new Map<string, Promise<void>>();
sources.setSegmentGate(url => {
  let pending = validation.get(url);
  if (!pending) { pending = validateDescriptor(descriptors.get(url)!); validation.set(url, pending); }
  return pending;
});
```

- [ ] Ensure every cancellation/error path disposes sources and awaits `settled()` before closing/reusing job resources. A later mismatch may leave temporary output only until normal cleanup; it never starts Chrome saving. Run remux independent FFmpeg decode/frame fidelity fixtures, host lifecycle tests and typecheck. Commit.

### Task 5: Matched native benchmarks and full Cinejoy acceptance

**Files:** Extend `tests/download-transport-browser.mjs`, `tests/download-engine-browser.mjs` or add `tests/download-speed-browser.mjs`; update `tests/download-acceptance-live.mjs` only where metric capture requires it. Add `src/downloads/base64.ts` and focused `tests/download-base64.test.ts`, and update `src/downloads/binary-protocol.ts` to remove the measured remaining wire-validation cost. Update `docs/DOWNLOAD_SPEED_INVESTIGATION.md`; add concise portable summarized JSON evidence under `docs/rea-evidence/download-speed/`. Large logs/media/profile data remain ignored scratch.

**Interfaces:** Test harnesses consume the baseline `b8b1671` and optimized production build without runtime patching, use owned temp profiles, and write explicit build hashes/source identities/timing endpoints. No changes to the normal product API are required for benchmark observability; use CDP timing and existing progress/job/download state.

- [ ] Tune the remaining measured base64 validator before final benchmarks. Add `isValidBase64(data: string, bytes: number): boolean` in the focused helper; check exact encoded length and padding count derived from bytes, then scan non-padding character codes for only ASCII A-Z/a-z/0-9/+/ and require literal equals signs in the padding positions. Preserve the existing acceptance of nonzero unused pad bits; decoded byte length remains independently checked by `decodeChunk`. Test literal valid/invalid inputs, every ASCII code in representative payload positions, Unicode/whitespace/internal padding, one/two/no padding, wrong declared sizes and maximum payload mutations. Watch the new helper tests fail before implementation, then run them plus binary/transport tests and typecheck. Do not add timing assertions to unit tests. Native evidence in `.cache/download-speed/native-validation-loop-probe.json` measured the candidate strict scan at 114.68 MiB/s versus 13.95 MiB/s for the existing repeated-group expression on the same valid payload; this justifies the change but does not prove malformed-input equivalence or final bridge throughput.

```ts
const padding = (3 - bytes % 3) % 3;
const end = data.length - padding;
for (let i = 0; i < end; i++) {
  const code = data.charCodeAt(i);
  if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) || code === 43 || code === 47)) return false;
}
for (let i = end; i < data.length; i++) if (data.charCodeAt(i) !== 61) return false;
```

- [ ] Capture immutable baseline build assets from Git in ignored scratch before replacing dist. Keep the exact baseline source and build hashes. Native fixtures use the same deterministic data and network delay/page-only context for both builds. Benchmark 1/4/8 MiB windows through the internal constructor option, select the measured best bounded default, and explain any tuning change.
- [ ] Run a transport-only actual payload greater than 2 GiB through real Chrome JSON messaging and OPFS, validating exact data, output length/backpatches and cleanup. Record wall time, MiB/s, CPU/memory where available, queue bound and actual active requests. A 64 MiB/s bridge is an aim, not permission to lower fidelity or hide a measured ceiling.
- [ ] Run matched complete generated HLS downloads through built host/worker and Chrome save. Compare first input/output, MP4-ready, Chrome-complete, network request counts/bytes, useful byte amplification, progress traffic, active requests, cache/staging/queue and cleanup. Add browser harness assertions on bytes and limits, not fragile wall-clock thresholds.

```js
assert.equal(receipt.chromeState, 'complete');
assert.equal(receipt.actualBytes, receipt.expectedBytes);
assert.ok(receipt.maximumActive <= 4);
assert.ok(receipt.maximumCachedBytes <= 32 * 1024 * 1024);
```

- [ ] Run `npm.cmd run check` on final code; perform targeted native lifecycle checks for four-read cancel, source navigation/closure, real service-worker stop/wake, popup close, expiry/truncation/storage failure, terminal cleanup. Preserve exact live handles until authoritative completion; never restart because a polling observation timed out.
- [ ] Run the complete same Cinejoy 1080p source using built artifacts with normal CORS and exact page/document. Verify all 797 segments plus MAP; save the MP4, record all timing endpoints, and run independent FFprobe, full A/V decode, packet counts, duration/quality, beginning/middle/end playback and faithful audio against retained validated output. If source identity has changed, document and compare equivalent current baseline/optimized runs rather than claiming a paired old result.
- [ ] Record measured improvement and remaining ceiling. Mark reported DownloadHelper 30 seconds as reported unless actually observed. Update investigation/spec status and commit portable evidence/documents. Complete broad branch review before offering integration; do not merge this new branch without authorization.
