import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");
const references = [
  "references/intake-and-gates.md",
  "references/research-and-licensing.md",
  "references/content-and-outline.md",
  "references/html-output.md",
  "references/pptx-output.md",
  "references/deck-model-schema.md",
  "references/qa-checklist.md",
];

test("workflow documents provide the required gated production contract", () => {
  const skill = read("SKILL.md");
  const allText = [skill, ...references.map(read)].join("\n");
  const required = [
    "topic-start",
    "confirmed-markdown",
    "confirmed-markdown-shortcut",
    "html-template-change",
    "resume-project",
    "requirements.md",
    "content-source.md",
    "speaker-notes.md",
    "whole chapter or the first five slides",
    "project-status.json",
    "1280×720",
    "allow_implicit_invocation",
  ];

  for (const value of required) assert.ok(allText.includes(value), `missing ${value}`);
  assert.ok(skill.split("\n").length < 500);
  for (const marker of ["TO" + "DO", "TB" + "D", "待" + "定", "待" + "补"]) {
    assert.ok(!allText.includes(marker));
  }
  assert.match(allText, /do not assume interviews/i);
  assert.match(allText, /never embed speaker notes in HTML/i);
  assert.match(allText, /lightweight blocker audit|轻量.*审计/i);
  assert.match(allText, /template change|更换视觉模板/i);
});

test("workflow documents keep finalized Markdown and template-only HTML changes lightweight", () => {
  const skill = read("SKILL.md");
  const intake = read("references/intake-and-gates.md");
  const combined = `${skill}\n${intake}`;
  assert.match(combined, /do not reopen a full requirements interview/i);
  assert.match(combined, /do not[^.]*rewrite (?:the )?(?:Markdown|source)/i);
  assert.match(combined, /preserve[^.]*?(?:content|narrative|meaning)[^.]*interaction/i);
  assert.match(combined, /Do not repeat requirements, content, outline, or chapter confirmations/i);
  assert.match(combined, /infer.*intent|semantic intent|按.*意图/i);
  assert.match(combined, /do not ask.*confirm|不再.*确认|without.*second confirmation/i);
  assert.match(combined, /minor copy|少量文案/i);
  assert.match(combined, /add.*remove.*slides|增删页面/i);
  assert.match(combined, /restructure.*chapter|调整章节|章节结构/i);
  assert.match(combined, /rewrit(?:e|ing)[^.]*core content|重写核心内容/i);
  assert.match(combined, /inherited confirmation|继承.*确认/i);
});

test("confirmed Markdown asks only material production-blocking gaps", () => {
  const intake = read("references/intake-and-gates.md");
  assert.match(
    intake,
    /After the audit, ask only about material, production-blocking gaps\./i,
  );
  assert.match(
    intake,
    /When file-derived context is sufficient, do not require every intake field to be completed\./i,
  );
});

test("generated artifacts prohibit placeholders and unfinished markers", () => {
  const qa = read("references/qa-checklist.md");
  assert.match(
    qa,
    /screen text, HTML, PPTX, speaker-notes\.md, manifests, and final delivery never contain placeholders or unfinished markers/i,
  );
});

test("workflow documents define contextual approval intent and forbid fast-mode gate bypass", () => {
  const skill = read("SKILL.md");
  const intake = read("references/intake-and-gates.md");
  const combined = `${skill}\n${intake}`;
  for (const phrase of ["通过", "没问题", "下一阶段", "下一章"]) {
    assert.ok(combined.includes(phrase), `missing approval phrase ${phrase}`);
  }
  assert.match(combined, /in context|上下文|directly answer|直接回答/i);
  assert.match(combined, /requested change|修改要求|不.*通过/i);
  assert.match(combined, /fast mode[^.]*must not skip[^.]*gate|快速模式[^。]*不得跳过[^。]*关卡/i);
  assert.match(combined, /revisionLog|artifactHashes|automatic(?:ally)? reopen/i);
});

test("output documents require executable parity and delivery-fatal clipping checks", () => {
  const output = [
    read("references/html-output.md"),
    read("references/pptx-output.md"),
    read("references/deck-model-schema.md"),
    read("references/qa-checklist.md"),
  ].join("\n");
  assert.match(output, /verify-deck-parity\.mjs/);
  assert.match(output, /data-deck-text/);
  assert.match(output, /clipping[^.]*fatal|fatal[^.]*clipping/i);
  assert.match(output, /inspect-rendered-pages\.mjs/);
  assert.match(output, /chart-treatment/);
  assert.match(output, /section-divider/);
});
