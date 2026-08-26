# HTML Output

Build HTML only when the user selects HTML. Deliver one offline, editable HTML file with local fonts and assets embedded; do not depend on network requests. Use a stable 1280×720 stage, preserve approved slide IDs and order, and provide keyboard, touch, fullscreen, scaling, and hash navigation.

Keep HTML and PPTX semantically aligned with the approved deck model: the same slide IDs, order, titles, screen text, source references, and approved content. In a dual-format project, mark each slide with `data-slide-type`, mark its one title with both `data-deck-title` and `data-deck-text`, mark every other model-owned screen string with `data-deck-text`, and mark each source with `data-source-ref`. Mark permitted format-specific labels with `data-decorative`. Run `scripts/verify-deck-parity.mjs`; any untracked text or mismatch blocks both outputs. `build-single-html.mjs` runs the same check automatically for projects whose selected outputs contain both HTML and PPTX.

Preserve HTML editability with real text, CSS, and local assets rather than flattened slide images. Render screenshots only inside a declared project scope. The screenshot manifest owns only files created by the renderer; never delete or overwrite an unowned PNG.

Never embed speaker notes in HTML. Keep notes only in the separate `speaker-notes.md` file when the user selected notes. Reject remote URLs, missing local assets, duplicate slide IDs, and material outside the slide bounds before delivery. Confirmed clipping or truncation of ordinary visible content is delivery-fatal; allow a deliberate media crop only when it is a visual element or explicitly carries `data-allow-clipping`.
