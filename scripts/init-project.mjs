import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { captureArtifactHashes } from "./update-project-status.mjs";

const ENTRY_MODES = new Set(["topic-start", "confirmed-markdown", "resume-project"]);
const OUTPUTS = new Set(["html", "pptx"]);

const TRANSLATIONS = [
  ["人工智能", "ai"],
  ["工作流", "workflow"],
  ["培训", "training"],
  ["演示", "presentation"],
  ["测试", "test"],
  ["幻灯片", "slides"],
  ["项目", "project"],
  ["报告", "report"],
];

const STARTER_FILES = {
  "requirements.md": `# Requirements

## Purpose

## Audience

## Setting

## Duration

## Takeaway

## Must Include

## Must Exclude

## Sources

## Sensitivity

## Deadline

## Visual Constraints

## Output Path
`,
  "content-source.md": `# Content Source

## Arguments

## Chapter Logic

## Cases And Data

## Source Markers

## Speaking Prompts

## Rejected Content
`,
  "outline.md": `# Outline

## Slide Records

| id | title | pageType | coreMessage | screenText | visualForm | contentSources | assetSources | transition | included | reviewStatus |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
`,
  "materials/source-manifest.md": `# Source Manifest

| name | URL/path | retrievedAt | author/organization | license/status | slideUsage | finalStatus |
| --- | --- | --- | --- | --- | --- | --- |
`,
  "speaker-notes.md": `# Speaker Notes

## Slide Notes
`,
};

export function slugifyProjectName(name) {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("Project name is required");
  }

  let normalized = name.trim().toLowerCase();
  for (const [source, translation] of TRANSLATIONS) {
    normalized = normalized.replaceAll(source, ` ${translation} `);
  }
  normalized = normalized
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");

  return normalized || "presentation";
}

function validateOptions(options) {
  if (!options || typeof options !== "object") throw new Error("Project options are required");
  if (typeof options.root !== "string" || !options.root.trim()) throw new Error("Project root is required");
  if (!ENTRY_MODES.has(options.entryMode)) throw new Error("A valid entry mode is required");
  if (!Array.isArray(options.outputs) || options.outputs.length === 0) {
    throw new Error("At least one output is required");
  }
  if (options.outputs.some((output) => !OUTPUTS.has(output))) {
    throw new Error("Outputs must be html and/or pptx");
  }
  if (new Set(options.outputs).size !== options.outputs.length) {
    throw new Error("Outputs must not contain duplicates");
  }
  if (options.speakerNotes !== undefined && typeof options.speakerNotes !== "boolean") {
    throw new Error("speakerNotes must be a boolean");
  }
}

function writeJson(file, value) {
  const temporaryFile = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryFile, file);
  } catch (error) {
    fs.rmSync(temporaryFile, { force: true });
    throw error;
  }
}

export function createProject(options) {
  validateOptions(options);

  const projectDir = path.resolve(options.root, slugifyProjectName(options.name));
  if (fs.existsSync(projectDir)) throw new Error(`Project directory already exists: ${projectDir}`);

  fs.mkdirSync(projectDir, { recursive: true });
  for (const directory of ["materials", "slides", "outputs"]) {
    fs.mkdirSync(path.join(projectDir, directory));
  }
  for (const file of ["requirements.md", "content-source.md", "outline.md", "materials/source-manifest.md"]) {
    fs.writeFileSync(path.join(projectDir, file), STARTER_FILES[file], "utf8");
  }
  if (options.speakerNotes === true) {
    fs.writeFileSync(path.join(projectDir, "speaker-notes.md"), STARTER_FILES["speaker-notes.md"], "utf8");
  }

  const status = {
    schemaVersion: 1,
    projectName: options.name,
    entryMode: options.entryMode,
    currentGate: "requirements",
    approvedGates: [],
    outputs: [...options.outputs],
    speakerNotes: options.speakerNotes === true,
    primaryStyleId: null,
    secondaryStyleId: null,
    fastMode: false,
    currentChapter: null,
    artifactHashes: captureArtifactHashes(projectDir),
    revisionLog: [],
    updatedAt: new Date().toISOString(),
  };
  writeJson(path.join(projectDir, "project-status.json"), status);

  return { projectDir, status };
}

function parseArguments(argv) {
  const parsed = { speakerNotes: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--speaker-notes") {
      parsed.speakerNotes = true;
      continue;
    }
    const key = {
      "--name": "name",
      "--root": "root",
      "--entry": "entryMode",
      "--outputs": "outputs",
    }[argument];
    if (!key || index + 1 === argv.length) throw new Error(`Unknown or incomplete argument: ${argument}`);
    parsed[key] = argv[index + 1];
    index += 1;
  }
  if (typeof parsed.outputs === "string") {
    parsed.outputs = parsed.outputs.split(",").map((output) => output.trim()).filter(Boolean);
  }
  return parsed;
}

function isDirectInvocation() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectInvocation()) {
  try {
    const { projectDir } = createProject(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${projectDir}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
