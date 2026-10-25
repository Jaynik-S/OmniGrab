# Download speed investigation

Updated: 2026-10-25 (America/Toronto). Branch: `feat/download-speed`, from `main` commit `b8b1671`. Approach 1 runtime implementation is `575da3c`; test-driver follow-up is `7c8beca`. Baseline check had 291 tests; final source check at `7c8beca` passed 366 tests, typecheck and the eleven-file/license build audit. Task and whole-branch review remain separate integration gates.

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

## Implemented changes and verification

| Files / boundary | Change and covering evidence |
| --- | --- |
| `base64.ts`, `binary-protocol.ts`; base64/binary tests | Strict ASCII length/alphabet/padding validation and native conversion with Chrome 120 fallback. RED/GREEN covers all ASCII payload positions, Unicode/whitespace, padding, wrong lengths, maximum chunks and unchanged permissive unused pad bits. Decoded length is checked separately. |
| `transport.ts`; transport tests | Reuse a fully proven page route only within the same job, origin and document. Existing grant, sequence, ACK, expiry and cancellation checks remain. No service-worker media relay. |
| `remux-source.ts`, `remux-read-cache.ts`; source tests | Four MiB HTTP windows, <=256 KiB independent cached responses, shared 32 MiB retained bound, <=4 physical / <=3 speculative reads, bounded whole-object fallback and asynchronous settlement. More-than-32 MiB MAP regression prevents initialization rereads rewinding speculation. |
| `remux-validation.ts`, `remux.ts`; validation/remux tests | Validate each unambiguous initial/later segment before consumption; retain strict eager fallback for ambiguous identity layouts. Keep full Input packet/timestamp processing, mismatch failure and cleanup. |
| `worker.ts`; progress/host lifecycle tests | Coalesce worker progress at 250 ms while flushing first real input and terminal counters; heartbeat remains independent. |
| Native browser fixtures and `download-speed-fixture.ts` | Actual Chrome saves, >2 GiB transport/OPFS, lifecycle/storage/media failures and deterministic matched generated HLS. Per-stream frame records retain timebase, DTS/PTS/duration/size/payload hashes and order while allowing cross-stream FFmpeg scheduling differences. No new dependency or permission. |

### Controlled generated HLS and native results

[Generated comparison](rea-evidence/download-speed/generated-comparison.json) uses the identical 798-segment, 640x360/2 fps, 3,190-second source for both unchanged builds. Both save 14,474,986 bytes, independently decode, and have identical per-stream encoded/decoded content and timing (6,380 video / 149,533 AAC packets). This low-bitrate fixture is not a substitute for Cinejoy 1080p.

| Endpoint / network | Baseline `b8b1671` | Optimized `575da3c` runtime |
| --- | ---: | ---: |
| First observed input | 0.474 s | 0.412 s |
| First observed output | 55.709 s | 0.652 s |
| MP4-ready upper bound (Chrome save start) | 79.114 s | 40.856 s |
| Chrome complete | 79.451 s | 41.186 s |
| Requests / failed primary reads | 1,599 / 799 | 801 / 1 |
| Successful media requests / byte amplification | 799 / 1.0x | 799 / 1.0x |
| Maximum physical active | 1 | 4 |

Chrome completion improved 1.93x in this controlled pair. State/progress endpoints are 100 ms polls plus API latency; Chrome begin/end use DownloadItem timestamps. The original generated command exited 1 because it compared aggregate decoded framehash order; the preserved raw receipt and corrected independent per-stream verification explicitly retain that failure. No download was repeated to conceal it. Module-private production cache/staging/queue and raw worker-message counts are unavailable; separate native controls assert their hard bounds.

[Native controls](rea-evidence/download-speed/native-controls.json) retain all 18 successful sequential window runs: 101,358,568 exact bytes each. At 75 ms header delay, 1/4/8 MiB medians were 7.4284/5.1196/5.5600 s; at 25 ms they were 4.5587/4.8298/5.0686 s with overlapping ranges. Retain 4 MiB: best representative-delay median, less staging than 8 MiB, and 792 of 798 observed real objects fit. Eight MiB saves only six theoretical real network windows. Every run checked content, file length, deletion, cache/queue/concurrency/ACK bounds. One genuine transient body failure remains retained with unproven cause; later unchanged runs passed without relaxing limits.

The accepted actual >2 GiB control checked every one of 2,147,549,185 bytes, output length, seek/backpatches, exclusive handle release and removal. Exact worker time was 77.1229 s (26.56 MiB/s). The same ten-second observation method measured final completion at 80.177 s versus the retained baseline 441.735 s (4.6364 MiB/s), about 5.51x faster; baseline has no exact worker endpoint. Queue peak was 2,009,776 bytes, active requests 1, ACK limit 1. The final read-only observer sampled browser CPU 2.422095→107.197571 CPU seconds, summed working-set peak 1,259,831,296 bytes and private-byte peak 828,026,880 bytes; it misses the exact final endpoint and summed working sets may double-count shared pages. Baseline lacked that observer. This combined integrity-check/transport/OPFS result misses the 64 MiB/s aim and does not establish a bridge-only ceiling.

Targeted native controls cover four-read cancel/disconnect, real service-worker stop/wake, source navigation and closure, popup closure, save adoption/recovery, worker/host loss, interrupted Chrome save, expiry/truncation, protected admission and storage estimate/quota/write/directory failures. Empty OPFS and released ownership were checked after terminal outcomes. The storage observer recovered one CDP deadline without restarting the job; setup failures and the earlier failed observer run remain recorded.

### Decisions and costs retained from the task ledger

| Decision | Reason and cost if wrong |
| --- | --- |
| Keep task reports in ignored scratch; commit portable summaries | Matches scratch lifecycle. Detailed transient reports can disappear after authorized cleanup; tests, code and portable evidence remain. |
| Preferred-page invalidation uses existing fallback eligibility; 408/429 retain same-route retries | Throttling alone does not disprove document context. A recovered direct route may be delayed by the bounded retry budget. |
| Replace the measured repeated-group base64 expression with strict character scanning | Native valid-payload microprobe measured 114.68 versus 13.95 MiB/s; malformed equivalence has independent tests. Cost is extra helper/tests if end-to-end gain is small. |
| Isolate same-window request-count tests with `prefetch:false`; retain default-enabled integration tests | Avoids treating useful speculation as a cache failure. Isolated tests could miss interactions, hence default/native coverage is required. |
| Bound cached library responses separately from HTTP windows | The intermediate worker profile attributed 35.5% to native reader reads and 7.7% to Response construction; bounded independent copies avoid repeated multi-MiB extraction. Cost is more local stream transitions if throughput does not improve. |
| Mark private production metrics unavailable; use separate native bound assertions | Keeps unchanged builds and avoids a product diagnostics API. Combined production peaks are indirectly bounded by the same tested implementation; sampled heaps and observed requests supplement that evidence. |

An additional measured correction keeps speculative positions forward-only when a shared initialization MAP is reread: the intermediate journal showed the first three fragments fetched 17/17/16 times. Foreground backward reads and upcoming MAP/range grants remain supported. No useful media read-ahead was disabled.

## Final real Cinejoy acceptance

[Final real evidence](rea-evidence/download-speed/final-cinejoy.json) records the complete same 1080p source: exact master/selected manifest texts match retained gold, all 797 segments plus MAP have complete inclusive range coverage, and all successful media responses are cache misses. The unmodified final build saved 1,920,506,462 bytes through matching Chrome download completion. Successful media bytes total 1,920,222,212 (1.0x amplification), in 804 successful media reads; 810 requests include two manifests and four failed primary reads. Peak physical concurrency was four. OPFS was empty afterward, job attachment/temp ownership was released, the dedicated worker was gone, and the owned browser closed.

| Endpoint from Download action | Final real run |
| --- | ---: |
| First observed real input / MP4 output | 3.116 s / 3.116 s |
| MP4-ready upper bound (durable save intent) | 199.886 s |
| Chrome save start | 199.894 s |
| Chrome complete | 206.195 s |

The first-output endpoint is limited by three-second state polling plus API latency; save intent is an upper bound on MP4 readiness, not an exact worker endpoint. Chrome timestamps are DownloadItem values. There was no overlapping heavy native work. This is a single final real measurement, not a contemporary paired baseline: the 645.392-second intermediate run included diagnostic profiling, and the historical 45-minute gold run had different conditions. The user's ten minutes and DownloadHelper thirty seconds remain reported comparisons. No thirty-second, DownloadHelper parity or all-site claim is supported.

Independent FFprobe and full FFmpeg A/V decode with `-xerror` passed: 1920x1080 H.264, stereo 48 kHz AAC, 3,189.941333 seconds, 76,473 video and 149,529 audio packets. Beginning, middle, near-end and tail native Chrome playback advanced video frames/audio bytes without error, with finite stereo signal checks. Automated checks do not claim human listening. Every encoded H.264/AAC packet's payload SHA256, timebase, DTS, PTS, duration, size and per-stream order exactly equals retained validated gold; the complete encoded framehash text also matches (`400f33de16fb9706ae5c012fe71a6db70c66a9291af5bb4a3520bfd806c5e3fa`). Whole-file SHA256 is `7bd0ab939387d1f89242a63153452a163b5387a27f44e8f3cb1ca8fd6f87e356`; container creation metadata differs without a media/timing change.

Twenty-one read-only resource samples report cumulative browser CPU 12.099780→324.569841 seconds, peak summed working sets 2,257,281,024 bytes and private bytes 1,695,150,080 bytes. Worker sampled JS heap peaked at 28,160,304 bytes; backing storage peaked at 151,986,440 bytes, including retained cache and transient buffers. These are sampled process/heap observations, not exact cache/queue measurements; summed working sets may count shared pages and CPU sampling misses exact endpoints. Native controls separately assert hard retained-cache/queue bounds.

## Measured remaining control cost

[Transport/component evidence](rea-evidence/download-speed/transport-components.json) retains the actual >2 GiB receipt and scoped diagnostics. One final 128 MiB + 65,537 byte replay used the exact production transport, every-byte integrity loop, OPFS writer, ACK and cleanup contracts, with timers around reader wait, verification and writes. All 134,283,265 bytes, backpatch slices, file length, exclusive-handle release and deletion passed. No accepted gate or original receipt was changed.

That diagnostic took 5.1071 s (25.08 MiB/s), close to the full control's 26.56 MiB/s. Measured sequential worker time was 2.7195 s in the harness's every-byte `for...of` check (53.25% of elapsed), 1.9596 s waiting on the reader (38.37%), 0.1373 s in OPFS writes (2.69%), and 0.2907 s elsewhere (5.69%, including request setup/final flush/close/inspection). Reader wait includes upstream fetch/JSON/base64/transfer/scheduling and is not pure IPC time; some upstream work overlaps consumer verification. This identifies the integrity loop as the largest measured worker component in this exact path and shows disk writes are a small part of this diagnostic. It does not prove identical proportions in the original >2 GiB run or a hardware/bridge ceiling.

Three-round, 64 MiB component calibrations with <=256 KiB chunks provide additional attribution: local production decode median 145.12 MiB/s, strict scan 165.98 MiB/s, native-only base64 decode 1,120.84 MiB/s, OPFS write/flush/close/content-slice/delete 442.60 MiB/s. Exact per-byte verification varied 54.85–295.89 MiB/s as tiering/context changed. A separate owned extension-page JSON/ACK1 receiver split measured medians 132.86 MiB/s for messaging alone, 120.89 with native decoding, 75.87 with strict scanning, and 72.28 with full production decoding. An earlier receiver series was slower (17.89–51.25 MiB/s with full decoding), retained openly. Receiver scanning is measurable overhead, while runtime scheduling and JIT effects prevent treating isolated rates as additive full-path predictions. These diagnostic cases omit page fetch and host-to-worker stream transfer and never replace the accepted full-control fidelity checks.

The 64 MiB/s aim remains unmet. The combined benchmark is substantially affected by its mandatory integrity loop, with remaining time in upstream delivery; native base64 conversion and OPFS are not the measured dominant components here. Changing verification to make a faster benchmark would weaken the accepted gate and was not done. Approach 2 remains a separate explicit design/permission decision, and task/whole-branch review must complete before offering integration. No merge is authorized.
