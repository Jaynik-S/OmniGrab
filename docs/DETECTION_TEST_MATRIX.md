# Detection test matrix and comparison protocol

Status: planned acceptance tests, with the currently observed baseline explicitly recorded. Date: 2026-10-15.

## Measurement contract

A detection is a media source visible in a versioned extension snapshot, with correct type, tab/document provenance, status and evidence. A parsed master with quality variants counts as **one source group**; its linked variants are not duplicates. Unrelated videos count separately. A network request alone is not a detection, and a detected source is not a successful download.

For deterministic fixtures, record `t_request` (first relevant response/request observation), `t_candidate` (first candidate snapshot), `t_confirmed` (classification/manifest parse completion), and `t_visible` (rendered row). Use a common monotonic test clock or an explicit wall/monotonic mapping. Do not compare unrelated clocks or count observation attachment time as playback start. Report both first candidate and confirmed/list-visible latency; unavailable timestamps remain null.

Initial measurable gates for the new engine:

- Direct confirmed network/DOM source: candidate and visible row within 2 seconds of the available signal on a local fixture.
- HLS/DASH: pending candidate within 2 seconds; confirmed group within 7 seconds when fetch/parse finishes inside the proposed 5-second deadline. Fetch failure remains a visible unresolved item with a reason.
- Deterministic positives: 100% expected sources; deterministic negatives: zero confirmed media; zero duplicate source groups after repeated observations.
- Correct tab/document attribution: 100% on controlled frame, navigation and multi-tab tests. No stale resurrection after navigation.
- State survives an actual service-worker instance stop/restart with the extension still loaded. An extension reload/browser restart is a distinct reset test, not the same resilience claim.

These are acceptance targets, not measured current results. Original extension latency is reported independently and never assumed to satisfy these gates. Live-site results use distributions/ranges across at least three trials; deterministic functional tests may run once in CI, with flaky network trials separated.

## Common comparison procedure

1. Verify the original extension ID/version and our built extension revision. Use the dedicated profile and authorized pages; record browser version, granted hosts, cache/service-worker state and test timestamp.
2. Establish ground truth from the fixture definition or a manually verified authorized source list. Define expected groups/variants before reading either extension's result.
3. Attach observation before navigation/playback. Include required page, iframe and CDN origins; preserve exclusions/truncation. Do not assume an allowlisted page includes every media origin.
4. Navigate the same page, run identical declared actions, and capture independent original/new snapshots and actual rendered rows while the intended page is active. Avoid preview-fetch side effects when comparing request counts.
5. Record all expected/matched/missed/unexpected groups, variant coverage, duplicates, statuses and latency values. Keep page/network evidence separate from extension-state evidence.
6. Repeat relevant cold/warm and restart cases. Record timeouts/failures rather than rerunning until a pass can be selected.
7. Save machine-readable results and update the comparison table. A change that fixes one case must rerun its affected positive and negative neighbors.

Do not invoke original Force detection in baseline runs: its cookie-removal/cache-bypass reload changes test conditions. A separate explicitly requested recovery trial can measure it without mixing that outcome into ordinary detection.

## Representative scenarios

Each future fixture is original or license-cleared. Media bytes must be valid playable samples; empty files with media extensions do not prove browser detection. HLS/DASH fixtures include real manifests and matching initialization/segment resources. Local test hosting uses two distinct origins for frame/CDN cases.

| ID | Scenario / trigger | Expected new-engine result | Failure/false-positive checks | Required proof layer |
| --- | --- | --- | --- | --- |
| D01 | Static `<video src>` MP4; normal MIME | One confirmed direct source with exact URL and DOM/network provenance | Repeated/range requests do not add rows | Pure classifier + real Chrome |
| D02 | WebM with child SOURCE alternatives | Selected current source plus correctly identified alternatives; one element association | Alternatives are not invented qualities | DOM + browser snapshot |
| D03 | Extensionless URL with `video/mp4` MIME | Confirmed direct source | URL suffix is not required | Network/browser |
| D04 | HTTP 206 ranges | One source, total size from Content-Range where valid | Range length not mistaken for total; zero duplicates | Header fixtures + browser |
| D05 | Small valid MP4 below 500,000 bytes | Confirm from strong media evidence; retain size | Do not copy original's minimum-size false negative | Real playable fixture |
| D06 | Misleading `.mp4` returning HTML/404 | No confirmed video; explicit failed/ignored candidate if relevant | Never promote extension alone over negative response | Classifier + browser |
| H01 | HLS master, two qualities | One HLS group, two exact variants, dimensions/bandwidth | Child playlists/segments not independent duplicate groups | Parser + original/new/browser |
| H02 | HLS separate audio/subtitle renditions | One group with audio language and subtitle associations | Subtitle-only manifests not video rows | Parser + browser |
| H03 | HLS individual media playlist | One confirmed HLS source | Empty/malformed/all-subtitle inputs rejected | Parser fixtures + browser |
| H04 | HLS variant/segment URLs ending `.jpg` | Confirm children only through parsed parent relationship | Ordinary image responses remain negative | Parser + browser; Cinejoy correlation |
| H05 | Live playlist updates/query tokens | Stable group, updated observations, preserved exact tokens | No per-refresh duplicate groups or token stripping | Parser/reducer + browser |
| M01 | DASH MPD, multiple representations/audio | One DASH group with representation and audio metadata | No fragment rows; BaseURL inheritance correct | Parser + original/new/browser |
| M02 | DASH SegmentTemplate/Timeline/List/Base | Preserve format/representations; unsupported details explicit | Do not claim download support from parser success | Parser fixture suite |
| M03 | MPD protection metadata | Detected source marked protected/unsupported as appropriate | No license/key requests or bypass | Parser + network assertions |
| J01 | JS inserts video after page load | Source visible within 2 seconds of actual source signal | No dependency on initial HTML only | Mutation/media events + browser |
| J02 | Same element switches source; SPA route changes | Correct current source/page metadata, prior element association retired | No stale old route source resurrection | DOM/lifecycle + browser |
| B01 | MSE blob playback with observed HLS | Underlying HLS group; blob remains contextual evidence | Do not expose blob as reusable HTTP download URL | Network/page/extension correlation |
| B02 | MSE with only fragments and no known manifest | Ambiguous context stays unresolved unless independently confirmed | Do not list every segment as a whole video | Pure classifier + browser |
| B03 | MediaStream/WebRTC or standalone local blob | Explicit unresolved/unsupported context, no fabricated remote source | No bogus downloadable HTTP URL | DOM + browser |
| F01 | Same-origin iframe player | Correct top-tab attribution plus frame/document evidence | No parent-URL substitution for source URL | Browser/extension state |
| F02 | Cross-origin iframe + third-origin media CDN | Correct tab/frame attribution with granted hosts | Permission-denied case visibly distinguished from no media | Real multi-origin Chrome test |
| F03 | Related about:blank/blob frame | Behavior matches declared related-frame injection scope | all_frames alone is not accepted as proof | Real browser + permission settings |
| G01 | Two unrelated videos on one CDN | Two groups; individual element evidence retained | Do not merge by title/origin alone | Reducer + browser |
| G02 | Master arrives after its known child | One parent group with child variant link | Unrelated direct video remains intact | Reducer race/order fixtures |
| G03 | Repeated DOM/resource/network signals | One group, all methods, stable first-seen time | No method-specific duplicate rows | Reducer/property tests |
| N01 | Images/scripts/ads/no video | Zero confirmed media, including paths containing `video` | Track false-positive count, not just expected matches | Pure + real browser |
| N02 | `.ts`/`.m4s` fragments and init.mp4 | Suppressed linked fragments/initialization resources | Init file not reported as a complete movie | Parser/classifier/browser |
| L01 | Top-level navigate during manifest fetch | Old job aborted/ignored; new document clean | Late result cannot resurrect old tab contents | Deferred-fetch integration/browser |
| L02 | Subframe navigate/remove | Only that document's attribution expires | Other videos in top tab remain | Browser |
| L03 | Stop/restart actual extension service worker | Persisted detections restore; queued work safely reconciles | No lost update, duplicate or fake persisted revision | Chrome worker lifecycle test |
| L04 | Two concurrent tabs share source/origin | Independent correct snapshots | Initiator-origin heuristic cannot leak between tabs | Real browser |
| E01 | Manifest CORS/auth/permission/fetch failure | Observed candidate retained with explicit reason | Never claim original response body was read | Network failure fixtures |
| E02 | Oversized/malformed/deep manifest, XML entity payload | Bounded reject/error; responsive collector/UI | No entity expansion, runaway parse, unbounded fetch | Parser/probe limits tests |
| E03 | State quota/write failure | Error surfaced, revision not falsely acknowledged | No silent persisted-success claim | Store integration with failure injection |
| E04 | Late attach/resource inventory | Recover provable DOM/resource sources; timing labeled late | No reconstruction of missing past response bodies | Real browser |
| U01 | Popup reopened with page active | Correct tab's existing snapshot and metadata | Extension page ID does not replace detection context | Rendered UI + state |

## Evidence and result schema

For each trial retain: case ID; page/fixture revision; original version; new commit/build; browser version; permitted origins; actions; start/end timestamps; capture/evidence paths and IDs; expected source groups/variants; independently observed original/new entries; matched/missed/unexpected groups; duplicates; candidate/confirmed/visible timings; capture exclusions; errors; and result status (`pass`, `fail`, `blocked`, `not-run`).

Use exact source URLs privately for matching, with safe URL display/export redaction where signed queries or identifiers occur. Never persist cookies, authorization, page account data or proprietary bundle sources in the production artifact. Store research under `docs/rea-evidence/`; bundle verifiers must reject research/capture files from extension output.

## Current comparative baseline

| Case | Original | Our engine | False positives / duplicates | Latency | Evidence |
| --- | --- | --- | --- | --- | --- |
| Cinejoy user-selected page, HLS underlying blob element; `.jpg` variants | Session state contains one HLS group with 1080p and 720p; original shared panel renders one media row when video tab is active | **Not implemented; not tested** | One source group observed; complete false-positive/duplicate audit not performed | Not measured | REA navigation `ev_79ebb3a64479a6a00211931d25751528b10aab9d289c7819b3f7155936163c4e` plus sanitized original session/page/panel snapshots |
| Same page, 45-second passive window | No new page/CDN requests retained in that window; no playback claim | Not implemented | Not evaluable from idle window | Not available | REA `ev_e2f320045028292990d87b9fc2d3bebddb7c8b1e3f2859af0bea60ed5a28dabd` |
| Direct MP4/WebM diagnostic pages | One exact direct source each; original WebM extension field is `mkv` | Not implemented | No duplicate terminal groups in these single trials; broader false-positive rate unknown | Scenario-call diagnostics recorded; response latency unknown | [Original baselines](ORIGINAL_BASELINES.md) and retained per-case receipts |
| HLS controlled demo | One master group with five variants | Not implemented | No standalone child groups at terminal sample | Scenario-call diagnostics only | HLS basic baseline |
| DASH controlled demo | Fresh tab: one MPD group, ten representations; reused tab also retained a previous unrelated MP4 | Not implemented | Reused-tab stale source observed; fresh control clean | Scenario-call diagnostics only | Corrected and fresh-tab DASH baselines |
| JS-triggered blob/source demo | Clicking Load produced one underlying MP4 source; element used blob URL | Not implemented | No blob download URL fabricated in original state; broad coverage unknown | Scenario-call diagnostics only | MDN SourceBuffer loaded baseline |
| F02 cross-origin embedded players | Three selected sources from distinct MDN example frames attributed to the parent documentation tab | Not implemented | Exact original per-source frame IDs not established; no broad false-positive rate | Scenario-call diagnostics only | Embedded MDN baseline plus separately labeled CDP frame receipts |
| G01/G02 multiple sources/qualities | Quality grouping observed for HLS/DASH; three distinct selected videos retained on embedded-example page | Not implemented | Specific terminal counts observed; broad completeness unknown | Unknown | New-engine multi-video comparison remains |
| N01 no-video negative page | No terminal discovered records on MDN DOM index | Not implemented | Zero observed false positives in one diagnostic trial | No positive detection to time | No-video baseline |

The detailed [baseline report](ORIGINAL_BASELINES.md) retains unsuccessful setup and no-load trials, exact actions, evidence IDs, latency definitions and navigation-state observations. These original-only single trials do not satisfy the repeated-trial or new-engine comparative gates.

## Completion gates

1. Research: existing capture analyzed; actual original detection correlated with network/page evidence; gaps/unsupported areas labeled. User reproduction and controlled baselines must complete before calling runtime research exhaustive.
2. Architecture: review the proposed collector/state/probe boundaries, permissions, limits and debug UI. Explicitly identify additional original design choices rather than attributing them to REA.
3. Implementation: TypeScript typecheck, fixture tests, browser build/load, manifest/permissions review, and artifact-content audit pass. Commit each verified implementation stage descriptively.
4. Comparison: all eight user-requested page categories have independent original/new results, false positives/duplicates and detection timing; blocked cases identify the concrete missing evidence.
5. Improvement: fix measured gaps, rerun affected positive/negative cases, document remaining unsupported scenarios. Passing unit fixtures alone does not satisfy the comparative gate.
