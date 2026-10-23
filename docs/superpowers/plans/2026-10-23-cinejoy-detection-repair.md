# Cinejoy detection repair implementation plan

> **For agentic workers:** Use executing-plans for the shared transport/reducer changes and independent popup implementation. Steps use checkbox syntax and require RED-to-GREEN verification before completion.

**Goal:** Resolve the reported live HLS404 failure and show the same 53:10 stream/qualities as the original.

**Architecture:** Keep the existing serialized state/probe pipeline. Add document-scoped page-context manifest retrieval, one representative child enrichment, controlled retry transitions and primary-versus-diagnostic media presentation.

**Tech Stack:** Existing TypeScript, supported MV3 messaging, fetch/streams, Node tests and Playwright; no new runtime dependency or Chrome permission.

**Spec:** [CINEJOY_DETECTION_FIX.md](../../CINEJOY_DETECTION_FIX.md).

## Global constraints

- No proprietary source copying, DNR/header spoofing, DRM/access bypass, key/segment retrieval or fabricated direct MP4 URL.
- Preserve signed URLs, the 5-second/2-MiB/four-concurrent-probe limits, and navigation/instance/document fences.
- A page transport must obey normal CORS with default same-origin credentials and validate messages and response bounds.
- At most one preferred child is added per master for enrichment; existing observed-child descriptors remain bounded.

## Task 1: Context transport and recovery

Files: `src/background/manifest-probe.ts`, a focused background context transport, `src/content/index.ts`, a bounded content fetch helper, shared response-body helper as needed; new transport tests and probe tests.

- [x] Write failing tests for worker404/page200, same-origin credentials, bounded body/timeout, failed fallback, stale-document refusal and context-response validation.
- [x] Observe the targeted failures before implementing transport injection and background/content messaging.
- [x] Keep worker fetch as the first path; attempt one context fallback within the same deadline. Convert validated response text/final URL into parser input.
- [x] Add explicit requeue on Rescan and fresh positive network evidence; test coalescing, retry exhaustion and stale completions.
- [x] Run targeted tests/typecheck; review and commit the verified behavior.

## Task 2: Representative child enrichment

Files: `src/core/reducer.ts`, model/store validation only if needed, `tests/final-regressions.test.ts`, new focused tests.

- [x] Write a failing master-only fixture with two `.jpg` renditions and a 3189.56-second preferred media playlist.
- [x] Schedule one highest-resolution video rendition, persist it through restart, and merge duration/relationships into the owning master.
- [x] Test child-before-master grouping, failures preserving the confirmed master, no segment/key/subtitle fan-out and independent sources.
- [x] Run targeted and existing neighbor tests; update prior observed-only assumptions to the new explicit one-child contract, then commit.

## Task 3: Honest primary media presentation

Files: `src/popup/view.ts`, new `tests/popup.test.ts`, minimal existing CSS only if required.

- [x] RED tests for title fallback, `53:10`, 1080p/720p, multi-source isolation, blob-only and failed-manifest views, safe text and inspectable URLs.
- [x] Show confirmed remote sources first; keep uncertain observations in a distinct collapsible section without copying blob metadata into unrelated streams.
- [x] Run popup/content neighbor tests, inspect an actual popup, review and commit.

## Task 4: End-to-end incident closure

- [x] Run `npm.cmd run check` and native collector checks.
- [x] Compare the original baseline on the same Cinejoy episode with a final rebuilt ours-only run, retaining independent evidence and actual popup output. The ours-only run excludes assistance from the original's broad DNR rules.
- [x] Verify one HLS source, 1080p/720p, 53:10 duration, no standalone fragments, recovery on Rescan, and real worker restart/navigation behavior.
- [x] Exercise deterministic Origin/CORS failure controls and direct/HLS/DASH/negative neighbors.
- [x] Record exact build identity, remaining limits and new loading/reload instructions; final scoped review and clean commit handoff.

Completion evidence: [final verification index](../../rea-evidence/cinejoy-gap/final-verification.json). Native aborted-frame setup remains explicitly blocked; source/listener regressions are separate evidence. No download engine was added.
