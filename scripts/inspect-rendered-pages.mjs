import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MIN_WIDTH = 320;
const MIN_HEIGHT = 180;
const MAX_DOMINANT_RATIO = 0.9985;

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function analyzePng(file) {
  const png = fs.readFileSync(file);
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${file} is not a PNG`);
  let offset = 8;
  let header = null;
  const data = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > png.length) throw new Error(`${file} has a truncated PNG chunk`);
    const bytes = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") header = bytes;
    if (type === "IDAT") data.push(bytes);
    offset = end;
    if (type === "IEND") break;
  }
  if (!header || header.length !== 13 || header[8] !== 8 || ![2, 6].includes(header[9]) || header[12] !== 0) {
    throw new Error(`${file} must be a non-interlaced 8-bit RGB or RGBA PNG`);
  }
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bytesPerPixel = header[9] === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const raw = zlib.inflateSync(Buffer.concat(data));
  if (raw.length !== (stride + 1) * height) throw new Error(`${file} has invalid pixel data length`);

  const buckets = new Uint32Array(4_096);
  let previous = Buffer.alloc(stride);
  let position = 0;
  let sampled = 0;
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
      else if (filter !== 0) throw new Error(`${file} uses unsupported PNG filter ${filter}`);
    }
    for (let index = 0; index < stride; index += bytesPerPixel * 2) {
      const bucket = (current[index] >> 4) << 8
        | (current[index + 1] >> 4) << 4
        | (current[index + 2] >> 4);
      buckets[bucket] += 1;
      sampled += 1;
    }
    previous = current;
  }
  let dominant = 0;
  let colorBucketCount = 0;
  for (const count of buckets) {
    if (count > 0) colorBucketCount += 1;
    dominant = Math.max(dominant, count);
  }
  const dominantRatio = dominant / sampled;
  return {
    file: path.resolve(file),
    width,
    height,
    dominantRatio,
    contentRatio: 1 - dominantRatio,
    colorBucketCount,
  };
}

export function inspectRenderedPages(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error("At least one rendered PNG is required");
  const pages = [];
  const errors = [];
  for (const file of files) {
    if (typeof file !== "string" || path.extname(file).toLowerCase() !== ".png") {
      throw new Error(`Rendered page must be a PNG path: ${String(file)}`);
    }
    const page = analyzePng(file);
    pages.push(page);
    const name = path.basename(page.file);
    if (page.width < MIN_WIDTH || page.height < MIN_HEIGHT) {
      errors.push(`${name} has undersized pixel dimensions ${page.width}x${page.height}`);
    }
    if (page.colorBucketCount < 2 || page.dominantRatio > MAX_DOMINANT_RATIO) {
      errors.push(`${name} is blank or near-blank at pixel level`);
    }
  }
  return { ok: errors.length === 0, pageCount: pages.length, pages, errors };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const diagnostics = inspectRenderedPages(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
    if (!diagnostics.ok) {
      process.stderr.write(`Rendered page pixel QA failed: ${diagnostics.errors.join("; ")}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
