# QA Checklist

Before approving samples, a chapter, or final output, complete the checks below.

## Samples And Chapters

- Render the cover and the densest representative sample at 1280×720.
- Render every chapter slide to an individual screenshot and make a contact sheet in stable slide order.
- Check clipping, overlap, overflow, contrast, illegible text, broken assets, blank slides, inconsistent alignment, and incorrect source use. Confirmed ordinary-content clipping is delivery-fatal; intentional visual crops require an explicit clipping marker.
- Compare slide IDs, order, screen text, and source references with the approved `outline.md` and `content-source.md`.
- For a revised approved slide, check adjacent transitions and numbering, then reopen every affected gate.

## Final Artifacts

- Verify the final HTML opens offline, has embedded assets, contains no remote URL, and never embeds speaker notes in HTML.
- Verify the final PPTX opens, preserves editable text, shapes, and charts, and has been render-checked page by page.
- Verify selected HTML/PPTX outputs have parity with `scripts/verify-deck-parity.mjs`; do not create an unselected output.
- Verify HTML screenshot diagnostics contain no clipping, overflow, blank pages, or image failures. Verify the screenshot manifest lists only tool-owned PNGs.
- Verify PPTX page PNGs with `scripts/inspect-rendered-pages.mjs`; page count and a nonempty contact sheet alone are insufficient.
- Verify `speaker-notes.md` exists only when the user selected notes and remains separate from HTML.
- Verify screen text, HTML, PPTX, speaker-notes.md, manifests, and final delivery never contain placeholders or unfinished markers. Do not create, approve, or deliver an artifact until it passes this check.
- Reopen exported artifacts and compare slide count, order, and notes coverage with approved content and outline.
- Report output paths, validation results, source manifest status, and any approved exceptions. Wait for final `通过` before closing the project.
