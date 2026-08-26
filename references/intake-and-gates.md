# Intake And Gates

## Entry Guard

Proceed only after an explicit `/sherry-skillforhtml2026` invocation, the name `sherry-skillforhtml2026`, or an explicit request for Sherry's named slide Skill. Otherwise stop.

## Detect The Entry

| Signal | Entry | First action |
| --- | --- | --- |
| Topic, purpose, or limited background | `topic-start` | Read supplied material and open requirements intake. |
| User calls supplied Markdown confirmed | `confirmed-markdown` | Save it as a candidate `content-source.md` and audit it. |
| User treats Markdown as final and wants to continue later in production | `confirmed-markdown-shortcut` | Preserve the Markdown, silently check blockers, and combine output/notes and style decisions. |
| Existing project directory | `resume-project` | Read `project-status.json` and the newest project files. |
| Existing HTML with a restyle, re-theme, visual upgrade, or new-template request | `html-template-change` | Preserve the narrative and interaction, accept minor copy edits, show style choices, and re-run visual QA. |

## Gate 1: Requirements

Make this table before asking questions:

| Known | Missing | Conflicting |
| --- | --- | --- |
| Facts found in supplied files | Information needed to meet the stop condition | Claims or instructions that disagree |

Batch factual questions about dates, duration, setting, files, and audience size. Isolate one directional decision at a time, such as takeaway, audience understanding, or content boundary. Never repeat file-derived facts. Briefly restate new conclusions before the next question.

Stop intake only when all fields are clear enough to approve: new or existing project; project name and save path; topic; purpose; audience; setting; duration or expected information volume; takeaway; must-include content; must-exclude content; supplied sources and their trust; sensitivity; deadline; and visual constraints. Record any non-blocking uncertainty as an explicit assumption for approval. For a new project with no location, propose a local Desktop path such as `<desktop>/<project-slug>-slides-<YYYYMMDD>` and show the final path before creating it.

Create `requirements.md`, then ask for approval of the current gate. Interpret the reply in context rather than requiring one exact string. Clear replies such as `通过`, `没问题`, `可以`, `好的`, `确认`, `继续`, `往下走`, `确认开始制作`, `这一页过了`, `第一页没问题`, `下一阶段`, or `下一章` count when they directly answer the confirmation request. A reply containing a requested change never counts as approval; `看起来可以`, `大概没问题`, `先看看`, questions, and other uncertain language require clarification. After recognizing approval, record only the current gate; never accept a user-supplied list of future approved gates.

## Gate 2: Research Decision

Before creating or approving `content-source.md`, inspect whether the material would benefit from current facts, industry context, public cases, evidence, fact checking, or requested visual references. Ask one concise choice: `需要网络调研，帮我完善内容`、`只查证事实，不扩展内容`，或 `不需要调研，直接基于现有素材`。 If research is selected, search authoritative or clearly open sources, summarize only material findings into `content-source.md`, and record every adopted fact or asset in `materials/source-manifest.md`. If fact checking is selected, verify or qualify existing claims without adding a new argument. If no research is selected, do not browse for content expansion and record the decision in the project requirements or source manifest. Ask for approval of the research decision before running research; ask for content approval only after research results have been incorporated.

## Confirmed Markdown Audit

For `confirmed-markdown`, inspect purpose, audience, setting, chapter logic, repeated or missing content, claims and data needing verification, required inclusions and exclusions, mixed facts versus proposals, sensitive material, separation of screen content and notes, and the closing takeaway. Present these three groups before Gate 1 and Gate 2 are approved:

1. **Keep**: content that can remain unchanged.
2. **Must-confirm**: items that block production.
3. **Optional-improvement**: non-required improvements.

For confirmed Markdown, file-derived information satisfies applicable Gate 1 fields. After the audit, ask only about material, production-blocking gaps. When file-derived context is sufficient, do not require every intake field to be completed.

For `confirmed-markdown-shortcut`, infer semantic intent instead of matching an exact sentence. Treat statements such as `MD 已经定了`, `内容不用再改`, `按现有内容往后做`, `从风格/大纲开始`, or `这是最终版，帮我做成 PPT` as equivalent when the surrounding request is clear. Do not reopen a full requirements interview, rewrite the Markdown, or ask whether the already-finalized content should remain unchanged. Copy or reference it as the complete material library and silently check production blockers. If there is no blocker, combine output format, speaker-notes, and visual style into one decision round. Ask one short clarification only when the user's wording is genuinely uncertain.

For `html-template-change`, infer semantic intent from requests such as `换模板`, `换风格`, `换皮`, `套一版科技模板`, or `视觉升级`; the user does not need to say `只更换模板`. Treat the existing HTML as the current content source. First check that it opens, has the expected slide count, contains no broken local assets or overflow, and identify whether its styles are centralized or embedded. Show the available styles; choosing one is the style approval, without a second confirmation. Preserve meaning, slide order, cases, images, and interaction by default while allowing layout fitting and requested minor copy edits. Do not repeat requirements, content, outline, or chapter confirmations. Switch back to the earliest affected normal gate only when the user asks to add or remove slides, restructure chapters, or rewrite core content.

Do not treat the user's claim that Markdown is confirmed as permission to skip this audit. Do not rewrite content the user explicitly requires to remain unchanged.

## Gates And Approval

Use this exact order:

1. `requirements`: approve `requirements.md` explicitly.
2. `research-decision`: choose and approve the research mode explicitly.
3. `content`: approve the complete `content-source.md` explicitly.
4. `format-notes`: choose HTML, PPTX, or both, decide whether to create `speaker-notes.md`, and approve the selection explicitly.
5. `style`: approve one primary visual system explicitly.
6. `outline`: approve `outline.md` explicitly.
7. `samples`: approve the cover and the most information-dense representative slide explicitly.
8. `chapters`: approve each natural chapter or requested batch explicitly.
9. `final`: approve the checked final artifacts explicitly.

Record approvals as one contiguous prefix in `project-status.json`. Approve the current gate before every forward transition. Fast mode never changes this rule. Maintenance shortcuts inherit already-settled decisions and record that inheritance; they are not fast-mode gate skipping.

At Gate 3, ask for the output selection again for every new project; never carry it over from an earlier project. Create `speaker-notes.md` only when the user selects notes. Do not assume interviews; interviews are optional input only.

## Chapters, Fast Mode, And Recovery

Split work by natural chapter, never a mechanical page count. For a chapter of five slides or fewer, produce and review the full chapter. For a chapter over five slides, ask exactly: `整章生成还是先生成 5 页？` Ask in English when needed: `Generate the whole chapter or the first five slides?` If the user chooses the whole chapter, still provide a contact sheet and a screenshot for every slide. If the user chooses the first five slides, wait for approval before continuing the chapter.

Enable fast mode only on an explicit user request. Fast mode may combine question rounds, generate multiple chapters after outline approval, and reduce intermediate screenshot rounds. Fast mode must not skip any gate or any explicit confirmation.

For `resume-project`, first rehash the latest requirements, content, outline, notes, chapter sources, style overrides, sample assets, and generated outputs before reporting the current gate. When approved material changes, automatically reopen the earliest affected gate, remove that approval and every dependent approval, and append the event to `revisionLog`. Use `revisedArtifacts` for supported external changes that are not represented by a tracked file field. Never approve a revised gate in the same state update that reopens it.
