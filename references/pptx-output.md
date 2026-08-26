# PPTX Output

Build PPTX only when the user selects PPTX. Preserve parity with the approved HTML output and shared deck model: the same slide IDs, order, titles, core messages, source references, and approved content.

Keep text editable as text, shapes editable as shapes, and charts editable with native chart APIs where applicable. Do not rasterize an entire slide. Use an editable wide layout and keep locally sourced images and fonts available to the exported file. Each of the six primary styles uses its own PPTX composition adapter, not only different colors and fonts.

When `secondaryStyleId` is present, require at least one `secondaryOverrides` entry. Support only `chart-treatment` and `section-divider`; reject missing, unknown, duplicate, global-layout, typography, or background overrides before output. A primary style without a secondary style remains valid.

Create `speaker-notes.md` only when the user selects notes. Do not put notes in PPTX speaker-note fields unless the user explicitly requests that exception. Render the final PPTX to images and inspect every page before delivery. Run `scripts/inspect-rendered-pages.mjs` over every rendered PNG so dimensions, color variation, and non-background pixel content are checked in addition to page count.
