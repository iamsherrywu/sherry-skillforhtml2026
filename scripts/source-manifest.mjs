import fs from "node:fs";
import path from "node:path";

const REQUIRED_FIELDS = ["name", "source", "retrievedAt", "author", "slideUsage"];
const TABLE_HEADER = "| name | URL/path | retrievedAt | author/organization | license/status | slideUsage | finalStatus |";

function cell(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Unadopted asset ${field} must be non-empty text`);
  }
  return value.trim().replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");
}

export function recordUnadoptedAsset(sourceManifestFile, asset) {
  if (typeof sourceManifestFile !== "string" || !path.isAbsolute(sourceManifestFile)) {
    throw new Error("sourceManifestFile must be an absolute path");
  }
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
    throw new Error("An asset record is required");
  }
  const resolved = path.resolve(sourceManifestFile);
  if (path.basename(resolved) !== "source-manifest.md") {
    throw new Error("Unadopted assets must be written to source-manifest.md");
  }
  const status = fs.lstatSync(resolved);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error("source-manifest.md must be a real file");
  }
  const parentStatus = fs.lstatSync(path.dirname(resolved));
  if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink()) {
    throw new Error("source-manifest.md must have a real parent directory");
  }
  if (fs.realpathSync(path.dirname(resolved)) !== path.dirname(resolved)) {
    throw new Error("source-manifest.md parent must use its physical path");
  }

  const values = Object.fromEntries(REQUIRED_FIELDS.map((field) => [field, cell(asset[field], field)]));
  const original = fs.readFileSync(resolved, "utf8");
  if (!original.includes(TABLE_HEADER)) {
    throw new Error("source-manifest.md does not contain the required table");
  }
  const row = `| ${values.name} | ${values.source} | ${values.retrievedAt} | ${values.author} | unclear | ${values.slideUsage} | unadopted |`;
  if (original.split("\n").includes(row)) return resolved;

  const next = `${original.replace(/\s*$/, "\n")}${row}\n`;
  const temporaryFile = `${resolved}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, next, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporaryFile, resolved);
  } catch (error) {
    fs.rmSync(temporaryFile, { force: true });
    throw error;
  }
  return resolved;
}
