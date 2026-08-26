import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const PptxGenJS = require("pptxgenjs");
const JSZip = require("jszip");

const SKILL_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const STYLE_ROOT = path.join(SKILL_ROOT, "assets", "style-pool");
const SLIDE_WIDTH = 13.333;
const SLIDE_HEIGHT = 7.5;
const ALLOWED_TYPES = new Set([
  "cover",
  "section",
  "statement",
  "data",
  "process",
  "comparison",
  "case-study",
  "timeline",
  "matrix",
  "image",
  "quote",
  "summary",
]);
const GENERIC_FONT_FAMILIES = new Set(["ui-monospace", "system-ui", "serif", "sans-serif", "monospace"]);
const SECONDARY_OVERRIDE_ALLOWLIST = new Set(["chart-treatment", "section-divider"]);
const STYLE_COMPOSITIONS = {
  "product-narrative": {
    id: "product-narrative-stage",
    transform: { x: 0, y: 0, width: 1, height: 1 },
    decoration: "edge-rail",
  },
  "system-monochrome": {
    id: "system-monochrome-grid",
    transform: { x: 0.18, y: 0.08, width: 0.965, height: 0.96 },
    decoration: "system-grid",
  },
  "editorial-signal": {
    id: "editorial-signal-column",
    transform: { x: 0.46, y: 0.16, width: 0.93, height: 0.94 },
    decoration: "editorial-band",
  },
  "insight-editorial": {
    id: "insight-editorial-frame",
    transform: { x: 0.28, y: 0.12, width: 0.96, height: 0.95 },
    decoration: "insight-editorial-frame",
  },
  "creative-primitives": {
    id: "creative-primitives-modules",
    transform: { x: 0.62, y: 0.24, width: 0.9, height: 0.91 },
    decoration: "primitive-blocks",
  },
  "ai-research-journal": {
    id: "ai-research-journal-page",
    transform: { x: 0.38, y: 0.2, width: 0.94, height: 0.92 },
    decoration: "journal-page",
  },
};
const SLIDE_CONTEXTS = new WeakMap();
const LAYOUT_RULES = {
  cover: { body: [0, 1], sections: [0, 0], metric: "none", sectionKind: "none" },
  section: { body: [0, 1], sections: [0, 0], metric: "none", sectionKind: "none" },
  statement: { body: [0, 1], sections: [0, 0], metric: "none", sectionKind: "none" },
  data: { body: [0, 2], sections: [1, 8], metric: "required", sectionKind: "data" },
  process: { body: [0, 0], sections: [2, 4], metric: "none", sectionKind: "body" },
  comparison: { body: [0, 0], sections: [2, 2], metric: "none", sectionKind: "items" },
  "case-study": { body: [1, 2], sections: [1, 2], metric: "required", sectionKind: "body" },
  timeline: { body: [0, 0], sections: [2, 4], metric: "none", sectionKind: "body" },
  matrix: { body: [0, 0], sections: [4, 4], metric: "none", sectionKind: "body" },
  image: { body: [0, 1], sections: [0, 3], metric: "none", sectionKind: "body" },
  quote: { body: [0, 1], sections: [0, 0], metric: "none", sectionKind: "none" },
  summary: { body: [0, 0], sections: [2, 3], metric: "none", sectionKind: "body" },
};

function nonEmptyString(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function styleTokenError(styleId, name, detail) {
  throw new Error(`Selected style ${styleId} token ${name} ${detail}`);
}

function cleanColor(value, styleId, name) {
  if (typeof value !== "string" || !/^#[0-9A-F]{6}$/i.test(value)) {
    styleTokenError(styleId, name, "must be a six-digit hex color");
  }
  return value.slice(1).toUpperCase();
}

function firstFont(value, styleId, name) {
  if (!nonEmptyString(value)) styleTokenError(styleId, name, "must be a non-empty font stack");
  const fonts = value.split(",").map((font) => font.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  const concrete = fonts.find((font) => !GENERIC_FONT_FAMILIES.has(font.toLowerCase()));
  if (!concrete) styleTokenError(styleId, name, "must include a concrete system-safe font family");
  return concrete;
}

function positiveStyleNumber(value, styleId, name, maximum) {
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    styleTokenError(styleId, name, `must be a positive number no greater than ${maximum}`);
  }
  return value;
}

function loadStyle(styleId) {
  if (!nonEmptyString(styleId)) throw new Error("styleId is required");
  const registryFile = path.join(STYLE_ROOT, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const entry = registry.styles.find((candidate) => candidate.id === styleId);
  if (!entry) throw new Error(`Unknown selected style: ${styleId}`);
  if (!nonEmptyString(entry.tokens)) throw new Error(`Selected style ${styleId} has no token file`);
  const canonicalRoot = fs.realpathSync(STYLE_ROOT);
  const tokenFile = path.resolve(canonicalRoot, entry.tokens);
  const relative = path.relative(canonicalRoot, tokenFile);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Selected style tokens escape the style root: ${entry.tokens}`);
  }
  if (!fs.existsSync(tokenFile) || !fs.lstatSync(tokenFile).isFile()) {
    throw new Error(`Selected style tokens do not exist: ${entry.tokens}`);
  }
  const canonicalFile = fs.realpathSync(tokenFile);
  const canonicalRelative = path.relative(canonicalRoot, canonicalFile);
  if (canonicalRelative.startsWith(`..${path.sep}`) || canonicalRelative === ".." || path.isAbsolute(canonicalRelative)) {
    throw new Error(`Selected style tokens resolve outside the style root: ${entry.tokens}`);
  }
  let tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(canonicalFile, "utf8"));
  } catch (error) {
    throw new Error(`Selected style ${styleId} tokens are not valid JSON`, { cause: error });
  }
  positiveStyleNumber(tokens.spacingUnit, styleId, "spacingUnit", 100);
  positiveStyleNumber(tokens.lineWidth, styleId, "lineWidth", 12);
  if (!nonEmptyString(tokens.motion) || tokens.motion.length > 120) {
    styleTokenError(styleId, "motion", "must be non-empty text no longer than 120 characters");
  }
  return {
    id: styleId,
    background: cleanColor(tokens.background, styleId, "background"),
    surface: cleanColor(tokens.surface, styleId, "surface"),
    text: cleanColor(tokens.text, styleId, "text"),
    muted: cleanColor(tokens.muted, styleId, "muted"),
    primary: cleanColor(tokens.primary, styleId, "primary"),
    secondary: cleanColor(tokens.secondary, styleId, "secondary"),
    warning: cleanColor(tokens.warning, styleId, "warning"),
    displayFont: firstFont(tokens.fontDisplay, styleId, "fontDisplay"),
    bodyFont: firstFont(tokens.fontBody, styleId, "fontBody"),
    monoFont: firstFont(tokens.fontMono, styleId, "fontMono"),
    spacingUnit: tokens.spacingUnit,
    lineWidth: tokens.lineWidth,
  };
}

function readModel(modelFile) {
  if (!nonEmptyString(modelFile)) throw new Error("modelFile is required");
  const resolved = path.resolve(modelFile);
  if (!fs.existsSync(resolved)) throw new Error(`Model file does not exist: ${resolved}`);
  if (!fs.statSync(resolved).isFile()) throw new Error(`Model path is not a file: ${resolved}`);
  const canonicalFile = fs.realpathSync(resolved);
  try {
    return { model: JSON.parse(fs.readFileSync(canonicalFile, "utf8")), modelFile: canonicalFile };
  } catch (error) {
    throw new Error(`Model file is not valid JSON: ${canonicalFile}`, { cause: error });
  }
}

function slideContext(slide) {
  return `Slide ${slide.id} (${slide.type})`;
}

function validateBoundedText(value, label, context, maximum, { optional = false } = {}) {
  if (optional && value === undefined) return;
  if (!nonEmptyString(value)) throw new Error(`${context} ${label} must be non-empty text`);
  if (value.length > maximum) throw new Error(`${context} ${label} must be at most ${maximum} characters`);
}

function validateStringArray(value, label, context, { minimum = 0, maximum, itemMaximum }) {
  if (!Array.isArray(value) || value.some((item) => !nonEmptyString(item))) {
    throw new Error(`${context} ${label} must be an array of non-empty strings`);
  }
  if (value.length < minimum) throw new Error(`${context} ${label} must contain at least ${minimum} items`);
  if (value.length > maximum) throw new Error(`${context} ${label} must contain at most ${maximum} items`);
  for (const [index, item] of value.entries()) {
    if (item.length > itemMaximum) {
      throw new Error(`${context} ${label} item ${index + 1} must be at most ${itemMaximum} characters`);
    }
  }
}

function validateMetric(metric, slide, rule) {
  const context = slideContext(slide);
  if (rule.metric === "none") {
    if (metric !== null) throw new Error(`${context} metric must be null for this layout`);
    return;
  }
  if (!metric || typeof metric !== "object" || Array.isArray(metric)) {
    throw new Error(`${context} metric requires a value/label object`);
  }
  const validValue = nonEmptyString(metric.value)
    || (typeof metric.value === "number" && Number.isFinite(metric.value));
  if (!validValue) throw new Error(`${context} metric requires a finite value`);
  validateBoundedText(metric.label, "metric label", context, 80);
  if (String(metric.value).length > 32) throw new Error(`${context} metric value must be at most 32 characters`);
}

function validateSections(sections, slide, rule) {
  const context = slideContext(slide);
  if (!Array.isArray(sections)) throw new Error(`${context} sections must be an array`);
  const [minimum, maximum] = rule.sections;
  if (minimum === maximum && sections.length !== minimum) {
    throw new Error(`${context} requires exactly ${minimum} sections`);
  }
  if (sections.length < minimum) throw new Error(`${context} sections must contain at least ${minimum} items`);
  if (sections.length > maximum) throw new Error(`${context} sections must contain at most ${maximum} items`);
  for (const [index, section] of sections.entries()) {
    if (!section || typeof section !== "object" || Array.isArray(section) || !nonEmptyString(section.title)) {
      throw new Error(`${context} section ${index + 1} requires a non-empty title`);
    }
    if (section.title.length > 80) {
      throw new Error(`${context} section ${index + 1} title must be at most 80 characters`);
    }
    if (rule.sectionKind === "data") {
      if (typeof section.value !== "number" || !Number.isFinite(section.value)) {
        throw new Error(`${context} section ${index + 1} requires a numeric value`);
      }
      if (section.value < 0 || section.value > 100) {
        throw new Error(`${context} section ${index + 1} value must be between 0 and 100`);
      }
      if (section.body !== undefined || section.items !== undefined) {
        throw new Error(`${context} data sections may contain only title and numeric value`);
      }
    } else if (rule.sectionKind === "items") {
      validateStringArray(section.items, `section ${index + 1} items`, context, {
        minimum: 1, maximum: 6, itemMaximum: 120,
      });
      if (section.body !== undefined || section.value !== undefined) {
        throw new Error(`${context} comparison sections may contain only title and items`);
      }
    } else if (rule.sectionKind === "body") {
      validateBoundedText(section.body, `section ${index + 1} body`, context, 180);
      if (section.items !== undefined || section.value !== undefined) {
        throw new Error(`${context} section ${index + 1} may contain only title and body`);
      }
    }
  }
}

function withinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveLocalImage(image, slide, modelFile) {
  const context = slideContext(slide);
  if (!nonEmptyString(image) || /^https?:/i.test(image)) {
    throw new Error(`${context} image must be a local relative file path`);
  }
  if (path.isAbsolute(image)) throw new Error(`${context} image path must not be absolute`);
  if (image.includes("\\") || image.split("/").includes("..")) {
    throw new Error(`${context} image path must not contain traversal segments`);
  }
  if (!/\.(?:png|jpe?g)$/i.test(image)) throw new Error(`${context} image must be PNG or JPEG`);

  const modelRoot = fs.realpathSync(path.dirname(modelFile));
  const candidate = path.resolve(modelRoot, image);
  if (!withinRoot(candidate, modelRoot)) throw new Error(`${context} image escapes the model directory`);
  const relative = path.relative(modelRoot, candidate);
  let current = modelRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) throw new Error(`${context} image does not exist: ${candidate}`);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`${context} image path must not contain a symlink`);
  }
  const canonical = fs.realpathSync(candidate);
  if (!withinRoot(canonical, modelRoot)) throw new Error(`${context} image symlink escapes the model directory`);
  if (!fs.statSync(canonical).isFile()) throw new Error(`${context} image is not a regular file: ${candidate}`);
  return canonical;
}

function validateModel(model, styleId, modelFile) {
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    throw new Error("Deck model must be a JSON object");
  }
  if (!model.meta || typeof model.meta !== "object" || Array.isArray(model.meta)) {
    throw new Error("Deck model requires a meta object");
  }
  validateBoundedText(model.meta.title, "meta.title", "Deck model", 160);
  if (!nonEmptyString(model.meta.styleId)) throw new Error("Deck model meta.styleId is required");
  if (model.meta.styleId !== styleId) {
    throw new Error(`Selected style ${styleId} does not match deck model style ${model.meta.styleId}`);
  }
  if (model.meta.aspectRatio !== "16:9") throw new Error('Deck model aspectRatio must be "16:9"');
  if (model.meta.secondaryStyleId !== null && model.meta.secondaryStyleId !== undefined
    && !nonEmptyString(model.meta.secondaryStyleId)) {
    throw new Error("Deck model secondaryStyleId must be null or a non-empty string");
  }
  const secondaryStyleId = model.meta.secondaryStyleId ?? null;
  const secondaryOverrides = model.meta.secondaryOverrides ?? [];
  if (!Array.isArray(secondaryOverrides)
    || secondaryOverrides.some((override) => !nonEmptyString(override))) {
    throw new Error("Deck model secondaryOverrides must be an array of non-empty strings");
  }
  if (new Set(secondaryOverrides).size !== secondaryOverrides.length) {
    throw new Error("Deck model secondaryOverrides must not contain duplicates");
  }
  if (secondaryStyleId === null && secondaryOverrides.length > 0) {
    throw new Error("Deck model secondary overrides require a selected secondary style");
  }
  if (secondaryStyleId !== null && secondaryOverrides.length === 0) {
    throw new Error("Deck model secondary style requires at least one limited secondary override");
  }
  if (secondaryStyleId === styleId) {
    throw new Error("Deck model secondary style must differ from the primary style");
  }
  for (const override of secondaryOverrides) {
    if (!SECONDARY_OVERRIDE_ALLOWLIST.has(override)) {
      throw new Error(`Unsupported secondary override: ${override}`);
    }
  }
  if (!Array.isArray(model.slides) || model.slides.length === 0 || model.slides.length > 200) {
    throw new Error("Deck model requires between 1 and 200 slides");
  }

  const ids = new Set();
  for (const [index, slide] of model.slides.entries()) {
    if (!slide || typeof slide !== "object" || Array.isArray(slide)) {
      throw new Error(`Slide ${index + 1} must be an object`);
    }
    const slideId = nonEmptyString(slide.id) ? slide.id : `at index ${index}`;
    if (!nonEmptyString(slide.type) || !ALLOWED_TYPES.has(slide.type)) {
      throw new Error(`Unsupported slide type "${slide.type}" for slide ${slideId}`);
    }
    if (!nonEmptyString(slide.id) || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(slide.id)) {
      throw new Error(`Slide ${index + 1} requires a safe, non-empty ID`);
    }
    if (ids.has(slide.id)) throw new Error(`Duplicate slide ID: ${slide.id}`);
    ids.add(slide.id);
    const context = slideContext(slide);
    const rule = LAYOUT_RULES[slide.type];
    validateBoundedText(slide.title, "title", context, ["statement", "quote"].includes(slide.type) ? 240 : 120);
    validateBoundedText(slide.subtitle, "subtitle", context, 180, { optional: true });
    validateStringArray(slide.body, "body", context, {
      minimum: rule.body[0], maximum: rule.body[1], itemMaximum: 240,
    });
    validateMetric(slide.metric, slide, rule);
    validateSections(slide.sections, slide, rule);
    validateStringArray(slide.sourceRefs, "sourceRefs", context, {
      minimum: 0, maximum: 8, itemMaximum: 180,
    });
    if (slide.type === "image" && slide.image === undefined && slide.sections.length === 0) {
      throw new Error(`${context} requires a local image or at least one editable diagram section`);
    }
    if (slide.image !== undefined) {
      if (slide.type !== "image") throw new Error(`${context} image is supported only by the image layout`);
      slide.image = resolveLocalImage(slide.image, slide, modelFile);
    }
  }
}

function resolveOutputFile(outputFile, modelFile) {
  if (!nonEmptyString(outputFile)) throw new Error("outputFile is required");
  const resolved = path.resolve(outputFile);
  if (path.extname(resolved).toLowerCase() !== ".pptx") {
    throw new Error("outputFile must use the .pptx extension");
  }
  if (resolved === modelFile) throw new Error("outputFile must differ from modelFile");
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isFile()) {
    throw new Error(`outputFile is not a file: ${resolved}`);
  }
  return resolved;
}

function removeXmlElements(xml, elementName, predicate) {
  const expression = new RegExp(`<${elementName}\\b[^>]*/>`, "g");
  return xml.replace(expression, (element) => (predicate(element) ? "" : element));
}

function xmlAttribute(element, name) {
  const match = element.match(new RegExp(`\\b${name}="([^"]*)"`));
  if (!match) return null;
  return match[1].replaceAll("&amp;", "&").replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function decodePackageUri(value) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    throw new Error(`Invalid OPC target URI: ${value}`, { cause: error });
  }
}

function sourcePartForRelationships(relationshipFile) {
  if (relationshipFile === "_rels/.rels") return "";
  const marker = "/_rels/";
  const markerIndex = relationshipFile.lastIndexOf(marker);
  if (markerIndex < 0 || !relationshipFile.endsWith(".rels")) {
    throw new Error(`Invalid OPC relationship part path: ${relationshipFile}`);
  }
  return `${relationshipFile.slice(0, markerIndex)}/${relationshipFile.slice(markerIndex + marker.length, -5)}`;
}

function resolveRelationshipTarget(relationshipFile, rawTarget) {
  const decoded = decodePackageUri(rawTarget);
  const sourcePart = sourcePartForRelationships(relationshipFile);
  const target = decoded.startsWith("/")
    ? path.posix.normalize(decoded).replace(/^\/+/, "")
    : path.posix.normalize(path.posix.join(path.posix.dirname(sourcePart), decoded));
  if (!target || target === ".." || target.startsWith("../") || path.posix.isAbsolute(target)) {
    throw new Error(`Unsafe OPC relationship target from ${relationshipFile}: ${rawTarget}`);
  }
  return target;
}

async function writeXml(archive, name, transform) {
  const entry = archive.file(name);
  if (!entry) return;
  archive.file(name, transform(await entry.async("string")));
}

async function assertOpcIntegrity(archive) {
  const packageFiles = new Set(Object.keys(archive.files).filter((name) => !archive.files[name].dir));
  const contentTypesEntry = archive.file("[Content_Types].xml");
  if (!contentTypesEntry) throw new Error("PPTX package is missing [Content_Types].xml");
  const contentTypes = await contentTypesEntry.async("string");
  for (const match of contentTypes.matchAll(/<Override\b[^>]*\bPartName="([^"]+)"[^>]*\/>/g)) {
    const target = decodePackageUri(xmlAttribute(match[0], "PartName")).replace(/^\/+/, "");
    if (!packageFiles.has(target)) throw new Error(`Missing OPC content-type target: ${target}`);
  }
  for (const relationshipFile of [...packageFiles].filter((name) => name.endsWith(".rels"))) {
    const xml = await archive.file(relationshipFile).async("string");
    for (const match of xml.matchAll(/<Relationship\b[^>]*\/>/g)) {
      if (xmlAttribute(match[0], "TargetMode") === "External") continue;
      const rawTarget = xmlAttribute(match[0], "Target");
      if (rawTarget === null) throw new Error(`OPC relationship has no target: ${relationshipFile}`);
      const target = resolveRelationshipTarget(relationshipFile, rawTarget);
      if (!packageFiles.has(target)) {
        throw new Error(`Missing OPC relationship target from ${relationshipFile}: ${target}`);
      }
    }
  }
}

async function cleanGeneratedPackage(pptxFile) {
  const archive = await JSZip.loadAsync(fs.readFileSync(pptxFile));
  archive.remove("ppt/notesSlides");
  archive.remove("ppt/notesMasters");
  await writeXml(archive, "[Content_Types].xml", (xml) => removeXmlElements(
    xml,
    "Override",
    (element) => {
      const partName = xmlAttribute(element, "PartName");
      if (/^\/ppt\/notes(?:Slides|Masters)\//.test(partName ?? "")) return true;
      if (!/^\/ppt\/slideMasters\/slideMaster\d+\.xml$/.test(partName ?? "")) return false;
      return !archive.file(partName.slice(1));
    },
  ));
  await writeXml(
    archive,
    "ppt/presentation.xml",
    (xml) => xml.replace(/<p:notesMasterIdLst>.*?<\/p:notesMasterIdLst>/s, ""),
  );
  await writeXml(
    archive,
    "docProps/app.xml",
    (xml) => xml.replace(/<Notes>\d+<\/Notes>/, "<Notes>0</Notes>"),
  );
  for (const name of Object.keys(archive.files).filter((entry) => entry.endsWith(".rels"))) {
    await writeXml(archive, name, (xml) => removeXmlElements(
      xml,
      "Relationship",
      (element) => /\/relationships\/notes(?:Slide|Master)"/.test(element),
    ));
  }
  await assertOpcIntegrity(archive);
  const buffer = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.writeFileSync(pptxFile, buffer);
}

function compositionFor(styleId) {
  const composition = STYLE_COMPOSITIONS[styleId];
  if (!composition) throw new Error(`Selected style ${styleId} has no PPTX composition adapter`);
  return composition;
}

function transformGeometry(ctx, options) {
  const transformed = { ...options };
  const transform = ctx.composition.transform;
  if (Number.isFinite(options.x)) transformed.x = transform.x + options.x * transform.width;
  if (Number.isFinite(options.y)) transformed.y = transform.y + options.y * transform.height;
  if (Number.isFinite(options.w)) transformed.w = options.w * transform.width;
  if (Number.isFinite(options.h)) transformed.h = options.h * transform.height;
  return transformed;
}

function rawShape(slide, ctx, shape, options) {
  slide.addShape(ctx.pptx.ShapeType[shape], options);
}

function addShape(slide, ctx, shape, options) {
  rawShape(slide, ctx, shape, transformGeometry(ctx, options));
}

function addText(slide, text, options = {}, ctx = null) {
  const compositionContext = ctx ?? SLIDE_CONTEXTS.get(slide) ?? null;
  slide.addText(String(text), {
    margin: 0,
    breakLine: false,
    fit: "shrink",
    valign: "mid",
    ...(compositionContext ? transformGeometry(compositionContext, options) : options),
  });
}

function secondaryStyleFor(ctx, override) {
  return ctx.secondaryStyle && ctx.secondaryOverrides.has(override) ? ctx.secondaryStyle : ctx.style;
}

function decorateBase(slide, ctx, slideModel) {
  const sectionStyle = slideModel.type === "section"
    ? secondaryStyleFor(ctx, "section-divider")
    : ctx.style;
  const { decoration } = ctx.composition;
  if (decoration === "edge-rail") {
    rawShape(slide, ctx, "line", {
      x: 12.92, y: 0.44, w: 0, h: 5.84,
      line: { color: sectionStyle.primary, width: 1.2, transparency: 10 },
    });
  } else if (decoration === "system-grid") {
    for (const x of [0.42, 3.54, 6.66, 9.78, 12.9]) {
      rawShape(slide, ctx, "line", {
        x, y: 0.28, w: 0, h: 6.76,
        line: { color: sectionStyle.muted, width: 0.45, transparency: 72 },
      });
    }
    rawShape(slide, ctx, "rect", {
      x: 0.18, y: 0.18, w: 1.04, h: 0.14,
      fill: { color: sectionStyle.primary }, line: { color: sectionStyle.primary, transparency: 100 },
    });
  } else if (decoration === "editorial-band") {
    rawShape(slide, ctx, "rect", {
      x: 0, y: 0, w: 0.3, h: SLIDE_HEIGHT,
      fill: { color: sectionStyle.primary }, line: { color: sectionStyle.primary, transparency: 100 },
    });
    rawShape(slide, ctx, "rect", {
      x: 10.86, y: 0, w: 2.47, h: 0.24,
      fill: { color: sectionStyle.secondary }, line: { color: sectionStyle.secondary, transparency: 100 },
    });
  } else if (decoration === "insight-editorial-frame") {
    for (const [x, y, w, h] of [
      [0.18, 0.18, 1.08, 0], [0.18, 0.18, 0, 0.78],
      [12.07, 0.18, 1.08, 0], [13.15, 0.18, 0, 0.78],
      [0.18, 7.28, 1.08, 0], [0.18, 6.5, 0, 0.78],
      [12.07, 7.28, 1.08, 0], [13.15, 6.5, 0, 0.78],
    ]) {
      rawShape(slide, ctx, "line", {
        x, y, w, h, line: { color: sectionStyle.primary, width: 1.1 },
      });
    }
  } else if (decoration === "primitive-blocks") {
    rawShape(slide, ctx, "rect", {
      x: 0, y: 0, w: 0.36, h: 1.42,
      fill: { color: sectionStyle.primary }, line: { color: sectionStyle.primary, transparency: 100 },
    });
    rawShape(slide, ctx, "rect", {
      x: 12.69, y: 5.64, w: 0.64, h: 1.86,
      fill: { color: sectionStyle.secondary }, line: { color: sectionStyle.secondary, transparency: 100 },
    });
    rawShape(slide, ctx, "rect", {
      x: 0.18, y: 7.08, w: 2.1, h: 0.22,
      fill: { color: sectionStyle.warning }, line: { color: sectionStyle.warning, transparency: 100 },
    });
  } else if (decoration === "journal-page") {
    rawShape(slide, ctx, "rect", {
      x: 0.22, y: 0.2, w: 12.89, h: 7.04,
      fill: { color: ctx.style.background, transparency: 100 },
      line: { color: sectionStyle.muted, width: 0.7, transparency: 34 },
    });
    rawShape(slide, ctx, "line", {
      x: 0.52, y: 0.58, w: 12.26, h: 0,
      line: { color: sectionStyle.primary, width: 1.1, transparency: 12 },
    });
  }
}

function addBase(slide, ctx, slideModel) {
  SLIDE_CONTEXTS.set(slide, ctx);
  rawShape(slide, ctx, "rect", {
    x: 0,
    y: 0,
    w: SLIDE_WIDTH,
    h: SLIDE_HEIGHT,
    fill: { color: ctx.style.background },
    line: { color: ctx.style.background, transparency: 100 },
  });
  decorateBase(slide, ctx, slideModel);
  addShape(slide, ctx, "line", {
    x: 0.58,
    y: 7.05,
    w: 12.17,
    h: 0,
    line: { color: ctx.style.muted, transparency: 55, width: ctx.style.lineWidth },
  });
  addText(slide, slideModel.id, {
    x: 0.6,
    y: 7.12,
    w: 0.8,
    h: 0.18,
    fontFace: ctx.style.monoFont,
    fontSize: 8,
    color: ctx.style.muted,
    charSpacing: 0,
  }, ctx);
  if (slideModel.sourceRefs.length) {
    addText(slide, slideModel.sourceRefs.join(" · "), {
      x: 6.7,
      y: 7.1,
      w: 6.05,
      h: 0.2,
      align: "right",
      fontFace: ctx.style.bodyFont,
      fontSize: 7.5,
      color: ctx.style.muted,
    }, ctx);
  }
}

function addHeader(slide, ctx, slideModel, kicker = slideModel.type.toUpperCase()) {
  addText(slide, kicker, {
    x: 0.62,
    y: 0.38,
    w: 2.7,
    h: 0.25,
    fontFace: ctx.style.monoFont,
    fontSize: 9,
    bold: true,
    color: ctx.style.primary,
    charSpacing: 0,
  });
  addText(slide, slideModel.title, {
    x: 0.62,
    y: 0.7,
    w: 10.9,
    h: 0.55,
    fontFace: ctx.style.displayFont,
    fontSize: 24,
    bold: true,
    color: ctx.style.text,
  });
  if (slideModel.subtitle) {
    addText(slide, slideModel.subtitle, {
      x: 0.64,
      y: 1.3,
      w: 10.8,
      h: 0.34,
      fontFace: ctx.style.bodyFont,
      fontSize: 11,
      color: ctx.style.muted,
    });
  }
}

function bodyText(slideModel) {
  return slideModel.body.join("\n");
}

function metricParts(metric) {
  if (metric === null) return { value: "", label: "" };
  if (typeof metric === "object") return { value: String(metric.value), label: metric.label };
  return { value: String(metric), label: "" };
}

function addCover(slide, ctx, model) {
  addBase(slide, ctx, model);
  addShape(slide, ctx, "rect", {
    x: 0.62, y: 0.62, w: 0.14, h: 5.8,
    fill: { color: ctx.style.primary }, line: { color: ctx.style.primary, transparency: 100 },
  });
  addText(slide, "RESEARCH BRIEF", {
    x: 1.05, y: 0.78, w: 2.8, h: 0.35,
    fontFace: ctx.style.monoFont, fontSize: 10, bold: true, color: ctx.style.secondary,
  });
  addText(slide, model.title, {
    x: 1.02, y: 1.42, w: 9.6, h: 1.55,
    fontFace: ctx.style.displayFont, fontSize: 34, bold: true, color: ctx.style.text,
  });
  if (model.subtitle) addText(slide, model.subtitle, {
    x: 1.05, y: 3.2, w: 8.3, h: 0.72,
    fontFace: ctx.style.bodyFont, fontSize: 18, color: ctx.style.muted,
  });
  if (model.body.length) addText(slide, bodyText(model), {
    x: 1.05, y: 5.72, w: 4.8, h: 0.32,
    fontFace: ctx.style.monoFont, fontSize: 10, color: ctx.style.text,
  });
  addShape(slide, ctx, "ellipse", {
    x: 10.72, y: 1.12, w: 1.72, h: 1.72,
    fill: { color: ctx.style.surface }, line: { color: ctx.style.primary, width: ctx.style.lineWidth },
  });
  addShape(slide, ctx, "ellipse", {
    x: 11.36, y: 1.76, w: 0.45, h: 0.45,
    fill: { color: ctx.style.secondary }, line: { color: ctx.style.secondary, transparency: 100 },
  });
}

function addSection(slide, ctx, model) {
  addBase(slide, ctx, model);
  addText(slide, model.title.split("/")[0].trim(), {
    x: 0.62, y: 0.55, w: 3.2, h: 1.25,
    fontFace: ctx.style.displayFont, fontSize: 46, bold: true, color: ctx.style.primary,
  });
  addShape(slide, ctx, "line", {
    x: 0.66, y: 2.1, w: 3.8, h: 0,
    line: { color: ctx.style.secondary, width: 3 },
  });
  addText(slide, model.title.includes("/") ? model.title.split("/").slice(1).join("/").trim() : model.title, {
    x: 4.82, y: 2.02, w: 7.7, h: 1.18,
    fontFace: ctx.style.displayFont, fontSize: 30, bold: true, color: ctx.style.text,
  });
  if (model.subtitle) addText(slide, model.subtitle, {
    x: 4.84, y: 3.35, w: 6.9, h: 0.7,
    fontFace: ctx.style.bodyFont, fontSize: 17, color: ctx.style.muted,
  });
  if (model.body.length) addText(slide, bodyText(model), {
    x: 4.84, y: 4.35, w: 6.7, h: 0.75,
    fontFace: ctx.style.bodyFont, fontSize: 12, color: ctx.style.text,
  });
}

function addStatement(slide, ctx, model) {
  addBase(slide, ctx, model);
  addText(slide, "THESIS", {
    x: 0.64, y: 0.52, w: 1.5, h: 0.3,
    fontFace: ctx.style.monoFont, fontSize: 9, bold: true, color: ctx.style.secondary,
  });
  addText(slide, model.title, {
    x: 0.76, y: 1.28, w: 11.5, h: 2.72,
    fontFace: ctx.style.displayFont, fontSize: 30, bold: true, color: ctx.style.text,
  });
  addShape(slide, ctx, "line", {
    x: 0.8, y: 4.35, w: 2.1, h: 0,
    line: { color: ctx.style.primary, width: 4 },
  });
  if (model.subtitle) addText(slide, model.subtitle, {
    x: 0.8, y: 4.65, w: 6.9, h: 0.6,
    fontFace: ctx.style.bodyFont, fontSize: 16, bold: true, color: ctx.style.primary,
  });
  if (model.body.length) addText(slide, bodyText(model), {
    x: 7.9, y: 4.45, w: 4.3, h: 1.15,
    fontFace: ctx.style.bodyFont, fontSize: 12, color: ctx.style.muted,
  });
}

function addData(slide, ctx, model) {
  addBase(slide, ctx, model);
  addHeader(slide, ctx, model, "DATA / EVALUATION");
  const chartStyle = secondaryStyleFor(ctx, "chart-treatment");
  const metric = metricParts(model.metric);
  addText(slide, metric.value, {
    x: 0.65, y: 2.2, w: 2.8, h: 1.15,
    fontFace: ctx.style.displayFont, fontSize: 42, bold: true, color: chartStyle.primary,
  });
  addText(slide, metric.label, {
    x: 0.68, y: 3.34, w: 2.5, h: 0.5,
    fontFace: ctx.style.bodyFont, fontSize: 11, color: ctx.style.muted,
  });
  if (model.body.length) addText(slide, bodyText(model), {
    x: 0.68, y: 4.28, w: 2.65, h: 0.8,
    fontFace: ctx.style.bodyFont, fontSize: 11, color: ctx.style.text,
  });
  const data = model.sections;
  if (data.length) {
    slide.addChart(ctx.pptx.ChartType.bar, [{
      name: metric.label || "Value",
      labels: data.map((section) => section.title),
      values: data.map((section) => section.value),
    }], {
      ...transformGeometry(ctx, { x: 3.7, y: 1.95, w: 8.85, h: 4.62 }),
      catAxisLabelFontFace: ctx.style.bodyFont,
      catAxisLabelFontSize: 10,
      chartColors: [chartStyle.primary],
      showLegend: false,
      showTitle: false,
      showValue: true,
      showCatName: false,
      valAxisLabelFontFace: ctx.style.bodyFont,
      valAxisLabelFontSize: 9,
      valAxisMinVal: 0,
      valAxisMaxVal: 100,
      valGridLine: { color: chartStyle.muted, transparency: 70, width: 1 },
      dataLabelColor: ctx.style.text,
      dataLabelPosition: "outEnd",
      border: { color: ctx.style.background, transparency: 100 },
    });
  }
}

function addProcess(slide, ctx, model) {
  addBase(slide, ctx, model);
  addHeader(slide, ctx, model, "OPERATING LOOP");
  const sections = model.sections;
  const width = 2.7;
  sections.forEach((section, index) => {
    const x = 0.66 + index * 3.12;
    if (index < sections.length - 1) addShape(slide, ctx, "chevron", {
      x: x + 2.55, y: 3.32, w: 0.62, h: 0.52,
      fill: { color: ctx.style.primary }, line: { color: ctx.style.primary, transparency: 100 },
    });
    addShape(slide, ctx, "roundRect", {
      x, y: 2.35, w: width, h: 2.52,
      rectRadius: 0.05,
      fill: { color: index % 2 ? ctx.style.background : ctx.style.surface },
      line: { color: index % 2 ? ctx.style.secondary : ctx.style.primary, width: ctx.style.lineWidth },
    });
    addText(slide, String(index + 1).padStart(2, "0"), {
      x: x + 0.2, y: 2.58, w: 0.48, h: 0.35,
      fontFace: ctx.style.monoFont, fontSize: 10, bold: true, color: ctx.style.secondary,
    });
    addText(slide, section.title, {
      x: x + 0.2, y: 3.02, w: 2.25, h: 0.45,
      fontFace: ctx.style.displayFont, fontSize: 17, bold: true, color: ctx.style.text,
    });
    addText(slide, section.body ?? "", {
      x: x + 0.2, y: 3.62, w: 2.2, h: 0.78,
      fontFace: ctx.style.bodyFont, fontSize: 10, color: ctx.style.muted,
    });
  });
}

function addComparison(slide, ctx, model) {
  addBase(slide, ctx, model);
  addHeader(slide, ctx, model, "COMPARISON");
  model.sections.forEach((section, index) => {
    const x = 0.66 + index * 6.18;
    addShape(slide, ctx, "rect", {
      x, y: 2.0, w: 5.78, h: 4.35,
      fill: { color: index === 0 ? ctx.style.surface : ctx.style.background },
      line: { color: index === 0 ? ctx.style.muted : ctx.style.primary, width: ctx.style.lineWidth },
    });
    addShape(slide, ctx, "rect", {
      x, y: 2.0, w: 5.78, h: 0.12,
      fill: { color: index === 0 ? ctx.style.secondary : ctx.style.primary },
      line: { color: index === 0 ? ctx.style.secondary : ctx.style.primary, transparency: 100 },
    });
    addText(slide, section.title, {
      x: x + 0.35, y: 2.4, w: 4.9, h: 0.55,
      fontFace: ctx.style.displayFont, fontSize: 22, bold: true, color: ctx.style.text,
    });
    const items = section.items ?? (section.body ? [section.body] : []);
    addText(slide, items.map((item) => `•  ${item}`).join("\n\n"), {
      x: x + 0.4, y: 3.22, w: 4.9, h: 2.35,
      fontFace: ctx.style.bodyFont, fontSize: 13, color: ctx.style.text,
      breakLine: true,
    });
  });
}

function addCaseStudy(slide, ctx, model) {
  addBase(slide, ctx, model);
  addHeader(slide, ctx, model, "FIELD NOTE");
  addText(slide, bodyText(model), {
    x: 0.68, y: 2.03, w: 7.2, h: 1.05,
    fontFace: ctx.style.bodyFont, fontSize: 15, color: ctx.style.text,
  });
  model.sections.forEach((section, index) => {
    addShape(slide, ctx, "line", {
      x: 0.7, y: 3.48 + index * 1.25, w: 0.55, h: 0,
      line: { color: index ? ctx.style.secondary : ctx.style.primary, width: 4 },
    });
    addText(slide, section.title, {
      x: 1.48, y: 3.25 + index * 1.25, w: 1.45, h: 0.35,
      fontFace: ctx.style.monoFont, fontSize: 9, bold: true, color: ctx.style.muted,
    });
    addText(slide, section.body ?? "", {
      x: 2.95, y: 3.18 + index * 1.25, w: 4.8, h: 0.55,
      fontFace: ctx.style.bodyFont, fontSize: 11.5, color: ctx.style.text,
    });
  });
  const metric = metricParts(model.metric);
  addShape(slide, ctx, "rect", {
    x: 8.45, y: 2.05, w: 4.15, h: 3.8,
    fill: { color: ctx.style.surface }, line: { color: ctx.style.primary, width: ctx.style.lineWidth },
  });
  addText(slide, metric.value, {
    x: 8.83, y: 2.58, w: 3.3, h: 1.1,
    align: "center", fontFace: ctx.style.displayFont, fontSize: 38, bold: true, color: ctx.style.secondary,
  });
  addText(slide, metric.label, {
    x: 9.0, y: 3.78, w: 2.95, h: 0.55,
    align: "center", fontFace: ctx.style.bodyFont, fontSize: 12, color: ctx.style.text,
  });
}

function addTimeline(slide, ctx, model) {
  addBase(slide, ctx, model);
  addHeader(slide, ctx, model, "TIMELINE");
  const sections = model.sections;
  addShape(slide, ctx, "line", {
    x: 1.15, y: 3.65, w: 10.95, h: 0,
    line: { color: ctx.style.primary, width: 2.5 },
  });
  sections.forEach((section, index) => {
    const x = 1.15 + index * 3.62;
    addShape(slide, ctx, "ellipse", {
      x: x - 0.17, y: 3.48, w: 0.34, h: 0.34,
      fill: { color: index === sections.length - 1 ? ctx.style.secondary : ctx.style.primary },
      line: { color: ctx.style.background, width: 1.5 },
    });
    addText(slide, section.title, {
      x: x - 0.78, y: index % 2 ? 3.98 : 2.62, w: 2.2, h: 0.45,
      fontFace: ctx.style.displayFont, fontSize: 16, bold: true, color: ctx.style.text,
    });
    addText(slide, section.body ?? "", {
      x: x - 0.78, y: index % 2 ? 4.48 : 3.05, w: 2.2, h: 0.35,
      fontFace: ctx.style.monoFont, fontSize: 9, color: ctx.style.muted,
    });
  });
}

function addMatrix(slide, ctx, model) {
  addBase(slide, ctx, model);
  addHeader(slide, ctx, model, "DECISION MATRIX");
  const sections = model.sections;
  sections.forEach((section, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 2.05 + column * 5.02;
    const y = 2.02 + row * 2.16;
    addShape(slide, ctx, "rect", {
      x, y, w: 4.82, h: 1.94,
      fill: { color: index === 0 ? ctx.style.surface : ctx.style.background },
      line: { color: index === 0 ? ctx.style.secondary : ctx.style.muted, width: ctx.style.lineWidth },
    });
    addText(slide, section.title, {
      x: x + 0.28, y: y + 0.28, w: 3.9, h: 0.42,
      fontFace: ctx.style.displayFont, fontSize: 16, bold: true,
      color: index === 0 ? ctx.style.secondary : ctx.style.text,
    });
    addText(slide, section.body ?? "", {
      x: x + 0.28, y: y + 0.86, w: 3.95, h: 0.42,
      fontFace: ctx.style.bodyFont, fontSize: 10.5, color: ctx.style.muted,
    });
  });
  addText(slide, "VALUE  →", {
    x: 5.08, y: 6.38, w: 2.2, h: 0.25,
    align: "center", fontFace: ctx.style.monoFont, fontSize: 8.5, bold: true, color: ctx.style.primary,
  });
  addText(slide, "READINESS  →", {
    x: 0.48, y: 3.45, w: 1.1, h: 0.25, rotate: 270,
    align: "center", fontFace: ctx.style.monoFont, fontSize: 8.5, bold: true, color: ctx.style.primary,
  });
}

function addImage(slide, ctx, model) {
  addBase(slide, ctx, model);
  addHeader(slide, ctx, model, "SYSTEM VIEW");
  addShape(slide, ctx, "rect", {
    x: 0.68, y: 1.88, w: 8.15, h: 4.72,
    fill: { color: ctx.style.surface }, line: { color: ctx.style.muted, width: ctx.style.lineWidth },
  });
  if (model.image) {
    slide.addImage({
      path: model.image,
      ...transformGeometry(ctx, { x: 0.76, y: 1.96, w: 7.99, h: 4.56 }),
      transparency: 0,
    });
    const calloutTop = model.body.length ? 3.35 : 2.15;
    const calloutHeight = (6.48 - calloutTop) / Math.max(1, model.sections.length);
    model.sections.forEach((section, index) => {
      const y = calloutTop + index * calloutHeight;
      addShape(slide, ctx, "line", {
        x: 9.25, y: y + 0.16, w: 0.34, h: 0,
        line: { color: index % 2 ? ctx.style.secondary : ctx.style.primary, width: 2.5 },
      });
      addText(slide, section.title, {
        x: 9.72, y, w: 2.72, h: 0.34,
        fontFace: ctx.style.displayFont, fontSize: 12, bold: true, color: ctx.style.text,
      });
      addText(slide, section.body, {
        x: 9.72, y: y + 0.38, w: 2.72, h: Math.min(0.52, calloutHeight - 0.42),
        fontFace: ctx.style.bodyFont, fontSize: 8.5, color: ctx.style.muted,
      });
    });
  } else {
    const nodes = model.sections;
    const positions = {
      1: [[3.88, 3.05]],
      2: [[1.22, 3.05], [6.05, 3.05]],
      3: [[1.22, 3.15], [3.62, 2.42], [6.05, 3.15]],
    }[nodes.length];
    for (let index = 0; index < nodes.length - 1; index += 1) {
      const [fromX, fromY] = positions[index];
      const [toX, toY] = positions[index + 1];
      addShape(slide, ctx, "line", {
        x: fromX + 1.75,
        y: fromY + 0.675,
        w: toX - fromX - 1.75,
        h: toY - fromY,
        line: { color: index % 2 ? ctx.style.secondary : ctx.style.primary, width: 2 },
      });
    }
    nodes.forEach((section, index) => {
      const [x, y] = positions[index];
      addShape(slide, ctx, "roundRect", {
        x, y, w: 1.75, h: 1.35,
        fill: { color: ctx.style.background },
        line: { color: index === 1 ? ctx.style.secondary : ctx.style.primary, width: 1.5 },
      });
      addText(slide, section.title, {
        x: x + 0.13, y: y + 0.18, w: 1.48, h: 0.32,
        align: "center", fontFace: ctx.style.displayFont, fontSize: 13, bold: true, color: ctx.style.text,
      });
      addText(slide, section.body ?? "", {
        x: x + 0.13, y: y + 0.62, w: 1.48, h: 0.45,
        align: "center", fontFace: ctx.style.bodyFont, fontSize: 8.5, color: ctx.style.muted,
      });
    });
  }
  if (model.body.length) addText(slide, bodyText(model), {
    x: 9.25, y: 2.18, w: 3.25, h: 1.35,
    fontFace: ctx.style.bodyFont, fontSize: 13, color: ctx.style.text,
  });
  if (!model.image || model.sections.length === 0) {
    addShape(slide, ctx, "line", {
      x: 9.27, y: 4.05, w: 1.25, h: 0,
      line: { color: ctx.style.secondary, width: 4 },
    });
  }
}

function addQuote(slide, ctx, model) {
  addBase(slide, ctx, model);
  addText(slide, "“", {
    x: 0.62, y: 0.48, w: 1.45, h: 1.4,
    fontFace: ctx.style.displayFont, fontSize: 68, bold: true, color: ctx.style.secondary,
  });
  addText(slide, model.title, {
    x: 1.55, y: 1.42, w: 10.25, h: 2.45,
    fontFace: ctx.style.displayFont, fontSize: 30, bold: true, italic: true, color: ctx.style.text,
  });
  if (model.subtitle) addText(slide, model.subtitle, {
    x: 1.6, y: 4.26, w: 5.8, h: 0.5,
    fontFace: ctx.style.bodyFont, fontSize: 13, bold: true, color: ctx.style.primary,
  });
  if (model.body.length) addText(slide, bodyText(model), {
    x: 7.55, y: 4.16, w: 4.2, h: 0.75,
    fontFace: ctx.style.bodyFont, fontSize: 11, color: ctx.style.muted,
  });
}

function addSummary(slide, ctx, model) {
  addBase(slide, ctx, model);
  addHeader(slide, ctx, model, "SUMMARY");
  model.sections.forEach((section, index) => {
    const x = 0.66 + index * 4.17;
    addShape(slide, ctx, "rect", {
      x, y: 2.15, w: 3.78, h: 3.65,
      fill: { color: index === 1 ? ctx.style.surface : ctx.style.background },
      line: { color: index === 2 ? ctx.style.secondary : ctx.style.primary, width: ctx.style.lineWidth },
    });
    addText(slide, String(index + 1).padStart(2, "0"), {
      x: x + 0.28, y: 2.48, w: 0.65, h: 0.38,
      fontFace: ctx.style.monoFont, fontSize: 10, bold: true,
      color: index === 2 ? ctx.style.secondary : ctx.style.primary,
    });
    addText(slide, section.title, {
      x: x + 0.28, y: 3.05, w: 3.05, h: 0.55,
      fontFace: ctx.style.displayFont, fontSize: 19, bold: true, color: ctx.style.text,
    });
    addText(slide, section.body ?? "", {
      x: x + 0.28, y: 3.9, w: 3.0, h: 1.05,
      fontFace: ctx.style.bodyFont, fontSize: 11, color: ctx.style.muted,
    });
  });
}

const layoutBuilders = {
  cover: addCover,
  section: addSection,
  statement: addStatement,
  data: addData,
  process: addProcess,
  comparison: addComparison,
  "case-study": addCaseStudy,
  timeline: addTimeline,
  matrix: addMatrix,
  image: addImage,
  quote: addQuote,
  summary: addSummary,
};

export async function buildPptx({ modelFile, styleId, outputFile } = {}) {
  const loaded = readModel(modelFile);
  const style = loadStyle(styleId);
  validateModel(loaded.model, styleId, loaded.modelFile);
  const composition = compositionFor(styleId);
  const secondaryStyleId = loaded.model.meta.secondaryStyleId ?? null;
  const secondaryStyle = secondaryStyleId ? loadStyle(secondaryStyleId) : null;
  const secondaryOverrides = new Set(loaded.model.meta.secondaryOverrides ?? []);
  const resolvedOutput = resolveOutputFile(outputFile, loaded.modelFile);

  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Sherry PPT Skill";
  pptx.company = "";
  pptx.subject = loaded.model.meta.title;
  pptx.title = loaded.model.meta.title;
  pptx.lang = "en-US";
  pptx.theme = {
    headFontFace: style.displayFont,
    bodyFontFace: style.bodyFont,
    lang: "en-US",
  };
  pptx.defineSlideMaster({
    title: "SHERRY_EDITABLE_WIDE",
    background: { color: style.background },
    objects: [],
    slideNumber: { x: 12.1, y: 7.1, w: 0.62, h: 0.18, color: style.muted, fontFace: style.monoFont, fontSize: 8 },
  });

  const context = { pptx, style, composition, secondaryStyle, secondaryOverrides };
  for (const slideModel of loaded.model.slides) {
    const slide = pptx.addSlide("SHERRY_EDITABLE_WIDE");
    layoutBuilders[slideModel.type](slide, context, slideModel);
  }

  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  const temporaryFile = `${resolvedOutput}.${process.pid}.${randomUUID()}.tmp.pptx`;
  try {
    await pptx.writeFile({ fileName: temporaryFile });
    await cleanGeneratedPackage(temporaryFile);
    fs.renameSync(temporaryFile, resolvedOutput);
  } catch (error) {
    fs.rmSync(temporaryFile, { force: true });
    throw new Error(`Failed to write PPTX ${resolvedOutput}: ${error.message}`, { cause: error });
  }
  return {
    outputFile: resolvedOutput,
    slideCount: loaded.model.slides.length,
    compositionId: composition.id,
    secondaryStyleId,
    secondaryOverrides: [...secondaryOverrides],
  };
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = { "--model": "modelFile", "--style": "styleId", "--output": "outputFile" }[argv[index]];
    if (!key || index + 1 >= argv.length || parsed[key]) {
      throw new Error(`Unknown, duplicate, or incomplete argument: ${argv[index]}`);
    }
    parsed[key] = argv[index + 1];
    index += 1;
  }
  if (!parsed.modelFile || !parsed.styleId || !parsed.outputFile) {
    throw new Error("Usage: node scripts/build-pptx.mjs --model /path/to/deck-model.json --style style-id --output /path/to/deck.pptx");
  }
  return parsed;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await buildPptx(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
