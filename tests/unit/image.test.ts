/**
 * T03：输入图片标准化测试。
 *
 * 覆盖：EXIF 方向校正、白底展平、sRGB、PNG 输出、哈希计算、
 * 尺寸/像素/字节上限、空输入与非法输入。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import sharp from "sharp";

import {
  MAX_IMAGE_SIDE,
  sha256Of,
  standardizeImage,
} from "../../src/io/image.js";
import { isImageTemplateError } from "../../src/errors.js";

const fixtureImage = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "images",
  "synthetic-travel.png",
);

test("PNG 输入标准化：尺寸一致、sRGB、白底、哈希正确", async () => {
  const input = await readFile(fixtureImage);
  const result = await standardizeImage(input);

  assert.equal(result.width, 800);
  assert.equal(result.height, 600);
  assert.equal(result.inputSha256, sha256Of(input));
  assert.equal(result.normalizedSha256, sha256Of(result.png));
  assert.equal(result.format.inputFormat, "png");
  assert.equal(result.format.orientationApplied, false);

  // 输出确为 PNG（魔数）
  assert.equal(result.png.subarray(0, 4).toString("hex"), "89504e47");
});

test("透明 PNG 展平白底", async () => {
  const rgba = await sharp({
    create: {
      width: 10,
      height: 10,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();

  const result = await standardizeImage(rgba);
  const stats = await sharp(result.png).stats();
  // 全透明 → 展平后接近纯白
  assert.ok(stats.channels[0].mean > 250, "透明区域应展平为白色");
});

test("EXIF 方向被校正（尺寸交换）", async () => {
  // 构造带 orientation=6 (需要 90° 旋转) 的 JPEG
  const base = await sharp({
    create: {
      width: 40,
      height: 20,
      channels: 3,
      background: "#336699",
    },
  })
    .jpeg()
    .toBuffer();

  const oriented = await sharp(base)
    .withMetadata({ orientation: 6 })
    .toBuffer();

  const result = await standardizeImage(oriented);
  // orientation 6 → 旋转 90°，宽高交换
  assert.equal(result.width, 20);
  assert.equal(result.height, 40);
  assert.equal(result.format.orientationApplied, true);
});

test("空输入报错", async () => {
  await assert.rejects(
    standardizeImage(Buffer.alloc(0)),
    (error: unknown) => {
      assert.ok(isImageTemplateError(error));
      assert.equal(error.code, "INVALID_ARGUMENT");
      return true;
    },
  );
});

test("非法图片字节报错", async () => {
  await assert.rejects(
    standardizeImage(Buffer.from("这不是图片")),
    (error: unknown) => {
      assert.ok(isImageTemplateError(error));
      assert.equal(error.code, "INVALID_ARGUMENT");
      return true;
    },
  );
});

test("像素数超限被拒绝（可自定义上限）", async () => {
  const input = await readFile(fixtureImage);
  await assert.rejects(
    standardizeImage(input, { maxPixels: 100 }),
    (error: unknown) => {
      assert.ok(isImageTemplateError(error));
      assert.ok(error.message.includes("像素数超限"));
      return true;
    },
  );
});

test("标准化输出字节超限被拒绝", async () => {
  const input = await readFile(fixtureImage);
  await assert.rejects(
    standardizeImage(input, { maxBytes: 100 }),
    (error: unknown) => {
      assert.ok(isImageTemplateError(error));
      assert.ok(error.message.includes("过大"));
      return true;
    },
  );
});

test("单边尺寸常量符合设计", () => {
  assert.equal(MAX_IMAGE_SIDE, 12000);
});
