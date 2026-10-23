# Cinejoy detection failure: investigation and repair

Date: 2026-10-23, America/Toronto. Target: the user's three screenshots and `https://cinejoy.pk/watch/tv/67178/2/1`.

## Verified failure

The screenshots show an unresolved HLS master with `manifest-http:404` and a separate blob lasting 3189.56 seconds. The original shows **HLS**, an intended `.mp4` output name, 1080p, and **53:10**. That is an HLS stream presented as a future MP4 output, not proof of a progressive MP4 URL.

Fresh reproduction in an isolated Chromium 153 profile with both extensions reproduces exactly the same master URL and failure. Original version is now **10.6.7.2**, rather than the previous investigation's 10.6.1.2. Its accepted item has 1080p/720p variants and duration 3189.561635 seconds. Our worker receives 404 and stores only the unresolved master and blob.

- The page and original requests carry the page's Origin/Referer and return 200; our extension-worker request does not carry them and returns 404.
- A normal page fetch using `same-origin` or `omit` credentials returns 200 and a valid HLS master. Page fetch with `include` fails under the server's CORS policy. Credentials inclusion alone is not equivalent to the player's request context.
- The selected `1080p/playlist.jpg` returns a valid media playlist: 797 EXTINF entries, total 3189.561635 seconds, VOD, initialization `init.mp4`, no key declaration. These are manifest observations, not a completed download or a decryption claim.
- REA controlled navigation Evidence: `ev_dd8545f80398c88180c9040f0b1aa0357af30eb54296f0ca7ea567a4f0d83fdf`. Its capture explicitly has incomplete event coverage and excludes extension-worker traffic; supplemental Playwright worker/request observations supply that separate authority.

## Code-level causes

1. `ManifestProbe.run()` refetches only from the extension worker. It has no page-context transport fallback.
2. `probeFailed()` makes parent/child work unresolved; later same-type positive observations and Rescan cannot retry it. The failure becomes permanent until navigation.
3. HLS enrichment relies on observed child traffic. Current original `Af()` deliberately fetches a selected rendition for duration. Our detector can therefore know qualities without learning duration, especially after late installation/buffering. Image-suffixed child observations can also be lost before a master is parsed.
4. The popup gives blobs and unresolved candidates the same prominence as confirmed streams, leaves useful duration in raw seconds, and fails to use the page title as a fallback for a manifest.
5. The live CDN serves real manifests with image MIME types and image-suffixed children. During the first repaired run, a successful page fallback's network observation could downgrade its pending manifest before body validation completed. URL-based manifest intent must survive that misleading MIME until parsing establishes the result. Direct MP4 responses with HTML/image MIME remain subject to the existing negative classification.

Current-original static references and byte identity are retained under `rea-evidence/cinejoy-gap/static-*`. Proprietary source is not copied into implementation.

## Repair design and acceptance

Extend the existing probe/store/collector boundaries. Keep the three current API permissions and HTTP(S) hosts. On failed worker manifest retrieval, try a bounded normal fetch in the originating content-script document, using that page's normal CORS rules and default same-origin credentials. Do not copy cookies or authorization values, install DNR rules, intercept page fetch, or bypass access controls. Retain the originating generation/instance/document fence through both transports.

After parsing an HLS master, schedule at most one preferred video rendition (highest resolution/bandwidth) for metadata. Do not fetch all variants, segments, keys or subtitles for detection. Persist that work and use its duration/protection/segment relationships to enrich the master. Existing observed-child work remains valid.

New successful network evidence and an explicit Rescan can requeue failed manifests with a fresh instance and a bounded retry budget. Routine repeated resource observations and worker restarts must not create retry loops. Old results cannot cross navigation or replacement.

Show confirmed remote media first: title, HLS/DASH/direct source format, formatted duration and actual quality choices. Keep exact URLs/provenance inspectable. Keep uncertain local blobs in a separate diagnostic section without inventing a blob-to-stream relationship or a downloadable MP4 URL.

Acceptance requires a fresh real-page comparison on the same episode: one confirmed HLS master, 1080p/720p, duration matching the original within rounding, no standalone segment videos, an actual readable popup, and no custom header/DNR dependence. Also test worker404/page200, CORS errors, bounded/timeout failures, restart/navigation fences, failed-probe recovery and multiple independent sources. A fixture pass alone cannot close this incident.

## Status

The bounded repair is implemented and scoped review approved it with no remaining Important findings. Final native and real-page verification use the exact six bundle hashes below. Downloading is a separate unimplemented feature.

## Implemented flow and references

1. `core/classify.ts::classify` records HLS/DASH manifest intent from MIME or a manifest suffix; parser validation is still required. `core/reducer.ts` retains that intent while a successful misleading-MIME response is being parsed.
2. `background/manifest-probe.ts::ManifestProbe` persists probing, tries worker retrieval, and delegates a failed request to `background/page-manifest.ts::createPageManifestFetcher` within one deadline. The latter validates the originating document before and after messaging.
3. `content/manifest-fetch.ts::createManifestRequestHandler` validates extension messages and deadlines. `fetchManifestForPage` performs the bounded ordinary fetch. `manifests/response.ts` supplies shared body/UTF-8 limits. No custom headers, DNR rules or new Chrome permission are introduced.
4. `core/reducer.ts::applyManifest` groups the master and linked children, schedules one preferred child if duration is missing, and merges parsed child metadata. `retryManifests` requeues failed work on Rescan; fresh network evidence has a bounded automatic retry path. Model/store validation preserves retry counts and source identity across recovery.
5. `popup/view.ts::renderSnapshot` puts confirmed remote sources first, uses the page title when needed, formats duration as `53:10`, and exposes actual qualities. URLs, response MIME and manifest byte size remain under Source details. Uncertain blobs stay separate.

Review also exposed races at ownership transfer and cancellation. Regression tests cover retry-budget transfer, distinct masters sharing a child, coalescing an already-running standalone child into its master without a duplicate physical fetch, actual cancel propagation, deadline expiry, and content work surviving worker restart. The final design uses owner-aware work identities, aliases only for the same resolved owner, four physical page slots and bounded deadline-aware waiting. Queue cancellation/expiry and storage-failure alias settlement received an additional independent in-memory review.

## Final verification

- `npm.cmd run check`: exit 0; TypeScript, **158/158 tests**, six-file runtime allowlist and bundled-license audit passed.
- Native collector checks: **3/3**, exit 0. [Native context/recovery/deadline controls](rea-evidence/cinejoy-gap/native-context/run-2026-10-23T08-45-17-418Z-11396/results.json): **3/3**, exit 0; actual toolbar Rescan recovers the same source/epoch/first-seen. Five stalled fallbacks are physically canceled in 5004–5020 ms from primary request receipt, maximum concurrency four, with no late confirmation. The receipt declares a 500 ms scheduling allowance. Structural controls make no playback claim.
- Fresh **ours-only** Chromium profile on the exact episode: [state](rea-evidence/cinejoy-gap/final-standalone-state.json) has one confirmed HLS master, 1080p/720p and **3189.561635 seconds**, matching the independently captured current original. There are no standalone segment media rows. The player selected 1080p in this run; only one additional preferred-child manifest is scheduled for detection.
- [Actual action popup](rea-evidence/cinejoy-gap/final-standalone-popup.png), [text](rea-evidence/cinejoy-gap/final-standalone-popup.json): one primary HLS row, **53:10**, both qualities, 460 px body, local blob collapsed separately. [Actual worker stop/wake](rea-evidence/cinejoy-gap/final-standalone-restart.json) verifies a cleared ephemeral sentinel and unchanged source identity, first-seen, duration and qualities after a normal message wakes recovery.
- [Final REA scenario projection](rea-evidence/cinejoy-gap/final-standalone-rea.json), Evidence `ev_068bee9dff50249eef8ef5578cc32ea300443153e30471569c8cec5d55ef5710`, retains the declared navigation and network observations. Coverage is incomplete and excludes extension-worker requests; supplemental native state and popup observations are separate authorities. The earlier successful dual-extension run and intermediate MIME failure remain retained as earlier-build evidence, not substituted for this ours-only result.
- [Final neighbor comparison](rea-evidence/cinejoy-gap/final-neighbors-popup-contract/results.json): exit 0, **7/7 for each extension** across direct MP4/WebM, HLS, DASH, multiple sources and two negative controls; lifecycle and visible primary-row checks passed. The optional native aborted-frame setup remains blocked and is not counted as passed. The preceding run's outdated raw-URL visibility assertion and cleanup termination are retained separately in [the comparison report](BROWSER_COMPARISON.md#cinejoy-repair-follow-up-2026-10-23).

Final artifact SHA-256:

| File | SHA-256 |
| --- | --- |
| `background.js` | `537864b34bd1cc120752faa22019d9c81b54a75688c1737a84cb872e37ae40df` |
| `content.js` | `03d3f81fe719e90d3dfc8e62b37d2a0591592758d04c0c2ac1bf0ebef4a5c53b` |
| `popup/index.js` | `7ecfc4f3b55c560ad927e348acc0c80d815381cee5c3e749c2f9929bf5efa48c` |

All six hashes are recorded in the native receipt. Tests ran on the working repair over `0d78cd8`; that parent Git revision alone does not identify the changed source. Build hashes identify the tested artifact.

## Verified findings and remaining uncertainty

The same current URL fails in worker context and succeeds under normal page-context CORS. That verifies the request-context difference; it does not isolate Origin versus Referer as the sole server rule. The manifest's preferred-child EXTINF sum and the current original's duration match; exact execution of the original screenshot remains inferred from static and matching runtime evidence.

The repair detects and presents this stream. It does not produce an MP4 file. The original's `.mp4` label describes an output container for an HLS download; adding a save pipeline requires separate segment retrieval, rendition/audio selection, assembly, progress/cancel/retry and saved-file verification. Broader cross-site parity, authentication policies, unsupported manifest constructs, closed shadows, long-running live windows and DRM are not proven by this incident. No proprietary source was copied.

To use this detector, reload the unpacked extension from this project's `dist` in `chrome://extensions`, then reload the webpage to replace the content script. Start normal playback if the player has not requested its media yet. Open the extension action; use Rescan after a transient manifest failure. No completed MP4 download is inferred from a confirmed source.
