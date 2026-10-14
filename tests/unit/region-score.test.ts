/**
 * T14：区域评价单元测试（离线）。
 *
 * 覆盖：
 * - 同图区域 mismatchRatio=0；
 * - 局部变化只影响对应区域分数（其他区域不受影响）；
 * - 非背景比例：全背景区域 nonBackgroundRatio=0；
 * - 尺寸不同直接报错；
 * - 区域与画布求交（越界区域不越界计数）；
 * - 默认区域覆盖全画布主要部分。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defaultEvalRegions,
  scoreRegions,
  type RgbaImage,
} from "../../src/quality/compare.js";
import { isImageTemplateError } from "../../src/errors.js";

const WIDTH = 200;
const HEIGHT = 100;

/** 构造纯白 RGBA 图。 */
function whiteImage(): RgbaImage {
  const data = Buffer.alloc(WIDTH * HEIGHT * 4, 255);
  return { data, width: WIDTH, height: HEIGHT };
}

/** 在指定矩形内填色。 */
function fill(
  image: RgbaImage,
  rect: { x: number; y: number; width: number; height: number },
  color: [number, number, number],
): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const idx = (y * WIDTH + x) * 4;
      image.data[idx] = color[0];
      image.data[idx + 1] = color[1];
      image.data[idx + 2] = color[2];
    }
  }
}

test("同图：全部区域 mismatchRatio=0", () => {
  const reference = whiteImage();
  fill(reference, { x: 0, y: 0, width: 200, height: 20 }, [25, 55, 83]);

  const scores = scoreRegions(reference, reference, [
    { id: "header", x: 0, y: 0, width: 200, height: 20 },
    { id: "body", x: 0, y: 20, width: 200, height: 80 },
  ]);

  assert.equal(scores.length, 2);
  for (const score of scores) {
    assert.equal(score.mismatchRatio, 0);
    assert.equal(score.mismatchedPixels, 0);
  }

  // header 非背景（深蓝），body 全白背景
  assert.ok(scores[0].nonBackgroundRatio > 0.99);
  assert.equal(scores[1].nonBackgroundRatio, 0);
});

test("局部变化只影响对应区域", () => {
  const reference = whiteImage();
  fill(reference, { x: 0, y: 0, width: 200, height: 20 }, [25, 55, 83]);

  const preview = whiteImage();
  fill(preview, { x: 0, y: 0, width: 200, height: 20 }, [203, 146, 59]);

  const scores = scoreRegions(reference, preview, [
    { id: "header", x: 0, y: 0, width: 200, height: 20 },
    { id: "body", x: 0, y: 20, width: 200, height: 80 },
  ]);

  assert.ok(scores[0].mismatchRatio > 0.99, "header 区域应全不匹配");
  assert.equal(scores[1].mismatchRatio, 0, "body 区域不受影响");
});

test("尺寸不同直接报错（不缩放）", () => {
  const a = whiteImage();
  const b: RgbaImage = { data: Buffer.alloc(100 * 50 * 4, 255), width: 100, height: 50 };

  assert.throws(
    () => scoreRegions(a, b, [{ id: "r", x: 0, y: 0, width: 50, height: 50 }]),
    (error: unknown) => {
      assert.ok(isImageTemplateError(error));
      assert.equal(error.code, "INVALID_ARGUMENT");
      return true;
    },
  );
});

test("区域与画布求交：越界区域不越界计数", () => {
  const reference = whiteImage();
  const scores = scoreRegions(reference, reference, [
    { id: "out", x: -50, y: -50, width: 300, height: 300 },
  ]);

  // 求交后 = 全画布 200×100 = 20000
  assert.equal(scores[0].pixels, WIDTH * HEIGHT);
});

test("默认区域：覆盖画布主要部分且 ID 稳定", () => {
  const regions = defaultEvalRegions({ width: 1060, height: 1500 });
  assert.deepEqual(
    regions.map((r) => r.id),
    ["header", "timeline", "photos", "sidebar"],
  );
  // header 全宽
  assert.equal(regions[0].width, 1060);
  // 区域在画布内
  for (const region of regions) {
    assert.ok(region.x >= 0 && region.y >= 0);
    assert.ok(region.x + region.width <= 1060);
    assert.ok(region.y + region.height <= 1500);
  }
});
