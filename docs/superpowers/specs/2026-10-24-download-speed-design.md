# Browser download speed design

Date: 2026-10-24. Status: **proposed, awaiting user approval**. Investigation and baseline only; no download behavior changed. Branch `feat/download-speed`, baseline `b8b1671`.

## Goal and comparison

Make the existing full Cinejoy 1080p download substantially faster while retaining the exact selected video/audio, final-file integrity, bounded resources, cancellation and durable recovery. The user reports about ten minutes versus DownloadHelper's thirty seconds for the same episode and quality. Thirty seconds is a performance target, not an established achievable result on the current source/network.

Measure Download click to first input, first MP4 output, MP4-ready, Chrome-save start and Chrome-complete separately. Preserve cold/warm-cache and network/profile conditions. The prior full 45-minute run remains historical evidence, not an apples-to-apples contemporary wall-time baseline. See [investigation](../../DOWNLOAD_SPEED_INVESTIGATION.md).

## Approaches

1. **Recommended: optimize the current browser-only path and permissions.** Remove repeated failed routes and avoid unnecessary round trips, conversion work and startup passes. Keep Mediabunny 1.62.1, OPFS, Chrome saving and current authorization model. This has strong measured justification and the smallest permission/lifecycle change.
2. **Alternative: add job-scoped direct-fetch request-header rules.** Closest to the installed original's inspected request-context path, removing page binary messaging where successful. Requires `declarativeNetRequestWithHostAccess`, tightly scoped Origin/Referer-only policy and durable rule cleanup/reconciliation. No cookie/authorization copying. This is not part of approach 1; evaluate separately if the retained page bridge remains the measured limit.

No native helper, original WASM/source copy, new codec/transcoding engine, DRM workflow or broad header rewriting is proposed.

## Recommended architecture

Keep popup -> durable coordinator -> offscreen host -> dedicated remux worker -> seekable OPFS -> Chrome Downloads. The changes sit inside existing transport/source/validation/progress boundaries. Do not mix detection-state snapshots with media/download metadata.

### 1. Binary conversion and worker progress

- Feature-detect native `Uint8Array` base64 methods on newer Chrome. Provide an efficient bounded fallback for Chrome 120 and Node tests. Preserve strict message shape, length, alphabet/padding, sequence/offset checks and decoded-byte equality; native conversion must not weaken malformed-input rejection.
- Keep raw runtime chunks at 256 KiB and one unacknowledged chunk per physical request. ACK follows successful downstream acceptance, including reentrant consumers. Retain the 8 MiB aggregate queue bound and no service-worker media relay.
- Coalesce worker-to-host progress at approximately 250 ms, keeping immediate first real input, phase changes and final/failure counters. Heartbeat and host-to-durable notification behavior remain independent. Final counts must not be lost behind a timer.

### 2. Reuse a proven request route

- Remember, only within the current job/capability/document, when direct extension fetching fails and normal page fetching succeeds. Prefer that proven page route for later resources at the same origin; do not repeat thousands of known-failing requests.
- A hint is not authorization. Revalidate the exact document and grants on every request. Never persist hints across jobs/navigation or use another document's context.
- On eligible pre-header failure, invalidate stale hints and use bounded recovery within the existing three-attempt/shared-120-second budget. Caller/overall abort and uncertain physical ownership still prohibit replacement work. Post-header/body failure is terminal; no unsafe byte resume.

### 3. Bounded larger reads and read-ahead

- Separate HTTP read windows from runtime message chunks. Start with a 4 MiB aligned HTTP window, clipped to the exact resource/MAP/range grant and object end. Benchmark 1/4/8 MiB internally before selecting a final value; do not expose tuning details as product controls.
- Keep a hard 32 MiB shared retained cache; library caches remain disabled. Count actual owned buffers correctly. Deduplicate overlapping in-flight reads; record maximum retained and in-flight bytes separately.
- Use at most four physical fetches globally, including speculative work. Reserve demand capacity; at most three speculative reads may run, in selected playlist order. Keep video/audio association intact and do not fetch unrelated renditions.
- Normal four-window staging is bounded. Range-ignored whole-object fallback remains capped at 64 MiB and must not permit four speculative 64 MiB allocations: disable speculative admission for such origins and serialize large fallback allocation. Preserve truthful ranges, exact URLs/queries, short objects and cancellation.
- All speculative work is owned by the job, observed for errors and physically aborted/settled on cancellation. No unhandled background promise or new-job overlap; existing quarantine and exact-document settlement rules stay intact.

### 4. Validate immediately before consumption

- Keep actual codec/dimension checks and public one-segment probe Inputs. Replace the full up-front pass with an async child-source gate for playlists whose media identities are unambiguous: validate the exact segment before the main demuxer can consume it, then reuse warmed bytes immediately.
- Probe reads must bypass only their own gate through an isolated mode, not a global validation-off switch. Avoid recursive validation/deadlock and duplicate probes. Release each probe in finally; retain the original full Input for timestamps/packet order.
- Check the initial selected tracks before muxing. A later mismatch fails and removes temporary output before any Chrome save. Do not silently drop, transcode or combine tracks.
- Keep the existing strict eager path for layouts where a path cannot uniquely identify the required segment/MAP/range, such as ambiguous shared-resource byte ranges. Performance scope and fallbacks must be documented; existing supported sources must not lose correctness.

## Files and compatibility

Expected changes: `src/downloads/binary-protocol.ts`, `transport.ts`, `remux-source.ts`, `remux-validation.ts`, `remux.ts`, `worker.ts`, small focused helpers where necessary, and focused unit/native performance fixtures and documentation. Keep public job phases/schema/permissions, popup interaction and output format stable unless a concrete necessity is reviewed first.

No wholesale rewrites. Existing hard bounds, source-tab requirements, safe errors, storage preflight and Chrome-consumer lifetime remain. No success until the matching Chrome download completes. No full-video buffer in memory; media and temporary profiles stay outside Git/dist.

## Performance and correctness evidence

- Retain the 291-test baseline and add behavioral regressions before each change. Cover native/fallback conversion equivalence and malformed data, proven-route hits/invalidation/recovery, read-ahead overlap/dedup/budgets, grant clipping and whole-object fallback, lazy-validation mismatch/abort/recursion/range fallback, and final worker progress flushing.
- Use original generated HLS/native fixtures with deterministic request delay and page-only request context. Benchmark baseline and optimized builds against identical payloads/settings; record bytes, requests, active concurrency, first output, progress-message count, CPU/worker memory, queue/cache/staging peaks and cleanup. Keep source/cache identities explicit.
- Re-run actual >2 GiB transport/OPFS control with exact bytes, backpatches and cleanup. Aim for at least 64 MiB/s on the measured modern native bridge to support the thirty-second file-size target; if hardware or a component prevents that, identify and measure the ceiling rather than claim the target passed.
- Run the complete current Cinejoy 1080p source on unmodified built artifacts, with all 797 segments and associated initialization, normal CORS and exact source identity. Verify final file size, quality, duration, packet counts, full independent A/V decode, beginning/middle/end playback and faithful audio. Compare encoded media/timestamps against the retained validated output where appropriate; never substitute lower quality or a short preview.
- Report MP4-ready and Chrome-complete separately, raw throughput and successful-byte amplification, absolute real-source time and controlled before/after results. The user's original thirty seconds remains user-reported unless an authorized original-extension run independently establishes it. Do not claim all-site or DownloadHelper parity.
- Recheck popup closure, real service-worker stop/wake, source navigation/closure, cancellation with four active reads, expiry/truncation, storage failure and final cleanup. Preserve exact handles until terminal outcome; no arbitrary deadline/restart of a live full transfer.

## Approval boundary

Approve approach 1 to authorize the implementation plan and changes above. Approach 2 requires a separate explicit permission/design decision. Source inspection, REA receipts and baseline tests are already complete; implementation has not started.
