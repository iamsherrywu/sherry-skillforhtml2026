---
name: sherry-skillforhtml2026
description: Use when the user explicitly invokes /sherry-skillforhtml2026, names sherry-skillforhtml2026, or explicitly asks for Sherry's named slide Skill to create or continue an HTML/PPTX slide project; never use for generic presentation requests.
---

# Sherry 幻灯片工作流

## Explicit Entry Check

Use this Skill only when the user explicitly invokes `/sherry-skillforhtml2026`, names `sherry-skillforhtml2026`, or explicitly asks for Sherry's named slide Skill. For generic slide or presentation requests where the Skill was not named, stop and do not continue. Keep `allow_implicit_invocation: false` in `agents/openai.yaml`.

## Entry Modes

- **topic-start**: Read available material, collect missing requirements, and wait for Gate 1 approval before creating content.
- **confirmed-markdown**: Treat confirmed Markdown as a candidate `content-source.md`; audit it, surface only production blockers, and do not generate slides directly.
- **confirmed-markdown-shortcut**: Infer this intent when the user treats the supplied Markdown as final and asks to continue from a later production step. Preserve the text, run a lightweight blocker audit, and move directly to output/notes and style decisions.
- **html-template-change**: Infer this intent when the user wants an existing HTML deck restyled, re-themed, visually upgraded, or fitted to another template while preserving its narrative. Validate the current HTML and assets, then change the visual layer plus any requested minor copy edits.
- **resume-project**: Read `project-status.json` and the latest files, then resume from the recorded gate.

## Maintenance Pressure-Test

Use `scripts/route-workflow.mjs` only as a gate-aware maintenance pressure-test for the written contract. Never use it to advance a real project, approve a gate, or replace reading `project-status.json` and the referenced workflow instructions. It derives invocation from request text, rejects unknown styles, and reports the earliest missing approval before testing a late action.

## Core Workflow

Follow the gate order: requirements, research decision, content, format-notes, style, outline, samples, chapters, final. Interpret the user's reply in context: clear approval such as `可以`, `好的`, `确认`, `继续`, `往下走`, `确认开始制作`, `这一页过了`, `第一页没问题`, `通过`, `没问题`, `下一阶段`, or `下一章` approves the current gate when it directly answers a confirmation request. A message that also requests changes is not approval; uncertain praise such as `看起来可以`, `大概没问题`, or `先看看` requires clarification. Canonicalize a recognized approval to the current gate only; do not write arbitrary future approvals. Do not assume interviews; use interview material only when the user supplies it or requests interview analysis. Do not start production before the current gate is approved.

After requirements intake, inspect whether the supplied material has important evidence gaps, current facts, industry context, public cases, or visual references that would materially improve the deck. Ask the user to choose one research mode: `需要网络调研，帮我完善内容`, `只查证事实，不扩展内容`, or `不需要调研，直接基于现有素材`. In research mode, collect authoritative or clearly open sources, record their URLs, retrieval dates, organizations, license status, and intended use, then add the useful findings to `content-source.md` before asking for content approval. In fact-check mode, correct or annotate claims without expanding the argument. In no-research mode, proceed with the supplied material and record that external research was declined. Never silently add researched claims to slides.

Use fast mode only when the user explicitly requests it. Fast mode may reduce rounds and increase batch size, but it must not skip any approval gate. When approved requirements, content, output/notes choices, style, outline, samples, chapters, or notes change, use the project state tool to automatically reopen the earliest affected gate and invalidate dependent approvals.

Infer the two maintenance shortcuts from semantic intent, not an exact phrase. Expressions such as content being finalized, no longer needing edits, continuing from style or outline, changing a theme, restyling, visual upgrading, or applying a new template may all qualify. If the intent is uncertain, ask one short clarifying question; do not demand a trigger phrase.

A finalized Markdown shortcut inherits the user's content confirmation. Do not repeat the full requirements interview, ask for a second content confirmation, or rewrite the source: silently check production blockers, then combine output, speaker-notes, and style decisions into one round. An HTML template change inherits requirements, content, outline, and chapter confirmation. The user's template selection is the style approval, so do not ask for a second confirmation before editing. Preserve slide order, meaning, cases, images, and interaction behavior; allow layout fitting and requested minor copy edits; run HTML validation and screenshots; then ask for one final visual confirmation. Exit the shortcut only for adding or removing slides, restructuring chapters, or rewriting core content, and return to the earliest affected normal gate. These inherited confirmations are maintenance routing, not fast-mode gate skipping.

## References

- Read [intake and gates](references/intake-and-gates.md) when detecting an entry mode, collecting requirements, seeking approval, or resuming work.
- Read [research and licensing](references/research-and-licensing.md) before researching or adopting any external fact or asset.
- Read [content and outline](references/content-and-outline.md) before writing project content, source manifests, or slide outlines.
- Read [HTML output](references/html-output.md) when the selected output includes HTML.
- Read [PPTX output](references/pptx-output.md) when the selected output includes PPTX.
- Read [deck model schema](references/deck-model-schema.md) before mapping an approved outline to either output format.
- Read [QA checklist](references/qa-checklist.md) before showing samples, approving a chapter, or delivering a final artifact.

