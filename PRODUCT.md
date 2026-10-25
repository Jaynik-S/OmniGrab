# OmniGrab

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Everyday Chrome users finding and downloading videos. Confirmed by the user on 2026-10-25.

## Product Purpose

Find media on the active browser tab, identify available qualities, and save supported sources with their original video and audio.

## Operating Context

A desktop Chrome extension popup. Users open a page, start playback if necessary, open OmniGrab, select a detected source and quality, and download. Progress and download history remain available when reopening the popup.

## Capabilities and Constraints

- Existing implementation: Chrome Manifest V3, minimum Chrome 120, TypeScript and local bundled assets.
- Detection distinguishes direct media, HLS, DASH, local blobs and unconfirmed evidence.
- Current MP4 downloads support confirmed, unprotected HLS VOD; do not imply that every detected source can be downloaded.
- Preserve quality selection, filename editing, copy-source actions, progress, cancel, retry, error reporting and diagnostic evidence.
- Preserve the download engine, permissions, security boundaries and durable job behavior during this rebrand.
- Give everyday download tasks priority; technical evidence remains available through details.

## Brand Commitments

- Product name: OmniGrab, as requested by the user.
- User-provided logo reference: `omnigrap-logo.png` in the project root. Preserve the supplied original asset.
- Styling must align with this logo; the rebrand replaces the existing lab identity.

## Evidence on Hand

The working popup, source and tests describe current capabilities. `docs/REA_ANALYSIS.md` records original-extension research; `docs/DOWNLOAD_SPEED_INVESTIGATION.md` records verified implementation performance and limitations. Do not invent universal support, speed or compatibility claims.

## Product Principles

- Make supported video downloads easy to find and act on.
- Keep quality, output and download state understandable.
- Preserve access to evidence without making diagnostics the main task.
- Use truthful capability and error messages.
