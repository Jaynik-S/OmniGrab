# Download speed investigation

Date: 2026-10-24 (America/Toronto). Branch: `feat/download-speed`, from `main` commit `b8b1671`. Baseline check: 291 tests, typecheck and eleven-file/license build audit pass. No download behavior has been changed in this investigation.

The user confirms the same Cinejoy episode, duration and 1080p quality: our observed download took about ten minutes; Video DownloadHelper was ready to save through File Explorer in about thirty seconds. These are user-reported timings, not an independently controlled paired benchmark. Measure MP4-ready and Chrome-save-complete separately in the optimization tests.

## Verified replacement bottlenecks

The retained full acceptance run downloaded the same 797-segment source into a valid 1,920,506,462-byte MP4. Its historical wall time was about 45 minutes under those recorded conditions; this is not interchangeable with the user's more recent ten-minute result.

| Evidence | Observed result | Consequence |
| --- | --- | --- |
| Full run `final-reviewed/live-1792802566845-25512/receipt.json` | 18,544 total requests; selected-origin records include 9,251 extension-origin 404s, 9,254 page-origin 206s, three primary aborts and 34 direct 206s | Almost every successful media read first pays for a known-unsuccessful extension request. |
| `src/downloads/remux-source.ts` | HTTP ranges aligned to 256 KiB; `UrlSource` parallelism 1; serial next-packet reads | The four-fetch transport limit is mostly unused. HTTP round trips dominate many small reads. |
| `src/downloads/remux-validation.ts` | Every fragment is probed before any packet output, then earlier bytes may be fetched again after cache eviction | Long startup and additional media reads. Recorded full successful-byte amplification is 1.21301x. |
| Original native large-I/O control `native-1792799869295-26364` | 2,147,549,185 actual bytes through page transport and OPFS in about 252.132 seconds: 8.123 MiB/s | The current bridge itself can constrain throughput, even without internet latency. This includes transport and disk work, not just decoding. |
| Current public `decodeChunk` CPU probe, Node 24.21.0 | 10 MiB / 1,666.54 ms = 6.000 MiB/s; exact byte checksum | Per-byte `Uint8Array.from` conversion is an independently measured hotspot. This is a Node CPU measurement, not native Chrome/site throughput. |
| `src/downloads/worker.ts` | Progress is posted for each packet and input chunk; only the host-to-coordinator stage is throttled | Fast processing can flood the worker/host control path unnecessarily. |

Selected-request duration distribution in the historical trace: median about 75.5 ms, p95 171.8 ms, p99 343.1 ms, excluding requests without completion timestamps. These observations support reducing round trips; they do not predict current internet speed.

## What the installed DownloadHelper does differently

Installed target: `lmjnegcaeklhafolokijcfjliaokphfk/10.6.7.2_0`. Direct inspection is static and does not prove which branch produced the user's thirty-second result.

- Its manifest declares `declarativeNetRequest`, with no `nativeMessaging`. The inspected path uses an offscreen document, dedicated worker, bundled LibAV/WASM and OPFS. A separate desktop companion is not the demonstrated requirement here.
- `service/main.js::Zm` at decoded offset 183791 and `ao` around 185400 prepare and install session request-header rules, then `St` removes them. The HLS planner includes media and initialization URLs. The worker's fetch path can therefore use prepared request context directly instead of our repeated primary-failure/page-base64 path.
- `download_worker/main.js::Ki`, around offset 36300/actual fetch call 36509, returns a direct Fetch response to the worker's processing path. `Ti` at 168774 and `Di` at 169323 use the bundled HLS demuxer with stream-copy video/audio mappings. The presence of WASM alone does not prove it is the source of the speed advantage.
- Worker progress class `q` at offset 38099 coalesces messages at 500 ms. The replacement currently sends packet-level worker progress.
- The setting `max_concurrent_downloads: 6` is a job-queue setting. It is not evidence of six parallel segments for one movie. Original per-video concurrency remains unverified.
- LibAV `jsfetch` internals and the actual Cinejoy strategy require runtime evidence for stronger performance attribution. No original source, binary or private protocol will be copied into the implementation.

## Connected REA evidence and limits

Fresh selected-source analysis used `manifest.json`, `service/main.js`, `download_worker/main.js`, `factory/factory.js`, 746,160 text bytes, three parsed JS files and zero parse failures. Artifact identity: `ebe79bbe981283a91eab65bc3b94440849aeeb4a75cc57c2a3fcbf616f915ba8`.

- Parent: `ev_e7bdca8d0694483b7178b59ebf8bcb5a7a1b495e1970a12e83553c29bc74676a`.
- Summary: `ev_d03702f96864d1913248432eb817b4608198a9b067293d15549c5dd14e6f0c55`.
- Exact worker-module outgoing trace: `ev_a00a33c16a02d300b6c3923cc2991c5fab5eb0bad22c2cd1b36dc736e5dfc093`, two seed roles, five nodes/four edges; source/export and unresolved worker/import relationships, not an end-to-end fetch trace.

[Summary](rea-evidence/download-speed/rea-application-summary.json) and [trace receipt](rea-evidence/download-speed/rea-worker-trace-summary.json) preserve the partial coverage: 71 unselected files, semantic node ceilings, 34,763 semantic unknowns. Chrome-specific request scheduling/header facts above come from direct installed-file inspection, not a successful REA runtime trace.

## Proposed direction

First optimize the existing permission set: efficient base64 primitives with a Chrome 120 fallback, proven page-route reuse within one job/document, larger bounded HTTP windows, bounded parallel read-ahead, just-in-time segment validation, and worker-boundary progress coalescing. This directly addresses measured costs without replacing the media engine.

A separate direct-fetch/header-rule option could remove the page bridge, like the inspected original path, but adds a permission and job-scoped rule ownership/recovery work. It is an explicit alternative requiring approval, not an automatic addition.

Primary API references: [Chrome messaging serialization](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#serialization), [Chrome 140 native typed-array base64](https://developer.chrome.com/release-notes/140#uint8array_to_and_from_base64_and_hex), and [declarative request rules](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest). Chrome runtime messages use JSON; native base64 methods arrived after the project's Chrome 120 minimum and must be feature-detected. The pinned Mediabunny source explicitly permits async `CustomPathedSource` handlers (`node_modules/mediabunny/src/source.ts:302`), enabling a validation gate before a child media source is handed to the demuxer.
