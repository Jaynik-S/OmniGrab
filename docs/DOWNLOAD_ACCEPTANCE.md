# Browser download acceptance

This report concerns this project's independent downloader. It does not establish the installed Video DownloadHelper's runtime behavior, WASM correctness, resilience or general website parity. The [original static investigation](DOWNLOAD_REPLACEMENT_GAPS.md) remains separate historical evidence.

The current implementation uses pinned Mediabunny 1.62.1, locally bundled under MPL-2.0, a dedicated worker with seekable OPFS output, and the Chrome Downloads API. The HLS source identity remains distinct from the MP4 output. No original extension source, binaries, private protocols or site rules are included.

The required full Cinejoy 1080p saved-file gates passed on 2026-10-24 with reviewed production source `52cac149ac22a981422363bdc24b59bd02d10f31`. The [unmodified live artifact receipt](rea-evidence/downloads/full-1080-complete.json) records the actual toolbar Download, all eleven unchanged build hashes, complete Chrome save and cleanup. The actual retained file is `.superpowers/download-acceptance/final-reviewed/cinejoy-1080p.mp4`; it was not renamed to satisfy the filename check.

| Gate | Actual result |
| --- | --- |
| Saved file | 1,920,506,462 bytes; Chrome download 1 complete; requested basename preserved |
| SHA-256 | `76d86a27cb3beb5184b3e3b1708f1714771a2d30f03a80004298ec4197bb32a6` |
| Independent full probe | 3189.941333 seconds; 1920Ã—1080 H.264, stereo 48 kHz AAC; 76,473 video and 149,529 audio packets |
| Independent full decode | Entire video and audio decoded with `ffmpeg -v error -xerror`, exit 0 |
| Native saved-file playback | Exact seeks at 1s, midpoint, 60s before end and 4s before end; advancing frames, time and decoded audio; no media error |
| Source coverage | All 797 segments plus initialization object fully covered; 18,544 observed requests; 256 KiB requested ranges |
| Successful media bytes | 2,329,250,460 bytes / 1,920,222,212 unique source bytes = 1.21301Ã—, including configuration reads |
| Cleanup | Empty OPFS namespace, no attachment/tempFile or processing worker; owned browser and observer closed; no remaining owned processes |

[Saved-file validation](rea-evidence/downloads/saved-file-validation.json) retains exact commands and measured playback/audio results. Automation was muted; no human listening is claimed. Two-second decoded probes show non-silent signal in both stereo channels at the beginning, midpoint and 52:09.94. The two-second probe starting at 53:05.94 is nearly silent (per-channel RMS about 0.0000033). A separate [source-tail comparison](rea-evidence/downloads/source-tail-comparison.json) fetched only the init and last two fragments through ordinary page CORS: all 384 final AAC packet payload hashes/sizes and timestamps match the saved file, including the final packet. The quiet ending is faithfully preserved, not claimed audible.

The actual Download ran from 00:43:05 to Chrome completion at 01:28:05 UTC, approximately 45 minutes. Input progress appeared after about three seconds. Three real 15-second primary preheader stalls recovered through successful same-range page requests; the receipt distinguishes CDP abort timing from the native fixture's independent server socket-close proof. The agent's usage interruption did not stop the browser or restart the job. Its original exec handle was unavailable on return, so no observed process exit code is claimed; the persisted terminal receipt, complete file and process cleanup prove settlement.

The [final-build live 720p control](rea-evidence/downloads/final-720-selection.json) observed 29 selected requests and zero unsolicited 1080p requests. Input reached 3,409,263 bytes, then actual popup Cancel settled without a save or retained worker/file. Its eleven artifact hashes match the full run. This is live selection/cancellation proof, not a complete 720p saved-file run; separate original fixtures cover named 720p saves and decode.

The historical [zero-progress cancellation](rea-evidence/downloads/preflight-cancel.json) and [preheader-timeout failure](rea-evidence/downloads/full-attempt-timeout.json) remain retained RED evidence. Reviewed fixes added actual preflight progress and settled preheader timeout recovery, plus atomic chunk consumption after a separate native regression exposed reentrancy. These failed/canceled attempts are not counted as completed-file evidence.

[Original native controls](rea-evidence/downloads/native-controls.json) include a 3190.021333-second generated AVC/AAC output with 6,380 video and 149,533 audio packets and full decode, actual 2,147,549,185-byte transport/contiguous OPFS verification, byte-range/discontinuity remuxing, awaited-write cancellation, lifecycle, storage, popup, transport and protected/expired/truncated-source failures. Each receipt identifies its scope and raw evidence hash.

## Reproduction and evidence boundaries

Run `npm.cmd run check` first. It checks TypeScript, all unit tests, exactly eleven distributable files, dependency integrity and bundled licenses. Native harnesses use development-only Playwright Core, an owned Chromium profile and an independently installed FFmpeg/ffprobe. Set `CHROMIUM_PATH` to override the installed browser path. Media, profiles and raw receipts are ignored and excluded from `dist` and Git.

```powershell
node tests/download-acceptance-live.mjs
node tests/download-acceptance-live.mjs --selection-720
node tests/download-acceptance-validate.mjs <actual-saved-mp4> <validation-directory>
node tests/download-acceptance-tail.mjs <live-receipt-directory> <actual-saved-mp4>
node --experimental-strip-types tests/download-acceptance-engine.mjs
node --experimental-strip-types tests/download-acceptance-engine.mjs --long
node --experimental-strip-types tests/download-acceptance-engine.mjs --mux-cancel
node tests/download-transport-browser.mjs --large-io
node --experimental-strip-types tests/download-coordinator-browser.mjs --media-failures
```

The live harness loads production `dist` directly and hashes all eleven files before/after. It uses the actual action popup's selector, filename field and Download button on the authorized `/watch/tv/67178/2/1` page, pausing that page's player before Download. Native profile preferences preserve Chrome's filename determination; CDP download overrides are reset to `default`. It automatically starts the read-only observer, takes two baseline samples before Download, and journals both page and offscreen request metadata. It retains real job/browser handles until terminal settlement, not a fixed short polling window. Set `DOWNLOAD_ACCEPTANCE_OUTPUT` to a fresh output directory; the harness never renames a wrong browser filename to satisfy a check.

The independent validator streams the complete file through SHA-256, `ffprobe -count_packets` and full video-plus-audio `ffmpeg -v error -xerror` decode. A range-capable local server supports first/middle/end native playback and seeks without buffering the complete file. Muted automation requires advancing decoded audio/video and independent non-silent decoded audio samples; it does not claim a human listened.

The large-I/O control streams and checks more than 2 GiB of actual binary data through the native page/extension transport into contiguous OPFS writes, patches across the signed 32-bit boundary, verifies small slices, and removes the file. It is a transport/seekable-output control, not proof of a greater-than-2-GiB media remux. The long fixture uses original generated H.264/AAC media and checks full packet counts/decode separately.

Resource observations distinguish native transport/cache bounds, worker JS/backing-store readings and whole-browser process metrics. Across 246 worker samples, JS heap peaked at 28,055,512 bytes and backing storage at 134,350,609 bytes. Whole-browser summed working set peaked at 2,408,460,288 bytes (673,935,360 above the paused-page baseline); private committed memory peaked at 1,790,656,512 bytes (645,562,368 above baseline). Summed working sets include shared pages and are not unique memory. Page/popup/offscreen targets may share an isolate; their heaps must not be summed. These finite observations include site/browser and inspector overhead, not a proof that total memory equals the 32 MiB input-cache limit. No unrelated heavy work ran during the full capture.

The final full check passed 290 tests, TypeScript and the eleven-file/license audit. Affected native transport multi-chunk/bounds controls passed again on `52cac14`. Earlier unrelated long/large-I/O/storage/lifecycle controls retain their explicitly recorded earlier artifact identities; the final artifact's timeout/atomic-consumer proof is separate. Broader branch review remains a separate controller gate.

## Product limits

Supported download admission is clear complete HLS VOD with H.264 video, AAC audio and a determinate selected rendition/audio relationship. Unknown size budgets fail safely: fresh aggregate bandwidth/duration or complete exact resource ranges are required for storage preflight. Quota is approximate and not a physical disk-space guarantee. A preserved source tab/document is required for context-dependent reads; navigation/closure is a failure/lifecycle case, not guaranteed continuation.

Direct-file downloads, DASH downloads, live streams, arbitrary codecs, protected content, broad authenticated-site behavior and exact original-extension parity remain outside the demonstrated scope. Chrome's complete state is the product's browser-save claim; independent saved-media validation is an acceptance test, not an invented automatic job phase.
