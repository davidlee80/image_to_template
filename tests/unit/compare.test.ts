/**
 * T07：像素对比单元测试。
 *
 * 覆盖：同图 mismatchRatio=0；局部变化产生对应 diff；尺寸不同直接失败；
 * 参数（threshold/includeAA）记录进结果。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import sharp from "sharp";

import {
  compareRgbaImages,
  loadRgba,
  DEFAULT_COMPARE_PARAMS,
} from "../../src/quality/compare.js";
import { isImageTemplateError } from "../../src/errors.js";

async function solidImage(
  width: number,
  height: number,
  color: string,
): Promise<{ file: string; buffer: Buffer }> {
  const png = await sharp({
    create: { width, height, channels: 3, background: color },
  })
    .png()
    .toBuffer();
  return { file: `solid-${color}.png`, buffer: png };
}

async function rgbaOf(png: Buffer) {
  const { data, info } = await sharp(png)
    .flatten({ background: "#FFFFFF" })
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

test("同图对比 mismatchRatio=0", async () => {
  const image = await rgbaOf((await solidImage(50, 40, "#336699")).buffer);
  const comparison = await compareRgbaImages(image, image);

  assert.equal(comparison.mismatchedPixels, 0);
  assert.equal(comparison.mismatchRatio, 0);
  assert.deepEqual(comparison.params, {
    threshold: DEFAULT_COMPARE_PARAMS.threshold,
    includeAA: DEFAULT_COMPARE_PARAMS.includeAA,
  });
});

test("局部变化产生对应差异", async () => {
  const base = await sharp({
    create: { width: 100, height: 80, channels: 3, background: "#FFFFFF" },
  })
    .png()
    .toBuffer();

  const modified = await sharp(base)
    .composite([
      {
        input: await sharp({
          create: { width: 20, height: 10, channels: 3, background: "#FF0000" },
        })
          .png()
          .toBuffer(),
        left: 10,
        top: 10,
      },
    ])
    .png()
    .toBuffer();

  const comparison = await compareRgbaImages(
    await rgbaOf(base),
    await rgbaOf(modified),
  );

  assert.ok(comparison.mismatchedPixels > 0);
  assert.ok(comparison.mismatchRatio > 0);
  assert.ok(comparison.mismatchRatio < 0.05, "局部变化不应导致大面积差异");
  // diff 与叠图均为有效 PNG
  assert.equal(comparison.diffPng.subarray(0, 4).toString("hex"), "89504e47");
  assert.equal(comparison.overlayPng.subarray(0, 4).toString("hex"), "89504e47");
});

test("尺寸不同直接失败（不自动缩放）", async () => {
  const a = await rgbaOf((await solidImage(50, 40, "#336699")).buffer);
  const b = await rgbaOf((await solidImage(51, 40, "#336699")).buffer);

  await assert.rejects(
    compareRgbaImages(a, b),
    (error: unknown) => {
      assert.ok(isImageTemplateError(error));
      assert.equal(error.code, "INVALID_ARGUMENT");
      assert.ok((error as Error).message.includes("尺寸不一致"));
      return true;
    },
  );
});

test("loadRgba 读取文件并统一规格", async () => {
  const tmp = await (await import("node:fs/promises")).mkdtemp(
    (await import("node:os")).tmpdir() + "/itt-cmp-",
  );
  try {
    const { writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.join(tmp, "img.png");
    await writeFile(file, (await solidImage(30, 20, "#FF0000")).buffer);

    const image = await loadRgba(file);
    assert.equal(image.width, 30);
    assert.equal(image.height, 20);
    assert.equal(image.data.length, 30 * 20 * 4);
    // 左上角像素为红色
    assert.equal(image.data[0], 255);
    assert.equal(image.data[1], 0);
    assert.equal(image.data[2], 0);
  } finally {
    await (await import("node:fs/promises")).rm(tmp, {
      recursive: true,
      force: true,
    });
  }
});
