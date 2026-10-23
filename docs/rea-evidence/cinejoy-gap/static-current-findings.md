# Current Video DownloadHelper: Cinejoy detection gap

Scope: installed extension **10.6.7.2**, inspected as inert JavaScript on 2026-10-23. This is a focused reinspection of the current package, not a claim that the earlier 10.6.1.2 analysis describes every current function. No proprietary implementation was copied into production. No browser actions were performed for this static investigation.

## Verified from current files

The original deliberately preserves the successful page request's context when it reads a manifest again. It also deliberately reads a selected media playlist to obtain duration. Our pre-fix detector did neither of these completely.

| Step | Current package reference, zero-based UTF-8 byte offset | Verified responsibility |
| --- | --- | --- |
| Observe requests | `service/main.js::If` @243646 | Registers `webRequest.onSendHeaders` and `onResponseStarted`; caches sent headers by request ID. Chrome uses `requestHeaders`/`responseHeaders` plus `extraHeaders`. The opportunistic cache age is ten minutes. |
| Classify response | `service/main.js::NS` @242218 | Handles successful HTTP responses, excludes extension-origin refetches, tries HLS using MIME/URL heuristics before DASH and direct-media handling. |
| Recover sent headers | `service/main.js::Eu` @238094 | Rebuilds a `Headers` object from the matching request ID. |
| Refetch HLS master | `service/main.js::Ef` @238202 | Installs header rules, fetches the master with the reconstructed headers, parses it, then calls the child-enrichment function before emitting `on_media`. A non-OK master response is rejected. |
| Select browser-controlled headers | `service/main.js::Bm` @183284; `Wm` @186187 | Selects `Sec-*`, `Cookie`, `Date`, `Origin`, and `Referer` for DNR application. This is distinct from merely using `credentials: include`. |
| Install and remove header rules | `service/main.js::wt` @185440, `ao` @185484, `St` @185996 | Adds temporary `modifyHeaders` session rules for the requested URLs and `xmlhttprequest`, then removes rule IDs after the fetch. In this package these rules are not scoped by extension initiator. |
| Parse and order renditions | `service/main.js::Lm` @181129; `Jn` @152694; `yv` @151955 | Resolves relative child URLs, codec/container hints, audio associations, resolution and bitrate. Sorts by descending height, then bitrate. URL query carry/strip rules are site configuration. |
| Enrich master from child | `service/main.js::Af` @237259 | Independently fetches the first sorted video child, or audio child if no video, using the reconstructed headers and temporary DNR rules. Uses a five-second timeout. This does **not** require the page to have requested that child. |
| Calculate duration | `service/main.js::io` @180881; `ro` @180406; `no` @183197 | Accepts a nonempty non-subtitle media playlist, sums its numeric segment durations, and reads protection signaling. A recent program-date-time can produce the original's `live` heuristic. Failed child enrichment leaves duration `unknown`. |
| Group master and child | `service/main.js::Vy` @536078; `Vx` @536684; `rm` @537763 | Stores one master record, rejects a later media-playlist record matching one of its rendition URLs, and removes already-stored matching child rows when the master arrives. |
| Obtain page title | `service/main.js::jn` @535473; `Of` @244328 | Reads tab metadata and injected page title/meta title plus thumbnail selectors. This is naming metadata, not video-byte detection. |
| Choose displayed name | `content/panel.js::Id` @271249 | Chooses media title, tab title, filename, then a hostname-derived fallback under the selected naming template. A name such as `Cinejoy` need not be the server file basename. |
| Show HLS tag | `content/panel.js` media-tag component @323433 | Maps `m3u8_playlist` to the HLS tag; a simple media playlist gets the separate M3U8 tag. |
| Show MP4 extension | `content/panel.js::xg` @327655; `ti` @319568; discovered-row `buildArgs` @337292 | Selects an output container using rendition demuxer and preferred AV muxer. The resulting download argument's `extension` populates the displayed suffix. The default preferred AV muxer is `mp4` (`service/main.js` @500477). |
| Show duration and quality | `content/panel.js::Gt` @276103; selector `Kr` @321534; metadata component @342528 | Formats duration as `mm:ss` or `hh:mm:ss`; shows selected rendition resolution. Default selection uses saved entry/quality, otherwise the first ordered rendition. |

All offsets above refer to the exact file hashes in [static-direct-inspection.json](static-direct-inspection.json). The inspected relevant files contain ASCII text, so the recorded byte offsets also equal character offsets. Method/component offsets identify their owning declaration or exact method start, as recorded in the JSON.

## What this proves about the screenshots

The HLS tag, `Cinejoy.mp4`, `53:10`, and `1080p` are consistent with **one HLS master record enriched from a rendition playlist and presented as a planned MP4 output**. The `.mp4` suffix alone does not demonstrate that a progressive MP4 exists at a downloadable network URL. Verifying a completed MP4 download would additionally require running and validating the download/mux pipeline.

The generic network path can account for Cinejoy without a dedicated Cinejoy content script: this manifest declares no Cinejoy match. That is a bounded statement about the manifest's declared scripts, not proof that every remote configuration rule is irrelevant.

## Gaps verified in our pre-fix implementation

1. `src/background/network.ts::RequestTracker` records response metadata and document fences, but no sent request-header context. `src/background/manifest-probe.ts::ManifestProbe.run` refetches with `credentials: include` and no `Origin`/`Referer` replay. Therefore its request can differ materially from the successful page request.
2. `src/core/model.ts::MediaItem.childManifests` and the probe queue intentionally include only observed children. An HLS master with variants can remain without duration when the page has not requested an accepted child, whereas the original proactively enriches a selected child.
3. `src/popup/view.ts::renderSnapshot` presents every candidate with raw URL/status and seconds, including blob observations. It does not produce the original's source grouping, title-based filename, selected quality and formatted-duration presentation.

These are implementation findings at investigation time, not assertions about the final fixed tree. The root investigation owns subsequent source changes and verification.

## Hypotheses requiring runtime corroboration

- Missing `Origin` and/or `Referer` is a plausible reason our extension-context request received 404 while playback and the original worked. Static code cannot establish which header the current server requires, whether a token expired, or whether cache, cookies, redirects or timing also matter. Compare the same current URL with bounded request-context variants before calling a specific header causal.
- The pictured 53:10 likely comes from the selected child playlist's segment sum through `Af` and `io`. Static analysis establishes this path, but only a matching current original state or runtime observation can prove that exact screenshot took it.
- Blob and other observations may correspond to the same playback, but correlation must use document/manifest relationships or corroborated metadata. Sharing a tab alone is insufficient to merge every media element.

## API and implementation implications

Preserving observed request context needs `webRequest.onSendHeaders` with `requestHeaders` and, for the Chrome headers involved here, `extraHeaders`. The existing `webRequest` and HTTP(S) host access can observe the relevant event when access covers the target and initiator. Setting browser-controlled headers on a worker refetch requires a supported mechanism such as `declarativeNetRequest`; adding that permission would be a meaningful manifest change. A `cookies` API permission is not inherently needed to observe an already-authorized request's header event.

An original implementation should retain only the required headers in bounded session context, avoid logging them, scope replay to the exact URL and the extension's own initiator, clean rules on every failure and on recovery, and keep lifecycle fences. It should not copy the original's broadly matched temporary rules. Child enrichment should be bounded to a chosen rendition and its linked audio when needed; no reason was found here to fetch every variant or media segment just to populate a row.

This does not require copying the original's DNR approach. A fetch made from an authorized content-script document context, under ordinary CORS and credentials behavior, is a separate supported option when runtime evidence shows that it succeeds. That option can preserve the site's normal context without an extra DNR permission. The root runtime investigation owns selection and verification of that approach; these static findings establish the requirement to preserve a successful request context, not a requirement to imitate the original API choices.

## REA evidence and limits

REA 6.5.0 CLI analysis parent: `ev_3321d11aa7c696714196afc554542847018e548d1a9b611757b13bd1b513ba09`. Analysis selected the manifest, service worker, panel, shared component bundle and persistent-state bundle. It inventoried 73 relevant files, parsed four JavaScript files without a parse failure, and visited 350,089 AST nodes. The retained graph is partial because 68 files were outside the selected scope; the semantic graph also reached per-file node limits. Chrome-extension listener/message relationships require direct inspection because the application analyzer is primarily oriented to generic JavaScript/Electron boundaries.

The CLI was used because REA tools were not exposed to this child agent. The first sandboxed attempt failed REA's Windows path self-test; it was not silently treated as successful. An authorized read-only retry outside the sandbox completed. No client/server configuration was changed, no original extension code was executed by the analyzer, and no browser was opened.

The complete 162 MB application Evidence is retained in the temporary investigation directory rather than copied into this repository. The focused [REA summary](static-rea-summary.json) preserves its parent ID and limitations. Feature-trace outcomes are recorded separately so a failed or broad trace is not presented as an exact Chrome execution trace.

- [Module feature trace](static-rea-feature-trace.json), `ev_3b2db3e89917a445894a7c65ff0a57872c62be5cdddf3e5f7ec9673aecc288a4`: exact `service/main.js` module/asset seed, outgoing only; two matches, 13 nodes, 13 edges. Coverage remains partial and it does not reconstruct the Chrome event chain.
- [Focused semantic caller trace](static-rea-af-trace.json), `ev_8c56a50a729a2b19f58015ec31e6b32ff7d80349b059a7a45f2a5fb97ef741be`: the authenticated `Af` function node leads to exactly one retained caller edge from the call site at bytes 238669–238676 inside `Ef`, confirming the static master-to-child enrichment call. Two retained nodes, one relation, six relevant unknowns; static reachability does not prove the exact screenshot's execution.
