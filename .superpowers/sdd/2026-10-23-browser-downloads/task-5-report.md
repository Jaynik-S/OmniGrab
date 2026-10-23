# Task 5 report: usable popup download controls and live job state

Status: DONE. Task 5 source and native gates are complete; Task 6 owns full Cinejoy acceptance.
Base: `eb5c82781e794e183acb4513fe4064401dc01287`, branch `feat/browser-downloads`.
Implementation/report commit is returned separately to the controller after this report is staged.

## Scope and files

Created:
- `src/popup/download-view.ts`: small UI module owning eligibility explanations, editable filename and real rendition selector, intent/request identity, pending/error feedback, separate immutable-selection job history, and cancel/retry controls.
- `tests/popup-controller.test.ts`: executes the actual popup entry module against controlled Chrome boundaries to verify separate storage streams, no storage/snapshot feedback loop, overtaken command responses, and stale active-tab reads.
- `tests/popup-browser.mjs`: production-extension native action-popup harness, generated owned fixtures, temporary browser profile, strict physical filename, screenshots and independent saved-file validation.
- This report.

Modified:
- `src/popup/view.ts`: optional download view integration; existing detector cards, source/protocol, page-title fallback, MIME/observed manifest-byte evidence, URL copying and provenance remain. Captures/restores active form focus, selection direction/caret, page scroll and expanded source details during rerenders.
- `src/popup/index.ts`: reviewed public runtime messages, initial job snapshot, direct consumption of local job-storage changes, existing detection-session refresh, active-tab/read fencing and command-response ordering fence.
- `src/popup/style.css`: compact controls and job history consistent with incumbent styles. Fixes root width to existing 460px body width rather than changing the design width.
- `src/popup/index.html`: replaces obsolete discovery-only footer with supported clear-HLS-VOD-to-MP4 behavior.
- `tests/popup.test.ts`: focused control, eligibility, identity, persistence, history, phase, recovery and disappearing-rendition regressions alongside all eight existing detector-view tests.

No upstream production, permission, manifest, dependency, detector, engine, host or transport files changed. No new dependency. Shared `httpUrl`/`safeFilename` are reused; `DownloadJob`, `DownloadStartRequest`, `JobOutcome` imports are type-only. No media enters Chrome storage. All source-derived strings use textContent/value rather than HTML parsing.

## API and data flow

1. Active tab is obtained with `tabs.query({active:true,currentWindow:true})`; the existing detection snapshot owns tab/epoch/media/instance identity. Tab activation invalidates older in-flight detection reads.
2. Eligible clear, confirmed, remote HLS VOD receives Output: MP4, a safe editable filename (item title, page-title fallback, then video), real video-only options sorted highest first, and Download MP4. Unsupported, unconfirmed, protected, unknown-clearance, live and blob rows receive an explanation and no download action. A removed selected rendition remains selected/unavailable and blocks starting until the user selects an available rendition.
3. Start sends exactly `{type:'download-start',request:{requestId,tabId,epoch,mediaId,instance,variantId?,filename}}`. Intent keys include source identity plus exact filename/quality; the same intent reuses its UUID across double clicks, refreshes and a lost response. A changed filename/quality gets a different intent. Only 50 intent records are retained in extension-page localStorage (`popupDownloadIntents-v1`); these are UI request metadata, separate from authoritative detection/job metadata. If that optional browser UI storage fails, current-popup in-memory protection remains; persistent reopen protection depends on storage availability.
4. Cancel/retry use exactly `{type:'download-cancel',jobId}` and `{type:'download-retry',jobId,requestId}`. Retry IDs are similarly stable after a lost response. Commands show structured safe `code: message` feedback. Cleanup-pending/uncertain-save records remain visibly blocked with recovery text; the UI never mutates attachment/saveIntent or invents settlement.
5. Initial/open and post-command reconciliation use `{type:'download-snapshot'}` without tabId. `chrome.storage.local.downloadState` updates update the displayed jobs directly; they do not call snapshot again. Detection-session updates refresh only the detection snapshot. This avoids a read/write feedback loop while retaining meaningful progress updates.
6. All bounded jobs remain in their own Downloads section using each job's immutable filename/quality/tab identity; navigation marks older/other selections rather than attaching their state to a new detection row. A storage revision fence prevents an older command result replacing a newer durable event.
7. Queued/resolving/processing/finalizing/ready-to-save/saving/complete/canceled/interrupted/failed labels map to the reviewed persisted model. Finalizing is a processing progress value. Media-read and MP4-written bytes are shown separately; detector manifest bytes remain in source details. Unknown total stays unknown, and a time progress bar is only shown with a supplied duration. Saved is only shown for persisted Chrome complete.

## RED/GREEN evidence

Commands executed in this workspace (PowerShell uses npm.cmd):

- `node --experimental-strip-types --test tests/popup.test.ts`
  - Initial RED: 11 tests, 8 pass / 3 fail: no real select, no editable filename, and no download eligibility explanation.
  - Incremental history/control RED: 13 tests, 11 pass / 2 fail: missing separate history and cancel/retry actions.
  - Disappearing-selected-rendition RED: 15 tests, 14 pass / 1 fail: actual `v1080` replaced explicit `v720` after detection update. Preserve the unavailable selection and require user choice.
- `node --experimental-strip-types --test tests/popup-controller.test.ts`
  - Initial RED: 1 fail: actual entry module did not load/display jobs.
  - Ordering RED: 1 fail: late command response showed Canceled after a newer durable complete event. Added `jobsRevision` capture before RPC and refuse stale replacement of an existing job.
- `node --experimental-strip-types --test tests/popup.test.ts tests/popup-controller.test.ts`
  - Final GREEN: 16 tests, 16 pass, 0 fail; 15 view and 1 integrated controller test.
- Linkedom has a getter-only select.value. A small test-only setter uses native option-selected semantics; the actual Chrome action popup independently selects 720p and verifies the sent/persisted rendition. Browser behavior is not inferred from that shim.
- `npm.cmd run typecheck`: final exit 0.
- `npm.cmd test`: final 254 tests, 254 pass, 0 fail, 0 skipped; log `.cache/task5-unit-final.log` (6.466 s test duration).
- `npm.cmd run build`: final exit 0; eleven extension files audited, local bundles and license notices verified. First sandbox build failed because esbuild could not inspect an ancestor directory; the same command with approved escalation succeeded. No build workaround was introduced.
- `git diff --check`: exit 0 before staging.

## Native action-popup evidence

Command: `node --experimental-strip-types tests/popup-browser.mjs`.
Final receipt: `.cache/download-popup/native-1792795025540-18804/evidence.json` (`ok:true`, four cases, `errors:[]`).
Production source build matches the final implementation; only the native harness's save configuration was corrected after the last build.

The harness launches only an owned temporary Chromium profile (`C:\Users\jay03\AppData\Local\Temp\owned-download-popup-mhv702`), port 11442 (explicitly not 9222), with this production dist extension. It opens `chrome.action.openPopup()` and connects to its actual popup target. Start/cancel/retry are actual DOM control actions in that popup, not internal download-message substitutes. It reads authoritative job/download metadata for assertions.

Verified cases:
1. Actual source card contains distinct real options `1080p`, `720p`; page-title filename fallback is `Owned popup fixture.mp4`.
2. Native select.value chooses 720p; editable filename is `Popup 720 fixture.mp4`; double click creates one job, with `requestedVariantId:'hls:1'`, 1280x720 and the edited filename. Active filename focus, caret [3,8] and backward selection survive job-storage changes. A separate real DOM/source detection update retains `Keep my caret.mp4`, active focus/caret/direction and 720p.
3. Popup is closed then reopened through the real action API. The existing processing job and Cancel are present, independent of freshly rendered detection controls.
4. Actual Cancel transitions the first record to canceled; actual Retry creates a new record, which becomes Chrome complete and visibly Saved by Chrome. Final physical basename is exactly `Popup 720 fixture.mp4`, owned browser download ID 1, byExtensionId matches the extension, bytes/fileSize/totalBytes all 268213. ffprobe independently finds H.264 720p (12 video frames) and AAC mono (58 packets/frames reported), format duration 1.221979 s. `ffmpeg -v error -xerror -i <saved file> -f null -` exits 0. This is a generated ~1.2-second fixture, not a full-length acceptance claim.

Saved media: `.cache/download-popup/native-1792795025540-18804/Popup 720 fixture.mp4`.
Screenshots, visually inspected:
- `.cache/download-popup/native-1792795025540-18804/01-controls-progress.png`: title/source, separate MP4 output, editable selected text and 720p selector readable at the existing width.
- `.cache/download-popup/native-1792795025540-18804/02-reopened.png`: reopened existing processing job and visible Cancel.
- `.cache/download-popup/native-1792795025540-18804/03-saved.png`: Saved by Chrome and independent canceled history record.
- Width evidence also in `00-width-check.png`: body 460px; native viewport client/scroll 475px (vertical scrollbar included); no overflowing descendant, horizontal overflow or clipping.

Native issues found and corrected:
- Initial root auto-width layout under repeated content updates measured scrollWidth 520/clientWidth 490. `html {width:460px}` matches the existing fixed-width body; final scrollWidth equals clientWidth. Initial receipt `.cache/download-popup/native-1792794555314-18204/evidence.json`; diagnostic screenshot `.cache/download-popup/native-1792794578673-15512/00-width-check.png`.
- PowerShell's default ANSI output initially encoded non-ASCII strings incorrectly in the new UI module. Converted that new file explicitly to UTF-8 and inspected the final screenshots (no replacement glyphs).
- The stricter physical filename assertion initially failed under the harness's `Browser.setDownloadBehavior({behavior:'allow',downloadPath:output})`: Chrome saved the blob UUID basename despite correct submitted/persisted filename. RED receipts `.cache/download-popup/native-1792794971149-23428/evidence.json` and `.cache/download-popup/native-1792794983847-23692/evidence.json` (acceptDownloads:false alone still failed). Native-default save setup now writes only this fresh owned profile's download.default_directory/prompt_for_download preferences and uses `Browser.setDownloadBehavior({behavior:'default'})` to restore normal Chrome determination after Playwright setup. The same strict expected-basename assertion passes in the final receipt. This isolates a harness override artifact; no upstream production filename fix was needed. Controller agreed no redundant headful diagnostic was required. For Task 6, reuse this native-default configuration and keep the basename assertion.

Cleanup: all harness CDP sockets, browser context, interval timers and owned HTTP connections/server are closed in finally; final receipt has `closedOwnedBrowserAndServer:true`. Exact-profile read-only Win32_Process query with approved escalation returned 0 remaining Chrome processes for the final temporary profile. An initial sandbox process query was denied, so its empty result was not used as proof. No user Chrome/default profile or port 9222 was operated. Media/profiles/screenshots/results are ignored and outside dist/Git.

## Self-review, limits and handoff

Self-reviewed all owned source/tests and full diff: preserved established UI/evidence structure, exact public messages/model, safe rendering, request identity, foreground context, race fences, no new permissions/dependencies, no engine/host changes. New form/job controls remain keyboard focusable with associated labels; rerenders restore caret/focus and existing width remains readable. Self-review regressions for removed quality and overtaken RPC are now green.

No Task 5 blocker or upstream production defect was found. The separately controller-recorded Task 4 storage-estimate/preflight/quota-message correction is outside Task 5 and was not masked or implemented in the popup. Later safe structured outcome messages will render generically.

This receipt validates generated fixtures and real browser file saving/control lifecycle only. Task 6 must perform the full 53:10 Cinejoy acceptance, complete playback/seek/duration/quality/audio checks and frozen-artifact acceptance with native-default filename behavior. The UI's Chrome-complete label is a browser-save claim; independent media validation is external acceptance evidence, not an invented job phase or claimed automatic user-file validator.
