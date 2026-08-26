import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const SKILL_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const SHELL_ROOT = path.join(SKILL_ROOT, "assets", "deck-shell");
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);
const ACTIVE_ELEMENTS = new Set([
  "audio", "base", "embed", "form", "frame", "iframe", "link", "meta", "object",
  "portal", "source", "track", "video",
]);
const RESOURCE_ATTRIBUTES = new Set([
  "action", "background", "cite", "data", "formaction", "href", "longdesc", "manifest",
  "ping", "poster", "src", "srcset", "xlink:href",
]);
const SVG_URL_PRESENTATION_ATTRIBUTES = new Set([
  "clip-path", "color-profile", "cursor", "fill", "filter", "marker", "marker-end",
  "marker-mid", "marker-start", "mask", "stroke",
]);
const SAFE_IMAGE_DATA_TYPES = new Set([
  "image/apng", "image/avif", "image/gif", "image/jpeg", "image/png", "image/svg+xml",
  "image/webp",
]);
const SAFE_FONT_DATA_TYPES = new Set([
  "application/font-woff", "application/vnd.ms-fontobject", "font/otf", "font/sfnt",
  "font/ttf", "font/woff", "font/woff2",
]);

function svgPresentationValueIsSafe(value) {
  const trimmed = value.trim();
  if (/[&\\]/.test(trimmed)) return false;
  if (/^url\(\s*(['"]?)#[A-Za-z][A-Za-z0-9_.:-]*\1\s*\)$/i.test(trimmed)) return true;
  return !/\b(?:url|var|attr|image|image-set|cross-fade|element)\s*\(/i.test(trimmed);
}
const MIME_TYPES = new Map([
  [".apng", "image/apng"],
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".eot", "application/vnd.ms-fontobject"],
]);

function failMalformed(file, detail) {
  throw new Error(`Malformed chapter ${file}: ${detail}`);
}

function tagEnd(source, start, file) {
  let quote = null;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index + 1;
    }
  }
  failMalformed(file, "unterminated tag");
}

function parseAttributes(source, contentStart, contentEnd, nameEnd, file) {
  const attributes = new Map();
  let cursor = nameEnd;
  while (cursor < contentEnd) {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (cursor >= contentEnd || source[cursor] === "/") break;

    const attributeStart = cursor;
    while (cursor < contentEnd && !/[\s=/>]/.test(source[cursor])) cursor += 1;
    if (cursor === attributeStart) failMalformed(file, "invalid attribute syntax");
    const name = source.slice(attributeStart, cursor).toLowerCase();
    if (attributes.has(name)) failMalformed(file, `duplicate attribute ${name}`);
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;

    let value = null;
    let valueStart = null;
    let valueEnd = null;
    if (source[cursor] === "=") {
      cursor += 1;
      while (/\s/.test(source[cursor] ?? "")) cursor += 1;
      const quote = source[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        valueStart = cursor;
        while (cursor < contentEnd && source[cursor] !== quote) cursor += 1;
        if (cursor >= contentEnd) failMalformed(file, `unterminated ${name} attribute`);
        valueEnd = cursor;
        value = source.slice(valueStart, valueEnd);
        cursor += 1;
      } else {
        valueStart = cursor;
        while (cursor < contentEnd && !/[\s>]/.test(source[cursor])) cursor += 1;
        valueEnd = cursor;
        if (valueStart === valueEnd) failMalformed(file, `empty ${name} attribute`);
        value = source.slice(valueStart, valueEnd);
      }
    }
    attributes.set(name, { name, value, valueStart, valueEnd });
  }
  return attributes;
}

export function tokenizeHtml(source, file = "HTML") {
  const tokens = [];
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open < 0) {
      tokens.push({ type: "text", start: cursor, end: source.length });
      break;
    }
    if (open > cursor) tokens.push({ type: "text", start: cursor, end: open });
    if (source.startsWith("<!--", open)) {
      const close = source.indexOf("-->", open + 4);
      if (close < 0) failMalformed(file, "unterminated comment");
      tokens.push({ type: "comment", start: open, end: close + 3 });
      cursor = close + 3;
      continue;
    }
    if (source.startsWith("<!", open) || source.startsWith("<?", open)) {
      const end = tagEnd(source, open, file);
      tokens.push({ type: "declaration", start: open, end });
      cursor = end;
      continue;
    }

    const end = tagEnd(source, open, file);
    const closing = /^<\s*\//.test(source.slice(open, end));
    const nameMatch = source.slice(open).match(/^<\s*\/?\s*([A-Za-z][A-Za-z0-9:-]*)/);
    if (!nameMatch) failMalformed(file, "invalid tag");
    const name = nameMatch[1].toLowerCase();
    const nameAbsoluteEnd = open + nameMatch[0].length;
    const selfClosing = !closing && /\/\s*>$/.test(source.slice(open, end));
    const attributes = closing
      ? new Map()
      : parseAttributes(source, open + 1, end - 1, nameAbsoluteEnd, file);
    tokens.push({
      type: closing ? "close" : "open",
      name,
      start: open,
      end,
      selfClosing,
      attributes,
    });
    cursor = end;

    if (!closing && !selfClosing && RAW_TEXT_ELEMENTS.has(name)) {
      const expression = new RegExp(`<\\/\\s*${name}\\s*>`, "ig");
      expression.lastIndex = cursor;
      const match = expression.exec(source);
      if (!match) failMalformed(file, `unclosed ${name} element`);
      if (match.index > cursor) tokens.push({ type: "text", start: cursor, end: match.index });
      tokens.push({ type: "close", name, start: match.index, end: expression.lastIndex, attributes: new Map() });
      cursor = expression.lastIndex;
    }
  }
  return tokens;
}

function classNames(token) {
  return (token.attributes.get("class")?.value ?? "").split(/\s+/).filter(Boolean);
}

function isSlideToken(token) {
  return token.type === "open" && token.name === "section" && classNames(token).includes("slide");
}

export function inspectSlideSections(source, file = "HTML") {
  const tokens = tokenizeHtml(source, file);
  const slides = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!isSlideToken(token)) continue;
    if (token.selfClosing) throw new Error(`Malformed chapter ${file}: slide sections cannot be self-closing`);
    const endIndex = findMatchingSection(tokens, index, file);
    slides.push({
      id: token.attributes.get("id")?.value ?? null,
      start: token.start,
      end: tokens[endIndex].end,
    });
    index = endIndex;
  }
  return slides;
}

function validateElementBalance(tokens, startIndex, endIndex, file) {
  const stack = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const token = tokens[index];
    if (token.type === "open" && !token.selfClosing && !VOID_ELEMENTS.has(token.name)) {
      stack.push(token.name);
    } else if (token.type === "close") {
      const expected = stack.pop();
      if (expected !== token.name) {
        failMalformed(file, `expected </${expected ?? "none"}> before </${token.name}>`);
      }
    }
  }
  if (stack.length > 0) failMalformed(file, `unclosed <${stack.at(-1)}> element`);
}

function findMatchingSection(tokens, startIndex, file) {
  let depth = 0;
  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "open" && token.name === "section") {
      if (index !== startIndex && isSlideToken(token)) {
        throw new Error(`Nested slide section in ${file}`);
      }
      if (token.selfClosing) continue;
      depth += 1;
    } else if (token.type === "close" && token.name === "section") {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) break;
    }
  }
  throw new Error(`Malformed chapter ${file}: unclosed slide section`);
}

function noteElement(token) {
  if (token.type !== "open") return false;
  const classes = classNames(token);
  return token.name === "speaker-note"
    || token.name === "speaker-notes"
    || classes.includes("speaker-note")
    || classes.includes("speaker-notes")
    || token.attributes.has("data-speaker-note")
    || token.attributes.has("data-speaker-notes");
}

function stripSpeakerNotes(slide, file) {
  const tokens = tokenizeHtml(slide, file);
  const removals = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!noteElement(token)) continue;
    if (token.selfClosing || VOID_ELEMENTS.has(token.name)) {
      removals.push([token.start, token.end]);
      continue;
    }
    let depth = 1;
    let end = null;
    for (let nested = index + 1; nested < tokens.length; nested += 1) {
      if (tokens[nested].type === "open" && tokens[nested].name === token.name
        && !tokens[nested].selfClosing) depth += 1;
      if (tokens[nested].type === "close" && tokens[nested].name === token.name) depth -= 1;
      if (depth === 0) {
        end = tokens[nested].end;
        index = nested;
        break;
      }
    }
    if (end === null) failMalformed(file, "unclosed speaker-note element");
    removals.push([token.start, end]);
  }
  return removals
    .sort((left, right) => right[0] - left[0])
    .reduce((result, [start, end]) => result.slice(0, start) + result.slice(end), slide);
}

function parseChapter(source, file) {
  const tokens = tokenizeHtml(source, file);
  const slides = [];
  const chapterCss = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "text") {
      if (source.slice(token.start, token.end).trim()) failMalformed(file, "text outside a slide");
      continue;
    }
    if (token.type === "comment") continue;
    if (token.type === "open" && token.name === "style" && !token.selfClosing) {
      const cssToken = tokens[index + 1];
      const closeToken = tokens[index + 2];
      if (!cssToken || cssToken.type !== "text" || !closeToken
        || closeToken.type !== "close" || closeToken.name !== "style") {
        failMalformed(file, "invalid chapter style block");
      }
      chapterCss.push(source.slice(cssToken.start, cssToken.end));
      index += 2;
      continue;
    }
    if (!isSlideToken(token)) failMalformed(file, "only chapter styles and slide sections are allowed");
    if (token.selfClosing) failMalformed(file, "slide sections cannot be self-closing");

    const id = token.attributes.get("id")?.value;
    if (!id || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) {
      failMalformed(file, "each slide requires a safe, non-empty id");
    }
    const endIndex = findMatchingSection(tokens, index, file);
    validateElementBalance(tokens, index, endIndex, file);
    slides.push({
      id,
      html: stripSpeakerNotes(source.slice(token.start, tokens[endIndex].end), file),
    });
    index = endIndex;
  }
  return { slides, chapterCss };
}

function decodeHtmlText(value) {
  return value
    .replace(/&#x([0-9A-F]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'");
}

function normalizeParityText(value) {
  return decodeHtmlText(String(value)).replace(/\s+/g, " ").trim();
}

function parityClassification(token) {
  const kinds = [
    ["screen", token.attributes.has("data-deck-text")],
    ["source", token.attributes.has("data-source-ref")],
    ["decorative", token.attributes.has("data-decorative")],
  ].filter(([, present]) => present).map(([kind]) => kind);
  if (kinds.length > 1) {
    throw new Error(`Parity marker conflict on <${token.name}>: ${kinds.join(", ")}`);
  }
  return kinds[0] ?? null;
}

function extractSlideParity(slide, file) {
  const tokens = tokenizeHtml(slide.html, file);
  const root = tokens.find(isSlideToken);
  if (!root) throw new Error(`Parity slide ${slide.id} has no slide section`);
  const type = root.attributes.get("data-slide-type")?.value;
  if (!type) throw new Error(`Parity slide ${slide.id} requires data-slide-type`);

  const stack = [];
  const screenText = [];
  const sourceRefs = [];
  const titles = [];
  const untracked = [];
  for (const token of tokens) {
    if (token.type === "open") {
      const kind = parityClassification(token);
      if (kind && stack.some((frame) => frame.kind && frame.kind !== "decorative")) {
        throw new Error(`Parity slide ${slide.id} cannot nest classified text markers`);
      }
      const frame = {
        name: token.name,
        kind,
        title: token.attributes.has("data-deck-title"),
        text: [],
      };
      stack.push(frame);
      if (token.selfClosing || VOID_ELEMENTS.has(token.name)) {
        stack.pop();
        if (kind === "screen" || kind === "source") {
          throw new Error(`Parity slide ${slide.id} has an empty ${kind} marker`);
        }
      }
      continue;
    }
    if (token.type === "text") {
      const normalized = normalizeParityText(slide.html.slice(token.start, token.end));
      if (!normalized) continue;
      const classified = [...stack].reverse().find(({ kind }) => kind);
      if (!classified) untracked.push(normalized);
      else if (classified.kind !== "decorative") classified.text.push(normalized);
      continue;
    }
    if (token.type === "close") {
      const frame = stack.pop();
      if (!frame || frame.name !== token.name) {
        throw new Error(`Parity slide ${slide.id} has malformed element balance`);
      }
      if (frame.kind === "screen" || frame.kind === "source") {
        const text = normalizeParityText(frame.text.join(" "));
        if (!text) throw new Error(`Parity slide ${slide.id} has an empty ${frame.kind} marker`);
        if (frame.kind === "screen") screenText.push(text);
        else sourceRefs.push(text);
        if (frame.title) titles.push(text);
      } else if (frame.title) {
        throw new Error(`Parity slide ${slide.id} data-deck-title must also use data-deck-text`);
      }
    }
  }
  if (untracked.length > 0) {
    throw new Error(`Parity slide ${slide.id} has untracked visible text: ${untracked.join(" | ")}`);
  }
  if (titles.length !== 1) {
    throw new Error(`Parity slide ${slide.id} requires exactly one data-deck-title marker`);
  }
  return { id: slide.id, type, title: titles[0], screenText, sourceRefs };
}

function modelScreenText(slide) {
  const values = [slide.title];
  if (slide.subtitle !== undefined) values.push(slide.subtitle);
  values.push(...(slide.body ?? []));
  if (slide.metric !== null && slide.metric !== undefined) {
    values.push(String(slide.metric.value), slide.metric.label);
  }
  for (const section of slide.sections ?? []) {
    values.push(section.title);
    if (section.value !== undefined) values.push(String(section.value));
    if (section.body !== undefined) values.push(section.body);
    values.push(...(section.items ?? []));
  }
  return values.map(normalizeParityText);
}

function assertParityArray(slideId, label, actual, expected) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`Parity slide ${slideId} ${label} differs: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function resolveParityModel(projectRoot, modelFile) {
  const requested = path.resolve(modelFile ?? path.join(projectRoot, "deck-model.json"));
  if (!fs.existsSync(requested)) {
    throw new Error(`Dual-format parity requires canonical deck-model.json: ${requested}`);
  }
  const canonicalRoot = fs.realpathSync(projectRoot);
  const canonicalFile = fs.realpathSync(requested);
  if (!withinRoot(canonicalFile, canonicalRoot) || !fs.statSync(canonicalFile).isFile()) {
    throw new Error(`Canonical parity model must be a real file inside the project: ${requested}`);
  }
  let model;
  try {
    model = JSON.parse(fs.readFileSync(canonicalFile, "utf8"));
  } catch (error) {
    throw new Error(`Canonical parity model is not valid JSON: ${canonicalFile}`, { cause: error });
  }
  if (!model?.meta || !Array.isArray(model.slides) || model.slides.length === 0) {
    throw new Error("Canonical parity model requires meta and at least one slide");
  }
  return { model, modelFile: canonicalFile };
}

export function verifyProjectDeckParity({ projectDir, modelFile } = {}) {
  if (typeof projectDir !== "string" || !projectDir.trim()) throw new Error("projectDir is required");
  const projectRoot = fs.realpathSync(path.resolve(projectDir));
  const loaded = resolveParityModel(projectRoot, modelFile);
  const records = [];
  const seen = new Set();
  for (const file of chapterFiles(projectRoot)) {
    const realFile = fs.realpathSync(file);
    if (!withinRoot(realFile, projectRoot)) throw new Error(`Unsafe chapter path outside project: ${file}`);
    const chapter = parseChapter(fs.readFileSync(realFile, "utf8"), realFile);
    for (const slide of chapter.slides) {
      if (seen.has(slide.id)) throw new Error(`Duplicate slide ID: ${slide.id}`);
      seen.add(slide.id);
      records.push(extractSlideParity(slide, realFile));
    }
  }
  if (records.length !== loaded.model.slides.length) {
    throw new Error(`Parity slide count differs: HTML has ${records.length}, model has ${loaded.model.slides.length}`);
  }
  if (loaded.model.meta.styleId && readProjectStatus(projectRoot).primaryStyleId !== loaded.model.meta.styleId) {
    throw new Error(`Parity style differs: project uses ${readProjectStatus(projectRoot).primaryStyleId}, model uses ${loaded.model.meta.styleId}`);
  }
  for (const [index, actual] of records.entries()) {
    const expected = loaded.model.slides[index];
    if (actual.id !== expected.id) {
      throw new Error(`Parity slide ${index + 1} order differs: expected ${expected.id}, received ${actual.id}`);
    }
    if (actual.type !== expected.type) {
      throw new Error(`Parity slide ${actual.id} type differs: expected ${expected.type}, received ${actual.type}`);
    }
    if (actual.title !== normalizeParityText(expected.title)) {
      throw new Error(`Parity slide ${actual.id} title differs: expected ${JSON.stringify(expected.title)}, received ${JSON.stringify(actual.title)}`);
    }
    assertParityArray(actual.id, "screen text", actual.screenText, modelScreenText(expected));
    assertParityArray(
      actual.id,
      "source references",
      actual.sourceRefs,
      (expected.sourceRefs ?? []).map(normalizeParityText),
    );
  }
  return {
    version: 1,
    ok: true,
    modelFile: loaded.modelFile,
    slideCount: records.length,
    slides: records,
  };
}

function withinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assetLabel(asset, context) {
  if (withinRoot(asset, context.projectRoot)) {
    return path.relative(context.projectRoot, asset).split(path.sep).join("/");
  }
  return path.relative(SKILL_ROOT, asset).split(path.sep).join("/");
}

function dataUriParts(reference) {
  const match = reference.match(/^data:([^;,\s]+)((?:;[^,]*)?),(.*)$/is);
  if (!match) throw new Error(`Malformed or unsafe data URI: ${reference.slice(0, 48)}`);
  const parts = {
    mimeType: match[1].toLowerCase(),
    parameters: match[2].toLowerCase(),
    payload: match[3],
  };
  if (parts.parameters.split(";").includes("base64")
    && !/^[A-Za-z0-9+/]*={0,2}$/.test(parts.payload)) {
    throw new Error("Malformed base64 data URI payload");
  }
  return parts;
}

function assertSafeSvgData({ parameters, payload }) {
  let source;
  try {
    source = parameters.split(";").includes("base64")
      ? Buffer.from(payload, "base64").toString("utf8")
      : decodeURIComponent(payload);
  } catch {
    throw new Error("Malformed or unsafe SVG data URI");
  }
  if (/<(?:script|foreignobject)\b|\son[a-z]+\s*=|@import\b|(?:href|xlink:href)\s*=\s*["']\s*(?:javascript:|https?:|\/\/|data:text\/html)/i.test(source)) {
    throw new Error("Executable or unsafe SVG data URI");
  }
}

export function assertSafeDataUri(reference, kind = "style") {
  if (!/^data:/i.test(reference)) return reference;
  const parts = dataUriParts(reference);
  const imageAllowed = SAFE_IMAGE_DATA_TYPES.has(parts.mimeType);
  const fontAllowed = SAFE_FONT_DATA_TYPES.has(parts.mimeType);
  if ((kind === "image" && !imageAllowed) || (kind === "style" && !imageAllowed && !fontAllowed)) {
    throw new Error(`Unsafe data URI type for ${kind}: ${parts.mimeType}`);
  }
  if (parts.mimeType === "image/svg+xml") assertSafeSvgData(parts);
  return reference;
}

function validateAssetMime(mimeType, kind, reference, bytes) {
  const imageAllowed = SAFE_IMAGE_DATA_TYPES.has(mimeType);
  const fontAllowed = SAFE_FONT_DATA_TYPES.has(mimeType);
  if ((kind === "image" && !imageAllowed) || (kind === "style" && !imageAllowed && !fontAllowed)) {
    throw new Error(`Unsupported ${kind} asset type: ${reference}`);
  }
  if (mimeType === "image/svg+xml") {
    assertSafeSvgData({ parameters: "", payload: encodeURIComponent(bytes.toString("utf8")) });
  }
}

function embedAsset(reference, { baseDir, allowedRoot, context }, kind = "style") {
  const trimmed = reference.trim();
  if (!trimmed || trimmed.startsWith("#")) return trimmed;
  if (/^data:/i.test(trimmed)) return assertSafeDataUri(trimmed, kind);
  if (/^\/\//.test(trimmed) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) {
    throw new Error(`Remote or unsupported asset URL: ${reference}`);
  }
  if (path.isAbsolute(trimmed) || trimmed.includes("\\") || trimmed.startsWith("~")) {
    throw new Error(`Unsafe asset path: ${reference}`);
  }

  const pathOnly = trimmed.split(/[?#]/, 1)[0];
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathOnly);
  } catch {
    throw new Error(`Unsafe asset path encoding: ${reference}`);
  }
  const resolvedRoot = fs.realpathSync(allowedRoot);
  const candidate = path.resolve(baseDir, decodedPath);
  if (!withinRoot(candidate, resolvedRoot)) {
    throw new Error(`Unsafe asset path outside the allowed root: ${reference}`);
  }
  if (!fs.existsSync(candidate)) throw new Error(`Missing local asset: ${reference}`);
  const realAsset = fs.realpathSync(candidate);
  if (!withinRoot(realAsset, resolvedRoot)) {
    throw new Error(`Unsafe asset path outside the allowed root: ${reference}`);
  }
  if (!fs.statSync(realAsset).isFile()) throw new Error(`Local asset is not a file: ${reference}`);
  const mimeType = MIME_TYPES.get(path.extname(realAsset).toLowerCase());
  if (!mimeType) throw new Error(`Unsupported local asset type: ${reference}`);
  const bytes = fs.readFileSync(realAsset);
  validateAssetMime(mimeType, kind, reference, bytes);
  context.embedded.add(assetLabel(realAsset, context));
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function replaceCssUrls(css, options) {
  if (/@import\b|(?:-webkit-)?image-set\s*\(/i.test(css)) {
    throw new Error("CSS imports and image-set resources are not allowed in an offline deck");
  }
  const expression = /url\(\s*(?:(['"])(.*?)\1|([^)]*?))\s*\)/gi;
  return css.replace(expression, (_match, _quote, quoted, unquoted) => {
    const reference = (quoted ?? unquoted ?? "").trim();
    return `url(${embedAsset(reference, options, "style")})`;
  });
}

function replaceSrcset(value, options) {
  if (/^data:/i.test(value.trim())) {
    const match = value.trim().match(/^(data:\S+?)(\s+\d+(?:\.\d+)?[wx])?$/i);
    if (!match) throw new Error("Malformed image srcset data URI");
    return `${assertSafeDataUri(match[1], "image")}${match[2] ?? ""}`;
  }
  return value.split(",").map((candidate) => {
    const trimmed = candidate.trim();
    const match = trimmed.match(/^(\S+)(\s+.*)?$/);
    if (!match) return trimmed;
    return `${embedAsset(match[1], options, "image")}${match[2] ?? ""}`;
  }).join(", ");
}

function embedHtmlAssets(html, options) {
  const tokens = tokenizeHtml(html, options.file);
  const replacements = [];
  for (const token of tokens) {
    if (token.type !== "open") continue;
    if (token.name === "script") throw new Error(`Scripts are not allowed in controlled chapter ${options.file}`);
    if (token.name === "style") {
      throw new Error(`Slide-local style elements are not allowed; use a top-level chapter style block in ${options.file}`);
    }
    if (ACTIVE_ELEMENTS.has(token.name)) {
      throw new Error(`Active element <${token.name}> is not allowed in controlled chapter ${options.file}`);
    }
    for (const [name, attribute] of token.attributes) {
      if (/^on/i.test(name) || name === "srcdoc") {
        throw new Error(`Unsafe attribute ${name} is not allowed in controlled chapter ${options.file}`);
      }
      if (attribute.value === null) continue;
      let replacement = null;
      if (name === "src" && token.name === "img") {
        replacement = embedAsset(attribute.value, options, "image");
      } else if (name === "srcset" && token.name === "img") {
        replacement = replaceSrcset(attribute.value, options);
      } else if (["href", "xlink:href"].includes(name) && token.name === "image") {
        replacement = embedAsset(attribute.value, options, "image");
      } else if (["href", "xlink:href"].includes(name) && token.name === "use") {
        if (!attribute.value.startsWith("#")) {
          throw new Error("External SVG use references are not supported; use an in-document fragment reference");
        }
      } else if (name === "href" && token.name === "a" && !attribute.value.startsWith("#")) {
        throw new Error(`Non-fragment links are not allowed in an offline deck: ${attribute.value}`);
      } else if (name === "style") {
        replacement = replaceCssUrls(attribute.value, options);
      } else if (SVG_URL_PRESENTATION_ATTRIBUTES.has(name)
        && !svgPresentationValueIsSafe(attribute.value)) {
        throw new Error(`SVG presentation attribute ${name} rejects HTML character references and CSS escapes and supports same-document url(#id) fragments only`);
      } else if (RESOURCE_ATTRIBUTES.has(name)) {
        throw new Error(`Resource-bearing attribute ${name} is not supported on <${token.name}>`);
      }
      if (replacement !== null && replacement !== attribute.value) {
        replacements.push({ start: attribute.valueStart, end: attribute.valueEnd, replacement });
      }
    }
  }
  return replacements
    .sort((left, right) => right.start - left.start)
    .reduce(
      (result, replacement) => result.slice(0, replacement.start)
        + replacement.replacement + result.slice(replacement.end),
      html,
    );
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function readProjectStatus(projectRoot) {
  const file = path.join(projectRoot, "project-status.json");
  if (!fs.existsSync(file)) throw new Error(`Project status does not exist: ${file}`);
  let status;
  try {
    status = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Project status is not valid JSON: ${file}`, { cause: error });
  }
  if (typeof status.projectName !== "string" || !status.projectName.trim()) {
    throw new Error("Project status requires projectName");
  }
  if (typeof status.primaryStyleId !== "string" || !status.primaryStyleId) {
    throw new Error("Project status requires a selected primaryStyleId");
  }
  return status;
}

export function resolveSelectedStyleFile(
  styleId,
  styleRoot = path.join(SKILL_ROOT, "assets", "style-pool"),
) {
  const canonicalRoot = fs.realpathSync(styleRoot);
  const registryFile = fs.realpathSync(path.join(canonicalRoot, "registry.json"));
  if (!withinRoot(registryFile, canonicalRoot)) throw new Error("Style registry escapes the style root");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const style = registry.styles.find((candidate) => candidate.id === styleId);
  if (!style) throw new Error(`Unknown selected style: ${styleId}`);
  const candidate = path.resolve(canonicalRoot, style.theme);
  if (!withinRoot(candidate, canonicalRoot) || !fs.existsSync(candidate)) {
    throw new Error(`Selected style CSS does not exist: ${style.theme}`);
  }
  const canonicalFile = fs.realpathSync(candidate);
  if (!withinRoot(canonicalFile, canonicalRoot)) {
    throw new Error(`Selected style theme resolves outside the style root: ${style.theme}`);
  }
  if (!fs.statSync(canonicalFile).isFile()) throw new Error(`Selected style theme is not a file: ${style.theme}`);
  return canonicalFile;
}

function replaceToken(template, token, value) {
  const marker = `<!-- {{${token}}} -->`;
  if (template.split(marker).length !== 2) throw new Error(`Deck template requires one ${token} token`);
  return template.replace(marker, value);
}

const chapterCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function compareChapterPaths(left, right) {
  const leftName = path.basename(left);
  const rightName = path.basename(right);
  const primary = chapterCollator.compare(leftName, rightName);
  if (primary !== 0) return primary;
  if (leftName < rightName) return -1;
  if (leftName > rightName) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function chapterFiles(projectRoot) {
  const slidesDir = path.join(projectRoot, "slides");
  if (!fs.existsSync(slidesDir)) throw new Error(`Slides directory does not exist: ${slidesDir}`);
  const files = fs.readdirSync(slidesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^chapter-.*\.html$/i.test(entry.name))
    .map((entry) => path.join(slidesDir, entry.name))
    .sort(compareChapterPaths);
  if (files.length === 0) throw new Error(`No chapter HTML files found in ${slidesDir}`);
  return files;
}

export function buildSingleHtml({ projectDir, outputFile, modelFile } = {}) {
  if (typeof projectDir !== "string" || !projectDir.trim()) throw new Error("projectDir is required");
  if (typeof outputFile !== "string" || !outputFile.trim()) throw new Error("outputFile is required");
  const projectRoot = fs.realpathSync(path.resolve(projectDir));
  const resolvedOutput = path.resolve(outputFile);
  const status = readProjectStatus(projectRoot);
  const parityManifest = status.outputs?.includes("html") && status.outputs?.includes("pptx")
    ? verifyProjectDeckParity({ projectDir: projectRoot, modelFile })
    : null;
  const context = { projectRoot, embedded: new Set() };
  const ids = new Set();
  const slides = [];
  const chapterStyles = [];

  for (const file of chapterFiles(projectRoot)) {
    const realFile = fs.realpathSync(file);
    if (!withinRoot(realFile, projectRoot)) throw new Error(`Unsafe chapter path outside project: ${file}`);
    const chapter = parseChapter(fs.readFileSync(realFile, "utf8"), realFile);
    const assetOptions = {
      baseDir: path.dirname(realFile),
      allowedRoot: projectRoot,
      context,
      file: realFile,
    };
    for (const css of chapter.chapterCss) chapterStyles.push(replaceCssUrls(css, assetOptions));
    for (const slide of chapter.slides) {
      if (ids.has(slide.id)) throw new Error(`Duplicate slide ID: ${slide.id}`);
      ids.add(slide.id);
      slides.push(embedHtmlAssets(slide.html, assetOptions));
    }
  }
  if (slides.length === 0) throw new Error("No slide sections found in chapter files");

  const styleFile = resolveSelectedStyleFile(status.primaryStyleId);
  const styleCss = replaceCssUrls(fs.readFileSync(styleFile, "utf8"), {
    baseDir: path.dirname(styleFile),
    allowedRoot: SKILL_ROOT,
    context,
  });
  const deckCssFile = path.join(SHELL_ROOT, "deck.css");
  const deckCss = replaceCssUrls(fs.readFileSync(deckCssFile, "utf8"), {
    baseDir: SHELL_ROOT,
    allowedRoot: SKILL_ROOT,
    context,
  });
  const template = fs.readFileSync(path.join(SHELL_ROOT, "deck.template.html"), "utf8");
  const script = fs.readFileSync(path.join(SHELL_ROOT, "deck.js"), "utf8").trim();
  const styles = [styleCss.trim(), deckCss.trim(), ...chapterStyles.map((css) => css.trim())]
    .filter(Boolean)
    .join("\n\n");

  let html = replaceToken(template, "DECK_TITLE", escapeHtml(status.projectName.trim()));
  html = replaceToken(html, "DECK_STYLES", styles);
  html = replaceToken(html, "DECK_SLIDES", slides.join("\n\n"));
  html = replaceToken(html, "DECK_SCRIPT", script);
  if (/speaker-notes?/i.test(html)) throw new Error("Speaker notes remain in the assembled deck");
  if (/https?:\/\//i.test(html)) throw new Error("Remote URL remains in the assembled deck");

  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  const temporaryFile = atomicTempFile(resolvedOutput);
  try {
    fs.writeFileSync(temporaryFile, html, "utf8");
    fs.renameSync(temporaryFile, resolvedOutput);
  } catch (error) {
    fs.rmSync(temporaryFile, { force: true });
    throw error;
  }
  return {
    outputFile: resolvedOutput,
    slideIds: [...ids],
    embeddedAssets: [...context.embedded],
    parityManifest,
  };
}

export function atomicTempFile(outputFile) {
  return `${path.resolve(outputFile)}.${process.pid}.${randomUUID()}.tmp`;
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = { "--project": "projectDir", "--output": "outputFile", "--model": "modelFile" }[argv[index]];
    if (!key || index + 1 >= argv.length || parsed[key]) {
      throw new Error(`Unknown, duplicate, or incomplete argument: ${argv[index]}`);
    }
    parsed[key] = argv[index + 1];
    index += 1;
  }
  if (!parsed.projectDir || !parsed.outputFile) {
    throw new Error("Usage: node scripts/build-single-html.mjs --project /path/to/project --output /path/to/final/deck.html [--model /path/to/deck-model.json]");
  }
  return parsed;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = buildSingleHtml(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
