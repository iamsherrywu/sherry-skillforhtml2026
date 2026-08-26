import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildPptx } from "../scripts/build-pptx.mjs";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const fixtureFile = fileURLToPath(new URL("fixtures/deck-model.json", import.meta.url));
const renderScript = fileURLToPath(new URL("../scripts/render-pptx.sh", import.meta.url));
const buildScript = fileURLToPath(new URL("../scripts/build-pptx.mjs", import.meta.url));
const stylePool = fileURLToPath(new URL("../assets/style-pool", import.meta.url));
const fixturePng = fileURLToPath(new URL("fixtures/html-project/materials/pixel.png", import.meta.url));
const tinyJpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////"
  + "2wBDAf//////////////////////////////////////////////////////////////////////////////////////"
  + "wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/"
  + "9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/"
  + "aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/"
  + "aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/"
  + "aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/"
  + "aAAgBAQABPxB//9k=",
  "base64",
);

function makeTempDir() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sherry-pptx-"));
}

function fixtureModel() {
  return JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
}

function writeModel(model) {
  const modelFile = path.join(makeTempDir(), "deck-model.json");
  fs.writeFileSync(modelFile, `${JSON.stringify(model, null, 2)}\n`);
  return modelFile;
}

function writeModelIn(directory, model) {
  const modelFile = path.join(directory, "deck-model.json");
  fs.writeFileSync(modelFile, `${JSON.stringify(model, null, 2)}\n`);
  return modelFile;
}

async function copiedBuildPptx(mutateTokens) {
  const root = makeTempDir();
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "assets"));
  const localNodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));
  if (fs.existsSync(localNodeModules)) {
    fs.symlinkSync(localNodeModules, path.join(root, "node_modules"), "dir");
  }
  fs.copyFileSync(buildScript, path.join(root, "scripts", "build-pptx.mjs"));
  fs.cpSync(stylePool, path.join(root, "assets", "style-pool"), { recursive: true });
  const tokenFile = path.join(root, "assets", "style-pool", "ai-research-journal", "tokens.json");
  const tokens = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  mutateTokens(tokens);
  fs.writeFileSync(tokenFile, `${JSON.stringify(tokens, null, 2)}\n`);
  return (await import(pathToFileURL(path.join(root, "scripts", "build-pptx.mjs")).href)).buildPptx;
}

function writeExecutable(directory, name, source) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, `#!/bin/bash\nset -u\n${source}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function runRender(args, pathValue) {
  return spawnSync("/bin/bash", [renderScript, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: pathValue },
  });
}

function waitForProcess(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function successfulSoffice(delaySeconds = 0) {
  return `
headless=0
format=""
outdir=""
input=""
while (($#)); do
  case "$1" in
    --headless) headless=1; shift ;;
    --convert-to) format="$2"; shift 2 ;;
    --outdir) outdir="$2"; shift 2 ;;
    *) input="$1"; shift ;;
  esac
done
[[ "$headless" = 1 && "$format" = pdf && -n "$outdir" && -n "$input" ]] || exit 41
${delaySeconds ? `/bin/sleep ${delaySeconds}` : ""}
base="\${input##*/}"
printf '%%PDF-1.4' > "$outdir/\${base%.*}.pdf"`;
}

const successfulPdftoppm = `
[[ "$1" = -png && "$2" = -scale-to-x && "$3" = 1600 && "$4" = -scale-to-y && "$5" = -1 ]] || exit 42
printf 'png-1' > "$7-01.png"
printf 'png-2' > "$7-02.png"`;

async function readPptx(outputFile) {
  return JSZip.loadAsync(fs.readFileSync(outputFile));
}

function geometrySignature(xml) {
  return [
    ...xml.matchAll(/<a:off\b[^>]*\/>|<a:ext\b[^>]*\/>|<a:prstGeom\b[^>]*>/g),
  ].map((match) => match[0]).join("\n");
}

function decodeXmlAttribute(value) {
  return value.replaceAll("&amp;", "&").replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function decodeXmlText(value) {
  return decodeXmlAttribute(value)
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9A-F]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function sourcePartForRelationships(relationshipFile) {
  if (relationshipFile === "_rels/.rels") return "";
  const marker = "/_rels/";
  const markerIndex = relationshipFile.lastIndexOf(marker);
  assert.notEqual(markerIndex, -1, `invalid relationship part path: ${relationshipFile}`);
  return `${relationshipFile.slice(0, markerIndex)}/${relationshipFile.slice(markerIndex + marker.length, -5)}`;
}

async function assertOpcTargetsResolve(archive) {
  const packageFiles = new Set(Object.keys(archive.files).filter((name) => !archive.files[name].dir));
  const contentTypes = await archive.file("[Content_Types].xml").async("string");
  for (const match of contentTypes.matchAll(/<Override\b[^>]*\bPartName="([^"]+)"[^>]*\/>/g)) {
    const target = decodeXmlAttribute(match[1]).replace(/^\//, "");
    assert.equal(packageFiles.has(target), true, `missing content-type override target: ${target}`);
  }

  for (const relationshipFile of [...packageFiles].filter((name) => name.endsWith(".rels"))) {
    const xml = await archive.file(relationshipFile).async("string");
    const sourcePart = sourcePartForRelationships(relationshipFile);
    for (const match of xml.matchAll(/<Relationship\b[^>]*\bTarget="([^"]+)"[^>]*\/>/g)) {
      if (/\bTargetMode="External"/.test(match[0])) continue;
      assert.doesNotMatch(match[0], /\/relationships\/notes(?:Slide|Master)"/i);
      const rawTarget = decodeXmlAttribute(match[1]);
      const target = rawTarget.startsWith("/")
        ? path.posix.normalize(rawTarget).replace(/^\//, "")
        : path.posix.normalize(path.posix.join(path.posix.dirname(sourcePart), rawTarget));
      assert.equal(packageFiles.has(target), true, `missing relationship target from ${relationshipFile}: ${target}`);
    }
  }
}

test("buildPptx creates a 12-slide editable wide deck with selected style tokens", async () => {
  const outputFile = path.join(makeTempDir(), "fixture.pptx");
  const result = await buildPptx({
    modelFile: fixtureFile,
    styleId: "ai-research-journal",
    outputFile,
  });
  const archive = await readPptx(outputFile);
  const files = Object.keys(archive.files);
  const slideFiles = files
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => Number(left.match(/\d+/)[0]) - Number(right.match(/\d+/)[0]));
  const slideXml = await Promise.all(slideFiles.map((name) => archive.file(name).async("string")));
  const allSlideXml = slideXml.join("\n");

  await assertOpcTargetsResolve(archive);

  assert.equal(result.outputFile, path.resolve(outputFile));
  assert.equal(result.slideCount, 12);
  assert.equal(fs.readFileSync(outputFile).subarray(0, 2).toString("ascii"), "PK");
  assert.equal(slideFiles.length, 12);
  assert.match(allSlideXml, /<a:t>Signals in Applied AI<\/a:t>/);
  assert.match(allSlideXml, /<a:t>Trust is built through visible evidence, not declarations\.<\/a:t>/);
  assert.ok(slideXml.every((xml) => /<a:t>p\d{2}<\/a:t>/.test(xml)), "every slide keeps its model ID as editable text");
  assert.doesNotMatch(allSlideXml, /typeface="(?:ui-monospace|system-ui|serif|sans-serif|monospace)"/i);
  assert.equal(files.some((name) => name.startsWith("ppt/notesSlides/") && !archive.files[name].dir), false);
  assert.equal(
    files.some((name) => name.startsWith("ppt/media/") && !archive.files[name].dir),
    false,
    "fixture must not be slide-rasterized",
  );
  assert.ok(files.some((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name)), "data layout uses an editable chart");
  for (const color of ["F9F8F3", "17191C", "1F5AA6", "D8492F"]) {
    assert.match(allSlideXml, new RegExp(`(?:srgbClr val="|color=")${color}`, "i"));
  }
});

test("all six styles use visibly distinct PPTX composition geometry", async () => {
  const styleIds = [
    "product-narrative",
    "system-monochrome",
    "editorial-signal",
    "creative-primitives",
    "ai-research-journal",
    "insight-editorial",
  ];
  const signatures = new Map();
  for (const styleId of styleIds) {
    const model = fixtureModel();
    model.meta.styleId = styleId;
    model.slides = [model.slides[0]];
    const outputFile = path.join(makeTempDir(), `${styleId}.pptx`);
    const result = await buildPptx({ modelFile: writeModel(model), styleId, outputFile });
    const archive = await readPptx(outputFile);
    const xml = await archive.file("ppt/slides/slide1.xml").async("string");
    signatures.set(styleId, geometrySignature(xml));
    assert.equal(typeof result.compositionId, "string");
    assert.match(result.compositionId, new RegExp(styleId));
  }

  assert.equal(new Set(signatures.values()).size, 6);
});

test("PPTX supports only the two approved limited secondary-style overrides", async () => {
  const model = fixtureModel();
  model.meta.styleId = "product-narrative";
  model.meta.secondaryStyleId = "insight-editorial";
  model.meta.secondaryOverrides = ["chart-treatment", "section-divider"];
  const outputFile = path.join(makeTempDir(), "secondary-overrides.pptx");

  const result = await buildPptx({
    modelFile: writeModel(model),
    styleId: "product-narrative",
    outputFile,
  });
  const archive = await readPptx(outputFile);
  const sectionXml = await archive.file("ppt/slides/slide2.xml").async("string");
  const dataXml = await archive.file("ppt/slides/slide4.xml").async("string");

  assert.deepEqual(result.secondaryOverrides, ["chart-treatment", "section-divider"]);
  assert.match(sectionXml, /(?:srgbClr val="|color=")DCE75A/i);
  assert.match(dataXml, /(?:srgbClr val="|color=")DCE75A/i);

  for (const mutate of [
    (candidate) => { candidate.meta.secondaryOverrides = ["global-layout"]; },
    (candidate) => { candidate.meta.secondaryOverrides = []; },
    (candidate) => { candidate.meta.secondaryStyleId = null; candidate.meta.secondaryOverrides = ["chart-treatment"]; },
    (candidate) => { candidate.meta.secondaryStyleId = "unknown-style"; candidate.meta.secondaryOverrides = ["chart-treatment"]; },
  ]) {
    const invalid = fixtureModel();
    invalid.meta.styleId = "product-narrative";
  invalid.meta.secondaryStyleId = "insight-editorial";
    invalid.meta.secondaryOverrides = ["chart-treatment"];
    mutate(invalid);
    await assert.rejects(
      buildPptx({
        modelFile: writeModel(invalid),
        styleId: "product-narrative",
        outputFile: path.join(makeTempDir(), "invalid-secondary.pptx"),
      }),
      /secondary.*override|unknown selected style|requires.*secondary|unsupported/i,
    );
  }
});

test("buildPptx rejects unsupported slide types clearly", async () => {
  const model = fixtureModel();
  model.slides[11].type = "agenda";

  await assert.rejects(
    buildPptx({
      modelFile: writeModel(model),
      styleId: "ai-research-journal",
      outputFile: path.join(makeTempDir(), "unsupported.pptx"),
    }),
    /Unsupported slide type "agenda".*p12/i,
  );
});

test("buildPptx validates model IDs, content, selected style, and output paths", async () => {
  const duplicateIds = fixtureModel();
  duplicateIds.slides[1].id = "p01";
  await assert.rejects(
    buildPptx({
      modelFile: writeModel(duplicateIds),
      styleId: "ai-research-journal",
      outputFile: path.join(makeTempDir(), "duplicate.pptx"),
    }),
    /Duplicate slide ID.*p01/i,
  );

  const invalidContent = fixtureModel();
  invalidContent.slides[2].body = ["valid", 42];
  await assert.rejects(
    buildPptx({
      modelFile: writeModel(invalidContent),
      styleId: "ai-research-journal",
      outputFile: path.join(makeTempDir(), "content.pptx"),
    }),
    /p03.*body.*non-empty strings/i,
  );

  await assert.rejects(
    buildPptx({
      modelFile: fixtureFile,
      styleId: "not-a-style",
      outputFile: path.join(makeTempDir(), "style.pptx"),
    }),
    /Unknown selected style.*not-a-style/i,
  );

  await assert.rejects(
    buildPptx({
      modelFile: fixtureFile,
      styleId: "ai-research-journal",
      outputFile: path.join(makeTempDir(), "not-pptx.txt"),
    }),
    /outputFile.*\.pptx/i,
  );
});

test("buildPptx rejects layout overflow and invalid per-type content with slide context", async () => {
  const cases = [
    {
      mutate(model) { model.slides[4].sections.push({ title: "Excess", body: "Must not be sliced." }); },
      error: /Slide p05 \(process\).*sections.*at most 4/i,
    },
    {
      mutate(model) { model.slides[5].sections.pop(); },
      error: /Slide p06 \(comparison\).*exactly 2 sections/i,
    },
    {
      mutate(model) { model.slides[3].sections[3].value = 120; },
      error: /Slide p04 \(data\).*value.*0.*100/i,
    },
    {
      mutate(model) { model.slides[3].sections[0].value = "32"; },
      error: /Slide p04 \(data\).*numeric value/i,
    },
    {
      mutate(model) { model.slides[2].title = "x".repeat(241); },
      error: /Slide p03 \(statement\).*title.*240/i,
    },
    {
      mutate(model) { model.slides[11].body = ["Summary layout has no body region."]; },
      error: /Slide p12 \(summary\).*body.*at most 0/i,
    },
  ];

  for (const example of cases) {
    const model = fixtureModel();
    example.mutate(model);
    await assert.rejects(
      buildPptx({
        modelFile: writeModel(model),
        styleId: "ai-research-journal",
        outputFile: path.join(makeTempDir(), "invalid-layout.pptx"),
      }),
      example.error,
    );
  }
});

test("buildPptx rejects malformed required style tokens without fallback", async () => {
  for (const [mutate, error] of [
    [(tokens) => { tokens.lineWidth = 0; }, /Selected style ai-research-journal token lineWidth/i],
    [(tokens) => { tokens.fontMono = "ui-monospace, monospace"; }, /Selected style ai-research-journal token fontMono.*concrete/i],
    [(tokens) => { delete tokens.spacingUnit; }, /Selected style ai-research-journal token spacingUnit/i],
  ]) {
    const isolatedBuild = await copiedBuildPptx(mutate);
    await assert.rejects(
      isolatedBuild({
        modelFile: fixtureFile,
        styleId: "ai-research-journal",
        outputFile: path.join(makeTempDir(), "bad-style.pptx"),
      }),
      error,
    );
  }
});

test("buildPptx round-trips XML metacharacters as editable text", async () => {
  const model = fixtureModel();
  const special = `Research & <signal> "quoted" 'apostrophe'`;
  model.slides[2].title = special;
  const outputFile = path.join(makeTempDir(), "metacharacters.pptx");

  await buildPptx({
    modelFile: writeModel(model),
    styleId: "ai-research-journal",
    outputFile,
  });
  const archive = await readPptx(outputFile);
  const xml = await archive.file("ppt/slides/slide3.xml").async("string");
  const textNodes = [...xml.matchAll(/<a:t>(.*?)<\/a:t>/gs)].map((match) => decodeXmlText(match[1]));

  assert.ok(textNodes.includes(special));
  assert.match(xml, /Research &amp; &lt;signal&gt;/);
});

test("buildPptx embeds real local PNG and JPEG files through the image layout", async () => {
  for (const extension of ["png", "jpg"]) {
    const root = makeTempDir();
    const imageName = `evidence.${extension}`;
    if (extension === "png") fs.copyFileSync(fixturePng, path.join(root, imageName));
    else fs.writeFileSync(path.join(root, imageName), tinyJpeg);
    const model = fixtureModel();
    model.slides[9].image = imageName;
    model.slides[9].sections = [
      { title: "Observed signal", body: "Quality improved after review." },
      { title: "Operating limit", body: "Human escalation remains available." },
      { title: "Next check", body: "Measure stability in the next cohort." },
    ];
    const outputFile = path.join(root, `image-${extension}.pptx`);

    await buildPptx({
      modelFile: writeModelIn(root, model),
      styleId: "ai-research-journal",
      outputFile,
    });
    const archive = await readPptx(outputFile);
    const files = Object.keys(archive.files);
    const slideXml = await archive.file("ppt/slides/slide10.xml").async("string");

    await assertOpcTargetsResolve(archive);
    assert.ok(files.some((name) => new RegExp(`^ppt/media/[^/]+\\.${extension}$`, "i").test(name)));
    assert.match(slideXml, /<p:pic>/);
    const textNodes = [...slideXml.matchAll(/<a:t>(.*?)<\/a:t>/gs)].map((match) => decodeXmlText(match[1]));
    for (const section of model.slides[9].sections) {
      assert.ok(textNodes.includes(section.title), `${extension} image slide retains section title: ${section.title}`);
      assert.ok(textNodes.includes(section.body), `${extension} image slide retains section body: ${section.body}`);
    }
  }
});

test("buildPptx derives fallback image nodes and connectors from every accepted section", async () => {
  for (const sectionCount of [1, 2, 3]) {
    const model = fixtureModel();
    model.slides[9].sections = model.slides[9].sections.slice(0, sectionCount);
    const outputFile = path.join(makeTempDir(), `image-fallback-${sectionCount}.pptx`);

    await buildPptx({
      modelFile: writeModel(model),
      styleId: "ai-research-journal",
      outputFile,
    });
    const archive = await readPptx(outputFile);
    const slideXml = await archive.file("ppt/slides/slide10.xml").async("string");
    const textNodes = [...slideXml.matchAll(/<a:t>(.*?)<\/a:t>/gs)].map((match) => decodeXmlText(match[1]));

    for (const section of model.slides[9].sections) {
      assert.ok(textNodes.includes(section.title), `fallback retains section title: ${section.title}`);
      assert.ok(textNodes.includes(section.body), `fallback retains section body: ${section.body}`);
    }
    assert.equal(
      [...slideXml.matchAll(/<a:prstGeom prst="line">/g)].length,
      3 + Math.max(0, sectionCount - 1),
      `fallback with ${sectionCount} sections has journal frame, footer, accent, and adjacent-node connectors`,
    );
  }
});

test("buildPptx confines local images to real files inside the model directory", async () => {
  const root = makeTempDir();
  const modelRoot = path.join(root, "model");
  fs.mkdirSync(modelRoot);
  fs.copyFileSync(fixturePng, path.join(root, "outside.png"));
  fs.symlinkSync(path.join(root, "outside.png"), path.join(modelRoot, "linked.png"));

  for (const [image, error] of [
    [path.join(root, "outside.png"), /Slide p10 \(image\).*absolute/i],
    ["../outside.png", /Slide p10 \(image\).*traversal/i],
    ["linked.png", /Slide p10 \(image\).*symlink/i],
    ["unsupported.gif", /Slide p10 \(image\).*PNG or JPEG/i],
  ]) {
    const model = fixtureModel();
    model.slides[9].image = image;
    await assert.rejects(
      buildPptx({
        modelFile: writeModelIn(modelRoot, model),
        styleId: "ai-research-journal",
        outputFile: path.join(makeTempDir(), "unsafe-image.pptx"),
      }),
      error,
    );
  }
});

test("render-pptx reports each missing conversion tool precisely", () => {
  const emptyPath = makeTempDir();
  const inputFile = path.join(makeTempDir(), "fixture.pptx");
  fs.writeFileSync(inputFile, "fixture");

  const missingSoffice = runRender([inputFile, path.join(makeTempDir(), "render")], emptyPath);
  assert.notEqual(missingSoffice.status, 0);
  assert.match(missingSoffice.stderr, /required tool 'soffice' was not found on PATH/i);

  writeExecutable(emptyPath, "soffice", "exit 0");
  const missingPdftoppm = runRender([inputFile, path.join(makeTempDir(), "render")], emptyPath);
  assert.notEqual(missingPdftoppm.status, 0);
  assert.match(missingPdftoppm.stderr, /required tool 'pdftoppm' was not found on PATH/i);
});

test("render-pptx preserves unrelated files and publishes only run-owned outputs", () => {
  const toolPath = makeTempDir();
  writeExecutable(toolPath, "soffice", successfulSoffice());
  writeExecutable(toolPath, "pdftoppm", successfulPdftoppm);
  const inputFile = path.join(makeTempDir(), "fixture.pptx");
  const outputDir = path.join(makeTempDir(), "render");
  fs.writeFileSync(inputFile, "fixture");
  fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, "unrelated.png"), "keep-png");
  fs.writeFileSync(path.join(outputDir, "unrelated.pdf"), "keep-pdf");

  const result = runRender([inputFile, outputDir], toolPath);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /bad substitution|syntax error/i);
  assert.equal(fs.readFileSync(path.join(outputDir, "unrelated.png"), "utf8"), "keep-png");
  assert.equal(fs.readFileSync(path.join(outputDir, "unrelated.pdf"), "utf8"), "keep-pdf");
  assert.equal(fs.readFileSync(path.join(outputDir, "fixture.pdf"), "utf8"), "%PDF-1.4");
  assert.deepEqual(
    fs.readdirSync(outputDir).filter((name) => name.startsWith("page-")).sort(),
    ["page-01.png", "page-02.png"],
  );
  assert.equal(fs.existsSync(path.join(outputDir, ".render-pptx-manifest")), true);
  assert.equal(fs.readdirSync(outputDir).some((name) => name.startsWith(".render-pptx.run.")), false);
  assert.equal(fs.existsSync(path.join(outputDir, ".render-pptx.lock")), false);
});

test("render-pptx surfaces LibreOffice and PNG conversion failures", () => {
  const inputFile = path.join(makeTempDir(), "fixture.pptx");
  fs.writeFileSync(inputFile, "fixture");

  const sofficeFailurePath = makeTempDir();
  writeExecutable(sofficeFailurePath, "soffice", "exit 17");
  writeExecutable(sofficeFailurePath, "pdftoppm", "exit 0");
  const sofficeFailure = runRender([inputFile, path.join(makeTempDir(), "render")], sofficeFailurePath);
  assert.notEqual(sofficeFailure.status, 0);
  assert.match(sofficeFailure.stderr, /LibreOffice conversion failed/i);

  const pdftoppmFailurePath = makeTempDir();
  writeExecutable(pdftoppmFailurePath, "soffice", `
outdir=""
input=""
while (($#)); do
  case "$1" in
    --outdir) outdir="$2"; shift 2 ;;
    --convert-to) shift 2 ;;
    --headless) shift ;;
    *) input="$1"; shift ;;
  esac
done
base="\${input##*/}"
printf '%%PDF-1.4' > "$outdir/\${base%.*}.pdf"`);
  writeExecutable(pdftoppmFailurePath, "pdftoppm", "exit 23");
  const pdftoppmFailure = runRender([inputFile, path.join(makeTempDir(), "render")], pdftoppmFailurePath);
  assert.notEqual(pdftoppmFailure.status, 0);
  assert.match(pdftoppmFailure.stderr, /PNG rendering failed/i);
});

test("render-pptx failure preserves the previous good render and releases run state", () => {
  const toolPath = makeTempDir();
  writeExecutable(toolPath, "soffice", "exit 17");
  writeExecutable(toolPath, "pdftoppm", successfulPdftoppm);
  const inputFile = path.join(makeTempDir(), "fixture.pptx");
  const outputDir = path.join(makeTempDir(), "render");
  fs.writeFileSync(inputFile, "fixture");
  fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, "fixture.pdf"), "previous-pdf");
  fs.writeFileSync(path.join(outputDir, "page-01.png"), "previous-page");
  fs.writeFileSync(
    path.join(outputDir, ".render-pptx-manifest"),
    "render-pptx-manifest-v1\nfixture.pdf\npage-01.png\n",
  );

  const result = runRender([inputFile, outputDir], toolPath);

  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(outputDir, "fixture.pdf"), "utf8"), "previous-pdf");
  assert.equal(fs.readFileSync(path.join(outputDir, "page-01.png"), "utf8"), "previous-page");
  assert.equal(fs.existsSync(path.join(outputDir, ".render-pptx.lock")), false);
  assert.equal(fs.readdirSync(outputDir).some((name) => name.startsWith(".render-pptx.run.")), false);
});

test("render-pptx rejects unsafe manifests and reserved-name collisions without deletion", () => {
  const toolPath = makeTempDir();
  writeExecutable(toolPath, "soffice", successfulSoffice());
  writeExecutable(toolPath, "pdftoppm", successfulPdftoppm);
  const inputFile = path.join(makeTempDir(), "fixture.pptx");
  fs.writeFileSync(inputFile, "fixture");

  const collisionDir = path.join(makeTempDir(), "render");
  fs.mkdirSync(collisionDir);
  fs.writeFileSync(path.join(collisionDir, "page-01.png"), "unrelated-page");
  const collision = runRender([inputFile, collisionDir], toolPath);
  assert.notEqual(collision.status, 0);
  assert.match(collision.stderr, /overwrite unrelated output/i);
  assert.equal(fs.readFileSync(path.join(collisionDir, "page-01.png"), "utf8"), "unrelated-page");
  assert.equal(fs.existsSync(path.join(collisionDir, ".render-pptx.lock")), false);

  const malformedDir = path.join(makeTempDir(), "render");
  fs.mkdirSync(malformedDir);
  fs.writeFileSync(path.join(malformedDir, "keep.png"), "keep");
  fs.writeFileSync(path.join(malformedDir, ".render-pptx-manifest"), "render-pptx-manifest-v1\n../keep.png\n");
  const malformed = runRender([inputFile, malformedDir], toolPath);
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /manifest.*unsafe output name/i);
  assert.equal(fs.readFileSync(path.join(malformedDir, "keep.png"), "utf8"), "keep");
  assert.equal(fs.existsSync(path.join(malformedDir, ".render-pptx.lock")), false);
});

test("render-pptx rejects root-equivalent and double-slash output paths", () => {
  const toolPath = makeTempDir();
  writeExecutable(toolPath, "soffice", successfulSoffice());
  writeExecutable(toolPath, "pdftoppm", successfulPdftoppm);
  const inputFile = path.join(makeTempDir(), "fixture.pptx");
  const root = makeTempDir();
  fs.writeFileSync(inputFile, "fixture");

  for (const outputDir of [`${root}/child/..`, `/${root}`]) {
    const result = runRender([inputFile, outputDir], toolPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsafe output|root-equivalent|double-slash/i);
  }
});

test("render-pptx rejects a symlinked output ancestor without touching its target", () => {
  const toolPath = makeTempDir();
  writeExecutable(toolPath, "soffice", successfulSoffice());
  writeExecutable(toolPath, "pdftoppm", successfulPdftoppm);
  const inputFile = path.join(makeTempDir(), "fixture.pptx");
  const root = makeTempDir();
  const external = makeTempDir();
  fs.writeFileSync(inputFile, "fixture");
  fs.writeFileSync(path.join(external, "unrelated.png"), "outside");
  fs.symlinkSync(external, path.join(root, "linked"));

  const result = runRender([inputFile, path.join(root, "linked", "render")], toolPath);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlinked output (?:path|ancestor)/i);
  assert.equal(fs.readFileSync(path.join(external, "unrelated.png"), "utf8"), "outside");
  assert.equal(fs.existsSync(path.join(external, "render")), false);
});

test("render-pptx lock rejects a concurrent render to the same output", async () => {
  const toolPath = makeTempDir();
  writeExecutable(toolPath, "soffice", successfulSoffice(1));
  writeExecutable(toolPath, "pdftoppm", successfulPdftoppm);
  const inputFile = path.join(makeTempDir(), "fixture.pptx");
  const outputDir = path.join(makeTempDir(), "render");
  fs.writeFileSync(inputFile, "fixture");
  fs.mkdirSync(outputDir);

  const first = spawn("/bin/bash", [renderScript, inputFile, outputDir], {
    env: { ...process.env, PATH: toolPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(path.join(outputDir, ".render-pptx.lock")) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fs.existsSync(path.join(outputDir, ".render-pptx.lock")), true, "first render acquired lock");

  const second = runRender([inputFile, outputDir], toolPath);
  const firstResult = await waitForProcess(first);

  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /render already in progress|lock/i);
  assert.equal(firstResult.status, 0, firstResult.stderr);
  assert.equal(fs.existsSync(path.join(outputDir, ".render-pptx.lock")), false);
});
