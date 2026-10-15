# Original-extension runtime baselines

Date: 2026-10-15. Original: Video DownloadHelper `10.6.1.2`, ID `lmjnegcaeklhafolokijcfjliaokphfk`, in the dedicated `rea-video-test` profile. Chrome: `155.0.8059.41`.

These are **single diagnostic trials of the original extension**, not a comparison with our engine and not a cross-website reliability score. No production engine exists yet. Public demonstration pages were used for bounded navigation/load actions; no media download, DRM/license operation, cookie purge or Force detection action was invoked.

## Method and retained evidence

REA MCP `capture_browser_scenario` performed declared navigation/wait/click actions in a research tab. Separately, a direct CDP reader polled **the original extension's session storage** through its already-open panel context at a requested 250 ms interval. These are separate authorities: REA captures page actions/network events, while original detection snapshots are labeled supplemental CDP observations.

Raw headers/account data were excluded from the original snapshots. The retained polling receipts contain state changes and the final sample rather than every identical sample. The original user-selected Cinejoy tab was preserved. The first batch reused one separate research tab; the DASH control used a newly created tab after closing only that research tab.

All REA scenarios reported `completeness.status: incomplete`, with `missing_sections: [events]`, even when their retained event lists contained requests/responses. Preserve this declared limitation: the retained records support the listed observations, not exhaustive absence of all unrecorded events. Exact action outcomes and evidence IDs are in [results.json](rea-evidence/runtime/baselines/results.json). Per-case `*-rea.json` files retain complete returned REA Evidence; `*-original-state.json` files retain separately labeled state observations.

## Successful diagnostic cases

| Case | Page and declared action | Page/network observation | Original terminal detection |
| --- | --- | --- | --- |
| Direct MP4 | [MDN CC0 flower MP4](https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4); navigate, wait | HTTP 200 and 206 records; browser-generated video/source DOM | One `http_playlist`, exact MP4 URL, extension field `mp4`. |
| Direct WebM | [MDN CC0 flower WebM](https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm); navigate, wait | HTTP 200 and 206 records; browser-generated video/source DOM | One `http_playlist`, exact WebM URL, extension field `mkv`. Source URL/format and suggested output/container naming must be distinguished. |
| HLS master | [hls.js basic usage](https://hlsjs.video-dev.org/demo/basic-usage); navigate, wait | Successful Mux test master/child playlist requests; final VIDEO has a blob source | One `m3u8_playlist` group with five variant choices. |
| JavaScript-loaded blob source | [MDN SourceBuffer demo](https://mdn.github.io/dom-examples/sourcebuffer/); click its Load button, wait | Successful request for `frag_bunny.mp4`; VIDEO changes to a blob source | One `http_playlist` for the underlying MP4, not a downloadable blob URL. Buffer internals were not instrumented. |
| DASH fresh-tab control | [DASH-IF reference player](https://reference.dashif.org/dash.js/latest/samples/dash-if-reference-player/index.html); open Options, check Muted, click Load, wait | Successful BBB MPD request; final VIDEO has a blob source | One `mpd_playlist`, ten representation choices, heights from 180 through 2160. |
| No-video negative | [MDN DOM example index](https://mdn.github.io/dom-examples/); navigate, wait | Successful HTML/scripts/styles, no VIDEO in final DOM | No discovered media records for that tab at the final polling sample. This is one negative page, not a universal false-positive rate. |
| Embedded/multiple videos | [MDN video documentation](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video); navigate, wait | Three cross-origin MDN example iframe targets, each with a ready video; selected WebM and two redirected Archive MP4 sources | Three separate `http_playlist` records attributed to the parent documentation tab. |

The direct samples are top-level media documents rendered by Chrome, not arbitrary application pages with embedded players. The SourceBuffer trial verifies a JavaScript-triggered source load and blob-plus-underlying-HTTP correlation; it does not establish a generic MSE hook inside the extension.

### Embedded-frame inspection boundary

The MDN documentation uses cross-origin example frames inside open shadow DOM. The scenario's serialized top-level DOM contained no literal IFRAME/VIDEO tags, and a later REA `inspect_web_page` returned only the top frame. These omissions are **not evidence that no embedded media exists**. Supplemental [open-shadow/frame-target inspection](rea-evidence/runtime/embedded-mdn-frames.json) and [read-only iframe media observations](rea-evidence/runtime/embedded-mdn-media.json) identified three `mdnplay.dev` frame targets with readyState 4 and paused video elements. Their sources correspond to the original's three records, allowing for the Archive.org redirect URLs retained in network observations. The extension's stored records identify the correct top tab; they do not expose complete per-source frame IDs.

The flower example had WebM and MP4 SOURCE alternatives, but WebM was selected. The original record set included the selected source and the two other examples' selected videos; this trial does not demonstrate enumeration of every unrequested SOURCE alternative. The [derived REA inspection summary](rea-evidence/runtime/embedded-mdn-rea-inspection-summary.json) preserves the narrower top-frame result and its original coverage declarations separately; the complete large DOM response remains at the temporary path and digest recorded in that summary.

## Timing measurements and their limits

The first number below subtracts host wall time immediately before the REA scenario call from the original media object's `discovery_timestamp_ms`. The second uses the first polling sample containing the **exact expected source URL**. Both include navigation/network time; DASH and SourceBuffer also include declared UI actions. They are **not response-to-detection or rendered-row latency**. REA event records in these scenarios did not provide the required per-response clock for that stronger measurement.

| Case | Original discovery after scenario call | First persisted polling observation after call |
| --- | ---: | ---: |
| Direct MP4 | 835 ms | 1,514 ms |
| Direct WebM | 214 ms | 814 ms |
| HLS basic | 705 ms | 1,270 ms |
| SourceBuffer after Load | 498 ms | 1,031 ms |
| DASH, reused tab | 1,911 ms | 2,620 ms |
| DASH, fresh tab | 1,771 ms | 2,311 ms |

The polling interval, host scheduling and storage batching affect observation delay. These values are single-trial diagnostics, not averages, percentiles, guarantees, or directly comparable parsing benchmarks. Strong latency and comparative claims still require the test matrix's synchronized clocks and repeated trials.

## Navigation-state observations

During the MP4-to-WebM navigation, an early sample already identified the tab's new URL while its persisted media/metadata still referred to the prior MP4. Later samples contained the correct WebM. Treat this as a measured transient storage transition rather than counting any nonempty snapshot as a new detection.

In a later **reused-tab** DASH trial, the terminal original discovery map contained:

1. The correct DASH master with ten choices.
2. The previous MDN SourceBuffer page's `frag_bunny.mp4` direct item, whose initiator remained `https://mdn.github.io/`, while the enclosing tab metadata referred to the DASH reference page.

The fresh-tab DASH control had only the correct MPD group. This supports a bounded finding of old-source retention in the reused navigation path. It does **not** establish the precise cause: delayed async completion, lifecycle registration timing, storage writes, or another path was not instrumented. The static code lacks a full document-generation fence, which is a compatible explanation rather than proven root cause.

The proposed engine should discard stale async results and preserve frame/document provenance. This requirement follows from observed risk; it is not a promise that any particular original function has been isolated as faulty.

## Preserved unsuccessful and no-load controls

| Trial | Outcome | Interpretation |
| --- | --- | --- |
| Obsolete DASH basic-auto-load URL | Page returned 404; no video or MPD request | Invalid test page, **not** a DASH detection miss. |
| DASH reference page without Load | Auto Load was unchecked; no MPD loaded; no detections | No-load control, **not** a detection miss. |
| SourceBuffer page without Load | VIDEO exists without src; no media request; no detections | An empty media element alone did not produce a source in this trial. |
| First DASH Load trial | Muted checkbox action timed out because its Options panel was collapsed; Load was cancelled | Automation failure. Retained; corrected by opening Options first. |

## Evidence index

| Trial | REA Evidence ID |
| --- | --- |
| Direct MP4 | `ev_ca256100e5856e98fab1d1b54c94aff375cb5165fdcc7bbb4461c860dbe2ac05` |
| Direct WebM | `ev_f407274c8fd74e2e2edc2f09b1c56115a0c4462e3b33cbdcfe2c0ef8e7ec50be` |
| HLS basic | `ev_0431da117d21f26b9c3a200270ab46f6c60410d1d7a3b7e1d711d27c90ebac84` |
| No-video index | `ev_04023a0f2e82102d019f1f71b9e51be8fd3c9b260f00c4a6b9ac8b90cd82a627` |
| SourceBuffer, loaded | `ev_e52f4572e3c41ed3bb7d9c5ef41c0279089efff8cb358f27e19f6fd3576181b7` |
| DASH corrected, reused tab | `ev_8c65bb35c64e9588c61d9820c640581b7f6a95148af4b20473ad32f0e522b338` |
| DASH fresh-tab control | `ev_117cdbc7c7c50a452472d208a5a8142fba002ff83e4e08f025de8aa87273d260` |
| Embedded MDN video examples | `ev_b9d8a43e327e7984649cf2063cf8fb0c79d27ccf06cd191aa70141930289464d` |
| Later REA top-frame inspection | `ev_c71d0a96e3a0ccf4076ca10d2520babac105a96eb96bec31d93d01a4332a202b` |

Remaining baseline gaps: precise per-source frame/document provenance, service-worker restart and asynchronous navigation races under controlled conditions, unrequested source alternatives, and repeated trials. The embedded examples are a bounded multi-source/top-tab observation, not exhaustive frame coverage. Our extension's outcomes, false positives, duplicate counts and comparable latency remain unmeasured until implementation and comparative testing.
