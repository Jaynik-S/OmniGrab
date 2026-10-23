# Media Detection Lab

An original TypeScript Chrome Manifest V3 media detector. It discovers direct media, HLS and DASH through complementary network metadata, media DOM, Resource Timing and manifest parsing. The popup shows sources, methods, metadata, variants and unresolved/protection diagnostics. This milestone implements discovery; it has no download or decryption action.

The installed Video DownloadHelper was investigated separately with REA. Its proprietary source, website rules and binaries are not included in this implementation or build.

## Develop and load

Requires Node 24+ and Chrome 120+.

```powershell
npm.cmd ci
npm.cmd run check
```

In `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this project's `dist` directory. Reload existing webpage tabs after loading/reloading the extension so its static content scripts are injected. Open the extension action on a webpage to view that tab's evidence. **Rescan** observes current DOM/resources and retries failed manifest work; it does not force playback or clear browser data.

`npm.cmd run check` runs TypeScript, the Node fixture suite and the build allowlist audit. The bundle contains six files. In the Codex Windows sandbox, esbuild's ancestor-directory resolution and external browser networking required normal filesystem/network execution permissions; this was an environment restriction rather than a build failure in the project.

Native DOM regressions use an installed Chromium and the development-only Playwright Core package:

```powershell
node tests/content-browser.mjs
```

Set `CHROMIUM_PATH` if the default local Playwright Chromium path is unavailable. Comparative browser tests additionally require the installed original extension. See [the test matrix](docs/DETECTION_TEST_MATRIX.md) and [comparison report](docs/BROWSER_COMPARISON.md) for commands, fixtures, measured outcomes and limitations. Browser-test profiles are temporary and separate from the user's Chrome profile.

## Implementation map

| Path | Responsibility |
| --- | --- |
| `src/background/index.ts` | Synchronous Chrome listeners, trusted sender attribution, lifecycle integration and popup messages |
| `src/background/network.ts` | Request-start context and response MIME/status/length extraction |
| `src/background/store.ts` | Serialized restoration, validation and save-before-acknowledgment session snapshots |
| `src/background/manifest-probe.ts` | Four concurrent manifest fetches, five-second deadline, two-MiB streamed-body limit and pending-work recovery |
| `src/core/` | Original URL identity, classification, generation fences, deduplication and explicit source grouping |
| `src/manifests/` | Independent bounded HLS/MPD parsing; no network or key retrieval |
| `src/background/page-manifest.ts` | Document-scoped fallback messaging and bounded physical page fetches |
| `src/content/` | Initial/dynamic media DOM, open shadow trees, Resource Timing and normal-CORS manifest fallback |
| `src/popup/` | Confirmed remote media, formatted metadata and expandable source diagnostics |
| `extension/manifest.json`, `scripts/build.mjs` | MV3 declarations and runtime-only distributable |
| `docs/rea-evidence/` | Research/test evidence, excluded from the build |

Production uses `fast-xml-parser` for validated MPD XML; its complete MIT notice is included and audited in the background bundle. TypeScript, esbuild, Chrome/Node types, linkedom and Playwright Core are development dependencies. Package versions are locked in `package-lock.json`.

## Permissions and limits

`webRequest` observes request metadata; it does not provide response bodies. `webNavigation` supplies document/frame lifecycle, and `storage` persists worker-session state. HTTP(S) host access covers both webpage and media/CDN origins across sites. The extension requests no downloads, debugger, scripting, native messaging, offscreen, DNR or cookie permissions.

Signed URL queries are preserved in candidate identity. No cookie, authorization header or request-body capture is performed. Manifest refetch starts in the worker; on failure it can use a current originating content-script document with normal CORS and default same-origin credentials. Both paths share the five-second deadline and body limit. Server policy, expiry, authentication or browser restrictions can still leave an unresolved source. A confirmed detection does not prove a future download will succeed.

Blob/MSE entries are unresolved local context; underlying HTTP sources are detected separately. There is no generic interception of page fetch/XHR or MSE buffers. Closed shadow trees, WebRTC/MediaStream buffers, protected playback, unsupported manifest constructs and site-specific extraction remain outside guaranteed coverage. Open roots created on existing hosts are discovered by a bounded two-second sweep while visible, plus batching delay.

State is bounded to 50 tabs, 100 frame documents per tab, 200 candidates per tab, 20 retained variants, 100 observed child-manifest jobs per source and 10,000 explicit child/segment references per list. Strings are limited to 16,384 characters; each parsed manifest has a combined reference budget of 2,097,152 characters. Oversized signed URLs are rejected without truncation. Stronger incoming evidence can displace weak candidates, with diagnostics.

Observed HLS children enrich their owning master and retain pending work across worker restarts. When duration is absent, one preferred rendition is fetched for metadata; other unobserved renditions, segments and keys are not fetched for detection. Live/VOD remains unknown until supported by a media playlist. Fresh successful network evidence permits up to three probe attempts; explicit Rescan resets failed work, while repeated resource inventory and worker wakes do not loop retries. DASH fragment relationships preserve template variable identity, decimal formatting and exact queries. Long-running live-window changes and recovery of earlier unclassifiable responses remain outside the verified scenarios.

Session storage survives a service-worker instance restart; browser restart or extension reload is a different reset boundary. Media removed from a DOM element may remain as previously observed evidence until navigation; there is no element-removal tombstone protocol yet.

## Research

- [Initial installed-extension architecture](docs/REA_ANALYSIS.md)
- [Detailed REA detection findings](docs/REA_DETECTION_ANALYSIS.md)
- [Architecture and design boundaries](docs/DETECTION_ARCHITECTURE.md)
- [Original-only runtime baselines](docs/ORIGINAL_BASELINES.md)
- [Implementation/review ledger](docs/DEVELOPMENT_PROGRESS.md)
- [Cinejoy failure, repair and live evidence](docs/CINEJOY_DETECTION_FIX.md)

Verified findings, inferences and unknowns are labeled in the research reports. Fixture success and a finite comparison set do not establish exact cross-website replication.

## Remaining product work

This build can be used to inspect detections after loading `dist`. It is not yet a complete Video DownloadHelper replacement. Downloading still requires a direct-file download action, HLS/DASH rendition selection and segment processing, audio/video assembly into an output container, and progress/cancel/retry/error handling. Those paths need independent end-to-end tests that validate the saved media. Broader real-site and authenticated/frame-context testing is also required. Exact worldwide detection parity is not established; DRM decryption is outside the current scope.

The [Cinejoy download-gap analysis](docs/DOWNLOAD_REPLACEMENT_GAPS.md) records the current original's browser-only processing path, confirmed stream codecs, missing components and proposed design. It is research/design evidence; no download implementation is included yet.
