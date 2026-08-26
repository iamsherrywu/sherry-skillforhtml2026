import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertSafeDataUri, inspectSlideSections, tokenizeHtml } from "./build-single-html.mjs";
import { launchPreviewBrowser } from "./generate-style-previews.mjs";

const require = createRequire(import.meta.url);
const ACTIVE_ELEMENTS = new Set([
  "audio", "base", "embed", "form", "frame", "iframe", "link", "object", "portal",
  "source", "track", "video",
]);
const RESOURCE_ATTRIBUTES = new Set([
  "action", "background", "cite", "data", "formaction", "href", "longdesc", "manifest",
  "ping", "poster", "src", "srcset", "xlink:href",
]);
const SVG_URL_PRESENTATION_ATTRIBUTES = new Set([
  "clip-path", "color-profile", "cursor", "fill", "filter", "marker", "marker-end",
  "marker-mid", "marker-start", "mask", "stroke",
]);
const REQUIRED_CSP = new Map([
  ["default-src", ["'none'"]],
  ["script-src", ["'unsafe-inline'"]],
  ["style-src", ["'unsafe-inline'"]],
  ["img-src", ["data:"]],
  ["font-src", ["data:"]],
  ["connect-src", ["'none'"]],
  ["object-src", ["'none'"]],
  ["frame-src", ["'none'"]],
  ["child-src", ["'none'"]],
  ["media-src", ["'none'"]],
  ["worker-src", ["'none'"]],
  ["manifest-src", ["'none'"]],
  ["base-uri", ["'none'"]],
  ["form-action", ["'none'"]],
]);

function svgPresentationValueIsSafe(value) {
  const trimmed = value.trim();
  if (/[&\\]/.test(trimmed)) return false;
  if (/^url\(\s*(['"]?)#[A-Za-z][A-Za-z0-9_.:-]*\1\s*\)$/i.test(trimmed)) return true;
  return !/\b(?:url|var|attr|image|image-set|cross-fade|element)\s*\(/i.test(trimmed);
}

function loadPlaywright() {
  try {
    return require("playwright");
  } catch (error) {
    const nodePath = process.env.NODE_PATH || "(not set)";
    throw new Error(
      `Playwright is required to validate slide bounds. Set NODE_PATH to the bundled node_modules directory. Current NODE_PATH: ${nodePath}`,
      { cause: error },
    );
  }
}

function pushUnique(list, message) {
  if (!list.includes(message)) list.push(message);
}

function resourceKind(token, name) {
  if (token.name === "img" && ["src", "srcset"].includes(name)) return "image";
  if (token.name === "image" && ["href", "xlink:href"].includes(name)) return "image";
  return null;
}

function validateDataReference(value, kind, errors) {
  try {
    assertSafeDataUri(value, kind ?? "style");
  } catch (error) {
    pushUnique(errors, error.message);
  }
}

function cspDiagnostics(tokens, errors) {
  const policyToken = tokens.find((token) => token.type === "open" && token.name === "meta"
    && token.attributes.get("http-equiv")?.value?.toLowerCase() === "content-security-policy");
  if (!policyToken) {
    pushUnique(errors, "Missing offline Content Security Policy");
    return;
  }
  const content = policyToken.attributes.get("content")?.value ?? "";
  const directives = new Map();
  for (const entry of content.split(";")) {
    const [name, ...values] = entry.trim().split(/\s+/);
    if (!name) continue;
    const normalizedName = name.toLowerCase();
    if (directives.has(normalizedName)) {
      pushUnique(errors, `Offline Content Security Policy must define ${normalizedName} exactly once`);
    }
    directives.set(normalizedName, values.map((value) => value.toLowerCase()));
  }
  for (const [name, expectedValues] of REQUIRED_CSP) {
    const actualValues = directives.get(name);
    if (!actualValues || actualValues.length !== expectedValues.length
      || actualValues.some((value, index) => value !== expectedValues[index])) {
      pushUnique(errors, `Offline Content Security Policy requires ${name} to contain exactly ${expectedValues.join(" ")}`);
    }
  }
}

function scriptNetworkDiagnostics(html, tokens, errors) {
  const networkApi = /\b(?:fetch|WebSocket|XMLHttpRequest|EventSource|RTCPeerConnection|Worker|SharedWorker|importScripts)\b|\.sendBeacon\s*\(/;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "open" || token.name !== "script") continue;
    const close = tokens.slice(index + 1).find((candidate) => candidate.type === "close" && candidate.name === "script");
    if (close && networkApi.test(html.slice(token.end, close.start))) {
      pushUnique(errors, "Network API is not allowed in an offline deck script");
    }
  }
}

function resourceDiagnostics(html, file, errors, slides) {
  let tokens;
  try {
    tokens = tokenizeHtml(html, file);
  } catch (error) {
    pushUnique(errors, error.message);
    return;
  }

  cspDiagnostics(tokens, errors);
  scriptNetworkDiagnostics(html, tokens, errors);

  for (const token of tokens) {
    if (token.type !== "open") continue;
    if (token.name === "style" && slides.some((slide) => token.start > slide.start && token.end < slide.end)) {
      pushUnique(errors, "Slide-local style elements are not allowed; use a top-level chapter style block");
    }
    if (ACTIVE_ELEMENTS.has(token.name)) {
      pushUnique(errors, `Active resource element <${token.name}> is not allowed`);
    }
    for (const [name, attribute] of token.attributes) {
      if (/^on/i.test(name) || name === "srcdoc") {
        pushUnique(errors, `Unsafe attribute is not allowed: ${name}`);
      }
      if (attribute.value === null) continue;
      const value = attribute.value.trim();
      if (/^(?:https?|wss?|ftp):|^\/\//i.test(value)) {
        pushUnique(errors, `Remote URL is not allowed: ${value}`);
      }
      if (!RESOURCE_ATTRIBUTES.has(name)) continue;
      const kind = resourceKind(token, name);
      if (/^data:/i.test(value)) {
        if (!kind) pushUnique(errors, `Data URI is not allowed on <${token.name}> ${name}`);
        else validateDataReference(value.replace(/\s+\d+(?:\.\d+)?[wx]$/i, ""), kind, errors);
      } else if (value.startsWith("#") && ["href", "xlink:href"].includes(name)) {
        continue;
      } else {
        pushUnique(errors, `Resource is not embedded as a data URI: ${token.name} ${name}=${value}`);
      }
    }
    for (const [name, attribute] of token.attributes) {
      if (!SVG_URL_PRESENTATION_ATTRIBUTES.has(name) || attribute.value === null) continue;
      if (!svgPresentationValueIsSafe(attribute.value)) {
        pushUnique(errors, `Unresolved SVG presentation resource, HTML character reference, or CSS escape in ${name}: ${attribute.value}`);
      }
    }
  }

  const cssUrl = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
  for (const match of html.matchAll(cssUrl)) {
    const value = match[2].trim();
    if (/^data:/i.test(value)) {
      validateDataReference(value, "style", errors);
    } else if (value && !value.startsWith("#")) {
      pushUnique(errors, `CSS resource is not embedded as a data URI: ${value}`);
    }
  }
  if (/(?:-webkit-)?image-set\s*\(/i.test(html)) {
    pushUnique(errors, "CSS image-set resources are not allowed in an offline deck");
  }
}

function staticDiagnostics(html, file) {
  const errors = [];
  let slides = [];
  try {
    slides = inspectSlideSections(html, file);
  } catch (error) {
    pushUnique(errors, error.message);
  }

  if (slides.length === 0) pushUnique(errors, "No slide sections found");
  const seen = new Set();
  for (const slide of slides) {
    if (!slide.id) {
      pushUnique(errors, "Slide section is missing an ID");
    } else if (seen.has(slide.id)) {
      pushUnique(errors, `Duplicate slide ID: ${slide.id}`);
    } else {
      seen.add(slide.id);
    }
  }
  if (/speaker-notes?/i.test(html)) pushUnique(errors, "Speaker notes are embedded in the deck");
  if (/(?:https?|wss?|ftp):\/\/|(?:^|["'(\s])\/\//im.test(html)) {
    pushUnique(errors, "Remote URL is embedded in the deck");
  }
  if (/@import\b/i.test(html)) pushUnique(errors, "CSS @import is not allowed in an offline deck");

  const apiContracts = [
    ["window.__sherryDeck", /window\.__sherryDeck\s*=/],
    ["show", /\bshow\b/],
    ["next", /\bnext\b/],
    ["previous", /\bprevious\b/],
    ["fit", /\bfit\b/],
    ["currentId", /\bcurrentId\b/],
    ["slideIds", /\bslideIds\b/],
  ];
  for (const [name, expression] of apiContracts) {
    if (!expression.test(html)) pushUnique(errors, `Missing deck API: ${name}`);
  }
  resourceDiagnostics(html, file, errors, slides);
  return { errors, slides };
}

async function browserDiagnostics(file, slideIds) {
  const errors = [];
  const warnings = [];
  const { chromium } = loadPlaywright();
  const browser = await launchPreviewBrowser(chromium);
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const remoteChannels = [];
    const pageErrors = [];
    await context.route("**/*", (route) => {
      const url = route.request().url();
      const protocol = new URL(url).protocol;
      if (["file:", "data:", "about:", "blob:"].includes(protocol)) route.continue();
      else {
        remoteChannels.push(url);
        route.abort();
      }
    });
    page.on("request", (request) => {
      if (/^(?:https?|wss?|ftp):/i.test(request.url())) remoteChannels.push(request.url());
    });
    page.on("websocket", (socket) => remoteChannels.push(socket.url()));
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
    const apiErrors = await page.evaluate((expectedIds) => {
      const api = window.__sherryDeck;
      if (!api || typeof api !== "object") return ["window.__sherryDeck must be an object"];
      const methods = ["show", "next", "previous", "fit", "currentId", "slideIds"];
      const failures = methods.filter((name) => typeof api[name] !== "function")
        .map((name) => `${name} must be a function`);
      if (failures.length > 0) return failures;
      try {
        const actualIds = api.slideIds();
        if (!Array.isArray(actualIds) || actualIds.join("\n") !== expectedIds.join("\n")) {
          failures.push("slideIds() must return every slide ID in source order");
        }
      } catch (error) {
        failures.push(`slideIds() failed: ${error.message}`);
      }
      return failures;
    }, slideIds);
    for (const error of apiErrors) pushUnique(errors, `Deck API invalid: ${error}`);
    if (apiErrors.length > 0) {
      for (const error of pageErrors) pushUnique(errors, `Deck script error: ${error}`);
      for (const url of remoteChannels) pushUnique(errors, `Remote channel attempted: ${url}`);
      await context.close();
      return { errors, warnings };
    }

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

    for (const id of slideIds) {
      let overflow;
      try {
        overflow = await page.evaluate((slideId) => {
          window.__sherryDeck.show(slideId);
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
            const selectorClasses = Array.from(element.classList).slice(0, 3).map((name) => `.${name}`).join("");
            const selector = `${element.localName}${element.id ? `#${element.id}` : ""}${selectorClasses}`;
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
            if (visible.right <= visible.left || visible.bottom <= visible.top) continue;
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
            if (outside) result.overflow.push({ selector });
          }
          return result;
        }, id);
      } catch (error) {
        pushUnique(errors, `Deck API show(${id}) failed: ${error.message}`);
        continue;
      }
      for (const item of overflow.overflow) {
        pushUnique(errors, `Slide ${id} overflow: ${item.selector}`);
      }
      for (const item of overflow.clipped) {
        pushUnique(errors, `Slide ${id} clipped content: ${item.selector}${item.reason ? ` (${item.reason})` : ""}`);
      }
    }
    for (const error of pageErrors) pushUnique(errors, `Deck script error: ${error}`);
    for (const url of remoteChannels) pushUnique(errors, `Remote channel attempted: ${url}`);
    await context.close();
  } finally {
    await browser.close();
  }
  return { errors, warnings };
}

export async function validateHtml(file) {
  if (typeof file !== "string" || !file.trim()) throw new Error("HTML file is required");
  const resolvedFile = path.resolve(file);
  if (!fs.existsSync(resolvedFile)) throw new Error(`HTML file does not exist: ${resolvedFile}`);
  const html = fs.readFileSync(resolvedFile, "utf8");
  const diagnostics = staticDiagnostics(html, resolvedFile);
  const errors = [...diagnostics.errors];
  const warnings = [];
  if (errors.length === 0) {
    try {
      const browser = await browserDiagnostics(resolvedFile, diagnostics.slides.map(({ id }) => id));
      errors.push(...browser.errors);
      warnings.push(...browser.warnings);
    } catch (error) {
      pushUnique(errors, `Browser validation failed: ${error.message}`);
    }
  }
  return {
    ok: errors.length === 0,
    slideCount: diagnostics.slides.length,
    errors,
    warnings,
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [file, ...extra] = process.argv.slice(2);
  if (!file || extra.length > 0) {
    process.stderr.write("Usage: node scripts/validate-html.mjs /path/to/deck.html\n");
    process.exitCode = 1;
  } else {
    validateHtml(file).then((diagnostics) => {
      process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
      if (!diagnostics.ok) process.exitCode = 1;
    }).catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
  }
}
