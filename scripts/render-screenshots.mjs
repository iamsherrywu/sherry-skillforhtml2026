import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

import { launchPreviewBrowser } from "./generate-style-previews.mjs";

const require = createRequire(import.meta.url);
const VIEWPORT = { width: 1280, height: 720 };
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SAFE_SLIDE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const IMAGE_TIMEOUT_MS = 5_000;
const MANIFEST_NAME = ".sherry-screenshot-manifest.json";
const OWNED_PNG_NAME = /^[A-Za-z][A-Za-z0-9_-]*\.png$/;

function loadPlaywright() {
  try {
    return require("playwright");
  } catch (error) {
    const nodePath = process.env.NODE_PATH || "(not set)";
    throw new Error(
      `Playwright is required to render slide screenshots. Set NODE_PATH to the bundled node_modules directory. Current NODE_PATH: ${nodePath}`,
      { cause: error },
    );
  }
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function pngBlankDiagnostics(png) {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Screenshot is not a PNG");
  let offset = 8;
  let header;
  const data = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const chunk = png.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (type === "IHDR") header = chunk;
    if (type === "IDAT") data.push(chunk);
    if (type === "IEND") break;
  }
  if (!header || header[8] !== 8 || ![2, 6].includes(header[9]) || header[12] !== 0) {
    throw new Error("Screenshot PNG must be a non-interlaced 8-bit RGB or RGBA image");
  }
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bytesPerPixel = header[9] === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const raw = zlib.inflateSync(Buffer.concat(data));
  const colors = new Uint32Array(4_096);
  let samples = 0;
  let firstColor = null;
  let blank = true;
  let position = 0;
  let previous = Buffer.alloc(stride);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[position];
    position += 1;
    const current = Buffer.from(raw.subarray(position, position + stride));
    position += stride;
    for (let index = 0; index < stride; index += 1) {
      const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0;
      const above = previous[index];
      const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
      if (filter === 1) current[index] = (current[index] + left) & 0xff;
      else if (filter === 2) current[index] = (current[index] + above) & 0xff;
      else if (filter === 3) current[index] = (current[index] + Math.floor((left + above) / 2)) & 0xff;
      else if (filter === 4) current[index] = (current[index] + paeth(left, above, upperLeft)) & 0xff;
      else if (filter !== 0) throw new Error(`Unsupported PNG filter: ${filter}`);
    }
    for (let index = 0; index < stride; index += bytesPerPixel) {
      const color = bytesPerPixel === 4
        ? current.readUInt32BE(index)
        : (current[index] << 16) | (current[index + 1] << 8) | current[index + 2];
      if (firstColor === null) firstColor = color;
      else if (color !== firstColor) blank = false;
      const pixel = index / bytesPerPixel;
      if (row % 4 === 0 && pixel % 4 === 0) {
        const bucket = (current[index] >> 4) << 8 | (current[index + 1] >> 4) << 4 | (current[index + 2] >> 4);
        colors[bucket] += 1;
        samples += 1;
      }
    }
    previous = current;
  }
  let largest = 0;
  for (const count of colors) largest = Math.max(largest, count);
  return { blankRatio: largest / samples, blank };
}

function browserSlideDiagnostics(slideId) {
  const slide = document.getElementById(slideId);
  if (!slide) return { overflow: [{ selector: "section.slide", reason: "slide not found" }], clipped: [] };
  const bounds = slide.getBoundingClientRect();
  const slideStyle = getComputedStyle(slide);
  const clipsX = /^(?:hidden|clip|scroll|auto)$/.test(slideStyle.overflowX);
  const clipsY = /^(?:hidden|clip|scroll|auto)$/.test(slideStyle.overflowY);
  const result = { overflow: [], clipped: [] };
  for (const element of slide.querySelectorAll("*")) {
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rectangle = element.getBoundingClientRect();
    if (rectangle.width === 0 && rectangle.height === 0) continue;
    const knownVisual = Boolean(element.closest("img, picture, video, canvas, svg"));
    const explicitlyAllowed = element.closest("[data-allow-clipping], .allow-clipping, .full-bleed");
    const visible = {
      left: rectangle.left,
      top: rectangle.top,
      right: rectangle.right,
      bottom: rectangle.bottom,
    };
    for (let ancestor = element.parentElement; ancestor && ancestor !== slide; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor);
      const clip = ancestor.getBoundingClientRect();
      if (/^(?:hidden|clip|scroll|auto)$/.test(ancestorStyle.overflowX)) {
        visible.left = Math.max(visible.left, clip.left);
        visible.right = Math.min(visible.right, clip.right);
      }
      if (/^(?:hidden|clip|scroll|auto)$/.test(ancestorStyle.overflowY)) {
        visible.top = Math.max(visible.top, clip.top);
        visible.bottom = Math.min(visible.bottom, clip.bottom);
      }
    }
    const classes = Array.from(element.classList).slice(0, 3).map((name) => `.${name}`).join("");
    const selector = `${element.localName}${element.id ? `#${element.id}` : ""}${classes}`;
    const clippedByAncestor = visible.left > rectangle.left + 1
      || visible.top > rectangle.top + 1
      || visible.right < rectangle.right - 1
      || visible.bottom < rectangle.bottom - 1;
    const clipsOwnX = /^(?:hidden|clip|scroll|auto)$/.test(style.overflowX);
    const clipsOwnY = /^(?:hidden|clip|scroll|auto)$/.test(style.overflowY);
    const hasText = Array.from(element.childNodes).some(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
    );
    const internallyClipped = hasText && (
      (clipsOwnX && element.scrollWidth > element.clientWidth + 1)
      || (clipsOwnY && element.scrollHeight > element.clientHeight + 1)
    );
    if (!knownVisual && !explicitlyAllowed && (clippedByAncestor || internallyClipped)) {
      result.clipped.push({ selector, reason: internallyClipped ? "internal clipping" : "ancestor clipping" });
    }
    const clippedBySlide = (clipsX && (visible.left < bounds.left - 1 || visible.right > bounds.right + 1))
      || (clipsY && (visible.top < bounds.top - 1 || visible.bottom > bounds.bottom + 1));
    if (clippedBySlide && !knownVisual && !explicitlyAllowed) {
      result.clipped.push({ selector, reason: "slide clipping" });
    }
    if (clipsX) {
      visible.left = Math.max(visible.left, bounds.left);
      visible.right = Math.min(visible.right, bounds.right);
    }
    if (clipsY) {
      visible.top = Math.max(visible.top, bounds.top);
      visible.bottom = Math.min(visible.bottom, bounds.bottom);
    }
    if (visible.right <= visible.left || visible.bottom <= visible.top) continue;
    const outside = visible.left < bounds.left - 1
      || visible.top < bounds.top - 1
      || visible.right > bounds.right + 1
      || visible.bottom > bounds.bottom + 1;
    if (outside) {
      result.overflow.push({ selector });
    }
  }
  return result;
}

async function waitForStableDeck(page) {
  await page.addStyleTag({ content: `
    *, *::before, *::after {
      animation: none !important;
      transition: none !important;
      scroll-behavior: auto !important;
      caret-color: transparent !important;
    }
  ` });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images, (image) => {
      if (image.complete) return undefined;
      return new Promise((resolve) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
      });
    }));
    for (const animation of document.getAnimations()) animation.cancel();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function waitForSlideImages(page, slideId) {
  return page.evaluate(async ({ id, timeoutMs }) => {
    const slide = document.getElementById(id);
    if (!slide) return [{ selector: "section.slide", reason: "slide not found" }];
    const selectorFor = (image) => `img${image.id ? `#${image.id}` : ""}`;
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const deadline = Date.now() + timeoutMs;
    const results = [];
    for (const image of slide.querySelectorAll("img")) {
      while (!image.currentSrc && !image.getAttribute("src") && Date.now() < deadline) await delay(25);
      if (!image.currentSrc && !image.getAttribute("src")) {
        results.push({ selector: selectorFor(image), src: "", reason: "missing src" });
        continue;
      }
      if (!image.complete) {
        const outcome = await new Promise((resolve) => {
          let settled = false;
          const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
          };
          const remaining = Math.max(0, deadline - Date.now());
          const timer = setTimeout(() => finish("timeout"), remaining);
          image.addEventListener("load", () => finish("load"), { once: true });
          image.addEventListener("error", () => finish("error"), { once: true });
        });
        if (outcome !== "load") {
          results.push({ selector: selectorFor(image), src: image.getAttribute("src") ?? "", reason: outcome });
          continue;
        }
      }
      if (image.naturalWidth === 0) {
        results.push({ selector: selectorFor(image), src: image.getAttribute("src") ?? "", reason: "error" });
      }
    }
    return results;
  }, { id: slideId, timeoutMs: IMAGE_TIMEOUT_MS });
}

function validateSlideIds(slideIds) {
  if (!Array.isArray(slideIds) || slideIds.length === 0) {
    throw new Error("Deck API slideIds() must return at least one non-empty slide ID");
  }
  const seen = new Set();
  for (const id of slideIds) {
    if (typeof id !== "string" || !SAFE_SLIDE_ID.test(id)) throw new Error(`Unsafe slide ID: ${String(id)}`);
    if (seen.has(id)) throw new Error(`Duplicate slide ID: ${id}`);
    seen.add(id);
  }
}

async function rejectSymlinkedOutputAncestors(outputDir) {
  const { root } = path.parse(outputDir);
  let current = root;
  const segments = outputDir.slice(root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    let status;
    try {
      status = await fs.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (status.isSymbolicLink()) {
      throw new Error(`Screenshot output has a symlinked ancestor: ${current}`);
    }
  }
}

function withinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function resolveProjectScope(htmlFile, outputDir, projectDir) {
  const requestedRoot = path.resolve(projectDir ?? path.dirname(htmlFile));
  const rootStatus = await fs.lstat(requestedRoot);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error(`Screenshot project scope must be a real directory: ${requestedRoot}`);
  }
  const projectRoot = await fs.realpath(requestedRoot);
  const canonicalHtml = await fs.realpath(htmlFile);
  if (!withinRoot(canonicalHtml, projectRoot)) {
    throw new Error(`HTML file is outside the screenshot project scope: ${canonicalHtml}`);
  }
  if (!withinRoot(outputDir, projectRoot) || outputDir === projectRoot) {
    throw new Error(`Screenshot output must be a dedicated directory inside the project scope: ${outputDir}`);
  }
  return { projectRoot, canonicalHtml };
}

async function loadOwnedManifest(outputDir) {
  const manifestFile = path.join(outputDir, MANIFEST_NAME);
  let manifestStatus;
  try {
    manifestStatus = await fs.lstat(manifestFile);
  } catch (error) {
    if (error.code === "ENOENT") return { manifestFile, owned: new Set() };
    throw error;
  }
  if (!manifestStatus.isFile() || manifestStatus.isSymbolicLink()) {
    throw new Error(`Screenshot manifest must be a real file: ${manifestFile}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  } catch (error) {
    throw new Error(`Screenshot manifest is not valid JSON: ${manifestFile}`, { cause: error });
  }
  if (manifest?.version !== 1 || !Array.isArray(manifest.files)) {
    throw new Error(`Screenshot manifest has an unsupported structure: ${manifestFile}`);
  }
  const owned = new Set();
  for (const name of manifest.files) {
    if (typeof name !== "string" || !OWNED_PNG_NAME.test(name)) {
      throw new Error(`Screenshot manifest contains an unsafe owned filename: ${String(name)}`);
    }
    if (owned.has(name)) throw new Error(`Screenshot manifest contains a duplicate filename: ${name}`);
    owned.add(name);
  }
  return { manifestFile, owned };
}

async function writeOwnedManifest(manifestFile, sourceHtml, files) {
  const temporary = `${manifestFile}.${process.pid}.${randomUUID()}.tmp`;
  const manifest = { version: 1, sourceHtml, files };
  try {
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fs.rename(temporary, manifestFile);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function prepareOutputDirectory(outputDir) {
  await rejectSymlinkedOutputAncestors(outputDir);
  try {
    const status = await fs.lstat(outputDir);
    if (!status.isDirectory()) {
      throw new Error(`Screenshot output must be a real directory: ${outputDir}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.mkdir(outputDir, { recursive: true });
    await rejectSymlinkedOutputAncestors(outputDir);
  }
  const manifest = await loadOwnedManifest(outputDir);
  for (const name of manifest.owned) {
    const candidate = path.join(outputDir, name);
    let status;
    try {
      status = await fs.lstat(candidate);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error(`Manifest-owned screenshot is missing or unsafe: ${candidate}`);
    }
    await fs.unlink(candidate);
  }
  return manifest;
}

export async function renderDeck({ htmlFile, outputDir, projectDir } = {}) {
  if (typeof htmlFile !== "string" || !htmlFile.trim()) throw new Error("htmlFile is required");
  if (typeof outputDir !== "string" || !outputDir.trim()) throw new Error("outputDir is required");
  const resolvedHtml = path.resolve(htmlFile);
  const resolvedOutput = path.resolve(outputDir);
  await fs.access(resolvedHtml);
  const scope = await resolveProjectScope(resolvedHtml, resolvedOutput, projectDir);

  const { chromium } = loadPlaywright();
  const browser = await launchPreviewBrowser(chromium);
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const remoteChannels = new Set();
      await context.route("**/*", (route) => {
        const url = route.request().url();
        const protocol = new URL(url).protocol;
        if (["file:", "data:", "about:", "blob:"].includes(protocol)) route.continue();
        else {
          remoteChannels.add(url);
          route.abort();
        }
      });
      page.on("request", (request) => {
        if (/^(?:https?|wss?|ftp):/i.test(request.url())) remoteChannels.add(request.url());
      });
      page.on("websocket", (socket) => remoteChannels.add(socket.url()));
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(pathToFileURL(scope.canonicalHtml).href, { waitUntil: "load" });
      await page.waitForFunction(() => window.__sherryDeck && Array.isArray(window.__sherryDeck.slideIds?.()));
      await waitForStableDeck(page);
      if (remoteChannels.size > 0) throw new Error(`Offline request blocked: ${[...remoteChannels].join(", ")}`);

      const slideIds = await page.evaluate(() => window.__sherryDeck.slideIds());
      validateSlideIds(slideIds);
      const sourceIds = await page.evaluate(() => Array.from(
        document.querySelectorAll("#deck-stage > section.slide, #stage > section.slide"),
        (slide) => slide.id,
      ));
      validateSlideIds(sourceIds);
      if (slideIds.join("\n") !== sourceIds.join("\n")) {
        throw new Error("Deck API slideIds() must return the slide IDs in source order");
      }
      const manifest = await prepareOutputDirectory(resolvedOutput);
      const ownedFiles = slideIds.map((id) => `${id}.png`);
      for (const name of ownedFiles) {
        const candidate = path.join(resolvedOutput, name);
        try {
          await fs.lstat(candidate);
          throw new Error(`Refusing to overwrite unowned screenshot file: ${candidate}`);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      await writeOwnedManifest(manifest.manifestFile, scope.canonicalHtml, ownedFiles);
      const diagnostics = [];
      for (const id of slideIds) {
        const screenshot = path.join(resolvedOutput, `${id}.png`);
        const shownId = await page.evaluate((requestedId) => window.__sherryDeck.show(requestedId), id);
        if (shownId !== id) throw new Error(`Deck API show(${id}) returned ${String(shownId)}`);
        const imageFailures = await waitForSlideImages(page, id);
        if (remoteChannels.size > 0) throw new Error(`Offline request blocked: ${[...remoteChannels].join(", ")}`);
        const slide = await page.evaluate(browserSlideDiagnostics, id);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const png = await page.screenshot({ path: screenshot, type: "png" });
        const { blankRatio, blank } = pngBlankDiagnostics(png);
        diagnostics.push({
          id,
          screenshot,
          overflow: slide.overflow,
          clipped: slide.clipped,
          blankRatio,
          imageFailures,
          blank,
        });
      }
      if (remoteChannels.size > 0) throw new Error(`Offline request blocked: ${[...remoteChannels].join(", ")}`);
      return diagnostics;
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

export function renderDiagnosticFailures(diagnostics) {
  const failures = [];
  for (const diagnostic of diagnostics) {
    for (const item of diagnostic.overflow) failures.push(`${diagnostic.id} overflow: ${item.selector}`);
    for (const item of diagnostic.clipped) failures.push(`${diagnostic.id} clipped: ${item.selector}`);
    for (const item of diagnostic.imageFailures) {
      failures.push(`${diagnostic.id} image failure: ${item.selector} (${item.reason})`);
    }
    if (diagnostic.blank || diagnostic.blankRatio >= 0.9995) failures.push(`${diagnostic.id} blank slide`);
  }
  return failures;
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = { "--html": "htmlFile", "--output": "outputDir", "--project": "projectDir" }[argv[index]];
    if (!key || index + 1 >= argv.length || parsed[key]) {
      throw new Error(`Unknown, duplicate, or incomplete argument: ${argv[index]}`);
    }
    parsed[key] = argv[index + 1];
    index += 1;
  }
  if (!parsed.htmlFile || !parsed.outputDir) {
    throw new Error("Usage: node scripts/render-screenshots.mjs --html /path/to/deck.html --output /path/to/pages [--project /path/to/project]");
  }
  return parsed;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  renderDeck(parseArguments(process.argv.slice(2))).then((diagnostics) => {
    process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
    const failures = renderDiagnosticFailures(diagnostics);
    if (failures.length > 0) {
      process.stderr.write(`Screenshot QA failed: ${failures.join("; ")}\n`);
      process.exitCode = 1;
    }
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
