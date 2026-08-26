import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("skill is explicit-only", () => {
  const yaml = read("agents/openai.yaml");
  const skill = read("SKILL.md");
  assert.match(yaml, /allow_implicit_invocation:\s*false/);
  assert.match(yaml, /\$sherry-skillforhtml2026/);
  assert.match(skill, /only when the user explicitly/i);
});

test("skill body accepts Sherry's named Skill trigger", () => {
  const body = read("SKILL.md").replace(/^---[\s\S]*?---\s*/, "");
  assert.match(body, /explicitly asks for Sherry's named slide Skill/i);
});

test("skill scaffold has no placeholders", () => {
  const unfinished = ["TO" + "DO", "TB" + "D", "[TO" + "DO"];
  for (const file of ["SKILL.md", "agents/openai.yaml"]) {
    for (const marker of unfinished) assert.ok(!read(file).includes(marker));
  }
});
