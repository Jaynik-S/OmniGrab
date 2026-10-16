# Real-browser comparison

The comparison harness loads the original Video DownloadHelper and this extension in the **same new isolated Chromium profile**. Each extension independently observes the same page and declared actions. It does not connect to or change the user's Chrome profile on port 9222.

## Reproduce

```powershell
npm run check
node scripts/browser-comparison.mjs --trials=3 --output=docs/rea-evidence/comparison/final
```

`playwright-core` must be installed. Defaults use Playwright Chromium `chromium-1243` under `%LOCALAPPDATA%` and installed original version `10.6.1.2_0`; override with `CHROMIUM_PATH` and `ORIGINAL_EXTENSION_PATH`. The current harness requests an **ephemeral debugging port**, reads it from its own new profile's `DevToolsActivePort`, and records it. It launches and closes its own browser. Port **9222 is never used**. Older receipts used fixed port 9223; the final-review setup corrections below explain the change.

Optional arguments are `--cases=hls,dash`, `--trials=1`, `--window=6500`, `--skip-lifecycle`, and `--output=...`. Valid case names appear in the result table below. The default observation window is 6.5 seconds after navigation/actions; setup has separate bounded deadlines. Exit code 0 means the new engine's requested cases passed, 1 means a failure/fatal error, and 2 means a setup/lifecycle case was blocked. Original outcomes are reported independently. A sandbox that blocks external networking requires the normal authorized network execution mechanism; a blocked fetch is setup failure, not a detector miss.

`tests/browser/fixtures.mjs` serves original HTML from two localhost origins and media from a third origin. Real MDN CC0 MP4/WebM bytes are fetched once into memory. No media binary or proprietary extension source is copied into the repository. The other pages are the authorized public hls.js, DASH-IF and MDN SourceBuffer demonstrations.

The opt-in `hls-master-child`, `hls-child-master-inflight` and `hls-pending-child-restart` controls remux the CC0 MP4 into real fMP4 HLS assets in a temporary directory when `ffmpeg` is available (`FFMPEG_PATH` can override it). Their explicit page observations use POST; extension GET probe response bodies are held after HTTP 200 headers until the declared release. This distinguishes producers without changing the extension or reading request headers. The harness records `request.serviceWorker()` attribution as URLs only. A fallback is explicitly labeled parser/network-order-only. These controls do not start a player; the protected declaration is metadata-only over clear fixture assets, with no key retrieval/decryption or successful protected-playback claim.

## What the evidence measures

The requested storage-poll interval is 200 ms, with actual interval bounds retained per trial. Each paired sample reads our `detectionState` and the original's decoded `global_session_state`; only explicit media metadata fields leave the original worker. Cookies, authorization and request headers are excluded. Results include bundle hashes, revision, browser/extension versions, granted origins, exact expected source URLs, variants, statuses, document/frame provenance, errors and changes.

`firstCandidateAfterNavigationMs` and `firstConfirmedAfterNavigationMs` measure the host's first matching storage observation after the navigation call. The final harness uses one monotonic host clock for navigation, responses, polling and rendering, and retains its wall-clock mapping; epoch-shaped field names retain the `WallMs` suffix for readability. The response-relative fields use the host's first observed expected response as the common reference. These are polling upper bounds, subject to scheduling and the recorded sampling interval. For multiple expected videos they describe the first matching group; terminal completeness is assessed separately. They are not download timings. Original discovery timestamps are preserved as supplemental browser-wall metadata, without substituting them for host observation times. Earlier diagnostics used the host wall clock and remain explicitly diagnostic.

Each terminal case opens the **real `chrome.action.openPopup()` view**, reads its rendered text/row count through its own CDP target, and captures a screenshot. Its active-tab context must match the tested page. Popup opening intentionally happens after the storage observation window, so general automatic row latency is null. The lifecycle suite additionally opens a popup *before* a delayed video appears and measures the rendered row against that video's response. Headless popup viewport dimensions are retained; screenshots show the browser's actual constrained popup surface.

Remote source groups, unresolved blob contexts and confirmed false positives are counted separately. Our `confirmed` status is literal; original counts refer to its accepted discovery records, which do not expose the same status enum. A parsed master is one group; its video/audio variants are not duplicates. Duplicate counts concern repeated primary source URLs. Unexpected confirmed fragment rows count as false positives against fixture ground truth. Terminal counts do not establish the absence of every transient intermediate row or a general cross-website false-positive rate.

The profile starts cold; subsequent fresh-tab trials can use warmed HTTP caches. No cache/cookie/third-party service-worker clearing, original Force detection, download or license operation is performed. Both extensions running together and the small trial count limit performance generalization.

## Retained diagnostics and corrections

The diagnostic directories are intentionally preserved, including unsuccessful setup attempts. They precede the final repeated comparison and must not be combined with it as successful trials.

| Evidence | Outcome |
| --- | --- |
| `diagnostic-01/` | Initial two direct cases found by our detector; ordinary background extension-tab popup verification timed out. The run was stopped to correct the harness. Original missed the immediate first post-install MP4; later WebM was detected. No original miss is inferred after adding explicit startup readiness. |
| `diagnostic-02/` | Real action-popup MP4 comparison passed both engines. Actual service-worker stop/restart, first-seen preservation and top navigation clearing passed. |
| `diagnostic-03/hls-1.json` | Original grouped five HLS variants. Our manifests stayed unresolved with native worker `fetch` illegal-invocation errors. This exposed the production native-fetch binding bug and led to a targeted fix. |
| `diagnostic-03/` other cases | Dynamic insertion, blob/MSE with remote MP4, three-origin embedding, two independent videos and both negative cases passed both engines. DASH was blocked by an incorrect Options accessible-name assumption. |
| `diagnostic-04/`, `diagnostic-05/` | Preserved DASH action timing/selector failures. HLS after the native-fetch fix contained one confirmed master and five video variants, but an incompatible screenshot option blocked that diagnostic's UI verification. Screenshot handling was corrected. |
| `diagnostic-06/dash-1.json` | Successful DASH load: original one group with ten qualities; ours one correct MPD plus 34 falsely confirmed `.m4v`/`.m4a` fragments. This exposed missing SegmentTemplate fragment association. |
| `diagnostic-06/results.json` lifecycle | Worker stop/restart, top navigation, cross-origin frame navigation preserving an unrelated top source, independent concurrent tabs and rejection of a delayed manifest completion all passed. |
| `final-review-orders/blocked-setup.json` | First new order-control attempt was interrupted before completion. Count-based GET holding could also hold the page observation when an extension's child GET arrived first. Explicit page POSTs and bounded fetch deadlines corrected producer identification. |
| `final-review-orders-02/` | Master-first metadata/grouping assertions passed. An extra worker CDP observer and wrapper-identity requirement did not provide reliable instrumentation; their failures were retained without attributing a source defect. |
| `final-review-orders-03/`, `final-review-popup-setup/` | All three order/recovery state assertions passed with Playwright service-worker request attribution, but the popup checks remained blocked. Investigation established that the first interrupted test Chrome still owned port 9223; later browsers used their own Playwright pipes while the fixed-port popup reader consulted that stale test profile. |

The stale browser was closed only after verifying its exact known test page, welcome/about:blank targets and the two expected extension workers. The harness now obtains its debugging endpoint from the exact newly created profile, so its popup evidence cannot silently come from another test browser. Previous blocked popup attempts remain blocked UI evidence; their passing state assertions are reported separately. The existing user browser on 9222 was untouched throughout.

The compatible DASH setup waits for the Muted control to attach, allows application event handlers to initialize, then uses the observed Options/Load selectors. Setup failures above do not count as DASH detection misses.

## Complete matrix on `dca4043`

Command: `node scripts/browser-comparison.mjs --trials=3 --output=docs/rea-evidence/comparison/final`. **Exit 0**, 2026-10-16 00:02:47–00:06:49 UTC, isolated Chromium **153.0.8010.12**, original **10.6.1.2**, ours **0.1.0** at `dca40433390ae521a1bd03b82269968ba90b7697`. All six artifact SHA-256 values and the complete independent state samples are in [results.json](rea-evidence/comparison/final/results.json); [summary.json](rea-evidence/comparison/final/summary.json) retains compact aggregates.

**30/30 case-trials passed for each extension independently.** Both had zero unexpected confirmed source groups and zero duplicate primary source URLs at the terminal samples. No captured page or extension-worker warning/error occurred. The requested 200 ms poll interval measured **198–281 ms** across these trials.

Timings below are rounded ranges over three trials, measured from the first expected response to the first persisted polling observation. Our candidate and confirmed ranges coincided at this polling resolution. They are diagnostic distributions with cache and sampling effects, not parsing benchmarks or generalized speed claims.

| Case | Original / ours | Confirmed remote groups in each trial | Our candidate / confirmed (ms) | Original first polled (ms) |
| --- | --- | --- | --- | --- |
| `direct-mp4` | 3/3 / 3/3 | 1 | 140–197 | 543–618 |
| `direct-webm` | 3/3 / 3/3 | 1 | 189–198 | 601–624 |
| `hls` | 3/3 / 3/3 | 1 master; 5 video variants | 36–201 | 590–645 |
| `dash` | 3/3 / 3/3 | 1 MPD; 10 video variants | 62–152 | 627–756 |
| `dynamic` | 3/3 / 3/3 | 1 | 94–163 | 593–706 |
| `blob-mse` | 3/3 / 3/3 | 1 underlying remote MP4 | 39–212 | 605–658 |
| `cross-origin-frame` | 3/3 / 3/3 | 1, with our actual frame/document attribution | 107–130 | 529–563 |
| `multiple` | 3/3 / 3/3 | 2 independent selected sources | 153–177 | 574–589 |
| `no-video` | 3/3 / 3/3 | 0 | Not applicable | Not applicable |
| `mime-negative` | 3/3 / 3/3 | 0 | Not applicable | Not applicable |

Our HLS, DASH and SourceBuffer cases each also retained **one unresolved blob context**, separate from the remote group. DASH had eleven representation records: ten video and one audio. No fragment rows survived grouping. The MIME-negative page retained one **unconfirmed `observed` candidate** for the misleading URL; neither extension confirmed it as media. This is zero confirmed false positives, not a claim that the candidate disappeared.

The lifecycle suite **passed** an actual worker stop/restart with first-seen preservation, top navigation clearing, cross-origin frame navigation clearing while preserving a separate top-frame video, independent concurrent tabs sharing the exact source, and rejection of a pending manifest result after navigation. A real popup opened before a delayed source appeared rendered the expected confirmed row **263 ms after the media response**. See the `lifecycle` object in the same result and [its actual popup screenshot](rea-evidence/comparison/final/lifecycle-live-popup.png).

The popup CSS correction adds `html { min-width: 460px; }` and removes the body's `max-width: 100vw`, keeping its 460 px width. Actual action screenshots after rebuilding show readable media headings and status badges, without the earlier vertical word wrapping. Headless action viewport widths ranged from 460 to 610 px, depending on the case; the [direct MP4 screenshot](rea-evidence/comparison/final/direct-mp4-1-popup.png) is representative.

This complete matrix predates a subsequent narrowly scoped DASH template-matcher hardening. Its build identity above is retained; later focused checks are recorded separately rather than attributing these thirty trials to an untested later hash.

## Focused verification on final hardening build `82883ce`

The final hardening preserves canonical DASH numeric padding and repeated Number/Time identity, and leaves an HLS master's live state unknown until child-media evidence exists. The source check before browser verification passed 96 tests, typecheck and the six-file artifact audit. The browser receipts identify build **`82883ce589f52b4b5bab08453d0f30586671a795`** and retain all six hashes; only `background.js` differs from the complete-matrix artifact above.

```powershell
node scripts/browser-comparison.mjs --trials=3 --cases=hls,dash,direct-mp4,direct-webm,multiple,mime-negative,no-video --output=docs/rea-evidence/comparison/post-hardening
```

**Exit 0; 21/21 case-trials passed independently for each extension**, 2026-10-16 00:08:58–00:11:55 UTC, same Chromium/original versions. Both had zero terminal confirmed false positives and duplicate primary URLs, with no captured page/worker warnings or errors. Actual polling intervals were 198–306 ms. See [results.json](rea-evidence/comparison/post-hardening/results.json) and [summary.json](rea-evidence/comparison/post-hardening/summary.json).

| Case (3 trials each) | Our candidate (ms) | Our confirmed (ms) | Original first polled (ms) |
| --- | --- | --- | --- |
| Direct MP4 | 148–217 | 148–217 | 614–761 |
| Direct WebM | 197–204 | 197–204 | 618–637 |
| HLS: one group, five video variants | 152–171 | 152–171 | 563–769 |
| DASH: one group, ten video variants, no fragment rows | 23–164 | 146–224 | 560–841 |
| Multiple: two independent sources | 143–157 | 143–157 | 560–595 |
| No-video and misleading-MIME controls | Not applicable | Zero confirmed media | Zero accepted media |

All lifecycle checks passed again. The already-open actual popup rendered a newly observed confirmed source **205 ms after its response**. Every measured popup body was **460 px** wide; [the actual HLS popup](rea-evidence/comparison/post-hardening/hls-1-popup.png) shows the readable layout. The public HLS player requests child media playlists, so its later VOD label is supported by that evidence rather than inferred from a master alone.

One additional valid master-only browser regression isolates that distinction:

```powershell
node scripts/browser-comparison.mjs --trials=1 --cases=hls-master-only --output=docs/rea-evidence/comparison/master-only --skip-lifecycle
```

**Exit 0, both extensions passed.** The original localhost HTML fetches an original HLS master that points at the same five valid public Mux demo variants; it does not start a player or request a child in the page. Our state contained one confirmed master, five variants, no blob context, and an unknown live state. The [actual popup](rea-evidence/comparison/master-only/hls-master-only-1-popup.png) omitted both Live and VOD, as asserted in [the receipt](rea-evidence/comparison/master-only/hls-master-only-1.json). Our first candidate/confirmed sample arrived 44 ms after the master response; original first polled discovery arrived 669 ms after it. This is a single regression trial, not a repeated playback comparison. `hls-master-only` is opt-in and excluded from the default thirty-trial matrix.

## Final review-fix verification on `be4669b`

The final source gate passed **114 tests, typecheck and the six-file/dependency-license audit**. The tested build is **`be4669b1b3b75b1cda89b6cbc47a5bb64777529f`**, with `background.js` SHA-256 **`a97773cd68c25a1a845ca3b25da4a1c36049aa87b0a8667d0b04b4659eb90d50`**. All six artifact hashes, independent snapshots and actual popup text are retained in [results.json](rea-evidence/comparison/final-review/results.json); [summary.json](rea-evidence/comparison/final-review/summary.json) gives the aggregates. Older 30/21-trial results above retain their original build identities.

```powershell
node scripts/browser-comparison.mjs --trials=3 --cases=direct-mp4,direct-webm,hls,dash,multiple,no-video,mime-negative,hls-master-child,hls-child-master-inflight,hls-pending-child-restart --output=docs/rea-evidence/comparison/final-review
```

**Exit 0: our detector passed 30/30 case-trials**, 2026-10-16 00:33:02–00:37:20 UTC, Chromium 153.0.8010.12. The seven existing positive/negative cases passed **21/21 for each extension**. All nine additional order-control trials passed our state and actual-popup checks; the original retained one unexpected standalone MP4 fragment record in each control. Thus the original passed 21/30 overall, with **nine unexpected fragment rows** scoped to those controls. Our detector had **zero confirmed false positives and zero duplicate primary URLs**; original primary-URL duplicate count was also zero. This bounded fragment-row difference is not a general reliability score.

Public/direct cases use the common response-relative polling definition above:

| Case (3 trials each) | Our candidate (ms) | Our confirmed (ms) | Original first polled (ms) |
| --- | --- | --- | --- |
| Direct MP4 | 141–190 | 141–190 | 568–630 |
| Direct WebM | 186–205 | 186–205 | 598–613 |
| Public HLS: one group, five video variants | 36–179 | 36–179 | 579–735 |
| Public DASH: one group, ten video variants | 18–204 | 153–241 | 574–830 |
| Multiple: two independent sources | 123–151 | 123–151 | 546–569 |
| No-video and misleading-MIME controls | Not applicable | Zero confirmed media | Zero accepted media |

The remux produced a **5.005-second** VOD media playlist with an 878-byte initialization resource and two real fMP4 segments; `video-001.mp4` is 587,513 bytes. The order controls fetch resources explicitly and make **no playback claim**. Public hls.js/DASH trials provide the separate player coverage.

| Order control (3 trials each) | Verified new-engine outcome |
| --- | --- |
| `hls-master-child` | Master confirmed first, then observed selected child probed; duration/VOD/protection metadata merged into the same owner. Fetching the named MP4 segment left one primary HLS group. |
| `hls-child-master-inflight` | Own worker's child GET was observed and its response body held before the master arrived. Releasing it preserved one owner, transferred child metadata and marked the declared protected source `unsupported`. |
| `hls-pending-child-restart` | Persisted child descriptor was probing; actual worker stop was observed; an ephemeral own-worker global sentinel cleared; a normal snapshot message woke recovery; the child became confirmed in the same owner with its first-seen time preserved. |

All nine controls retained only the selected child's durable work. Own-worker request attribution and fixture-server logs showed **zero unused-rendition fetches and zero key requests**. The protected declaration is a parser-metadata control over clear media, with no decryption operation; our broad protection flag is not compared as equivalent to the original's `has_drm` field. Its terminal owner is intentionally `unsupported`, so a zero confirmed count in that control is expected, not a missed source. [The actual protected-owner popup](rea-evidence/comparison/final-review/hls-child-master-inflight-1-popup.png) shows the one owner and its explicit status.

Actual worker recovery, top/frame navigation clearing, concurrent-tab isolation and stale-manifest rejection passed again. The live popup rendered the newly observed source **227 ms after its response**. All measured popup bodies were 460 px wide. Requested 200 ms polling measured 198–417 ms; three deliberate worker-stop polling pauses are separately recorded. No page/worker warning or error was captured.

**Aborted-frame browser recovery remains BLOCKED.** The control initiated a navigation that withheld response headers, then called `window.stop()` in the surviving frame, but Playwright observed no `requestfailed` event within two seconds. Consequently the intended `ERR_ABORTED`/surviving-document recovery scenario was not established. Its independent `lifecycle.abortedFrame.status` is `blocked`; the primary lifecycle status and exit 0 do **not** count this optional control as passed. Listener/unit regressions are separate source-gate evidence, not a substitute browser result.

The browser's recorded ephemeral endpoint, port 9013, refused connections after completion (`ECONNREFUSED`), as retained in [browser-closure.json](rea-evidence/comparison/final-review/browser-closure.json). This verifies test-browser closure independently of process exit. The user browser on 9222 was never queried or controlled.

## Scope limits

This is detection-only verification. Manifest recognition does not establish downloadable output, muxing, DRM support or protected-content access. The original exposes top-tab attribution in session state; its precise per-source frame/document IDs are unavailable in these observations. Our controlled cross-origin case records actual frame/document provenance.

No worker restart result is inferred from extension reload or browser restart: the harness observes an actual CDP `ServiceWorker.stopWorker` stopped event with the extension still loaded, then wakes the worker through a normal extension snapshot message. Storage polling is paused during this operation because debugger attachment can keep a worker alive.

The user-selected Cinejoy replay and its REA evidence are a separate research authority. A replay without new media requests cannot establish a new-engine comparison. This harness deliberately leaves that live session untouched. See [the detection matrix](DETECTION_TEST_MATRIX.md) and [the original baseline report](ORIGINAL_BASELINES.md) for the broader untested/unsupported cases.
