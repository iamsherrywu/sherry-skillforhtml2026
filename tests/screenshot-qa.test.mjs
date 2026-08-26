import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildSingleHtml } from "../scripts/build-single-html.mjs";
import { renderDeck } from "../scripts/render-screenshots.mjs";

const fixtureProject = fileURLToPath(new URL("fixtures/html-project", import.meta.url));
const renderScript = fileURLToPath(new URL("../scripts/render-screenshots.mjs", import.meta.url));
const bundledNodeModules = process.env.NODE_PATH || path.join(root, "node_modules");

function makeTempDir() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sherry-screenshots-"));
}

function pngDimensions(file) {
  const png = fs.readFileSync(file);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function writeDeck(root, slides, { apiIds = slides.map(({ id }) => id), showHook = "" } = {}) {
  const htmlFile = path.join(root, "deck.html");
  const sections = slides.map(({ id, content = "", style = "" }) => (
    `<section class="slide" id="${id}" style="${style}">${content}</section>`
  )).join("\n");
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #111; }
#stage { position: relative; width: 1280px; height: 720px; overflow: hidden; }
.slide { position: absolute; inset: 0; width: 1280px; height: 720px; overflow: hidden; visibility: hidden; background: #111; }
.slide.active { visibility: visible; }
</style></head><body><main id="stage">${sections}</main><script>
const slides = Array.from(document.querySelectorAll(".slide"));
const apiIds = ${JSON.stringify(apiIds)};
function show(id) {
  slides.forEach((slide) => slide.classList.toggle("active", slide.id === id));
  ${showHook}
  return id;
}
window.__sherryDeck = { show, slideIds: () => apiIds };
show(apiIds[0]);
</script></body></html>`;
  fs.writeFileSync(htmlFile, html);
  return htmlFile;
}

test("renderDeck captures the fixture slides at 1280 by 720 in deck order", async () => {
  const root = makeTempDir();
  const htmlFile = path.join(root, "deck.html");
  const outputDir = path.join(root, "pages");
  buildSingleHtml({ projectDir: fixtureProject, outputFile: htmlFile });

  const diagnostics = await renderDeck({ htmlFile, outputDir });

  assert.deepEqual(diagnostics.map(({ id }) => id), ["p01", "p02", "p03"]);
  for (const diagnostic of diagnostics) {
    assert.equal(path.isAbsolute(diagnostic.screenshot), true);
    assert.deepEqual(pngDimensions(diagnostic.screenshot), { width: 1280, height: 720 });
    assert.deepEqual(diagnostic.overflow, []);
    assert.equal(typeof diagnostic.blankRatio, "number");
    assert.deepEqual(diagnostic.imageFailures, []);
  }
  assert.deepEqual(
    diagnostics.map(({ screenshot }) => path.basename(screenshot)),
    ["p01.png", "p02.png", "p03.png"],
  );
});

test("renderDeck names screenshots from safe unique slide IDs", async () => {
  const root = makeTempDir();
  const htmlFile = writeDeck(root, [{ id: "chapter_01", content: "<p>Custom ID</p>" }]);
  const diagnostics = await renderDeck({ htmlFile, outputDir: path.join(root, "pages") });
  assert.equal(path.basename(diagnostics[0].screenshot), "chapter_01.png");

  const duplicate = writeDeck(root, [{ id: "p01" }], { apiIds: ["p01", "p01"] });
  await assert.rejects(
    renderDeck({ htmlFile: duplicate, outputDir: path.join(root, "duplicate-pages") }),
    /duplicate slide ID/i,
  );

  const unsafe = writeDeck(root, [{ id: "p01" }], { apiIds: ["../outside"] });
  await assert.rejects(
    renderDeck({ htmlFile: unsafe, outputDir: path.join(root, "unsafe-pages") }),
    /safe.*slide ID|unsafe.*slide ID/i,
  );
});

test("renderDeck cleans only manifest-owned PNGs and preserves every unowned PNG", async () => {
  const root = makeTempDir();
  const outputDir = path.join(root, "pages");
  const outside = path.join(root, "outside.png");
  fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, "owned-stale.png"), "owned");
  fs.writeFileSync(path.join(outputDir, "unowned.png"), "unowned");
  fs.writeFileSync(path.join(outputDir, "keep.txt"), "keep");
  fs.writeFileSync(outside, "outside");
  fs.symlinkSync(outside, path.join(outputDir, "linked.png"));
  fs.writeFileSync(
    path.join(outputDir, ".sherry-screenshot-manifest.json"),
    `${JSON.stringify({ version: 1, files: ["owned-stale.png"] })}\n`,
  );

  const htmlFile = writeDeck(root, [{ id: "fresh", content: "<p>Fresh</p>" }]);
  await renderDeck({ htmlFile, outputDir });

  assert.equal(fs.existsSync(path.join(outputDir, "owned-stale.png")), false);
  assert.equal(fs.readFileSync(path.join(outputDir, "unowned.png"), "utf8"), "unowned");
  assert.equal(fs.lstatSync(path.join(outputDir, "linked.png")).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(outputDir, "keep.txt"), "utf8"), "keep");
  assert.equal(fs.readFileSync(outside, "utf8"), "outside");
  assert.equal(fs.existsSync(path.join(outputDir, "fresh.png")), true);
  const manifest = JSON.parse(fs.readFileSync(
    path.join(outputDir, ".sherry-screenshot-manifest.json"),
    "utf8",
  ));
  assert.deepEqual(manifest.files, ["fresh.png"]);
});

test("renderDeck refuses unowned filename collisions and output outside the project scope", async () => {
  const root = makeTempDir();
  const htmlFile = writeDeck(root, [{ id: "fresh", content: "<p>Fresh</p>" }]);
  const outputDir = path.join(root, "pages");
  fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, "fresh.png"), "unowned");

  await assert.rejects(
    renderDeck({ htmlFile, outputDir }),
    /unowned|refusing to overwrite|not owned/i,
  );
  assert.equal(fs.readFileSync(path.join(outputDir, "fresh.png"), "utf8"), "unowned");

  await assert.rejects(
    renderDeck({ htmlFile, outputDir: path.join(makeTempDir(), "outside") }),
    /project scope|outside.*project|output.*scope/i,
  );
});

test("renderDeck rejects a symlinked output ancestor before cleaning external PNGs", async () => {
  const root = makeTempDir();
  const external = path.join(root, "external");
  const outputParent = path.join(root, "work");
  const sentinel = path.join(external, "pages", "sentinel.png");
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.mkdirSync(outputParent);
  fs.writeFileSync(sentinel, "external");
  fs.symlinkSync(external, path.join(outputParent, "link"));
  const htmlFile = writeDeck(root, [{ id: "safe", content: "<p>Safe</p>" }]);

  const result = await renderDeck({ htmlFile, outputDir: path.join(outputParent, "link", "pages") })
    .then(() => ({ error: null }), (error) => ({ error }));

  assert.equal(fs.readFileSync(sentinel, "utf8"), "external");
  assert.match(result.error?.message ?? "", /symlink.*ancestor|symlinked.*path/i);
});

test("renderDeck waits for show-triggered images and reports broken ones", async () => {
  const root = makeTempDir();
  const validImage = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='%23fff'/%3E%3C/svg%3E";
  const htmlFile = writeDeck(root, [
    { id: "lazy", content: "<img id='lazy-image' alt='lazy'>" },
    { id: "broken", content: "<img id='broken-image' alt='broken'>" },
  ], {
    showHook: `if (id === "lazy") document.getElementById("lazy-image").src = ${JSON.stringify(validImage)};
      if (id === "broken") document.getElementById("broken-image").src = "data:image/png;base64,broken";`,
  });

  const diagnostics = await renderDeck({ htmlFile, outputDir: path.join(root, "pages") });
  assert.deepEqual(diagnostics[0].imageFailures, []);
  assert.equal(diagnostics[1].imageFailures[0].selector, "img#broken-image");
});

test("renderDeck reports Task 5 clipping semantics and fully blank slides", async () => {
  const root = makeTempDir();
  const image = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3C/svg%3E";
  const htmlFile = writeDeck(root, [
    {
      id: "clipped",
      content: `<img id="visual" src="${image}" style="position:absolute;left:-100px;width:1400px;height:20px;max-width:none;max-height:none">
        <div id="allowed" data-allow-clipping style="position:absolute;left:1270px;top:40px;width:30px;height:30px">allowed</div>
        <div id="generic" style="position:absolute;left:1270px;top:80px;width:30px;height:30px">clipped</div>`,
    },
    {
      id: "overflow",
      style: "overflow:visible",
      content: "<div id='visible-overflow' style='position:absolute;left:1282px;width:20px;height:20px'>overflow</div>",
    },
    { id: "blank" },
  ]);

  const diagnostics = await renderDeck({ htmlFile, outputDir: path.join(root, "pages") });
  assert.deepEqual(diagnostics[0].overflow, []);
  assert.ok(diagnostics[0].clipped.some(({ selector }) => /generic/.test(selector)));
  assert.equal(diagnostics[0].clipped.some(({ selector }) => /visual/.test(selector)), false);
  assert.equal(diagnostics[0].clipped.some(({ selector }) => /allowed/.test(selector)), false);
  assert.ok(diagnostics[1].overflow.some(({ selector }) => /visible-overflow/.test(selector)));
  assert.equal(diagnostics[2].blank, true);
  assert.equal(diagnostics[2].blankRatio, 1);
});

test("render-screenshots CLI exits nonzero for clipping, blank slides, and image failures", () => {
  const root = makeTempDir();
  const htmlFile = writeDeck(root, [
    {
      id: "clipped",
      content: "<div style='position:absolute;left:1275px;width:30px'>clipped</div>",
    },
    {
      id: "broken",
      content: "<img id='broken-image' src='data:image/png;base64,broken' alt='broken'>",
    },
    { id: "blank" },
  ]);
  const result = spawnSync(process.execPath, [
    renderScript,
    "--html", htmlFile,
    "--output", path.join(root, "pages"),
    "--project", root,
  ], {
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: process.env.NODE_PATH ?? bundledNodeModules },
  });

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /clipped|blank|image/i);
  const diagnostics = JSON.parse(result.stdout);
  assert.equal(diagnostics.length, 3);
});

test("renderDeck rejects offline requests triggered by a visible slide", async () => {
  const root = makeTempDir();
  const htmlFile = writeDeck(root, [{ id: "offline", content: "<img id='remote' alt='remote'>" }], {
    showHook: 'document.getElementById("remote").src = "https://example.invalid/blocked.png";',
  });

  await assert.rejects(
    renderDeck({ htmlFile, outputDir: path.join(root, "pages") }),
    /offline request blocked/i,
  );
});
