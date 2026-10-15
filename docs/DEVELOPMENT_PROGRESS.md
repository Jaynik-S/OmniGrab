# Detection engine development evidence

Branch: `feat/detection-engine`; research baseline: `f833ce9`.

The goal's Phase 3 authorizes the original implementation. Work follows [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). The user's `rea-video-capture.json` remains untouched and excluded from the bundle and Git.

- Task 1: behavioral tests first failed because the core modules were absent. Implemented URL identity, classification and immutable document-scoped state transitions; targeted core tests subsequently passed 9/9. Initial TypeScript check exposed a computed-key inference issue; corrected with the explicit snapshot map type. Task review pending.
- Task 2: parser worker reports red-to-green fixture development, bounded HLS/MPD parsing, 20 retained variants with explicit omitted count, and focused 10/10 passing tests. Review pending.
- Task 4: collector/UI worker reports red-to-green tests for DOM, resource timing, dynamic and shadow elements, alternative-source metadata and safe popup rendering; focused 9/9 passing. Review pending.
- Ruling: continue in the authorized current workspace on a feature branch. No separate worktree is needed for the previously empty implementation tree; the cost if wrong is reduced isolation from unrelated local edits.
- Ruling: execute the goal's implementation phase after completed research. The earlier extra design approval checkpoint was withdrawn; the cost if the design needs revision is reversible implementation rework.
- Ruling: preserve up to 20 variants and report truncation rather than rejecting an otherwise valid larger manifest. Explicit child relationships remain separately bounded; the cost is incomplete representation detail for larger manifests.

Runtime follow-up: the user's selected capture identifies `https://cinejoy.pk/watch/tv/67178/2/2`; a passive 45-second REA observation was started against the matching existing page. Its result is not yet assessed here.

Completion still requires browser comparisons, restart/navigation checks, review, artifact verification and descriptive implementation commits. Green fixture tests alone do not demonstrate parity with the original.
