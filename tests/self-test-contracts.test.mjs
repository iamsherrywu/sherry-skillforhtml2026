import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const selfTest = path.join(root, "scripts", "self-test.sh");
const physicalTemp = fs.realpathSync(os.tmpdir());
const defaultStages = [
  "runtime-validation",
  "source-policy",
  "source-hygiene",
  "official-validation",
  "node-tests",
  "python-tests",
  "style-previews",
  "deck-parity",
  "html-build",
  "html-validation",
  "html-screenshots",
  "html-contact-sheet",
  "pptx-build",
  "pptx-render",
  "pptx-contact-sheet",
];
const releaseStages = [
  "runtime-validation",
  "source-policy",
  "source-hygiene",
  "official-validation",
  "installed-link",
  "installed-policy",
  "installed-validation",
  "clean-git-tree",
  "node-tests",
  "python-tests",
  "style-previews",
  "deck-parity",
  "html-build",
  "html-validation",
  "html-screenshots",
  "html-contact-sheet",
  "pptx-build",
  "pptx-render",
  "pptx-contact-sheet",
  "final-source-policy",
  "final-source-hygiene",
  "final-installed-link",
  "final-installed-policy",
  "final-installed-validation",
  "final-clean-git-tree",
];
const bundledRenderTools = process.env.RENDER_TOOL_PATH || path.join(
  process.env.CODEX_RUNTIME_ROOT || "",
  "bin",
  "override",
);
const bundledPython = process.env.PYTHON3_PATH || process.env.PYTHON || process.env.python3 || "python3";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(physicalTemp, prefix));
}

function runSelfTest(args = [], options = {}) {
  return spawnSync("/bin/bash", [options.script ?? selfTest, ...args], {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
    env: { ...process.env, ...options.env },
  });
}

function copyWorkingRepository(t) {
  const holder = makeTempDir("sherry-self-test-copy-");
  const copy = path.join(holder, "skill");
  fs.cpSync(root, copy, {
    recursive: true,
    filter(source) {
      const relative = path.relative(root, source);
      return relative !== ".superpowers" && !relative.startsWith(`.superpowers${path.sep}`);
    },
  });
  t.after(() => fs.rmSync(holder, { recursive: true, force: true }));
  return { holder, copy };
}

function releaseEnvironment(holder, copy, target) {
  return {
    SELF_TEST_TEMP_ROOT: holder,
    SKILL_INSTALL_TARGET: target,
    CODEX_HOME: process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function commitWorkingCopy(copy) {
  for (const args of [
    ["config", "user.name", "Task 8 Tests"],
    ["config", "user.email", "task-8-tests@example.invalid"],
    ["add", "-A"],
    ["commit", "--allow-empty", "-m", "test fixture checkpoint"],
  ]) {
    const result = spawnSync("git", args, { cwd: copy, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
}

function makeNodeTestMutator(holder, commands) {
  const mutator = path.join(holder, `mutate-${Math.random().toString(16).slice(2)}.sh`);
  const wrapper = path.join(holder, `node-${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(mutator, `#!/bin/bash\nset -eu\n${commands}\n`, { mode: 0o755 });
  fs.writeFileSync(
    wrapper,
    `#!/bin/bash\nif [[ \${1:-} == --test ]]; then ${shellQuote(mutator)}; exit 0; fi\nexec ${shellQuote(process.execPath)} \"$@\"\n`,
    { mode: 0o755 },
  );
  return wrapper;
}

function makeFinalContactSheetMutator(holder, commands) {
  const mutator = path.join(holder, `contact-mutate-${Math.random().toString(16).slice(2)}.sh`);
  const wrapper = path.join(holder, `python-${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(mutator, `#!/bin/bash\nset -eu\n${commands}\n`, { mode: 0o755 });
  fs.writeFileSync(
    wrapper,
    `#!/bin/bash
late=0
for argument in "$@"; do
  [[ $argument == *pptx-contact-sheet.png ]] && late=1
done
${shellQuote(process.env.python3 ?? process.env.PYTHON ?? bundledPython)} "$@"
rc=$?
if [[ $rc -eq 0 && $late -eq 1 ]]; then ${shellQuote(mutator)}; fi
exit "$rc"
`,
    { mode: 0o755 },
  );
  return wrapper;
}

test("self-test lists accurate development and release stages", () => {
  const development = runSelfTest(["--list-stages"]);
  assert.equal(development.status, 0, development.stderr || development.stdout);
  assert.deepEqual(development.stdout.trim().split("\n"), defaultStages);

  const release = runSelfTest(["--release", "--list-stages"]);
  assert.equal(release.status, 0, release.stderr || release.stdout);
  assert.deepEqual(release.stdout.trim().split("\n"), releaseStages);
});

test("release self-test rejects a dangling install target", (t) => {
  const { holder, copy } = copyWorkingRepository(t);
  const target = path.join(holder, "installed-skill");
  fs.symlinkSync(path.join(holder, "missing-source"), target);
  const result = runSelfTest(["--release"], {
    script: path.join(copy, "scripts", "self-test.sh"),
    cwd: copy,
    env: releaseEnvironment(holder, copy, target),
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /FAIL installed-link|dangling install/i);
});

test("release self-test rejects deletion of explicit-only policy", (t) => {
  const { holder, copy } = copyWorkingRepository(t);
  const target = path.join(holder, "installed-skill");
  fs.symlinkSync(copy, target);
  fs.writeFileSync(
    path.join(copy, "agents", "openai.yaml"),
    "interface:\n  display_name: Sherry\n",
    "utf8",
  );
  const result = runSelfTest(["--release"], {
    script: path.join(copy, "scripts", "self-test.sh"),
    cwd: copy,
    env: releaseEnvironment(holder, copy, target),
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /FAIL source-policy|allow_implicit_invocation/i);
});

test("source hygiene rejects markers, empty files, caches, metadata residue, and tracked scratch", async (t) => {
  const cases = [
    ["unfinished marker", (copy) => fs.writeFileSync(path.join(copy, "unfinished.txt"), ["TO", "DO"].join(""))],
    ["empty file", (copy) => fs.writeFileSync(path.join(copy, "empty.txt"), "")],
    ["DS_Store", (copy) => fs.writeFileSync(path.join(copy, ".DS_Store"), "metadata")],
    ["Python cache", (copy) => {
      fs.mkdirSync(path.join(copy, "cache", "__pycache__"), { recursive: true });
      fs.writeFileSync(path.join(copy, "cache", "__pycache__", "module.pyc"), "bytecode");
    }],
    ["tracked scratch", (copy) => {
      const scratch = path.join(copy, ".superpowers", "tracked.txt");
      fs.mkdirSync(path.dirname(scratch), { recursive: true });
      fs.writeFileSync(scratch, "tracked scratch\n");
      const added = spawnSync("git", ["add", "-f", ".superpowers/tracked.txt"], { cwd: copy, encoding: "utf8" });
      assert.equal(added.status, 0, added.stderr);
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, (subtest) => {
      const { holder, copy } = copyWorkingRepository(subtest);
      const target = path.join(holder, "installed-skill");
      fs.symlinkSync(copy, target);
      mutate(copy);
      const result = runSelfTest(["--release"], {
        script: path.join(copy, "scripts", "self-test.sh"),
        cwd: copy,
        env: releaseEnvironment(holder, copy, target),
      });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /FAIL source-hygiene|source hygiene/i);
    });
  }
});

test("source hygiene uses a reliable grep fallback when rg is unavailable", (t) => {
  const { copy } = copyWorkingRepository(t);
  const clean = spawnSync("/bin/bash", [path.join(copy, "scripts", "check-source-hygiene.sh"), copy], {
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin" },
  });
  assert.equal(clean.status, 0, clean.stderr || clean.stdout);

  fs.writeFileSync(path.join(copy, "unfinished-fallback.txt"), ["TO", "DO", "\n"].join(""));
  const dirty = spawnSync("/bin/bash", [path.join(copy, "scripts", "check-source-hygiene.sh"), copy], {
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin" },
  });
  assert.notEqual(dirty.status, 0);
  assert.match(`${dirty.stdout}\n${dirty.stderr}`, /unfinished-fallback|unfinished markers|source hygiene/i);
});

test("runtime validation rejects unresolved Node modules and missing render overrides", (t) => {
  const emptyModules = makeTempDir("sherry-empty-modules-");
  const emptyTools = makeTempDir("sherry-empty-tools-");
  t.after(() => fs.rmSync(emptyModules, { recursive: true, force: true }));
  t.after(() => fs.rmSync(emptyTools, { recursive: true, force: true }));

  const modules = runSelfTest([], {
    env: { NODE_PATH: emptyModules, SELF_TEST_TEMP_ROOT: physicalTemp },
  });
  assert.notEqual(modules.status, 0);
  assert.match(`${modules.stdout}\n${modules.stderr}`, /FAIL runtime-validation.*(?:Playwright|PptxGenJS)|Node modules/i);

  const tools = runSelfTest([], {
    env: { RENDER_TOOL_PATH: emptyTools, SELF_TEST_TEMP_ROOT: physicalTemp },
  });
  assert.notEqual(tools.status, 0);
  assert.match(`${tools.stdout}\n${tools.stderr}`, /FAIL runtime-validation.*(?:soffice|pdftoppm)|render tools/i);
});

test("CODEX_HOME creator override is preferred over machine fallback", (t) => {
  const codexHome = makeTempDir("sherry-codex-home-");
  const validator = path.join(codexHome, "skills", ".system", "skill-creator", "scripts", "quick_validate.py");
  fs.mkdirSync(path.dirname(validator), { recursive: true });
  fs.writeFileSync(validator, "raise SystemExit('CODEX_HOME validator selected')\n", "utf8");
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));

  const result = runSelfTest([], {
    env: { CODEX_HOME: codexHome, SKILL_CREATOR: "", SELF_TEST_TEMP_ROOT: physicalTemp },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /CODEX_HOME validator selected/);
  assert.match(`${result.stdout}\n${result.stderr}`, /FAIL official-validation/);
});

test("release self-test requires a clean Git tree", (t) => {
  const { holder, copy } = copyWorkingRepository(t);
  const target = path.join(holder, "installed-skill");
  fs.symlinkSync(copy, target);
  fs.writeFileSync(path.join(copy, "dirty.txt"), "dirty\n", "utf8");
  const result = runSelfTest(["--release"], {
    script: path.join(copy, "scripts", "self-test.sh"),
    cwd: copy,
    env: releaseEnvironment(holder, copy, target),
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /FAIL clean-git-tree|working tree is not clean/i);
});

test("release rechecks invariants after a successful late stage", async (t) => {
  const cases = [
    {
      name: "policy mutation",
      expected: /FAIL final-source-policy|allow_implicit_invocation/i,
      commands(copy) {
        return `printf 'interface:\\n  display_name: Sherry\\n' > ${shellQuote(path.join(copy, "agents", "openai.yaml"))}`;
      },
    },
    {
      name: "installation mutation",
      expected: /FAIL final-installed-link|installed link/i,
      prepare(holder) {
        const alternate = path.join(holder, "alternate-source");
        fs.mkdirSync(alternate);
        return alternate;
      },
      commands(_copy, target, alternate) {
        return `/bin/rm ${shellQuote(target)}\n/bin/ln -s ${shellQuote(alternate)} ${shellQuote(target)}`;
      },
    },
    {
      name: "residue mutation",
      expected: /FAIL final-source-hygiene|source hygiene/i,
      commands(copy) {
        return `printf residue > ${shellQuote(path.join(copy, "late-stage.pyc"))}`;
      },
    },
    {
      name: "dirty tracked source",
      expected: /FAIL final-clean-git-tree|working tree is not clean/i,
      commands(copy) {
        return `printf '\\nlate-stage mutation\\n' >> ${shellQuote(path.join(copy, "SKILL.md"))}`;
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, (subtest) => {
      const { holder, copy } = copyWorkingRepository(subtest);
      commitWorkingCopy(copy);
      const target = path.join(holder, "installed-skill");
      fs.symlinkSync(copy, target);
      const prepared = fixture.prepare?.(holder);
      const nodeWrapper = makeNodeTestMutator(holder, ":");
      const pythonWrapper = makeFinalContactSheetMutator(
        holder,
        fixture.commands(copy, target, prepared),
      );
      const result = runSelfTest(["--release"], {
        script: path.join(copy, "scripts", "self-test.sh"),
        cwd: copy,
        timeout: 90_000,
        env: {
          ...releaseEnvironment(holder, copy, target),
          node: nodeWrapper,
          python3: pythonWrapper,
        },
      });
      const output = `${result.stdout}\n${result.stderr}`;
      assert.notEqual(result.status, 0, output);
      assert.match(output, /PASS node-tests/, output);
      assert.match(output, /PASS pptx-contact-sheet/, output);
      assert.match(output, fixture.expected, output);
    });
  }
});

test("render stages keep using the exact tools approved at runtime", (t) => {
  const holder = makeTempDir("sherry-pinned-render-");
  t.after(() => fs.rmSync(holder, { recursive: true, force: true }));
  const toolPath = path.join(holder, "discovered-tools");
  const alternatePath = path.join(holder, "alternate-tools");
  fs.mkdirSync(toolPath);
  fs.mkdirSync(alternatePath);
  for (const name of ["soffice", "pdftoppm"]) {
    const approved = path.join(bundledRenderTools, name);
    assert.equal(fs.existsSync(approved), true, `missing bundled ${name}`);
    fs.symlinkSync(approved, path.join(toolPath, name));
    fs.writeFileSync(
      path.join(alternatePath, name),
      `#!/bin/bash\nprintf '%s\\n' ${name} >> ${shellQuote(path.join(holder, "alternate-used.log"))}\nexit 88\n`,
      { mode: 0o755 },
    );
  }
  const commands = ["soffice", "pdftoppm"].map((name) => (
    `/bin/rm ${shellQuote(path.join(toolPath, name))}\n/bin/ln -s ${shellQuote(path.join(alternatePath, name))} ${shellQuote(path.join(toolPath, name))}`
  )).join("\n");
  const nodeWrapper = makeNodeTestMutator(holder, commands);
  const result = runSelfTest([], {
    timeout: 90_000,
    env: {
      SELF_TEST_TEMP_ROOT: holder,
      RENDER_TOOL_PATH: toolPath,
      node: nodeWrapper,
      PATH: `${alternatePath}${path.delimiter}${process.env.PATH}`,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS pptx-render/);
  assert.equal(fs.existsSync(path.join(holder, "alternate-used.log")), false);
  const selfTestSource = fs.readFileSync(selfTest, "utf8");
  assert.match(selfTestSource, /PATH="\$run_bin\$\{PATH:\+:\$PATH\}"/);
  assert.doesNotMatch(selfTestSource, /PATH="\$tool_path:\$PATH"/);
});

test("render stage rejects an approved target that stops being executable", (t) => {
  const holder = makeTempDir("sherry-render-executable-");
  t.after(() => fs.rmSync(holder, { recursive: true, force: true }));
  const toolPath = path.join(holder, "approved-tools");
  fs.mkdirSync(toolPath);
  for (const name of ["soffice", "pdftoppm"]) {
    fs.writeFileSync(
      path.join(toolPath, name),
      `#!/bin/bash\nexec ${shellQuote(path.join(bundledRenderTools, name))} \"$@\"\n`,
      { mode: 0o755 },
    );
  }
  const nodeWrapper = makeNodeTestMutator(
    holder,
    `/bin/chmod 600 ${shellQuote(path.join(toolPath, "soffice"))}`,
  );
  const result = runSelfTest([], {
    timeout: 90_000,
    env: {
      SELF_TEST_TEMP_ROOT: holder,
      RENDER_TOOL_PATH: toolPath,
      node: nodeWrapper,
    },
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /PASS pptx-build/, output);
  assert.match(output, /render tools are no longer executable|FAIL pptx-render/i, output);
});

test("TERM cleans the physical work root and exits with signal status", async (t) => {
  const holder = makeTempDir("sherry-signal-");
  const fakeNode = path.join(holder, "node");
  fs.writeFileSync(
    fakeNode,
    "#!/bin/bash\nif [[ $1 == '-e' ]]; then exit 0; fi\nsleep 2\n",
    { encoding: "utf8", mode: 0o755 },
  );
  t.after(() => fs.rmSync(holder, { recursive: true, force: true }));

  const child = spawn("/bin/bash", [selfTest], {
    cwd: root,
    env: {
      ...process.env,
      node: fakeNode,
      SELF_TEST_TEMP_ROOT: holder,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (/RUN  node-tests/.test(output)) child.kill("SIGTERM");
  });
  child.stderr.on("data", (chunk) => { output += chunk; });

  const result = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, signal: "TIMEOUT" });
    }, 5_000);
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
  assert.deepEqual(result, { code: 143, signal: null }, output);
  assert.deepEqual(fs.readdirSync(holder), ["node"]);
});
