import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(scriptDirectory, ".."));
const required = ["SKILL.md", "README.md", "LICENSE", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", ".gitignore", "package.json"];
const bannedPath = /\/Users\/[^/\s]+/;
const skipDirectories = new Set([".git", "node_modules", ".superpowers", "__pycache__"]);
const skipContentChecks = new Set([
  "scripts/check-open-source.mjs",
  "scripts/check-source-hygiene.sh",
  "tests/self-test-contracts.test.mjs",
]);
const failures = [];

for (const relative of required) {
  if (!fs.existsSync(path.join(root, relative))) failures.push(`missing required file: ${relative}`);
}

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (skipDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(absolute);
      continue;
    }
    if (!entry.isFile()) continue;
    const relative = path.relative(root, absolute);
    if (skipContentChecks.has(relative)) continue;
    const content = fs.readFileSync(absolute, "utf8");
    if (bannedPath.test(content)) failures.push(`personal absolute path: ${relative}`);
    if (path.basename(absolute) === ".DS_Store") failures.push(`metadata residue: ${relative}`);
  }
}

visit(root);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("open-source checks passed");
