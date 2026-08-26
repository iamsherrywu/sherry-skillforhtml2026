import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createProject } from "../scripts/init-project.mjs";
import { isExplicitApprovalPhrase, updateStatus } from "../scripts/update-project-status.mjs";

const makeTempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "sherry-slide-"));
const optionsFor = (root, overrides = {}) => ({
  name: "AI 工作流培训",
  root,
  entryMode: "confirmed-markdown",
  outputs: ["html", "pptx"],
  speakerNotes: true,
  ...overrides,
});
const initScript = fileURLToPath(new URL("../scripts/init-project.mjs", import.meta.url));

function advanceToFinal(projectDir) {
  for (const [index, gate] of [
    "requirements",
    "content",
    "format-notes",
    "style",
    "outline",
    "samples",
    "chapters",
  ].entries()) {
    updateStatus(projectDir, {
      approvedGate: gate,
      currentGate: [
        "content",
        "format-notes",
        "style",
        "outline",
        "samples",
        "chapters",
        "final",
      ][index],
    });
  }
}

test("createProject creates a deterministic workflow scaffold", () => {
  const root = makeTempRoot();
  const { projectDir, status } = createProject(optionsFor(root));

  assert.equal(path.basename(projectDir), "ai-workflow-training");
  for (const relativePath of [
    "materials",
    "slides",
    "outputs",
    "requirements.md",
    "content-source.md",
    "outline.md",
    "materials/source-manifest.md",
    "speaker-notes.md",
    "project-status.json",
  ]) {
    assert.ok(fs.existsSync(path.join(projectDir, relativePath)), `missing ${relativePath}`);
  }
  assert.match(fs.readFileSync(path.join(projectDir, "requirements.md"), "utf8"), /^# Requirements/m);
  assert.match(fs.readFileSync(path.join(projectDir, "content-source.md"), "utf8"), /^# Content Source/m);
  assert.match(fs.readFileSync(path.join(projectDir, "outline.md"), "utf8"), /^# Outline/m);
  assert.equal(status.currentGate, "requirements");
  assert.deepEqual(status.outputs, ["html", "pptx"]);
  assert.deepEqual(status.approvedGates, []);
  assert.equal(status.speakerNotes, true);
  assert.ok(Number.isFinite(Date.parse(status.updatedAt)));
});

test("createProject creates speaker notes only when requested", () => {
  const root = makeTempRoot();
  const { projectDir, status } = createProject(optionsFor(root, {
    name: "No Notes",
    outputs: ["html"],
    speakerNotes: false,
  }));

  assert.equal(fs.existsSync(path.join(projectDir, "speaker-notes.md")), false);
  assert.deepEqual(status.outputs, ["html"]);
  assert.equal(status.speakerNotes, false);
});

test("createProject rejects a non-boolean speaker-notes option", () => {
  assert.throws(
    () => createProject(optionsFor(makeTempRoot(), { speakerNotes: "true" })),
    /speakerNotes must be a boolean/i,
  );
});

test("createProject leaves no final status file when its atomic rename fails", () => {
  const root = makeTempRoot();
  const expectedProjectDir = path.join(root, "ai-workflow-training");
  const originalRenameSync = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === path.join(expectedProjectDir, "project-status.json")) {
      throw new Error("simulated rename failure");
    }
    return originalRenameSync(source, destination);
  };

  try {
    assert.throws(
      () => createProject(optionsFor(root)),
      /simulated rename failure/,
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(fs.existsSync(path.join(expectedProjectDir, "project-status.json")), false);
});

test("init-project CLI prints the created project path and omits notes by default", () => {
  const root = makeTempRoot();
  const expectedProjectDir = path.join(root, "presentation-test");
  const result = spawnSync(process.execPath, [
    initScript,
    "--name", "演示测试",
    "--root", root,
    "--entry", "topic-start",
    "--outputs", "html",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${expectedProjectDir}\n`);
  assert.equal(result.stderr, "");
  assert.ok(fs.existsSync(path.join(expectedProjectDir, "project-status.json")));
  assert.equal(fs.existsSync(path.join(expectedProjectDir, "speaker-notes.md")), false);
});

test("updateStatus rejects ordinary-mode skipped gates", () => {
  const { projectDir } = createProject(optionsFor(makeTempRoot()));

  assert.throws(
    () => updateStatus(projectDir, { currentGate: "style" }),
    /cannot skip gate/i,
  );
});

test("updateStatus cannot record approval for an unvisited future gate", () => {
  const { projectDir } = createProject(optionsFor(makeTempRoot()));

  assert.throws(
    () => updateStatus(projectDir, { approvedGates: ["style"] }),
    /cannot approve gate/i,
  );
});

test("updateStatus rejects unknown, immutable, and malformed state patches", () => {
  const invalidPatches = [
    [{ unexpected: true }, /unknown status field/i],
    [{ projectName: "Changed" }, /immutable status field/i],
    [{ schemaVersion: 2 }, /immutable status field/i],
    [{ updatedAt: "2026-01-01T00:00:00.000Z" }, /immutable status field/i],
    [{ outputs: ["html", "pdf"] }, /outputs must be html and\/or pptx/i],
    [{ entryMode: "invalid" }, /valid entryMode/i],
    [{ speakerNotes: "yes" }, /speakerNotes must be a boolean/i],
    [{ fastMode: "yes" }, /fastMode must be a boolean/i],
    [{ primaryStyleId: "unknown-style" }, /primaryStyleId/i],
    [{ secondaryStyleId: "" }, /secondaryStyleId/i],
    [{ currentChapter: 3 }, /currentChapter/i],
    [{ approvedGates: [{ gate: "requirements", approvedAt: "not-a-timestamp" }] }, /approvedAt/i],
  ];

  for (const [patch, error] of invalidPatches) {
    const { projectDir } = createProject(optionsFor(makeTempRoot()));
    assert.throws(() => updateStatus(projectDir, patch), error);
  }
});

test("updateStatus retains timestamps for prior approved gates", () => {
  const { projectDir } = createProject(optionsFor(makeTempRoot()));
  const afterRequirements = updateStatus(projectDir, {
    currentGate: "content",
    approvedGates: ["requirements"],
  });
  const requirementsApproval = afterRequirements.approvedGates.find(
    ({ gate }) => gate === "requirements",
  ).approvedAt;
  const afterContent = updateStatus(projectDir, {
    currentGate: "format-notes",
    approvedGates: ["requirements", "content"],
  });

  assert.equal(
    afterContent.approvedGates.find(({ gate }) => gate === "requirements").approvedAt,
    requirementsApproval,
  );
  assert.ok(
    Number.isFinite(
      Date.parse(afterContent.approvedGates.find(({ gate }) => gate === "content").approvedAt),
    ),
  );
});

test("updateStatus requires current-gate approval before every forward transition", () => {
  const { projectDir } = createProject(optionsFor(makeTempRoot()));

  assert.throws(
    () => updateStatus(projectDir, { currentGate: "content" }),
    /approve.*requirements|requirements.*approval/i,
  );
  const next = updateStatus(projectDir, {
    approvedGate: "requirements",
    currentGate: "content",
  });
  assert.equal(next.currentGate, "content");
  assert.deepEqual(next.approvedGates.map(({ gate }) => gate), ["requirements"]);
});

test("updateStatus fast mode changes batching only and cannot skip confirmation gates", () => {
  const { projectDir } = createProject(optionsFor(makeTempRoot()));
  updateStatus(projectDir, { fastMode: true });

  assert.throws(
    () => updateStatus(projectDir, { currentGate: "final" }),
    /cannot skip gate|approve.*requirements/i,
  );
  assert.throws(
    () => updateStatus(projectDir, { currentGate: "content" }),
    /approve.*requirements|requirements.*approval/i,
  );
});

test("updateStatus enforces one contiguous approved-gate prefix", () => {
  const { projectDir } = createProject(optionsFor(makeTempRoot()));

  assert.throws(
    () => updateStatus(projectDir, { approvedGates: ["requirements", "style"] }),
    /contiguous|approval prefix|cannot approve gate/i,
  );
});

test("approval intent accepts conservative standalone natural-language confirmations", () => {
  for (const phrase of [
    "通过",
    "没问题",
    "下一阶段",
    "下一章",
    "可以",
    "好的",
    "确认",
    "继续",
    "往下走",
    "确认开始制作",
    "这一页过了",
    "第一页没问题",
    "确认通过",
    "我确认通过，可以进入下一阶段",
    "请进入下一阶段",
    "按这个版本继续",
    "approved",
    "I approve this version",
    "yes, proceed",
    "go ahead to the next stage",
    "LGTM, proceed",
  ]) {
    assert.equal(isExplicitApprovalPhrase(phrase), true, phrase);
    assert.equal(isExplicitApprovalPhrase(`  ${phrase}  `), true, phrase);
  }

  const { projectDir } = createProject(optionsFor(makeTempRoot()));
  const next = updateStatus(projectDir, {
    approvalPhrase: "我确认通过，可以进入下一阶段",
    currentGate: "content",
  });
  assert.deepEqual(next.approvedGates.map(({ gate }) => gate), ["requirements"]);
});

test("approval intent rejects mixed edits and ambiguous language", () => {
  for (const phrase of [
    "不错",
    "看起来可以",
    "应该没问题",
    "大概可以",
    "下一章先看看",
    "通过吗",
    "looks good",
    "looks okay?",
    "maybe proceed",
    "probably approved",
    "没问题，顺便改一下标题",
    "通过，但把第 3 页调整一下",
    "LGTM, change the color before continuing",
    "go ahead after you fix the outline",
  ]) {
    assert.equal(isExplicitApprovalPhrase(phrase), false, phrase);
  }

  const { projectDir } = createProject(optionsFor(makeTempRoot()));
  assert.throws(
    () => updateStatus(projectDir, { approvalPhrase: "看起来可以" }),
    /approval.*intent|standalone.*approval|approval phrase/i,
  );
});

test("updateStatus rejects arbitrary approval injection beyond the current gate", () => {
  const { projectDir } = createProject(optionsFor(makeTempRoot()));

  assert.throws(
    () => updateStatus(projectDir, {
      approvedGates: ["requirements", "content"],
      currentGate: "content",
    }),
    /current gate|destination gate|before it is current/i,
  );
});

test("updateStatus allows one-step approval transition but not fast-mode cross-gate approval", () => {
  const { projectDir } = createProject(optionsFor(makeTempRoot()));

  const content = updateStatus(projectDir, {
    approvalPhrase: "yes, proceed",
    currentGate: "content",
  });
  assert.equal(content.currentGate, "content");
  assert.deepEqual(content.approvedGates.map(({ gate }) => gate), ["requirements"]);

  updateStatus(projectDir, { fastMode: true });
  assert.throws(
    () => updateStatus(projectDir, {
      approvedGates: ["requirements", "content", "format-notes"],
      currentGate: "format-notes",
    }),
    /current gate|destination gate|before it is current/i,
  );
});

test("content revisions reopen content and invalidate every dependent approval", () => {
  const { projectDir } = createProject(optionsFor(makeTempRoot()));
  advanceToFinal(projectDir);
  updateStatus(projectDir, { approvedGate: "final" });
  fs.appendFileSync(path.join(projectDir, "content-source.md"), "\nRevised material.\n");

  const revised = updateStatus(projectDir, { currentChapter: "chapter-03" });

  assert.equal(revised.currentGate, "content");
  assert.deepEqual(revised.approvedGates.map(({ gate }) => gate), ["requirements"]);
  assert.equal(revised.revisionLog.at(-1).reopenedGate, "content");
  assert.ok(revised.revisionLog.at(-1).changedMaterials.includes("content-source.md"));
  assert.ok(revised.revisionLog.at(-1).invalidatedGates.includes("final"));
});

test("outline, format, style, and notes revisions reopen their earliest owning gate", () => {
  const cases = [
    {
      name: "outline file",
      mutate(projectDir) { fs.appendFileSync(path.join(projectDir, "outline.md"), "\nRevised outline.\n"); },
      patch: {},
      expectedGate: "outline",
    },
    {
      name: "output selection",
      mutate() {},
      patch: { outputs: ["html"] },
      expectedGate: "format-notes",
    },
    {
      name: "speaker-notes selection",
      mutate() {},
      patch: { speakerNotes: false },
      expectedGate: "format-notes",
    },
    {
      name: "style selection",
      mutate() {},
      patch: { primaryStyleId: "technical-atlas" },
      expectedGate: "style",
    },
    {
      name: "speaker notes content",
      mutate(projectDir) { fs.appendFileSync(path.join(projectDir, "speaker-notes.md"), "\nRevised notes.\n"); },
      patch: {},
      expectedGate: "chapters",
    },
  ];

  for (const fixture of cases) {
    const { projectDir } = createProject(optionsFor(makeTempRoot()));
    advanceToFinal(projectDir);
    updateStatus(projectDir, { approvedGate: "final" });
    fixture.mutate(projectDir);

    const revised = updateStatus(projectDir, fixture.patch);

    assert.equal(revised.currentGate, fixture.expectedGate, fixture.name);
    assert.equal(
      revised.approvedGates.some(({ gate }) => gate === fixture.expectedGate),
      false,
      fixture.name,
    );
    assert.equal(revised.approvedGates.some(({ gate }) => gate === "final"), false, fixture.name);
  }
});

test("chapter, style, sample, and output files reopen their owning gates", () => {
  const cases = [
    ["slides/chapter-01.html", "chapters"],
    ["materials/style-overrides.json", "style"],
    ["materials/samples/sample-note.md", "samples"],
    ["outputs/deck.html", "final"],
  ];
  for (const [relativePath, expectedGate] of cases) {
    const { projectDir } = createProject(optionsFor(makeTempRoot()));
    advanceToFinal(projectDir);
    updateStatus(projectDir, { approvedGate: "final" });
    const file = path.join(projectDir, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "revised artifact\n", "utf8");

    const revised = updateStatus(projectDir, {});

    assert.equal(revised.currentGate, expectedGate, relativePath);
    assert.equal(revised.approvedGates.at(-1)?.gate, expectedGate === "requirements" ? undefined : [
      "requirements", "content", "format-notes", "style", "outline", "samples", "chapters", "final",
    ][["requirements", "content", "format-notes", "style", "outline", "samples", "chapters", "final"].indexOf(expectedGate) - 1], relativePath);
    assert.ok(revised.revisionLog.at(-1).changedMaterials.includes(relativePath), relativePath);
  }
});

test("explicit artifact revisions cannot be approved again in the same state update", () => {
  const { projectDir } = createProject(optionsFor(makeTempRoot()));
  advanceToFinal(projectDir);

  assert.throws(
    () => updateStatus(projectDir, {
      revisedArtifacts: ["style"],
      approvedGate: "style",
    }),
    /same update|revised.*approve|approve.*revision/i,
  );
});

test("legacy approved state without artifact hashes reopens conservatively on first update", () => {
  const { projectDir } = createProject(optionsFor(makeTempRoot()));
  advanceToFinal(projectDir);
  updateStatus(projectDir, { approvedGate: "final" });
  const statusFile = path.join(projectDir, "project-status.json");
  const legacy = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  delete legacy.artifactHashes;
  fs.writeFileSync(statusFile, `${JSON.stringify(legacy, null, 2)}\n`);

  const migrated = updateStatus(projectDir, {});

  assert.equal(migrated.currentGate, "requirements");
  assert.deepEqual(migrated.approvedGates, []);
  assert.ok(migrated.revisionLog.at(-1).changedMaterials.includes("artifact-hash-baseline"));
});
