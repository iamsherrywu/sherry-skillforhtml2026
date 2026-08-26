import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { recordUnadoptedAsset } from "./source-manifest.mjs";
import { updateStatus } from "./update-project-status.mjs";

const SKILL_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const GATES = [
  "requirements",
  "content",
  "format-notes",
  "style",
  "outline",
  "samples",
  "chapters",
  "final",
];
const SECONDARY_OVERRIDE_ALLOWLIST = ["chart-treatment", "section-divider"];

function requireScenario(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Scenario must be a JSON object");
  }
  if (Object.hasOwn(value, "explicitInvocation")) {
    throw new Error("explicitInvocation is unsupported; invocation must be derived from request text");
  }
  if (typeof value.requestText !== "string" || !value.requestText.trim()) {
    throw new Error("Scenario requestText must be non-empty text");
  }
}

export function detectsExplicitInvocation(requestText) {
  if (typeof requestText !== "string") return false;
  return /(?:^|[^A-Za-z0-9_-])sherry-skillforhtml2026(?:$|[^A-Za-z0-9_-])/i.test(requestText)
    || /\bsherry(?:'|’)s\s+named\s+(?:slide\s+)?skill\b/i.test(requestText);
}

export function inferShortcutEntryMode({ requestText, suppliedFiles = [] } = {}) {
  if (typeof requestText !== "string" || !Array.isArray(suppliedFiles)) return null;
  const text = requestText.trim();
  const files = suppliedFiles.filter((file) => typeof file === "string");
  const hasMarkdown = files.some((file) => /\.(?:md|markdown)$/i.test(file))
    || /\bmarkdown\b|\bmd\b|文档|内容/u.test(text);
  const hasHtml = files.some((file) => /\.html?$/i.test(file)) || /\bhtml\b|现有演示|页面/u.test(text);
  const uncertain = /大概|可能|差不多|还行|不确定|先看看|再看看|看起来可以|maybe|probably|not sure/i.test(text);
  const structuralChange = /增删.{0,4}(?:页|页面)|增加.{0,4}(?:页|页面)|删除.{0,4}(?:页|页面)|调整.{0,4}章节|章节.{0,4}(?:调整|重组)|(?:改|调整|重做).{0,4}结构|重写.{0,4}核心内容|核心内容.{0,4}重写/u.test(text);

  const markdownFinal = /(?:md|markdown|文档|内容|这版|终稿).{0,12}(?:已|已经)?(?:敲定|定稿|确认了?|定了|最终版|终稿|不用再改|无需再改)|(?:最终版|终稿).{0,8}(?:md|markdown|文档|内容)?|(?:不用|不需要|无需).{0,8}(?:再)?(?:改|调整).{0,6}(?:md|markdown|文档|内容)/iu.test(text);
  const continueAfterMarkdown = /直接.{0,10}(?:往后|继续|进入|做|制作)|继续.{0,8}(?:往后|后面|制作|做)|从.{0,8}(?:风格|大纲|后面|下一步).{0,4}开始|按.{0,8}(?:现有|这版|这个).{0,10}(?:做|制作|继续|往下)|(?:做成|生成|制作).{0,8}(?:ppt|幻灯片|演示|html)/iu.test(text);
  if (hasMarkdown && !uncertain && markdownFinal && continueAfterMarkdown) {
    return "confirmed-markdown-shortcut";
  }

  const visualChange = /换.{0,6}(?:模板|模版|风格|主题|皮)|换成?.{0,8}风|套.{0,6}(?:模板|模版)|视觉.{0,8}(?:升级|更新|调整|重做)|重新.{0,6}(?:设计|排版|套版)|换皮/u.test(text);
  if (hasHtml && !uncertain && !structuralChange && visualChange) {
    return "html-template-change";
  }
  return null;
}

function gateName(record) {
  return typeof record === "string" ? record : record?.gate;
}

function approvedGatePrefix(approvedGates = []) {
  if (!Array.isArray(approvedGates)) throw new Error("approvedGates must be an array");
  const supplied = approvedGates.map(gateName);
  for (const gate of supplied) {
    if (!GATES.includes(gate)) throw new Error(`Unknown approved gate: ${String(gate)}`);
  }
  const prefix = [];
  for (let index = 0; index < supplied.length && index < GATES.length; index += 1) {
    if (supplied[index] !== GATES[index]) break;
    prefix.push(supplied[index]);
  }
  return prefix;
}

function requireGates(approvedGates, prerequisites) {
  const prefix = approvedGatePrefix(approvedGates);
  const nextRequiredGate = prerequisites.find((gate) => !prefix.includes(gate));
  return nextRequiredGate
    ? { invoked: true, action: "next-required-gate", nextRequiredGate }
    : null;
}

function styleIds() {
  const registry = JSON.parse(fs.readFileSync(
    path.join(SKILL_ROOT, "assets", "style-pool", "registry.json"),
    "utf8",
  ));
  return new Set(registry.styles.map(({ id }) => id));
}

function validateSelectedStyles(primaryStyleId, secondaryStyleId, secondaryOverrides = []) {
  const allowed = styleIds();
  if (typeof primaryStyleId !== "string" || !allowed.has(primaryStyleId)) {
    throw new Error(`Unknown primary style ID in registry: ${String(primaryStyleId)}`);
  }
  if (secondaryStyleId !== undefined && secondaryStyleId !== null
    && (typeof secondaryStyleId !== "string" || !allowed.has(secondaryStyleId))) {
    throw new Error(`Unknown secondary style ID in registry: ${String(secondaryStyleId)}`);
  }
  if (!Array.isArray(secondaryOverrides)) {
    throw new Error("secondaryOverrides must be an array");
  }
  if (secondaryOverrides.length > 0 && (secondaryStyleId === undefined || secondaryStyleId === null)) {
    throw new Error("A secondary style is required when secondary overrides are selected");
  }
  for (const override of secondaryOverrides) {
    if (!SECONDARY_OVERRIDE_ALLOWLIST.includes(override)) {
      throw new Error(`Unsupported secondary override: ${String(override)}; global layout, typography, and background replacement are forbidden`);
    }
  }
}

function readProjectStatus(projectDir) {
  if (typeof projectDir !== "string" || !projectDir.trim()) {
    throw new Error("resume-project requires projectDir");
  }
  const resolvedDir = path.resolve(projectDir);
  const directoryStatus = fs.lstatSync(resolvedDir);
  if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
    throw new Error("resume-project requires a real project directory");
  }
  const statusFile = path.join(resolvedDir, "project-status.json");
  const fileStatus = fs.lstatSync(statusFile);
  if (!fileStatus.isFile() || fileStatus.isSymbolicLink()) {
    throw new Error("project-status.json must be a real file");
  }
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  if (!GATES.includes(status.currentGate)) {
    throw new Error("project-status.json requires a valid currentGate");
  }
  return { status, statusFile };
}

function requireTemporaryMaintenanceArtifact(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) {
    throw new Error("Maintenance sourceManifestFile must be an absolute temporary path");
  }
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const parent = fs.realpathSync(path.dirname(path.resolve(file)));
  if (parent !== temporaryRoot && !parent.startsWith(`${temporaryRoot}${path.sep}`)) {
    throw new Error("Maintenance pressure-tests may write only to temporary project artifacts");
  }
}

export function resolveWorkflowRoute(scenario) {
  requireScenario(scenario);
  if (!detectsExplicitInvocation(scenario.requestText)) {
    return { invoked: false, action: "do-not-invoke" };
  }

  const inferredShortcut = inferShortcutEntryMode(scenario);
  const entryMode = scenario.entryMode === "resume-project"
    ? scenario.entryMode
    : inferredShortcut ?? scenario.entryMode;

  if (entryMode === "resume-project") {
    readProjectStatus(scenario.projectDir);
    updateStatus(scenario.projectDir, {});
    const { status, statusFile } = readProjectStatus(scenario.projectDir);
    const approvedGates = approvedGatePrefix(status.approvedGates);
    return {
      invoked: true,
      action: "read-project-status",
      currentGate: status.currentGate,
      approvedGates,
      nextRequiredGate: GATES.find((gate) => !approvedGates.includes(gate)) ?? null,
      statusFile,
    };
  }
  if (entryMode === "confirmed-markdown") {
    return { invoked: true, action: "self-audit-then-requirements-and-content-gates" };
  }
  if (entryMode === "confirmed-markdown-shortcut") {
    return {
      invoked: true,
      action: "lightweight-markdown-audit-then-format-and-style",
      skippedGates: ["requirements", "content"],
      confirmationPolicy: "do-not-reconfirm-finalized-markdown",
      nextDecisions: ["outputs", "speaker-notes", "style"],
    };
  }
  if (entryMode === "html-template-change") {
    return {
      invoked: true,
      action: "validate-existing-html-then-template-change",
      requiredChecks: ["html-opens", "assets-resolve", "slide-count", "overflow", "offline"],
      skippedGates: ["requirements", "content", "outline", "chapters"],
      confirmationPolicy: "template-selection-is-approval",
      allowedChanges: ["visual-layer", "layout-fit", "minor-copy-edits"],
      escalateOn: ["slide-add-remove", "chapter-restructure", "core-content-rewrite"],
    };
  }
  if (entryMode === "topic-start") {
    return { invoked: true, action: "requirements-gate" };
  }
  if (Number.isInteger(scenario.chapterSlideCount) && scenario.chapterSlideCount > 5) {
    const blocked = requireGates(scenario.approvedGates, GATES.slice(0, 6));
    return blocked ?? {
      invoked: true,
      action: "ask-whole-chapter-or-first-five",
      question: "Generate the whole chapter or the first five slides?",
      choices: ["whole chapter", "first five"],
    };
  }
  if (scenario.outputs?.includes("html") && scenario.outputs?.includes("pptx")
    && scenario.speakerNotes === true) {
    const blocked = requireGates(scenario.approvedGates, GATES.slice(0, 2));
    return blocked ?? {
      invoked: true,
      action: "two-outputs-plus-separate-speaker-notes",
      outputs: ["html", "pptx"],
      speakerNotes: true,
    };
  }
  if (scenario.primaryStyleId !== undefined || scenario.secondaryStyleId !== undefined) {
    validateSelectedStyles(
      scenario.primaryStyleId,
      scenario.secondaryStyleId,
      scenario.secondaryOverrides,
    );
    const blocked = requireGates(scenario.approvedGates, GATES.slice(0, 3));
    return blocked ?? {
      invoked: true,
      action: "one-primary-with-limited-override",
      styleDecision: {
        primaryStyleId: scenario.primaryStyleId,
        secondaryStyleId: scenario.secondaryStyleId ?? null,
        secondaryOverrideAllowlist: [...SECONDARY_OVERRIDE_ALLOWLIST],
      },
    };
  }
  if (scenario.assetLicenseStatus === "unclear") {
    const blocked = requireGates(scenario.approvedGates, GATES.slice(0, 1));
    if (blocked) return blocked;
    requireTemporaryMaintenanceArtifact(scenario.sourceManifestFile);
    const manifestFile = recordUnadoptedAsset(scenario.sourceManifestFile, scenario.asset);
    return {
      invoked: true,
      action: "reject-asset-and-record-unadopted",
      assetDecision: { adopted: false, finalStatus: "unadopted", manifestFile },
    };
  }
  return { invoked: true, action: "requirements-gate" };
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--scenario") {
    throw new Error("Usage: node scripts/route-workflow.mjs --scenario '<json>'");
  }
  try {
    return JSON.parse(argv[1]);
  } catch (error) {
    throw new Error(`Scenario is not valid JSON: ${error.message}`, { cause: error });
  }
}

const invokedPath = process.argv[1] ? fs.realpathSync(path.resolve(process.argv[1])) : "";
if (invokedPath === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.stdout.write(`${JSON.stringify(resolveWorkflowRoute(parseArguments(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
