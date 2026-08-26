import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createProject } from "../scripts/init-project.mjs";
import { updateStatus } from "../scripts/update-project-status.mjs";
import { inferShortcutEntryMode } from "../scripts/route-workflow.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const node = process.execPath;
const routingScript = path.join(root, "scripts", "route-workflow.mjs");
const physicalTemp = fs.realpathSync(os.tmpdir());
const namedRequest = "Use sherry-skillforhtml2026 for this slide project.";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(physicalTemp, prefix));
}

function runRoute(input, script = routingScript) {
  return spawnSync(node, [script, "--scenario", JSON.stringify(input)], {
    cwd: root,
    encoding: "utf8",
  });
}

function route(input, script) {
  const result = runRoute(input, script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("request text recognizes exactly the three explicit Skill trigger forms", () => {
  for (const requestText of [
    "/sherry-skillforhtml2026 Build a deck about reliable AI.",
    "Please use sherry-skillforhtml2026 for these slides.",
    "Please use Sherry's named slide Skill for this presentation.",
  ]) {
    assert.deepEqual(route({ requestText, entryMode: "topic-start" }), {
      invoked: true,
      action: "requirements-gate",
    });
  }
});

test("generic requests derive non-invocation from text and reject boolean bypasses", () => {
  for (const requestText of [
    "Create a presentation about reliable AI.",
    "Make this Markdown into a slide deck.",
  ]) {
    assert.deepEqual(route({ requestText, entryMode: "topic-start" }), {
      invoked: false,
      action: "do-not-invoke",
    });
  }

  const bypass = runRoute({
    requestText: "Create a generic presentation.",
    explicitInvocation: true,
    entryMode: "topic-start",
  });
  assert.notEqual(bypass.status, 0);
  assert.match(bypass.stderr, /request text|explicitInvocation|unsupported/i);
});

test("shortcut entry modes are inferred from natural intent instead of exact trigger phrases", () => {
  for (const requestText of [
    "Use sherry-skillforhtml2026. 这份 md 已经敲定，直接往后做。",
    "Use sherry-skillforhtml2026. 内容定了，从风格选择开始。",
    "Use sherry-skillforhtml2026. 不用再改文档，按现有内容做幻灯片。",
    "Use sherry-skillforhtml2026. 这是最终版 MD，帮我做成 PPT。",
    "Use sherry-skillforhtml2026. 终稿已经确认，生成 HTML 演示。",
  ]) {
    assert.equal(
      inferShortcutEntryMode({ requestText, suppliedFiles: ["training.md"] }),
      "confirmed-markdown-shortcut",
      requestText,
    );
  }

  for (const requestText of [
    "Use sherry-skillforhtml2026. 这个 HTML 换个模板。",
    "Use sherry-skillforhtml2026. 保留内容，换成科技风。",
    "Use sherry-skillforhtml2026. 页面视觉升级一下，顺便改两处文案。",
    "Use sherry-skillforhtml2026. 给现有演示换皮。",
  ]) {
    assert.equal(
      inferShortcutEntryMode({ requestText, suppliedFiles: ["deck.html"] }),
      "html-template-change",
      requestText,
    );
  }

  for (const requestText of [
    "Use sherry-skillforhtml2026. 这份 md 大概可以，先看看。",
    "Use sherry-skillforhtml2026. HTML 需要增删页面并重写核心内容。",
  ]) {
    assert.equal(inferShortcutEntryMode({ requestText, suppliedFiles: ["deck.html", "draft.md"] }), null);
  }
});

test("the eight approved scenarios resolve through gated maintenance pressure tests", (t) => {
  const projectRoot = makeTempDir("sherry-route-project-");
  const created = createProject({
    root: projectRoot,
    name: "Resume Contract",
    entryMode: "resume-project",
    outputs: ["html"],
    speakerNotes: false,
  });
  updateStatus(created.projectDir, { approvedGate: "requirements", currentGate: "content" });
  updateStatus(created.projectDir, { approvedGate: "content", currentGate: "format-notes" });
  updateStatus(created.projectDir, { approvedGate: "format-notes", currentGate: "style" });
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const scenarios = [
    {
      name: "topic-start",
      input: { requestText: namedRequest, entryMode: "topic-start" },
      expected: { invoked: true, action: "requirements-gate" },
    },
    {
      name: "confirmed-markdown",
      input: { requestText: namedRequest, entryMode: "confirmed-markdown" },
      expected: { invoked: true, action: "self-audit-then-requirements-and-content-gates" },
    },
    {
      name: "confirmed Markdown shortcut",
      input: { requestText: namedRequest, entryMode: "confirmed-markdown-shortcut" },
      expected: {
        invoked: true,
        action: "lightweight-markdown-audit-then-format-and-style",
        skippedGates: ["requirements", "content"],
        confirmationPolicy: "do-not-reconfirm-finalized-markdown",
      },
    },
    {
      name: "HTML template-only shortcut",
      input: { requestText: namedRequest, entryMode: "html-template-change" },
      expected: {
        invoked: true,
        action: "validate-existing-html-then-template-change",
        skippedGates: ["requirements", "content", "outline", "chapters"],
        confirmationPolicy: "template-selection-is-approval",
        allowedChanges: ["visual-layer", "layout-fit", "minor-copy-edits"],
      },
    },
    {
      name: "seven-slide chapter",
      input: {
        requestText: namedRequest,
        approvedGates: ["requirements", "content", "format-notes", "style", "outline", "samples"],
        chapterSlideCount: 7,
      },
      expected: {
        invoked: true,
        action: "ask-whole-chapter-or-first-five",
        question: "Generate the whole chapter or the first five slides?",
        choices: ["whole chapter", "first five"],
      },
    },
    {
      name: "HTML, PPTX, and notes",
      input: {
        requestText: namedRequest,
        approvedGates: ["requirements", "content"],
        outputs: ["html", "pptx"],
        speakerNotes: true,
      },
      expected: {
        invoked: true,
        action: "two-outputs-plus-separate-speaker-notes",
        outputs: ["html", "pptx"],
        speakerNotes: true,
      },
    },
    {
      name: "primary and secondary style",
      input: {
        requestText: namedRequest,
        approvedGates: ["requirements", "content", "format-notes"],
        primaryStyleId: "product-narrative",
        secondaryStyleId: "insight-editorial",
        secondaryOverrides: ["chart-treatment", "section-divider"],
      },
      expected: {
        invoked: true,
        action: "one-primary-with-limited-override",
        styleDecision: {
          primaryStyleId: "product-narrative",
          secondaryStyleId: "insight-editorial",
          secondaryOverrideAllowlist: ["chart-treatment", "section-divider"],
        },
      },
    },
    {
      name: "unclear image license",
      input: {
        requestText: namedRequest,
        approvedGates: ["requirements"],
        assetLicenseStatus: "unclear",
        sourceManifestFile: path.join(created.projectDir, "materials", "source-manifest.md"),
        asset: {
          name: "Unclear fixture asset",
          source: "https://example.invalid/fixture.png",
          retrievedAt: "2026-08-02",
          author: "Unknown",
          slideUsage: "Rejected fixture candidate",
        },
      },
      expected: { invoked: true, action: "reject-asset-and-record-unadopted" },
    },
    {
      name: "resume project",
      input: { requestText: namedRequest, entryMode: "resume-project", projectDir: created.projectDir },
      expected: {
        invoked: true,
        action: "read-project-status",
        currentGate: "content",
        approvedGates: ["requirements"],
        nextRequiredGate: "content",
      },
    },
    {
      name: "unnamed generic request",
      input: { requestText: "Create an executive slide deck.", entryMode: "topic-start" },
      expected: { invoked: false, action: "do-not-invoke" },
    },
  ];

  for (const fixture of scenarios) {
    const actual = route(fixture.input);
    assert.deepEqual(
      Object.fromEntries(Object.keys(fixture.expected).map((key) => [key, actual[key]])),
      fixture.expected,
      fixture.name,
    );
  }
});

test("resume-project revalidates changed chapter sources before reporting status", () => {
  const projectRoot = makeTempDir("sherry-resume-revision-");
  const created = createProject({
    root: projectRoot,
    name: "Resume Revision",
    entryMode: "resume-project",
    outputs: ["html"],
    speakerNotes: false,
  });
  for (const [index, gate] of [
    "requirements", "content", "format-notes", "style", "outline", "samples", "chapters",
  ].entries()) {
    updateStatus(created.projectDir, {
      approvedGate: gate,
      currentGate: ["content", "format-notes", "style", "outline", "samples", "chapters", "final"][index],
    });
  }
  updateStatus(created.projectDir, { approvedGate: "final" });
  fs.mkdirSync(path.join(created.projectDir, "slides"), { recursive: true });
  fs.writeFileSync(path.join(created.projectDir, "slides", "chapter-01.html"), "changed\n", "utf8");

  const result = route({
    requestText: namedRequest,
    entryMode: "resume-project",
    projectDir: created.projectDir,
  });

  assert.equal(result.currentGate, "chapters");
  assert.equal(result.approvedGates.at(-1), "samples");
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("late maintenance actions return the earliest missing approved gate", () => {
  const cases = [
    {
      input: { chapterSlideCount: 7, approvedGates: [] },
      nextRequiredGate: "requirements",
    },
    {
      input: { chapterSlideCount: 7, approvedGates: ["requirements", "style"] },
      nextRequiredGate: "content",
    },
    {
      input: { outputs: ["html", "pptx"], speakerNotes: true, approvedGates: ["content", "requirements"] },
      nextRequiredGate: "requirements",
    },
    {
      input: {
        chapterSlideCount: 7,
        approvedGates: ["requirements", "content", "format-notes", "style", "outline"],
      },
      nextRequiredGate: "samples",
    },
    {
      input: { outputs: ["html", "pptx"], speakerNotes: true, approvedGates: ["requirements"] },
      nextRequiredGate: "content",
    },
    {
      input: {
        primaryStyleId: "product-narrative",
        secondaryStyleId: "insight-editorial",
        approvedGates: ["requirements", "content"],
      },
      nextRequiredGate: "format-notes",
    },
    {
      input: { assetLicenseStatus: "unclear", approvedGates: [] },
      nextRequiredGate: "requirements",
    },
  ];

  for (const fixture of cases) {
    const actual = route({ requestText: namedRequest, ...fixture.input });
    assert.deepEqual(actual, {
      invoked: true,
      action: "next-required-gate",
      nextRequiredGate: fixture.nextRequiredGate,
    });
  }
});

test("style maintenance pressure tests reject IDs outside the registry", () => {
  const result = runRoute({
    requestText: namedRequest,
    approvedGates: ["requirements", "content", "format-notes"],
    primaryStyleId: "not-a-style",
    secondaryStyleId: "insight-editorial",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown.*style|registry/i);
});

test("style maintenance accepts a primary style without an optional secondary style", () => {
  assert.deepEqual(route({
    requestText: namedRequest,
    approvedGates: ["requirements", "content", "format-notes"],
    primaryStyleId: "system-monochrome",
  }), {
    invoked: true,
    action: "one-primary-with-limited-override",
    styleDecision: {
      primaryStyleId: "system-monochrome",
      secondaryStyleId: null,
      secondaryOverrideAllowlist: ["chart-treatment", "section-divider"],
    },
  });
});

test("style maintenance rejects secondary overrides unless a secondary style is selected", () => {
  const result = runRoute({
    requestText: namedRequest,
    approvedGates: ["requirements", "content", "format-notes"],
    primaryStyleId: "system-monochrome",
    secondaryOverrides: ["chart-treatment"],
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /secondary.*style.*required|override.*secondary/i);
});

test("style decisions reject global replacement and persist through project state", (t) => {
  const projectRoot = makeTempDir("sherry-style-decision-");
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const created = createProject({
    root: projectRoot,
    name: "Style Decision",
    entryMode: "topic-start",
    outputs: ["html"],
    speakerNotes: false,
  });

  const decision = route({
    requestText: namedRequest,
    approvedGates: ["requirements", "content", "format-notes"],
    primaryStyleId: "product-narrative",
    secondaryStyleId: "insight-editorial",
    secondaryOverrides: ["chart-treatment", "section-divider"],
  }).styleDecision;
  updateStatus(created.projectDir, {
    primaryStyleId: decision.primaryStyleId,
    secondaryStyleId: decision.secondaryStyleId,
  });
  const persisted = JSON.parse(fs.readFileSync(
    path.join(created.projectDir, "project-status.json"),
    "utf8",
  ));
  assert.equal(persisted.primaryStyleId, "product-narrative");
    assert.equal(persisted.secondaryStyleId, "insight-editorial");
  assert.deepEqual(decision.secondaryOverrideAllowlist, ["chart-treatment", "section-divider"]);

  for (const prohibited of ["global-layout", "typography", "background"]) {
    const result = runRoute({
      requestText: namedRequest,
      approvedGates: ["requirements", "content", "format-notes"],
      primaryStyleId: "product-narrative",
      secondaryStyleId: "insight-editorial",
      secondaryOverrides: [prohibited],
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /secondary override|global|typography|background/i);
  }
});

test("unclear licenses reject adoption and record a real unadopted manifest entry", (t) => {
  const projectRoot = makeTempDir("sherry-license-decision-");
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const created = createProject({
    root: projectRoot,
    name: "License Decision",
    entryMode: "topic-start",
    outputs: ["html"],
    speakerNotes: false,
  });
  const manifestFile = path.join(created.projectDir, "materials", "source-manifest.md");
  const result = route({
    requestText: namedRequest,
    approvedGates: ["requirements"],
    assetLicenseStatus: "unclear",
    sourceManifestFile: manifestFile,
    asset: {
      name: "Unclear skyline",
      source: "https://example.invalid/skyline.png",
      retrievedAt: "2026-08-02",
      author: "Unknown",
      slideUsage: "Rejected cover candidate",
    },
  });

  assert.equal(result.assetDecision.adopted, false);
  assert.equal(result.assetDecision.finalStatus, "unadopted");
  route({
    requestText: namedRequest,
    approvedGates: ["requirements"],
    assetLicenseStatus: "unclear",
    sourceManifestFile: manifestFile,
    asset: {
      name: "Unclear skyline",
      source: "https://example.invalid/skyline.png",
      retrievedAt: "2026-08-02",
      author: "Unknown",
      slideUsage: "Rejected cover candidate",
    },
  });
  const manifest = fs.readFileSync(manifestFile, "utf8");
  assert.match(manifest, /\| Unclear skyline \| https:\/\/example\.invalid\/skyline\.png \|/);
  assert.match(manifest, /\| unclear \| Rejected cover candidate \| unadopted \|/);
  assert.equal(manifest.match(/\| Unclear skyline \|/g)?.length, 1);
});

test("output and notes route creates two selected outputs plus separate notes", (t) => {
  const decision = route({
    requestText: namedRequest,
    approvedGates: ["requirements", "content"],
    outputs: ["html", "pptx"],
    speakerNotes: true,
  });
  const projectRoot = makeTempDir("sherry-output-notes-");
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const created = createProject({
    root: projectRoot,
    name: "Two Output Contract",
    entryMode: "topic-start",
    outputs: decision.outputs,
    speakerNotes: decision.speakerNotes,
  });

  assert.deepEqual(created.status.outputs, ["html", "pptx"]);
  assert.equal(created.status.speakerNotes, true);
  assert.equal(fs.existsSync(path.join(created.projectDir, "speaker-notes.md")), true);
  assert.equal(fs.existsSync(path.join(created.projectDir, "outputs", "speaker-notes.md")), false);
});

test("workflow router executes through an installed Skill symlink", (t) => {
  const installRoot = makeTempDir("sherry-install-");
  const installedSkill = path.join(installRoot, "sherry-skillforhtml2026");
  fs.symlinkSync(root, installedSkill);
  t.after(() => fs.rmSync(installRoot, { recursive: true, force: true }));

  assert.deepEqual(route({ requestText: "Create a generic presentation." }, path.join(
    installedSkill,
    "scripts",
    "route-workflow.mjs",
  )), { invoked: false, action: "do-not-invoke" });
});

test("SKILL describes the router as maintenance-only and forbids live advancement", () => {
  const skill = fs.readFileSync(path.join(root, "SKILL.md"), "utf8");
  assert.match(skill, /maintenance pressure-test/i);
  assert.match(skill, /never use it to advance a real project/i);
  assert.doesNotMatch(skill, /executable routing contract/i);
});
