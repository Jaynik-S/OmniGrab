# Current Video DownloadHelper download path and replacement gaps

Inspected 2026-10-23. Target: installed **10.6.7.2_0**, under the user-supplied Chrome extension ID. This is static analysis of shipped files; no original download was initiated, no terms were accepted, and no segments or keys were fetched. No proprietary implementation code is reproduced here.

## Findings that affect the current screenshots

The existing Cinejoy evidence identifies **HLS**, not a progressive MP4: the original state contains one `m3u8_playlist`, duration `3189.5616350000337` seconds, with 1920×1080 and 1280×720 variants. See [original and replacement state](../cinejoy-gap/live-verified-state.json). The replacement now has the corresponding confirmed HLS group. The original's displayed `.mp4` describes the **planned output container**. Saving that output requires a separate processing pipeline; discovery alone does not produce a downloadable MP4 URL.

The replacement's missing Download button follows the current implementation scope: [README](../../../README.md) states detection only; [manifest](../../../extension/manifest.json) has only `webRequest`, `webNavigation`, and `storage`, and its CSP does not permit WASM evaluation. Its production tree has manifest probes and a diagnostic popup, with no download coordinator, offscreen host, muxer, or final save handler. These are verified implementation gaps, not merely a popup rendering defect.

## Verified current original control and data flow

References below use zero-based decoded-text offsets after universal-newline normalization, with the exact original byte hashes and 1-based lines in [direct-static-references.json](direct-static-references.json). Bundle-local names are navigation aids, not recovered source names.

| Stage | Current shipped reference | Verified behavior |
| --- | --- | --- |
| User selection | `content/panel.js::J.buildArgs` @337292; quality callback @336074 | Reads the selected playlist entry (or saved/preferred selection), naming, action, and output settings. Quality changes persist a preferred entry. |
| HLS plan | `content/panel.js::xg` @327655; `ti` @319568 | Uses the selected rendition's video URL and its associated audio URL if present. Plans one-source or two-source processing; audio-only is separate. MP4-compatible input uses the preferred AV muxer (`mp4` by default), while WebM/MKV choices use MKV. This selection does not itself download anything. |
| DASH plan | `content/panel.js::kg` @324645; service `Vv` @203010 | Keeps the master URL, selected video representation index and optional audio track ID/language. The worker receives explicit representation selection rather than simply downloading the MPD file. |
| Submit | `content/panel.js::J.doDownload` @335413 | Serializes arguments, normalized media, and tab metadata in `do_download` to the service on runtime channel 1. |
| Policy and queue | `service/main.js::Hy` @539445; `In` @505465 | Rejects duplicate active/completed hashes; checks terms acceptance, platform/entitlement restrictions, and known DRM. Inserts queued download state and uses bounded concurrency. The current Chrome build has a YouTube restriction with an experiment/Brave-related exception; collector presence does not prove unrestricted YouTube downloading. |
| Request preparation | `service/main.js::ru` @212215; HLS `Zm` @183791 | Ensures worker readiness, prepares request-header session rules, and dispatches the chosen strategy. HLS jsfetch selection is derived from query-carry policy. The current original reuses captured request context for manifests and media; exact server requirements remain site dependent. |
| Browser worker host | `service/main.js::pv` @148598; `Hn` @148952; `factory/factory.js::D` and worker construction @11420 | Creates `/factory/factory.html` as a Chrome offscreen document with reason `WORKERS`, verifies extension identity in the factory, then starts `/download_worker/main.js` as a module worker. Readiness uses request/reply messages. |
| Worker protocol | `service/main.js::wr` @148104 / `Xt` @148182; `download_worker/main.js::ie` @37851 / `sr` @37929 / `No` @171467 | Uses `BroadcastChannel("worker_service")`, channel 2 toward the worker and 3 back. Commands include readiness, download, abort and blob revocation. Per-download AbortControllers support cancellation. |
| HLS processing | `download_worker/main.js::Mo` @170152; `Ti` @168774 / `Di` @169323 | The jsfetch path uses bundled LibAV's HLS input, explicit video/audio stream mapping, stream copy, output container selection, and timestamp normalization. Separate input audio is mapped explicitly. Optional subtitles and language metadata are included. This is generally remuxing, not an assertion of universal video transcoding. |
| Alternative HLS processing | `download_worker/main.js::oe` @84292; `Vr` @91228 / `Rr` @88140 | A separate manual path parses media playlists, resolves segment URLs, optional query carry, initialization maps, byte ranges, sequence numbers, and ordinary AES-128 metadata. It demuxes/muxes with LibAV. Presence of this path does not mean every HLS download uses it. |
| DASH processing | `download_worker/main.js::fr` @48416 | Passes the selected representation to the DASH demuxer, maps selected audio by ID if present, and copies video/audio into the output container. Exact WASM internals and all MPD dialects were not examined. |
| Direct files | `download_worker/main.js::Ur` @98548 | Streams ordinary direct HTTP data into temporary storage; other direct strategies can process/extract streams. Direct sources therefore have a simpler save path than adaptive playlists. |
| Temporary output | `download_worker/main.js::L` @39792; `U` @41634; `Q` @40431 | Writes an origin-private filesystem file through a synchronous access handle. LibAV writes to this sink; the output file later becomes a blob URL. Large output is not necessarily retained as a single JavaScript byte array. |
| Progress | Worker progress class `q` @38099; service `Hy` | Reports throttled fetched bytes, output duration, percent when trustworthy, and finalizing state. The service updates shared state and estimates bitrate; the panel can remain separate from the worker lifetime. |
| Final save and completion | `service/main.js::iu` @212894; `Jv` @211067; `Kv` @210688 / `tu` @210907 | Calls Chrome Downloads with the processed **blob URL**, derived filename, `uniquify`, and Save As flag. Waits for browser completion/interruption before treating the browser stage as complete; removes OPFS temporary output and revokes the worker blob. Completion, partial output, cancellation and errors are distinct outcomes. |

Selected HLS/audio associations come from the original master parser and preferred-language/default rules (`service/main.js::Lm` @181129, `Jn` @152694); they are not inferred by matching arbitrary URLs in a tab. The Cinejoy stored-state receipt intentionally omits private captured headers and does not retain audio associations, so it does not prove whether that particular stream uses embedded or separate audio. That requires inspecting the master/selected child metadata or a controlled download plan, not assuming all HLS layouts are alike.

## Browser versus native companion

**Verified current boundary:** required and optional manifest permissions contain no `nativeMessaging`. A static scan of all installed JavaScript found no `connectNative` or `nativeMessaging` occurrence. Every `sendNativeMessage` occurrence is the generic WebExtension-polyfill API arity table, not a call site. The three `companion` substrings in `content/smartnaming.js` belong to bundled language-syntax keyword inventories. The inspected download path is **Chrome offscreen document → dedicated worker → LibAV/WASM → OPFS → Chrome Downloads**.

This establishes that a native companion is not the demonstrated requirement of this current Chrome package. It does not determine whether another product version used one, whether one is installed, or whether every platform uses this branch. A replacement can independently implement the browser-resident architecture without importing the original extension's bundles or private protocol.

## Missing capabilities and proof required in the replacement

| Capability missing today | What would establish completion |
| --- | --- |
| Download/Save As actions and filename/container planning | A click initiates a job for the selected confirmed source and validates final saved-file location/name. |
| Quality and audio selection for HLS/DASH | A controlled multi-rendition source produces the chosen video resolution and intended audio track; other renditions are not accidentally combined. |
| Authorized media fetching | Requests succeed with the required normal origin/session context, preserve signed URLs and redirects, and fail explicitly when access expires or is denied. Detector page-context success alone does not establish download-worker success for hundreds of segments. |
| Adaptive media assembly | Known clear HLS TS/fMP4 and DASH inputs produce a playable MP4/MKV with expected duration, A/V streams, timestamps and seekability; fragments are not just concatenated under an `.mp4` filename. |
| Job lifetime and storage | Processing continues with the popup closed, does not rely on an indefinitely live service-worker instance, and handles quotas/cleanup and interruption. |
| Progress/cancel/retry/error handling | Controlled stalls, failed segments, cancellation, repeated clicks, worker restarts and final browser interruptions reach the expected durable state without falsely reporting success. |
| Real-site and specialized detector coverage | Paired current-site tests establish source identity/quality where parity is claimed. A separate actual YouTube URL and its playback evidence are needed; the two screenshots are the Cinejoy case. |

These are clean-room requirements derived from externally observable behavior and static responsibilities. They are not an instruction to reproduce private code, hard-coded licensing rules, or a DRM bypass. Universal parity remains an unproven product claim even after one site downloads successfully.

## REA use and coverage

The previously retained current-detection parent `ev_3321d11aa7c696714196afc554542847018e548d1a9b611757b13bd1b513ba09` is not retained in this MCP connection. That rejection was not treated as successful access. Existing detection receipts and direct-file fingerprints were reused; the factory/worker files not selected in that earlier analysis received a focused connected-MCP analysis.

- [Worker/factory summary](rea-worker-summary.json): view `ev_6f7878441dfb7990a33d481d583a67da5d4c4e4caf86f373222161cb573fba48`, parent `ev_53fcfe51f6751e07dc5c975b05ea53370cbc2662b122d9928579725adec15b51`.
- Selected exact paths: `manifest.json`, `factory/factory.js`, `factory/factory.html`, `download_worker/main.js`; 190,278 text bytes, two JS files, 49,187 AST nodes, zero parse failures. Seventy-one inventoried files remain outside this analysis; semantic extraction hit its per-file ceiling and records 9,727 unknowns. Chrome-extension API messaging is supplemented by direct static inspection.
- [Factory feature trace](rea-factory-feature-trace.json): `ev_d67a87080e45b2cea21dc36242b43faf9e72d33f24c4944bc7be91989d5839f0`, exact outgoing module seed, two seed roles, three nodes and two edges. It finds module-worker construction, but the dynamic worker target expression is unresolved by REA. Direct inspection resolves that target. This trace is not an end-to-end runtime download observation.

All conclusions above labeled verified are declarations or static control/data flow, except the explicitly linked prior detected-state observation. No completed original MP4, output codec/stream validation, processing performance, successful full-length fetch, cancellation or original-worker-restart behavior was exercised in this scope. Those remain runtime verification work.
