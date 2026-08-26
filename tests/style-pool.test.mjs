import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");
const readJson = (path) => JSON.parse(read(path));

const expectedStyleIds = [
  "product-narrative",
  "system-monochrome",
  "editorial-signal",
  "technical-atlas",
  "creative-primitives",
  "ai-research-journal",
];

const requiredTokenKeys = [
  "background",
  "surface",
  "text",
  "muted",
  "primary",
  "secondary",
  "warning",
  "fontDisplay",
  "fontBody",
  "fontMono",
  "spacingUnit",
  "lineWidth",
  "motion",
];

const semanticSlideTypes = [
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
];

test("style registry exposes the six approved original systems", () => {
  const registry = readJson("assets/style-pool/registry.json");
  assert.deepEqual(registry.styles.map(({ id }) => id), expectedStyleIds);
});

for (const styleId of expectedStyleIds) {
  test(`${styleId} provides complete tokens and local semantic previews`, () => {
    const tokens = readJson(`assets/style-pool/${styleId}/tokens.json`);
    for (const key of requiredTokenKeys) {
      assert.ok(Object.hasOwn(tokens, key), `${styleId} missing token ${key}`);
    }

    const preview = read(`assets/style-pool/${styleId}/preview.html`);
    for (const example of ["cover", "data", "process"]) {
      assert.match(
        preview,
        new RegExp(`data-example=["']${example}["']`),
        `${styleId} missing ${example} example`,
      );
    }
    assert.doesNotMatch(preview, /https?:\/\//i, `${styleId} loads a remote resource`);
    const visibleText = preview.replace(/<[^>]+>/g, " ");
    assert.doesNotMatch(
      visibleText,
      /\b(?:Apple|Google|Microsoft|OpenAI|Anthropic|Meta|Netflix|Spotify|Stripe)\b/i,
      `${styleId} contains company logo text`,
    );

    const css = read(`assets/style-pool/${styleId}/html-theme.css`);
    for (const slideType of semanticSlideTypes) {
      assert.match(
        css,
        new RegExp(`\\.slide--${slideType.replace("-", "\\-")}\\b`),
        `${styleId} missing .slide--${slideType}`,
      );
    }
  });
}
