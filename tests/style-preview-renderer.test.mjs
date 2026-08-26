import assert from "node:assert/strict";
import test from "node:test";

test("browser launch failure explains managed Chromium and Chrome recovery paths", async () => {
  const renderer = await import("../scripts/generate-style-previews.mjs");
  assert.equal(
    typeof renderer.launchPreviewBrowser,
    "function",
    "renderer must expose its browser launch contract",
  );

  const managedError = new Error(
    "browserType.launch: Executable doesn't exist; run playwright install",
  );
  const chromeError = new Error(
    "browserType.launch: Chrome channel executable was not found",
  );
  const attempts = [];
  const chromium = {
    async launch(options) {
      attempts.push(options);
      if (!options.channel) throw managedError;
      throw chromeError;
    },
  };

  await assert.rejects(
    renderer.launchPreviewBrowser(chromium),
    (error) => {
      assert.match(error.message, /npx playwright install chromium/i);
      assert.match(error.message, /install Google Chrome/i);
      assert.ok(error.cause instanceof AggregateError);
      assert.deepEqual(error.cause.errors, [managedError, chromeError]);
      return true;
    },
  );
  assert.deepEqual(attempts, [
    { headless: true },
    { channel: "chrome", headless: true },
  ]);
});
