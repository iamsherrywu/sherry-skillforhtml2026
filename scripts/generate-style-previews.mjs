import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

function loadPlaywright() {
  try {
    return require("playwright");
  } catch (error) {
    const nodePath = process.env.NODE_PATH || "(not set)";
    throw new Error(
      `Playwright is required to render style previews. Set NODE_PATH to the bundled node_modules directory before running this script. Current NODE_PATH: ${nodePath}`,
      { cause: error },
    );
  }
}

function managedBrowserIsUnavailable(error) {
  return /executable doesn't exist|playwright install|browser executable/i.test(
    error?.message ?? "",
  );
}

export async function launchPreviewBrowser(chromium) {
  try {
    return await chromium.launch({ headless: true });
  } catch (managedError) {
    if (!managedBrowserIsUnavailable(managedError)) {
      throw new Error(
        "Playwright managed Chromium failed to launch. Inspect the original cause before retrying preview generation.",
        { cause: managedError },
      );
    }

    try {
      return await chromium.launch({ channel: "chrome", headless: true });
    } catch (chromeError) {
      throw new Error(
        "Unable to launch a preview browser. Install Playwright managed Chromium with `npx playwright install chromium`, or install Google Chrome so Playwright can use its `chrome` channel fallback.",
        {
          cause: new AggregateError(
            [managedError, chromeError],
            "Managed Chromium and Google Chrome launch attempts both failed",
          ),
        },
      );
    }
  }
}

export async function renderStylePreviews({ skillRoot, outputRoot }) {
  const resolvedSkillRoot = path.resolve(skillRoot);
  const styleRoot = path.join(resolvedSkillRoot, "assets", "style-pool");
  const resolvedOutputRoot = path.resolve(outputRoot ?? styleRoot);
  const registry = JSON.parse(
    await fs.readFile(path.join(styleRoot, "registry.json"), "utf8"),
  );
  const { chromium } = loadPlaywright();
  const browser = await launchPreviewBrowser(chromium);

  try {
    for (const style of registry.styles) {
      const previewPath = path.join(styleRoot, style.id, "preview.html");
      const targetDir = path.join(resolvedOutputRoot, style.id);
      const targetPath = path.join(targetDir, "preview.png");
      await fs.mkdir(targetDir, { recursive: true });

      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.goto(pathToFileURL(previewPath).href, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: targetPath, fullPage: false });
      await page.close();

      const { size } = await fs.stat(targetPath);
      if (size < 10_000) {
        throw new Error(`${style.id} preview is unexpectedly small (${size} bytes)`);
      }
      console.log(`rendered ${style.id}: ${targetPath} (${size} bytes)`);
    }
  } finally {
    await browser.close();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  const skillRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
  renderStylePreviews({ skillRoot }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
