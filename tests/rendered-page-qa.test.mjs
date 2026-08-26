import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { inspectRenderedPages } from "../scripts/inspect-rendered-pages.mjs";

const script = fileURLToPath(new URL("../scripts/inspect-rendered-pages.mjs", import.meta.url));
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, data, Buffer.alloc(4)]);
}

function makePng(file, { width = 320, height = 180, content = true } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3, 255);
    row[0] = 0;
    if (content && y >= 50 && y < 110) {
      for (let x = 70; x < 250; x += 1) {
        const offset = 1 + x * 3;
        row[offset] = 20;
        row[offset + 1] = 80;
        row[offset + 2] = 160;
      }
    }
    rows.push(row);
  }
  fs.writeFileSync(file, Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}

test("rendered-page QA performs pixel/content checks beyond file count", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sherry-page-qa-"));
  const page = path.join(root, "page-01.png");
  makePng(page);

  const diagnostics = inspectRenderedPages([page]);

  assert.equal(diagnostics.ok, true);
  assert.equal(diagnostics.pages[0].width, 320);
  assert.equal(diagnostics.pages[0].height, 180);
  assert.ok(diagnostics.pages[0].contentRatio > 0.01);
  assert.ok(diagnostics.pages[0].colorBucketCount >= 2);
});

test("rendered-page QA rejects blank and undersized page images", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sherry-page-qa-"));
  const blank = path.join(root, "page-01.png");
  const undersized = path.join(root, "page-02.png");
  makePng(blank, { content: false });
  makePng(undersized, { width: 20, height: 20 });

  const diagnostics = inspectRenderedPages([blank, undersized]);

  assert.equal(diagnostics.ok, false);
  assert.ok(diagnostics.errors.some((error) => /page-01.*blank|near-blank/i.test(error)));
  assert.ok(diagnostics.errors.some((error) => /page-02.*dimension|undersized/i.test(error)));

  const result = spawnSync(process.execPath, [script, blank, undersized], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /blank|dimension|pixel/i);
});
