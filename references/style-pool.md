# Style Pool

The style pool contains six original slide systems. Each registry entry points to portable JSON tokens, a semantic HTML theme, and a local 1280x720 preview. A renderer can implement `getStyle(styleId)` by finding the matching entry in `assets/style-pool/registry.json`, loading its `tokens` file, and resolving the adjacent theme path. Unknown IDs must be rejected rather than silently substituted.

## Selection Rules

Choose one primary `styleId` for the full deck. HTML themes and PPTX composition adapters both preserve six visibly distinct systems. A `secondaryStyleId` is optional and may influence only `chart-treatment` or `section-divider`. It must not replace the primary system's typography, spacing rhythm, page geometry, or overall composition. Do not blend several systems across ordinary slides.

All themes implement the twelve slide types in `deck-model-schema.md`: `cover`, `section`, `statement`, `data`, `process`, `comparison`, `case-study`, `timeline`, `matrix`, `image`, `quote`, and `summary`.

## Systems

### Product Narrative

For product stories that need a calm, cinematic sequence. It uses large centered statements, generous negative space, restrained framing, and one dominant visual anchor. Public inspiration comes from modern product-launch editorial pacing and museum display graphics, interpreted as general composition principles rather than a company identity.

### System Monochrome

For operations, infrastructure, and status narratives. It uses a strict grid, hard rules, monospace labels, indexed modules, and explicit dot patterns. Public inspiration comes from open traditions of Swiss grid design, terminal interfaces, and technical manuals.

### Editorial Signal

For market, culture, and strategy stories. It uses asymmetric columns, serif headlines, solid color fields, annotated measures, and data-led page rhythm. Public inspiration comes from newspaper infographics, independent magazines, and public-information posters.

### Technical Atlas

For architecture, engineering, and evidence-heavy explanations. It uses coordinate grids, evidence labels, node-and-link diagrams, compact typography, and structured density. Public inspiration comes from engineering schematics, public transit maps, and scientific instrument panels.

### Creative Primitives

For workshops, concepts, and energetic narrative shifts. It uses modular geometry, bold system type, thick outlines, playful scale changes, and deliberately offset modules. Public inspiration comes from basic geometric art, educational construction kits, and public-domain modernist composition.

### AI Research Journal

For research findings, evaluations, and evidence chains. It uses a warm paper field, restrained serif display, numbered citations, scientific charts, and explicit claim-to-evidence flow. Public inspiration comes from academic journals, laboratory notebooks, and statistical figure conventions.

## License And Asset Boundary

These systems are original implementations and are not copies of named company design systems. They contain no logos, proprietary fonts, remote resources, or unclear-license assets. Generated HTML uses system-safe font stacks only. Shapes, rules, charts, patterns, and diagrams are authored with local HTML and CSS; no gradient-orb or bokeh decoration is used. Any future image added to a deck must follow `research-and-licensing.md` and include its own provenance.
