import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const GATES = [
  "requirements",
  "content",
  "format-notes",
  "style",
  "outline",
  "samples",
  "chapters",
  "final",
];

const GATE_SET = new Set(GATES);
export const APPROVAL_PHRASES = ["通过", "没问题", "下一阶段", "下一章"];
const APPROVAL_PHRASE_SET = new Set(APPROVAL_PHRASES);
const MIXED_EDIT_INTENT = [
  /改|修改|调整|优化|补充|增加|添加|删除|删掉|替换|换成|重写|重新|修正|完善|变更|更新/u,
  /\b(change|fix|revise|edit|adjust|update|add|remove|delete|replace|rewrite)\b/i,
  /\b(after|before)\s+you\b/i,
];
const UNCERTAIN_OR_QUESTION_INTENT = [
  /[?？]|吗|么|呢/u,
  /应该|可能|大概|或许|不确定|先看看|再看看|看起来可以/u,
  /\b(maybe|probably|perhaps|not sure|i think|looks okay)\b/i,
];
const APPROVAL_INTENT_PATTERNS = [
  /^(通过|没问题|下一阶段|下一章)[。.!！]*$/u,
  /^(可以|好的|确认|确定|继续|往下走|开始吧|按这个来)[。.!！]*$/u,
  /^(我)?确认通过([，, ]*(可以|请)?(进入|开始|继续)?(下一阶段|下一个阶段|下一步|下一章))?[。.!！]*$/u,
  /^确认([，, ]*(开始制作|进入下一阶段|进入下一步|继续|往下走))[。.!！]*$/u,
  /^(可以|请)?(进入|开始|继续)(下一阶段|下一个阶段|下一步|下一章)[。.!！]*$/u,
  /^(这一页|这页|第一页|这一章)(过了|通过|没问题|可以)[。.!！]*$/u,
  /^按(这个|当前|此)(版本|方案|稿子|内容)(继续|推进|执行)[。.!！]*$/u,
  /^(同意|批准)(这个|当前|此)?(版本|方案|稿子|内容)?([，, ]*(继续|推进|执行|进入(下一阶段|下一章)))?[。.!！]*$/u,
  /^(approved|approve|this is approved)[.!]*$/i,
  /^i approve( this| this version)?[.!]*$/i,
  /^(yes,? )?(proceed|go ahead)( to (the )?(next stage|next chapter|next step))?[.!]*$/i,
  /^lgtm,? (proceed|go ahead)( to (the )?(next stage|next chapter|next step))?[.!]*$/i,
  /^looks good to (proceed|go ahead|continue)( to (the )?(next stage|next chapter|next step))?[.!]*$/i,
];
const ENTRY_MODES = new Set(["topic-start", "confirmed-markdown", "resume-project"]);
const OUTPUTS = new Set(["html", "pptx"]);
const STYLE_IDS = new Set(
  JSON.parse(fs.readFileSync(new URL("../assets/style-pool/registry.json", import.meta.url), "utf8"))
    .styles.map(({ id }) => id),
);
const MUTABLE_FIELDS = new Set([
  "entryMode",
  "currentGate",
  "approvedGates",
  "approvedGate",
  "approveGate",
  "approvalPhrase",
  "outputs",
  "speakerNotes",
  "primaryStyleId",
  "secondaryStyleId",
  "fastMode",
  "currentChapter",
  "revisedArtifacts",
]);
const IMMUTABLE_FIELDS = new Set([
  "schemaVersion",
  "projectName",
  "updatedAt",
  "artifactHashes",
  "revisionLog",
]);
const ARTIFACT_FILES = new Map([
  ["requirements.md", "requirements"],
  ["content-source.md", "content"],
  ["outline.md", "outline"],
  ["speaker-notes.md", "chapters"],
]);
const EXPLICIT_REVISIONS = new Map([
  ["requirements", "requirements"],
  ["content", "content"],
  ["outputs", "format-notes"],
  ["notes-selection", "format-notes"],
  ["style", "style"],
  ["outline", "outline"],
  ["samples", "samples"],
  ["chapters", "chapters"],
  ["speaker-notes", "chapters"],
  ["chapter-sources", "chapters"],
  ["style-overrides", "style"],
  ["sample-assets", "samples"],
]);

function statusFile(projectDir) {
  return path.join(path.resolve(projectDir), "project-status.json");
}

function readStatus(projectDir) {
  const file = statusFile(projectDir);
  if (!fs.existsSync(file)) throw new Error(`Project status does not exist: ${file}`);
  const status = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!GATE_SET.has(status.currentGate)) throw new Error("Project status has an invalid current gate");
  return status;
}

function digestFile(file) {
  if (!fs.existsSync(file)) return null;
  const fileStatus = fs.lstatSync(file);
  if (!fileStatus.isFile() || fileStatus.isSymbolicLink()) {
    throw new Error(`Tracked project artifact must be a real file: ${file}`);
  }
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function walkProjectFiles(root, relativeDirectory) {
  const directory = path.join(root, relativeDirectory);
  if (!fs.existsSync(directory)) return [];
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "project-status.json" || entry.name.endsWith(".tmp")) continue;
    const relativePath = path.join(relativeDirectory, entry.name);
    const absolutePath = path.join(root, relativePath);
    if (entry.isSymbolicLink()) {
      throw new Error(`Tracked project artifact must not be a symbolic link: ${absolutePath}`);
    }
    if (entry.isDirectory()) files.push(...walkProjectFiles(root, relativePath));
    else if (entry.isFile()) files.push(relativePath.split(path.sep).join("/"));
  }
  return files;
}

function artifactGate(relativePath) {
  if (ARTIFACT_FILES.has(relativePath)) return ARTIFACT_FILES.get(relativePath);
  if (relativePath.startsWith("slides/")) return "chapters";
  if (relativePath.startsWith("outputs/")) return "final";
  if (relativePath.startsWith("materials/style") || relativePath.includes("/style-")) return "style";
  if (relativePath.startsWith("materials/sample") || relativePath.includes("/sample")) return "samples";
  if (relativePath.startsWith("materials/")) return "content";
  return null;
}

function trackedArtifactPaths(root, existingHashes = {}) {
  const paths = new Set([...ARTIFACT_FILES.keys(), ...Object.keys(existingHashes)]);
  for (const directory of ["materials", "slides", "outputs"]) {
    for (const relativePath of walkProjectFiles(root, directory)) paths.add(relativePath);
  }
  return [...paths].filter((relativePath) => artifactGate(relativePath));
}

export function captureArtifactHashes(projectDir) {
  const root = path.resolve(projectDir);
  return Object.fromEntries(
    trackedArtifactPaths(root).map((relativePath) => [relativePath, digestFile(path.join(root, relativePath))]),
  );
}

function approvedGateRecords(approvedGates, fallbackTimestamp) {
  if (Array.isArray(approvedGates)) {
    return approvedGates.map((item) => (
      typeof item === "string" ? { gate: item, approvedAt: fallbackTimestamp } : item
    ));
  }
  if (approvedGates && typeof approvedGates === "object") {
    return Object.entries(approvedGates).map(([gate, approvedAt]) => ({ gate, approvedAt }));
  }
  return [];
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function isExplicitApprovalPhrase(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (APPROVAL_PHRASE_SET.has(trimmed)) return true;
  const normalized = trimmed.replace(/\s+/g, " ");
  if (MIXED_EDIT_INTENT.some((pattern) => pattern.test(normalized))) return false;
  if (UNCERTAIN_OR_QUESTION_INTENT.some((pattern) => pattern.test(normalized))) return false;
  return APPROVAL_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function validateOutputs(outputs) {
  if (!Array.isArray(outputs) || outputs.length === 0 || outputs.some((output) => !OUTPUTS.has(output))) {
    throw new Error("outputs must be html and/or pptx");
  }
  if (new Set(outputs).size !== outputs.length) throw new Error("outputs must not contain duplicates");
}

function validateStyleId(field, value) {
  if (value !== null && (typeof value !== "string" || !STYLE_IDS.has(value))) {
    throw new Error(`${field} must be a style ID or null`);
  }
}

function validateApprovedGateInput(value) {
  const validateGate = (gate) => {
    if (typeof gate !== "string" || !GATE_SET.has(gate)) throw new Error("approvedGates contains an invalid gate");
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") {
        validateGate(item);
      } else if (item && typeof item === "object" && !Array.isArray(item)) {
        if (!Object.hasOwn(item, "gate") || !Object.keys(item).every((key) => ["gate", "approvedAt"].includes(key))) {
          throw new Error("approvedGates contains a malformed approval");
        }
        validateGate(item.gate);
        if (item.approvedAt !== undefined && !isTimestamp(item.approvedAt)) {
          throw new Error("approvedAt must be an ISO-8601 timestamp");
        }
      } else {
        throw new Error("approvedGates contains a malformed approval");
      }
    }
    return;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [gate, approvedAt] of Object.entries(value)) {
      validateGate(gate);
      if (!isTimestamp(approvedAt)) throw new Error("approvedAt must be an ISO-8601 timestamp");
    }
    return;
  }
  throw new Error("approvedGates must be an array or object");
}

function validatePatch(patch) {
  for (const key of Object.keys(patch)) {
    if (IMMUTABLE_FIELDS.has(key)) throw new Error(`Immutable status field: ${key}`);
    if (!MUTABLE_FIELDS.has(key)) throw new Error(`Unknown status field: ${key}`);
  }
  if (patch.entryMode !== undefined && !ENTRY_MODES.has(patch.entryMode)) {
    throw new Error("entryMode must be a valid entryMode");
  }
  if (patch.currentGate !== undefined && !GATE_SET.has(patch.currentGate)) {
    throw new Error(`Unknown gate: ${patch.currentGate}`);
  }
  if (patch.outputs !== undefined) validateOutputs(patch.outputs);
  for (const field of ["speakerNotes", "fastMode"]) {
    if (patch[field] !== undefined && typeof patch[field] !== "boolean") {
      throw new Error(`${field} must be a boolean`);
    }
  }
  if (patch.primaryStyleId !== undefined) validateStyleId("primaryStyleId", patch.primaryStyleId);
  if (patch.secondaryStyleId !== undefined) validateStyleId("secondaryStyleId", patch.secondaryStyleId);
  if (patch.currentChapter !== undefined && patch.currentChapter !== null
    && (typeof patch.currentChapter !== "string" || !patch.currentChapter.trim())) {
    throw new Error("currentChapter must be a non-empty string or null");
  }
  if (patch.approvedGates !== undefined) validateApprovedGateInput(patch.approvedGates);
  if (patch.approvalPhrase !== undefined && !isExplicitApprovalPhrase(patch.approvalPhrase)) {
    throw new Error(`Approval phrase must be one exact standalone approval: ${APPROVAL_PHRASES.join(", ")}`);
  }
  if (patch.revisedArtifacts !== undefined) {
    if (!Array.isArray(patch.revisedArtifacts) || patch.revisedArtifacts.length === 0) {
      throw new Error("revisedArtifacts must be a non-empty array");
    }
    if (new Set(patch.revisedArtifacts).size !== patch.revisedArtifacts.length) {
      throw new Error("revisedArtifacts must not contain duplicates");
    }
    for (const artifact of patch.revisedArtifacts) {
      if (typeof artifact !== "string" || !EXPLICIT_REVISIONS.has(artifact)) {
        throw new Error(`Unknown revised artifact: ${String(artifact)}`);
      }
    }
  }
  for (const field of ["approvedGate", "approveGate"]) {
    if (patch[field] !== undefined && (typeof patch[field] !== "string" || !GATE_SET.has(patch[field]))) {
      throw new Error(`${field} must be a valid gate`);
    }
  }
}

function mergeApprovedGates(status, patch, timestamp) {
  const existing = approvedGateRecords(status.approvedGates, status.updatedAt);
  const requested = [];
  if (patch.approvedGates !== undefined) {
    if (!Array.isArray(patch.approvedGates) && typeof patch.approvedGates !== "object") {
      throw new Error("approvedGates must be an array or object");
    }
    requested.push(...approvedGateRecords(patch.approvedGates, timestamp));
  }
  for (const key of ["approvedGate", "approveGate"]) {
    if (patch[key] !== undefined) requested.push({ gate: patch[key], approvedAt: timestamp });
  }
  if (patch.approvalPhrase !== undefined) {
    requested.push({ gate: status.currentGate, approvedAt: timestamp });
  }
  const existingGates = new Set(existing.map(({ gate }) => gate));
  for (const item of requested) {
    if (!existingGates.has(item.gate) && item.gate !== status.currentGate) {
      throw new Error(`Cannot approve gate ${item.gate} before it is current; only the current gate can be approved`);
    }
  }

  const byGate = new Map();
  for (const item of [...existing, ...requested]) {
    if (!item || typeof item.gate !== "string" || !GATE_SET.has(item.gate)) {
      throw new Error("approvedGates contains an invalid gate");
    }
    if (!byGate.has(item.gate)) {
      byGate.set(item.gate, {
        gate: item.gate,
        approvedAt: typeof item.approvedAt === "string" ? item.approvedAt : timestamp,
      });
    }
  }
  return GATES.filter((gate) => byGate.has(gate)).map((gate) => byGate.get(gate));
}

function validateTransition(currentGate, nextGate) {
  if (!GATE_SET.has(nextGate)) throw new Error(`Unknown gate: ${nextGate}`);
  const currentIndex = GATES.indexOf(currentGate);
  const nextIndex = GATES.indexOf(nextGate);
  if (nextIndex > currentIndex + 1) {
    throw new Error(`Cannot skip gate: ${GATES.slice(currentIndex + 1, nextIndex).join(", ")}`);
  }
}

function validateApprovedGates(approvedGates, currentGate) {
  for (const [index, record] of approvedGates.entries()) {
    if (record.gate !== GATES[index]) {
      throw new Error(`Cannot approve gate ${record.gate}: approvals must form one contiguous approval prefix`);
    }
  }
  const currentIndex = GATES.indexOf(currentGate);
  const futureApproval = approvedGates.find(({ gate }) => GATES.indexOf(gate) > currentIndex);
  if (futureApproval) throw new Error(`Cannot approve gate before it is visited: ${futureApproval.gate}`);
}

function approvalWasRequested(patch) {
  return patch.approvedGates !== undefined || patch.approvedGate !== undefined
    || patch.approveGate !== undefined || patch.approvalPhrase !== undefined;
}

function changedStatusMaterials(status, patch) {
  const changes = [];
  const push = (name, gate) => changes.push({ name, gate });
  if (patch.entryMode !== undefined && patch.entryMode !== status.entryMode) push("entryMode", "requirements");
  if (patch.outputs !== undefined && JSON.stringify(patch.outputs) !== JSON.stringify(status.outputs)) {
    push("outputs", "format-notes");
  }
  if (patch.speakerNotes !== undefined && patch.speakerNotes !== status.speakerNotes) {
    push("speakerNotes", "format-notes");
  }
  for (const field of ["primaryStyleId", "secondaryStyleId"]) {
    if (patch[field] !== undefined && patch[field] !== status[field]) push(field, "style");
  }
  for (const artifact of patch.revisedArtifacts ?? []) {
    push(artifact, EXPLICIT_REVISIONS.get(artifact));
  }
  return changes;
}

function changedFileMaterials(projectDir, status) {
  const currentHashes = captureArtifactHashes(projectDir);
  if (!status.artifactHashes || typeof status.artifactHashes !== "object") {
    const hasApprovals = approvedGateRecords(status.approvedGates, status.updatedAt).length > 0;
    return {
      currentHashes,
      changes: hasApprovals ? [{ name: "artifact-hash-baseline", gate: "requirements" }] : [],
    };
  }
  const changes = [];
  for (const relativePath of trackedArtifactPaths(path.resolve(projectDir), status.artifactHashes)) {
    const gate = artifactGate(relativePath);
    if ((status.artifactHashes[relativePath] ?? null) !== (currentHashes[relativePath] ?? null)) {
      changes.push({ name: relativePath, gate });
    }
  }
  return { currentHashes, changes };
}

function earliestAffectedRevision(status, changes) {
  const approved = new Set(approvedGateRecords(status.approvedGates, status.updatedAt).map(({ gate }) => gate));
  const currentIndex = GATES.indexOf(status.currentGate);
  const effective = changes.filter(({ gate }) => (
    approved.has(gate) || currentIndex > GATES.indexOf(gate)
  ));
  if (effective.length === 0) return null;
  return effective.reduce((earliest, change) => (
    GATES.indexOf(change.gate) < GATES.indexOf(earliest.gate) ? change : earliest
  ));
}

function appendRevisionLog(status, changes, reopenedGate, timestamp, invalidatedGates) {
  const existing = Array.isArray(status.revisionLog) ? status.revisionLog : [];
  const changedMaterials = [...new Set(changes.map(({ name }) => name))];
  return [...existing, {
    at: timestamp,
    changedMaterials,
    fromGate: status.currentGate,
    reopenedGate,
    invalidatedGates,
  }].slice(-200);
}

function writeStatus(file, status) {
  const temporaryFile = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryFile, file);
}

export function updateStatus(projectDir, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Status patch is required");
  }
  validatePatch(patch);
  const status = readStatus(projectDir);
  const timestamp = new Date().toISOString();
  const requestedGate = patch.currentGate === undefined ? status.currentGate : patch.currentGate;
  validateTransition(status.currentGate, requestedGate);
  const files = changedFileMaterials(projectDir, status);
  const changes = [...files.changes, ...changedStatusMaterials(status, patch)];
  const earliestRevision = earliestAffectedRevision(status, changes);
  if (earliestRevision && approvalWasRequested(patch)) {
    throw new Error("Cannot approve a revised gate in the same update; review the reopened material first");
  }

  let nextGate = requestedGate;
  if (earliestRevision) {
    const requestedIndex = GATES.indexOf(requestedGate);
    const affectedIndex = GATES.indexOf(earliestRevision.gate);
    nextGate = GATES[Math.min(requestedIndex, affectedIndex)];
  }

  const nextStatus = {
    ...status,
    ...Object.fromEntries(
      Object.entries(patch).filter(([key]) => ![
        "approvedGates",
        "approvedGate",
        "approveGate",
        "approvalPhrase",
        "revisedArtifacts",
      ].includes(key)),
    ),
    currentGate: nextGate,
    approvedGates: mergeApprovedGates(status, patch, timestamp),
    artifactHashes: files.currentHashes,
    revisionLog: Array.isArray(status.revisionLog) ? status.revisionLog : [],
    updatedAt: timestamp,
  };

  if (GATES.indexOf(nextGate) < GATES.indexOf(status.currentGate) || earliestRevision) {
    const previousApprovals = nextStatus.approvedGates.map(({ gate }) => gate);
    nextStatus.approvedGates = nextStatus.approvedGates.filter(
      ({ gate }) => GATES.indexOf(gate) < GATES.indexOf(nextGate),
    );
    if (earliestRevision) {
      const retained = new Set(nextStatus.approvedGates.map(({ gate }) => gate));
      const invalidatedGates = previousApprovals.filter((gate) => !retained.has(gate));
      nextStatus.revisionLog = appendRevisionLog(
        status,
        changes,
        nextGate,
        timestamp,
        invalidatedGates,
      );
    }
  }
  validateApprovedGates(nextStatus.approvedGates, nextStatus.currentGate);
  if (GATES.indexOf(nextStatus.currentGate) > GATES.indexOf(status.currentGate)
    && !nextStatus.approvedGates.some(({ gate }) => gate === status.currentGate)) {
    throw new Error(`Approve ${status.currentGate} before advancing to ${nextStatus.currentGate}`);
  }
  writeStatus(statusFile(projectDir), nextStatus);
  return nextStatus;
}
