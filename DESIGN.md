---
name: OmniGrab
description: A friendly, logo-led Chrome popup for finding and saving supported videos.
colors:
  canvas: "#f6f6e9"
  surface: "#fffef7"
  header: "#f0f3df"
  sage: "#e8edd9"
  ink: "#34442e"
  muted: "#647258"
  line: "#d6ddc3"
  green: "#405f38"
  green-hover: "#334e2c"
  action-text: "#fffef4"
  field-background: "#fbfcf3"
  field-border: "#829568"
  error: "#8c3e35"
  error-background: "#fbede3"
  progress-value: "#76965c"
  disabled-text: "#6b775f"
  disabled-background: "#e9eddf"
  disabled-border: "#d8dfca"
typography:
  display:
    fontFamily: '"Nunito Sans", "Segoe UI", sans-serif'
    fontSize: "27px"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "-0.04em"
  headline:
    fontFamily: '"Nunito Sans", "Segoe UI", sans-serif'
    fontSize: "20px"
    fontWeight: 800
    lineHeight: 1.4
    letterSpacing: "-0.025em"
  title:
    fontFamily: '"Nunito Sans", "Segoe UI", sans-serif'
    fontSize: "16px"
    fontWeight: 800
    lineHeight: 1.4
    letterSpacing: "-0.015em"
  section:
    fontFamily: '"Nunito Sans", "Segoe UI", sans-serif'
    fontSize: "14px"
    fontWeight: 800
    lineHeight: 1.4
  body:
    fontFamily: '"Nunito Sans", "Segoe UI", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  action:
    fontFamily: '"Nunito Sans", "Segoe UI", sans-serif'
    fontSize: "13px"
    fontWeight: 700
    lineHeight: 1.5
  metadata:
    fontFamily: '"Nunito Sans", "Segoe UI", sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  field:
    fontFamily: '"Nunito Sans", "Segoe UI", sans-serif'
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.5
  label:
    fontFamily: '"Nunito Sans", "Segoe UI", sans-serif'
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.5
  status:
    fontFamily: '"Nunito Sans", "Segoe UI", sans-serif'
    fontSize: "10px"
    fontWeight: 800
    lineHeight: 1.5
rounded:
  sleeve: "16px"
  button: "9px"
  field: "8px"
  chip: "6px"
  skeleton: "5px"
spacing:
  "5": "5px"
  "8": "8px"
  "10": "10px"
  "12": "12px"
  "14": "14px"
  "16": "16px"
  "17": "17px"
  "20": "20px"
components:
  button-primary:
    backgroundColor: "{colors.green}"
    textColor: "{colors.action-text}"
    rounded: "{rounded.button}"
    typography: "{typography.action}"
    padding: "8px 12px"
    width: "100%"
  button-primary-hover:
    backgroundColor: "{colors.green-hover}"
    textColor: "{colors.action-text}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.button}"
    padding: "8px 12px"
  button-copy:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.button}"
    padding: "5px 9px"
  button-recovery:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.button}"
    padding: "5px 10px"
  button-rescan:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.button}"
    padding: "8px 12px"
  button-disabled:
    backgroundColor: "{colors.disabled-background}"
    textColor: "{colors.disabled-text}"
  field:
    backgroundColor: "{colors.field-background}"
    typography: "{typography.field}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "8px 10px"
    width: "100%"
  source-status:
    backgroundColor: "{colors.sage}"
    textColor: "{colors.green}"
    rounded: "{rounded.chip}"
    typography: "{typography.status}"
    padding: "3px 7px"
  media-sleeve:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sleeve}"
    padding: "17px"
  error-message:
    backgroundColor: "{colors.error-background}"
    textColor: "{colors.error}"
    rounded: "{rounded.field}"
    padding: "9px 10px"
---

# Design System: OmniGrab

## Overview

**Creative North Star: "Soft video sleeves"**

OmniGrab uses the supplied mascot's cream, sage and olive world to make a small browser popup feel friendly and practical. Rounded source sleeves hold readable video facts and straightforward controls; a strong green action gives each supported source a clear next step. Density comes from a compact type hierarchy and aligned fields, with enough air to distinguish one source from another.

The brand appears through the original mascot and locally hosted Nunito Sans. Preserve `omnigrap-logo.png` as the supplied source; the bundled icon sizes are mechanical derivatives. Nunito Sans is bundled at `extension/fonts/nunito-sans-latin.woff2`, with its OFL license at `licenses/nunito-sans-OFL.txt`. Flat surfaces, restrained color and quiet state feedback carry the atmosphere without ornamental shadows or entrance choreography.

**Key Characteristics:**
- Cream ground, near-white sleeves and sage supporting surfaces.
- One rounded type family, strong source names and legible labeled states.
- Bordered sleeves, aligned controls and disclosures for technical evidence.

## Colors

The palette follows the supplied logo: warm pale grounds, low-chroma greens and dark olive text. The frontmatter owns the interface colors; sidecar tonal ramps are preview metadata, not extra interface colors.

### Primary
- **Olive action** (`green`): the eligible Download button, focus outline, source-status text and completed phase.
- **Deep olive response** (`green-hover`): the primary button's hover background and border.
- **Warm action lettering** (`action-text`): text on the filled Download button.
- **Leaf progress** (`progress-value`): the filled portion of determinate media-time progress.

### Secondary
- **Clay error** (`error`) and **pale clay ground** (`error-background`): readable failures and recovery guidance. Text carries the meaning alongside color.

### Neutral
- **Cream canvas** (`canvas`): the popup ground.
- **Warm sleeve** (`surface`): source cards and quiet buttons.
- **Pale sage header** (`header`): the compact brand strip.
- **Sage support** (`sage`): status/count chips, feedback surfaces, progress tracks and the static loading line.
- **Olive ink** (`ink`): titles, fields and general text.
- **Muted olive** (`muted`): descriptions, metadata, disclosures and contextual labels.
- **Soft olive line** (`line`): sleeve borders and section dividers.
- **Light field ground** (`field-background`) and **field outline** (`field-border`): editable filename and quality controls.
- **Disabled text, ground and border** (`disabled-text`, `disabled-background`, `disabled-border`): a subdued, explicitly unavailable button state.

### Named Rules
**The Green Action Rule.** Give each eligible source one strong green Download action. Rescan, Copy URL, Cancel and Retry stay quiet outlined controls.

## Typography

**Display Font:** Nunito Sans, with Segoe UI and sans-serif fallbacks.
**Body Font:** Nunito Sans, with the same fallbacks.
**Label/Mono Font:** the same family; technical evidence does not introduce a second voice.

**Character:** Rounded lettering and heavy titles echo the mascot without turning the popup into a decorative display. Weight and size make source names, actions and facts easy to scan.

### Hierarchy
- **Display:** the brand wordmark; use the `display` token. At the narrow breakpoint it reduces to (24px).
- **Headline:** the empty-state heading; use `headline`.
- **Title:** source names; use `title`. Download filenames reduce to (13px), retaining weight (800), line-height (1.4) and title tracking.
- **Section:** Videos found and Downloads; use `section`.
- **Body:** general copy; use `body`. The Download button uses the matching `action` role at weight (700).
- **Metadata:** descriptions and source facts; use `metadata`. Quality summaries and disclosures use weight (700); job-phase labels use (800). Numeric source facts and job metadata use tabular figures.
- **Label:** filename and quality labels; use `label`. Current-tab context and expanded evidence also use the small scale; context titles use (12px), weight (600), with ellipsis.
- **Status:** compact source-protocol/status badges; use `status`. The footer shares the small (10px) size at line-height (1.6).

### Named Rules
**The Shared Voice Rule.** Use the bundled Nunito Sans for brand, controls, metadata and evidence; hierarchy comes from the observed size and weight changes.

## Layout

The popup is a single vertical flow, sized to (440px), capped at (100vw), with a (320px) minimum. Main content has (20px) horizontal gutters. The header uses (17px 20px) padding and a (12px) gap; the mascot is (52px) square. Current-tab context is a compact baseline row with a bottom divider; title and host truncate independently.

Source sleeves use (17px) padding, a (14px) bottom margin and a title/status row separated by (12px). Download fields form two columns: flexible filename plus (96px) quality, separated by (10px). Output guidance, unavailable explanations, errors and the full-width Download button span both columns. Labels sit (5px) above their fields. Source titles and errors wrap rather than forcing horizontal overflow.

At (380px) and below, main/header gutters become (16px), the header's vertical padding becomes (14px), sleeve padding becomes (14px), the brand gap becomes (5px), and the mascot becomes (44px) square. The source row stacks the status above the title with an (8px) gap. The quality column narrows to (87px); controls remain side by side. This is a narrow-popup adaptation, not a separate mobile-navigation system.

The recurring spacing vocabulary is recorded in frontmatter. Vertical section gaps vary with purpose: the Downloads section starts after (21px), diagnostics after (18px), and the footer after (19px). The empty state centers its (120px) mascot and limits guidance to (290px).

## Elevation & Depth

The system is flat: there are no box shadows. Cream, warm white and sage distinguish levels; thin borders and dividers establish grouping. Focus uses an olive (2px) outline offset by (3px), a state cue rather than a shadow. Source details have a lighter top divider, while download history remains on the canvas with bottom rules.

### Named Rules
**The Flat Sleeve Rule.** Build depth with the existing grounds, borders and spacing. Keep sleeves and controls free of decorative elevation.

## Shapes

Large source containers use the `sleeve` radius. Buttons are gently rounded with `button`; fields, errors and clipped progress bars use `field`; source-status and count chips use `chip`. The count badge is (22px) high with a matching minimum width. The loading line uses the smaller `skeleton` radius. Borders are (1px); silhouettes stay soft and compact rather than fully pill-shaped.

## Components

### Buttons
Direct, legible and quietly tactile.
- **Primary:** full-width olive Download button, weight (700), minimum height (42px), using `button-primary`. Hover uses `button-primary-hover`; press deepens to (#293f24).
- **Secondary:** warm-white outlined controls using `button-secondary`, minimum height (36px), weight (700), and a (7px) internal gap. Hover changes the ground to sage and border to (#a6b893); press uses (#dce5c9).
- **Rescan:** a transparent outlined button with a true inline SVG refresh icon (16px); its text is (12px). Its border is (#cbd7b5), with hover ground (#e0e8cc) and border (#a9ba91). Narrow padding becomes (7px 9px).
- **Compact actions:** Copy URL uses (5px 9px) padding; Cancel and Retry use `button-recovery`. All have (30px) minimum height and (11px) text.
- **Disabled:** the shared subdued button palette, a default cursor and truthful action text. Rescan retains its transparent ground and own outline. Pending, accepted and renewable download intents use Starting…, Download started and Download again labels as appropriate.
- **Feedback:** background, border and text colors transition for (160ms ease-out). Focus keeps the shared visible outline. Reduced-motion preference removes transitions and animations.

### Chips
Small functional facts, not decorative headings.
- **Source status:** `source-status` pairs the protocol with a readable status word; it does not rely on green alone.
- **Source count:** sage ground, ink text, (11px) type and (0 6px) horizontal padding. It accompanies the Videos found heading rather than acting as a navigation filter.

### Cards / Containers
A sleeve gathers one source and its action.
- **Shape and ground:** `media-sleeve`, a thin soft-olive border and no shadow.
- **Contents:** wrapping source title, protocol/status, metadata, available qualities, supported controls and a Source details disclosure.
- **Narrow state:** reduced padding and stacked source-status/title, as defined in Layout.
- **Unavailable state:** readable explanation replaces filename/quality/download controls when the source is unsupported; preserve the source evidence.

### Inputs / Fields
Light editable surfaces with clear boundaries.
- **Shared:** `field`, minimum height (38px), text (12px), and a (1px) field-outline border. Field text inherits label weight (700); labels use the small bold muted scale.
- **Hover:** outline darkens to (#6e8356).
- **Focus:** ground becomes (#fffef9), border becomes olive, and keyboard focus receives the common outline.
- **Quality select:** native select with available rendition labels. A disabled select uses muted text, ground (#eef1e4) and default cursor.
- **Errors:** pale-clay message blocks appear with text; empty error and unavailable regions are hidden. An unavailable selected quality is explained and disables the Download action.

### Disclosures
Technical detail stays available through native disclosure controls.
- **Summary:** fit-content, (8px 0) padding, muted (12px) bold text, turning olive on hover; native triangle and keyboard behavior remain.
- **Grouping:** Source details sits beneath a light divider; Diagnostics has its own section divider. Local and unconfirmed evidence is grouped separately and may open when it is the primary unresolved outcome.
- **Persistence:** open disclosures, focused controls, text selection and page scroll survive snapshot redraws. Download-details identity belongs to its immutable job.
- **Evidence:** raw URLs, internal identifiers, byte counters and structured failure codes live inside the relevant details.

### Download history and progress
Quiet rows show what happened to each named file.
- **Row:** no nested sleeve; (13px 0) padding and a soft-olive bottom border. Filename is bold (13px); source relationship and actual quality use (11px) muted text.
- **Phase:** readable (12px) bold labels remain visible. Completion colors the phase olive and includes the browser-save confirmation.
- **Progress:** a determinate native bar appears when duration and processed media time are known. It is (7px) high with sage track and leaf-green fill, clipped to the field radius. No invented percentage or animated indeterminate treatment is added.
- **Recovery:** errors and Cancel/Retry remain outside Download details. Raw telemetry stays inside that disclosure.

### Empty and loading states
The supplied mascot provides reassurance without a new illustration system.
- **Empty:** centered original mascot derivative, a bold headline and brief playback/Rescan guidance.
- **Loading:** one static sage line (65% width, 11px height) and readable loading text. There is no shimmer or page-load choreography.

## Do's and Don'ts

### Do:
- **Do** preserve the supplied mascot and the local Nunito Sans font with its shipped license.
- **Do** keep one strong green Download action per eligible source and use quiet outlined supporting actions.
- **Do** pair status colors with readable labels, and preserve visible errors, progress and recovery actions.
- **Do** use the narrow-popup rules to keep long titles and download controls within the viewport.
- **Do** keep source evidence and raw job telemetry available in their native disclosures.

### Don't:
- **Don't** replace the supplied logo with a generated mascot or a glyph substitute.
- **Don't** add decorative shadows, gradients or entrance choreography to the flat sleeve system.
- **Don't** promote internal IDs, raw byte counters or structured failure codes into the main download-history reading order.
- **Don't** add a distinct display or monospace family to create hierarchy the existing type ramp already supplies.
