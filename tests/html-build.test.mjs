import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildSingleHtml, tokenizeHtml } from "../scripts/build-single-html.mjs";
import { launchPreviewBrowser } from "../scripts/generate-style-previews.mjs";
import { validateHtml } from "../scripts/validate-html.mjs";

const fixtureProject = fileURLToPath(new URL("fixtures/html-project", import.meta.url));
const require = createRequire(import.meta.url);

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sherry-html-"));
}

function copyFixture() {
  const root = makeTempDir();
  const projectDir = path.join(root, "project");
  fs.cpSync(fixtureProject, projectDir, { recursive: true });
  return projectDir;
}

function buildFixture(projectDir = fixtureProject) {
  const outputFile = path.join(makeTempDir(), "deck.html");
  return {
    outputFile,
    result: buildSingleHtml({ projectDir, outputFile }),
  };
}

function writeChapter(projectDir, html) {
  fs.writeFileSync(path.join(projectDir, "slides", "chapter-02.html"), `${html}\n`);
}

test("buildSingleHtml creates one deterministic offline deck in source order", () => {
  const first = buildFixture();
  const second = buildFixture();
  const html = fs.readFileSync(first.outputFile, "utf8");

  assert.deepEqual(first.result.slideIds, ["p01", "p02", "p03"]);
  assert.deepEqual(first.result.embeddedAssets, ["materials/pixel.png"]);
  assert.equal(first.result.outputFile, first.outputFile);
  assert.equal((html.match(/<section\b[^>]*\bclass=["'][^"']*\bslide\b[^"']*["']/g) ?? []).length, 3);
  assert.ok(html.indexOf('id="p01"') < html.indexOf('id="p02"'));
  assert.ok(html.indexOf('id="p02"') < html.indexOf('id="p03"'));
  assert.match(html, /--primary:\s*#1677ff/);
  assert.match(html, /\.chapter-accent\s*\{/);
  assert.match(html, /#deck-stage/);
  assert.match(html, /data:image\/png;base64,/);
  assert.doesNotMatch(html, /speaker-notes?|https?:\/\//i);
  assert.equal(html, fs.readFileSync(second.outputFile, "utf8"));
});

test("built deck exposes keyboard, touch, fullscreen, scaling, and hash navigation", () => {
  const { outputFile } = buildFixture();
  const html = fs.readFileSync(outputFile, "utf8");

  for (const contract of [
    /window\.__sherryDeck/,
    /keydown/,
    /touchstart/,
    /requestFullscreen/,
    /transform/,
    /hashchange/,
  ]) {
    assert.match(html, contract);
  }
});

test("built deck includes a restrictive offline content security policy", () => {
  const { outputFile } = buildFixture();
  const html = fs.readFileSync(outputFile, "utf8");

  assert.match(html, /http-equiv="Content-Security-Policy"/i);
  for (const directive of [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "connect-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
  ]) {
    assert.match(html, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("buildSingleHtml rejects executable attributes in controlled chapters", () => {
  for (const attribute of ['onclick="alert(1)"', 'srcdoc="<p>active</p>"']) {
    const projectDir = copyFixture();
    writeChapter(projectDir, `<section class="slide" id="p03"><div ${attribute}>unsafe</div></section>`);
    assert.throws(() => buildFixture(projectDir), /unsafe attribute|event handler|srcdoc/i);
  }
});

test("buildSingleHtml rejects active document and embedded-content elements", () => {
  for (const element of [
    '<iframe src="data:text/html,active"></iframe>',
    '<frame src="data:text/html,active">',
    '<object data="data:text/html,active"></object>',
    '<embed src="data:text/html,active">',
  ]) {
    const projectDir = copyFixture();
    writeChapter(projectDir, `<section class="slide" id="p03">${element}</section>`);
    assert.throws(() => buildFixture(projectDir), /active element|not allowed|iframe|frame|object|embed/i);
  }
});

test("buildSingleHtml rejects executable data URIs and preserves image and font data URIs", () => {
  const projectDir = copyFixture();
  writeChapter(projectDir, `
<style data-chapter-css>
@font-face { font-family: Fixture; src: url(data:font/woff2;base64,d09GMg==); }
</style>
<section class="slide" id="p03"><img src="data:image/png;base64,iVBORw0KGgo=" alt="safe"></section>`);
  const safe = buildFixture(projectDir);
  const safeHtml = fs.readFileSync(safe.outputFile, "utf8");
  assert.match(safeHtml, /data:image\/png;base64,iVBORw0KGgo=/);
  assert.match(safeHtml, /data:font\/woff2;base64,d09GMg==/);

  writeChapter(projectDir, '<section class="slide" id="p03"><img src="data:text/html;base64,PGgxPmFjdGl2ZTwvaDE+" alt="unsafe"></section>');
  assert.throws(() => buildFixture(projectDir), /unsafe data URI|image data URI/i);
});

test("inline style asset embedding preserves quoted HTML attributes", () => {
  const projectDir = copyFixture();
  writeChapter(projectDir, `
<section class="slide" id="p03">
  <div id="inline-asset" style="background-image: url('../materials/pixel.png')" data-marker="kept"></div>
</section>`);
  const { outputFile } = buildFixture(projectDir);
  const html = fs.readFileSync(outputFile, "utf8");
  const token = tokenizeHtml(html, outputFile).find(
    (candidate) => candidate.type === "open" && candidate.attributes.get("id")?.value === "inline-asset",
  );

  assert.equal(token?.attributes.get("data-marker")?.value, "kept");
  assert.match(token?.attributes.get("style")?.value ?? "", /url\(data:image\/png;base64,[A-Za-z0-9+/=]+\)/);
});

test("resource policy embeds xlink image references and rejects unresolved object data", async () => {
  const projectDir = copyFixture();
  writeChapter(projectDir, `
<section class="slide" id="p03">
  <svg viewBox="0 0 10 10"><image id="svg-image" xlink:href="../materials/pixel.png" width="10" height="10"></image></svg>
</section>`);
  const { outputFile } = buildFixture(projectDir);
  const html = fs.readFileSync(outputFile, "utf8");
  assert.match(html, /xlink:href="data:image\/png;base64,/);

  fs.writeFileSync(
    outputFile,
    html.replace('</section>\n    </main>', '<object data="./payload.html"></object></section>\n    </main>'),
  );
  const diagnostics = await validateHtml(outputFile);
  assert.equal(diagnostics.ok, false);
  assert.ok(diagnostics.errors.some((error) => /object|data URI|resource/i.test(error)));
});

test("resource policy rejects ambiguous data payloads and external SVG use references", async () => {
  const projectDir = copyFixture();
  writeChapter(
    projectDir,
    '<section class="slide" id="p03"><svg><use xlink:href="../materials/pixel.png"></use></svg></section>',
  );
  assert.throws(() => buildFixture(projectDir), /external SVG use|fragment reference|not supported/i);

  writeChapter(
    projectDir,
    '<section class="slide" id="p03"><img src="data:image/png;base64,AAAA,../materials/pixel.png" alt="ambiguous"></section>',
  );
  assert.throws(() => buildFixture(projectDir), /malformed|unsafe data URI|base64/i);

  const { outputFile } = buildFixture();
  const html = fs.readFileSync(outputFile, "utf8").replace(
    '<section class="slide slide--statement" id="p03">',
    '<section class="slide slide--statement" id="p03"><img srcset="data:image/png;base64,AAAA, ./local.png 2x" alt="ambiguous">',
  );
  fs.writeFileSync(outputFile, html);
  const diagnostics = await validateHtml(outputFile);
  assert.equal(diagnostics.ok, false);
  assert.ok(diagnostics.errors.some((error) => /srcset|data URI|base64|resource/i.test(error)));
});

test("controlled chapters reject slide-local style elements", () => {
  const projectDir = copyFixture();
  writeChapter(
    projectDir,
    '<section class="slide" id="p03"><style>.local { color: red; }</style><p class="local">unsafe</p></section>',
  );
  assert.throws(() => buildFixture(projectDir), /style.*inside|slide-local style|top-level chapter style/i);
});

test("SVG presentation URL attributes preserve fragments and reject unresolved forms", () => {
  const projectDir = copyFixture();
  writeChapter(projectDir, `
<section class="slide" id="p03">
  <svg viewBox="0 0 20 20">
    <defs><linearGradient id="paint"><stop offset="0" stop-color="#fff"></stop></linearGradient></defs>
    <rect width="20" height="20" fill="url(#paint)" stroke="#111" clip-path="url(#clip)"></rect>
  </svg>
</section>`);
  const { outputFile } = buildFixture(projectDir);
  const html = fs.readFileSync(outputFile, "utf8");
  assert.match(html, /fill="url\(#paint\)"/);
  assert.match(html, /clip-path="url\(#clip\)"/);

  for (const attribute of [
    'filter="url(../materials/pixel.png)"',
    'mask="url(https://example.invalid/mask.svg#mask)"',
    'marker-end="url(data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)"',
  ]) {
    writeChapter(
      projectDir,
      `<section class="slide" id="p03"><svg><path ${attribute} d="M0 0L1 1"></path></svg></section>`,
    );
    assert.throws(() => buildFixture(projectDir), /SVG presentation|same-document|resource.*attribute|not supported/i);
  }
});

test("SVG presentation URL attributes reject CSS-escaped resource tokens", async () => {
  const escapedFilter = String.raw`u\72l(../materials/pixel.png#filter)`;
  const projectDir = copyFixture();
  writeChapter(
    projectDir,
    `<section class="slide" id="p03"><svg><path filter="${escapedFilter}" d="M0 0L1 1"></path></svg></section>`,
  );
  assert.throws(() => buildFixture(projectDir), /CSS escape|backslash|SVG presentation/i);

  const { outputFile } = buildFixture();
  const html = fs.readFileSync(outputFile, "utf8").replace(
    '<section class="slide slide--statement" id="p03">',
    `<section class="slide slide--statement" id="p03"><svg><path filter="${escapedFilter}" d="M0 0L1 1"></path></svg>`,
  );
  fs.writeFileSync(outputFile, html);
  const diagnostics = await validateHtml(outputFile);
  assert.equal(diagnostics.ok, false);
  assert.ok(diagnostics.errors.some((error) => /CSS escape|backslash|SVG presentation/i.test(error)));
});

test("SVG presentation URL attributes reject character-reference encoded CSS escapes", async () => {
  const escapedFilter = "u&#92;72l(../materials/pixel.png#filter)";
  const projectDir = copyFixture();
  writeChapter(
    projectDir,
    `<section class="slide" id="p03"><svg><path filter="${escapedFilter}" d="M0 0L1 1"></path></svg></section>`,
  );
  assert.throws(() => buildFixture(projectDir), /character reference|entity|CSS escape|SVG presentation/i);

  const { outputFile } = buildFixture();
  const html = fs.readFileSync(outputFile, "utf8").replace(
    '<section class="slide slide--statement" id="p03">',
    `<section class="slide slide--statement" id="p03"><svg><path filter="${escapedFilter}" d="M0 0L1 1"></path></svg>`,
  );
  fs.writeFileSync(outputFile, html);
  const diagnostics = await validateHtml(outputFile);
  assert.equal(diagnostics.ok, false);
  assert.ok(diagnostics.errors.some((error) => /character reference|entity|CSS escape|SVG presentation/i.test(error)));
});

test("validateHtml rejects slide-local styles and unresolved SVG presentation URLs", async () => {
  for (const injected of [
    '<style>.slide-local { color: red; }</style>',
    '<svg><rect filter="url(./filters.svg#blur)" width="10" height="10"></rect></svg>',
  ]) {
    const { outputFile } = buildFixture();
    const html = fs.readFileSync(outputFile, "utf8").replace(
      '<section class="slide slide--statement" id="p03">',
      `<section class="slide slide--statement" id="p03">${injected}`,
    );
    fs.writeFileSync(outputFile, html);
    const diagnostics = await validateHtml(outputFile);
    assert.equal(diagnostics.ok, false);
    assert.ok(diagnostics.errors.some((error) => /slide-local style|SVG presentation|resource/i.test(error)));
  }
});

test("buildSingleHtml rejects duplicate slide IDs", () => {
  const projectDir = copyFixture();
  const chapter = path.join(projectDir, "slides", "chapter-02.html");
  fs.writeFileSync(chapter, fs.readFileSync(chapter, "utf8").replace('id="p03"', 'id="p02"'));

  assert.throws(
    () => buildFixture(projectDir),
    /duplicate slide id.*p02/i,
  );
});

test("buildSingleHtml rejects missing local assets", () => {
  const projectDir = copyFixture();
  fs.rmSync(path.join(projectDir, "materials", "pixel.png"));

  assert.throws(
    () => buildFixture(projectDir),
    /missing local asset.*pixel\.png/i,
  );
});

test("buildSingleHtml rejects local asset traversal outside the project", () => {
  const projectDir = copyFixture();
  const chapter = path.join(projectDir, "slides", "chapter-01.html");
  fs.writeFileSync(
    chapter,
    fs.readFileSync(chapter, "utf8").replace("../materials/pixel.png", "../../../outside.png"),
  );

  assert.throws(
    () => buildFixture(projectDir),
    /unsafe asset path|outside the allowed root/i,
  );
});

test("buildSingleHtml rejects nested slide sections", () => {
  const projectDir = copyFixture();
  const chapter = path.join(projectDir, "slides", "chapter-02.html");
  fs.writeFileSync(
    chapter,
    '<section class="slide" id="p03"><section class="slide" id="p04"></section></section>\n',
  );

  assert.throws(
    () => buildFixture(projectDir),
    /nested slide section/i,
  );
});

test("buildSingleHtml rejects self-closing nested slide sections", () => {
  const projectDir = copyFixture();
  writeChapter(
    projectDir,
    '<section class="slide" id="p03"><section class="slide" id="p04"/></section>',
  );

  assert.throws(() => buildFixture(projectDir), /nested slide section|self-closing slide/i);
});

test("buildSingleHtml rejects malformed controlled chapters", () => {
  const projectDir = copyFixture();
  const chapter = path.join(projectDir, "slides", "chapter-02.html");
  fs.writeFileSync(chapter, '<section class="slide" id="p03"><h2>Unclosed</h2>\n');

  assert.throws(
    () => buildFixture(projectDir),
    /malformed chapter|unclosed slide section/i,
  );
});

test("selected style resolution rejects theme symlinks outside the style root", async () => {
  const module = await import("../scripts/build-single-html.mjs");
  assert.equal(typeof module.resolveSelectedStyleFile, "function");
  const root = makeTempDir();
  const styleRoot = path.join(root, "style-pool");
  const styleDir = path.join(styleRoot, "escape");
  const outside = path.join(root, "outside.css");
  fs.mkdirSync(styleDir, { recursive: true });
  fs.writeFileSync(outside, ":root { color: red; }\n");
  fs.writeFileSync(
    path.join(styleRoot, "registry.json"),
    JSON.stringify({ styles: [{ id: "escape", theme: "escape/theme.css" }] }),
  );
  fs.symlinkSync(outside, path.join(styleDir, "theme.css"));

  assert.throws(
    () => module.resolveSelectedStyleFile("escape", styleRoot),
    /outside.*style root|symlink|unsafe/i,
  );
});

test("chapter ordering has a deterministic total tie-breaker", async () => {
  const module = await import("../scripts/build-single-html.mjs");
  assert.equal(typeof module.compareChapterPaths, "function");
  const left = "/project/slides/chapter-2.html";
  const right = "/project/slides/chapter-02.html";
  assert.notEqual(module.compareChapterPaths(left, right), 0);
  assert.equal(
    [left, right].sort(module.compareChapterPaths).join("\n"),
    [right, left].join("\n"),
  );
});

test("atomic output temp names are collision resistant within one process", async () => {
  const module = await import("../scripts/build-single-html.mjs");
  assert.equal(typeof module.atomicTempFile, "function");
  const output = path.join(makeTempDir(), "deck.html");
  assert.notEqual(module.atomicTempFile(output), module.atomicTempFile(output));
});

test("validateHtml accepts the fixture deck after static and browser checks", async () => {
  const { outputFile } = buildFixture();
  const diagnostics = await validateHtml(outputFile);

  assert.deepEqual(diagnostics, {
    ok: true,
    slideCount: 3,
    errors: [],
    warnings: [],
  });
});

test("validateHtml reports elements beyond the one-pixel overflow tolerance", async () => {
  const { outputFile } = buildFixture();
  const html = fs.readFileSync(outputFile, "utf8").replace(
    '<section class="slide slide--statement" id="p03">',
    '<section class="slide slide--statement" id="p03" style="overflow:visible"><div style="position:absolute;left:1282px;top:0;width:10px;height:10px">overflow</div>',
  );
  fs.writeFileSync(outputFile, html);

  const diagnostics = await validateHtml(outputFile);
  assert.equal(diagnostics.ok, false);
  assert.equal(diagnostics.slideCount, 3);
  assert.ok(diagnostics.errors.some((error) => /p03.*overflow/i.test(error)));
});

test("validateHtml allows intentional visual-media crops but fails generic slide-clipped content", async () => {
  const { outputFile } = buildFixture();
  const html = fs.readFileSync(outputFile, "utf8");
  const imageData = html.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/)?.[0];
  assert.ok(imageData);
  fs.writeFileSync(
    outputFile,
    html.replace(
      '<section class="slide slide--statement" id="p03">',
      `<section class="slide slide--statement" id="p03">
        <img id="full-bleed" src="${imageData}" alt="cropped" style="position:absolute;left:-100px;top:0;width:1400px;height:720px;max-width:none;max-height:none">
        <svg id="full-bleed-svg" viewBox="0 0 1400 50" style="position:absolute;left:-100px;top:0;width:1400px;height:50px;max-width:none">
          <rect id="svg-visual-child" width="1400" height="50" fill="#fff"></rect>
        </svg>
        <div id="generic-clipped" style="position:absolute;left:1270px;top:100px;width:30px;height:30px">clipped</div>`,
    ),
  );

  const diagnostics = await validateHtml(outputFile);
  assert.equal(diagnostics.ok, false);
  assert.ok(diagnostics.errors.some((error) => /p03.*clipped.*generic-clipped/i.test(error)));
  assert.equal(diagnostics.errors.some((error) => /full-bleed/i.test(error)), false);
  assert.equal(diagnostics.errors.some((error) => /svg-visual-child/i.test(error)), false);
});

test("validateHtml fails ancestor-clipped text while ignoring animation-only geometry", async () => {
  const { outputFile } = buildFixture();
  const html = fs.readFileSync(outputFile, "utf8")
    .replace(
      "</style>",
      "@keyframes escape { from { transform: translateX(2000px); } to { transform: translateX(2000px); } }\n</style>",
    )
    .replace(
      '<section class="slide slide--statement" id="p03">',
      `<section class="slide slide--statement" id="p03">
      <div style="position:absolute;left:1270px;top:0;width:10px;height:20px;overflow:hidden">
        <span style="display:block;width:100px;height:10px">clipped</span>
      </div>
      <div id="animated" style="width:20px;height:20px;animation:escape 1s infinite">animated</div>`,
    );
  fs.writeFileSync(outputFile, html);

  const diagnostics = await validateHtml(outputFile);
  assert.equal(diagnostics.ok, false);
  assert.equal(diagnostics.slideCount, 3);
  assert.ok(diagnostics.errors.some((error) => /p03.*clipped.*span/i.test(error)));
  assert.equal(diagnostics.errors.some((error) => /animated/i.test(error)), false);
});

test("validateHtml fails text truncated inside an overflow-hidden box", async () => {
  const { outputFile } = buildFixture();
  const html = fs.readFileSync(outputFile, "utf8").replace(
    '<section class="slide slide--statement" id="p03">',
    `<section class="slide slide--statement" id="p03">
      <div id="truncated-copy" style="width:40px;height:18px;overflow:hidden;white-space:nowrap">This sentence cannot fit.</div>`,
  );
  fs.writeFileSync(outputFile, html);

  const diagnostics = await validateHtml(outputFile);
  assert.equal(diagnostics.ok, false);
  assert.ok(diagnostics.errors.some((error) => /p03.*clipped.*truncated-copy|internal.*clipping/i.test(error)));
});

test("validateHtml returns diagnostics when the browser deck API is structurally broken", async () => {
  const { outputFile } = buildFixture();
  const html = fs.readFileSync(outputFile, "utf8").replace(
    "window.__sherryDeck = { show, next, previous, fit, currentId, slideIds };",
    "window.__sherryDeck = { show: null, next, previous, fit, currentId, slideIds };",
  );
  fs.writeFileSync(outputFile, html);

  const diagnostics = await validateHtml(outputFile);
  assert.equal(diagnostics.ok, false);
  assert.equal(diagnostics.slideCount, 3);
  assert.ok(diagnostics.errors.some((error) => /deck API.*show|show.*function/i.test(error)));
});

test("validateHtml rejects network APIs and missing offline CSP", async () => {
  const { outputFile } = buildFixture();
  const html = fs.readFileSync(outputFile, "utf8");
  const withNetworkApi = html.replace(
    "</body>",
    '<script>new WebSocket("ws:" + "//127.0.0.1:9"); fetch("ftp:" + "//example.invalid");</script></body>',
  );
  fs.writeFileSync(outputFile, withNetworkApi);
  const networkDiagnostics = await validateHtml(outputFile);
  assert.equal(networkDiagnostics.ok, false);
  assert.ok(networkDiagnostics.errors.some((error) => /network API|WebSocket|connect/i.test(error)));

  fs.writeFileSync(
    outputFile,
    html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/i, ""),
  );
  const cspDiagnostics = await validateHtml(outputFile);
  assert.equal(cspDiagnostics.ok, false);
  assert.ok(cspDiagnostics.errors.some((error) => /content security policy|CSP/i.test(error)));
});

test("validateHtml requires exact deny and data-only CSP source lists", async () => {
  for (const [original, replacement, directive] of [
    ["connect-src 'none';", "connect-src 'none' https:;", "connect-src"],
    ["img-src data:;", "img-src data: https:;", "img-src"],
  ]) {
    const { outputFile } = buildFixture();
    const html = fs.readFileSync(outputFile, "utf8").replace(original, replacement);
    fs.writeFileSync(outputFile, html);
    const diagnostics = await validateHtml(outputFile);
    assert.equal(diagnostics.ok, false);
    assert.ok(diagnostics.errors.some((error) => new RegExp(`${directive}.*exact|${directive}.*only`, "i").test(error)));
  }
});

test("deck hash navigation tolerates malformed percent escapes", async () => {
  const { outputFile } = buildFixture();
  const { chromium } = require("playwright");
  const browser = await launchPreviewBrowser(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${pathToFileURL(outputFile).href}#%E0%A4%A`, { waitUntil: "load" });
    const currentId = await page.evaluate(() => window.__sherryDeck?.currentId());
    assert.equal(currentId, "p01");
    assert.deepEqual(pageErrors, []);
    await page.close();
  } finally {
    await browser.close();
  }
});
