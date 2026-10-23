# Download replacement gaps: Cinejoy

Date: 2026-10-23, America/Toronto. Status: investigation complete for the pictured gap; download implementation has not started. The user clarified that this request focuses on Cinejoy, not YouTube.

## What the screenshots establish

Both images describe the same Cinejoy episode at `https://cinejoy.pk/watch/tv/67178/2/1`. The original presents **HLS**, an intended MP4 output, **53:10**, and 1080p. Our current screenshot already presents a confirmed HLS source, **53:10**, and 1080p/720p. The earlier detection repair is present. The missing Download action is a missing product subsystem, not evidence that a progressive MP4 URL must still be discovered.

The current original has a download planner, processing worker, disk-backed temporary output, and a browser save stage. Our `MediaItem` is a discovery record, not an executable download plan. Relabeling its URL or adding a button without those stages would not produce a usable video file.

## Verified source and current implementation

- Installed original inspected: **10.6.7.2**. [Current static trace and exact references](rea-evidence/download-gap/CURRENT_DOWNLOAD_GAP.md), [file identities](rea-evidence/download-gap/direct-static-references.json).
- Its demonstrated download path is **popup selection → service coordinator → offscreen document → dedicated worker → LibAV/OPFS → Chrome Downloads**. Its manifest has no `nativeMessaging`; no native companion requirement was established for this current Chrome path.
- Our current `extension/manifest.json` grants `webRequest`, `webNavigation`, and `storage`. `src/background/index.ts::message` accepts observation/snapshot/rescan messages. `src/popup/view.ts::renderSnapshot` and `renderItem` show evidence and Copy URL. There is no download request, queue, offscreen host, processing engine, or browser-save completion handler.
- Fresh [codec probe](rea-evidence/download-gap/cinejoy-codec-probe.json): the selected 1080p playlist has 797 media entries totaling **3189.561635 seconds**. The 1,393-byte initialization plus first 3,274,899-byte fragment parse as **H.264 High, 1920×1080, with AAC-LC 48 kHz stereo**. A `.jpg` fragment is served as `image/jpeg` despite containing media. These observations support remuxing; they do not prove the remaining episode was downloaded or processed.
- [REA controlled navigation](rea-evidence/download-gap/cinejoy-navigation-rea.json), Evidence `ev_f9600ed55298059d16de1c59a2843d6d98ab43f6ac08016fb1337b28e5337ca4`, has explicit incomplete event coverage. The subsequent bounded page-context reads and installed ffprobe are separate supplemental evidence. No original Download or terms-acceptance action was performed. Sample media stays in ignored research scratch space.

## Capability gap and acceptance evidence

| Capability | Current replacement | Required behavior and proof |
| --- | --- | --- |
| Identify the pictured source | Confirmed HLS, matching duration and qualities | Preserve source identity and detection regressions while adding downloads. |
| Choose video/output | Quality labels only | A real selector chooses 1080p or 720p, a filename is editable, and the output is identified as MP4 while the source remains HLS. |
| Make a download plan | Missing | Resolve the exact selected media playlist, associated audio, initialization, ranges and required segments. Never combine unrelated tab media. |
| Read full media | Only bounded text probes exist | Stream the authorized resources with bounded memory, retries, cancellation and the necessary normal request context. Preserve exact signed URLs. |
| Create MP4 | Missing | Demux/remux compressed H.264 and AAC into a valid seekable file; initialization and fragment handling must be correct. Renaming or naive concatenation is insufficient. |
| Continue outside popup lifetime | Missing | Offscreen/worker processing continues after closing the popup; a service-worker wake reconnects without starting a second job. |
| Show honest progress/state | Missing | Bytes, phase, cancel/retry/error and browser-save state are distinct. No completed badge before browser completion. |
| Save to disk | Missing | Chrome saves the final file with the chosen filename. Verify the actual saved output, not an internal blob or preview. |
| Bound resources and clean up | No media job storage exists | Disk-backed output, bounded packet/chunk queues, quota/disk errors, cancellation and eventual OPFS/object-URL cleanup. |
| Establish useful parity | Finite detection evidence only | A full saved 1080p Cinejoy file with audio, correct duration, seekable playback, independent probing/decoding, and failure/lifecycle controls. Broader direct/DASH/live/site claims need their own results. |

## Recommended implementation

Add a browser-only download subsystem around the existing detector. A service coordinator owns durable job identity; one offscreen host runs a dedicated processing worker. A pinned, independently licensed media library reads selected media and writes MP4 to seekable OPFS storage. Chrome Downloads then saves a file-backed object URL, with completion/interruption tracked before cleanup.

[Browser architecture research](rea-evidence/download-gap/browser-design-options.md) compares three practical engines: Mediabunny, a custom public LibAV/WASM build, and an optional native FFmpeg helper. **Mediabunny 1.62.1** is the proposed clear-HLS/remux candidate for this source; no original code or WASM is reused. Its runtime suitability remains to be proven. The proposed system includes `downloads`, `offscreen`, and `unlimitedStorage`; it needs no native installation or WASM CSP relaxation on this path.

The full reviewable [design](superpowers/specs/2026-10-23-browser-downloads-design.md) defines the new files, interfaces, lifecycle, fetch/packet bounds, product controls, and final-file gates. The user approved it on 2026-10-23. Implementation is in progress; research documents are not an implemented or passing download feature.

## Important distinctions and unresolved evidence

- A manifest is the detected **source protocol**. MP4 is the planned **output container**. Both should be clear in the product.
- The first segment supports stream-copy compatibility. Codec changes, timestamp behavior, full resource accessibility and the final 53-minute file remain unverified until implementation and a full run.
- The known page-context manifest path obeys ordinary CORS. Downloading hundreds of binary objects needs a separate bounded transport; weakening the 2 MiB detection endpoint is not a download architecture.
- A page-dependent transport may fail after its originating document closes. Successful popup closure and actual service-worker restart must be tested separately from page closure. Any page-closure limit must be reported truthfully until an independent context strategy is established.
- Original ordinary AES-128 HLS handling, live capture, subtitles, previews, audio extraction, broader DASH layouts and site adapters exceed this clear Cinejoy file's demonstrated path. They remain explicit parity gaps, rather than features proven by one successful MP4.
- There is no YouTube runtime claim in this investigation; the user selected the Cinejoy example. DRM circumvention is outside the proposed implementation.

## Evidence quality

Connected REA's worker/factory parent is `ev_53fcfe51f6751e07dc5c975b05ea53370cbc2662b122d9928579725adec15b51`. Its [summary](rea-evidence/download-gap/rea-worker-summary.json) and [factory feature trace](rea-evidence/download-gap/rea-factory-feature-trace.json) preserve source selection, semantic ceilings, incomplete graph coverage and unresolved dynamic relationships. Direct file inspection supplies Chrome-specific message and API references. Static reachability is not runtime download proof.

Public primary sources informing the proposed implementation are linked in the architecture research, including [Chrome offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen), [Chrome Downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads), [Chrome JSON messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#serialization), and [Mediabunny HLS](https://mediabunny.dev/guide/reading-hls), [packet IO](https://mediabunny.dev/guide/media-sources) and [stream output](https://mediabunny.dev/guide/writing-media-files). Those APIs describe possible components; they do not establish that our unimplemented integration works.
