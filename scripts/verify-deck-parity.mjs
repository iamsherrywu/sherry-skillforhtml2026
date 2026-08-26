import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { verifyProjectDeckParity } from "./build-single-html.mjs";

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = {
      "--project": "projectDir",
      "--model": "modelFile",
      "--manifest": "manifestFile",
    }[argv[index]];
    if (!key || index + 1 >= argv.length || parsed[key]) {
      throw new Error(`Unknown, duplicate, or incomplete argument: ${argv[index]}`);
    }
    parsed[key] = argv[index + 1];
    index += 1;
  }
  if (!parsed.projectDir) {
    throw new Error("Usage: node scripts/verify-deck-parity.mjs --project /path/to/project [--model /path/to/deck-model.json] [--manifest /path/to/parity-manifest.json]");
  }
  return parsed;
}

function writeManifest(file, manifest) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, resolved);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return resolved;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const manifest = verifyProjectDeckParity(args);
    const manifestFile = args.manifestFile ? writeManifest(args.manifestFile, manifest) : null;
    process.stdout.write(`${JSON.stringify({ ...manifest, manifestFile })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
